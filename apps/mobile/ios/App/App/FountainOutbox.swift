// Native-only SQLite foundation. Call exclusively on FountainNative's serial
// executor while holding its bridge-owner lock. No SQL or credential is bridged.
import Foundation
import SQLite3
import CryptoKit
import Darwin

enum FountainOutboxError: Error, Equatable {
    case invalid, limit, stale, head, conflict, blocked, storage, access, retry, confirmation
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
        case .retry: return "OUTBOX_RECONCILE_RETRY"
        case .confirmation: return "OUTBOX_CONFIRMATION_REQUIRED"
        }
    }
    var message: String { "Native outbox could not confirm this operation" }
}

extension FountainOutbox {
    // Tokens are constructed only at native request admission. Their private
    // nonce, scope and watermark never come from, or return to, JavaScript.
    struct ReconcileAdmission { fileprivate let plan: String, sweep: Int, key: String, nonce: String }
    struct HTTPAdmission {
        fileprivate let profile: String, reference: String, owner: String, lease: String
        fileprivate let auth: Int, deadline: Double
        fileprivate let authority: String, authoritative: Bool
    }
    func captureHTTPDelivery(sessionRef: String?, allowBlockedMetadata: Bool = false) throws -> HTTPAdmission? {
        let value = try identity(), reference = sessionRef ?? "local-no-cookie"
        guard value["state"] as? String == "verified" || allowBlockedMetadata && value["permissionBlocked"] as? Bool == true,
              let profile = value["profileId"] as? String, value["sessionRef"] as? String == reference,
              let deadline = value["validUntil"] as? Double, deadline > Date().timeIntervalSince1970 * 1000,
              let owner, let auth = authEpoch, let lease else { return nil }
        return HTTPAdmission(profile: profile, reference: reference, owner: owner, lease: lease, auth: auth, deadline: deadline, authority: authorityBoundary, authoritative: true)
    }
    func admitHTTP(path: String, sessionRef: String?) throws -> HTTPAdmission? {
        guard path != "/api/session" else { return nil }
        if let captured = try captureHTTPDelivery(sessionRef: sessionRef) { return captured }
        let value = try identity()
        guard value["profileId"] == nil else { throw FountainOutboxError.blocked }
        return HTTPAdmission(profile: "", reference: sessionRef ?? "local-no-cookie", owner: "", lease: "", auth: -1, deadline: Date().timeIntervalSince1970 * 1000 + 120000, authority: authorityBoundary, authoritative: false)
    }
    func permitsHTTPObservation(_ admission: HTTPAdmission?) -> Bool { admission?.authoritative == true }
    func checkHTTPAdmission(_ admission: HTTPAdmission, sessionRef: String?) throws {
        guard canDeliverHTTP(admission), admission.reference == (sessionRef ?? "local-no-cookie") else { throw FountainOutboxError.stale }
        if !admission.authoritative { return }
        guard try verifiedProfile() == admission.profile, try identity()["sessionRef"] as? String == admission.reference,
              admission.reference == (sessionRef ?? "local-no-cookie"), canDeliverHTTP(admission) else { throw FountainOutboxError.stale }
        try checkLease(admission.lease)
    }
    // Memory-only check for the final main-thread WebView submission. Native
    // mutations/role renewal rotate the lease; no SQLite runs on the UI thread.
    func canDeliverHTTP(_ admission: HTTPAdmission) -> Bool {
        guard authorityBoundary == admission.authority, admission.deadline > Date().timeIntervalSince1970 * 1000 else { return false }
        return !admission.authoritative || owner == admission.owner && authEpoch == admission.auth && lease == admission.lease
    }
    struct HTTPDeliveryFence {
        fileprivate let admission: HTTPAdmission, resource: String?, version: String?, denial: String, accessFloor: Int
    }
    private func rotateHTTPAuthority() {
        // Scope floors are monotonic only within one private authority. Never
        // let a previous actor's larger counter mask this scope's next advance.
        authorityBoundary = UUID().uuidString
        httpDeliveryAccess = 0; httpDeliveryResources.removeAll(); httpDeliveryDenial = UUID().uuidString
    }
    private func noteHTTPProof(_ key: String, access: Int? = nil, denied: Bool = false) {
        if let access { httpDeliveryAccess = max(httpDeliveryAccess, access) }
        httpDeliveryResources[key] = UUID().uuidString
        if denied { httpDeliveryDenial = UUID().uuidString }
    }
    func captureHTTPFence(_ admission: HTTPAdmission, path: String, method: String, status: Int) throws -> HTTPDeliveryFence {
        let resource = Self.observedResource(path: path, method: method, status: status) ?? Self.collectorResource(path: path, method: method)
        let key = resource.map { proofKey($0.0, $0.1) }
        if let key, admission.authoritative {
            httpDeliveryAccess = max(httpDeliveryAccess, try floor(admission.profile)["access"] ?? 0)
            if httpDeliveryResources[key] == nil { httpDeliveryResources[key] = UUID().uuidString }
        }
        return HTTPDeliveryFence(admission: admission, resource: key, version: key.flatMap { httpDeliveryResources[$0] }, denial: httpDeliveryDenial, accessFloor: httpDeliveryAccess)
    }
    func canDeliverHTTP(_ fence: HTTPDeliveryFence) -> Bool {
        guard canDeliverHTTP(fence.admission) else { return false }
        guard let resource = fence.resource else { return true }
        return fence.denial == httpDeliveryDenial && fence.accessFloor == httpDeliveryAccess && fence.version == httpDeliveryResources[resource]
    }
    struct SyncAdmission {
        fileprivate let profile: String, reference: String, owner: String, auth: Int, lease: String, operations: [[String: Any]]
    }
    func admitSync(path: String, method: String, body: Data, sessionRef: String?) throws -> SyncAdmission? {
        guard path == "/api/sync", method == "POST" else { return nil }
        guard try identity()["offline"] as? Bool != true, try identity()["needsFloor"] as? Bool != true else { throw FountainOutboxError.access }
        let profile = try verifiedProfile(), parts = try profileParts(profile), identity = try self.identity()
        guard try control("accountNeedsReconcile:" + profile) == nil else { throw FountainOutboxError.access }
        guard body.count <= recordLimit, identity["sessionRef"] as? String == (sessionRef ?? "local-no-cookie"), let owner = owner, let auth = authEpoch, let lease = lease,
              let request = try decode(body) as? [String: Any], Set(request.keys) == Set(["workspace_id", "session_binding", "operations"]),
              request["workspace_id"] as? String == parts[1].removingPercentEncoding, request["session_binding"] as? String == parts[3].removingPercentEncoding,
              let operations = request["operations"] as? [[String: Any]], operations.count <= 50 else { throw FountainOutboxError.access }
        for operation in operations {
            _ = try text(operation["id"], limit: 160); _ = try text(operation["target_id"], limit: 640)
            guard ["page.create", "page.patch", "row.create", "row.patch", "row.delete"].contains(operation["kind"] as? String ?? "") else { throw FountainOutboxError.invalid }
            if operation["kind"] as? String == "page.create" { _ = try text(operation["document_epoch"], limit: 1000) }
        }
        return SyncAdmission(profile: profile, reference: identity["sessionRef"] as! String, owner: owner, auth: auth, lease: lease, operations: operations)
    }
    func observeSync(_ admission: SyncAdmission?, status: Int, data: Data, sessionRef: String?) throws {
        guard status == 200, let admission = admission else { return }
        let profile = try verifiedProfile(), parts = try profileParts(profile)
        guard profile == admission.profile, owner == admission.owner, authEpoch == admission.auth, lease == admission.lease,
              try identity()["sessionRef"] as? String == admission.reference, admission.reference == (sessionRef ?? "local-no-cookie"), data.count <= recordLimit,
              let body = try decode(data) as? [String: Any], Set(body.keys) == Set(["workspace_id", "current_member_id", "session_binding", "data_revision", "results"]),
              body["workspace_id"] as? String == parts[1].removingPercentEncoding, body["current_member_id"] as? String == parts[2].removingPercentEncoding,
              body["session_binding"] as? String == parts[3].removingPercentEncoding, let results = body["results"] as? [[String: Any]], results.count == admission.operations.count else { throw FountainOutboxError.access }
        _ = try checkedInteger(body["data_revision"])
        var accepted: [(String, [String: Any])] = []
        for (index, result) in results.enumerated() {
            let operation = admission.operations[index], id = operation["id"] as! String
            guard result["id"] as? String == id, let status = result["status"] as? String else { throw FountainOutboxError.invalid }
            if status != "applied" {
                guard ["conflict", "denied", "deferred", "invalid"].contains(status), let code = result["http_status"] as? NSNumber, CFGetTypeID(code) != CFBooleanGetTypeID(), (400...599).contains(code.intValue) else { throw FountainOutboxError.invalid }
                continue
            }
            let kind = operation["kind"] as! String
            guard Set(result.keys).isSubset(of: ["id", "status", "http_status", "resource_id", "data_revision", "updated_at", "revision"]),
                  try checkedInteger(result["http_status"]) == (kind.hasSuffix("create") ? 201 : 200), result["resource_id"] as? String == operation["target_id"] as? String else { throw FountainOutboxError.invalid }
            _ = try checkedInteger(result["data_revision"])
            if let revision = result["revision"] { _ = try checkedInteger(revision) }
            if let timestamp = result["updated_at"] { _ = try text(timestamp, limit: 1000) }
            let marker: [String: Any] = ["profile": profile, "sessionRef": admission.reference, "actor": parts.prefix(3).joined(separator: "|"), "id": id, "kind": kind, "target": operation["target_id"]!, "database_id": operation["database_id"] ?? NSNull(), "document_epoch": operation["document_epoch"] ?? NSNull(), "operationDigest": Self.hash(try json(operation)), "result": result]
            accepted.append(("syncReceipt:" + profile + ":" + id, marker))
        }
        let observed = try transaction { () throws -> Bool in
            var observed = false
            for (key, marker) in accepted {
                if let previous = try self.control(key) { guard try self.json(previous) == self.json(marker) else { throw FountainOutboxError.conflict } }
                else { try self.setControl(key, marker) }
                if (marker["kind"] as? String)?.hasPrefix("page.") == true, let target = marker["target"] as? String { observed = try self.markServerObserved(profile, page: target) || observed }
            }
            if observed { try self.advanceProof() }
            return observed
        }
        if observed { readDeadline = nil; boundary = UUID().uuidString }
    }
    private func appliedSyncOperation(_ operation: [String: Any], profile: String) throws -> [String: Any]? {
        guard let id = operation["id"] as? String, let marker = try control("syncReceipt:" + profile + ":" + id) as? [String: Any],
              marker["profile"] as? String == profile, marker["sessionRef"] as? String == (try identity()["sessionRef"] as? String), marker["operationDigest"] as? String == Self.hash(try json(operation)),
              marker["target"] as? String == operation["target_id"] as? String, marker["kind"] as? String == operation["kind"] as? String,
              let result = marker["result"] as? [String: Any], result["status"] as? String == "applied" else { return nil }
        return result
    }
    private func creationMarker(_ id: String, target: String, epoch: String, profile: String) throws -> [String: Any]? {
        guard let marker = try control("syncReceipt:" + profile + ":" + id) as? [String: Any], marker["profile"] as? String == profile, marker["kind"] as? String == "page.create", marker["id"] as? String == id,
              marker["sessionRef"] as? String == (try identity()["sessionRef"] as? String),
              marker["target"] as? String == target, marker["document_epoch"] as? String == epoch,
              let result = marker["result"] as? [String: Any], result["status"] as? String == "applied" else { return nil }
        return result
    }
    private final class ReconciliationPlan {
        let id = UUID().uuidString.lowercased(), directory: URL, profile: String, lease: String, owner: String, auth: Int, sessionRef: String
        let mode: String, watermark: Int
        var expiresAt: Double
        var head: Int, proof: Int, source: String, sweep = 1, expanded = false
        var required: [String: [String: String]] = ["workspace:workspace": ["kind": "workspace", "id": "workspace"]]
        var admissions: [String: String] = [:], captures: [String: (Int, URL, String)] = [:]
        var totalBytes = 0, ready: [String: Any]?, changes: [Change] = [], preserve: [Change] = []
        var selected: [ArchiveHandle] = []
        var manifest: (URL, String)?
        init(directory: URL, profile: String, lease: String, owner: String, auth: Int, sessionRef: String, mode: String, expiresAt: Double, watermark: Int, head: Int, proof: Int, source: String) {
            self.directory = directory; self.profile = profile; self.lease = lease; self.owner = owner; self.auth = auth; self.sessionRef = sessionRef
            self.mode = mode; self.expiresAt = expiresAt; self.watermark = watermark; self.head = head; self.proof = proof; self.source = source
        }
    }
    private struct ArchiveHandle {
        let handle: String, profile: String, kind: String, rows: [Int], digest: String, expiresAt: Double, owner: String, auth: Int, lease: String
    }
    private func archiveData(_ rowsToRead: [Int], profile: String) throws -> [(String, Any, [String: Any], Data)] {
        var result: [(String, Any, [String: Any], Data)] = [], total = 0
        for row in rowsToRead {
            guard let header = try rows("SELECT bucket,key,profile_id,length(value) FROM recovery WHERE rowid=?", [row]).first,
                  let bucket = header[0] as? String, let encoded = header[1] as? String, header[2] as? String == profile,
                  let size = header[3] as? Int, size > 0, size <= recordLimit, size <= transactionLimit - total,
                  let bytes = try rows("SELECT value FROM recovery WHERE rowid=?", [row]).first?.first as? Data, bytes.count == size,
                  var value = try decode(bytes) as? [String: Any] else { throw FountainOutboxError.access }
            guard let attribution = try control("archiveAuthority:" + String(row)) as? [String: Any], attribution["actor"] as? String == profile.components(separatedBy: "|").prefix(3).joined(separator: "|"),
                  attribution["profile"] as? String == profile, attribution["digest"] as? String == Self.hash(bytes), ["confirmed", "upgrade"].contains(attribution["trust"] as? String ?? "") else { throw FountainOutboxError.access }
            total += size; let key = try decode(Data(encoded.utf8))
            if value["op"] != nil {
                guard value["op"] as? String == "put", value["bucket"] as? String == bucket,
                      try json(value["key"] ?? NSNull()) == json(key), let inner = value["value"] as? [String: Any] else { throw FountainOutboxError.access }
                value = inner
            }
            guard value["profileId"] as? String == profile else { throw FountainOutboxError.access }
            _ = try change(["op": "put", "bucket": bucket, "key": key, "value": value])
            result.append((bucket, key, value, bytes))
        }
        return result
    }
    private func archiveDigest(_ selected: [Int], profile: String) throws -> String {
        var hash = SHA256()
        for (bucket, key, _, bytes) in try archiveData(selected, profile: profile) {
            hash.update(data: try json([bucket, key, bytes.count])); hash.update(data: bytes)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func reconciliationHandles(_ profile: String) throws -> [[String: Any]] {
        guard let owner = owner, let auth = authEpoch, let lease = lease else { return [] }
        let now = Date().timeIntervalSince1970 * 1000, expiry = min(try identity()["validUntil"] as? Double ?? 0, now + 120000).rounded(.down)
        reconciliationArchives = reconciliationArchives.filter { $0.value.expiresAt > now && $0.value.owner == owner && $0.value.auth == auth && $0.value.lease == lease }
        let prefix = (try profileParts(profile)).prefix(3).joined(separator: "|") + "|"
        var groups: [String: [Int]] = [:], inputCounts: [String: Int] = [:]
        let headers = try rows("SELECT rowid,profile_id,bucket FROM recovery WHERE substr(profile_id,1,length(?))=? AND bucket IN ('mutations','drafts','operations','localPages','snapshots') ORDER BY rowid LIMIT 100001", [prefix, prefix])
        guard headers.count <= 100000 else { throw FountainOutboxError.limit }
        for row in headers {
            guard let id = row[0] as? Int, let source = row[1] as? String, source.hasPrefix(prefix) else { throw FountainOutboxError.storage }
            groups[source, default: []].append(id)
            if row[2] as? String != "snapshots" { inputCounts[source, default: 0] += 1 }
        }
        guard groups.count <= 100 else { throw FountainOutboxError.limit }
        var output: [[String: Any]] = []
        for source in groups.keys.sorted() {
            guard inputCounts[source, default: 0] > 0 else { continue }
            guard let selected = groups[source], selected.count <= 100000 else { throw FountainOutboxError.limit }
            let digest: String
            do { digest = try archiveDigest(selected, profile: source) }
            catch FountainOutboxError.access { continue }
            catch FountainOutboxError.invalid { continue }
            let existing = reconciliationArchives.values.first { $0.profile == source && $0.digest == digest }
            if try control("promotedArchive:" + profile + ":" + digest) != nil { continue }
            let trusts = try selected.map { try control("archiveAuthority:" + String($0)) as? [String: Any] }
            let kind = trusts.allSatisfy { $0?["trust"] as? String == "confirmed" } ? "recovery" : "upgrade"
            let descriptor = existing ?? ArchiveHandle(handle: UUID().uuidString.lowercased(), profile: source, kind: kind, rows: selected, digest: digest, expiresAt: expiry, owner: owner, auth: auth, lease: lease)
            reconciliationArchives[descriptor.handle] = descriptor
            output.append(["handle": descriptor.handle, "kind": descriptor.kind, "count": inputCounts[source, default: 0], "expiresAt": descriptor.expiresAt])
        }
        return output
    }
    private func cancelReconciliation() {
        if let plan = reconciliation { try? FileManager.default.removeItem(at: plan.directory) }
        reconciliation = nil
    }
    func matchesReconciliationAuthority(workspace: String, member: String, binding: String, reference: String) throws -> Bool {
        let profile = try verifiedProfile(), parts = try profileParts(profile), observedReference = try identity()["sessionRef"] as? String
        return parts[1].removingPercentEncoding == workspace && parts[2].removingPercentEncoding == member && parts[3].removingPercentEncoding == binding && observedReference == reference
    }
    private func attributeRecord(_ item: Change, profile: String) throws {
        guard let bytes = item.payload, item.profile == profile else { throw FountainOutboxError.access }
        let actor = (try profileParts(profile)).prefix(3).joined(separator: "|")
        var attribution: [String: Any] = ["actor": actor, "profile": profile, "digest": Self.hash(bytes), "trust": "confirmed"]
        if let resource = item.resource, resource.components(separatedBy: "|").count == 5,
           let context = try control("nativeLocal:" + resource) as? [String: Any], context["profile"] as? String == profile,
           context["actor"] as? String == actor, let target = context["page"] as? String,
           try control(serverObservedKey(profile, page: target)) == nil { attribution["nativeLocal"] = context }
        try setControl("recordAuthority:" + item.bucket + "|" + item.encodedKey, attribution)
    }
    private func serverObservedKey(_ profile: String, page: String) throws -> String {
        "serverObserved:" + (try profileParts(profile))[1] + "|" + Self.encodeURIComponent(page)
    }
    @discardableResult private func markServerObserved(_ profile: String, page: String) throws -> Bool {
        let key = try serverObservedKey(profile, page: page)
        if try control(key) == nil { try setControl(key, true); return true }
        return false
    }
    private func markServerProjection(_ profile: String, kind: String, page: String, proof: [String: Any]) throws -> Bool {
        var changed = false
        if kind == "page" { return try markServerObserved(profile, page: page) }
        if kind == "workspace" {
            for page in (proof["pages"] as? [String: [String: Any]] ?? [:]).keys { changed = try markServerObserved(profile, page: page) || changed }
        }
        return changed
    }
    // A native-only negative-observation capability. It cannot grant a profile,
    // read body, edit right or renew even a permanently blocked binding.
    struct RecoveryObservation {
        fileprivate let profile: String, reference: String, boundary: String, deadline: Double
    }
    func admitRecoveryObservation(_ authority: FountainRecovery.Authority, sessionRef: String?) throws -> RecoveryObservation {
        let reference = sessionRef ?? "local-no-cookie", now = Date().timeIntervalSince1970 * 1000
        let profile = origin + "|" + [authority.workspace, authority.member, authority.binding].map(Self.encodeURIComponent).joined(separator: "|")
        let current = try identity()
        guard authority.origin == origin, authority.reference == reference, authority.deadline > now,
              current["profileId"] as? String == profile, current["sessionRef"] as? String == reference,
              ["verified", "blocked"].contains(current["state"] as? String ?? ""), try control("known:" + profile) != nil else { throw FountainOutboxError.access }
        _ = try profileParts(profile)
        return RecoveryObservation(profile: profile, reference: reference, boundary: boundary, deadline: min(authority.deadline, now + 120000))
    }
    private func checkRecoveryObservation(_ admission: RecoveryObservation, sessionRef: String?) throws {
        let current = try identity()
        guard admission.boundary == boundary, admission.deadline > Date().timeIntervalSince1970 * 1000,
              admission.reference == (sessionRef ?? "local-no-cookie"), current["sessionRef"] as? String == admission.reference,
              current["profileId"] as? String == admission.profile, ["verified", "blocked"].contains(current["state"] as? String ?? "") else { throw FountainOutboxError.stale }
    }
    // The actual Recovery GET pipeline can only add a permanent restriction.
    // Its private caller closes the read snapshot before any SQLite mutation.
    @discardableResult func observeRecoveryServerPage(admission: RecoveryObservation, path: String, status: Int, data: Data, sessionRef: String?, beforeMutation: () -> Void) throws -> Bool {
        guard status == 200, let (kind, page) = Self.canonicalResource(path: path, method: "GET"), ["page", "workspace"].contains(kind) else { return false }
        try checkRecoveryObservation(admission, sessionRef: sessionRef)
        let profile = admission.profile, parts = try profileParts(profile), currentFloor = try floor(profile)
        guard data.count <= recordLimit, let body = try decode(data) as? [String: Any], body["workspace_id"] as? String == parts[1].removingPercentEncoding,
              body["current_member_id"] as? String == parts[2].removingPercentEncoding, body["session_binding"] as? String == parts[3].removingPercentEncoding else { throw FountainOutboxError.access }
        guard try checkedInteger(body["access_revision"]) >= currentFloor["access", default: 0],
              try checkedInteger(body["data_revision"]) >= currentFloor["data", default: 0] else { throw FountainOutboxError.stale }
        var pages = Set<String>()
        if kind == "page" {
            guard let entity = body["page"] as? [String: Any], entity["id"] as? String == page,
                  body["blocks"] is [Any], body["state"] is [String: Any], try level(entity["access_level"]) == level(body["access_level"]) else { throw FountainOutboxError.access }
            _ = try text(body["epoch"], limit: 1000); _ = try checkedInteger(body["seq"]); pages.insert(page)
        } else {
            guard let entities = body["pages"] as? [[String: Any]], entities.count <= 100000, body["databases"] is [Any] else { throw FountainOutboxError.access }
            for entity in entities { let id = try text(entity["id"], limit: 1000); _ = try level(entity["access_level"]); guard pages.insert(id).inserted else { throw FountainOutboxError.access } }
        }
        var missing = Set<String>()
        for page in pages where try control(serverObservedKey(profile, page: page)) == nil { missing.insert(page) }
        guard !missing.isEmpty else { return false }
        beforeMutation()
        try transaction {
            try self.checkRecoveryObservation(admission, sessionRef: sessionRef)
            for page in missing { try self.markServerObserved(profile, page: page) }
            try self.advanceProof()
        }
        readDeadline = nil; boundary = UUID().uuidString
        return true
    }
    private func newNativeLocalTargets(_ changes: [Change]) throws -> Set<String> {
        var result = Set<String>()
        for item in changes where item.op == "put" && item.bucket == "mutations" {
            guard let operation = item.value?["operation"] as? [String: Any], operation["kind"] as? String == "page.create", let target = operation["target_id"] as? String,
                  try integer("SELECT count(*) FROM records WHERE bucket='mutations' AND key=?", [item.encodedKey]) == 0 else { continue }
            result.insert(target)
        }
        return result
    }
    private func qualifyNativeLocalCreations(_ profile: String, targets: Set<String>, overlay: [Change]) throws {
        guard !targets.isEmpty else { return }
        let qualification = try localCreationAuthority(profile, overlay: overlay), actor = (try profileParts(profile)).prefix(3).joined(separator: "|")
        guard qualification.issues.isEmpty else { throw FountainOutboxError.access }
        for target in targets where qualification.pages[target]?["local"] as? Bool == true {
            guard try control(serverObservedKey(profile, page: target)) == nil,
                  let operation = qualification.operations.values.first(where: { $0["kind"] as? String == "page.create" && $0["target_id"] as? String == target }),
                  let body = operation["body"] as? [String: Any], let creation = operation["id"] as? String, let epoch = operation["document_epoch"] as? String else { continue }
            let context: [String: Any] = ["version": 1, "actor": actor, "profile": profile, "page": target, "creation": creation, "epoch": epoch,
                "operationDigest": Self.hash(try json(operation)), "parent": body["parent_id"] ?? NSNull(), "teamspace": body["teamspace_id"] ?? "general"]
            let key = "nativeLocal:" + profile + "|" + Self.encodeURIComponent(target)
            if let previous = try control(key) { guard try json(previous) == json(context) else { throw FountainOutboxError.conflict } }
            else { try setControl(key, context) }
        }
    }
    private func confirmedRecord(_ item: Change, profile: String) throws -> Bool {
        guard let bytes = item.payload, item.profile == profile else { return false }
        return try confirmedBytes(bucket: item.bucket, key: item.encodedKey, bytes: bytes, profile: profile)
    }
    private func confirmedBytes(bucket: String, key: String, bytes: Data, profile: String) throws -> Bool {
        guard let authority = try control("recordAuthority:" + bucket + "|" + key) as? [String: Any] else { return false }
        return authority["profile"] as? String == profile && authority["actor"] as? String == profile.components(separatedBy: "|").prefix(3).joined(separator: "|") && authority["digest"] as? String == Self.hash(bytes) && authority["trust"] as? String == "confirmed"
    }
    private func archiveOriginal(_ item: Change, bytes: Data, tx: String, position: Int, capturedProfile: String, submittedUntrustedInput: Bool = false) throws {
        try execute("INSERT INTO recovery(tx_id,position,bucket,key,profile_id,value) VALUES(?,?,?,?,?,?)", [tx, position, item.bucket, item.encodedKey, item.profile, bytes])
        let row = try integer("SELECT last_insert_rowid()"), actor = (try profileParts(capturedProfile)).prefix(3).joined(separator: "|")
        guard (try profileParts(item.profile)).prefix(3).joined(separator: "|") == actor else { return }
        let original = try control("recordAuthority:" + item.bucket + "|" + item.encodedKey) as? [String: Any]
        let confirmed = original?["profile"] as? String == item.profile && original?["actor"] as? String == actor && original?["digest"] as? String == item.payload.map(Self.hash)
        guard confirmed || submittedUntrustedInput else { return }
        var attribution: [String: Any] = ["actor": actor, "profile": item.profile, "digest": Self.hash(bytes), "trust": submittedUntrustedInput ? "upgrade" : "confirmed"]
        if confirmed, !submittedUntrustedInput, let context = original?["nativeLocal"] as? [String: Any] { attribution["nativeLocal"] = context }
        try setControl("archiveAuthority:" + String(row), attribution)
    }
    // Internal native archive primitive, also exercised by historical fixtures.
    // It derives the bytes and ownership from an actual confirmed active row;
    // neither a renderer body nor a claimed historical actor is accepted.
    func archiveConfirmedVersion(bucket: String, key: Any, transactionID: String, position: Int) throws {
        let profile = try verifiedProfile(), encoded = String(data: try json(key), encoding: .utf8)!
        guard position >= 0, position < 100000, !transactionID.isEmpty, transactionID.utf8.count <= 160,
              let row = try rows("SELECT value FROM records WHERE bucket=? AND key=? AND profile_id=?", [bucket, encoded, profile]).first,
              let bytes = row[0] as? Data, try confirmedBytes(bucket: bucket, key: encoded, bytes: bytes, profile: profile), let value = try decode(bytes) as? [String: Any] else { throw FountainOutboxError.access }
        let parsed = try change(["op": "put", "bucket": bucket, "key": key, "value": value])
        let source = Change(op: parsed.op, bucket: parsed.bucket, encodedKey: parsed.encodedKey, profile: parsed.profile, resource: parsed.resource, value: parsed.value, payload: bytes)
        try transaction { try self.archiveOriginal(source, bytes: bytes, tx: transactionID, position: position, capturedProfile: profile) }
    }
    private func eraseAttributedRows(actor: String) throws {
        let prefix = actor + "|"
        for table in ["records", "recovery"] {
            let headers = try rows("SELECT rowid,bucket,key,profile_id,length(value) FROM " + table + " WHERE substr(profile_id,1,length(?))=? ORDER BY rowid LIMIT 100001", [prefix, prefix])
            guard headers.count <= 100000 else { throw FountainOutboxError.limit }
            for row in headers {
                guard let id = row[0] as? Int, let bucket = row[1] as? String, let key = row[2] as? String, let profile = row[3] as? String, let size = row[4] as? Int else { throw FountainOutboxError.storage }
                let authorityKey = table == "records" ? "recordAuthority:" + bucket + "|" + key : "archiveAuthority:" + String(id)
                guard let authority = try control(authorityKey) as? [String: Any], authority["actor"] as? String == actor, authority["profile"] as? String == profile,
                      (table == "records" ? authority["trust"] as? String == "confirmed" : ["confirmed", "upgrade"].contains(authority["trust"] as? String ?? "")),
                      size > 0, size <= recordLimit else { continue }
                guard let bytes = try rows("SELECT value FROM " + table + " WHERE rowid=?", [id]).first?.first as? Data, bytes.count == size else { throw FountainOutboxError.storage }
                guard authority["digest"] as? String == Self.hash(bytes) else { continue }
                try execute(table == "records" ? "DELETE FROM records WHERE rowid=?" : "DELETE FROM recovery WHERE rowid=?", [id])
                try execute("DELETE FROM control WHERE id=?", [authorityKey])
            }
        }
    }
    func failedReconcile(_ admission: ReconcileAdmission?) {
        if let tag = admission, reconciliation?.id == tag.plan { cancelReconciliation() }
    }
    private func reconcileRecords(_ profile: String) throws -> [Change] {
        var result: [Change] = [], total = 0
        try eachRecord("SELECT bucket,key,value FROM records WHERE profile_id=? ORDER BY bucket,key", profile) { bucket, key, bytes in
            guard result.count < 100000, bytes.count <= self.transactionLimit - total else { throw FountainOutboxError.limit }
            total += bytes.count
            if try !self.confirmedBytes(bucket: bucket, key: key, bytes: bytes, profile: profile) {
                result.append(Change(op: "put", bucket: bucket, encodedKey: key, profile: profile, resource: nil, value: nil, payload: bytes))
                return
            }
            let item = try self.change(["op": "put", "bucket": bucket, "key": self.decode(Data(key.utf8)), "value": self.decode(bytes)])
            result.append(Change(op: item.op, bucket: item.bucket, encodedKey: item.encodedKey, profile: item.profile, resource: item.resource, value: item.value, payload: bytes))
        }
        return result
    }
    private struct LocalCreationAuthority {
        var pages: [String: [String: Any]] = [:], rows: [String: Set<String>] = [:], mutations = Set<String>()
        var operations: [String: [String: Any]] = [:]
        var issues: [[String: String]] = []
    }
    private func localRowKey(_ database: String, _ row: String) -> String { Self.encodeURIComponent(database) + "|" + Self.encodeURIComponent(row) }
    private func localCreationAuthority(_ profile: String, overlay: [Change]) throws -> LocalCreationAuthority {
        var records: [String: Change] = [:]
        for item in try reconcileRecords(profile) { records[item.bucket + "|" + item.encodedKey] = item }
        for item in overlay { if item.op == "delete" { records.removeValue(forKey: item.bucket + "|" + item.encodedKey) } else { records[item.bucket + "|" + item.encodedKey] = item } }
        let ledger = try proofs(profile), currentFloor = try floor(profile), now = Date().timeIntervalSince1970 * 1000
        let nativeSession = try control("nativeSession:" + profile) as? [String: Any]
        let role = (nativeSession?["member"] as? [String: Any])?["role"] as? String
        var result = LocalCreationAuthority(), mutations: [String: Change] = [:], creates: [String: String] = [:], rows: [String: String] = [:], edges: [String: Set<String>] = [:], canonicalCandidates: [String: [String: Any]] = [:]
        func failure(_ kind: String, _ id: String, _ reason: String = "dependency_conflict") { result.issues.append(["kind": kind, "id": id, "reason": reason]) }
        func fresh(_ kind: String, _ id: String, write: Bool) -> [String: Any]? {
            guard let proof = ledger[proofKey(kind, id)], proof["denied"] == nil, proof["invalid"] == nil,
                  (proof["validUntil"] as? Double ?? 0) > now,
                  proof["accessRevision"] as? Int == currentFloor["access"], proof["dataRevision"] as? Int == currentFloor["data"],
                  (proof["accessLevel"] as? Int ?? 0) >= (write ? 3 : 1),
                  !write || (proof["locked"] as? Bool != true && proof["archived"] as? Bool != true) else { return nil }
            return proof
        }
        for item in records.values where item.bucket == "mutations" {
            guard let value = item.value, let id = value["id"] as? String, let operation = value["operation"] as? [String: Any], operation["id"] as? String == id,
                  mutations[id] == nil, let kind = operation["kind"] as? String, ["page.create", "page.patch", "row.create", "row.patch", "row.delete"].contains(kind), let target = operation["target_id"] as? String,
                  let body = operation["body"] as? [String: Any], let resource = item.resource else { throw FountainOutboxError.invalid }
            let parts = resource.components(separatedBy: "|")
            guard parts.prefix(4).joined(separator: "|") == profile,
                  kind.hasPrefix("page.") ? (parts.count == 5 && parts[4].removingPercentEncoding == target) : (parts.count == 6 && parts[5].removingPercentEncoding == operation["database_id"] as? String) else { throw FountainOutboxError.invalid }
            mutations[id] = item
            guard let dependencies = operation["depends_on"] as? [String], Set(dependencies).count == dependencies.count else { failure(kind.hasPrefix("row.") ? "database" : "page", kind.hasPrefix("row.") ? operation["database_id"] as? String ?? target : target); continue }
            edges[id] = Set(dependencies)
            for basis in (operation["base_rows"] as? [String: [String: Any]] ?? [:]).values { if let previous = basis["after_operation"] as? String { edges[id, default: []].insert(previous) } }
            if kind == "page.create" {
                if try appliedSyncOperation(operation, profile: profile) != nil { continue }
                guard creates[target] == nil, body["id"] as? String == target else { failure("page", target); continue }; creates[target] = id
                if (ledger["workspace:workspace"]?["pages"] as? [String: [String: Any]])?[target] != nil {
                    if let actual = fresh("page", target, write: true), actual["epoch"] as? String == operation["document_epoch"] as? String { canonicalCandidates[target] = actual }
                    else { failure("page", target, "denied") }
                }
            } else if kind == "row.create" {
                let key = localRowKey(operation["database_id"] as? String ?? "", target)
                guard rows[key] == nil, body["id"] as? String == target else { failure("database", operation["database_id"] as? String ?? target); continue }; rows[key] = id
            }
        }
        var local: [String: Change] = [:]
        for item in records.values where item.bucket == "localPages" {
            guard let metadata = item.value?["metadata"] as? [String: Any], metadata["localOnly"] as? Bool == true else { continue }
            guard let entity = metadata["page"] as? [String: Any], let id = entity["id"] as? String, let createID = creates[id],
                  createID == metadata["create_operation_id"] as? String, let mutation = mutations[createID]?.value?["operation"] as? [String: Any],
                  let epoch = metadata["initial_epoch"] as? String, !epoch.isEmpty, mutation["document_epoch"] as? String == epoch,
                  let resource = item.resource, resource == profile + "|" + Self.encodeURIComponent(id),
                  let snapshot = records["snapshots|" + String(data: try json(resource), encoding: .utf8)!]?.value?["snapshot"] as? [String: Any],
                  snapshot["epoch"] as? String == epoch, (snapshot["page"] as? [String: Any])?["id"] as? String == id,
                  snapshot["workspace_id"] as? String == nativeSession?["workspace_id"] as? String,
                  snapshot["current_member_id"] as? String == (nativeSession?["member"] as? [String: Any])?["id"] as? String,
                  snapshot["session_binding"] as? String == nativeSession?["cache_binding"] as? String,
                  let state = snapshot["state"] as? [String: Any], (try? checkedInteger(state["version"])) == 1 else { failure("page", item.resource?.components(separatedBy: "|").last?.removingPercentEncoding ?? "unknown"); continue }
            local[id] = item
        }
        for (target, createID) in creates {
            guard local[target] != nil, let operation = mutations[createID]?.value?["operation"] as? [String: Any], let body = operation["body"] as? [String: Any] else { failure("page", target); continue }
            guard let workspaceAuthority = fresh("workspace", "workspace", write: false) else { failure("page", target, "denied"); continue }
            if let parent = body["parent_id"] as? String {
                if let predecessor = creates[parent] { edges[createID, default: []].insert(predecessor) }
                else if fresh("page", parent, write: true) == nil { failure("page", target, "denied") }
            } else {
                guard ["owner", "admin", "member"].contains(role ?? "") else { failure("page", target, "denied"); continue }
                let space = body["teamspace_id"] as? String ?? (body["teamspace_id"] is NSNull ? "" : "general")
                let spaces = workspaceAuthority["teamspaces"] as? [String: Int] ?? [:]
                if !space.isEmpty && (spaces[space] ?? 0) < 3 { failure("page", target, "denied") }
            }
        }
        for (id, item) in mutations {
            let operation = item.value!["operation"] as! [String: Any], kind = operation["kind"] as! String, target = operation["target_id"] as! String
            if kind == "page.patch", let predecessor = creates[target] { edges[id, default: []].insert(predecessor) }
            if kind.hasPrefix("row."), let database = operation["database_id"] as? String, let body = operation["body"] as? [String: Any] {
                guard let authority = fresh("database", database, write: false) else { failure("database", database, "denied"); continue }
                if kind == "row.create", authority["canCreateRow"] as? Bool != true { failure("database", database, "denied") }
                var references: [(String, String)] = []
                if let parent = body["parent_row_id"] as? String { references.append((database, parent)) }
                for row in body["depends_on"] as? [String] ?? [] { references.append((database, row)) }
                for (property, destination) in authority["relations"] as? [String: String] ?? [:] {
                    for row in (body["properties"] as? [String: Any])?[property] as? [String] ?? [] { references.append((destination.isEmpty ? database : destination, row)) }
                }
                for (destination, row) in references {
                    if let predecessor = rows[localRowKey(destination, row)] { edges[id, default: []].insert(predecessor) }
                    else if ((fresh("database", destination, write: false)?["rows"] as? [String: Int])?[row] ?? 0) < 1 { failure("database", database, "denied") }
                }
                if kind != "row.create", let predecessor = rows[localRowKey(database, target)] { edges[id, default: []].insert(predecessor) }
            }
        }
        var indegree: [String: Int] = [:], dependents: [String: [String]] = [:]
        for id in mutations.keys {
            var pending = Set<String>()
            for dependency in edges[id, default: []] {
                if mutations[dependency] == nil, let receipt = try control("syncReceipt:" + profile + ":" + dependency) as? [String: Any], receipt["profile"] as? String == profile,
                   receipt["sessionRef"] as? String == (try identity()["sessionRef"] as? String), (receipt["result"] as? [String: Any])?["status"] as? String == "applied" { continue }
                pending.insert(dependency)
            }
            edges[id] = pending; indegree[id] = pending.count
            for dependency in pending { dependents[dependency, default: []].append(id) }
        }
        var queue = indegree.keys.filter { indegree[$0] == 0 }.sorted(), cursor = 0, visited = Set<String>()
        while cursor < queue.count {
            let id = queue[cursor]; cursor += 1; visited.insert(id)
            for dependent in dependents[id] ?? [] { indegree[dependent, default: 0] -= 1; if indegree[dependent] == 0 { queue.append(dependent) } }
        }
        for (id, item) in mutations where !visited.contains(id) {
            let operation = item.value!["operation"] as! [String: Any], kind = operation["kind"] as! String
            failure(kind.hasPrefix("row.") ? "database" : "page", kind.hasPrefix("row.") ? operation["database_id"] as! String : operation["target_id"] as! String)
        }
        var invalid = Set(mutations.filter { _, item in
            let operation = item.value!["operation"] as! [String: Any]
            return result.issues.contains { issue in issue["kind"] == "database" ? issue["id"] == operation["database_id"] as? String : issue["id"] == operation["target_id"] as? String }
        }.keys)
        var pending = Array(invalid), pendingCursor = 0
        while pendingCursor < pending.count { let id = pending[pendingCursor]; pendingCursor += 1; for dependent in dependents[id] ?? [] where invalid.insert(dependent).inserted { pending.append(dependent) } }
        result.mutations = Set(mutations.keys).subtracting(invalid)
        for id in result.mutations { result.operations[id] = mutations[id]?.value?["operation"] as? [String: Any] }
        for (id, item) in local {
            guard let creator = creates[id], result.mutations.contains(creator) else { continue }
            let metadata = item.value!["metadata"] as! [String: Any]
            result.pages[id] = canonicalCandidates[id] ?? ["accessLevel": 4, "locked": false, "archived": false, "epoch": metadata["initial_epoch"]!, "seq": 0, "local": true]
        }
        for (key, creator) in rows where result.mutations.contains(creator) { let parts = key.split(separator: "|", maxSplits: 1); if parts.count == 2, let database = String(parts[0]).removingPercentEncoding, let row = String(parts[1]).removingPercentEncoding { result.rows[database, default: []].insert(row) } }
        return result
    }
    private func reconcileSource(_ profile: String) throws -> String {
        var digest = SHA256(), total = 0
        try eachRecord("SELECT bucket,key,value FROM records WHERE profile_id=? ORDER BY bucket,key", profile) { bucket, key, bytes in
            guard bytes.count <= self.transactionLimit - total else { throw FountainOutboxError.limit }; total += bytes.count
            digest.update(data: try self.json([bucket, key, bytes.count]))
            for offset in stride(from: 0, to: bytes.count, by: self.partLimit) { digest.update(data: bytes.subdata(in: offset..<min(offset + self.partLimit, bytes.count))) }
        }
        if let session = try control("nativeSession:" + profile) { digest.update(data: try json(session)) }
        let staged = try rows("SELECT tx_id,part,lease,base_head,length(data) FROM staging ORDER BY tx_id,part")
        guard staged.count <= 100000 else { throw FountainOutboxError.limit }
        var stageBytes = 0
        for row in staged {
            guard let tx = row[0] as? String, let part = row[1] as? Int, let size = row[4] as? Int, size > 0, size <= transactionLimit - stageBytes else { throw FountainOutboxError.limit }
            stageBytes += size; digest.update(data: try json(row))
            for prefix in ["stagedOwner:", "stagedProof:"] { digest.update(data: try json([prefix + tx, try control(prefix + tx) ?? NSNull()])) }
            for offset in stride(from: 0, to: size, by: partLimit) {
                let length = min(partLimit, size - offset)
                guard let bytes = try rows("SELECT substr(data,?,?) FROM staging WHERE tx_id=? AND part=?", [offset + 1, length, tx, part]).first?.first as? Data, bytes.count == length else { throw storageFailure("source-stage-bytes") }
                digest.update(data: bytes)
            }
        }
        for prefix in ["cancelledTx:" + profile + ":", "cancelledReconcile:" + profile + ":", "syncReceipt:" + profile + ":", "nativeLocal:" + profile + "|", "serverObserved:" + (try profileParts(profile))[1] + "|"] {
            for row in try rows("SELECT id,value FROM control WHERE substr(id,1,length(?))=? ORDER BY id", [prefix, prefix]) {
                guard let key = row[0] as? String, let bytes = row[1] as? Data, bytes.count <= recordLimit else { throw storageFailure("source-control-type") }
                digest.update(data: Data(key.utf8)); digest.update(data: bytes)
            }
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func checkReconciliation(_ plan: ReconciliationPlan, checkSource: Bool = true) throws {
        guard reconciliation === plan, try verifiedProfile() == plan.profile, lease == plan.lease, owner == plan.owner, authEpoch == plan.auth,
              try identity()["sessionRef"] as? String == plan.sessionRef, plan.expiresAt > Date().timeIntervalSince1970 * 1000,
              try head() == plan.head, try proofEpoch() == plan.proof,
              try (!checkSource || reconcileSource(plan.profile) == plan.source) else { throw FountainOutboxError.stale }
        try checkLease(plan.lease)
        for handle in plan.selected {
            guard handle.expiresAt > Date().timeIntervalSince1970 * 1000,
                  try archiveDigest(handle.rows, profile: handle.profile) == handle.digest else { throw FountainOutboxError.stale }
        }
    }
    private func planWrite(_ bytes: Data, plan: ReconciliationPlan, name: String) throws -> URL {
        guard bytes.count <= recordLimit, bytes.count <= transactionLimit - plan.totalBytes else { throw FountainOutboxError.limit }
        let file = plan.directory.appendingPathComponent(name)
        guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.complete]) else { throw storageFailure("plan-file-create") }
        try Self.privateItem(file, directory: false)
        let handle = try FileHandle(forWritingTo: file)
        do {
            for offset in stride(from: 0, to: bytes.count, by: partLimit) { try handle.write(contentsOf: bytes.subdata(in: offset..<min(offset + partLimit, bytes.count))) }
            try handle.synchronize(); try handle.close()
        } catch { try? handle.close(); throw storageFailure("plan-file-write") }
        plan.totalBytes += bytes.count
        return file
    }
    func admitReconcile(path: String, method: String, sessionRef: String?, sequence: Int) throws -> ReconcileAdmission? {
        guard let plan = reconciliation else { return nil }
        do { try checkReconciliation(plan) } catch { cancelReconciliation(); throw error }
        // Any non-GET business request admitted while collecting/ready makes its
        // result unknowable to this plan; a fresh preparation is required.
        if method != "GET" { cancelReconciliation(); return nil }
        guard plan.ready == nil, sequence > plan.watermark, (sessionRef ?? "local-no-cookie") == plan.sessionRef,
              let (kind, id) = Self.collectorResource(path: path, method: method) else { return nil }
        let exactPath = kind == "workspace" ? "/api/workspace" : "/api/" + (kind == "database" ? "databases/" : kind == "attachment" ? "attachments/" : "pages/") + Self.encodeURIComponent(id) + (kind == "page" ? "/collaboration" : kind == "attachment" ? "/metadata" : "")
        guard path == exactPath else { return nil }
        let key = proofKey(kind, id)
        guard plan.required[key] != nil, plan.captures[key] == nil, plan.admissions[key] == nil else { return nil }
        let nonce = UUID().uuidString
        plan.admissions[key] = nonce
        return ReconcileAdmission(plan: plan.id, sweep: plan.sweep, key: key, nonce: nonce)
    }
    private static func collectorResource(path: String, method: String) -> (String, String)? {
        if let resource = canonicalResource(path: path, method: method) { return resource }
        guard method == "GET", !path.contains("?"), !path.contains("#") else { return nil }
        let parts = path.components(separatedBy: "/")
        guard parts.count == 5, parts[0].isEmpty, parts[1] == "api", parts[2] == "attachments", parts[4] == "metadata",
              let id = parts[3].removingPercentEncoding, !id.isEmpty, id.utf8.count <= 1000, ![".", ".."].contains(id), !id.contains("/"), !id.contains("\\"),
              !id.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }), encodeURIComponent(id) == parts[3] else { return nil }
        return ("attachment", id)
    }
    private func validateCollectedAttachment(_ data: Data, id: String) throws {
        guard let body = try decode(data) as? [String: Any], Set(body.keys).isSubset(of: ["id", "name", "size", "mime", "storage", "status", "sha256"]),
              body["id"] as? String == id, body["status"] as? String == "complete", ["inline", "chunks"].contains(body["storage"] as? String ?? ""),
              try checkedInteger(body["size"]) <= 5_000_000_000 else { throw FountainOutboxError.access }
        let name = try text(body["name"], limit: 1020)
        guard name.unicodeScalars.count <= 255, ![".", ".."].contains(name), !name.contains("/"), !name.contains("\\") else { throw FountainOutboxError.access }
        _ = try text(body["mime"], limit: 1020)
        guard (body["mime"] as! String).unicodeScalars.count <= 255 else { throw FountainOutboxError.access }
        if let sha = body["sha256"] { guard let sha = sha as? String, sha.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw FountainOutboxError.access } }
    }
    func observeReconcileResource(admission: ReconcileAdmission?, path: String, method: String, status: Int, data: Data, sessionRef: String?) throws {
        guard let plan = reconciliation else { try observeResource(path: path, method: method, status: status, data: data, sessionRef: sessionRef); return }
        guard let tag = admission, tag.plan == plan.id, tag.sweep == plan.sweep, plan.admissions[tag.key] == tag.nonce,
              plan.ready == nil, (sessionRef ?? "local-no-cookie") == plan.sessionRef,
              let (kind, id) = Self.collectorResource(path: path, method: method), method == "GET", proofKey(kind, id) == tag.key else {
            // An unowned late reply can never fill a capture. A semantic no-op
            // while collecting may leave the plan alive; any actual evidence
            // transition, or every observation after ready, closes it.
            do {
                try checkReconciliation(plan)
                try observeResource(path: path, method: method, status: status, data: data, sessionRef: sessionRef)
                let currentHead = try head(), currentProof = try proofEpoch(), currentSource = try reconcileSource(plan.profile)
                if plan.ready != nil || currentHead != plan.head || currentProof != plan.proof || currentSource != plan.source { cancelReconciliation() }
            } catch { cancelReconciliation(); throw error }
            return
        }
        do {
            try checkReconciliation(plan)
            guard [200, 403, 404].contains(status), data.count <= recordLimit else { throw FountainOutboxError.retry }
            if kind == "attachment" { if status == 200 { try validateCollectedAttachment(data, id: id) } }
            else { try observeResource(path: path, method: method, status: status, data: data, sessionRef: sessionRef) }
            let file = try planWrite(data, plan: plan, name: UUID().uuidString)
            plan.captures[tag.key] = (status, file, Self.hash(data)); plan.admissions.removeValue(forKey: tag.key)
            plan.head = try head(); plan.proof = try proofEpoch(); plan.source = try reconcileSource(plan.profile)
        } catch { cancelReconciliation(); throw error }
    }
    private func captured(_ key: String, plan: ReconciliationPlan) throws -> [String: Any]? {
        guard let captured = plan.captures[key] else { throw FountainOutboxError.retry }
        guard captured.0 == 200 else { return nil }
        try Self.privateItem(captured.1, directory: false)
        let attributes = try FileManager.default.attributesOfItem(atPath: captured.1.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue <= recordLimit else { throw storageFailure("capture-size") }
        let bytes = try Data(contentsOf: captured.1)
        guard Self.hash(bytes) == captured.2, let body = try decode(bytes) as? [String: Any] else { throw storageFailure("capture-hash-object") }
        return body
    }
    private func collecting(_ plan: ReconciliationPlan) throws -> [String: Any] {
        try checkReconciliation(plan)
        let needed = plan.required.keys.sorted().filter { plan.captures[$0] == nil }.prefix(100).map { plan.required[$0]! }
        return ["state": "collecting", "planId": plan.id, "lease": plan.lease, "expiresAt": plan.expiresAt, "sweep": plan.sweep, "needed": needed]
    }
    private func expandReconciliation(_ plan: ReconciliationPlan, workspace: [String: Any]) throws {
        var source: [Change] = []
        for item in try reconcileRecords(plan.profile) where try confirmedRecord(item, profile: plan.profile) { source.append(item) }
        for handle in plan.selected { for (bucket, key, value, _) in try archiveData(handle.rows, profile: handle.profile) { source.append(try change(["op": "put", "bucket": bucket, "key": key, "value": value])) } }
        var local = Set<String>()
        for item in source where item.bucket == "localPages" && (item.value?["metadata"] as? [String: Any])?["localOnly"] as? Bool == true {
            guard let id = item.resource?.components(separatedBy: "|").last?.removingPercentEncoding, let metadata = item.value?["metadata"] as? [String: Any], let creation = metadata["create_operation_id"] as? String, let epoch = metadata["initial_epoch"] as? String else { continue }
            let alreadyVisible = (workspace["pages"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == id }
            if !alreadyVisible, try creationMarker(creation, target: id, epoch: epoch, profile: plan.profile) == nil,
               try control(serverObservedKey(item.profile, page: id)) == nil { local.insert(id) }
        }
        func add(_ kind: String, _ id: String) throws {
            _ = try text(id, limit: 1000)
            if kind == "page" && local.contains(id) { return }
            let key = proofKey(kind, id)
            if plan.required[key] == nil, plan.required.count >= 1000 { throw FountainOutboxError.limit }
            plan.required[key] = ["kind": kind, "id": id]
        }
        for (kind, field) in [("page", "pages"), ("database", "databases")] {
            guard let values = workspace[field] as? [[String: Any]] else { throw FountainOutboxError.access }
            for value in values { try add(kind, try text(value["id"], limit: 1000)) }
        }
        for item in source {
            if let resource = item.resource {
                let parts = resource.components(separatedBy: "|")
                if let id = parts.last?.removingPercentEncoding { try add(parts.count == 6 ? "database" : "page", id) }
            }
            if let operation = item.value?["operation"] as? [String: Any], let body = operation["body"] as? [String: Any], operation["kind"] as? String == "page.create", let parent = body["parent_id"] as? String { try add("page", parent) }
            if let operation = item.value?["operation"] as? [String: Any] {
                if operation["field"] as? String == "attachment_id", let attachment = operation["value"] as? String { try add("attachment", attachment) }
                if let schema = (operation["base"] as? [String: Any])?["schema"] as? [String: [String: Any]], let values = (operation["body"] as? [String: Any])?["properties"] as? [String: Any] {
                    for (property, description) in schema where description["type"] as? String == "files" { for id in values[property] as? [String] ?? [] { try add("attachment", id) } }
                }
            }
            func attachments(_ object: Any) throws {
                guard let object = object as? [String: Any] else { return }
                if let id = object["attachment_id"] as? String { try add("attachment", id) }
                if let blocks = object["blocks"] as? [[String: Any]] { for block in blocks { try attachments(block) } }
            }
            if let value = item.value { try attachments(value["draft"] as Any); try attachments(value["snapshot"] as Any) }
        }
        // Relation target projections are actual canonical DBs, including when
        // a locally staged mutation refers to a DB outside its own resource.
        for key in plan.captures.keys.sorted() where key.hasPrefix("database:") {
            if let body = try captured(key, plan: plan), let database = body["database"] as? [String: Any], let properties = database["properties"] as? [[String: Any]] {
                for property in properties where property["type"] as? String == "relation" { if let target = property["database_id"] as? String, !target.isEmpty { try add("database", target) } }
            }
        }
        plan.expanded = true
    }
    private func readablePromotionBody(_ raw: Any, plan: ReconciliationPlan) throws -> (blocks: [[String: Any]], points: Int) {
        guard let source = raw as? [[String: Any]], source.count <= 2000 else { throw FountainOutboxError.access }
        var identities: [String: String] = [:], prepared: [[String: Any]] = [], points = 0
        let aliases = ["heading_1": "heading1", "heading_2": "heading2", "heading_3": "heading3", "bulleted_list_item": "bullet", "numbered_list_item": "numbered", "to_do": "todo"]
        for var block in source {
            let id = try text(block["id"], limit: 640); guard id.unicodeScalars.count <= 160, identities.updateValue(id, forKey: id) == nil else { throw FountainOutboxError.access }
            var tokens: [[String: Any]] = []
            if let supplied = block["rich_text"] {
                guard let values = supplied as? [[String: Any]], values.count <= 10000 else { throw FountainOutboxError.access }
                for token in values {
                    guard Set(token.keys).isSubset(of: ["text", "marks"]), let content = token["text"] as? String else { throw FountainOutboxError.access }
                    tokens.append(["text": content, "marks": try sanitizedMarks(token["marks"] ?? [:])])
                }
            }
            let joined = tokens.map { $0["text"] as! String }.joined(), plain = block["text"] as? String ?? joined
            guard block["text"] == nil || block["text"] is String, plain.unicodeScalars.count <= 100000,
                  block["rich_text"] == nil || plain.utf8.elementsEqual(joined.utf8) else { throw FountainOutboxError.access }
            if block["rich_text"] == nil, !plain.isEmpty { tokens = [["text": plain, "marks": [String: Any]()]] }
            for token in tokens {
                let count = (token["text"] as! String).unicodeScalars.count, weight = 1 + (token["marks"] as! [String: Any]).count
                guard count <= (Int.max - points) / weight else { throw FountainOutboxError.access }; points += count * weight
            }
            block["text"] = plain; block["rich_text"] = tokens
            if let type = block["type"] as? String { block["type"] = aliases[type] ?? type } else { block["type"] = "paragraph" }
            if let language = block["language"] as? String, language.unicodeScalars.count > 100 { throw FountainOutboxError.access }
            if let attachment = block["attachment_id"] as? String, attachment.unicodeScalars.count > 160 { throw FountainOutboxError.access }
            prepared.append(block)
        }
        let normalized = try sanitizedBlocks(prepared, blockMap: identities, plan: plan)
        var children: [String: [[String: Any]]] = [:]
        for block in normalized {
            let id = block["id"] as! String, parent = block["parent_id"] as? String ?? ""
            guard parent != id, parent.isEmpty || identities[parent] != nil else { throw FountainOutboxError.access }; children[parent, default: []].append(block)
        }
        var stack = Array(children["", default: []].reversed()), ordered: [[String: Any]] = []
        while let block = stack.popLast() { ordered.append(block); stack.append(contentsOf: children[block["id"] as! String, default: []].reversed()) }
        guard ordered.count == normalized.count else { throw FountainOutboxError.access }
        return (ordered, points)
    }
    private func promotionTimestamp(_ record: [String: Any]) throws -> Int {
        if let value = record["updatedAt"] { return try checkedInteger(value) }
        if let value = record["createdAt"] { return try checkedInteger(value) }
        if let raw = (record["draft"] as? [String: Any])?["createdAt"] as? String {
            let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = parser.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) { let milliseconds = date.timeIntervalSince1970 * 1000; guard milliseconds >= 0, milliseconds <= 9_007_199_254_740_991 else { throw FountainOutboxError.access }; return Int(milliseconds.rounded(.down)) }
        }
        throw FountainOutboxError.access
    }
    private enum UnsupportedPromotionBody: Error { case invalid }
    private func promotedChanges(_ plan: ReconciliationPlan, fresh: [String: [String: Any]]) throws -> (changes: [Change], unsupported: Bool) {
        guard !plan.selected.isEmpty else { return ([], false) }
        var sources: [(String, String, Any, [String: Any])] = []
        for handle in plan.selected { for (bucket, key, value, _) in try archiveData(handle.rows, profile: handle.profile) { sources.append((handle.profile, bucket, key, value)) } }
        var mirrorCount = 0, inputCount = 0
        for (sourceProfile, bucket, key, value) in sources where ["operations", "drafts", "mutations", "localPages", "transfers"].contains(bucket) && (value["draft"] as? [String: Any])?["reason"] as? String != "basis" {
            inputCount += 1
            guard sourceProfile == plan.profile else { continue }
            let archived = try change(["op": "put", "bucket": bucket, "key": key, "value": value])
            guard let bytes = try rows("SELECT value FROM records WHERE bucket=? AND key=? AND profile_id=?", [bucket, archived.encodedKey, plan.profile]).first?.first as? Data,
                  bytes == archived.payload, try confirmedBytes(bucket: bucket, key: archived.encodedKey, bytes: bytes, profile: plan.profile) else { continue }
            mirrorCount += 1
        }
        if inputCount > 0 && mirrorCount == inputCount { return ([], false) }
        if mirrorCount > 0 { throw FountainOutboxError.access }
        var operations: [String: [String: Any]] = [:], pageIDs: [String: String] = [:], rowIDs: [String: String] = [:], mutationIDs: [String: String] = [:], epochs: [String: String] = [:]
        var output: [Change] = [], unsupported = false
        func put(_ bucket: String, _ key: Any, _ value: [String: Any]) throws { output.append(try change(["op": "put", "bucket": bucket, "key": key, "value": value])) }
        for (sourceProfile, bucket, key, record) in sources where ["mutations", "localPages", "snapshots", "drafts", "operations"].contains(bucket) {
            let item = try change(["op": "put", "bucket": bucket, "key": key, "value": record])
            guard let resource = item.resource, resource.components(separatedBy: "|").count == 5, let originalID = resource.components(separatedBy: "|").last?.removingPercentEncoding else { continue }
            guard try control(serverObservedKey(sourceProfile, page: originalID)) != nil else { continue }
            guard let original = fresh[plan.profile + "|" + Self.encodeURIComponent(originalID)], let page = original["page"] as? [String: Any], page["id"] as? String == originalID,
                  (try? level(original["access_level"])) ?? 0 >= 3, (try? level(page["access_level"])) == (try? level(original["access_level"])),
                  Self.boolean(page["locked"]) == false, Self.boolean(page["archived"]) == false else { throw FountainOutboxError.access }
            _ = try text(original["epoch"], limit: 1000)
        }
        for (sourceProfile, bucket, _, record) in sources where bucket == "mutations" {
            guard let id = record["id"] as? String, let operation = record["operation"] as? [String: Any], operation["id"] as? String == id,
                  let kind = operation["kind"] as? String, ["page.create", "page.patch", "row.create", "row.patch", "row.delete"].contains(kind),
                  let target = operation["target_id"] as? String else { unsupported = true; continue }
            let identity = sourceProfile + "|" + id
            if let previous = operations[identity] { guard try json(previous) == json(operation) else { throw FountainOutboxError.conflict }; continue }
            operations[identity] = operation; mutationIDs[identity] = UUID().uuidString.lowercased()
            if kind == "page.create" { guard pageIDs[sourceProfile + "|" + target] == nil else { throw FountainOutboxError.conflict }; pageIDs[sourceProfile + "|" + target] = UUID().uuidString.lowercased(); epochs[sourceProfile + "|" + target] = UUID().uuidString.lowercased() }
            if kind == "row.create" { let database = try text(operation["database_id"], limit: 1000); guard rowIDs[sourceProfile + "|" + localRowKey(database, target)] == nil else { throw FountainOutboxError.conflict }; rowIDs[sourceProfile + "|" + localRowKey(database, target)] = UUID().uuidString.lowercased() }
        }
        let now = Date().timeIntervalSince1970 * 1000, scope = try profileParts(plan.profile)
        func safeProperty(_ value: Any, type: String) -> Bool {
            if value is NSNull { return true }
            if type == "number", let number = value as? NSNumber { return CFGetTypeID(number) != CFBooleanGetTypeID() && number.doubleValue.isFinite && abs(number.doubleValue) < 1e15 }
            if type == "checkbox" { return Self.boolean(value) != nil }
            if ["multi_select", "relation"].contains(type) { return (value as? [String]).map { $0.count <= 1000 && $0.allSatisfy { !$0.isEmpty && $0.utf8.count <= 100000 } } ?? false }
            if type == "files" { return (value as? [String]).map { ids in ids.count <= 1000 && ids.allSatisfy { plan.captures["attachment:" + $0]?.0 == 200 } } ?? false }
            if ["person", "formula", "rollup"].contains(type) { return false }
            if type == "date", let range = value as? [String: Any] { return Set(range.keys).isSubset(of: ["start", "end"]) && range.values.allSatisfy { $0 is NSNull || ($0 as? String).map { $0.utf8.count <= 1000 } == true } }
            return (value as? String).map { $0.utf8.count <= 400000 } ?? false
        }
        var indegree: [String: Int] = [:], dependents: [String: [String]] = [:]
        for (identity, operation) in operations {
            let sourceProfile = String(identity.prefix(identity.count - (operation["id"] as! String).count - 1))
            guard let dependencies = operation["depends_on"] as? [String], Set(dependencies).count == dependencies.count else { throw FountainOutboxError.access }
            var required = Set(dependencies)
            for basis in (operation["base_rows"] as? [String: [String: Any]] ?? [:]).values { if let prior = basis["after_operation"] as? String { required.insert(prior) } }
            indegree[identity] = required.count
            for dependency in required { let prior = sourceProfile + "|" + dependency; guard operations[prior] != nil, prior != identity else { throw FountainOutboxError.access }; dependents[prior, default: []].append(identity) }
        }
        var ordered = indegree.keys.filter { indegree[$0] == 0 }.sorted(), position = 0
        while position < ordered.count {
            let identity = ordered[position]; position += 1
            for next in dependents[identity, default: []].sorted() { indegree[next, default: 0] -= 1; if indegree[next] == 0 { ordered.append(next) } }
        }
        guard ordered.count == operations.count else { throw FountainOutboxError.access }
        var virtual = fresh, latestRows: [String: String] = [:]
        for identity in ordered {
            let original = operations[identity]!, originalID = original["id"] as! String, sourceProfile = String(identity.prefix(identity.count - originalID.count - 1)), kind = original["kind"] as! String, oldTarget = original["target_id"] as! String
            guard var body = original["body"] as? [String: Any] else { throw FountainOutboxError.access }
            let target = kind.hasPrefix("page.") ? pageIDs[sourceProfile + "|" + oldTarget] ?? oldTarget : rowIDs[sourceProfile + "|" + localRowKey(original["database_id"] as? String ?? "", oldTarget)] ?? oldTarget
            let newID = mutationIDs[identity]!, dependencies = (original["depends_on"] as! [String]).compactMap { mutationIDs[sourceProfile + "|" + $0] }
            var operation: [String: Any] = ["id": newID, "kind": kind, "target_id": target, "depends_on": dependencies], resource: String
            if kind.hasPrefix("page.") {
                resource = plan.profile + "|" + Self.encodeURIComponent(target)
                let permitted = Set(kind == "page.create" ? ["id", "title", "icon", "cover", "parent_id", "teamspace_id", "permissions"] : ["title", "icon", "cover", "favorite"])
                guard Set(body.keys).isSubset(of: permitted) else { throw FountainOutboxError.access }
                body.removeValue(forKey: "permissions")
                for field in ["title", "icon", "cover"] { if let value = body[field] { guard let text = value as? String, text.unicodeScalars.count <= (field == "title" ? 500 : 100000) else { throw FountainOutboxError.access } } }
                if let favorite = body["favorite"], Self.boolean(favorite) == nil { throw FountainOutboxError.access }
                if kind == "page.create" {
                    body["id"] = target
                    let privatePermissions: [String: Any] = ["default": "private", "inherit": false, "members": [String: Any](), "groups": [String: Any]()]
                    body["permissions"] = privatePermissions
                    if let parent = body["parent_id"] as? String { body["parent_id"] = pageIDs[sourceProfile + "|" + parent] ?? parent }
                    let epoch = epochs[sourceProfile + "|" + oldTarget]!
                    operation["document_epoch"] = epoch
                    let entity: [String: Any] = ["id": target, "title": body["title"] ?? "제목 없음", "icon": body["icon"] ?? "📄", "cover": body["cover"] ?? "", "parent_id": body["parent_id"] ?? NSNull(), "teamspace_id": body["teamspace_id"] ?? NSNull(), "owner_id": scope[2].removingPercentEncoding!, "permissions": privatePermissions, "access_level": 4, "revision": 0, "blocks": [], "locked": false, "archived": false]
                    let snapshot: [String: Any] = ["epoch": epoch, "seq": 0, "state": ["version": 1, "max_clock": 0, "blocks": [String: Any](), "seen": [String: Any]()], "page": entity, "blocks": [], "access_level": 4, "access_revision": try floor(plan.profile)["access"] ?? 0, "data_revision": try floor(plan.profile)["data"] ?? 0, "workspace_id": scope[1].removingPercentEncoding!, "current_member_id": scope[2].removingPercentEncoding!, "session_binding": scope[3].removingPercentEncoding!]
                    virtual[resource] = snapshot
                    try put("localPages", resource, ["key": resource, "resourceKey": resource, "profileId": plan.profile, "metadata": ["page": entity, "initial_epoch": epoch, "create_operation_id": newID, "localOnly": true], "updatedAt": now])
                    try put("snapshots", resource, ["key": resource, "profileId": plan.profile, "snapshot": snapshot, "updatedAt": now])
                } else {
                    guard var snapshot = virtual[resource], var page = snapshot["page"] as? [String: Any] else { throw FountainOutboxError.access }
                    var fields: [String: Any] = [:]; for field in body.keys { fields[field] = page[field] ?? NSNull(); page[field] = body[field] }; operation["base"] = ["fields": fields]
                    snapshot["page"] = page; virtual[resource] = snapshot
                }
            } else {
                let databaseID = try text(original["database_id"], limit: 1000); operation["database_id"] = databaseID
                resource = plan.profile + "|database|" + Self.encodeURIComponent(databaseID)
                guard var snapshot = virtual[resource], let database = snapshot["database"] as? [String: Any], let properties = database["properties"] as? [[String: Any]], var rows = snapshot["rows"] as? [[String: Any]], Set(body.keys).isSubset(of: ["id", "properties", "parent_row_id", "depends_on"]) else { throw FountainOutboxError.access }
                if kind == "row.create" { body["id"] = target }
                if let parent = body["parent_row_id"] as? String { body["parent_row_id"] = rowIDs[sourceProfile + "|" + localRowKey(databaseID, parent)] ?? parent }
                if let ids = body["depends_on"] as? [String] { body["depends_on"] = ids.map { rowIDs[sourceProfile + "|" + localRowKey(databaseID, $0)] ?? $0 } }
                var values = body["properties"] as? [String: Any] ?? [:], schema: [String: Any] = [:], baseValues: [String: Any] = [:]
                let currentRow = rows.first { $0["id"] as? String == target }
                for (id, value) in values {
                    guard let property = properties.first(where: { $0["id"] as? String == id }), let type = property["type"] as? String, safeProperty(value, type: type) else { throw FountainOutboxError.access }
                    schema[id] = property; baseValues[id] = (currentRow?["properties"] as? [String: Any])?[id] ?? NSNull()
                    if type == "relation", let ids = value as? [String] { let destination = property["database_id"] as? String ?? databaseID; values[id] = ids.map { rowIDs[sourceProfile + "|" + localRowKey(destination, $0)] ?? $0 } }
                }
                if !values.isEmpty { body["properties"] = values }
                if kind == "row.delete" {
                    guard currentRow != nil, let originalSelection = original["base_rows"] as? [String: [String: Any]], !originalSelection.isEmpty else { throw FountainOutboxError.access }
                    let selected = Set(originalSelection.keys.map { rowIDs[sourceProfile + "|" + localRowKey(databaseID, $0)] ?? $0 })
                    var subtree: Set<String> = [target], queue = [target], cursor = 0
                    var children: [String: [String]] = [:]
                    for row in rows { if let parent = row["parent_row_id"] as? String, let id = row["id"] as? String { children[parent, default: []].append(id) } }
                    while cursor < queue.count { let parent = queue[cursor]; cursor += 1; for id in children[parent, default: []] { guard subtree.insert(id).inserted else { throw FountainOutboxError.access }; queue.append(id) } }
                    // Never expand a deletion to newly appeared canonical or
                    // virtual children that were absent from the original intent.
                    guard subtree == selected else { throw FountainOutboxError.access }
                    var bases: [String: [String: Any]] = [:], required = Set(operation["depends_on"] as! [String])
                    for id in subtree {
                        guard let row = rows.first(where: { $0["id"] as? String == id }), (try? level(row["access_level"])) ?? 0 >= 3 else { throw FountainOutboxError.access }
                        let latest = latestRows[localRowKey(databaseID, id)]
                        guard let updated = row["updated_at"] as? String, !updated.isEmpty || latest != nil else { throw FountainOutboxError.access }
                        var basis: [String: Any] = ["updated_at": updated.isEmpty ? "1970-01-01T00:00:00.000Z" : updated]
                        if let latest { basis["after_operation"] = latest; required.insert(latest) }
                        bases[id] = basis
                    }
                    guard required.count <= 50 else { throw FountainOutboxError.access }
                    operation["depends_on"] = required.sorted(); operation["base_rows"] = bases; body = [:]
                    rows.removeAll { subtree.contains($0["id"] as? String ?? "") }
                } else {
                    var fields: [String: Any] = [:]; for field in ["parent_row_id", "depends_on"] where body[field] != nil { fields[field] = currentRow?[field] ?? (field == "depends_on" ? [] : NSNull()) }
                    operation["base"] = kind == "row.create" ? ["schema": schema] : ["schema": schema, "properties": baseValues, "fields": fields]
                    var projected = currentRow ?? ["id": target, "database_id": databaseID, "access_level": 4, "updated_at": "1970-01-01T00:00:00.000Z", "properties": [String: Any](), "parent_row_id": NSNull(), "depends_on": []]
                    var projectedValues = projected["properties"] as? [String: Any] ?? [:]; for (field, value) in values { projectedValues[field] = value }; projected["properties"] = projectedValues
                    for field in ["parent_row_id", "depends_on"] where body[field] != nil { projected[field] = body[field] }
                    rows.removeAll { $0["id"] as? String == target }; rows.append(projected); latestRows[localRowKey(databaseID, target)] = newID
                }
                snapshot["rows"] = rows; virtual[resource] = snapshot

            }
            operation["body"] = body
            try put("mutations", [plan.profile, newID], ["profileId": plan.profile, "id": newID, "resourceKey": resource, "operation": operation, "status": "pending", "sequence": Int(now) + output.count, "createdAt": now, "updatedAt": now])
        }
        // Validate current native actor, original-server resources, destination
        // rights and the complete new entity DAG before classifying body-only
        // unsupported input. This overlay never writes or exposes old inputs.
        for (key, descriptor) in plan.required where descriptor["kind"] == "attachment" {
            guard plan.captures[key]?.0 == 200 else { throw FountainOutboxError.access }
        }
        var authorityOverlay = try reconcileRecords(plan.profile).map { item in
            Change(op: "delete", bucket: item.bucket, encodedKey: item.encodedKey, profile: item.profile, resource: item.resource, value: nil, payload: nil)
        }
        guard let workspace = try captured("workspace:workspace", plan: plan), let nativeSession = try control("nativeSession:" + plan.profile) as? [String: Any] else { throw FountainOutboxError.access }
        var profileValue: [String: Any] = ["id": plan.profile, "origin": origin, "workspaceId": scope[1].removingPercentEncoding!, "memberId": scope[2].removingPercentEncoding!, "cacheBinding": scope[3].removingPercentEncoding!, "session": nativeSession, "workspace": workspace, "validUntil": try identity()["validUntil"] ?? NSNull(), "updatedAt": now]
        if let parent = nativeSession["account_binding"] as? String { profileValue["accountBinding"] = parent }
        authorityOverlay.append(try change(["op": "put", "bucket": "profiles", "key": plan.profile, "value": profileValue]))
        for pointer in try pointerKeys(plan.profile) { authorityOverlay.append(try change(["op": "put", "bucket": "meta", "key": pointer, "value": ["id": pointer, "profileId": plan.profile]])) }
        for (resource, snapshot) in fresh {
            let database = resource.components(separatedBy: "|").count == 6
            var value: [String: Any] = ["key": resource, "profileId": plan.profile, "snapshot": snapshot, "updatedAt": now]
            if database { value["resourceKey"] = resource }
            authorityOverlay.append(try change(["op": "put", "bucket": database ? "databaseSnapshots" : "snapshots", "key": resource, "value": value]))
        }
        authorityOverlay.append(contentsOf: output)
        guard try accessIssues(plan.profile, overlay: authorityOverlay).issues.isEmpty else { throw FountainOutboxError.access }
        func selectBodies() throws -> [String: [[String: Any]]] {
            func bodyTimestamp(_ record: [String: Any]) throws -> Int {
                guard let stamp = try? promotionTimestamp(record) else { throw UnsupportedPromotionBody.invalid }; return stamp
            }
            var selectedBodies: [String: [[String: Any]]] = [:], totalPoints = 0, totalBlocks = 0
        for sourcePage in pageIDs.keys.sorted() {
            let sourceProfile = sourcePage.components(separatedBy: "|").prefix(4).joined(separator: "|"), oldPage = String(sourcePage.dropFirst(sourceProfile.count + 1)), resource = sourceProfile + "|" + Self.encodeURIComponent(oldPage)
            let records = sources.filter { $0.0 == sourceProfile && ($0.3["key"] as? String == resource || $0.3["resourceKey"] as? String == resource) }
            let sourceEpochs = Set(records.compactMap { entry -> String? in
                guard entry.1 == "mutations", let operation = entry.3["operation"] as? [String: Any], operation["kind"] as? String == "page.create", operation["target_id"] as? String == oldPage else { return nil }
                return operation["document_epoch"] as? String
            })
            guard sourceEpochs.count == 1, let sourceEpoch = sourceEpochs.first else { throw UnsupportedPromotionBody.invalid }
            var pending: [String: Data] = [:], candidates: [(Int, [[String: Any]], Int, [String: Data])] = [], snapshots: [(Int, [[String: Any]], Int, Set<String>, Data)] = [], invalidDraftStamps: [Int] = [], invalidSnapshotStamps: [Int] = []
            func operation(_ source: [String: Any], requireEpoch: Bool) throws -> (String, Data) {
                let id = try text(source["id"], limit: 300)
                if let epoch = source["_epoch"] as? String { guard epoch == sourceEpoch else { throw UnsupportedPromotionBody.invalid } }
                else if requireEpoch || source["_epoch"] != nil { throw UnsupportedPromotionBody.invalid }
                var canonical = source; canonical.removeValue(forKey: "_epoch")
                return (id, try json(canonical))
            }
            func track(_ id: String, _ bytes: Data) throws {
                if let prior = pending[id], prior != bytes { throw UnsupportedPromotionBody.invalid }
                pending[id] = bytes
            }
            for (_, bucket, _, record) in records {
                if bucket == "operations" {
                    guard let source = record["operation"] as? [String: Any] else { throw UnsupportedPromotionBody.invalid }
                    let item = try operation(source, requireEpoch: true); guard item.0 == record["id"] as? String else { throw UnsupportedPromotionBody.invalid }; try track(item.0, item.1)
                }
                if bucket == "drafts", let draft = record["draft"] as? [String: Any], draft["reason"] as? String != "basis" {
                    guard draft["epoch"] as? String == sourceEpoch, draft["ops"] == nil || draft["ops"] is [[String: Any]] else { throw UnsupportedPromotionBody.invalid }
                    var covered: [String: Data] = [:]
                    for source in draft["ops"] as? [[String: Any]] ?? [] { let item = try operation(source, requireEpoch: false); try track(item.0, item.1); covered[item.0] = item.1 }
                    if let blocks = draft["blocks"] { let stamp = try bodyTimestamp(record); if let body = try? readablePromotionBody(blocks, plan: plan) { candidates.append((stamp, body.blocks, body.points, covered)) } else { invalidDraftStamps.append(stamp) } }
                }
                if bucket == "snapshots", let snapshot = record["snapshot"] as? [String: Any], snapshot["epoch"] as? String == sourceEpoch, (snapshot["page"] as? [String: Any])?["id"] as? String == oldPage {
                    let stamp = try bodyTimestamp(record)
                    if let blocks = snapshot["blocks"], let state = snapshot["state"] as? [String: Any], let values = state["seen"] as? [String: Any],
                       values.allSatisfy({ !($0.key.isEmpty) && $0.key.utf8.count <= 300 && (Self.boolean($0.value) == true || ($0.value as? String)?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil) }),
                       let body = try? readablePromotionBody(blocks, plan: plan) { snapshots.append((stamp, body.blocks, body.points, Set(values.keys), try json(["blocks": body.blocks, "state": state]))) }
                    else { invalidSnapshotStamps.append(stamp) }
                }
            }
            let latestSnapshot: (Int, [[String: Any]], Int, Set<String>, Data)?
            if let latest = snapshots.map({ $0.0 }).max() {
                guard !invalidSnapshotStamps.contains(where: { $0 >= latest }) else { throw UnsupportedPromotionBody.invalid }
                let newest = snapshots.filter { $0.0 == latest }, first = newest[0]
                guard newest.allSatisfy({ $0.4 == first.4 }) else { throw UnsupportedPromotionBody.invalid }
                latestSnapshot = first
            } else { latestSnapshot = nil }
            let seen = latestSnapshot?.3 ?? Set<String>()
            let chosen: ([[String: Any]], Int)
            if let latest = candidates.map({ $0.0 }).max() {
                let newest = candidates.filter { $0.0 == latest }, first = newest[0]
                guard !invalidDraftStamps.contains(where: { $0 >= latest }) else { throw UnsupportedPromotionBody.invalid }
                for candidate in newest {
                    guard try json(candidate.1) == json(first.1), pending.allSatisfy({ seen.contains($0.key) || candidate.3[$0.key] == $0.value }) else { throw UnsupportedPromotionBody.invalid }
                }
                chosen = (first.1, first.2)
            } else {
                guard invalidDraftStamps.isEmpty, Set(pending.keys).isSubset(of: seen), let first = latestSnapshot else { throw UnsupportedPromotionBody.invalid }
                chosen = (first.1, first.2)
            }
            guard chosen.1 <= 50000 - totalPoints, chosen.0.count <= 2000 - totalBlocks else { throw UnsupportedPromotionBody.invalid }
            totalPoints += chosen.1; totalBlocks += chosen.0.count; selectedBodies[sourcePage] = chosen.0
        }
            return selectedBodies
        }
        let selectedBodies: [String: [[String: Any]]]
        do { selectedBodies = try selectBodies() }
        catch UnsupportedPromotionBody.invalid { return ([], true) }
        // Rebuild complete readable bodies. Archived partial operations and
        // state remain exact originals in recovery and never become active RGA.
        for sourcePage in pageIDs.keys.sorted() {
            let newPage = pageIDs[sourcePage]!, resource = plan.profile + "|" + Self.encodeURIComponent(newPage), epoch = epochs[sourcePage]!, client = "recovery_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            guard let selected = selectedBodies[sourcePage] else { throw FountainOutboxError.access }
            let identities = Dictionary(uniqueKeysWithValues: selected.map { ($0["id"] as! String, UUID().uuidString.lowercased()) })
            let blocks = try sanitizedBlocks(selected, blockMap: identities, plan: plan)
            var remapped: [[String: Any]] = [], clock = 0, siblings: [String: String] = [:]
            func emit(_ type: String, block: String, fields: [String: Any]) -> String {
                clock += 1; let id = client + ":" + String(clock)
                var operation: [String: Any] = ["id": id, "client": client, "clock": clock, "type": type, "block_id": block, "_epoch": epoch]
                for (key, value) in fields { operation[key] = value }; remapped.append(operation); return id
            }
            for block in blocks {
                let id = block["id"] as! String, parent = block["parent_id"] as? String ?? ""
                _ = emit("block.insert", block: id, fields: ["block_type": block["type"]!, "parent_id": parent.isEmpty ? NSNull() : parent, "after_id": siblings[parent] as Any? ?? NSNull()])
                siblings[parent] = id
                for field in ["checked", "language", "attachment_id", "size"] { if let value = block[field] { _ = emit("block.set", block: id, fields: ["field": field, "value": value]) } }
                var anchor: String?
                for token in block["rich_text"] as? [[String: Any]] ?? [] {
                    let text = token["text"] as! String; guard !text.isEmpty else { continue }
                    let operation = emit("text.insert", block: id, fields: ["after_id": anchor as Any? ?? NSNull(), "text": text, "marks": token["marks"]!])
                    anchor = operation + ":" + String(text.unicodeScalars.count - 1)
                }
            }
            for operation in remapped { try put("operations", [resource, operation["id"]!], ["key": resource, "profileId": plan.profile, "id": operation["id"]!, "operation": operation]) }
            let draft: [String: Any] = ["epoch": epoch, "reason": "pending", "createdAt": ISO8601DateFormatter().string(from: Date()), "ops": remapped.map { value -> [String: Any] in var value = value; value.removeValue(forKey: "_epoch"); return value }, "blocks": blocks]
            let draftID = UUID().uuidString.lowercased()
            try put("drafts", [resource, draftID], ["key": resource, "profileId": plan.profile, "clientId": draftID, "draft": draft, "updatedAt": now])
        }
        if sources.contains(where: { source in ["operations", "drafts"].contains(source.1) && (source.3["key"] as? String).map { resource in !pageIDs.keys.contains { key in let profile = key.components(separatedBy: "|").prefix(4).joined(separator: "|"); return resource == profile + "|" + Self.encodeURIComponent(String(key.dropFirst(profile.count + 1))) } } != false }) { unsupported = true }
        return (output, unsupported)
    }
    private func sanitizedMarks(_ value: Any) throws -> [String: Any] {
        guard let marks = value as? [String: Any] else { throw FountainOutboxError.access }
        for (key, value) in marks {
            if ["bold", "italic", "underline", "strike", "code"].contains(key) { guard Self.boolean(value) != nil else { throw FountainOutboxError.access } }
            else if ["color", "background"].contains(key) { guard let color = value as? String, ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"].contains(color) else { throw FountainOutboxError.access } }
            else if key == "link" {
                if value is NSNull { continue }
                guard let link = value as? String, !link.isEmpty, link.unicodeScalars.count <= 2048, !link.contains("\\"), !link.unicodeScalars.contains(where: { $0.value <= 32 }), !link.hasPrefix("//") else { throw FountainOutboxError.access }
                if !link.hasPrefix("/") && !link.hasPrefix("#") { guard let url = URL(string: link), let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme), scheme == "mailto" ? !url.path.isEmpty : url.host?.isEmpty == false else { throw FountainOutboxError.access } }
            } else { throw FountainOutboxError.access }
        }
        return marks
    }
    private func sanitizedBlocks(_ value: Any, blockMap: [String: String], plan: ReconciliationPlan) throws -> [[String: Any]] {
        guard let values = value as? [[String: Any]], values.count <= 2000 else { throw FountainOutboxError.access }
        var seen = Set<String>()
        return try values.map { source in
            guard Set(source.keys).isSubset(of: ["id", "type", "text", "parent_id", "checked", "language", "attachment_id", "size", "rich_text"]), let id = source["id"] as? String, seen.insert(id).inserted, let replacement = blockMap[id],
                  let type = source["type"] as? String, ["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "quote", "code", "callout", "divider", "toggle", "image", "bookmark", "file", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do"].contains(type), let text = source["text"] as? String, text.unicodeScalars.count <= 100000 else { throw FountainOutboxError.access }
            var block = source; block["id"] = replacement
            if let parent = source["parent_id"] as? String { guard let replacement = blockMap[parent] else { throw FountainOutboxError.access }; block["parent_id"] = replacement }
            if let checked = source["checked"], Self.boolean(checked) == nil { throw FountainOutboxError.access }
            if let language = source["language"] { _ = try self.text(language, limit: 400) }
            if let size = source["size"] { _ = try checkedInteger(size) }
            if let id = source["attachment_id"] as? String { guard plan.captures["attachment:" + id]?.0 == 200 else { throw FountainOutboxError.access } }
            if let tokens = source["rich_text"] {
                guard let tokens = tokens as? [[String: Any]], tokens.count <= 10000 else { throw FountainOutboxError.access }
                block["rich_text"] = try tokens.map { token -> [String: Any] in guard Set(token.keys).isSubset(of: ["text", "marks"]), let text = token["text"] as? String else { throw FountainOutboxError.access }; return ["text": text, "marks": try sanitizedMarks(token["marks"] ?? [:])] }
            }
            return block
        }
    }
    private func finalizeReconciliation(_ plan: ReconciliationPlan) throws -> [String: Any] {
        guard let workspace = try captured("workspace:workspace", plan: plan), let nativeSession = try control("nativeSession:" + plan.profile) as? [String: Any] else { throw FountainOutboxError.access }
        let parts = try profileParts(plan.profile), now = Date().timeIntervalSince1970 * 1000
        let current = try reconcileRecords(plan.profile)
        var changes: [Change] = [], preserve: [Change] = [], counts = ["refresh": 0, "keep": 0, "acknowledge": 0, "quarantine": 0, "import": 0], reasons = Set<String>()
        func put(_ bucket: String, _ key: Any, _ value: [String: Any]) throws { changes.append(try change(["op": "put", "bucket": bucket, "key": key, "value": value])) }
        func remove(_ item: Change, reason: String?, acknowledge: Bool = false) throws {
            if !acknowledge { preserve.append(item); counts["quarantine", default: 0] += 1; if let reason = reason { reasons.insert(reason) } }
            else { counts["acknowledge", default: 0] += 1 }
            if item.value == nil { changes.append(Change(op: "delete", bucket: item.bucket, encodedKey: item.encodedKey, profile: item.profile, resource: nil, value: nil, payload: nil)) }
            else { changes.append(try change(["op": "delete", "bucket": item.bucket, "key": decode(Data(item.encodedKey.utf8))])) }
        }
        var profileValue: [String: Any] = ["id": plan.profile, "origin": origin, "workspaceId": parts[1].removingPercentEncoding!, "memberId": parts[2].removingPercentEncoding!, "cacheBinding": parts[3].removingPercentEncoding!, "session": nativeSession, "workspace": workspace, "validUntil": try identity()["validUntil"] ?? NSNull(), "updatedAt": now]
        if let parent = nativeSession["account_binding"] as? String { profileValue["accountBinding"] = parent }
        try put("profiles", plan.profile, profileValue)
        for pointer in try pointerKeys(plan.profile) { try put("meta", pointer, ["id": pointer, "profileId": plan.profile]) }
        var fresh: [String: [String: Any]] = [:]
        for key in plan.required.keys.sorted() where key != "workspace:workspace" {
            guard let descriptor = plan.required[key], let kind = descriptor["kind"], kind != "attachment", let id = descriptor["id"], let body = try captured(key, plan: plan) else { continue }
            let resource = plan.profile + (kind == "database" ? "|database|" : "|") + Self.encodeURIComponent(id)
            var record: [String: Any] = ["key": resource, "profileId": plan.profile, "snapshot": body, "updatedAt": now]
            if kind == "database" { record["resourceKey"] = resource }
            try put(kind == "database" ? "databaseSnapshots" : "snapshots", resource, record); fresh[resource] = body
        }
        let baselineKeys = Set(changes.map { $0.bucket + "|" + $0.encodedKey })
        counts["refresh"] = baselineKeys.count
        for item in current {
            if baselineKeys.contains(item.bucket + "|" + item.encodedKey) {
                if let replacement = changes.first(where: { $0.bucket == item.bucket && $0.encodedKey == item.encodedKey }), replacement.payload != item.payload { preserve.append(item) }
                continue
            }
            if item.value == nil { try remove(item, reason: "unconfirmed_input"); continue }
            if item.bucket == "localPages", let resource = item.resource, let snapshot = fresh[resource], var value = item.value, var metadata = value["metadata"] as? [String: Any],
               let id = (metadata["page"] as? [String: Any])?["id"] as? String, let creation = metadata["create_operation_id"] as? String, let epoch = metadata["initial_epoch"] as? String,
               let receipt = try creationMarker(creation, target: id, epoch: epoch, profile: plan.profile), snapshot["epoch"] as? String == epoch {
                preserve.append(item); metadata["localOnly"] = false; metadata["creation_result"] = receipt; metadata["page"] = snapshot["page"]
                metadata["canonical_access_revision"] = snapshot["access_revision"]; metadata["canonical_data_revision"] = snapshot["data_revision"]
                value["metadata"] = metadata; value["updatedAt"] = now; try put("localPages", decode(Data(item.encodedKey.utf8)), value)
                counts["refresh", default: 0] += 1; continue
            }
            if item.bucket == "localPages", let resource = item.resource, let snapshot = fresh[resource], var value = item.value, var metadata = value["metadata"] as? [String: Any],
               metadata["localOnly"] as? Bool == true, let epoch = metadata["initial_epoch"] as? String, snapshot["epoch"] as? String == epoch,
               let actualPage = snapshot["page"] as? [String: Any], (try? level(actualPage["access_level"])) ?? 0 >= 3,
               Self.boolean(actualPage["locked"]) == false, Self.boolean(actualPage["archived"]) == false {
                preserve.append(item); metadata["page"] = actualPage; metadata.removeValue(forKey: "creation_result")
                value["metadata"] = metadata; value["updatedAt"] = now; try put("localPages", decode(Data(item.encodedKey.utf8)), value)
                counts["refresh", default: 0] += 1; continue
            }
            if ["snapshots", "databaseSnapshots"].contains(item.bucket) {
                if let id = item.resource?.components(separatedBy: "|").last?.removingPercentEncoding, (try proofs(plan.profile))[proofKey(item.bucket == "snapshots" ? "page" : "database", id)]?["denied"] as? Bool == true { try remove(item, reason: "denied") }
                continue
            }
            if ["operations", "drafts", "mutations", "localPages", "transfers"].contains(item.bucket), (item.value?["draft"] as? [String: Any])?["reason"] as? String != "basis", try !confirmedRecord(item, profile: plan.profile) {
                try remove(item, reason: "unconfirmed_input"); continue
            }
            if item.bucket == "operations", let resource = item.resource, let snapshot = fresh[resource], let operation = item.value?["operation"] as? [String: Any] {
                if (operation["_epoch"] as? String ?? operation["epoch"] as? String) != snapshot["epoch"] as? String { try remove(item, reason: "epoch_changed"); continue }
                if let id = item.value?["id"] as? String, let state = snapshot["state"] as? [String: Any], let seen = state["seen"] as? [String: Any], seen[id] != nil { try remove(item, reason: nil, acknowledge: true); continue }
            }
            if item.bucket == "drafts", let resource = item.resource, let snapshot = fresh[resource], let draft = item.value?["draft"] as? [String: Any], draft["reason"] as? String == "basis" {
                preserve.append(item)
                var value = item.value!, basis = draft
                for field in ["epoch", "seq", "state", "blocks"] { basis[field] = snapshot[field] }
                value["draft"] = basis; value["updatedAt"] = now
                try put("drafts", decode(Data(item.encodedKey.utf8)), value); counts["refresh", default: 0] += 1
                continue
            }
            if ["operations", "drafts", "mutations", "localPages", "transfers"].contains(item.bucket) { counts["keep", default: 0] += 1 }
        }
        let promoted = try promotedChanges(plan, fresh: fresh)
        if promoted.unsupported { reasons.insert("unsupported_input") }
        changes.append(contentsOf: promoted.changes)
        counts["import"] = promoted.changes.filter { ["operations", "drafts", "mutations", "localPages", "transfers"].contains($0.bucket) }.count
        counts["refresh", default: 0] += promoted.changes.filter { ["snapshots", "databaseSnapshots"].contains($0.bucket) }.count
        let priorDeletes = Set(changes.filter { $0.op == "delete" }.map { $0.bucket + "|" + $0.encodedKey })
        let candidates = current.filter { ["operations", "drafts", "mutations", "localPages", "transfers"].contains($0.bucket) && !priorDeletes.contains($0.bucket + "|" + $0.encodedKey) && !(($0.value?["draft"] as? [String: Any])?["reason"] as? String == "basis") }
        var parent: [String: String] = [:], nodes: [String: Change] = [:], mutationNode: [String: String] = [:], creationNode: [String: String] = [:], rowCreationNode: [String: String] = [:], requirements: [String: Set<String>] = [:]
        func root(_ id: String) -> String { var current = id; while let next = parent[current], next != current { current = next }; return current }
        func join(_ left: String, _ right: String) { let a = root(left), b = root(right); if a != b { parent[a] = b } }
        for item in candidates {
            let key = item.bucket + "|" + item.encodedKey; nodes[key] = item; parent[key] = key
            if let operation = item.value?["operation"] as? [String: Any], let id = item.value?["id"] as? String, item.bucket == "mutations" {
                mutationNode[id] = key
                if operation["kind"] as? String == "page.create", let target = operation["target_id"] as? String { creationNode[target] = key }
                if operation["kind"] as? String == "row.create", let target = operation["target_id"] as? String, let database = operation["database_id"] as? String { rowCreationNode[localRowKey(database, target)] = key }
            }
        }
        var resourceNodes: [String: String] = [:]
        for (key, item) in nodes {
            if item.bucket != "mutations", let resource = item.resource {
                if let prior = resourceNodes[resource] { join(key, prior) } else { resourceNodes[resource] = key }
                if let id = resource.components(separatedBy: "|").last?.removingPercentEncoding, let creator = creationNode[id] { join(key, creator) }
            }
            if item.bucket == "mutations", let operation = item.value?["operation"] as? [String: Any] {
                for dependency in operation["depends_on"] as? [String] ?? [] { if let prior = mutationNode[dependency] { requirements[key, default: []].insert(prior) } }
                for basis in (operation["base_rows"] as? [String: [String: Any]] ?? [:]).values { if let dependency = basis["after_operation"] as? String, let prior = mutationNode[dependency] { requirements[key, default: []].insert(prior) } }
                if let target = operation["target_id"] as? String, let prior = creationNode[target], prior != key { requirements[key, default: []].insert(prior) }
                if let body = operation["body"] as? [String: Any] {
                    if let parentID = body["parent_id"] as? String, let prior = creationNode[parentID] { requirements[key, default: []].insert(prior) }
                    if let database = operation["database_id"] as? String {
                        var referenced = body["depends_on"] as? [String] ?? []
                        if let parentID = body["parent_row_id"] as? String { referenced.append(parentID) }
                        for row in referenced { if let prior = rowCreationNode[localRowKey(database, row)] { requirements[key, default: []].insert(prior) } }
                        let relations = (try proofs(plan.profile))["database:" + database]?["relations"] as? [String: String] ?? [:]
                        for (property, targetDB) in relations { for row in (body["properties"] as? [String: Any])?[property] as? [String] ?? [] { if let prior = rowCreationNode[localRowKey(targetDB.isEmpty ? database : targetDB, row)] { requirements[key, default: []].insert(prior) } } }
                    }
                }
            }
        }
        var components: [String: [Change]] = [:]
        for (key, item) in nodes { components[root(key), default: []].append(item) }
        for (componentID, component) in components {
            guard plan.expiresAt > Date().timeIntervalSince1970 * 1000 else { throw FountainOutboxError.retry }
            var ancestors: Set<String> = [componentID], queue = [componentID], cursor = 0
            while cursor < queue.count { let id = queue[cursor]; cursor += 1; for item in components[id] ?? [] { for dependency in requirements[item.bucket + "|" + item.encodedKey] ?? [] { let prior = root(dependency); if ancestors.insert(prior).inserted { queue.append(prior) } } } }
            let included = ancestors.flatMap { components[$0] ?? [] }
            let keys = Set(included.map { $0.bucket + "|" + $0.encodedKey }), resources = Set(included.compactMap(\.resource))
            var inspection = changes
            for other in candidates where !keys.contains(other.bucket + "|" + other.encodedKey) { inspection.append(try change(["op": "delete", "bucket": other.bucket, "key": decode(Data(other.encodedKey.utf8))])) }
            for item in current where item.bucket == "snapshots" && item.resource.flatMap({ fresh[$0] }) == nil && item.resource.map({ !resources.contains($0) }) == true { inspection.append(try change(["op": "delete", "bucket": item.bucket, "key": decode(Data(item.encodedKey.utf8))])) }
            let failures = try accessIssues(plan.profile, overlay: inspection).issues
            guard !failures.isEmpty else { continue }
            let ledger = try proofs(plan.profile)
            // Only an actual HTTP denial uses `denied`; capability or DAG
            // loss within an otherwise valid fresh projection is a dependency
            // conflict. Preserve the same rejected closure and source bytes.
            let directlyDenied = component.contains { item in
                guard let resource = item.resource, let id = resource.components(separatedBy: "|").last?.removingPercentEncoding else { return false }
                return ledger[proofKey(resource.contains("|database|") ? "database" : "page", id)]?["denied"] as? Bool == true
            }
            let reason = directlyDenied ? "denied" : failures.contains { $0["reason"] == "revision_changed" } ? "schema_changed" : "dependency_conflict"
            for item in component {
                changes.removeAll { $0.bucket == item.bucket && $0.encodedKey == item.encodedKey }
                try remove(item, reason: reason)
            }
            let ownResources = Set(component.compactMap(\.resource))
            for item in current where item.bucket == "snapshots" && item.resource.map(ownResources.contains) == true && item.resource.flatMap({ fresh[$0] }) == nil {
                preserve.append(item); changes.append(try change(["op": "delete", "bucket": item.bucket, "key": decode(Data(item.encodedKey.utf8))]))
            }
        }
        // Validate the complete final overlay, then quarantine whole dependency
        // groups rather than deleting the particular record that failed first.
        var issues = try accessIssues(plan.profile, overlay: changes).issues
        #if DEBUG
        reconciliationTestReasons = issues.map { ($0["kind"] ?? "invalid") + ":" + ($0["reason"] ?? "invalid") }.sorted()
        #endif
        var passes = 0
        while !issues.isEmpty && passes <= current.count {
            passes += 1; var affected = Set<String>()
            for issue in issues {
                guard let kind = issue["kind"], let id = issue["id"], kind != "workspace" else { throw FountainOutboxError.access }
                affected.insert(plan.profile + (kind == "database" ? "|database|" : "|") + Self.encodeURIComponent(id))
                if let reason = issue["reason"] { reasons.insert(reason) }
            }
            var removed = false
            let already = Set(changes.filter { $0.op == "delete" }.map { $0.bucket + "|" + $0.encodedKey })
            var affectedOperations = Set(current.filter { $0.resource.map(affected.contains) == true && $0.bucket == "mutations" }.compactMap { $0.value?["id"] as? String })
            var expanding = true
            while expanding {
                expanding = false
                for item in current where item.bucket == "mutations" {
                    guard let operation = item.value?["operation"] as? [String: Any], let id = item.value?["id"] as? String else { continue }
                    let dependencies = operation["depends_on"] as? [String] ?? []
                    let after = (operation["base_rows"] as? [String: [String: Any]] ?? [:]).values.compactMap { $0["after_operation"] as? String }
                    if !affectedOperations.contains(id), dependencies.contains(where: affectedOperations.contains) || after.contains(where: affectedOperations.contains) { affectedOperations.insert(id); expanding = true; if let resource = item.resource { affected.insert(resource) } }
                }
            }
            for item in current where !already.contains(item.bucket + "|" + item.encodedKey) && ["operations", "drafts", "mutations", "localPages", "transfers"].contains(item.bucket) {
                if item.resource.map(affected.contains) == true || (item.value?["id"] as? String).map(affectedOperations.contains) == true {
                    changes.removeAll { $0.bucket == item.bucket && $0.encodedKey == item.encodedKey }
                    try remove(item, reason: "dependency_conflict"); removed = true
                }
            }
            for item in current where item.bucket == "snapshots" && item.resource.map(affected.contains) == true && item.resource.flatMap({ fresh[$0] }) == nil && !already.contains(item.bucket + "|" + item.encodedKey) {
                preserve.append(item); changes.append(try change(["op": "delete", "bucket": item.bucket, "key": decode(Data(item.encodedKey.utf8))])); removed = true
            }
            guard removed else { throw FountainOutboxError.access }
            issues = try accessIssues(plan.profile, overlay: changes).issues
        }
        guard issues.isEmpty, changes.count <= 100000 else { throw FountainOutboxError.limit }
        let deleted = Set(changes.filter { $0.op == "delete" }.map { $0.bucket + "|" + $0.encodedKey })
        let inputBuckets = Set(["operations", "drafts", "mutations", "localPages", "transfers"])
        var qualified = Set<String>()
        for item in current where try confirmedRecord(item, profile: plan.profile) { qualified.insert(item.bucket + "|" + item.encodedKey) }
        let quarantined = Set(preserve.filter { inputBuckets.contains($0.bucket) && deleted.contains($0.bucket + "|" + $0.encodedKey) && qualified.contains($0.bucket + "|" + $0.encodedKey) }.map { $0.bucket + "|" + $0.encodedKey })
        counts["quarantine"] = quarantined.count
        counts["acknowledge"] = current.filter { $0.bucket == "operations" && deleted.contains($0.bucket + "|" + $0.encodedKey) && !quarantined.contains($0.bucket + "|" + $0.encodedKey) }.count
        let rewritten = Set(changes.filter { $0.op == "put" }.map { $0.bucket + "|" + $0.encodedKey })
        counts["keep"] = current.filter { inputBuckets.contains($0.bucket) && !deleted.contains($0.bucket + "|" + $0.encodedKey) && !rewritten.contains($0.bucket + "|" + $0.encodedKey) && !(($0.value?["draft"] as? [String: Any])?["reason"] as? String == "basis") }.count
        var bytes = 0
        for item in changes + preserve { bytes += item.payload?.count ?? 0; guard bytes <= transactionLimit else { throw FountainOutboxError.limit } }
        plan.changes = changes; plan.preserve = preserve
        let checksum = Self.hash(try json([plan.id, UUID().uuidString, plan.mode, counts, reasons.sorted()] as [Any]))
        let ready: [String: Any] = ["state": "ready", "planId": plan.id, "lease": plan.lease, "baseHead": plan.head, "proofEpoch": plan.proof, "expiresAt": plan.expiresAt, "checksum": checksum, "counts": counts, "reasons": reasons.sorted(), "requiresConfirmation": plan.mode != "current" || counts["quarantine", default: 0] > 0]
        let manifest = try json(["planId": plan.id, "profile": plan.profile, "source": plan.source, "ready": ready,
                                 "changes": changes.map { ["op": $0.op, "bucket": $0.bucket, "key": $0.encodedKey, "digest": $0.payload.map(Self.hash) ?? ""] },
                                 "preserve": preserve.map { ["bucket": $0.bucket, "key": $0.encodedKey, "digest": $0.payload.map(Self.hash) ?? ""] }])
        plan.manifest = (try planWrite(manifest, plan: plan, name: "manifest.json"), Self.hash(manifest))
        try transaction {
            try self.checkReconciliation(plan)
            try self.setControl("reconcileReady:" + plan.id, ["profile": plan.profile, "sessionRef": plan.sessionRef, "lease": plan.lease,
                                                           "baseHead": plan.head, "proofEpoch": plan.proof, "checksum": checksum])
        }
        plan.ready = ready
        return ready
    }
    func reconcile(_ input: [String: Any], admissionWatermark: Int, sessionRef: String?) throws -> [String: Any] {
        guard try identity()["offline"] as? Bool != true || ["settle", "cancel"].contains(input["phase"] as? String ?? "") else { throw FountainOutboxError.access }
        #if DEBUG
        let diagnostic = input["phase"] as? String ?? "invalid"
        Self.storagePhase(diagnostic == "prepare" ? (input["planId"] == nil ? "prepare-initial" : "prepare-continued") : (["commit", "cancel", "settle"].contains(diagnostic) ? "reconcile-" + diagnostic : "reconcile-invalid"))
        #endif
        _ = try checkedInteger(input["generation"])
        guard let phase = input["phase"] as? String else { throw FountainOutboxError.invalid }
        if phase == "cancel" {
            guard Set(input.keys) == Set(["generation", "phase", "planId"]), let id = input["planId"] as? String else { throw FountainOutboxError.invalid }
            let current = try identity(), reference = sessionRef ?? "local-no-cookie"
            if let plan = reconciliation, plan.id == id {
                guard current["profileId"] as? String == plan.profile, current["sessionRef"] as? String == reference, reference == plan.sessionRef,
                      owner == plan.owner, authEpoch == plan.auth else { throw FountainOutboxError.stale }
                cancelReconciliation()
            } else {
                // An already closed/committed preparation has no transform to
                // undo. Qualify only the current private caller and acknowledge
                // a generic no-op without revealing old registry metadata.
                _ = try verifiedProfile()
                guard current["sessionRef"] as? String == reference, owner != nil, authEpoch != nil, lease != nil else { throw FountainOutboxError.stale }
            }
            return ["state": "cancelled", "planId": id]
        }
        guard let lease = input["lease"] as? String else { throw FountainOutboxError.invalid }; try checkLease(lease)
        if phase == "settle" { return try settleReconciliation(input, sessionRef: sessionRef) }
        if phase == "commit" { return try commitReconciliation(input, sessionRef: sessionRef) }
        guard phase == "prepare" else { throw FountainOutboxError.invalid }
        if let id = input["planId"] as? String {
            guard Set(input.keys) == Set(["generation", "phase", "lease", "planId"]), let plan = reconciliation, plan.id == id else { throw FountainOutboxError.stale }
            do {
                try checkReconciliation(plan)
                if let ready = plan.ready { return ready }
                if plan.captures["workspace:workspace"] == nil { return try collecting(plan) }
                guard let workspace = try captured("workspace:workspace", plan: plan) else { throw FountainOutboxError.access }
                try expandReconciliation(plan, workspace: workspace)
                if plan.required.keys.contains(where: { plan.captures[$0] == nil }) { return try collecting(plan) }
                let countBefore = plan.required.count; try expandReconciliation(plan, workspace: workspace)
                if countBefore != plan.required.count { return try collecting(plan) }
                let finalFloor = try floor(plan.profile)
                let stable = try plan.required.keys.allSatisfy { key in
                    guard let body = try captured(key, plan: plan) else { return true }
                    if key.hasPrefix("attachment:") { return true }
                    let access = try checkedInteger(body["access_revision"]), data = try checkedInteger(body["data_revision"])
                    return access == finalFloor["access"] && data == finalFloor["data"]
                }
                if !stable {
                    guard plan.sweep == 1 else { throw FountainOutboxError.retry }
                    for captured in plan.captures.values { try FileManager.default.removeItem(at: captured.1) }
                    plan.sweep = 2; plan.captures.removeAll(); plan.admissions.removeAll(); plan.totalBytes = 0
                    return try collecting(plan)
                }
                return try finalizeReconciliation(plan)
            } catch { cancelReconciliation(); throw error }
        }
        guard let mode = input["mode"] as? String, ["current", "upgrade", "promote"].contains(mode),
              Set(input.keys) == Set(mode == "current" ? ["generation", "phase", "lease", "baseHead", "proofEpoch", "mode"] : ["generation", "phase", "lease", "baseHead", "proofEpoch", "mode", "handles"]) else { throw FountainOutboxError.invalid }
        let profile = try verifiedProfile(), grant = try identity()
        guard try checkedInteger(input["baseHead"]) == head(), try checkedInteger(input["proofEpoch"]) == proofEpoch(),
              grant["sessionRef"] as? String == (sessionRef ?? "local-no-cookie"), let owner = owner, let auth = authEpoch else { throw FountainOutboxError.stale }
        var selected: [ArchiveHandle] = []
        if mode != "current" {
            guard let handles = input["handles"] as? [String], !handles.isEmpty, handles.count <= 100, Set(handles).count == handles.count else { throw FountainOutboxError.invalid }
            let actorPrefix = (try profileParts(profile)).prefix(3).joined(separator: "|") + "|"
            for handle in handles {
                guard let selection = reconciliationArchives[handle], selection.owner == owner, selection.auth == auth, selection.lease == lease,
                      selection.expiresAt > Date().timeIntervalSince1970 * 1000, selection.profile.hasPrefix(actorPrefix),
                      mode != "upgrade" || selection.kind == "upgrade", try archiveDigest(selection.rows, profile: selection.profile) == selection.digest else { throw FountainOutboxError.stale }
                selected.append(selection)
            }
        }
        cancelReconciliation()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("FountainReconcile-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        let plan = ReconciliationPlan(directory: directory, profile: profile, lease: lease, owner: owner, auth: auth, sessionRef: grant["sessionRef"] as! String, mode: mode, expiresAt: min(grant["validUntil"] as? Double ?? 0, Date().timeIntervalSince1970 * 1000 + 120000).rounded(.down), watermark: admissionWatermark, head: try head(), proof: try proofEpoch(), source: try reconcileSource(profile))
        plan.selected = selected
        reconciliation = plan
        return try collecting(plan)
    }
    private func settleReconciliation(_ input: [String: Any], sessionRef: String?) throws -> [String: Any] {
        guard Set(input.keys) == Set(input["reconciliations"] == nil ? ["generation", "phase", "lease", "journals"] : ["generation", "phase", "lease", "journals", "reconciliations"]), let entries = input["journals"] as? [[String: Any]], entries.count <= 100,
              let lease = input["lease"] as? String else { throw FountainOutboxError.invalid }
        let reconciliationInputs: [[String: Any]]
        if let supplied = input["reconciliations"] { guard let supplied = supplied as? [[String: Any]] else { throw FountainOutboxError.invalid }; reconciliationInputs = supplied }
        else { reconciliationInputs = [] }
        guard entries.count + reconciliationInputs.count <= 100 else { throw FountainOutboxError.limit }
        if try availableProfile() == nil {
            // Only exact accepted terminal receipts may cross their own
            // suspension. Unknown/unaccepted plans and journals stay blocked.
            guard !entries.isEmpty, reconciliationInputs.isEmpty else { throw FountainOutboxError.access }
            return try transaction {
                try self.checkLease(lease)
                var results: [[String: Any]] = [], seen = Set<String>()
                for entry in entries {
                    guard Set(entry.keys) == Set(["txId", "digest", "baseHead", "proofEpoch"]), let tx = entry["txId"] as? String, !tx.isEmpty, tx.utf8.count <= 160, seen.insert(tx).inserted,
                          let digest = entry["digest"] as? String, digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                          let receipt = try self.terminalReceipt(tx, baseHead: self.checkedInteger(entry["baseHead"]), proofEpoch: self.checkedInteger(entry["proofEpoch"]), digest: digest, sessionRef: sessionRef) else { throw FountainOutboxError.access }
                    results.append(["txId": tx, "digest": digest, "status": "accepted", "head": receipt["head"]!, "proofEpoch": receipt["proofEpoch"]!])
                }
                return ["generation": input["generation"]!, "state": "settled", "lease": lease, "settlements": results]
            }
        }
        let profile = try verifiedProfile()
        guard try identity()["sessionRef"] as? String == (sessionRef ?? "local-no-cookie") else { throw FountainOutboxError.stale }
        var closeAfterCommit = false
        let settled = try transaction { () throws -> [String: Any] in
            try self.checkLease(lease)
            guard try self.verifiedProfile() == profile else { throw FountainOutboxError.stale }
            var results: [[String: Any]] = [], seen = Set<String>()
            var closePreparation = false
            for entry in entries {
                guard Set(entry.keys) == Set(["txId", "digest", "baseHead", "proofEpoch"]), let tx = entry["txId"] as? String, !tx.isEmpty, tx.utf8.count <= 160, seen.insert(tx).inserted,
                      let digest = entry["digest"] as? String, digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw FountainOutboxError.invalid }
                let base = try self.checkedInteger(entry["baseHead"]), proof = try self.checkedInteger(entry["proofEpoch"])
                if let receipt = try self.rows("SELECT digest,head FROM tx_receipts WHERE tx_id=?", [tx]).first {
                    guard try self.control("receiptOwner:" + tx) as? String == profile, receipt[0] as? String == digest,
                          receipt[1] as? Int == base + 1, try self.control("receiptProof:" + tx) as? Int == proof else { throw FountainOutboxError.conflict }
                    results.append(["txId": tx, "digest": digest, "status": "accepted", "head": receipt[1], "proofEpoch": proof])
                } else {
                    guard try self.control("stagedOwner:" + tx) as? String == profile, try self.control("stagedProof:" + tx) as? Int == proof,
                          let first = try self.rows("SELECT base_head FROM staging WHERE tx_id=? ORDER BY part LIMIT 1", [tx]).first, first[0] as? Int == base else { throw FountainOutboxError.access }
                    let key = "cancelledTx:" + profile + ":" + tx
                    if let previous = try self.control(key) as? [String: Any] { guard previous["digest"] as? String == digest else { throw FountainOutboxError.conflict } }
                    try self.setControl(key, ["digest": digest, "baseHead": base, "proofEpoch": proof])
                    closePreparation = true
                    results.append(["txId": tx, "digest": digest, "status": "unaccepted"])
                }
            }
            var reconciliations: [[String: Any]] = [], plans = Set<String>()
            for caps in reconciliationInputs {
                guard Set(caps.keys) == Set(["planId", "checksum", "lease", "baseHead", "proofEpoch"]), let id = caps["planId"] as? String, !id.isEmpty, id.utf8.count <= 160, plans.insert(id).inserted,
                      let checksum = caps["checksum"] as? String, checksum.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                      let originalLease = caps["lease"] as? String, let registry = try self.control("reconcileReady:" + id) as? [String: Any],
                      registry["profile"] as? String == profile, registry["sessionRef"] as? String == (sessionRef ?? "local-no-cookie"), registry["lease"] as? String == originalLease,
                      registry["checksum"] as? String == checksum, registry["baseHead"] as? Int == (try self.checkedInteger(caps["baseHead"])), registry["proofEpoch"] as? Int == (try self.checkedInteger(caps["proofEpoch"])) else { throw FountainOutboxError.access }
                if let accepted = try self.control("reconcileReceipt:" + id) as? [String: Any] {
                    guard accepted["profileId"] as? String == profile, accepted["sessionRef"] as? String == (sessionRef ?? "local-no-cookie"), accepted["checksum"] as? String == checksum,
                          let result = accepted["result"] as? [String: Any], let receipt = result["receipt"] as? [String: Any], let target = result["head"] as? Int, let proof = result["proofEpoch"] as? Int else { throw FountainOutboxError.storage }
                    reconciliations.append(["planId": id, "checksum": checksum, "status": "accepted", "head": target, "proofEpoch": proof, "receipt": receipt])
                } else {
                    try self.setControl("cancelledReconcile:" + profile + ":" + id, caps)
                    if self.reconciliation?.id == id { closePreparation = true }
                    reconciliations.append(["planId": id, "checksum": checksum, "status": "unaccepted"])
                }
            }
            closeAfterCommit = closePreparation
            var result: [String: Any] = ["state": "settled", "lease": lease, "settlements": results]
            if input["reconciliations"] != nil { result["reconciliations"] = reconciliations }
            return result
        }
        // The durable cancellation fence is inside the transaction. Physical
        // prepared-file cleanup follows successful COMMIT so rollback retains
        // the old private plan and its captures intact.
        if closeAfterCommit { cancelReconciliation() }
        return settled
    }
    private func commitReconciliation(_ input: [String: Any], sessionRef: String?) throws -> [String: Any] {
        guard Set(input.keys) == Set(["generation", "phase", "lease", "baseHead", "proofEpoch", "planId", "checksum", "confirm"]),
              let id = input["planId"] as? String, let suppliedLease = input["lease"] as? String, let checksum = input["checksum"] as? String,
              let confirmed = Self.boolean(input["confirm"]) else { throw FountainOutboxError.invalid }
        let profile = try verifiedProfile()
        guard try identity()["sessionRef"] as? String == (sessionRef ?? "local-no-cookie") else { throw FountainOutboxError.stale }
        if let receipt = try control("reconcileReceipt:" + id) as? [String: Any] {
            guard receipt["profileId"] as? String == profile, receipt["owner"] as? String == owner, receipt["auth"] as? Int == authEpoch,
                  receipt["lease"] as? String == suppliedLease, receipt["checksum"] as? String == checksum,
                  receipt["sourceHead"] as? Int == (try checkedInteger(input["baseHead"])), receipt["sourceProof"] as? Int == (try checkedInteger(input["proofEpoch"])),
                  let result = receipt["result"] as? [String: Any] else { throw FountainOutboxError.conflict }
            return result
        }
        guard let plan = reconciliation, plan.id == id, let ready = plan.ready, ready["checksum"] as? String == checksum else { throw FountainOutboxError.stale }
        try checkReconciliation(plan)
        guard let manifest = plan.manifest else { throw FountainOutboxError.storage }
        try Self.privateItem(manifest.0, directory: false)
        guard Self.hash(try Data(contentsOf: manifest.0)) == manifest.1 else { throw FountainOutboxError.storage }
        guard try checkedInteger(input["baseHead"]) == plan.head, try checkedInteger(input["proofEpoch"]) == plan.proof else { throw FountainOutboxError.head }
        if ready["requiresConfirmation"] as? Bool == true && !confirmed { throw FountainOutboxError.confirmation }
        let result = try transaction { () throws -> [String: Any] in
            try self.checkReconciliation(plan)
            guard try self.control("cancelledReconcile:" + profile + ":" + id) == nil else { throw FountainOutboxError.conflict }
            let localTargets = plan.mode == "current" ? Set<String>() : try self.newNativeLocalTargets(plan.changes)
            for (position, item) in plan.preserve.enumerated() {
                guard let bytes = item.payload else { throw FountainOutboxError.storage }
                try self.archiveOriginal(item, bytes: bytes, tx: "native-reconcile:" + plan.id, position: position, capturedProfile: profile)
            }
            for item in plan.changes {
                if item.op == "delete" { try self.execute("DELETE FROM records WHERE bucket=? AND key=?", [item.bucket, item.encodedKey]) }
                else { try self.execute("INSERT INTO records(bucket,key,profile_id,resource_key,value) VALUES(?,?,?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET profile_id=excluded.profile_id,resource_key=excluded.resource_key,value=excluded.value", [item.bucket, item.encodedKey, item.profile, item.resource, item.payload]) }
                if item.op == "put" { try self.attributeRecord(item, profile: profile) }
            }
            try self.requireAccess(profile)
            try self.qualifyNativeLocalCreations(profile, targets: localTargets, overlay: [])
            if try self.control("account:" + profile) != nil {
                try self.execute("DELETE FROM control WHERE id IN (?,?)", ["accountNeedsReconcile:" + profile, "accountOfflineDenied:" + profile])
            }
            for item in plan.changes where item.op == "put" { try self.attributeRecord(item, profile: profile) }
            let target = try self.advance()
            let receipt: [String: Any] = ["version": 1, "planId": id, "checksum": checksum, "sourceHead": plan.head, "targetHead": target, "mode": plan.mode, "counts": ready["counts"]!]
            let result: [String: Any] = ["state": "committed", "planId": id, "lease": plan.lease, "head": target, "proofEpoch": plan.proof, "checksum": checksum, "receipt": receipt]
            try self.setControl("reconcileReceipt:" + id, ["profileId": profile, "sessionRef": plan.sessionRef, "owner": plan.owner, "auth": plan.auth, "lease": plan.lease, "checksum": checksum, "sourceHead": plan.head, "sourceProof": plan.proof, "result": result])
            for selection in plan.selected { try self.setControl("promotedArchive:" + profile + ":" + selection.digest, ["planId": id, "head": target]) }
            return result
        }
        boundary = UUID().uuidString; cancelReconciliation()
        return result
    }
}

