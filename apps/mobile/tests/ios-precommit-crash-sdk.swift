import XCTest
import Foundation
import SQLite3
import Darwin
#if os(iOS)
@testable import App
#endif

/// Actual SDK SQLite. Synthetic native authority. Root kills the QA PID after
/// durable staging and BEFORE active COMMIT; this is not a mid-transaction kill.
final class FountainPrecommitCrashTests: XCTestCase {
    private let prefix = "fountain-precommit-crash-"
    private func require(_ value: @autoclosure () throws -> Bool) throws {
        if try !value() { throw NSError(domain: "PrecommitCrashFixture", code: 1) }
    }
    private func json(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed])
    }
    private func owned(_ file: URL, directory: Bool) throws {
        var info = stat()
        try require(lstat(file.path, &info) == 0 && info.st_uid == getuid() && info.st_mode & 0o777 == (directory ? 0o700 : 0o600))
        try require(info.st_mode & mode_t(S_IFMT) == mode_t(directory ? S_IFDIR : S_IFREG))
        try require(file.standardizedFileURL.path == file.resolvingSymlinksInPath().path)
    }
    private func read(_ file: URL, consume: Bool = false) throws -> Data {
        try owned(file, directory: false)
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        try require(descriptor >= 0)
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        try require(fstat(descriptor, &info) == 0 && info.st_uid == getuid() && info.st_mode & 0o777 == 0o600 && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && info.st_size > 0 && info.st_size <= 32768)
        guard let raw = try handle.read(upToCount: 32769) else { throw FountainOutboxError.storage }
        try require(raw.count == Int(info.st_size))
        if consume { try require(unlink(file.path) == 0) }
        return raw
    }
    private func seal(_ file: URL, _ value: [String: Any]) throws {
        let raw = try json(value), descriptor = Darwin.open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
        try require(descriptor >= 0)
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        do { try handle.write(contentsOf: raw); try require(fsync(descriptor) == 0); try handle.close() }
        catch { try? handle.close(); throw error }
        let parent = Darwin.open(file.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        try require(parent >= 0); defer { Darwin.close(parent) }; try require(fsync(parent) == 0)
        try require(read(file) == raw)
    }
    /// Read-only opens prove retained bytes before constructing the next engine.
    private func sql(_ file: URL, _ query: String, _ parameters: [String] = []) throws -> [[Any]] {
        var db: OpaquePointer?, statement: OpaquePointer?
        try require(sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW, nil) == SQLITE_OK)
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        try require(sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK)
        for (index, parameter) in parameters.enumerated() {
            try require(sqlite3_bind_text(statement, Int32(index + 1), parameter, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) == SQLITE_OK)
        }
        var rows: [[Any]] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return rows }; try require(status == SQLITE_ROW)
            rows.append((0..<sqlite3_column_count(statement)).map { column -> Any in
                switch sqlite3_column_type(statement, column) {
                case SQLITE_BLOB: return Data(bytes: sqlite3_column_blob(statement, column)!, count: Int(sqlite3_column_bytes(statement, column)))
                case SQLITE_INTEGER: return Int(sqlite3_column_int64(statement, column))
                case SQLITE_NULL: return NSNull()
                default: return String(cString: sqlite3_column_text(statement, column))
                }
            })
        }
    }
    private func source(_ file: URL) throws -> String {
        var tables: [[Any]] = []
        for table in ["records", "recovery", "tx_receipts", "tombstones"] {
            let rows = try sql(file, "SELECT * FROM " + table + " ORDER BY rowid").map { row in row.map { value -> Any in
                if let bytes = value as? Data { return ["blob", bytes.base64EncodedString()] }
                if let number = value as? Int { return ["integer", number] }
                if value is NSNull { return ["null", NSNull()] }
                return ["text", value]
            } }
            tables.append([table, rows])
        }
        return FountainOutbox.hash(try json(tables))
    }
    private func staged(_ file: URL, _ tx: String) throws -> Data {
        let rows = try sql(file, "SELECT data FROM staging WHERE tx_id=? ORDER BY part", [tx])
        try require(rows.count == 1)
        guard let bytes = rows.first?.first as? Data else { throw FountainOutboxError.storage }; return bytes
    }
    private func put(_ bucket: String, _ key: Any, _ value: [String: Any]) -> [String: Any] { ["op": "put", "bucket": bucket, "key": key, "value": value] }
    private func draft(_ profile: String, _ text: String) -> [String: Any] {
        let resource = profile + "|page"
        return put("drafts", [resource, "crash-client"], ["key": resource, "profileId": profile, "clientId": "crash-client", "updatedAt": 1,
            "draft": ["epoch": "epoch", "reason": "pending", "blocks": [["id": "paragraph", "type": "paragraph", "text": text]]]])
    }
    private func delta(_ origin: String, _ changes: [[String: Any]]) throws -> Data { try json(["version": 1, "origin": origin, "mode": "active", "changes": changes]) }
    private func stage(_ store: FountainOutbox, _ tx: String, _ bytes: Data) throws -> [String: Any] {
        let opened = try store.open()
        try store.stage(lease: opened["lease"] as! String, txID: tx, baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, part: 0, bytes: bytes)
        return opened
    }
    private func seed(_ store: FountainOutbox, _ origin: String) throws {
        let session: [String: Any] = ["authenticated": true, "required": false, "mode": "local", "workspace_id": "workspace", "cache_binding": "binding", "member": ["id": "member", "role": "owner", "active": true]]
        try store.grant(session, sessionRef: nil); try store.ensureOwner("precommit-owner", epoch: 1)
        let page: [String: Any] = ["id": "page", "access_level": 4, "locked": false, "archived": false, "revision": 1]
        let envelope: [String: Any] = ["workspace_id": "workspace", "current_member_id": "member", "session_binding": "binding", "access_revision": 1, "data_revision": 1]
        var workspace = envelope; workspace["pages"] = [page]; workspace["databases"] = []; workspace["teamspaces"] = [["id": "general", "access_level": 3]]
        var snapshot = envelope; snapshot["page"] = page; snapshot["access_level"] = 4; snapshot["epoch"] = "epoch"; snapshot["seq"] = 0; snapshot["blocks"] = []
        snapshot["state"] = ["version": 1, "max_clock": 0, "blocks": [:], "seen": [:]] as [String: Any]
        try store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: json(workspace), sessionRef: nil)
        try store.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 200, data: json(snapshot), sessionRef: nil)
        let profile = try store.open()["profileId"] as! String, resource = profile + "|page"
        let bytes = try delta(origin, [put("snapshots", resource, ["key": resource, "profileId": profile, "snapshot": snapshot]), draft(profile, "Committed baseline")])
        let opened = try stage(store, "baseline", bytes)
        _ = try store.commit(lease: opened["lease"] as! String, txID: "baseline", baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, digest: FountainOutbox.hash(bytes))
    }
    func testRootManagedKillAfterStageBeforeActiveCommit() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && environment["FOUNTAIN_OUTBOX_QA"] == "1" && environment["FOUNTAIN_PRECOMMIT_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), "Explicit dedicated pre-COMMIT QA required")
        let manager = FileManager.default, documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let input = documents.appendingPathComponent(prefix + "input.json")
        try XCTSkipUnless(manager.fileExists(atPath: input.path), "Root-owned protected phase input required")
        let raw = try read(input)
        guard let inputValue = try JSONSerialization.jsonObject(with: raw) as? [String: String], Set(inputValue.keys) == Set(["phase", "nonce"]), let phase = inputValue["phase"], let nonce = inputValue["nonce"] else { throw FountainOutboxError.invalid }
        try require(["prepare", "verify"].contains(phase) && nonce.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil)
        try require(json(inputValue) == raw); _ = try read(input, consume: true)
        let root = documents.appendingPathComponent(prefix + nonce, isDirectory: true), origin = "https://precommit-" + nonce + ".invalid", tx = "pending-" + nonce
        if phase == "prepare" { try require(!manager.fileExists(atPath: root.path)); try manager.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete]) }
        try owned(root, directory: true)
        let file = root.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite"), stateFile = root.appendingPathComponent("state.json")
        let ready = documents.appendingPathComponent(prefix + "ready.json"), result = documents.appendingPathComponent(prefix + "result.json")
        if phase == "prepare" {
            let store = try FountainOutbox(origin: origin, testingDirectory: root); defer { store.close() }
            try seed(store, origin); let opened = try store.open(), before = try source(file), profile = opened["profileId"] as! String
            let pending = try delta(origin, [draft(profile, "Uncommitted exact input " + nonce)]), digest = FountainOutbox.hash(pending)
            _ = try stage(store, tx, pending); try require(staged(file, tx) == pending && source(file) == before)
            try seal(stateFile, ["nonce": nonce, "pid": Int(getpid()), "profile": profile, "sourceSHA256": before, "digest": digest, "baseHead": opened["head"]!, "proofEpoch": opened["proofEpoch"]!, "lease": opened["lease"]!])
            try seal(ready, ["nonce": nonce, "pid": Int(getpid()), "staged": true, "beforeActiveCommit": true, "digest": digest, "sourceSHA256": before, "head": opened["head"]!])
            // Root verifies the ready nonce/PID then kills ONLY this QA process.
            // There is deliberately NO pending delta COMMIT call on this path.
            while true { Thread.sleep(forTimeInterval: 1) }
        }
        guard let state = try JSONSerialization.jsonObject(with: read(stateFile)) as? [String: Any], let priorPID = state["pid"] as? Int, let profile = state["profile"] as? String, let digest = state["digest"] as? String, let before = state["sourceSHA256"] as? String, let head = state["baseHead"] as? Int, let proof = state["proofEpoch"] as? Int else { throw FountainOutboxError.invalid }
        try require(state["nonce"] as? String == nonce && priorPID != Int(getpid())); try owned(file, directory: false)
        let pending = try delta(origin, [draft(profile, "Uncommitted exact input " + nonce)])
        try require(sql(file, "PRAGMA integrity_check").first?.first as? String == "ok")
        try require(source(file) == before && staged(file, tx) == pending && FountainOutbox.hash(pending) == digest)
        let retainedStage = try sql(file, "SELECT part,base_head,lease FROM staging WHERE tx_id=?", [tx])
        try require(retainedStage.count == 1 && retainedStage[0][0] as? Int == 0 && retainedStage[0][1] as? Int == head && retainedStage[0][2] as? String == state["lease"] as? String)
        let retainedHead = try sql(file, "SELECT value FROM control WHERE id='head'").first?.first as! Data
        let retainedProof = try sql(file, "SELECT value FROM control WHERE id='proofEpoch'").first?.first as! Data
        try require(JSONSerialization.jsonObject(with: retainedHead, options: [.fragmentsAllowed]) as? Int == head && JSONSerialization.jsonObject(with: retainedProof, options: [.fragmentsAllowed]) as? Int == proof)
        try require(sql(file, "SELECT count(*) FROM tx_receipts WHERE tx_id=?", [tx]).first?.first as? Int == 0)
        try require(sql(file, "SELECT count(*) FROM records").first?.first as? Int == 2 && sql(file, "SELECT count(*) FROM tx_receipts").first?.first as? Int == 1)
        let store = try FountainOutbox(origin: origin, testingDirectory: root); defer { store.close() }
        try store.ensureOwner("precommit-owner", epoch: 1); let opened = try store.open()
        let settled = try store.reconcile(["generation": 1, "phase": "settle", "lease": opened["lease"]!, "journals": [["txId": tx, "digest": digest, "baseHead": head, "proofEpoch": proof]]], admissionWatermark: 0, sessionRef: nil)
        try require((settled["settlements"] as? [[String: Any]])?.first?["status"] as? String == "unaccepted")
        try require(staged(file, tx) == pending && source(file) == before)
        try seal(result, ["nonce": nonce, "pid": Int(getpid()), "priorPID": priorPID, "actualSDKSQLite": true, "syntheticAuthority": true, "integrity": true, "stagingExact": true, "sourceUnchanged": true, "pendingReceiptAbsent": true, "settlement": "unaccepted", "digest": digest, "sourceSHA256": before])
        // Root retains evidence, then removes ONLY this verified nonce directory.
    }
}
