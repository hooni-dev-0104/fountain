"""Disposable in-memory SQLite oracle for the Edge core port; no production I/O."""
import copy
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from fountain import core, crdt, richtext, tasks

FIXED_TIME = "2026-10-16T00:00:00.123000+00:00"
counter = 0

def identity():
    global counter
    counter += 1
    return f"generated-{counter:04}"

core.uid = crdt.uid = tasks.uid = identity
core.now = lambda: FIXED_TIME

def main():
    specification = json.load(sys.stdin)
    store = core.Store(":memory:")
    workspace = core.Workspace.__new__(core.Workspace)
    workspace.store, workspace.lock = store, store.lock
    for key, value in specification.get("meta", {}).items():
        store.set_meta(key, value)
    for kind, records in specification.get("records", {}).items():
        for value in records:
            store.put(kind, value)
    actor = core.AUDIT_ACTOR.set(specification.get("actor", "alice"))
    output, references = [], {}
    def resolve(value):
        if isinstance(value, dict) and set(value) == {"$ref"}:
            path = value["$ref"].split(".")
            result = references[path.pop(0)]
            for key in path:
                result = result[int(key)] if isinstance(result, list) else result[key]
            return copy.deepcopy(result)
        if isinstance(value, list): return [resolve(item) for item in value]
        if isinstance(value, dict): return {key: resolve(item) for key, item in value.items()}
        return value
    for operation in specification["operations"]:
        try:
            args = resolve(operation.get("args", []))
            if "deny" in operation:
                args.append(lambda row: row["id"] not in operation["deny"])
            with store.transaction():
                method = operation["method"]
                if method == "normalize_blocks": result = crdt.normalize_blocks(*args)
                elif method == "inline_markdown": result = richtext.inline_markdown(*args)
                elif method == "resolve_comment":
                    comment = store.get("comment", args[0]); core.require(comment, "Comment not found", 404)
                    core.require(isinstance(args[1].get("resolved"), bool), "resolved must be boolean")
                    comment["resolved"] = args[1]["resolved"]
                    store.audit("comment.resolved", {"page_id": comment["page_id"], "id": comment["id"]})
                    result = store.put("comment", comment)
                else: result = getattr(workspace, method)(*args)
            if isinstance(result, dict) and result.get("mime") == "application/json":
                result["content"] = json.loads(result["content"])
            if operation.get("as"): references[operation["as"]] = copy.deepcopy(result)
            output.append({"ok": result})
        except core.APIError as error:
            output.append({"error": {"status": error.status, "message": error.message}})
        except Exception as error:
            output.append({"unexpected": {"type": type(error).__name__, "message": str(error)}})
    kinds = [row[0] for row in store.db.execute("SELECT DISTINCT kind FROM entities ORDER BY kind")]
    result = {"results": output, "records": {kind: store.list(kind) for kind in kinds}, "revision": store.meta("_entity_revision", 0)}
    core.AUDIT_ACTOR.reset(actor); store.close()
    json.dump(result, sys.stdout, ensure_ascii=False)

if __name__ == "__main__": main()
