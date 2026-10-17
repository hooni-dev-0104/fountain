import XCTest
import UIKit
import WebKit
import SQLite3
import Darwin
import Security
@testable import App

#if DEBUG
// A test-owned, empty document uses the captured application's data store and
// exact local origin. It has no plugins, application scripts or network routes.
private final class FountainQAIndexedDBScheme: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.absoluteString == "capacitor://localhost/__fountain_qa_indexeddb__" else {
            urlSchemeTask.didFailWithError(NSError(domain: "FountainQAIndexedDB", code: 1)); return
        }
        let bytes = Data("<!doctype html><meta charset=utf-8><title>Fountain QA IndexedDB</title><script>globalThis.__fountainQAIndexedDB=true</script>".utf8)
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: bytes.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(bytes); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
// No global URLProtocol registration, TLS exception, shared cookie storage or
// renderer-accessible nonce. Only the opted-in native session installs this.
private final class FountainCloudQAProtocol: URLProtocol, URLSessionDataDelegate, @unchecked Sendable {
    private static let lock = NSLock()
    private static var nonce: String?
    private static var intercepted = 0
    private static var credentialRequests = 0
    private static var logoutRequests = 0
    private static var bodyfulLogoutRequests = 0
    private static var ownedPageReads = 0
    private static var candidates = 0
    private static var fixedMatches = 0
    private static var offline = false
    private static var offlineFailures = 0
    private enum Delivery { case response(HTTPURLResponse), bytes(Data), finished, failed(Int) }
    private let state = NSRecursiveLock()
    private var clientThread: Thread?
    private var deliveries: [Delivery] = []
    private var drainScheduled = false
    private var terminalQueued = false
    private var forwarding: URLSession?
    private var forwardingTask: URLSessionDataTask?
    private var stopped = false
    private var received = 0
    private static let host = "ehnovtfadpkwtubmwltl.supabase.co"
    private static let prefix = "/functions/v1/fountain-api"
    static func install(_ value: String?) {
        lock.lock(); defer { lock.unlock() }
        nonce = value; intercepted = 0; credentialRequests = 0; logoutRequests = 0; bodyfulLogoutRequests = 0; ownedPageReads = 0; candidates = 0; fixedMatches = 0; offline = false; offlineFailures = 0
    }
    static func setOffline(_ value: Bool) { lock.lock(); defer { lock.unlock() }; offline = value }
    static func offlineCount() -> Int { lock.lock(); defer { lock.unlock() }; return offlineFailures }
    static func counts() -> (Int, Int) { lock.lock(); defer { lock.unlock() }; return (intercepted, credentialRequests) }
    static func routingCounts() -> [String: Int] { lock.lock(); defer { lock.unlock() }; return ["protocolCandidates": candidates, "protocolFixedMatches": fixedMatches, "actualSessionDELETE": logoutRequests, "actualSessionDELETEWithBody": bodyfulLogoutRequests, "actualOwnedPageGET": ownedPageReads] }
    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        let matches = url.scheme == "https" && url.host == host && (url.port == nil || url.port == 443) && url.path.hasPrefix(prefix + "/")
        lock.lock(); candidates += 1; if matches { fixedMatches += 1 }; lock.unlock()
        return matches
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        state.lock(); clientThread = Thread.current; state.unlock()
        Self.lock.lock(); let nonce = Self.nonce, offline = Self.offline; if offline { Self.offlineFailures += 1 }; Self.lock.unlock()
        if offline { fail(); return }
        guard let nonce = nonce, let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.percentEncodedPath.hasPrefix(Self.prefix + "/"), url.user == nil, url.password == nil, url.fragment == nil,
              request.value(forHTTPHeaderField: "Origin") == nil, request.value(forHTTPHeaderField: "Authorization") == nil else { fail(); return }
        let path = String(components.percentEncodedPath.dropFirst(Self.prefix.count)) + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        guard path.utf8.count <= 8192, path.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }),
              path.hasPrefix("/api/") || path.hasPrefix("/sites/") || path.hasPrefix("/forms/"),
              let destination = URL(string: "https://" + Self.host + "/functions/v1/fountain-verify/wire") else { fail(); return }
        var wire = request; wire.url = destination; wire.timeoutInterval = min(request.timeoutInterval, 45)
        wire.setValue(nonce, forHTTPHeaderField: "X-Fountain-Verify")
        wire.setValue(path, forHTTPHeaderField: "X-Fountain-Test-Path")
        wire.setValue("1", forHTTPHeaderField: "X-Fountain-Request")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = []; configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 45; configuration.timeoutIntervalForResource = 45
        state.lock(); guard !stopped else { state.unlock(); return }
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        forwarding = session; forwardingTask = session.dataTask(with: wire); let pending = forwardingTask; state.unlock()
        Self.lock.lock(); Self.intercepted += 1
        if path == "/api/session" && request.httpMethod == "POST" { Self.credentialRequests += 1 }
        if path == "/api/session" && request.httpMethod == "DELETE" { Self.logoutRequests += 1; if request.httpBody?.isEmpty == false || request.httpBodyStream != nil { Self.bodyfulLogoutRequests += 1 } }
        if path == "/api/pages/qa-native-shared" && request.httpMethod == "GET" { Self.ownedPageReads += 1 }
        Self.lock.unlock(); pending?.resume()
    }
    override func stopLoading() {
        state.lock(); stopped = true; deliveries.removeAll(); let session = forwarding; forwarding = nil; let pending = forwardingTask; forwardingTask = nil; state.unlock()
        pending?.cancel(); session?.invalidateAndCancel()
    }
    private func enqueue(_ delivery: Delivery, terminal: Bool = false) {
        state.lock()
        guard !stopped, !terminalQueued, let thread = clientThread else { state.unlock(); return }
        if terminal { terminalQueued = true }
        deliveries.append(delivery)
        let schedule = !drainScheduled; drainScheduled = true; state.unlock()
        if schedule { perform(#selector(drainQAEvents), on: thread, with: nil, waitUntilDone: false, modes: [RunLoop.Mode.default.rawValue, RunLoop.Mode.common.rawValue]) }
    }
    @objc private func drainQAEvents() {
        while true {
            state.lock()
            guard Thread.current === clientThread, !stopped, !deliveries.isEmpty else { drainScheduled = false; state.unlock(); return }
            let delivery = deliveries.removeFirst()
            // The recursive lock covers the final client call: a concurrent
            // stop cannot pass the gate between checking and delivering. A
            // terminal queued behind data does not discard earlier data.
            switch delivery {
            case .response(let response): client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            case .bytes(let data): client?.urlProtocol(self, didLoad: data)
            case .finished: stopped = true; client?.urlProtocolDidFinishLoading(self)
            case .failed(let code): stopped = true; client?.urlProtocol(self, didFailWithError: NSError(domain: "FountainCloudQA", code: code))
            }
            state.unlock()
        }
    }
    private func fail() {
        enqueue(.failed(1), terminal: true)
        state.lock(); let session = forwarding; forwarding = nil; let pending = forwardingTask; forwardingTask = nil; state.unlock()
        pending?.cancel(); session?.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil); fail()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, let original = request.url,
              response.url?.scheme == "https", response.url?.host == Self.host, response.url?.path == "/functions/v1/fountain-verify/wire",
              let mapped = HTTPURLResponse(url: original, statusCode: response.statusCode, httpVersion: "HTTP/1.1", headerFields: response.allHeaderFields.reduce(into: [String: String]()) { if let key = $1.key as? String { $0[key] = String(describing: $1.value) } }) else { completionHandler(.cancel); fail(); return }
        state.lock(); let active = !stopped; state.unlock(); guard active else { completionHandler(.cancel); return }
        enqueue(.response(mapped)); completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        state.lock(); received += data.count; let active = !stopped, bounded = received <= 16 * 1024 * 1024; state.unlock()
        guard active else { return }; guard bounded else { fail(); return }; enqueue(.bytes(data))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        state.lock(); let active = !stopped; forwarding = nil; forwardingTask = nil; state.unlock()
        guard active else { return }; enqueue(error == nil ? .finished : .failed(2), terminal: true)
        session.finishTasksAndInvalidate()
    }
}
#endif

