import Foundation
import SQLite3
#if os(iOS)
@testable import App
#endif

private final class MemoryOrganizationStorage: FountainOrganizationStorage {
    var rows: [String: FountainOrganizationCookies] = [:]
    var markers = Set<String>()
    var failWrite = false
    var failUnblock = false
    func read(_ origin: String) throws -> FountainOrganizationCookies { rows[origin] ?? FountainOrganizationCookies() }
    func write(_ value: FountainOrganizationCookies, origin: String) throws {
        guard !failWrite else { throw FountainOrganizationError.storage }; rows[origin] = value
    }
    func blocked(_ origin: String) throws -> Bool { markers.contains(origin) }
    func block(_ origin: String) throws { markers.insert(origin) }
    func unblock(_ origin: String) throws {
        guard !failUnblock else { throw FountainOrganizationError.storage }; markers.remove(origin)
    }
}

private final class OrganizationProtocol: URLProtocol {
    static var handler: ((OrganizationProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.handler?(self) }
    override func stopLoading() {}
    func respond(_ status: Int, _ body: String = "{}", _ headers: [String: String] = [:]) {
        let data = Data(body.utf8)
        var fields = headers; fields["Content-Length"] = String(data.count)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
}

enum IOSOrganizationFixture {
    static let origin = "https://organization.invalid"
    static let token = Data(repeating: 7, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    static var cookie: String { "fountain_organization_session=" + token }
    static var binding = "organization-binding"
    static func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try value() else { throw NSError(domain: "IOSOrganization", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func rejects(_ action: () throws -> Void) throws {
        do { try action() } catch is FountainOrganizationError { return }
        throw NSError(domain: "IOSOrganization", code: 2, userInfo: [NSLocalizedDescriptionKey: "Expected organization guard failure"])
    }
    static func request(_ id: String = UUID().uuidString, path: String = "/api/organization/session", method: String = "GET", body: String = "", timeout: Int = 1000) throws -> FountainOrganization.Request {
        try .init(["id": id, "generation": 3, "path": path, "method": method, "headers": ["accept": "application/json"], "bodyBase64": Data(body.utf8).base64EncodedString(), "timeoutMs": timeout])
    }
    static func url(_ origin: String, _ path: String) throws -> URL { URL(string: origin + path)! }
    static func perform(_ realm: FountainOrganization, _ queue: DispatchQueue, _ request: FountainOrganization.Request, workspace: @escaping () throws -> String? = { "fountain_session=workspace-secret" }) throws -> Result<[String: Any], FountainOrganizationError> {
        let done = DispatchSemaphore(value: 0)
        var output: Result<[String: Any], FountainOrganizationError>?
        try queue.sync { try realm.request(request, workspaceCookie: workspace, url: url) { output = $0; done.signal() } }
        guard done.wait(timeout: .now() + 5) == .success, let output else { throw NSError(domain: "IOSOrganization", code: 3) }
        return output
    }
    static func run(directory: URL) throws {
        var checks = 0
        for path in ["/api/session", "/api/organization/../session", "/api/organization/%2e%2e/session", "/api/organization/%2573ession", "/api/organization//session", "/api/organization/session#bad", "/api/organization/session?session_binding=A", "/api/organization/organizations?x=A", "/api/organization/organizations?session_binding=A&session_binding=B", "/api/organization/organizations?session_binding=%250a"] {
            try rejects { _ = try request(path: path) }; checks += 1
        }
        for (path, method) in [("/api/organization/session", "PATCH"), ("/api/organization/organizations", "DELETE"), ("/api/organization/bootstrap", "GET")] { try rejects { _ = try request(path: path, method: method) }; checks += 1 }
        try check(try FountainOrganizationPolicy.route("/api/organization/organizations?session_binding=a%2Bb", method: "GET") == "/api/organization/organizations", "Valid binding query rejected"); checks += 1
        for raw in ["{}", "[]", "{\"session_binding\":\"A\",\"session_binding\":\"B\"}", "{\"session_binding\":\"A\",\"extra\":1}", "{\"session_binding\":1}"] { try rejects { _ = try FountainOrganizationPolicy.logoutBinding(Data(raw.utf8)) }; checks += 1 }
        try check(try FountainOrganizationPolicy.logoutBinding(Data("{\"session_binding\":\"B\"}".utf8)) == "B", "Valid logout binding rejected"); checks += 1
        let setCookie = cookie + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800"
        let response: (String) -> HTTPURLResponse = { HTTPURLResponse(url: URL(string: origin)!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Set-Cookie": $0])! }
        try check(try FountainOrganizationPolicy.responseCookie(response(setCookie)) == cookie, "Strict cookie rejected"); checks += 1
        for invalid in [setCookie + "; Domain=organization.invalid", setCookie + "; Max-Age=1", setCookie.replacingOccurrences(of: "Strict", with: "Lax"), setCookie.replacingOccurrences(of: "; Secure", with: ""), setCookie.replacingOccurrences(of: "604800", with: "604801"), setCookie.replacingOccurrences(of: "Path=/", with: "Path=/api"), setCookie + ", fountain_session=leak", setCookie.replacingOccurrences(of: token, with: String(token.dropLast()) + "B")] {
            try rejects { _ = try FountainOrganizationPolicy.responseCookie(response(invalid)) }; checks += 1
        }
        for path in ["session", "bootstrap", "organizations/00000000-0000-0000-0000-000000000000/owners"] {
            try check(!FountainOrganizationPolicy.needsWorkspace(path: "/api/organization/" + path, method: "POST"), "Workspace cookie leaked to organization-only path"); checks += 1
        }
        let infrastructure = "__cf_bm=independent.bot.cookie; HttpOnly; SameSite=None; Secure; Path=/; Domain=.supabase.co; Expires=Sun, 18 Oct 2026 13:00:00 GMT"
        try check(try FountainOrganizationPolicy.responseCookie(response(setCookie + ", " + infrastructure)) == cookie, "Infrastructure cookie prevented organization login"); checks += 1
        try check(try FountainOrganizationPolicy.responseCookie(response(infrastructure + ", " + setCookie)) == cookie, "Infrastructure expiry comma changed organization cookie"); checks += 1
        try rejects { _ = try FountainOrganizationPolicy.responseCookie(response(setCookie + ", " + infrastructure + ", fountain_account_session=leak")) }; checks += 1
        for control in ["\t", "\u{1}", "\u{7f}"] {
            try rejects { _ = try FountainOrganizationPolicy.responseCookie(response(setCookie + ", " + infrastructure + control)) }; checks += 1
        }
        try rejects { _ = try FountainOrganizationPolicy.responseCookie(response(setCookie.replacingOccurrences(of: "; Path", with: ";\tPath") + ", " + infrastructure)) }; checks += 1

        let outbox = try FountainOutbox(origin: origin, testingDirectory: directory); defer { outbox.close() }
        let profile: [String: Any] = ["authenticated": true, "required": true, "mode": "accounts", "workspace_id": "workspace", "cache_binding": "workspace-binding", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), "member": ["id": "member", "active": true, "role": "owner"]]
        try outbox.grant(profile, sessionRef: "workspace-secret"); try outbox.ensureOwner("organization-fixture", epoch: 8)
        let before = try outbox.open()
        let queue = DispatchQueue(label: "organization-fixture"), storage = MemoryOrganizationStorage()
        let realm = FountainOrganization(queue: queue, storage: storage, protocolClasses: [OrganizationProtocol.self])
        try queue.sync { try realm.configure(origin: origin, generation: 3) }
        defer { queue.sync { realm.shutdown() } }
        OrganizationProtocol.handler = { transport in
            if transport.request.httpMethod == "POST" && transport.request.url!.path.hasSuffix("/session") {
                transport.respond(200, "{\"authenticated\":true,\"cache_binding\":\"organization-binding\"}", ["Set-Cookie": setCookie])
            } else { transport.respond(200) }
        }
        _ = try perform(realm, queue, request(method: "POST", body: "{\"email\":\"person@example.invalid\",\"password\":\"private\"}"))
        try check(storage.rows[origin]?.active == cookie, "Login cookie not privately persisted"); checks += 1
        for (path, method, cross) in [("setup-eligibility?session_binding=B", "GET", true), ("organizations", "POST", true), ("workspace-preview", "POST", true), ("workspace-accept", "POST", true), ("organizations?session_binding=B", "GET", false), ("bootstrap", "POST", false)] {
            var cookieObserved: String?
            OrganizationProtocol.handler = { transport in cookieObserved = transport.request.value(forHTTPHeaderField: "Cookie"); transport.respond(200) }
            _ = try perform(realm, queue, request(path: "/api/organization/" + path, method: method, body: method == "GET" ? "" : "{}"))
            try check(cookieObserved == cookie + (cross ? "; fountain_session=workspace-secret" : ""), "Cross-realm cookie route mismatch"); checks += 1
        }
        OrganizationProtocol.handler = { $0.respond(401) }
        let denied = try perform(realm, queue, request(path: "/api/organization/organizations?session_binding=B"))
        if case .success(let body) = denied { try check(body["status"] as? Int == 401, "401 missing") } else { throw NSError(domain: "IOSOrganization", code: 4) }
        try check(storage.rows[origin]?.active == nil && storage.rows[origin]?.revoke == cookie && storage.markers.contains(origin), "401 failed to quarantine organization"); checks += 1
        let after401 = try outbox.open()
        try check(before["head"] as? Int == after401["head"] as? Int && before["proofEpoch"] as? Int == after401["proofEpoch"] as? Int && after401["identityState"] as? String == "verified", "Organization401 changed actual workspace outbox"); checks += 1
        var sequence: [String] = []
        OrganizationProtocol.handler = { transport in
            sequence.append(transport.request.httpMethod!)
            if transport.request.httpMethod == "DELETE" { transport.respond(503) }
            else { transport.respond(200, "{\"authenticated\":true,\"cache_binding\":\"organization-binding\"}", ["Set-Cookie": setCookie]) }
        }
        let pending = try perform(realm, queue, request(method: "POST", body: "{}"))
        if case .failure(.revoke) = pending {} else { throw NSError(domain: "IOSOrganization", code: 5) }
        try check(sequence == ["DELETE"] && storage.rows[origin]?.revoke == cookie, "Unknown ACK permitted new login"); checks += 1
        OrganizationProtocol.handler = { transport in
            sequence.append(transport.request.httpMethod!)
            if transport.request.httpMethod == "DELETE" { transport.respond(200) }
            else { transport.respond(200, "{\"authenticated\":true,\"cache_binding\":\"organization-binding\"}", ["Set-Cookie": setCookie]) }
        }
        _ = try perform(realm, queue, request(method: "POST", body: "{}"))
        try check(sequence == ["DELETE", "DELETE", "POST"] && storage.rows[origin]?.active == cookie && !storage.markers.contains(origin), "Organization retry did not clear quarantine"); checks += 1
        let logout = try perform(realm, queue, request(method: "DELETE", body: "{\"session_binding\":\"organization-binding\"}"))
        if case .success(let body) = logout { try check(body["status"] as? Int == 200, "Logout missing") } else { throw NSError(domain: "IOSOrganization", code: 6) }
        let afterLogout = try outbox.open()
        try check(storage.rows[origin]?.active == nil && storage.rows[origin]?.revoke == nil && afterLogout["head"] as? Int == before["head"] as? Int && afterLogout["proofEpoch"] as? Int == before["proofEpoch"] as? Int && afterLogout["identityState"] as? String == "verified", "Organization logout changed workspace profile/outbox"); checks += 1
        // Cancel an old login, accept a new one, then deliver the former reply.
        var held: OrganizationProtocol?
        OrganizationProtocol.handler = { held = $0 }
        let cancelled = DispatchSemaphore(value: 0)
        try queue.sync { try realm.request(request("held", method: "POST", body: "{}"), workspaceCookie: { nil }, url: url) { _ in cancelled.signal() } }
        for _ in 0..<100 where held == nil { Thread.sleep(forTimeInterval: 0.005) }
        try check(queue.sync { realm.cancel(id: "held", generation: 3) }, "Organization cancel failed")
        try check(cancelled.wait(timeout: .now() + 2) == .success, "Cancelled caller not released")
        OrganizationProtocol.handler = { $0.respond(200, "{\"authenticated\":true,\"cache_binding\":\"organization-binding\"}", ["Set-Cookie": setCookie]) }
        _ = try perform(realm, queue, request(method: "POST", body: "{}"))
        held?.respond(200, "{\"authenticated\":true,\"cache_binding\":\"old-binding\"}", ["Set-Cookie": setCookie])
        queue.sync {}
        try check(storage.rows[origin]?.binding == binding, "Late cancelled response overwrote new login"); checks += 1
        // The existing workspace negative effect has no reference to this
        // independent realm, and cannot revoke its cookie or pending binding.
        let organizationBeforeWorkspaceLogout = storage.rows[origin]
        try outbox.suspend()
        try check(storage.rows[origin] == organizationBeforeWorkspaceLogout && storage.rows[origin]?.active == cookie, "Workspace logout changed organization session"); checks += 1
        var originHeld: OrganizationProtocol?
        let originCancelled = DispatchSemaphore(value: 0)
        OrganizationProtocol.handler = { originHeld = $0 }
        try queue.sync { try realm.request(request("origin-held", method: "POST", body: "{}"), workspaceCookie: { nil }, url: url) { _ in originCancelled.signal() } }
        for _ in 0..<100 where originHeld == nil { Thread.sleep(forTimeInterval: 0.005) }
        try queue.sync { try realm.configure(origin: "https://second.invalid", generation: 4) }
        try check(originCancelled.wait(timeout: .now() + 2) == .success, "Origin change did not close old request"); checks += 1
        originHeld?.respond(200)
        queue.sync {}
        try check(storage.rows[origin]?.active == nil && storage.rows[origin]?.revoke == cookie && storage.markers.contains(origin), "Origin change retained an active old-server cookie"); checks += 1
        try rejects { try queue.sync { try realm.request(request(), workspaceCookie: { nil }, url: url) { _ in } } }; checks += 1
        // Failed persistence cannot publish a new active session, even when the
        // failure occurs after Keychain accepted the active cookie.
        let failed = MemoryOrganizationStorage(), failureQueue = DispatchQueue(label: "organization-storage-failure")
        let failedRealm = FountainOrganization(queue: failureQueue, storage: failed, protocolClasses: [OrganizationProtocol.self])
        try failureQueue.sync { try failedRealm.configure(origin: origin, generation: 3) }
        OrganizationProtocol.handler = { $0.respond(200, "{\"authenticated\":true,\"cache_binding\":\"organization-binding\"}", ["Set-Cookie": setCookie]) }
        failed.failUnblock = true
        let result = try perform(failedRealm, failureQueue, request(method: "POST", body: "{}"))
        if case .failure(.storage) = result {} else { throw NSError(domain: "IOSOrganization", code: 7) }
        try check(failed.rows[origin]?.active == nil && failed.rows[origin]?.revoke == cookie && failed.markers.contains(origin), "Failed login storage did not remain retry-only"); checks += 1
        try rejects { try failureQueue.sync { try failedRealm.request(request(), workspaceCookie: { nil }, url: url) { _ in } } }; checks += 1
        // A reply over the 2MiB cap and a silent deadline never become a
        // renderer response, and cancellation addresses only this realm.
        let bounds = MemoryOrganizationStorage(), boundsQueue = DispatchQueue(label: "organization-bounds")
        let boundsRealm = FountainOrganization(queue: boundsQueue, storage: bounds, protocolClasses: [OrganizationProtocol.self])
        try boundsQueue.sync { try boundsRealm.configure(origin: origin, generation: 3) }
        OrganizationProtocol.handler = { transport in
            let response = HTTPURLResponse(url: transport.request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "2097153"])!
            transport.client?.urlProtocol(transport, didReceive: response, cacheStoragePolicy: .notAllowed)
            transport.client?.urlProtocolDidFinishLoading(transport)
        }
        let oversized = try perform(boundsRealm, boundsQueue, request())
        if case .failure(.tooLarge) = oversized {} else { throw NSError(domain: "IOSOrganization", code: 8) }; checks += 1
        OrganizationProtocol.handler = { _ in }
        let timeout = try perform(boundsRealm, boundsQueue, request(timeout: 20))
        if case .failure(.timeout) = timeout {} else { throw NSError(domain: "IOSOrganization", code: 9) }; checks += 1
        try check(!boundsQueue.sync { boundsRealm.cancel(id: "held", generation: 3) }, "Cancel reached a different realm instance"); checks += 1
        boundsQueue.sync { boundsRealm.shutdown() }
        failureQueue.sync { failedRealm.shutdown() }
        print("iOS organization production URLSession + parser + actual SQLite isolation: \(checks) checks passed")
    }
}

#if !os(iOS)
@main private enum IOSOrganizationDriver {
    static func main() throws { try IOSOrganizationFixture.run(directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)) }
}
#endif
