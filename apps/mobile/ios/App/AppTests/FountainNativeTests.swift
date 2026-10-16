import XCTest
import UIKit
import WebKit
import SQLite3
import Darwin
import Security
@testable import App

#if DEBUG
// No global URLProtocol registration, TLS exception, shared cookie storage or
// renderer-accessible nonce. Only the opted-in native session installs this.
private final class FountainCloudQAProtocol: URLProtocol, URLSessionDataDelegate, @unchecked Sendable {
    private static let lock = NSLock()
    private static var nonce: String?
    private static var intercepted = 0
    private static var credentialRequests = 0
    private static var candidates = 0
    private static var fixedMatches = 0
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
        nonce = value; intercepted = 0; credentialRequests = 0; candidates = 0; fixedMatches = 0
    }
    static func counts() -> (Int, Int) { lock.lock(); defer { lock.unlock() }; return (intercepted, credentialRequests) }
    static func routingCounts() -> [String: Int] { lock.lock(); defer { lock.unlock() }; return ["protocolCandidates": candidates, "protocolFixedMatches": fixedMatches] }
    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        let matches = url.scheme == "https" && url.host == host && (url.port == nil || url.port == 443) && url.path.hasPrefix(prefix + "/")
        lock.lock(); candidates += 1; if matches { fixedMatches += 1 }; lock.unlock()
        return matches
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        state.lock(); clientThread = Thread.current; state.unlock()
        Self.lock.lock(); let nonce = Self.nonce; Self.lock.unlock()
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

    private func sql(_ file: URL, _ statement: String, _ values: [String] = []) throws -> [[String]] {
        var db: OpaquePointer?; XCTAssertEqual(sqlite3_open(file.path, &db), SQLITE_OK); defer { sqlite3_close_v2(db) }
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
