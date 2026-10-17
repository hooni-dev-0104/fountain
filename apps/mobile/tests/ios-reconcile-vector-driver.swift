// Real production API setup: never manufacture private ownership rows with SQL.
import Foundation
import SQLite3
#if os(iOS)
@testable import App
#endif

final class IOSReconcileVectorDriver {
    typealias IO = IOSReconcileVectors
    let corpus: [String: Any], vector: [String: Any], expected: [String: Any], store: FountainOutbox, file: URL
    let origin = "https://native-reconcile.invalid"
    var profile = "", reference = "", authority = "", epoch = 0, sequence = 0, state: [String: Any]?, lastCommit: [String: Any]?, accepted: [String: Any]?
    var sources: [[String: Any]], responses: [String: [String: Any]], originals: [String: Data] = [:], selected: [String] = [], admitted: [String: FountainOutbox.ReconcileAdmission?] = [:]
    var initialHead = 0, initialProof = 0, beforeLateProof = 0, sweeps = 0, sawWrite = false, authChanged = false, lateCommitFenced = false
    var exportVerified = false
    var collisionOriginals: [Data] = [], capturedPaths = Set<String>(), settled: [String: Any]?, failure: FountainOutboxError?
    var journalReceipts: [String: [String: Any]] = [:]
    var journalRequests: [String: [String: Any]] = [:], unaccepted: (String, Data)?, stage = "setup", outcome = "unknown"
    init(_ vector: [String: Any], corpus: [String: Any], directory: URL) throws {
        self.corpus = corpus; self.vector = vector; expected = vector["expected"] as! [String: Any]
        sources = vector["sourceRecords"] as! [[String: Any]]
        responses = Dictionary(uniqueKeysWithValues: (vector["responses"] as! [[String: Any]]).map { ($0["ref"] as! String, $0) })
        store = try FountainOutbox(origin: origin, testingDirectory: directory)
        file = directory.appendingPathComponent(FountainOutbox.hash(Data(origin.utf8)) + ".sqlite")
    }
    deinit { store.close() }
    func sourceProfile(_ row: [String: Any]) -> String {
        let value = row["value"] as! [String: Any]
        return row["bucket"] as? String == "profiles" ? value["id"] as! String : value["profileId"] as? String ?? profile
    }
    func resource(_ row: [String: Any]) -> String? {
        let value = row["value"] as! [String: Any], bucket = row["bucket"] as! String
        return ["profiles", "meta"].contains(bucket) ? nil : bucket == "mutations" ? value["resourceKey"] as? String : bucket == "transfers" ? value["scopeId"] as? String : value["key"] as? String
    }
    func session(_ name: String) -> [String: Any] { ((corpus["authorities"] as! [String: [String: Any]])[name]!["session"] as! [String: Any]) }
    func login(_ name: String) throws {
        authority = name; reference = (corpus["authorities"] as! [String: [String: Any]])[name]!["sessionRef"] as! String
        try grant(session(name), reference: reference)
    }
    func grant(_ session: [String: Any], reference: String) throws {
        self.reference = reference; try store.grant(session, sessionRef: reference); epoch += 1; try store.ensureOwner("shared-vector-owner", epoch: epoch)
        profile = (try store.open())["profileId"] as! String
    }
    func submit(_ changes: [[String: Any]], mode: String = "active", tx: String = UUID().uuidString, commit: Bool = true) throws -> [String: Any] {
        let opened = try store.open(), bytes = try IO.json(["version": 1, "origin": origin, "mode": mode, "changes": changes]), lease = opened["lease"] as! String
        let request: [String: Any] = ["txId": tx, "digest": FountainOutbox.hash(bytes), "baseHead": opened["head"]!, "proofEpoch": opened["proofEpoch"]!, "lease": lease]
        journalRequests[tx] = request
        for (part, offset) in stride(from: 0, to: bytes.count, by: 256 * 1024).enumerated() {
            try store.stage(lease: lease, txID: tx, baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, part: part, bytes: bytes.subdata(in: offset..<min(offset + 256 * 1024, bytes.count)))
        }
        return commit ? try store.commit(lease: lease, txID: tx, baseHead: opened["head"] as! Int, proofEpoch: opened["proofEpoch"] as! Int, digest: FountainOutbox.hash(bytes)) : request
    }
    func putChanges(_ rows: [[String: Any]]) -> [[String: Any]] { rows.map { ["op": "put", "bucket": $0["bucket"]!, "key": $0["key"]!, "value": $0["value"]!] } }
    func bound(_ body: [String: Any], session: [String: Any]) -> [String: Any] {
        var body = body; body["workspace_id"] = session["workspace_id"]; body["current_member_id"] = (session["member"] as! [String: Any])["id"]; body["session_binding"] = session["cache_binding"]; return body
    }
    func baselineWorkspace(_ session: [String: Any]) throws -> [String: Any] {
        if let journals = vector["legacyJournal"] as? [[String: Any]], let text = journals.first?["deltaJSON"] as? String, let delta = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
            for row in delta["changes"] as? [[String: Any]] ?? [] where row["bucket"] as? String == "profiles" { if let workspace = (row["value"] as? [String: Any])?["workspace"] as? [String: Any] { return workspace } }
        }
        for row in sources where row["bucket"] as? String == "profiles" && sourceProfile(row) == profile { return (row["value"] as! [String: Any])["workspace"] as! [String: Any] }
        return bound(responses["workspace"]!["body"] as! [String: Any], session: session)
    }
    func baselinePage(_ session: [String: Any]) throws -> [String: Any] {
        if let journals = vector["legacyJournal"] as? [[String: Any]], let text = journals.first?["deltaJSON"] as? String, let delta = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
            for row in delta["changes"] as? [[String: Any]] ?? [] where row["bucket"] as? String == "snapshots" { if let snapshot = (row["value"] as? [String: Any])?["snapshot"] as? [String: Any], (snapshot["page"] as? [String: Any])?["id"] as? String == "page" { return snapshot } }
        }
        return bound(responses["page"]!["body"] as! [String: Any], session: session)
    }
    func observe(_ response: [String: Any], tag: FountainOutbox.ReconcileAdmission? = nil) throws {
        try IO.require(response["sessionRef"] as? String == reference, "Fixture private cookie does not match native admission")
        if response["method"] as? String != "GET" { sawWrite = true }
        if tag != nil { capturedPaths.insert(response["path"] as! String) }
        try store.observeReconcileResource(admission: tag, path: response["path"] as! String, method: response["method"] as! String, status: response["status"] as! Int, data: IO.json(response["body"] ?? [:]), sessionRef: reference)
    }
    func sourceProofs(_ session: [String: Any]) throws {
        let workspace = try baselineWorkspace(session)
        try store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: IO.json(workspace), sessionRef: reference)
        let local = Set(sources.filter { $0["bucket"] as? String == "localPages" }.compactMap(resource))
        var page = false
        for row in sources where sourceProfile(row) == profile {
            if row["bucket"] as? String == "snapshots", !local.contains(resource(row) ?? "") {
                let snapshot = (row["value"] as! [String: Any])["snapshot"] as! [String: Any], id = (snapshot["page"] as! [String: Any])["id"] as! String
                try store.observeResource(path: "/api/pages/" + FountainOutbox.encodeURIComponent(id) + "/collaboration", method: "GET", status: 200, data: IO.json(snapshot), sessionRef: reference); page = true
            }
            if row["bucket"] as? String == "databaseSnapshots" {
                let snapshot = (row["value"] as! [String: Any])["snapshot"] as! [String: Any], id = (snapshot["database"] as! [String: Any])["id"] as! String
                try store.observeResource(path: "/api/databases/" + FountainOutbox.encodeURIComponent(id), method: "GET", status: 200, data: IO.json(snapshot), sessionRef: reference)
            }
        }
        if !page, !(workspace["pages"] as? [Any] ?? []).isEmpty { try store.observeResource(path: "/api/pages/page/collaboration", method: "GET", status: 200, data: IO.json(baselinePage(session)), sessionRef: reference) }
    }
    func seedJournal() throws {
        for journal in vector["legacyJournal"] as? [[String: Any]] ?? [] {
            let delta = try JSONSerialization.jsonObject(with: Data((journal["deltaJSON"] as! String).utf8)) as! [String: Any]
            let result = try submit(delta["changes"] as! [[String: Any]], tx: journal["txId"] as! String, commit: (vector["receiptLookup"] as? [String: Any])?["accepted"] as? Bool == true)
            if (vector["receiptLookup"] as? [String: Any])?["accepted"] as? Bool == true { journalReceipts[journal["txId"] as! String] = result }
        }
    }
    func seed() throws {
        let setup = vector["privateSetup"] as? [String: Any] ?? [:], target = vector["authority"] as! String, mode = vector["mode"] as! String
        if mode != "promote" || setup["sourceSetup"] as? String == "via-untrusted-quarantine" { try login(setup["sourceAuthority"] as? String ?? target) }
        if setup["sourceSetup"] as? String == "via-untrusted-quarantine" { try sourceProofs(session(authority)); return }
        let journalOnly = setup["sourceSetup"] as? String == "accepted-journal-only"
        if journalOnly {
            try sourceProofs(session(authority)); try seedJournal(); _ = try submit(putChanges(sources.filter { $0["storage"] as? String == "upgrade" }), mode: "quarantine")
        } else if mode == "current" {
            try sourceProofs(session(authority))
            let rows = sources.filter { $0["storage"] as? String == "active" && sourceProfile($0) == profile }
            if !rows.isEmpty { _ = try submit(putChanges(rows)) }
            let inactive = sources.filter { ["recovery", "upgrade"].contains($0["storage"] as? String ?? "") }
            if !inactive.isEmpty { _ = try submit(putChanges(inactive), mode: "quarantine") }
        } else if mode == "upgrade" {
            try sourceProofs(session(authority)); _ = try submit(putChanges(sources), mode: "quarantine")
        } else {
            let source = sourceProfile(sources[0]).components(separatedBy: "|")
            var prior = session("current"), member = prior["member"] as! [String: Any]
            prior["workspace_id"] = source[1].removingPercentEncoding!; prior["cache_binding"] = source[3].removingPercentEncoding!; member["id"] = source[2].removingPercentEncoding!; prior["member"] = member
            try grant(prior, reference: "synthetic-private-historical-cookie"); try sourceProofs(prior)
            let workspace = try baselineWorkspace(prior), initial = try store.open()
            let profileValue: [String: Any] = ["id": profile, "origin": origin, "workspaceId": prior["workspace_id"]!, "memberId": member["id"]!, "cacheBinding": prior["cache_binding"]!, "session": prior, "workspace": workspace, "validUntil": initial["validUntil"]!, "updatedAt": 1]
            var changes: [[String: Any]] = [["op": "put", "bucket": "profiles", "key": profile, "value": profileValue]]
            for pointer in ["active", "last-profile"] { changes.append(["op": "put", "bucket": "meta", "key": pointer, "value": ["id": pointer, "profileId": profile]]) }
            if !(workspace["pages"] as? [Any] ?? []).isEmpty { let key = profile + "|page"; changes.append(["op": "put", "bucket": "snapshots", "key": key, "value": ["key": key, "profileId": profile, "snapshot": try baselinePage(prior), "updatedAt": 1]]) }
            changes.append(contentsOf: putChanges(sources)); _ = try submit(changes)
            for (index, row) in sources.enumerated() { try store.archiveConfirmedVersion(bucket: row["bucket"] as! String, key: row["key"]!, transactionID: "native-history", position: index) }
            try login(target)
        }
        if authority != target { try login(target) }
        if let refs = setup["unacceptedRefs"] as? [String] {
            let rows = sources.filter { refs.contains($0["ref"] as! String) }, changes = putChanges(rows), tx = "unaccepted-" + UUID().uuidString
            let bytes = try IO.json(["version": 1, "origin": origin, "mode": "active", "changes": changes])
            do { _ = try submit(changes, tx: tx); throw NSError(domain: "SharedVector", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid input was accepted as confirmed history"]) }
            catch let error as FountainOutboxError { try IO.require(error == .access || error == .invalid, "Unexpected invalid-input setup error") }
            unaccepted = (tx, bytes)
        }
        for response in vector["privatePriorObservations"] as? [[String: Any]] ?? [] { try observe(response) }
        if !journalOnly { try seedJournal() }
        try snapshotOriginals()
        if (expected["assertions"] as! [String]).contains("archive_before_remove") {
            let refs = (expected["records"] as! [String: [String]])["quarantined"]!
            let matches = try refs.map { ref -> String in let row = try self.row(ref); let bucket = (row["bucket"] as! String).replacingOccurrences(of: "'", with: "''"), key = String(data: try IO.json(row["key"]!), encoding: .utf8)!.replacingOccurrences(of: "'", with: "''"); return "(OLD.bucket='" + bucket + "' AND OLD.key='" + key + "')" }.joined(separator: " OR ")
            if !matches.isEmpty { _ = try IO.sql(file, "CREATE TRIGGER vector_archive_before_remove BEFORE DELETE ON records WHEN (" + matches + ") AND NOT EXISTS(SELECT 1 FROM recovery WHERE bucket=OLD.bucket AND key=OLD.key AND value=OLD.value) BEGIN SELECT RAISE(ABORT,'vector_delete_before_archive'); END") }
        }
    }
    func snapshotOriginals() throws {
        for row in sources {
            let key = String(data: try IO.json(row["key"]!), encoding: .utf8)!, bucket = row["bucket"] as! String
            if row["storage"] as? String == "active", let bytes = try IO.sql(file, "SELECT value FROM records WHERE bucket=? AND key=? AND profile_id=?", [bucket, key, sourceProfile(row)]).first?.first as? Data { originals[row["ref"] as! String] = bytes }
            else {
                let archived = try IO.sql(file, "SELECT value FROM recovery WHERE bucket=? AND key=? AND profile_id=? ORDER BY rowid DESC LIMIT 1", [bucket, key, sourceProfile(row)]).first?.first as? Data
                originals[row["ref"] as! String] = try archived ?? IO.json(row["value"]!)
            }
        }
        let initial = try store.open(); initialHead = initial["head"] as! Int; initialProof = initial["proofEpoch"] as! Int

    }
    func next() throws -> [String: Any] { try store.reconcile(["generation": 1, "phase": "prepare", "lease": state!["lease"]!, "planId": state!["planId"]!], admissionWatermark: sequence, sessionRef: reference) }
    func collect(_ event: [String: Any]) throws {
        stage = "collect:initial-next"; state = try next(); sweeps = max(sweeps, state?["sweep"] as? Int ?? 1); let initialSweep = state?["sweep"] as? Int ?? 1
        let allowed = event["responseRefs"] as? [String]; var seen = Set<String>()
        for _ in 0..<1000 {
            guard state?["state"] as? String == "collecting" else { return }
            var progress = false
            for descriptor in state!["needed"] as! [[String: String]] {
                let kind = descriptor["kind"]!, id = descriptor["id"]!, path = kind == "workspace" ? "/api/workspace" : "/api/" + (kind == "database" ? "databases/" : kind == "attachment" ? "attachments/" : "pages/") + FountainOutbox.encodeURIComponent(id) + (kind == "page" ? "/collaboration" : kind == "attachment" ? "/metadata" : "")
                guard let response = responses.values.first(where: { $0["path"] as? String == path && (allowed == nil || allowed!.contains($0["ref"] as! String)) }) else { continue }
                let unique = String(state!["sweep"] as! Int) + ":" + (response["ref"] as! String); if !seen.insert(unique).inserted { continue }
                stage = "collect:get:" + kind; sequence += 1; let tag = try store.admitReconcile(path: path, method: "GET", sessionRef: reference, sequence: sequence)
                try IO.require(tag != nil, "Expected post-watermark canonical GET was not admitted"); try observe(response, tag: tag); progress = true
            }
            if !progress { return }; stage = "collect:next"; state = try next(); sweeps = max(sweeps, state?["sweep"] as? Int ?? initialSweep)
            if state?["sweep"] as? Int ?? initialSweep != initialSweep { return }
        }
        throw NSError(domain: "SharedVector", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unbounded collector"])
    }
    func run() throws {
        try seed()
        do {
            for event in vector["events"] as! [[String: Any]] {
                let type = event["type"] as! String; stage = type
                switch type {
                case "prepare":
                    let opened = try store.open(); var input: [String: Any] = ["generation": 1, "phase": type, "lease": opened["lease"]!, "baseHead": opened["head"]!, "proofEpoch": opened["proofEpoch"]!, "mode": vector["mode"]!]
                    if vector["mode"] as? String != "current" { input["handles"] = selected }
                    state = try store.reconcile(input, admissionWatermark: sequence, sessionRef: reference); outcome = "collecting"
                case "select_handle": selected = (try store.open()["reconciliationHandles"] as! [[String: Any]]).compactMap { $0["handle"] as? String }
                case "collect":
                    do { try collect(event); outcome = state?["state"] as? String ?? "unknown" }
                    catch FountainOutboxError.access where expected["result"] as? String == "cancelled" && responses.values.contains(where: { [403, 404].contains($0["status"] as? Int ?? 0) }) {
                        try IO.require(!(try IO.sql(file, "SELECT scope FROM tombstones")).isEmpty, "A real denial must remain before safe cancellation")
                        // The next explicit cancel exercises safe no-op close of
                        // a prep discarded by real denial/final validation.
                    }
                case "commit", "drop_commit_reply":
                    guard let ready = state, ready["state"] as? String == "ready" else { throw FountainOutboxError.stale }
                    if let counts = expected["counts"] as? [String: Any] { try IO.require(try IO.json(ready["counts"]!) == IO.json(counts), "Logical counts differ: \(ready["counts"]!) expected \(counts)") }
                    let reasons = Set(ready["reasons"] as! [String]); try IO.require(Set(expected["requiredReasons"] as? [String] ?? []).isSubset(of: reasons), "Required reasons missing: \(reasons)")
                    lastCommit = ["generation": 1, "phase": "commit", "lease": ready["lease"]!, "baseHead": ready["baseHead"]!, "proofEpoch": ready["proofEpoch"]!, "planId": ready["planId"]!, "checksum": ready["checksum"]!, "confirm": event["confirm"] ?? expected["requiresConfirmation"] ?? false]
                    accepted = try store.reconcile(lastCommit!, admissionWatermark: sequence, sessionRef: reference); outcome = "committed"
                case "retry_commit": guard let request = lastCommit else { throw FountainOutboxError.invalid }; let retried = try store.reconcile(request, admissionWatermark: sequence, sessionRef: reference); try IO.require(try IO.json(retried) == IO.json(accepted!), "Accepted receipt changed on retry"); outcome = "committed"
                case "cancel": _ = try store.reconcile(["generation": 1, "phase": "cancel", "planId": state!["planId"]!], admissionWatermark: sequence, sessionRef: reference); if outcome != "committed" { outcome = "cancelled" }
                case "change_sweep": let name = event["response"] as! String; var body = responses[name]!["body"] as! [String: Any]; body["data_revision"] = event["dataRevision"]; responses[name]!["body"] = body
                case "auth_change": authChanged = true; try login(event["authority"] as! String)
                case "advance_clock": try IO.require((event["milliseconds"] as! Int) > (corpus["planTTLms"] as! Int), "Expiry injection must exceed capability TTL"); store.expireReconciliationForTesting()
                case "admit_http": let response = responses[event["response"] as! String]!; sequence += 1; admitted[event["response"] as! String] = try store.admitReconcile(path: response["path"] as! String, method: response["method"] as! String, sessionRef: reference, sequence: sequence); beforeLateProof = try store.proofEpoch()
                case "deliver_http": let name = event["response"] as! String; try observe(responses[name]!, tag: admitted[name] ?? nil)
                case "observe_after_ready": try observe(responses[event["response"] as! String]!)
                case "mutate_source": let row = sources.first { $0["ref"] as? String == event["ref"] as? String }!; var value = row["value"] as! [String: Any]; value["updatedAt"] = (value["updatedAt"] as? Int ?? 0) + 1; _ = try IO.sql(file, "UPDATE records SET value=? WHERE bucket=? AND key=?", [try IO.json(value), row["bucket"]!, String(data: try IO.json(row["key"]!), encoding: .utf8)!]); originals[row["ref"] as! String] = try IO.json(value)
                case "fail_commit": _ = try IO.sql(file, "CREATE TRIGGER vector_fail_commit BEFORE INSERT ON control WHEN substr(NEW.id,1,17)='reconcileReceipt:' BEGIN SELECT RAISE(ABORT,'vector_commit_failure'); END")
                case "stage_untrusted_quarantine": let refs = event["sourceRefs"] as! [String]; _ = try submit(putChanges(sources.filter { refs.contains($0["ref"] as! String) }), mode: "quarantine"); try snapshotOriginals()
                case "assert_no_source_handles": try IO.require((try store.open()["reconciliationHandles"] as! [Any]).isEmpty, "Untrusted foreign profile metadata granted a source handle")
                case "collide_archive": let row = sources.first { $0["ref"] as? String == event["ref"] as? String }!; var old = row, value = row["value"] as! [String: Any]; value["updatedAt"] = (value["updatedAt"] as? Int ?? 0) - 1; old["value"] = value; _ = try submit(putChanges([old])); collisionOriginals.append(try IO.json(value)); try store.archiveConfirmedVersion(bucket: row["bucket"] as! String, key: row["key"]!, transactionID: "collision-history", position: 0); _ = try submit(putChanges([row]))
                case "settle":
                    let opened = try store.open(), journals = try (event["journals"] as! [[String: Any]]).map { item -> [String: Any] in guard let request = journalRequests[item["txId"] as! String] else { throw FountainOutboxError.invalid }; return ["txId": request["txId"]!, "digest": request["digest"]!, "baseHead": request["baseHead"]!, "proofEpoch": request["proofEpoch"]!] }
                    state = try store.reconcile(["generation": 1, "phase": "settle", "lease": opened["lease"]!, "journals": journals], admissionWatermark: sequence, sessionRef: reference); outcome = "settled"; settled = state
                case "late_legacy_commit": let request = journalRequests[event["txId"] as! String]!; do { _ = try store.commit(lease: request["lease"] as! String, txID: request["txId"] as! String, baseHead: request["baseHead"] as! Int, proofEpoch: request["proofEpoch"] as! Int, digest: request["digest"] as! String); throw NSError(domain: "SharedVector", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cancelled old COMMIT applied"]) } catch let error as FountainOutboxError { try IO.require(error == .conflict, "Wrong old-COMMIT fence"); lateCommitFenced = true }
                default: throw NSError(domain: "UnsupportedVectorEvent", code: 1, userInfo: [NSLocalizedDescriptionKey: "UNIMPLEMENTED native event \(type)"])
                }
            }
        } catch let error as FountainOutboxError {
            failure = error
            let wanted = expected["result"] as! String
            if wanted == "rejected" { outcome = "rejected" }
            else if wanted == "retryable", [.retry, .access, .stale].contains(error) { outcome = "retryable" }
            else if wanted == "confirmation_required", error == .confirmation { outcome = "confirmation_required" }
            else { throw error }
        }
        try IO.require(outcome == expected["result"] as? String, "Unexpected result at \(stage): \(outcome)")
        if let unaccepted = unaccepted {
            let fragments = try IO.sql(file, "SELECT data FROM staging WHERE tx_id=? ORDER BY part", [unaccepted.0]).compactMap { $0[0] as? Data }
            try IO.require(fragments.reduce(into: Data(), { $0.append($1) }) == unaccepted.1, "Rejected unaccepted input was lost")
        }
        try verify()
    }
    func row(_ ref: String) throws -> [String: Any] {
        guard let row = sources.first(where: { $0["ref"] as? String == ref }) else { throw FountainOutboxError.invalid }; return row
    }
    func active(_ row: [String: Any]) throws -> Data? {
        try IO.sql(file, "SELECT value FROM records WHERE bucket=? AND key=? AND profile_id=?", [row["bucket"]!, String(data: IO.json(row["key"]!), encoding: .utf8)!, sourceProfile(row)]).first?.first as? Data
    }
    func archived(_ bytes: Data) throws -> Bool { try IO.sql(file, "SELECT 1 FROM recovery WHERE value=? LIMIT 1", [bytes]).count == 1 }
    func activeRows(_ bucket: String) throws -> [[String: Any]] {
        try IO.sql(file, "SELECT value FROM records WHERE profile_id=? AND bucket=?", [profile, bucket]).map { guard let bytes = $0.first as? Data, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw FountainOutboxError.invalid }; return value }
    }
    func receiptCount() throws -> Int { (try IO.sql(file, "SELECT count(*) FROM control WHERE substr(id,1,17)='reconcileReceipt:'")).first?.first as? Int ?? -1 }
    func hasDenial() -> Bool { responses.values.contains { [403, 404].contains($0["status"] as? Int ?? 0) } }
    func verify() throws {
        let groups = expected["records"] as! [String: [String]]
        for (classification, refs) in groups {
            for ref in refs {
                let row = try row(ref); guard let bytes = originals[ref] else { throw FountainOutboxError.invalid }
                let live = try active(row)
                switch classification {
                case "kept": try IO.require(live == bytes, "Kept source bytes changed: " + ref)
                case "acknowledged":
                    try IO.require(live == nil, "Acknowledged input remained active: " + ref)
                    let value = row["value"] as! [String: Any], operation = value["operation"] as! [String: Any]
                    guard let snapshot = try activeRows("snapshots").first(where: { $0["key"] as? String == resource(row) })?["snapshot"] as? [String: Any], let state = snapshot["state"] as? [String: Any], let seen = state["seen"] as? [String: Any] else { throw FountainOutboxError.invalid }
                    try IO.require(snapshot["epoch"] as? String == operation["_epoch"] as? String && seen[value["id"] as! String] != nil, "ACK lacks same installed transaction/epoch state.seen")
                case "quarantined": try IO.require(live == nil && archived(bytes), "Rejected closure/original archive differs: " + ref)
                case "archived": try IO.require(try archived(bytes), "Original archive missing: " + ref)
                case "unchanged": try IO.require(try row["storage"] as? String == "active" ? live == bytes : archived(bytes), "Unexpected source mutation: " + ref)
                case "replaced":
                    guard let live, let value = try JSONSerialization.jsonObject(with: live) as? [String: Any] else { throw NSError(domain: "SharedVector", code: 1, userInfo: [NSLocalizedDescriptionKey: "Fresh canonical record missing: " + ref]) }
                    if ["snapshots", "databaseSnapshots"].contains(row["bucket"] as? String ?? ""), let snapshot = value["snapshot"] as? [String: Any] {
                        guard let response = responses.values.first(where: { let body = $0["body"] as? [String: Any] ?? [:]; return (body["page"] as? [String: Any])?["id"] as? String == (snapshot["page"] as? [String: Any])?["id"] as? String && body["page"] != nil || (body["database"] as? [String: Any])?["id"] as? String == (snapshot["database"] as? [String: Any])?["id"] as? String && body["database"] != nil }) else { throw FountainOutboxError.invalid }
                        try IO.require(try IO.json(response["body"]!) == IO.json(snapshot), "Canonical snapshot differs from actual collected bytes")
                    }
                case "opaque":
                    if row["storage"] as? String == "unaccepted" { try IO.require(live == nil && unaccepted != nil, "Unaccepted input became active") }
                    else { try IO.require(try live == bytes || archived(bytes), "Opaque original lost: " + ref) }
                    if let descriptors = state?["needed"] as? [[String: String]], let key = resource(row) { try IO.require(!descriptors.contains { key.hasSuffix("|" + FountainOutbox.encodeURIComponent($0["id"]!)) }, "Opaque source exposed a native descriptor") }
                case "safetyChanged": try IO.require(hasDenial() && !(try IO.sql(file, "SELECT scope FROM tombstones")).isEmpty, "Safety disposition lacks actual HTTP denial")
                default: throw NSError(domain: "UnsupportedVectorAssertion", code: 1, userInfo: [NSLocalizedDescriptionKey: "UNIMPLEMENTED disposition " + classification])
                }
            }
        }
        if outcome == "settled", let expectedSettlements = expected["settlements"] as? [[String: Any]] {
            let wanted = try expectedSettlements.map { item -> [String: Any] in
                guard let tx = item["txId"] as? String, let request = journalRequests[tx], let status = item["status"] as? String else { throw FountainOutboxError.invalid }
                var entry: [String: Any] = ["txId": tx, "digest": request["digest"]!, "status": status]
                if status == "accepted" { guard let receipt = journalReceipts[tx] else { throw FountainOutboxError.invalid }; entry["head"] = receipt["head"]; entry["proofEpoch"] = request["proofEpoch"] }
                return entry
            }
            try IO.require(try IO.json(settled!["settlements"]!) == IO.json(wanted), "Settlement status/digest/original receipt caps differ")
        }
        for assertion in expected["assertions"] as! [String] { try verifyAssertion(assertion) }
        try freshIdentities()
        try IO.require(try IO.sql(file, "PRAGMA integrity_check").first?.first as? String == "ok", "SQLite integrity check failed")
    }
    func verifyAssertion(_ name: String) throws {
        switch name {
        case "input_bytes_preserved", "source_bytes_unchanged", "external_source_change_preserved", "archive_bytes_preserved", "archive_before_remove": break // Every exact original disposition is checked above.
        case "canonical_installed_atomically", "one_transform", "same_transaction_seen_only", "immutable_receipt":
            if let accepted { try IO.require(try receiptCount() == 1 && store.open()["head"] as? Int == accepted["head"] as? Int, "Canonical transform or immutable receipt was not atomic") }
            else { try IO.require(settled != nil, "No immutable transform/settlement receipt") }
        case "no_network_replay", "no_upload_auto_resume": try IO.require(!sawWrite, "Collector submitted an HTTP write")
        case "complete_dependency_closure": if accepted != nil { let current = try store.open(); _ = try store.read(lease: current["lease"] as! String, head: current["head"] as! Int, proofEpoch: current["proofEpoch"] as! Int, cursor: nil, byteLimit: 1024) }
        case "exact_retry_current_owner": try IO.require(try store.matchesReconciliationAuthority(workspace: session(authority)["workspace_id"] as! String, member: (session(authority)["member"] as! [String: Any])["id"] as! String, binding: session(authority)["cache_binding"] as! String, reference: reference), "Immutable retry caller lost private native authority")
        case "no_partial_active_replace": if accepted == nil { try IO.require(try receiptCount() == 0, "Failed prep installed a receipt"); if !hasDenial() && !authChanged { let bytes = try IO.sql(file, "SELECT value FROM control WHERE id='head'").first?.first as! Data; try IO.require(try JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]) as? Int == initialHead, "Failed prep partially advanced head") } }
        case "native_role_only": let bytes = try IO.sql(file, "SELECT value FROM control WHERE id=?", ["nativeSession:" + profile]).first?.first as! Data; let session = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]; try IO.require((session["member"] as! [String: Any])["role"] as? String == (self.session(authority)["member"] as! [String: Any])["role"] as? String, "Native role changed from renderer metadata")
        case "no_hidden_body_delivery", "cross_actor_no_descriptors_counts", "untrusted_profile_does_not_qualify_history":
            if let state { try IO.require(Set(state.keys).isDisjoint(with: ["sourceRecords", "snapshot", "sessionRef", "body", "digest"]), "Private source body or identity escaped summary") }
            if !(expected["records"] as! [String: [String]])["opaque"]!.isEmpty { try IO.require((try store.open()["reconciliationHandles"] as! [Any]).isEmpty, "Opaque source gained a public handle") }
        case "native_admission_only": try IO.require(admitted.values.contains { $0 == nil }, "Pre-plan HTTP fixture did not retain a null native admission")
        case "stable_unowned_proof_unchanged": try IO.require(try store.proofEpoch() == beforeLateProof, "Semantically stable late response changed native proof")
        case "unowned_proof_change_invalidates": try IO.require(try store.proofEpoch() > beforeLateProof && receiptCount() == 0, "Mutating unowned response did not fence the plan")
        case "no_fabricated_denial": try IO.require(try IO.sql(file, "SELECT scope FROM tombstones").isEmpty, "Collector failure fabricated a revocation")
        case "denial_survives_cancel": let before = try IO.sql(file, "SELECT scope FROM tombstones ORDER BY scope").map { $0[0] as! String }; try IO.require(!before.isEmpty, "No actual denial tombstone"); _ = try store.reconcile(["generation": 1, "phase": "cancel", "planId": state!["planId"]!], admissionWatermark: sequence, sessionRef: reference); try IO.require(try IO.sql(file, "SELECT scope FROM tombstones ORDER BY scope").map { $0[0] as! String } == before, "Cancellation undid normal denial safety")
        case "explicit_confirmation": try IO.require(expected["requiresConfirmation"] as? Bool == true && (accepted == nil || lastCommit?["confirm"] as? Bool == true), "Explicit promotion confirmation missing")
        case "fresh_private_acl", "no_old_owner_session_receipts", "no_old_crdt_identity_replay": if accepted != nil { try freshAuthority() }
        case "archive_collision_no_overwrite": try IO.require(!collisionOriginals.isEmpty, "Collision fixture had no older archive"); for bytes in collisionOriginals { try IO.require(try archived(bytes), "Earlier archive version overwritten") }
        case "both_archives_exportable", "export_requires_current_resource_proof": try verifyRecoveryExport()
        case "two_sweeps_max": try IO.require(sweeps <= 2, "Collector exceeded two bounded sweeps")
        case "late_legacy_commit_fenced": try IO.require(lateCommitFenced && settled != nil, "Old unaccepted COMMIT was not privately fenced")
        case "attachment_metadata_native_proof": try IO.require(capturedPaths.contains(responses["attachment"]?["path"] as? String ?? "missing-attachment") && (accepted == nil || responses["attachment"]?["status"] as? Int == 200), "Attachment promotion lacked actual native metadata capture")
        case "accepted_identity_preserved": for pair in (vector["privateSetup"] as! [String: Any])["confirmedMirrors"] as! [[String: String]] { let row = try row(pair["active"]!); try IO.require(try active(row) == originals[pair["active"]!], "Accepted native identity/body/base/dependencies changed") }
        case "no_fresh_reimport": guard let accepted else { throw FountainOutboxError.invalid }; try IO.require((accepted["receipt"] as! [String: Any])["counts"].flatMap { $0 as? [String: Int] }?["import"] == 0, "Already accepted native input was freshly imported"); let count = try IO.sql(file, "SELECT count(*) FROM records WHERE profile_id=? AND bucket IN ('operations','drafts','mutations','localPages','transfers')", [profile]).first?.first as! Int; try IO.require(count == (expected["counts"] as! [String: Int])["keep"], "Accepted input duplicated")
        case "unaccepted_submit_rejected", "staging_bytes_preserved": try IO.require(unaccepted != nil, "Invalid source setup was not rejected")
        case "unaccepted_input_not_qualified": for ref in (vector["privateSetup"] as! [String: Any])["unacceptedRefs"] as! [String] { let row = try row(ref), key = "recordAuthority:" + (row["bucket"] as! String) + "|" + String(data: try IO.json(row["key"]!), encoding: .utf8)!; try IO.require(try IO.sql(file, "SELECT 1 FROM control WHERE id=?", [key]).isEmpty, "Rejected source received private native qualification") }
        case "same_floor_equivocation_rejected": try IO.require(failure == .stale && store.proofEpoch() == initialProof, "Same-floor equivocation changed native proof")
        default: throw NSError(domain: "UnsupportedVectorAssertion", code: 1, userInfo: [NSLocalizedDescriptionKey: "UNIMPLEMENTED native assertion " + name])
        }
    }
    func verifyRecoveryExport() throws {
        if exportVerified { return }
        try IO.require(!collisionOriginals.isEmpty, "Archive export fixture must preserve multiple versions")
        let authority = try FountainRecovery.Authority.session(IO.json(session(self.authority)), origin: origin, reference: reference)
        let recovery = try FountainRecovery(authority: authority, testingDirectory: file.deletingLastPathComponent()); defer { recovery.close() }
        var selected: [String] = [], cursor: String?
        repeat {
            let page = try recovery.inventory(authority, cursor: cursor, count: 100)
            selected += (page["items"] as! [[String: Any]]).map { $0["handle"] as! String }
            cursor = page["next"] as? String
        } while cursor != nil
        try IO.require(!selected.isEmpty, "Privately confirmed native archive is not discoverable")
        var permissions: FountainRecovery.Responses = [:]
        for response in responses.values { permissions[response["path"] as! String] = (response["status"] as! Int, try IO.json(response["body"] ?? [:])) }
        let prepared = try recovery.prepare(selected, other: authority, responses: permissions, observedAt: Date().timeIntervalSince1970 * 1000) { name in
            let root = self.file.deletingLastPathComponent().appendingPathComponent("export-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
            let file = root.appendingPathComponent(name)
            guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.complete]) else { throw FountainRecoveryError.storage }; return file
        }
        try IO.require((prepared["readyCount"] as! Int) >= 2, "Preserved original versions are not exportable")
        let token = prepared["exportToken"] as! String, files = try recovery.saveFiles(token, handles: selected, other: authority, responses: permissions)
        try IO.require(!files.isEmpty, "Native export produced no file")
        for file in files { try IO.require((try FileManager.default.attributesOfItem(atPath: file.path)[.size] as! NSNumber).intValue > 0, "Native export is empty") }
        var exportedDrafts: [[String: Any]] = []
        for file in files {
            guard let export = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else { throw FountainOutboxError.invalid }
            if export["format"] as? String == "fountain-recovery-v2" { exportedDrafts += export["drafts"] as? [[String: Any]] ?? [] }
            else {
                // The tiny collision fixtures each fit one supported readable
                // JSON piece; these preserve original pending body/ops safely.
                let text = (export["blocks"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "code" }.compactMap { $0["text"] as? String }.joined()
                guard !text.isEmpty, let draft = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw FountainOutboxError.invalid }
                exportedDrafts.append(draft)
            }
        }
        let sourceDrafts = collisionOriginals + (try sources.filter { $0["bucket"] as? String == "drafts" }.map { try IO.json($0["value"]!) })
        for bytes in sourceDrafts {
            guard let original = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let draft = original["draft"] as? [String: Any] else { throw FountainOutboxError.invalid }
            let originalBlocks = draft["blocks"] as? [[String: Any]] ?? []
            let matching = try exportedDrafts.filter { value in
                let candidate = value["draft"] as? [String: Any] ?? value
                return try IO.json(candidate["blocks"] ?? []) == IO.json(originalBlocks)
            }
            try IO.require(matching.count >= 2, "Export omitted the body of a preserved same-key archive version")
        }
        var denied = permissions; denied["/api/pages/page/collaboration"] = (403, try IO.json(["error": "Denied"]))
        do { _ = try recovery.saveFiles(token, handles: selected, other: authority, responses: denied); throw NSError(domain: "SharedVector", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native export ignored fresh resource denial"]) }
        catch let error as FountainRecoveryError { try IO.require(error == .access || error == .stale, "Wrong native export denial error") }
        exportVerified = true
    }
    func freshAuthority() throws {
        let privateACL: [String: Any] = ["default": "private", "inherit": false, "members": [String: Any](), "groups": [String: Any]()]
        let actor = (session(authority)["member"] as! [String: Any])["id"] as! String
        let pages = try activeRows("localPages"), snapshots = try activeRows("snapshots")
        for value in try activeRows("mutations") {
            guard let operation = value["operation"] as? [String: Any], operation["kind"] as? String == "page.create" else { continue }
            guard let body = operation["body"] as? [String: Any], let permissions = body["permissions"] as? [String: Any], let target = operation["target_id"] as? String else { throw NSError(domain: "SharedVector", code: 1, userInfo: [NSLocalizedDescriptionKey: "Fresh imported page.create BODY lacks explicit private ACL"]) }
            try IO.require(try IO.json(permissions) == IO.json(privateACL) && body["owner_id"] == nil, "Fresh page.create BODY reused old ACL or forbidden owner authority")
            guard let page = pages.compactMap({ ($0["metadata"] as? [String: Any])?["page"] as? [String: Any] }).first(where: { $0["id"] as? String == target }),
                  let snapshot = snapshots.compactMap({ $0["snapshot"] as? [String: Any] }).first(where: { ($0["page"] as? [String: Any])?["id"] as? String == target }), let snapshotPage = snapshot["page"] as? [String: Any] else { throw FountainOutboxError.invalid }
            for projection in [page, snapshotPage] {
                guard let permissions = projection["permissions"] as? [String: Any] else { throw NSError(domain: "SharedVector", code: 1, userInfo: [NSLocalizedDescriptionKey: "Fresh metadata/snapshot PAGE lacks explicit private ACL"]) }
                try IO.require(try IO.json(permissions) == IO.json(privateACL) && projection["owner_id"] as? String == actor, "Fresh metadata/snapshot PAGE reused historical ACL/owner")
            }
            try IO.require((pages.first(where: { (($0["metadata"] as? [String: Any])?["page"] as? [String: Any])?["id"] as? String == target })?["metadata"] as? [String: Any])?["initial_epoch"] as? String == operation["document_epoch"] as? String && snapshot["epoch"] as? String == operation["document_epoch"] as? String, "Fresh page/create/snapshot epoch remapping disagrees")
        }
        let nativeSession = session(authority), binding = nativeSession["cache_binding"] as! String
        for value in try activeRows("profiles") {
            try IO.require(value["id"] as? String == profile && value["memberId"] as? String == actor && value["cacheBinding"] as? String == binding && (try IO.json(value["session"]!)) == IO.json(nativeSession), "Imported profile copied old owner/session/binding")
        }
        for value in try activeRows("snapshots") {
            let snapshot = value["snapshot"] as! [String: Any]
            try IO.require(value["profileId"] as? String == profile && snapshot["current_member_id"] as? String == actor && snapshot["session_binding"] as? String == binding, "Imported snapshot retained old scope/session envelope")
        }
        for bucket in ["operations", "drafts", "mutations", "localPages"] {
            for value in try activeRows(bucket) {
                try IO.require(value["profileId"] as? String == profile && Set(value.keys).isDisjoint(with: ["receipt", "creation_result", "session", "cacheBinding", "owner_id"]), "Imported input copied historical authority/receipt")
                if bucket == "mutations" { try IO.require(value["status"] as? String == "pending", "Imported mutation copied an applied receipt/status") }
            }
        }
        let oldIDs = Set(sources.filter { $0["bucket"] as? String == "operations" }.compactMap { ($0["value"] as? [String: Any])?["id"] as? String })
        for value in try activeRows("operations") { try IO.require(!oldIDs.contains(value["id"] as! String), "Historical CRDT identity was replayed") }
    }
    func freshIdentities() throws {
        guard accepted != nil else { return }
        let conditions = expected["fresh"] as! [[String: Any]]
        var epochs: [String: String] = [:], ids: [String: String] = [:], targets: [String: String] = [:], blocks: [String: String] = [:], mapped: [String: [String: Any]] = [:]
        for condition in conditions {
            let ref = condition["source"] as! String, source = try row(ref), old = (source["value"] as! [String: Any])["operation"] as! [String: Any]
            let candidates = try activeRows(source["bucket"] as! String).compactMap { $0["operation"] as? [String: Any] }.filter { old["kind"] != nil ? $0["kind"] as? String == old["kind"] as? String : $0["type"] as? String == old["type"] as? String }
            try IO.require(candidates.count == 1, "Fresh operation identity mapping missing or ambiguous"); let candidate = candidates[0]; mapped[ref] = candidate
            try IO.require(condition["allDifferent"] as? Bool == true && condition["consistentReferences"] as? Bool == true, "Unsupported fresh identity predicate")
            for field in condition["fields"] as! [String] { let key = String(field.dropFirst("operation.".count)); try IO.require(candidate[key] != nil && (try IO.json(candidate[key]!)) != IO.json(old[key]!), "Fresh operation reused original identity: " + key) }
            ids[old["id"] as! String] = candidate["id"] as? String
            if let target = old["target_id"] as? String { targets[target] = candidate["target_id"] as? String }
            if let epoch = old["document_epoch"] as? String { epochs[epoch] = candidate["document_epoch"] as? String }
            if old["type"] as? String == "block.insert", let block = old["block_id"] as? String { blocks[block] = candidate["block_id"] as? String }
        }
        for condition in conditions {
            let ref = condition["source"] as! String, source = try row(ref), old = (source["value"] as! [String: Any])["operation"] as! [String: Any], candidate = mapped[ref]!
            if let epoch = old["_epoch"] as? String { try IO.require(epochs[epoch] == candidate["_epoch"] as? String, "CRDT/document epoch remapping disagrees") }
            if let block = old["block_id"] as? String { try IO.require(blocks[block] == candidate["block_id"] as? String, "CRDT operations disagree on remapped block identity") }
            for field in ["after_id", "parent_id"] { if let oldID = old[field] as? String { try IO.require(candidate[field] as? String == blocks[oldID], "CRDT structural reference was not remapped") } }
            if let dependencies = old["depends_on"] as? [String] { try IO.require(candidate["depends_on"] as? [String] == dependencies.map { ids[$0] ?? $0 }, "Promoted operation dependencies disagree with fresh IDs") }
            if let oldBody = old["body"] as? [String: Any], let body = candidate["body"] as? [String: Any] {
                for field in ["parent_id", "parent_row_id"] { if let oldID = oldBody[field] as? String { try IO.require(body[field] as? String == (targets[oldID] ?? oldID), "Promoted parent/reference identity differs") } }
                if let dependencies = oldBody["depends_on"] as? [String] { try IO.require(body["depends_on"] as? [String] == dependencies.map { targets[$0] ?? $0 }, "Promoted row dependency targets differ") }
                if old["kind"] as? String == "page.create" { try IO.require(body["id"] as? String == candidate["target_id"] as? String, "Promoted page.create body target differs from fresh metadata") }
            }
            if let bases = old["base_rows"] as? [String: [String: Any]], let updatedBases = candidate["base_rows"] as? [String: [String: Any]] {
                for (target, base) in bases { if let after = base["after_operation"] as? String { try IO.require(updatedBases[targets[target] ?? target]?["after_operation"] as? String == ids[after], "Promoted base_rows.after_operation was not remapped") } }
            }
        }
        if !conditions.isEmpty {
            for value in try activeRows("localPages") {
                let metadata = value["metadata"] as! [String: Any], page = metadata["page"] as! [String: Any]
                try IO.require(ids.values.contains(metadata["create_operation_id"] as! String) && targets.values.contains(page["id"] as! String) && epochs.values.contains(metadata["initial_epoch"] as! String), "Promoted local metadata references inconsistent create/target/epoch")
            }
            for value in try activeRows("drafts") {
                let draft = value["draft"] as! [String: Any]
                if draft["reason"] as? String == "basis" { continue }
                try IO.require(epochs.values.contains(draft["epoch"] as! String), "Promoted draft retained historical document epoch")
                for operation in draft["ops"] as? [[String: Any]] ?? [] { try IO.require(ids.values.contains(operation["id"] as! String) && blocks.values.contains(operation["block_id"] as! String), "Promoted draft operations disagree with fresh identities") }
                for block in draft["blocks"] as? [[String: Any]] ?? [] { try IO.require(blocks.values.contains(block["id"] as! String), "Promoted draft display blocks disagree with operation identities") }
            }
        }
    }
}

// Focused production-path regressions supplement (and never alter) the frozen
// shared corpus. Expected bases/references are checked independently below.
enum IOSPromotionProjectionFixtures {
    static func run(_ corpus: [String: Any], directory: URL) throws -> [String] {
        let cases = corpus["cases"] as! [[String: Any]]
        var passed: [String] = []
        func expected(_ refs: [String]) -> [String: Any] {
            ["result": "committed", "requiresConfirmation": true, "records": ["archived": refs], "assertions": [], "fresh": [], "requiredReasons": []]
        }
        var page = cases.first { $0["id"] as? String == "same-actor-promotion" }!
        page["id"] = "promotion-sequential-page-patches"
        var rows = page["sourceRecords"] as! [[String: Any]]
        let create = rows.first { $0["ref"] as? String == "local-create" }!, value = create["value"] as! [String: Any], original = value["operation"] as! [String: Any]
        let profile = value["profileId"] as! String, target = original["target_id"] as! String, createID = original["id"] as! String
        for (index, title) in ["Second title", "Third title"].enumerated() {
            let id = "page-patch-" + String(index), operation: [String: Any] = ["id": id, "kind": "page.patch", "target_id": target, "body": ["title": title], "base": ["fields": ["title": index == 0 ? "Local input" : "Second title"]], "depends_on": [index == 0 ? createID : "page-patch-0"]]
            rows.append(["ref": id, "storage": "recovery", "bucket": "mutations", "key": [profile, id], "value": ["profileId": profile, "id": id, "resourceKey": profile + "|" + target, "operation": operation, "status": "pending", "sequence": index + 2, "createdAt": 1, "updatedAt": 1]])
        }
        page["sourceRecords"] = rows; page["expected"] = expected(rows.map { $0["ref"] as! String })
        let pageDriver = try IOSReconcileVectorDriver(page, corpus: corpus, directory: directory.appendingPathComponent(page["id"] as! String)); do { try pageDriver.run() } catch { throw NSError(domain: "FocusedPromotion", code: 1, userInfo: [NSLocalizedDescriptionKey: "page fixture " + pageDriver.stage + ": " + ((error as? FountainOutboxError)?.code ?? error.localizedDescription)]) }
        let pageOperations = try pageDriver.activeRows("mutations").map { $0["operation"] as! [String: Any] }
        let freshCreate = pageOperations.first { $0["kind"] as? String == "page.create" }!
        let first = pageOperations.first { ($0["body"] as? [String: Any])?["title"] as? String == "Second title" }!, second = pageOperations.first { ($0["body"] as? [String: Any])?["title"] as? String == "Third title" }!
        try IOSReconcileVectors.require(((first["base"] as! [String: Any])["fields"] as! [String: Any])["title"] as? String == "Local input" && ((second["base"] as! [String: Any])["fields"] as! [String: Any])["title"] as? String == "Second title", "Sequential page patches did not rebase against preceding promoted state")
        try IOSReconcileVectors.require(first["depends_on"] as? [String] == [freshCreate["id"] as! String] && second["depends_on"] as? [String] == [first["id"] as! String] && first["target_id"] as? String == freshCreate["target_id"] as? String && second["target_id"] as? String == freshCreate["target_id"] as? String, "Sequential page patches lost fresh dependency/target mapping")
        passed.append(page["id"] as! String)

        var row = cases.first { $0["id"] as? String == "complete-row-dependency-dag" }!
        row["id"] = "promotion-virtual-row-patches-and-selected-subtree"
        row["mode"] = "promote"
        let sourceRows = row["sourceRecords"] as! [[String: Any]], oldProfile = (sourceRows.first { $0["bucket"] as? String == "profiles" }!["value"] as! [String: Any])["id"] as! String
        let priorProfile = String(oldProfile.prefix(oldProfile.count - "binding-current".count)) + "binding-old"
        var promoted: [[String: Any]] = []
        for var source in sourceRows where ["databaseSnapshots", "mutations"].contains(source["bucket"] as? String ?? "") {
            let bytes = try IOSReconcileVectors.json(source), text = String(data: bytes, encoding: .utf8)!.replacingOccurrences(of: oldProfile, with: priorProfile)
            source = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]; source["storage"] = "recovery"
            if source["bucket"] as? String == "databaseSnapshots" { var value = source["value"] as! [String: Any], snapshot = value["snapshot"] as! [String: Any]; snapshot["session_binding"] = "binding-old"; snapshot["data_revision"] = 8; value["snapshot"] = snapshot; source["value"] = value }
            if source["ref"] as? String == "row-delete" { var value = source["value"] as! [String: Any], operation = value["operation"] as! [String: Any]; operation["target_id"] = "row-new"; operation["base_rows"] = ["row-new": ["updated_at": "1970-01-01T00:00:00.000Z", "after_operation": "row-patch-1"], "row-dependent": ["updated_at": "1970-01-01T00:00:00.000Z", "after_operation": "row-dependent-op"]]; value["operation"] = operation; source["value"] = value }
            promoted.append(source)
        }
        for (index, name) in ["Changed once", "Changed twice"].enumerated() {
            let id = "row-patch-" + String(index), operation: [String: Any] = ["id": id, "kind": "row.patch", "target_id": "row-new", "database_id": "database", "body": ["properties": ["name": name]], "base": ["schema": ["name": ["id": "name", "name": "Name", "type": "title"]], "properties": ["name": index == 0 ? "New" : "Changed once"], "fields": [String: Any]()], "depends_on": [index == 0 ? "row-new-op" : "row-patch-0"]]
            promoted.append(["ref": id, "storage": "recovery", "bucket": "mutations", "key": [priorProfile, id], "value": ["profileId": priorProfile, "id": id, "resourceKey": priorProfile + "|database|database", "operation": operation, "status": "pending", "sequence": index + 3, "createdAt": 1, "updatedAt": 1]])
        }
        row["sourceRecords"] = promoted; row["expected"] = expected(promoted.map { $0["ref"] as! String }); row["events"] = [["type": "select_handle"], ["type": "prepare"], ["type": "collect"], ["type": "commit", "confirm": true]]
        let rowDriver = try IOSReconcileVectorDriver(row, corpus: corpus, directory: directory.appendingPathComponent(row["id"] as! String)); do { try rowDriver.run() } catch { throw NSError(domain: "FocusedPromotion", code: 1, userInfo: [NSLocalizedDescriptionKey: "row fixture " + rowDriver.stage + " reasons=" + rowDriver.store.reconciliationTestReasons.joined(separator: ",") + ": " + ((error as? FountainOutboxError)?.code ?? error.localizedDescription)]) }
        let rowOperations = try rowDriver.activeRows("mutations").map { $0["operation"] as! [String: Any] }
        let root = rowOperations.first { $0["kind"] as? String == "row.create" && (($0["body"] as? [String: Any])?["properties"] as? [String: Any])?["name"] as? String == "New" }!, child = rowOperations.first { $0["kind"] as? String == "row.create" && (($0["body"] as? [String: Any])?["properties"] as? [String: Any])?["name"] as? String == "Dependent" }!
        let patches = ["Changed once", "Changed twice"].map { name in rowOperations.first { (($0["body"] as? [String: Any])?["properties"] as? [String: Any])?["name"] as? String == name }! }, deletion = rowOperations.first { $0["kind"] as? String == "row.delete" }!
        try IOSReconcileVectors.require(((patches[0]["base"] as! [String: Any])["properties"] as! [String: Any])["name"] as? String == "New" && ((patches[1]["base"] as! [String: Any])["properties"] as! [String: Any])["name"] as? String == "Changed once", "Sequential row patches did not advance the private virtual base")
        let bases = deletion["base_rows"] as! [String: [String: Any]], rootID = root["target_id"] as! String, childID = child["target_id"] as! String
        try IOSReconcileVectors.require(Set(bases.keys) == Set([rootID, childID]) && bases[rootID]?["after_operation"] as? String == patches[1]["id"] as? String && bases[childID]?["after_operation"] as? String == child["id"] as? String, "Selected subtree deletion lost exact fresh membership/latest predecessor receipts")
        try IOSReconcileVectors.require(Set(deletion["depends_on"] as! [String]).isSuperset(of: [patches[1]["id"] as! String, child["id"] as! String]), "Selected subtree deletion omitted fresh predecessor dependencies")
        passed.append(row["id"] as! String)
        var cleared = cases.first { $0["id"] as? String == "compatible-row-mutation" }!
        cleared["id"] = "current-cleared-null-relation"
        var clearedRows = cleared["sourceRecords"] as! [[String: Any]]
        let schema = (((clearedRows.first { $0["bucket"] as? String == "databaseSnapshots" }!["value"] as! [String: Any])["snapshot"] as! [String: Any])["database"] as! [String: Any])["properties"] as! [[String: Any]]
        let relation = schema.first { $0["id"] as? String == "link" }!
        for index in clearedRows.indices where clearedRows[index]["ref"] as? String == "row-patch" {
            var value = clearedRows[index]["value"] as! [String: Any], operation = value["operation"] as! [String: Any], body = operation["body"] as! [String: Any], properties = body["properties"] as! [String: Any], base = operation["base"] as! [String: Any], baseSchema = base["schema"] as! [String: Any], baseValues = base["properties"] as! [String: Any]
            properties["link"] = NSNull(); body["properties"] = properties; baseSchema["link"] = relation; baseValues["link"] = []; base["schema"] = baseSchema; base["properties"] = baseValues; operation["body"] = body; operation["base"] = base; value["operation"] = operation; clearedRows[index]["value"] = value
        }
        cleared["sourceRecords"] = clearedRows
        let clearDriver = try IOSReconcileVectorDriver(cleared, corpus: corpus, directory: directory.appendingPathComponent(cleared["id"] as! String)); try clearDriver.run()
        let retained = try clearDriver.activeRows("mutations").first!["operation"] as! [String: Any]
        try IOSReconcileVectors.require(((retained["body"] as! [String: Any])["properties"] as! [String: Any])["link"] is NSNull, "Whole null relation clear was changed or widened")
        passed.append(cleared["id"] as! String)
        return passed
    }
}
