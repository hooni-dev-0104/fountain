"""Targeted undo semantics, immutable legacy state, and public-value boundaries."""
import copy
import hashlib
import itertools
import json
import unittest

from fountain.core import APIError
from fountain.crdt import (apply_operations, capture_public_hints, hydrate_public_state,
                           project, public_state, seed_state, visible_chars)


def op(client, clock, kind, block_id="block", **values):
    result = {"id": f"{client}:{clock}", "client": client, "clock": clock, "type": kind}
    if kind != "history.cancel": result["block_id"] = block_id
    return {**result, **values}


def cancel(client, clock, *targets):
    return op(client, clock, "history.cancel", targets=list(targets))


class HistoryCRDTTests(unittest.TestCase):
    def initial(self, text="x", **fields):
        return seed_state([{"id": "block", "text": text, **fields}])

    def converge(self, initial, operations):
        expected = apply_operations(initial, operations)
        original = copy.deepcopy(initial)
        for permutation in itertools.permutations(operations):
            current = initial
            for operation in permutation: current = apply_operations(current, [operation])
            self.assertEqual(current, expected)
            self.assertEqual(apply_operations(current, operations), expected)
            self.assertEqual(project(public_state(current)), project(current))
        self.assertEqual(initial, original)
        return expected

    def test_late_lower_clock_field_and_redo_do_not_erase_remote_candidate(self):
        initial = self.initial()
        a = op("a", 3, "block.set", field="type", value="heading_1")
        b = op("b", 2, "block.set", field="type", value="quote")
        state = self.converge(initial, [a, b, cancel("a", 4, a["id"])])
        self.assertEqual(project(state)[0]["type"], "quote")
        redone = apply_operations(state, [cancel("a", 5, "a:4")])
        self.assertEqual(project(redone)[0]["type"], "heading1")
        self.assertEqual(redone["history"]["ops"]["b:2"], b)
        self.assertEqual(redone["history"]["baseline"]["blocks"], initial["blocks"])

    def test_mark_registers_and_atomic_position_use_active_lineage(self):
        initial = seed_state([{"id": name, "text": name} for name in ("p", "q", "block")])
        cid = "seed:block:0"
        marks = [op("a", 3, "text.format", char_ids=[cid], marks={"bold": True, "link": None}),
                 op("b", 2, "text.format", char_ids=[cid], marks={"bold": False, "link": "https://example.com"}),
                 cancel("a", 4, "a:3")]
        state = self.converge(initial, marks)
        self.assertEqual(visible_chars(state, "block")[0]["marks"], {"bold": False, "link": "https://example.com"})
        positions = [op("a", 3, "block.move", parent_id="p", after_id="q"),
                     op("b", 2, "block.move", parent_id="q", after_id="p"), cancel("a", 4, "a:3")]
        moved = self.converge(initial, positions)["blocks"]["block"]
        self.assertEqual((moved["parent_id"], moved["after_id"], moved["move"]), ("q", "p", [2, "b", "b:2"]))

    def test_multiple_cancellations_and_two_thousand_node_dag_are_stack_safe(self):
        state = self.converge(self.initial(), [op("a", 1, "block.set", field="checked", value=True),
            cancel("a", 2, "a:1"), cancel("a", 3, "a:1"), cancel("a", 4, "a:2")])
        self.assertNotIn("checked", project(state)[0])
        self.assertTrue(project(apply_operations(state, [cancel("a", 5, "a:3")]))[0]["checked"])
        operations = [op("a", 1, "block.set", field="checked", value=True)]
        operations.extend(cancel("a", clock, f"a:{clock - 1}") for clock in range(2, 2002))
        results = []
        for order in (operations, list(reversed(operations))):
            current = self.initial()
            for index in range(0, len(order), 1000): current = apply_operations(current, order[index:index + 1000])
            results.append(current)
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0]["max_clock"], 2001)
        self.assertTrue(project(results[0])[0]["checked"])

    def test_repeated_deletion_restores_original_ids_only_without_other_active_delete(self):
        cid = "seed:block:0"
        state = self.converge(self.initial(), [op("a", 1, "text.delete", char_ids=[cid]),
            op("b", 2, "text.delete", char_ids=[cid]), cancel("a", 3, "a:1")])
        self.assertEqual(project(state)[0]["text"], "")
        restored = apply_operations(state, [cancel("b", 4, "b:2")])
        self.assertEqual(visible_chars(restored, "block"), [{"id": cid, "text": "x", "marks": {}}])

    def test_canceled_insert_skeleton_keeps_remote_anchor_order_and_redo_ids(self):
        state = self.converge(self.initial(""), [op("a", 1, "text.insert", after_id=None, text="xy"),
            op("b", 2, "text.insert", after_id="a:1:0", text="Z"), cancel("a", 3, "a:1")])
        self.assertEqual(project(state)[0]["text"], "Z")
        self.assertIn("a:1:0", state["blocks"]["block"]["chars"])
        restored = apply_operations(state, [cancel("a", 4, "a:3")])
        self.assertEqual([char["id"] for char in visible_chars(restored, "block")], ["a:1:0", "b:2:0", "a:1:1"])
        self.assertEqual(project(restored)[0]["text"], "xZy")

    def test_delete_undo_preserves_remote_insertion_and_format_at_old_anchor(self):
        initial = self.initial("ABCD")
        operations = [op("a", 1, "text.delete", char_ids=["seed:block:1", "seed:block:2"]),
            op("b", 2, "text.insert", after_id="seed:block:1", text="X"),
            op("b", 3, "text.format", char_ids=["seed:block:1"], marks={"italic": True}), cancel("a", 4, "a:1")]
        state = self.converge(initial, operations)
        self.assertEqual(project(state)[0]["text"], "ABXCD")
        self.assertEqual(visible_chars(state, "block")[1]["marks"], {"italic": True})
        redelete = apply_operations(state, [op("b", 5, "text.delete", char_ids=["seed:block:1"])])
        self.assertEqual(project(redelete)[0]["text"], "AXCD")
        restored = apply_operations(redelete, [cancel("b", 6, "b:5")])
        self.assertEqual(project(restored)[0]["text"], "ABXCD")

    def test_format_on_inactive_character_does_not_resurrect_it(self):
        state = self.converge(self.initial(""), [op("a", 1, "text.insert", text="가😀", marks={"bold": False}),
            op("b", 2, "text.format", char_ids=["a:1:0"], marks={"bold": True}), cancel("a", 3, "a:1")])
        self.assertEqual(project(state)[0]["text"], "")
        restored = apply_operations(state, [cancel("a", 4, "a:3")])
        self.assertEqual(visible_chars(restored, "block")[0]["marks"], {"bold": True})

    def test_protected_file_container_uses_creation_cohort_but_not_its_text(self):
        initial = seed_state([])
        operations = [op("a", 1, "block.insert", "file", block_type="file", group_id="birth"),
            op("a", 2, "block.set", "file", field="attachment_id", value="attachment-1", group_id="birth"),
            op("a", 3, "block.set", "file", field="size", value=42, group_id="birth"),
            op("a", 4, "text.insert", "file", text="original filename", group_id="birth"),
            cancel("a", 5, "a:1", "a:2", "a:3", "a:4")]
        state = apply_operations(initial, operations)
        self.assertEqual(project(state), [])
        remote = op("b", 2, "text.insert", "file", text="remote", after_id="a:4:0")
        expected = apply_operations(initial, operations + [remote])
        for order in (operations + [remote], [remote] + list(reversed(operations))):
            current = initial
            for operation in order: current = apply_operations(current, [operation])
            self.assertEqual(current, expected)
        self.assertEqual(project(expected)[0], {"id": "file", "type": "file", "attachment_id": "attachment-1", "size": 42,
                                               "parent_id": None, "text": "remote", "rich_text": [{"text": "remote", "marks": {}}]})

    def test_child_protects_canceled_ancestor_chain_but_explicit_delete_dominates(self):
        operations = [op("a", 1, "block.insert", "p", block_type="toggle", group_id="birth"),
            op("a", 2, "block.insert", "q", parent_id="p", block_type="quote", group_id="birth"),
            op("b", 2, "block.insert", "child", parent_id="q"), cancel("a", 3, "a:1", "a:2")]
        state = self.converge(seed_state([]), operations)
        self.assertEqual([(block["id"], block["parent_id"]) for block in project(state)], [("p", None), ("q", "p"), ("child", "q")])
        deleted = apply_operations(state, [op("b", 4, "block.delete", "p")])
        self.assertEqual([(block["id"], block["parent_id"]) for block in project(deleted)], [("q", None), ("child", "q")])
        restored = apply_operations(deleted, [cancel("b", 5, "b:4")])
        self.assertEqual(project(restored), project(state))

    def test_canceled_cycles_without_contribution_hide_and_foreign_equal_field_protects(self):
        initial = seed_state([])
        ops = [op("a", 1, "block.insert", "p", parent_id="q", group_id="birth"),
               op("a", 2, "block.insert", "q", parent_id="p", group_id="birth"), cancel("a", 3, "a:1", "a:2")]
        self.assertEqual(project(self.converge(initial, ops)), [])
        protected = apply_operations(initial, ops + [op("b", 2, "block.set", "q", field="type", value="paragraph")])
        self.assertEqual([(block["id"], block["parent_id"]) for block in project(protected)], [("p", None), ("q", "p")])

    def test_active_lower_clock_field_and_move_beat_canceled_creation_fallback(self):
        initial = seed_state([{"id": "other", "text": ""}])
        operations = [op("a", 5, "block.insert", "new", block_type="heading1", group_id="birth"),
            op("b", 2, "block.set", "new", field="type", value="quote"),
            op("b", 3, "block.move", "new", parent_id="other"), cancel("a", 6, "a:5")]
        state = self.converge(initial, operations)
        block = next(block for block in project(state) if block["id"] == "new")
        self.assertEqual((block["type"], block["parent_id"]), ("quote", "other"))

    def test_late_group_fields_no_phantom_and_deterministic_colliding_birth(self):
        initial = seed_state([])
        fields = op("a", 2, "block.set", "new", field="attachment_id", value="file", group_id="g")
        pending = apply_operations(initial, [fields, op("b", 3, "text.insert", "new", text="remote")])
        self.assertEqual(project(pending), [])
        state = self.converge(initial, [op("a", 1, "block.insert", "new", block_type="file", group_id="g"), fields,
            op("b", 3, "text.insert", "new", text="remote"), cancel("a", 4, "a:1", "a:2")])
        self.assertEqual(project(state)[0]["attachment_id"], "file")
        collision = [op("a", 5, "block.insert", "new", block_type="file"),
            op("b", 1, "block.insert", "new", block_type="quote"), cancel("a", 6, "a:5"), cancel("b", 2, "b:1"),
            op("c", 3, "text.insert", "new", text="remote")]
        self.assertEqual(project(self.converge(initial, collision))[0]["type"], "quote")

    def test_legacy_replay_is_exact_noop_and_tombstones_cannot_be_canceled(self):
        original = op("a", 1, "text.delete", char_ids=["seed:block:0"])
        state = self.initial()
        state["blocks"]["block"]["chars"]["seed:block:0"]["deleted"] = True
        state["max_clock"] = 1
        state["seen"]["a:1"] = hashlib.sha256(json.dumps(original, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(apply_operations(state, [original]), state)
        self.assertNotIn("history", state)
        changed = apply_operations(state, [cancel("a", 2, "a:1")])
        self.assertEqual(project(changed)[0]["text"], "")
        self.assertEqual(changed["history"]["ops"].keys(), {"a:2"})
        self.assertTrue(changed["history"]["baseline"]["blocks"]["block"]["chars"]["seed:block:0"]["deleted"])

    def test_public_history_strips_all_historical_values_and_hashes(self):
        state = self.initial("secret baseline", language="secret-language")
        operations = [op("a", 1, "block.set", field="language", value="secret-old-write"),
            op("b", 2, "block.set", field="language", value="visible-language"),
            op("a", 3, "text.insert", text="secret-insert", marks={"link": "https://secret.example"}),
            op("a", 4, "text.delete", char_ids=[f"a:3:{index}" for index in range(len("secret-insert"))]
                + [f"seed:block:{index}" for index in range(len("secret baseline"))])]
        private = apply_operations(state, operations)
        public = public_state(private)
        encoded = json.dumps(public, ensure_ascii=False)
        for secret in ("secret baseline", "secret-language", "secret-old-write", "secret-insert", "https://secret.example"):
            self.assertNotIn(secret, encoded)
        for digest in private["seen"].values(): self.assertNotIn(digest, encoded)
        self.assertNotIn("parent_id", public["history"]["baseline"]["blocks"]["block"])
        self.assertNotIn("after_id", public["history"]["baseline"]["blocks"]["block"])
        self.assertEqual(public["history"]["ops"]["a:3"]["mark_keys"], ["link"])
        self.assertEqual(public["history"]["ops"]["a:3"]["character_count"], len("secret-insert"))
        self.assertEqual(project(public), project(private))

    def test_public_unknown_winner_uses_exact_source_hints_and_cannot_guess_baseline(self):
        initial = self.initial()
        before = apply_operations(initial, [op("b", 2, "block.set", field="type", value="quote")])
        private = apply_operations(before, [op("a", 3, "block.set", field="type", value="heading1")])
        public = public_state(private)
        cancellation = cancel("a", 4, "a:3")
        unknown = apply_operations(public, [cancellation], capture_public_hints(initial))
        descriptor = {"block_id": "block", "kind": "field", "field": "type", "source": [2, "b", "b:2"]}
        self.assertEqual(unknown["unresolved_slots"], [descriptor])
        self.assertEqual(unknown["blocks"]["block"]["fields"]["type"], {"stamp": [2, "b", "b:2"]})
        result = hydrate_public_state(unknown, capture_public_hints(before))
        self.assertEqual(result["unresolved_slots"], [])
        self.assertEqual(project(result["state"]), project(apply_operations(private, [cancellation])))
        self.assertEqual(unknown["unresolved_slots"], [descriptor], "Hydration must not mutate input")

    def test_public_unknown_position_text_and_marks_remain_unresolved_until_hydrated(self):
        initial = seed_state([{"id": name, "text": "x"} for name in ("p", "q", "block")])
        older = apply_operations(initial, [op("b", 2, "block.move", parent_id="q", after_id="p"),
            op("b", 3, "text.format", char_ids=["seed:block:0"], marks={"link": "https://old.example"})])
        private = apply_operations(older, [op("a", 4, "block.move", parent_id="p"),
            op("a", 5, "text.format", char_ids=["seed:block:0"], marks={"link": None}),
            op("a", 6, "text.delete", char_ids=["seed:block:0"])])
        public = apply_operations(public_state(private), [cancel("a", 7, "a:4", "a:5", "a:6")])
        self.assertEqual({value["kind"] for value in public["unresolved_slots"]}, {"position", "text", "mark"})
        for key in capture_public_hints(public):
            self.assertNotEqual(json.loads(key), ["block", "position", None, None, None, [2, "b", "b:2"]])
        result = hydrate_public_state(public, capture_public_hints(older))
        self.assertEqual(result["unresolved_slots"], [])
        expected = apply_operations(private, [cancel("a", 7, "a:4", "a:5", "a:6")])
        self.assertEqual(project(result["state"]), project(expected))

    def test_legacy_public_snapshot_has_metadata_baseline_and_private_ignores_hints(self):
        initial = self.initial()
        public = public_state(initial)
        self.assertIs(public["history"]["public"], True)
        self.assertNotIn("history", initial)
        self.assertNotIn("text", public["history"]["baseline"]["blocks"]["block"]["chars"]["seed:block:0"])
        operations = [op("a", 1, "block.set", field="type", value="quote"), cancel("a", 2, "a:1")]
        forged = {key: "malicious" for key in capture_public_hints(initial)}
        self.assertEqual(apply_operations(initial, operations, forged), apply_operations(initial, operations))
        self.assertEqual(project(apply_operations(public, operations)), project(apply_operations(initial, operations)))
        with self.assertRaises(APIError): hydrate_public_state(initial, forged)

    def test_validation_digest_group_immutability_and_failed_batch_do_not_mutate(self):
        initial = self.initial()
        original = op("a", 1, "text.insert", text="hello", group_id="birth")
        state = apply_operations(initial, [original])
        with self.assertRaises(APIError) as error: apply_operations(state, [{**original, "group_id": "changed"}])
        self.assertEqual(error.exception.status, 409)
        invalid = [cancel("a", 2), cancel("a", 2, "b:1"), cancel("a", 2, "a:2"), cancel("a", 2, "a:3"),
            cancel("a", 2, "a:01"), cancel("a", 2, "a:1", "a:1"), cancel("a", 2, "a:" + "1" * 5000),
            {**cancel("a", 2, "a:1"), "block_id": "block"}, {**cancel("a", 2, "a:1"), "group_id": "g"},
            cancel("a", 1002, *(f"a:{index}" for index in range(1, 1002))), {**original, "group_id": ""},
            {**original, "group_id": "공유"}, {**original, "group_id": "x" * 81}]
        before = copy.deepcopy(state)
        for operation in invalid:
            with self.subTest(kind=operation["type"]), self.assertRaises(APIError):
                apply_operations(state, [op("fresh", 99, "text.insert", text="must not apply"), operation])
            self.assertEqual(state, before)
        self.assertEqual(apply_operations(state, [original]), state)


if __name__ == "__main__": unittest.main()
