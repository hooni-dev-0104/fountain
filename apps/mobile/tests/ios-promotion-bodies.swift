import Foundation
#if os(iOS)
@testable import App
#endif

// Body inputs enter through the real verified quarantine protocol, never a
// fabricated historical owner stamp. The production transform generates output.
enum IOSPromotionBodyFixtures {
    static func run(_ raw: [String: Any], directory: URL, large: Bool) throws -> [String: Any] {
        typealias IO = IOSReconcileVectors
        let corpus = try IO.adapt(raw, shift: Date().timeIntervalSince1970 * 1000 - (raw["clockMs"] as! NSNumber).doubleValue) as! [String: Any]
        let template = (corpus["cases"] as! [[String: Any]]).first { $0["id"] as? String == "confirmed-upgrade" }!
        var passed: [String] = []
        let rich: [[String: Any]] = [
            ["id": "source-root", "type": "heading_1", "text": "완전한 본문🙂", "parent_id": NSNull(), "rich_text": [["text": "완전한 ", "marks": ["bold": true]], ["text": "본문🙂", "marks": ["link": "https://example.invalid/notes"]]]],
            ["id": "source-child", "type": "to_do", "checked": true, "text": "가족", "parent_id": "source-root", "rich_text": [["text": "가족", "marks": ["italic": true, "color": "blue"]]]]
        ]
        func exercise(_ name: String, blocks: [[String: Any]], supported: Bool, conflicting: Bool = false, other: [[String: Any]]? = nil, deniedParent: Bool = false, amend: ((inout [[String: Any]]) throws -> Void)? = nil) throws {
            var vector = template, sources = template["sourceRecords"] as! [[String: Any]]
            vector["id"] = name
            for index in sources.indices where sources[index]["bucket"] as? String == "drafts" {
                var value = sources[index]["value"] as! [String: Any], draft = value["draft"] as! [String: Any]
                draft["blocks"] = blocks
                if conflicting { var operations = draft["ops"] as! [[String: Any]]; operations[0]["block_type"] = "heading1"; draft["ops"] = operations }
                value["draft"] = draft; sources[index]["value"] = value
            }
            if let other {
                let creation = (sources.first { $0["bucket"] as? String == "mutations" }!["value"] as! [String: Any])["operation"] as! [String: Any]
                let oldTarget = creation["target_id"] as! String, oldEpoch = creation["document_epoch"] as! String, oldCreation = creation["id"] as! String
                for row in sources {
                    let text = String(data: try IO.json(row), encoding: .utf8)!.replacingOccurrences(of: oldTarget, with: "88888888-8888-4888-8888-888888888888").replacingOccurrences(of: oldEpoch, with: "99999999-9999-4999-8999-999999999999").replacingOccurrences(of: oldCreation, with: "77777777-7777-4777-8777-777777777777")
                    var duplicate = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]; duplicate["ref"] = (row["ref"] as! String) + "-other"
                    if duplicate["bucket"] as? String == "drafts" { var value = duplicate["value"] as! [String: Any], draft = value["draft"] as! [String: Any]; draft["blocks"] = other; value["draft"] = draft; duplicate["value"] = value }
                    sources.append(duplicate)
                }
            }
            try amend?(&sources)
            vector["sourceRecords"] = sources
            vector["expected"] = ["result": deniedParent ? "retryable" : "committed", "requiresConfirmation": true, "records": ["archived": sources.map { $0["ref"] as! String }], "assertions": [], "fresh": [], "requiredReasons": supported ? [] : ["unsupported_input"]]
            let driver = try IOSReconcileVectorDriver(vector, corpus: corpus, directory: directory.appendingPathComponent(name, isDirectory: true))
            if deniedParent {
                try driver.seed()
                var denied = driver.responses["page"]!; denied["status"] = 403; denied["body"] = [:]; driver.responses["page"] = denied
                let opened = try driver.store.open(); driver.selected = (opened["reconciliationHandles"] as! [[String: Any]]).map { $0["handle"] as! String }
                driver.state = try driver.store.reconcile(["generation": 1, "phase": "prepare", "lease": opened["lease"]!, "baseHead": opened["head"]!, "proofEpoch": opened["proofEpoch"]!, "mode": "upgrade", "handles": driver.selected], admissionWatermark: 0, sessionRef: driver.reference)
                var authorityRejected = false
                do { try driver.collect([:]) } catch let error as FountainOutboxError { guard [.access, .retry, .stale].contains(error) else { throw error }; authorityRejected = true }
                try IO.require(authorityRejected && driver.state?["state"] as? String != "ready" && driver.accepted == nil && driver.receiptCount() == 0, "Authority denial became an unsupported-body ready plan")
                try IO.require((try driver.activeRows("operations")).isEmpty && (try driver.activeRows("mutations")).isEmpty, "Authority denial partially expanded body input")
                for bytes in driver.originals.values { try IO.require(try driver.archived(bytes), "Authority denial lost original complete-body versions") }
                passed.append(name); return
            }
            try driver.run()
            let counts = driver.state!["counts"] as! [String: Int], operations = try driver.activeRows("operations").map { $0["operation"] as! [String: Any] }
            if supported {
                try IO.require(counts["import", default: 0] > 0 && !operations.isEmpty, "Complete body produced no fresh native input")
                let creation = try driver.activeRows("mutations").first! ["operation"] as! [String: Any], freshEpoch = creation["document_epoch"] as! String
                try IO.require(operations.allSatisfy { $0["_epoch"] as? String == freshEpoch && !($0["id"] as! String).hasPrefix("local_editor:") }, "Body promotion replayed old CRDT lineage")
                let drafts = try driver.activeRows("drafts").filter { ($0["draft"] as? [String: Any])?["reason"] as? String != "basis" }
                try IO.require(drafts.count == 1, "Complete body lacks one fresh pending draft")
                let draft = drafts[0]["draft"] as! [String: Any]
                try IO.require(Set((draft["ops"] as! [[String: Any]]).map { $0["id"] as! String }) == Set(operations.map { $0["id"] as! String }), "Draft mirror does not cover exact generated native operations")
                let output = directory.appendingPathComponent("body-projection-" + name + ".json")
                try IO.json(["expected": blocks, "operations": operations, "draft": draft]).write(to: output)
            } else {
                try IO.require(counts["import"] == 0 && operations.isEmpty && (try driver.activeRows("mutations")).isEmpty, "Unsupported complete body partially expanded or imported active input")
            }
            passed.append(name)
        }
        try exercise("complete-body-format-and-unicode", blocks: rich, supported: true)
        try exercise("conflicting-pending-op-content", blocks: rich, supported: false, conflicting: true)
        func copyDraft(_ sources: inout [[String: Any]], blocks: [[String: Any]]?, emptyCoverage: Bool = false, newer: Bool = false) {
            var row = sources.first { $0["bucket"] as? String == "drafts" }!, value = row["value"] as! [String: Any], draft = value["draft"] as! [String: Any]
            row["ref"] = "alternate-draft"; value["clientId"] = "alternate-tab"; row["key"] = [value["key"]!, "alternate-tab"]
            if let blocks { draft["blocks"] = blocks }; if emptyCoverage { draft["ops"] = [] }
            if newer { value["updatedAt"] = (value["updatedAt"] as! Int) + 1 }
            value["draft"] = draft; row["value"] = value; sources.append(row)
        }
        try exercise("same-time-differing-complete-bodies", blocks: rich, supported: false) { rows in
            copyDraft(&rows, blocks: [["id": "other-body", "type": "paragraph", "text": "다른 본문"]])
        }
        try exercise("same-body-tied-drafts-no-coverage-union", blocks: rich, supported: false) { rows in
            copyDraft(&rows, blocks: nil, emptyCoverage: true)
        }
        try exercise("same-body-tied-drafts-each-cover-pending", blocks: rich, supported: true) { rows in
            copyDraft(&rows, blocks: nil)
        }
        try exercise("latest-draft-cannot-borrow-older-coverage", blocks: rich, supported: false) { rows in
            copyDraft(&rows, blocks: nil, emptyCoverage: true, newer: true)
        }
        try exercise("latest-matching-snapshot-seen-covers-unseen-draft", blocks: rich, supported: true) { rows in
            for i in rows.indices {
                var value = rows[i]["value"] as! [String: Any]
                if rows[i]["bucket"] as? String == "snapshots" { var snapshot = value["snapshot"] as! [String: Any], state = snapshot["state"] as! [String: Any]; state["seen"] = ["local_editor:1": true]; snapshot["state"] = state; value["snapshot"] = snapshot; value["updatedAt"] = (value["updatedAt"] as! Int) + 1 }
                if rows[i]["bucket"] as? String == "drafts" { var draft = value["draft"] as! [String: Any]; draft["ops"] = []; value["draft"] = draft }
                rows[i]["value"] = value
            }
        }
        try exercise("old-snapshot-seen-cannot-cover-newer-missing-seen", blocks: rich, supported: false) { rows in
            var older = rows.first { $0["bucket"] as? String == "snapshots" }!, value = older["value"] as! [String: Any], snapshot = value["snapshot"] as! [String: Any], state = snapshot["state"] as! [String: Any]
            state["seen"] = ["local_editor:1": true]; snapshot["state"] = state; value["snapshot"] = snapshot; value["updatedAt"] = (value["updatedAt"] as! Int) - 1; older["value"] = value; older["ref"] = "older-seen-snapshot"; rows.append(older)
            for i in rows.indices where rows[i]["bucket"] as? String == "drafts" { var value = rows[i]["value"] as! [String: Any], draft = value["draft"] as! [String: Any]; draft["ops"] = []; value["draft"] = draft; rows[i]["value"] = value }
        }
        try exercise("complete-snapshot-fallback-all-pending-seen", blocks: rich, supported: true) { rows in
            rows.removeAll { $0["bucket"] as? String == "drafts" }
            for i in rows.indices where rows[i]["bucket"] as? String == "snapshots" {
                var value = rows[i]["value"] as! [String: Any], snapshot = value["snapshot"] as! [String: Any], state = snapshot["state"] as! [String: Any]
                state["seen"] = ["local_editor:1": true]; snapshot["state"] = state; snapshot["blocks"] = rich; value["snapshot"] = snapshot; rows[i]["value"] = value
            }
        }
        try exercise("same-time-snapshot-seen-equivocation", blocks: rich, supported: false) { rows in
            var alternate = rows.first { $0["bucket"] as? String == "snapshots" }!, value = alternate["value"] as! [String: Any], snapshot = value["snapshot"] as! [String: Any], state = snapshot["state"] as! [String: Any]
            state["seen"] = ["local_editor:1": true]; snapshot["state"] = state; value["snapshot"] = snapshot; alternate["value"] = value; alternate["ref"] = "same-time-different-snapshot"; rows.append(alternate)
        }
        try exercise("pending-operation-without-complete-body", blocks: rich, supported: false) { rows in
            rows.removeAll { $0["bucket"] as? String == "drafts" }
        }
        let tooLarge = String(repeating: "a", count: 50001)
        try exercise("plain-50001-preserved", blocks: [["id": "source-root", "type": "paragraph", "text": tooLarge]], supported: false)
        try exercise("over-budget-body-parent-denied-keeps-authority-error", blocks: [["id": "source-root", "type": "paragraph", "text": tooLarge]], supported: false, deniedParent: true)
        let tooMarked = String(repeating: "b", count: 25001)
        try exercise("bold-25001-preserved", blocks: [["id": "source-root", "type": "paragraph", "text": tooMarked, "rich_text": [["text": tooMarked, "marks": ["bold": true]]]]], supported: false)
        if large {
            let plain = String(repeating: "a", count: 50000)
            try exercise("plain-50000-boundary", blocks: [["id": "source-root", "type": "paragraph", "text": plain]], supported: true)
            let bold = String(repeating: "b", count: 25000)
            try exercise("bold-25000-boundary", blocks: [["id": "source-root", "type": "paragraph", "text": bold, "rich_text": [["text": bold, "marks": ["bold": true]]]]], supported: true)
            try exercise("aggregate-two-blocks-50001", blocks: [["id": "source-root", "type": "paragraph", "text": String(repeating: "a", count: 25000)], ["id": "source-child", "type": "paragraph", "text": String(repeating: "b", count: 25001)]], supported: false)
            try exercise("aggregate-two-selected-bodies-50001", blocks: [["id": "source-root", "type": "paragraph", "text": String(repeating: "a", count: 25000)]], supported: false, other: [["id": "other-root", "type": "paragraph", "text": String(repeating: "b", count: 25001)]])
        }
        #if os(iOS)
        let platform = "iOS"
        #else
        let platform = "macOS"
        #endif
        return ["actualProductionSwiftSQLite": true, "platform": platform, "passed": passed, "skipped": 0, "largeBoundariesIncluded": large]
    }
}
