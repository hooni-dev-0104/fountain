// Explicit, read-only recovery. Never use an active outbox grant or expose bytes to JS.
import Foundation
import SQLite3
import Darwin
import CryptoKit

enum FountainRecoveryError: Error {
    case auth, stale, access, storage, cancelled
    var code: String {
        switch self {
        case .auth: return "RECOVERY_AUTH_REQUIRED"
        case .stale: return "RECOVERY_STALE"
        case .access: return "RECOVERY_ACCESS_REQUIRED"
        case .storage: return "RECOVERY_STORAGE"
        case .cancelled: return "RECOVERY_CANCELLED"
        }
    }
    var message: String { "복구 자료의 현재 권한을 확인해 주세요. 선택한 자료가 크면 나누어 선택하세요. 원본은 유지됩니다." }
}

final class FountainRecovery {
    struct Authority {
        let origin: String, workspace: String, member: String, binding: String, reference: String, role: String
        let deadline: Double
        private static func boolean(_ value: Any?) -> Bool? {
            guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
            return number.boolValue
        }
        static func session(_ data: Data, origin: String, reference: String) throws -> Authority {
            guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  boolean(body["authenticated"]) == true, let member = body["member"] as? [String: Any],
                  boolean(member["active"]) == true, ["owner", "admin", "member", "guest"].contains(member["role"] as? String ?? ""),
                  let workspace = body["workspace_id"] as? String, let actor = member["id"] as? String,
                  let binding = body["cache_binding"] as? String,
                  [workspace, actor, binding].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1000 && !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }) else { throw FountainRecoveryError.auth }
            let now = Date().timeIntervalSince1970 * 1000
            let deadline: Double
            if body["mode"] as? String == "local", boolean(body["required"]) == false, reference == "local-no-cookie" { deadline = now + 86_400_000 }
            else {
                guard ["accounts", "family"].contains(body["mode"] as? String ?? ""), reference != "local-no-cookie", let raw = body["expires_at"] as? String else { throw FountainRecoveryError.auth }
                let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard let date = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) else { throw FountainRecoveryError.auth }
                deadline = min(date.timeIntervalSince1970 * 1000, now + 86_400_000)
            }
            guard deadline > now else { throw FountainRecoveryError.auth }
            return Authority(origin: origin, workspace: workspace, member: actor, binding: binding, reference: reference, role: member["role"] as! String, deadline: deadline)
        }
        func matches(_ other: Authority) -> Bool {
            origin == other.origin && workspace == other.workspace && member == other.member && binding == other.binding && reference == other.reference && role == other.role
        }
        func envelope(_ body: [String: Any]) -> Bool {
            body["workspace_id"] as? String == workspace && body["current_member_id"] as? String == member && body["session_binding"] as? String == binding
        }
    }
    private struct Entry {
        let handle: String, row: Int64, recovery: Bool, profile: String, bucket: String, encoded: String, category: String
        let bytes: Int, digest: String
    }
    private struct Prepared {
        let token: String, handles: [String], digests: [String: String], authority: Authority
        let urls: [URL], paths: [String], authorityDigests: [String: String], deadline: Double
        let floorAccess: Int, floorData: Int
        let outputDigests: [String: String]
    }
    private let limit = 16 * 1024 * 1024
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private var db: OpaquePointer?
    private let path: URL?
    private let fingerprint: String
    private var sourceHead = ""
    private let authority: Authority
    private var sessionDeadline: Double
    private let inventoryDeadline = Date().timeIntervalSince1970 * 1000 + 300_000
    private var entries: [String: Entry] = [:], cursors: [String: (Int, Int64)] = [:]
    private var inventoryBytes = 0
    private var prepared: Prepared?
    private var workspaceExportAllowed = false
    private var localVersionChecks: [String: Bool] = [:]
    private var localLineages: [String: LocalLineage] = [:]
    private var localAuxiliaryBytes = 0
    private var closed = false
    private(set) var boundary = UUID().uuidString
    let token = UUID().uuidString

    convenience init(authority: Authority) throws { try self.init(authority: authority, isolatedDirectory: nil) }
    #if DEBUG
    // Read-only native QA fixtures may inspect only their private temp database;
    // no renderer method, URL input, or release-build path override exists.
    convenience init(authority: Authority, testingDirectory: URL) throws {
        let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL.path + "/"
        guard testingDirectory.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(temporary) else { throw FountainRecoveryError.storage }
        try self.init(authority: authority, isolatedDirectory: testingDirectory)
    }
    #endif
    private init(authority: Authority, isolatedDirectory: URL?) throws {
        self.authority = authority
        sessionDeadline = authority.deadline
        let manager = FileManager.default
        let directory: URL
        if let isolatedDirectory { directory = isolatedDirectory }
        else {
            let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
            directory = support.appendingPathComponent("FountainOutbox", isDirectory: true)
        }
        if !manager.fileExists(atPath: directory.path) { path = nil; fingerprint = "absent"; return }
        try Self.privateItem(directory, directory: true)
        // Canonicalize the already validated directory (e.g. macOS /var) only;
        // leave the database basename unresolved for SQLite's NOFOLLOW check.
        guard let resolvedDirectory = realpath(directory.path, nil) else { throw FountainRecoveryError.storage }
        let canonicalDirectory = URL(fileURLWithPath: String(cString: resolvedDirectory), isDirectory: true)
        free(resolvedDirectory)
        let candidate = canonicalDirectory.appendingPathComponent(FountainOutbox.hash(Data(authority.origin.utf8)) + ".sqlite")
        if !manager.fileExists(atPath: candidate.path) { path = nil; fingerprint = "absent"; return }
        try Self.privateItem(candidate, directory: false)
        path = candidate; fingerprint = try Self.fingerprint(candidate)
        // SQLite must own every database descriptor so its VFS can preserve other
        // live connections' locks. NOFOLLOW supplies the symlink guard at open.
        guard sqlite3_open_v2(candidate.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW, nil) == SQLITE_OK else { close(); throw FountainRecoveryError.storage }
        do {
            guard sqlite3_exec(db, "PRAGMA query_only=ON", nil, nil, nil) == SQLITE_OK,
                  sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK,
                  try Self.fingerprint(candidate) == fingerprint else { throw FountainRecoveryError.storage }
            let version = try scalar("PRAGMA user_version")
            guard version == 1 else { throw FountainRecoveryError.storage }
            sourceHead = try headDigest(db)
        } catch { close(); throw error }
    }
    deinit { close() }
    func close() {
        closed = true
        cancelPrepared()
        if let db = db { sqlite3_close_v2(db) }; db = nil
        entries.removeAll(); cursors.removeAll(); inventoryBytes = 0
    }
    func cancelPrepared() {
        for url in prepared?.urls ?? [] { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        prepared = nil
        workspaceExportAllowed = false
        boundary = UUID().uuidString
    }
    @discardableResult func cancelToken(_ token: String) -> Bool { if prepared?.token == token { cancelPrepared(); return true }; return false }
    func validContext(_ other: Authority) -> Bool {
        let now = Date().timeIntervalSince1970 * 1000
        return !closed && authority.matches(other) && min(sessionDeadline, other.deadline) > now && inventoryDeadline > now
    }
    func validMetadata(_ exportToken: String?, other: Authority) -> Bool {
        guard validContext(other) else { return false }
        guard let token = exportToken else { return true }
        return workspaceExportAllowed && prepared?.token == token && (prepared?.deadline ?? 0) > Date().timeIntervalSince1970 * 1000
    }
    func checkSource(_ other: Authority) throws { try current(other) }
    func sameSession(_ data: Data, origin: String, reference: String) -> Bool {
        guard let current = try? Authority.session(data, origin: origin, reference: reference) else { return false }
        guard authority.matches(current) else { return false }
        sessionDeadline = min(sessionDeadline, current.deadline)
        return sessionDeadline > Date().timeIntervalSince1970 * 1000
    }
    private static func privateItem(_ url: URL, directory: Bool) throws {
        let info = try FileManager.default.attributesOfItem(atPath: url.path)
        guard info[.type] as? FileAttributeType == (directory ? .typeDirectory : .typeRegular),
              (info[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              (info[.posixPermissions] as? NSNumber)?.intValue == (directory ? 0o700 : 0o600) else { throw FountainRecoveryError.storage }
    }
    private static func fingerprint(_ url: URL) throws -> String {
        let value = try FileManager.default.attributesOfItem(atPath: url.path)
        guard value[.type] as? FileAttributeType == .typeRegular else { throw FountainRecoveryError.storage }
        return [value[.systemNumber], value[.systemFileNumber], value[.size], (value[.modificationDate] as? Date)?.timeIntervalSince1970].map { String(describing: $0) }.joined(separator: ":")
    }
    private func scalar(_ sql: String) throws -> Int {
        var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, sqlite3_step(statement) == SQLITE_ROW else { throw FountainRecoveryError.storage }
        return Int(sqlite3_column_int64(statement, 0))
    }
    private func scoped(_ profile: String) -> Bool {
        let values = profile.components(separatedBy: "|")
        guard values.count == 4, values[0] == authority.origin, values[1].removingPercentEncoding == authority.workspace,
              values[2].removingPercentEncoding == authority.member, let binding = values[3].removingPercentEncoding,
              !binding.isEmpty, binding.utf8.count <= 1000, FountainOutbox.encodeURIComponent(binding) == values[3] else { return false }
        return true
    }
    private func headDigest(_ connection: OpaquePointer?) throws -> String {
        var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(connection, "SELECT value FROM control WHERE id='head'", -1, &statement, nil) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_ROW else { throw FountainRecoveryError.storage }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count > 0, count <= 4096, let bytes = sqlite3_column_blob(statement, 0) else { throw FountainRecoveryError.storage }
        return FountainOutbox.hash(Data(bytes: bytes, count: count))
    }
    private func current(_ other: Authority) throws {
        guard validContext(other) else { throw FountainRecoveryError.stale }
        if let path = path {
            try Self.privateItem(path, directory: false)
            guard try Self.fingerprint(path) == fingerprint else { throw FountainRecoveryError.stale }
            var fresh: OpaquePointer?; defer { if let fresh = fresh { sqlite3_close_v2(fresh) } }
            guard sqlite3_open_v2(path.path, &fresh, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW, nil) == SQLITE_OK,
                  try headDigest(fresh) == sourceHead, try Self.fingerprint(path) == fingerprint else { throw FountainRecoveryError.stale }
        }
    }
    private func read(_ row: Int64, recovery: Bool) throws -> (String, String, String, Data) {
        let sql = recovery ? "SELECT bucket,key,profile_id,value FROM recovery WHERE rowid=?" : "SELECT bucket,key,profile_id,value FROM records WHERE rowid=?"
        var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
              sqlite3_bind_int64(statement, 1, row) == SQLITE_OK, sqlite3_step(statement) == SQLITE_ROW,
              let bucket = sqlite3_column_text(statement, 0), let key = sqlite3_column_text(statement, 1), let profile = sqlite3_column_text(statement, 2) else { throw FountainRecoveryError.stale }
        let size = Int(sqlite3_column_bytes(statement, 3))
        guard size > 0, size <= limit, let bytes = sqlite3_column_blob(statement, 3) else { throw FountainRecoveryError.access }
        return (String(cString: bucket), String(cString: key), String(cString: profile), Data(bytes: bytes, count: size))
    }
    private func attributed(_ row: Int64, recovery: Bool, profile: String, bucket: String, encoded: String, digest: String) throws -> Bool {
        let key = recovery ? "archiveAuthority:" + String(row) : "recordAuthority:" + bucket + "|" + encoded
        var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "SELECT value FROM control WHERE id=?", -1, &statement, nil) == SQLITE_OK,
              sqlite3_bind_text(statement, 1, key, -1, transient) == SQLITE_OK else { throw FountainRecoveryError.storage }
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { return false }
        guard status == SQLITE_ROW else { throw FountainRecoveryError.storage }
        let size = Int(sqlite3_column_bytes(statement, 0))
        guard size > 0, size <= 16384, let bytes = sqlite3_column_blob(statement, 0),
              let proof = try JSONSerialization.jsonObject(with: Data(bytes: bytes, count: size)) as? [String: Any] else { throw FountainRecoveryError.storage }
        let actor = authority.origin + "|" + [authority.workspace, authority.member].map(FountainOutbox.encodeURIComponent).joined(separator: "|")
        return proof["actor"] as? String == actor && proof["profile"] as? String == profile && proof["digest"] as? String == digest && (recovery ? ["confirmed", "upgrade"].contains(proof["trust"] as? String ?? "") : proof["trust"] as? String == "confirmed")
    }
    private func privateControl(_ key: String) throws -> Any? {
        var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "SELECT value FROM control WHERE id=?", -1, &statement, nil) == SQLITE_OK,
              sqlite3_bind_text(statement, 1, key, -1, transient) == SQLITE_OK else { throw FountainRecoveryError.storage }
        let status = sqlite3_step(statement); if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW, let bytes = sqlite3_column_blob(statement, 0) else { throw FountainRecoveryError.storage }
        let size = Int(sqlite3_column_bytes(statement, 0)); guard size > 0, size <= 16384 else { throw FountainRecoveryError.storage }
        return try JSONSerialization.jsonObject(with: Data(bytes: bytes, count: size), options: [.fragmentsAllowed])
    }
    private func targetPage(_ entry: Entry, _ value: [String: Any]) -> String? {
        if entry.bucket == "mutations", let operation = value["operation"] as? [String: Any], (operation["kind"] as? String)?.hasPrefix("page.") == true { return operation["target_id"] as? String }
        return pageID(entry, value)
    }
    private struct LocalLineage { let target: String, externalParent: String?, teamspace: String? }
    private func nativeCreationVersion(_ context: [String: Any], bucket: String) throws -> Bool {
        guard let profile = context["profile"] as? String, let page = context["page"] as? String, let creation = context["creation"] as? String else { throw FountainRecoveryError.access }
        let rawKey: Any = bucket == "mutations" ? [profile, creation] : profile + "|" + FountainOutbox.encodeURIComponent(page)
        let encoded = String(data: try JSONSerialization.data(withJSONObject: rawKey, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]), encoding: .utf8)!, cacheKey = bucket + "|" + encoded + "|" + FountainOutbox.hash(try json(context))
        if let known = localVersionChecks[cacheKey] { return known }
        for recovery in [false, true] {
            var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
            let table = recovery ? "recovery" : "records"
            guard sqlite3_prepare_v2(db, "SELECT rowid,value FROM " + table + " WHERE profile_id=? AND bucket=? AND key=? ORDER BY rowid DESC LIMIT 100001", -1, &statement, nil) == SQLITE_OK,
                  sqlite3_bind_text(statement, 1, profile, -1, transient) == SQLITE_OK, sqlite3_bind_text(statement, 2, bucket, -1, transient) == SQLITE_OK,
                  sqlite3_bind_text(statement, 3, encoded, -1, transient) == SQLITE_OK else { throw FountainRecoveryError.storage }
            var rows = 0
            while true {
                let status = sqlite3_step(statement); if status == SQLITE_DONE { break }
                guard status == SQLITE_ROW else { throw FountainRecoveryError.storage }
                rows += 1; guard rows <= 100000 else { throw FountainRecoveryError.access }
                let row = sqlite3_column_int64(statement, 0), size = Int(sqlite3_column_bytes(statement, 1))
                guard size > 0, size <= limit, size <= 64 * 1024 * 1024 - localAuxiliaryBytes, let raw = sqlite3_column_blob(statement, 1) else { throw FountainRecoveryError.access }
                localAuxiliaryBytes += size
                let digest = FountainOutbox.hash(Data(bytes: raw, count: size)), key = recovery ? "archiveAuthority:" + String(row) : "recordAuthority:" + bucket + "|" + encoded
                guard let attribution = try privateControl(key) as? [String: Any], attribution["trust"] as? String == "confirmed", attribution["digest"] as? String == digest,
                      let stamped = attribution["nativeLocal"] as? [String: Any], try json(stamped) == json(context) else { continue }
                let entry = Entry(handle: "", row: row, recovery: recovery, profile: profile, bucket: bucket, encoded: encoded, category: "local_page", bytes: size, digest: digest)
                guard let record = try checkedValue(entry) else { continue }
                if bucket == "mutations" {
                    guard let operation = record["operation"] as? [String: Any], operation["kind"] as? String == "page.create", operation["id"] as? String == creation,
                          operation["target_id"] as? String == page, operation["document_epoch"] as? String == context["epoch"] as? String,
                          context["operationDigest"] as? String == FountainOutbox.hash(try json(operation)) else { continue }
                } else {
                    guard let metadata = record["metadata"] as? [String: Any], metadata["create_operation_id"] as? String == creation,
                          metadata["initial_epoch"] as? String == context["epoch"] as? String, (metadata["page"] as? [String: Any])?["id"] as? String == page else { continue }
                }
                localVersionChecks[cacheKey] = true; return true
            }
        }
        localVersionChecks[cacheKey] = false; return false
    }
    private func localLineage(_ entry: Entry, value: [String: Any]) throws -> LocalLineage? {
        guard let target = targetPage(entry, value), identifier(target) else { return nil }
        let key = entry.recovery ? "archiveAuthority:" + String(entry.row) : "recordAuthority:" + entry.bucket + "|" + entry.encoded
        guard let attribution = try privateControl(key) as? [String: Any], attribution["trust"] as? String == "confirmed",
              let original = attribution["nativeLocal"] as? [String: Any] else { return nil }
        let actor = authority.origin + "|" + [authority.workspace, authority.member].map(FountainOutbox.encodeURIComponent).joined(separator: "|")
        let observedPrefix = "serverObserved:" + FountainOutbox.encodeURIComponent(authority.workspace) + "|"
        if try privateControl(observedPrefix + FountainOutbox.encodeURIComponent(target)) != nil { return nil }
        guard original["profile"] as? String == entry.profile, original["actor"] as? String == actor, original["page"] as? String == target,
              let epoch = original["epoch"] as? String, let creation = original["creation"] as? String else { throw FountainRecoveryError.access }
        if entry.bucket == "localPages" { guard let metadata = value["metadata"] as? [String: Any], metadata["initial_epoch"] as? String == epoch, metadata["create_operation_id"] as? String == creation, (metadata["page"] as? [String: Any])?["id"] as? String == target else { throw FountainRecoveryError.access } }
        if entry.bucket == "snapshots", (value["snapshot"] as? [String: Any])?["epoch"] as? String != epoch { throw FountainRecoveryError.access }
        if entry.bucket == "drafts", (value["draft"] as? [String: Any])?["epoch"] as? String != epoch { throw FountainRecoveryError.access }
        if entry.bucket == "operations", (value["operation"] as? [String: Any])?["_epoch"] as? String != epoch { throw FountainRecoveryError.access }
        if entry.bucket == "mutations", let operation = value["operation"] as? [String: Any], operation["kind"] as? String == "page.create" {
            guard operation["id"] as? String == creation, operation["document_epoch"] as? String == epoch,
                  original["operationDigest"] as? String == FountainOutbox.hash(try json(operation)) else { throw FountainRecoveryError.access }
        }
        var context = original, visited = Set<String>()
        func result(parent: String?, teamspace: String?) -> LocalLineage {
            for page in visited { localLineages[entry.profile + "|" + FountainOutbox.encodeURIComponent(page)] = LocalLineage(target: page, externalParent: parent, teamspace: teamspace) }
            return LocalLineage(target: target, externalParent: parent, teamspace: teamspace)
        }
        for _ in 0..<100000 {
            guard context["version"] as? Int == 1, context["profile"] as? String == entry.profile, context["actor"] as? String == actor,
                  let page = context["page"] as? String, identifier(page), visited.insert(page).inserted,
                  let epoch = context["epoch"] as? String, !epoch.isEmpty, epoch.utf8.count <= 1000,
                  let creation = context["creation"] as? String, identifier(creation) else { throw FountainRecoveryError.access }
            if let known = localLineages[entry.profile + "|" + FountainOutbox.encodeURIComponent(page)] { return result(parent: known.externalParent, teamspace: known.teamspace) }
            guard try nativeCreationVersion(context, bucket: "mutations"), try nativeCreationVersion(context, bucket: "localPages") else { throw FountainRecoveryError.access }
            if let parent = context["parent"] as? String {
                guard identifier(parent), !visited.contains(parent) else { throw FountainRecoveryError.access }
                if try privateControl(observedPrefix + FountainOutbox.encodeURIComponent(parent)) == nil,
                   let ancestor = try privateControl("nativeLocal:" + entry.profile + "|" + FountainOutbox.encodeURIComponent(parent)) as? [String: Any] { context = ancestor; continue }
                return result(parent: parent, teamspace: nil)
            }
            guard context["parent"] is NSNull, context["teamspace"] is String || context["teamspace"] is NSNull else { throw FountainRecoveryError.access }
            return result(parent: nil, teamspace: context["teamspace"] as? String)
        }
        throw FountainRecoveryError.access
    }
    private func readablePage(_ entry: Entry, value: [String: Any], responses: Responses, other: Authority) throws -> Bool {
        guard let target = targetPage(entry, value) else { throw FountainRecoveryError.access }
        let local: LocalLineage?
        do { local = try localLineage(entry, value: value) } catch FountainRecoveryError.access { local = nil }
        guard let local else { try page(target, responses: responses, other: other); return false }
        if let parent = local.externalParent { try page(parent, responses: responses, other: other) }
        else {
            guard ["owner", "admin", "member"].contains(other.role) else { throw FountainRecoveryError.access }
            let workspace = try authorized("/api/workspace", responses: responses, other: other)
            if let teamspace = local.teamspace, !teamspace.isEmpty {
                guard let spaces = workspace["teamspaces"] as? [[String: Any]], let space = spaces.first(where: { $0["id"] as? String == teamspace }), (safeInteger(space["access_level"]) ?? 0) >= 3 else { throw FountainRecoveryError.access }
            }
        }
        return true
    }
    func inventory(_ other: Authority, cursor: String?, count: Int) throws -> [String: Any] {
        try current(other)
        guard (1...100).contains(count), cursor == nil || cursors[cursor!] != nil else { throw FountainRecoveryError.stale }
        guard db != nil else { return ["inventoryToken": token, "items": [], "next": NSNull()] }
        var position = cursor.flatMap { cursors[$0] } ?? (0, 0)
        let prefix = authority.origin + "|" + [authority.workspace, authority.member].map(FountainOutbox.encodeURIComponent).joined(separator: "|") + "|"
        var items: [[String: Any]] = [], next: Any = NSNull()
        while position.0 < 2 {
            let sql = position.0 == 0
                ? "SELECT rowid,bucket,key,profile_id,length(value) FROM records WHERE substr(profile_id,1,length(?))=? AND rowid>? AND bucket IN ('mutations','drafts','operations','localPages','snapshots') ORDER BY rowid"
                : "SELECT rowid,bucket,key,profile_id,length(value) FROM recovery WHERE substr(profile_id,1,length(?))=? AND rowid>? AND bucket IN ('mutations','drafts','operations','localPages','snapshots') ORDER BY rowid"
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
                  sqlite3_bind_text(statement, 1, prefix, -1, transient) == SQLITE_OK,
                  sqlite3_bind_text(statement, 2, prefix, -1, transient) == SQLITE_OK,
                  sqlite3_bind_int64(statement, 3, position.1) == SQLITE_OK else { sqlite3_finalize(statement); throw FountainRecoveryError.storage }
            do {
                while items.count < count {
                    let status = sqlite3_step(statement)
                    if status == SQLITE_DONE { break }
                    guard status == SQLITE_ROW, let bucketRaw = sqlite3_column_text(statement, 1), let encodedRaw = sqlite3_column_text(statement, 2), let profileRaw = sqlite3_column_text(statement, 3) else { throw FountainRecoveryError.storage }
                    position.1 = sqlite3_column_int64(statement, 0)
                    let profile = String(cString: profileRaw); if !scoped(profile) { continue }
                    guard entries.count < 10000 else { throw FountainRecoveryError.access }
                    let bucket = String(cString: bucketRaw), bytes = Int(sqlite3_column_int64(statement, 4))
                    guard bytes > 0, bytes <= limit else { continue }
                    let actualDigest = FountainOutbox.hash(try read(position.1, recovery: position.0 == 1).3)
                    guard try attributed(position.1, recovery: position.0 == 1, profile: profile, bucket: bucket, encoded: String(cString: encodedRaw), digest: actualDigest) else { continue }
                    var category = bucket == "mutations" ? "typed" : bucket == "localPages" ? "local_page" : "body"
                    let handle = UUID().uuidString, recovery = position.0 == 1
                    let metadataBytes = profile.utf8.count + String(cString: encodedRaw).utf8.count + 512
                    guard inventoryBytes <= limit - metadataBytes else { throw FountainRecoveryError.access }
                    inventoryBytes += metadataBytes
                    var blocked = bytes <= 0 || bytes > limit
                    let digest = actualDigest
                    let candidate = Entry(handle: handle, row: position.1, recovery: recovery, profile: profile, bucket: bucket, encoded: String(cString: encodedRaw), category: category, bytes: bytes, digest: digest)
                    if !blocked {
                        if let value = try checkedValue(candidate) {
                            if bucket == "mutations" {
                                let kind = (value["operation"] as? [String: Any])?["kind"] as? String ?? ""
                                if kind == "page.create" { category = "local_page" }
                                else if !["page.patch", "row.create", "row.patch", "row.delete"].contains(kind) { category = "unsupported"; blocked = true }
                            }
                        } else { category = "unsupported"; blocked = true }
                    }
                    entries[handle] = Entry(handle: handle, row: candidate.row, recovery: recovery, profile: profile, bucket: bucket, encoded: candidate.encoded, category: category, bytes: bytes, digest: digest)
                    items.append(["handle": handle, "category": category, "recordCount": 1, "byteLength": bytes, "state": blocked ? "blocked" : "needs_check"])
                }
                sqlite3_finalize(statement)
            } catch { sqlite3_finalize(statement); throw error }
            if items.count == count { let cursor = UUID().uuidString; cursors[cursor] = position; next = cursor; break }
            position = (position.0 + 1, 0)
        }
        return ["inventoryToken": token, "items": items, "next": next]
    }

    private func selected(_ handles: [String], _ other: Authority) throws -> [Entry] {
        try current(other)
        guard !handles.isEmpty, handles.count <= 100, Set(handles).count == handles.count else { throw FountainRecoveryError.stale }
        return try handles.map { handle in
            guard let entry = entries[handle], scoped(entry.profile) else { throw FountainRecoveryError.stale }
            return entry
        }
    }
    private func sourceData(_ entry: Entry) throws -> Data {
        let source = try read(entry.row, recovery: entry.recovery)
        guard source.0 == entry.bucket, source.1 == entry.encoded, source.2 == entry.profile, FountainOutbox.hash(source.3) == entry.digest else { throw FountainRecoveryError.stale }
        guard try attributed(entry.row, recovery: entry.recovery, profile: entry.profile, bucket: entry.bucket, encoded: entry.encoded, digest: entry.digest) else { throw FountainRecoveryError.access }
        return source.3
    }
    private func value(_ entry: Entry) throws -> [String: Any] {
        let bytes = try sourceData(entry)
        guard let value = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { throw FountainRecoveryError.access }
        let record: [String: Any]
        if value["op"] != nil || value["bucket"] != nil {
            guard Set(value.keys) == Set(["op", "bucket", "key", "value"]), value["op"] as? String == "put", value["bucket"] as? String == entry.bucket,
                  let key = value["key"], let stored = entry.encoded.data(using: .utf8),
                  let storedKey = try? JSONSerialization.jsonObject(with: stored, options: [.fragmentsAllowed]),
                  let expected = try? JSONSerialization.data(withJSONObject: storedKey, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]),
                  let actual = try? JSONSerialization.data(withJSONObject: key, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]), actual == expected,
                  let inner = value["value"] as? [String: Any] else { throw FountainRecoveryError.access }
            record = inner
        } else { record = value }
        guard record["profileId"] as? String == entry.profile else { throw FountainRecoveryError.access }
        guard let encoded = entry.encoded.data(using: .utf8), let storedKey = try? JSONSerialization.jsonObject(with: encoded, options: [.fragmentsAllowed]) else { throw FountainRecoveryError.access }
        if ["mutations", "operations", "drafts"].contains(entry.bucket) {
            guard let keys = storedKey as? [String], keys.count == 2 else { throw FountainRecoveryError.access }
            if entry.bucket == "mutations" {
                guard keys[0] == entry.profile, record["id"] as? String == keys[1], let operation = record["operation"] as? [String: Any],
                      operation["id"] as? String == keys[1], let kind = operation["kind"] as? String,
                      let target = operation[kind.hasPrefix("row.") ? "database_id" : "target_id"] as? String,
                      record["resourceKey"] as? String == entry.profile + (kind.hasPrefix("row.") ? "|database|" : "|") + FountainOutbox.encodeURIComponent(target) else { throw FountainRecoveryError.access }
            } else {
                guard record["key"] as? String == keys[0], record[entry.bucket == "drafts" ? "clientId" : "id"] as? String == keys[1] else { throw FountainRecoveryError.access }
                if entry.bucket == "operations", (record["operation"] as? [String: Any])?["id"] as? String != keys[1] { throw FountainRecoveryError.access }
            }
        } else if ["snapshots", "localPages"].contains(entry.bucket) { guard record["key"] as? String == storedKey as? String else { throw FountainRecoveryError.access } }
        return record
    }
    private func checkedValue(_ entry: Entry) throws -> [String: Any]? {
        do { return try value(entry) } catch FountainRecoveryError.access { return nil }
    }
    private func pageID(_ entry: Entry, _ value: [String: Any]) -> String? {
        let resource = value["key"] as? String
        let pieces = resource?.components(separatedBy: "|") ?? []
        guard let encoded = entry.encoded.data(using: .utf8), let key = try? JSONSerialization.jsonObject(with: encoded, options: [.fragmentsAllowed]) else { return nil }
        let sourceResource = key as? String ?? (key as? [String])?.first
        return pieces.count == 5 && pieces.prefix(4).joined(separator: "|") == entry.profile && sourceResource == resource && value["profileId"] as? String == entry.profile ? pieces[4].removingPercentEncoding : nil
    }
    func authorityPaths(_ handles: [String], _ other: Authority) throws -> [String] {
        var paths = Set(["/api/workspace"])
        for entry in try selected(handles, other) {
            if entry.digest.isEmpty { continue }
            guard let value = try checkedValue(entry) else { continue }
            if let local = try? localLineage(entry, value: value) {
                if let parent = local.externalParent { paths.insert("/api/pages/" + FountainOutbox.encodeURIComponent(parent) + "/collaboration") }
                continue
            }
            if entry.bucket == "mutations", let operation = value["operation"] as? [String: Any], let kind = operation["kind"] as? String {
                if ["page.patch", "page.create"].contains(kind), let id = operation["target_id"] as? String { paths.insert("/api/pages/" + FountainOutbox.encodeURIComponent(id) + "/collaboration") }
                else if ["row.create", "row.patch", "row.delete"].contains(kind), let id = operation["database_id"] as? String { paths.insert("/api/databases/" + FountainOutbox.encodeURIComponent(id)) }
            } else if let id = pageID(entry, value) { paths.insert("/api/pages/" + FountainOutbox.encodeURIComponent(id) + "/collaboration") }
        }
        return ["/api/workspace"] + paths.filter { $0 != "/api/workspace" }.sorted()
    }
    typealias Responses = [String: (Int, Data)]
    func additionalPaths(_ handles: [String], _ other: Authority, responses: Responses) throws -> [String] {
        var paths = Set<String>()
        let workspace = try authorized("/api/workspace", responses: responses, other: other)
        try exportPolicy(workspace)
        for entry in try selected(handles, other) {
            if entry.digest.isEmpty { continue }
            guard let value = try checkedValue(entry) else { continue }
            if entry.bucket == "mutations", let operation = value["operation"] as? [String: Any], let id = operation["database_id"] as? String {
                let dbPath = "/api/databases/" + FountainOutbox.encodeURIComponent(id)
                guard let db = try? authorized(dbPath, responses: responses, other: other), let database = db["database"] as? [String: Any] else { continue }
                let oldSchema = ((operation["base"] as? [String: Any])?["schema"] as? [String: [String: Any]])?.values.map { $0 } ?? []
                let schema = (database["properties"] as? [[String: Any]] ?? []) + oldSchema
                var bases = [operation["body"] as? [String: Any] ?? [:], operation["base"] as? [String: Any] ?? [:]]
                if let fields = (operation["base"] as? [String: Any])?["fields"] as? [String: Any] { bases.append(fields) }
                for old in (operation["base_rows"] as? [String: [String: Any]] ?? [:]).values { bases.append(old); if let fields = old["fields"] as? [String: Any] { bases.append(fields) } }
                for property in schema {
                    if property["type"] as? String == "relation" {
                        if let target = property["database_id"] as? String { paths.insert("/api/databases/" + FountainOutbox.encodeURIComponent(target)) }
                        else { for item in workspace["databases"] as? [[String: Any]] ?? [] { if let id = item["id"] as? String { paths.insert("/api/databases/" + FountainOutbox.encodeURIComponent(id)) } } }
                    } else if property["type"] as? String == "files", let key = property["id"] as? String {
                        for basis in bases { for id in (basis["properties"] as? [String: Any])?[key] as? [String] ?? [] { paths.insert("/api/attachments/" + FountainOutbox.encodeURIComponent(id) + "/metadata") } }
                    }
                }
            }
            let blocks = (value["draft"] as? [String: Any])?["blocks"] as? [[String: Any]] ?? (value["snapshot"] as? [String: Any])?["blocks"] as? [[String: Any]] ?? []
            for block in blocks { if let id = block["attachment_id"] as? String { paths.insert("/api/attachments/" + FountainOutbox.encodeURIComponent(id) + "/metadata") } }
            var bodyOps = (value["draft"] as? [String: Any])?["ops"] as? [[String: Any]] ?? []
            if entry.bucket == "operations", let operation = value["operation"] as? [String: Any] { bodyOps.append(operation) }
            for operation in bodyOps where operation["type"] as? String == "block.set" && operation["field"] as? String == "attachment_id" { if let id = operation["value"] as? String { paths.insert("/api/attachments/" + FountainOutbox.encodeURIComponent(id) + "/metadata") } }
        }
        guard paths.count <= 100 else { throw FountainRecoveryError.access }
        return paths.filter { responses[$0] == nil }.sorted()
    }
    private func safeInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991, number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.intValue
    }
    private func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    private func authorized(_ path: String, responses: Responses, other: Authority) throws -> [String: Any] {
        guard let response = responses[path], response.0 == 200, response.1.count <= limit,
              let body = try JSONSerialization.jsonObject(with: response.1) as? [String: Any] else { throw FountainRecoveryError.access }
        if path.hasSuffix("/metadata") { return body }
        guard other.envelope(body), let access = safeInteger(body["access_revision"]), let data = safeInteger(body["data_revision"]) else { throw FountainRecoveryError.access }
        if path != "/api/workspace" {
            let workspace = try authorized("/api/workspace", responses: responses, other: other)
            guard let workspaceAccess = safeInteger(workspace["access_revision"]), let workspaceData = safeInteger(workspace["data_revision"]),
                  access == workspaceAccess, data >= workspaceData else { throw FountainRecoveryError.stale }
        }
        return body
    }
    private func permissionFloors(_ responses: Responses, other: Authority) throws {
        _ = try authorized("/api/workspace", responses: responses, other: other)
        // Validate the complete permission cut before any intermediate/export
        // file exists; a later mismatching entry must not produce partial files.
        for (path, response) in responses where response.0 == 200 {
            if let kind = FountainOutbox.canonicalResource(path: path, method: "GET")?.0, ["page", "database"].contains(kind) { _ = try authorized(path, responses: responses, other: other) }
        }
    }
    private func exportPolicy(_ workspace: [String: Any]) throws {
        guard let supplied = workspace["settings"] else { return }
        guard let settings = supplied as? [String: Any] else { throw FountainRecoveryError.access }
        guard let value = settings["disable_export"] else { return }
        guard boolean(value) == false else { throw FountainRecoveryError.access }
    }
    private func currentDenied(_ kind: String, id: String, other: Authority) throws -> Bool {
        guard db != nil else { return false }
        let profile = other.origin + "|" + [other.workspace, other.member, other.binding].map(FountainOutbox.encodeURIComponent).joined(separator: "|")
        let resource = profile + (kind == "database" ? "|database|" : "|") + FountainOutbox.encodeURIComponent(id)
        var statement: OpaquePointer?; defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "SELECT count(*) FROM tombstones WHERE scope=? OR scope=?", -1, &statement, nil) == SQLITE_OK,
              sqlite3_bind_text(statement, 1, profile, -1, transient) == SQLITE_OK,
              sqlite3_bind_text(statement, 2, resource, -1, transient) == SQLITE_OK, sqlite3_step(statement) == SQLITE_ROW else { throw FountainRecoveryError.storage }
        return sqlite3_column_int64(statement, 0) > 0
    }
    private func page(_ id: String, responses: Responses, other: Authority) throws {
        let body = try authorized("/api/pages/" + FountainOutbox.encodeURIComponent(id) + "/collaboration", responses: responses, other: other)
        guard !id.isEmpty, let page = body["page"] as? [String: Any], page["id"] as? String == id,
              (3...4).contains(safeInteger(body["access_level"]) ?? 0), safeInteger(page["access_level"]) == safeInteger(body["access_level"]),
              boolean(page["locked"]) == false, boolean(page["archived"]) == false, !(try currentDenied("page", id: id, other: other)) else { throw FountainRecoveryError.access }
    }
    private func database(_ id: String, responses: Responses, other: Authority, minimum: Int = 3) throws -> [String: Any] {
        let body = try authorized("/api/databases/" + FountainOutbox.encodeURIComponent(id), responses: responses, other: other)
        guard let database = body["database"] as? [String: Any], database["id"] as? String == id,
              (minimum...4).contains(safeInteger(database["access_level"]) ?? 0), body["rows"] is [[String: Any]],
              !(try currentDenied("database", id: id, other: other)) else { throw FountainRecoveryError.access }
        var ids = Set<String>()
        for row in body["rows"] as? [[String: Any]] ?? [] {
            guard let rowID = row["id"] as? String, identifier(rowID), ids.insert(rowID).inserted,
                  row["database_id"] as? String == id, (1...4).contains(safeInteger(row["access_level"]) ?? 0) else { throw FountainRecoveryError.access }
        }
        return body
    }
    private func row(_ id: String, db: [String: Any], edit: Bool) throws {
        guard let row = (db["rows"] as? [[String: Any]])?.first(where: { $0["id"] as? String == id }),
              (edit ? 3...4 : 1...4).contains(safeInteger(row["access_level"]) ?? 0) else { throw FountainRecoveryError.access }
    }
    private func references(_ fields: [String: Any], db: [String: Any], responses: Responses, other: Authority, oldSchema: [[String: Any]] = []) throws {
        if let parent = fields["parent_row_id"], !(parent is NSNull) && !(parent is String) { throw FountainRecoveryError.access }
        if let dependencies = fields["depends_on"], !(dependencies is [String]) { throw FountainRecoveryError.access }
        if let properties = fields["properties"], !(properties is [String: Any]) { throw FountainRecoveryError.access }
        if let parent = fields["parent_row_id"] as? String { try row(parent, db: db, edit: false) }
        for id in fields["depends_on"] as? [String] ?? [] { try row(id, db: db, edit: false) }
        let properties = fields["properties"] as? [String: Any] ?? [:], database = db["database"] as? [String: Any] ?? [:]
        let schema = database["properties"] as? [[String: Any]] ?? []
        guard Set(properties.keys).isSubset(of: Set(schema.compactMap { $0["id"] as? String })) else { throw FountainRecoveryError.access }
        for (key, value) in properties {
            guard let property = oldSchema.first(where: { $0["id"] as? String == key }) ?? schema.first(where: { $0["id"] as? String == key }),
                  let kind = property["type"] as? String, validProperty(value, type: kind) else { throw FountainRecoveryError.access }
        }
        for property in schema + oldSchema where ["relation", "files"].contains(property["type"] as? String ?? "") {
            guard let key = property["id"] as? String, let supplied = properties[key] else { continue }
            if supplied is NSNull { continue }
            guard let ids = supplied as? [String] else { throw FountainRecoveryError.access }
            if property["type"] as? String == "files" {
                for id in ids { let metadata = try authorized("/api/attachments/" + FountainOutbox.encodeURIComponent(id) + "/metadata", responses: responses, other: other); guard metadata["id"] as? String == id, metadata["status"] as? String == "complete" else { throw FountainRecoveryError.access } }
                continue
            }
            if let target = property["database_id"] as? String {
                let targetDB = try self.database(target, responses: responses, other: other, minimum: 1)
                for id in ids { try row(id, db: targetDB, edit: false) }
            } else {
                for id in ids {
                    var found = false
                    for (path, _) in responses where path.hasPrefix("/api/databases/") {
                        guard let target = path.split(separator: "/").last?.removingPercentEncoding,
                              let candidate = try? self.database(target, responses: responses, other: other, minimum: 1),
                              (try? row(id, db: candidate, edit: false)) != nil else { continue }
                        found = true; break
                    }
                    guard found else { throw FountainRecoveryError.access }
                }
            }
        }
    }
    private func date(_ text: String) -> Date? {
        if text.count == 10 {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
            guard let value = formatter.date(from: text), formatter.string(from: value) == text else { return nil }; return value
        }
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    private func validProperty(_ value: Any, type: String) -> Bool {
        guard !["formula", "rollup"].contains(type) else { return false }
        if value is NSNull { return true }
        if type == "number" { guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }; return number.doubleValue.isFinite && abs(number.doubleValue) < 1e15 }
        if type == "checkbox" { return boolean(value) != nil }
        if type == "date" {
            if let text = value as? String { return date(text) != nil }
            guard let range = value as? [String: Any], Set(range.keys).isSubset(of: ["start", "end"]), let start = range["start"] as? String, let first = date(start) else { return false }
            if range["end"] == nil || range["end"] is NSNull { return true }
            guard let end = range["end"] as? String, (end.count == 10) == (start.count == 10), let last = date(end) else { return false }; return last >= first
        }
        if ["multi_select", "relation", "files"].contains(type) { guard let values = value as? [String], values.count <= 1000 else { return false }; return type != "relation" || Set(values).count == values.count }
        guard ["title", "text", "select", "status", "person", "url", "email", "created_time", "last_edited_time"].contains(type), let text = value as? String else { return false }
        return text.unicodeScalars.count <= 100000
    }
    private func bounded(_ value: Any, depth: Int = 0, nodes: inout Int) throws {
        nodes += 1
        guard depth <= 32, nodes <= 150000 else { throw FountainRecoveryError.access }
        if let array = value as? [Any] { for item in array { try bounded(item, depth: depth + 1, nodes: &nodes) } }
        else if let object = value as? [String: Any] { for (key, item) in object { guard !["__proto__", "prototype", "constructor"].contains(key) else { throw FountainRecoveryError.access }; try bounded(item, depth: depth + 1, nodes: &nodes) } }
    }
    private func json(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    private func authorityDigest(_ path: String, status: Int, data: Data) throws -> String {
        guard status == 200, FountainOutbox.canonicalResource(path: path, method: "GET") != nil else { return String(status) + ":" + FountainOutbox.hash(data) }
        guard var body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], authority.envelope(body),
              safeInteger(body["access_revision"]) != nil, safeInteger(body["data_revision"]) != nil else { throw FountainRecoveryError.access }
        // The global transport watermark may move for unrelated family activity.
        // Identity, ACL revision, resource contents and projected rows stay exact.
        body.removeValue(forKey: "data_revision")
        return String(status) + ":" + FountainOutbox.hash(try json(body))
    }
    private func authorityDigests(_ responses: Responses) throws -> [String: String] {
        var result: [String: String] = [:]
        for (path, response) in responses { result[path] = try authorityDigest(path, status: response.0, data: response.1) }
        return result
    }
    private func identifier(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.count <= 160 && ![".", ".."].contains(value) && !value.contains("/") && !value.contains("\\") && !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
    }
    private func marks(_ source: Any) throws -> [String: Any] {
        guard let source = source as? [String: Any] else { throw FountainRecoveryError.access }
        var result: [String: Any] = [:]
        for (key, value) in source {
            if ["bold", "italic", "underline", "strike", "code"].contains(key) {
                guard boolean(value) != nil else { throw FountainRecoveryError.access }; result[key] = value
            } else if ["color", "background"].contains(key) {
                guard let color = value as? String, ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"].contains(color) else { throw FountainRecoveryError.access }; result[key] = color
            } else if key == "link" {
                if value is NSNull { result[key] = NSNull(); continue }
                guard let link = value as? String, !link.isEmpty, link.unicodeScalars.count <= 2048, !link.contains("\\"), !link.unicodeScalars.contains(where: { $0.value <= 32 }) else { throw FountainRecoveryError.access }
                if link.hasPrefix("/") || link.hasPrefix("#") { guard !link.hasPrefix("//") else { throw FountainRecoveryError.access } }
                else { guard let url = URL(string: link), let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme), scheme == "mailto" ? !url.path.isEmpty : url.host?.isEmpty == false else { throw FountainRecoveryError.access } }
                result[key] = link
            } else { throw FountainRecoveryError.access }
        }
        return result
    }
    private func operations(_ values: Any) throws -> [[String: Any]] {
        guard let values = values as? [[String: Any]] else { throw FountainRecoveryError.access }
        let extra: [String: Set<String>] = ["block.insert": ["parent_id", "after_id", "block_type"], "block.move": ["parent_id", "after_id"], "block.set": ["field", "value"], "block.delete": [], "text.insert": ["after_id", "text", "marks"], "text.delete": ["char_ids"], "text.format": ["char_ids", "marks"], "history.cancel": ["targets"]]
        return try values.map { source in
            guard let type = source["type"] as? String, let fields = extra[type],
                  Set(source.keys).isSubset(of: fields.union(type == "history.cancel" ? ["id", "client", "clock", "type", "_epoch"] : ["id", "client", "clock", "type", "_epoch", "block_id", "group_id"])),
                  let id = source["id"] as? String, !id.isEmpty, id.unicodeScalars.count <= 300,
                  let client = source["client"] as? String, !client.isEmpty, client.utf8.count <= 80,
                  client.unicodeScalars.allSatisfy({ (65...90).contains($0.value) || (97...122).contains($0.value) || (48...57).contains($0.value) || $0.value == 95 || $0.value == 45 }),
                  let clock = safeInteger(source["clock"]), clock > 0, id == client + ":" + String(clock) else { throw FountainRecoveryError.access }
            var result: [String: Any] = ["id": id, "client": client, "clock": clock, "type": type]
            for key in ["block_id", "after_id", "parent_id", "group_id", "_epoch"] {
                if let supplied = source[key] { if supplied is NSNull, ["after_id", "parent_id"].contains(key) { result[key] = NSNull() }
                    else { guard let text = supplied as? String, !text.isEmpty, text.unicodeScalars.count <= (key == "block_id" || key == "parent_id" ? 160 : 300) else { throw FountainRecoveryError.access }; result[key] = text } }
            }
            if type != "history.cancel", result["block_id"] == nil { throw FountainRecoveryError.access }
            if let text = source["text"] { guard let text = text as? String else { throw FountainRecoveryError.access }; result["text"] = text }
            for key in ["char_ids", "targets"] { if let supplied = source[key] { guard let ids = supplied as? [String], ids.count <= 100000, ids.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.count <= 300 }) else { throw FountainRecoveryError.access }; result[key] = ids } }
            if let supplied = source["marks"] { result["marks"] = try marks(supplied) }
            if type == "block.insert", let supplied = source["block_type"] { guard let value = supplied as? String, blockType(value) else { throw FountainRecoveryError.access }; result["block_type"] = value }
            if type == "text.insert" && !(source["text"] is String) { throw FountainRecoveryError.access }
            if ["text.delete", "text.format"].contains(type) && !(source["char_ids"] is [String]) { throw FountainRecoveryError.access }
            if type == "history.cancel" && ((source["targets"] as? [String])?.isEmpty != false) { throw FountainRecoveryError.access }
            if type == "block.set" {
                guard let field = source["field"] as? String, let value = source["value"], ["type", "checked", "language", "attachment_id", "size"].contains(field) else { throw FountainRecoveryError.access }
                if field == "checked" { guard boolean(value) != nil else { throw FountainRecoveryError.access } }
                else if field == "size" { guard safeInteger(value) != nil else { throw FountainRecoveryError.access } }
                else if field == "attachment_id" && value is NSNull {}
                else { guard let text = value as? String, text.unicodeScalars.count <= (field == "language" ? 100 : 160), field != "type" || blockType(text) else { throw FountainRecoveryError.access } }
                result["field"] = field; result["value"] = value
            } else if source["field"] != nil || source["value"] != nil { throw FountainRecoveryError.access }
            return result
        }
    }
    private func blockType(_ value: String) -> Bool {
        ["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "quote", "code", "callout", "divider", "toggle", "image", "bookmark", "file", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do"].contains(value)
    }
    private func blocks(_ values: Any) throws -> [[String: Any]] {
        guard let values = values as? [[String: Any]] else { throw FountainRecoveryError.access }
        return try values.map { source in
            guard Set(source.keys).isSubset(of: ["id", "type", "text", "parent_id", "checked", "language", "attachment_id", "size", "rich_text"]),
                  let id = source["id"] as? String, identifier(id), let type = source["type"] as? String, blockType(type), let text = source["text"] as? String else { throw FountainRecoveryError.access }
            var block: [String: Any] = ["id": id, "type": type, "text": text]
            if let parent = source["parent_id"] { guard parent is NSNull || (parent as? String).map(identifier) == true else { throw FountainRecoveryError.access }; block["parent_id"] = parent }
            if let checked = source["checked"] { guard boolean(checked) != nil else { throw FountainRecoveryError.access }; block["checked"] = checked }
            if let language = source["language"] { guard let language = language as? String, language.unicodeScalars.count <= 100 else { throw FountainRecoveryError.access }; block["language"] = language }
            if let id = source["attachment_id"] { guard id is NSNull || (id as? String).map(identifier) == true else { throw FountainRecoveryError.access }; block["attachment_id"] = id }
            if let size = source["size"] { guard safeInteger(size) != nil else { throw FountainRecoveryError.access }; block["size"] = size }
            if let tokens = source["rich_text"] {
                guard let tokens = tokens as? [[String: Any]] else { throw FountainRecoveryError.access }
                block["rich_text"] = try tokens.map { token -> [String: Any] in
                    guard Set(token.keys).isSubset(of: ["text", "marks"]), let text = token["text"] as? String else { throw FountainRecoveryError.access }
                    return ["text": text, "marks": try marks(token["marks"] ?? [:])]
                }
            }
            return block
        }
    }
    private func importable(_ blocks: [[String: Any]]) -> Bool {
        let types = Set(["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "quote", "code", "callout", "divider", "toggle", "image", "bookmark", "file", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do"])
        let colors = Set(["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"])
        var ids = Set<String>()
        guard blocks.count <= 2000 else { return false }
        for block in blocks {
            guard let id = block["id"] as? String, identifier(id), ids.insert(id).inserted,
                  let type = block["type"] as? String, types.contains(type), let text = block["text"] as? String, text.unicodeScalars.count <= 100000 else { return false }
            if let parent = block["parent_id"], !(parent is NSNull), (parent as? String).map(identifier) != true { return false }
            if let size = block["size"], safeInteger(size) == nil { return false }
            if let language = block["language"], (language as? String).map({ $0.unicodeScalars.count <= 100 }) != true { return false }
            if let attachment = block["attachment_id"], !(attachment is NSNull), (attachment as? String).map(identifier) != true { return false }
            if let checked = block["checked"] { guard let number = checked as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false } }
            if let supplied = block["rich_text"] {
                guard let tokens = supplied as? [[String: Any]], tokens.count <= 10000 else { return false }
                var points = 0
                for token in tokens {
                    guard Set(token.keys).isSubset(of: ["text", "marks"]), let text = token["text"] as? String else { return false }
                    if token["marks"] != nil && !(token["marks"] is [String: Any]) { return false }
                    points += text.unicodeScalars.count; if points > 100000 { return false }
                    for (mark, value) in token["marks"] as? [String: Any] ?? [:] {
                        if ["bold", "italic", "underline", "strike", "code"].contains(mark) { guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false } }
                        else if ["color", "background"].contains(mark) { guard let color = value as? String, colors.contains(color) else { return false } }
                        else if mark == "link", !(value is NSNull) {
                            guard let link = value as? String, !link.isEmpty, link.unicodeScalars.count <= 2048,
                                  !link.contains("\\"), !link.unicodeScalars.contains(where: { $0.value <= 32 }) else { return false }
                            if link.hasPrefix("/") || link.hasPrefix("#") { if link.hasPrefix("//") { return false } }
                            else { guard let url = URL(string: link), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return false } }
                        } else if mark != "link" { return false }
                    }
                }
            }
        }
        return true
    }
    private func projection(_ entry: Entry, value: [String: Any], responses: Responses, other: Authority, selectedIDs: Set<String>) throws -> (String, [String: Any], Int) {
        if entry.bucket == "localPages" {
            _ = try readablePage(entry, value: value, responses: responses, other: other)
            guard let metadata = value["metadata"] as? [String: Any], let page = metadata["page"] as? [String: Any], page["id"] as? String == targetPage(entry, value),
                  let epoch = metadata["initial_epoch"] as? String, !epoch.isEmpty, epoch.utf8.count <= 1000,
                  let creation = metadata["create_operation_id"] as? String, identifier(creation) else { throw FountainRecoveryError.access }
            return ("readable", ["page": try readablePageFields(page), "initial_epoch": epoch, "create_operation_id": creation], 0)
        }
        if entry.bucket == "mutations" {
            guard let operation = value["operation"] as? [String: Any] else { throw FountainRecoveryError.access }
            let dependencies = try operationDependencies(operation)
            if let kind = operation["kind"] as? String, ["page.create", "page.patch"].contains(kind) {
                let local = try readablePage(entry, value: value, responses: responses, other: other)
                if kind == "page.create" || local {
                    guard let id = operation["id"] as? String, identifier(id), let target = operation["target_id"] as? String, identifier(target),
                          let body = operation["body"] as? [String: Any], dependencies.allSatisfy(identifier) else { throw FountainRecoveryError.access }
                    var output: [String: Any] = ["id": id, "kind": kind, "target_id": target, "depends_on": dependencies, "body": try readablePageFields(body)]
                    if kind == "page.create" { guard body["id"] as? String == target, let epoch = operation["document_epoch"] as? String, !epoch.isEmpty, epoch.utf8.count <= 1000 else { throw FountainRecoveryError.access }; output["document_epoch"] = epoch }
                    return ("readable", ["operation": output], 0)
                }
            }
            guard let kind = operation["kind"] as? String,
                  let id = operation["id"] as? String, identifier(id), let target = operation["target_id"] as? String, identifier(target),
                  let body = operation["body"] as? [String: Any],
                  dependencies.allSatisfy({ identifier($0) && selectedIDs.contains($0) }) else { throw FountainRecoveryError.access }
            var output: [String: Any] = ["id": id, "kind": kind, "target_id": target, "depends_on": dependencies]
            if kind == "page.patch" {
                try page(target, responses: responses, other: other)
                output["body"] = body.filter { ["title", "icon", "cover", "favorite"].contains($0.key) }
                for field in ["title", "icon", "cover"] { if let value = body[field] { guard let text = value as? String, text.unicodeScalars.count <= (field == "title" ? 500 : 10000) else { throw FountainRecoveryError.access } } }
                if body["favorite"] != nil && boolean(body["favorite"]) == nil { throw FountainRecoveryError.access }
            } else {
                guard ["row.create", "row.patch", "row.delete"].contains(kind), let databaseID = operation["database_id"] as? String, identifier(databaseID) else { throw FountainRecoveryError.access }
                let db = try database(databaseID, responses: responses, other: other)
                if kind == "row.create" { guard boolean((db["database"] as? [String: Any])?["can_create_row"]) == true else { throw FountainRecoveryError.access } }
                else { try row(target, db: db, edit: true) }
                try references(body, db: db, responses: responses, other: other)
                if let base = operation["base"] as? [String: Any] {
                    let schema = (base["schema"] as? [String: [String: Any]])?.values.map { $0 } ?? []
                    if let fields = base["fields"] as? [String: Any] { try references(fields, db: db, responses: responses, other: other, oldSchema: schema) }
                    if let properties = base["properties"] { try references(["properties": properties], db: db, responses: responses, other: other, oldSchema: schema) }
                }
                for (rowID, original) in operation["base_rows"] as? [String: Any] ?? [:] {
                    try row(rowID, db: db, edit: true)
                    if let basis = original as? [String: Any] { try references(basis, db: db, responses: responses, other: other); if let fields = basis["fields"] as? [String: Any] { try references(fields, db: db, responses: responses, other: other) } }
                }
                output["database_id"] = databaseID
                output["body"] = kind == "row.delete" ? [:] : body.filter { ["properties", "parent_row_id", "depends_on"].contains($0.key) }
            }
            return ("records", ["id": id, "operation": output], 0)
        }
        guard let pageID = pageID(entry, value) else { throw FountainRecoveryError.access }
        let nativeLocal = try readablePage(entry, value: value, responses: responses, other: other)
        var draft: [String: Any]
        if entry.bucket == "drafts", let source = value["draft"] as? [String: Any] {
            draft = source.filter { ["epoch", "seq", "blocks", "ops", "reason", "createdAt", "history_pending"].contains($0.key) }
        } else if entry.bucket == "snapshots", let snapshot = value["snapshot"] as? [String: Any], let blocks = snapshot["blocks"] as? [[String: Any]] { draft = ["blocks": blocks, "reason": "native_recovery"] }
        else if entry.bucket == "operations", let operation = value["operation"] as? [String: Any] { draft = ["ops": [operation], "reason": "native_unresolved_operations"] }
        else { throw FountainRecoveryError.access }
        for field in ["epoch", "reason"] {
            if let supplied = draft[field] { guard let text = supplied as? String, text.unicodeScalars.count <= 1000 else { throw FountainRecoveryError.access }; draft[field] = text }
        }
        if let seq = draft["seq"], safeInteger(seq) == nil { throw FountainRecoveryError.access }
        if let pending = draft["history_pending"], boolean(pending) == nil { throw FountainRecoveryError.access }
        if let date = draft["createdAt"] {
            if let text = date as? String { guard text.unicodeScalars.count <= 1000 else { throw FountainRecoveryError.access } }
            else { guard let number = date as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw FountainRecoveryError.access } }
        }
        if let supplied = draft["ops"] { draft["ops"] = try operations(supplied) }
        if let supplied = draft["blocks"] { draft["blocks"] = try self.blocks(supplied) }
        for operation in draft["ops"] as? [[String: Any]] ?? [] where operation["type"] as? String == "block.set" && operation["field"] as? String == "attachment_id" {
            if let id = operation["value"] as? String {
                let metadata = try authorized("/api/attachments/" + FountainOutbox.encodeURIComponent(id) + "/metadata", responses: responses, other: other)
                guard metadata["id"] as? String == id, metadata["status"] as? String == "complete" else { throw FountainRecoveryError.access }
            }
        }
        if let blocks = draft["blocks"] as? [[String: Any]], !blocks.isEmpty {
            for block in blocks {
                if let id = block["attachment_id"] as? String {
                    let metadata = try authorized("/api/attachments/" + FountainOutbox.encodeURIComponent(id) + "/metadata", responses: responses, other: other)
                    guard metadata["id"] as? String == id, metadata["status"] as? String == "complete" else { throw FountainRecoveryError.access }
                }
            }
            if nativeLocal { return ("readable", ["page_id": pageID, "draft": draft], blocks.count) }
            if !importable(blocks) || (draft["ops"] as? [Any])?.isEmpty == false { return ("readable", draft, blocks.count) }
            return ("drafts", ["page_id": pageID, "draft": draft], blocks.count)
        }
        if nativeLocal, let blocks = draft["blocks"] as? [[String: Any]], blocks.isEmpty { return ("readable", ["page_id": pageID, "draft": draft], 0) }
        guard let ops = draft["ops"] as? [[String: Any]], !ops.isEmpty else { throw FountainRecoveryError.access }
        if nativeLocal { return ("readable", ["page_id": pageID, "draft": draft], 0) }
        if ops.count > 1000 { return ("readable", ["ops": ops], 0) }
        return ("drafts", ["page_id": pageID, "draft": ["ops": ops, "reason": "native_unresolved_operations"]], 0)
    }
    private func readablePageFields(_ body: [String: Any]) throws -> [String: Any] {
        var output: [String: Any] = [:]
        for (field, limit) in [("id", 160), ("title", 500), ("icon", 10000), ("cover", 10000), ("parent_id", 160), ("teamspace_id", 1000)] {
            guard let value = body[field] else { continue }
            if value is NSNull, ["parent_id", "teamspace_id", "cover"].contains(field) { output[field] = NSNull(); continue }
            guard let text = value as? String, text.unicodeScalars.count <= limit, !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  !["id", "parent_id"].contains(field) || identifier(text) else { throw FountainRecoveryError.access }
            output[field] = text
        }
        if let value = body["favorite"] { guard boolean(value) != nil else { throw FountainRecoveryError.access }; output["favorite"] = value }
        return output
    }
    private func operationDependencies(_ operation: [String: Any]) throws -> [String] {
        if let supplied = operation["depends_on"], !(supplied is [String]) { throw FountainRecoveryError.access }
        var dependencies = operation["depends_on"] as? [String] ?? []
        for value in (operation["base_rows"] as? [String: [String: Any]] ?? [:]).values {
            if let supplied = value["after_operation"] { guard let id = supplied as? String else { throw FountainRecoveryError.access }; dependencies.append(id) }
        }
        var seen = Set<String>()
        return dependencies.filter { seen.insert($0).inserted }.sorted()
    }

    private struct Piece {
        let entry: Entry, section: String, url: URL, bytes: Int, blocks: Int, nodes: Int, operationID: String?, dependencies: [String]
    }
    private func write(_ data: Data, to file: URL) throws {
        let handle = try FileHandle(forWritingTo: file)
        do {
            var offset = 0
            while offset < data.count { let end = min(offset + 256 * 1024, data.count); try handle.write(contentsOf: data.subdata(in: offset..<end)); offset = end }
            try handle.synchronize(); try handle.close()
        } catch { try? handle.close(); throw error }
    }
    private func append(_ file: URL, to handle: FileHandle) throws {
        let input = try FileHandle(forReadingFrom: file); defer { try? input.close() }
        while let bytes = try input.read(upToCount: 256 * 1024), !bytes.isEmpty { try handle.write(contentsOf: bytes) }
    }
    private func fileDigest(_ file: URL) throws -> String {
        try Self.privateItem(file, directory: false)
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw FountainRecoveryError.storage }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? input.close() }
        var digest = SHA256(), count = 0
        while let bytes = try input.read(upToCount: 256 * 1024), !bytes.isEmpty {
            count += bytes.count; guard count <= limit else { throw FountainRecoveryError.storage }; digest.update(data: bytes)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    func prepare(_ handles: [String], other: Authority, responses: Responses, observedAt: Double, makeFile: (String) throws -> URL) throws -> [String: Any] {
        try current(other); cancelPrepared()
        guard responses.values.reduce(0, { $0 + $1.1.count }) <= 64 * 1024 * 1024 else { throw FountainRecoveryError.access }
        try permissionFloors(responses, other: other)
        try exportPolicy(authorized("/api/workspace", responses: responses, other: other))
        let chosen = try selected(handles, other)
        var ids = Set<String>()
        for entry in chosen where entry.category == "typed" && !entry.digest.isEmpty {
            guard let value = try checkedValue(entry) else { continue }
            if let id = (value["operation"] as? [String: Any])?["id"] as? String { ids.insert(id) }
        }
        var pieces: [Piece] = [], temporary: [URL] = [], outputs: [URL] = [], keep = false, blocked = 0, intermediateBytes = 0
        defer {
            for url in temporary { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
            if !keep { for url in outputs { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) } }
        }
        for entry in chosen {
            if entry.digest.isEmpty { blocked += 1; continue }
            guard let value = try checkedValue(entry) else { blocked += 1; continue }
            do {
                let (section, output, blocks) = try projection(entry, value: value, responses: responses, other: other, selectedIDs: ids)
                var nodes = 0
                if section != "readable" { try bounded(output, nodes: &nodes) }
                let data = try json(output)
                guard intermediateBytes <= 64 * 1024 * 1024 - data.count else { throw FountainRecoveryError.access }
                intermediateBytes += data.count
                let file = try makeFile("recovery-part.json")
                temporary.append(file); try write(data, to: file)
                let operation = section == "records" ? output["operation"] as? [String: Any] : nil
                pieces.append(Piece(entry: entry, section: section, url: file, bytes: data.count, blocks: blocks, nodes: nodes, operationID: operation?["id"] as? String, dependencies: operation?["depends_on"] as? [String] ?? []))
            } catch FountainRecoveryError.access { blocked += 1 }
        }
        // A blocked/absent prerequisite must never become a partial executable graph.
        var changed = true
        while changed {
            changed = false
            var valid: [String: String] = [:], duplicates = Set<String>()
            for piece in pieces { if let id = piece.operationID { if valid[id] != nil { duplicates.insert(id) }; valid[id] = piece.entry.profile } }
            pieces = pieces.filter { piece in
                if let id = piece.operationID, duplicates.contains(id) { blocked += 1; changed = true; return false }
                if piece.dependencies.contains(where: { valid[$0] != piece.entry.profile }) { blocked += 1; changed = true; return false }
                return true
            }
        }
        var completed = Set<String>()
        while true {
            let before = completed.count
            for piece in pieces where piece.operationID != nil && piece.dependencies.allSatisfy({ completed.contains($0) }) { completed.insert(piece.operationID!) }
            if completed.count == before { break }
        }
        pieces = pieces.filter { piece in if let id = piece.operationID, !completed.contains(id) { blocked += 1; return false }; return true }
        var total = 0, readable = false, formats: [String: String] = [:]
        for profile in Set(pieces.map { $0.entry.profile }).sorted() {
            let group = pieces.filter { $0.entry.profile == profile }.sorted { left, right in
                left.entry.recovery == right.entry.recovery ? left.entry.row < right.entry.row : !left.entry.recovery
            }, parts = profile.components(separatedBy: "|")
            let binding = parts[3].removingPercentEncoding!
            let header: [String: Any] = ["format": "fountain-recovery-v2", "origin": other.origin, "workspace_id": other.workspace,
                "member_id": other.member, "source_binding": binding, "records": [], "localPages": [], "drafts": []]
            var prefix = try json(header); prefix.removeLast()
            // Streaming fields avoid constructing a whole selected cache/graph in memory.
            let size = group.reduce(prefix.count + 100, { $0 + $1.bytes + 1 })
            let normal = size <= limit && group.reduce(0, { $0 + $1.blocks }) <= 2000 && group.reduce(0, { $0 + $1.nodes }) <= 149900 && !group.contains(where: { $0.section == "readable" })
            if normal {
                var base = header; base.removeValue(forKey: "records"); base.removeValue(forKey: "drafts")
                var start = try json(base); start.removeLast()
                guard outputs.count < 1000 else { throw FountainRecoveryError.access }
                let file = try makeFile(String(format: "fountain-recovery-%02d.json", outputs.count + 1)); outputs.append(file)
                formats[file.path] = "fountain-recovery-v2"
                let handle = try FileHandle(forWritingTo: file)
                do {
                    try handle.write(contentsOf: start)
                    for (index, section) in ["records", "drafts"].enumerated() {
                        try handle.write(contentsOf: Data((",\"" + section + "\":[").utf8))
                        for (position, piece) in group.filter({ $0.section == section }).enumerated() { if position > 0 { try handle.write(contentsOf: Data(",".utf8)) }; try append(piece.url, to: handle) }
                        try handle.write(contentsOf: Data("]".utf8)); if index == 1 { try handle.write(contentsOf: Data("}".utf8)) }
                    }
                    try handle.synchronize(); try handle.close()
                } catch { try? handle.close(); throw error }
                let actual = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? limit + 1
                guard actual <= limit, total <= 64 * 1024 * 1024 - actual else { throw FountainRecoveryError.access }; total += actual
            } else {
                readable = true
                for (part, piece) in group.enumerated() {
                    let bytes = try Data(contentsOf: piece.url), digest = FountainOutbox.hash(bytes)
                    var offset = 0, fragment = 0
                    while offset < bytes.count {
                        var end = min(offset + 512 * 1024, bytes.count)
                        while end > offset && String(data: bytes.subdata(in: offset..<end), encoding: .utf8) == nil { end -= 1 }
                        guard end > offset, let text = String(data: bytes.subdata(in: offset..<end), encoding: .utf8) else { throw FountainRecoveryError.storage }
                        var blocks: [[String: Any]] = [], rest = text.unicodeScalars[...], index = 0
                        while !rest.isEmpty { let tail = rest.index(rest.startIndex, offsetBy: min(50000, rest.count)); blocks.append(["id": "native-part-\(index)", "type": "code", "language": "json", "text": String(String.UnicodeScalarView(rest[..<tail]))]); rest = rest[tail...]; index += 1 }
                        blocks.insert(["id": "native-context", "type": "paragraph", "text": "원문 JSON 수동 복구 · 항목 \(part + 1)/\(group.count), 조각 \(fragment + 1), UTF-8 \(offset)..<\(end), SHA-256 \(digest). 순서대로 원문을 보관하세요. 자동 변경 실행이 아닙니다."], at: 0)
                        let data = try json(["blocks": blocks])
                        guard outputs.count < 1000, data.count <= limit, total <= 64 * 1024 * 1024 - data.count else { throw FountainRecoveryError.access }
                        let file = try makeFile(String(format: "fountain-readable-%02d.json", outputs.count + 1))
                        outputs.append(file); try write(data, to: file); total += data.count; offset = end; fragment += 1
                        formats[file.path] = "readable-body"
                    }
                }
            }
        }
        try current(other)
        let deadline = min(min(other.deadline, sessionDeadline), observedAt + 120_000)
        guard deadline > Date().timeIntervalSince1970 * 1000 else { throw FountainRecoveryError.stale }
        let exportToken = UUID().uuidString
        var floorAccess = 0, floorData = 0
        for response in responses.values {
            if let body = (try? JSONSerialization.jsonObject(with: response.1)) as? [String: Any], other.envelope(body) {
                floorAccess = max(floorAccess, safeInteger(body["access_revision"]) ?? 0)
                floorData = max(floorData, safeInteger(body["data_revision"]) ?? 0)
            }
        }
        var outputDigests: [String: String] = [:]
        for file in outputs { outputDigests[file.path] = try fileDigest(file) }
        let result = Prepared(token: exportToken, handles: handles.sorted(), digests: Dictionary(uniqueKeysWithValues: chosen.map { ($0.handle, $0.digest) }), authority: other,
            urls: outputs, paths: ["/api/workspace"] + responses.keys.filter { $0 != "/api/workspace" }.sorted(), authorityDigests: try authorityDigests(responses), deadline: deadline,
            floorAccess: floorAccess, floorData: floorData, outputDigests: outputDigests)
        let files: [[String: Any]] = try outputs.map { url in
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            return ["name": url.lastPathComponent, "byteLength": (attributes[.size] as? NSNumber)?.intValue ?? 0, "format": formats[url.path] ?? "readable-body"]
        }
        prepared = result; workspaceExportAllowed = true; keep = true
        return ["exportToken": exportToken, "readyCount": pieces.count, "blockedCount": blocked,
            "files": files,
            "warnings": ["원본은 기기에 그대로 남습니다. 새 파일은 가져오기 미리보기에서 다시 확인해야 합니다."] + (readable ? ["큰 자료는 순서가 표시된 원문 JSON 조각으로 보관합니다. 직접 내용을 확인하고 나누어 복구하세요."] : []) + (blocked > 0 ? ["확인되지 않은 항목은 파일에 포함하지 않았습니다. 권한을 확인하거나 자료를 나누어 선택해 주세요."] : [])]
    }
    func preparedPaths(_ exportToken: String, handles: [String], other: Authority) throws -> [String] {
        try current(other)
        guard let prepared = prepared, prepared.token == exportToken, prepared.handles == handles.sorted(), prepared.authority.matches(other), prepared.deadline > Date().timeIntervalSince1970 * 1000 else { throw FountainRecoveryError.stale }
        _ = try selected(handles, other)
        for entry in try selected(handles, other) where !entry.digest.isEmpty {
            guard prepared.digests[entry.handle] == entry.digest else { throw FountainRecoveryError.stale }
            _ = try sourceData(entry)
        }
        try current(other)
        return prepared.paths
    }
    func saveFiles(_ exportToken: String, handles: [String], other: Authority, responses: Responses) throws -> [URL] {
        _ = try preparedPaths(exportToken, handles: handles, other: other)
        do { try permissionFloors(responses, other: other); try exportPolicy(authorized("/api/workspace", responses: responses, other: other)) }
        catch { cancelPrepared(); throw error }
        guard let prepared = prepared, try authorityDigests(responses) == prepared.authorityDigests else { cancelPrepared(); throw FountainRecoveryError.stale }
        for file in prepared.urls { guard try fileDigest(file) == prepared.outputDigests[file.path] else { cancelPrepared(); throw FountainRecoveryError.storage } }
        try current(other)
        return prepared.urls
    }
    func validSave(_ exportToken: String, other: Authority) -> Bool {
        guard workspaceExportAllowed, let prepared = prepared, prepared.token == exportToken, prepared.authority.matches(other), prepared.deadline > Date().timeIntervalSince1970 * 1000 else { return false }
        return validContext(other)
    }
    func noteCanonical(path: String, status: Int, data: Data) {
        guard let prepared = prepared else { return }
        if path == "/api/workspace", status == 200 {
            guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], authority.envelope(body), (try? exportPolicy(body)) != nil else { cancelPrepared(); return }
        }
        if status == 403 || status == 404 { cancelPrepared(); return }
        if let old = prepared.authorityDigests[path], (try? authorityDigest(path, status: status, data: data)) != old { cancelPrepared(); return }
        if status == 200, let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], authority.envelope(body),
           let access = safeInteger(body["access_revision"]), let revision = safeInteger(body["data_revision"]) {
            // A known newer canonical observation anywhere may change row scope.
            if access > prepared.floorAccess || revision > prepared.floorData { cancelPrepared() }
        }
    }
    func observes(_ path: String) -> Bool {
        if FountainOutbox.canonicalResource(path: path, method: "GET") != nil { return true }
        return !path.contains("?") && !path.contains("#") && path.hasPrefix("/api/attachments/") && path.hasSuffix("/metadata") && prepared?.authorityDigests[path] != nil
    }
}