// Runs only on a freshly-created Fountain QA Simulator. Fixtures never share a
// server origin, SQLite file or data container with an installed user workspace.
final class FountainNativeTests: XCTestCase {
    private var cleanup: [URL] = []
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["FOUNTAIN_QA"] == "1" && (ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), "Use the dedicated Fountain QA Simulator and scheme")
    }
    override func tearDownWithError() throws {
        for url in cleanup { try? FileManager.default.removeItem(at: url) }; cleanup.removeAll()
    }
    private func encoded(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]) }
    private func json(_ value: Any) throws -> String { String(data: try encoded(value), encoding: .utf8)! }
    private func context() throws -> FountainRecovery.Authority {
        let origin = "https://unit-" + UUID().uuidString.lowercased() + ".invalid"
        return try FountainRecovery.Authority.session(encoded(["authenticated": true, "mode": "accounts", "required": true,
            "workspace_id": "qa-workspace", "cache_binding": "qa-current", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)),
            "member": ["id": "qa-member", "name": "QA", "active": true, "role": "member"]]), origin: origin, reference: "private-test-reference")
    }
    private func source(_ authority: FountainRecovery.Authority, records: [(String, Any, [String: Any], Bool)]) throws -> URL {
        let manager = FileManager.default, support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = support.appendingPathComponent("FountainOutbox", isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent(FountainOutbox.hash(Data(authority.origin.utf8)) + ".sqlite")
        XCTAssertFalse(manager.fileExists(atPath: file.path))
        XCTAssertTrue(manager.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])); cleanup.append(file)
        var db: OpaquePointer?; XCTAssertEqual(sqlite3_open(file.path, &db), SQLITE_OK); defer { sqlite3_close_v2(db) }
        XCTAssertEqual(sqlite3_exec(db, FountainOutbox.schema + "PRAGMA user_version=1; INSERT INTO control(id,value) VALUES('head',x'30');", nil, nil, nil), SQLITE_OK)
        for (index, item) in records.enumerated() {
            let profile = item.2["profileId"] as! String
            let payload: Any = item.3 ? ["op": "put", "bucket": item.0, "key": item.1, "value": item.2] : item.2
            let sql = item.3 ? "INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES('fixture',?, ?,?,?,?)" : "INSERT INTO records(bucket,key,profile_id,value) VALUES(?,?,?,?)"
            var statement: OpaquePointer?; XCTAssertEqual(sqlite3_prepare_v2(db, sql, -1, &statement, nil), SQLITE_OK)
            var parameter: Int32 = 1
            if item.3 { sqlite3_bind_int(statement, parameter, Int32(index)); parameter += 1 }
            for value in [item.0, try json(item.1), profile] { sqlite3_bind_text(statement, parameter, value, -1, transient); parameter += 1 }
            let bytes = try encoded(payload); _ = bytes.withUnsafeBytes { sqlite3_bind_blob(statement, parameter, $0.baseAddress, Int32(bytes.count), transient) }
            XCTAssertEqual(sqlite3_step(statement), SQLITE_DONE); sqlite3_finalize(statement)
            // Synthetic fixture history is explicitly native-qualified. Tests
            // of real attribution exercise commitDelta separately; metadata in
            // a renderer-provided profile never creates this private control.
            let row = sqlite3_last_insert_rowid(db)
            let proofKey = item.3 ? "archiveAuthority:" + String(row) : "recordAuthority:" + item.0 + "|" + (try json(item.1))
            let proof: [String: Any] = ["actor": profile.components(separatedBy: "|").prefix(3).joined(separator: "|"), "profile": profile, "digest": FountainOutbox.hash(bytes), "trust": "confirmed"]
            var attribution: OpaquePointer?
            XCTAssertEqual(sqlite3_prepare_v2(db, "INSERT INTO control(id,value) VALUES(?,?)", -1, &attribution, nil), SQLITE_OK)
            sqlite3_bind_text(attribution, 1, proofKey, -1, transient)
            let metadata = try encoded(proof); _ = metadata.withUnsafeBytes { sqlite3_bind_blob(attribution, 2, $0.baseAddress, Int32(metadata.count), transient) }
            XCTAssertEqual(sqlite3_step(attribution), SQLITE_DONE); sqlite3_finalize(attribution)
        }
        return file
    }
    private func profile(_ authority: FountainRecovery.Authority) -> String { authority.origin + "|qa-workspace|qa-member|old-binding" }
    private func responses(_ authority: FountainRecovery.Authority) throws -> FountainRecovery.Responses {
        let identity: [String: Any] = ["workspace_id": authority.workspace, "current_member_id": authority.member, "session_binding": authority.binding, "access_revision": 1, "data_revision": 10]
        var workspace = identity; workspace["pages"] = []; workspace["databases"] = []
        var page = identity; page["access_level"] = 3; page["epoch"] = "current-epoch"; page["seq"] = 0; page["blocks"] = []; page["state"] = [:]
        page["page"] = ["id": "welcome", "access_level": 3, "locked": false, "archived": false]
        return ["/api/workspace": (200, try encoded(workspace)), "/api/pages/welcome/collaboration": (200, try encoded(page))]
    }
    private func temporary(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Fountain-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]); cleanup.append(root)
        let file = root.appendingPathComponent(name)
        XCTAssertTrue(FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])); return file
    }
    private func handles(_ result: [String: Any]) -> [String] { (result["items"] as! [[String: Any]]).map { $0["handle"] as! String } }

    private func sql(_ file: URL, _ statement: String, _ values: [String] = [], readOnly: Bool = false) throws -> [[String]] {
        var db: OpaquePointer?; XCTAssertEqual(sqlite3_open_v2(file.path, &db, (readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_FULLMUTEX, nil), SQLITE_OK); defer { sqlite3_close_v2(db) }
        sqlite3_busy_timeout(db, 1000)
        var query: OpaquePointer?; XCTAssertEqual(sqlite3_prepare_v2(db, statement, -1, &query, nil), SQLITE_OK); defer { sqlite3_finalize(query) }
        for (index, value) in values.enumerated() { sqlite3_bind_text(query, Int32(index + 1), value, -1, transient) }
        var result: [[String]] = []
        while true {
            let status = sqlite3_step(query)
            if status == SQLITE_DONE { break }
            guard status == SQLITE_ROW else { throw FountainOutboxError.storage }
            result.append((0..<sqlite3_column_count(query)).map { sqlite3_column_text(query, $0).map { String(cString: $0) } ?? "" })
        }
        return result
    }
    private func retainedBytes(_ file: URL) throws -> [[String]] {
        try sql(file, "SELECT 'record',bucket,key,profile_id,hex(value) FROM records UNION ALL SELECT 'recovery',bucket,key,profile_id,hex(value) FROM recovery UNION ALL SELECT 'staging',tx_id,CAST(part AS TEXT),lease,hex(data) FROM staging UNION ALL SELECT 'receipt',tx_id,digest,CAST(head AS TEXT),'' FROM tx_receipts ORDER BY 1,2,3,4,5")
    }
    private func session(_ member: String, _ binding: String) -> [String: Any] {
        ["authenticated": true, "mode": "accounts", "required": true, "workspace_id": "qa-workspace", "cache_binding": binding,
         "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)),
         "member": ["id": member, "active": true, "role": "member"]]
    }
    private func seedOwnedScratch(_ file: URL, _ profile: String, _ tx: String) throws {
        _ = try sql(file, "INSERT INTO staging(tx_id,part,lease,base_head,data) VALUES(?,0,'old-lease',0,x'010203')", [tx])
        _ = try sql(file, "INSERT INTO tx_receipts(tx_id,digest,head) VALUES(?, 'fixture-digest',0)", [tx])
        for kind in ["stagedOwner:", "receiptOwner:"] { _ = try sql(file, "INSERT INTO control(id,value) VALUES(?,CAST(? AS BLOB))", [kind + tx, try json(profile)]) }
    }
    private func operationObserverFixture() throws -> (store: FountainOutbox, file: URL, profile: String, snapshot: [String: Any]) {
        let origin = "https://observer-" + UUID().uuidString.lowercased() + ".invalid"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Fountain-observer-" + UUID().uuidString, isDirectory: true)
        cleanup.append(directory)
        let store = try FountainOutbox(origin: origin, testingDirectory: directory)
        let profile = origin + "|qa-workspace|qa-member|qa-binding"
        let file = directory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
        try store.grant(session("qa-member", "qa-binding"), sessionRef: "private-observer-cookie")
        let page: [String: Any] = ["id": "welcome", "access_level": 3, "locked": false, "archived": false, "revision": 1]
        var workspace: [String: Any] = ["workspace_id": "qa-workspace", "current_member_id": "qa-member", "session_binding": "qa-binding", "access_revision": 4, "data_revision": 7]
        var snapshot = workspace
        workspace["pages"] = [page]; workspace["databases"] = []
        snapshot["page"] = page; snapshot["access_level"] = 3; snapshot["blocks"] = []; snapshot["state"] = [String: Any](); snapshot["epoch"] = "first-epoch"; snapshot["seq"] = 0
        try store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspace), sessionRef: "private-observer-cookie")
        try store.observeResource(path: "/api/pages/welcome/collaboration", method: "GET", status: 200, data: encoded(snapshot), sessionRef: "private-observer-cookie")
        let resource = profile + "|welcome", draft: [String: Any] = ["key": profile + "|welcome", "profileId": profile, "clientId": "test-client", "draft": ["blocks": [["id": "block", "type": "paragraph", "text": "미전송 원본🙂"]]]]
        _ = try sql(file, "INSERT INTO records(bucket,key,profile_id,resource_key,value) VALUES('drafts',?,?,?,CAST(? AS BLOB))", [try json([resource, "test-client"]), profile, resource, try json(draft)])
        return (store, file, profile, snapshot)
    }
    private func observedPageProof(_ file: URL, profile: String) throws -> [String: Any] {
        let rows = try sql(file, "SELECT CAST(value AS TEXT) FROM control WHERE id=?", ["proofs:" + profile])
        let ledger = try JSONSerialization.jsonObject(with: Data(XCTUnwrap(rows.first?.first).utf8)) as! [String: Any]
        return try XCTUnwrap(ledger["page:welcome"] as? [String: Any])
    }
    func testSameCookieNativeRoleChangeFencesActualCacheAndPreservesInput() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Fountain-role-" + UUID().uuidString, isDirectory: true); cleanup.append(directory)
        let origin = "https://role-" + UUID().uuidString.lowercased() + ".invalid", profile = origin + "|qa-workspace|qa-member|role-binding"
        let store = try FountainOutbox(origin: origin, testingDirectory: directory); defer { store.close() }
        let file = directory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
        var owner = session("qa-member", "role-binding"); var member = owner["member"] as! [String: Any]; member["role"] = "owner"; owner["member"] = member
        try store.grant(owner, sessionRef: "private-role-cookie"); try store.ensureOwner("role-unit-owner", epoch: 1)
        let page: [String: Any] = ["id": "private", "title": "Private canonical", "owner_id": "another-actor", "access_level": 4, "locked": false, "archived": false, "revision": 1]
        let envelope: [String: Any] = ["workspace_id": "qa-workspace", "current_member_id": "qa-member", "session_binding": "role-binding", "access_revision": 4, "data_revision": 7]
        var workspace = envelope; workspace["pages"] = [page]; workspace["databases"] = []
        var snapshot = envelope; snapshot["page"] = page; snapshot["epoch"] = "private-epoch"; snapshot["seq"] = 0; snapshot["state"] = ["version": 1, "blocks": [String: Any](), "seen": [String: Any](), "max_clock": 0]; snapshot["blocks"] = []; snapshot["access_level"] = 4
        try store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspace), sessionRef: "private-role-cookie")
        try store.observeResource(path: "/api/pages/private/collaboration", method: "GET", status: 200, data: encoded(snapshot), sessionRef: "private-role-cookie")
        let opened = try store.open(), lease = opened["lease"] as! String, resource = profile + "|private"
        let profileValue: [String: Any] = ["id": profile, "origin": origin, "workspaceId": "qa-workspace", "memberId": "qa-member", "cacheBinding": "role-binding", "session": owner, "workspace": workspace, "validUntil": opened["validUntil"]!, "updatedAt": 1]
        let draft: [String: Any] = ["key": resource, "profileId": profile, "clientId": "role-draft", "draft": ["epoch": "private-epoch", "reason": "pending", "ops": [], "blocks": [["id": "new", "type": "paragraph", "text": "권한 변경 전 미전송 입력🙂"]]]]
        let input: [String: Any] = ["version": 1, "origin": origin, "mode": "active", "changes": [
            ["op": "put", "bucket": "profiles", "key": profile, "value": profileValue],
            ["op": "put", "bucket": "meta", "key": "active", "value": ["id": "active", "profileId": profile]],
            ["op": "put", "bucket": "snapshots", "key": resource, "value": ["key": resource, "profileId": profile, "snapshot": snapshot, "updatedAt": 1]],
            ["op": "put", "bucket": "drafts", "key": [resource, "role-draft"], "value": draft]]]
        let bytes = try encoded(input)
        try store.stage(lease: lease, txID: "role-source", baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, part: 0, bytes: bytes)
        _ = try store.commit(lease: lease, txID: "role-source", baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, digest: FountainOutbox.hash(bytes))
        let ready = try store.open(); XCTAssertEqual(ready["resourceAccess"] as? String, "ready")
        XCTAssertFalse((try store.read(lease: lease, head: ready["head"] as! Int, proofEpoch: ready["proofEpoch"] as! Int, cursor: nil, byteLimit: 1024)["fragments"] as! [Any]).isEmpty)
        let retained = try retainedBytes(file), beforeExpiryOnly = try Data(contentsOf: file)
        var extended = owner; extended["expires_at"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(7200))
        try store.grant(extended, sessionRef: "private-role-cookie"); XCTAssertEqual(try Data(contentsOf: file), beforeExpiryOnly)
        member["role"] = "member"; extended["member"] = member
        try store.grant(extended, sessionRef: "private-role-cookie")
        let fenced = try store.open(); XCTAssertEqual(fenced["identityState"] as? String, "verified"); XCTAssertEqual(fenced["resourceAccess"] as? String, "required")
        XCTAssertEqual(fenced["head"] as? Int, ready["head"] as? Int); XCTAssertGreaterThan(fenced["proofEpoch"] as! Int, ready["proofEpoch"] as! Int)
        XCTAssertEqual(try retainedBytes(file), retained)
        XCTAssertNotEqual(fenced["lease"] as? String, lease)
        XCTAssertThrowsError(try store.read(lease: lease, head: fenced["head"] as! Int, proofEpoch: fenced["proofEpoch"] as! Int, cursor: nil, byteLimit: 1024)) { XCTAssertEqual($0 as? FountainOutboxError, .stale) }
        XCTAssertThrowsError(try store.read(lease: fenced["lease"] as! String, head: fenced["head"] as! Int, proofEpoch: fenced["proofEpoch"] as! Int, cursor: nil, byteLimit: 1024)) { XCTAssertEqual($0 as? FountainOutboxError, .access) }
        workspace["pages"] = []; workspace["access_revision"] = 5; workspace["data_revision"] = 8
        try store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspace), sessionRef: "private-role-cookie")
        try store.observeResource(path: "/api/pages/private/collaboration", method: "GET", status: 404, data: Data(), sessionRef: "private-role-cookie")
        let recovered = try sql(file, "SELECT CAST(value AS TEXT) FROM recovery WHERE bucket='drafts' AND profile_id=?", [profile])
        XCTAssertEqual(recovered.first?.first, try json(draft)); XCTAssertEqual(try sql(file, "SELECT count(*) FROM control WHERE id=?", ["suspended:" + profile])[0][0], "0")
    }
    func testFirstStaleStageRetainsPrivateAttemptForActiveAndQuarantineSettlement() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Fountain-stage-race-" + UUID().uuidString, isDirectory: true); cleanup.append(directory)
        let origin = "https://stage-race-" + UUID().uuidString.lowercased() + ".invalid", profile = origin + "|qa-workspace|qa-member|race-binding"
        let store = try FountainOutbox(origin: origin, testingDirectory: directory); defer { store.close() }
        let file = directory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
        try store.grant(session("qa-member", "race-binding"), sessionRef: "private-race-cookie"); try store.ensureOwner("race-owner", epoch: 1)
        for mode in ["active", "quarantine"] {
            let old = try store.open(), lease = old["lease"] as! String, head = old["head"] as! Int, proof = old["proofEpoch"] as! Int, id = "draft-" + mode
            let put: [String: Any] = ["op": "put", "bucket": "drafts", "key": [profile + "|page", id], "value": ["profileId": profile, "key": profile + "|page", "clientId": id, "draft": ["reason": "pending", "blocks": [["id": "block", "type": "paragraph", "text": "첫 조각 경합 원본🙂"]]]]]
            let retained = try encoded(["version": 1, "origin": origin, "mode": mode, "changes": [put]]), quarantine = try encoded(["version": 1, "origin": origin, "mode": "quarantine", "changes": [put]])
            let bump = "bump-" + mode
            try store.stage(lease: lease, txID: bump, baseHead: head, proofEpoch: proof, part: 0, bytes: quarantine)
            _ = try store.commit(lease: lease, txID: bump, baseHead: head, proofEpoch: proof, digest: FountainOutbox.hash(quarantine))
            let stale = "stale-first-" + mode
            try store.stage(lease: lease, txID: stale, baseHead: head, proofEpoch: proof, part: 0, bytes: retained)
            XCTAssertThrowsError(try store.commit(lease: lease, txID: stale, baseHead: head, proofEpoch: proof, digest: FountainOutbox.hash(retained))) { XCTAssertEqual($0 as? FountainOutboxError, .head) }
            let settled = try store.reconcile(["generation": 1, "phase": "settle", "lease": lease, "journals": [["txId": stale, "digest": FountainOutbox.hash(retained), "baseHead": head, "proofEpoch": proof]]], admissionWatermark: 0, sessionRef: "private-race-cookie")
            XCTAssertEqual((settled["settlements"] as! [[String: Any]])[0]["status"] as? String, "unaccepted")
            XCTAssertThrowsError(try store.commit(lease: lease, txID: stale, baseHead: head, proofEpoch: proof, digest: FountainOutbox.hash(retained))) { XCTAssertEqual($0 as? FountainOutboxError, .conflict) }
            XCTAssertEqual(try sql(file, "SELECT hex(data) FROM staging WHERE tx_id=?", [stale]).first?.first, retained.map { String(format: "%02X", $0) }.joined())
            let fresh = try store.open(), tx = "fresh-" + mode
            try store.stage(lease: lease, txID: tx, baseHead: fresh["head"] as! Int, proofEpoch: fresh["proofEpoch"] as! Int, part: 0, bytes: quarantine)
            _ = try store.commit(lease: lease, txID: tx, baseHead: fresh["head"] as! Int, proofEpoch: fresh["proofEpoch"] as! Int, digest: FountainOutbox.hash(quarantine), quarantineOnly: true)
            XCTAssertEqual(try sql(file, "SELECT CAST(value AS TEXT) FROM recovery WHERE tx_id=?", [tx]).first?.first, try json(put))
            let accepted = try store.reconcile(["generation": 1, "phase": "settle", "lease": lease, "journals": [["txId": tx, "digest": FountainOutbox.hash(quarantine), "baseHead": fresh["head"]!, "proofEpoch": fresh["proofEpoch"]!]]], admissionWatermark: 0, sessionRef: "private-race-cookie")
            XCTAssertEqual((accepted["settlements"] as! [[String: Any]])[0]["status"] as? String, "accepted")
        }
    }
    func testOutboxOperationsPOSTAdvancesProofAndRejectsSequenceRegression() throws {
        let fixture = try operationObserverFixture(); defer { fixture.store.close() }
        let store = fixture.store, before = try retainedBytes(fixture.file), head = try store.open()["head"] as! Int, epoch = try store.proofEpoch()
        var body = fixture.snapshot; body["ack"] = ["client:1", "client:1", "other_2:9007199254740991"]; body["seq"] = 1; body["data_revision"] = 8
        try store.observeResource(path: "/api/pages/welcome/operations", method: "POST", status: 200, data: encoded(body), sessionRef: "private-observer-cookie")
        XCTAssertEqual(try observedPageProof(fixture.file, profile: fixture.profile)["seq"] as? Int, 1)
        XCTAssertGreaterThan(try store.proofEpoch(), epoch)
        XCTAssertEqual(try store.open()["head"] as? Int, head)
        let currentEpoch = try store.proofEpoch()
        try store.observeResource(path: "/api/pages/welcome/operations", method: "POST", status: 200, data: encoded(body), sessionRef: "private-observer-cookie")
        XCTAssertEqual(try store.proofEpoch(), currentEpoch)
        body["seq"] = 0; body["data_revision"] = 9
        XCTAssertThrowsError(try store.observeResource(path: "/api/pages/welcome/operations", method: "POST", status: 200, data: encoded(body), sessionRef: "private-observer-cookie")) { XCTAssertEqual($0 as? FountainOutboxError, .stale) }
        XCTAssertEqual(try store.proofEpoch(), currentEpoch)
        body["epoch"] = "replacement-epoch"; body["ack"] = []
        try store.observeResource(path: "/api/pages/welcome/operations", method: "POST", status: 200, data: encoded(body), sessionRef: "private-observer-cookie")
        let replacement = try observedPageProof(fixture.file, profile: fixture.profile)
        XCTAssertEqual(replacement["epoch"] as? String, "replacement-epoch"); XCTAssertEqual(replacement["seq"] as? Int, 0)
        XCTAssertEqual(try retainedBytes(fixture.file), before)
    }
    func testOutboxDeniedWritesPreserveReadProofAndInput() throws {
        let fixture = try operationObserverFixture(); defer { fixture.store.close() }
        let before = try retainedBytes(fixture.file), proof = try json(observedPageProof(fixture.file, profile: fixture.profile)), epoch = try fixture.store.proofEpoch()
        for status in [201, 204, 400, 401, 403, 404, 409, 423, 500] {
            XCTAssertNil(FountainOutbox.observedResource(path: "/api/pages/welcome/operations", method: "POST", status: status))
            try fixture.store.observeResource(path: "/api/pages/welcome/operations", method: "POST", status: status, data: Data(), sessionRef: "unrelated-cookie")
        }
        XCTAssertEqual(try json(observedPageProof(fixture.file, profile: fixture.profile)), proof)
        XCTAssertEqual(try fixture.store.proofEpoch(), epoch); XCTAssertEqual(try retainedBytes(fixture.file), before)
        XCTAssertEqual(try sql(fixture.file, "SELECT count(*) FROM tombstones")[0][0], "0")
        XCTAssertEqual(try fixture.store.open()["identityState"] as? String, "verified")
    }
    func testOutboxMalformedOperationACKIsRepairableWithoutPurgingInput() throws {
        let fixture = try operationObserverFixture(); defer { fixture.store.close() }
        let before = try retainedBytes(fixture.file)
        let invalid: [Any] = [NSNull(), true, "client:1", [1], ["client:01"], ["client:9007199254740992"], Array(repeating: "client:1", count: 1001)]
        for ack in invalid {
            var body = fixture.snapshot; body["ack"] = ack
            XCTAssertThrowsError(try fixture.store.observeResource(path: "/api/pages/welcome/operations", method: "POST", status: 200, data: encoded(body), sessionRef: "private-observer-cookie")) { XCTAssertEqual($0 as? FountainOutboxError, .access) }
            let marker = try observedPageProof(fixture.file, profile: fixture.profile)
            XCTAssertEqual(marker["invalid"] as? Bool, true); XCTAssertNil(marker["denied"])
            XCTAssertEqual(try retainedBytes(fixture.file), before)
            XCTAssertEqual(try sql(fixture.file, "SELECT count(*) FROM tombstones")[0][0], "0")
            try fixture.store.observeResource(path: "/api/pages/welcome/collaboration", method: "GET", status: 200, data: encoded(fixture.snapshot), sessionRef: "private-observer-cookie")
            XCTAssertEqual(try observedPageProof(fixture.file, profile: fixture.profile)["seq"] as? Int, 0)
        }
    }
    func testOutboxOperationPOSTRequiresPrivateCookieAndExactScope() throws {
        let fixture = try operationObserverFixture(); defer { fixture.store.close() }
        let before = try retainedBytes(fixture.file), epoch = try fixture.store.proofEpoch()
        var body = fixture.snapshot; body["ack"] = ["client:1"]; body["seq"] = 1; body["data_revision"] = 8
        XCTAssertThrowsError(try fixture.store.observeResource(path: "/api/pages/welcome/operations", method: "POST", status: 200, data: encoded(body), sessionRef: "unrelated-cookie")) { XCTAssertEqual($0 as? FountainOutboxError, .stale) }
        XCTAssertEqual(try fixture.store.proofEpoch(), epoch)
        for path in ["x/api/pages/welcome/operations", "/api/pages/%77elcome/operations", "/api/pages/welcome/operations?q=1"] {
            XCTAssertNil(FountainOutbox.canonicalResource(path: path, method: "POST"))
            try fixture.store.observeResource(path: path, method: "POST", status: 200, data: encoded(body), sessionRef: "private-observer-cookie")
        }
        XCTAssertEqual(try fixture.store.proofEpoch(), epoch)
        for field in ["workspace_id", "current_member_id", "session_binding"] {
            var foreign = body; foreign[field] = "another-scope"
            XCTAssertThrowsError(try fixture.store.observeResource(path: "/api/pages/welcome/operations", method: "POST", status: 200, data: encoded(foreign), sessionRef: "private-observer-cookie")) { XCTAssertEqual($0 as? FountainOutboxError, .access) }
            try fixture.store.observeResource(path: "/api/pages/welcome/collaboration", method: "GET", status: 200, data: encoded(fixture.snapshot), sessionRef: "private-observer-cookie")
        }
        XCTAssertEqual(try retainedBytes(fixture.file), before)
    }
    func testPassiveAuthRetentionFreshBindingFloorAndActorOnlyLogout() throws {
        let authority = try context(), origin = authority.origin
        let a1 = origin + "|qa-workspace|A|first", a2 = origin + "|qa-workspace|A|second", b = origin + "|qa-workspace|B|first"
        func draft(_ profile: String) -> [String: Any] { ["key": profile + "|welcome", "profileId": profile, "clientId": "first", "draft": ["blocks": [["id": "x", "type": "paragraph", "text": "미전송🙂"]]]] }
        let file = try source(authority, records: [("drafts", [a1 + "|welcome", "first"], draft(a1), false), ("drafts", [a2 + "|welcome", "first"], draft(a2), true), ("drafts", [b + "|welcome", "first"], draft(b), false)])
        try seedOwnedScratch(file, a1, "a-owned"); try seedOwnedScratch(file, b, "b-owned")
        _ = try sql(file, "INSERT INTO staging(tx_id,part,lease,base_head,data) VALUES('legacy-unknown',0,'legacy',0,x'ff')")
        let store = try FountainOutbox(origin: origin); defer { store.close() }
        try store.grant(session("A", "first"), sessionRef: "cookie-a1")
        try store.ensureOwner("first-webview", epoch: 1)
        let initial = try store.open(), before = try retainedBytes(file), oldBoundary = store.boundary
        XCTAssertEqual(initial["resourceAccess"] as? String, "required")
        XCTAssertThrowsError(try store.read(lease: initial["lease"] as! String, head: initial["head"] as! Int, proofEpoch: initial["proofEpoch"] as! Int, cursor: nil, byteLimit: 1024))
        try store.validateSession("cookie-a1", eligible: false)
        XCTAssertNotEqual(oldBoundary, store.boundary); XCTAssertEqual(try retainedBytes(file), before)
        try store.ensureOwner("second-webview", epoch: 2)
        XCTAssertEqual(try store.open()["identityState"] as? String, "blocked")
        XCTAssertThrowsError(try store.grant(session("A", "first"), sessionRef: "cookie-a1"))
        let blocked = try store.open()
        XCTAssertThrowsError(try store.stage(lease: blocked["lease"] as! String, txID: "late", baseHead: blocked["head"] as! Int, proofEpoch: blocked["proofEpoch"] as! Int, part: 0, bytes: Data("{}".utf8)))
        try store.grant(session("A", "second"), sessionRef: "cookie-a2")
        try store.ensureOwner("second-webview", epoch: 3)
        XCTAssertEqual(try retainedBytes(file), before)
        XCTAssertEqual(try store.open()["resourceAccess"] as? String, "required")
        // A query-bearing response cannot anchor a fresh native grant.
        let workspace: [String: Any] = ["workspace_id": "qa-workspace", "current_member_id": "A", "session_binding": "second", "access_revision": 5, "data_revision": 9, "pages": [], "databases": []]
        try store.observeResource(path: "/api/workspace?q=1", method: "GET", status: 200, data: encoded(workspace), sessionRef: "cookie-a2")
        XCTAssertEqual(try store.open()["resourceAccess"] as? String, "required")
        try store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: encoded(workspace), sessionRef: "cookie-a2")
        let anchored = try sql(file, "SELECT CAST(value AS TEXT) FROM control WHERE id='identity'")[0][0]
        XCTAssertTrue(anchored.contains("\"needsFloor\":false"))
        let stable = store.boundary, head = try store.open()["head"] as! Int
        try store.grant(session("A", "second"), sessionRef: "cookie-a2")
        XCTAssertEqual(store.boundary, stable); XCTAssertEqual(try store.open()["head"] as? Int, head)
        XCTAssertNil(try store.actorForLogout(reference: "unrelated-cookie"))
        let actor = try XCTUnwrap(store.actorForLogout(reference: "cookie-a2"))
        try store.eraseActor(actor)
        XCTAssertEqual(try sql(file, "SELECT count(*) FROM records WHERE profile_id=?", [b])[0][0], "1")
        XCTAssertEqual(try sql(file, "SELECT count(*) FROM records WHERE profile_id=?", [a1])[0][0], "0")
        XCTAssertEqual(try sql(file, "SELECT count(*) FROM recovery WHERE profile_id=?", [a2])[0][0], "0")
        XCTAssertEqual(try sql(file, "SELECT tx_id FROM staging ORDER BY tx_id").map { $0[0] }, ["b-owned", "legacy-unknown"])
        XCTAssertEqual(try sql(file, "SELECT tx_id FROM tx_receipts").map { $0[0] }, ["b-owned"])
        XCTAssertThrowsError(try store.grant(session("A", "second"), sessionRef: "cookie-a2"))
    }
    func testActorEraseFailureRollsBackAllSourceAndUnknownActorIsOpaque() throws {
        let authority = try context(), own = authority.origin + "|qa-workspace|A|first", resource = own + "|welcome"
        let draft: [String: Any] = ["key": resource, "profileId": own, "clientId": "first", "draft": ["blocks": [["id": "x", "type": "paragraph", "text": "rollback"]]]]
        let file = try source(authority, records: [("drafts", [resource, "first"], draft, false), ("drafts", [resource, "wrapped"], draft, true)])
        let store = try FountainOutbox(origin: authority.origin); defer { store.close() }
        XCTAssertNil(try store.actorForLogout(reference: "cookie"))
        try store.grant(session("A", "first"), sessionRef: "cookie")
        let actor = try XCTUnwrap(store.actorForLogout(reference: "cookie")), before = try retainedBytes(file)
        _ = try sql(file, "CREATE TRIGGER fail_erase BEFORE DELETE ON recovery BEGIN SELECT RAISE(ABORT,'QA rollback'); END")
        XCTAssertThrowsError(try store.eraseActor(actor))
        XCTAssertEqual(try retainedBytes(file), before)
        XCTAssertEqual(try sql(file, "SELECT count(*) FROM tombstones")[0][0], "0")
    }
    func testReceiptAcknowledgementRequiresExactNativeOwnerAndPreservesLegacy() throws {
        let authority = try context(), own = authority.origin + "|qa-workspace|A|first"
        let file = try source(authority, records: []), digest = String(repeating: "a", count: 64)
        try seedOwnedScratch(file, own, "owned")
        _ = try sql(file, "UPDATE tx_receipts SET digest=?", [digest])
        _ = try sql(file, "INSERT INTO control(id,value) VALUES('receiptProof:owned',x'30')")
        _ = try sql(file, "INSERT INTO tx_receipts(tx_id,digest,head) VALUES('legacy',?,0)", [digest])
        _ = try sql(file, "INSERT INTO control(id,value) VALUES('receiptProof:legacy',x'30')")
        _ = try sql(file, "INSERT INTO staging(tx_id,part,lease,base_head,data) VALUES('legacy',0,'opaque',0,x'ff')")
        let store = try FountainOutbox(origin: authority.origin); defer { store.close() }
        try store.grant(session("A", "first"), sessionRef: "cookie-a")
        try store.ensureOwner("a", epoch: 1)
        let first = try store.open(), before = try retainedBytes(file)
        try store.stage(lease: first["lease"] as! String, txID: "owned", baseHead: 0, proofEpoch: 0, part: 0, bytes: Data("{}".utf8))
        XCTAssertEqual(try store.commit(lease: first["lease"] as! String, txID: "owned", baseHead: 0, proofEpoch: 0, digest: digest)["txId"] as? String, "owned")
        XCTAssertEqual(try retainedBytes(file), before)
        try store.grant(session("B", "first"), sessionRef: "cookie-b")
        try store.ensureOwner("b", epoch: 2)
        let second = try store.open(), lease = second["lease"] as! String
        XCTAssertThrowsError(try store.stage(lease: lease, txID: "owned", baseHead: 0, proofEpoch: 0, part: 0, bytes: Data("{}".utf8)))
        XCTAssertThrowsError(try store.commit(lease: lease, txID: "owned", baseHead: 0, proofEpoch: 0, digest: digest))
        try store.stage(lease: lease, txID: "legacy", baseHead: 0, proofEpoch: 0, part: 0, bytes: Data("{}".utf8))
        XCTAssertEqual(try store.commit(lease: lease, txID: "legacy", baseHead: 0, proofEpoch: 0, digest: digest)["txId"] as? String, "legacy")
        XCTAssertEqual(try retainedBytes(file), before)
    }

    func testReadonlyNativeRoundtripRawWrappedAndActorIsolation() throws {
        let authority = try context(), own = profile(authority), resource = own + "|welcome"
        let draft: [String: Any] = ["key": resource, "profileId": own, "clientId": "first", "draft": ["blocks": [["id": "original", "type": "paragraph", "text": "한글🙂 <img src=x>", "rich_text": [["text": "한글🙂 <img src=x>", "marks": ["bold": true]]]]]]]
        var wrapped = draft; wrapped["clientId"] = "second"
        var foreign = draft; foreign["profileId"] = authority.origin + "|qa-workspace|another-member|old-binding"
        let file = try source(authority, records: [("drafts", [resource, "first"], draft, false), ("drafts", [resource, "second"], wrapped, true), ("drafts", [resource, "foreign"], foreign, false)])
        let before = try Data(contentsOf: file), reader = try FountainRecovery(authority: authority); defer { reader.close() }
        let inventory = try reader.inventory(authority, cursor: nil, count: 100), chosen = handles(inventory)
        XCTAssertEqual(chosen.count, 2)
        let permissions = try responses(authority)
        let prepared = try reader.prepare(chosen, other: authority, responses: permissions, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: temporary)
        XCTAssertEqual(prepared["readyCount"] as? Int, 2); XCTAssertEqual(prepared["blockedCount"] as? Int, 0)
        let files = try reader.saveFiles(prepared["exportToken"] as! String, handles: chosen, other: authority, responses: permissions)
        XCTAssertEqual(files.count, 1)
        let output = try JSONSerialization.jsonObject(with: Data(contentsOf: files[0])) as! [String: Any]
        XCTAssertEqual(output["format"] as? String, "fountain-recovery-v2"); XCTAssertEqual(output["source_binding"] as? String, "old-binding")
        let drafts = output["drafts"] as! [[String: Any]]; XCTAssertEqual(drafts.count, 2)
        XCTAssertEqual(((drafts[0]["draft"] as! [String: Any])["blocks"] as! [[String: Any]])[0]["text"] as? String, "한글🙂 <img src=x>")
        XCTAssertEqual(try Data(contentsOf: file), before)
    }
    func testMalformedMetadataDoesNotExportAndCounterOnlyChangeIsAllowed() throws {
        let authority = try context(), own = profile(authority), resource = own + "|welcome"
        let valid: [String: Any] = ["key": resource, "profileId": own, "clientId": "valid", "draft": ["blocks": [["id": "valid", "type": "paragraph", "text": "보존"]]]]
        let bad: [String: Any] = ["key": resource, "profileId": own, "clientId": "bad", "draft": ["reason": ["provider_key": "fixture-secret"], "blocks": [["id": "bad", "type": "paragraph", "text": "unsafe"]]]]
        _ = try source(authority, records: [("drafts", [resource, "valid"], valid, false), ("drafts", [resource, "bad"], bad, true)])
        let reader = try FountainRecovery(authority: authority); defer { reader.close() }
        let chosen = handles(try reader.inventory(authority, cursor: nil, count: 100)), original = try responses(authority)
        let prepared = try reader.prepare(chosen, other: authority, responses: original, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: temporary)
        XCTAssertEqual(prepared["readyCount"] as? Int, 1); XCTAssertEqual(prepared["blockedCount"] as? Int, 1)
        var refreshed: FountainRecovery.Responses = [:]
        for (path, response) in original { var body = try JSONSerialization.jsonObject(with: response.1) as! [String: Any]; body["data_revision"] = 99; refreshed[path] = (200, try encoded(body)) }
        let files = try reader.saveFiles(prepared["exportToken"] as! String, handles: chosen, other: authority, responses: refreshed)
        XCTAssertFalse(String(data: try Data(contentsOf: files[0]), encoding: .utf8)!.contains("fixture-secret"))
        var denied = refreshed; denied["/api/pages/welcome/collaboration"] = (403, Data("{}".utf8))
        XCTAssertThrowsError(try reader.saveFiles(prepared["exportToken"] as! String, handles: chosen, other: authority, responses: denied))
    }
    func testAbsentNativeSourceCreatesNothing() throws {
        let authority = try context(), manager = FileManager.default, support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
        let file = support.appendingPathComponent("FountainOutbox").appendingPathComponent(FountainOutbox.hash(Data(authority.origin.utf8)) + ".sqlite")
        let reader = try FountainRecovery(authority: authority); defer { reader.close() }
        XCTAssertEqual(handles(try reader.inventory(authority, cursor: nil, count: 10)).count, 0); XCTAssertFalse(manager.fileExists(atPath: file.path))
    }
    func testReadableOverflowIsLosslessAndDeterministicAcrossPreparation() throws {
        let authority = try context(), own = profile(authority), resource = own + "|welcome", text = String(repeating: "🙂", count: 110000)
        let blocks: [[String: Any]] = [["id": "large", "type": "paragraph", "text": text]]
        let value: [String: Any] = ["key": resource, "profileId": own, "clientId": "large", "draft": ["blocks": blocks]]
        _ = try source(authority, records: [("drafts", [resource, "large"], value, true)])
        let reader = try FountainRecovery(authority: authority); defer { reader.close() }
        let chosen = handles(try reader.inventory(authority, cursor: nil, count: 100)), permissions = try responses(authority)
        let first = try reader.prepare(chosen, other: authority, responses: permissions, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: temporary)
        let firstURLs = try reader.saveFiles(first["exportToken"] as! String, handles: chosen, other: authority, responses: permissions)
        let firstBytes = try firstURLs.map { try Data(contentsOf: $0) }
        let second = try reader.prepare(chosen, other: authority, responses: permissions, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: temporary)
        let secondURLs = try reader.saveFiles(second["exportToken"] as! String, handles: chosen, other: authority, responses: permissions)
        XCTAssertEqual(firstBytes, try secondURLs.map { try Data(contentsOf: $0) })
        var reconstructed = ""
        for bytes in firstBytes {
            let file = try JSONSerialization.jsonObject(with: bytes) as! [String: Any], content = file["blocks"] as! [[String: Any]]
            reconstructed += content.filter { $0["type"] as? String == "code" }.map { $0["text"] as! String }.joined()
        }
        XCTAssertEqual(reconstructed, try json(["blocks": blocks]))
        XCTAssertEqual((first["files"] as! [[String: Any]])[0]["format"] as? String, "readable-body")
    }
    func testTypedNestedMetadataAndBothPreviousPropertyLocationsStayBlocked() throws {
        let authority = try context(), own = profile(authority)
        func record(_ id: String, properties: [String: Any], base: [String: Any]) -> [String: Any] {
            ["id": id, "profileId": own, "resourceKey": own + "|database|projects", "operation": ["id": id, "kind": "row.patch", "database_id": "projects", "target_id": "row-one", "depends_on": [], "body": ["properties": properties], "base": base]]
        }
        let good = record("good", properties: ["name": "새 이름"], base: [:])
        let nested = record("nested", properties: ["name": ["provider": ["api_key": "fixture-secret"]]], base: [:])
        let oldFields = record("old-fields", properties: ["name": "보류"], base: ["fields": ["properties": ["related": ["hidden-row"]]]])
        let both = record("both", properties: ["name": "보류"], base: ["fields": ["properties": ["related": ["hidden-row"]]], "properties": ["name": "이전 이름"]])
        _ = try source(authority, records: [good, nested, oldFields, both].map { ("mutations", [own, $0["id"] as! String], $0, true) })
        let reader = try FountainRecovery(authority: authority); defer { reader.close() }
        let chosen = handles(try reader.inventory(authority, cursor: nil, count: 100))
        var permissions = try responses(authority)
        let db: [String: Any] = ["workspace_id": authority.workspace, "current_member_id": authority.member, "session_binding": authority.binding, "access_revision": 1, "data_revision": 10,
            "database": ["id": "projects", "access_level": 3, "can_create_row": true, "properties": [["id": "name", "type": "title"], ["id": "related", "type": "relation"]]],
            "rows": [["id": "row-one", "database_id": "projects", "access_level": 3, "properties": ["name": "현재"]]]]
        permissions["/api/databases/projects"] = (200, try encoded(db))
        let prepared = try reader.prepare(chosen, other: authority, responses: permissions, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: temporary)
        XCTAssertEqual(prepared["readyCount"] as? Int, 1); XCTAssertEqual(prepared["blockedCount"] as? Int, 3)
        let files = try reader.saveFiles(prepared["exportToken"] as! String, handles: chosen, other: authority, responses: permissions)
        let text = String(data: try Data(contentsOf: files[0]), encoding: .utf8)!
        XCTAssertFalse(text.contains("fixture-secret")); XCTAssertFalse(text.contains("hidden-row")); XCTAssertTrue(text.contains("새 이름"))
    }

    @MainActor private func webView() async throws -> WKWebView {
        for _ in 0..<100 {
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene, let controller = scene.windows.first?.rootViewController as? FountainBridgeViewController, let webView = controller.webView, webView.url?.scheme == "capacitor" { return webView }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NSError(domain: "FountainQA", code: 1)
    }
    @MainActor private func script(_ body: String, arguments: [String: Any] = [:]) async throws -> Any {
        let view = try await webView()
        return try await script(view: view, body, arguments: arguments)
    }
    @MainActor private func script(view: WKWebView, _ body: String, arguments: [String: Any] = [:]) async throws -> Any {
        return try await withCheckedThrowingContinuation { continuation in view.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { continuation.resume(with: $0) } }
    }
    @MainActor func testActualBundledBridgeAndPrivateAssetGate() async throws {
        let view = try await webView(); XCTAssertEqual(view.url?.host, "localhost")
        var configuration: [String: Any] = [:]
        for _ in 0..<100 {
            if let value = try? await script("if (!globalThis.Capacitor?.isPluginAvailable('FountainNative')) return null; const bridge=Capacitor.registerPlugin('FountainNative'); const c=await bridge.getConfiguration(); let code='';try{await bridge.outboxOpen({generation:c.generation});}catch(e){code=e.code;}return {outbox:c.outboxEnabled,recovery:c.recoveryEnabled,code};"), let result = value as? [String: Any] { configuration = result; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertEqual(configuration["outbox"] as? Bool, false); XCTAssertEqual(configuration["recovery"] as? Bool, true); XCTAssertEqual(configuration["code"] as? String, "OUTBOX_DISABLED")
        let marker = "Fountain-QA-private-canary", privateFile = try temporary("private-canary.txt")
        try Data(marker.utf8).write(to: privateFile)
        for prefix in ["/_capacitor_file_", "/%5Fcapacitor%5Ffile%5F", "/%255Fcapacitor%255Ffile%255F", "/_capacitor_http_interceptor_"] {
            let result = try await script("try{const r=await fetch('capacitor://localhost'+prefix+path);return {ok:r.ok,text:await r.text()};}catch(e){return {ok:false,text:''};}", arguments: ["prefix": prefix, "path": privateFile.path]) as! [String: Any]
            XCTAssertEqual(result["ok"] as? Bool, false); XCTAssertFalse((result["text"] as? String ?? "").contains(marker))
        }
    }
    func testNativeSupabaseURLRoutingPreservesOriginAndLogicalPathPolicy() throws {
        let project = "https://ehnovtfadpkwtubmwltl.supabase.co", prefix = "/functions/v1/fountain-api"
        XCTAssertEqual(try FountainNative.validOrigin(project + ":443/"), project)
        XCTAssertEqual(try FountainNative.validPath("/api/pages/%ED%95%9C%EA%B8%80?raw=%2F&next=a%20b"), "/api/pages/한글")
        for origin in [project, project + ":443", project + "/", "https://abcdefghijklmnopqrst.supabase.co"] {
            for path in ["/api/session", "/api/pages/한글🙂?q=%ED%95%9C%EA%B8%80&raw=%2F", "/api/attachments/a/download", "/api/backup?job_id=00000000-0000-0000-0000-000000000001"] {
                let url = try FountainNative.requestURL(origin: origin, path: path)
                let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
                XCTAssertEqual(url.host, URL(string: origin)?.host)
                XCTAssertNil(url.port)
                XCTAssertEqual(url.path, prefix + path.split(separator: "?", maxSplits: 1).first!)
                XCTAssertEqual(components.percentEncodedQuery, path.contains("?") ? String(path.split(separator: "?", maxSplits: 1).last!) : nil)
            }
        }
        for origin in ["https://example.com", "https://127.0.0.1:61602", project + ":8443",
                       "https://ehnovtfadpkwtubmwltl.supabase.co.example.com", "https://evil-supabase.co",
                       "https://abcdefghijklmnopqrs.supabase.co", "https://abcdefghijklmnopqrstu.supabase.co",
                       "https://abcdefghijklmnopqrs-.supabase.co"] {
            let url = try FountainNative.requestURL(origin: origin, path: "/api/session?x=1")
            XCTAssertEqual(url.path, "/api/session"); XCTAssertEqual(url.query, "x=1")
            XCTAssertEqual(url.port, URL(string: origin)?.port)
        }
        for origin in ["http://example.com", "https://user:password@ehnovtfadpkwtubmwltl.supabase.co",
                       "https://ehnovtfadpkwtubmwltl.supabase.co/functions/v1/fountain-api", project + "?key=1", project + "#fragment"] {
            XCTAssertThrowsError(try FountainNative.requestURL(origin: origin, path: "/api/session"))
        }
        for path in ["https://evil.invalid/api/session", "//evil.invalid/api/session", "/functions/v1/fountain-api/api/session",
                     "/api/../session", "/api/%252e%252e/session", "/api/%73ession", "/api/session#fragment", "/api/session\n"] {
            XCTAssertThrowsError(try FountainNative.requestURL(origin: project, path: path), path)
        }
    }

#if DEBUG
    private func cloudSessionKeychainStatus() -> OSStatus {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "dev.fountain.workspace") + ".native-session",
            kSecAttrAccount as String: "https://ehnovtfadpkwtubmwltl.supabase.co",
            kSecAttrSynchronizable as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: false, kSecReturnAttributes as String: false,
            kSecReturnRef as String: false, kSecReturnPersistentRef as String: false,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail
        ]
        return SecItemCopyMatching(query as CFDictionary, nil)
    }
    func testCloudKeychainEligibility() throws {
        let status = cloudSessionKeychainStatus()
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let result = documents.appendingPathComponent("fountain-cloud-keychain-status.json")
        try JSONSerialization.data(withJSONObject: ["status": Int(status)], options: [.sortedKeys]).write(to: result, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: result.path)
        XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound, "Simulator Keychain eligibility failed; inspect numeric OSStatus evidence")
    }
    @MainActor private func freshCloudView(clearOrigin: Bool) throws {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene, let window = scene.windows.first,
              let controller = UIStoryboard(name: "Main", bundle: Bundle.main).instantiateInitialViewController() as? FountainBridgeViewController else { throw NSError(domain: "FountainCloudQA", code: 3) }
        (window.rootViewController as? FountainBridgeViewController)?.shutdownNative()
        if clearOrigin { UserDefaults.standard.removeObject(forKey: "FountainNative.origin") }
        window.rootViewController = controller; window.makeKeyAndVisible(); controller.loadViewIfNeeded()
    }
    @MainActor private func waitCloud(_ body: String, arguments: [String: Any] = [:], attempts: Int = 180) async throws {
        for _ in 0..<attempts {
            if (try? await script(body, arguments: arguments)) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw NSError(domain: "FountainCloudQA", code: 4)
    }
    @MainActor private func detachCloudDataStore() throws -> WKWebsiteDataStore {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene, let window = scene.windows.first,
              let controller = window.rootViewController as? FountainBridgeViewController, let view = controller.webView,
              view.url?.scheme == "capacitor", view.url?.host == "localhost", view.url?.port == nil else { throw NSError(domain: "FountainQAIndexedDB", code: 2) }
        let store = view.configuration.websiteDataStore
        controller.shutdownNative(); view.stopLoading(); view.removeFromSuperview()
        window.rootViewController = UIViewController(); window.makeKeyAndVisible()
        return store
    }
    @MainActor private func evictOwnedCloudIndexedDB(workspace: String, expected: String, evidence: inout [String: Any]) async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["FOUNTAIN_QA"] == "1", environment["FOUNTAIN_OUTBOX_QA"] == "1", (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA") else { throw NSError(domain: "FountainQAIndexedDB", code: 3) }
        // WKWebView.url can already be the bundled navigation while its JS
        // main frame is still about:blank. Wait for the actual owned document.
        var original: [String: Any]?
        for _ in 0..<100 {
            if let value = try? await script("const source=new URL(location.href);if(source.protocol!=='capacitor:'||source.hostname!=='localhost'||source.port!==''||source.username!==''||source.password!==''||!document.querySelector('#app #main')||typeof globalThis.FountainNativeStorage?.close!=='function')return null;if(typeof closeDocument==='function')closeDocument();if(typeof closeMutations==='function')closeMutations();globalThis.FountainNativeStorage.close();return {origin:location.origin,adapterClosed:true};"), let value = value as? [String: Any] { original = value; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard let original, let originalOrigin = original["origin"] as? String,
              ["capacitor://localhost", "null"].contains(originalOrigin) else { throw NSError(domain: "FountainQAIndexedDB", code: 8) }
        evidence["indexedDBAdapterClosed"] = original["adapterClosed"] as? Bool == true
        let store = try detachCloudDataStore()
        evidence["indexedDBActualStorePersistent"] = store.isPersistent
        // WebKit's record API can omit custom-scheme IndexedDB. Record only
        // bounded counts/allowlisted origin labels, and never remove broadly.
        var listed: [WKWebsiteDataRecord]?
        store.fetchDataRecords(ofTypes: [WKWebsiteDataTypeIndexedDBDatabases]) { listed = $0 }
        for _ in 0..<40 { if listed != nil { break }; try await Task.sleep(nanoseconds: 50_000_000) }
        evidence["indexedDBRecordAPIReturned"] = listed != nil
        evidence["indexedDBRecordCount"] = min(listed?.count ?? 0, 100000)
        evidence["indexedDBLocalRecordCount"] = min(listed?.filter { ["localhost", "capacitor://localhost"].contains($0.displayName) }.count ?? 0, 100000)
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene, let window = scene.windows.first else { throw NSError(domain: "FountainQAIndexedDB", code: 4) }
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = store
        configuration.setURLSchemeHandler(FountainQAIndexedDBScheme(), forURLScheme: "capacitor")
        let blank = WKWebView(frame: window.bounds, configuration: configuration), controller = UIViewController()
        controller.view = blank; window.rootViewController = controller; window.makeKeyAndVisible()
        defer { blank.stopLoading(); blank.removeFromSuperview(); window.rootViewController = UIViewController() }
        blank.load(URLRequest(url: URL(string: "capacitor://localhost/__fountain_qa_indexeddb__")!))
        var loaded = false
        for _ in 0..<80 {
            let ready = try? await script(view: blank, "return globalThis.__fountainQAIndexedDB===true&&location.protocol==='capacitor:'&&location.hostname==='localhost'&&location.port===''&&location.pathname==='/__fountain_qa_indexeddb__'&&location.origin===originalOrigin;", arguments: ["originalOrigin": originalOrigin])
            if ready as? Bool == true { loaded = true; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        evidence["indexedDBBlankOriginVerified"] = loaded
        guard loaded else { throw NSError(domain: "FountainQAIndexedDB", code: 5) }
        // Native ownership has been synchronously revoked by detach; its old
        // queued tasks cannot admit another write. Account for close effects
        // before taking the exact source boundary around the two IDB deletes.
        let before = try activeOutboxEvidence(workspace: workspace, page: "qa-native-shared", canonical: expected, pending: expected)
        let sourceBefore = try activeOutboxSourceDigest()
        evidence["beforeEviction"] = before; evidence["nativeSourceSHA256BeforeEviction"] = sourceBefore
        let result = try await script(view: blank, """
        if(location.protocol!=='capacitor:'||location.hostname!=='localhost'||location.port!==''||location.pathname!=='/__fountain_qa_indexeddb__'||location.origin!==originalOrigin||globalThis.__fountainQAIndexedDB!==true||typeof indexedDB.databases!=='function')throw new Error('QA_IDB_ORIGIN');
        const owned=['fountain-offline-v1','fountain-upload-metadata-v1'];const before=await indexedDB.databases();
        const present=owned.map(name=>before.some(item=>item.name===name));if(!present.every(Boolean))throw new Error('QA_IDB_EXPECTED_ABSENT');
        let removed=0;for(let index=0;index<owned.length;index++){if(!present[index])continue;await new Promise((resolve,reject)=>{let settled=false;const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(new Error(error)):resolve();};const timer=setTimeout(()=>finish('QA_IDB_TIMEOUT'),8000);const request=indexedDB.deleteDatabase(owned[index]);request.onsuccess=()=>finish();request.onerror=()=>finish('QA_IDB_DELETE');request.onblocked=()=>finish('QA_IDB_BLOCKED');});removed++;}
        const after=await indexedDB.databases();if(after.some(item=>owned.includes(item.name)))throw new Error('QA_IDB_REMAINS');
        return {primaryPresent:present[0],uploadPresent:present[1],removed,ownedAbsent:true,otherDatabaseCount:Math.min(100000,before.filter(item=>!owned.includes(item.name)).length),otherDatabaseCountAfter:Math.min(100000,after.filter(item=>!owned.includes(item.name)).length)};
        """, arguments: ["originalOrigin": originalOrigin])
        guard let result = result as? [String: Any], result["primaryPresent"] as? Bool == true, result["uploadPresent"] as? Bool == true,
              result["removed"] as? Int == 2, result["ownedAbsent"] as? Bool == true,
              result["otherDatabaseCount"] as? Int == result["otherDatabaseCountAfter"] as? Int else { throw NSError(domain: "FountainQAIndexedDB", code: 6) }
        evidence["indexedDBEviction"] = result
        let after = try activeOutboxEvidence(workspace: workspace, page: "qa-native-shared", canonical: expected, pending: expected)
        let sourceAfter = try activeOutboxSourceDigest()
        evidence["afterEviction"] = after; evidence["nativeSourceSHA256AfterEviction"] = sourceAfter
        guard sourceBefore == sourceAfter, before["head"] as? Int == after["head"] as? Int,
              before["pendingOperations"] as? Int == after["pendingOperations"] as? Int,
              before["pendingMatches"] as? Bool == after["pendingMatches"] as? Bool,
              after["integrityOK"] as? Bool == true else { throw NSError(domain: "FountainQAIndexedDB", code: 7) }
    }
    private func activeOutboxSourceDigest() throws -> String {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
        let file = support.appendingPathComponent("FountainOutbox").appendingPathComponent(FountainOutbox.hash(Data("https://ehnovtfadpkwtubmwltl.supabase.co".utf8)) + ".sqlite")
        // Use SQLite for every read, including exact BLOB bytes. A raw file
        // descriptor close could interfere with another SQLite VFS connection.
        let tables: [(String, String)] = [("control", "id,value"), ("records", "bucket,key,profile_id,resource_key,value"), ("recovery", "tx_id,position,bucket,key,profile_id,value"), ("staging", "tx_id,part,lease,base_head,data"), ("tx_receipts", "tx_id,digest,head"), ("tombstones", "scope,kind,profile_id")]
        var source: [String: [[String]]] = [:]
        for (table, columns) in tables {
            let projection = columns.split(separator: ",").map { "quote(" + $0 + ")" }.joined(separator: ",")
            source[table] = try sql(file, "SELECT rowid," + projection + " FROM " + table + " ORDER BY rowid", readOnly: true)
        }
        let bytes = try encoded(source)
        guard bytes.count <= 128 * 1024 * 1024 else { throw NSError(domain: "FountainQAIndexedDB", code: 9) }
        return FountainOutbox.hash(bytes)
    }
    private func activeOutboxEvidence(workspace: String, page: String, canonical: String, pending: String) throws -> [String: Any] {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
        let file = support.appendingPathComponent("FountainOutbox").appendingPathComponent(FountainOutbox.hash(Data("https://ehnovtfadpkwtubmwltl.supabase.co".utf8)) + ".sqlite")
        guard FileManager.default.fileExists(atPath: file.path), let identityText = try sql(file, "SELECT CAST(value AS TEXT) FROM control WHERE id='identity'", readOnly: true).first?.first,
              let identity = try JSONSerialization.jsonObject(with: Data(identityText.utf8)) as? [String: Any], let profile = identity["profileId"] as? String else { return ["actualSQLite": false] }
        let parts = profile.components(separatedBy: "|")
        guard parts.count == 4, parts[0] == "https://ehnovtfadpkwtubmwltl.supabase.co", parts[1].removingPercentEncoding == workspace else { return ["actualSQLite": true, "scopeMatches": false] }
        let resource = profile + "|" + FountainOutbox.encodeURIComponent(page)
        let snapshotRows = try sql(file, "SELECT CAST(value AS TEXT) FROM records WHERE bucket='snapshots' AND key=? AND profile_id=?", [try json(resource), profile], readOnly: true)
        let snapshot = snapshotRows.first?.first.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }?["snapshot"] as? [String: Any]
        let canonicalMatches = (snapshot?["blocks"] as? [[String: Any]] ?? []).contains { $0["text"] as? String == canonical }
        var pendingMatches = false
        let inputs = try sql(file, "SELECT bucket,CAST(value AS TEXT) FROM records WHERE profile_id=? AND resource_key=? AND bucket IN ('operations','drafts','mutations')", [profile, resource], readOnly: true)
        for row in inputs {
            guard let value = try JSONSerialization.jsonObject(with: Data(row[1].utf8)) as? [String: Any] else { throw FountainOutboxError.storage }
            if (value["operation"] as? [String: Any])?["text"] as? String == pending { pendingMatches = true }
            if let draft = value["draft"] as? [String: Any], (draft["blocks"] as? [[String: Any]] ?? []).contains(where: { $0["text"] as? String == pending }) { pendingMatches = true }
        }
        let head = Int(try sql(file, "SELECT CAST(value AS TEXT) FROM control WHERE id='head'", readOnly: true).first?.first ?? "-1") ?? -1
        let receipts = Int(try sql(file, "SELECT count(*) FROM control WHERE substr(id,1,13)='receiptOwner:' AND CAST(value AS TEXT)=?", [try json(profile)], readOnly: true)[0][0]) ?? 0
        return ["actualSQLite": true, "scopeMatches": true, "grantVerified": identity["state"] as? String == "verified", "head": head,
                "canonicalMatches": canonicalMatches, "pendingMatches": pendingMatches, "pendingOperations": inputs.filter { $0[0] == "operations" }.count,
                "deltaReceipts": receipts, "integrityOK": try sql(file, "PRAGMA integrity_check", readOnly: true).first?.first == "ok"]
    }
    @MainActor func testActualActiveCloudOutboxLifecyclePhase() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["FOUNTAIN_OUTBOX_QA"] == "1", "Opt-in DEBUG native outbox lifecycle phase required")
        let manager = FileManager.default, documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let inputURL = documents.appendingPathComponent("fountain-cloud-outbox-input.json"), resultURL = documents.appendingPathComponent("fountain-cloud-outbox-result.json")
        try XCTSkipUnless(manager.fileExists(atPath: inputURL.path), "Private outbox lifecycle input required")
        let descriptor = Darwin.open(inputURL.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw NSError(domain: "FountainOutboxQAInput", code: 1) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o777 == 0o600,
              info.st_uid == getuid(), info.st_size > 0, info.st_size <= 16384, unlink(inputURL.path) == 0,
              let bytes = try handle.read(upToCount: 16385), bytes.count == Int(info.st_size), let input = try JSONSerialization.jsonObject(with: bytes) as? [String: String],
              Set(input.keys) == Set(["origin", "workspaceId", "email", "password", "nonce", "phase", "pageId", "expectedText", "editedText"]),
              input["origin"] == "https://ehnovtfadpkwtubmwltl.supabase.co", let workspace = input["workspaceId"], workspace.range(of: "^fountain-qa-cloud-native-[a-f0-9]{16}$", options: .regularExpression) != nil,
              let email = input["email"], email.hasSuffix(".invalid"), email.utf8.count <= 254, let password = input["password"], (10...1024).contains(password.utf8.count),
              let nonce = input["nonce"], nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let phase = input["phase"], ["login-edit", "queue-offline", "restart-read", "evict-read", "logout"].contains(phase), input["pageId"] == "qa-native-shared",
              let expected = input["expectedText"], let edited = input["editedText"], expected.utf8.count <= 4096, edited.utf8.count <= 4096 else { throw NSError(domain: "FountainOutboxQAInput", code: 2) }
        let offlineBoot = ["restart-read", "evict-read"].contains(phase)
        var evidence: [String: Any] = ["completed": false, "phase": phase, "processID": Int(ProcessInfo.processInfo.processIdentifier), "outboxEnabled": true,
                                       "preinstallAllocated": FountainNative.qaLaunchNetworkEvidence()["allocated"] ?? -1]
        var stage = "install"
        FountainCloudQAProtocol.install(nonce); FountainCloudQAProtocol.setOffline(offlineBoot); try FountainNative.setQAProtocolClass(FountainCloudQAProtocol.self)
        defer { let controller = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.windows.first?.rootViewController as? FountainBridgeViewController; controller?.shutdownNative(); try? FountainNative.setQAProtocolClass(nil); FountainCloudQAProtocol.install(nil) }
        do {
            guard evidence["preinstallAllocated"] as? Int == 0 else { throw NSError(domain: "FountainOutboxQA", code: 10) }
            if phase == "evict-read" {
                stage = "indexeddb-eviction"
                try await evictOwnedCloudIndexedDB(workspace: workspace, expected: expected, evidence: &evidence)
            }
            try freshCloudView(clearOrigin: phase == "login-edit")
            if phase == "login-edit" {
                stage = "configure"
                try await waitCloud("return !!document.querySelector('#native-configuration-form input[name=origin]');")
                _ = try await script("const f=document.querySelector('#native-configuration-form');f.elements.origin.value=origin;f.requestSubmit();return true;", arguments: ["origin": input["origin"]!])
            }
            stage = "authenticated-bootstrap"
            for _ in 0..<180 {
                if (try? await script("try{return state.loaded===true&&state.session?.authenticated===true&&FountainNativeStorage?.ready===true;}catch{return false;}")) as? Bool == true { break }
                if phase == "login-edit" {
                    _ = try? await script("""
                    const submitted=globalThis.__fountainOutboxQAControls||(globalThis.__fountainOutboxQAControls=new WeakSet());const trace=globalThis.__fountainOutboxQATrace||(globalThis.__fountainOutboxQATrace={formSubmits:0,continueClicks:0,entryClicks:0,accountSwitchClicks:0});
                    const dialog=document.querySelector('.native-recovery-dialog[open]');
                    const f=dialog?dialog.querySelector('.native-recovery-login'):document.querySelector('#login-form');
                    const switcher=dialog&&!f&&globalThis.FountainNativeStorage?.identityState==='blocked'&&dialog.getAttribute('aria-busy')!=='true'&&trace.accountSwitchClicks<2&&(!trace.lastAccountSwitch||Date.now()-trace.lastAccountSwitch>1000)&&[...dialog.querySelectorAll('button')].find(b=>b.textContent==='다른 계정으로 로그인'&&!b.disabled);if(switcher){trace.lastAccountSwitch=Date.now();trace.accountSwitchClicks++;switcher.click();return true;}
                    if(f?.elements?.email&&!submitted.has(f)&&!f.querySelector('button[type=submit]')?.disabled){submitted.add(f);trace.formSubmits=Math.min(1000000,trace.formSubmits+1);f.elements.email.value=email;f.elements.password.value=password;f.requestSubmit();return true;}
                    const resume=dialog&&[...dialog.querySelectorAll('button')].find(b=>['원본 보관하고 최신 상태로 계속','확인하고 계속'].includes(b.textContent)&&!b.disabled&&!submitted.has(b));
                    if(resume){submitted.add(resume);trace.continueClicks=Math.min(1000000,trace.continueClicks+1);resume.click();return true;}
                    const entry=!dialog&&document.querySelector('.native-recovery-entry');if(entry&&!submitted.has(entry)){submitted.add(entry);trace.entryClicks=Math.min(1000000,trace.entryClicks+1);entry.click();return true;}return false;
                    """, arguments: ["email": email, "password": password])
                }
                try await Task.sleep(nanoseconds: 250_000_000)
            }
            try await waitCloud("return state.loaded===true&&state.session?.workspace_id===workspace&&FountainNativeStorage?.ready===true;", arguments: ["workspace": workspace], attempts: 12)
            let privacy = try await script("const c=await Capacitor.registerPlugin('FountainNative').getConfiguration();return c.outboxEnabled===true&&document.cookie==='';") as? Bool
            guard privacy == true else { throw NSError(domain: "FountainOutboxQA", code: 12) }
            stage = "open-owned-page"
            evidence["pageClickMatched"] = try await script("const b=document.querySelector('[data-action=page][data-id=qa-native-shared]');b?.click();return !!b;")
            try await waitCloud("return state.page?.id==='qa-native-shared'&&[...document.querySelectorAll('.block-content')].some(e=>e.innerText===text);", arguments: ["text": expected])
            let before = try activeOutboxEvidence(workspace: workspace, page: "qa-native-shared", canonical: expected, pending: expected)
            evidence["before"] = before
            if ["login-edit", "queue-offline"].contains(phase) {
                if phase == "queue-offline" { FountainCloudQAProtocol.setOffline(true); _ = try await script("dispatchEvent(new Event('offline'));return true;") }
                stage = "real-editor-input"
                let changed = try await script("const e=[...document.querySelectorAll('.block-content')].find(e=>e.innerText===previous);if(!e||e.contentEditable!=='true')return false;e.focus();e.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:text}));e.textContent=text;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));return true;", arguments: ["previous": expected, "text": edited]) as? Bool
                guard changed == true else { throw NSError(domain: "FountainOutboxQA", code: 13) }
                stage = "native-commit"
                var committed = false
                for _ in 0..<180 {
                    let state = try activeOutboxEvidence(workspace: workspace, page: "qa-native-shared", canonical: edited, pending: edited)
                    let changedHead = (state["head"] as? Int ?? -1) > (before["head"] as? Int ?? Int.max)
                    if changedHead && (phase == "queue-offline" ? state["pendingMatches"] as? Bool == true && (state["pendingOperations"] as? Int ?? 0) > 0 : state["canonicalMatches"] as? Bool == true && state["pendingOperations"] as? Int == 0) { evidence["after"] = state; committed = true; break }
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                guard committed else { throw NSError(domain: "FountainOutboxQA", code: 14) }
                if phase == "login-edit" {
                    stage = "saved-badge"
                    try await waitCloud("return document.querySelector('#save-status')?.textContent==='모든 변경 사항 저장됨';", attempts: 120)
                    evidence["savedBadgeVerified"] = true
                    stage = "independent-backend-get"
                    let wireBefore = FountainCloudQAProtocol.routingCounts()["actualOwnedPageGET"] ?? 0
                    let actual = try await script("""
                    const bridge=Capacitor.registerPlugin('FountainNative'),configuration=await bridge.getConfiguration();if(configuration.origin!==origin)throw new Error('QA_BACKEND_ORIGIN');
                    const response=await bridge.request({id:requestId,generation:configuration.generation,path:'/api/pages/qa-native-shared',method:'GET',headers:{accept:'application/json'},bodyBase64:'',timeoutMs:45000});
                    const headers=Object.keys(response.headers||{}).map(key=>key.toLowerCase()),safe=!headers.includes('set-cookie')&&!headers.includes('cookie');
                    if(response.status!==200)return {status:response.status,pageMatches:false,editedTextMatches:false,responseHeadersSafe:safe};
                    const value=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(response.bodyBase64),character=>character.charCodeAt(0))));
                    return {status:response.status,pageMatches:value.page?.id==='qa-native-shared',editedTextMatches:Array.isArray(value.blocks)&&value.blocks.some(block=>block.text===edited),responseHeadersSafe:safe};
                    """, arguments: ["origin": input["origin"]!, "edited": edited, "requestId": "lifecycle-backend-" + UUID().uuidString]) as? [String: Any]
                    let wireDelta = (FountainCloudQAProtocol.routingCounts()["actualOwnedPageGET"] ?? 0) - wireBefore
                    evidence["actualBackendRead"] = actual ?? [:]
                    evidence["actualBackendGETWireDelta"] = wireDelta
                    guard actual?["status"] as? Int == 200, actual?["pageMatches"] as? Bool == true,
                          actual?["editedTextMatches"] as? Bool == true, actual?["responseHeadersSafe"] as? Bool == true,
                          wireDelta > 0 else { throw NSError(domain: "FountainOutboxQA", code: 18) }
                    evidence["actualBackendReadMatched"] = true
                }
            } else if offlineBoot {
                guard before["pendingMatches"] as? Bool == true, (before["pendingOperations"] as? Int ?? 0) > 0, before["integrityOK"] as? Bool == true,
                      FountainCloudQAProtocol.counts().0 == 0, FountainCloudQAProtocol.offlineCount() > 0 else { throw NSError(domain: "FountainOutboxQA", code: 15) }
                evidence["restoredPendingWithoutHTTPS"] = true
            } else if phase == "logout" {
                stage = "flush-pending"
                _ = try await script("dispatchEvent(new Event('online'));state.channel?.sync?.();return true;")
                var flushed = false
                for _ in 0..<180 { let state = try activeOutboxEvidence(workspace: workspace, page: "qa-native-shared", canonical: expected, pending: expected); if state["canonicalMatches"] as? Bool == true && state["pendingOperations"] as? Int == 0 { evidence["after"] = state; flushed = true; break }; try await Task.sleep(nanoseconds: 250_000_000) }
                guard flushed else { throw NSError(domain: "FountainOutboxQA", code: 16) }
                stage = "explicit-logout"
                _ = try await script("""
                if(!globalThis.__fountainLogoutQA){const trace=globalThis.__fountainLogoutQA={clicks:0,calls:0,accepted:0,completed:0,inFlight:false,errorCode:null,errorName:null,frames:[]};const original=doAction;doAction=async function(...args){if(args[0]?.dataset?.action!=='logout')return original.apply(this,args);trace.calls++;trace.pausedAtCall=!!state.nativeOutboxPause;trace.resumingAtCall=!!state.nativeOutboxResuming;if(!state.nativeOutboxPause)trace.accepted++;trace.inFlight=true;try{return await original.apply(this,args);}catch(error){const allowed=['OUTBOX_STALE','OUTBOX_ACCESS_REQUIRED','OUTBOX_RECOVERY_REQUIRED','OUTBOX_STORAGE','OUTBOX_CANCELLED','OUTBOX_INVALID_OPEN','OUTBOX_SCOPE_CHANGED','OUTBOX_IDENTITY','OUTBOX_PAUSE','OUTBOX_CLOSED','OUTBOX_NOT_READY','OUTBOX_IDENTITY_REQUIRED','OUTBOX_UNAVAILABLE','NATIVE_OUTBOX_STALE','NATIVE_OUTBOX_HEAD','NATIVE_OUTBOX_CONFLICT','NATIVE_OUTBOX_INVALID','NATIVE_OUTBOX_LIMIT','NATIVE_OUTBOX_BLOCKED','NATIVE_STORAGE','STALE_REQUEST'];trace.errorCode=allowed.includes(error?.code)?error.code:'OTHER';trace.errorName=['Error','TypeError','AbortError','SecurityError','InvalidStateError','TransactionInactiveError','UnknownError'].includes(error?.name)?error.name:'OTHER';trace.frames=['opened','recover','releasePause','readCurrent','clearActiveProfile','getProfile','doAction','coordinated','scopeCheck'].filter(name=>String(error?.stack||'').includes(name));throw error;}finally{trace.inFlight=false;trace.completed++;}};}return true;
                """)
                try await waitCloud("""
                const trace=globalThis.__fountainLogoutQA;if(trace.accepted>0)return true;if(state.nativeOutboxPause||state.nativeOutboxResuming||state.nativeRecoveryPreparing||state.nativeRecoveryPaused||!state.loaded||!FountainNativeStorage.ready){trace.readyAt=0;return false;}if(!trace.readyAt){trace.readyAt=Date.now();return false;}if(Date.now()-trace.readyAt<250)return false;const usable=button=>button&&!button.disabled&&!button.closest('[inert]')&&button.getClientRects().length>0;const logout=document.querySelector('[data-action=logout]');if(usable(logout)&&trace.clicks<3&&(!trace.lastClick||Date.now()-trace.lastClick>1000)){trace.clicks++;trace.lastClick=Date.now();logout.click();return trace.accepted>0;}const security=document.querySelector('[data-action=settings-tab][data-tab=security]');if(usable(security))security.click();else if(!document.querySelector('[data-action=logout]')){const settings=document.querySelector('[data-action=settings]');if(usable(settings))settings.click();}return false;
                """)
                try await waitCloud("if(!document.querySelector('#login-form'))return false;const r=await FountainTransport.request('/api/session');return r.status===200&&(await r.json()).authenticated===false&&document.cookie==='';")
                stage = "logout-flow-completion"
                try await waitCloud("const trace=globalThis.__fountainLogoutQA;return trace?.accepted===1&&trace.completed===1&&trace.inFlight===false&&trace.errorCode===null&&trace.errorName===null&&typeof logoutPendingKey==='function'&&localStorage.getItem(logoutPendingKey())===null;", attempts: 120)
                evidence["logoutFlowCompleted"] = true
                evidence["pendingLogoutMarkerCleared"] = true
                guard (FountainCloudQAProtocol.routingCounts()["actualSessionDELETE"] ?? 0) > 0 else { throw NSError(domain: "FountainOutboxQA", code: 17) }
                evidence["logoutAction"] = try await script("const t=globalThis.__fountainLogoutQA;return t?{clicks:t.clicks,calls:t.calls,accepted:t.accepted,completed:t.completed,inFlight:t.inFlight,errorCode:t.errorCode,errorName:t.errorName,frames:t.frames,pausedAtCall:t.pausedAtCall,resumingAtCall:t.resumingAtCall}:null;")
                evidence["logoutVerified"] = true
            }
            evidence["completed"] = true
        } catch {
            evidence["failedStageSHA256"] = FountainOutbox.hash(Data(stage.utf8))
            evidence["failureCode"] = (error as? FountainOutboxError)?.code ?? "QA_STAGE_FAILED"
            let harnessError = error as NSError
            if ["FountainQAIndexedDB", "FountainOutboxQA", "FountainCloudQA"].contains(harnessError.domain) { evidence["harnessFailureDomain"] = harnessError.domain; evidence["harnessFailureCode"] = harnessError.code }
            if phase == "logout" { evidence["logoutAction"] = try? await script("const t=globalThis.__fountainLogoutQA;return t?{clicks:t.clicks,calls:t.calls,accepted:t.accepted,completed:t.completed,inFlight:t.inFlight,errorCode:t.errorCode,errorName:t.errorName,frames:t.frames,pausedAtCall:t.pausedAtCall,resumingAtCall:t.resumingAtCall,currentlyPaused:!!state.nativeOutboxPause,currentlyResuming:!!state.nativeOutboxResuming,settingsPresent:!!document.querySelector('[data-action=settings]'),logoutPresent:!!document.querySelector('[data-action=logout]')}:null;") }
            evidence["expectedTextSHA256"] = FountainOutbox.hash(Data(expected.utf8))
            evidence["nativeShape"] = try? activeOutboxEvidence(workspace: workspace, page: "qa-native-shared", canonical: expected, pending: expected)
            evidence["pageUI"] = try? await script("""
            const owned=typeof state!=='undefined'&&state.page?.id==='qa-native-shared';const all=[...document.querySelectorAll('.block-content')];const hash=async text=>{if(!globalThis.crypto?.subtle)return null;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');};return {selectedPagePresent:typeof state!=='undefined'&&!!state.page,selectedOwnedPage:owned,routeContainsOwnedPage:location.hash.includes('qa-native-shared'),blockCount:all.length,expectedDOMText:all.some(e=>e.innerText===expected),expectedStateText:owned&&(state.page.blocks||[]).some(b=>b.text===expected),stateBlockCount:owned&&Array.isArray(state.page.blocks)?state.page.blocks.length:0,innerTextSHA256:owned?await Promise.all(all.slice(0,8).map(e=>hash(e.innerText.slice(0,4096)))):[],textContentSHA256:owned?await Promise.all(all.slice(0,8).map(e=>hash((e.textContent||'').slice(0,4096)))):[],storageReady:globalThis.FountainNativeStorage?.ready===true};
            """, arguments: ["expected": expected])
            evidence["publicUI"] = try? await script("""
            const d=document.querySelector('.native-recovery-dialog[open]');return {loaded:typeof state!=='undefined'&&state.loaded===true,authenticated:typeof state!=='undefined'&&state.session?.authenticated===true,storageReady:globalThis.FountainNativeStorage?.ready===true,recoveryOpen:!!d,loginVisible:!!(d?.querySelector('.native-recovery-login')||document.querySelector('#login-form')),continueVisible:!!d&&[...d.querySelectorAll('button')].some(b=>b.textContent==='원본 보관하고 최신 상태로 계속'),confirmationVisible:!!d&&[...d.querySelectorAll('button')].some(b=>b.textContent==='확인하고 계속'),busy:d?.getAttribute('aria-busy')==='true',qaActions:globalThis.__fountainOutboxQATrace||{formSubmits:0,continueClicks:0,entryClicks:0}};
            """)
            // Retain cookie, native source, staging and pending input for Root's
            // next isolated phase; a test failure never silently logs it out.
            XCTFail("Active native outbox lifecycle phase failed; inspect private boolean evidence")
        }
        evidence["qaActions"] = try? await script("return globalThis.__fountainOutboxQATrace||{formSubmits:0,continueClicks:0,entryClicks:0};")
        evidence["interceptedHTTPS"] = FountainCloudQAProtocol.counts().0; evidence["offlineFailures"] = FountainCloudQAProtocol.offlineCount()
        for (key, value) in FountainCloudQAProtocol.routingCounts() { evidence[key] = value }
        evidence["textSHA256"] = FountainOutbox.hash(Data(edited.utf8)); evidence["launchNetwork"] = FountainNative.qaLaunchNetworkEvidence()
        try JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys]).write(to: resultURL, options: [.atomic, .completeFileProtection])
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: resultURL.path)
    }
    private func logoutProbeSourceDigest() throws -> String {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
        let file = support.appendingPathComponent("FountainOutbox").appendingPathComponent(FountainOutbox.hash(Data("https://ehnovtfadpkwtubmwltl.supabase.co".utf8)) + ".sqlite")
        return FileManager.default.fileExists(atPath: file.path) ? try activeOutboxSourceDigest() : "absent"
    }
    @MainActor func testActualPublicLogoutBindingAdmissionPreservesCurrentSession() async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), "Dedicated native QA Simulator required")
        let manager = FileManager.default, documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let inputURL = documents.appendingPathComponent("fountain-native-logout-input.json"), output = documents.appendingPathComponent("fountain-native-logout-result.json")
        try XCTSkipUnless(manager.fileExists(atPath: inputURL.path), "Private real-HTTPS logout QA input required")
        let descriptor = Darwin.open(inputURL.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw NSError(domain: "FountainLogoutInput", code: 1) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o777 == 0o600, info.st_uid == getuid(),
              info.st_size > 0, info.st_size <= 16384, unlink(inputURL.path) == 0,
              let bytes = try handle.read(upToCount: 16385), bytes.count == Int(info.st_size), let input = try JSONSerialization.jsonObject(with: bytes) as? [String: String],
              Set(input.keys) == Set(["origin", "workspaceId", "email", "password", "nonce"]),
              input["origin"] == "https://ehnovtfadpkwtubmwltl.supabase.co", let workspace = input["workspaceId"], workspace.range(of: "^fountain-qa-cloud-native-[a-f0-9]{16}$", options: .regularExpression) != nil,
              let email = input["email"], email.hasSuffix(".invalid"), email.utf8.count <= 254,
              let password = input["password"], (10...1024).contains(password.utf8.count),
              let nonce = input["nonce"], nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw NSError(domain: "FountainLogoutInput", code: 2) }
        var evidence: [String: Any] = ["completed": false, "actualNativeBoundary": true, "processID": Int(ProcessInfo.processInfo.processIdentifier)]
        var stage = "install"
        FountainCloudQAProtocol.install(nonce); FountainCloudQAProtocol.setOffline(true); try FountainNative.setQAProtocolClass(FountainCloudQAProtocol.self)
        defer { let controller = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.windows.first?.rootViewController as? FountainBridgeViewController; controller?.shutdownNative(); try? FountainNative.setQAProtocolClass(nil); FountainCloudQAProtocol.install(nil) }
        do {
            // Preserve the existing native configuration and all persisted
            // data. Pause only this test WebView's already-existing business
            // controller; raw Capacitor still crosses the real native gate.
            try freshCloudView(clearOrigin: false)
            try await waitCloud("return !!globalThis.Capacitor?.isPluginAvailable('FountainNative');")
            _ = try await script("if(typeof state!=='undefined'){state.bootGeneration=(state.bootGeneration||0)+1;state.nativeRecoveryPaused=true;state.nativeOutboxPause=true;}if(typeof closeDocument==='function')closeDocument();if(typeof closeMutations==='function')closeMutations();globalThis.FountainNativeStorage?.close();return true;")
            FountainCloudQAProtocol.setOffline(false)
            stage = "two-real-sessions"
            let setup = try await script("""
            const bridge=Capacitor.registerPlugin('FountainNative');const configuration=await bridge.getConfiguration();if(configuration.origin!==origin)throw new Error('QA_EXISTING_CONFIGURATION');
            const pause=()=>{if(typeof state!=='undefined'){state.bootGeneration=(state.bootGeneration||0)+1;state.nativeRecoveryPaused=true;state.nativeOutboxPause=true;}if(typeof closeDocument==='function')closeDocument();if(typeof closeMutations==='function')closeMutations();globalThis.FountainNativeStorage?.close();};pause();
            const probe=globalThis.__fountainLogoutAdmission={bridge,generation:configuration.generation,sequence:0};
            probe.exchange=async(method,body)=>{const raw=body===undefined?'':typeof body==='string'?body:JSON.stringify(body);const bytes=new TextEncoder().encode(raw);let binary='';for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);return bridge.request({id:'logout-admission-'+(++probe.sequence),generation:probe.generation,path:'/api/session',method,headers:{'content-type':'application/json'},bodyBase64:btoa(binary),timeoutMs:45000});};
            probe.session=async()=>{const response=await probe.exchange('GET');if(response.status!==200)throw new Error('QA_SESSION_STATUS');return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(response.bodyBase64),c=>c.charCodeAt(0))));};
            if((await probe.exchange('POST',{email,password})).status!==200)throw new Error('QA_LOGIN_A');pause();const a=await probe.session();
            if((await probe.exchange('POST',{email,password})).status!==200)throw new Error('QA_LOGIN_B');pause();const b=await probe.session();
            if(a.authenticated!==true||b.authenticated!==true||a.workspace_id!==workspace||b.workspace_id!==workspace||typeof a.cache_binding!=='string'||typeof b.cache_binding!=='string'||a.cache_binding===b.cache_binding)throw new Error('QA_SESSION_SCOPE');
            probe.bindingA=a.cache_binding;probe.bindingB=b.cache_binding;return {twoRealSessions:true,distinctBindings:true,outboxEnabled:configuration.outboxEnabled===true};
            """, arguments: ["origin": input["origin"]!, "email": email, "password": password, "workspace": workspace]) as! [String: Any]
            evidence.merge(setup, uniquingKeysWith: { _, value in value })
            let sourceBefore = try logoutProbeSourceDigest(), deleteBefore = FountainCloudQAProtocol.routingCounts()["actualSessionDELETE"] ?? 0
            stage = "stale-a-current-b"
            let stale = try await script("""
            const p=globalThis.__fountainLogoutAdmission;try{const response=await p.exchange('DELETE',{cache_binding:p.bindingA});return {rejected:false,status:response.status};}catch(error){return {rejected:error?.code==='NATIVE_SESSION_CONFLICT',code:['NATIVE_SESSION_CONFLICT','NATIVE_SESSION_REQUIRED','NATIVE_SESSION_INVALID'].includes(error?.code)?error.code:'OTHER'};}
            """) as! [String: Any]
            evidence["staleAdmission"] = stale
            let sourceAfter = try logoutProbeSourceDigest(), deleteAfter = FountainCloudQAProtocol.routingCounts()["actualSessionDELETE"] ?? 0
            let after = try await script("const p=globalThis.__fountainLogoutAdmission,s=await p.session();return {authenticatedB:s.authenticated===true&&s.cache_binding===p.bindingB};") as! [String: Any]
            evidence["privateSourceUnchanged"] = sourceBefore == sourceAfter; evidence["sourceSHA256Before"] = sourceBefore; evidence["sourceSHA256After"] = sourceAfter
            evidence["unexpectedDELETEDelta"] = deleteAfter - deleteBefore; evidence["actualGETStillAuthenticatedB"] = after["authenticatedB"] as? Bool == true
            XCTAssertEqual(stale["rejected"] as? Bool, true); XCTAssertEqual(deleteAfter, deleteBefore); XCTAssertEqual(sourceAfter, sourceBefore); XCTAssertEqual(after["authenticatedB"] as? Bool, true)
            guard stale["rejected"] as? Bool == true, sourceBefore == sourceAfter, deleteAfter == deleteBefore, after["authenticatedB"] as? Bool == true else { throw NSError(domain: "FountainLogoutQA", code: 3) }
            stage = "malformed-no-effects"
            let invalid = try await script("""
            const p=globalThis.__fountainLogoutAdmission;const cases=['','{}','[]','{"cache_binding":null}','{"cache_binding":"a","cache_binding":"b"}','{"cache_binding":"a","extra":true}',JSON.stringify({cache_binding:'a'.repeat(1001)}),JSON.stringify({cache_binding:p.bindingB})+' '.repeat(8193)];let rejected=0;for(const body of cases){try{await p.exchange('DELETE',body);}catch(error){if(error?.code==='NATIVE_SESSION_INVALID')rejected++;}}return {cases:cases.length,rejected};
            """) as! [String: Any]
            evidence["malformed"] = invalid
            XCTAssertEqual(invalid["rejected"] as? Int, 8); XCTAssertEqual(FountainCloudQAProtocol.routingCounts()["actualSessionDELETE"], deleteBefore); XCTAssertEqual(try logoutProbeSourceDigest(), sourceBefore)
            stage = "matching-b-actual-bound-delete"
            let matchingBefore = FountainCloudQAProtocol.routingCounts()
            let matching = try await script("const p=globalThis.__fountainLogoutAdmission;const r=await p.exchange('DELETE',{cache_binding:p.bindingB});const s=await p.session();return {status:r.status,anonymous:s.authenticated===false};") as! [String: Any]
            let matchingAfter = FountainCloudQAProtocol.routingCounts()
            evidence["matching"] = matching; evidence["matchingActualDELETEDelta"] = (matchingAfter["actualSessionDELETE"] ?? 0) - (matchingBefore["actualSessionDELETE"] ?? 0)
            evidence["matchingBodyfulDELETEDelta"] = (matchingAfter["actualSessionDELETEWithBody"] ?? 0) - (matchingBefore["actualSessionDELETEWithBody"] ?? 0)
            XCTAssertEqual(matching["status"] as? Int, 200); XCTAssertEqual(matching["anonymous"] as? Bool, true); XCTAssertEqual(evidence["matchingActualDELETEDelta"] as? Int, 1); XCTAssertEqual(evidence["matchingBodyfulDELETEDelta"] as? Int, 1)
            evidence["completed"] = true
        } catch {
            evidence["failedStageSHA256"] = FountainOutbox.hash(Data(stage.utf8)); evidence["failed"] = true
            XCTFail("Native logout admission failed; inspect private boolean/hash evidence")
        }
        for (key, value) in FountainCloudQAProtocol.routingCounts() { evidence[key] = value }
        try encoded(evidence).write(to: output, options: [.atomic, .completeFileProtection]); try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
    }
    @MainActor func testActualCloudBundledUILoginEditReloadAndLogout() async throws {
        let manager = FileManager.default, documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let inputURL = documents.appendingPathComponent("fountain-cloud-client-input.json"), resultURL = documents.appendingPathComponent("fountain-cloud-client-result.json")
        try XCTSkipUnless(manager.fileExists(atPath: inputURL.path), "Opt-in private native cloud client input required")
        if manager.fileExists(atPath: resultURL.path) { try manager.removeItem(at: resultURL) }
        let descriptor = Darwin.open(inputURL.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw NSError(domain: "FountainCloudQAInput", code: 1) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o777 == 0o600,
              info.st_uid == getuid(), info.st_size > 0, info.st_size <= 16384, unlink(inputURL.path) == 0 else { throw NSError(domain: "FountainCloudQAInput", code: 2) }
        guard let inputData = try handle.read(upToCount: 16385), inputData.count == Int(info.st_size), (try handle.read(upToCount: 1))?.isEmpty != false,
              let input = (try? JSONSerialization.jsonObject(with: inputData)) as? [String: String],
              Set(input.keys) == Set(["origin", "workspaceId", "email", "password", "bootstrapNonce", "nonce", "phase"]),
              input["origin"] == "https://ehnovtfadpkwtubmwltl.supabase.co", input["phase"] == "ios",
              let workspace = input["workspaceId"], workspace.range(of: "^fountain-qa-cloud-native-[a-f0-9]{16}$", options: .regularExpression) != nil,
              let email = input["email"], email.hasSuffix(".invalid"), email.count <= 254,
              let password = input["password"], password.count >= 10, password.count <= 1024,
              let nonce = input["nonce"], nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              input["bootstrapNonce"]?.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw NSError(domain: "FountainCloudQAInput", code: 3) }
        let suffix = String(workspace.suffix(16)), previousText = "Android native QA " + suffix, editedText = "iOS native QA " + suffix
        var evidence: [String: Any] = ["actualRunCompleted": false, "outboxEnabled": false], stage = "install", authMayExist = false
        FountainCloudQAProtocol.install(nonce); try FountainNative.setQAProtocolClass(FountainCloudQAProtocol.self)
        defer { let controller = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.windows.first?.rootViewController as? FountainBridgeViewController; controller?.shutdownNative(); try? FountainNative.setQAProtocolClass(nil); FountainCloudQAProtocol.install(nil) }
        func nativeRead(_ path: String, expectedText: String? = nil) async throws -> Bool {
            (try await script("const r=await FountainTransport.request(path); if(r.status!==200||r.headers.has('set-cookie'))return false;const v=await r.json();if(expected!==null)return v.page?.id==='qa-native-shared'&&v.blocks?.some(b=>b.type==='paragraph'&&b.text===expected);return v.authenticated===true&&v.workspace_id===workspace&&v.member?.role==='owner'&&v.member?.active===true;", arguments: ["path": path, "expected": expectedText.map { $0 as Any } ?? NSNull(), "workspace": workspace])) as? Bool == true
        }
        func logoutUI() async throws {
            _ = try await script("document.querySelector('[data-action=\"settings\"]')?.click();return true;")
            try await waitCloud("const b=document.querySelector('[data-action=\"settings-tab\"][data-tab=\"security\"]');if(!b)return false;b.click();return true;")
            try await waitCloud("const b=document.querySelector('[data-action=\"logout\"]');if(!b)return false;b.click();return true;")
            try await waitCloud("if(!document.querySelector('#login-form'))return false;const r=await FountainTransport.request('/api/session');const v=await r.json();return r.status===200&&v.authenticated===false&&!r.headers.has('set-cookie');")
        }
        do {
            try freshCloudView(clearOrigin: true)
            try await waitCloud("return !!document.querySelector('#native-configuration-form input[name=origin]');")
            _ = try await script("const f=document.querySelector('#native-configuration-form');f.elements.origin.value=origin;f.requestSubmit();return true;", arguments: ["origin": input["origin"]!])
            stage = "private-gate"
            try await waitCloud("return !!document.querySelector('#login-form input[name=email]');")
            let before = FountainCloudQAProtocol.counts(); guard before.0 > 0, before.1 == 0 else { throw NSError(domain: "FountainCloudQA", code: 5) }
            stage = "ui-login"
            authMayExist = true
            _ = try await script("const f=document.querySelector('#login-form');f.elements.email.value=email;f.elements.password.value=password;f.requestSubmit();return true;", arguments: ["email": email, "password": password])
            try await waitCloud("return state.loaded===true&&state.session?.authenticated===true;")
            guard try await nativeRead("/api/session") else { throw NSError(domain: "FountainCloudQA", code: 6) }; evidence["sessionVerified"] = true
            stage = "shared-page"
            try await waitCloud("const b=document.querySelector('[data-action=\"page\"][data-id=\"qa-native-shared\"]');if(!b)return false;b.click();return true;")
            try await waitCloud("return state.page?.id==='qa-native-shared'&&[...document.querySelectorAll('.block-content')].some(e=>e.innerText===expected);", arguments: ["expected": previousText])
            evidence["androidSharedTextRead"] = true; stage = "ui-edit"
            _ = try await script("const e=[...document.querySelectorAll('.block-content')].find(e=>e.innerText===previous);if(!e||e.contentEditable!=='true')return false;e.focus();e.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:text}));e.textContent=text;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));return true;", arguments: ["previous": previousText, "text": editedText])
            for _ in 0..<180 { if (try? await nativeRead("/api/pages/qa-native-shared", expectedText: editedText)) == true { evidence["persistedEdit"] = true; break }; try await Task.sleep(nanoseconds: 250_000_000) }
            guard evidence["persistedEdit"] as? Bool == true else { throw NSError(domain: "FountainCloudQA", code: 7) }
            stage = "keychain-reload"; try freshCloudView(clearOrigin: false)
            try await waitCloud("return state.loaded===true&&state.session?.authenticated===true;")
            guard try await nativeRead("/api/session"), try await nativeRead("/api/pages/qa-native-shared", expectedText: editedText) else { throw NSError(domain: "FountainCloudQA", code: 8) }
            evidence["newNativeOwnerKeychainSession"] = true
            let privacy = try await script("const c=await Capacitor.registerPlugin('FountainNative').getConfiguration();return {cookieEmpty:document.cookie==='',outboxDisabled:c.outboxEnabled===false};") as? [String: Bool]
            guard privacy?["cookieEmpty"] == true, privacy?["outboxDisabled"] == true else { throw NSError(domain: "FountainCloudQA", code: 9) }
            evidence["rendererCookieEmpty"] = true; stage = "ui-logout"; try await logoutUI(); authMayExist = false
            evidence["logoutVerified"] = true; evidence["actualRunCompleted"] = true
        } catch {
            // Exact native service/account existence/entitlement status only.
            // Explicitly request no data, attributes, references or UI, and do
            // not pass a result pointer: cookie material cannot reach this test.
            evidence["keychainQueryOSStatus"] = Int(cloudSessionKeychainStatus())
            // Only fixed booleans, bounded counts, HTTP status and an explicit
            // native error-code allowlist leave the failed UI. No DOM text,
            // error messages, URLs, input fields or response bodies are saved.
            let diagnostic = try? await script("""
            const d={transportPresent:typeof globalThis.FountainTransport==='object',transportFactoryPresent:typeof globalThis.FountainNativeTransport==='object',statePresent:false,pluginAvailable:false,scriptLoadedCount:Math.min(document.scripts.length,100),configurationForm:!!document.querySelector('#native-configuration-form'),loginForm:!!document.querySelector('#login-form'),appScriptPresent:[...document.scripts].some(s=>{try{return new URL(s.src).pathname==='/app.js';}catch{return false;}})};
            try{d.statePresent=typeof state==='object';}catch{}
            const text=document.querySelector('#main')?.textContent||'';
            d.knownAssetLoadError=text.includes('앱 파일을 열지 못했습니다.');d.knownInvalidAssetList=text.includes('앱 자산 목록이 올바르지 않습니다.');d.knownNativeOnlyError=text.includes('이 번들은 Fountain 네이티브 앱에서 열어 주세요.');d.knownStorageRecoveryError=text.includes('기기 저장 기록을 아직 열지 못했습니다.');
            const codes=new Set(['NATIVE_INVALID','NATIVE_STALE','NATIVE_CANCELLED','NATIVE_NETWORK','NATIVE_TIMEOUT','NATIVE_STORAGE','NATIVE_DURABLE_INVALIDATION_FAILED','NATIVE_REDIRECT','NATIVE_TOO_LARGE','NATIVE_INCOMPLETE','NATIVE_BUSY','NATIVE_REVOKE','NATIVE_UNAVAILABLE','NETWORK_ERROR','TIMEOUT','SESSION_CHANGED','SESSION_REVOCATION_PENDING','OUTBOX_ACCESS_REQUIRED']);
            const safeCode=e=>codes.has(e?.code)?e.code:'UNKNOWN';
            const bounded=p=>Promise.race([p,new Promise((_,reject)=>setTimeout(()=>reject({code:'NATIVE_TIMEOUT'}),6000))]);
            try{d.pluginAvailable=!!globalThis.Capacitor?.isPluginAvailable('FountainNative');if(d.pluginAvailable){const c=await bounded(Capacitor.registerPlugin('FountainNative').getConfiguration());d.pluginOriginMatches=c.origin===origin;d.pluginGeneration=Number.isSafeInteger(c.generation)&&c.generation>=0?c.generation:-1;d.pluginOutboxDisabled=c.outboxEnabled===false;}}catch(e){d.configurationErrorCode=safeCode(e);}
            if(d.transportPresent){d.transportOriginMatches=FountainTransport.origin===origin;d.transportGeneration=Number.isSafeInteger(FountainTransport.generation)?FountainTransport.generation:-1;try{const r=await bounded(FountainTransport.request('/api/session',{timeoutMs:5000}));d.probeHTTPStatus=Number.isInteger(r.status)&&r.status>=100&&r.status<=599?r.status:0;d.probeSetCookieExposed=r.headers.has('set-cookie');await r.body?.cancel();}catch(e){d.probeErrorCode=safeCode(e);}}
            return d;
            """, arguments: ["origin": "https://ehnovtfadpkwtubmwltl.supabase.co"])
            if let diagnostic = diagnostic as? [String: Any] { evidence["diagnostics"] = diagnostic } else { evidence["diagnosticsUnavailable"] = true }
            evidence["routingDiagnostics"] = FountainCloudQAProtocol.routingCounts()
            if authMayExist {
                do { try await logoutUI(); evidence["logoutVerified"] = true; authMayExist = false }
                catch { evidence["logoutVerified"] = (try? await script("try{const r=await FountainTransport.request('/api/session',{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});return r.status===200&&(await r.json()).authenticated===false;}catch{return false;}")) as? Bool == true }
            }
            // Static stage only: never attach JavaScript/provider errors, input,
            // password, nonce, Cookie or response bodies to XCTest diagnostics.
            evidence["failedStageSHA256"] = FountainOutbox.hash(Data(stage.utf8)); XCTFail("Native cloud client verification failed; inspect boolean evidence")
        }
        let counts = FountainCloudQAProtocol.counts(); evidence["interceptedRequests"] = counts.0; evidence["credentialRequests"] = counts.1
        evidence["textSHA256"] = FountainOutbox.hash(Data(editedText.utf8))
        try JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys]).write(to: resultURL, options: [.atomic, .completeFileProtection])
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: resultURL.path)
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true; var protectedResult = resultURL; try protectedResult.setResourceValues(excluded)
    }

    func testActualAnonymousCloudDirectNativeRoute() async throws {
        let manager = FileManager.default
        let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let inputURL = documents.appendingPathComponent("fountain-cloud-direct-input.json")
        try XCTSkipUnless(manager.fileExists(atPath: inputURL.path), "Opt-in private direct-route input required")
        let resultURL = documents.appendingPathComponent("fountain-cloud-direct-result.json")
        if manager.fileExists(atPath: resultURL.path) { try manager.removeItem(at: resultURL) }
        let attributes = try manager.attributesOfItem(atPath: inputURL.path)
        defer { try? manager.removeItem(at: inputURL) }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 512 else { throw NSError(domain: "CloudDirectQAInput", code: 1) }
        let bytes = try Data(contentsOf: inputURL); try manager.removeItem(at: inputURL)
        guard let input = try JSONSerialization.jsonObject(with: bytes) as? [String: String], input.count == 1,
              input["origin"] == "https://ehnovtfadpkwtubmwltl.supabase.co" else { throw NSError(domain: "CloudDirectQAInput", code: 2) }
        // A separate plugin instance calls the actual production network()/URL builder.
        // No load/configure/renderer, currentOwner, Keychain or persistent state is touched.
        let probe = FountainNative()
        let response: [String: Any] = try await withCheckedThrowingContinuation { continuation in
            do {
                try probe.probeAnonymousCloudRoute(origin: input["origin"]!) { value, error in
                    if let error = error { continuation.resume(throwing: error) }
                    else if let value = value { continuation.resume(returning: value) }
                    else { continuation.resume(throwing: NSError(domain: "CloudDirectQAResponse", code: 1)) }
                }
            } catch { continuation.resume(throwing: error) }
        }
        guard let encoded = response["bodyBase64"] as? String, let body = Data(base64Encoded: encoded),
              let session = try JSONSerialization.jsonObject(with: body) as? [String: Any] else { throw NSError(domain: "CloudDirectQAResponse", code: 2) }
        let headers = response["headers"] as? [String: String] ?? [:]
        let checks: [String: Bool] = ["http200": response["status"] as? Int == 200,
            "anonymous": session["authenticated"] as? Bool == false, "required": session["required"] as? Bool == true,
            "enabled": session["enabled"] as? Bool == true,
            "accountsMode": session["mode"] as? String == "accounts", "workspaceNull": session["workspace_id"] is NSNull,
            "identityNull": session["identity"] is NSNull, "bindingNull": session["cache_binding"] is NSNull,
            "memberNull": session["member"] is NSNull, "noExposedSetCookie": !headers.keys.contains { $0.lowercased() == "set-cookie" }]
        for (name, passed) in checks { XCTAssertTrue(passed, name) }
        guard checks.values.allSatisfy({ $0 }) else { throw NSError(domain: "CloudDirectQAResponse", code: 3) }
        var evidence: [String: Any] = checks
        evidence["actualPluginNativeHTTPS"] = true; evidence["requests"] = 1; evidence["mutations"] = 0
        try JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys]).write(to: resultURL, options: [.atomic, .completeFileProtection])
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: resultURL.path)
    }
