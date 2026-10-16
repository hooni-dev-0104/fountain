"""Short-lived, session-bound document presence shared through SQLite.

Live leases last 15 seconds. Sequence high-water marks survive leave/expiry for
60 more seconds, after which a client ID may be reused. Clients must generate a
fresh random ID per channel lifetime and never persist/replay presence offline.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import time

from .access import Access
from .core import require
from .crdt import MAX_CLOCK, visible_chars

TTL = 15
HEARTBEAT = 5
RETENTION = 60
MAX_ACTIVE_SESSION = 10
MAX_ACTIVE_PAGE = 100
MAX_RETAINED_SESSION = 200
MAX_RETAINED_PAGE = 500
COLORS = ("#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#16a34a", "#0891b2", "#4f46e5")


class PresenceService:
    def __init__(self, store, auth, clock=time.time):
        self.store, self.auth, self.clock = store, auth, clock

    def _now(self):
        value = self.clock()
        require(type(value) in (int, float) and math.isfinite(value), "Invalid presence clock", 500)
        return value

    def _records(self, *, page=None, origin=None, now=None):
        clauses, parameters = ["kind='presence'"], []
        if page is not None:
            clauses.append("json_extract(data,'$.page_id')=?")
            parameters.append(page)
        if origin is not None:
            clauses.extend(["json_extract(data,'$.origin_kind')=?", "json_extract(data,'$.origin_id')=?"])
            parameters.extend(origin)
        if now is not None:
            clauses.append("json_extract(data,'$.retain_until')>?")
            parameters.append(now)
        return [json.loads(row[0]) for row in self.store.db.execute("SELECT data FROM entities WHERE " + " AND ".join(clauses), parameters)]

    def _cleanup(self, now):
        expired = self.store.db.execute("SELECT id FROM entities WHERE kind='presence' AND json_extract(data,'$.retain_until')<=? LIMIT 500", (now,)).fetchall()
        for (identity,) in expired: self.store.delete("presence", identity)

    def _context(self, page_id, cookie):
        info = self.auth.session_info(cookie)
        require(info.get("authenticated") and isinstance(info.get("member"), dict), "Authentication required", 401)
        access = Access(self.store, info["member"])
        page = access.require_resource("page", page_id, 1)
        digest = self.auth._digest(cookie)
        session = self.auth.session_by_digest(digest)
        if session:
            origin = ("session", digest)
        else:
            require(not self.auth.enabled and access.member_id == "local", "A live presence session is required", 401)
            origin = ("local", info["cache_binding"])
        document = self.store.get("collaboration", page_id)
        return info, access, page, document, origin

    @staticmethod
    def _identity(page_id, epoch, origin, client_id, workspace_id):
        data = json.dumps([workspace_id, page_id, epoch, *origin, client_id], ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(data.encode()).hexdigest()

    def _publisher(self, record):
        if record["origin_kind"] == "session":
            session = self.auth.session_by_digest(record["origin_id"])
            if session is None or record.get("session_binding") != session.get("cache_binding", session["created_at"]):
                return None
            return self.auth.principal_by_digest(record["origin_id"])
        if (record["origin_kind"] == "local" and not self.auth.enabled
                and record["origin_id"] == self.store.meta("local_cache_binding")):
            return {"id": "local", "name": "나", "role": "owner", "active": True}
        return None

    @staticmethod
    def _selection_shape(selection):
        if selection is None: return
        require(isinstance(selection, dict) and set(selection) == {"block_id", "anchor", "focus"}, "Invalid presence selection")
        identity = selection["block_id"]
        require(isinstance(identity, str) and 0 < len(identity) <= 160, "Invalid presence block")
        for key in ("anchor", "focus"):
            point = selection[key]
            require(isinstance(point, dict) and set(point) == {"before", "after", "offset"}, "Invalid presence point")
            require(type(point["offset"]) is int and 0 <= point["offset"] <= MAX_CLOCK, "Invalid presence offset")
            for side in ("before", "after"):
                value = point[side]
                require(value is None or isinstance(value, str) and 0 < len(value) <= 300, "Invalid presence character anchor")

    @staticmethod
    def _selection(selection, state):
        if selection is None: return None
        identity = selection["block_id"]
        block = state.get("blocks", {}).get(identity)
        if not block or block.get("deleted") or block.get("insert") is None: return None
        characters = visible_chars(state, identity)
        ids = [character["id"] for character in characters]
        positions = {value: index for index, value in enumerate(ids)}
        result = {"block_id": identity}
        for key in ("anchor", "focus"):
            point = selection[key]
            before, after = point["before"], point["after"]
            if any(value is not None and value not in positions for value in (before, after)): return None
            position = positions[before] + 1 if before is not None else positions[after] if after is not None else point["offset"]
            if position > len(ids) or after is not None and positions[after] < position: return None
            result[key] = {"before": ids[position - 1] if position else None,
                           "after": ids[position] if position < len(ids) else None, "offset": position}
        return result

    @staticmethod
    def _live(record, now):
        return not record.get("left") and record["expires_at"] > now

    def _retire(self, record, now):
        if not record.get("left"):
            record.update(left=True, expires_at=min(record["expires_at"], now))
            record["retain_until"] = record["expires_at"] + RETENTION
            self.store.put("presence", record)

    def _snapshot(self, context, now):
        info, access, page, document, _ = context
        epoch = document["epoch"] if document else None
        participants = []
        for record in self._records(page=page["id"], now=now):
            if record.get("epoch") != epoch:
                self.store.delete("presence", record["id"])
                continue
            if page.get("archived"):
                self._retire(record, now)
                continue
            if not self._live(record, now): continue
            publisher = self._publisher(record)
            if publisher is None or publisher.get("id") != record["member_id"] or not Access(self.store, publisher).can("page", page):
                self._retire(record, now)
                continue
            name = publisher.get("name")
            participants.append({"id": record["id"], "member_id": publisher["id"],
                "name": name[:100] if isinstance(name, str) else "참여자", "color": COLORS[int(record["id"][:8], 16) % len(COLORS)],
                "client_id": record["client_id"], "seq": record["seq"], "selection": self._selection(record.get("selection"), document["state"])})
        participants.sort(key=lambda participant: participant["id"])
        return {"epoch": epoch, "workspace_id": info["workspace_id"], "current_member_id": access.member_id,
            "session_binding": info["cache_binding"], "participants": participants,
            "ttl": TTL, "heartbeat": HEARTBEAT, "revision": self.store.meta("_entity_revision", 0)}

    def snapshot(self, page_id, cookie):
        with self.store.transaction():
            now = self._now()
            context = self._context(page_id, cookie)
            self._cleanup(now)
            return self._snapshot(context, now)

    def _mutate(self, page_id, body, cookie, leaving):
        fields = {"session_binding", "epoch", "client_id", "seq"} | (set() if leaving else {"selection"})
        require(isinstance(body, dict) and set(body) == fields, "Invalid presence fields")
        require(isinstance(body["client_id"], str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", body["client_id"]) is not None, "Invalid presence client")
        require(type(body["seq"]) is int and 0 < body["seq"] <= MAX_CLOCK, "Invalid presence sequence")
        require(isinstance(body["epoch"], str) and 0 < len(body["epoch"]) <= 160, "Invalid presence epoch")
        if not leaving: self._selection_shape(body["selection"])
        with self.store.transaction():
            now = self._now()
            context = self._context(page_id, cookie)
            info, access, page, document, origin = context
            require(body["session_binding"] == info["cache_binding"], "Presence belongs to another login", 403)
            require(document is not None and body["epoch"] == document["epoch"], "Document epoch changed", 409)
            require(leaving or not page.get("archived"), "Restore the page before publishing presence", 409)
            self._cleanup(now)
            # Reading first retires revoked publishers and prior document epochs.
            self._snapshot(context, now)
            identity = self._identity(page_id, document["epoch"], origin, body["client_id"], info["workspace_id"])
            previous = self.store.get("presence", identity)
            # Cleanup is bounded; an expired record beyond its current batch is
            # a new allocation and must not bypass retained-capacity checks.
            if previous is not None and previous["retain_until"] <= now: previous = None
            ignored = previous is not None and body["seq"] <= previous["seq"]
            if not ignored:
                retained_page, retained_session = self._records(page=page_id, now=now), self._records(origin=origin, now=now)
                if previous is None:
                    require(len(retained_page) < MAX_RETAINED_PAGE and len(retained_session) < MAX_RETAINED_SESSION, "Presence retention capacity reached", 429)
                if not leaving and not (previous and self._live(previous, now)):
                    require(sum(self._live(row, now) for row in retained_page) < MAX_ACTIVE_PAGE
                            and sum(self._live(row, now) for row in retained_session) < MAX_ACTIVE_SESSION, "Too many active presence clients", 429)
                expires_at = now if leaving else now + TTL
                previous = self.store.put("presence", {"id": identity, "page_id": page_id, "epoch": document["epoch"],
                    "member_id": access.member_id, "origin_kind": origin[0], "origin_id": origin[1],
                    "session_binding": info["cache_binding"], "client_id": body["client_id"],
                    "seq": body["seq"], "left": leaving, "expires_at": expires_at, "retain_until": expires_at + RETENTION,
                    "selection": None if leaving else self._selection(body["selection"], document["state"])})
            result = self._snapshot(context, now)
            result.update(ack_seq=previous["seq"], participant_id=identity, ignored=ignored)
            return result

    def update(self, page_id, body, cookie):
        return self._mutate(page_id, body, cookie, False)

    def leave(self, page_id, body, cookie):
        return self._mutate(page_id, body, cookie, True)