final class FountainOutbox {
    #if DEBUG
    private static let diagnosticLock = NSLock()
    private static var diagnosticPhase = "other"
    private static var diagnosticStorage: [String: Int] = [:]
    static func qaStorageEvidence() -> [String: Int] { diagnosticLock.lock(); defer { diagnosticLock.unlock() }; return diagnosticStorage }
    private static func storagePhase(_ phase: String) { diagnosticLock.lock(); defer { diagnosticLock.unlock() }; diagnosticPhase = phase }
    private static func recordStorageFailure(_ site: String, database: OpaquePointer?) {
        // Capture the failing connection before synchronization or another API
        // can replace its I/O error. Global errno alone is not a VFS diagnosis.
        let systemError = database.map { Int(sqlite3_system_errno($0)) } ?? 0
        let code = database.map { Int(sqlite3_errcode($0)) } ?? 0
        let extendedCode = database.map { Int(sqlite3_extended_errcode($0)) } ?? 0
        let readOnly = database.map { Int(sqlite3_db_readonly($0, "main")) } ?? -1
        let ambientError = Int(errno)
        diagnosticLock.lock(); defer { diagnosticLock.unlock() }
        guard diagnosticStorage.isEmpty else { return }
        diagnosticStorage = ["storage.phase." + diagnosticPhase: 1, "storage.site." + site: 1,
                             "storage.sqliteCode": code, "storage.sqliteExtendedCode": extendedCode,
                             "storage.sqliteSystemErrno": systemError, "storage.sqliteReadOnly": readOnly,
                             "storage.errno": ambientError]
    }
    #endif
    private func storageFailure(_ site: String) -> FountainOutboxError {
        #if DEBUG
        Self.recordStorageFailure(site, database: database)
        #endif
        return .storage
    }
    private func storageStatement(_ sql: String) -> String {
        if sql == "BEGIN IMMEDIATE" { return "transaction-begin" }
        if sql == "COMMIT" { return "transaction-commit" }
        if sql == "ROLLBACK" { return "transaction-rollback" }
        for table in ["control", "records", "staging", "recovery", "tx_receipts", "tombstones"] {
            if sql.hasPrefix("INSERT INTO " + table) || sql.hasPrefix("INSERT OR IGNORE INTO " + table) { return table + "-insert" }
            if sql.hasPrefix("DELETE FROM " + table) { return table + "-delete" }
            if sql.contains("FROM " + table) { return table + "-read" }
        }
        return "other"
    }
    struct LogoutActor { fileprivate let prefix: String }
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
    private(set) var authorityBoundary = UUID().uuidString
    private(set) var observedProofEpoch = 0
    private var readDeadline: Double?
    private let partLimit = 256 * 1024
    private let recordLimit = 16 * 1024 * 1024
    private let transactionLimit = 64 * 1024 * 1024
    private var httpDeliveryAccess = 0
    private var httpDeliveryResources: [String: String] = [:]
    private var httpDeliveryDenial = UUID().uuidString
    private var reconciliation: ReconciliationPlan?
    #if DEBUG
    private(set) var reconciliationTestReasons: [String] = []
    #endif
    private var reconciliationArchives: [String: ArchiveHandle] = [:]

