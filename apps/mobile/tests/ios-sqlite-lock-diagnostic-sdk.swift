import XCTest
import Foundation
import SQLite3
import Darwin
#if os(iOS)
@testable import App
#endif

/// Controlled comparison only. All-PASS does not establish the cause of a prior
/// lock failure. Native authority is synthetic; production Core/SQLite are real.
final class FountainSQLiteLockDiagnosticTests: XCTestCase {
    #if !os(iOS)
    private static let hostOwnership = NSRecursiveLock()
    #endif
    private static func ownership<T>(_ operation: () throws -> T) throws -> T {
        #if os(iOS)
        return try FountainNative.withQAOutboxOwnership(operation)
        #else
        hostOwnership.lock(); defer { hostOwnership.unlock() }
        return try operation()
        #endif
    }
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var done = false, stopped = false, commits = 0, polls = 0
        var first: [String: Any] = [:]
        func update(_ body: (State) -> Void) { lock.lock(); defer { lock.unlock() }; body(self) }
        func snapshot() -> (Bool, Bool, Int, Int, [String: Any]) { lock.lock(); defer { lock.unlock() }; return (done, stopped, commits, polls, first) }
        func fail(_ value: [String: Any]) { update { if $0.first.isEmpty { $0.first = value }; $0.stopped = true } }
    }
    private static func require(_ condition: @autoclosure () throws -> Bool) throws { if try !condition() { throw FountainOutboxError.invalid } }
    private static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]) }
    private static func privateItem(_ file: URL, directory: Bool) throws {
        var info = stat()
        try require(lstat(file.path, &info) == 0 && info.st_uid == getuid() && info.st_mode & 0o777 == (directory ? 0o700 : 0o600))
        try require(info.st_mode & mode_t(S_IFMT) == mode_t(directory ? S_IFDIR : S_IFREG) && file.standardizedFileURL.path == file.resolvingSymlinksInPath().path)
    }
    private static func consume(_ file: URL) throws -> String {
        try privateItem(file, directory: false)
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); try require(descriptor >= 0)
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }; var info = stat()
        try require(fstat(descriptor, &info) == 0 && info.st_uid == getuid() && info.st_mode & 0o777 == 0o600 && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && info.st_size > 0 && info.st_size <= 100)
        guard let raw = try handle.read(upToCount: 101), raw.count == Int(info.st_size), let value = try JSONSerialization.jsonObject(with: raw) as? [String: String], Set(value.keys) == Set(["nonce"]), let nonce = value["nonce"] else { throw FountainOutboxError.invalid }
        try require(nonce.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil && json(value) == raw)
        try require(unlink(file.path) == 0); return nonce
    }
    private static func seal(_ file: URL, _ value: [String: Any]) throws {
        let descriptor = Darwin.open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600)); try require(descriptor >= 0)
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        do { try handle.write(contentsOf: json(value)); try require(fsync(descriptor) == 0); try handle.close() } catch { try? handle.close(); throw error }
        let parent = Darwin.open(file.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW); try require(parent >= 0)
        defer { Darwin.close(parent) }; try require(fsync(parent) == 0)
    }
    /// Metadata-only inspection: never open/close the DB to inspect an FD.
    private static func fds(_ file: URL) -> [String: Any] {
        var item = stat(); let found = lstat(file.path, &item) == 0
        var count = 0, matching = 0, ro = 0, rw = 0, wo = 0, invalidFlags = 0
        for fd in Int32(0)..<Int32(256) {
            var current = stat(); if fstat(fd, &current) != 0 { continue }; count += 1
            if found && current.st_dev == item.st_dev && current.st_ino == item.st_ino {
                matching += 1; let flags = fcntl(fd, F_GETFL)
                if flags < 0 { invalidFlags += 1 }
                else { switch flags & O_ACCMODE { case O_RDONLY: ro += 1; case O_RDWR: rw += 1; case O_WRONLY: wo += 1; default: break } }
            }
        }
        return ["scannedFDLimit": 256, "existingFDCount": count, "dbLstat": found, "dbDevice": Int(item.st_dev), "dbInode": UInt64(item.st_ino), "matchingDBFDCount": matching, "matchingReadOnlyCount": ro, "matchingReadWriteCount": rw, "matchingWriteOnlyCount": wo, "matchingInvalidFlagsCount": invalidFlags]
    }
    private static func failure(_ state: State, _ file: URL, _ site: String, db: OpaquePointer?, status: Int32) {
        // These connection error values are captured BEFORE finalize/close/fstat.
        let ambient = errno, code = db.map { sqlite3_errcode($0) } ?? status, extended = db.map { sqlite3_extended_errcode($0) } ?? status
        let system = db.map { sqlite3_system_errno($0) } ?? 0
        state.fail(["site": site, "sqliteStatus": Int(status), "sqliteCode": Int(code), "sqliteExtendedCode": Int(extended), "sqliteSystemErrno": Int(system), "errno": Int(ambient), "fdMetadata": fds(file)])
    }
    private static func openReader(_ file: URL, _ state: State) throws -> OpaquePointer {
        var db: OpaquePointer?
        let status = sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil)
        guard status == SQLITE_OK, let db else { failure(state, file, "reader-open", db: db, status: status); if let db { sqlite3_close_v2(db) }; throw FountainOutboxError.storage }
        let busy = sqlite3_busy_timeout(db, 1000)
        if busy != SQLITE_OK { failure(state, file, "reader-busy-timeout", db: db, status: busy); sqlite3_close_v2(db); throw FountainOutboxError.storage }; return db
    }
    // Same query and open/fullmutex/busy1000/column-text/finalize/close lifecycle
    // as FountainNativeTests.retainedBytes + sql(readOnly:true).
    private static func poll(_ db: OpaquePointer, _ file: URL, _ state: State) throws {
        let sql = "SELECT 'record',bucket,key,profile_id,hex(value) FROM records UNION ALL SELECT 'recovery',bucket,key,profile_id,hex(value) FROM recovery UNION ALL SELECT 'staging',tx_id,CAST(part AS TEXT),lease,hex(data) FROM staging UNION ALL SELECT 'receipt',tx_id,digest,CAST(head AS TEXT),'' FROM tx_receipts ORDER BY 1,2,3,4,5"
        var statement: OpaquePointer?
        let prepared = sqlite3_prepare_v2(db, sql, -1, &statement, nil)
        guard prepared == SQLITE_OK else { failure(state, file, "reader-prepare", db: db, status: prepared); if let statement { sqlite3_finalize(statement) }; throw FountainOutboxError.storage }
        defer { sqlite3_finalize(statement) }
        var rows: [[String]] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { break }
            guard status == SQLITE_ROW else { failure(state, file, "reader-step", db: db, status: status); throw FountainOutboxError.storage }
            rows.append((0..<sqlite3_column_count(statement)).map { sqlite3_column_text(statement, $0).map { String(cString: $0) } ?? "" })
        }
        try require(!rows.isEmpty); state.update { $0.polls += 1 }
    }
    private static func draft(_ profile: String, _ sequence: Int) -> [String: Any] {
        let resource = profile + "|page"
        return ["op": "put", "bucket": "drafts", "key": [resource, "lock-client"], "value": ["key": resource, "profileId": profile, "clientId": "lock-client", "updatedAt": sequence,
            "draft": ["epoch": "epoch", "reason": "pending", "blocks": [["id": "paragraph", "type": "paragraph", "text": "Isolated diagnostic edit \(sequence)"]]]]]
    }
    private static func submit(_ store: FountainOutbox, _ origin: String, _ changes: [[String: Any]], _ tx: String) throws {
        let opened = try store.open(), bytes = try json(["version": 1, "origin": origin, "mode": "active", "changes": changes])
        try store.stage(lease: opened["lease"] as! String, txID: tx, baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, part: 0, bytes: bytes)
        let accepted = try store.commit(lease: opened["lease"] as! String, txID: tx, baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, digest: FountainOutbox.hash(bytes))
        try require(accepted["head"] as? Int == (opened["head"] as! Int) + 1 && accepted["txId"] as? String == tx)
    }
    private static func seed(_ store: FountainOutbox, _ origin: String) throws -> String {
        let session: [String: Any] = ["authenticated": true, "required": false, "mode": "local", "workspace_id": "workspace", "cache_binding": "binding", "member": ["id": "member", "role": "owner", "active": true]]
        try store.grant(session, sessionRef: nil); try store.ensureOwner("lock-diagnostic-owner", epoch: 1)
        let page: [String: Any] = ["id": "page", "access_level": 4, "locked": false, "archived": false, "revision": 1]
        let envelope: [String: Any] = ["workspace_id": "workspace", "current_member_id": "member", "session_binding": "binding", "access_revision": 1, "data_revision": 1]
        var workspace = envelope; workspace["pages"] = [page]; workspace["databases"] = []; workspace["teamspaces"] = [["id": "general", "access_level": 3]]
        var snapshot = envelope; snapshot["page"] = page; snapshot["access_level"] = 4; snapshot["epoch"] = "epoch"; snapshot["seq"] = 0; snapshot["blocks"] = []
        snapshot["state"] = ["version": 1, "max_clock": 0, "blocks": [:], "seen": [:]] as [String: Any]
        try store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: json(workspace), sessionRef: nil)
        try store.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 200, data: json(snapshot), sessionRef: nil)
        let profile = try store.open()["profileId"] as! String, resource = profile + "|page"
        try submit(store, origin, [["op": "put", "bucket": "snapshots", "key": resource, "value": ["key": resource, "profileId": profile, "snapshot": snapshot]], draft(profile, 0)], "baseline")
        return profile
    }
    private static func arm(_ index: Int, _ root: URL) throws -> [String: Any] {
        let directory = root.appendingPathComponent("arm-\(index)", isDirectory: true), origin = "https://lock-arm-\(index).invalid"
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete]); try privateItem(directory, directory: true)
        let file = directory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite"), state = State()
        let ready = DispatchSemaphore(value: 0), start = DispatchSemaphore(value: 0), finished = DispatchGroup()
        let evidenceBefore = FountainOutbox.qaStorageEvidence(); finished.enter()
        DispatchQueue(label: "fountain.qa.sqlite-lock.writer.\(index)").async {
            var store: FountainOutbox?
            defer {
                do { try ownership { store?.close() } }
                catch { state.fail(["site": "writer-ownership-close"]) }
                state.update { $0.done = true }; ready.signal(); finished.leave()
            }
            do {
                let profile = try ownership {
                    store = try FountainOutbox(origin: origin, testingDirectory: directory)
                    return try seed(store!, origin)
                }
                ready.signal(); try require(start.wait(timeout: .now() + 20) == .success)
                for update in 1...128 {
                    if state.snapshot().1 { break }
                    try ownership { try submit(store!, origin, [draft(profile, update)], "update-\(update)") }; state.update { $0.commits += 1 }
                    usleep(1000)
                }
            } catch {
                let ambient = errno, native = FountainOutbox.qaStorageEvidence()
                state.fail(["site": "production-writer", "nativeStorageEvidence": native, "nativeStorageEvidenceIsNew": native != evidenceBefore, "errno": Int(ambient), "fdMetadata": fds(file)])
            }
        }
        let readyStatus = ready.wait(timeout: .now() + 20); var persistent: OpaquePointer?
        if readyStatus != .success { state.fail(["site": "fixture-ready-timeout"]) }
        if !state.snapshot().1 && index == 2 {
            do { persistent = try ownership { try openReader(file, state) } }
            catch { if state.snapshot().4.isEmpty { state.fail(["site": "reader-ownership-open"]) } }
        }
        let beforeFD = fds(file); start.signal()
        if index != 0 {
            for _ in 0..<2048 {
                if state.snapshot().0 || state.snapshot().1 { break }
                do {
                    try ownership {
                        let db = try persistent ?? openReader(file, state)
                        if index == 1 { defer { sqlite3_close_v2(db) }; try poll(db, file, state) }
                        else { try poll(db, file, state) }
                    }
                } catch { if state.snapshot().4.isEmpty { state.fail(["site": "reader-fixture-check", "fdMetadata": fds(file)]) }; break }
                usleep(1000)
            }
        }
        let completed = finished.wait(timeout: .now() + 60) == .success
        if !completed { state.fail(["site": "fixture-writer-timeout"]) }
        let writerEndFD = fds(file)
        // Persistent RO is deliberately retained until writer connection closes.
        if completed, let persistent {
            do { try ownership { _ = sqlite3_close_v2(persistent) } }
            catch { state.fail(["site": "reader-ownership-close"]) }
        }
        let snapshot = state.snapshot(), passed = completed && snapshot.4.isEmpty && snapshot.2 == 128 && (index == 0 || snapshot.3 > 0)
        return ["arm": ["writer-only", "reader-open-close", "reader-persistent"][index], "passed": passed, "updatesRequested": 128, "updatesCommitted": snapshot.2, "readerPolls": snapshot.3,
                "writerCompleted": completed, "firstError": snapshot.4, "beforeConcurrentFD": beforeFD, "afterWriterFD": writerEndFD, "afterReaderCloseFD": fds(file)]
    }
    func testThreeArmsOfConcurrentReadOnlyPolling() throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["FOUNTAIN_QA"] == "1" && env["FOUNTAIN_OUTBOX_QA"] == "1" && env["FOUNTAIN_SQLITE_LOCK_QA"] == "1" && (env["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), "Explicit dedicated SQLite lock diagnostic required")
        let manager = FileManager.default, documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true), input = documents.appendingPathComponent("fountain-sqlite-lock-input.json")
        try XCTSkipUnless(manager.fileExists(atPath: input.path), "Protected Root-owned nonce input required")
        let nonce = try Self.consume(input), root = documents.appendingPathComponent("fountain-sqlite-lock-" + nonce, isDirectory: true)
        try Self.require(!manager.fileExists(atPath: root.path)); try manager.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete]); try Self.privateItem(root, directory: true)
        var results: [[String: Any]] = []
        for index in 0..<3 {
            let result = try Self.arm(index, root); results.append(result)
            if result["writerCompleted"] as? Bool != true { break }
        }
        let passed = results.count == 3 && results.allSatisfy { $0["passed"] as? Bool == true }
        try Self.seal(documents.appendingPathComponent("fountain-sqlite-lock-result.json"), ["nonce": nonce, "pid": Int(getpid()), "actualSDKSQLite": true, "syntheticAuthority": true, "allPassed": passed, "armsAttempted": results.count, "arms": results, "fixtureRetained": true, "causalConclusion": false])
        XCTAssertTrue(passed, "Controlled SQLite comparison failed; protected result and isolated fixtures retained")
    }
}
