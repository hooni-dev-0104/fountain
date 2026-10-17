// Executes the production Swift observer and SQLite, without UIKit, Keychain,
// a simulator, network access, or an override of the user's home directory.
import Foundation
import SQLite3

#if os(iOS)
@testable import App
#endif
#if os(macOS)
@main
#endif
struct OutboxObserverFixture {
    static var checks = 0
    static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        checks += 1
        if try !condition() { throw NSError(domain: "OutboxObserverFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func encoded(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
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
    static func stored(_ file: URL, query: String, key: String) throws -> Data? {
        var db: OpaquePointer?, statement: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        guard sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        sqlite3_bind_text(statement, 1, key, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW, let bytes = sqlite3_column_blob(statement, 0) else { throw FountainOutboxError.storage }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))
    }
    static func expireNativeGrantFixture(_ file: URL) throws {
        // Fault-inject elapsed time only, after a genuine native grant/commit.
        // Never seed actor, ownership, receipt, or permission qualification.
        var expired = try value(file, key: "identity"); expired["validUntil"] = 0
        var db: OpaquePointer?, statement: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        guard sqlite3_prepare_v2(db, "UPDATE control SET value=? WHERE id='identity'", -1, &statement, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        let bytes = try encoded(expired); _ = bytes.withUnsafeBytes { sqlite3_bind_blob(statement, 1, $0.baseAddress, Int32(bytes.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw FountainOutboxError.storage }
    }
    static func main() {
        do { try run(directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)) }
        catch { print("iOS observer failed after \(checks) checks: \((error as? FountainOutboxError)?.code ?? error.localizedDescription)"); exit(1) }
    }
    static func run(directory base: URL) throws {
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
        let (reconciled, reconciledFile) = try fixture("reconciliation"); defer { reconciled.close() }
        try reconciled.ensureOwner("native-owner", epoch: 2)
        let opened = try reconciled.open(), reconcileLease = opened["lease"] as! String
        let begin: [String: Any] = ["generation": 1, "phase": "prepare", "lease": reconcileLease, "baseHead": opened["head"]!, "proofEpoch": opened["proofEpoch"]!, "mode": "current"]
        var state = try reconciled.reconcile(begin, admissionWatermark: 10, sessionRef: "private-cookie")
        let planId = state["planId"] as! String
        try require(state["state"] as? String == "collecting", "Initial reconciliation collects workspace before native hydration")
        try require(try reconciled.admitReconcile(path: "/api/workspace", method: "GET", sessionRef: "private-cookie", sequence: 10) == nil, "Pre-prepare native admission cannot fill a plan")
        var sequence = 10, collects = 0
        while state["state"] as? String == "collecting" {
            collects += 1; try require(collects <= 6, "Two stable sweeps terminate")
            for descriptor in state["needed"] as! [[String: String]] {
                let path = descriptor["kind"] == "workspace" ? "/api/workspace" : "/api/pages/" + descriptor["id"]! + "/collaboration"
                var body = descriptor["kind"] == "workspace" ? workspace : snapshot
                // First workspace predates lazy collaboration initialization.
                body["data_revision"] = (collects == 1 ? 7 : 8)
                sequence += 1
                let tag = try reconciled.admitReconcile(path: path, method: "GET", sessionRef: "private-cookie", sequence: sequence)
                try require(tag != nil, "Only native expected admission receives a collection token")
                try reconciled.observeReconcileResource(admission: tag, path: path, method: "GET", status: 200, data: encoded(body), sessionRef: "private-cookie")
            }
            state = try reconciled.reconcile(["generation": 1, "phase": "prepare", "lease": reconcileLease, "planId": planId], admissionWatermark: sequence, sessionRef: "private-cookie")
        }
        try require(state["state"] as? String == "ready", "Actual native captures produce ready baseline")
        try require(state["requiresConfirmation"] as? Bool == false, "Compatible current reconciliation can commit without adoption confirmation")
        let counts = state["counts"] as! [String: Int]
        try require(counts["refresh"] == 4, "Fresh baseline counts profile, both pointers and page snapshot")
        let commitInput: [String: Any] = ["generation": 1, "phase": "commit", "lease": reconcileLease, "baseHead": state["baseHead"]!, "proofEpoch": state["proofEpoch"]!, "planId": planId, "checksum": state["checksum"]!, "confirm": false]
        let receipt = try reconciled.reconcile(commitInput, admissionWatermark: sequence, sessionRef: "private-cookie")
        try require(receipt["state"] as? String == "committed", "Single SQLite transaction installs authorized baseline")
        try require(try reconciled.open()["resourceAccess"] as? String == "ready", "Installed profile passes complete native hydration preflight")
        try require(try value(reconciledFile, key: "reconcileReceipt:" + planId)["result"] != nil, "Typed immutable receipt persists separately from delta receipts")
        let retry = try reconciled.reconcile(commitInput, admissionWatermark: sequence, sessionRef: "private-cookie")
        try require(try encoded(receipt) == encoded(retry), "Lost callback retry returns exact receipt without a second transformation")
        _ = try reconciled.reconcile(["generation": 1, "phase": "cancel", "planId": planId], admissionWatermark: sequence, sessionRef: "private-cookie")
        try require(try encoded(receipt) == encoded(reconciled.reconcile(commitInput, admissionWatermark: sequence, sessionRef: "private-cookie")), "Cancel never rolls back an accepted reconciliation receipt")
        let beforeStage = try reconciled.open()
        let stagedPlan = try reconciled.reconcile(["generation": 1, "phase": "prepare", "lease": reconcileLease, "baseHead": beforeStage["head"]!, "proofEpoch": beforeStage["proofEpoch"]!, "mode": "current"], admissionWatermark: sequence, sessionRef: "private-cookie")
        let untouchedIntent = try encoded(["version": 1, "origin": origin, "mode": "quarantine", "changes": []])
        try reconciled.stage(lease: reconcileLease, txID: "cas-staged", baseHead: beforeStage["head"] as! Int, proofEpoch: beforeStage["proofEpoch"] as! Int, part: 0, bytes: untouchedIntent)
        try failure(.stale) { _ = try reconciled.reconcile(["generation": 1, "phase": "prepare", "lease": reconcileLease, "planId": stagedPlan["planId"]!], admissionWatermark: sequence, sessionRef: "private-cookie") }
        try require(try stored(reconciledFile, query: "SELECT data FROM staging WHERE tx_id=? AND part=0", key: "cas-staged") == untouchedIntent, "Source CAS rejects uncommitted staging without losing its bytes")
        let unsettled: [String: Any] = ["txId": "cas-staged", "digest": FountainOutbox.hash(untouchedIntent), "baseHead": beforeStage["head"]!, "proofEpoch": beforeStage["proofEpoch"]!]
        let settlement = try reconciled.reconcile(["generation": 1, "phase": "settle", "lease": reconcileLease, "journals": [unsettled]], admissionWatermark: sequence, sessionRef: "private-cookie")
        try require((settlement["settlements"] as! [[String: Any]])[0]["status"] as? String == "unaccepted", "Unaccepted intent is privately fenced before reply")
        try failure(.conflict) { _ = try reconciled.commit(lease: reconcileLease, txID: "cas-staged", baseHead: beforeStage["head"] as! Int, proofEpoch: beforeStage["proofEpoch"] as! Int, digest: FountainOutbox.hash(untouchedIntent)) }
        try require(try stored(reconciledFile, query: "SELECT data FROM staging WHERE tx_id=? AND part=0", key: "cas-staged") == untouchedIntent, "Late COMMIT after settlement cannot apply or delete staged input")
        let savedID = "native-write", resourceKey = profile + "|page"
        let pendingRecord: [String: Any] = ["profileId": profile, "id": savedID, "resourceKey": resourceKey, "operation": ["id": savedID, "kind": "page.patch", "target_id": "page", "body": ["title": "확정할 제목🙂"], "base": ["fields": [:]], "depends_on": []], "status": "pending", "sequence": 1, "createdAt": 1, "updatedAt": 1]
        let pendingBytes = try encoded(["version": 1, "origin": origin, "mode": "active", "changes": [["op": "put", "bucket": "mutations", "key": [profile, savedID], "value": pendingRecord]]])
        try reconciled.stage(lease: reconcileLease, txID: "accepted-write", baseHead: beforeStage["head"] as! Int, proofEpoch: beforeStage["proofEpoch"] as! Int, part: 0, bytes: pendingBytes)
        let accepted = try reconciled.commit(lease: reconcileLease, txID: "accepted-write", baseHead: beforeStage["head"] as! Int, proofEpoch: beforeStage["proofEpoch"] as! Int, digest: FountainOutbox.hash(pendingBytes))
        let authorityKey = "recordAuthority:mutations|" + String(data: try encoded([profile, savedID]), encoding: .utf8)!
        try require(try value(reconciledFile, key: authorityKey)["trust"] as? String == "confirmed", "Only real native active COMMIT attributes confirmed source history")
        var changedProof = snapshot; changedProof["seq"] = 1; changedProof["data_revision"] = 9
        try reconciled.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 200, data: encoded(changedProof), sessionRef: "private-cookie")
        try require(try reconciled.open()["resourceAccess"] as? String == "required", "New observation can require a fresh baseline")
        let acceptedSettlement = try reconciled.reconcile(["generation": 1, "phase": "settle", "lease": reconcileLease, "journals": [["txId": "accepted-write", "digest": FountainOutbox.hash(pendingBytes), "baseHead": beforeStage["head"]!, "proofEpoch": beforeStage["proofEpoch"]!]]], admissionWatermark: sequence, sessionRef: "private-cookie")
        let settledReceipt = (acceptedSettlement["settlements"] as! [[String: Any]])[0]
        try require(settledReceipt["status"] as? String == "accepted" && settledReceipt["head"] as? Int == accepted["head"] as? Int && settledReceipt["proofEpoch"] as? Int == beforeStage["proofEpoch"] as? Int, "Lost accepted ACK settles original proof despite required resource refresh")
        let roleStore = try FountainOutbox(origin: origin, testingDirectory: base.appendingPathComponent("role-change", isDirectory: true)); defer { roleStore.close() }
        let roleFile = base.appendingPathComponent("role-change").appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
        try roleStore.grant(session, sessionRef: "private-role-cookie"); try roleStore.ensureOwner("role-owner", epoch: 1)
        var ownerPage = page; ownerPage["access_level"] = 4; ownerPage["owner_id"] = "different-actor"; ownerPage["title"] = "Private owner-only cache"
        var ownerWorkspace = workspace; ownerWorkspace["pages"] = [ownerPage]
        var ownerSnapshot = snapshot; ownerSnapshot["page"] = ownerPage; ownerSnapshot["access_level"] = 4; ownerSnapshot.removeValue(forKey: "ack")
        let roleInitial = try roleStore.open()
        var roleLease = roleInitial["lease"] as! String
        var rolePlan = try roleStore.reconcile(["generation": 1, "phase": "prepare", "lease": roleLease, "baseHead": roleInitial["head"]!, "proofEpoch": roleInitial["proofEpoch"]!, "mode": "current"], admissionWatermark: 0, sessionRef: "private-role-cookie")
        var roleSequence = 0
        while rolePlan["state"] as? String == "collecting" {
            for descriptor in rolePlan["needed"] as! [[String: String]] {
                let isWorkspace = descriptor["kind"] == "workspace", path = isWorkspace ? "/api/workspace" : "/api/pages/page/collaboration"
                roleSequence += 1; let tag = try roleStore.admitReconcile(path: path, method: "GET", sessionRef: "private-role-cookie", sequence: roleSequence)
                try roleStore.observeReconcileResource(admission: tag, path: path, method: "GET", status: 200, data: encoded(isWorkspace ? ownerWorkspace : ownerSnapshot), sessionRef: "private-role-cookie")
            }
            rolePlan = try roleStore.reconcile(["generation": 1, "phase": "prepare", "lease": roleLease, "planId": rolePlan["planId"]!], admissionWatermark: roleSequence, sessionRef: "private-role-cookie")
        }
        _ = try roleStore.reconcile(["generation": 1, "phase": "commit", "lease": roleLease, "baseHead": rolePlan["baseHead"]!, "proofEpoch": rolePlan["proofEpoch"]!, "planId": rolePlan["planId"]!, "checksum": rolePlan["checksum"]!, "confirm": false], admissionWatermark: roleSequence, sessionRef: "private-role-cookie")
        let roleReady = try roleStore.open()
        let ownerRead = try roleStore.read(lease: roleLease, head: roleReady["head"] as! Int, proofEpoch: roleReady["proofEpoch"] as! Int, cursor: nil, byteLimit: 1024)
        try require((ownerRead["fragments"] as? [[String: Any]])?.isEmpty == false, "Owner can read its actual authorized canonical cache before role change")
        let draftValue: [String: Any] = ["key": resourceKey, "profileId": profile, "clientId": "role-draft", "draft": ["epoch": "epoch", "reason": "pending", "ops": [], "blocks": [["id": "pending", "type": "paragraph", "text": "Role-change unsent input🙂"]]]]
        let draftDelta = try encoded(["version": 1, "origin": origin, "mode": "active", "changes": [["op": "put", "bucket": "drafts", "key": [resourceKey, "role-draft"], "value": draftValue]]])
        try roleStore.stage(lease: roleLease, txID: "role-input", baseHead: roleReady["head"] as! Int, proofEpoch: roleReady["proofEpoch"] as! Int, part: 0, bytes: draftDelta)
        _ = try roleStore.commit(lease: roleLease, txID: "role-input", baseHead: roleReady["head"] as! Int, proofEpoch: roleReady["proofEpoch"] as! Int, digest: FountainOutbox.hash(draftDelta))
        var extendedOwner = session; extendedOwner["expires_at"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(7200))
        let beforeNoop = try Data(contentsOf: roleFile), noOpBoundary = roleStore.boundary
        try roleStore.grant(extendedOwner, sessionRef: "private-role-cookie")
        try require(try Data(contentsOf: roleFile) == beforeNoop && roleStore.boundary == noOpBoundary, "Expiry-only extension preserves exact SQLite source and proof boundary")
        var memberSession = extendedOwner, member = session["member"] as! [String: Any]; member["role"] = "member"; memberSession["member"] = member
        let beforeRole = try roleStore.open()
        let oldHTTP = try roleStore.admitHTTP(path: "/api/pages/page/collaboration", sessionRef: "private-role-cookie")!
        let oldHTTPFence = try roleStore.captureHTTPFence(oldHTTP, path: "/api/pages/page/collaboration", method: "GET", status: 200)
        let oldRoleOperation: [String: Any] = ["id": "old-role-write", "kind": "page.patch", "target_id": "page", "body": ["title": "Old owner response"], "depends_on": []]
        let oldRoleSync = try roleStore.admitSync(path: "/api/sync", method: "POST", body: encoded(["workspace_id": "workspace", "session_binding": "binding", "operations": [oldRoleOperation]]), sessionRef: "private-role-cookie")
        try roleStore.grant(memberSession, sessionRef: "private-role-cookie")
        let afterRole = try roleStore.open()
        try failure(.stale) { try roleStore.checkHTTPAdmission(oldHTTP, sessionRef: "private-role-cookie") }
        try require(!roleStore.canDeliverHTTP(oldHTTPFence), "Final WebView HTTP fence rejects a pre-role payload after same-cookie downgrade")
        try failure(.access) { try roleStore.observeSync(oldRoleSync, status: 200, data: encoded(["workspace_id": "workspace", "current_member_id": "member", "session_binding": "binding", "data_revision": 8, "results": [["id": "old-role-write", "status": "applied", "http_status": 200, "resource_id": "page", "data_revision": 8]]]), sessionRef: "private-role-cookie") }
        let postRoleSession = try roleStore.captureHTTPDelivery(sessionRef: "private-role-cookie")!
        try require(roleStore.canDeliverHTTP(postRoleSession), "Actual session delivery can capture its new post-grant lease")
        let beforeRoleLease = roleLease; roleLease = afterRole["lease"] as! String
        try require(beforeRoleLease != roleLease, "Meaningful same-cookie role change rotates the native lease")
        try require(afterRole["head"] as? Int == beforeRole["head"] as? Int && (afterRole["proofEpoch"] as! Int) > (beforeRole["proofEpoch"] as! Int), "Role change invalidates evidence without mutating data head")
        try require(afterRole["resourceAccess"] as? String == "required" && roleStore.boundary != noOpBoundary, "Same-cookie lower role cannot hydrate owner-only cache")
        try failure(.access) { _ = try roleStore.read(lease: roleLease, head: afterRole["head"] as! Int, proofEpoch: afterRole["proofEpoch"] as! Int, cursor: nil, byteLimit: 1024) }
        let draftKey = String(data: try encoded([resourceKey, "role-draft"]), encoding: .utf8)!
        try require(try stored(roleFile, query: "SELECT value FROM records WHERE bucket='drafts' AND key=?", key: draftKey) == encoded(draftValue), "Role change preserves exact unsent input bytes")
        var memberWorkspace = ownerWorkspace; memberWorkspace["pages"] = []; memberWorkspace["access_revision"] = 5; memberWorkspace["data_revision"] = 8
        try roleStore.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(memberWorkspace), sessionRef: "private-role-cookie")
        try roleStore.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 404, data: Data(), sessionRef: "private-role-cookie")
        try require(try stored(roleFile, query: "SELECT value FROM recovery WHERE bucket='drafts' AND profile_id=?", key: profile) == encoded(draftValue), "Fresh lower-role denial preserves original input in native archive")
        var inactive = memberSession, inactiveMember = member; inactiveMember["active"] = false; inactive["member"] = inactiveMember
        try failure(.blocked) { try roleStore.grant(inactive, sessionRef: "private-role-cookie") }
        try require(!roleStore.canDeliverHTTP(postRoleSession), "A subsequent same-cookie role change fences the older session DTO at final delivery")
        try require(try roleStore.open()["identityState"] as? String == "blocked", "Inactive native session cannot authorize cache reads")
        try require(try stored(roleFile, query: "SELECT value FROM control WHERE id=?", key: "suspended:" + profile) == nil, "Permission transition is not a permanent binding suspension")
        try roleStore.grant(memberSession, sessionRef: "private-role-cookie")
        roleLease = try roleStore.open()["lease"] as! String
        try require(try roleStore.open()["identityState"] as? String == "verified" && roleStore.open()["resourceAccess"] as? String == "required", "Fresh same-cookie reactivation still requires current canonical authority")
        // First-fragment stale-head admission is opaque storage, never active
        // authority. Both modes must be settleable after the final CAS rejects.
        for mode in ["active", "quarantine"] {
            let prior = try roleStore.open(), originalHead = prior["head"] as! Int, originalProof = prior["proofEpoch"] as! Int
            let input: [String: Any] = ["op": "put", "bucket": "drafts", "key": [resourceKey, "head-race-" + mode], "value": ["key": resourceKey, "profileId": profile, "clientId": "head-race-" + mode, "draft": ["reason": "pending", "blocks": [["id": "race", "type": "paragraph", "text": "First-stage race original🙂"]]]]]
            let original = try encoded(["version": 1, "origin": origin, "mode": mode, "changes": [input]])
            let bump = try encoded(["version": 1, "origin": origin, "mode": "quarantine", "changes": [input]])
            let bumpID = "head-bump-" + mode
            try roleStore.stage(lease: roleLease, txID: bumpID, baseHead: originalHead, proofEpoch: originalProof, part: 0, bytes: bump)
            _ = try roleStore.commit(lease: roleLease, txID: bumpID, baseHead: originalHead, proofEpoch: originalProof, digest: FountainOutbox.hash(bump))
            let staleID = "first-stage-stale-" + mode
            try roleStore.stage(lease: roleLease, txID: staleID, baseHead: originalHead, proofEpoch: originalProof, part: 0, bytes: original)
            try failure(.head) { _ = try roleStore.commit(lease: roleLease, txID: staleID, baseHead: originalHead, proofEpoch: originalProof, digest: FountainOutbox.hash(original)) }
            let settled = try roleStore.reconcile(["generation": 1, "phase": "settle", "lease": roleLease, "journals": [["txId": staleID, "digest": FountainOutbox.hash(original), "baseHead": originalHead, "proofEpoch": originalProof]]], admissionWatermark: 0, sessionRef: "private-role-cookie")
            try require((settled["settlements"] as! [[String: Any]])[0]["status"] as? String == "unaccepted", "First stale fragment has private current-actor attribution for " + mode)
            try failure(.conflict) { _ = try roleStore.commit(lease: roleLease, txID: staleID, baseHead: originalHead, proofEpoch: originalProof, digest: FountainOutbox.hash(original)) }
            try require(try stored(roleFile, query: "SELECT data FROM staging WHERE tx_id=? AND part=0", key: staleID) == original, "First-stage race keeps exact opaque staged bytes for " + mode)
            let current = try roleStore.open(), retryID = "fresh-quarantine-" + mode
            try roleStore.stage(lease: roleLease, txID: retryID, baseHead: current["head"] as! Int, proofEpoch: current["proofEpoch"] as! Int, part: 0, bytes: bump)
            let retry = try roleStore.commit(lease: roleLease, txID: retryID, baseHead: current["head"] as! Int, proofEpoch: current["proofEpoch"] as! Int, digest: FountainOutbox.hash(bump), quarantineOnly: true)
            try require(try stored(roleFile, query: "SELECT value FROM recovery WHERE tx_id=?", key: retryID) == encoded(input), "Fresh verified quarantine preserves original put bytes for " + mode)
            let accepted = try roleStore.reconcile(["generation": 1, "phase": "settle", "lease": roleLease, "journals": [["txId": retryID, "digest": FountainOutbox.hash(bump), "baseHead": current["head"]!, "proofEpoch": current["proofEpoch"]!]]], admissionWatermark: 0, sessionRef: "private-role-cookie")
            try require((accepted["settlements"] as! [[String: Any]])[0]["head"] as? Int == retry["head"] as? Int, "Verified quarantine receipt settles after a head race for " + mode)
        }
        let restartDirectory = base.appendingPathComponent("receipt-restart", isDirectory: true)
        let oldOwnerStore = try FountainOutbox(origin: origin, testingDirectory: restartDirectory)
        try oldOwnerStore.grant(session, sessionRef: "private-restart-cookie"); try oldOwnerStore.ensureOwner("receipt-old-owner", epoch: 1)
        var emptyWorkspace = workspace; emptyWorkspace["pages"] = []; emptyWorkspace["databases"] = []
        let oldOpen = try oldOwnerStore.open(), oldLease = oldOpen["lease"] as! String
        var oldReady = try oldOwnerStore.reconcile(["generation": 1, "phase": "prepare", "lease": oldLease, "baseHead": oldOpen["head"]!, "proofEpoch": oldOpen["proofEpoch"]!, "mode": "current"], admissionWatermark: 0, sessionRef: "private-restart-cookie")
        let admitted = try oldOwnerStore.admitReconcile(path: "/api/workspace", method: "GET", sessionRef: "private-restart-cookie", sequence: 1)
        try oldOwnerStore.observeReconcileResource(admission: admitted, path: "/api/workspace", method: "GET", status: 200, data: encoded(emptyWorkspace), sessionRef: "private-restart-cookie")
        oldReady = try oldOwnerStore.reconcile(["generation": 1, "phase": "prepare", "lease": oldLease, "planId": oldReady["planId"]!], admissionWatermark: 1, sessionRef: "private-restart-cookie")
        let acceptedRequest: [String: Any] = ["generation": 1, "phase": "commit", "lease": oldLease, "baseHead": oldReady["baseHead"]!, "proofEpoch": oldReady["proofEpoch"]!, "planId": oldReady["planId"]!, "checksum": oldReady["checksum"]!, "confirm": false]
        let committedBeforeRestart = try oldOwnerStore.reconcile(acceptedRequest, admissionWatermark: 1, sessionRef: "private-restart-cookie")
        oldOwnerStore.close()
        let newOwnerStore = try FountainOutbox(origin: origin, testingDirectory: restartDirectory); defer { newOwnerStore.close() }
        try newOwnerStore.grant(session, sessionRef: "private-restart-cookie"); try newOwnerStore.ensureOwner("receipt-new-owner", epoch: 2)
        let restartedOpen = try newOwnerStore.open(), newLease = restartedOpen["lease"] as! String
        try require(oldLease != newLease, "Actual engine restart creates a fresh native owner lease")
        let reconciliationCaps: [String: Any] = ["planId": oldReady["planId"]!, "checksum": oldReady["checksum"]!, "lease": oldLease, "baseHead": oldReady["baseHead"]!, "proofEpoch": oldReady["proofEpoch"]!]
        let metadata = try newOwnerStore.reconcile(["generation": 2, "phase": "settle", "lease": newLease, "journals": [], "reconciliations": [reconciliationCaps]], admissionWatermark: 0, sessionRef: "private-restart-cookie")
        let recoveredReceipt = (metadata["reconciliations"] as! [[String: Any]])[0]
        try require(recoveredReceipt["status"] as? String == "accepted" && recoveredReceipt["head"] as? Int == committedBeforeRestart["head"] as? Int && recoveredReceipt["proofEpoch"] as? Int == committedBeforeRestart["proofEpoch"] as? Int, "Lost reconcile ACK recovers immutable original metadata after native restart")
        try require(try encoded(recoveredReceipt["receipt"]!) == encoded(committedBeforeRestart["receipt"]!), "Restart settlement returns the original immutable typed receipt")
        try failure(.stale) { _ = try newOwnerStore.reconcile(acceptedRequest, admissionWatermark: 0, sessionRef: "private-restart-cookie") }
        let current = try newOwnerStore.open()
        var unknownReady = try newOwnerStore.reconcile(["generation": 2, "phase": "prepare", "lease": newLease, "baseHead": current["head"]!, "proofEpoch": current["proofEpoch"]!, "mode": "current"], admissionWatermark: 0, sessionRef: "private-restart-cookie")
        let nextTag = try newOwnerStore.admitReconcile(path: "/api/workspace", method: "GET", sessionRef: "private-restart-cookie", sequence: 1)
        try newOwnerStore.observeReconcileResource(admission: nextTag, path: "/api/workspace", method: "GET", status: 200, data: encoded(emptyWorkspace), sessionRef: "private-restart-cookie")
        unknownReady = try newOwnerStore.reconcile(["generation": 2, "phase": "prepare", "lease": newLease, "planId": unknownReady["planId"]!], admissionWatermark: 1, sessionRef: "private-restart-cookie")
        let unacceptedCaps: [String: Any] = ["planId": unknownReady["planId"]!, "checksum": unknownReady["checksum"]!, "lease": newLease, "baseHead": unknownReady["baseHead"]!, "proofEpoch": unknownReady["proofEpoch"]!]
        let closed = try newOwnerStore.reconcile(["generation": 2, "phase": "settle", "lease": newLease, "journals": [], "reconciliations": [unacceptedCaps]], admissionWatermark: 1, sessionRef: "private-restart-cookie")
        try require((closed["reconciliations"] as! [[String: Any]])[0]["status"] as? String == "unaccepted", "Known ready but unaccepted plan is privately fenced before answer")
        try failure(.stale) { _ = try newOwnerStore.reconcile(["generation": 2, "phase": "commit", "lease": newLease, "baseHead": unknownReady["baseHead"]!, "proofEpoch": unknownReady["proofEpoch"]!, "planId": unknownReady["planId"]!, "checksum": unknownReady["checksum"]!, "confirm": false], admissionWatermark: 1, sessionRef: "private-restart-cookie") }
        try require(try newOwnerStore.open()["head"] as? Int == committedBeforeRestart["head"] as? Int, "Unaccepted reconcile settlement never installs or rolls back canonical data")
        let syncBefore = try newOwnerStore.open(), syncHead = syncBefore["head"] as! Int, syncProof = syncBefore["proofEpoch"] as! Int
        let operation: [String: Any] = ["id": "private-create", "kind": "page.create", "target_id": "private-created-page", "document_epoch": "private-created-epoch", "body": ["id": "private-created-page", "title": "Receipt proof only"], "depends_on": []]
        let syncRequest = try encoded(["workspace_id": "workspace", "session_binding": "binding", "operations": [operation, operation]])
        try require(try newOwnerStore.admitSync(path: "/api/sync?query=1", method: "POST", body: syncRequest, sessionRef: "private-restart-cookie") == nil, "Sync proof requires the exact canonical POST path")
        try failure(.access) { _ = try newOwnerStore.admitSync(path: "/api/sync", method: "POST", body: syncRequest, sessionRef: "foreign-cookie") }
        let syncAdmission = try newOwnerStore.admitSync(path: "/api/sync", method: "POST", body: syncRequest, sessionRef: "private-restart-cookie")
        let appliedResult: [String: Any] = ["id": "private-create", "status": "applied", "http_status": 201, "resource_id": "private-created-page", "data_revision": 8, "revision": 1]
        let syncReply = try encoded(["workspace_id": "workspace", "current_member_id": "member", "session_binding": "binding", "data_revision": 8, "results": [appliedResult, appliedResult]])
        let syncLedgerBefore = try stored(restartDirectory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite"), query: "SELECT value FROM control WHERE id=?", key: "proofs:" + profile)
        try newOwnerStore.observeSync(syncAdmission, status: 200, data: syncReply, sessionRef: "private-restart-cookie")
        let restartFile = restartDirectory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite"), markerKey = "syncReceipt:" + profile + ":private-create"
        let markerBytes = try stored(restartFile, query: "SELECT value FROM control WHERE id=?", key: markerKey)
        try require(markerBytes != nil, "Actual private duplicate-ID sync reply installs one exact native receipt")
        try newOwnerStore.observeSync(syncAdmission, status: 200, data: syncReply, sessionRef: "private-restart-cookie")
        try require(try stored(restartFile, query: "SELECT value FROM control WHERE id=?", key: markerKey) == markerBytes, "Exact sync receipt replay remains byte stable")
        try require(try newOwnerStore.open()["head"] as? Int == syncHead && newOwnerStore.proofEpoch() == syncProof + 1 && stored(restartFile, query: "SELECT value FROM control WHERE id=?", key: "proofs:" + profile) == syncLedgerBefore && stored(restartFile, query: "SELECT value FROM control WHERE id=?", key: "serverObserved:workspace|private-created-page") == Data("true".utf8), "Applied sync adds exactly one permanent negative-observation fence without changing positive proofs or input head")
        for status in [403, 404, 409, 500] { try newOwnerStore.observeSync(syncAdmission, status: status, data: Data("invalid".utf8), sessionRef: "foreign-cookie") }
        try require(try stored(restartFile, query: "SELECT value FROM control WHERE id=?", key: markerKey) == markerBytes, "Non200 sync never tombstones reads or changes a receipt")
        var different = operation; different["body"] = ["id": "private-created-page", "title": "Changed identity body"]
        let conflictingAdmission = try newOwnerStore.admitSync(path: "/api/sync", method: "POST", body: encoded(["workspace_id": "workspace", "session_binding": "binding", "operations": [different, different]]), sessionRef: "private-restart-cookie")
        try failure(.conflict) { try newOwnerStore.observeSync(conflictingAdmission, status: 200, data: syncReply, sessionRef: "private-restart-cookie") }
        try require(try stored(restartFile, query: "SELECT value FROM control WHERE id=?", key: markerKey) == markerBytes, "Conflicting same-ID receipt cannot overwrite native operation digest")
        let beforeLate = try newOwnerStore.open()
        var receiptPlan = try newOwnerStore.reconcile(["generation": 2, "phase": "prepare", "lease": newLease, "baseHead": beforeLate["head"]!, "proofEpoch": beforeLate["proofEpoch"]!, "mode": "current"], admissionWatermark: 0, sessionRef: "private-restart-cookie")
        let receiptTag = try newOwnerStore.admitReconcile(path: "/api/workspace", method: "GET", sessionRef: "private-restart-cookie", sequence: 1)
        try newOwnerStore.observeReconcileResource(admission: receiptTag, path: "/api/workspace", method: "GET", status: 200, data: encoded(emptyWorkspace), sessionRef: "private-restart-cookie")
        receiptPlan = try newOwnerStore.reconcile(["generation": 2, "phase": "prepare", "lease": newLease, "planId": receiptPlan["planId"]!], admissionWatermark: 1, sessionRef: "private-restart-cookie")
        var lateOperation = operation; lateOperation["id"] = "late-private-receipt"
        let lateAdmission = try newOwnerStore.admitSync(path: "/api/sync", method: "POST", body: encoded(["workspace_id": "workspace", "session_binding": "binding", "operations": [lateOperation]]), sessionRef: "private-restart-cookie")
        var lateResult = appliedResult; lateResult["id"] = "late-private-receipt"
        try newOwnerStore.observeSync(lateAdmission, status: 200, data: encoded(["workspace_id": "workspace", "current_member_id": "member", "session_binding": "binding", "data_revision": 8, "results": [lateResult]]), sessionRef: "private-restart-cookie")
        try failure(.stale) { _ = try newOwnerStore.reconcile(["generation": 2, "phase": "commit", "lease": newLease, "baseHead": receiptPlan["baseHead"]!, "proofEpoch": receiptPlan["proofEpoch"]!, "planId": receiptPlan["planId"]!, "checksum": receiptPlan["checksum"]!, "confirm": false], admissionWatermark: 1, sessionRef: "private-restart-cookie") }
        try require(try newOwnerStore.open()["head"] as? Int == syncHead, "Late sync receipt CAS rejects stale plan without replacing active data")
        let actualAuthority = try FountainRecovery.Authority.session(encoded(session), origin: origin, reference: "private-restart-cookie")
        let stableReader = try FountainRecovery(authority: actualAuthority, testingDirectory: restartDirectory)
        _ = try stableReader.inventory(actualAuthority, cursor: nil, count: 100)
        var readerClosures = 0
        try newOwnerStore.grant(session, sessionRef: "private-restart-cookie", beforeMutation: { readerClosures += 1; stableReader.close() })
        try require(readerClosures == 0 && stableReader.validContext(actualAuthority), "Stable live session does not close or rewrite a read-only Recovery inventory")
        stableReader.close()
        let beforeExpiry = try newOwnerStore.open(), expiredAdmission = try newOwnerStore.admitHTTP(path: "/api/workspace", sessionRef: "private-restart-cookie")!
        try expireNativeGrantFixture(restartFile)
        let expiryReader = try FountainRecovery(authority: actualAuthority, testingDirectory: restartDirectory)
        _ = try expiryReader.inventory(actualAuthority, cursor: nil, count: 100)
        let handoffStart = Date()
        try newOwnerStore.validateSession("private-restart-cookie", eligible: true, beforeMutation: { readerClosures += 1; expiryReader.close() })
        try require(Date().timeIntervalSince(handoffStart) < 4, "Native expiry writer does not wait on its own read-only SQLite inventory")
        let expiredOpen = try newOwnerStore.open()
        try require(expiredOpen["identityState"] as? String == "blocked" && (expiredOpen["proofEpoch"] as! Int) > (beforeExpiry["proofEpoch"] as! Int), "Elapsed native TTL blocks reads and clears old private proof")
        try require(try stored(restartFile, query: "SELECT value FROM control WHERE id=?", key: "suspended:" + profile) == nil && expiredOpen["head"] as? Int == beforeExpiry["head"] as? Int, "Cache TTL expiry preserves source and does not create permanent binding suspension")
        try require(!newOwnerStore.canDeliverHTTP(expiredAdmission), "Expired authority cannot deliver a queued pre-expiry business response")
        var freshSession = session; freshSession["expires_at"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(172800))
        try newOwnerStore.grant(freshSession, sessionRef: "private-restart-cookie")
        let renewed = try newOwnerStore.open(), renewedLease = renewed["lease"] as! String
        try require(renewed["identityState"] as? String == "verified" && renewed["resourceAccess"] as? String == "required", "Actual fresh same-cookie session renews cache grant while requiring canonical permission refresh")
        try require(renewedLease != beforeExpiry["lease"] as? String && (renewed["validUntil"] as! Double) <= Date().timeIntervalSince1970 * 1000 + 86_400_000 && (renewed["validUntil"] as! Double).rounded(.down) == renewed["validUntil"] as? Double, "Renewal rotates lease and clamps an integer private TTL without extending old proofs")
        try failure(.access) { _ = try newOwnerStore.read(lease: renewedLease, head: renewed["head"] as! Int, proofEpoch: renewed["proofEpoch"] as! Int, cursor: nil, byteLimit: 1024) }
        try newOwnerStore.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(emptyWorkspace), sessionRef: "private-restart-cookie")
        let revalidated = try newOwnerStore.open()
        try require(revalidated["resourceAccess"] as? String == "ready", "Fresh whole-profile canonical proof restores reads after native TTL renewal")
        let refreshedAuthority = try FountainRecovery.Authority.session(encoded(freshSession), origin: origin, reference: "private-restart-cookie")
        let writerReader = try FountainRecovery(authority: refreshedAuthority, testingDirectory: restartDirectory)
        _ = try writerReader.inventory(refreshedAuthority, cursor: nil, count: 100)
        // Exact production handoff used by the bridge: close only inventory SQL
        // and capabilities, retain actual native identity and source input.
        writerReader.close()
        let preservedPut: [String: Any] = ["op": "put", "bucket": "drafts", "key": [profile + "|page", "two-connections"], "value": ["key": profile + "|page", "profileId": profile, "clientId": "two-connections", "draft": ["reason": "pending", "blocks": [["id": "pending", "type": "paragraph", "text": "Two SQLite connections original🙂"]]]]]
        let quarantineBytes = try encoded(["version": 1, "origin": origin, "mode": "quarantine", "changes": [preservedPut]])
        try newOwnerStore.stage(lease: renewedLease, txID: "two-connections-unaccepted", baseHead: revalidated["head"] as! Int, proofEpoch: revalidated["proofEpoch"] as! Int, part: 0, bytes: quarantineBytes)
        let settlementReader = try FountainRecovery(authority: refreshedAuthority, testingDirectory: restartDirectory)
        _ = try settlementReader.inventory(refreshedAuthority, cursor: nil, count: 100); settlementReader.close()
        let settleStart = Date()
        let twoConnectionSettlement = try newOwnerStore.reconcile(["generation": 2, "phase": "settle", "lease": renewedLease, "journals": [["txId": "two-connections-unaccepted", "digest": FountainOutbox.hash(quarantineBytes), "baseHead": revalidated["head"]!, "proofEpoch": revalidated["proofEpoch"]!]]], admissionWatermark: 0, sessionRef: "private-restart-cookie")
        try require(Date().timeIntervalSince(settleStart) < 4 && (twoConnectionSettlement["settlements"] as! [[String: Any]])[0]["status"] as? String == "unaccepted", "Inventory reader handoff permits a bounded private unaccepted-settlement writer")
        try require(try stored(restartFile, query: "SELECT data FROM staging WHERE tx_id=?", key: "two-connections-unaccepted") == quarantineBytes, "Two-connection settlement retains every original staged byte")
        try newOwnerStore.stage(lease: renewedLease, txID: "two-connections-quarantine", baseHead: revalidated["head"] as! Int, proofEpoch: revalidated["proofEpoch"] as! Int, part: 0, bytes: quarantineBytes)
        _ = try newOwnerStore.commit(lease: renewedLease, txID: "two-connections-quarantine", baseHead: revalidated["head"] as! Int, proofEpoch: revalidated["proofEpoch"] as! Int, digest: FountainOutbox.hash(quarantineBytes), quarantineOnly: true)
        try require(try stored(restartFile, query: "SELECT value FROM recovery WHERE tx_id=?", key: "two-connections-quarantine") == encoded(preservedPut), "Verified quarantine commits original bytes after closing its own SQLite reader")
        try newOwnerStore.suspend()
        try failure(.access) { try newOwnerStore.grant(freshSession, sessionRef: "private-restart-cookie") }
        try require(try stored(restartFile, query: "SELECT value FROM control WHERE id=?", key: "suspended:" + profile) != nil, "Explicit suspension remains permanent across an actual same-cookie fresh session")
        let scopeStore = try FountainOutbox(origin: origin, testingDirectory: base.appendingPathComponent("delivery-scopes", isDirectory: true)); defer { scopeStore.close() }
        var scopeA = session, scopeMemberA = session["member"] as! [String: Any]; scopeMemberA["id"] = "actor-a"; scopeA["member"] = scopeMemberA; scopeA["workspace_id"] = "scope-a"; scopeA["cache_binding"] = "binding-a"
        try scopeStore.grant(scopeA, sessionRef: "scope-cookie-a"); try scopeStore.ensureOwner("scope-owner-a", epoch: 1)
        let pageB: [String: Any] = ["id": "page-b", "access_level": 3, "locked": false, "archived": false, "revision": 1]
        let workspaceA: [String: Any] = ["workspace_id": "scope-a", "current_member_id": "actor-a", "session_binding": "binding-a", "access_revision": 100, "data_revision": 100, "pages": [], "databases": []]
        try scopeStore.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspaceA), sessionRef: "scope-cookie-a")
        let admissionA = try scopeStore.admitHTTP(path: "/api/workspace", sessionRef: "scope-cookie-a")!, fenceA = try scopeStore.captureHTTPFence(admissionA, path: "/api/workspace", method: "GET", status: 200)
        var scopeB = session, scopeMemberB = scopeMemberA; scopeMemberB["id"] = "actor-b"; scopeB["member"] = scopeMemberB; scopeB["workspace_id"] = "scope-b"; scopeB["cache_binding"] = "binding-b"
        try scopeStore.grant(scopeB, sessionRef: "scope-cookie-b"); try scopeStore.ensureOwner("scope-owner-b", epoch: 2)
        var workspaceB: [String: Any] = ["workspace_id": "scope-b", "current_member_id": "actor-b", "session_binding": "binding-b", "access_revision": 5, "data_revision": 5, "pages": [pageB], "databases": []]
        try scopeStore.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspaceB), sessionRef: "scope-cookie-b")
        var pageReplyB = workspaceB; pageReplyB.removeValue(forKey: "pages"); pageReplyB.removeValue(forKey: "databases"); pageReplyB["page"] = pageB; pageReplyB["access_level"] = 3; pageReplyB["epoch"] = "scope-b-epoch"; pageReplyB["seq"] = 0; pageReplyB["blocks"] = []; pageReplyB["state"] = ["version": 1, "blocks": [String: Any](), "seen": [String: Any](), "max_clock": 0]
        try scopeStore.observeResource(path: "/api/pages/page-b/collaboration", method: "GET", status: 200, data: encoded(pageReplyB), sessionRef: "scope-cookie-b")
        let admissionB = try scopeStore.admitHTTP(path: "/api/pages/page-b/collaboration", sessionRef: "scope-cookie-b")!, fenceB5 = try scopeStore.captureHTTPFence(admissionB, path: "/api/pages/page-b/collaboration", method: "GET", status: 200)
        try scopeStore.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspaceB), sessionRef: "scope-cookie-b")
        try require(scopeStore.canDeliverHTTP(fenceB5), "A stable sibling canonical200 at B5 does not invalidate B page delivery")
        try require(!scopeStore.canDeliverHTTP(fenceA), "Old actor A100 delivery never revives after resetting to actor B5 scope")
        workspaceB["access_revision"] = 6; workspaceB["data_revision"] = 6
        try scopeStore.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspaceB), sessionRef: "scope-cookie-b")
        try require(!scopeStore.canDeliverHTTP(fenceB5), "B5 page delivery is fenced when B advances to6 even after prior actor A100")
        try require(scopeStore.canDeliverHTTP(admissionB), "Same-authority floor advance retains the lease while fencing only stale private delivery")
        let fenceB6 = try scopeStore.captureHTTPFence(admissionB, path: "/api/workspace", method: "GET", status: 200)
        var lowerB = workspaceB; lowerB["access_revision"] = 4
        try failure(.stale) { try scopeStore.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(lowerB), sessionRef: "scope-cookie-b") }
        try require(scopeStore.canDeliverHTTP(fenceB6), "Rejected older B floor never lowers current delivery authority or fabricates denial")
        try scopeStore.observeResource(path: "/api/pages/page-b/collaboration", method: "GET", status: 403, data: Data(), sessionRef: "scope-cookie-b")
        try require(!scopeStore.canDeliverHTTP(fenceB6), "An actual resource denial fences prior workspace metadata before WebView delivery")
        let (terminalStore, terminalFile) = try fixture("terminal-cleanup-receipt"); defer { terminalStore.close() }
        try terminalStore.ensureOwner("terminal-owner", epoch: 1)
        let terminalBefore = try terminalStore.open(), terminalLease = terminalBefore["lease"] as! String
        let terminalHead = terminalBefore["head"] as! Int, terminalProof = terminalBefore["proofEpoch"] as! Int
        let terminalBytes = try encoded(["version": 1, "origin": origin, "mode": "active", "changes": [["op": "put", "bucket": "meta", "key": "revoked:" + profile, "value": ["id": "revoked:" + profile, "profileId": profile]]]])
        let terminalDigest = FountainOutbox.hash(terminalBytes)
        try terminalStore.stage(lease: terminalLease, txID: "terminal-cleanup", baseHead: terminalHead, proofEpoch: terminalProof, part: 0, bytes: terminalBytes)
        let terminalReceipt = try terminalStore.commit(lease: terminalLease, txID: "terminal-cleanup", baseHead: terminalHead, proofEpoch: terminalProof, digest: terminalDigest)
        try require(terminalReceipt["head"] as? Int == terminalHead + 1, "Own cleanup advances the native head exactly once")
        try require(try terminalStore.open()["identityState"] as? String == "blocked", "Own cleanup permanently blocks native body hydration")
        try failure(.blocked) { _ = try terminalStore.read(lease: terminalLease, head: terminalHead + 1, proofEpoch: terminalProof, cursor: nil, byteLimit: 1024) }
        let terminalRetry = try terminalStore.commit(lease: terminalLease, txID: "terminal-cleanup", baseHead: terminalHead, proofEpoch: terminalProof, digest: terminalDigest, sessionRef: "private-cookie")
        try require(try encoded(terminalRetry) == encoded(terminalReceipt), "Lost own cleanup ACK returns immutable metadata without another head advance")
        let terminalSettled = try terminalStore.reconcile(["generation": 1, "phase": "settle", "lease": terminalLease, "journals": [["txId": "terminal-cleanup", "digest": terminalDigest, "baseHead": terminalHead, "proofEpoch": terminalProof]]], admissionWatermark: 0, sessionRef: "private-cookie")
        try require((terminalSettled["settlements"] as? [[String: Any]])?.first?["status"] as? String == "accepted", "Exact terminal cleanup journal settles metadata while the native profile remains blocked")
        try require(try stored(terminalFile, query: "SELECT value FROM control WHERE id=?", key: "suspended:" + profile) != nil && terminalStore.open()["head"] as? Int == terminalHead + 1, "Terminal settlement preserves suspension and the original head")
        let terminalBeforeRestage = try Data(contentsOf: terminalFile)
        try terminalStore.stage(lease: terminalLease, txID: "terminal-cleanup", baseHead: terminalHead, proofEpoch: terminalProof, part: 0, bytes: terminalBytes, sessionRef: "private-cookie")
        try require(try Data(contentsOf: terminalFile) == terminalBeforeRestage, "Exact accepted terminal restage is metadata-only and never recreates staging")
        try failure(.conflict) { try terminalStore.stage(lease: terminalLease, txID: "terminal-cleanup", baseHead: terminalHead, proofEpoch: terminalProof, part: 0, bytes: Data("changed".utf8), sessionRef: "private-cookie") }
        try failure(.access) { _ = try terminalStore.commit(lease: terminalLease, txID: "terminal-cleanup", baseHead: terminalHead, proofEpoch: terminalProof, digest: terminalDigest, sessionRef: "foreign-cookie") }
        try failure(.conflict) { _ = try terminalStore.commit(lease: terminalLease, txID: "terminal-cleanup", baseHead: terminalHead, proofEpoch: terminalProof, digest: String(repeating: "0", count: 64), sessionRef: "private-cookie") }
        try failure(.access) { try terminalStore.stage(lease: terminalLease, txID: "new-after-cleanup", baseHead: terminalHead + 1, proofEpoch: terminalProof, part: 0, bytes: terminalBytes, sessionRef: "private-cookie") }
        try failure(.access) { _ = try terminalStore.reconcile(["generation": 1, "phase": "settle", "lease": terminalLease, "journals": [["txId": "unknown-terminal", "digest": terminalDigest, "baseHead": terminalHead, "proofEpoch": terminalProof]]], admissionWatermark: 0, sessionRef: "private-cookie") }
        try require(try Data(contentsOf: terminalFile) == terminalBeforeRestage, "Rejected terminal mismatches leave all original receipt, source and suspension bytes intact")
        let unanchored = try FountainOutbox(origin: origin, testingDirectory: base.appendingPathComponent("terminal-before-floor", isDirectory: true)); defer { unanchored.close() }
        try unanchored.grant(session, sessionRef: "private-unanchored-cookie"); try unanchored.ensureOwner("unanchored-owner", epoch: 1)
        let unanchoredBefore = try unanchored.open(), unanchoredLease = unanchoredBefore["lease"] as! String
        try unanchored.stage(lease: unanchoredLease, txID: "unanchored-negative", baseHead: unanchoredBefore["head"] as! Int, proofEpoch: unanchoredBefore["proofEpoch"] as! Int, part: 0, bytes: terminalBytes)
        let unanchoredReceipt = try unanchored.commit(lease: unanchoredLease, txID: "unanchored-negative", baseHead: unanchoredBefore["head"] as! Int, proofEpoch: unanchoredBefore["proofEpoch"] as! Int, digest: terminalDigest)
        try require(unanchoredReceipt["head"] as? Int == (unanchoredBefore["head"] as! Int) + 1 && unanchored.open()["identityState"] as? String == "blocked", "Fresh actual actor can submit only its own negative cleanup before canonical floors exist")
        #if os(iOS)
        print("iOS production Swift observer: \(checks) checks PASS (actual iOS SDK SQLite; no full bridge lifecycle claim)")
        #else
        print("iOS production Swift observer: \(checks) checks PASS (macOS SQLite; no native bridge or iOS file-protection claim)")
        #endif
    }
}
