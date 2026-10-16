// Native-only SQLite foundation. Call exclusively on FountainNative's serial
// executor while holding its bridge-owner lock. No SQL or credential is bridged.
import Foundation
import SQLite3
import CryptoKit
import Darwin

enum FountainOutboxError: Error, Equatable {
    case invalid, limit, stale, head, conflict, blocked, storage
    var code: String {
        switch self {
        case .invalid: return "NATIVE_OUTBOX_INVALID"
        case .limit: return "NATIVE_OUTBOX_LIMIT"
        case .stale: return "NATIVE_OUTBOX_STALE"
        case .head: return "NATIVE_OUTBOX_HEAD"
        case .conflict: return "NATIVE_OUTBOX_CONFLICT"
        case .blocked: return "NATIVE_OUTBOX_BLOCKED"
        case .storage: return "NATIVE_STORAGE"
        }
    }
    var message: String { "Native outbox could not confirm this operation" }
}

final class FountainOutbox {
    // Kept as one literal so portable SQLite tests exercise this actual schema.
    static let schema = """
    CREATE TABLE IF NOT EXISTS control (id TEXT PRIMARY KEY NOT NULL,value BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL,key TEXT NOT NULL,profile_id TEXT NOT NULL,resource_key TEXT,value BLOB NOT NULL,PRIMARY KEY(bucket,key));
    CREATE INDEX IF NOT EXISTS records_profile ON records(profile_id,bucket,key);
    CREATE INDEX IF NOT EXISTS records_resource ON records(resource_key);
    CREATE TABLE IF NOT EXISTS tombstones (scope TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,profile_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tx_receipts (tx_id TEXT PRIMARY KEY NOT NULL,digest TEXT NOT NULL,head INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS staging (tx_id TEXT NOT NULL,part INTEGER NOT NULL,lease TEXT NOT NULL,base_head INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(tx_id,part));
    CREATE TABLE IF NOT EXISTS recovery (tx_id TEXT NOT NULL,position INTEGER NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,profile_id TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(tx_id,position));
    """
    private static let buckets = Set(["profiles", "meta", "snapshots", "databaseSnapshots", "localPages", "operations", "drafts", "mutations", "transfers"])
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private let origin: String
    private var database: OpaquePointer?
    private var poisoned = false
    private var owner: String?
    private var authEpoch: Int?
    private var lease: String?
    // Read only while the native bridge-owner lock is held. This fences the
    // final main-thread delivery without opening SQLite on the UI thread.
    private(set) var boundary = UUID().uuidString
    private let partLimit = 256 * 1024
    private let recordLimit = 16 * 1024 * 1024
    private let transactionLimit = 64 * 1024 * 1024

