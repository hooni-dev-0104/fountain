import Foundation
import SQLite3
#if os(iOS)
@testable import App
#endif

private final class AccountMemory: FountainAccountStorage {
    var values: [String: FountainAccountCookies] = [:], markers = Set<String>(), failRead = false
    func read(_ origin: String) throws -> FountainAccountCookies { if failRead { throw FountainAccountError.storage }; return values[origin] ?? FountainAccountCookies() }
    func write(_ value: FountainAccountCookies, origin: String) throws { values[origin] = value }
    func blocked(_ origin: String) throws -> Bool { markers.contains(origin) }
    func block(_ origin: String) throws { markers.insert(origin) }
    func unblock(_ origin: String) throws { markers.remove(origin) }
}
private final class WorkspaceProtocol: URLProtocol {
    static var handler: ((WorkspaceProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.handler?(self) }
    override func stopLoading() {}
    func respond(_ status: Int, _ bytes: Data, headers: [String: String] = [:]) {
        var headers = headers; headers["Content-Length"] = String(bytes.count)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
}
enum IOSMultiworkspaceFixture {
    static var checks = 0
    static let parent = String(repeating: "a", count: 32), bindingA = String(repeating: "1", count: 32), bindingB = String(repeating: "2", count: 32)
    static let origin = "https://multiworkspace.invalid", reference = "private-account-cookie-reference"
    static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        checks += 1
        guard try condition() else { throw NSError(domain: "IOSMultiworkspace", code: checks, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]) }
    static func denied(_ operation: () throws -> Void) throws {
        do { try operation() } catch { checks += 1; return }
        throw NSError(domain: "IOSMultiworkspace", code: -1, userInfo: [NSLocalizedDescriptionKey: "Expected rejection"])
    }
    static func session(_ ws: String, _ binding: String) -> [String: Any] {
        ["enabled": true, "authenticated": true, "required": true, "mode": "accounts", "identity": "Member " + ws, "workspace_id": ws, "cache_binding": binding, "account_binding": parent, "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), "member": ["id": "member-" + ws, "name": "Member " + ws, "email": "member-" + ws + "@example.invalid", "active": true, "role": "owner"]]
    }
    static func scopedReconcile(_ store: FountainOutbox, _ input: [String: Any], admissionWatermark: Int, sessionRef: String?) throws -> [String: Any] {
        var wire: [AnyHashable: Any] = [:]
        for (key, value) in input { wire[key] = value }
        wire["workspaceEpoch"] = 7
        return try store.reconcile(FountainOutbox.reconciliationBridgePayload(wire), admissionWatermark: admissionWatermark, sessionRef: sessionRef)
    }
    static func reconcile(_ store: FountainOutbox, _ ws: String, _ binding: String) throws {
        try store.ensureOwner("multiworkspace", epoch: 7)
        let opened = try store.open(), lease = opened["lease"] as! String
        var sequence = 0
        var state = try scopedReconcile(store, ["generation": 1, "phase": "prepare", "lease": lease, "baseHead": opened["head"]!, "proofEpoch": opened["proofEpoch"]!, "mode": "current"], admissionWatermark: sequence, sessionRef: reference)
        let plan = state["planId"] as! String
        let page: [String: Any] = ["id": "page", "access_level": 3, "locked": false, "archived": false, "revision": 1]
        let workspace: [String: Any] = ["workspace_id": ws, "current_member_id": "member-" + ws, "session_binding": binding, "access_revision": 1, "data_revision": 1, "pages": [page], "databases": [], "teamspaces": [["id": "general", "access_level": 4]]]
        let snapshot: [String: Any] = ["workspace_id": ws, "current_member_id": "member-" + ws, "session_binding": binding, "access_revision": 1, "data_revision": 1, "page": page, "access_level": 3, "blocks": [], "state": [:], "epoch": "epoch", "seq": 0, "ack": []]
        while state["state"] as? String == "collecting" {
            try check(sequence < 20, "Canonical collection did not terminate")
            for needed in state["needed"] as! [[String: String]] {
                sequence += 1
                let path = needed["kind"] == "workspace" ? "/api/workspace" : "/api/pages/page/collaboration"
                let admission = try store.admitReconcile(path: path, method: "GET", sessionRef: reference, sequence: sequence)
                try check(admission != nil, "Missing canonical admission")
                try store.observeReconcileResource(admission: admission, path: path, method: "GET", status: 200, data: bytes(needed["kind"] == "workspace" ? workspace : snapshot), sessionRef: reference)
            }
            state = try scopedReconcile(store, ["generation": 1, "phase": "prepare", "lease": lease, "planId": plan], admissionWatermark: sequence, sessionRef: reference)
        }
        try check(state["state"] as? String == "ready" && state["requiresConfirmation"] as? Bool == false, "Same-incarnation resume unexpectedly needs adoption")
        let result = try scopedReconcile(store, ["generation": 1, "phase": "commit", "lease": lease, "baseHead": state["baseHead"]!, "proofEpoch": state["proofEpoch"]!, "planId": plan, "checksum": state["checksum"]!, "confirm": false], admissionWatermark: sequence, sessionRef: reference)
        try check(result["state"] as? String == "committed", "Canonical reconciliation did not commit")
        try check(try store.open()["resourceAccess"] as? String == "ready", "Fresh canonical scope is not ready")
        try check(try store.accountCanTransmit(), "Canonical commit failed to open native mutation admission")
    }
    static func readControl(_ file: URL, _ key: String) throws -> Any? {
        var db: OpaquePointer?, statement: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        guard sqlite3_prepare_v2(db, "SELECT value FROM control WHERE id=?", -1, &statement, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        sqlite3_bind_text(statement, 1, key, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        if sqlite3_step(statement) == SQLITE_DONE { return nil }
        guard let buffer = sqlite3_column_blob(statement, 0) else { throw FountainOutboxError.storage }
        return try JSONSerialization.jsonObject(with: Data(bytes: buffer, count: Int(sqlite3_column_bytes(statement, 0))), options: [.fragmentsAllowed])
    }
    static func readRecord(_ file: URL, _ bucket: String, _ key: Any) throws -> Data? {
        var db: OpaquePointer?, statement: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        guard sqlite3_prepare_v2(db, "SELECT value FROM records WHERE bucket=? AND key=?", -1, &statement, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(statement, 1, bucket, -1, transient)
        sqlite3_bind_text(statement, 2, String(data: try bytes(key), encoding: .utf8)!, -1, transient)
        if sqlite3_step(statement) == SQLITE_DONE { return nil }
        guard let buffer = sqlite3_column_blob(statement, 0) else { throw FountainOutboxError.storage }
        return Data(bytes: buffer, count: Int(sqlite3_column_bytes(statement, 0)))
    }
    static func expireParkedFixture(_ file: URL, _ profile: String) throws {
        guard var saved = try readControl(file, "parked:" + profile) as? [String: Any] else { throw FountainOutboxError.storage }
        saved["validUntil"] = 1
        let data = try bytes(saved)
        var db: OpaquePointer?, statement: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        guard sqlite3_prepare_v2(db, "UPDATE control SET value=? WHERE id=?", -1, &statement, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        _ = data.withUnsafeBytes { sqlite3_bind_blob(statement, 1, $0.baseAddress, Int32(data.count), transient) }
        sqlite3_bind_text(statement, 2, "parked:" + profile, -1, transient)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw FountainOutboxError.storage }
    }
    static func run(directory: URL) throws {
        for path in ["/api/w/A/" + bindingA + "/session", "/api/organization/session", "/api/account/%73ession", "/api/account/session/", "/api/account/workspaces?session_binding=" + parent + "&session_binding=" + parent, "/api/account/workspaces?session_binding=bad"] {
            try denied { _ = try FountainAccount.Request(["id": "bad", "generation": 1, "path": path]) }
        }
        try check(try FountainAccountPolicy.route("/api/account/workspaces?session_binding=" + parent + "&cursor=workspace-A", method: "GET") == "/api/account/workspaces", "Directory pagination rejected")
        for path in ["/api/w/A/" + bindingA + "/session", "/api/w/B/" + bindingB + "/pages/page?x=1"] { try check(FountainWorkspacePolicy.scoped(path) != nil, "Canonical route rejected") }
        for path in ["/api/w/A/bad/session", "/api/w/A%2fB/" + bindingA + "/session", "/api/w//" + bindingA + "/session", "/api/w/A/" + bindingA + "//session"] { try check(FountainWorkspacePolicy.scoped(path) == nil, "Noncanonical prefix admitted") }
        let cookieToken = Data(repeating: 7, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let accountCookie = "fountain_account_session=" + cookieToken, targetHeader = accountCookie + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800"
        let cfHeader = "__cf_bm=independent.bot.cookie; HttpOnly; SameSite=None; Secure; Path=/; Domain=.supabase.co; Expires=Sun, 18 Oct 2026 13:00:00 GMT"
        func header(_ value: String) -> HTTPURLResponse { HTTPURLResponse(url: URL(string: origin)!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Set-Cookie": value])! }
        try check(try FountainAccountPolicy.responseCookie(header(targetHeader + ", " + cfHeader)) == accountCookie, "Actual Cloudflare companion rejected target cookie")
        try check(try FountainAccountPolicy.responseCookie(header(cfHeader + ", " + targetHeader)) == accountCookie, "Companion Expires date comma confused target boundary")
        for value in [targetHeader + ", " + targetHeader, targetHeader + ", fountain_session=leak", targetHeader + ", fountain_organization_session=leak", targetHeader + ", unknown_cookie=leak", cfHeader, targetHeader + ", " + cfHeader + ", " + cfHeader, targetHeader.replacingOccurrences(of: "Path=/", with: "Path=/api") + ", " + cfHeader] { try denied { _ = try FountainAccountPolicy.responseCookie(header(value)) } }
        for control in ["\t", "\u{1}", "\u{7f}"] {
            try denied { _ = try FountainAccountPolicy.responseCookie(header(targetHeader + ", " + cfHeader + control)) }
        }
        try denied { _ = try FountainAccountPolicy.responseCookie(header(targetHeader.replacingOccurrences(of: "; Path", with: ";\tPath") + ", " + cfHeader)) }
        let a = session("A", bindingA), b = session("B", bindingB)
        let authority = try FountainWorkspacePolicy.verify(bytes(a), workspace: "A", binding: bindingA, account: parent)
        try check(authority.memberId == "member-A" && authority.expiresAt > Date().timeIntervalSince1970 * 1000, "Session authority missing")
        var published = a; published["public_web_origin"] = "https://fountain.example"
        try check(try FountainWorkspacePolicy.verify(bytes(published), workspace: "A", binding: bindingA, account: parent).session["public_web_origin"] as? String == "https://fountain.example", "Canonical optional public origin rejected actual scoped GET")
        for invalid in ["http://fountain.example", "https://fountain.example/", "https://fountain.example/path", "https://user@fountain.example", "https://fountain.example?x=1", "https://fountain.example#x", "https://FOUNTAIN.example/", "https://fountain.example\\evil"] {
            published["public_web_origin"] = invalid
            try denied { _ = try FountainWorkspacePolicy.verify(bytes(published), workspace: "A", binding: bindingA, account: parent) }
        }
        published = a; published["public_web_origin"] = NSNull()
        try denied { _ = try FountainWorkspacePolicy.verify(bytes(published), workspace: "A", binding: bindingA, account: parent) }
        for displayEmail in ["", String(repeating: "x", count: 1000), String(repeating: "🙂", count: 500)] {
            var legacy = a, member = legacy["member"] as! [String: Any]; member["email"] = displayEmail; legacy["member"] = member
            try check(try FountainWorkspacePolicy.verify(bytes(legacy), workspace: "A", binding: bindingA, account: parent).memberId == "member-A", "Legacy display email rejected authoritative member")
        }
        var oversized = a, oversizedMember = oversized["member"] as! [String: Any]; oversizedMember["email"] = String(repeating: "🙂", count: 501); oversized["member"] = oversizedMember
        try denied { _ = try FountainWorkspacePolicy.verify(bytes(oversized), workspace: "A", binding: bindingA, account: parent) }
        for field in ["workspace_id", "cache_binding", "account_binding", "expires_at", "authenticated", "member", "enabled", "required", "identity"] {
            var broken = a; broken.removeValue(forKey: field)
            try denied { _ = try FountainWorkspacePolicy.verify(bytes(broken), workspace: "A", binding: bindingA, account: parent) }
        }
        var openedUnconfiguredStore = false
        try FountainWorkspacePolicy.invalidatePersistedAccount(origin: nil) { openedUnconfiguredStore = true; throw FountainOutboxError.storage }
        try check(!openedUnconfiguredStore, "First configuration required an impossible old native store")
        var invalidatedConfiguredStore = false
        FountainWorkspacePolicy.invalidatePersistedAccount(origin: origin) { invalidatedConfiguredStore = true }
        try check(invalidatedConfiguredStore, "Configured origin skipped old account boundary invalidation")
        do {
            try FountainWorkspacePolicy.invalidatePersistedAccount(origin: origin) { throw FountainOutboxError.storage }
            throw NSError(domain: "IOSMultiworkspace", code: -1)
        } catch let failure as FountainOutboxError { try check(failure == .storage, "Configured storage failure was hidden") }
        let switchDirectory = directory.appendingPathComponent("configured-account-boundary", isDirectory: true)
        let switchStore = try FountainOutbox(origin: origin, testingDirectory: switchDirectory); defer { switchStore.close() }
        try switchStore.activateAccount(a, sessionRef: reference, parentBinding: parent)
        try FountainWorkspacePolicy.invalidatePersistedAccount(origin: origin) { try switchStore.suspendAccounts() }
        let switchFile = switchDirectory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
        try check(try readControl(switchFile, "suspended:" + origin + "|A|member-A|" + bindingA) as? Bool == true, "Origin switch did not durably suspend old account scope")
        let bridgePayload = try FountainOutbox.reconciliationBridgePayload(["generation": 1, "workspaceEpoch": 7, "phase": "prepare", "unknown": true])
        try check(bridgePayload["workspaceEpoch"] == nil && bridgePayload["unknown"] as? Bool == true && bridgePayload["phase"] as? String == "prepare", "Bridge codec dropped an engine field or forwarded consumed epoch")
        try denied { _ = try FountainOutbox.reconciliationBridgePayload([AnyHashable(7): "not-a-string-key"]) }
        let store = try FountainOutbox(origin: origin, testingDirectory: directory); defer { store.close() }
        let file = directory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
        try store.activateAccount(a, sessionRef: reference, parentBinding: parent)
        try reconcile(store, "A", bindingA)
        try store.activateAccount(a, sessionRef: reference, parentBinding: parent, requireReconcile: false)
        try check(try store.accountCanTransmit(), "Identical scoped session refresh unnecessarily blocked canonical scope")
        let strictOpened = try store.open()
        try denied { _ = try scopedReconcile(store, ["generation": 1, "phase": "prepare", "lease": strictOpened["lease"]!, "baseHead": strictOpened["head"]!, "proofEpoch": strictOpened["proofEpoch"]!, "mode": "current", "unknown": true], admissionWatermark: 0, sessionRef: reference) }
        let opened = try store.open(), oldLease = opened["lease"] as! String
        let profile = origin + "|A|member-A|" + bindingA, resource = profile + "|page"
        let operation: [String: Any] = ["id": "pending-A", "kind": "page.patch", "target_id": "page", "body": ["title": "A에서 보관한 제목🙂"], "base": ["fields": [:]], "depends_on": []]
        let pending: [String: Any] = ["profileId": profile, "id": "pending-A", "resourceKey": resource, "operation": operation, "status": "pending", "sequence": 1, "createdAt": 1, "updatedAt": 1]
        let delta = try bytes(["version": 1, "origin": origin, "mode": "active", "changes": [["op": "put", "bucket": "mutations", "key": [profile, "pending-A"], "value": pending]]])
        try store.stage(lease: oldLease, txID: "pending-A", baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, part: 0, bytes: delta)
        _ = try store.commit(lease: oldLease, txID: "pending-A", baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, digest: FountainOutbox.hash(delta))
        let originalPending = try readRecord(file, "mutations", [profile, "pending-A"])
        try check(originalPending != nil, "Original pending mutation never reached SQL")
        let metadata = try bytes(["version": 1, "origin": origin, "mode": "active", "changes": [
            ["op": "put", "bucket": "meta", "key": "workspace-input:" + profile, "value": ["id": "workspace-input:" + profile, "profileId": profile, "forms": [["name": "title", "value": "미완성 IME🙂"]], "updatedAt": 1]],
            ["op": "put", "bucket": "meta", "key": "parked:" + profile, "value": ["id": "parked:" + profile, "profileId": profile, "accountBinding": parent, "createdAt": 1]]]])
        let inputState = try store.open()
        try store.stage(lease: oldLease, txID: "captured-input", baseHead: inputState["head"] as! Int, proofEpoch: inputState["proofEpoch"] as! Int, part: 0, bytes: metadata)
        _ = try store.commit(lease: oldLease, txID: "captured-input", baseHead: inputState["head"] as! Int, proofEpoch: inputState["proofEpoch"] as! Int, digest: FountainOutbox.hash(metadata))
        try check(try readRecord(file, "meta", "active:" + parent + ":A") != nil, "Native reconciliation failed to use account-specific pointer")
        try check(try readRecord(file, "meta", "active") == nil, "Account reconciliation wrote legacy active pointer")
        try store.parkAccount()
        try check(try readControl(file, "parked:" + profile) != nil, "Parking was not durable")
        try check(try readControl(file, "suspended:" + profile) == nil, "Parking permanently suspended A")
        try denied { try store.stage(lease: oldLease, txID: "stale", baseHead: 0, proofEpoch: 0, part: 0, bytes: delta) }
        try store.activateAccount(b, sessionRef: reference, parentBinding: parent)
        try reconcile(store, "B", bindingB)
        try check(try store.open()["profileId"] as? String == origin + "|B|member-B|" + bindingB, "B was not selected")
        try store.parkAccount()
        try store.activateAccount(a, sessionRef: reference, parentBinding: parent)
        try check(try store.open()["resourceAccess"] as? String == "required", "Parked cache resumed before canonical reconciliation")
        try reconcile(store, "A", bindingA)
        try check(try store.open()["profileId"] as? String == profile, "Stable A binding was replaced")
        try check(try readRecord(file, "mutations", [profile, "pending-A"]) == originalPending, "A→B→A changed or lost original pending title")
        try check(try readRecord(file, "meta", "workspace-input:" + profile) != nil, "Durable IME/form input was lost on resume")
        let sync = try bytes(["workspace_id": "A", "session_binding": bindingA, "operations": [operation]])
        try check(try store.admitSync(path: "/api/sync", method: "POST", body: sync, sessionRef: reference) != nil, "Same-incarnation pending cannot resume")
        try denied { _ = try store.admitSync(path: "/api/sync", method: "POST", body: bytes(["workspace_id": "B", "session_binding": bindingB, "operations": [operation]]), sessionRef: reference) }
        try store.parkAccount()
        let hints = try store.retainedAccountScopes(parentBinding: parent, sessionRef: reference)
        try check(Set(hints.compactMap { $0["workspaceId"] as? String }) == Set(["A", "B"]), "Cold chooser did not retain both workspace hints")
        try check(hints.allSatisfy { Set($0.keys) == Set(["workspaceId", "memberId", "binding", "accountBinding", "expiresAt"]) }, "Retained hints disclosed private fields")
        try check(try store.retainedAccountScopes(parentBinding: String(repeating: "b", count: 32), sessionRef: reference).isEmpty, "Retained hints crossed parent boundary")
        let offline = try FountainOutbox(origin: origin, testingDirectory: directory)
        defer { offline.close() }
        try denied { try offline.resumeAccountOffline(a, sessionRef: "another-parent-cookie", parentBinding: parent) }
        try denied { try offline.resumeAccountOffline(a, sessionRef: reference, parentBinding: String(repeating: "b", count: 32)) }
        try offline.resumeAccountOffline(a, sessionRef: reference, parentBinding: parent)
        try offline.ensureOwner("cold-offline", epoch: 8)
        let cached = try offline.open(), offlineLease = cached["lease"] as! String
        try check(cached["resourceAccess"] as? String == "ready", "Original proof/TTL did not support cold cached read")
        let read = try offline.read(lease: offlineLease, head: cached["head"] as! Int, proofEpoch: cached["proofEpoch"] as! Int, cursor: nil, byteLimit: 262144)
        try check(!(read["fragments"] as! [Any]).isEmpty, "Cold offline cached content is unavailable")
        try denied { _ = try offline.admitSync(path: "/api/sync", method: "POST", body: sync, sessionRef: reference) }
        try denied { _ = try offline.reconcile(["phase": "prepare"], admissionWatermark: 0, sessionRef: reference) }
        let draft: [String: Any] = ["key": resource, "profileId": profile, "clientId": "offline-ime", "draft": ["reason": "pending", "epoch": "epoch", "blocks": [["id": "draft", "type": "paragraph", "text": "오프라인에서 이어 쓴 가족 메모🙂"]]]]
        var localChanges: [[String: Any]] = [["op": "put", "bucket": "drafts", "key": [resource, "offline-ime"], "value": draft]]
        let crdt: [[String: Any]] = [
            ["id": "offline_editor:1", "client": "offline_editor", "clock": 1, "type": "block.insert", "block_id": "offline-block", "parent_id": NSNull(), "after_id": NSNull(), "block_type": "paragraph", "_epoch": "epoch"],
            ["id": "offline_editor:2", "client": "offline_editor", "clock": 2, "type": "text.insert", "block_id": "offline-block", "after_id": NSNull(), "text": "연결 없이 이어 쓴 본문🙂", "marks": [:], "_epoch": "epoch"]]
        for operation in crdt {
            localChanges.append(["op": "put", "bucket": "operations", "key": [resource, operation["id"]!], "value": ["key": resource, "profileId": profile, "id": operation["id"]!, "operation": operation, "createdAt": 2, "updatedAt": 2]])
        }
        var offlineTitle = pending
        offlineTitle["id"] = "offline-title"
        var titleOperation = operation; titleOperation["id"] = "offline-title"; titleOperation["body"] = ["title": "비행기 모드에서 바꾼 제목🙂"]
        offlineTitle["operation"] = titleOperation
        localChanges.append(["op": "put", "bucket": "mutations", "key": [profile, "offline-title"], "value": offlineTitle])
        let newResource = profile + "|offline-created", createEpoch = "offline-created-epoch"
        let newPage: [String: Any] = ["id": "offline-created", "title": "오프라인 새 페이지", "owner_id": "member-A", "access_level": 4, "locked": false, "archived": false, "revision": 0]
        let create: [String: Any] = ["id": "offline-create", "kind": "page.create", "target_id": "offline-created", "document_epoch": createEpoch, "body": ["id": "offline-created", "title": "오프라인 새 페이지", "teamspace_id": "general"], "depends_on": []]
        let createRecord: [String: Any] = ["profileId": profile, "id": "offline-create", "resourceKey": newResource, "operation": create, "status": "pending", "sequence": 3, "createdAt": 3, "updatedAt": 3]
        let localPage: [String: Any] = ["key": newResource, "profileId": profile, "metadata": ["localOnly": true, "page": newPage, "create_operation_id": "offline-create", "initial_epoch": createEpoch]]
        let localSnapshot: [String: Any] = ["workspace_id": "A", "current_member_id": "member-A", "session_binding": bindingA, "page": newPage, "access_level": 4, "blocks": [], "state": ["version": 1, "blocks": [:], "seen": [:]], "epoch": createEpoch, "seq": 0]
        localChanges.append(["op": "put", "bucket": "mutations", "key": [profile, "offline-create"], "value": createRecord])
        localChanges.append(["op": "put", "bucket": "localPages", "key": newResource, "value": localPage])
        localChanges.append(["op": "put", "bucket": "snapshots", "key": newResource, "value": ["key": newResource, "profileId": profile, "snapshot": localSnapshot, "updatedAt": 3]])
        let append = try bytes(["version": 1, "origin": origin, "mode": "active", "changes": localChanges])
        try offline.stage(lease: offlineLease, txID: "offline-append", baseHead: cached["head"] as! Int, proofEpoch: cached["proofEpoch"] as! Int, part: 0, bytes: append)
        _ = try offline.commit(lease: offlineLease, txID: "offline-append", baseHead: cached["head"] as! Int, proofEpoch: cached["proofEpoch"] as! Int, digest: FountainOutbox.hash(append))
        try check(try readRecord(file, "drafts", [resource, "offline-ime"]) != nil, "Offline local input was not durable")
        for (bucket, key) in [("operations", [resource, "offline_editor:1"]), ("operations", [resource, "offline_editor:2"]), ("mutations", [profile, "offline-title"]), ("mutations", [profile, "offline-create"])] { try check(try readRecord(file, bucket, key) != nil, "Offline CRDT/title/create pending was not retained") }
        try check(try readRecord(file, "localPages", newResource) != nil && readRecord(file, "snapshots", newResource) != nil, "Cached creation authority failed local page construction")
        let offlineAfter = try offline.open()
        let forgedPage: [String: Any] = ["id": "page", "access_level": 3, "locked": false, "archived": false, "revision": 1]
        let forgedSnapshot: [String: Any] = ["workspace_id": "A", "current_member_id": "member-A", "session_binding": bindingA, "access_revision": 1, "data_revision": 1, "page": forgedPage, "access_level": 3, "blocks": [["id": "forged", "type": "paragraph", "text": "Forged server body"]], "state": ["version": 1], "epoch": "epoch", "seq": 0]
        let forged = try bytes(["version": 1, "origin": origin, "mode": "active", "changes": [["op": "put", "bucket": "snapshots", "key": resource, "value": ["key": resource, "profileId": profile, "snapshot": forgedSnapshot, "updatedAt": 4]]]])
        try offline.stage(lease: offlineLease, txID: "forged-offline-snapshot", baseHead: offlineAfter["head"] as! Int, proofEpoch: offlineAfter["proofEpoch"] as! Int, part: 0, bytes: forged)
        try denied { _ = try offline.commit(lease: offlineLease, txID: "forged-offline-snapshot", baseHead: offlineAfter["head"] as! Int, proofEpoch: offlineAfter["proofEpoch"] as! Int, digest: FountainOutbox.hash(forged)) }
        try offline.parkAccount()
        try offline.activateAccount(a, sessionRef: reference, parentBinding: parent)
        try denied { _ = try offline.admitSync(path: "/api/sync", method: "POST", body: sync, sessionRef: reference) }
        try reconcile(offline, "A", bindingA)
        try check(try offline.admitSync(path: "/api/sync", method: "POST", body: sync, sessionRef: reference) != nil, "Online canonical reconciliation failed to restore sync")
        try offline.parkAccount()
        try expireParkedFixture(file, profile)
        try check(Set(try offline.retainedAccountScopes(parentBinding: parent, sessionRef: reference).compactMap { $0["workspaceId"] as? String }) == Set(["B"]), "Expired A appeared in retained chooser hints")
        try denied { try offline.resumeAccountOffline(a, sessionRef: reference, parentBinding: parent) }
        let replacementBinding = String(repeating: "3", count: 32), replacement = session("A", String(repeating: "3", count: 32))
        try offline.activateAccount(replacement, sessionRef: reference, parentBinding: parent)
        try check(try readControl(file, "suspended:" + profile) as? Bool == true, "Observed new child incarnation did not permanently fence old A")
        let replacementHints = try offline.retainedAccountScopes(parentBinding: parent, sessionRef: reference).filter { $0["workspaceId"] as? String == "A" }
        try check(replacementHints.count == 1 && replacementHints.first?["binding"] as? String == replacementBinding, "Old incarnation leaked into retained chooser")
        try denied { try offline.resumeAccountOffline(a, sessionRef: reference, parentBinding: parent) }
        try check(try readRecord(file, "mutations", [profile, "pending-A"]) == originalPending, "New incarnation erased old retained input")
        try offline.suspendAccounts()
        try check(try offline.retainedAccountScopes(parentBinding: parent, sessionRef: reference).isEmpty, "Retained hints resurrected suspended scopes")
        try denied { try store.activateAccount(a, sessionRef: reference, parentBinding: parent) }
        try denied { try store.activateAccount(b, sessionRef: reference, parentBinding: parent) }
        try denied { try store.resumeAccountOffline(a, sessionRef: reference, parentBinding: parent) }
        try check(try readControl(file, "suspended:" + profile) as? Bool == true, "Account logout did not permanently fence parked A")
        let queue = DispatchQueue(label: "account-native-fixture"), storage = AccountMemory()
        let realm = FountainAccount(queue: queue, storage: storage, protocolClasses: [WorkspaceProtocol.self])
        try queue.sync { try realm.configure(origin: origin, generation: 1) }
        defer { queue.sync { realm.shutdown() } }
        let token = Data(repeating: 8, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let cookie = "fountain_account_session=" + token
        let cookieHeader = cookie + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800"
        var invalidations = 0
        realm.onInvalidation = { invalidations += 1 }
        WorkspaceProtocol.handler = { $0.respond(200, try! bytes(["authenticated": true, "mode": "account", "cache_binding": parent, "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]), headers: ["Set-Cookie": cookieHeader]) }
        func perform(_ request: FountainAccount.Request) throws -> [String: Any] {
            let semaphore = DispatchSemaphore(value: 0); var result: Result<[String: Any], FountainAccountError>?
            try queue.sync { try realm.request(request, workspaceCookie: { fatalError("Account requested workspace cookie") }, url: { URL(string: $0 + $1)! }) { result = $0; semaphore.signal() } }
            guard semaphore.wait(timeout: .now() + 5) == .success, let result else { throw FountainAccountError.timeout }
            return try result.get()
        }
        for status in [200, 401, 404] {
            WorkspaceProtocol.handler = { $0.respond(status, try! bytes(["authenticated": false]), headers: ["X-Fountain-Account-Directory": "absent", "Set-Cookie": "private-canary=never-forward"]) }
            let capability = try perform(FountainAccount.Request(["id": UUID().uuidString, "generation": 1, "path": "/api/account/session"]))
            let headers = capability["headers"] as! [String: String]
            try check(capability["status"] as? Int == status && headers["x-fountain-account-directory"] == "absent" && headers["set-cookie"] == nil, "Explicit account directory absence lost trusted marker or exposed cookie")
        }
        for value in ["Absent", "absent ", " absent", "present", ""] {
            WorkspaceProtocol.handler = { $0.respond(401, try! bytes(["authenticated": false]), headers: ["X-Fountain-Account-Directory": value]) }
            let capability = try perform(FountainAccount.Request(["id": UUID().uuidString, "generation": 1, "path": "/api/account/session"]))
            try check((capability["headers"] as! [String: String])["x-fountain-account-directory"] == nil && capability["status"] as? Int == 401, "Nonliteral capability marker changed denial")
        }
        WorkspaceProtocol.handler = { $0.respond(401, try! bytes(["authenticated": false])) }
        let deniedDirectory = try perform(FountainAccount.Request(["id": UUID().uuidString, "generation": 1, "path": "/api/account/session"]))
        try check(deniedDirectory["status"] as? Int == 401 && (deniedDirectory["headers"] as! [String: String])["x-fountain-account-directory"] == nil, "Unmarked 401 silently became legacy absence")
        try check(invalidations == 0, "Anonymous absence/401 capability probe invalidated unrelated legacy authority")
        for (path, method) in [("/api/account/workspaces?session_binding=" + parent, "GET"), ("/api/account/session", "POST")] {
            WorkspaceProtocol.handler = { $0.respond(401, try! bytes(["authenticated": false]), headers: ["X-Fountain-Account-Directory": "absent"]) }
            let capability = try perform(FountainAccount.Request(["id": UUID().uuidString, "generation": 1, "path": path, "method": method]))
            try check((capability["headers"] as! [String: String])["x-fountain-account-directory"] == nil, "Other account method/path exposed absence authority")
        }
        WorkspaceProtocol.handler = { $0.respond(200, try! bytes(["authenticated": true, "mode": "account", "cache_binding": parent, "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]), headers: ["Set-Cookie": cookieHeader]) }
        _ = try perform(FountainAccount.Request(["id": "login", "generation": 1, "path": "/api/account/session", "method": "POST", "bodyBase64": Data("{}".utf8).base64EncodedString()]))
        try check(try queue.sync { try realm.activeCookie(binding: parent) } == cookie, "Account Keychain adapter lost private token")
        var observedCookie: String?, observedPath: String?
        WorkspaceProtocol.handler = { request in observedCookie = request.request.value(forHTTPHeaderField: "Cookie"); observedPath = request.request.url!.path; request.respond(200, try! bytes(a)) }
        let response = try perform(FountainAccount.Request(["id": "native-session", "generation": 1, "path": "/api/w/A/" + bindingA + "/session"], workspaceVerification: true))
        try check(observedCookie == cookie && observedPath == "/api/w/A/" + bindingA + "/session", "Scoped verification was not actual native URLSession with account cookie")
        try check(!(response["headers"] as! [String: String]).keys.contains("set-cookie"), "Native cookie reached renderer")
        let denialStore = try FountainOutbox(origin: origin, testingDirectory: directory.appendingPathComponent("directory-denial", isDirectory: true))
        defer { denialStore.close() }
        try denialStore.activateAccount(a, sessionRef: reference, parentBinding: parent); try denialStore.parkAccount()
        try denialStore.activateAccount(b, sessionRef: reference, parentBinding: parent); try reconcile(denialStore, "B", bindingB)
        let bBeforeDenial = try denialStore.open(), bBoundary = denialStore.boundary
        var deniedScopes: [(String, String, String)] = []
        realm.onWorkspaceDenial = { workspace, child, parent in
            deniedScopes.append((workspace, child, parent))
            try denialStore.denyAccount(workspace: workspace, binding: child, parentBinding: parent)
        }
        func openAttempt(_ expected: Any, status: Int, code: String) throws {
            WorkspaceProtocol.handler = { $0.respond(status, try! bytes(["error": "Workspace request denied", "code": code])) }
            _ = try perform(FountainAccount.Request(["id": UUID().uuidString, "generation": 1, "path": "/api/account/workspaces/A/open", "method": "POST", "bodyBase64": try bytes(["session_binding": parent, "command_id": UUID().uuidString, "expected_binding": expected]).base64EncodedString()]))
        }
        try openAttempt(bindingA, status: 409, code: "WORKSPACE_BUSY")
        try check(deniedScopes.isEmpty, "Busy409 became permanent workspace denial")
        try openAttempt(bindingA, status: 409, code: "WORKSPACE_SESSION_CHANGED")
        try check(deniedScopes.isEmpty, "Generic receipt/session409 became permanent workspace denial")
        try openAttempt(NSNull(), status: 409, code: "WORKSPACE_SESSION_CHANGED")
        try check(deniedScopes.isEmpty, "Fresh open without prior child became denial authority")
        try openAttempt(String(repeating: "9", count: 32), status: 403, code: "WORKSPACE_ACCESS_REQUIRED")
        try check(deniedScopes.count == 1 && deniedScopes[0].1 != bindingA, "Denial rebound to another expected child")
        try check(Set(try denialStore.retainedAccountScopes(parentBinding: parent, sessionRef: reference).compactMap { $0["workspaceId"] as? String }) == Set(["A", "B"]), "Different-child denial suspended existing A")
        try openAttempt(bindingA, status: 403, code: "WORKSPACE_ACCESS_REQUIRED")
        try check(deniedScopes.count == 2 && deniedScopes.last?.0 == "A" && deniedScopes.last?.1 == bindingA, "Actual directory denial lost exact target")
        try openAttempt(bindingA, status: 409, code: "WORKSPACE_GRANT_CHANGED")
        try check(deniedScopes.count == 3, "Exact grant-changed denial was ignored")
        let bAfterDenial = try denialStore.open()
        for field in ["lease", "head", "proofEpoch", "profileId", "resourceAccess"] { try check(try bytes(bBeforeDenial[field]!) == bytes(bAfterDenial[field]!), "Late A denial changed active B " + field) }
        try check(denialStore.boundary == bBoundary, "Late A denial fenced current B HTTP delivery")
        try denied { try denialStore.resumeAccountOffline(a, sessionRef: reference, parentBinding: parent) }
        try check(Set(try denialStore.retainedAccountScopes(parentBinding: parent, sessionRef: reference).compactMap { $0["workspaceId"] as? String }) == Set(["B"]), "Authoritatively denied A remained an offline chooser option")
        let observationStore = try FountainOutbox(origin: origin, testingDirectory: directory.appendingPathComponent("directory-observation", isDirectory: true))
        defer { observationStore.close() }
        try observationStore.activateAccount(a, sessionRef: reference, parentBinding: parent); try reconcile(observationStore, "A", bindingA); try observationStore.parkAccount()
        try observationStore.activateAccount(b, sessionRef: reference, parentBinding: parent); try reconcile(observationStore, "B", bindingB)
        let bBeforeObservation = try observationStore.open(), observationBoundary = observationStore.boundary
        var observations = 0
        realm.onWorkspaceObservation = { observed in
            observations += 1
            try check(try observationStore.observeAccountSelection(observed.session, parentBinding: observed.accountBinding) == false, "A observation marked active B affected")
        }
        func observedOpen(_ session: [String: Any]) throws {
            WorkspaceProtocol.handler = { $0.respond(200, try! bytes(["workspace_id": "A", "account_binding": parent, "session": session])) }
            _ = try perform(FountainAccount.Request(["id": UUID().uuidString, "generation": 1, "path": "/api/account/workspaces/A/open", "method": "POST", "bodyBase64": try bytes(["session_binding": parent, "command_id": UUID().uuidString, "expected_binding": NSNull()]).base64EncodedString()]))
        }
        var lowerRole = a, guest = a["member"] as! [String: Any]; guest["role"] = "guest"; lowerRole["member"] = guest
        var oldVerification: WorkspaceProtocol?, oldVerificationResult: Result<[String: Any], FountainAccountError>?
        let oldVerificationDone = DispatchSemaphore(value: 0)
        WorkspaceProtocol.handler = { oldVerification = $0 }
        let oldVerificationEvidence = try queue.sync { try realm.beginWorkspaceEvidence("A") }
        try queue.sync { try realm.request(FountainAccount.Request(["id": "old-role-verification", "generation": 1, "path": "/api/w/A/" + bindingA + "/session"], workspaceVerification: true), workspaceCookie: { nil }, url: { URL(string: $0 + $1)! }) { oldVerificationResult = $0; oldVerificationDone.signal() } }
        for _ in 0..<100 where oldVerification == nil { Thread.sleep(forTimeInterval: 0.005) }
        try check(oldVerification != nil, "Old role verification was not admitted")
        try observedOpen(lowerRole)
        oldVerification!.respond(200, try bytes(a))
        try check(oldVerificationDone.wait(timeout: .now() + 5) == .success, "Delayed old role verification did not finish")
        _ = try oldVerificationResult?.get()
        try check(queue.sync { !realm.currentWorkspaceEvidence("A", oldVerificationEvidence) }, "Old native GET outranked later trusted role observation")
        try denied { try queue.sync { try realm.acceptWorkspaceEvidence("A", oldVerificationEvidence) } }
        try check(observations == 1, "Actual directory role observation was ignored")
        try check(try observationStore.retainedAccountScopes(parentBinding: parent, sessionRef: reference).count == 1, "Changed role retained an old offline seal")
        let observationFile = directory.appendingPathComponent("directory-observation").appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
        try check(try readControl(observationFile, "suspended:" + profile) == nil, "Same child role change permanently bricked scope")
        try denied { try observationStore.resumeAccountOffline(a, sessionRef: reference, parentBinding: parent) }
        let bAfterObservation = try observationStore.open()
        for field in ["lease", "head", "proofEpoch", "profileId", "resourceAccess"] { try check(try bytes(bBeforeObservation[field]!) == bytes(bAfterObservation[field]!), "A role observation changed B " + field) }
        try check(observationStore.boundary == observationBoundary, "A role observation fenced active B")
        try observationStore.parkAccount(); try observationStore.activateAccount(lowerRole, sessionRef: reference, parentBinding: parent)
        try check(try observationStore.open()["resourceAccess"] as? String == "required", "Role change created canonical write proof")
        try check(try observationStore.retainedAccountScopes(parentBinding: parent, sessionRef: reference).allSatisfy { $0["workspaceId"] as? String != "A" }, "Native GET alone cleared role-change offline fence")
        try denied { try observationStore.resumeAccountOffline(lowerRole, sessionRef: reference, parentBinding: parent) }
        try check(try observationStore.accountCanTransmit() == false, "Native GET alone enabled mutation transmission")
        try denied { _ = try observationStore.admitSync(path: "/api/sync", method: "POST", body: sync, sessionRef: reference) }
        try reconcile(observationStore, "A", bindingA)
        try observationStore.parkAccount(); try observationStore.activateAccount(b, sessionRef: reference, parentBinding: parent); try reconcile(observationStore, "B", bindingB)
        let bBeforeReplacement = try observationStore.open(), replacementBoundary = observationStore.boundary
        let newChild = String(repeating: "4", count: 32), observedReplacement = session("A", String(repeating: "4", count: 32))
        try observedOpen(observedReplacement)
        try check(observations == 2 && readControl(observationFile, "suspended:" + profile) as? Bool == true, "Observed new incarnation did not retire old scope before activate")
        try check(try observationStore.retainedAccountScopes(parentBinding: parent, sessionRef: reference).allSatisfy { $0["binding"] as? String != bindingA && $0["binding"] as? String != newChild }, "Directory observation granted a new offline scope")
        try denied { try observationStore.resumeAccountOffline(observedReplacement, sessionRef: reference, parentBinding: parent) }
        let bAfterReplacement = try observationStore.open()
        for field in ["lease", "head", "proofEpoch", "profileId", "resourceAccess"] { try check(try bytes(bBeforeReplacement[field]!) == bytes(bAfterReplacement[field]!), "New A child observation affected B " + field) }
        try check(observationStore.boundary == replacementBoundary, "New A child observation fenced B")
        let raceStore = try FountainOutbox(origin: origin, testingDirectory: directory.appendingPathComponent("directory-order", isDirectory: true))
        defer { raceStore.close() }
        try raceStore.activateAccount(a, sessionRef: reference, parentBinding: parent); try reconcile(raceStore, "A", bindingA)
        var raceObservations = 0
        realm.onWorkspaceObservation = { observed in raceObservations += 1; _ = try raceStore.observeAccountSelection(observed.session, parentBinding: observed.accountBinding) }
        for (round, oldSession) in [a, session("A", String(repeating: "5", count: 32))].enumerated() {
            var held: WorkspaceProtocol?, oldResult: Result<[String: Any], FountainAccountError>?
            let oldDone = DispatchSemaphore(value: 0)
            WorkspaceProtocol.handler = { held = $0 }
            try queue.sync { try realm.request(FountainAccount.Request(["id": "old-open-" + String(round), "generation": 1, "path": "/api/account/workspaces/A/open", "method": "POST", "bodyBase64": try bytes(["session_binding": parent, "command_id": UUID().uuidString, "expected_binding": NSNull()]).base64EncodedString()]), workspaceCookie: { nil }, url: { URL(string: $0 + $1)! }) { oldResult = $0; oldDone.signal() } }
            for _ in 0..<100 where held == nil { Thread.sleep(forTimeInterval: 0.005) }
            try check(held != nil, "Delayed open was not admitted")
            let child = String(repeating: round == 0 ? "5" : "6", count: 32), fresh = session("A", String(repeating: round == 0 ? "5" : "6", count: 32))
            if round == 0 { try observedOpen(fresh) }
            let expectedObservations = raceObservations
            WorkspaceProtocol.handler = { $0.respond(200, try! bytes(fresh)) }
            let verifiedReply = try perform(FountainAccount.Request(["id": "verify-later-" + String(round), "generation": 1, "path": "/api/w/A/" + child + "/session"], workspaceVerification: true))
            let verified = try FountainWorkspacePolicy.verify(Data(base64Encoded: verifiedReply["bodyBase64"] as! String)!, workspace: "A", binding: child, account: parent)
            try queue.sync { try realm.noteWorkspaceVerification("A") }
            try raceStore.parkAccount(); try raceStore.activateAccount(verified.session, sessionRef: reference, parentBinding: parent); try reconcile(raceStore, "A", child)
            held!.respond(200, try bytes(["workspace_id": "A", "account_binding": parent, "session": oldSession]))
            try check(oldDone.wait(timeout: .now() + 5) == .success, "Delayed old caller did not finish")
            _ = try oldResult?.get()
            try check(raceObservations == expectedObservations, "Older success DTO retired a later native verified child")
            try check(try raceStore.open()["resourceAccess"] as? String == "ready" && raceStore.accountCanTransmit(), "Older open damaged current canonical child")
            try check(try raceStore.retainedAccountScopes(parentBinding: parent, sessionRef: reference).contains { $0["binding"] as? String == child }, "Late old response removed current child offline hint")
        }
        // Root-create authority must be checked even with no cached profile row.
        // A page proof can advance the private floor beyond an old workspace.
        for stale in [false, true] {
            let target = directory.appendingPathComponent(stale ? "stale-create-floor" : "fresh-create-floor", isDirectory: true)
            let creationStore = try FountainOutbox(origin: origin, testingDirectory: target); defer { creationStore.close() }
            try creationStore.activateAccount(a, sessionRef: reference, parentBinding: parent)
            let descriptor: [String: Any] = ["id": "page", "access_level": 3, "locked": false, "archived": false, "revision": 1]
            let workspace: [String: Any] = ["workspace_id": "A", "current_member_id": "member-A", "session_binding": bindingA, "access_revision": 1, "data_revision": 1, "pages": [descriptor], "databases": [], "teamspaces": [["id": "general", "access_level": 4]]]
            try creationStore.observeResource(path: "/api/workspace", method: "GET", status: 200, data: bytes(workspace), sessionRef: reference)
            if stale {
                let advanced: [String: Any] = ["workspace_id": "A", "current_member_id": "member-A", "session_binding": bindingA, "access_revision": 2, "data_revision": 2, "page": descriptor, "access_level": 3, "blocks": [], "state": [:], "epoch": "epoch", "seq": 0]
                try creationStore.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 200, data: bytes(advanced), sessionRef: reference)
            }
            try creationStore.parkAccount(); try creationStore.resumeAccountOffline(a, sessionRef: reference, parentBinding: parent); try creationStore.ensureOwner("create-floor", epoch: 11)
            let creationFile = target.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
            try check(try readRecord(creationFile, "profiles", profile) == nil, "Fixture unexpectedly relied on cached profiles row")
            let pendingCreate = localChanges.filter { $0["bucket"] as? String == "localPages" || $0["bucket"] as? String == "snapshots" || (($0["value"] as? [String: Any])?["id"] as? String == "offline-create") }
            let payload = try bytes(["version": 1, "origin": origin, "mode": "active", "changes": pendingCreate]), state = try creationStore.open(), lease = state["lease"] as! String
            try creationStore.stage(lease: lease, txID: "root-create", baseHead: state["head"] as! Int, proofEpoch: state["proofEpoch"] as! Int, part: 0, bytes: payload)
            if stale { try denied { _ = try creationStore.commit(lease: lease, txID: "root-create", baseHead: state["head"] as! Int, proofEpoch: state["proofEpoch"] as! Int, digest: FountainOutbox.hash(payload)) } }
            else { _ = try creationStore.commit(lease: lease, txID: "root-create", baseHead: state["head"] as! Int, proofEpoch: state["proofEpoch"] as! Int, digest: FountainOutbox.hash(payload)); try check(try readRecord(creationFile, "mutations", [profile, "offline-create"]) != nil, "Live cached create authority failed") }
        }
        let before = invalidations
        WorkspaceProtocol.handler = { $0.respond(401, Data("{}".utf8)) }
        _ = try perform(FountainAccount.Request(["id": "lost", "generation": 1, "path": "/api/account/workspaces?session_binding=" + parent]))
        try check(invalidations == before + 1 && storage.values[origin]?.active == nil && storage.values[origin]?.revoke == cookie && storage.markers.contains(origin), "Parent401 failed durable quarantine")
        let fenceQueue = DispatchQueue(label: "native-activation-fence"), fenceMemory = AccountMemory()
        let fenceRealm = FountainAccount(queue: fenceQueue, storage: fenceMemory, protocolClasses: [WorkspaceProtocol.self])
        try fenceQueue.sync { try fenceRealm.configure(origin: origin, generation: 1) }
        defer { fenceQueue.sync { fenceRealm.shutdown() } }
        fenceMemory.values[origin] = FountainAccountCookies(active: cookie, binding: parent, expiresAt: Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000)
        var nativeWorkspaceEpoch = 1, realmLosses = 0, taggedAuthLoss = false
        fenceRealm.onInvalidation = { realmLosses += 1; taggedAuthLoss = fenceRealm.authorizationLost }
        var lateActivation: WorkspaceProtocol?, lateDirectory: WorkspaceProtocol?
        WorkspaceProtocol.handler = { request in if request.request.url!.path.contains("/api/w/") { lateActivation = request } else { lateDirectory = request } }
        let activationDone = DispatchSemaphore(value: 0), directoryDone = DispatchSemaphore(value: 0)
        var activationFailure: String?, directoryStatus: Int?
        try fenceQueue.sync {
            try fenceRealm.request(FountainAccount.Request(["id": "late-A-activation", "generation": 1, "path": "/api/w/A/" + bindingA + "/session"], workspaceVerification: true), workspaceCookie: { nil }, workspaceFence: { nativeWorkspaceEpoch == 1 }, url: { URL(string: $0 + $1)! }) { result in if case .failure(let error) = result { activationFailure = error.code }; activationDone.signal() }
            try fenceRealm.request(FountainAccount.Request(["id": "standalone-directory", "generation": 1, "path": "/api/account/workspaces?session_binding=" + parent]), workspaceCookie: { nil }, url: { URL(string: $0 + $1)! }) { result in if case .success(let reply) = result { directoryStatus = reply["status"] as? Int }; directoryDone.signal() }
        }
        for _ in 0..<100 where lateActivation == nil || lateDirectory == nil { Thread.sleep(forTimeInterval: 0.005) }
        try check(lateActivation != nil && lateDirectory != nil, "Parallel native activation/directory were not admitted")
        let parentEpochBefore = fenceQueue.sync { fenceRealm.privateEpoch }
        fenceQueue.sync { nativeWorkspaceEpoch = 2; fenceRealm.fenceWorkspaceJobs() }
        try check(activationDone.wait(timeout: .now() + 2) == .success && activationFailure == "NATIVE_STALE", "Workspace park did not close old activation")
        lateActivation!.respond(401, Data("{}".utf8)); lateDirectory!.respond(200, Data("{}".utf8))
        try check(directoryDone.wait(timeout: .now() + 2) == .success && directoryStatus == 200, "Workspace park cancelled standalone account directory")
        fenceQueue.sync {}
        try check(fenceMemory.values[origin]?.active == cookie && realmLosses == 0 && fenceQueue.sync { fenceRealm.privateEpoch } == parentEpochBefore, "Late cancelled A401 invalidated current B parent")
        WorkspaceProtocol.handler = { $0.respond(401, Data("{}".utf8)) }
        let currentDone = DispatchSemaphore(value: 0); var currentStatus: Int?
        try fenceQueue.sync { try fenceRealm.request(FountainAccount.Request(["id": "current-B-activation", "generation": 1, "path": "/api/w/B/" + bindingB + "/session"], workspaceVerification: true), workspaceCookie: { nil }, workspaceFence: { nativeWorkspaceEpoch == 2 }, url: { URL(string: $0 + $1)! }) { result in if case .success(let reply) = result { currentStatus = reply["status"] as? Int }; currentDone.signal() } }
        try check(currentDone.wait(timeout: .now() + 2) == .success && currentStatus == 401, "Current parent401 lost actual status metadata")
        try check(taggedAuthLoss && realmLosses == 1 && fenceMemory.values[origin]?.active == nil && fenceMemory.values[origin]?.revoke == cookie, "Current parent401 lacked guarded auth-loss signal")
        let networkQueue = DispatchQueue(label: "account-network-fixture"), networkMemory = AccountMemory()
        let networkRealm = FountainAccount(queue: networkQueue, storage: networkMemory, protocolClasses: [WorkspaceProtocol.self])
        try networkQueue.sync { try networkRealm.configure(origin: origin, generation: 1) }
        defer { networkQueue.sync { networkRealm.shutdown() } }
        for (code, expected) in [(URLError.Code.notConnectedToInternet, "NATIVE_NETWORK_UNREACHABLE"), (.cannotConnectToHost, "NATIVE_NETWORK_UNREACHABLE"), (.cannotFindHost, "NATIVE_NETWORK_UNREACHABLE"), (.dnsLookupFailed, "NATIVE_NETWORK_UNREACHABLE"), (.networkConnectionLost, "NATIVE_NETWORK_UNREACHABLE"), (.serverCertificateUntrusted, "NATIVE_NETWORK"), (.secureConnectionFailed, "NATIVE_NETWORK"), (.clientCertificateRejected, "NATIVE_NETWORK"), (.cancelled, "NATIVE_NETWORK"), (.badServerResponse, "NATIVE_NETWORK"), (.userAuthenticationRequired, "NATIVE_NETWORK"), (.timedOut, "NATIVE_TIMEOUT")] {
            WorkspaceProtocol.handler = { $0.client?.urlProtocol($0, didFailWithError: URLError(code)) }
            let done = DispatchSemaphore(value: 0); var actual: String?
            try networkQueue.sync { try networkRealm.request(FountainAccount.Request(["id": UUID().uuidString, "generation": 1, "path": "/api/account/session"]), workspaceCookie: { nil }, url: { URL(string: $0 + $1)! }) { result in if case .failure(let error) = result { actual = error.code }; done.signal() } }
            try check(done.wait(timeout: .now() + 5) == .success && actual == expected, "TLS/timeout/unreachable classification collapsed")
        }
        var storageFailureReachedNetwork = false
        WorkspaceProtocol.handler = { _ in storageFailureReachedNetwork = true }
        networkMemory.failRead = true
        do {
            try networkQueue.sync { try networkRealm.request(FountainAccount.Request(["id": "storage-failure", "generation": 1, "path": "/api/account/session"]), workspaceCookie: { nil }, url: { URL(string: $0 + $1)! }) { _ in } }
            throw NSError(domain: "IOSMultiworkspace", code: -1)
        } catch let failure as FountainAccountError { try check(failure.code == "NATIVE_STORAGE" && !storageFailureReachedNetwork, "Private vault failure became network-unreachable admission") }
        networkMemory.failRead = false
        var expiredInvalidation = 0
        networkRealm.onInvalidation = { expiredInvalidation += 1 }
        networkMemory.values[origin] = FountainAccountCookies(active: cookie, binding: parent, expiresAt: 1)
        try denied { _ = try networkQueue.sync { try networkRealm.activeCookie(binding: parent) } }
        try check(expiredInvalidation == 1 && networkMemory.markers.contains(origin) && networkMemory.values[origin]?.revoke == cookie, "Expired parent failed durable account invalidation")
        print("iOS multiworkspace production URLSession + SQLite parking/resume: \(checks) checks passed")
    }
}
#if !os(iOS)
@main private enum MultiworkspaceDriver {
    static func main() throws { try IOSMultiworkspaceFixture.run(directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)) }
}
#endif
