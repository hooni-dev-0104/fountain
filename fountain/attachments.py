"""Resumable SQLite BLOB attachments; all file reads remain bounded in memory."""
from __future__ import annotations

import base64
import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone

from .core import APIError, require, text, uid

CHUNK_SIZE = 4 * 1024 * 1024
READ_SIZE = 64 * 1024
MAX_FILE_SIZE = 5_000_000_000
UPLOAD_TTL_SECONDS = 24 * 60 * 60


class FileStorage:
    def __init__(self, store):
        self.store = store

    def _public(self, upload):
        result = {key: upload.get(key) for key in ("id", "owner_id", "page_id", "name", "size", "offset", "chunk_size", "expires_at", "completed")}
        if upload.get("completed"):
            attachment = self.store.get("attachment", upload["id"])
            if attachment: result["attachment"] = attachment
        return result

    def _check(self, upload, owner_id, access=None, cleaning=False):
        text(owner_id, "upload owner", 160, False)
        workspace_owner = False
        if access is not None and not callable(access):
            from .access import Access
            principal = self.store.get("member", access.member_id)
            require(principal is not None, "Active upload member not found", 403)
            access = Access(self.store, principal)
            require(access.active and access.member_id == owner_id, "Upload actor does not match session", 403)
            workspace_owner = access.owner
            require(access.regular or upload.get("page_id"), "Guests must upload to an editable page", 403)
        require(upload["owner_id"] == owner_id or cleaning and workspace_owner, "Upload not found", 404)
        if cleaning and workspace_owner:
            return
        if upload.get("page_id"):
            page = self.store.get("page", upload["page_id"])
            require(page is not None, "Upload page not found", 404)
            require(not page.get("archived") and not page.get("locked"), "Upload page is locked or archived", 423)
            if access is not None and not callable(access):
                require(access.can("page", page, 3), "Upload page is no longer editable", 403)
        if callable(access):
            require(access(dict(upload)), "Upload is no longer authorized", 403)

    def _load(self, identity, owner_id, access=None, cleaning=False):
        text(identity, "upload id", 160, False)
        upload = self.store.get("upload", identity)
        require(upload is not None, "Upload not found", 404)
        self._check(upload, owner_id, access, cleaning)
        try: expired = datetime.fromisoformat(upload["expires_at"]) <= datetime.now(timezone.utc)
        except (KeyError, ValueError, TypeError): expired = True
        require(not expired, "Upload expired; start a new upload", 410)
        return upload

    def begin(self, body, owner_id, access=None):
        require(isinstance(body, dict), "Upload metadata must be an object")
        name = text(body.get("name", ""), "filename", 255, False)
        require(name not in {".", ".."} and not any(ord(c) < 32 or c in "/\\" for c in name), "Invalid filename")
        try: name.encode("utf-8")
        except UnicodeEncodeError: raise APIError(400, "Invalid Unicode filename")
        size = body.get("size")
        require(type(size) is int and size >= 0, "File size must be a nonnegative integer")
        require(size <= MAX_FILE_SIZE, "File exceeds 5,000,000,000 bytes", 413)
        page_id = body.get("page_id")
        if page_id is not None: text(page_id, "page id", 160, False)
        upload = {"id": uid(), "owner_id": owner_id, "page_id": page_id, "name": name, "size": size,
                  "offset": 0, "chunk_size": CHUNK_SIZE, "completed": False,
                  "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=UPLOAD_TTL_SECONDS)).isoformat()}
        with self.store.transaction():
            self._check(upload, owner_id, access)
            return self._public(self.store.put("upload", upload))

    def status(self, identity, owner_id, access=None):
        with self.store.lock:
            return self._public(self._load(identity, owner_id, access))

    def append(self, identity, offset, data, owner_id, access=None):
        require(type(offset) is int and offset >= 0, "Invalid chunk offset")
        require(isinstance(data, (bytes, bytearray)) and len(data) <= CHUNK_SIZE, "Chunk must contain at most 4 MiB")
        with self.store.transaction():
            upload = self._load(identity, owner_id, access)
            require(not upload.get("completed"), "Upload is already complete", 409)
            require(offset <= upload["offset"], "Chunk would create a gap", 409)
            require(offset % CHUNK_SIZE == 0 and offset < upload["size"], "Invalid chunk boundary")
            require(len(data) == min(CHUNK_SIZE, upload["size"] - offset), "Incorrect chunk length")
            if offset < upload["offset"]:
                stored = self.store.db.execute("SELECT length(data),typeof(data) FROM attachment_chunks WHERE attachment_id=? AND offset=?", (identity, offset)).fetchone()
                require(stored is not None and stored[1] == 'blob' and stored[0] == len(data), "Retry chunk differs from the stored bytes", 409)
                content = self.store.db.execute("SELECT substr(data,1,?) FROM attachment_chunks WHERE attachment_id=? AND offset=?", (len(data), identity, offset)).fetchone()[0]
                require(content == bytes(data), "Retry chunk differs from the stored bytes", 409)
                return self._public(upload)
            self.store.db.execute("INSERT INTO attachment_chunks VALUES (?,?,?)", (identity, offset, bytes(data)))
            upload["offset"] += len(data)
            return self._public(self.store.put("upload", upload))

    def _slice(self, identity, position, length):
        chunk_offset = position // CHUNK_SIZE * CHUNK_SIZE
        relative = position - chunk_offset
        length = min(length, READ_SIZE, CHUNK_SIZE - relative)
        with self.store.lock:
            row = self.store.db.execute("SELECT rowid,length(data),typeof(data) FROM attachment_chunks WHERE attachment_id=? AND offset=?",
                                        (identity, chunk_offset)).fetchone()
            require(row is not None and row[2] == "blob" and row[1] >= relative + length,
                    "Attachment bytes are missing or were removed", 409)
            try:
                # Close each incremental BLOB handle before yielding network bytes;
                # no SQLite cursor or transaction is pinned across a slow client.
                with self.store.db.blobopen("attachment_chunks", "data", row[0], readonly=True) as blob:
                    blob.seek(relative)
                    data = blob.read(length)
            except sqlite3.Error as error:
                raise APIError(409, "Attachment bytes changed during transfer") from error
        require(len(data) == length, "Attachment bytes are incomplete", 409)
        return data

    def complete(self, identity, owner_id, access=None):
        with self.store.transaction():
            upload = self._load(identity, owner_id, access)
            if upload.get("completed"):
                attachment = self.store.get("attachment", identity)
                require(attachment is not None, "Completed attachment was removed", 410)
                return attachment
            require(upload["offset"] == upload["size"], "Upload is not complete", 409)
            rows = self.store.db.execute("SELECT offset,length(data),typeof(data) FROM attachment_chunks WHERE attachment_id=? ORDER BY offset", (identity,))
            position = 0
            for offset, length, kind in rows:
                require(offset == position and kind == "blob" and length == min(CHUNK_SIZE, upload["size"] - position)
                        and length > 0, "Upload chunk layout is invalid", 409)
                position += length
            require(position == upload["size"], "Upload bytes are incomplete", 409)
            digest, position = hashlib.sha256(), 0
            while position < upload["size"]:
                data = self._slice(identity, position, upload["size"] - position)
                digest.update(data)
                position += len(data)
            attachment = self.store.put("attachment", {"id": identity, "owner_id": upload["owner_id"], "page_id": upload.get("page_id"),
                "name": upload["name"], "size": upload["size"], "mime": "application/octet-stream", "storage": "chunks", "sha256": digest.hexdigest()})
            upload["completed"] = True
            self.store.put("upload", upload)
            return attachment

    def cancel(self, identity, owner_id, access=None):
        with self.store.transaction():
            upload = self._load(identity, owner_id, access, cleaning=True)
            completed = upload.get("completed") or self.store.get("attachment", identity) is not None
            if not completed:
                self.store.db.execute("DELETE FROM attachment_chunks WHERE attachment_id=?", (identity,))
                self.store.delete("upload", identity)
            return {"id": identity, "cancelled": not completed, "completed": bool(completed)}

    def cleanup(self, now_value=None):
        current = now_value if now_value is not None else datetime.now(timezone.utc)
        if isinstance(current, str):
            try: current = datetime.fromisoformat(current)
            except ValueError: raise APIError(400, "Invalid upload cleanup time")
        require(isinstance(current, datetime) and current.utcoffset() is not None, "Cleanup time must include a UTC offset")
        removed = 0
        with self.store.transaction():
            for upload in self.store.list("upload"):
                try: expired = datetime.fromisoformat(upload["expires_at"]) <= current
                except (ValueError, TypeError, KeyError): expired = True
                if not expired: continue
                if self.store.get("attachment", upload["id"]) is None:
                    self.store.db.execute("DELETE FROM attachment_chunks WHERE attachment_id=?", (upload["id"],))
                self.store.delete("upload", upload["id"])
                removed += 1
        return {"removed": removed}

    def iter_bytes(self, identity, start=0, end=None):
        """Yield <=64 KiB incremental BLOB reads for [start,end), without held locks."""
        attachment = self.store.get("attachment", identity)
        require(attachment is not None, "Attachment not found", 404)
        size = attachment["size"]
        end = size if end is None else end
        require(type(start) is int and type(end) is int and 0 <= start <= end <= size, "Invalid attachment byte range", 416)
        position = start
        while position < end:
            with self.store.lock:
                current = self.store.get("attachment", identity)
                require(current is not None and current.get("size") == size, "Attachment was removed", 404)
                if attachment.get("storage") == "chunks":
                    data = self._slice(identity, position, end - position)
                else:
                    # Legacy files are capped at 5 MB, but decode only this slice.
                    length = min(READ_SIZE, end - position)
                    first = position // 3 * 4
                    last = ((position + length + 2) // 3) * 4
                    try: decoded = base64.b64decode(current.get("data", "")[first:last], validate=True)
                    except (ValueError, TypeError): raise APIError(409, "Legacy attachment data is invalid")
                    relative = position % 3
                    data = decoded[relative:relative + length]
                    require(len(data) == length, "Legacy attachment bytes are incomplete", 409)
            position += len(data)
            yield data