#endif

    func testBackupExactQueryAndInt64RangeBounds() throws {
        let id = "00000000-0000-0000-0000-000000000001", path = "/api/backup?job_id=" + id
        XCTAssertEqual(try FountainBackupPlan.id(path), id); XCTAssertNil(try FountainBackupPlan.id("/api/backup"))
        for invalid in [path + "&extra=1", path + "#fragment", path + "&job_id=" + id, "/api/backup?job_id=%30" + id.dropFirst(), path + "\n"] {
            XCTAssertThrowsError(try FountainBackupPlan.id(String(invalid)))
        }
        let plan = try FountainBackupPlan(encoded(["id": id, "phase": "ready", "size": Int64(6_000_000_123), "sha256": String(repeating: "a", count: 64), "expires_at": "2099-01-01T00:00:00Z"]), id: id)
        XCTAssertEqual(plan.size, 6_000_000_123)
        let url = URL(string: "https://native-backup-qa.invalid/api/backup")!
        let good = HTTPURLResponse(url: url, statusCode: 206, httpVersion: nil, headerFields: ["Content-Range": "bytes 6000000000-6000000122/6000000123", "Content-Length": "123"])!
        try plan.piece(good, offset: 6_000_000_000, length: 123, received: 123)
        for status in [200, 302, 416] {
            let bad = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Range": "bytes 0-262143/6000000123", "Content-Length": "262144"])!
            XCTAssertThrowsError(try plan.piece(bad, offset: 0, length: 262144, received: 262144))
        }
    }
    @MainActor func testActualHTTPSBackupRangeHashCancelAndOwnerFence() async throws {
        // Explicit isolated loopback fixture; root CA is installed only on the dedicated QA Simulator.
        let view = try await webView(); XCTAssertEqual(view.url?.host, "localhost")
        for _ in 0..<100 {
            if (try? await script("return !!globalThis.Capacitor?.isPluginAvailable('FountainNative');")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let configured = try await script("const p=Capacitor.registerPlugin('FountainNative');globalThis.__backupQA={p,results:{}};return await p.configure({origin:'https://127.0.0.1:61602'});") as! [String: Any]
        let generation = configured["generation"] as! Int
        let original = try temporary("backup-qa-original.txt"); let source = Data("last original offline input 🏠".utf8); try source.write(to: original)
        func login(_ mode: String) async throws {
            let result = try await script("const p=__backupQA.p;return await p.request({id:crypto.randomUUID(),generation,method:'POST',path:'/api/session',headers:{'Content-Type':'application/json'},bodyBase64:btoa(JSON.stringify({mode})),timeoutMs:30000});", arguments: ["generation": generation, "mode": mode]) as! [String: Any]
            XCTAssertEqual(result["status"] as? Int, 200)
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        func start() async throws -> String {
            let id = UUID().uuidString
            _ = try await script("(async()=>{for(let attempt=0;attempt<100;attempt++){try{return await __backupQA.p.download({id,generation,path:'/api/backup?job_id=00000000-0000-0000-0000-000000000001',filename:'fountain-backup-qa.sqlite'});}catch(error){if(error.code!=='NATIVE_BUSY'||attempt===99)throw error;await new Promise(resolve=>setTimeout(resolve,50));}}})().then(value=>__backupQA.results[id]={ok:true,value},error=>__backupQA.results[id]={ok:false,code:error.code});return true;", arguments: ["generation": generation, "id": id]); return id
        }
        func result(_ id: String) async throws -> [String: Any] {
            for _ in 0..<200 {
                if let value = try await script("return __backupQA.results[id]||null;", arguments: ["id": id]) as? [String: Any] { return value }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw NSError(domain: "BackupQA", code: 2)
        }
        func files() -> [URL] {
            let manager = FileManager.default
            return ((try? manager.contentsOfDirectory(at: manager.temporaryDirectory, includingPropertiesForKeys: nil)) ?? []).filter { $0.lastPathComponent.hasPrefix("Fountain-") }.map { $0.appendingPathComponent("fountain-backup-qa.sqlite") }.filter { manager.fileExists(atPath: $0.path) }
        }
        try await login("normal"); let normal = try await start()
        var displayed = false
        for _ in 0..<200 {
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene, scene.windows.first?.rootViewController?.presentedViewController is UIDocumentPickerViewController { displayed = true; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let early = try await script("return __backupQA.results[id]||null;", arguments: ["id": normal])
        XCTAssertTrue(displayed, "Verified download reaches actual iOS picker; outcome=\(early)")
        let exports = files(); XCTAssertEqual(exports.count, 1)
        if let exported = exports.first {
            let bytes = try Data(contentsOf: exported)
            var expected = Data(capacity: 786555)
            for index in 0..<786555 { expected.append(UInt8((index * 31 + index / 65536 * 17) & 255)) }
            XCTAssertEqual(bytes, expected)
        }
        _ = try await script("return await __backupQA.p.cancel({id});", arguments: ["id": normal])
        let cancelledNormal = try await result(normal); XCTAssertEqual(cancelledNormal["ok"] as? Bool, false)
        for mode in ["hash", "range", "denied"] {
            try await login(mode); let id = try await start(); let denied = try await result(id); XCTAssertEqual(denied["ok"] as? Bool, false, mode)
            XCTAssertTrue(files().isEmpty); XCTAssertEqual(try Data(contentsOf: original), source)
        }
        try await login("cancel"); let pending = try await start(); try await Task.sleep(nanoseconds: 250_000_000)
        _ = try await script("return await __backupQA.p.cancel({id});", arguments: ["id": pending])
        let cancelled = try await result(pending); XCTAssertEqual(cancelled["ok"] as? Bool, false)
        XCTAssertTrue(files().isEmpty); XCTAssertEqual(try Data(contentsOf: original), source)
        try await login("cancel"); let loggedOut = try await start(); try await Task.sleep(nanoseconds: 250_000_000)
        _ = try await script("return await __backupQA.p.request({id:crypto.randomUUID(),generation,method:'DELETE',path:'/api/session',bodyBase64:'',timeoutMs:30000});", arguments: ["generation": generation])
        let logoutOutcome = try await result(loggedOut); XCTAssertEqual(logoutOutcome["ok"] as? Bool, false)
        XCTAssertTrue(files().isEmpty); XCTAssertEqual(try Data(contentsOf: original), source)
    }

    @MainActor func testActualSupabaseOwnerSessionAndPrivatePage() async throws {
        let manager = FileManager.default
        let cache = try manager.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let inputURL = cache.appendingPathComponent("fountain-cloud-native-qa.json")
        try XCTSkipUnless(manager.fileExists(atPath: inputURL.path), "Opt-in private disposable cloud input required")
        let attributes = try manager.attributesOfItem(atPath: inputURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertLessThanOrEqual((attributes[.size] as? NSNumber)?.intValue ?? Int.max, 16384)
        let inputData = try Data(contentsOf: inputURL); try manager.removeItem(at: inputURL)
        guard let input = try JSONSerialization.jsonObject(with: inputData) as? [String: String],
              input["origin"] == "https://127.0.0.1:61603", input["workspaceId"] == "fountain-qa-cloud-accounts-75254a74761a4888",
              let email = input["email"], let password = input["password"] else { throw NSError(domain: "CloudQAInput", code: 1) }
        _ = try await webView()
        for _ in 0..<100 {
            if (try? await script("return !!globalThis.Capacitor?.isPluginAvailable('FountainNative');")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let configured = try await script("const p=Capacitor.registerPlugin('FountainNative');globalThis.__cloudQA=p;return await p.configure({origin:'https://127.0.0.1:61603'});") as! [String: Any]
        let generation = configured["generation"] as! Int
        XCTAssertEqual(configured["outboxEnabled"] as? Bool, false)
        func request(_ method: String, _ path: String, _ body: [String: String]? = nil) async throws -> [String: Any] {
            let raw = try body.map { try JSONSerialization.data(withJSONObject: $0).base64EncodedString() } ?? ""
            let value = try await script("return await __cloudQA.request({id:crypto.randomUUID(),generation,method,path,headers:body?{'Content-Type':'application/json'}:{},bodyBase64:body,timeoutMs:45000});", arguments: ["generation": generation, "method": method, "path": path, "body": raw]) as! [String: Any]
            XCTAssertEqual(value["status"] as? Int, 200, "Actual cloud response")
            let headers = value["headers"] as? [String: String] ?? [:]
            XCTAssertFalse(headers.keys.contains { $0.lowercased() == "set-cookie" })
            guard let encoded = value["bodyBase64"] as? String, let bytes = Data(base64Encoded: encoded), let decoded = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw NSError(domain: "CloudQAResponse", code: 1) }
            return decoded
        }
        var authenticated = false
        do {
            let login = try await request("POST", "/api/session", ["email": email, "password": password]); authenticated = true
            XCTAssertEqual(login["authenticated"] as? Bool, true); XCTAssertEqual(login["mode"] as? String, "accounts")
            let current = try await request("GET", "/api/session"), member = current["member"] as! [String: Any]
            XCTAssertEqual(current["authenticated"] as? Bool, true); XCTAssertEqual(current["workspace_id"] as? String, input["workspaceId"])
            XCTAssertEqual(member["id"] as? String, "local"); XCTAssertEqual(member["role"] as? String, "owner"); XCTAssertEqual(member["active"] as? Bool, true)
            XCTAssertEqual(current["cache_binding"] as? String, login["cache_binding"] as? String)
            let page = try await request("GET", "/api/pages/qa-accounts-private"), detail = page["page"] as! [String: Any]
            XCTAssertEqual(detail["id"] as? String, "qa-accounts-private"); XCTAssertEqual(detail["access_level"] as? Int, 4)
            let after = try await request("GET", "/api/session"), afterMember = after["member"] as! [String: Any]
            XCTAssertEqual(after["workspace_id"] as? String, input["workspaceId"]); XCTAssertEqual(afterMember["id"] as? String, "local"); XCTAssertEqual(afterMember["role"] as? String, "owner"); XCTAssertEqual(after["cache_binding"] as? String, current["cache_binding"] as? String)
            var evidence: [String: Any] = ["platform": "ios", "actualNativeHTTPS": true, "actualSupabase": true, "memberId": "local", "role": "owner", "workspaceId": input["workspaceId"]!, "pageId": "qa-accounts-private", "bindingSHA256": FountainOutbox.hash(Data((current["cache_binding"] as! String).utf8)), "titleSHA256": FountainOutbox.hash(Data((detail["title"] as! String).utf8)), "outboxEnabled": false]
            _ = try await request("DELETE", "/api/session"); authenticated = false
            let ended = try await request("GET", "/api/session"); XCTAssertEqual(ended["authenticated"] as? Bool, false); evidence["logoutVerified"] = true
            let result = cache.appendingPathComponent("fountain-cloud-native-result.json")
            try JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys]).write(to: result, options: [.atomic, .completeFileProtection]); try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: result.path)
        } catch {
            if authenticated { _ = try? await request("DELETE", "/api/session") }
            throw error
        }
    }

}
