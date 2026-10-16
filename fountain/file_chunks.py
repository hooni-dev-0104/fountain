"""Immutable POSIX files referenced by PostgreSQL chunk manifests.

Files are durable before their manifest is inserted. Rollback/delete therefore
leave private orphans; only the workspace-locked, age-delayed collector unlinks.
No open file descriptor survives read_range(), including streaming callers.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import uuid

from .core import APIError, now as timestamp, require

CHUNK_SIZE = 4 * 1024 * 1024
ROOT_KEY = "attachment_file_root"
MARKER = ".fountain-root.json"
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_TEMP = re.compile(r"\.tmp-[0-9a-f]{32}\Z")


class FileChunkStorage:
    def __init__(self, store, root):
        self.store = store
        self._root = self._namespace = None
        self.namespace = hashlib.sha256(store.workspace_id.encode()).hexdigest()
        require(os.name == "posix" and hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY")
                and all(function in os.supports_dir_fd for function in (os.open, os.mkdir, os.link, os.unlink, os.stat)),
                "Attachment files require POSIX directory descriptor support", 503)
        try:
            with store.transaction():
                absent = object()
                binding = store.meta(ROOT_KEY, absent)
                bound = binding is not absent
                if bound: self._binding(binding)
                self._root = self._open_root(root, create=not bound)
                try:
                    marker = self._read_marker()
                except FileNotFoundError:
                    require(not bound and not os.listdir(self._root), "Attachment directory has no valid root marker", 503)
                    marker = {"version": 1, "id": str(uuid.uuid4())}
                    self._publish(self._root, MARKER, json.dumps(marker, separators=(",", ":")).encode())
                    marker = self._read_marker()
                self._binding(marker)
                require(not bound or binding == marker, "Attachment directory does not match this workspace", 503)
                self.root_id = marker["id"]
                self._namespace = self._directory(self._root, self.namespace, create=not bound)
                require(bound or not os.listdir(self._namespace), "Nonempty attachment namespace cannot be rebound", 503)
                if not bound: store.set_meta(ROOT_KEY, marker)
        except OSError:
            self.close()
            raise APIError(503, "Attachment directory is unavailable or unsafe") from None
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _binding(value):
        require(isinstance(value, dict) and set(value) == {"version", "id"}
                and type(value["version"]) is int and value["version"] == 1
                and isinstance(value["id"], str), "Invalid attachment root binding", 503)
        try: valid = str(uuid.UUID(value["id"])) == value["id"]
        except ValueError: valid = False
        require(valid, "Invalid attachment root binding", 503)

    @staticmethod
    def _private(info, directory=False):
        require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
                and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600),
                "Unsafe attachment file or directory", 503)

    @classmethod
    def _directory(cls, parent, name, *, create=False):
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError: pass
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try: cls._private(os.fstat(descriptor), True)
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor

    @classmethod
    def _open_root(cls, path, *, create):
        parts = Path(os.path.abspath(os.fspath(path))).parts
        require(len(parts) > 1, "Filesystem root cannot hold attachment storage", 503)
        descriptor = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for index, name in enumerate(parts[1:]):
                last = index == len(parts) - 2
                if last:
                    child = cls._directory(descriptor, name, create=create)
                else:
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def _read_marker(self):
        descriptor = os.open(MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self._root)
        try:
            info = os.fstat(descriptor)
            self._private(info)
            require(info.st_size <= 256, "Invalid attachment root marker", 503)
            try: return json.loads(os.read(descriptor, 257))
            except (ValueError, UnicodeError): raise APIError(503, "Invalid attachment root marker") from None
        finally: os.close(descriptor)

    def _check_root(self):
        require(self._root is not None and self._namespace is not None, "Attachment storage is closed", 503)
        try:
            self._private(os.fstat(self._root), True)
            self._private(os.fstat(self._namespace), True)
            marker = self._read_marker()
        except OSError: raise APIError(503, "Attachment root marker is unavailable") from None
        self._binding(marker)
        require(marker == {"version": 1, "id": self.root_id}, "Attachment root marker changed", 503)

    @staticmethod
    def _publish(directory, name, data):
        temporary = ".tmp-" + uuid.uuid4().hex
        descriptor = None
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            view = memoryview(data)
            while view:
                written = os.write(descriptor, view)
                if written <= 0: raise OSError("Short attachment write")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            try: os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            except FileExistsError: pass
            os.unlink(temporary, dir_fd=directory)
            os.fsync(directory)
        finally:
            if descriptor is not None: os.close(descriptor)
            try: os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError: pass

    @staticmethod
    def _key(identity, offset):
        require(isinstance(identity, str) and bool(identity) and len(identity) <= 160,
                "Invalid attachment identity")
        require(not any(0xD800 <= ord(character) <= 0xDFFF for character in identity), "Invalid attachment identity")
        require(type(offset) is int and offset >= 0 and offset % CHUNK_SIZE == 0, "Invalid chunk offset")
        return hashlib.sha256(json.dumps([identity, offset], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

    def _manifest(self, identity, offset):
        key = self._key(identity, offset)
        value = self.store.get("attachment_chunk", key)
        if value is not None:
            self._validate_manifest(value, identity, offset, key)
        return value

    @staticmethod
    def _validate_manifest(value, identity, offset, key):
        require(isinstance(value, dict) and value.get("id") == key and value.get("attachment_id") == identity
                and type(value.get("offset")) is int and value["offset"] == offset
                and type(value.get("size")) is int and 0 < value["size"] <= CHUNK_SIZE
                and isinstance(value.get("sha256"), str) and _HEX.fullmatch(value["sha256"]),
                "Invalid attachment chunk manifest", 409)

    def info(self, identity, offset):
        with self.store._read():
            value = self._manifest(identity, offset)
            return (value["size"], "blob") if value else None

    def _open_blob(self, directory, digest, size, *, verify=False):
        descriptor = os.open(digest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(descriptor)
            self._private(info)
            require(info.st_size == size, "Attachment chunk length is corrupt", 409)
            if verify:
                checksum = hashlib.sha256()
                while True:
                    part = os.read(descriptor, 65536)
                    if not part: break
                    checksum.update(part)
                require(checksum.hexdigest() == digest, "Attachment chunk checksum is corrupt", 409)
                os.lseek(descriptor, 0, os.SEEK_SET)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def read_range(self, identity, offset, start, length):
        require(type(start) is int and start >= 0 and type(length) is int and 0 <= length <= CHUNK_SIZE,
                "Invalid chunk read range")
        with self.store._read():
            value = self._manifest(identity, offset)
            if value is None: return None
            self._check_root()
            directory = descriptor = None
            try:
                directory = self._directory(self._namespace, value["sha256"][:2])
                descriptor = self._open_blob(directory, value["sha256"], value["size"])
                os.lseek(descriptor, start, os.SEEK_SET)
                expected = min(length, max(0, value["size"] - start))
                result = bytearray()
                while len(result) < expected:
                    part = os.read(descriptor, expected - len(result))
                    require(bool(part), "Attachment chunk was truncated while reading", 409)
                    result.extend(part)
                return bytes(result)
            except OSError: raise APIError(503, "Attachment chunk file is unavailable or unsafe") from None
            finally:
                if descriptor is not None: os.close(descriptor)
                if directory is not None: os.close(directory)

    def hash_into(self, identity, offset, length, digest):
        """Hash one complete chunk with one manifest lookup and 64 KiB reads.

        False means only that this backend has no manifest. A referenced but
        unavailable or corrupt file must never trigger legacy BYTEA fallback.
        """
        require(type(length) is int and 0 < length <= CHUNK_SIZE, "Invalid attachment chunk hash length")
        with self.store._read():
            value = self._manifest(identity, offset)
            if value is None: return False
            require(value["size"] == length, "Attachment chunk hash length does not match its manifest", 409)
            self._check_root()
            directory = descriptor = None
            try:
                directory = self._directory(self._namespace, value["sha256"][:2])
                descriptor = self._open_blob(directory, value["sha256"], length)
                checksum, remaining = hashlib.sha256(), length
                while remaining:
                    part = os.read(descriptor, min(65536, remaining))
                    require(bool(part), "Attachment chunk was truncated while hashing", 409)
                    checksum.update(part)
                    digest.update(part)
                    remaining -= len(part)
                require(os.fstat(descriptor).st_size == length and not os.read(descriptor, 1),
                        "Attachment chunk changed length while hashing", 409)
                require(checksum.hexdigest() == value["sha256"], "Attachment chunk checksum is corrupt", 409)
                return True
            except OSError: raise APIError(503, "Attachment chunk file is unavailable or unsafe") from None
            finally:
                if descriptor is not None: os.close(descriptor)
                if directory is not None: os.close(directory)

    def write(self, identity, offset, data):
        key = self._key(identity, offset)
        require(isinstance(data, (bytes, bytearray)) and 0 < len(data) <= CHUNK_SIZE, "Invalid attachment chunk bytes")
        data = bytes(data)
        with self.store.transaction():
            self._check_root()
            require(self._manifest(identity, offset) is None and not self.store._execute(
                'SELECT 1 FROM fountain_private.attachment_chunks WHERE workspace_id=%s AND attachment_id=%s AND "offset"=%s',
                (self.store.workspace_id, identity, offset), fetch="one"), "Attachment chunk already exists", 409)
            digest = hashlib.sha256(data).hexdigest()
            directory = descriptor = None
            try:
                directory = self._directory(self._namespace, digest[:2], create=True)
                try: descriptor = self._open_blob(directory, digest, len(data), verify=True)
                except FileNotFoundError:
                    self._publish(directory, digest, data)
                    descriptor = self._open_blob(directory, digest, len(data), verify=True)
                # An earlier failed directory fsync can leave a valid orphan.
                # Reusing it must establish durability again before the SQL INSERT.
                os.fsync(descriptor)
                os.fsync(directory)
            except OSError: raise APIError(503, "Unable to publish attachment chunk safely") from None
            finally:
                if descriptor is not None: os.close(descriptor)
                if directory is not None: os.close(directory)
            stamp = timestamp()
            value = {"id": key, "attachment_id": identity, "offset": offset, "size": len(data),
                     "sha256": digest, "created_at": stamp, "updated_at": stamp}
            self.store._execute("INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) "
                                "VALUES (%s,'attachment_chunk',%s,%s,%s,%s)",
                                (self.store.workspace_id, key, self.store._json(value), stamp, stamp))
            self.store._advance_revision()

    def list(self, identity):
        self._key(identity, 0)
        with self.store._read():
            values = self.store._execute("SELECT id,data FROM fountain_private.entities WHERE workspace_id=%s "
                                        "AND kind='attachment_chunk' AND data->>'attachment_id'=%s",
                                        (self.store.workspace_id, identity), fetch="all")
            result = []
            for key, value in values:
                require(isinstance(value, dict) and type(value.get("offset")) is int
                        and value["offset"] >= 0 and value["offset"] % CHUNK_SIZE == 0,
                        "Invalid attachment chunk manifest", 409)
                self._validate_manifest(value, identity, value["offset"], self._key(identity, value["offset"]))
                require(key == value["id"], "Invalid attachment chunk manifest identity", 409)
                result.append((value["offset"], value["size"], "blob"))
            return sorted(result)

    def delete(self, identity):
        self._key(identity, 0)
        with self.store.transaction():
            count = self.store._execute("DELETE FROM fountain_private.entities WHERE workspace_id=%s "
                                        "AND kind='attachment_chunk' AND data->>'attachment_id'=%s",
                                        (self.store.workspace_id, identity))
            if count: self.store._advance_revision()
            return count

    def garbage_collect(self, now=None, limit=500):
        require(type(limit) is int and 1 <= limit <= 10000, "Invalid file collection limit")
        current = time.time() if now is None else (now.timestamp() if hasattr(now, "timestamp") else now)
        require(type(current) in (int, float) and math.isfinite(current), "Invalid collection time")
        with self.store.lock:
            # A caller's rollback must never revive a deleted manifest after GC
            # irreversibly unlinked its bytes. GC owns its outer transaction.
            require(self.store.transaction_depth == 0, "File collection requires an independent transaction", 409)
        return self._collect(current, limit)

    def _discover(self, cursor, limit):
        # Enumeration is deliberately outside the PostgreSQL writer. A directory
        # can contain many names, but heap selection keeps memory bounded and
        # other processes remain free to commit while we discover candidates.
        candidates = []
        for number in range(256):
            prefix = f"{number:02x}"
            if cursor and prefix < cursor["prefix"]: continue
            try: directory = self._directory(self._namespace, prefix)
            except FileNotFoundError: continue
            try:
                with os.scandir(directory) as entries:
                    names = heapq.nsmallest(limit - len(candidates), (
                        entry.name for entry in entries
                        if ((_HEX.fullmatch(entry.name) and entry.name.startswith(prefix)) or _TEMP.fullmatch(entry.name))
                        and (not cursor or prefix != cursor["prefix"] or entry.name > cursor["name"])))
                candidates.extend((prefix, name) for name in names)
            finally: os.close(directory)
            if len(candidates) >= limit:
                return candidates, {"version": 1, "prefix": prefix, "name": candidates[-1][1]}
        return candidates, None

    def _collect(self, current, limit):
        key = "attachment_file_gc_cursor"
        with self.store.transaction():
            self._check_root()
            cursor = self.store.meta(key)
            require(cursor is None or (isinstance(cursor, dict) and set(cursor) == {"version", "prefix", "name"}
                    and type(cursor["version"]) is int and cursor["version"] == 1
                    and isinstance(cursor["prefix"], str) and re.fullmatch(r"[0-9a-f]{2}", cursor["prefix"])
                    and isinstance(cursor["name"], str) and (_HEX.fullmatch(cursor["name"]) or _TEMP.fullmatch(cursor["name"]))),
                    "Invalid attachment collection cursor", 503)
        try: candidates, following = self._discover(cursor, limit)
        except OSError: raise APIError(503, "Attachment file discovery could not complete safely") from None
        removed = 0
        with self.store.transaction():
            self._check_root()
            # Another collector may have progressed while discovery ran. Its
            # cursor wins; a later bounded call will discover the next batch.
            if self.store.meta(key) != cursor: return {"removed": 0, "scanned": 0}
            references = self.store._execute("SELECT data->>'sha256' FROM fountain_private.entities "
                "WHERE workspace_id=%s AND kind='attachment_chunk' AND data->>'sha256'=ANY(%s)",
                (self.store.workspace_id, [item[1] for item in candidates]), fetch="all") if candidates else []
            retained = {item[0] for item in references}
            try:
                for prefix, name in candidates:
                    if name in retained: continue
                    directory = self._directory(self._namespace, prefix)
                    try:
                        try: info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        except FileNotFoundError: continue
                        if not stat.S_ISREG(info.st_mode) or info.st_mtime > current - 86400: continue
                        # Recheck the path immediately before unlink. Workspace
                        # writers cannot add a reference until this tx completes.
                        check = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        if (check.st_dev, check.st_ino, check.st_mtime_ns) != (info.st_dev, info.st_ino, info.st_mtime_ns): continue
                        os.unlink(name, dir_fd=directory)
                        os.fsync(directory)
                        removed += 1
                    finally: os.close(directory)
            except OSError: raise APIError(503, "Attachment file collection could not complete safely") from None
            if following != cursor: self.store.set_meta(key, following)
        return {"removed": removed, "scanned": len(candidates)}

    def close(self):
        for attribute in ("_namespace", "_root"):
            descriptor = getattr(self, attribute, None)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, attribute, None)
