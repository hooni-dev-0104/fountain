import Foundation
import SQLite3
#if os(iOS)
@testable import App
#endif

// Actual grant -> canonical observation -> normal COMMIT -> native archive ->
// new current grant. SQL only inspects output, never manufactures provenance.
enum IOSNativeLocalExportFixtures {
    static func run(_ raw: [String: Any], directory: URL) throws -> [String: Any] {
        if CommandLine.arguments.contains("--body") { return try IOSPromotionBodyFixtures.run(raw, directory: directory, large: CommandLine.arguments.contains("--large")) }
        typealias IO = IOSReconcileVectors
        let corpus = try IO.adapt(raw, shift: Date().timeIntervalSince1970 * 1000 - (raw["clockMs"] as! NSNumber).doubleValue) as! [String: Any]
        let cases = corpus["cases"] as! [[String: Any]]
        var vector = cases.first { $0["id"] as? String == "same-actor-promotion" }!
        vector["id"] = "native-local-readable-export"
        var sourceRows = vector["sourceRecords"] as! [[String: Any]]
        for index in sourceRows.indices where sourceRows[index]["bucket"] as? String == "drafts" {
            var value = sourceRows[index]["value"] as! [String: Any], draft = value["draft"] as! [String: Any]
            draft["blocks"] = [["id": "local-block", "type": "paragraph", "text": "가족 로컬 보관🙂", "parent_id": NSNull(), "rich_text": [["text": "가족 로컬 보관🙂", "marks": ["bold": true]]]]]
            value["draft"] = draft; sourceRows[index]["value"] = value
        }
        vector["sourceRecords"] = sourceRows
        let root = directory.appendingPathComponent("qualified", isDirectory: true)
        let driver = try IOSReconcileVectorDriver(vector, corpus: corpus, directory: root)
        try driver.seed()
        let authority = try FountainRecovery.Authority.session(IO.json(driver.session(driver.authority)), origin: driver.origin, reference: driver.reference)
        let reader = try FountainRecovery(authority: authority, testingDirectory: root); defer { reader.close() }
        var selected: [String] = [], cursor: String?, items: [[String: Any]] = []
        repeat {
            let inventory = try reader.inventory(authority, cursor: cursor, count: 100)
            items += inventory["items"] as! [[String: Any]]; cursor = inventory["next"] as? String
        } while cursor != nil
        let localSizes = Set(driver.originals.values.map { $0.count })
        selected = items.filter { localSizes.contains($0["byteLength"] as! Int) }.map { $0["handle"] as! String }
        var permissions: FountainRecovery.Responses = [:]
        for response in vector["responses"] as! [[String: Any]] { permissions[response["path"] as! String] = (response["status"] as! Int, try IO.json(response["body"] ?? [:])) }
        let paths = try reader.authorityPaths(selected, authority)
        let localID = ((vector["sourceRecords"] as! [[String: Any]]).first { $0["bucket"] as? String == "localPages" }!["value"] as! [String: Any])["metadata"] as! [String: Any]
        let target = (localID["page"] as! [String: Any])["id"] as! String
        try IO.require(!paths.contains("/api/pages/" + FountainOutbox.encodeURIComponent(target) + "/collaboration"), "Privately confirmed never-server local page incorrectly requires its nonexistent server ID")
        let exports = directory.appendingPathComponent("exports", isDirectory: true)
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let prepared = try reader.prepare(selected, other: authority, responses: permissions, observedAt: Date().timeIntervalSince1970 * 1000) { name in
            let folder = exports.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let url = folder.appendingPathComponent(name); FileManager.default.createFile(atPath: url.path, contents: Data(), attributes: [.posixPermissions: 0o600]); return url
        }
        if prepared["blockedCount"] as? Int != 0 {
            var blocked: [String] = []
            for item in items where selected.contains(item["handle"] as! String) {
                let single = try reader.prepare([item["handle"] as! String], other: authority, responses: permissions, observedAt: Date().timeIntervalSince1970 * 1000) { name in
                    let folder = exports.appendingPathComponent(UUID().uuidString, isDirectory: true); try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]); let url = folder.appendingPathComponent(name); FileManager.default.createFile(atPath: url.path, contents: Data(), attributes: [.posixPermissions: 0o600]); return url
                }
                if single["blockedCount"] as? Int != 0 { blocked += driver.originals.filter { $0.value.count == item["byteLength"] as? Int }.map { $0.key } }
            }
            throw NSError(domain: "LocalExportFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Blocked fixture references: " + blocked.joined(separator: ",")])
        }
        try IO.require((prepared["readyCount"] as? Int ?? 0) == selected.count && (prepared["blockedCount"] as? Int ?? -1) == 0, "Native-local DAG blocked: selected=\(selected.count) ready=\(prepared["readyCount"] ?? -1) blocked=\(prepared["blockedCount"] ?? -1)")
        let files = try reader.saveFiles(prepared["exportToken"] as! String, handles: selected, other: authority, responses: permissions)
        try IO.require(!files.isEmpty, "Native-local readable export is empty")
        let rendered = try files.map { String(data: try Data(contentsOf: $0), encoding: .utf8)! }.joined()
        try IO.require(rendered.contains("가족 로컬 보관🙂") && !["owner_id", "permissions", "access_level", "session_binding", "cache_binding"].contains(where: rendered.contains), "Readable native-local projection lost own text or copied historical authority")
        var denied = permissions
        for path in paths where path != "/api/workspace" { denied[path] = (403, Data()) }
        do { _ = try reader.saveFiles(prepared["exportToken"] as! String, handles: selected, other: authority, responses: denied); throw NSError(domain: "LocalExportFixture", code: 2) }
        catch let error as FountainRecoveryError { try IO.require(error == .access || error == .stale, "Denied parent returned an unrelated failure") }
        let beforeObserved = try driver.store.open(), sourceBytes = try IO.sql(driver.file, "SELECT value FROM recovery ORDER BY rowid").map { $0[0] as! Data }
        let snapshot = ((sourceRows.first { $0["bucket"] as? String == "snapshots" }!["value"] as! [String: Any])["snapshot"] as! [String: Any])
        let actualBody = driver.bound(snapshot, session: driver.session(driver.authority))
        var closedForMarker = false
        let recoveryAdmission = try driver.store.admitRecoveryObservation(authority, sessionRef: driver.reference)
        let marked = try driver.store.observeRecoveryServerPage(admission: recoveryAdmission, path: "/api/pages/" + FountainOutbox.encodeURIComponent(target) + "/collaboration", status: 200, data: IO.json(actualBody), sessionRef: driver.reference) { reader.close(); closedForMarker = true }
        try IO.require(marked && closedForMarker && driver.store.open()["head"] as? Int == beforeObserved["head"] as? Int && driver.store.proofEpoch() > beforeObserved["proofEpoch"] as! Int, "First actual private Recovery200 must close snapshot and durably fence local-read classification without a head write")
        let afterMarker = try Data(contentsOf: driver.file)
        var closedAgain = false
        let repeatedAdmission = try driver.store.admitRecoveryObservation(authority, sessionRef: driver.reference)
        let repeated = try driver.store.observeRecoveryServerPage(admission: repeatedAdmission, path: "/api/pages/" + FountainOutbox.encodeURIComponent(target) + "/collaboration", status: 200, data: IO.json(actualBody), sessionRef: driver.reference) { closedAgain = true }
        try IO.require(!repeated && !closedAgain && Data(contentsOf: driver.file) == afterMarker, "Already-observed Recovery page rewrote native source or invalidated inventory")
        let freshReader = try FountainRecovery(authority: authority, testingDirectory: root); defer { freshReader.close() }
        let freshItems = (try freshReader.inventory(authority, cursor: nil, count: 100))["items"] as! [[String: Any]]
        let freshHandles = freshItems.filter { localSizes.contains($0["byteLength"] as! Int) }.map { $0["handle"] as! String }
        let observedPaths = try freshReader.authorityPaths(freshHandles, authority)
        try IO.require(observedPaths.contains("/api/pages/" + FountainOutbox.encodeURIComponent(target) + "/collaboration"), "Observed local page still borrowed its old parent proof")
        permissions["/api/pages/" + FountainOutbox.encodeURIComponent(target) + "/collaboration"] = (403, Data())
        let blocked = try freshReader.prepare(freshHandles, other: authority, responses: permissions, observedAt: Date().timeIntervalSince1970 * 1000) { _ in throw NSError(domain: "LocalExportFixture", code: 3) }
        try IO.require(blocked["readyCount"] as? Int == 0 && blocked["blockedCount"] as? Int == freshHandles.count && IO.sql(driver.file, "SELECT value FROM recovery ORDER BY rowid").map({ $0[0] as! Data }) == sourceBytes, "Observed403 used parent fallback or lost source archives")
        var collision = vector; collision["id"] = "quarantine-before-native-local-version"; collision["mode"] = "upgrade"; collision["authority"] = "current"
        let collisionRoot = directory.appendingPathComponent("prior-untrusted", isDirectory: true), prior = try IOSReconcileVectorDriver(collision, corpus: corpus, directory: collisionRoot)
        try prior.seed()
        let untrusted = try IO.sql(prior.file, "SELECT rowid,value FROM recovery ORDER BY rowid").map { ($0[0] as! Int, $0[1] as! Data) }
        _ = try prior.submit(prior.putChanges(sourceRows))
        for (row, bytes) in untrusted {
            let stamp = try IO.sql(prior.file, "SELECT value FROM control WHERE id=?", ["archiveAuthority:" + String(row)]).first![0] as! Data
            let attribution = try JSONSerialization.jsonObject(with: stamp) as! [String: Any]
            try IO.require(attribution["trust"] as? String == "upgrade" && attribution["nativeLocal"] == nil && (try IO.sql(prior.file, "SELECT value FROM recovery WHERE rowid=?", [row]))[0][0] as! Data == bytes, "Later identical native acceptance retro-stamped or changed an older untrusted version")
        }
        let priorAuthority = try FountainRecovery.Authority.session(IO.json(prior.session(prior.authority)), origin: prior.origin, reference: prior.reference)
        let priorReader = try FountainRecovery(authority: priorAuthority, testingDirectory: collisionRoot); defer { priorReader.close() }
        let priorItems = (try priorReader.inventory(priorAuthority, cursor: nil, count: 100))["items"] as! [[String: Any]], oldSizes = Set(untrusted.map { $0.1.count })
        let oldHandles = priorItems.filter { oldSizes.contains($0["byteLength"] as! Int) }.map { $0["handle"] as! String }
        try IO.require(oldHandles.count == 5 && priorReader.authorityPaths(oldHandles, priorAuthority).contains("/api/pages/" + FountainOutbox.encodeURIComponent(target) + "/collaboration"), "Untrusted old raw-matching versions borrowed a later private native-local context")
        for topLevel in [false, true] {
            var roleVector = vector; roleVector["id"] = topLevel ? "guest-local-top-denied" : "guest-local-child-allowed"
            if topLevel {
                var rows = roleVector["sourceRecords"] as! [[String: Any]]
                for i in rows.indices {
                    var value = rows[i]["value"] as! [String: Any]
                    if rows[i]["bucket"] as? String == "mutations" { var operation = value["operation"] as! [String: Any], body = operation["body"] as! [String: Any]; body["parent_id"] = NSNull(); operation["body"] = body; value["operation"] = operation }
                    if rows[i]["bucket"] as? String == "localPages" { var metadata = value["metadata"] as! [String: Any], page = metadata["page"] as! [String: Any]; page["parent_id"] = NSNull(); metadata["page"] = page; value["metadata"] = metadata }
                    if rows[i]["bucket"] as? String == "snapshots" { var snapshot = value["snapshot"] as! [String: Any], page = snapshot["page"] as! [String: Any]; page["parent_id"] = NSNull(); snapshot["page"] = page; value["snapshot"] = snapshot }
                    rows[i]["value"] = value
                }
                roleVector["sourceRecords"] = rows
            }
            let roleRoot = directory.appendingPathComponent(roleVector["id"] as! String, isDirectory: true), roleDriver = try IOSReconcileVectorDriver(roleVector, corpus: corpus, directory: roleRoot)
            try roleDriver.seed()
            var guestSession = roleDriver.session(roleDriver.authority), guestMember = guestSession["member"] as! [String: Any]; guestMember["role"] = "guest"; guestSession["member"] = guestMember
            try roleDriver.grant(guestSession, reference: roleDriver.reference)
            let guestAuthority = try FountainRecovery.Authority.session(IO.json(guestSession), origin: roleDriver.origin, reference: roleDriver.reference)
            let roleReader = try FountainRecovery(authority: guestAuthority, testingDirectory: roleRoot); defer { roleReader.close() }
            let roleItems = (try roleReader.inventory(guestAuthority, cursor: nil, count: 100))["items"] as! [[String: Any]], size = roleDriver.originals["local-draft"]!.count
            let handles = roleItems.filter { $0["byteLength"] as? Int == size }.map { $0["handle"] as! String }
            try IO.require(handles.count == 2, "Guest local export must inspect exact privately stamped active/archive draft versions")
            var guestResponses = permissions
            var workspace = try JSONSerialization.jsonObject(with: guestResponses["/api/workspace"]!.1) as! [String: Any]; workspace["teamspaces"] = []; guestResponses["/api/workspace"] = (200, try IO.json(workspace))
            let before = try IO.sql(roleDriver.file, "SELECT value FROM recovery ORDER BY rowid").map { $0[0] as! Data }; var made = 0
            let prepared = try roleReader.prepare(handles, other: guestAuthority, responses: guestResponses, observedAt: Date().timeIntervalSince1970 * 1000) { name in
                made += 1; let folder = exports.appendingPathComponent(UUID().uuidString, isDirectory: true); try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]); let file = folder.appendingPathComponent(name); FileManager.default.createFile(atPath: file.path, contents: Data(), attributes: [.posixPermissions: 0o600]); return file
            }
            try IO.require(prepared["readyCount"] as? Int == (topLevel ? 0 : 2) && prepared["blockedCount"] as? Int == (topLevel ? 2 : 0), "Guest export borrowed top-level creation authority or denied a freshly editable parent")
            try IO.require(IO.sql(roleDriver.file, "SELECT value FROM recovery ORDER BY rowid").map({ $0[0] as! Data }) == before, "Guest export changed historical source bytes")
            if topLevel { try IO.require(made == 0, "Guest top-level denial created export files") }
            else { let files = try roleReader.saveFiles(prepared["exportToken"] as! String, handles: handles, other: guestAuthority, responses: guestResponses); try IO.require(try files.map({ String(data: try Data(contentsOf: $0), encoding: .utf8)! }).joined().contains("가족 로컬 보관🙂"), "Guest child export lost its privately native own body") }
        }
        let knownCase = cases.first { $0["id"] as? String == "confirmed-upgrade" }!, knownRoot = directory.appendingPathComponent("known-original-denied", isDirectory: true)
        let known = try IOSReconcileVectorDriver(knownCase, corpus: corpus, directory: knownRoot); try known.seed()
        var observedWorkspace = known.responses["workspace"]!["body"] as! [String: Any]
        let access = observedWorkspace["access_revision"] as! Int, data = observedWorkspace["data_revision"] as! Int
        observedWorkspace["access_revision"] = access + 1; observedWorkspace["data_revision"] = data + 1
        var visible = observedWorkspace["pages"] as! [[String: Any]]
        visible.append(["id": target, "access_level": 3, "revision": 1, "locked": false, "archived": false]); observedWorkspace["pages"] = visible
        try known.store.observeResource(path: "/api/workspace", method: "GET", status: 200, data: IO.json(observedWorkspace), sessionRef: known.reference)
        for key in Array(known.responses.keys) { var response = known.responses[key]!, body = response["body"] as! [String: Any]; body["access_revision"] = access + 2; body["data_revision"] = data + 2; response["body"] = body; known.responses[key] = response }
        let originalPath = "/api/pages/" + FountainOutbox.encodeURIComponent(target) + "/collaboration"
        known.responses["original-denied"] = ["ref": "original-denied", "path": originalPath, "method": "GET", "status": 403, "body": [:], "sessionRef": known.reference]
        let knownBefore = try known.store.open(), knownBytes = try IO.sql(known.file, "SELECT value FROM recovery ORDER BY rowid").map { $0[0] as! Data }
        known.selected = (knownBefore["reconciliationHandles"] as! [[String: Any]]).map { $0["handle"] as! String }
        known.state = try known.store.reconcile(["generation": 1, "phase": "prepare", "lease": knownBefore["lease"]!, "baseHead": knownBefore["head"]!, "proofEpoch": knownBefore["proofEpoch"]!, "mode": "upgrade", "handles": known.selected], admissionWatermark: 0, sessionRef: known.reference)
        var originalDenied = false
        do { try known.collect([:]) } catch let error as FountainOutboxError { guard error == .access || error == .retry else { throw error }; originalDenied = true }
        try IO.require(known.capturedPaths.contains(originalPath), "Known server original was skipped using localOnly/upgrade metadata")
        try IO.require(originalDenied && known.accepted == nil && known.receiptCount() == 0, "Original403 plus editable parent produced an active historical clone")
        try IO.require(known.store.open()["head"] as? Int == knownBefore["head"] as? Int, "Failed historical promotion changed the active head")
        try IO.require(IO.sql(known.file, "SELECT value FROM recovery ORDER BY rowid").map({ $0[0] as! Data }) == knownBytes, "Original403 changed or dropped selected source versions")
        let blockedRoot = directory.appendingPathComponent("blocked-negative-observation", isDirectory: true), blockedStore = try IOSReconcileVectorDriver(knownCase, corpus: corpus, directory: blockedRoot)
        try blockedStore.seed()
        let blockedAuthority = try FountainRecovery.Authority.session(IO.json(blockedStore.session(blockedStore.authority)), origin: blockedStore.origin, reference: blockedStore.reference)
        let oldAdmission = try blockedStore.store.admitRecoveryObservation(blockedAuthority, sessionRef: blockedStore.reference)
        _ = try blockedStore.submit([["op": "put", "bucket": "meta", "key": "revoked:" + blockedStore.profile, "value": ["id": "revoked:" + blockedStore.profile, "profileId": blockedStore.profile]]], tx: "blocked-terminal")
        let blockedBefore = try blockedStore.store.open(), blockedBytes = try IO.sql(blockedStore.file, "SELECT value FROM recovery ORDER BY rowid").map { $0[0] as! Data }
        try IO.require(blockedBefore["identityState"] as? String == "blocked", "Negative-observation fixture failed to enter terminally blocked state")
        var blockedCanonical = blockedStore.bound(snapshot, session: blockedStore.session(blockedStore.authority))
        let blockedProjection = blockedStore.responses["workspace"]!["body"] as! [String: Any]
        blockedCanonical["access_revision"] = blockedProjection["access_revision"]; blockedCanonical["data_revision"] = blockedProjection["data_revision"]
        let blockedBody = try IO.json(blockedCanonical)
        do { _ = try blockedStore.store.observeRecoveryServerPage(admission: oldAdmission, path: originalPath, status: 200, data: blockedBody, sessionRef: blockedStore.reference, beforeMutation: {}); throw NSError(domain: "LocalExportFixture", code: 7) }
        catch let error as FountainOutboxError { try IO.require(error == .stale, "Pre-cleanup admission survived terminal boundary change") }
        let blockedAdmission = try blockedStore.store.admitRecoveryObservation(blockedAuthority, sessionRef: blockedStore.reference)
        let blockedMarker = try blockedStore.store.observeRecoveryServerPage(admission: blockedAdmission, path: originalPath, status: 200, data: blockedBody, sessionRef: blockedStore.reference, beforeMutation: {})
        try IO.require(blockedMarker && blockedStore.store.open()["identityState"] as? String == "blocked" && blockedStore.store.open()["head"] as? Int == blockedBefore["head"] as? Int, "Actual Recovery negative marker revived blocked business authority or advanced the input head")
        try IO.require(blockedStore.store.proofEpoch() > blockedBefore["proofEpoch"] as! Int && IO.sql(blockedStore.file, "SELECT value FROM recovery ORDER BY rowid").map({ $0[0] as! Data }) == blockedBytes, "Blocked negative marker lost source or failed to fence metadata")
        let terminalCaps = blockedStore.journalRequests["blocked-terminal"]!
        do { _ = try blockedStore.store.commit(lease: terminalCaps["lease"] as! String, txID: "blocked-terminal", baseHead: terminalCaps["baseHead"] as! Int, proofEpoch: terminalCaps["proofEpoch"] as! Int, digest: terminalCaps["digest"] as! String, sessionRef: blockedStore.reference); throw NSError(domain: "LocalExportFixture", code: 9) }
        catch let error as FountainOutboxError { try IO.require(error == .conflict && blockedStore.store.open()["identityState"] as? String == "blocked", "Later negative proof change revived historical terminal metadata") }
        do { _ = try blockedStore.store.admitRecoveryObservation(blockedAuthority, sessionRef: "foreign-cookie"); throw NSError(domain: "LocalExportFixture", code: 8) }
        catch let error as FountainOutboxError { try IO.require(error == .access, "Foreign cookie admitted a Recovery negative observation") }
        let policyRoot = directory.appendingPathComponent("workspace-export-policy", isDirectory: true), policy = try IOSReconcileVectorDriver(knownCase, corpus: corpus, directory: policyRoot)
        try policy.seed(); var owner = policy.session(policy.authority), ownerMember = owner["member"] as! [String: Any]; ownerMember["role"] = "owner"; owner["member"] = ownerMember; try policy.grant(owner, reference: policy.reference)
        let policyAuthority = try FountainRecovery.Authority.session(IO.json(owner), origin: policy.origin, reference: policy.reference)
        let policyReader = try FountainRecovery(authority: policyAuthority, testingDirectory: policyRoot); defer { policyReader.close() }
        let policyItems = (try policyReader.inventory(policyAuthority, cursor: nil, count: 100))["items"] as! [[String: Any]], draftSize = policy.originals["local-draft"]!.count
        let policyHandles = policyItems.filter { $0["byteLength"] as? Int == draftSize }.map { $0["handle"] as! String }; try IO.require(policyHandles.count == 1, "Policy fixture must select one actual captured draft")
        var policyResponses: FountainRecovery.Responses = [:]
        for response in knownCase["responses"] as! [[String: Any]] { policyResponses[response["path"] as! String] = (response["status"] as! Int, try IO.json(response["body"] ?? [:])) }
        policyResponses[originalPath] = (200, try IO.json(policy.bound(snapshot, session: owner)))
        var allowedWorkspace = try JSONSerialization.jsonObject(with: policyResponses["/api/workspace"]!.1) as! [String: Any]; allowedWorkspace["settings"] = ["disable_export": false]
        policyResponses["/api/workspace"] = (200, try IO.json(allowedWorkspace))
        var freshOriginal = try JSONSerialization.jsonObject(with: policyResponses[originalPath]!.1) as! [String: Any]
        freshOriginal["access_revision"] = allowedWorkspace["access_revision"]; freshOriginal["data_revision"] = allowedWorkspace["data_revision"]
        policyResponses[originalPath] = (200, try IO.json(freshOriginal))
        var disabledWorkspace = allowedWorkspace; disabledWorkspace["settings"] = ["disable_export": true]
        var forbiddenResponses = policyResponses; forbiddenResponses["/api/workspace"] = (200, try IO.json(disabledWorkspace))
        var made = 0, policyCreated: [URL] = []
        func policyFile(_ name: String) throws -> URL {
            made += 1; let folder = exports.appendingPathComponent(UUID().uuidString, isDirectory: true); try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]); let file = folder.appendingPathComponent(name); FileManager.default.createFile(atPath: file.path, contents: Data(), attributes: [.posixPermissions: 0o600]); policyCreated.append(file); return file
        }
        let allowed = try policyReader.prepare(policyHandles, other: policyAuthority, responses: policyResponses, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: policyFile)
        try IO.require(allowed["readyCount"] as? Int == 1 && made > 0, "Explicit false export policy rejected an owner with fresh direct proof")
        let policyRaw = try IO.sql(policy.file, "SELECT value FROM recovery ORDER BY rowid").map { $0[0] as! Data }
        for (kind, accessDelta, dataDelta) in [("page", -1, 0), ("page", 1, 0), ("page", 0, -1), ("database", -1, 0)] {
            var unstable = policyResponses
            let access = (allowedWorkspace["access_revision"] as! Int) + accessDelta, data = (allowedWorkspace["data_revision"] as! Int) + dataDelta
            if kind == "page" { var body = freshOriginal; body["access_revision"] = access; body["data_revision"] = data; unstable[originalPath] = (200, try IO.json(body)) }
            else { var body = policy.bound(["database": ["id": "fresh-db", "access_level": 3, "can_create_row": true, "properties": []], "rows": []], session: owner); body["access_revision"] = access; body["data_revision"] = data; unstable["/api/databases/fresh-db"] = (200, try IO.json(body)) }
            if kind == "page" && accessDelta == -1 {
                let start = policyCreated.count
                let saveReady = try policyReader.prepare(policyHandles, other: policyAuthority, responses: policyResponses, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: policyFile), token = saveReady["exportToken"] as! String
                let files = Array(policyCreated.dropFirst(start))
                do { _ = try policyReader.saveFiles(token, handles: policyHandles, other: policyAuthority, responses: unstable); throw NSError(domain: "LocalExportFixture", code: 11) }
                catch let error as FountainRecoveryError { try IO.require(error == .stale, "Final save borrowed older resource access from a mixed permission cut") }
                try IO.require(!policyReader.validSave(token, other: policyAuthority) && files.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) }, "Stale final-save capability or private output files survived invalidation")
            }
            made = 0
            do { _ = try policyReader.prepare(policyHandles, other: policyAuthority, responses: unstable, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: policyFile); throw NSError(domain: "LocalExportFixture", code: 10, userInfo: [NSLocalizedDescriptionKey: "Mixed Recovery permission floors produced an export"]) }
            catch let error as FountainRecoveryError { try IO.require(error == .stale, "Mixed permission floors did not request a fresh explicit retry") }
            try IO.require(made == 0 && IO.sql(policy.file, "SELECT value FROM recovery ORDER BY rowid").map({ $0[0] as! Data }) == policyRaw, "Mixed permission floors created files or changed source")
        }
        do { _ = try policyReader.saveFiles(allowed["exportToken"] as! String, handles: policyHandles, other: policyAuthority, responses: forbiddenResponses); throw NSError(domain: "LocalExportFixture", code: 4) }
        catch let error as FountainRecoveryError { try IO.require(error == .access || error == .stale, "Changed export policy returned an unrelated error") }
        made = 0
        do { _ = try policyReader.prepare(policyHandles, other: policyAuthority, responses: forbiddenResponses, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: policyFile); throw NSError(domain: "LocalExportFixture", code: 5, userInfo: [NSLocalizedDescriptionKey: "Owner exported while actual workspace disable_export=true"]) }
        catch let error as FountainRecoveryError { try IO.require(error == .access, "Disabled export returned an unrelated error") }
        try IO.require(made == 0 && IO.sql(policy.file, "SELECT value FROM recovery ORDER BY rowid").map({ $0[0] as! Data }) == policyRaw, "Disabled export created files or altered source inputs")
        for value: Any in ["false", 0, NSNull(), ["enabled": false]] {
            var malformed = allowedWorkspace; malformed["settings"] = ["disable_export": value]; var responses = policyResponses; responses["/api/workspace"] = (200, try IO.json(malformed)); made = 0
            do { _ = try policyReader.prepare(policyHandles, other: policyAuthority, responses: responses, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: policyFile); throw NSError(domain: "LocalExportFixture", code: 6) }
            catch let error as FountainRecoveryError { try IO.require(error == .access && made == 0, "Malformed present export policy was treated as omitted/false") }
        }
        var legacyWorkspace = allowedWorkspace; legacyWorkspace.removeValue(forKey: "settings"); var legacyResponses = policyResponses; legacyResponses["/api/workspace"] = (200, try IO.json(legacyWorkspace))
        let legacy = try policyReader.prepare(policyHandles, other: policyAuthority, responses: legacyResponses, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: policyFile)
        try IO.require(legacy["readyCount"] as? Int == 1, "Omitted legacy export flag lost its false default")
        let freshPolicy = try policyReader.prepare(policyHandles, other: policyAuthority, responses: policyResponses, observedAt: Date().timeIntervalSince1970 * 1000, makeFile: policyFile), policyToken = freshPolicy["exportToken"] as! String
        policyReader.noteCanonical(path: "/api/workspace", status: 200, data: try IO.json(disabledWorkspace))
        try IO.require(!policyReader.validSave(policyToken, other: policyAuthority), "Actual later disabled workspace proof left a prepared export capability alive")
        try IO.require(IO.sql(policy.file, "SELECT value FROM recovery ORDER BY rowid").map({ $0[0] as! Data }) == policyRaw && policy.store.open()["identityState"] as? String == "verified", "Export policy erased source or suspended the actual native account")
        policyReader.close()
        for key in Array(policy.responses.keys) { var response = policy.responses[key]!, body = response["body"] as! [String: Any]; if key == "workspace" { body["settings"] = ["disable_export": true] }; response["body"] = body; policy.responses[key] = response }
        let policyBefore = try policy.store.open(); policy.selected = (policyBefore["reconciliationHandles"] as! [[String: Any]]).map { $0["handle"] as! String }
        policy.state = try policy.store.reconcile(["generation": 1, "phase": "prepare", "lease": policyBefore["lease"]!, "baseHead": policyBefore["head"]!, "proofEpoch": policyBefore["proofEpoch"]!, "mode": "upgrade", "handles": policy.selected], admissionWatermark: 0, sessionRef: policy.reference)
        try policy.collect([:])
        try IO.require(policy.state?["state"] as? String == "ready" && (policy.state?["counts"] as? [String: Int])?["import", default: 0] ?? 0 > 0, "Export-only policy accidentally disabled ordinary reconciliation")
        #if os(iOS)
        let platform = "iOS"
        #else
        let platform = "macOS"
        #endif
        return ["actualProductionSwiftSQLite": true, "checks": 56, "passed": ["native-local-readable-export", "local-export-parent-denied", "server-observed-recovery-restricts-fallback", "server-observed-idempotent", "quarantine-before-native-local-version", "known-original-denied-cannot-promote", "guest-native-local-child", "guest-native-local-top-denied", "blocked-native-negative-marker", "recovery-cross-response-permission-floors", "workspace-export-policy-owner", "workspace-export-policy-malformed", "workspace-export-policy-legacy-default", "workspace-export-policy-keeps-business-authority"], "platform": platform]
    }
}