    init(origin: String) throws {
        self.origin = origin
        let manager = FileManager.default
        let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).resolvingSymlinksInPath()
        var directory = support.appendingPathComponent("FountainOutbox", isDirectory: true)
        if !manager.fileExists(atPath: directory.path) {
            try manager.createDirectory(at: directory, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        }
        try Self.privateItem(directory, directory: true)
        var protection = URLResourceValues(); protection.isExcludedFromBackup = true
        try directory.setResourceValues(protection)
        let path = directory.appendingPathComponent(Self.hash(Data(origin.utf8)) + ".sqlite")
        let descriptor = Darwin.open(path.path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
        if descriptor >= 0 { Darwin.close(descriptor) }
        else if errno != EEXIST { throw FountainOutboxError.storage }
        try Self.privateItem(path, directory: false)
        do {
            try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: path.path)
            guard sqlite3_open_v2(path.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
            sqlite3_busy_timeout(database, 5000)
            try execute("PRAGMA journal_mode=DELETE")
            try execute("PRAGMA synchronous=EXTRA")
            try execute("PRAGMA trusted_schema=OFF")
            try execute("PRAGMA secure_delete=ON")
            guard try rows("PRAGMA journal_mode").first?.first as? String == "delete",
                  try integer("PRAGMA synchronous") == 3 else { throw FountainOutboxError.storage }
            let version = try integer("PRAGMA user_version")
            guard version == 0 || version == 1 else { throw FountainOutboxError.storage }
            try transaction {
                guard sqlite3_exec(self.database, Self.schema, nil, nil, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
                try self.execute("PRAGMA user_version=1")
                if try self.control("head") == nil { try self.setControl("head", 0) }
                if try self.control("identity") == nil { try self.setControl("identity", ["state": "unknown"]) }
            }
        } catch { close(); throw FountainOutboxError.storage }
    }

    deinit { close() }
    func close() { if let database = database { sqlite3_close_v2(database) }; database = nil }
    private static func privateItem(_ url: URL, directory: Bool) throws {
        let info = try FileManager.default.attributesOfItem(atPath: url.path)
        guard info[.type] as? FileAttributeType == (directory ? .typeDirectory : .typeRegular),
              (info[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              (info[.posixPermissions] as? NSNumber)?.intValue == (directory ? 0o700 : 0o600) else { throw FountainOutboxError.storage }
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func encodeURIComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")) ?? ""
    }
    private func json(_ value: Any) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) || value is String || value is NSNumber || value is NSNull else { throw FountainOutboxError.invalid }
        do { return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]) }
        catch { throw FountainOutboxError.invalid }
    }
    private func decode(_ data: Data) throws -> Any {
        do { return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) }
        catch { throw FountainOutboxError.invalid }
    }
    private func execute(_ sql: String, _ values: [Any?] = []) throws {
        _ = try rows(sql, values)
    }
    private func rows(_ sql: String, _ values: [Any?] = []) throws -> [[Any]] {
        guard !poisoned, let database = database else { throw FountainOutboxError.storage }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let prepared = statement else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(prepared) }
        for (index, value) in values.enumerated() {
            let status: Int32
            if value == nil || value is NSNull { status = sqlite3_bind_null(prepared, Int32(index + 1)) }
            else if let data = value as? Data {
                status = data.withUnsafeBytes { sqlite3_bind_blob(prepared, Int32(index + 1), $0.baseAddress, Int32(data.count), Self.transient) }
            } else if let value = value as? String { status = sqlite3_bind_text(prepared, Int32(index + 1), value, -1, Self.transient) }
            else if let value = value as? Int { status = sqlite3_bind_int64(prepared, Int32(index + 1), sqlite3_int64(value)) }
            else { throw FountainOutboxError.invalid }
            guard status == SQLITE_OK else { throw FountainOutboxError.storage }
        }
        var result: [[Any]] = []
        while true {
            let status = sqlite3_step(prepared)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW else { throw FountainOutboxError.storage }
            var row: [Any] = []
            for column in 0..<sqlite3_column_count(prepared) {
                switch sqlite3_column_type(prepared, column) {
                case SQLITE_INTEGER: row.append(Int(sqlite3_column_int64(prepared, column)))
                case SQLITE_TEXT: row.append(String(cString: sqlite3_column_text(prepared, column)))
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(prepared, column))
                    if count == 0 { row.append(Data()) }
                    else if let bytes = sqlite3_column_blob(prepared, column) { row.append(Data(bytes: bytes, count: count)) }
                    else { throw FountainOutboxError.storage }
                case SQLITE_NULL: row.append(NSNull())
                default: throw FountainOutboxError.storage
                }
            }
            result.append(row)
        }
    }
    private func integer(_ sql: String, _ values: [Any?] = []) throws -> Int { try rows(sql, values).first?.first as? Int ?? 0 }
    private func control(_ id: String) throws -> Any? {
        guard let data = try rows("SELECT value FROM control WHERE id=?", [id]).first?.first as? Data else { return nil }
        return try decode(data)
    }
    private func setControl(_ id: String, _ value: Any) throws {
        try execute("INSERT INTO control(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [id, try json(value)])
    }
    private func transaction<T>(_ operation: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try operation()
            try execute("COMMIT")
            guard sqlite3_get_autocommit(database) != 0 else { throw FountainOutboxError.storage }
            return result
        } catch {
            _ = try? execute("ROLLBACK")
            if (error as? FountainOutboxError) == .storage { poisoned = true }
            throw error
        }
    }
    private func head() throws -> Int { try control("head") as? Int ?? 0 }
    @discardableResult private func advance() throws -> Int {
        let value = try head()
        guard value < 9_007_199_254_740_991 else { throw FountainOutboxError.storage }
        try setControl("head", value + 1)
        return value + 1
    }
    private func checkedInteger(_ value: Any?) throws -> Int {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
              value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991,
              value.doubleValue.rounded() == value.doubleValue else { throw FountainOutboxError.invalid }
        return value.intValue
    }
    private func text(_ value: Any?, limit: Int = 8192) throws -> String {
        guard let value = value as? String, !value.isEmpty, value.utf8.count <= limit,
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw FountainOutboxError.invalid }
        return value
    }
    private func profileParts(_ id: String) throws -> [String] {
        let parts = id.components(separatedBy: "|")
        guard parts.count == 4, parts[0] == origin else { throw FountainOutboxError.blocked }
        for part in parts.dropFirst() {
            guard let decoded = part.removingPercentEncoding, !decoded.isEmpty,
                  Self.encodeURIComponent(decoded) == part else { throw FountainOutboxError.invalid }
        }
        return parts
    }
    private func resourceProfile(_ key: String) throws -> String {
        let parts = key.components(separatedBy: "|")
        guard parts.count == 5 || (parts.count == 6 && parts[4] == "database"),
              let tail = parts.last, let decoded = tail.removingPercentEncoding, !decoded.isEmpty,
              Self.encodeURIComponent(decoded) == tail else { throw FountainOutboxError.invalid }
        let profile = parts.prefix(4).joined(separator: "|")
        _ = try profileParts(profile)
        return profile
    }
    private func known(_ profile: String) throws -> Bool {
        _ = try profileParts(profile)
        if try control("known:" + profile) != nil { return true }
        return try integer("SELECT count(*) FROM recovery WHERE profile_id=?", [profile]) > 0
    }
    private func identity() throws -> [String: Any] { try control("identity") as? [String: Any] ?? ["state": "unknown"] }
    private func verifiedProfile() throws -> String {
        let value = try identity()
        guard value["state"] as? String == "verified", let profile = value["profileId"] as? String,
              let expiry = value["validUntil"] as? Double, expiry > Date().timeIntervalSince1970 * 1000,
              try integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile]) == 0 else { throw FountainOutboxError.blocked }
        return profile
    }
    private func availableProfile() throws -> String? {
        do { return try verifiedProfile() }
        catch FountainOutboxError.blocked { return nil }
        // Storage and malformed persisted-state failures must reach the native
        // caller's fail-closed boundary, rather than becoming an anonymous view.
    }

    func ensureOwner(_ owner: String, epoch: Int) throws {
        if self.owner == owner && self.authEpoch == epoch && lease != nil { return }
        let next = UUID().uuidString
        try transaction {
            try self.setControl("lease", next)
            try self.execute("DELETE FROM staging")
        }
        self.owner = owner; authEpoch = epoch; lease = next
        boundary = UUID().uuidString
    }
    private func checkLease(_ value: String) throws {
        guard lease == value, try control("lease") as? String == value else { throw FountainOutboxError.stale }
    }
    func open() throws -> [String: Any] {
        let value = try identity()
        let current = try availableProfile()
        return ["lease": lease as Any? ?? NSNull(), "head": try head(),
                "identityState": current == nil ? (value["state"] as? String == "unknown" ? "unknown" : "blocked") : "verified",
                "profileId": current as Any? ?? NSNull(), "validUntil": current == nil ? NSNull() : value["validUntil"] ?? NSNull()]
    }

    // Native caller supplies the hash of its current active cookie, never JS.
    func validateSession(_ reference: String?, eligible: Bool) throws {
        let value = try identity()
        if value["state"] as? String == "verified" {
            if !eligible || reference == nil || value["sessionRef"] as? String != reference { try revoke() }
            else if (value["validUntil"] as? Double ?? 0) <= Date().timeIntervalSince1970 * 1000 {
                // Expiry blocks hydration, but is not logout. A new actual local
                // session response may renew the same no-cookie binding.
                try transaction {
                    var expired = value; expired["state"] = "blocked"
                    try self.setControl("identity", expired); _ = try self.advance()
                    try self.execute("DELETE FROM staging")
                }
                owner = nil; authEpoch = nil; lease = nil
                boundary = UUID().uuidString
            }
        }
    }
    func grant(_ body: [String: Any], sessionRef: String?) throws {
        guard Self.boolean(body["authenticated"]) == true, let member = body["member"] as? [String: Any],
              Self.boolean(member["active"]) == true, ["owner", "admin", "member", "guest"].contains(member["role"] as? String ?? "") else { try revoke(); throw FountainOutboxError.blocked }
        let workspace = try text(body["workspace_id"], limit: 1000), actor = try text(member["id"], limit: 1000), binding = try text(body["cache_binding"], limit: 1000)
        let local = body["mode"] as? String == "local" && Self.boolean(body["required"]) == false && sessionRef == nil
        var expiry: Double
        if local { expiry = Date().timeIntervalSince1970 * 1000 + 24 * 60 * 60 * 1000 }
        else {
            guard let raw = body["expires_at"] as? String, sessionRef != nil,
                  ["accounts", "family"].contains(body["mode"] as? String ?? "") else { try revoke(); throw FountainOutboxError.blocked }
            let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let alternative = ISO8601DateFormatter()
            guard let date = parser.date(from: raw) ?? alternative.date(from: raw) else { throw FountainOutboxError.invalid }
            expiry = date.timeIntervalSince1970 * 1000
        }
        guard expiry > Date().timeIntervalSince1970 * 1000 else { try revoke(); throw FountainOutboxError.blocked }
        let profile = origin + "|" + [workspace, actor, binding].map(Self.encodeURIComponent).joined(separator: "|")
        let reference = sessionRef ?? "local-no-cookie"
        let previous = try identity()
        let sameIdentity = previous["profileId"] as? String == profile && previous["sessionRef"] as? String == reference && previous["state"] as? String == "verified"
        if previous["profileId"] as? String == profile && previous["sessionRef"] as? String == reference,
           previous["state"] as? String == "verified", let oldExpiry = previous["validUntil"] as? Double {
            // A local grant never extends without another actual native response;
            // retaining an earlier valid limit avoids invalidating read cursors.
            if local && oldExpiry > Date().timeIntervalSince1970 * 1000 { expiry = min(expiry, oldExpiry) }
            if oldExpiry == expiry { return }
        }
        try transaction {
            if let old = previous["profileId"] as? String, old != profile { try self.purgeProfile(old) }
            guard try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile]) == 0 else { throw FountainOutboxError.blocked }
            try self.setControl("identity", ["state": "verified", "profileId": profile, "validUntil": expiry, "sessionRef": reference])
            try self.setControl("lastProfile", profile)
            try self.setControl("known:" + profile, true)
            if !sameIdentity { _ = try self.advance() }
        }
        if !sameIdentity {
            owner = nil; authEpoch = nil; lease = nil
            boundary = UUID().uuidString
        }
    }
    func revoke() throws {
        try transaction {
            let previous = try self.identity()
            var changed = previous["state"] as? String != "blocked"
            if let profile = previous["profileId"] as? String {
                if try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile]) == 0 { changed = true }
                try self.purgeProfile(profile)
            }
            if changed {
                try self.setControl("identity", ["state": "blocked"])
                _ = try self.advance()
            }
            try self.execute("DELETE FROM staging")
        }
        owner = nil; authEpoch = nil; lease = nil
        boundary = UUID().uuidString
    }
    func revocationConfirmed() throws -> Bool { try identity()["state"] as? String != "verified" }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    func stage(lease: String, txID: String, baseHead: Int, part: Int, bytes: Data) throws {
        try checkLease(lease)
        _ = try text(txID, limit: 160)
        guard part >= 0 && part < 256, bytes.count > 0, bytes.count <= partLimit else { throw FountainOutboxError.limit }
        try transaction {
            if let existing = try self.rows("SELECT lease,base_head,data FROM staging WHERE tx_id=? AND part=?", [txID, part]).first {
                guard existing[0] as? String == lease, existing[1] as? Int == baseHead, existing[2] as? Data == bytes else { throw FountainOutboxError.conflict }
                return
            }
            guard part == (try self.integer("SELECT count(*) FROM staging WHERE tx_id=?", [txID])) else { throw FountainOutboxError.invalid }
            if baseHead != (try self.head()), try self.integer("SELECT count(*) FROM tx_receipts WHERE tx_id=?", [txID]) == 0 { throw FountainOutboxError.head }
            let size = try self.integer("SELECT coalesce(sum(length(data)),0) FROM staging")
            guard size <= self.transactionLimit - bytes.count else { throw FountainOutboxError.limit }
            try self.execute("INSERT INTO staging(tx_id,part,lease,base_head,data) VALUES(?,?,?,?,?)", [txID, part, lease, baseHead, bytes])
        }
    }

    private struct Change {
        let op: String, bucket: String, encodedKey: String, profile: String
        let resource: String?
        let value: [String: Any]?
        let payload: Data?
    }
    private func change(_ source: Any) throws -> Change {
        guard let source = source as? [String: Any], let op = source["op"] as? String, ["put", "delete"].contains(op),
              let bucket = source["bucket"] as? String, Self.buckets.contains(bucket), let key = source["key"] else { throw FountainOutboxError.invalid }
        let keyData = try json(key)
        guard keyData.count <= 8192, let encoded = String(data: keyData, encoding: .utf8) else { throw FountainOutboxError.limit }
        let value = source["value"] as? [String: Any]
        if op == "put" && value == nil { throw FountainOutboxError.invalid }
        var profile: String, resource: String?
        if ["operations", "drafts", "mutations"].contains(bucket) {
            guard let keys = key as? [String], keys.count == 2 else { throw FountainOutboxError.invalid }
            _ = try text(keys[1], limit: 1000)
            if bucket == "mutations" { profile = keys[0]; resource = value?["resourceKey"] as? String }
            else { resource = keys[0]; profile = try resourceProfile(keys[0]) }
            if let value = value {
                guard value["profileId"] as? String == profile,
                      value[bucket == "drafts" ? "clientId" : "id"] as? String == keys[1],
                      bucket == "mutations" || value["key"] as? String == keys[0] else { throw FountainOutboxError.invalid }
            }
        } else {
            let key = try text(key)
            if bucket == "profiles" {
                profile = key
                if let value = value {
                    let parts = try profileParts(profile)
                    guard value["id"] as? String == key, value["origin"] as? String == origin,
                          Self.encodeURIComponent(value["workspaceId"] as? String ?? "") == parts[1],
                          Self.encodeURIComponent(value["memberId"] as? String ?? "") == parts[2],
                          Self.encodeURIComponent(value["cacheBinding"] as? String ?? "") == parts[3],
                          let session = value["session"] as? [String: Any], session["authenticated"] as? Bool == true,
                          Self.encodeURIComponent(session["cache_binding"] as? String ?? "") == parts[3],
                          Self.encodeURIComponent(session["workspace_id"] as? String ?? "") == parts[1],
                          let member = session["member"] as? [String: Any],
                          Self.encodeURIComponent(member["id"] as? String ?? "") == parts[2] else { throw FountainOutboxError.invalid }
                }
            } else if bucket == "meta" {
                if key.hasPrefix("revoked-resource:") { resource = String(key.dropFirst(17)); profile = try resourceProfile(resource!) }
                else if key.hasPrefix("revoked:") { profile = String(key.dropFirst(8)) }
                else if key.hasPrefix("mutation-sequence:") { profile = String(key.dropFirst(18)) }
                else if key == "active" {
                    if let supplied = value?["profileId"] as? String { profile = supplied }
                    else if let stored = try rows("SELECT profile_id FROM records WHERE bucket='meta' AND key=?", [String(data: try json("active"), encoding: .utf8)!]).first?.first as? String { profile = stored }
                    else if let last = try control("lastProfile") as? String { profile = last }
                    else { throw FountainOutboxError.blocked }
                } else { throw FountainOutboxError.invalid }
                if let value = value, value["id"] as? String != key { throw FountainOutboxError.invalid }
            } else {
                let pieces = key.components(separatedBy: "|")
                if bucket == "transfers" {
                    guard pieces.count == 6 else { throw FountainOutboxError.invalid }
                    resource = pieces.prefix(5).joined(separator: "|")
                    profile = try resourceProfile(resource!)
                    if let value = value {
                        guard value["scopeId"] as? String == resource,
                              Self.encodeURIComponent(value["id"] as? String ?? "") == pieces[5],
                              Self.encodeURIComponent(value["pageId"] as? String ?? "") == pieces[4],
                              Set(value.keys).isSubset(of: ["key", "id", "profileId", "scopeId", "pageId", "name", "size", "lastModified", "fingerprint", "offset", "expiresAt", "publicationVersion", "publication"]) else { throw FountainOutboxError.invalid }
                    }
                } else { resource = key; profile = try resourceProfile(key) }
                if let value = value {
                    guard value["key"] as? String == key, value["profileId"] as? String == profile else { throw FountainOutboxError.invalid }
                }
            }
        }
        _ = try profileParts(profile)
        if let resource = resource { guard try resourceProfile(resource) == profile else { throw FountainOutboxError.invalid } }
        let payload = try value.map { try json($0) }
        guard payload == nil || payload!.count <= recordLimit else { throw FountainOutboxError.limit }
        if let value = value, let snapshot = value["snapshot"] as? [String: Any] {
            let parts = try profileParts(profile)
            for (field, expected) in [("workspace_id", parts[1]), ("current_member_id", parts[2]), ("session_binding", parts[3])] {
                if let actual = snapshot[field] as? String, Self.encodeURIComponent(actual) != expected { throw FountainOutboxError.invalid }
            }
            if let resource = resource, let encodedID = resource.components(separatedBy: "|").last {
                let object = snapshot[bucket == "databaseSnapshots" ? "database" : "page"] as? [String: Any]
                if let id = object?["id"] as? String, Self.encodeURIComponent(id) != encodedID { throw FountainOutboxError.invalid }
            }
        }
        return Change(op: op, bucket: bucket, encodedKey: encoded, profile: profile, resource: resource, value: value, payload: payload)
    }
    private func isRevocation(_ change: Change) -> Bool {
        guard change.bucket == "meta", change.op == "put", let key = change.value?["id"] as? String else { return false }
        return key.hasPrefix("revoked:") || key.hasPrefix("revoked-resource:")
    }
    private func purgeProfile(_ profile: String) throws {
        try execute("INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) VALUES(?,'profile',?)", [profile, profile])
        try execute("DELETE FROM records WHERE profile_id=?", [profile])
        try execute("DELETE FROM recovery WHERE profile_id=?", [profile])
    }
    private func purgeResource(_ resource: String, profile: String) throws {
        try execute("INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) VALUES(?,'resource',?)", [resource, profile])
        let recoveryID = "native-resource-revocation:" + UUID().uuidString
        for (position, row) in try rows("SELECT key,value FROM records WHERE resource_key=? AND bucket='mutations'", [resource]).enumerated() {
            guard let encoded = row[0] as? String, let bytes = row[1] as? Data,
                  var value = try decode(bytes) as? [String: Any] else { throw FountainOutboxError.storage }
            value["status"] = "denied"; value["recovery"] = ["reason": "resource_revoked", "at": Date().timeIntervalSince1970 * 1000]
            try execute("INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,'mutations',?,?,?)", [recoveryID, position, encoded, profile, try json(value)])
        }
        try execute("DELETE FROM records WHERE resource_key=?", [resource])
    }

    func commit(lease: String, txID: String, baseHead: Int, digest: String) throws -> Int {
        try checkLease(lease)
        guard digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw FountainOutboxError.invalid }
        if let receipt = try rows("SELECT digest,head FROM tx_receipts WHERE tx_id=?", [txID]).first {
            guard receipt[0] as? String == digest, let head = receipt[1] as? Int else { throw FountainOutboxError.conflict }
            try transaction {
                try self.checkLease(lease)
                try self.execute("DELETE FROM staging WHERE tx_id=?", [txID])
            }
            return head
        }
        var bytes = Data()
        for (part, row) in try rows("SELECT part,lease,base_head,data FROM staging WHERE tx_id=? ORDER BY part", [txID]).enumerated() {
            guard row[0] as? Int == part, row[1] as? String == lease, row[2] as? Int == baseHead,
                  let chunk = row[3] as? Data, bytes.count <= transactionLimit - chunk.count else { throw FountainOutboxError.invalid }
            bytes.append(chunk)
        }
        guard !bytes.isEmpty, Self.hash(bytes) == digest,
              let delta = try decode(bytes) as? [String: Any], try checkedInteger(delta["version"]) == 1,
              delta["origin"] as? String == origin, let mode = delta["mode"] as? String,
              ["active", "quarantine"].contains(mode), let input = delta["changes"] as? [Any], input.count <= 100000 else { throw FountainOutboxError.invalid }
        let changes = try input.map(change)
        let result = try transaction { () throws -> Int in
            try self.checkLease(lease)
            guard baseHead == (try self.head()) else { throw FountainOutboxError.head }
            let active = try self.availableProfile()
            for (position, item) in changes.enumerated() {
                if mode == "quarantine" {
                    let quarantined = try self.json(input[position])
                    try self.execute("INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,?,?,?,?)", [txID, position, item.bucket, item.encodedKey, item.profile, quarantined])
                    continue
                }
                let revocation = self.isRevocation(item)
                if item.op == "delete" || revocation {
                    let knownProfile = try self.known(item.profile)
                    guard active == item.profile || knownProfile else { throw FountainOutboxError.blocked }
                } else {
                    guard active == item.profile,
                          try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [item.profile]) == 0 else { throw FountainOutboxError.blocked }
                }
                if item.op == "delete" {
                    if item.bucket == "meta", let key = try self.decode(Data(item.encodedKey.utf8)) as? String,
                       key.hasPrefix("revoked:") || key.hasPrefix("revoked-resource:") { throw FountainOutboxError.blocked }
                    if item.bucket == "profiles" { try self.purgeProfile(item.profile) }
                    else { try self.execute("DELETE FROM records WHERE bucket=? AND key=?", [item.bucket, item.encodedKey]) }
                    continue
                }
                if revocation, let key = item.value?["id"] as? String {
                    if key.hasPrefix("revoked-resource:"), let resource = item.resource { try self.purgeResource(resource, profile: item.profile) }
                    else { try self.purgeProfile(item.profile) }
                }
                if let resource = item.resource,
                   try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [resource]) > 0, !revocation {
                    guard item.bucket == "mutations", item.value?["status"] as? String == "denied",
                          (item.value?["recovery"] as? [String: Any])?["reason"] as? String == "resource_revoked",
                          let payload = item.payload else { throw FountainOutboxError.blocked }
                    try self.execute("INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,?,?,?,?)", [txID, position, item.bucket, item.encodedKey, item.profile, payload])
                    continue
                }
                guard let payload = item.payload else { throw FountainOutboxError.invalid }
                try self.execute("INSERT INTO records(bucket,key,profile_id,resource_key,value) VALUES(?,?,?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET profile_id=excluded.profile_id,resource_key=excluded.resource_key,value=excluded.value", [item.bucket, item.encodedKey, item.profile, item.resource, payload])
            }
            let head = try self.advance()
            try self.execute("INSERT INTO tx_receipts(tx_id,digest,head) VALUES(?,?,?)", [txID, digest, head])
            try self.execute("DELETE FROM staging WHERE tx_id=?", [txID])
            return head
        }
        guard let receipt = try rows("SELECT digest,head FROM tx_receipts WHERE tx_id=?", [txID]).first,
              receipt[0] as? String == digest, receipt[1] as? Int == result else { poisoned = true; throw FountainOutboxError.storage }
        boundary = UUID().uuidString
        return result
    }

    func read(lease: String, head: Int, cursor: String?, byteLimit: Int) throws -> [String: Any] {
        try checkLease(lease)
        guard head == (try self.head()), byteLimit > 0, byteLimit <= partLimit else { throw FountainOutboxError.head }
        let profile = try verifiedProfile()
        var rowID = 0, offset = 0
        if let cursor = cursor {
            guard cursor.utf8.count <= 2048, let value = try decode(Data(cursor.utf8)) as? [String: Any],
                  value["lease"] as? String == lease, value["profile"] as? String == profile,
                  try checkedInteger(value["head"]) == head else { throw FountainOutboxError.stale }
            rowID = try checkedInteger(value["row"]); offset = try checkedInteger(value["offset"])
        }
        var fragments: [[String: Any]] = [], remaining = byteLimit
        while remaining > 0 {
            guard let row = try rows("SELECT rowid,bucket,key,length(value) FROM records WHERE profile_id=? AND rowid>=? ORDER BY rowid LIMIT 1", [profile, rowID]).first,
                  let actualID = row[0] as? Int, let bucket = row[1] as? String, let encoded = row[2] as? String, let total = row[3] as? Int else { break }
            if actualID != rowID { offset = 0 }
            guard offset >= 0, offset < total, total <= recordLimit else { throw FountainOutboxError.invalid }
            let length = min(remaining, total - offset)
            guard let bytes = try rows("SELECT substr(value,?,?) FROM records WHERE rowid=? AND profile_id=?", [offset + 1, length, actualID, profile]).first?.first as? Data, bytes.count == length else { throw FountainOutboxError.storage }
            fragments.append(["bucket": bucket, "key": try decode(Data(encoded.utf8)), "offset": offset, "total": total, "bytesBase64": bytes.base64EncodedString()])
            remaining -= length; offset += length; rowID = actualID
            if offset == total { rowID += 1; offset = 0 }
        }
        let more = try integer("SELECT count(*) FROM records WHERE profile_id=? AND rowid>=?", [profile, rowID]) > 0
        let next: Any
        if more { next = String(data: try json(["lease": lease, "profile": profile, "head": head, "row": rowID, "offset": offset]), encoding: .utf8)! }
        else { next = NSNull() }
        return ["head": head, "fragments": fragments, "next": next]
    }
}
