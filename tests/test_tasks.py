import copy
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from fountain.core import APIError, Store
from fountain.tasks import TaskGraph, parse_date_value, validate_date_value, validate_settings


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.graph = TaskGraph(self.store)
        self.database = {"id": "tasks", "properties": [{"id": "due", "name": "일정", "type": "date"}],
                         "task_settings": {"subitems": True, "dependencies": True, "date_property": "due", "shift": "overlap", "skip_weekends": False}}
        self.store.put("database", self.database)

    def tearDown(self):
        self.store.close()

    def row(self, identity, due=None, dependencies=None, parent=None, database="tasks"):
        return self.store.put("row", {"id": identity, "database_id": database,
            "properties": {"due": due}, "parent_row_id": parent, "depends_on": dependencies or []})

    def shift(self, old, due, mode="overlap", weekends=False, can_edit=None):
        database = copy.deepcopy(self.database)
        database["task_settings"].update(shift=mode, skip_weekends=weekends)
        return self.graph.plan_shift(database, old, {**old, "properties": {"due": due}}, can_edit)

    def test_settings_partial_updates_and_invalid_schema(self):
        settings = validate_settings({"task_settings": {"shift": "maintain"}, "name": "ignored outer"}, self.database)
        self.assertTrue(settings["subitems"])
        self.assertEqual(settings["shift"], "maintain")
        for body in [{"skip_weekends": 1}, {"shift": "unknown"}, {"shift": []}, {"date_property": "missing"}, {"extra": True}]:
            with self.subTest(body=body), self.assertRaises(APIError): validate_settings(body, self.database)
        self.assertEqual(validate_settings({}, {"properties": []})["shift"], "none")

    def test_date_values_validate_ranges_precision_and_timezone(self):
        self.assertEqual(parse_date_value("2026-10-16"), (date(2026, 10, 16), date(2026, 10, 16)))
        value = {"start": "2026-10-16T09:00:00+09:00", "end": "2026-10-16T11:00:00+09:00", "time_zone": "Asia/Seoul"}
        self.assertEqual(validate_date_value(value), value)
        self.assertIsInstance(parse_date_value(value)[0], datetime)
        self.assertEqual(validate_date_value("2026-10-16T00:00:00Z"), "2026-10-16T00:00:00+00:00")
        self.assertIsNone(parse_date_value(None))
        self.assertEqual(validate_date_value({"start": "2026-10-16", "end": None}), {"start": "2026-10-16", "end": None})
        for value in ["2026-02-30", "2026-10-16T09:00:00", {"start": "2026-10-16", "end": "2026-10-15"},
                      {"start": "2026-10-16", "end": "2026-10-16T12:00:00Z"},
                      {"start": "2026-10-16", "time_zone": "Unknown/Nowhere"}]:
            with self.subTest(value=value), self.assertRaises(APIError): validate_date_value(value)

    def test_link_validation_defaults_self_missing_cross_database_and_duplicates(self):
        self.row("a")
        self.row("foreign", database="another")
        self.assertEqual(self.graph.prepare_row(self.database, "new", {}), {"parent_row_id": None, "depends_on": []})
        for body in [{"parent_row_id": "new"}, {"depends_on": ["new"]}, {"depends_on": ["missing"]},
                     {"parent_row_id": "foreign"}, {"depends_on": ["foreign"]}, {"depends_on": ["a", "a"]}, {"depends_on": None}]:
            with self.subTest(body=body), self.assertRaises(APIError): self.graph.prepare_row(self.database, "new", body)

    def test_independent_parent_and_dependency_cycle_detection(self):
        a = self.row("a")
        self.row("b", dependencies=["a"], parent="a")
        self.row("c", dependencies=["b"], parent="b")
        for body in [{"parent_row_id": "c"}, {"depends_on": ["c"]}]:
            with self.assertRaises(APIError): self.graph.prepare_row(self.database, "a", body, a)
        result = self.graph.prepare_row(self.database, "new", {"parent_row_id": "c", "depends_on": ["a"]})
        self.assertEqual(result["parent_row_id"], "c")

    def test_disabled_features_preserve_old_links_but_block_new_links(self):
        self.row("a")
        existing = self.row("b", dependencies=["a"], parent="a")
        database = {**self.database, "task_settings": {"subitems": False, "dependencies": False}}
        self.assertEqual(self.graph.prepare_row(database, "b", {}, existing), {"parent_row_id": "a", "depends_on": ["a"]})
        self.assertEqual(self.graph.prepare_row(database, "b", {"parent_row_id": None, "depends_on": []}, existing), {"parent_row_id": None, "depends_on": []})
        with self.assertRaises(APIError): self.graph.prepare_row(database, "new", {"depends_on": ["a"]})

    def test_descendants_include_root_in_deterministic_breadth_first_order(self):
        self.row("a")
        self.row("c", parent="a")
        self.row("b", parent="a")
        self.row("d", parent="b")
        self.row("unrelated")
        self.assertEqual([row["id"] for row in self.graph.descendants("tasks", "a")], ["a", "b", "c", "d"])
        with self.assertRaises(APIError): self.graph.descendants("tasks", "absent")

    def test_overlap_shifts_transitively_and_does_not_mutate_store(self):
        a = self.row("a", "2026-10-12")
        self.row("b", "2026-10-13", ["a"])
        self.row("c", {"start": "2026-10-14", "end": "2026-10-16"}, ["b"])
        before = self.store.list("row")
        updates = self.shift(a, "2026-10-15")
        self.assertEqual([row["id"] for row in updates], ["b", "c"])
        self.assertEqual(updates[0]["properties"]["due"], "2026-10-16")
        self.assertEqual(updates[1]["properties"]["due"], {"start": "2026-10-17", "end": "2026-10-19"})
        self.assertEqual(self.store.list("row"), before)
        self.assertEqual(self.shift(a, "2026-10-10"), [])

    def test_maintain_preserves_gaps_and_allows_negative_offsets(self):
        a = self.row("a", {"start": "2026-10-08", "end": "2026-10-10"})
        self.row("b", {"start": "2026-10-12", "end": "2026-10-14"}, ["a"])
        self.row("c", "2026-10-17", ["b"])
        updates = self.shift(a, {"start": "2026-10-05", "end": "2026-10-07"}, "maintain")
        self.assertEqual(updates[0]["properties"]["due"], {"start": "2026-10-09", "end": "2026-10-11"})
        self.assertEqual(updates[1]["properties"]["due"], "2026-10-14")

    def test_branching_multiple_predecessors_shift_once_with_strongest_constraint(self):
        a = self.row("a", "2026-10-10")
        self.row("b", "2026-10-11", ["a"])
        self.row("c", "2026-10-13", ["a"])
        self.row("d", "2026-10-15", ["b", "c"])
        updates = self.shift(a, "2026-10-14", "maintain")
        self.assertEqual([row["id"] for row in updates], ["b", "c", "d"])
        self.assertEqual(updates[-1]["properties"]["due"], "2026-10-19")
        self.row("unchanged", "2026-10-12")
        d = self.store.get("row", "d")
        d["depends_on"].append("unchanged")
        self.store.put("row", d)
        updates = self.shift(a, "2026-10-08", "maintain")
        self.assertNotIn("d", [row["id"] for row in updates])

    def test_weekend_translation_preserves_duration_and_weekday_endpoints(self):
        a = self.row("a", "2026-10-15")
        self.row("b", {"start": "2026-10-16", "end": "2026-10-21"}, ["a"])
        result = self.shift(a, "2026-10-16", weekends=True)[0]["properties"]["due"]
        self.assertEqual(result, {"start": "2026-10-21", "end": "2026-10-26"})
        start, end = parse_date_value(result)
        self.assertLess(start.weekday(), 5)
        self.assertLess(end.weekday(), 5)
        self.assertEqual((end - start).days, 5)

    def test_inaccessible_dependent_is_skipped_and_does_not_propagate(self):
        a = self.row("a", "2026-10-12")
        self.row("b", "2026-10-13", ["a"])
        self.row("c", "2026-10-14", ["b"])
        self.assertEqual(self.shift(a, "2026-10-15", can_edit=lambda row: row["id"] != "b"), [])
        self.row("visible", "2026-10-13", ["a"])
        result = self.shift(a, "2026-10-15", can_edit=lambda row: row["id"] != "b")
        self.assertEqual([row["id"] for row in result], ["visible"])

    def test_datetime_shifts_preserve_offsets_elapsed_duration_and_metadata(self):
        a = self.row("a", "2026-10-16T10:00:00+09:00")
        self.row("b", {"start": "2026-10-16T03:00:00+00:00", "end": "2026-10-16T05:30:00+00:00", "time_zone": "UTC"}, ["a"])
        result = self.shift(a, "2026-10-16T14:00:00+09:00", "maintain")[0]["properties"]["due"]
        self.assertEqual(result, {"start": "2026-10-16T07:00:00+00:00", "end": "2026-10-16T09:30:00+00:00", "time_zone": "UTC"})
        self.row("mixed", "2026-10-16", ["a"])
        with self.assertRaises(APIError): self.shift(a, "2026-10-16T15:00:00+09:00")

    def test_mode_none_unset_dates_overflow_and_graph_bounds(self):
        a = self.row("a", "2026-10-12")
        self.row("b", None, ["a"])
        self.assertEqual(self.shift(a, "2026-10-15"), [])
        self.assertEqual(self.shift(a, "2026-10-15", "none"), [])
        self.row("b", "9999-12-31", ["a"])
        with self.assertRaises(APIError): self.shift(a, "9999-12-31")
        rows = [{"id": str(i), "database_id": "tasks"} for i in range(10001)]
        with self.assertRaises(APIError): self.graph.prepare_row(self.database, "new", {}, rows=rows)

    def test_duplicate_subtree_remaps_links_relations_and_preserves_dates_privately(self):
        database = copy.deepcopy(self.database)
        database["properties"].extend([{"id": "related", "name": "연결", "type": "relation"},
                                       {"id": "files", "name": "첨부", "type": "files"}])
        database["task_settings"] = {"subitems": False, "dependencies": False}
        self.store.put("database", database)
        self.row("external", "2026-10-10")
        a = self.row("a", {"start": "2026-10-12", "end": "2026-10-14"}, ["external"])
        self.row("b", "2026-10-15", ["a"], "a")
        self.row("c", "2026-10-16", ["a", "b"], "b")
        a.update(owner_id="original", permissions={"default": "workspace"}, access_level=4, computed_errors={"x": "error"})
        a["properties"].update(related=["b", "external"], files=[{"id": "file-id", "name": "family.png"}])
        self.store.put("row", a)
        before = self.store.list("row")
        copies = self.graph.duplicate_plan("tasks", "a", "copier")
        new_a, new_b, new_c = copies
        self.assertEqual(len(copies), 3)
        self.assertTrue({row["id"] for row in copies}.isdisjoint({"a", "b", "c"}))
        self.assertEqual(new_b["parent_row_id"], new_a["id"])
        self.assertEqual(new_c["parent_row_id"], new_b["id"])
        self.assertEqual(new_a["depends_on"], ["external"])
        self.assertEqual(new_b["depends_on"], [new_a["id"]])
        self.assertEqual(new_c["depends_on"], [new_a["id"], new_b["id"]])
        self.assertEqual(new_a["properties"]["related"], [new_b["id"], "external"])
        self.assertEqual(new_a["properties"]["due"], a["properties"]["due"])
        self.assertEqual(new_a["properties"]["files"], a["properties"]["files"])
        for row in copies:
            self.assertEqual(row["owner_id"], "copier")
            self.assertEqual(row["permissions"], {"default": "private", "inherit": False, "members": {"copier": "full"}, "groups": {}})
            for field in ("created_at", "updated_at", "access_level", "computed_errors"):
                self.assertNotIn(field, row)
        self.assertEqual(self.store.list("row"), before)

    def test_duplicate_redacts_hidden_external_references_and_requires_every_descendant(self):
        database = copy.deepcopy(self.database)
        database["properties"].append({"id": "related", "name": "연결", "type": "relation"})
        self.store.put("database", database)
        self.row("hidden-parent")
        self.row("hidden-dependency")
        self.row("visible")
        a = self.row("a", "2026-10-12", ["hidden-dependency", "visible"], "hidden-parent")
        self.row("b", "2026-10-13", ["a"], "a")
        a["properties"]["related"] = ["b", "hidden-dependency", "visible", "missing"]
        self.store.put("row", a)
        readable = lambda row: not row["id"].startswith("hidden")
        copies = self.graph.duplicate_plan("tasks", "a", "copier", readable)
        self.assertIsNone(copies[0]["parent_row_id"])
        self.assertEqual(copies[0]["depends_on"], ["visible"])
        self.assertEqual(copies[0]["properties"]["related"], [copies[1]["id"], "visible"])
        before = self.store.list("row")
        with self.assertRaises(APIError) as error:
            self.graph.duplicate_plan("tasks", "a", "copier", lambda row: row["id"] != "b")
        self.assertEqual(error.exception.status, 403)
        self.assertEqual(self.store.list("row"), before)

    def test_links_and_schedule_survive_store_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tasks.db"
            store = Store(path)
            a = store.put("row", {"id": "a", "database_id": "tasks", "properties": {"due": "2026-10-12"}})
            store.put("row", {"id": "b", "database_id": "tasks", "properties": {"due": "2026-10-13"}, "depends_on": ["a"], "parent_row_id": "a"})
            store.close()
            store = Store(path)
            try:
                graph = TaskGraph(store)
                self.assertEqual(len(graph.descendants("tasks", "a")), 2)
                result = graph.plan_shift(self.database, a, {**a, "properties": {"due": "2026-10-15"}})
                self.assertEqual(result[0]["properties"]["due"], "2026-10-16")
            finally: store.close()


if __name__ == "__main__": unittest.main()
