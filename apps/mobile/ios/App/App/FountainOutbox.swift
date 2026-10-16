// Native-only SQLite foundation. Call exclusively on FountainNative's serial
// executor while holding its bridge-owner lock. No SQL or credential is bridged.
import Foundation
import SQLite3
import CryptoKit
import Darwin

enum FountainOutboxError: Error, Equatable {
    case invalid, limit, stale, head, conflict, blocked, storage, access
    var code: String {
        switch self {
        case .invalid: return "NATIVE_OUTBOX_INVALID"
        case .limit: return "NATIVE_OUTBOX_LIMIT"
        case .stale: return "NATIVE_OUTBOX_STALE"
        case .head: return "NATIVE_OUTBOX_HEAD"
        case .conflict: return "NATIVE_OUTBOX_CONFLICT"
        case .blocked: return "NATIVE_OUTBOX_BLOCKED"
        case .storage: return "NATIVE_STORAGE"
        case .access: return "OUTBOX_ACCESS_REQUIRED"
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
    private(set) var observedProofEpoch = 0
    private var readDeadline: Double?
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
    // Never materialize the whole business cache to preflight or quarantine it.
    private func eachRecord(_ sql: String, _ parameter: String, _ visit: (String, String, Data) throws -> Void) throws {
        guard !poisoned, let database = database else { throw FountainOutboxError.storage }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let prepared = statement else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(prepared) }
        guard sqlite3_bind_text(prepared, 1, parameter, -1, Self.transient) == SQLITE_OK else { throw FountainOutboxError.storage }
        while true {
            let status = sqlite3_step(prepared)
            if status == SQLITE_DONE { return }
            guard status == SQLITE_ROW, let bucket = sqlite3_column_text(prepared, 0), let key = sqlite3_column_text(prepared, 1) else { throw FountainOutboxError.storage }
            let size = Int(sqlite3_column_bytes(prepared, 2))
            guard size > 0, size <= recordLimit, let bytes = sqlite3_column_blob(prepared, 2) else { throw FountainOutboxError.access }
            try visit(String(cString: bucket), String(cString: key), Data(bytes: bytes, count: size))
        }
    }
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
    func proofEpoch() throws -> Int {
        let value = try control("proofEpoch") as? Int ?? 0
        observedProofEpoch = value
        return value
    }
    private func advanceProof() throws {
        let epoch = try proofEpoch()
        guard epoch < 9_007_199_254_740_991 else { throw FountainOutboxError.storage }
        try setControl("proofEpoch", epoch + 1)
        observedProofEpoch = epoch + 1
    }
    func deliveryDeadline() throws -> Double {
        guard let deadline = readDeadline else { throw FountainOutboxError.access }
        return deadline
    }
    func open() throws -> [String: Any] {
        let value = try identity()
        let current = try availableProfile()
        let issues = try current.map { try accessIssues($0).issues } ?? []
        return ["lease": lease as Any? ?? NSNull(), "head": try head(),
                "identityState": current == nil ? (value["state"] as? String == "unknown" ? "unknown" : "blocked") : "verified",
                "profileId": current as Any? ?? NSNull(), "validUntil": current == nil ? NSNull() : value["validUntil"] ?? NSNull(),
                "proofEpoch": try proofEpoch(), "resourceAccess": current != nil && issues.isEmpty ? "ready" : "required",
                "accessIssues": Array(issues.prefix(100)), "accessIssuesTruncated": issues.count > 100]
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
                    try self.setControl("identity", expired); _ = try self.advance(); try self.advanceProof()
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
        let shortened = sameIdentity && expiry < (previous["validUntil"] as? Double ?? 0)
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
            if !sameIdentity { _ = try self.advance(); try self.setControl("proofs:" + profile, [:]); try self.advanceProof() }
            else if shortened { try self.advanceProof() }
        }
        if !sameIdentity {
            owner = nil; authEpoch = nil; lease = nil
            boundary = UUID().uuidString
        } else if shortened { boundary = UUID().uuidString }
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
                _ = try self.advance(); try self.advanceProof()
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

    // Only this native HTTP observer can write evidence. Renderer deltas cannot.
    static func canonicalResource(path: String, method: String) -> (String, String)? {
        guard method == "GET", !path.contains("?"), !path.contains("#") else { return nil }
        if path == "/api/workspace" { return ("workspace", "workspace") }
        let parts = path.components(separatedBy: "/")
        let kind: String
        if parts.count == 4 && parts[1] == "api" && parts[2] == "databases" { kind = "database" }
        else if parts.count == 5 && parts[1] == "api" && parts[2] == "pages" && parts[4] == "collaboration" { kind = "page" }
        else { return nil }
        guard let id = parts[3].removingPercentEncoding, !id.isEmpty, id.utf8.count <= 1000,
              ![".", ".."].contains(id), !id.contains("/"), !id.contains("\\"),
              !id.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        return (kind, id)
    }
    private func proofs(_ profile: String) throws -> [String: [String: Any]] {
        guard try integer("SELECT coalesce(length(value),0) FROM control WHERE id=?", ["proofs:" + profile]) <= recordLimit else { throw FountainOutboxError.access }
        return try control("proofs:" + profile) as? [String: [String: Any]] ?? [:]
    }
    private func floor(_ profile: String) throws -> [String: Int] {
        try control("proofFloor:" + profile) as? [String: Int] ?? ["access": 0, "data": 0]
    }
    private func proofKey(_ kind: String, _ id: String) -> String { kind + ":" + id }
    private func level(_ value: Any?) throws -> Int {
        let result = try checkedInteger(value)
        guard (1...4).contains(result) else { throw FountainOutboxError.invalid }
        return result
    }
    private func descriptor(_ value: Any?, page: Bool) throws -> [String: Any] {
        guard let value = value as? [String: Any] else { throw FountainOutboxError.invalid }
        var result: [String: Any] = ["id": try text(value["id"], limit: 1000), "accessLevel": try level(value["access_level"])]
        if page {
            guard let locked = Self.boolean(value["locked"]), let archived = Self.boolean(value["archived"]) else { throw FountainOutboxError.invalid }
            result["locked"] = locked; result["archived"] = archived
            result["revision"] = try checkedInteger(value["revision"])
        }
        return result
    }
    func observeResource(path: String, method: String, status: Int, data: Data, sessionRef: String?) throws {
        guard let (kind, id) = Self.canonicalResource(path: path, method: method) else { return }
        let profile = try verifiedProfile(), grant = try identity(), parts = try profileParts(profile)
        guard grant["sessionRef"] as? String == (sessionRef ?? "local-no-cookie") else { throw FountainOutboxError.stale }
        guard status == 200 || status == 403 || status == 404 else { return }
        let key = proofKey(kind, id)
        var ledger = try proofs(profile)
        if status == 403 || status == 404 {
            try transaction {
                ledger[key] = ["kind": kind, "id": id, "denied": true]
                if try self.json(ledger).count > self.recordLimit { ledger = [self.proofKey("workspace", "workspace"): ["kind": "workspace", "id": "workspace", "denied": true]] }
                try self.setControl("proofs:" + profile, ledger)
                if kind != "workspace" { try self.purgeResource(profile + (kind == "database" ? "|database|" : "|") + Self.encodeURIComponent(id), profile: profile) }
                try self.advanceProof()
            }
            boundary = UUID().uuidString
            return
        }
        // Actual denials are terminal within this login, including late 200s
        // already in flight when the resource was revoked. Malformed successes
        // have only an invalid marker and may be replaced by a fresh valid GET.
        if ledger[proofKey("workspace", "workspace")]?["denied"] as? Bool == true || ledger[key]?["denied"] as? Bool == true { throw FountainOutboxError.access }
        if kind != "workspace", try integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile + (kind == "database" ? "|database|" : "|") + Self.encodeURIComponent(id)]) > 0 { throw FountainOutboxError.access }
        do {
            guard let body = try decode(data) as? [String: Any],
                  body["workspace_id"] as? String == parts[1].removingPercentEncoding,
                  body["current_member_id"] as? String == parts[2].removingPercentEncoding,
                  body["session_binding"] as? String == parts[3].removingPercentEncoding else { throw FountainOutboxError.invalid }
            let access = try checkedInteger(body["access_revision"]), revision = try checkedInteger(body["data_revision"])
            // A late canonical response cannot restore a projection observed before a newer one.
            let knownFloor = try floor(profile)
            guard access >= (knownFloor["access"] ?? 0), revision >= (knownFloor["data"] ?? 0) else { throw FountainOutboxError.stale }
            let now = Date().timeIntervalSince1970 * 1000
            var proof: [String: Any] = ["profileId": profile, "kind": kind, "id": id, "accessRevision": access,
                "dataRevision": revision, "observedAt": now, "validUntil": min(grant["validUntil"] as? Double ?? 0, now + 86_400_000),
                "accessLevel": 1, "locked": false, "archived": false, "epoch": NSNull(), "seq": NSNull()]
            if kind == "workspace" {
                guard let pages = body["pages"] as? [Any], let databases = body["databases"] as? [Any], pages.count + databases.count <= 100000 else { throw FountainOutboxError.invalid }
                var pageMap: [String: [String: Any]] = [:], databaseMap: [String: [String: Any]] = [:]
                for source in pages { let item = try descriptor(source, page: true), itemID = item["id"] as! String; guard pageMap[itemID] == nil else { throw FountainOutboxError.invalid }; pageMap[itemID] = item }
                for source in databases { let item = try descriptor(source, page: false), itemID = item["id"] as! String; guard databaseMap[itemID] == nil else { throw FountainOutboxError.invalid }; databaseMap[itemID] = item }
                proof["pages"] = pageMap; proof["databases"] = databaseMap
            } else if kind == "page" {
                guard let page = body["page"] as? [String: Any], page["id"] as? String == id,
                      body["blocks"] is [Any], body["state"] is [String: Any] else { throw FountainOutboxError.invalid }
                let item = try descriptor(page, page: true), accessLevel = try level(body["access_level"])
                guard item["accessLevel"] as? Int == accessLevel else { throw FountainOutboxError.invalid }
                proof.merge(item) { _, new in new }; proof["epoch"] = try text(body["epoch"], limit: 1000); proof["seq"] = try checkedInteger(body["seq"])
            } else {
                guard let database = body["database"] as? [String: Any], database["id"] as? String == id,
                      let rows = body["rows"] as? [[String: Any]], rows.count <= 100000,
                      let canCreate = Self.boolean(database["can_create_row"]), let properties = database["properties"] as? [[String: Any]] else { throw FountainOutboxError.invalid }
                proof["accessLevel"] = try level(database["access_level"]); proof["canCreateRow"] = canCreate
                var rowMap: [String: Int] = [:], relations: [String: String] = [:], propertyDigests: [String: String] = [:]
                for row in rows { let rowID = try text(row["id"], limit: 1000); guard row["database_id"] as? String == id, rowMap[rowID] == nil else { throw FountainOutboxError.invalid }; rowMap[rowID] = try level(row["access_level"]) }
                for property in properties {
                    let propertyID = try text(property["id"], limit: 1000); _ = try text(property["type"], limit: 1000)
                    guard propertyDigests[propertyID] == nil else { throw FountainOutboxError.invalid }
                    propertyDigests[propertyID] = Self.hash(try json(property))
                    if property["type"] as? String == "relation" {
                        if let target = property["database_id"] as? String { relations[propertyID] = try text(target, limit: 1000) }
                        else if property["database_id"] == nil || property["database_id"] is NSNull { relations[propertyID] = "" }
                        else { throw FountainOutboxError.invalid }
                    }
                }
                proof["rows"] = rowMap; proof["relations"] = relations
                proof["schemaDigest"] = Self.hash(try json(properties)); proof["propertyDigests"] = propertyDigests
            }
            if var old = ledger[key], let deadline = old["validUntil"] as? Double, deadline > now,
               (grant["validUntil"] as? Double ?? 0) >= deadline {
                var semantic = proof
                for field in ["observedAt", "validUntil"] { old.removeValue(forKey: field); semantic.removeValue(forKey: field) }
                // Polling the same unexpired evidence must not invalidate a long staged transfer.
                if try json(old) == json(semantic), access == knownFloor["access"], revision == knownFloor["data"] { return }
            }
            var proposed = ledger; proposed[key] = proof
            let fits = try json(proposed).count <= recordLimit
            try transaction {
                if fits { try self.setControl("proofs:" + profile, proposed) }
                try self.setControl("proofFloor:" + profile, ["access": max(access, knownFloor["access"] ?? 0), "data": max(revision, knownFloor["data"] ?? 0)])
                try self.advanceProof()
            }
            boundary = UUID().uuidString
            if !fits { throw FountainOutboxError.access }
        } catch FountainOutboxError.stale { throw FountainOutboxError.stale }
        catch FountainOutboxError.access { throw FountainOutboxError.access }
        catch {
            if (error as? FountainOutboxError) == .storage { throw error }
            // Malformed success is not a permanent revocation: retain data and invalidate evidence only.
            try transaction {
                ledger[key] = ["kind": kind, "id": id, "invalid": true]
                if try self.json(ledger).count > self.recordLimit { ledger = [self.proofKey("workspace", "workspace"): ["kind": "workspace", "id": "workspace", "invalid": true]] }
                try self.setControl("proofs:" + profile, ledger); try self.advanceProof()
            }
            boundary = UUID().uuidString
            throw FountainOutboxError.access
        }
    }

    func stage(lease: String, txID: String, baseHead: Int, proofEpoch: Int, part: Int, bytes: Data) throws {
        try checkLease(lease)
        _ = try text(txID, limit: 160)
        guard part >= 0 && part < 256, bytes.count > 0, bytes.count <= partLimit else { throw FountainOutboxError.limit }
        try transaction {
            if let original = try self.control("stagedProof:" + txID) as? Int {
                guard original == proofEpoch else { throw FountainOutboxError.access }
            } else { try self.setControl("stagedProof:" + txID, proofEpoch) }
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
                else if key.hasPrefix("recovery-import:") { profile = try importReceiptProfile(key, op: op, value: value) }
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
    private func importReceiptProfile(_ key: String, op: String, value: [String: Any]?) throws -> String {
        guard let separator = key.lastIndex(of: ":"),
              separator >= key.index(key.startIndex, offsetBy: "recovery-import:".count) else { throw FountainOutboxError.invalid }
        let digest = String(key[key.index(after: separator)...])
        let profile = String(key[key.index(key.startIndex, offsetBy: "recovery-import:".count)..<separator])
        _ = try profileParts(profile)
        guard digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw FountainOutboxError.invalid }
        if op == "delete" { return profile }
        guard op == "put", let value = value,
              Set(value.keys) == Set(["id", "profileId", "digest", "operationIds", "pageIds", "draftKeys", "createdAt"]),
              value["id"] as? String == key, value["profileId"] as? String == profile, value["digest"] as? String == digest,
              let operations = value["operationIds"] as? [String], operations.count <= 1000, Set(operations).count == operations.count,
              let pages = value["pageIds"] as? [String], pages.count <= 1000, Set(pages).count == pages.count,
              let drafts = value["draftKeys"] as? [[String]], drafts.count <= 2000 else { throw FountainOutboxError.invalid }
        _ = try checkedInteger(value["createdAt"])
        for identity in operations + pages { _ = try text(identity, limit: 1000) }
        for draft in drafts {
            guard draft.count == 2, draft[0].components(separatedBy: "|").count == 5,
                  try resourceProfile(draft[0]) == profile else { throw FountainOutboxError.invalid }
            _ = try text(draft[1], limit: 1000)
        }
        return profile
    }
    private func purgeProfile(_ profile: String) throws {
        try execute("INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) VALUES(?,'profile',?)", [profile, profile])
        try execute("DELETE FROM records WHERE profile_id=?", [profile])
        try execute("DELETE FROM recovery WHERE profile_id=?", [profile])
        try setControl("proofs:" + profile, [:])
    }
    private func purgeResource(_ resource: String, profile: String) throws {
        try execute("INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) VALUES(?,'resource',?)", [resource, profile])
        let recoveryID = "native-resource-revocation:" + UUID().uuidString
        var position = 0
        try eachRecord("SELECT bucket,key,value FROM records WHERE resource_key=? AND bucket IN ('mutations','operations','drafts')", resource) { bucket, encoded, bytes in
            guard var value = try self.decode(bytes) as? [String: Any] else { throw FountainOutboxError.storage }
            if bucket == "mutations" {
                value["status"] = "denied"; value["recovery"] = ["reason": "resource_revoked", "at": Date().timeIntervalSince1970 * 1000]
            }
            let payload: Data
            if bucket == "mutations" { payload = try self.json(value) } else { payload = bytes }
            try self.execute("INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,?,?,?,?)", [recoveryID, position, bucket, encoded, profile, payload])
            position += 1
        }
        try execute("DELETE FROM records WHERE resource_key=?", [resource])
    }

    private func accessIssues(_ profile: String, overlay: [Change] = []) throws -> (issues: [[String: String]], deadline: Double) {
        var overlayByKey: [String: Change] = [:]
        for item in overlay { overlayByKey[item.bucket + "|" + item.encodedKey] = item }
        let ledger = try proofs(profile), now = Date().timeIntervalSince1970 * 1000, grantDeadline = try identity()["validUntil"] as? Double ?? 0
        let currentFloor = try floor(profile)
        let tombstones = Set(try rows("SELECT scope FROM tombstones WHERE profile_id=?", [profile]).compactMap { $0.first as? String })
        var issues: [[String: String]] = [], seen = Set<String>(), deadline = grantDeadline
        func issue(_ kind: String, _ id: String, _ reason: String) {
            if issues.count <= 100 && seen.insert(kind + "|" + id + "|" + reason).inserted { issues.append(["kind": kind, "id": id, "reason": reason]) }
        }
        func proof(_ kind: String, _ id: String) -> [String: Any]? {
            if kind != "workspace", tombstones.contains(profile + (kind == "database" ? "|database|" : "|") + Self.encodeURIComponent(id)) { issue(kind, id, "denied"); return nil }
            guard let value = ledger[proofKey(kind, id)] else { issue(kind, id, "missing"); return nil }
            if value["denied"] as? Bool == true { issue(kind, id, "denied"); return nil }
            if value["invalid"] as? Bool == true { issue(kind, id, "missing"); return nil }
            guard let expiry = value["validUntil"] as? Double, expiry > now, expiry <= grantDeadline else { issue(kind, id, "expired"); return nil }
            guard (value["accessRevision"] as? Int ?? -1) >= (currentFloor["access"] ?? 0),
                  (value["dataRevision"] as? Int ?? -1) >= (currentFloor["data"] ?? 0) else { issue(kind, id, "revision_changed"); return nil }
            deadline = min(deadline, expiry)
            if kind != "workspace", let workspace = ledger[proofKey("workspace", "workspace")],
               (workspace["accessRevision"] as? Int ?? 0) >= (value["accessRevision"] as? Int ?? 0),
               (workspace["dataRevision"] as? Int ?? 0) >= (value["dataRevision"] as? Int ?? 0) {
                let membership = workspace[kind == "page" ? "pages" : "databases"] as? [String: [String: Any]] ?? [:]
                guard membership[id] != nil else { issue(kind, id, "denied"); return nil }
                guard workspace["accessRevision"] as? Int == value["accessRevision"] as? Int,
                      workspace["dataRevision"] as? Int == value["dataRevision"] as? Int else { issue(kind, id, "revision_changed"); return nil }
            }
            return value
        }
        func revisions(_ value: [String: Any], _ authority: [String: Any], _ kind: String, _ id: String) -> Bool {
            guard let access = try? checkedInteger(value["access_revision"]), let data = try? checkedInteger(value["data_revision"]),
                  access == authority["accessRevision"] as? Int, data == authority["dataRevision"] as? Int else { issue(kind, id, "revision_changed"); return false }
            let parts = profile.components(separatedBy: "|")
            guard value["workspace_id"] as? String == parts[1].removingPercentEncoding,
                  value["current_member_id"] as? String == parts[2].removingPercentEncoding,
                  value["session_binding"] as? String == parts[3].removingPercentEncoding else { issue(kind, id, "revision_changed"); return false }
            return true
        }
        func page(_ id: String, write: Bool = false) -> [String: Any]? {
            guard let authority = proof("page", id) else { return nil }
            if (authority["accessLevel"] as? Int ?? 0) < (write ? 3 : 1) || write && (authority["locked"] as? Bool == true || authority["archived"] as? Bool == true) { issue("page", id, "denied"); return nil }
            return authority
        }
        func database(_ id: String) -> [String: Any]? { proof("database", id) }
        func row(_ id: String, databaseID: String, authority: [String: Any], write: Bool) {
            if ((authority["rows"] as? [String: Int])?[id] ?? 0) < (write ? 3 : 1) { issue("database", databaseID, "denied") }
        }
        func references(_ body: [String: Any], databaseID: String, authority: [String: Any]) {
            if let parent = body["parent_row_id"] as? String { row(parent, databaseID: databaseID, authority: authority, write: false) }
            else if body["parent_row_id"] != nil && !(body["parent_row_id"] is NSNull) { issue("database", databaseID, "denied") }
            if let dependencies = body["depends_on"] {
                if let ids = dependencies as? [String] { for id in ids { row(id, databaseID: databaseID, authority: authority, write: false) } }
                else { issue("database", databaseID, "denied") }
            }
            for (property, targetDB) in authority["relations"] as? [String: String] ?? [:] {
                if let supplied = (body["properties"] as? [String: Any])?[property] {
                    guard let ids = supplied as? [String] else { issue("database", databaseID, "denied"); continue }
                    if ids.isEmpty { continue }
                    if targetDB.isEmpty {
                        for id in ids {
                            var found = false
                            for candidate in ledger.values where candidate["kind"] as? String == "database" && (candidate["rows"] as? [String: Int])?[id] != nil {
                                if let candidateID = candidate["id"] as? String, let target = database(candidateID) {
                                    row(id, databaseID: candidateID, authority: target, write: false); found = true
                                }
                            }
                            if !found { issue("database", databaseID, "missing") }
                        }
                    } else if let target = targetDB == databaseID ? authority : database(targetDB) {
                        for id in ids { row(id, databaseID: targetDB, authority: target, write: false) }
                    }
                }
            }
        }
        func canonicalSnapshot(_ resource: String) throws -> Change? {
            let encoded = String(data: try json(resource), encoding: .utf8)!
            if let supplied = overlayByKey["snapshots|" + encoded] { return supplied.op == "delete" ? nil : supplied }
            guard try integer("SELECT coalesce(length(value),0) FROM records WHERE bucket='snapshots' AND key=?", [encoded]) <= recordLimit else { throw FountainOutboxError.access }
            guard let bytes = try rows("SELECT value FROM records WHERE bucket='snapshots' AND key=?", [encoded]).first?.first as? Data,
                  let value = try decode(bytes) as? [String: Any] else { return nil }
            return try change(["op": "put", "bucket": "snapshots", "key": resource, "value": value])
        }
        if ledger[proofKey("workspace", "workspace")]?["denied"] as? Bool == true { issue("workspace", "workspace", "denied") }
        if ledger[proofKey("workspace", "workspace")]?["invalid"] as? Bool == true { issue("workspace", "workspace", "missing") }
        func inspect(_ item: Change) throws {
          for item in [item] {
            guard let value = item.value else { continue }
            if item.bucket == "meta" { continue }
            if item.bucket == "profiles" {
                guard let workspace = value["workspace"] as? [String: Any], let authority = proof("workspace", "workspace") else { issue("workspace", "workspace", "missing"); continue }
                guard revisions(workspace, authority, "workspace", "workspace"), let pages = workspace["pages"] as? [[String: Any]], let databases = workspace["databases"] as? [[String: Any]] else { issue("workspace", "workspace", "revision_changed"); continue }
                for (kind, list, key) in [("page", pages, "pages"), ("database", databases, "databases")] {
                    let allowed = authority[key] as? [String: [String: Any]] ?? [:]
                    for entity in list {
                        guard let id = entity["id"] as? String, let actual = allowed[id], (try? level(entity["access_level"])) == actual["accessLevel"] as? Int else { issue("workspace", "workspace", "denied"); continue }
                        if kind == "page" && (Self.boolean(entity["locked"]) != Self.boolean(actual["locked"]) || Self.boolean(entity["archived"]) != Self.boolean(actual["archived"]) || (try? checkedInteger(entity["revision"])) != actual["revision"] as? Int) { issue(kind, id, "revision_changed") }
                        if tombstones.contains(profile + (kind == "database" ? "|database|" : "|") + Self.encodeURIComponent(id)) { issue(kind, id, "denied") }
                        if let direct = ledger[proofKey(kind, id)] {
                            if direct["denied"] as? Bool == true { issue(kind, id, "denied") }
                            if direct["invalid"] as? Bool == true { issue(kind, id, "missing") }
                        }
                    }
                }
                continue
            }
            let pieces = item.resource?.components(separatedBy: "|") ?? [], id = pieces.last?.removingPercentEncoding ?? ""
            let kind = pieces.count == 6 ? "database" : "page"
            if item.bucket == "localPages" { issue("page", id, "local_dependency"); continue }
            if item.bucket == "snapshots" || item.bucket == "databaseSnapshots" {
                let authority = kind == "database" ? database(id) : page(id)
                guard let authority = authority else { continue }
                guard let snapshot = value["snapshot"] as? [String: Any] else { issue(kind, id, "missing"); continue }
                guard revisions(snapshot, authority, kind, id) else { continue }
                if kind == "page" {
                    if snapshot["epoch"] as? String != authority["epoch"] as? String || (try? checkedInteger(snapshot["seq"])) != authority["seq"] as? Int { issue(kind, id, "epoch_changed") }
                    if (try? level(snapshot["access_level"])) != authority["accessLevel"] as? Int { issue(kind, id, "denied") }
                    let entity = snapshot["page"] as? [String: Any]
                    if (try? level(entity?["access_level"])) != authority["accessLevel"] as? Int || Self.boolean(entity?["locked"]) != Self.boolean(authority["locked"]) || Self.boolean(entity?["archived"]) != Self.boolean(authority["archived"]) || (try? checkedInteger(entity?["revision"])) != authority["revision"] as? Int { issue(kind, id, "revision_changed") }
                } else {
                    guard let rows = snapshot["rows"] as? [[String: Any]], let entity = snapshot["database"] as? [String: Any],
                          (try? level(entity["access_level"])) == authority["accessLevel"] as? Int,
                          Self.boolean(entity["can_create_row"]) == Self.boolean(authority["canCreateRow"]) else { issue(kind, id, "denied"); continue }
                    guard let properties = entity["properties"], let bytes = try? json(properties), Self.hash(bytes) == authority["schemaDigest"] as? String else { issue(kind, id, "revision_changed"); continue }
                    for cached in rows {
                        guard let rowID = cached["id"] as? String, cached["database_id"] as? String == id,
                              let access = (authority["rows"] as? [String: Int])?[rowID], (try? level(cached["access_level"])) == access else { issue(kind, id, "denied"); continue }
                        references(cached, databaseID: id, authority: authority)
                    }
                }
            } else if ["operations", "drafts", "transfers"].contains(item.bucket) {
                guard let authority = page(id, write: true) else { continue }
                let pending = value[item.bucket == "operations" ? "operation" : item.bucket == "drafts" ? "draft" : "publication"] as? [String: Any]
                if let pending = pending, let epoch = pending["_epoch"] as? String ?? pending["epoch"] as? String, epoch != authority["epoch"] as? String { issue("page", id, "epoch_changed") }
                if item.bucket != "transfers" && (pending?["_epoch"] as? String ?? pending?["epoch"] as? String) == nil { issue("page", id, "epoch_changed") }
                if item.bucket == "drafts", pending?["reason"] as? String == "basis" {
                    guard let resource = item.resource, let canonical = try canonicalSnapshot(resource),
                          let snapshot = canonical.value?["snapshot"] as? [String: Any] else { issue("page", id, "missing"); continue }
                    // A basis is not authority: validate the independent canonical cache first.
                    try inspect(canonical)
                    if pending?["epoch"] as? String != snapshot["epoch"] as? String ||
                       (try? checkedInteger(pending?["seq"])) != (try? checkedInteger(snapshot["seq"])) { issue("page", id, "epoch_changed") }
                }
            } else if item.bucket == "mutations" {
                guard let operation = value["operation"] as? [String: Any], let operationKind = operation["kind"] as? String,
                      let target = operation["target_id"] as? String else { issue(kind, id, "missing"); continue }
                if operationKind == "page.create" { issue("page", target, "local_dependency"); continue }
                if operationKind == "page.patch" { _ = page(target, write: true); continue }
                guard ["row.create", "row.patch", "row.delete"].contains(operationKind) else { issue(kind, id, "missing"); continue }
                guard let databaseID = operation["database_id"] as? String, let authority = database(databaseID), let body = operation["body"] as? [String: Any] else { issue("database", id, "missing"); continue }
                if operationKind == "row.create" {
                    if authority["canCreateRow"] as? Bool != true { issue("database", databaseID, "denied") }
                } else { row(target, databaseID: databaseID, authority: authority, write: true) }
                let baseSchema = (operation["base"] as? [String: Any])?["schema"] as? [String: Any] ?? [:]
                let baseProperties = (operation["base"] as? [String: Any])?["properties"] as? [String: Any] ?? [:]
                let properties = Set(baseSchema.keys).union(baseProperties.keys).union((body["properties"] as? [String: Any] ?? [:]).keys)
                for property in properties {
                    guard let baseline = baseSchema[property], let bytes = try? json(baseline),
                          Self.hash(bytes) == (authority["propertyDigests"] as? [String: String])?[property] else { issue("database", databaseID, "revision_changed"); continue }
                }
                references(body, databaseID: databaseID, authority: authority)
                if let base = operation["base"] as? [String: Any] {
                    if let fields = base["fields"] as? [String: Any] { references(fields, databaseID: databaseID, authority: authority) }
                    if let properties = base["properties"] { references(["properties": properties], databaseID: databaseID, authority: authority) }
                }
                for (rowID, basis) in operation["base_rows"] as? [String: Any] ?? [:] {
                    row(rowID, databaseID: databaseID, authority: authority, write: true)
                    guard let basis = basis as? [String: Any], Set(basis.keys).isSubset(of: ["updated_at", "after_operation"]) else { issue("database", databaseID, "missing"); continue }
                }
            }
          }
        }
        try eachRecord("SELECT bucket,key,value FROM records WHERE profile_id=?", profile) { bucket, encoded, bytes in
            if overlayByKey[bucket + "|" + encoded] != nil || issues.count > 100 { return }
            guard let value = try self.decode(bytes) as? [String: Any] else { throw FountainOutboxError.storage }
            let key = try self.decode(Data(encoded.utf8))
            let item = try self.change(["op": "put", "bucket": bucket, "key": key, "value": value])
            try inspect(item)
        }
        for item in overlayByKey.values where item.op != "delete" { try inspect(item) }
        return (issues, deadline)
    }
    @discardableResult private func requireAccess(_ profile: String, overlay: [Change] = []) throws -> Double {
        let result = try accessIssues(profile, overlay: overlay)
        guard result.issues.isEmpty else { throw FountainOutboxError.access }
        return result.deadline
    }

    func commit(lease: String, txID: String, baseHead: Int, proofEpoch: Int, digest: String) throws -> [String: Any] {
        try checkLease(lease)
        guard digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw FountainOutboxError.invalid }
        if let receipt = try rows("SELECT digest,head FROM tx_receipts WHERE tx_id=?", [txID]).first {
            guard receipt[0] as? String == digest, let head = receipt[1] as? Int else { throw FountainOutboxError.conflict }
            try transaction {
                try self.checkLease(lease)
                try self.execute("DELETE FROM staging WHERE tx_id=?", [txID])
            }
            guard let acceptedEpoch = try control("receiptProof:" + txID) as? Int else { throw FountainOutboxError.access }
            return ["head": head, "txId": txID, "proofEpoch": acceptedEpoch]
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
            guard try self.control("stagedProof:" + txID) as? Int == proofEpoch else { throw FountainOutboxError.access }
            let active = try self.availableProfile()
            let cleanupOnly = changes.allSatisfy { $0.op == "delete" || self.isRevocation($0) }
            if mode == "active" && !cleanupOnly {
                guard proofEpoch == (try self.proofEpoch()), let profile = active else { throw FountainOutboxError.access }
                try self.requireAccess(profile, overlay: changes)
            }
            for (position, item) in changes.enumerated() {
                if item.bucket == "meta", let key = try self.decode(Data(item.encodedKey.utf8)) as? String, key.hasPrefix("recovery-import:") {
                    guard mode == "active" else { throw FountainOutboxError.blocked }
                    if item.op == "delete" {
                        guard try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [item.profile]) > 0 else { throw FountainOutboxError.blocked }
                    } else if let previous = try self.rows("SELECT value FROM records WHERE bucket='meta' AND key=?", [item.encodedKey]).first?.first as? Data,
                       previous != item.payload { throw FountainOutboxError.conflict }
                }
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
            try self.setControl("receiptProof:" + txID, proofEpoch)
            try self.execute("DELETE FROM staging WHERE tx_id=?", [txID])
            return head
        }
        guard let receipt = try rows("SELECT digest,head FROM tx_receipts WHERE tx_id=?", [txID]).first,
              receipt[0] as? String == digest, receipt[1] as? Int == result else { poisoned = true; throw FountainOutboxError.storage }
        boundary = UUID().uuidString
        return ["head": result, "txId": txID, "proofEpoch": proofEpoch]
    }

    func read(lease: String, head: Int, proofEpoch: Int, cursor: String?, byteLimit: Int) throws -> [String: Any] {
        try checkLease(lease)
        guard head == (try self.head()), byteLimit > 0, byteLimit <= partLimit else { throw FountainOutboxError.head }
        let profile = try verifiedProfile()
        guard proofEpoch == (try self.proofEpoch()) else { throw FountainOutboxError.access }
        let deadline = try requireAccess(profile)
        readDeadline = deadline
        guard deadline > Date().timeIntervalSince1970 * 1000 else { throw FountainOutboxError.access }
        var rowID = 0, offset = 0
        if let cursor = cursor {
            guard cursor.utf8.count <= 2048, let value = try decode(Data(cursor.utf8)) as? [String: Any],
                  value["lease"] as? String == lease, value["profile"] as? String == profile,
                  try checkedInteger(value["proofEpoch"]) == proofEpoch,
                  value["expiresAt"] as? Double == deadline,
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
        if more { next = String(data: try json(["lease": lease, "profile": profile, "head": head, "proofEpoch": proofEpoch, "expiresAt": deadline, "row": rowID, "offset": offset]), encoding: .utf8)! }
        else { next = NSNull() }
        return ["head": head, "proofEpoch": proofEpoch, "fragments": fragments, "next": next]
    }
}
