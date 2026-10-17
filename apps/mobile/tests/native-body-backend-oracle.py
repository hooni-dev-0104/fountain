#!/usr/bin/env python3
"""Compare SDK-produced synthetic fresh operations with the actual Python CRDT.

Inputs are test-only native-body-oracles/*.json retrieved by the device owner.
This is not a transform mirror: the installed Android engine generated operations;
the repository's actual backend applies and projects them.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))
from fountain import crdt, history_crdt


def normalized(blocks):
    positions = {block["id"]: index for index, block in enumerate(blocks)}
    answer = []
    for block in blocks:
        text = block.get("text", "")
        tokens = block.get("rich_text") or ([{"text": text, "marks": {}}] if text else [])
        value = {"type": block["type"], "parent": positions.get(block.get("parent_id")), "text": text,
                 "rich_text": [{"text": token["text"], "marks": token.get("marks", {})} for token in tokens]}
        for field in ("checked", "language", "attachment_id", "size"):
            if field in block:
                value[field] = block[field]
        answer.append(value)
    return answer


if len(sys.argv) < 2:
    raise SystemExit("Pass SDK-produced synthetic oracle JSON files")
for name in sys.argv[1:]:
    fixture = json.loads(pathlib.Path(name).read_text())
    state = history_crdt.apply_history(crdt.seed_state([]), fixture["operations"])
    actual, expected = normalized(crdt.project(state)), normalized(fixture["expected"])
    if actual != expected:
        raise AssertionError(f"Backend projection differs for {fixture['label']}")
    print(f"PASS {fixture['label']}: actual backend projection matches complete readable body")
