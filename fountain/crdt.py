"""A pure, codepoint RGA and LWW block tree for Fountain collaboration.

This is an independent protocol, not recovered Notion implementation code.
Characters and blocks retain permanent deletion tombstones. Missing anchors are
projected at the root until they arrive; cycles break at the smallest identifier.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from urllib.parse import urlsplit

from .core import APIError, require, uid

MAX_CLOCK = 9007199254740991
PALETTE = {"default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"}
BOOL_MARKS = {"bold", "italic", "underline", "strike", "code"}
ALIASES = {"heading_1": "heading1", "heading_2": "heading2", "heading_3": "heading3",
           "bulleted_list_item": "bullet", "numbered_list_item": "numbered", "to_do": "todo"}
BLOCK_TYPES = {"paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "quote", "code",
               "callout", "divider", "toggle", "image", "bookmark", "file"}
FIELDS = {"type", "checked", "language", "attachment_id", "size"}


def _string(value, label, limit, nullable=False):
    if nullable and value is None: return None
    require(isinstance(value, str) and len(value) <= limit, f"Invalid {label}")
    try: value.encode("utf-8")
    except UnicodeEncodeError: raise APIError(400, f"Invalid Unicode in {label}")
    return value


def _identity(value, label="identifier", nullable=False):
    value = _string(value, label, 300, nullable)
    require(value is None and nullable or bool(value), f"Invalid {label}")
    return value


def validate_marks(marks):
    require(isinstance(marks, dict) and set(marks) <= BOOL_MARKS | {"color", "background", "link"}, "Unsupported rich text marks")
    result = {}
    for key, value in marks.items():
        if key in BOOL_MARKS:
            require(type(value) is bool, f"{key} must be boolean")
        elif key in {"color", "background"}:
            require(isinstance(value, str) and value in PALETTE, "Unsupported text color")
        else:
            if value is not None:
                _string(value, "link", 2048)
                require(value and not any(ord(c) <= 32 or c == "\\" for c in value), "Unsafe text link")
                try: parsed = urlsplit(value)
                except ValueError: raise APIError(400, "Unsafe text link")
                allowed = (parsed.scheme in {"http", "https"} and bool(parsed.hostname)
                           or parsed.scheme == "mailto" and bool(parsed.path)
                           or not parsed.scheme and not parsed.netloc and value.startswith(("/", "#")) and not value.startswith("//"))
                require(allowed, "Unsafe text link")
        result[key] = value
    return result


def _field(field, value):
    require(isinstance(field, str) and field in FIELDS, "Unsupported block field")
    if field == "type":
        require(isinstance(value, str), "Invalid block type")
        value = ALIASES.get(value, value)
        require(value in BLOCK_TYPES, "Unsupported block type")
    elif field == "checked": require(type(value) is bool, "checked must be boolean")
    elif field == "size": require(type(value) is int and 0 <= value <= MAX_CLOCK, "Invalid block size")
    elif field == "attachment_id": _string(value, "attachment id", 160, nullable=True)
    else: _string(value, "language", 100)
    return value


def normalize_blocks(blocks):
    require(isinstance(blocks, list) and len(blocks) <= 2000, "Provide at most 2000 blocks")
    result, identities = [], set()
    for block in blocks:
        require(isinstance(block, dict), "Block must be an object")
        identity = _identity(block.get("id") or uid(), "block id")
        require(len(identity) <= 160 and identity not in identities, "Invalid or duplicate block id")
        identities.add(identity)
        tokens = block.get("rich_text", [])
        require(isinstance(tokens, list) and len(tokens) <= 10000, "Invalid rich text tokens")
        rich, total = [], 0
        for token in tokens:
            require(isinstance(token, dict) and set(token) <= {"text", "marks"}, "Invalid rich text token")
            content = _string(token.get("text", ""), "rich text", 100000)
            marks = validate_marks(token.get("marks", {}))
            total += len(content)
            require(total <= 100000, "Block text is too large")
            if content:
                if rich and rich[-1]["marks"] == marks: rich[-1]["text"] += content
                else: rich.append({"text": content, "marks": marks})
        joined = "".join(token["text"] for token in rich)
        plain = _string(block.get("text", joined), "block text", 100000)
        # A legacy client replaces plain text without updating rich_text. Clear
        # old formatting in that case, after validating every supplied mark.
        if plain != joined: rich = [{"text": plain, "marks": {}}] if plain else []
        require(len(joined) <= 100000, "Block text is too large")
        item = {"id": identity, "type": _field("type", block.get("type", "paragraph")), "text": plain,
                "parent_id": _identity(block.get("parent_id"), "parent id", True), "rich_text": rich}
        for field in FIELDS - {"type"}:
            if field in block: item[field] = _field(field, copy.deepcopy(block[field]))
        result.append(item)
    return result


def _block(identity):
    return {"id": identity, "insert": None, "deleted": False, "parent_id": None, "after_id": None,
            "move": None, "fields": {}, "chars": {}}


def _char(identity):
    return {"id": identity, "after_id": None, "stamp": None, "deleted": False, "marks": {}}


def _newer(stamp, previous):
    return previous is None or tuple(stamp) > tuple(previous)


def _set(registers, field, value, stamp):
    if field not in registers or _newer(stamp, registers[field]["stamp"]):
        registers[field] = {"value": copy.deepcopy(value), "stamp": list(stamp)}


def seed_state(blocks):
    state = {"version": 1, "max_clock": 0, "blocks": {}, "seen": {}}
    previous = {}
    for item in normalize_blocks(blocks):
        identity = item["id"]
        stamp = [0, "seed", identity]
        block = _block(identity)
        block.update(insert=stamp, move=list(stamp), parent_id=item["parent_id"], after_id=previous.get(item["parent_id"]))
        previous[item["parent_id"]] = identity
        for field in FIELDS:
            if field in item: _set(block["fields"], field, item[field], stamp)
        index, anchor = 0, None
        for token in item["rich_text"]:
            for character in token["text"]:
                char_id = f"seed:{identity}:{index}"
                char = _char(char_id)
                char.update(after_id=anchor, stamp=list(stamp), text=character)
                for mark, value in token["marks"].items(): _set(char["marks"], mark, value, stamp)
                block["chars"][char_id] = char
                anchor, index = char_id, index + 1
        state["blocks"][identity] = block
    return state


def _validate_operation(operation):
    require(isinstance(operation, dict), "Operation must be an object")
    client = _string(operation.get("client"), "client", 80)
    require(re.fullmatch(r"[A-Za-z0-9_-]+", client) is not None, "Invalid operation client")
    clock = operation.get("clock")
    require(type(clock) is int and 0 < clock <= MAX_CLOCK, "Invalid operation clock")
    require(operation.get("id") == f"{client}:{clock}", "Operation id must match client and clock")
    kind = operation.get("type")
    require(isinstance(kind, str) and kind in {"block.insert", "block.set", "block.move", "block.delete", "text.insert", "text.delete", "text.format"}, "Unknown operation type")
    fields = {
        "block.insert": {"parent_id", "after_id", "block_type"}, "block.move": {"parent_id", "after_id"},
        "block.set": {"field", "value"}, "block.delete": set(), "text.insert": {"after_id", "text", "marks"},
        "text.delete": {"char_ids"}, "text.format": {"char_ids", "marks"},
    }
    require(set(operation) <= {"id", "client", "clock", "type", "block_id"} | fields[kind], "Unsupported operation fields")
    _identity(operation.get("block_id"), "block id")
    require(len(operation["block_id"]) <= 160, "Block id is too long")
    if kind in {"block.insert", "block.move"}:
        _identity(operation.get("parent_id"), "parent id", True)
        _identity(operation.get("after_id"), "block anchor", True)
    if kind == "block.insert": _field("type", operation.get("block_type", "paragraph"))
    if kind == "block.set": _field(operation.get("field"), operation.get("value"))
    if kind == "text.insert":
        _identity(operation.get("after_id"), "character anchor", True)
        _string(operation.get("text"), "insert text", 100000)
        validate_marks(operation.get("marks", {}))
    if kind in {"text.delete", "text.format"}:
        identities = operation.get("char_ids")
        require(isinstance(identities, list) and len(identities) <= 100000, "Invalid character ids")
        for identity in identities: _identity(identity, "character id")
    if kind == "text.format": validate_marks(operation.get("marks", {}))
    return [clock, client, operation["id"]]


def apply_operations(state, operations):
    require(isinstance(state, dict) and state.get("version") == 1, "Unsupported collaboration state")
    require(isinstance(operations, list) and len(operations) <= 1000, "Send at most 1000 operations at a time")
    validated = [(operation, _validate_operation(operation)) for operation in operations]
    digests = [hashlib.sha256(json.dumps(operation, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
               for operation, _ in validated]
    result = copy.deepcopy(state)
    for (operation, stamp), digest in zip(validated, digests):
        result["max_clock"] = max(result.get("max_clock", 0), operation["clock"])
        if operation["id"] in result["seen"]:
            require(result["seen"][operation["id"]] == digest, "Operation id was reused with different content", 409)
            continue
        result["seen"][operation["id"]] = digest
        block_id, kind = operation["block_id"], operation["type"]
        block = result["blocks"].setdefault(block_id, _block(block_id))
        if kind == "block.delete": block["deleted"] = True
        elif kind in {"block.insert", "block.move"}:
            if kind == "block.insert":
                if _newer(stamp, block["insert"]): block["insert"] = list(stamp)
                _set(block["fields"], "type", _field("type", operation.get("block_type", "paragraph")), stamp)
            if _newer(stamp, block["move"]):
                block.update(parent_id=operation.get("parent_id"), after_id=operation.get("after_id"), move=list(stamp))
        elif kind == "block.set": _set(block["fields"], operation["field"], _field(operation["field"], operation.get("value")), stamp)
        elif kind == "text.insert":
            anchor = operation.get("after_id")
            for index, character in enumerate(operation["text"]):
                identity = f"{operation['id']}:{index}"
                char = block["chars"].setdefault(identity, _char(identity))
                char.update(after_id=anchor, stamp=list(stamp))
                char["text"] = character
                for mark, value in operation.get("marks", {}).items(): _set(char["marks"], mark, value, stamp)
                anchor = identity
        else:
            for identity in operation["char_ids"]:
                char = block["chars"].setdefault(identity, _char(identity))
                if kind == "text.delete": char["deleted"] = True
                else:
                    for mark, value in operation.get("marks", {}).items(): _set(char["marks"], mark, value, stamp)
    return result


def _break_cycles(anchors):
    finished = set()
    for identity in sorted(anchors):
        if identity in finished: continue
        path, positions, current = [], {}, identity
        while current is not None and current not in finished:
            if current in positions:
                anchors[min(path[positions[current]:])] = None
                break
            positions[current] = len(path)
            path.append(current)
            current = anchors.get(current)
        finished.update(path)
    return anchors


def _ordered(nodes, anchors, stamp_key, pending_missing=False):
    if pending_missing:
        dependents, blocked = {}, set()
        for identity, anchor in anchors.items():
            dependents.setdefault(anchor, []).append(identity)
            if anchor is not None and anchor not in nodes: blocked.add(identity)
        stack = list(blocked)
        while stack:
            for child in dependents.get(stack.pop(), []):
                if child not in blocked:
                    blocked.add(child)
                    stack.append(child)
        nodes = {identity: node for identity, node in nodes.items() if identity not in blocked}
        anchors = {identity: anchor for identity, anchor in anchors.items() if identity in nodes}
    anchors = _break_cycles({identity: anchor if anchor in nodes and anchor != identity else None
                             for identity, anchor in anchors.items()})
    children = {None: []}
    for identity, anchor in anchors.items(): children.setdefault(anchor, []).append(identity)
    def key(identity): return (*((nodes[identity].get(stamp_key)) or [0, "", ""]), identity)
    for siblings in children.values(): siblings.sort(key=key, reverse=True)
    stack, result = list(reversed(children[None])), []
    while stack:
        identity = stack.pop()
        result.append(identity)
        stack.extend(reversed(children.get(identity, [])))
    return result


def visible_chars(state, block_id):
    block = state.get("blocks", {}).get(block_id)
    if not block or block["deleted"] or block["insert"] is None: return []
    chars = {identity: char for identity, char in block["chars"].items() if char.get("stamp") is not None}
    order = _ordered(chars, {identity: char.get("after_id") for identity, char in chars.items()}, "stamp", pending_missing=True)
    return [{"id": identity, "text": chars[identity]["text"],
             "marks": {key: register["value"] for key, register in chars[identity].get("marks", {}).items() if "value" in register}}
            for identity in order if chars[identity].get("stamp") is not None and not chars[identity]["deleted"] and "text" in chars[identity]]


def project(state):
    created = {identity: block for identity, block in state.get("blocks", {}).items() if block["insert"] is not None}
    parents = _break_cycles({identity: block["parent_id"] if block["parent_id"] in created
                             and not created[block["parent_id"]]["deleted"] and block["parent_id"] != identity else None
                             for identity, block in created.items()})
    siblings = {}
    for identity, parent in parents.items(): siblings.setdefault(parent, {})[identity] = created[identity]
    order = {}
    for parent, nodes in siblings.items():
        order[parent] = _ordered(nodes, {identity: block["after_id"] for identity, block in nodes.items()}, "move")
    stack, result = list(reversed(order.get(None, []))), []
    while stack:
        identity = stack.pop()
        block = created[identity]
        if block["deleted"]:
            stack.extend(reversed(order.get(identity, [])))
            continue
        fields = {key: copy.deepcopy(register["value"]) for key, register in block["fields"].items() if "value" in register}
        rich = []
        for char in visible_chars(state, identity):
            if rich and rich[-1]["marks"] == char["marks"]: rich[-1]["text"] += char["text"]
            else: rich.append({"text": char["text"], "marks": copy.deepcopy(char["marks"])})
        result.append({"id": identity, "type": "paragraph", **fields, "parent_id": parents[identity],
                       "text": "".join(token["text"] for token in rich), "rich_text": rich})
        stack.extend(reversed(order.get(identity, [])))
    return result


def public_state(state):
    result = copy.deepcopy(state)
    for block in result.get("blocks", {}).values():
        if block["deleted"]:
            for register in block["fields"].values(): register.pop("value", None)
        for char in block["chars"].values():
            if block["deleted"] or char["deleted"]:
                char.pop("text", None)
                char["marks"] = {}
    return result
