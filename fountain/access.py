"""Per-request workspace, teamspace and database-row authorization."""
from __future__ import annotations

import copy

from .core import require

LEVELS = {"none": 0, "view": 1, "comment": 2, "edit": 3, "full": 4}
ROLES = {"owner", "admin", "member", "guest"}


class Access:
    def __init__(self, store, principal):
        self.store = store
        self.principal = principal if isinstance(principal, dict) else {}
        self.member_id = self.principal.get("id")
        self.active = (isinstance(self.member_id, str) and bool(self.member_id)
                       and self.principal.get("role") in ROLES
                       and self.principal.get("active", True) is True)
        self.owner = self.active and self.principal.get("role") == "owner"
        self.regular = self.active and self.principal.get("role") != "guest"
        self.groups = {group["id"] for group in store.list("group")
                       if isinstance(group.get("members"), list)
                       and self.member_id in group["members"]} if self.active else set()

    def require_admin(self, owner_only=False):
        allowed = self.owner or (not owner_only and self.active
                                and self.principal.get("role") == "admin")
        require(allowed, "Workspace administrator permission required", 403)

    def _owns(self, entity):
        return self.active and entity.get("owner_id", "local") == self.member_id

    def _teamspace_level(self, entity):
        if self.owner or self._owns(entity):
            return 4
        if not self.active:
            return 0
        members, groups = entity.get("members", []), entity.get("groups", [])
        if not isinstance(members, list) or not isinstance(groups, list) or not all(isinstance(group, str) for group in groups):
            return 0
        if (self.member_id in members or bool(self.groups.intersection(groups))):
            return 3
        return 3 if self.regular and entity.get("visibility", "open") == "open" else 0

    def _workspace_level(self, entity):
        if not self.regular:
            return 0
        teamspace_id = entity.get("teamspace_id")
        if not teamspace_id:
            return 3
        teamspace = self.store.get("teamspace", teamspace_id)
        return min(3, self._teamspace_level(teamspace)) if teamspace else 0

    def _acl(self, permissions):
        """Return explicit override and default; invalid persisted ACL fails closed."""
        if not isinstance(permissions, dict):
            return 0, 0
        default = permissions.get("default", "workspace")
        if (not isinstance(default, str) or default not in {"workspace", "private"}
                or type(permissions.get("inherit", False)) is not bool):
            return 0, 0
        members, groups = permissions.get("members", {}), permissions.get("groups", {})
        if not isinstance(members, dict) or not isinstance(groups, dict):
            return 0, 0
        if any(not isinstance(identity, str) or not isinstance(value, str) or value not in LEVELS
               for grants in (members, groups) for identity, value in grants.items()):
            return 0, 0
        if self.member_id in members:
            return LEVELS.get(members[self.member_id], 0), 0
        matching = [LEVELS.get(groups[group_id], 0) for group_id in self.groups if group_id in groups]
        if matching:
            return max(matching), 0
        return None, permissions.get("default", "workspace")

    def level(self, kind, entity):
        return self._level(kind, entity, set())

    def _level(self, kind, entity, trail):
        if not self.active or not isinstance(entity, dict):
            return 0
        if self.owner:
            return 4
        token = (kind, entity.get("id"))
        if token in trail or len(trail) >= 64:
            return 0
        trail = trail | {token}
        if kind == "teamspace":
            return self._teamspace_level(entity)
        if kind == "row":
            return self._row_level(entity, trail)
        if kind not in {"page", "database"}:
            return 0
        if self._owns(entity):
            return 4
        permissions = entity.get("permissions")
        if permissions is not None:
            override, default = self._acl(permissions)
            if override is not None:
                return override
        else:
            default = "workspace"
        parent_id = entity.get("parent_id")
        inherit = permissions is None or permissions.get("inherit", False) is True
        if parent_id and inherit:
            parent = self.store.get("page", parent_id)
            # A missing/cyclic parent cannot fall back to a permissive workspace.
            return self._level("page", parent, trail)
        return self._workspace_level(entity) if default == "workspace" else 0

    def _row_level(self, row, trail):
        database = self.store.get("database", row.get("database_id"))
        db_level = self._level("database", database, trail)
        if not db_level:
            return 0
        if self._owns(database):
            return 4
        policy = self._row_policy(database)
        if policy is None:
            return 0
        level = db_level
        if db_level < 4 and policy.get("mode", "all") == "assigned":
            value = row.get("properties", {}).get(policy.get("property_id"))
            member = self.store.get("member", self.member_id) or self.principal
            email = member.get("email")
            values = value if isinstance(value, list) else [value]
            if not any(isinstance(item, str) and (item == self.member_id or
                       (isinstance(email, str) and bool(email) and item.casefold() == email.casefold()))
                       for item in values):
                return 0
            level = min(db_level, 3) if policy.get("edit_assigned", False) is True else min(db_level, 1)
        permissions = row.get("permissions")
        if permissions is not None:
            override, default = self._acl(permissions)
            acl_level = override if override is not None else (db_level if default == "workspace" else 0)
            level = min(level, acl_level)
        return level

    @staticmethod
    def _row_policy(database):
        policy = database.get("row_permissions", {})
        if not isinstance(policy, dict):
            return None
        mode = policy.get("mode", "all")
        if not isinstance(mode, str) or mode not in {"all", "assigned"}:
            return None
        if any(type(policy.get(field, False)) is not bool for field in ("edit_assigned", "allow_create")):
            return None
        if mode == "assigned" and (not isinstance(policy.get("property_id"), str) or not policy["property_id"]):
            return None
        return policy

    def can(self, kind, entity, needed=1):
        return self.level(kind, entity) >= needed

    def require_resource(self, kind, entity_id, needed=1):
        require(isinstance(entity_id, str) and 0 < len(entity_id) <= 160, "Invalid resource ID")
        entity = self.store.get(kind, entity_id)
        level = self.level(kind, entity)
        require(level > 0, "Resource not found", 404)
        require(level >= needed, "Insufficient resource permission", 403)
        return entity

    def can_create_row(self, database):
        level = self.level("database", database)
        if self.owner or (level and self._owns(database)):
            return True
        if level < 3:
            return False
        policy = self._row_policy(database)
        if policy is None:
            return False
        return level == 4 or policy.get("mode", "all") != "assigned" or policy.get("allow_create", False) is True

    def visible_teamspaces(self):
        return [teamspace for teamspace in self.store.list("teamspace") if self.can("teamspace", teamspace)]

    def filter_workspace(self, snapshot):
        result = copy.deepcopy(snapshot)
        for key, kind in (("pages", "page"), ("databases", "database"), ("teamspaces", "teamspace")):
            result[key] = [entity for entity in result.get(key, []) if self.can(kind, entity)]
        page_ids = {page["id"] for page in result["pages"]}
        teamspace_ids = {teamspace["id"] for teamspace in result["teamspaces"]}
        for entity in result["pages"] + result["databases"]:
            if entity.get("parent_id") and entity["parent_id"] not in page_ids:
                entity["parent_id"] = None
            if entity.get("teamspace_id") and entity["teamspace_id"] not in teamspace_ids:
                entity["teamspace_id"] = None
        safe_fields = {"id", "name", "email", "role", "active", "created_at", "updated_at"}
        result["members"] = [{key: value for key, value in member.items() if key in safe_fields}
                             for member in result.get("members", [])
                             if self.regular or member.get("id") == self.member_id]
        if "groups" in result:
            result["groups"] = result["groups"] if self.regular else []
        return result

    def filter_database(self, detail):
        result = copy.deepcopy(detail)
        database = result.get("database")
        require(self.can("database", database), "Resource not found", 404)
        result["rows"] = [row for row in result.get("rows", []) if self.can("row", row)]
        known = {prop["id"] for prop in database.get("properties", [])}
        for row in result["rows"]: row["properties"] = {key: value for key, value in row.get("properties", {}).items() if key in known}
        relations = {prop["id"] for prop in database.get("properties", []) if prop.get("type") == "relation"}
        for row in result["rows"]:
            for key in relations:
                values = row.get("properties", {}).get(key)
                if isinstance(values, list):
                    row["properties"][key] = [identity for identity in values
                                              if isinstance(identity, str)
                                              and self.can("row", self.store.get("row", identity))]
        return result

    def validate_permissions(self, body):
        require(isinstance(body, dict), "permissions must be an object")
        require(set(body) <= {"default", "members", "groups", "inherit"}, "Unknown permissions field")
        default = body.get("default", "workspace")
        require(isinstance(default, str) and default in {"workspace", "private"}, "Invalid permission default")
        inherit = body.get("inherit", False)
        require(type(inherit) is bool, "inherit must be boolean")
        result = {"default": default, "inherit": inherit, "members": {}, "groups": {}}
        for field, kind in (("members", "member"), ("groups", "group")):
            values = body.get(field, {})
            require(isinstance(values, dict) and len(values) <= 1000, f"{field} must be a permission map")
            for identity, level in values.items():
                require(isinstance(identity, str) and 0 < len(identity) <= 160, "Invalid permission identity")
                require(isinstance(level, str) and level in LEVELS, "Invalid permission level")
                target = self.store.get(kind, identity)
                require(target is not None, f"Unknown permission {kind}")
                if kind == "member":
                    require(target.get("role") in ROLES, "Invalid member role")
                result[field][identity] = level
        return result
