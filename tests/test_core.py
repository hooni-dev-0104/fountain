import json
import tempfile
import unittest
from pathlib import Path

from fountain.core import APIError, Store, Workspace


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.workspace = Workspace(self.store)

    def tearDown(self):
        self.store.close()

    def test_seed_is_idempotent_and_persistent(self):
        count = len(self.store.list("page"))
        Workspace(self.store)
        self.assertEqual(len(self.store.list("page")), count)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.db"
            store = Store(path)
            page = Workspace(store).create_page({"title": "보존"})
            store.close()
            store = Store(path)
            self.assertEqual(store.get("page", page["id"])["title"], "보존")
            store.close()

    def test_revision_conflict_and_restore_preserve_previous_content(self):
        page = self.workspace.create_page({"title": "실험", "blocks": [{"type": "paragraph", "text": "이전"}]})
        self.workspace.save_blocks(page["id"], [{"type": "paragraph", "text": "수정"}], 0)
        with self.assertRaises(APIError) as error:
            self.workspace.save_blocks(page["id"], [], 0)
        self.assertEqual(error.exception.status, 409)
        detail = self.workspace.detail(page["id"])
        self.workspace.restore_version(page["id"], detail["versions"][0]["id"])
        self.assertEqual(self.workspace.detail(page["id"])["blocks"][0]["text"], "이전")
        self.assertEqual(self.workspace.page(page["id"])["revision"], 2)

    def test_trash_search_and_hierarchy_cycles(self):
        parent = self.workspace.create_page({"title": "검색어"})
        child = self.workspace.create_page({"title": "하위", "parent_id": parent["id"]})
        with self.assertRaises(APIError):
            self.workspace.update_page(parent["id"], {"parent_id": child["id"]})
        self.assertEqual(len(self.workspace.search("검색어")["results"]), 1)
        self.workspace.update_page(parent["id"], {"archived": True})
        self.assertEqual(self.workspace.search("검색어")["results"], [])
        self.workspace.update_page(parent["id"], {"archived": False})
        self.assertEqual(len(self.workspace.search("검색어")["results"]), 1)

    def test_database_filter_sort_and_typed_validation(self):
        db = self.workspace.create_database({"name": "숫자", "properties": [{"id": "n", "name": "점수", "type": "number"}]})
        for number in [2, 100, 10]: self.workspace.create_row(db["id"], {"properties": {"n": number}})
        result = self.workspace.database_detail(db["id"], [{"property": "n", "operator": "greater_than", "value": 2}], [{"property": "n", "direction": "ascending"}])
        self.assertEqual([r["properties"]["n"] for r in result["rows"]], [10, 100])
        with self.assertRaises(APIError): self.workspace.create_row(db["id"], {"properties": {"n": "bad"}})
        with self.assertRaises(APIError): self.workspace.create_row(db["id"], {"properties": {"missing": 1}})

    def test_imports_exports_and_comments(self):
        page = self.workspace.import_data({"format": "markdown", "content": "# 제목\n안녕하세요", "title": "문서"})["page"]
        self.assertEqual(page["blocks"][0]["type"], "heading1")
        comment = self.workspace.create_comment(page["id"], {"text": "의견"})
        self.assertEqual(self.workspace.detail(page["id"])["comments"][0]["id"], comment["id"])
        csv_db = self.workspace.import_data({"format": "csv", "content": '이름,설명\n첫째,"쉼표, 포함"\n', "title": "CSV"})["database"]
        exported = self.workspace.export("csv", csv_db["id"])
        self.assertIn('"쉼표, 포함"', exported["content"])
        self.assertIn("안녕하세요", self.workspace.export("markdown")["content"])
        data = json.loads(self.workspace.export("json")["content"])
        self.assertEqual(data["format"], "fountain-v1")

    def test_json_backup_restores_database_rows_and_parent_links(self):
        parent = self.workspace.create_page({"title": "상위 문서"})
        self.workspace.create_page({"title": "하위 문서", "parent_id": parent["id"]})
        backup = self.workspace.export("json")["content"]
        result = self.workspace.import_data({"format": "json", "content": backup})
        self.assertEqual(result["row_count"], 3)
        restored = {page["title"]: page for page in result["pages"]}
        self.assertNotEqual(restored["상위 문서"]["id"], parent["id"])
        self.assertEqual(restored["하위 문서"]["parent_id"], restored["상위 문서"]["id"])
        self.assertEqual(len(self.workspace.database_detail(result["databases"][0])["rows"]), 3)

    def test_create_cannot_overwrite_existing_page_id(self):
        with self.assertRaises(APIError) as error:
            self.workspace.create_page({"id": "welcome", "title": "overwrite"})
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.workspace.page("welcome")["title"], "시작하기")

    def test_invalid_import_does_not_write_partial_pages(self):
        count = len(self.store.list("page"))
        with self.assertRaises(APIError):
            self.workspace.import_data({"format": "json", "content": json.dumps({"pages": [{"title": "valid"}, {"title": 4}]})})
        self.assertEqual(len(self.store.list("page")), count)

    def test_transactions_rollback_audit_and_nested_writes(self):
        with self.assertRaises(RuntimeError):
            with self.store.transaction():
                self.store.put("test", {"id": "one"})
                self.store.set_meta("rolled-back", True)
                self.store.audit("rolled-back", {})
                raise RuntimeError("abort")
        self.assertIsNone(self.store.get("test", "one"))
        self.assertIsNone(self.store.meta("rolled-back"))
        self.assertFalse(any(e["action"] == "rolled-back" for e in self.store.list("audit")))
        with self.store.transaction():
            self.store.put("test", {"id": "outer"})
            try:
                with self.store.transaction():
                    self.store.delete("test", "outer")
                    self.store.put("test", {"id": "inner"})
                    raise ValueError("inner abort")
            except ValueError:
                pass
            self.assertIsNotNone(self.store.get("test", "outer"))
        self.assertIsNone(self.store.get("test", "inner"))
        self.assertIsNotNone(self.store.get("test", "outer"))
        self.assertEqual(self.store.transaction_depth, 0)

    def test_archive_timestamp_survives_repeat_and_clears_on_restore(self):
        first = self.workspace.update_page("welcome", {"archived": True})
        second = self.workspace.update_page("welcome", {"archived": True})
        self.assertIn("deleted_at", first)
        self.assertEqual(first["deleted_at"], second["deleted_at"])
        self.assertNotIn("deleted_at", self.workspace.update_page("welcome", {"archived": False}))

    def test_safe_formulas_compute_without_persisting_and_filter_on_result(self):
        database = self.workspace.create_database({"name": "계산", "properties": [
            {"id": "estimate", "name": "시간", "type": "number"},
            {"id": "double", "name": "두 배", "type": "formula", "expression": "prop('estimate') * 2"},
            {"id": "check", "name": "조건", "type": "formula", "expression": "double >= 6 and estimate < 10"},
            {"id": "label", "name": "안내", "type": "formula", "expression": "concat('시간: ', coalesce(시간, 0))"}]})
        row = self.workspace.create_row(database["id"], {"properties": {"estimate": 3}})
        visible = self.workspace.database_detail(database["id"], [{"property": "double", "value": 6}])["rows"][0]
        self.assertEqual(visible["properties"]["double"], 6)
        self.assertIs(visible["properties"]["check"], True)
        self.assertEqual(visible["properties"]["label"], "시간: 3")
        self.assertNotIn("double", self.store.get("row", row["id"])["properties"])
        with self.assertRaises(APIError):
            self.workspace.update_row(database["id"], row["id"], {"properties": {"double": 100}})

    def test_formula_rejects_unsafe_syntax_and_reports_cycles_and_zero_division(self):
        for expression in ["__import__('os').system('id')", "(1).__class__", "[x for x in []]", "2 ** 100000", "1e999"]:
            with self.subTest(expression=expression), self.assertRaises(APIError):
                self.workspace.create_database({"name": "금지", "properties": [{"id": "f", "name": "f", "type": "formula", "expression": expression}]})
        database = self.workspace.create_database({"name": "오류", "properties": [
            {"id": "a", "name": "a", "type": "formula", "expression": "b + 1"},
            {"id": "b", "name": "b", "type": "formula", "expression": "a + 1"},
            {"id": "zero", "name": "zero", "type": "formula", "expression": "1 / 0"},
            {"id": "missing", "name": "missing", "type": "formula", "expression": "unknown + 1"}]})
        self.workspace.create_row(database["id"], {})
        row = self.workspace.database_detail(database["id"])["rows"][0]
        self.assertEqual(set(row["computed_errors"]), {"a", "b", "zero", "missing"})
        self.assertIn("Circular", row["computed_errors"]["a"])
        self.assertTrue(all(value is None for value in row["properties"].values()))

    def test_relations_rollups_and_backup_use_remapped_rows(self):
        target = self.workspace.create_database({"name": "작업", "properties": [
            {"id": "n", "name": "시간", "type": "number"},
            {"id": "double", "name": "두 배", "type": "formula", "expression": "n * 2"}]})
        related = [self.workspace.create_row(target["id"], {"properties": {"n": value}})["id"] for value in [3, 5]]
        properties = [{"id": "related", "name": "작업", "type": "relation", "database_id": target["id"]}]
        for aggregation in ["sum", "count", "average", "min", "max"]:
            properties.append({"id": aggregation, "name": aggregation, "type": "rollup", "relation_property": "related", "target_property": "double", "aggregation": aggregation})
        database = self.workspace.create_database({"name": "집계", "properties": properties})
        row = self.workspace.create_row(database["id"], {"properties": {"related": related}})
        result = self.workspace.database_detail(database["id"])["rows"][0]["properties"]
        self.assertEqual({key: result[key] for key in ["sum", "count", "average", "min", "max"]}, {"sum": 16, "count": 2, "average": 8, "min": 6, "max": 10})
        with self.assertRaises(APIError):
            self.workspace.update_row(database["id"], row["id"], {"properties": {"related": [row["id"]]}})
        with self.assertRaises(APIError):
            self.workspace.update_row(database["id"], row["id"], {"properties": {"related": ["missing"]}})
        restored = self.workspace.import_data({"format": "json", "content": self.workspace.export("json")["content"]})
        restored_db = next(identity for identity in restored["databases"] if self.workspace.database(identity)["name"] == "집계")
        restored_row = self.workspace.database_detail(restored_db)["rows"][0]
        self.assertEqual(restored_row["properties"]["sum"], 16)
        self.assertFalse(set(restored_row["properties"]["related"]) & set(related))
        self.store.delete("row", related[0])
        broken = self.workspace.database_detail(database["id"])["rows"][0]
        self.assertIn("sum", broken["computed_errors"])

    def test_attachments_cannot_escape_and_locked_pages_reject_edits(self):
        with self.assertRaises(APIError): self.workspace.attachment({"name": "../escape", "data": "eA=="})
        self.assertEqual(self.workspace.attachment({"name": "notes.txt", "data": "eA=="})["size"], 1)
        page = self.workspace.update_page("welcome", {"locked": True})
        with self.assertRaises(APIError) as error: self.workspace.save_blocks(page["id"], [])
        self.assertEqual(error.exception.status, 423)

    def test_plain_database_crud_is_not_capped_by_task_graph_processing_limit(self):
        database = self.workspace.create_database({'name': '큰 일반 DB'})
        with self.store.transaction():
            for number in range(10001):
                self.store.put('row', {'id': 'plain-' + str(number), 'database_id': database['id'], 'properties': {'name': str(number)}})
        row = self.workspace.create_row(database['id'], {'properties': {'name': '새 항목'}, 'depends_on': []})
        self.assertEqual(self.workspace.update_row(database['id'], row['id'], {'properties': {'name': '수정'}, 'parent_row_id': None, 'depends_on': []})['properties']['name'], '수정')
        self.assertTrue(self.workspace.delete_row(database['id'], row['id'])['deleted'])


if __name__ == "__main__": unittest.main()
