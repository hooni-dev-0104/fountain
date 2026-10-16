"""Pure targeted cancellation, immutable lineage, and public value hydration.

The authoritative baseline and operation ledger retain historical values. Public
lineage carries locations and stamps only; exact locally known values are supplied
separately and never become writes or authoritative server input.
"""
from __future__ import annotations

import copy
import hashlib
import json

from . import crdt
from .core import require


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _stamp(operation):
    return [operation["clock"], operation["client"], operation["id"]]


def _slot(block_id, kind, source, **extra):
    return {"block_id": block_id, "kind": kind, **extra, "source": list(source)}


def _hint_key(descriptor):
    return _canonical([descriptor["block_id"], descriptor["kind"], descriptor.get("field"),
                       descriptor.get("char_id"), descriptor.get("mark"), descriptor["source"]])


def capture_public_hints(state):
    """Return exact current values keyed by both register location and source."""
    hints = {}
    unknown = {_hint_key(value) for value in state.get("unresolved_slots", [])}
    for identity, block in state.get("blocks", {}).items():
        if block["deleted"] or block["insert"] is None: continue
        if block["move"] is not None and "parent_id" in block and "after_id" in block:
            key = _hint_key(_slot(identity, "position", block["move"]))
            if key not in unknown:
                hints[key] = {"parent_id": block["parent_id"], "after_id": block["after_id"]}
        for field, register in block["fields"].items():
            if "value" in register:
                hints[_hint_key(_slot(identity, "field", register["stamp"], field=field))] = copy.deepcopy(register["value"])
        for char_id, char in block["chars"].items():
            if char["deleted"] or char["stamp"] is None: continue
            if "text" in char: hints[_hint_key(_slot(identity, "text", char["stamp"], char_id=char_id))] = char["text"]
            for mark, register in char["marks"].items():
                if "value" in register:
                    hints[_hint_key(_slot(identity, "mark", register["stamp"], char_id=char_id, mark=mark))] = copy.deepcopy(register["value"])
    return hints


def _metadata(operation):
    result = {key: operation[key] for key in ("id", "client", "clock", "type")}
    for key in ("block_id", "group_id", "field", "char_ids", "targets"):
        if key in operation: result[key] = copy.deepcopy(operation[key])
    if operation["type"] == "text.insert":
        result["after_id"] = operation.get("after_id")
        result["character_count"] = len(operation["text"]) if "text" in operation else operation["character_count"]
    if operation["type"] in {"text.insert", "text.format"}:
        result["mark_keys"] = sorted(operation["marks"] if "marks" in operation else operation.get("mark_keys", []))
    return result


def _redact_baseline(blocks):
    result = copy.deepcopy(blocks)
    for block in result.values():
        block.pop("parent_id", None)
        block.pop("after_id", None)
        for register in block["fields"].values(): register.pop("value", None)
        for char in block["chars"].values():
            char.pop("text", None)
            for register in char["marks"].values(): register.pop("value", None)
    return result


def public_history(state):
    history = state.get("history") or {"version": 1, "baseline": {"blocks": state["blocks"]}, "ops": {}}
    return {"version": 1, "public": True, "baseline": {"blocks": _redact_baseline(history["baseline"]["blocks"])},
            "ops": {identity: _metadata(operation) for identity, operation in history["ops"].items()}}


def _operation_hints(operations, hints):
    for operation in operations:
        identity, kind, source = operation.get("block_id"), operation["type"], _stamp(operation)
        def put(slot_kind, value, **extra):
            hints[_hint_key(_slot(identity, slot_kind, source, **extra))] = copy.deepcopy(value)
        if kind in {"block.insert", "block.move"}:
            put("position", {"parent_id": operation.get("parent_id"), "after_id": operation.get("after_id")})
        if kind == "block.insert": put("field", crdt._field("type", operation.get("block_type", "paragraph")), field="type")
        if kind == "block.set": put("field", crdt._field(operation["field"], operation.get("value")), field=operation["field"])
        if kind == "text.insert":
            for index, text in enumerate(operation["text"]):
                char_id = f"{operation['id']}:{index}"
                put("text", text, char_id=char_id)
                for mark, value in operation.get("marks", {}).items(): put("mark", value, char_id=char_id, mark=mark)
        if kind == "text.format":
            for char_id in operation["char_ids"]:
                for mark, value in operation.get("marks", {}).items(): put("mark", value, char_id=char_id, mark=mark)


