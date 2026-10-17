import Foundation
import Darwin
import SQLite3
#if os(iOS)
@testable import App
#endif

// Production admission decisions, with an isolated actual native SQLite store
// for effects. This fixture never claims Keychain, Vault or real HTTP coverage.
enum IOSSessionLogoutFixture {
    static let cases = ["stale-preserves-sqlite", "matching-negative-only", "unknown-no-vault-read", "cookie-origin-fences", "queued-old-scope", "actual-capture-guards", "strict-parser", "exact-public409-pending", "durable-bound-restart", "public-preflight-denied", "bound-mismatch-corruption", "durable-local-sentinel", "actual-new-cookie-rollback", "failed-directory-seal-retry", "local-caller-dispatch-before-ack"]
    static let origin = "https://session-logout.invalid"
    static func body(_ binding: String) throws -> Data { try JSONSerialization.data(withJSONObject: ["cache_binding": binding], options: [.sortedKeys]) }
    static func session(_ binding: String) throws -> Data { try JSONSerialization.data(withJSONObject: ["authenticated": true, "cache_binding": binding]) }
    static func observed(_ binding: String = "B", cookie: String? = "cookie-B") throws -> FountainSessionLogout {
        let gate = FountainSessionLogout()
        gate.observeActualSession(origin: origin, requestOrigin: origin, requestCookieReference: cookie, currentCookieReference: cookie, responseCookie: .absent, method: "GET", status: 200, data: try session(binding))
        return gate
    }
    static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw NSError(domain: "IOSSessionLogoutFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func fails(_ wanted: FountainSessionLogoutError, _ action: () throws -> Void) throws {
        do { try action(); throw NSError(domain: "IOSSessionLogoutFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing expected native admission failure"]) }
        catch let error as FountainSessionLogoutError { try require(error == wanted && error.status == wanted.status, "Wrong native typed admission failure") }
    }
    static func admit(_ gate: FountainSessionLogout, _ binding: String = "B", cookie: String? = "cookie-B", auth: Int = 7) throws -> FountainSessionLogout.Intent {
        try gate.admit(body: body(binding), origin: origin, generation: 2, auth: auth, cookieReference: { cookie })
    }
    static func run(_ name: String, directory: URL) throws {
        switch name {
        case "stale-preserves-sqlite", "matching-negative-only":
            let gate = try observed(), store = try FountainOutbox(origin: origin, testingDirectory: directory); defer { store.close() }
            let source: [String: Any] = ["authenticated": true, "required": true, "mode": "accounts", "workspace_id": "workspace", "cache_binding": "B", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), "member": ["id": "member", "active": true, "role": "owner"]]
            try store.grant(source, sessionRef: "cookie-B"); try store.ensureOwner("fixture-owner", epoch: 7)
            if name == "stale-preserves-sqlite" {
                let before = try store.open(); var deletes = 0
                try fails(.conflict) { _ = try admit(gate, "A"); deletes += 1; try store.suspend() }
                let after = try store.open()
                try require(deletes == 0 && before["head"] as? Int == after["head"] as? Int && before["proofEpoch"] as? Int == after["proofEpoch"] as? Int && after["identityState"] as? String == "verified", "Stale binding reached actual native SQLite negative effects")
                _ = try admit(gate)
            } else {
                try store.suspend() // The admission scope cannot revive this binding.
                let before = try store.open(), intent = try admit(gate)
                try gate.recheck(intent, origin: origin, generation: 2, auth: 7, cookieReference: { "cookie-B" })
                let after = try store.open()
                try require(after["identityState"] as? String == "blocked" && before["head"] as? Int == after["head"] as? Int, "Own negative admission granted a blocked profile")
                gate.observeActualSession(origin: origin, requestOrigin: origin, requestCookieReference: "cookie-B", currentCookieReference: "cookie-B", responseCookie: .absent, method: "GET", status: 200, data: Data("{\"authenticated\":true,\"cache_binding\":\"B\",\"expires_at\":\"2000-01-01T00:00:00Z\"}".utf8))
                _ = try admit(gate) // Expiry is not a positive input to a logout-only capability.
            }
        case "unknown-no-vault-read":
            let gate = FountainSessionLogout(); var reads = 0
            try fails(.required) { _ = try gate.admit(body: body("B"), origin: origin, generation: 2, auth: 7) { reads += 1; return "cookie-B" } }
            for invalid in ["", "{}", "[]", "{\"cache_binding\":null}", "{\"cache_binding\":\"A\",\"cache_binding\":\"B\"}"] {
                try fails(.invalid) { _ = try gate.admit(body: Data(invalid.utf8), origin: origin, generation: 2, auth: 7) { reads += 1; return "cookie-B" } }
            }
            try require(reads == 0, "Unknown/malformed logout read the credential vault")
        case "cookie-origin-fences":
            let gate = try observed(), intent = try admit(gate)
            try fails(.required) { _ = try gate.admit(body: body("B"), origin: "https://other.invalid", generation: 2, auth: 7, cookieReference: { "cookie-B" }) }
            try fails(.required) { _ = try admit(gate, cookie: "cookie-C") }
            try fails(.conflict) { try gate.recheck(intent, origin: origin, generation: 2, auth: 7, cookieReference: { "cookie-C" }) }
            try fails(.conflict) { try gate.recheck(intent, origin: origin, generation: 3, auth: 7, cookieReference: { "cookie-B" }) }
            _ = try admit(gate)
        case "queued-old-scope":
            let gate = try observed(), intent = try admit(gate); var reads = 0
            gate.observeActualSession(origin: origin, requestOrigin: origin, requestCookieReference: "cookie-B", currentCookieReference: "cookie-C", responseCookie: .value("cookie-C"), method: "POST", status: 200, data: try session("C"))
            try fails(.conflict) { try gate.recheck(intent, origin: origin, generation: 2, auth: 8) { reads += 1; return "cookie-C" } }
            try require(reads == 0, "Queued old logout reached effects after a newer login")
            _ = try admit(gate, "C", cookie: "cookie-C", auth: 8)
            let sameCookie = try observed(), old = try admit(sameCookie)
            sameCookie.observeActualSession(origin: origin, requestOrigin: origin, requestCookieReference: "cookie-B", currentCookieReference: "cookie-B", responseCookie: .absent, method: "GET", status: 200, data: try session("C"))
            try fails(.conflict) { try sameCookie.recheck(old, origin: origin, generation: 2, auth: 7, cookieReference: { "cookie-B" }) }
        case "actual-capture-guards":
            for variant in 0..<5 {
                let gate = FountainSessionLogout()
                gate.observeActualSession(origin: origin, requestOrigin: variant == 0 ? "https://other.invalid" : origin, requestCookieReference: variant == 1 ? "cookie-A" : "cookie-B", currentCookieReference: "cookie-B", responseCookie: variant == 2 ? .value("cookie-C") : .absent, method: variant == 3 ? "POST" : "GET", status: variant == 4 ? 401 : 200, data: try session("B"))
                try fails(.required) { _ = try admit(gate) }
            }
            let gate = FountainSessionLogout()
            gate.observeActualSession(origin: origin, requestOrigin: origin, requestCookieReference: "old-cookie", currentCookieReference: "cookie-B", responseCookie: .value("cookie-B"), method: "POST", status: 200, data: try session("B")); _ = try admit(gate)
            gate.observeActualSession(origin: origin, requestOrigin: origin, requestCookieReference: "cookie-B", currentCookieReference: "cookie-B", responseCookie: .absent, method: "GET", status: 200, data: Data("{\"authenticated\":false}".utf8))
            try fails(.required) { _ = try admit(gate) }
            let local = try observed("local", cookie: nil); _ = try admit(local, "local", cookie: nil)
            for authenticated in ["1", "1.0", "\"true\""] {
                let numeric = FountainSessionLogout()
                numeric.observeActualSession(origin: origin, requestOrigin: origin, requestCookieReference: "cookie-B", currentCookieReference: "cookie-B", responseCookie: .absent, method: "GET", status: 200, data: Data("{\"authenticated\":\(authenticated),\"cache_binding\":\"B\"}".utf8))
                try fails(.required) { _ = try admit(numeric) }
            }
        case "strict-parser":
            let thousand = String(repeating: "a", count: 1000), base = try body("B")
            try require(try FountainSessionLogout.requestedBinding(body(thousand)) == thousand, "UTF8 boundary rejected")
            try require(try FountainSessionLogout.requestedBinding(base + Data(repeating: 32, count: 8192 - base.count)) == "B", "Exact8KiB request rejected")
            try require(try FountainSessionLogout.requestedBinding(Data("{\"cache_binding\":\"\\ud83d\\ude42\"}".utf8)) == "🙂", "Valid Unicode surrogate pair rejected")
            for raw in [try body(String(repeating: "界", count: 334)), try body("\u{0085}"), Data("{\"cache_binding\":\"\\ud800\"}".utf8), Data("{\"cache_binding\":\"\\udc00\"}".utf8), Data("{\"cache_binding\":\"A\",\"\\u0063ache_binding\":\"B\"}".utf8), Data("{\"cache_binding\":\"B\",}".utf8), Data("{,\"cache_binding\":\"B\"}".utf8), base + Data(repeating: 32, count: 8193 - base.count), Data([0xff])] {
                try fails(.invalid) { _ = try FountainSessionLogout.requestedBinding(raw) }
            }
            let byteExact = try observed("é")
            try fails(.conflict) { _ = try admit(byteExact, "e\u{0301}") }
        case "durable-bound-restart", "public-preflight-denied", "bound-mismatch-corruption":
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard descriptor >= 0 else { throw CocoaError(.fileReadUnknown) }; defer { Darwin.close(descriptor) }
            let markerName = String(repeating: "a", count: 64) + ".invalid", hash = String(repeating: "b", count: 64)
            let gate = try observed("B", cookie: hash), intent = try admit(gate, cookie: hash)
            let journal = FountainSessionInvalidation(directory: descriptor, name: markerName)
            // Keychain operations are injected as failures; the value surviving
            // them is fed through production restoration in fresh FS instances.
            let survivingCookie = "fountain_session=synthetic-private-fixture"
            func reference(_ cookie: String?) -> String? { cookie == survivingCookie ? hash : nil }
            if name == "public-preflight-denied" {
                guard chmod(directory.path, 0o500) == 0 else { throw CocoaError(.fileWriteUnknown) }
                defer { _ = chmod(directory.path, 0o700) }
                var effects = 0
                do { try journal.preparePublic(intent); effects += 1; throw NSError(domain: "MissingFailure", code: 1) }
                catch let error as NSError where error.domain == "MissingFailure" { throw error }
                catch { }
                try require(effects == 0 && !FileManager.default.fileExists(atPath: directory.appendingPathComponent(markerName).path), "Denied public preflight reached authentication effects")
            } else {
                try journal.preparePublic(intent)
                try journal.writeLegacy() // Generic invalidation cannot downgrade context.
                if name == "durable-bound-restart" {
                    var failedWrites = 0
                    for _ in 0..<2 { do { throw CocoaError(.fileWriteNoPermission) } catch { failedWrites += 1 } }
                    try require(failedWrites == 2, "Injected vault update/delete failures missing")
                    for _ in 0..<2 {
                        let restarted = FountainSessionInvalidation(directory: descriptor, name: markerName)
                        for stored in [(active: survivingCookie as String?, revoke: nil as String?), (active: nil as String?, revoke: survivingCookie as String?)] {
                            let masked = try restarted.restore(active: stored.active, revoke: stored.revoke, cookieReference: reference)
                            try require(masked.active == nil && masked.revoke == survivingCookie, "Restart revived positive cookie or lost pending revoke")
                            try require(try FountainSessionLogout.requestedBinding(restarted.pendingBody(cookieRefHash: reference(masked.revoke))) == "B", "Restart lost explicit binding or reverted to bodyless DELETE")
                        }
                    }
                } else {
                    try fails(.conflict) { _ = try journal.pendingBody(cookieRefHash: String(repeating: "c", count: 64)) }
                    do { _ = try journal.restore(active: "foreign-cookie", revoke: nil, cookieReference: reference); throw NSError(domain: "MissingFailure", code: 1) }
                    catch let error as NSError where error.domain == "MissingFailure" { throw error }
                    catch { }
                    let path = directory.appendingPathComponent(markerName), corrupt = Data([2])
                    try corrupt.write(to: path); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
                    do { try journal.writeLegacy(); throw NSError(domain: "MissingFailure", code: 1) }
                    catch let error as NSError where error.domain == "MissingFailure" { throw error }
                    catch { }
                    try require(try Data(contentsOf: path) == corrupt, "Unknown context overwritten as legacy")
                }
            }
        case "durable-local-sentinel", "actual-new-cookie-rollback":
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard descriptor >= 0 else { throw CocoaError(.fileReadUnknown) }; defer { Darwin.close(descriptor) }
            let markerName = String(repeating: "a", count: 64) + ".invalid"
            let journal = FountainSessionInvalidation(directory: descriptor, name: markerName)
            if name == "durable-local-sentinel" {
                let gate = try observed("local", cookie: nil), intent = try admit(gate, "local", cookie: nil)
                try journal.preparePublic(intent)
                try require(try FountainSessionLogout.requestedBinding(journal.pendingBody(cookieRefHash: nil)) == "local", "Local nil context lost its exact binding")
                try fails(.conflict) { _ = try journal.pendingBody(cookieRefHash: String(repeating: "b", count: 64)) }
                let otherName = String(repeating: "c", count: 64) + ".invalid"
                try FileManager.default.copyItem(at: directory.appendingPathComponent(markerName), to: directory.appendingPathComponent(otherName))
                do { _ = try FountainSessionInvalidation(directory: descriptor, name: otherName).state(); throw NSError(domain: "MissingFailure", code: 1) }
                catch let error as NSError where error.domain == "MissingFailure" { throw error }
                catch { }
            } else {
                let hash = String(repeating: "b", count: 64), gate = try observed("B", cookie: String(repeating: "b", count: 64))
                try journal.preparePublic(admit(gate, cookie: hash))
                let empty = try journal.restore(active: nil, revoke: nil, cookieReference: { _ in nil })
                try require(empty.active == nil && empty.revoke == nil, "Durably empty credentials became positive/pending")
                let before = try Data(contentsOf: directory.appendingPathComponent(markerName))
                let rollbackC = try FountainSessionLogout.actualResponseBody(session("C"))
                try require(try FountainSessionLogout.requestedBinding(rollbackC) == "C", "Actual new-cookie rollback borrowed old context binding")
                try fails(.conflict) { _ = try journal.pendingBody(cookieRefHash: String(repeating: "c", count: 64)) }
                try require(try Data(contentsOf: directory.appendingPathComponent(markerName)) == before, "Empty credential path discarded old public context before actual adoption")
                for raw in ["{\"authenticated\":1,\"cache_binding\":\"C\"}", "{\"authenticated\":true}"] {
                    try fails(.invalid) { _ = try FountainSessionLogout.actualResponseBody(Data(raw.utf8)) }
                }
            }
        case "failed-directory-seal-retry":
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard descriptor >= 0 else { throw CocoaError(.fileReadUnknown) }; defer { Darwin.close(descriptor) }
            let markerName = String(repeating: "a", count: 64) + ".invalid", hash = String(repeating: "b", count: 64)
            let gate = try observed("B", cookie: hash), intent = try admit(gate, cookie: hash)
            var failedSeals = 0, effects = 0
            let failed = FountainSessionInvalidation(directory: descriptor, name: markerName, testingDirectorySync: { _ in failedSeals += 1; return -1 })
            do { try failed.preparePublic(intent); effects += 1; throw NSError(domain: "MissingFailure", code: 1) }
            catch let error as NSError where error.domain == "MissingFailure" { throw error }
            catch { }
            try require(failedSeals == 1 && effects == 0 && FileManager.default.fileExists(atPath: directory.appendingPathComponent(markerName).path), "Fault did not leave visible but unconfirmed context before effects")
            do { _ = try failed.pendingBody(cookieRefHash: hash); effects += 1; throw NSError(domain: "MissingFailure", code: 1) }
            catch let error as NSError where error.domain == "MissingFailure" { throw error }
            catch { }
            try require(failedSeals == 2 && effects == 0, "Unconfirmed pending retry reached HTTP admission without durable seal")
            var completedSeals = 0
            let restarted = FountainSessionInvalidation(directory: descriptor, name: markerName, testingDirectorySync: { completedSeals += 1; return Darwin.fsync($0) })
            try restarted.preparePublic(intent); effects += 1
            try restarted.writeLegacy()
            try require(try FountainSessionLogout.requestedBinding(restarted.pendingBody(cookieRefHash: hash)) == "B", "Reseal lost exact pending binding")
            try require(completedSeals == 3 && effects == 1, "Visible context skipped durable reseal at subsequent public, generic or pending-body preflight")
        case "local-caller-dispatch-before-ack":
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard descriptor >= 0 else { throw CocoaError(.fileReadUnknown) }; defer { Darwin.close(descriptor) }
            let markerName = String(repeating: "a", count: 64) + ".invalid", journal = FountainSessionInvalidation(directory: descriptor, name: markerName)
            let gate = try observed("local", cookie: nil), intent = try admit(gate, "local", cookie: nil)
            // The actual nextAuth caller uses this production descriptor for
            // both pre-dispatch preservation and pending network selection.
            // Dispatch/ACK are fixture callbacks, not a SaaS local-mode claim.
            for mode in ["logout", "check", "login"] {
                try journal.preparePublic(intent)
                let transition = try journal.transition(mode: mode, active: nil, revoke: nil, cookieReference: { _ in nil })
                try require(!transition.blockCheck && transition.pending != nil, "Known tagged-local retry was mistaken for absent bearer")
                if mode != "check", !transition.preserveEmptyContext { try journal.clear() }
                let request = transition.pending!
                try require(try journal.state() != nil && request.cookie == nil && FountainSessionLogout.requestedBinding(request.body) == "local", "Public or startup nil-cookie dispatch lost context/bound body before ACK")
                let credential = directory.appendingPathComponent("empty-vault-fixture")
                let credentialFD = Darwin.open(credential.path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600)
                guard credentialFD >= 0 else { throw CocoaError(.fileWriteUnknown) }
                let empty = Data("{}".utf8), written = empty.withUnsafeBytes { Darwin.write(credentialFD, $0.baseAddress, $0.count) }
                let durable = written == empty.count && Darwin.fsync(credentialFD) == 0; Darwin.close(credentialFD)
                try require(durable && FileManager.default.fileExists(atPath: directory.appendingPathComponent(markerName).path), "Context retired before ACK credential cleanup")
                // The private native caller performs this only after accepted
                // bound DELETE and successful durable credential cleanup.
                try journal.clear()
                try require(try journal.state() == nil, "ACK failed to retire context")
                if mode == "login" { try require(try journal.state() == nil, "Next POST preceded pending-bound ACK cleanup") }
            }
            let bearer = try observed("B", cookie: String(repeating: "b", count: 64))
            try journal.preparePublic(admit(bearer, cookie: String(repeating: "b", count: 64)))
            let unknown = try journal.transition(mode: "check", active: nil, revoke: nil, cookieReference: { _ in nil })
            let login = try journal.transition(mode: "login", active: nil, revoke: nil, cookieReference: { _ in nil })
            try require(unknown.blockCheck && unknown.pending == nil && login.preserveEmptyContext && login.pending == nil && journal.state() != nil, "Empty bearer context was mistaken for tagged-local pending or retired before explicit POST")
        case "exact-public409-pending":
            let gate = try observed(), intent = try admit(gate)
            gate.clear() // Public transition already invalidated positive RAM scope.
            try require(gate.ownsPending(intent, origin: origin, activeCookieReference: nil, pendingCookieReference: "cookie-B"), "Exact admitted pending cannot be cleared")
            try require(!gate.ownsPending(intent, origin: origin, activeCookieReference: "cookie-C", pendingCookieReference: "cookie-B"), "Public409 cleared newer active login")
            try require(!gate.ownsPending(intent, origin: origin, activeCookieReference: nil, pendingCookieReference: "cookie-C"), "Public409 cleared foreign pending")
            try require(!gate.ownsPending(intent, origin: "https://other.invalid", activeCookieReference: nil, pendingCookieReference: "cookie-B"), "Public409 crossed origin")
            try fails(.required) { _ = try admit(gate) }
        default: throw NSError(domain: "IOSSessionLogoutFixture", code: 3)
        }
    }
}
#if os(macOS)
@main enum IOSSessionLogoutHost {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        for name in IOSSessionLogoutFixture.cases { try IOSSessionLogoutFixture.run(name, directory: root.appendingPathComponent(name, isDirectory: true)) }
        print("Production Swift logout admission:15 cases PASS; actual isolated SQLite/FS; injected vault failures only; no system Keychain/HTTP/iOS-runtime claim")
    }
}
#endif
