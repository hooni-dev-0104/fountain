// Executes the production Swift observer and SQLite, without UIKit, Keychain,
// a simulator, network access, or an override of the user's home directory.
import Foundation
import SQLite3

@main
struct OutboxObserverFixture {
    static var checks = 0
    static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        checks += 1
        if try !condition() { throw NSError(domain: "OutboxObserverFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func encoded(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    static func value(_ file: URL, key: String) throws -> [String: Any] {
        var db: OpaquePointer?, statement: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        guard sqlite3_prepare_v2(db, "SELECT value FROM control WHERE id=?", -1, &statement, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, 1, key, -1, transient) == SQLITE_OK, sqlite3_step(statement) == SQLITE_ROW,
              let bytes = sqlite3_column_blob(statement, 0) else { throw FountainOutboxError.storage }
        return try JSONSerialization.jsonObject(with: Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))) as! [String: Any]
    }
    static func failure(_ expected: FountainOutboxError, _ operation: () throws -> Void) throws {
        do { try operation() }
        catch let error as FountainOutboxError { try require(error == expected, "Unexpected outbox error"); return }
        throw NSError(domain: "OutboxObserverFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing expected rejection"])
    }
    static func main() throws {
        let base = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let resource = FountainOutbox.canonicalResource(path: "/api/pages/page/operations", method: "POST")
        try require(resource?.0 == "page" && resource?.1 == "page", "Successful operation POST must be observed before its ACK is delivered")
        for path in ["/api/pages/page/operations?q=1", "/api/pages/page/operations#fragment", "/api/pages/%70age/operations", "/api/pages/a%2fb/operations", "/api/pages/../operations", "/api/pages/page/operations/", "/api/databases/page", "/api/workspace", "/api/pages/page/collaboration", "/api/pages/한글/operations", "x/api/pages/page/operations"] {
            try require(FountainOutbox.canonicalResource(path: path, method: "POST") == nil, "POST route must be canonical and exact")
        }
        let unicodeID = "한글🙂"
        try require(FountainOutbox.canonicalResource(path: "/api/pages/" + FountainOutbox.encodeURIComponent(unicodeID) + "/operations", method: "POST")?.1 == unicodeID, "Exactly once encoded Unicode ID accepted")
        try require(FountainOutbox.canonicalResource(path: "/api/pages/page/operations", method: "GET") == nil, "GET operations is not canonical evidence")
        for status in [201, 204, 400, 401, 403, 404, 409, 423, 500] {
            try require(FountainOutbox.observedResource(path: "/api/pages/page/operations", method: "POST", status: status) == nil, "Non-200 POST must not carry proof or read denial")
        }
        for status in [200, 403, 404] {
            try require(FountainOutbox.observedResource(path: "/api/pages/page/collaboration", method: "GET", status: status)?.1 == "page", "Existing GET statuses unchanged")
        }
        let origin = "https://ios-observer.invalid", profile = origin + "|workspace|member|binding"
        let session: [String: Any] = ["authenticated": true, "required": true, "mode": "accounts", "workspace_id": "workspace", "cache_binding": "binding", "member": ["id": "member", "active": true, "role": "owner"], "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]
        let page: [String: Any] = ["id": "page", "access_level": 3, "locked": false, "archived": false, "revision": 1]
        let workspace: [String: Any] = ["workspace_id": "workspace", "current_member_id": "member", "session_binding": "binding", "access_revision": 4, "data_revision": 7, "pages": [page], "databases": []]
        var snapshot: [String: Any] = ["workspace_id": "workspace", "current_member_id": "member", "session_binding": "binding", "access_revision": 4, "data_revision": 7, "page": page, "access_level": 3, "blocks": [], "state": [:], "epoch": "epoch", "seq": 0]
        func fixture(_ name: String) throws -> (FountainOutbox, URL) {
            let directory = base.appendingPathComponent(name, isDirectory: true)
            let store = try FountainOutbox(origin: origin, testingDirectory: directory)
            try store.grant(session, sessionRef: "private-cookie")
            try store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspace), sessionRef: "private-cookie")
            try store.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 200, data: encoded(snapshot), sessionRef: "private-cookie")
            return (store, directory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite"))
        }
        let (store, file) = try fixture("positive"); defer { store.close() }
        let oldEpoch = try store.proofEpoch(), oldHead = try store.open()["head"] as! Int
        snapshot["ack"] = ["client:1", "client:1", "other_2:9007199254740991"]; snapshot["seq"] = 1; snapshot["data_revision"] = 8
        try store.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(snapshot), sessionRef: "private-cookie")
        let proof = try value(file, key: "proofs:" + profile)["page:page"] as! [String: Any]
        try require(proof["seq"] as? Int == 1, "POST installs the new canonical sequence before JS delivery")
        try require(try store.proofEpoch() > oldEpoch, "Changed proof fences old staged transactions")
        try require(try store.open()["head"] as? Int == oldHead, "Proof observation does not mutate business head")
        let afterPost = try store.proofEpoch()
        try store.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(snapshot), sessionRef: "private-cookie")
        try require(try store.proofEpoch() == afterPost, "Repeated identical canonical POST does not extend TTL or invalidate staging")
        try store.observeResource(path: "/api/pages/page/operations", method: "POST", status: 403, data: Data(), sessionRef: "unrelated-cookie")
        try require(try store.proofEpoch() == afterPost, "Denied write does not revoke existing read proof")
        try failure(.stale) { try store.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(snapshot), sessionRef: "unrelated-cookie") }
        try require(try store.proofEpoch() == afterPost, "Unrelated cookie cannot update proof")
        var older = snapshot; older["data_revision"] = 7; older["seq"] = 0
        try failure(.stale) { try store.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(older), sessionRef: "private-cookie") }
        try require(try store.proofEpoch() == afterPost, "Late sequence/counter response cannot regress proof")
        older["data_revision"] = 9
        try failure(.stale) { try store.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(older), sessionRef: "private-cookie") }
        try require(try store.proofEpoch() == afterPost, "New global counter cannot authorize an older page sequence")
        var nextEpoch = snapshot; nextEpoch["epoch"] = "replacement"; nextEpoch["seq"] = 0; nextEpoch["data_revision"] = 9; nextEpoch["ack"] = []
        try store.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(nextEpoch), sessionRef: "private-cookie")
        let reset = try value(file, key: "proofs:" + profile)["page:page"] as! [String: Any]
        try require(reset["epoch"] as? String == "replacement" && reset["seq"] as? Int == 0, "New canonical epoch may reset its sequence with empty acknowledgement")
        let invalidACKs: [Any] = [NSNull(), true, "client:1", [1], [""], ["client:0"], ["client:01"], ["client:9007199254740992"], ["client:+1"], ["client:1.0"], ["한글:1"], [String(repeating: "a", count: 81) + ":1"], Array(repeating: "client:1", count: 1001)]
        snapshot["seq"] = 0; snapshot["data_revision"] = 7
        for (index, ack) in invalidACKs.enumerated() {
            let (invalidStore, invalidFile) = try fixture("invalid-\(index)"); defer { invalidStore.close() }
            var body = snapshot; body["ack"] = ack
            try failure(.access) { try invalidStore.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(body), sessionRef: "private-cookie") }
            let marker = try value(invalidFile, key: "proofs:" + profile)["page:page"] as! [String: Any]
            try require(marker["invalid"] as? Bool == true && marker["denied"] == nil, "Malformed ACK invalidates evidence without denial/tombstone")
            // A fresh GET can repair malformed evidence; actual denial cannot.
            try invalidStore.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 200, data: encoded(snapshot), sessionRef: "private-cookie")
        }
        for field in ["ack", "workspace_id", "current_member_id", "session_binding", "page", "access_level", "blocks", "state", "epoch", "seq"] {
            let (invalidStore, _) = try fixture("missing-" + field); defer { invalidStore.close() }
            var body = snapshot; body.removeValue(forKey: field)
            try failure(.access) { try invalidStore.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(body), sessionRef: "private-cookie") }
        }
        let (denied, _) = try fixture("terminal-denial"); defer { denied.close() }
        try denied.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 404, data: Data(), sessionRef: "private-cookie")
        snapshot["ack"] = []
        try failure(.access) { try denied.observeResource(path: "/api/pages/page/operations", method: "POST", status: 200, data: encoded(snapshot), sessionRef: "private-cookie") }
        print("iOS production Swift observer: \(checks) checks PASS (macOS SQLite; no native bridge or iOS file-protection claim)")
    }
}
