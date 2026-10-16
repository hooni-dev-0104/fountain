import XCTest
import UIKit
import WebKit
import SQLite3
@testable import App

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
}
