import copy
import unittest

from fountain.access import Access
from fountain.authorization import Authorization
from fountain.core import APIError, Store


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.members = {}
        for identity, role in (("local", "owner"), ("admin", "admin"), ("alice", "member"),
                               ("bob", "member"), ("guest", "guest")):
            self.members[identity] = self.store.put("member", {
                "id": identity, "name": "같은 이름", "email": identity + "@family.test", "role": role,
                "active": True, "password_hash": "must-never-be-returned"})
        self.store.put("group", {"id": "family", "name": "가족", "members": ["alice"]})
        self.store.put("teamspace", {"id": "general", "visibility": "open"})

    def tearDown(self):
        self.store.close()

    def access(self, identity="alice"):
        return Access(self.store, self.members[identity])

    def page(self, identity="p", **fields):
        return self.store.put("page", {"id": identity, **fields})

    def database(self, **fields):
        return self.store.put("database", {"id": "db", "properties": [], **fields})

    def row(self, identity="row", **fields):
        return self.store.put("row", {"id": identity, "database_id": "db", "properties": {}, **fields})

    def assert_status(self, status, callback):
        with self.assertRaises(APIError) as error:
            callback()
        self.assertEqual(error.exception.status, status)

    def test_workspace_default_roles_and_legacy_owner(self):
        page = self.page(teamspace_id="general")
        for identity in ("alice", "admin", "bob"):
            self.assertEqual(self.access(identity).level("page", page), 3)
        self.assertEqual(self.access("guest").level("page", page), 0)
        self.assertEqual(self.access("local").level("page", page), 4)
        # Owner identity on old resources remains local after a role change.
        local = dict(self.members["local"], role="member")
        self.assertEqual(Access(self.store, local).level("page", page), 4)

    def test_private_page_owner_and_admin_do_not_inherit_privilege(self):
        page = self.page(owner_id="alice", permissions={"default": "private"})
        self.assertEqual(self.access().level("page", page), 4)
        self.assertEqual(self.access("local").level("page", page), 4)
        self.assertEqual(self.access("admin").level("page", page), 0)
        self.access("admin").require_admin()
        self.assert_status(403, lambda: self.access("admin").require_admin(owner_only=True))
        self.assert_status(403, lambda: self.access().require_admin())
        self.access("local").require_admin(owner_only=True)

    def test_membership_admin_cannot_create_or_promote_privileged_members(self):
        authority = Authorization(self.access("admin"))
        for role in ("owner", "admin"):
            for method, path, identity in (("POST", "/api/members", None),
                                           ("PATCH", "/api/members/alice", "alice"),
                                           ("PATCH", "/api/members/guest", "guest")):
                with self.subTest(role=role, method=method, path=path):
                    self.assert_status(403, lambda: authority.member_change(method, identity, {"role": role}))
                    self.assert_status(403, lambda: authority.prepare(method, path, {"role": role}))

    def test_membership_admin_cannot_change_existing_privileged_members_even_itself(self):
        self.store.put("member", {"id": "other-admin", "role": "admin", "active": True})
        authority = Authorization(self.access("admin"))
        for identity in ("local", "admin", "other-admin"):
            for method, body in (("DELETE", {}), ("PATCH", {}),
                                 ("PATCH", {"name": "변경"}), ("PATCH", {"active": False}),
                                 ("PATCH", {"role": "member"}), ("PATCH", {"role": "guest"})):
                with self.subTest(identity=identity, method=method, body=body):
                    self.assert_status(403, lambda: authority.member_change(method, identity, dict(body)))
                    self.assert_status(403, lambda: authority.prepare(method, "/api/members/" + identity, dict(body)))

    def test_membership_admin_can_manage_members_and_guests(self):
        authority = Authorization(self.access("admin"))
        for method, path, body in (("POST", "/api/members", {}),
                                   ("POST", "/api/members", {"role": "member"}),
                                   ("POST", "/api/members", {"role": "guest"}),
                                   ("PATCH", "/api/members/alice", {"role": "guest"}),
                                   ("PATCH", "/api/members/guest", {"role": "member"}),
                                   ("PATCH", "/api/members/alice", {"active": False}),
                                   ("PATCH", "/api/members/guest", {"name": "변경"}),
                                   ("DELETE", "/api/members/alice", {}),
                                   ("DELETE", "/api/members/guest", {})):
            with self.subTest(method=method, path=path, body=body):
                authority.prepare(method, path, dict(body))

    def test_owner_can_manage_admin_membership_and_last_owner_remains_protected(self):
        authority = Authorization(self.access("local"))
        for method, path, body in (("POST", "/api/members", {"role": "admin"}),
                                   ("PATCH", "/api/members/alice", {"role": "admin"}),
                                   ("PATCH", "/api/members/admin", {}),
                                   ("PATCH", "/api/members/admin", {"name": "변경"}),
                                   ("PATCH", "/api/members/admin", {"role": "member"}),
                                   ("PATCH", "/api/members/admin", {"active": False}),
                                   ("DELETE", "/api/members/admin", {})):
            with self.subTest(method=method, path=path, body=body):
                authority.prepare(method, path, dict(body))
        for method, body in (("DELETE", {}), ("PATCH", {"role": "admin"}),
                             ("PATCH", {"active": False})):
            with self.subTest(method=method, body=body):
                self.assert_status(409, lambda: authority.prepare(method, "/api/members/local", dict(body)))

    def test_explicit_member_deny_and_group_override_default(self):
        access = self.access()
        page = self.page(permissions={"default": "workspace", "groups": {"family": "view"}})
        self.assertEqual(access.level("page", page), 1)
        page["permissions"]["members"] = {"alice": "none"}
        self.assertEqual(access.level("page", page), 0)
        page["permissions"]["members"]["alice"] = "comment"
        self.assertEqual(access.level("page", page), 2)
        page["owner_id"] = "alice"
        self.assertEqual(access.level("page", page), 4)
        self.assertEqual(self.access("local").level("page", page), 4)

    def test_multiple_group_grants_use_highest_matching_level(self):
        self.store.put("group", {"id": "friends", "members": ["alice"]})
        page = self.page(permissions={"default": "private", "groups": {"family": "none", "friends": "edit"}})
        self.assertEqual(self.access().level("page", page), 3)
        self.assertEqual(self.access("bob").level("page", page), 0)

    def test_parent_inheritance_explicit_overrides_and_independent_acl(self):
        self.page("parent", permissions={"default": "private", "members": {"alice": "comment"}})
        child = self.page("child", parent_id="parent")
        self.assertEqual(self.access().level("page", child), 2)
        child["permissions"] = {"default": "workspace", "inherit": True}
        self.assertEqual(self.access().level("page", child), 2)
        child["permissions"]["members"] = {"alice": "none"}
        self.assertEqual(self.access().level("page", child), 0)
        child["permissions"] = {"default": "private", "members": {"guest": "view"}}
        self.assertEqual(self.access("guest").level("page", child), 1)
        child["permissions"] = {"default": "workspace", "inherit": False}
        self.assertEqual(self.access().level("page", child), 3)

    def test_cycles_deep_chains_and_missing_parent_fail_closed(self):
        first = self.page("first", parent_id="second")
        self.page("second", parent_id="first")
        self.assertEqual(self.access().level("page", first), 0)
        self.assertEqual(self.access().level("page", self.page("missing", parent_id="absent")), 0)
        for index in range(66):
            self.page(str(index), parent_id=str(index + 1) if index < 65 else None)
        self.assertEqual(self.access().level("page", self.store.get("page", "0")), 0)

    def test_closed_teamspace_and_explicit_page_guest_grant(self):
        teamspace = self.store.put("teamspace", {"id": "secret", "visibility": "private", "members": ["bob"]})
        page = self.page(teamspace_id="secret")
        self.assertEqual(self.access().level("page", page), 0)
        self.assertEqual(self.access("admin").level("page", page), 0)
        self.assertEqual(self.access("bob").level("page", page), 3)
        self.assertFalse(self.access("guest").can("teamspace", teamspace))
        page["permissions"] = {"default": "workspace", "members": {"guest": "view"}}
        self.assertTrue(self.access("guest").can("page", page))
        self.assertFalse(self.access("guest").can("teamspace", teamspace))
        teamspace["groups"] = ["family"]
        self.store.put("teamspace", teamspace)
        self.assertTrue(self.access().can("teamspace", teamspace))
        self.assertEqual(self.access().level("page", page), 3)
        page["teamspace_id"] = "nonexistent"
        self.assertEqual(self.access().level("page", page), 0)

    def test_inactive_invalid_and_missing_principals_fail_closed(self):
        page = self.page()
        for principal in (None, {}, {"id": "alice", "role": "root"},
                          {"id": "local", "role": "owner", "active": False},
                          {"id": "local", "role": "owner", "active": 1}):
            access = Access(self.store, principal)
            self.assertEqual(access.level("page", page), 0)
            self.assert_status(403, access.require_admin)
        self.assertEqual(self.access().level("unknown", page), 0)

    def test_require_resource_hides_missing_and_denied_but_distinguishes_edit_denial(self):
        self.page(permissions={"default": "private", "members": {"alice": "view"}})
        self.assertEqual(self.access().require_resource("page", "p")["id"], "p")
        self.assert_status(403, lambda: self.access().require_resource("page", "p", 3))
        self.assert_status(404, lambda: self.access("bob").require_resource("page", "p"))
        self.assert_status(404, lambda: self.access().require_resource("page", "absent"))

    def test_assigned_rows_match_id_or_email_never_display_name(self):
        self.database(row_permissions={"mode": "assigned", "property_id": "who", "edit_assigned": True})
        for index, value in enumerate(("alice", ["bob", "alice"], "ALICE@FAMILY.TEST")):
            row = self.row(str(index), properties={"who": value})
            self.assertEqual(self.access().level("row", row), 3)
        for index, value in enumerate(("bob", "같은 이름", None, {"id": "alice"}, ["같은 이름"])):
            row = self.row("bad" + str(index), properties={"who": value})
            self.assertEqual(self.access().level("row", row), 0)
        self.assertEqual(self.access("local").level("row", row), 4)
        self.assertEqual(self.access("admin").level("row", row), 0)

    def test_readonly_assignment_creation_and_owner_exemptions(self):
        database = self.database(row_permissions={"mode": "assigned", "property_id": "who"})
        row = self.row(properties={"who": "alice"})
        self.assertEqual(self.access().level("row", row), 1)
        self.assertFalse(self.access().can_create_row(database))
        database["row_permissions"]["allow_create"] = True
        self.store.put("database", database)
        self.assertTrue(self.access().can_create_row(database))
        database["permissions"] = {"default": "private", "members": {"alice": "view"}}
        self.store.put("database", database)
        self.assertFalse(self.access().can_create_row(database))
        database["owner_id"] = "alice"
        self.store.put("database", database)
        self.assertTrue(self.access().can_create_row(database))
        self.assertEqual(self.access().level("row", self.row("unassigned")), 4)

    def test_row_acl_further_restricts_and_never_opens_inaccessible_database(self):
        database = self.database()
        row = self.row(permissions={"default": "private", "members": {"alice": "view"}})
        self.assertEqual(self.access().level("row", row), 1)
        self.assertEqual(self.access("bob").level("row", row), 0)
        database["permissions"] = {"default": "private"}
        self.store.put("database", database)
        row["owner_id"] = "alice"
        self.assertEqual(self.access().level("row", row), 0)
        database["permissions"]["members"] = {"alice": "view"}
        self.store.put("database", database)
        row.pop("owner_id")
        row["permissions"]["members"]["alice"] = "full"
        self.assertEqual(self.access().level("row", row), 1)

    def test_row_creator_cannot_bypass_assignment_or_database_view_limit(self):
        database = self.database(row_permissions={"mode": "assigned", "property_id": "who", "edit_assigned": True})
        row = self.row(owner_id="alice", properties={"who": "bob"})
        self.assertEqual(self.access().level("row", row), 0)
        row["properties"]["who"] = "alice"
        database["permissions"] = {"default": "private", "members": {"alice": "view"}}
        self.store.put("database", database)
        self.assertEqual(self.access().level("row", row), 1)
        database["permissions"]["members"]["alice"] = "full"
        self.store.put("database", database)
        row["properties"]["who"] = "bob"
        self.assertEqual(self.access().level("row", row), 4)
        self.assertTrue(self.access().can_create_row(database))
        row["permissions"] = {"members": {"alice": "none"}}
        self.assertEqual(self.access().level("row", row), 0)

    def test_malformed_persisted_acl_and_row_policy_fail_closed(self):
        for acl in ([], {"default": []}, {"default": "public"}, {"members": {"alice": []}},
                    {"groups": []}, {"inherit": 1}):
            with self.subTest(acl=acl):
                self.assertEqual(self.access().level("page", self.page(permissions=acl)), 0)
        for policy in ([], None, {"mode": []}, {"mode": "assigned"}, {"mode": "invalid"},
                       {"edit_assigned": "yes"}, {"allow_create": 1}):
            with self.subTest(policy=policy):
                database = self.database(row_permissions=policy)
                self.assertEqual(self.access().level("row", self.row()), 0)
                self.assertFalse(self.access().can_create_row(database))

    def test_workspace_filter_is_deepcopy_hides_private_resources_and_guest_directory(self):
        secret = self.store.put("teamspace", {"id": "secret", "visibility": "private"})
        hidden = self.page("hidden", teamspace_id="secret")
        shared = self.page("shared", parent_id="hidden", teamspace_id="secret",
                           permissions={"default": "private", "members": {"guest": "view"}})
        database = self.database()
        snapshot = {"pages": [hidden, shared], "databases": [database], "teamspaces": [secret],
                    "members": list(self.members.values()), "groups": self.store.list("group")}
        original = copy.deepcopy(snapshot)
        result = self.access("guest").filter_workspace(snapshot)
        self.assertEqual([page["id"] for page in result["pages"]], ["shared"])
        self.assertIsNone(result["pages"][0]["parent_id"])
        self.assertIsNone(result["pages"][0]["teamspace_id"])
        self.assertEqual(result["databases"], [])
        self.assertEqual(result["teamspaces"], [])
        self.assertEqual(result["groups"], [])
        self.assertEqual([member["id"] for member in result["members"]], ["guest"])
        self.assertNotIn("password_hash", result["members"][0])
        self.assertEqual(snapshot, original)
        self.assertEqual(len(self.access().filter_workspace(snapshot)["members"]), 5)
        self.assertEqual([item["id"] for item in self.access("guest").visible_teamspaces()], [])

    def test_database_filter_hides_rows_and_invisible_relation_targets(self):
        database = self.database(properties=[{"id": "related", "type": "relation"}],
                                 row_permissions={"mode": "assigned", "property_id": "who"})
        visible = self.row("visible", properties={"who": "alice", "related": ["hidden", "other", "gone"]})
        hidden = self.row("hidden", properties={"who": "bob"})
        other = self.row("other", properties={"who": "alice"})
        detail = {"database": database, "rows": [visible, hidden, other]}
        original = copy.deepcopy(detail)
        result = self.access().filter_database(detail)
        self.assertEqual([row["id"] for row in result["rows"]], ["visible", "other"])
        self.assertEqual(result["rows"][0]["properties"]["related"], ["other"])
        self.assertEqual(detail, original)
        self.assert_status(404, lambda: self.access("guest").filter_database(detail))

    def test_permission_validation_normalizes_without_mutation(self):
        source = {"default": "private", "members": {"guest": "comment"}, "groups": {"family": "edit"}}
        result = self.access().validate_permissions(source)
        self.assertEqual(result, dict(source, inherit=False))
        result["members"]["guest"] = "none"
        self.assertEqual(source["members"]["guest"], "comment")
        self.assertEqual(self.access().validate_permissions({}),
                         {"default": "workspace", "inherit": False, "members": {}, "groups": {}})

    def test_permission_validation_rejects_malformed_or_unknown_grants(self):
        invalid = [None, [], {"default": []}, {"default": "public"}, {"inherit": 1}, {"extra": True},
                   {"members": []}, {"groups": None}, {"members": {"missing": "view"}},
                   {"groups": {"missing": "edit"}}, {"members": {"alice": []}},
                   {"members": {"alice": 3}}, {"members": {"alice": "owner"}}]
        for body in invalid:
            with self.subTest(body=body):
                self.assert_status(400, lambda: self.access().validate_permissions(body))
        self.store.put("member", {"id": "invalid", "role": "superuser"})
        self.assert_status(400, lambda: self.access().validate_permissions({"members": {"invalid": "view"}}))


if __name__ == "__main__":
    unittest.main()
