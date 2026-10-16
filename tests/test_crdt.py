import copy
import hashlib
import itertools
import json
import unittest
from pathlib import Path

from fountain.core import APIError
from fountain.crdt import apply_operations, normalize_blocks, project, public_state, seed_state, validate_marks, visible_chars


def operation(client, clock, kind, block_id="block", **values):
    return {"id": f"{client}:{clock}", "client": client, "clock": clock, "type": kind, "block_id": block_id, **values}


class CRDTTests(unittest.TestCase):
    def test_shared_vectors_converge_in_projection_and_full_state_for_every_permutation(self):
        vectors = json.loads((Path(__file__).parent / "fixtures" / "crdt-vectors.json").read_text())["vectors"]
        for vector in vectors:
            original = seed_state(vector["initial_blocks"])
            expected_state = apply_operations(original, vector["operations"])
            for permutation in vector["permutations"]:
                with self.subTest(vector=vector["name"], permutation=permutation):
                    state = original
                    for index in permutation: state = apply_operations(state, [vector["operations"][index]])
                    self.assertEqual(state, expected_state)
                    self.assertEqual(project(state), vector["expected"])
                    self.assertEqual(apply_operations(state, vector["operations"]), state)
                    self.assertEqual(project(public_state(state)), project(state))

    def test_same_anchor_concurrency_uses_numeric_clock_then_client_and_chain(self):
        state = seed_state([{"id": "block", "text": "한🙂"}])
        operations = [operation("a", 2, "text.insert", after_id="seed:block:0", text="AB"),
                      operation("b", 10, "text.insert", after_id="seed:block:0", text="다🚀")]
        for order in itertools.permutations(operations):
            changed = apply_operations(state, list(order))
            self.assertEqual(project(changed)[0]["text"], "한다🚀AB🙂")
            self.assertEqual([char["id"] for char in visible_chars(changed, "block")],
                             ["seed:block:0", "b:10:0", "b:10:1", "a:2:0", "a:2:1", "seed:block:1"])
        self.assertEqual(project(state)[0]["text"], "한🙂")

    def test_unknown_and_placeholder_anchors_remain_pending_until_inserted(self):
        state = seed_state([{"id": "block", "text": ""}])
        pending = operation("child", 2, "text.insert", after_id="anchor:1:0", text="B")
        delete = operation("delete", 3, "text.delete", char_ids=["anchor:1:0"])
        changed = apply_operations(state, [pending, delete])
        self.assertEqual(project(changed)[0]["text"], "")
        anchor = operation("anchor", 1, "text.insert", after_id=None, text="A")
        changed = apply_operations(changed, [anchor])
        self.assertEqual(project(changed)[0]["text"], "B")
        self.assertEqual(project(public_state(changed))[0]["text"], "B")

    def test_pending_format_per_mark_conflicts_and_removal_do_not_revive_deletes(self):
        operations = [operation("insert", 1, "text.insert", after_id=None, text="AB", marks={"bold": True, "italic": True}),
                      operation("format", 4, "text.format", char_ids=["insert:1:0"], marks={"bold": False, "link": None}),
                      operation("color", 3, "text.format", char_ids=["insert:1:0"], marks={"color": "red"}),
                      operation("delete", 5, "text.delete", char_ids=["insert:1:1"])]
        for order in itertools.permutations(operations):
            state = apply_operations(seed_state([{"id": "block", "text": ""}]), list(order))
            token = project(state)[0]["rich_text"][0]
            self.assertEqual(token, {"text": "A", "marks": {"bold": False, "italic": True, "link": None, "color": "red"}})
            self.assertEqual(state["max_clock"], 5)

    def test_block_delete_is_permanent_and_future_move_fields_still_merge(self):
        operations = [operation("insert", 1, "block.insert", block_type="todo"),
                      operation("text", 2, "text.insert", after_id=None, text="private contents"),
                      operation("delete", 3, "block.delete"),
                      operation("move", 4, "block.move", parent_id="another", after_id=None),
                      operation("set", 5, "block.set", field="checked", value=True)]
        initial = seed_state([{"id": "another", "text": "live"}])
        expected = apply_operations(initial, operations)
        for order in itertools.permutations(operations):
            state = apply_operations(initial, list(order))
            self.assertEqual(state, expected)
            self.assertEqual([b["id"] for b in project(state)], ["another"])
            self.assertEqual(state["blocks"]["block"]["parent_id"], "another")
            self.assertTrue(state["blocks"]["block"]["fields"]["checked"]["value"])

    def test_public_snapshot_removes_deleted_payloads_and_preserves_anchors(self):
        initial = seed_state([{"id": "block", "text": "秘密🙂"}, {"id": "gone", "text": "private whole block", "language": "hidden-language"}])
        operations = [operation("delete", 1, "text.delete", char_ids=["seed:block:0", "seed:block:1"]),
                      operation("format", 2, "text.format", char_ids=["seed:block:2"], marks={"bold": False, "link": None}),
                      operation("delete", 3, "block.delete", "gone")]
        state = apply_operations(initial, operations)
        clean = public_state(state)
        encoded = json.dumps(clean, ensure_ascii=False)
        self.assertNotIn("秘密", encoded)
        self.assertNotIn("private whole block", encoded)
        self.assertNotIn("hidden-language", encoded)
        self.assertNotIn("text", clean["blocks"]["block"]["chars"]["seed:block:0"])
        self.assertEqual(clean["blocks"]["block"]["chars"]["seed:block:1"]["after_id"], "seed:block:0")
        self.assertEqual(project(clean), project(state))
        self.assertEqual(project(clean)[0]["rich_text"][0]["marks"], {"bold": False, "link": None})
        self.assertIn("text", state["blocks"]["block"]["chars"]["seed:block:0"])

    def test_reused_operation_id_conflict_and_input_immutability(self):
        state = seed_state([{"id": "block", "text": "original"}])
        before = copy.deepcopy(state)
        op = operation("a", 1, "text.insert", after_id=None, text="new")
        changed = apply_operations(state, [op])
        self.assertEqual(state, before)
        self.assertEqual(changed["seen"]["a:1"], hashlib.sha256(json.dumps(op, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest())
        with self.assertRaises(APIError) as error: apply_operations(changed, [{**op, "text": "different"}])
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(apply_operations(changed, [op]), changed)

    def test_normalization_supports_aliases_merges_tokens_and_legacy_plain_replacement(self):
        block = {"id": "b", "type": "to_do", "checked": False, "text": "가나", "rich_text": [
            {"text": "가", "marks": {"bold": True}}, {"text": "나", "marks": {"bold": True}}]}
        normalized = normalize_blocks([block])[0]
        self.assertEqual(normalized["type"], "todo")
        self.assertEqual(normalized["rich_text"], [{"text": "가나", "marks": {"bold": True}}])
        changed = normalize_blocks([{**block, "text": "legacy replacement"}])[0]
        self.assertEqual(changed["rich_text"], [{"text": "legacy replacement", "marks": {}}])
        with self.assertRaises(APIError): normalize_blocks([{**block, "text": "replacement", "rich_text": [{"text": "old", "marks": {"link": "javascript:alert(1)"}}]}])

    def test_invalid_operations_marks_unicode_and_transport_bounds(self):
        state = seed_state([{"id": "block", "text": ""}])
        invalid = [operation("a", True, "block.delete"), operation("a", 0, "block.delete"),
                   operation("a", 9007199254740992, "block.delete"), operation("bad:client", 1, "block.delete"),
                   {**operation("a", 1, "block.delete"), "id": "wrong"},
                   operation("a", 1, "text.insert", text="\ud800"),
                   operation("a", 1, "block.set", field="html", value="<b>unsafe</b>"),
                   operation("a", 1, "block.insert", block_type="paragraph", text="not allowed"),
                   operation("a", 1, "block.set", field="size", value=1.2),
                   operation("a", 1, "text.format", char_ids=["x"], marks={"bold": 1})]
        for op in invalid:
            with self.subTest(op=op), self.assertRaises(APIError): apply_operations(state, [op])
        with self.assertRaises(APIError): apply_operations(state, [operation("a", i + 1, "block.delete") for i in range(1001)])
        for marks in [{"color": "#ff0000"}, {"html": "<b>x</b>"}, {"link": "//evil.example"}, {"link": "data:text/html,x"}, {"link": "/\\evil.example"}]:
            with self.subTest(marks=marks), self.assertRaises(APIError): validate_marks(marks)
        for link in ["https://example.com", "http://localhost:8787", "mailto:family@example.com", "/page/1", "#notes", None]:
            self.assertEqual(validate_marks({"link": link}), {"link": link})

    def test_block_parent_after_and_character_cycles_have_deterministic_lossless_projection(self):
        state = seed_state([{"id": i, "text": i} for i in ["a", "b", "c"]])
        ops = [operation("m", 1, "block.move", "a", parent_id="b"),
               operation("m", 2, "block.move", "b", parent_id="a"),
               operation("m", 3, "block.move", "c", parent_id="missing", after_id="missing")]
        for order in itertools.permutations(ops):
            blocks = project(apply_operations(state, list(order)))
            self.assertEqual(set(b["id"] for b in blocks), {"a", "b", "c"})
            self.assertEqual(next(b for b in blocks if b["id"] == "a")["parent_id"], None)
        state = seed_state([{"id": "block", "text": ""}])
        ops = [operation("a", 1, "text.insert", after_id="b:2:0", text="A"),
               operation("b", 2, "text.insert", after_id="a:1:0", text="B")]
        self.assertEqual(project(apply_operations(state, ops))[0]["text"], "AB")


if __name__ == "__main__": unittest.main()
