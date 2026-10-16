"""Persistent workspace primitives, implemented entirely with the standard library."""
from __future__ import annotations

import ast
import base64
from contextvars import ContextVar
import copy
import csv
import io
import json
import math
import operator
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from contextlib import contextmanager
from typing import Any


AUDIT_ACTOR = ContextVar("fountain_actor", default="local")
CURRENT_ACCESS = ContextVar("fountain_access", default=None)

def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return uuid.uuid4().hex


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def require(condition, message, status=400):
    if not condition:
        raise APIError(status, message)


def text(value, name, limit=10000, empty=True):
    require(isinstance(value, str), f"{name} must be text")
    require(len(value) <= limit and (empty or value.strip()), f"Invalid {name}")
    return value


class Store:
    """Thread-safe JSON entity persistence; identifiers are namespaced by kind."""
    def __init__(self, db_path):
        self.lock = threading.RLock()
        self.transaction_depth = 0
        self.db = sqlite3.connect(str(db_path), check_same_thread=False)
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS entities (
                kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS attachment_chunks (
                attachment_id TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL,
                PRIMARY KEY(attachment_id,offset));
        """)
        self.db.commit()

    @contextmanager
    def transaction(self):
        """Claim the SQLite writer before a read-modify-write; nest with savepoints."""
        with self.lock:
            outer = self.transaction_depth == 0
            name = f"fountain_{self.transaction_depth}"
            self.db.execute("BEGIN IMMEDIATE" if outer else f"SAVEPOINT {name}")
            self.transaction_depth += 1
            try:
                yield self
            except BaseException:
                if outer:
                    self.db.rollback()
                else:
                    self.db.execute(f"ROLLBACK TO SAVEPOINT {name}")
                    self.db.execute(f"RELEASE SAVEPOINT {name}")
                raise
            else:
                if outer: self.db.commit()
                else: self.db.execute(f"RELEASE SAVEPOINT {name}")
            finally:
                self.transaction_depth -= 1

    def commit(self):
        if not self.transaction_depth:
            self.db.commit()

    def _advance_revision(self):
        self.db.execute("INSERT INTO meta(key,data) VALUES ('_entity_revision','1') "
                        "ON CONFLICT(key) DO UPDATE SET data=CAST(CAST(meta.data AS INTEGER)+1 AS TEXT)")

    def get(self, kind, entity_id):
        with self.lock:
            row = self.db.execute("SELECT data FROM entities WHERE kind=? AND id=?", (kind, entity_id)).fetchone()
            return json.loads(row[0]) if row else None

    def list(self, kind):
        with self.lock:
            return [json.loads(r[0]) for r in self.db.execute(
                "SELECT data FROM entities WHERE kind=? ORDER BY created_at,id", (kind,)).fetchall()]

    def put(self, kind, data):
        require(isinstance(data, dict), "Entity must be an object")
        data = copy.deepcopy(data)
        entity_id = data.get("id") or uid()
        text(entity_id, "id", 160, False)
        with self.lock:
            previous = self.get(kind, entity_id)
            data.update(id=entity_id, created_at=(previous or {}).get("created_at", now()), updated_at=now())
            self.db.execute("INSERT OR REPLACE INTO entities VALUES (?,?,?,?,?)", (
                kind, entity_id, json.dumps(data, ensure_ascii=False), data["created_at"], data["updated_at"]))
            self._advance_revision()
            self.commit()
        return data

    def delete(self, kind, entity_id):
        with self.lock:
            cursor = self.db.execute("DELETE FROM entities WHERE kind=? AND id=?", (kind, entity_id))
            if cursor.rowcount: self._advance_revision()
            self.commit()

    def meta(self, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT data FROM meta WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def set_meta(self, key, value):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))
            if key != '_entity_revision': self._advance_revision()
            self.commit()
        return value

    def audit(self, action, details, user=None):
        return self.put("audit", {"action": action, "details": details, "user": user if user is not None else AUDIT_ACTOR.get()})

    def close(self):
        with self.lock:
            self.db.close()


BLOCK_TYPES = {"paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo",
               "quote", "code", "callout", "divider", "toggle", "image", "bookmark", "file",
               "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do"}
PROPERTY_TYPES = {"title", "text", "number", "select", "multi_select", "date", "checkbox", "person", "url", "email",
                  "status", "relation", "rollup", "formula", "files", "created_time", "last_edited_time"}


ARITHMETIC = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
              ast.Div: operator.truediv, ast.Mod: operator.mod}
COMPARISONS = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt,
               ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge}


def formula_tree(source):
    text(source, "formula expression", 2000, False)
    try:
        tree = ast.parse(source, mode="eval")
    except (SyntaxError, RecursionError):
        raise APIError(400, "Invalid formula expression")
    nodes = list(ast.walk(tree))
    require(len(nodes) <= 200, "Formula is too complex")
    allowed = {ast.Expression, ast.Constant, ast.Name, ast.Load, ast.BinOp, ast.UnaryOp,
               ast.UAdd, ast.USub, ast.Not, ast.BoolOp, ast.And, ast.Or, ast.Compare,
               ast.Call, *ARITHMETIC, *COMPARISONS}
    for node in nodes:
        require(type(node) in allowed, "Unsupported formula syntax")
        if isinstance(node, ast.Constant):
            require(type(node.value) in {str, int, float, bool, type(None)}, "Unsupported formula literal")
            if type(node.value) in (int, float):
                require(abs(node.value) <= 1e15, "Formula literal exceeds numeric range")
        if isinstance(node, ast.Call):
            require(isinstance(node.func, ast.Name) and node.func.id in {"prop", "concat", "coalesce"}
                    and not node.keywords and len(node.args) <= 20, "Unsupported formula function")
            if node.func.id == "prop":
                require(len(node.args) == 1 and isinstance(node.args[0], ast.Constant)
                        and isinstance(node.args[0].value, str), "prop requires a literal property name")
    return tree.body


def evaluate_formula(node, get):
    if isinstance(node, ast.Constant): return node.value
    if isinstance(node, ast.Name): return get(node.id)
    if isinstance(node, ast.Call):
        if node.func.id == "prop": return get(node.args[0].value)
        values = [evaluate_formula(arg, get) for arg in node.args]
        if node.func.id == "coalesce": return next((v for v in values if v is not None), None)
        result = "".join(str(v) if v is not None else "" for v in values)
    elif isinstance(node, ast.BinOp):
        left, right = evaluate_formula(node.left, get), evaluate_formula(node.right, get)
        if isinstance(node.op, ast.Add) and isinstance(left, str) and isinstance(right, str):
            result = left + right
        else:
            if type(left) not in (int, float) or type(right) not in (int, float):
                raise ValueError("Arithmetic requires numeric properties")
            result = ARITHMETIC[type(node.op)](left, right)
    elif isinstance(node, ast.UnaryOp):
        value = evaluate_formula(node.operand, get)
        if isinstance(node.op, ast.Not): return not value
        if type(value) not in (int, float): raise ValueError("Unary arithmetic requires a number")
        result = value if isinstance(node.op, ast.UAdd) else -value
    elif isinstance(node, ast.BoolOp):
        result = evaluate_formula(node.values[0], get)
        for operand in node.values[1:]:
            if (isinstance(node.op, ast.And) and not result) or (isinstance(node.op, ast.Or) and result): break
            result = evaluate_formula(operand, get)
    else:
        left = evaluate_formula(node.left, get)
        for op, operand in zip(node.ops, node.comparators):
            right = evaluate_formula(operand, get)
            if not COMPARISONS[type(op)](left, right): return False
            left = right
        return True
    if isinstance(result, str) and len(result) > 100000: raise ValueError("Formula output is too large")
    if type(result) in (int, float) and (not math.isfinite(result) or abs(result) > 1e15):
        raise ValueError("Formula result is outside the supported numeric range")
    return result


class Workspace:
    def __init__(self, store):
        self.store = store
        self.lock = store.lock
        self.seed()

    def seed(self):
        with self.store.transaction():
            if not self.store.meta('workspace_id'):
                self.store.set_meta('workspace_id', uid())
            if self.store.meta("seeded"):
                return
            self.store.set_meta("settings", {"name": "Fountain 워크스페이스", "icon": "⛲", "plan": "local", "locale": "ko"})
            self.store.put("member", {"id": "local", "name": "나", "email": "local@fountain.local", "role": "owner"})
            self.store.put("teamspace", {"id": "general", "name": "팀 워크스페이스", "icon": "🏠", "visibility": "open"})
            page = self.create_page({"id": "welcome", "title": "시작하기", "icon": "👋", "teamspace_id": "general"})
            self.save_blocks(page["id"], [
                {"type": "heading1", "text": "생각을 모으고, 함께 완성하세요"},
                {"type": "paragraph", "text": "Fountain은 문서, 프로젝트와 지식을 한곳에서 관리하는 로컬 워크스페이스입니다."},
                {"type": "callout", "text": "왼쪽에서 새 페이지를 만들고 / 명령으로 블록을 추가하세요."},
                {"type": "todo", "text": "첫 페이지 만들기", "checked": False},
                {"type": "todo", "text": "프로젝트 데이터베이스 살펴보기", "checked": False},
            ])
            self.create_page({"id": "notes", "title": "팀 위키", "icon": "📚", "teamspace_id": "general",
                              "blocks": [{"type": "heading1", "text": "팀의 모든 지식"}, {"type": "paragraph", "text": "팀의 원칙과 회의 기록을 이곳에 모으세요."}]})
            self.create_database({"id": "projects", "name": "프로젝트", "icon": "📋", "properties": [
                {"id": "name", "name": "이름", "type": "title"},
                {"id": "status", "name": "상태", "type": "status", "options": ["시작 전", "진행 중", "완료"]},
                {"id": "priority", "name": "우선순위", "type": "select", "options": ["높음", "보통", "낮음"]},
                {"id": "due", "name": "마감일", "type": "date"},
                {"id": "assignee", "name": "담당자", "type": "person"}]})
            for name, status, priority, due in [("브랜드 웹사이트 리뉴얼", "진행 중", "높음", "2026-10-23"), ("고객 인터뷰 정리", "시작 전", "보통", "2026-10-27"), ("분기 로드맵 공유", "완료", "높음", "2026-10-16")]:
                self.create_row("projects", {"properties": {"name": name, "status": status, "priority": priority, "due": due, "assignee": "나"}})
            self.store.set_meta("seeded", True)

    def snapshot(self):
        return {"workspace_id": self.store.meta('workspace_id'), "pages": self.store.list("page"), "databases": self.store.list("database"),
                "teamspaces": self.store.list("teamspace"), "members": self.store.list("member"),
                "settings": self.store.meta("settings", {})}

    def page(self, page_id):
        page = self.store.get("page", page_id)
        require(page is not None, "Page not found", 404)
        return page

    def detail(self, page_id):
        page = self.page(page_id)
        return {"page": page, "blocks": page.get("blocks", []),
                "versions": sorted([v for v in self.store.list("version") if v["page_id"] == page_id], key=lambda v: v["created_at"], reverse=True),
                "comments": [c for c in self.store.list("comment") if c["page_id"] == page_id]}

    def create_page(self, body):
        title = text(body.get("title", "제목 없음"), "title", 500)
        if body.get("id"):
            require(self.store.get("page", body["id"]) is None, "Page id already exists", 409)
        parent = body.get("parent_id")
        if parent:
            self.page(parent)
        page = self.store.put("page", {"id": body.get("id") or uid(), "title": title,
            "icon": text(body.get("icon", "📄"), "icon", 80), "cover": text(body.get("cover", ""), "cover", 4000),
            "parent_id": parent, "teamspace_id": body.get("teamspace_id", "general"), "favorite": False,
            "owner_id": body.get("owner_id", AUDIT_ACTOR.get()), "permissions": copy.deepcopy(body.get("permissions")) if "permissions" in body else None,
            "archived": False, "locked": False, "revision": 0, "blocks": self.validate_blocks(body.get("blocks", []))})
        self.store.audit("page.created", {"page_id": page["id"]})
        return page

    def update_page(self, page_id, body):
        with self.lock:
            page = self.page(page_id)
            self.check_revision(page, body.get("revision"))
            for field in ["title", "icon", "cover"]:
                if field in body:
                    page[field] = text(body[field], field, 500 if field == "title" else 4000)
            for field in ["favorite", "archived", "locked"]:
                if field in body:
                    require(isinstance(body[field], bool), f"{field} must be boolean")
                    page[field] = body[field]
            if body.get("archived") is True: page.setdefault("deleted_at", now())
            if body.get("archived") is False: page.pop("deleted_at", None)
            if "parent_id" in body:
                parent = body["parent_id"]
                visited = {page_id}
                while parent:
                    require(parent not in visited, "Page hierarchy cannot contain cycles")
                    visited.add(parent)
                    parent = self.page(parent).get("parent_id")
                page["parent_id"] = body["parent_id"]
            page["revision"] += 1
            self.store.audit("page.updated", {"page_id": page_id})
            return self.store.put("page", page)

    @staticmethod
    def check_revision(page, revision):
        if revision is not None:
            require(type(revision) is int and revision == page["revision"], "Document changed. Reload before saving.", 409)

    def validate_blocks(self, blocks):
        from .crdt import normalize_blocks
        return normalize_blocks(blocks)

    def save_blocks(self, page_id, blocks, revision=None):
        with self.store.transaction():
            page = self.page(page_id)
            require(not page.get("locked"), "Page is locked", 423)
            self.check_revision(page, revision)
            blocks = self.validate_blocks(blocks)
            self.store.put("version", {"page_id": page_id, "revision": page["revision"], "title": page["title"], "blocks": page.get("blocks", [])})
            page.update(blocks=blocks, revision=page["revision"] + 1)
            page = self.store.put("page", page)
            self.store.delete('collaboration', page_id)
            self.store.audit("page.saved", {"page_id": page_id, "revision": page["revision"]})
            return {"page": page, "blocks": blocks, "revision": page["revision"]}

    def restore_version(self, page_id, version_id):
        version = self.store.get("version", version_id)
        require(version and version["page_id"] == page_id, "Version not found", 404)
        return self.save_blocks(page_id, version["blocks"])

    def search(self, query):
        query = text(query, "query", 500).casefold()
        pages = [p for p in self.store.list("page") if not p.get("archived") and (query in p["title"].casefold() or any(query in b.get("text", "").casefold() for b in p.get("blocks", [])))]
        return {"results": pages, "pages": pages}

    def create_comment(self, page_id, body):
        self.page(page_id)
        author = AUDIT_ACTOR.get()
        member = self.store.get('member', author) or {}
        comment = self.store.put("comment", {"page_id": page_id, "text": text(body.get("text", ""), "comment", 10000, False),
            "block_id": body.get("block_id"), "author": author, "author_name": member.get('name', '나'), "resolved": False})
        self.store.audit('comment.created', {'page_id': page_id, 'id': comment['id']})
        return comment

    def database(self, database_id):
        database = self.store.get("database", database_id)
        require(database is not None, "Database not found", 404)
        return database

    def validate_properties(self, properties):
        require(isinstance(properties, list) and 0 < len(properties) <= 100, "Provide 1 to 100 properties")
        ids = set()
        for prop in properties:
            require(isinstance(prop, dict), "Property must be an object")
            prop.setdefault("id", uid())
            text(prop["id"], "property id", 160, False)
            text(prop.get("name", ""), "property name", 200, False)
            require(prop.get("type") in PROPERTY_TYPES, "Unsupported property type")
            require(prop["id"] not in ids, "Duplicate property id")
            ids.add(prop["id"])
            if prop["type"] == "formula": formula_tree(prop.get("expression", prop.get("formula", "")))
            if prop["type"] == "relation" and prop.get("database_id") is not None:
                text(prop["database_id"], "relation database", 160, False)
            if prop["type"] == "rollup":
                require(prop.get("aggregation") in {"sum", "count", "average", "min", "max"}, "Invalid rollup aggregation")
                text(prop.get("target_property"), "rollup target", 160, False)
        known = {p["id"]: p for p in properties}
        for prop in properties:
            if prop["type"] == "rollup":
                require(known.get(prop.get("relation_property"), {}).get("type") == "relation", "Rollup requires a relation property")
        return properties

    def create_database(self, body):
        if body.get("id"):
            require(self.store.get("database", body["id"]) is None, "Database id already exists", 409)
        database = {"id": body.get("id") or uid(), "name": text(body.get("name", "새 데이터베이스"), "name", 500, False),
            "owner_id": body.get("owner_id", AUDIT_ACTOR.get()), "teamspace_id": body.get("teamspace_id", "general"),
            "permissions": copy.deepcopy(body.get("permissions")) if "permissions" in body else None,
            "row_permissions": copy.deepcopy(body.get("row_permissions", {})),
            "icon": body.get("icon", "📊"), "properties": self.validate_properties(copy.deepcopy(body.get("properties", [{"id": "name", "name": "이름", "type": "title"}]))),
            "views": body.get("views", [{"id": "table", "name": "테이블", "type": "table"}])}

        from .tasks import validate_settings
        database['task_settings'] = validate_settings(body.get('task_settings', {}), database)
        return self.store.put('database', database)

    def validate_values(self, database, values, relation_rows=None):
        require(isinstance(values, dict), "properties must be an object")
        known = {p["id"]: p for p in database["properties"]}
        for key, value in values.items():
            require(key in known, f"Unknown property: {key}")
            kind = known[key]["type"]
            require(kind not in {"formula", "rollup"}, f"{key} is computed and cannot be assigned")
            if value is None:
                continue
            if kind == "number":
                require(type(value) in (int, float) and abs(value) < 1e15, f"{key} must be a finite number")
            elif kind == "checkbox":
                require(type(value) is bool, f"{key} must be boolean")
            elif kind == "date":
                from .tasks import validate_date_value
                values[key] = validate_date_value(value)
            elif kind in {"multi_select", "relation", "files"}:
                require(isinstance(value, list) and len(value) <= 1000, f"{key} must be a list")
                if kind == "relation":
                    require(all(isinstance(identity, str) for identity in value), "Relation values must be row ids")
                    require(len(set(value)) == len(value), "Duplicate relation row")
                    for identity in value:
                        target = relation_rows.get(identity) if relation_rows is not None else self.store.get("row", identity)
                        require(target and (not known[key].get("database_id") or target["database_id"] == known[key]["database_id"]), "Relation target row not found in target database")
            elif kind not in {"rollup", "formula"}:
                text(value, key, 100000)
        return values

    def create_row(self, database_id, body):
        from .tasks import TaskGraph
        with self.store.transaction():
            database = self.database(database_id)
            identity = text(body.get('id') or uid(), 'row id', 160, False)
            require(self.store.get('row', identity) is None, 'Row id already exists', 409)
            values = body.get('properties', body.get('values', {}))
            settings = database.get('task_settings', {})
            has_links = bool(body.get('parent_row_id') or body.get('depends_on') or settings.get('subitems') or settings.get('dependencies'))
            links = TaskGraph(self.store).prepare_row(database, identity, body) if has_links else {'parent_row_id': None, 'depends_on': []}
            if not has_links:
                require(body.get('parent_row_id') is None and body.get('depends_on', []) == [], 'Enable task links before adding them')
            row = self.store.put('row', {'id': identity, 'database_id': database_id,
                'owner_id': body.get('owner_id', AUDIT_ACTOR.get()),
                'properties': self.validate_values(database, values), **links})
            self.store.audit('row.created', {'database_id': database_id, 'row_id': row['id']})
            return row

    def update_row(self, database_id, row_id, body, can_edit=None):
        from .tasks import TaskGraph
        with self.store.transaction():
            database = self.database(database_id)
            row = self.store.get('row', row_id)
            require(row and row['database_id'] == database_id, 'Row not found', 404)
            access = CURRENT_ACCESS.get()
            if can_edit is None and access is not None: can_edit = lambda item: access.can('row', item, 3)
            require(can_edit is None or can_edit(row), 'Insufficient row edit permission', 403)
            previous = copy.deepcopy(row)
            row['properties'].update(self.validate_values(database, body.get('properties', body.get('values', {}))))
            graph = TaskGraph(self.store)
            settings = database.get('task_settings', {})
            has_links = bool(previous.get('parent_row_id') or previous.get('depends_on') or settings.get('subitems') or settings.get('dependencies') or body.get('parent_row_id') or body.get('depends_on'))
            if has_links: row.update(graph.prepare_row(database, row_id, body, existing=previous))
            else: require(body.get('parent_row_id') is None and body.get('depends_on', []) == [], 'Invalid task links')
            shifted = graph.plan_shift(database, previous, row, can_edit=can_edit) if settings.get('dependencies') else []
            row = self.store.put('row', row)
            self.store.audit('row.updated', {'database_id': database_id, 'row_id': row_id})
            for dependent in shifted:
                self.store.put('row', dependent)
                self.store.audit('row.schedule.shifted', {'database_id': database_id, 'row_id': dependent['id'], 'source_row_id': row_id})
            return row

    def delete_row(self, database_id, row_id, can_edit=None):
        from .tasks import TaskGraph
        with self.store.transaction():
            self.database(database_id)
            root = self.store.get('row', row_id)
            require(root and root['database_id'] == database_id, 'Row not found', 404)
            has_children = any(item.get('database_id') == database_id and item.get('parent_row_id') == row_id for item in self.store.list('row'))
            deleted = TaskGraph(self.store).descendants(database_id, row_id) if has_children else [root]
            require(can_edit is None or all(can_edit(item) for item in deleted), 'Cannot delete a subitem without edit permission', 403)
            deleted_ids = {item['id'] for item in deleted}
            # Removing a predecessor clears its edges, so later edits never inherit dangling links.
            for row in self.store.list('row'):
                if row.get('database_id') != database_id or row['id'] in deleted_ids: continue
                if deleted_ids.intersection(row.get('depends_on', [])):
                    row['depends_on'] = [identity for identity in row['depends_on'] if identity not in deleted_ids]
                    self.store.put('row', row)
            for item in deleted:
                self.store.delete('row', item['id'])
                self.store.audit('row.deleted', {'database_id': database_id, 'row_id': item['id']})
            return {'deleted': True, 'count': len(deleted_ids)}

    def duplicate_row(self, database_id, row_id, can_read=None):
        from .tasks import TaskGraph
        with self.store.transaction():
            planned = TaskGraph(self.store).duplicate_plan(database_id, row_id, AUDIT_ACTOR.get(), can_read)
            rows = [self.store.put('row', item) for item in planned]
            for row in rows:
                self.store.audit('row.duplicated', {'database_id': database_id, 'row_id': row['id'], 'source_row_id': row_id})
            return {'root_id': rows[0]['id'], 'rows': rows}

    def computed_rows(self, database, rows, can_read_row=None):
        cache, databases = {}, {database["id"]: database}
        def resolve(row, key, trail=()):
            token = (row["id"], key)
            if token in trail: raise ValueError("Circular formula or rollup reference")
            if len(trail) > 50: raise ValueError("Computed dependency chain is too deep")
            if token in cache: return cache[token]
            if row["database_id"] not in databases:
                databases[row["database_id"]] = self.database(row["database_id"])
            db = databases[row["database_id"]]
            prop = next((p for p in db["properties"] if p["id"] == key), None)
            if prop is None: prop = next((p for p in db["properties"] if p["name"] == key), None)
            if prop is None: raise ValueError(f"Unknown property: {key}")
            key, trail = prop["id"], (*trail, token)
            if prop["type"] == "formula":
                result = evaluate_formula(formula_tree(prop.get("expression", prop.get("formula", ""))), lambda name: resolve(row, name, trail))
            elif prop["type"] == "rollup":
                related = resolve(row, prop["relation_property"], trail) or []
                targets = [self.store.get("row", identity) for identity in related]
                if can_read_row: targets = [target for target in targets if target is not None and can_read_row(target)]
                if any(target is None for target in targets): raise ValueError("Related row was deleted")
                values = [resolve(target, prop["target_property"], trail) for target in targets]
                aggregation = prop["aggregation"]
                values = [v for v in values if v is not None]
                if aggregation == "count": result = len(values)
                else:
                    if any(type(value) not in (int, float) for value in values): raise ValueError("Rollup requires numeric values")
                    result = (sum(values) if aggregation == "sum" else sum(values) / len(values) if aggregation == "average"
                              else min(values) if aggregation == "min" else max(values)) if values or aggregation == "sum" else None
            elif prop['type'] == 'relation' and can_read_row:
                result = [identity for identity in row['properties'].get(key, []) if (target := self.store.get('row', identity)) and can_read_row(target)]
            else: result = row["properties"].get(key)
            cache[token] = result
            return result
        for row in rows:
            errors = {}
            for prop in database["properties"]:
                if prop["type"] not in {"formula", "rollup"}: continue
                try: row["properties"][prop["id"]] = resolve(row, prop["id"])
                except (APIError, ValueError, TypeError, ZeroDivisionError, OverflowError) as error:
                    row["properties"][prop["id"]] = None
                    errors[prop["id"]] = str(error)
            if errors: row["computed_errors"] = errors
        return rows

    def database_detail(self, database_id, filters=None, sorts=None, can_read_row=None):
        database = self.database(database_id)
        rows = [r for r in self.store.list("row") if r["database_id"] == database_id]
        if can_read_row: rows = [row for row in rows if can_read_row(row)]
        rows = self.computed_rows(database, rows, can_read_row)
        if filters:
            require(isinstance(filters, list) and len(filters) <= 50, "Invalid filters")
            for rule in filters:
                require(isinstance(rule, dict), "Invalid filter")
                key, op, value = rule.get("property"), rule.get("operator", "equals"), rule.get("value")
                require(op in {"equals", "not_equals", "contains", "is_empty", "greater_than", "less_than"}, "Invalid filter operator")
                def matches(row):
                    current = row["properties"].get(key)
                    if op == "equals": return current == value
                    if op == "not_equals": return current != value
                    if op == "contains": return str(value).casefold() in str(current or "").casefold()
                    if op == "is_empty": return current in (None, "", [])
                    try: return current > value if op == "greater_than" else current < value
                    except TypeError: return False
                rows = [r for r in rows if matches(r)]
        if sorts:
            require(isinstance(sorts, list) and len(sorts) <= 20, "Invalid sorts")
            for rule in reversed(sorts):
                require(isinstance(rule, dict), "Invalid sort")
                key = rule.get("property")
                def sort_key(row):
                    val = row["properties"].get(key)
                    return (val is None, 0 if type(val) in (int, float) else 1, val if type(val) in (int, float) else str(val or "").casefold())
                rows.sort(key=sort_key, reverse=rule.get("direction") == "descending")
        return {"database": database, "rows": rows}

    def export(self, format="json", database_id=None):
        if format == "csv":
            detail = self.database_detail(database_id or "projects")
            output = io.StringIO()
            properties = detail["database"]["properties"]
            writer = csv.writer(output)
            writer.writerow([p["name"] for p in properties])
            for row in detail["rows"]:
                writer.writerow([row["properties"].get(p["id"], "") for p in properties])
            return {"filename": "database.csv", "content": output.getvalue(), "mime": "text/csv"}
        if format == "markdown":
            from .richtext import block_depths, inline_markdown
            output = []
            for page in self.store.list("page"):
                if page.get("archived"): continue
                output.append("# " + page["title"])
                depths = block_depths(page.get('blocks', []))
                for block in page.get("blocks", []):
                    kind, content = block["type"], inline_markdown(block)
                    prefix = {"heading1": "# ", "heading2": "## ", "heading3": "### ", "bullet": "- ", "numbered": "1. ", "quote": "> ", "todo": "- [x] " if block.get("checked") else "- [ ] "}.get(kind, "")
                    if kind == 'code':
                        raw = block.get('text', '')
                        fence = '`' * max(3, max((len(part) for part in re.findall(r'`+', raw)), default=0) + 1)
                        content = fence + '\n' + raw + '\n' + fence
                    else:
                        content = prefix + content
                    output.append('  ' * depths[block['id']] + content)
                output.append("")
            return {"filename": "workspace.md", "content": "\n\n".join(output), "mime": "text/markdown"}
        require(format == "json", "Unsupported export format")
        return {"filename": "workspace.json", "content": json.dumps({"format": "fountain-v1", **self.snapshot(), "rows": self.store.list("row")}, ensure_ascii=False, indent=2), "mime": "application/json"}

    def import_data(self, body):
        with self.store.transaction():
            return self._import_data(body)

    def _import_data(self, body):
        private = {"default": "private", "inherit": False, "members": {}, "groups": {}}
        format, content = body.get("format", "markdown"), text(body.get("content", ""), "content", 2000000)
        if format == "markdown":
            blocks = []
            for line in content.splitlines():
                kind = "paragraph"
                for prefix, candidate in [("### ", "heading3"), ("## ", "heading2"), ("# ", "heading1"), ("- ", "bullet"), ("> ", "quote")]:
                    if line.startswith(prefix):
                        kind, line = candidate, line[len(prefix):]
                        break
                blocks.append({"type": kind, "text": line})
            return {"page": self.create_page({"title": body.get("title", "가져온 문서"), "blocks": blocks, "permissions": private})}
        if format == "csv":
            reader = csv.DictReader(io.StringIO(content))
            require(reader.fieldnames and len(reader.fieldnames) <= 100, "CSV requires a header with at most 100 columns")
            data = list(reader)
            require(len(data) <= 10000, "CSV row limit exceeded")
            props = [{"id": str(i), "name": name, "type": "title" if i == 0 else "text"} for i, name in enumerate(reader.fieldnames)]
            for row in data:
                require(None not in row, "CSV row has more fields than header")
                for value in row.values():
                    if value is not None: text(value, "CSV value", 100000)
            database = self.create_database({"name": body.get("title", "가져온 데이터"), "properties": props, "permissions": private})
            for row in data:
                self.create_row(database["id"], {"properties": {str(i): row[name] for i, name in enumerate(reader.fieldnames)}})
            return {"database": database, "count": len(data)}
        require(format == "json", "Unsupported import format")
        try: data = json.loads(content)
        except ValueError: raise APIError(400, "Invalid JSON import")
        require(isinstance(data, dict) and isinstance(data.get("pages"), list) and len(data["pages"]) <= 1000, "Invalid workspace import")
        # Validate the complete input before writing any entity; assign fresh ids
        # on import so loading a backup never overwrites an existing workspace.
        databases = data.get("databases", [])
        rows = data.get("rows", [])
        require(isinstance(databases, list) and len(databases) <= 1000, "Invalid imported databases")
        require(isinstance(rows, list) and len(rows) <= 100000, "Invalid imported rows")
        page_ids, db_ids = {}, {}
        for page in data["pages"]:
            require(isinstance(page, dict), "Invalid imported page")
            text(page.get("title", ""), "title", 500)
            text(page.get("icon", "📄"), "icon", 80)
            text(page.get("cover", ""), "cover", 4000)
            self.validate_blocks(page.get("blocks", []))
            if page.get("id"):
                text(page["id"], "id", 160, False)
                require(page["id"] not in page_ids, "Duplicate imported page")
                page_ids[page["id"]] = page
        for page in data["pages"]:
            visited = {page.get("id")}
            parent = page.get("parent_id")
            while parent:
                require(parent in page_ids and parent not in visited, "Invalid imported page hierarchy")
                visited.add(parent)
                parent = page_ids[parent].get("parent_id")
        for database in databases:
            require(isinstance(database, dict) and isinstance(database.get("id"), str), "Invalid imported database")
            require(database["id"] not in db_ids, "Duplicate imported database")
            text(database.get("name", ""), "name", 500, False)
            database["properties"] = self.validate_properties(copy.deepcopy(database.get("properties")))
            db_ids[database["id"]] = database
        imported_rows = {}
        for row in rows:
            require(isinstance(row, dict) and row.get("database_id") in db_ids, "Invalid imported row database")
            text(row.get("id"), "imported row id", 160, False)
            require(row["id"] not in imported_rows, "Duplicate imported row")
            imported_rows[row["id"]] = row
        for database in databases:
            from .tasks import validate_settings
            database['task_settings'] = validate_settings(database.get('task_settings', {}), database)
        for row in rows:
            self.validate_values(db_ids[row["database_id"]], row.get("properties"), imported_rows)
            if row.get('parent_row_id') or row.get('depends_on'):
                from .tasks import TaskGraph
                TaskGraph(self.store).prepare_row(db_ids[row['database_id']], row['id'], row, existing=row, rows=imported_rows)
        pages, page_map, database_map = [], {}, {}
        for page in data["pages"]:
            created = self.create_page({"title": page.get("title", "제목 없음"), "blocks": page.get("blocks", []), "icon": page.get("icon", "📄"), "cover": page.get("cover", ""), "permissions": private})
            pages.append(created)
            if page.get("id"): page_map[page["id"]] = created["id"]
        for page, created in zip(data["pages"], pages):
            if page.get("parent_id"):
                created["parent_id"] = page_map[page["parent_id"]]
                created["permissions"]["inherit"] = True
                self.store.put("page", created)
        database_map = {database["id"]: uid() for database in databases}
        for database in databases:
            imported = copy.deepcopy(database)
            imported["id"] = database_map[database["id"]]
            imported.update(owner_id=AUDIT_ACTOR.get(), permissions=copy.deepcopy(private), teamspace_id="general", row_permissions={})
            for prop in imported["properties"]:
                if prop["type"] == "relation" and prop.get("database_id") in database_map:
                    prop["database_id"] = database_map[prop["database_id"]]
            self.create_database(imported)
        row_map = {row["id"]: uid() for row in rows}
        for row in rows:
            values = copy.deepcopy(row["properties"])
            for prop in db_ids[row["database_id"]]["properties"]:
                if prop["type"] == "relation" and values.get(prop["id"]):
                    values[prop["id"]] = [row_map[identity] for identity in values[prop["id"]]]
            self.store.put("row", {"id": row_map[row["id"]], "owner_id": AUDIT_ACTOR.get(), "database_id": database_map[row["database_id"]], "properties": values, "parent_row_id": row_map.get(row.get("parent_row_id")), "depends_on": [row_map[identity] for identity in row.get("depends_on", [])]})
        return {"pages": pages, "databases": list(database_map.values()), "count": len(pages), "row_count": len(rows)}

    def attachment(self, body):
        name = text(body.get("name", ""), "filename", 255, False)
        require("/" not in name and "\\" not in name, "Invalid filename")
        encoded = text(body.get("data", ""), "attachment data", 7000000, False)
        try: raw = base64.b64decode(encoded, validate=True)
        except ValueError: raise APIError(400, "Invalid base64 attachment")
        require(len(raw) <= 5000000, "Attachment exceeds 5 MB", 413)
        # Download as attachment; never execute uploaded HTML or SVG in this origin.
        return self.store.put("attachment", {"name": name, "owner_id": body.get("owner_id", AUDIT_ACTOR.get()), "data": encoded, "size": len(raw), "mime": "application/octet-stream"})