def _materialize(state, hints):
    history = state["history"]
    public = history.get("public") is True
    records, active, disabled = {}, set(), set()
    operations = sorted(history["ops"].values(), key=_stamp)
    for operation in reversed(operations):
        if operation["id"] in disabled: continue
        active.add(operation["id"])
        if operation["type"] == "history.cancel": disabled.update(operation["targets"])

    def ensure(identity):
        if identity not in records:
            records[identity] = {"node": crdt._block(identity), "baseline": None, "insertions": [], "fields": {},
                                 "positions": [], "chars": {}, "deleted": False, "contributions": []}
        return records[identity]

    def ensure_char(record, identity):
        if identity not in record["chars"]:
            record["chars"][identity] = {"node": crdt._char(identity), "baseline": False, "origin": None,
                                         "marks": {}, "deleted": False}
        return record["chars"][identity]

    def candidate(descriptor, operation_id, value=None, known=False):
        result = {"descriptor": descriptor, "stamp": descriptor["source"], "op_id": operation_id}
        if known: result["value"] = copy.deepcopy(value)
        elif public and _hint_key(descriptor) in hints: result["value"] = copy.deepcopy(hints[_hint_key(descriptor)])
        return result

    def add(registers, key, value):
        registers.setdefault(key, []).append(value)

    for identity, base in history["baseline"]["blocks"].items():
        record = ensure(identity)
        record["baseline"], record["node"]["insert"], record["deleted"] = base, copy.deepcopy(base["insert"]), base["deleted"]
        if base["move"] is not None:
            record["positions"].append(candidate(_slot(identity, "position", base["move"]), None,
                {"parent_id": base.get("parent_id"), "after_id": base.get("after_id")}, "parent_id" in base and "after_id" in base))
        for field, register in base["fields"].items():
            add(record["fields"], field, candidate(_slot(identity, "field", register["stamp"], field=field), None,
                register.get("value"), "value" in register))
        for char_id, value in base["chars"].items():
            entry = ensure_char(record, char_id)
            entry.update(node=copy.deepcopy(value), baseline=value["stamp"] is not None, deleted=value["deleted"])
            if value["stamp"] is not None:
                entry["origin"] = candidate(_slot(identity, "text", value["stamp"], char_id=char_id), None,
                                            value.get("text"), "text" in value)
            for mark, register in value["marks"].items():
                add(entry["marks"], mark, candidate(_slot(identity, "mark", register["stamp"], char_id=char_id, mark=mark), None,
                                                  register.get("value"), "value" in register))

    for operation in operations:
        kind = operation["type"]
        if kind == "history.cancel": continue
        identity, stamp, live = operation["block_id"], _stamp(operation), operation["id"] in active
        record = ensure(identity)
        if kind == "block.delete":
            if live: record["deleted"] = True
            continue
        if kind in {"block.insert", "block.move"}:
            if kind == "block.insert":
                record["insertions"].append(operation)
                if crdt._newer(stamp, record["node"]["insert"]): record["node"]["insert"] = list(stamp)
                add(record["fields"], "type", candidate(_slot(identity, "field", stamp, field="type"), operation["id"],
                    crdt._field("type", operation.get("block_type", "paragraph")) if not public else None, not public))
            record["positions"].append(candidate(_slot(identity, "position", stamp), operation["id"],
                {"parent_id": operation.get("parent_id"), "after_id": operation.get("after_id")}, not public))
            if kind == "block.move": record["contributions"].append(operation)
        elif kind == "block.set":
            add(record["fields"], operation["field"], candidate(_slot(identity, "field", stamp, field=operation["field"]), operation["id"],
                crdt._field(operation["field"], operation.get("value")) if not public else None, not public))
            record["contributions"].append(operation)
        elif kind == "text.insert":
            anchor = operation.get("after_id")
            texts = operation["text"] if not public else None
            count = len(texts) if not public else operation["character_count"]
            for index in range(count):
                char_id = f"{operation['id']}:{index}"
                entry = ensure_char(record, char_id)
                entry["node"].update(after_id=anchor, stamp=list(stamp))
                entry["origin"] = candidate(_slot(identity, "text", stamp, char_id=char_id), operation["id"],
                                             texts[index] if not public else None, not public)
                for mark in operation.get("marks", {}) if not public else operation["mark_keys"]:
                    add(entry["marks"], mark, candidate(_slot(identity, "mark", stamp, char_id=char_id, mark=mark), operation["id"],
                        operation["marks"][mark] if not public else None, not public))
                anchor = char_id
        else:
            for char_id in operation["char_ids"]:
                entry = ensure_char(record, char_id)
                if kind == "text.delete":
                    if live: entry["deleted"] = True
                else:
                    for mark in operation.get("marks", {}) if not public else operation["mark_keys"]:
                        add(entry["marks"], mark, candidate(_slot(identity, "mark", stamp, char_id=char_id, mark=mark), operation["id"],
                            operation["marks"][mark] if not public else None, not public))

    def greatest(values):
        return max(values, key=lambda value: value["stamp"], default=None)

    def is_active(value):
        return value["op_id"] is None or value["op_id"] in active

    def cohort(record, operation):
        birth = record["birth"]
        if birth is None: return False
        if not birth.get("group_id"): return operation["id"] == birth["id"]
        return (operation["client"] == birth["client"] and operation.get("group_id") == birth["group_id"]
                and operation.get("block_id") == birth["block_id"]
                and operation["type"] in {"block.insert", "block.set", "block.move", "text.insert"})

    eligible, visible = set(), set()
    for identity, record in records.items():
        baseline_born = record["baseline"] is not None and record["baseline"]["insert"] is not None
        record["birth"] = None if baseline_born or not record["insertions"] else record["insertions"][0]
        record["origin_active"] = baseline_born or any(operation["id"] in active for operation in record["insertions"])
        record["position"] = (greatest(value for value in record["positions"] if is_active(value))
            or greatest(value for value in record["positions"] if value["op_id"] is not None and cohort(record, history["ops"][value["op_id"]])))
        position, node = record["position"], record["node"]
        node["move"] = list(position["stamp"]) if position is not None else None
        node["parent_id"] = position["value"]["parent_id"] if position and "value" in position else None
        node["after_id"] = position["value"]["after_id"] if position and "value" in position else None
        for entry in record["chars"].values():
            entry["node"]["deleted"] = entry["deleted"] or not (entry["baseline"] or entry["origin"] and entry["origin"]["op_id"] in active)
        if node["insert"] is not None and not record["deleted"]:
            eligible.add(identity)
            if (record["origin_active"] or any(entry["node"]["stamp"] is not None and not entry["node"]["deleted"] for entry in record["chars"].values())
                or any(operation["id"] in active and not cohort(record, operation) for operation in record["contributions"])):
                visible.add(identity)
    parents = crdt._break_cycles({identity: records[identity]["node"]["parent_id"]
        if records[identity]["node"]["parent_id"] in eligible and records[identity]["node"]["parent_id"] != identity else None for identity in eligible})
    stack = list(visible)
    while stack:
        parent = parents.get(stack.pop())
        if parent is not None and parent not in visible:
            visible.add(parent)
            stack.append(parent)

    unresolved = []
    def resolve(value):
        if value is not None and "value" not in value: unresolved.append(copy.deepcopy(value["descriptor"]))

    state["blocks"] = {}
    for identity, record in records.items():
        node = record["node"]
        node["deleted"] = record["deleted"] or node["insert"] is not None and identity not in visible
        node["fields"], node["chars"] = {}, {}
        if not node["deleted"] and node["insert"] is not None: resolve(record["position"])
        for field, values in record["fields"].items():
            value = greatest(value for value in values if is_active(value))
            if value is None and not record["origin_active"] and identity in visible:
                value = greatest(value for value in values if value["op_id"] is not None and cohort(record, history["ops"][value["op_id"]]))
            if value is not None:
                node["fields"][field] = {"stamp": list(value["stamp"])}
                if "value" in value: node["fields"][field]["value"] = copy.deepcopy(value["value"])
                if not node["deleted"] and node["insert"] is not None: resolve(value)
        for char_id, entry in record["chars"].items():
            char = entry["node"]
            char.pop("text", None)
            char["marks"] = {}
            if entry["origin"] is not None and "value" in entry["origin"]: char["text"] = entry["origin"]["value"]
            displayed = not node["deleted"] and node["insert"] is not None and not char["deleted"] and char["stamp"] is not None
            if displayed: resolve(entry["origin"])
            for mark, values in entry["marks"].items():
                value = greatest(value for value in values if is_active(value))
                if value is None: continue
                char["marks"][mark] = {"stamp": list(value["stamp"])}
                if "value" in value: char["marks"][mark]["value"] = copy.deepcopy(value["value"])
                if displayed: resolve(value)
            node["chars"][char_id] = char
        state["blocks"][identity] = node
    if public: state["unresolved_slots"] = sorted(unresolved, key=_canonical)
    else: state.pop("unresolved_slots", None)
    return state


