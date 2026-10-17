import Foundation
import SQLite3
import Darwin

@main enum RecoveryLockFixture {
    static func main() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true), python = CommandLine.arguments[2]
        let origin = "https://recovery-lock.invalid", file = directory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
        let store = try FountainOutbox(origin: origin, testingDirectory: directory); store.close()
        var writer: OpaquePointer?
        guard sqlite3_open_v2(file.path, &writer, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        defer { sqlite3_exec(writer, "ROLLBACK", nil, nil, nil); sqlite3_close(writer) }
        guard sqlite3_exec(writer, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        func externallyLocked() throws -> Bool {
            let process = Process(); process.executableURL = URL(fileURLWithPath: python)
            process.arguments = ["-c", "import os,sys,fcntl,errno\nf=os.open(sys.argv[1],os.O_RDWR)\ntry:\n try: fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB,1,1073741825,os.SEEK_SET)\n except OSError as e: sys.exit(0 if e.errno in (errno.EACCES,errno.EAGAIN) else 2)\n else: fcntl.lockf(f,fcntl.LOCK_UN,1,1073741825,os.SEEK_SET);sys.exit(1)\nfinally: os.close(f)", file.path]
            try process.run(); process.waitUntilExit()
            guard [0, 1].contains(process.terminationStatus) else { throw FountainOutboxError.storage }
            return process.terminationStatus == 0
        }
        guard try externallyLocked() else { throw NSError(domain: "RecoveryLockFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Fixture writer failed to hold its own reserved lock"]) }
        let session: [String: Any] = ["authenticated": true, "mode": "accounts", "required": true, "workspace_id": "workspace", "cache_binding": "binding", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), "member": ["id": "member", "role": "owner", "active": true]]
        let authority = try FountainRecovery.Authority.session(JSONSerialization.data(withJSONObject: session), origin: origin, reference: "synthetic-private-lock-test")
        let reader = try FountainRecovery(authority: authority, testingDirectory: directory); defer { reader.close() }
        guard try externallyLocked() else { throw NSError(domain: "RecoveryLockFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Production Recovery constructor cleared another live SQLite connection's reserved lock"]) }
        reader.close()
        guard try externallyLocked() else { throw NSError(domain: "RecoveryLockFixture", code: 3, userInfo: [NSLocalizedDescriptionKey: "SQLite-only reader close cleared the writer lock"]) }
        let linkedDirectory = directory.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createDirectory(at: linkedDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let linkedFile = linkedDirectory.appendingPathComponent(file.lastPathComponent)
        try FileManager.default.createSymbolicLink(at: linkedFile, withDestinationURL: file)
        do {
            let unexpected = try FountainRecovery(authority: authority, testingDirectory: linkedDirectory)
            unexpected.close()
            throw NSError(domain: "RecoveryLockFixture", code: 4, userInfo: [NSLocalizedDescriptionKey: "Production Recovery accepted a symlink database"])
        } catch FountainRecoveryError.storage { }
        guard try externallyLocked() else { throw FountainOutboxError.storage }
        var linked: OpaquePointer?
        let status = sqlite3_open_v2(linkedFile.path, &linked, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW, nil)
        if let linked { sqlite3_close_v2(linked) }
        guard status != SQLITE_OK, try externallyLocked() else { throw FountainOutboxError.storage }
        print("Production Swift Recovery: reserved lock preserved across reader initialization/close; symlink source rejected (macOS SQLite, external-process POSIX probe; no iOS-runtime claim)")
    }
}