    convenience init(origin: String) throws {
        try self.init(origin: origin, isolatedDirectory: nil)
    }
    #if DEBUG
    // Native test callers may supply only their own isolated private directory.
    // This initializer is absent from release builds and has no bridge method.
    convenience init(origin: String, testingDirectory: URL) throws {
        try self.init(origin: origin, isolatedDirectory: testingDirectory)
    }
    // Native test-only expiry injection shortens private capabilities. There
    // is no bridge entry and release builds contain no expiry override.
    func expireReconciliationForTesting() {
        reconciliation?.expiresAt = 0
        reconciliationArchives = reconciliationArchives.mapValues { value in
            ArchiveHandle(handle: value.handle, profile: value.profile, kind: value.kind, rows: value.rows, digest: value.digest, expiresAt: 0, owner: value.owner, auth: value.auth, lease: value.lease)
        }
    }
    #endif
    private init(origin: String, isolatedDirectory: URL?) throws {
        self.origin = origin
        let manager = FileManager.default
        var directory: URL
        if let isolatedDirectory = isolatedDirectory { directory = isolatedDirectory }
        else {
            let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).resolvingSymlinksInPath()
            directory = support.appendingPathComponent("FountainOutbox", isDirectory: true)
        }
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
    func close() { cancelReconciliation(); if let database = database { sqlite3_close_v2(database) }; database = nil }
    private static func privateItem(_ url: URL, directory: Bool) throws {
        let info = try FileManager.default.attributesOfItem(atPath: url.path)
        guard info[.type] as? FileAttributeType == (directory ? .typeDirectory : .typeRegular),
              (info[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              (info[.posixPermissions] as? NSNumber)?.intValue == (directory ? 0o700 : 0o600) else {
            #if DEBUG
            Self.recordStorageFailure(directory ? "private-directory" : "private-file", database: nil)
            #endif
            throw FountainOutboxError.storage
        }
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
        guard !poisoned, let database = database else { throw storageFailure("connection-guard") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let prepared = statement else { throw storageFailure("sql-prepare." + storageStatement(sql)) }
        defer { sqlite3_finalize(prepared) }
        for (index, value) in values.enumerated() {
            let status: Int32
            if value == nil || value is NSNull { status = sqlite3_bind_null(prepared, Int32(index + 1)) }
            else if let data = value as? Data {
                status = data.withUnsafeBytes { sqlite3_bind_blob(prepared, Int32(index + 1), $0.baseAddress, Int32(data.count), Self.transient) }
            } else if let value = value as? String { status = sqlite3_bind_text(prepared, Int32(index + 1), value, -1, Self.transient) }
            else if let value = value as? Int { status = sqlite3_bind_int64(prepared, Int32(index + 1), sqlite3_int64(value)) }
            else { throw FountainOutboxError.invalid }
            guard status == SQLITE_OK else { throw storageFailure("sql-bind." + storageStatement(sql)) }
        }
        var result: [[Any]] = []
        while true {
            let status = sqlite3_step(prepared)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW else { throw storageFailure("sql-step." + storageStatement(sql)) }
            var row: [Any] = []
            for column in 0..<sqlite3_column_count(prepared) {
                switch sqlite3_column_type(prepared, column) {
                case SQLITE_INTEGER: row.append(Int(sqlite3_column_int64(prepared, column)))
                case SQLITE_TEXT: row.append(String(cString: sqlite3_column_text(prepared, column)))
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(prepared, column))
                    if count == 0 { row.append(Data()) }
                    else if let bytes = sqlite3_column_blob(prepared, column) { row.append(Data(bytes: bytes, count: count)) }
                    else { throw storageFailure("sql-blob") }
                case SQLITE_NULL: row.append(NSNull())
                default: throw storageFailure("sql-column-type")
                }
            }
            result.append(row)
        }
    }
    private func integer(_ sql: String, _ values: [Any?] = []) throws -> Int { try rows(sql, values).first?.first as? Int ?? 0 }
    // Never materialize the whole business cache to preflight or quarantine it.
    private func eachRecord(_ sql: String, _ parameter: String, _ visit: (String, String, Data) throws -> Void) throws {
        guard !poisoned, let database = database else { throw storageFailure("record-connection") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let prepared = statement else { throw storageFailure("record-prepare") }
        defer { sqlite3_finalize(prepared) }
        guard sqlite3_bind_text(prepared, 1, parameter, -1, Self.transient) == SQLITE_OK else { throw storageFailure("record-bind") }
        while true {
            let status = sqlite3_step(prepared)
            if status == SQLITE_DONE { return }
            guard status == SQLITE_ROW, let bucket = sqlite3_column_text(prepared, 0), let key = sqlite3_column_text(prepared, 1) else { throw storageFailure("record-step") }
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
            guard sqlite3_get_autocommit(database) != 0 else { throw storageFailure("transaction-autocommit") }
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
    private func pointerKeys(_ profile: String) throws -> [String] {
        if let parent = try control("account:" + profile) as? String {
            let parts = try profileParts(profile)
            return ["active:", "last-profile:"].map { $0 + parent + ":" + parts[1].removingPercentEncoding! }
        }
        return ["active", "last-profile"]
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
              try integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile]) == 0,
              try control("suspended:" + profile) == nil else { throw FountainOutboxError.blocked }
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
            // Old batches retain their original lease; never rebind or erase input.
        }
        self.owner = owner; authEpoch = epoch; lease = next
        boundary = UUID().uuidString; rotateHTTPAuthority()
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
                "accessIssues": Array(issues.prefix(100)), "accessIssuesTruncated": issues.count > 100,
                "reconciliationHandles": try current.map { try reconciliationHandles($0) } ?? []]
    }

    // Native caller supplies only its private current/pending cookie hash.
    func validateSession(_ reference: String?, eligible: Bool, beforeMutation: (() -> Void)? = nil) throws {
        let value = try identity()
        if value["state"] as? String == "verified" {
            let suspended = try (value["profileId"] as? String).map { try control("suspended:" + $0) != nil } ?? false
            if !eligible || reference == nil || value["sessionRef"] as? String != reference || suspended { beforeMutation?(); try suspend() }
            else if (value["validUntil"] as? Double ?? 0) <= Date().timeIntervalSince1970 * 1000 { beforeMutation?(); try expireGrant() }
        }
    }
    private func expireGrant() throws {
        cancelReconciliation()
        try transaction {
            var value = try self.identity()
            guard let profile = value["profileId"] as? String, value["grantExpired"] as? Bool != true else { return }
            value["state"] = "blocked"; value["grantExpired"] = true; value["needsFloor"] = true
            try self.setControl("identity", value); try self.setControl("proofs:" + profile, [:]); try self.advanceProof()
        }
        readDeadline = nil; boundary = UUID().uuidString; rotateHTTPAuthority()
    }
    private func markSuspended(_ profile: String) throws {
        _ = try profileParts(profile)
        try setControl("suspended:" + profile, true)
        try setControl("proofs:" + profile, [:])
        var value = try identity()
        if value["profileId"] as? String == profile {
            value["state"] = "blocked"; value["needsFloor"] = true
            try setControl("identity", value)
        }
    }
    func suspend() throws {
        var changed = false
        try transaction {
            var value = try self.identity()
            if let profile = value["profileId"] as? String {
                let marker = try self.control("suspended:" + profile)
                changed = value["state"] as? String == "verified" || marker == nil
                try self.markSuspended(profile)
            } else if value["state"] as? String != "unknown" { value["state"] = "blocked"; try self.setControl("identity", value) }
            if changed { _ = try self.advance(); try self.advanceProof() }
        }
        owner = nil; authEpoch = nil; lease = nil; readDeadline = nil
        boundary = UUID().uuidString; rotateHTTPAuthority()
    }
    // Switching is durable parking, never revocation. A parked profile cannot
    // provide leases or HTTP proofs until a fresh native session is reconciled.
    func parkAccount() throws {
        cancelReconciliation()
        try transaction {
            let value = try self.identity()
            if let profile = value["profileId"] as? String, try self.control("account:" + profile) != nil {
                try self.setControl("parked:" + profile, value)
                try self.setControl("parkedProofs:" + profile, try self.control("proofs:" + profile) ?? [:])
                try self.setControl("proofs:" + profile, [:])
                try self.setControl("identity", ["state": "parked"])
                try self.advanceProof()
            }
        }
        owner = nil; authEpoch = nil; lease = nil; readDeadline = nil
        boundary = UUID().uuidString; rotateHTTPAuthority()
    }
    func suspendAccounts() throws {
        cancelReconciliation()
        try transaction {
            let profiles = try self.rows("SELECT substr(id,9) FROM control WHERE substr(id,1,8)='account:'").compactMap { $0[0] as? String }
            for profile in profiles { try self.markSuspended(profile) }
            let current = try self.identity()
            if let profile = current["profileId"] as? String, profiles.contains(profile) { try self.setControl("identity", ["state": "blocked"]) }
            _ = try self.advance(); try self.advanceProof()
        }
        owner = nil; authEpoch = nil; lease = nil; readDeadline = nil
        boundary = UUID().uuidString; rotateHTTPAuthority()
    }
    func denyAccount(workspace: String, binding: String, parentBinding: String) throws {
        var currentAffected = false
        try transaction {
            let current = try self.identity()["profileId"] as? String
            for row in try self.rows("SELECT substr(id,9),value FROM control WHERE substr(id,1,8)='account:'") {
                guard let profile = row[0] as? String, let bytes = row[1] as? Data,
                      try self.decode(bytes) as? String == parentBinding else { continue }
                let parts = try self.profileParts(profile)
                if parts[1].removingPercentEncoding == workspace && parts[3].removingPercentEncoding == binding {
                    try self.markSuspended(profile)
                    currentAffected = currentAffected || current == profile
                }
            }
            if currentAffected { try self.advanceProof() }
        }
        if currentAffected { readDeadline = nil; boundary = UUID().uuidString; rotateHTTPAuthority() }
    }
    // A directory success is negative evidence about a previous cached scope.
    // It cannot grant the new child or extend any lease, proof or cache TTL.
    func observeAccountSelection(_ body: [String: Any], parentBinding: String) throws -> Bool {
        guard let workspace = body["workspace_id"] as? String, let member = body["member"] as? [String: Any], let actor = member["id"] as? String,
              let binding = body["cache_binding"] as? String, body["account_binding"] as? String == parentBinding else { throw FountainOutboxError.access }
        var currentAffected = false
        try transaction {
            let current = try self.identity()["profileId"] as? String
            for row in try self.rows("SELECT substr(id,9),value FROM control WHERE substr(id,1,8)='account:'") {
                guard let profile = row[0] as? String, let bytes = row[1] as? Data,
                      try self.decode(bytes) as? String == parentBinding else { continue }
                let parts = try self.profileParts(profile)
                guard parts[1].removingPercentEncoding == workspace else { continue }
                var changed = false
                if parts[2].removingPercentEncoding != actor || parts[3].removingPercentEncoding != binding {
                    try self.markSuspended(profile); changed = true
                } else if let previous = try self.control("nativeSession:" + profile) as? [String: Any], let oldMember = previous["member"] as? [String: Any] {
                    let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                    func deadline(_ raw: Any?) -> Double { guard let raw = raw as? String else { return 0 }; return (parser.date(from: raw) ?? ISO8601DateFormatter().date(from: raw))?.timeIntervalSince1970 ?? 0 }
                    changed = oldMember["role"] as? String != member["role"] as? String || Self.boolean(oldMember["active"]) != Self.boolean(member["active"]) || deadline(body["expires_at"]) < deadline(previous["expires_at"])
                    if changed {
                        try self.execute("DELETE FROM control WHERE id IN (?,?)", ["sealedAccount:" + profile, "parkedProofs:" + profile])
                        try self.setControl("accountOfflineDenied:" + profile, true)
                        try self.setControl("accountNeedsReconcile:" + profile, true)
                        try self.setControl("proofs:" + profile, [:])
                        if current == profile { var identity = try self.identity(); identity["needsFloor"] = true; try self.setControl("identity", identity) }
                    }
                }
                currentAffected = currentAffected || (changed && current == profile)
            }
            if currentAffected { try self.advanceProof() }
        }
        if currentAffected { readDeadline = nil; boundary = UUID().uuidString; rotateHTTPAuthority() }
        return currentAffected
    }
    func activateAccount(_ body: [String: Any], sessionRef: String, parentBinding: String, requireReconcile: Bool = true) throws {
        guard let workspace = body["workspace_id"] as? String, let member = body["member"] as? [String: Any],
              let actor = member["id"] as? String, let binding = body["cache_binding"] as? String,
              body["account_binding"] as? String == parentBinding else { throw FountainOutboxError.blocked }
        let profile = origin + "|" + [workspace, actor, binding].map(Self.encodeURIComponent).joined(separator: "|")
        try transaction {
            guard try self.control("suspended:" + profile) == nil,
                  try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile]) == 0 else { throw FountainOutboxError.access }
            if let parent = try self.control("account:" + profile) as? String, parent != parentBinding { throw FountainOutboxError.access }
            // A fresh native server verification of the same workspace with a
            // different member/child incarnation permanently fences old input.
            for row in try self.rows("SELECT substr(id,9),value FROM control WHERE substr(id,1,8)='account:'") {
                guard let old = row[0] as? String, old != profile, let bytes = row[1] as? Data,
                      try self.decode(bytes) as? String == parentBinding else { continue }
                if try self.profileParts(old)[1].removingPercentEncoding == workspace { try self.markSuspended(old) }
            }
            if var parked = try self.control("parked:" + profile) as? [String: Any] {
                guard parked["sessionRef"] as? String == sessionRef,
                      (parked["validUntil"] as? Double ?? 0) > Date().timeIntervalSince1970 * 1000 else { throw FountainOutboxError.access }
                parked["state"] = "verified"; parked["needsFloor"] = true; parked.removeValue(forKey: "offline")
                try self.setControl("identity", parked)
                try self.setControl("proofs:" + profile, [:])
                try self.execute("DELETE FROM control WHERE id=?", ["parked:" + profile])
                try self.advanceProof()
            }
            try self.setControl("account:" + profile, parentBinding)
        }
        let proofBeforeGrant = try proofEpoch()
        try grant(body, sessionRef: sessionRef)
        let grantChanged = try proofEpoch() != proofBeforeGrant
        try transaction {
            var current = try self.identity(); current.removeValue(forKey: "offline")
            try self.setControl("identity", current)
            try self.setControl("sealedAccount:" + profile, ["session": body, "reference": sessionRef, "parent": parentBinding])
            if requireReconcile || grantChanged { try self.setControl("accountNeedsReconcile:" + profile, true) }
        }
    }
    func accountCanTransmit() throws -> Bool {
        let identity = try self.identity()
        guard let profile = identity["profileId"] as? String, try control("account:" + profile) != nil else { return true }
        let pending = try control("accountNeedsReconcile:" + profile), denied = try control("accountOfflineDenied:" + profile)
        return identity["offline"] as? Bool != true && identity["needsFloor"] as? Bool != true && pending == nil && denied == nil
    }
    func retainedAccountScopes(parentBinding: String, sessionRef: String) throws -> [[String: Any]] {
        var result: [[String: Any]] = []
        let now = Date().timeIntervalSince1970 * 1000, live = try identity()
        for row in try rows("SELECT substr(id,15),value FROM control WHERE substr(id,1,14)='sealedAccount:' ORDER BY id LIMIT 100") {
            guard let profile = row[0] as? String, let bytes = row[1] as? Data,
                  let sealed = try decode(bytes) as? [String: Any], sealed["parent"] as? String == parentBinding, sealed["reference"] as? String == sessionRef,
                  try control("account:" + profile) as? String == parentBinding, try control("suspended:" + profile) == nil, try control("accountOfflineDenied:" + profile) == nil,
                  try integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile]) == 0,
                  let session = sealed["session"] as? [String: Any], let rawExpiry = session["expires_at"] as? String,
                  let member = session["member"] as? [String: Any], Self.boolean(member["active"]) == true else { continue }
            guard let saved = try control("parked:" + profile) as? [String: Any] ?? (live["profileId"] as? String == profile ? live : nil),
                  saved["state"] as? String == "verified", saved["sessionRef"] as? String == sessionRef, (saved["validUntil"] as? Double ?? 0) > now else { continue }
            let parts = try profileParts(profile), workspace = parts[1].removingPercentEncoding!, actor = parts[2].removingPercentEncoding!, binding = parts[3].removingPercentEncoding!
            guard session["workspace_id"] as? String == workspace, member["id"] as? String == actor, session["cache_binding"] as? String == binding, session["account_binding"] as? String == parentBinding else { continue }
            let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = parser.date(from: rawExpiry) ?? ISO8601DateFormatter().date(from: rawExpiry), date.timeIntervalSince1970 * 1000 > now else { continue }
            result.append(["workspaceId": workspace, "memberId": actor, "binding": binding, "accountBinding": parentBinding, "expiresAt": (date.timeIntervalSince1970 * 1000).rounded(.down)])
        }
        return result
    }
    func resumeAccountOffline(_ body: [String: Any], sessionRef: String, parentBinding: String) throws {
        guard let workspace = body["workspace_id"] as? String, let member = body["member"] as? [String: Any], let actor = member["id"] as? String,
              let binding = body["cache_binding"] as? String, body["account_binding"] as? String == parentBinding else { throw FountainOutboxError.access }
        let profile = origin + "|" + [workspace, actor, binding].map(Self.encodeURIComponent).joined(separator: "|")
        try transaction {
            guard try self.control("account:" + profile) as? String == parentBinding,
                  try self.control("suspended:" + profile) == nil, try self.control("accountOfflineDenied:" + profile) == nil,
                  try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile]) == 0,
                  let sealed = try self.control("sealedAccount:" + profile) as? [String: Any], sealed["reference"] as? String == sessionRef,
                  sealed["parent"] as? String == parentBinding, let session = sealed["session"] as? [String: Any], try self.json(session) == self.json(body) else { throw FountainOutboxError.access }
            let live = try self.identity()
            guard var saved = try self.control("parked:" + profile) as? [String: Any] ?? (live["profileId"] as? String == profile ? live : nil),
                  saved["sessionRef"] as? String == sessionRef,
                  (saved["validUntil"] as? Double ?? 0) > Date().timeIntervalSince1970 * 1000,
                  saved["state"] as? String == "verified" else { throw FountainOutboxError.access }
            saved["offline"] = true; saved["needsFloor"] = true
            try self.setControl("identity", saved)
            try self.setControl("accountNeedsReconcile:" + profile, true)
            if let proofs = try self.control("parkedProofs:" + profile) { try self.setControl("proofs:" + profile, proofs) }
            try self.execute("DELETE FROM control WHERE id=?", ["parked:" + profile])
            try self.advanceProof()
        }
        owner = nil; authEpoch = nil; lease = nil; readDeadline = nil
        boundary = UUID().uuidString; rotateHTTPAuthority()
    }
    func grant(_ body: [String: Any], sessionRef: String?, beforeMutation: (() -> Void)? = nil) throws {
        guard Self.boolean(body["authenticated"]) == true, let member = body["member"] as? [String: Any],
              let active = Self.boolean(member["active"]), ["owner", "admin", "member", "guest"].contains(member["role"] as? String ?? "") else { beforeMutation?(); try suspend(); throw FountainOutboxError.blocked }
        let workspace = try text(body["workspace_id"], limit: 1000), actor = try text(member["id"], limit: 1000), binding = try text(body["cache_binding"], limit: 1000)
        let local = body["mode"] as? String == "local" && Self.boolean(body["required"]) == false && sessionRef == nil
        let now = Date().timeIntervalSince1970 * 1000
        var expiry: Double
        if local { expiry = now + 86_400_000 }
        else {
            guard let raw = body["expires_at"] as? String, sessionRef != nil,
                  ["accounts", "family"].contains(body["mode"] as? String ?? "") else { beforeMutation?(); try suspend(); throw FountainOutboxError.blocked }
            let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = parser.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) else { beforeMutation?(); try suspend(); throw FountainOutboxError.blocked }
            expiry = date.timeIntervalSince1970 * 1000
        }
        expiry = min(expiry, now + 86_400_000).rounded(.down)
        guard expiry > now else { beforeMutation?(); try suspend(); throw FountainOutboxError.access }
        let profile = origin + "|" + [workspace, actor, binding].map(Self.encodeURIComponent).joined(separator: "|")
        let reference = sessionRef ?? "local-no-cookie", previous = try identity()
        var nativeSession: [String: Any] = [:]
        for key in ["authenticated", "required", "mode", "workspace_id", "cache_binding", "expires_at", "account_binding"] { nativeSession[key] = body[key] }
        nativeSession["member"] = member
        let suspendedMarker = try control("suspended:" + profile)
        let revoked = try integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile])
        if suspendedMarker != nil || revoked > 0 { throw FountainOutboxError.access }
        let same = previous["profileId"] as? String == profile
        if same {
            guard previous["state"] as? String == "verified" || previous["permissionBlocked"] as? Bool == true || previous["grantExpired"] as? Bool == true,
                  previous["sessionRef"] as? String == reference,
                  let oldDeadline = previous["validUntil"] as? Double else { beforeMutation?(); try suspend(); throw FountainOutboxError.access }
            let renewing = oldDeadline <= now || previous["grantExpired"] as? Bool == true
            if !renewing { expiry = min(expiry, oldDeadline.rounded(.down)) }
            guard expiry > now else { beforeMutation?(); try suspend(); throw FountainOutboxError.access }
            var oldSemantic = try control("nativeSession:" + profile) as? [String: Any] ?? [:], nextSemantic = nativeSession
            oldSemantic.removeValue(forKey: "expires_at"); nextSemantic.removeValue(forKey: "expires_at")
            if !renewing, expiry == oldDeadline, try json(oldSemantic) == json(nextSemantic) {
                if !active { throw FountainOutboxError.blocked }
                // A live retained bound is unchanged by a server extension or
                // an equivalent expiry spelling. Preserve the exact SQL file.
                return
            }
            cancelReconciliation()
            beforeMutation?()
            let nextLease = lease.map { _ in UUID().uuidString }
            try transaction {
                var value = previous; value["validUntil"] = expiry; value["needsFloor"] = true
                value["state"] = active ? "verified" : "blocked"; value["permissionBlocked"] = !active; value.removeValue(forKey: "grantExpired")
                if let nextLease { try self.setControl("lease", nextLease) }
                try self.setControl("identity", value); try self.setControl("nativeSession:" + profile, nativeSession)
                try self.setControl("proofs:" + profile, [:]); try self.advanceProof()
            }
            lease = nextLease
            readDeadline = nil; boundary = UUID().uuidString; rotateHTTPAuthority()
            if !active { throw FountainOutboxError.blocked }
            return
        }
        guard active else { beforeMutation?(); try suspend(); throw FountainOutboxError.blocked }
        beforeMutation?()
        try transaction {
            if let old = previous["profileId"] as? String { try self.markSuspended(old) }
            try self.setControl("identity", ["state": "verified", "profileId": profile, "validUntil": expiry, "sessionRef": reference, "needsFloor": true])
            try self.setControl("lastProfile", profile); try self.setControl("known:" + profile, true)
            try self.setControl("proofs:" + profile, [:])
            try self.setControl("nativeSession:" + profile, nativeSession)
            _ = try self.advance(); try self.advanceProof()
        }
        owner = nil; authEpoch = nil; lease = nil; readDeadline = nil
        boundary = UUID().uuidString; rotateHTTPAuthority()
    }
    // This opaque actor prefix originates only in a private native grant. Never
    // accept an actor/profile supplied by the renderer as deletion authority.
    func actorForLogout(reference: String) throws -> LogoutActor? {
        let value = try identity()
        guard ["verified", "blocked"].contains(value["state"] as? String ?? ""), value["sessionRef"] as? String == reference,
              let profile = value["profileId"] as? String, try control("known:" + profile) != nil else { return nil }
        return LogoutActor(prefix: try profileParts(profile).prefix(3).joined(separator: "|"))
    }
    func eraseActor(_ captured: LogoutActor) throws {
        let actor = captured.prefix
        let parts = actor.components(separatedBy: "|")
        guard parts.count == 3, parts[0] == origin, parts.dropFirst().allSatisfy({ !$0.isEmpty && $0.removingPercentEncoding.map(Self.encodeURIComponent) == $0 }) else { throw FountainOutboxError.blocked }
        let prefix = actor + "|", quotedPrefix = "\"" + prefix
        try transaction {
            try self.execute("INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) SELECT profile_id,'profile',profile_id FROM records WHERE substr(profile_id,1,length(?))=?", [prefix, prefix])
            try self.execute("INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) SELECT profile_id,'profile',profile_id FROM recovery WHERE substr(profile_id,1,length(?))=?", [prefix, prefix])
            let knownPrefix = "known:" + prefix
            try self.execute("INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) SELECT substr(id,7),'profile',substr(id,7) FROM control WHERE substr(id,1,length(?))=?", [knownPrefix, knownPrefix])
            try self.eraseAttributedRows(actor: actor)
            try self.execute("DELETE FROM staging WHERE tx_id IN (SELECT substr(id,13) FROM control WHERE substr(id,1,12)='stagedOwner:' AND substr(CAST(value AS TEXT),1,length(?))=?)", [quotedPrefix, quotedPrefix])
            try self.execute("DELETE FROM tx_receipts WHERE tx_id IN (SELECT substr(id,14) FROM control WHERE substr(id,1,13)='receiptOwner:' AND substr(CAST(value AS TEXT),1,length(?))=?)", [quotedPrefix, quotedPrefix])
            for kind in ["proofs:", "proofFloor:", "nativeSession:"] {
                let controlPrefix = kind + prefix
                try self.execute("DELETE FROM control WHERE substr(id,1,length(?))=?", [controlPrefix, controlPrefix])
            }
            let identity = try self.identity()
            if let profile = identity["profileId"] as? String, profile.hasPrefix(prefix) { try self.markSuspended(profile) }
            _ = try self.advance(); try self.advanceProof()
        }
        owner = nil; authEpoch = nil; lease = nil; readDeadline = nil; boundary = UUID().uuidString
    }
    func revocationConfirmed() throws -> Bool { try identity()["state"] as? String != "verified" }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    // Only this native HTTP observer can write evidence. Renderer deltas cannot.
    static func canonicalResource(path: String, method: String) -> (String, String)? {
        guard method == "GET" || method == "POST", !path.contains("?"), !path.contains("#") else { return nil }
        if method == "GET", path == "/api/workspace" { return ("workspace", "workspace") }
        let parts = path.components(separatedBy: "/")
        let kind: String
        if method == "GET", parts.count == 4 && parts[1] == "api" && parts[2] == "databases" { kind = "database" }
        else if parts.count == 5 && parts[1] == "api" && parts[2] == "pages" &&
            ((method == "GET" && parts[4] == "collaboration") || (method == "POST" && parts[4] == "operations")) { kind = "page" }
        else { return nil }
        guard let id = parts[3].removingPercentEncoding, !id.isEmpty, id.utf8.count <= 1000,
              ![".", ".."].contains(id), !id.contains("/"), !id.contains("\\"),
              !id.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        if method == "POST", !parts[0].isEmpty || Self.encodeURIComponent(id) != parts[3] { return nil }
        return (kind, id)
    }
    static func observedResource(path: String, method: String, status: Int) -> (String, String)? {
        guard (method == "GET" && [200, 403, 404].contains(status)) || (method == "POST" && status == 200) else { return nil }
        return canonicalResource(path: path, method: method)
    }
    private func validateAcknowledgements(_ value: Any?) throws {
        guard let values = value as? [String], values.count <= 1000 else { throw FountainOutboxError.invalid }
        for value in values {
            let parts = value.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 2, (1...80).contains(parts[0].utf8.count),
                  parts[0].utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }),
                  (1...16).contains(parts[1].utf8.count), parts[1].utf8.allSatisfy({ (48...57).contains($0) }),
                  let clock = Int(parts[1]), clock > 0, clock <= 9_007_199_254_740_991,
                  String(clock) == parts[1] else { throw FountainOutboxError.invalid }
        }
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
        guard let (kind, id) = Self.observedResource(path: path, method: method, status: status) else { return }
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
            noteHTTPProof(key, denied: true)
            boundary = UUID().uuidString
            return
        }
        // Actual denials are terminal within this login, including late 200s
        // already in flight when the resource was revoked. Malformed successes
        // have only an invalid marker and may be replaced by a fresh valid GET.
        if ledger[proofKey("workspace", "workspace")]?["denied"] as? Bool == true || ledger[key]?["denied"] as? Bool == true { throw FountainOutboxError.access }
        if kind != "workspace", try integer("SELECT count(*) FROM tombstones WHERE scope=?", [profile + (kind == "database" ? "|database|" : "|") + Self.encodeURIComponent(id)]) > 0 { throw FountainOutboxError.access }
        do {
            if method == "POST", data.count > recordLimit { throw FountainOutboxError.invalid }
            guard let body = try decode(data) as? [String: Any],
                  body["workspace_id"] as? String == parts[1].removingPercentEncoding,
                  body["current_member_id"] as? String == parts[2].removingPercentEncoding,
                  body["session_binding"] as? String == parts[3].removingPercentEncoding else { throw FountainOutboxError.invalid }
            if method == "POST" { try validateAcknowledgements(body["ack"]) }
            let access = try checkedInteger(body["access_revision"]), revision = try checkedInteger(body["data_revision"])
            httpDeliveryAccess = max(httpDeliveryAccess, access)
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
                if let spaces = body["teamspaces"] as? [[String: Any]] {
                    guard spaces.count <= 100000 else { throw FountainOutboxError.invalid }
                    var levels: [String: Int] = [:]
                    for space in spaces { let id = try text(space["id"], limit: 1000); guard levels[id] == nil else { throw FountainOutboxError.invalid }; levels[id] = try level(space["access_level"]) }
                    proof["teamspaces"] = levels
                }
            } else if kind == "page" {
                guard let page = body["page"] as? [String: Any], page["id"] as? String == id,
                      body["blocks"] is [Any], body["state"] is [String: Any] else { throw FountainOutboxError.invalid }
                let item = try descriptor(page, page: true), accessLevel = try level(body["access_level"])
                guard item["accessLevel"] as? Int == accessLevel else { throw FountainOutboxError.invalid }
                proof.merge(item) { _, new in new }; proof["epoch"] = try text(body["epoch"], limit: 1000); proof["seq"] = try checkedInteger(body["seq"])
                if method == "POST", let old = ledger[key], old["epoch"] as? String == proof["epoch"] as? String,
                   let oldSeq = old["seq"] as? Int, let nextSeq = proof["seq"] as? Int, nextSeq < oldSeq {
                    throw FountainOutboxError.stale
                }
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
                if old["accessRevision"] as? Int == access, old["dataRevision"] as? Int == revision,
                   try json(old) != json(semantic) { throw FountainOutboxError.stale }
                // Polling the same unexpired evidence must not invalidate a long staged transfer.
                if try json(old) == json(semantic), access == knownFloor["access"], revision == knownFloor["data"],
                   !(kind == "workspace" && grant["needsFloor"] as? Bool == true) {
                    let changed = try transaction { () throws -> Bool in
                        let changed = try self.markServerProjection(profile, kind: kind, page: id, proof: proof)
                        if changed { try self.advanceProof() }
                        return changed
                    }
                    if changed { readDeadline = nil; boundary = UUID().uuidString }
                    return
                }
            }
            var proposed = ledger; proposed[key] = proof
            let fits = try json(proposed).count <= recordLimit
            try transaction {
                _ = try self.markServerProjection(profile, kind: kind, page: id, proof: proof)
                if fits { try self.setControl("proofs:" + profile, proposed) }
                try self.setControl("proofFloor:" + profile, ["access": max(access, knownFloor["access"] ?? 0), "data": max(revision, knownFloor["data"] ?? 0)])
                if fits && kind == "workspace" {
                    var anchored = grant; anchored["needsFloor"] = false
                    try self.setControl("identity", anchored)
                }
                try self.advanceProof()
            }
            noteHTTPProof(key, access: access)
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
            noteHTTPProof(key)
            boundary = UUID().uuidString
            throw FountainOutboxError.access
        }
    }

    func stage(lease: String, txID: String, baseHead: Int, proofEpoch: Int, part: Int, bytes: Data, sessionRef: String? = nil) throws {
        try checkLease(lease)
        _ = try text(txID, limit: 160)
        guard part >= 0 && part < 256, bytes.count > 0, bytes.count <= partLimit,
              baseHead >= 0, baseHead <= 9_007_199_254_740_991, proofEpoch >= 0, proofEpoch <= 9_007_199_254_740_991 else { throw FountainOutboxError.limit }
        let current = try availableProfile(), state = try identity()
        if current == nil, try terminalReceipt(txID, baseHead: baseHead, proofEpoch: proofEpoch, digest: nil, sessionRef: sessionRef) != nil {
            guard let header = try control("terminalReceipt:" + txID) as? [String: Any], let parts = header["parts"] as? [[String: Any]],
                  part < parts.count, parts[part]["part"] as? Int == part, parts[part]["bytes"] as? Int == bytes.count,
                  parts[part]["digest"] as? String == Self.hash(bytes) else { throw FountainOutboxError.conflict }
            return // Exact accepted piece metadata only; no staging or source mutation.
        }
        if let current = current, try control("cancelledTx:" + current + ":" + txID) != nil { throw FountainOutboxError.conflict }
        if current == nil && state["profileId"] != nil { throw FountainOutboxError.access }
        // Accepted receipts are durable facts; a restage never overwrites or
        // deletes a retained old batch while waiting for the immutable receipt.
        if try integer("SELECT count(*) FROM tx_receipts WHERE tx_id=?", [txID]) > 0 {
            try requireReceiptOwner(txID, current: current)
            return
        }
        try transaction {
            if let owner = try self.control("stagedOwner:" + txID) as? String {
                guard owner == current, try self.control("suspended:" + owner) == nil else { throw FountainOutboxError.access }
            }
            let priorProof = try self.control("stagedProof:" + txID)
            if priorProof == nil, let current = current { try self.setControl("stagedOwner:" + txID, current) }
            if let original = try self.control("stagedProof:" + txID) as? Int {
                guard original == proofEpoch else { throw FountainOutboxError.access }
            } else { try self.setControl("stagedProof:" + txID, proofEpoch) }
            if let existing = try self.rows("SELECT lease,base_head,data FROM staging WHERE tx_id=? AND part=?", [txID, part]).first {
                guard existing[0] as? String == lease, existing[1] as? Int == baseHead, existing[2] as? Data == bytes else { throw FountainOutboxError.conflict }
                return
            }
            guard part == (try self.integer("SELECT count(*) FROM staging WHERE tx_id=?", [txID])) else { throw FountainOutboxError.invalid }
            // Stage is bounded opaque retention. The supplied original CAS
            // remains attached to the private current actor even if another
            // accepted write already advanced head; final COMMIT still checks
            // the actual head/proof and all authority before any active write.
            if let first = try self.rows("SELECT lease,base_head FROM staging WHERE tx_id=? ORDER BY part LIMIT 1", [txID]).first {
                guard first[0] as? String == lease, first[1] as? Int == baseHead else { throw FountainOutboxError.conflict }
            }
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
                    if let parent = try control("account:" + profile) as? String {
                        guard value["accountBinding"] as? String == parent, session["account_binding"] as? String == parent else { throw FountainOutboxError.invalid }
                    } else if value["accountBinding"] != nil && !(value["accountBinding"] is NSNull) { throw FountainOutboxError.invalid }
                }
            } else if bucket == "meta" {
                if key.hasPrefix("revoked-resource:") { resource = String(key.dropFirst(17)); profile = try resourceProfile(resource!) }
                else if key.hasPrefix("revoked:") { profile = String(key.dropFirst(8)) }
                else if key.hasPrefix("mutation-sequence:") { profile = String(key.dropFirst(18)) }
                else if key.hasPrefix("recovery-import:") { profile = try importReceiptProfile(key, op: op, value: value) }
                else if key.hasPrefix("parked:") || key.hasPrefix("workspace-input:") || key.hasPrefix("suspended:") || key.hasPrefix("ended-account:") {
                    let prefix = key.hasPrefix("workspace-input:") ? "workspace-input:" : key.hasPrefix("parked:") ? "parked:" : key.hasPrefix("suspended:") ? "suspended:" : "ended-account:"
                    var tail = String(key.dropFirst(prefix.count))
                    if prefix == "ended-account:" {
                        guard let separator = tail.firstIndex(of: ":") else { throw FountainOutboxError.invalid }
                        let parent = String(tail[..<separator]); tail = String(tail[tail.index(after: separator)...])
                        guard try control("account:" + tail) as? String == parent else { throw FountainOutboxError.invalid }
                    }
                    profile = tail
                    guard value == nil || value?["profileId"] as? String == profile else { throw FountainOutboxError.invalid }
                    if prefix != "suspended:" {
                        guard let parent = try control("account:" + profile) as? String,
                              prefix != "parked:" || value == nil || value?["accountBinding"] as? String == parent else { throw FountainOutboxError.invalid }
                    }
                }
                else if key.hasPrefix("active:") || key.hasPrefix("last-profile:") {
                    if let supplied = value?["profileId"] as? String { profile = supplied }
                    else if let stored = try rows("SELECT profile_id FROM records WHERE bucket='meta' AND key=?", [encoded]).first?.first as? String { profile = stored }
                    else if let current = try identity()["profileId"] as? String { profile = current }
                    else { throw FountainOutboxError.blocked }
                    guard try pointerKeys(profile).contains(key) else { throw FountainOutboxError.invalid }
                }
                else if key == "active" || key == "last-profile" {
                    if let supplied = value?["profileId"] as? String { profile = supplied }
                    else if let stored = try rows("SELECT profile_id FROM records WHERE bucket='meta' AND key=?", [String(data: try json("active"), encoding: .utf8)!]).first?.first as? String { profile = stored }
                    else if let last = try control("lastProfile") as? String { profile = last }
                    else { throw FountainOutboxError.blocked }
                } else { throw FountainOutboxError.invalid }
                if (key == "active" || key == "last-profile"), try control("account:" + profile) != nil { throw FountainOutboxError.invalid }
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
        return key.hasPrefix("revoked:") || key.hasPrefix("revoked-resource:") || key.hasPrefix("suspended:") || key.hasPrefix("ended-account:")
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
    private func purgeResource(_ resource: String, profile: String) throws {
        try execute("INSERT OR IGNORE INTO tombstones(scope,kind,profile_id) VALUES(?,'resource',?)", [resource, profile])
        let recoveryID = "native-resource-revocation:" + UUID().uuidString
        var position = 0
        try eachRecord("SELECT bucket,key,value FROM records WHERE resource_key=? AND bucket IN ('mutations','operations','drafts')", resource) { bucket, encoded, bytes in
            guard let value = try self.decode(bytes) as? [String: Any] else { throw FountainOutboxError.storage }
            let parsed = try self.change(["op": "put", "bucket": bucket, "key": self.decode(Data(encoded.utf8)), "value": value])
            let original = Change(op: parsed.op, bucket: parsed.bucket, encodedKey: parsed.encodedKey, profile: parsed.profile, resource: parsed.resource, value: parsed.value, payload: bytes)
            try self.archiveOriginal(original, bytes: bytes, tx: recoveryID, position: position, capturedProfile: profile)
            position += 1
        }
        try execute("DELETE FROM records WHERE resource_key=?", [resource])
    }

    private func accessIssues(_ profile: String, overlay: [Change] = []) throws -> (issues: [[String: String]], deadline: Double) {
        var overlayByKey: [String: Change] = [:]
        for item in overlay { overlayByKey[item.bucket + "|" + item.encodedKey] = item }
        let ledger = try proofs(profile), now = Date().timeIntervalSince1970 * 1000, grantDeadline = try identity()["validUntil"] as? Double ?? 0
        var unknown = false
        try eachRecord("SELECT bucket,key,value FROM records WHERE profile_id=?", profile) { bucket, key, bytes in
            if overlayByKey[bucket + "|" + key] == nil, try !self.confirmedBytes(bucket: bucket, key: key, bytes: bytes, profile: profile) { unknown = true }
        }
        if unknown { return ([["kind": "workspace", "id": "workspace", "reason": "unconfirmed_input"]], grantDeadline) }
        let currentFloor = try floor(profile)
        let tombstones = Set(try rows("SELECT scope FROM tombstones WHERE profile_id=?", [profile]).compactMap { $0.first as? String })
        let localAuthority = try localCreationAuthority(profile, overlay: overlay)
        var issues: [[String: String]] = localAuthority.issues, seen = Set<String>(), deadline = grantDeadline
        func issue(_ kind: String, _ id: String, _ reason: String) {
            if issues.count <= 100 && seen.insert(kind + "|" + id + "|" + reason).inserted { issues.append(["kind": kind, "id": id, "reason": reason]) }
        }
        if try identity()["needsFloor"] as? Bool == true, try identity()["offline"] as? Bool != true { issue("workspace", "workspace", "missing") }
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
            if let authority = localAuthority.pages[id] { return authority }
            guard let authority = proof("page", id) else { return nil }
            if (authority["accessLevel"] as? Int ?? 0) < (write ? 3 : 1) || write && (authority["locked"] as? Bool == true || authority["archived"] as? Bool == true) { issue("page", id, "denied"); return nil }
            return authority
        }
        func database(_ id: String) -> [String: Any]? { proof("database", id) }
        func row(_ id: String, databaseID: String, authority: [String: Any], write: Bool) {
            if localAuthority.rows[databaseID]?.contains(id) == true { return }
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
                    if supplied is NSNull { continue }
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
            if item.bucket == "localPages" {
                if let metadata = value["metadata"] as? [String: Any], metadata["localOnly"] as? Bool == false,
                   let creation = metadata["create_operation_id"] as? String, let epoch = metadata["initial_epoch"] as? String,
                   try creationMarker(creation, target: id, epoch: epoch, profile: profile) != nil {
                    guard let actual = page(id), actual["epoch"] as? String == epoch else { issue("page", id, "epoch_changed"); continue }
                } else if localAuthority.pages[id] == nil { issue("page", id, "local_dependency") }
                continue
            }
            if item.bucket == "snapshots" || item.bucket == "databaseSnapshots" {
                let authority = kind == "database" ? database(id) : page(id)
                guard let authority = authority else { continue }
                guard let snapshot = value["snapshot"] as? [String: Any] else { issue(kind, id, "missing"); continue }
                if authority["local"] as? Bool == true {
                    if snapshot["epoch"] as? String != authority["epoch"] as? String { issue(kind, id, "epoch_changed") }
                    continue
                }
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
                if operationKind == "page.create" {
                    if try appliedSyncOperation(operation, profile: profile) != nil {
                        guard let actual = page(target), actual["epoch"] as? String == operation["document_epoch"] as? String else { issue("page", target, "epoch_changed"); continue }
                    } else if localAuthority.mutations.contains(value["id"] as? String ?? "") == false { issue("page", target, "local_dependency") }
                    continue
                }
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
                    if let previous = basis["after_operation"] as? String {
                        if let predecessor = localAuthority.operations[previous], ["row.create", "row.patch"].contains(predecessor["kind"] as? String ?? ""), predecessor["database_id"] as? String == databaseID, predecessor["target_id"] as? String == rowID { continue }
                        guard let marker = try control("syncReceipt:" + profile + ":" + previous) as? [String: Any], marker["profile"] as? String == profile,
                              marker["sessionRef"] as? String == (try identity()["sessionRef"] as? String), ["row.create", "row.patch"].contains(marker["kind"] as? String ?? ""),
                              marker["database_id"] as? String == databaseID, marker["target"] as? String == rowID, (marker["result"] as? [String: Any])?["status"] as? String == "applied" else { issue("database", databaseID, "dependency_conflict"); continue }
                    }
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

    private func requireReceiptOwner(_ txID: String, current: String?) throws {
        // Legacy unattributed receipts remain metadata-only. A native-owned
        // receipt cannot acknowledge another login's journal, even for the same actor.
        if let owner = try control("receiptOwner:" + txID) as? String {
            guard owner == current, try control("suspended:" + owner) == nil else { throw FountainOutboxError.access }
        }
    }
    // A completed, privately attributed negative cleanup can outlive the grant
    // it deliberately suspended. This narrow path returns immutable receipt
    // metadata; it cannot hydrate, stage new bytes, renew or change authority.
    private func terminalReceipt(_ txID: String, baseHead: Int, proofEpoch: Int, digest: String?, sessionRef: String?) throws -> [String: Any]? {
        guard let header = try control("terminalReceipt:" + txID) as? [String: Any] else { return nil }
        let current = try identity(), reference = sessionRef ?? "local-no-cookie"
        guard current["state"] as? String == "blocked", let profile = current["profileId"] as? String,
              current["sessionRef"] as? String == reference, header["profile"] as? String == profile, header["sessionRef"] as? String == reference,
              try actorForLogout(reference: reference) != nil, try control("suspended:" + profile) != nil,
              try control("receiptOwner:" + txID) as? String == profile else { throw FountainOutboxError.access }
        guard header["version"] as? Int == 1, header["baseHead"] as? Int == baseHead, header["proofEpoch"] as? Int == proofEpoch,
              header["postProofEpoch"] as? Int == (try self.proofEpoch()),
              let acceptedDigest = header["digest"] as? String, digest == nil || digest == acceptedDigest,
              let receipt = try rows("SELECT digest,head FROM tx_receipts WHERE tx_id=?", [txID]).first,
              receipt[0] as? String == acceptedDigest, receipt[1] as? Int == baseHead + 1,
              header["head"] as? Int == baseHead + 1, try control("receiptProof:" + txID) as? Int == proofEpoch else { throw FountainOutboxError.conflict }
        return ["txId": txID, "head": baseHead + 1, "proofEpoch": proofEpoch]
    }
    private func ownNegativeChanges(_ changes: [Change], profile: String) throws -> Bool {
        for item in changes {
            guard item.profile == profile else { return false }
            if isRevocation(item) { continue }
            guard item.op == "delete" else { return false }
            if let bytes = try rows("SELECT value FROM records WHERE bucket=? AND key=?", [item.bucket, item.encodedKey]).first?.first as? Data,
               try !confirmedBytes(bucket: item.bucket, key: item.encodedKey, bytes: bytes, profile: profile) { return false }
        }
        return true
    }
    func commit(lease: String, txID: String, baseHead: Int, proofEpoch: Int, digest: String, quarantineOnly: Bool = false, sessionRef: String? = nil) throws -> [String: Any] {
        try checkLease(lease)
        let currentProfile = try availableProfile(), currentIdentity = try identity()
        if currentProfile == nil, let terminal = try terminalReceipt(txID, baseHead: baseHead, proofEpoch: proofEpoch, digest: digest, sessionRef: sessionRef) { return terminal }
        if let profile = currentProfile, try control("cancelledTx:" + profile + ":" + txID) != nil { throw FountainOutboxError.conflict }
        if currentProfile == nil && currentIdentity["profileId"] != nil { throw FountainOutboxError.access }
        guard digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw FountainOutboxError.invalid }
        if let receipt = try rows("SELECT digest,head FROM tx_receipts WHERE tx_id=?", [txID]).first {
            try requireReceiptOwner(txID, current: currentProfile)
            guard receipt[0] as? String == digest, let head = receipt[1] as? Int else { throw FountainOutboxError.conflict }
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
        if quarantineOnly && mode != "quarantine" { throw FountainOutboxError.access }
        let result = try transaction { () throws -> Int in
            try self.checkLease(lease)
            guard baseHead == (try self.head()) else { throw FountainOutboxError.head }
            guard try self.control("stagedProof:" + txID) as? Int == proofEpoch else { throw FountainOutboxError.access }
            let active = try self.availableProfile()
            let identity = try self.identity()
            if active == nil && identity["profileId"] != nil { throw FountainOutboxError.access }
            let cleanupOnly = try active.map { try self.ownNegativeChanges(changes, profile: $0) } ?? false
            if mode == "active" && identity["needsFloor"] as? Bool == true && identity["offline"] as? Bool != true && !cleanupOnly { throw FountainOutboxError.access }
            if mode == "active", identity["offline"] as? Bool == true, !cleanupOnly {
                guard changes.allSatisfy({ ["operations", "drafts", "mutations", "localPages", "transfers", "meta", "snapshots"].contains($0.bucket) }) else { throw FountainOutboxError.access }
                if let profile = active {
                    let local = try self.localCreationAuthority(profile, overlay: changes)
                    for item in changes where item.bucket == "snapshots" {
                        guard let id = item.resource?.components(separatedBy: "|").last?.removingPercentEncoding, local.pages[id]?["local"] as? Bool == true else { throw FountainOutboxError.access }
                    }
                }
            }
            if let stagedOwner = try self.control("stagedOwner:" + txID) as? String {
                guard active == stagedOwner, try self.control("suspended:" + stagedOwner) == nil else { throw FountainOutboxError.access }
            }
            let fencedProfiles = Set(changes.filter {
                if $0.bucket == "profiles" && $0.op == "delete" { return true }
                guard $0.bucket == "meta", let key = try? self.decode(Data($0.encodedKey.utf8)) as? String else { return false }
                return key.hasPrefix("revoked:") || key.hasPrefix("suspended:") || key.hasPrefix("ended-account:")
            }.map { $0.profile })
            if mode == "active" && !cleanupOnly {
                guard proofEpoch == (try self.proofEpoch()), let profile = active else { throw FountainOutboxError.access }
                try self.requireAccess(profile, overlay: changes)
                try self.qualifyNativeLocalCreations(profile, targets: self.newNativeLocalTargets(changes), overlay: changes)
            }
            if mode == "active" && !fencedProfiles.isEmpty {
                for profile in fencedProfiles {
                    guard active == profile else { throw FountainOutboxError.access }
                    try self.markSuspended(profile)
                }
                try self.advanceProof()
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
                    // A later migration may replay this exact intent. It must
                    // never replace/delete the only retained same-key source.
                    guard let capturedProfile = active else { throw FountainOutboxError.access }
                    try self.archiveOriginal(item, bytes: quarantined, tx: txID, position: position, capturedProfile: capturedProfile, submittedUntrustedInput: true)
                    continue
                }
                if fencedProfiles.contains(item.profile) { continue }
                let revocation = self.isRevocation(item)
                if revocation, let resource = item.resource {
                    guard active == item.profile else { throw FountainOutboxError.access }
                    try self.purgeResource(resource, profile: item.profile)
                }
                if item.op == "delete" || revocation {
                    let knownProfile = try self.known(item.profile)
                    guard active == item.profile || knownProfile else { throw FountainOutboxError.blocked }
                } else {
                    guard active == item.profile,
                          try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [item.profile]) == 0 else { throw FountainOutboxError.blocked }
                }
                if item.op == "delete" {
                    if item.bucket == "meta", let key = try self.decode(Data(item.encodedKey.utf8)) as? String,
                       key.hasPrefix("revoked:") || key.hasPrefix("revoked-resource:") || key.hasPrefix("suspended:") || key.hasPrefix("ended-account:") { throw FountainOutboxError.blocked }
                    guard active == item.profile else { throw FountainOutboxError.access }
                    try self.execute("DELETE FROM records WHERE bucket=? AND key=?", [item.bucket, item.encodedKey])
                    continue
                }
                if let resource = item.resource,
                   try self.integer("SELECT count(*) FROM tombstones WHERE scope=?", [resource]) > 0, !revocation {
                    guard item.bucket == "mutations", item.value?["status"] as? String == "denied",
                          (item.value?["recovery"] as? [String: Any])?["reason"] as? String == "resource_revoked",
                          let payload = item.payload else { throw FountainOutboxError.blocked }
                    guard let profile = active else { throw FountainOutboxError.access }
                    try self.archiveOriginal(item, bytes: payload, tx: txID, position: position, capturedProfile: profile)
                    continue
                }
                guard let payload = item.payload else { throw FountainOutboxError.invalid }
                try self.execute("INSERT INTO records(bucket,key,profile_id,resource_key,value) VALUES(?,?,?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET profile_id=excluded.profile_id,resource_key=excluded.resource_key,value=excluded.value", [item.bucket, item.encodedKey, item.profile, item.resource, payload])
                if let profile = active { try self.attributeRecord(item, profile: profile) }
            }
            let head = try self.advance()
            try self.execute("INSERT INTO tx_receipts(tx_id,digest,head) VALUES(?,?,?)", [txID, digest, head])
            try self.setControl("receiptProof:" + txID, proofEpoch)
            if let owner = active { try self.setControl("receiptOwner:" + txID, owner) }
            if mode == "active", cleanupOnly, let owner = active, fencedProfiles == Set([owner]) {
                let parts = try self.rows("SELECT part,data FROM staging WHERE tx_id=? ORDER BY part", [txID]).map { row -> [String: Any] in
                    guard let part = row[0] as? Int, let data = row[1] as? Data else { throw FountainOutboxError.storage }
                    return ["part": part, "bytes": data.count, "digest": Self.hash(data)]
                }
                try self.setControl("terminalReceipt:" + txID, ["version": 1, "profile": owner, "sessionRef": identity["sessionRef"] as? String ?? "local-no-cookie", "baseHead": baseHead, "head": head, "proofEpoch": proofEpoch, "postProofEpoch": try self.proofEpoch(), "digest": digest, "parts": parts])
            }
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