def hydrate_public_state(state, hints=None):
    require(state.get("history", {}).get("public") is True, "Expected public collaboration state")
    known = capture_public_hints(state)
    known.update(copy.deepcopy(hints or {}))
    result = _materialize(copy.deepcopy(state), known)
    return {"state": result, "unresolved_slots": result["unresolved_slots"]}


def apply_history(state, operations, hints=None):
    require(isinstance(state, dict) and state.get("version") == 1, "Unsupported collaboration state")
    require(isinstance(operations, list) and len(operations) <= 1000, "Send at most 1000 operations at a time")
    validated = [(operation, crdt._validate_operation(operation)) for operation in operations]
    digests = [hashlib.sha256(_canonical(operation).encode()).hexdigest() for operation, _ in validated]
    result, fresh = copy.deepcopy(state), []
    for (operation, _), digest in zip(validated, digests):
        result["max_clock"] = max(result.get("max_clock", 0), operation["clock"])
        if operation["id"] in result["seen"]:
            known = result["seen"][operation["id"]]
            require(known is True or known == digest, "Operation id was reused with different content", 409)
            continue
        result["seen"][operation["id"]] = digest
        fresh.append(operation)
    if not fresh: return result
    if "history" not in result:
        result["history"] = {"version": 1, "baseline": {"blocks": copy.deepcopy(state["blocks"])}, "ops": {}}
    public = result["history"].get("public") is True
    known = capture_public_hints(state) if public else {}
    if public:
        known.update(copy.deepcopy(hints or {}))
        _operation_hints(fresh, known)
    for operation in fresh: result["history"]["ops"][operation["id"]] = _metadata(operation) if public else copy.deepcopy(operation)
    return _materialize(result, known)
