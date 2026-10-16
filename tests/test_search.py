import copy
import unittest

from fountain.access import Access
from fountain.core import APIError
from fountain.search import advanced_search, _number, _timestamp


class MemoryStore:
    def __init__(self):
        self.records = {}
        self.scans = 0

    def add(self, kind, identity, **fields):
        value = {"id": identity, "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-02T00:00:00.000Z", **fields}
        self.records.setdefault(kind, {})[identity] = value
        return value

    def get(self, kind, identity):
        return self.records.get(kind, {}).get(identity)

    def list(self, kind):
        self.scans += 1
        return list(self.records.get(kind, {}).values())

    def meta(self, key, default=None):
        return "search-test-workspace" if key == "workspace_id" else default


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        for identity, role in (("local", "owner"), ("admin", "admin"), ("alice", "member"), ("bob", "member"), ("guest", "guest"), ("inactive", "member")):
            self.store.add("member", identity, role=role, active=identity != "inactive", email=identity + "@family.test")
        self.store.add("teamspace", "general", visibility="open")
        self.store.add("teamspace", "hidden-space", visibility="closed", members=["bob"], groups=[])
        self.store.add("page", "visible", title="우리 가족 Straße", owner_id="bob", teamspace_id="general", blocks=[{"type": "paragraph", "text": "아이디어 alpha beta 함께"}])
        self.store.add("page", "private", title="Private hidden source", owner_id="bob", permissions={"default": "private"}, blocks=[{"type": "paragraph", "text": "HIDDEN_PAGE_TOKEN"}])
        self.store.add("page", "guest-page", title="Guest shared", owner_id="bob", permissions={"default": "private", "members": {"guest": "view"}})
        self.store.add("page", "archived", title="Archived source", archived=True)

    def access(self, member="alice"):
        return Access(self.store, self.store.get("member", member))

    def search(self, query=None, member="alice"):
        return advanced_search(self.store, self.access(member), query or {})

    def denied(self, query, status=400, member="alice"):
        with self.assertRaises(APIError) as caught:
            self.search(query, member)
        self.assertEqual(caught.exception.status, status)

    def database(self):
        schema = [{"id": "name", "type": "title"}, {"id": "note", "type": "text", "name": "HIDDEN_PROPERTY_NAME"}, {"id": "n", "type": "number"}, {"id": "assignee", "type": "person"}, {"id": "person", "type": "person"}, {"id": "file", "type": "files"}, {"id": "related", "type": "relation"}, {"id": "calc", "type": "formula"}, {"id": "roll", "type": "rollup"}]
        db = self.store.add("database", "db", name="가족 작업", owner_id="bob", teamspace_id="general", properties=schema, row_permissions={"mode": "assigned", "property_id": "assignee", "edit_assigned": False, "allow_create": False})
        row = self.store.add("row", "row-visible", database_id="db", owner_id="bob", properties={"name": "Visible task", "note": "public row idea", "n": 1e-7, "assignee": "alice", "person": "HIDDEN_PERSON_TOKEN", "file": ["HIDDEN_FILE_TOKEN"], "related": ["HIDDEN_RELATION_TOKEN"], "calc": "HIDDEN_FORMULA_TOKEN", "roll": "HIDDEN_ROLLUP_TOKEN", "unknown": "HIDDEN_UNKNOWN_TOKEN"})
        self.store.add("row", "row-hidden", database_id="db", owner_id="alice", properties={"name": "HIDDEN_ASSIGNED_TOKEN", "assignee": "bob"})
        return db, row

    def test_authorization_precedes_matching_ranking_and_count(self):
        class Unscannable(list):
            def __iter__(self):
                raise AssertionError("Hidden body was scanned")
        self.store.get("page", "private")["blocks"] = Unscannable()
        self.assertEqual(self.search({"q": ["HIDDEN_PAGE_TOKEN"]})["total"], 0)
        self.assertEqual({r["id"] for r in self.search()["results"]}, {"visible"})
        self.assertEqual(self.search(member="admin")["total"], 1)
        self.assertEqual({r["id"] for r in self.search(member="guest")["results"]}, {"guest-page"})
        self.denied({}, 401, "inactive")

    def test_owner_sees_private_resources_but_no_archived_type_is_searchable(self):
        self.store.add("database", "archived-db", name="gone", archived=True)
        self.store.add("row", "archived-row", database_id="archived-db", properties={})
        ids = {r["id"] for r in self.search(member="local")["results"]}
        self.assertIn("private", ids)
        self.assertNotIn("archived", ids)
        self.assertNotIn("archived-db", ids)
        self.assertNotIn("archived-row", ids)

    def test_assigned_row_and_scalar_whitelist_never_leak_reference_or_property_names(self):
        self.database()
        self.assertEqual(self.search({"q": ["public row"], "types": ["row"]})["total"], 1)
        for term in ["HIDDEN_ASSIGNED_TOKEN", "HIDDEN_PERSON_TOKEN", "HIDDEN_FILE_TOKEN", "HIDDEN_RELATION_TOKEN", "HIDDEN_FORMULA_TOKEN", "HIDDEN_ROLLUP_TOKEN", "HIDDEN_UNKNOWN_TOKEN", "HIDDEN_PROPERTY_NAME"]:
            self.assertEqual(self.search({"q": [term]})["total"], 0, term)
        result = self.search({"types": ["row"]})["results"][0]
        self.assertEqual(result["database_id"], "db")
        self.assertEqual(result["database_title"], "가족 작업")
        self.assertEqual(result["icon"], None)
        self.assertEqual(set(result), {"type", "id", "title", "icon", "snippet", "owner_id", "created_at", "updated_at", "database_id", "database_title"})

    def test_hidden_database_and_attachment_block_are_not_search_sources(self):
        db, row = self.database()
        db["permissions"] = {"default": "private"}
        self.assertEqual(self.search({"q": ["public row"]})["total"], 0)
        self.store.get("page", "visible")["blocks"].extend([{"type": "file", "text": "SECRET_FILENAME", "attachment_id": "PRIVATE_ATTACHMENT"}, {"type": "embed", "text": "SECRET_EMBED"}, {"type": "paragraph", "text": "SECRET_ATTACHMENT_TEXT", "attachment_id": "PRIVATE_ATTACHMENT"}])
        for q in ["SECRET_FILENAME", "PRIVATE_ATTACHMENT", "SECRET_EMBED", "SECRET_ATTACHMENT_TEXT"]:
            self.assertEqual(self.search({"q": [q]})["total"], 0)
        self.assertNotIn("properties", self.search()["results"][0])

    def test_unicode_casefold_nfkc_phrases_and_and_terms(self):
        self.assertEqual(self.search({"q": ['"alpha beta" STRASSE']})["total"], 1)
        self.assertEqual(self.search({"q": ['" alpha beta "']})["total"], 1)
        self.assertEqual(self.search({"q": ["ＡＬＰＨＡ\u0085beta"]})["total"], 1)
        self.assertEqual(self.search({"q": ["alpha absent"]})["total"], 0)
        self.assertEqual(self.search({"q": ["함께"]})["total"], 1)
        self.assertEqual(self.search({"q": ["\ufeffalpha"]})["total"], 0)
        self.assertEqual(self.search({"q": ["alpha"], "title_only": ["1"]})["total"], 0)
        for value in ['"', '""', '"  "', 'a"b"', '"a"b', " ".join(str(n) for n in range(17))]:
            self.denied({"q": [value]})

    def test_snippet_fold_expansion_uses_original_unicode_scalar_positions(self):
        text = "🙂" * 190 + " Straße Needle " + "가" * 220
        self.store.get("page", "visible")["blocks"] = [{"type": "paragraph", "text": text}]
        result = self.search({"q": ["strasse needle"]})["results"][0]
        self.assertLessEqual(len(result["snippet"]), 180)
        self.assertIn("Straße Needle", result["snippet"])
        self.assertTrue(result["snippet"].startswith("…"))
        self.assertTrue(result["snippet"].endswith("…"))

    def test_strict_invalid_parameters_fail_before_corpus_scan(self):
        access = self.access()
        invalid = [{"unknown": ["x"]}, {"q": ["a", "b"]}, {"owner": [str(n) for n in range(21)]}, {"owner": [""]}, {"types": ["page,page"]}, {"types": ["pages"]}, {"types": [""]}, {"q": ["x" * 501]}, {"q": ["\ud800"]}, {"q": ["\0"]}, {"limit": ["0"]}, {"limit": ["51"]}, {"offset": ["01"]}, {"offset": ["100001"]}, {"offset": ["1"]}, {"result_set": ["F" * 64]}, {"title_only": ["true"]}, {"date_field": ["wrong"]}, {"sort": ["new"]}, {"after": ["2026-01-01T00:00:00Z"]}, {"after": ["2026-02-30T00:00:00.000Z"]}, {"after": ["2026-01-02T00:00:00.000Z"], "before": ["2026-01-01T00:00:00.000Z"]}]
        for query in invalid:
            before = self.store.scans
            with self.assertRaises(APIError) as caught:
                advanced_search(self.store, access, query)
            self.assertEqual(caught.exception.status, 400, query)
            self.assertEqual(self.store.scans, before, query)

    def test_owner_default_is_absent_only_and_types_are_normalized(self):
        self.store.add("page", "legacy", title="legacy")
        self.store.add("page", "null-owner", title="null", owner_id=None)
        result = self.search({"owner": ["local", "local"], "types": ["row,page,database"]}, "local")
        self.assertEqual({r["id"] for r in result["results"]}, {"legacy"})
        self.assertEqual(self.search({"owner": ["alice", "bob"]})["result_set"], self.search({"owner": ["bob", "alice", "bob"]})["result_set"])
        self.assertEqual(self.search({"owner": ["bob"] * 30})["result_set"], self.search({"owner": ["bob"]})["result_set"])

    def test_containment_stops_hidden_ancestry_and_rows_use_only_database_anchors(self):
        self.store.add("page", "child", title="Child", parent_id="visible")
        self.store.add("page", "hidden-parent", title="hidden", parent_id="visible", permissions={"default": "private"}, owner_id="bob")
        self.store.add("page", "independent", title="Independent", parent_id="hidden-parent", permissions={"default": "workspace", "inherit": False})
        db, row = self.database()
        db["parent_id"] = "child"
        result = self.search({"in": ["visible"]})
        self.assertEqual({r["id"] for r in result["results"]}, {"visible", "child", "db", "row-visible"})
        del db["parent_id"]
        row["page_id"] = "visible"
        self.assertNotIn("row-visible", {r["id"] for r in self.search({"in": ["visible"]})["results"]})
        for identity in ["private", "missing", "archived"]:
            self.denied({"in": [identity]}, 404)
        for identity in ["hidden-space", "missing"]:
            self.denied({"teamspace": [identity]}, 404)
        self.assertNotIn("private", {r["id"] for r in self.search({"teamspace": ["general"]})["results"]})

    def test_cycles_are_bounded_and_unknown_row_database_is_not_a_result(self):
        self.store.add("page", "cycle-a", title="Cycle A", parent_id="cycle-b")
        self.store.add("page", "cycle-b", title="Cycle B", parent_id="cycle-a")
        self.store.add("row", "orphan", database_id="missing", properties={"name": "orphan"})
        self.assertNotIn("orphan", {r["id"] for r in self.search(member="local")["results"]})
        self.assertEqual(self.search({"in": ["cycle-a"]}, "local")["total"], 2)
        for index in range(90):
            self.store.add("page", "deep-" + str(index), title="deep", parent_id="visible" if index == 0 else "deep-" + str(index - 1))
        self.store.get("page", "deep-89")["title"] = "Deep needle"
        self.assertEqual([r["id"] for r in self.search({"in": ["visible"], "q": ['"deep needle"']}, "local")["results"]], ["deep-89"])

    def test_relevance_weights_and_entire_query_title_bonus(self):
        self.store.add("page", "exact", title="Alpha Beta", blocks=[])
        self.store.add("page", "split", title="Alpha", blocks=[{"type": "paragraph", "text": "Beta"}])
        self.store.add("page", "body", title="Body result", blocks=[{"type": "paragraph", "text": "Alpha Beta"}])
        results = self.search({"q": ["alpha beta"]})["results"]
        ids = [item["id"] for item in results]
        self.assertLess(ids.index("exact"), ids.index("split"))
        self.assertLess(ids.index("split"), ids.index("body"))
        self.assertEqual([r["id"] for r in self.search({"q": ["alpha beta"], "title_only": ["1"]})["results"]], ["exact"])

    def test_body_is_not_silently_truncated_and_marker_folds_unicode_whitespace(self):
        self.store.get("page", "visible")["blocks"] = [{"type": "paragraph", "text": "x" * 30000 + " 끝까지 Needle"}]
        result = self.search({"q": ["needle"]})
        self.assertEqual(result["total"], 1)
        self.assertIn("Needle", result["results"][0]["snippet"])
        self.assertEqual(result["result_set"], self.search({"q": ["ＮＥＥＤＬＥ\u0085"]})["result_set"])

    def test_source_dates_preserve_raw_spelling_and_invalid_dates_sort_last(self):
        self.store.get("page", "visible")["updated_at"] = "1969-12-31T23:59:59.999999Z"
        self.store.add("page", "newer", title="Newer", updated_at="2026-01-01T01:30:00.123456+01:30")
        self.store.add("page", "bad-date", title="Bad", updated_at="2026-02-30T00:00:00Z")
        self.assertEqual(_timestamp("1969-12-31T23:59:59.999999Z"), -1)
        for mode in ["updated_asc", "updated_desc"]:
            items = self.search({"sort": [mode]})["results"]
            self.assertEqual(items[-1]["id"], "bad-date")
            self.assertIsNone(items[-1]["updated_at"])
        result = self.search({"after": ["2026-01-01T00:00:00.123Z"], "before": ["2026-01-01T00:00:00.124Z"]})
        self.assertEqual([r["id"] for r in result["results"]], ["newer"])
        self.assertEqual(result["results"][0]["updated_at"], "2026-01-01T01:30:00.123456+01:30")

    def test_result_set_recomputes_authorized_dtos_and_is_not_a_permission(self):
        self.store.add("page", "second", title="Second")
        first = self.search({"limit": ["1"]})
        next_page = self.search({"limit": ["1"], "offset": ["1"], "result_set": [first["result_set"]]})
        self.assertEqual(next_page["result_set"], first["result_set"])
        self.assertNotEqual(next_page["results"][0]["id"], first["results"][0]["id"])
        self.store.get("page", "private")["title"] = "Still private changed"
        self.assertEqual(self.search()["result_set"], first["result_set"])
        self.store.get("page", "second")["permissions"] = {"default": "private"}
        self.store.get("page", "second")["owner_id"] = "bob"
        self.denied({"offset": ["1"], "result_set": [first["result_set"]]}, 409)
        self.assertNotIn("second", {r["id"] for r in self.search()["results"]})

    def test_scalar_numbers_and_dates_are_safe_not_generic_json(self):
        self.assertEqual([_number(n) for n in [0, -0.0, 1, 100.0, 1.25, 1e-6, 1e-7, -1.2e-7]], ["0", "0", "1", "100", "1.25", "0.000001", "1e-7", "-1.2e-7"])
        self.assertEqual(_number(10 ** 1000), "")
        self.assertEqual(_number(float("nan")), "")
        db, row = self.database()
        db["properties"].extend([{"id": "date", "type": "date"}, {"id": "flag", "type": "checkbox"}])
        row["properties"].update(date={"start": "2026-03-01", "end": "2026-03-03"}, flag=True)
        self.assertEqual(self.search({"q": ["2026-03-03 true 1e-7"]})["total"], 1)
        row["properties"]["date"]["private"] = "DO_NOT_INDEX"
        self.assertEqual(self.search({"q": ["2026-03-03"]})["total"], 0)
        self.assertEqual(self.search({"q": ["DO_NOT_INDEX"]})["total"], 0)
        for value in [{"start": "2026-03-01", "end": None}, {"start": "2026-03-01", "end": ""}, {"start": "2026-03-01", "end": "2026-02-30"}, {"start": "2026-03-03", "end": "2026-03-01"}]:
            row["properties"]["date"] = value
            self.assertEqual(self.search({"q": ["2026-03-01"]})["total"], 0)

    def test_deterministic_codepoint_ties_and_no_store_mutation(self):
        self.store.add("page", "astral", title="😀")
        self.store.add("page", "bmp", title="\ue000")
        before = copy.deepcopy(self.store.records)
        result = self.search({"sort": ["title"]})
        ids = [r["id"] for r in result["results"]]
        self.assertLess(ids.index("bmp"), ids.index("astral"))
        self.assertEqual(self.store.records, before)


if __name__ == "__main__":
    unittest.main()
