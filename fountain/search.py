"""Authorized lexical retrieval. The content marker never grants access."""
from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from functools import cmp_to_key

from .core import require

TYPES = ("page", "database", "row")
TEXT_BLOCKS = {"paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "quote", "code", "callout", "toggle"}
TEXT_PROPERTIES = {"title", "text", "select", "status", "url", "email", "phone"}
SPACE = re.compile(r"[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+")
SOURCE_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$", re.ASCII)
BOUND_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", re.ASCII)
HASH = re.compile(r"^[a-f0-9]{64}$")
SORTS = {"relevance", "updated_desc", "updated_asc", "created_desc", "created_asc", "title"}
KEYS = {"q", "types", "owner", "teamspace", "in", "title_only", "date_field", "after", "before", "sort", "limit", "offset", "result_set"}


def _text(value):
    return isinstance(value, str) and "\0" not in value and not any(0xD800 <= ord(c) <= 0xDFFF for c in value)


def _display(value):
    return SPACE.sub(" ", unicodedata.normalize("NFKC", value)).strip(" ")


def _fold(value):
    return SPACE.sub(" ", unicodedata.normalize("NFKC", value).casefold()).strip(" ")


def _id(value):
    return _text(value) and 0 < len(value) <= 160


def _timestamp(value):
    if not _text(value):
        return None
    match = SOURCE_DATE.fullmatch(value)
    if not match:
        return None
    try:
        year, month, day, hour, minute, second = map(int, match.groups()[:6])
        fraction, zone = match.group(7), match.group(8)
        offset = timedelta()
        if zone != "Z":
            hours, minutes = int(zone[1:3]), int(zone[4:6])
            if hours > 23 or minutes > 59:
                return None
            offset = timedelta(hours=hours, minutes=minutes) * (1 if zone[0] == "+" else -1)
        instant = datetime(year, month, day, hour, minute, second, int((fraction or "").ljust(6, "0")), timezone(offset)).astimezone(timezone.utc)
        delta = instant - datetime(1970, 1, 1, tzinfo=timezone.utc)
        return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
    except (ValueError, OverflowError):
        return None


def _terms(query):
    result, position, count = [], 0, 0
    while position < len(query):
        if query[position] == " ":
            position += 1
            continue
        if query[position] == '"':
            end = query.find('"', position + 1)
            require(end != -1 and end > position + 1, "Invalid search phrase")
            token = query[position + 1:end].strip(" ")
            require(token.strip(" ") != "" and (end + 1 == len(query) or query[end + 1] == " "), "Invalid search phrase")
            position = end + 1
        else:
            end = query.find(" ", position)
            end = len(query) if end == -1 else end
            token = query[position:end]
            require('"' not in token, "Invalid search phrase")
            position = end
        count += 1
        require(count <= 16, "Too many search terms")
        if token not in result:
            result.append(token)
    return result


def _query(query):
    require(isinstance(query, dict) and set(query) <= KEYS, "Invalid search parameters")
    for key, values in query.items():
        require(isinstance(values, list) and len(values) > 0 and (key == "owner" or len(values) == 1) and all(_text(v) for v in values), "Invalid search parameters")
    get = lambda key, default=None: query[key][0] if key in query else default
    raw = get("q", "")
    require(len(raw) <= 500, "Search query is too long")
    folded = _fold(raw)
    terms = _terms(folded)
    types = get("types", ",".join(TYPES)).split(",")
    require(len(types) == len(set(types)) and all(kind in TYPES for kind in types), "Invalid search types")
    owners = query.get("owner", [])
    require(all(_id(owner) for owner in owners) and len(set(owners)) <= 20, "Invalid search owner")
    for key in ("teamspace", "in"):
        require(get(key) is None or _id(get(key)), "Invalid search container")
    require(get("title_only", "0") in {"0", "1"} and get("date_field", "updated") in {"updated", "created"} and get("sort", "relevance") in SORTS, "Invalid search filter")
    after, before = get("after"), get("before")
    for value in (after, before):
        require(value is None or BOUND_DATE.fullmatch(value) is not None and _timestamp(value) is not None, "Invalid search date")
    require(after is None or before is None or _timestamp(after) < _timestamp(before), "Invalid search date bounds")
    numbers = {}
    for key, default, low, high in (("limit", "20", 1, 50), ("offset", "0", 0, 100000)):
        value = get(key, default)
        require(re.fullmatch(r"0|[1-9][0-9]{0,5}", value) is not None and low <= int(value) <= high, "Invalid search pagination")
        numbers[key] = int(value)
    marker = get("result_set")
    require(marker is None or HASH.fullmatch(marker) is not None, "Invalid search result set")
    require(numbers["offset"] == 0 or marker is not None, "Search result set is required")
    filters = {"q": folded, "terms": terms, "types": [kind for kind in TYPES if kind in types], "owners": sorted(set(owners)), "teamspace": get("teamspace"), "in": get("in"), "title_only": get("title_only", "0") == "1", "date_field": get("date_field", "updated"), "after": after, "before": before, "sort": get("sort", "relevance")}
    return filters, numbers["limit"], numbers["offset"], marker


def _number(value):
    if type(value) not in (int, float) or type(value) is int and abs(value) > 9007199254740991 or not math.isfinite(value):
        return ""
    if value == 0:
        return "0"
    if value == int(value) and abs(value) > 9007199254740991:
        return ""
    number = Decimal(repr(value))
    if 1e-6 <= abs(value) < 1e21:
        return format(number, "f").rstrip("0").rstrip(".") if "." in format(number, "f") else format(number, "f")
    mantissa, exponent = str(number).lower().split("e")
    return mantissa.rstrip("0").rstrip(".") + "e" + ("+" if int(exponent) >= 0 else "-") + str(abs(int(exponent)))


def _scalar(kind, value):
    if not isinstance(kind, str):
        return ""
    if kind in TEXT_PROPERTIES:
        return value if _text(value) else ""
    if kind == "number":
        return _number(value)
    if kind == "checkbox":
        return "true" if value is True else "false" if value is False else ""
    if kind == "multi_select" and isinstance(value, list) and all(_text(v) for v in value):
        return " ".join(value)
    if kind == "date":
        if _text(value):
            return value if _date_atom(value) is not None else ""
        if isinstance(value, dict) and set(value) == {"start", "end"}:
            start = _date_atom(value["start"])
            end = _date_atom(value["end"])
            if start is not None and end is not None and start[0] == end[0] and start[1] <= end[1]:
                return value["start"] + " " + value["end"]
    return ""


def _date_atom(value):
    if not _text(value):
        return None
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        stamp = _timestamp(value + "T00:00:00Z")
        return ("day", stamp) if stamp is not None else None
    stamp = _timestamp(value)
    return ("time", stamp) if stamp is not None else None


def _snippet(body, terms):
    if len(body) <= 180:
        return body
    folded_parts, positions = [], []
    for index, character in enumerate(body):
        piece = character.casefold()
        folded_parts.append(piece)
        positions.extend([index] * len(piece))
    folded = "".join(folded_parts)
    matches = [folded.find(term) for term in terms if term in folded]
    hit = positions[min(matches)] if matches else 0
    start = max(0, min(hit - 89, len(body) - 178))
    return ("…" if start else "") + body[start:start + 178] + ("…" if start + 178 < len(body) else "")


def advanced_search(store, access, query):
    """Return a small authorized corpus page; never mutate or audit the store."""
    filters, limit, offset, supplied = _query(query)
    require(access.active, "Authentication required", 401)
    if filters["teamspace"] is not None:
        require(access.can("teamspace", store.get("teamspace", filters["teamspace"])), "Search container not found", 404)
    if filters["in"] is not None:
        parent = store.get("page", filters["in"])
        require(parent is not None and not parent.get("archived") and access.can("page", parent), "Search container not found", 404)
    pages = {p["id"]: p for p in store.list("page") if isinstance(p, dict) and _id(p.get("id")) and not p.get("archived") and access.can("page", p)}
    databases = {d["id"]: d for d in store.list("database") if isinstance(d, dict) and _id(d.get("id")) and not d.get("archived") and access.can("database", d)}

    def ancestry(identity):
        result, seen = [], set()
        while _id(identity) and identity in pages and identity not in seen:
            seen.add(identity)
            result.append(identity)
            identity = pages[identity].get("parent_id")
        return result

    def container(kind, entity, database):
        base = database if kind == "row" else entity
        chain = ancestry(entity["id"]) if kind == "page" else list(dict.fromkeys(ancestry(base.get("parent_id")) + ancestry(base.get("page_id"))))
        if filters["in"] is not None and filters["in"] not in chain:
            return False
        if filters["teamspace"] is not None:
            teamspace = base.get("teamspace_id")
            if teamspace is None:
                teamspace = next((pages[p].get("teamspace_id") for p in chain if pages[p].get("teamspace_id") is not None), None)
            if teamspace != filters["teamspace"]:
                return False
        return True

    found = []
    for kind in filters["types"]:
        candidates = pages.values() if kind == "page" else databases.values() if kind == "database" else store.list("row")
        for entity in candidates:
            if not isinstance(entity, dict) or not _id(entity.get("id")) or entity.get("archived"):
                continue
            database = databases.get(entity.get("database_id")) if kind == "row" and _id(entity.get("database_id")) else None
            if kind == "row" and (database is None or not access.can("row", entity)):
                continue
            owner = entity.get("owner_id", "local")
            if not _id(owner):
                owner = None
            if filters["owners"] and owner not in filters["owners"] or not container(kind, entity, database):
                continue
            dates = {key: (_timestamp(entity.get(key)), entity.get(key)) for key in ("created_at", "updated_at")}
            when = dates[filters["date_field"] + "_at"][0]
            if (filters["after"] is not None or filters["before"] is not None) and (when is None or filters["after"] is not None and when < _timestamp(filters["after"]) or filters["before"] is not None and when >= _timestamp(filters["before"])):
                continue
            if kind == "page":
                title = entity.get("title")
                blocks = entity.get("blocks", [])
                body = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict) and isinstance(b.get("type", "paragraph"), str) and b.get("type", "paragraph") in TEXT_BLOCKS and not b.get("attachment_id") and _text(b.get("text", ""))) if isinstance(blocks, list) else ""
            elif kind == "database":
                title = entity.get("name") if isinstance(entity.get("name"), str) else entity.get("title")
                body = entity.get("description", "") if _text(entity.get("description", "")) else ""
            else:
                props = entity.get("properties") if isinstance(entity.get("properties"), dict) else {}
                schema = database.get("properties") if isinstance(database.get("properties"), list) else []
                title = next((props.get(p.get("id")) for p in schema if isinstance(p, dict) and p.get("type") == "title"), "")
                body = " ".join(_scalar(p.get("type"), props.get(p.get("id"))) for p in schema if isinstance(p, dict) and isinstance(p.get("id"), str))
            title = title if _text(title) else ""
            body = _display(body)
            folded_title, folded_body = _fold(title), body.casefold()
            if not all(term in folded_title or not filters["title_only"] and term in folded_body for term in filters["terms"]):
                continue
            score = sum(50 * (term in folded_title) + 8 * (not filters["title_only"] and term in folded_body) for term in filters["terms"])
            if filters["terms"] and SPACE.sub(" ", filters["q"].replace('"', "")).strip(" ") in folded_title:
                score += 30
            dto = {"type": kind, "id": entity["id"], "title": title, "icon": entity.get("icon") if _text(entity.get("icon")) else None,
                   "snippet": _snippet(body, [] if filters["title_only"] else filters["terms"]), "owner_id": owner,
                   "created_at": dates["created_at"][1] if dates["created_at"][0] is not None else None,
                   "updated_at": dates["updated_at"][1] if dates["updated_at"][0] is not None else None}
            if kind == "row":
                dto.update(database_id=database["id"], database_title=database.get("name") if _text(database.get("name")) else database.get("title") if _text(database.get("title")) else "")
            found.append((dto, score, folded_title, dates))

    def compare(left, right):
        mode = filters["sort"]
        if mode == "relevance" and left[1] != right[1]:
            return -1 if left[1] > right[1] else 1
        if mode != "title":
            key = "created_at" if mode.startswith("created") else "updated_at"
            a, b = left[3][key][0], right[3][key][0]
            if a != b:
                if a is None or b is None:
                    return 1 if a is None else -1
                return (1 if a > b else -1) * (1 if mode.endswith("asc") else -1)
        a, b = (left[2], TYPES.index(left[0]["type"]), left[0]["id"]), (right[2], TYPES.index(right[0]["type"]), right[0]["id"])
        return (a > b) - (a < b)

    results = [value[0] for value in sorted(found, key=cmp_to_key(compare))]
    raw = [1, store.meta("workspace_id"), access.member_id, filters, results]
    marker = hashlib.sha256(json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    require(supplied is None or supplied == marker, "Search results changed; restart from the first page", 409)
    end = offset + limit
    return {"results": results[offset:end], "total": len(results), "offset": offset, "limit": limit, "has_more": end < len(results), "next_offset": end if end < len(results) else None, "result_set": marker}
