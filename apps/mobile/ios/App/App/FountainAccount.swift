import Foundation
import Security

// This realm deliberately has no workspace profile, outbox or logout observer.
enum FountainAccountError: Error {
    case invalid, stale, busy, storage, revoke, network, unreachable, timeout, cancelled, redirect, tooLarge, incomplete
    var code: String {
        switch self {
        case .invalid: return "NATIVE_INVALID"
        case .stale: return "NATIVE_STALE"
        case .busy: return "NATIVE_BUSY"
        case .storage: return "NATIVE_STORAGE"
        case .revoke: return "NATIVE_REVOKE_REQUIRED"
        case .network: return "NATIVE_NETWORK"
        case .unreachable: return "NATIVE_NETWORK_UNREACHABLE"
        case .timeout: return "NATIVE_TIMEOUT"
        case .cancelled: return "NATIVE_CANCELLED"
        case .redirect: return "NATIVE_REDIRECT"
        case .tooLarge: return "NATIVE_TOO_LARGE"
        case .incomplete: return "NATIVE_INCOMPLETE"
        }
    }
}

struct FountainAccountCookies: Codable, Equatable {
    var active: String?
    var revoke: String?
    var binding: String?
    var revokeBinding: String?
    var expiresAt: Double?
}

protocol FountainAccountStorage {
    func read(_ origin: String) throws -> FountainAccountCookies
    func write(_ value: FountainAccountCookies, origin: String) throws
    func blocked(_ origin: String) throws -> Bool
    func block(_ origin: String) throws
    func unblock(_ origin: String) throws
}

final class FountainAccountKeychain: FountainAccountStorage {
    private func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "dev.fountain.workspace") + ".native-account-session",
         kSecAttrAccount as String: origin, kSecAttrSynchronizable as String: false]
    }
    private func markerQuery(_ origin: String) -> [String: Any] {
        var attributes = query(origin)
        attributes[kSecAttrService as String] = (Bundle.main.bundleIdentifier ?? "dev.fountain.workspace") + ".native-account-session.blocked"
        return attributes
    }
    func blocked(_ origin: String) throws -> Bool {
        var attributes = markerQuery(origin); attributes[kSecReturnData as String] = true
        var found: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &found)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess, let data = found as? Data, data == Data([1]) else { throw FountainAccountError.storage }
        return true
    }
    func block(_ origin: String) throws {
        let attributes = markerQuery(origin)
        let update = [kSecValueData as String: Data([1])]
        var status = SecItemUpdate(attributes as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = attributes; insert[kSecValueData as String] = Data([1])
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw FountainAccountError.storage }
    }
    func unblock(_ origin: String) throws {
        let status = SecItemDelete(markerQuery(origin) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw FountainAccountError.storage }
    }
    func read(_ origin: String) throws -> FountainAccountCookies {
        var attributes = query(origin); attributes[kSecReturnData as String] = true; attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &found)
        if status == errSecItemNotFound { return FountainAccountCookies() }
        guard status == errSecSuccess, let data = found as? Data,
              let value = try? JSONDecoder().decode(FountainAccountCookies.self, from: data),
              (value.active == nil || value.revoke == nil),
              [value.active, value.revoke].compactMap({ $0 }).allSatisfy(FountainAccountPolicy.validStoredCookie) else { throw FountainAccountError.storage }
        return value
    }
    func write(_ value: FountainAccountCookies, origin: String) throws {
        let attributes = query(origin)
        if value == FountainAccountCookies() {
            let status = SecItemDelete(attributes as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw FountainAccountError.storage }; return
        }
        let data = try JSONEncoder().encode(value)
        let update = [kSecValueData as String: data]
        var status = SecItemUpdate(attributes as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = attributes; insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw FountainAccountError.storage }
    }
}

enum FountainAccountPolicy {
    static let prefix = "/api/account/"
    static func integer(_ input: Any?) throws -> Int {
        guard let number = input as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991 else { throw FountainAccountError.invalid }
        return number.intValue
    }
    static func route(_ raw: String, method: String) throws -> String {
        guard raw.utf8.count <= 8192, raw.hasPrefix(prefix), !raw.contains("#"), !raw.contains("\\"),
              !raw.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }) else { throw FountainAccountError.invalid }
        let pieces = raw.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(pieces[0])
        // The API grammar needs no encoded path characters. Refusing them also
        // prevents repeated decoding from crossing into another cookie realm.
        guard !path.contains("%"), !path.contains("//"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { throw FountainAccountError.invalid }
        let tail = String(path.dropFirst(prefix.count))
        let workspace = "[A-Za-z0-9_-]{1,160}"
        let operations: [(String, [String])] = [
            ("session", ["GET", "POST", "DELETE"]), ("workspaces", ["GET", "POST"]),
            ("workspaces/" + workspace + "/open", ["POST"]), ("workspaces/" + workspace + "/invitations", ["POST"]),
            ("invitation-preview", ["POST"]), ("invitation-accept", ["POST"])
        ]
        guard operations.contains(where: { tail.range(of: "^" + $0.0 + "$", options: .regularExpression) != nil && $0.1.contains(method) }) else { throw FountainAccountError.invalid }
        if pieces.count == 2 {
            guard method == "GET", tail == "workspaces", !pieces[1].isEmpty,
                  let components = URLComponents(string: "https://account.invalid" + raw),
                  let items = components.queryItems, (1...2).contains(items.count),
                  Set(items.map { $0.name }).count == items.count,
                  items.allSatisfy({ ($0.name == "session_binding" && validBinding($0.value ?? "")) || ($0.name == "cursor" && validWorkspace($0.value ?? "")) }),
                  items.contains(where: { $0.name == "session_binding" }) else { throw FountainAccountError.invalid }
        } else if method == "GET", tail != "session" { throw FountainAccountError.invalid }
        return path
    }
    static func workspaceDenied(status: Int, body: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let code = object["code"] as? String else { return false }
        return (status == 403 && code == "WORKSPACE_ACCESS_REQUIRED") || ([403, 409].contains(status) && code == "WORKSPACE_GRANT_CHANGED")
    }
    static func needsWorkspace(path: String, method: String) -> Bool { false }
    static func validWorkspace(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_-]{1,160}$", options: .regularExpression) != nil }
    static func validBinding(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil }
    static func logoutBinding(_ body: Data) throws -> String {
        guard body.count <= 8192, let raw = String(data: body, encoding: .utf8),
              raw.range(of: #"^\s*\{\s*"session_binding"\s*:\s*"(?:[^"\\\x00-\x1F]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"\s*\}\s*$"#, options: .regularExpression) != nil,
              let json = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              let binding = json["session_binding"] as? String, validBinding(binding) else { throw FountainAccountError.invalid }
        return binding
    }
    static func validStoredCookie(_ cookie: String) -> Bool {
        let prefix = "fountain_account_session="
        guard cookie.hasPrefix(prefix) else { return false }
        return validToken(String(cookie.dropFirst(prefix.count)))
    }
    static func validToken(_ token: String) -> Bool {
        guard token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let data = Data(base64Encoded: token.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="), data.count == 32 else { return false }
        return data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == token
    }
    static func responseCookie(_ response: HTTPURLResponse, now: Date = Date()) throws -> String? {
        guard let supplied = response.value(forHTTPHeaderField: "Set-Cookie") else { return nil }
        let header: String
        do { header = try FountainCookieHeaders.target(supplied, name: "fountain_account_session") }
        catch { throw FountainAccountError.invalid }
        // Only one host-only realm cookie can enter this private vault.
        let parts = header.split(separator: ";", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first = parts.first, first.hasPrefix("fountain_account_session="), validStoredCookie(first) else { throw FountainAccountError.invalid }
        var names = Set<String>(); var secure = false; var httpOnly = false; var sameSite = false; var root = false; var expiry: Date?; var maxAge: Date?
        for part in parts.dropFirst() {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let name = String(pair[0]).lowercased(); let value = pair.count == 2 ? String(pair[1]) : ""
            guard names.insert(name).inserted else { throw FountainAccountError.invalid }
            switch name {
            case "secure": guard pair.count == 1 else { throw FountainAccountError.invalid }; secure = true
            case "httponly": guard pair.count == 1 else { throw FountainAccountError.invalid }; httpOnly = true
            case "samesite": guard value.lowercased() == "strict" else { throw FountainAccountError.invalid }; sameSite = true
            case "path": guard value == "/" else { throw FountainAccountError.invalid }; root = true
            case "max-age": guard let seconds = Int(value), seconds > 0, seconds <= 604800, String(seconds) == value else { throw FountainAccountError.invalid }; maxAge = now.addingTimeInterval(Double(seconds))
            case "expires":
                let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"; formatter.isLenient = false
                guard let date = formatter.date(from: value), date > now, date.timeIntervalSince(now) <= 604801 else { throw FountainAccountError.invalid }
                if let previous = expiry, abs(previous.timeIntervalSince(date)) > 2 { throw FountainAccountError.invalid }; expiry = date
            default: throw FountainAccountError.invalid
            }
        }
        if let expiry, let maxAge, abs(expiry.timeIntervalSince(maxAge)) > 2 { throw FountainAccountError.invalid }
        guard secure, httpOnly, sameSite, root, expiry != nil || maxAge != nil else { throw FountainAccountError.invalid }
        return first
    }
}

// A serial queue confines origin, auth epoch, Keychain transitions and tasks.
final class FountainAccount: NSObject, URLSessionDataDelegate {
    struct Request {
        let id: String; let generation: Int; let path: String; let method: String
        let headers: [String: String]; let body: Data; let timeout: Int
        init(_ input: [String: Any], workspaceVerification: Bool = false) throws {
            guard Set(input.keys).isSubset(of: ["id", "generation", "path", "method", "headers", "bodyBase64", "timeoutMs"]),
                  let id = input["id"] as? String, !id.isEmpty, id.utf8.count <= 160,
                  let path = input["path"] as? String else { throw FountainAccountError.invalid }
            if let method = input["method"], !(method is String) { throw FountainAccountError.invalid }
            let method = input["method"] as? String ?? "GET"
            if workspaceVerification { guard method == "GET", FountainWorkspacePolicy.scoped(path)?.logical == "/api/session" else { throw FountainAccountError.invalid } } else { _ = try FountainAccountPolicy.route(path, method: method) }
            var headers: [String: String] = [:]
            if let raw = input["headers"] {
                guard let values = raw as? [String: String] else { throw FountainAccountError.invalid }
                for (key, value) in values {
                    let name = key.lowercased()
                    guard ["content-type", "accept"].contains(name), headers[name] == nil, value.utf8.count <= 4096,
                          !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw FountainAccountError.invalid }
                    headers[name] = value
                }
            }
            if let value = input["bodyBase64"], !(value is String) { throw FountainAccountError.invalid }
            let encoded = input["bodyBase64"] as? String ?? ""
            guard encoded.utf8.count <= 10924, let body = Data(base64Encoded: encoded), body.count <= 8192, body.base64EncodedString() == encoded else { throw FountainAccountError.tooLarge }
            guard method != "GET" || body.isEmpty else { throw FountainAccountError.invalid }
            let timeout = try input["timeoutMs"].map(FountainAccountPolicy.integer) ?? 45000
            guard (1...45000).contains(timeout) else { throw FountainAccountError.invalid }
            self.id = id; self.generation = try FountainAccountPolicy.integer(input["generation"])
            self.path = path; self.method = method; self.headers = headers; self.body = body; self.timeout = timeout
        }
        var session: Bool { path == FountainAccountPolicy.prefix + "session" }
        var transition: Bool { session && method != "GET" }
    }
    private final class Job {
        let request: Request; let epoch: Int; let origin: String
        let done: (Result<[String: Any], FountainAccountError>) -> Void
        var task: URLSessionDataTask?; var timer: DispatchSourceTimer?
        var data = Data(); var response: HTTPURLResponse?; var expected = -1; var failure: FountainAccountError?
        var sent: String?; var revoking = false
        var workspaceEvidence: (String, Int)?
        var workspaceFence: (() -> Bool)?
        var deadline: DispatchTime
        init(_ request: Request, epoch: Int, origin: String, done: @escaping (Result<[String: Any], FountainAccountError>) -> Void) {
            self.request = request; self.epoch = epoch; self.origin = origin; self.done = done
            self.deadline = .now() + .milliseconds(request.timeout)
        }
    }
    private let queue: DispatchQueue
    private let ownership: NSRecursiveLock?
    private let admission: () -> Bool
    private let storage: FountainAccountStorage
    private var session: URLSession!
    private var origin: String?
    private var generation = 0
    private var epoch = 0
    private var jobs: [String: Job] = [:]
    private var tasks: [Int: Job] = [:]
    private var transition: String?
    private var poisoned = false
    private var closed = false
    private var workspaceEvidence: [String: Int] = [:]
    private var appliedWorkspaceEvidence: [String: Int] = [:]
    func beginWorkspaceEvidence(_ workspace: String) throws -> Int {
        let previous = workspaceEvidence[workspace, default: 0]
        guard previous < 9_007_199_254_740_991 else { throw FountainAccountError.storage }
        workspaceEvidence[workspace] = previous + 1
        return previous + 1
    }
    func currentWorkspaceEvidence(_ workspace: String, _ version: Int) -> Bool { version >= appliedWorkspaceEvidence[workspace, default: 0] && version <= workspaceEvidence[workspace, default: 0] }
    func acceptWorkspaceEvidence(_ workspace: String, _ version: Int) throws {
        guard currentWorkspaceEvidence(workspace, version) else { throw FountainAccountError.stale }
        appliedWorkspaceEvidence[workspace] = version
    }
    func noteWorkspaceVerification(_ workspace: String) throws { try acceptWorkspaceEvidence(workspace, beginWorkspaceEvidence(workspace)) }
    var privateEpoch: Int { epoch }
    private(set) var authorizationLost = false
    private func quarantineUnauthorized(_ origin: String, _ value: FountainAccountCookies) throws -> FountainAccountCookies {
        authorizationLost = true; defer { authorizationLost = false }
        return try quarantine(origin, value)
    }
    func fenceWorkspaceJobs() {
        for job in Array(jobs.values) where job.workspaceFence != nil { finish(job, .failure(.stale)) }
    }
    var onInvalidation: (() throws -> Void)?
    var onWorkspaceDenial: ((String, String, String) throws -> Void)?
    var onWorkspaceObservation: ((FountainWorkspace) throws -> Void)?
    func activeCookie(binding: String? = nil) throws -> String {
        guard let origin, !closed, !poisoned else { throw FountainAccountError.stale }
        let value = try state(origin)
        guard !(try storage.blocked(origin)), value.revoke == nil, let active = value.active, let expiry = value.expiresAt, expiry > Date().timeIntervalSince1970 * 1000, binding == nil || value.binding == binding else { throw FountainAccountError.revoke }
        return active
    }
    func activeBinding() throws -> String {
        guard let origin, let binding = try state(origin).binding else { throw FountainAccountError.stale }
        _ = try activeCookie(binding: binding)
        return binding
    }
    func invalidate(authRequired: Bool = false) throws {
        guard let origin else { throw FountainAccountError.stale }
        let value = try state(origin)
        _ = try authRequired ? quarantineUnauthorized(origin, value) : quarantine(origin, value); epoch += 1
        for job in Array(jobs.values) { finish(job, .failure(.stale)) }
    }
    init(queue: DispatchQueue, storage: FountainAccountStorage = FountainAccountKeychain(), protocolClasses: [AnyClass]? = nil, ownership: NSRecursiveLock? = nil, admission: @escaping () -> Bool = { true }) {
        self.queue = queue; self.storage = storage; self.ownership = ownership; self.admission = admission; super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.timeoutIntervalForResource = 45
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        let delegates = OperationQueue(); delegates.maxConcurrentOperationCount = 1; delegates.underlyingQueue = queue
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegates)
    }
    func configure(origin: String?, generation: Int) throws {
        guard self.origin != origin || self.generation != generation else { return }
        if let previous = self.origin {
            var value = try storage.read(previous)
            if let active = value.active {
                try storage.block(previous); value.active = nil; value.revoke = active; value.revokeBinding = value.binding; value.binding = nil
                try storage.write(value, origin: previous)
            }
        }
        epoch += 1
        for job in Array(jobs.values) { finish(job, .failure(.stale)) }
        self.origin = origin; self.generation = generation; poisoned = false; workspaceEvidence.removeAll(); appliedWorkspaceEvidence.removeAll()
    }
    func shutdown() {
        closed = true; epoch += 1
        for job in Array(jobs.values) { finish(job, .failure(.stale)) }
        session.invalidateAndCancel()
    }
    func deliveryFence() -> () -> Bool {
        let capturedEpoch = epoch, capturedOrigin = origin, capturedGeneration = generation
        return { [weak self] in
            guard let self else { return false }
            return self.queue.sync { !self.closed && self.epoch == capturedEpoch && self.origin == capturedOrigin && self.generation == capturedGeneration }
        }
    }
    func cancel(id: String, generation: Int) -> Bool {
        guard generation == self.generation, let job = jobs[id], !(job.request.session && job.request.method == "DELETE") else { return false }
        finish(job, .failure(.cancelled)); return true
    }
    private func current(_ job: Job) -> Bool {
        admission() && jobs[job.request.id] === job && origin == job.origin && generation == job.request.generation && epoch == job.epoch && (job.workspaceFence?() ?? true)
    }
    private func state(_ origin: String) throws -> FountainAccountCookies {
        var value = try storage.read(origin)
        if try storage.blocked(origin), let active = value.active {
            value.active = nil; value.revoke = active; value.revokeBinding = value.binding; value.binding = nil
            try storage.write(value, origin: origin)
        }
        if value.active != nil, (value.expiresAt ?? 0) <= Date().timeIntervalSince1970 * 1000 {
            value = try quarantineUnauthorized(origin, value); epoch += 1
            for job in Array(jobs.values) { finish(job, .failure(.stale)) }
        }
        return value
    }
    private func quarantine(_ origin: String, _ value: FountainAccountCookies) throws -> FountainAccountCookies {
        do { try storage.block(origin); try onInvalidation?() } catch { poisoned = true; throw FountainAccountError.storage }
        var next = value
        if let active = value.active { next.revoke = active; next.revokeBinding = value.binding }
        next.active = nil; next.binding = nil; next.expiresAt = nil
        do { try storage.write(next, origin: origin) } catch { poisoned = true; throw FountainAccountError.storage }
        return next
    }
    func request(_ request: Request, workspaceCookie: () throws -> String?, workspaceFence: (() -> Bool)? = nil, url: @escaping (String, String) throws -> URL,
                 done: @escaping (Result<[String: Any], FountainAccountError>) -> Void) throws {
        guard admission(), !closed, !poisoned, let origin, request.generation == generation else { throw FountainAccountError.stale }
        guard jobs[request.id] == nil, jobs.count < 16, transition == nil else { throw FountainAccountError.busy }
        let path = request.path.hasPrefix("/api/w/") ? request.path : try FountainAccountPolicy.route(request.path, method: request.method)
        var value = try state(origin)
        if request.session && request.method == "DELETE" {
            let binding = try FountainAccountPolicy.logoutBinding(request.body)
            guard (value.binding ?? value.revokeBinding) == binding, value.active != nil || value.revoke != nil else { throw FountainAccountError.stale }
        }
        if request.transition {
            // The negative marker precedes every cancellation or network effect.
            value = try quarantine(origin, value)
            epoch += 1
            for old in Array(jobs.values) { finish(old, .failure(.stale)) }
        } else if try value.revoke != nil || storage.blocked(origin) { throw FountainAccountError.revoke }
        let workspace = FountainAccountPolicy.needsWorkspace(path: path, method: request.method) ? try workspaceCookie() : nil
        let job = Job(request, epoch: epoch, origin: origin, done: done)
        job.workspaceFence = workspaceFence
        if request.method == "POST", request.path.range(of: "^/api/account/workspaces/[A-Za-z0-9_-]{1,160}/open$", options: .regularExpression) != nil {
            let workspace = String(request.path.split(separator: "/")[3])
            job.workspaceEvidence = (workspace, try beginWorkspaceEvidence(workspace))
        }
        jobs[request.id] = job; if request.transition { transition = request.id }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: job.deadline); timer.setEventHandler { [weak self, weak job] in if let self, let job { self.finish(job, .failure(.timeout)) } }
        job.timer = timer; timer.resume()
        // Cross-realm cookies are selected before allocating a task and never
        // copied into the account vault, renderer, or session observer.
        do {
            if let pending = value.revoke {
                guard let binding = value.revokeBinding, FountainAccountPolicy.validBinding(binding) else { throw FountainAccountError.revoke }
                let body = try JSONSerialization.data(withJSONObject: ["session_binding": binding], options: [.sortedKeys])
                job.revoking = true
                try send(job, path: FountainAccountPolicy.prefix + "session", method: "DELETE", body: body, cookie: pending, url: url)
            } else if request.session && request.method == "DELETE" { throw FountainAccountError.stale }
            else { try send(job, path: request.path, method: request.method, body: request.body, cookie: [value.active, workspace].compactMap({ $0 }).joined(separator: "; "), url: url) }
        } catch { finish(job, .failure(error as? FountainAccountError ?? .network)) }
    }
    // Native-owned URL construction is injected by the existing fixed-origin
    // adapter. The helper independently checks that its origin cannot escape.
    private var urls: [String: (String, String) throws -> URL] = [:]
    private func send(_ job: Job, path: String, method: String, body: Data, cookie: String?, url: @escaping (String, String) throws -> URL) throws {
        guard current(job), job.deadline > .now() else { throw FountainAccountError.stale }
        let target = try url(job.origin, path)
        guard let base = URL(string: job.origin), target.scheme == "https", target.host == base.host, target.port == base.port, target.user == nil, target.password == nil else { throw FountainAccountError.invalid }
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Double(job.request.timeout) / 1000)
        request.httpMethod = method; request.httpBody = body.isEmpty ? nil : body
        for (name, value) in job.request.headers { request.setValue(value, forHTTPHeaderField: name) }
        if !body.isEmpty { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        request.setValue("1", forHTTPHeaderField: "X-Fountain-Request"); request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let cookie, !cookie.isEmpty { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        job.sent = cookie; job.data = Data(); job.response = nil; job.expected = -1; job.failure = nil
        let task = session.dataTask(with: request); job.task = task; tasks[task.taskIdentifier] = job; urls[job.request.id] = url; task.resume()
    }
    private func finish(_ job: Job, _ result: Result<[String: Any], FountainAccountError>) {
        guard jobs.removeValue(forKey: job.request.id) === job else { return }
        if transition == job.request.id { transition = nil }
        urls.removeValue(forKey: job.request.id)
        if let task = job.task { tasks.removeValue(forKey: task.taskIdentifier); task.cancel() }
        job.timer?.cancel(); job.timer = nil
        job.done(result)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust { completionHandler(.performDefaultHandling, nil) }
        else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        tasks[task.taskIdentifier]?.failure = .redirect; completionHandler(nil); task.cancel()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let job = tasks[dataTask.taskIdentifier], current(job), let response = response as? HTTPURLResponse else { completionHandler(.cancel); return }
        job.response = response
        if let raw = response.value(forHTTPHeaderField: "Content-Length") {
            if let size = Int(raw), size >= 0, size <= 2 * 1024 * 1024 { job.expected = size }
            else { job.failure = .tooLarge }
        }
        if response.statusCode >= 300 && response.statusCode < 400 { job.failure = .redirect }
        completionHandler(job.failure == nil ? .allow : .cancel)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let job = tasks[dataTask.taskIdentifier], current(job) else { dataTask.cancel(); return }
        guard data.count <= 2 * 1024 * 1024 - job.data.count else { job.failure = .tooLarge; dataTask.cancel(); return }
        job.data.append(data)
        if job.expected >= 0 && job.data.count > job.expected { job.failure = .incomplete; dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        ownership?.lock(); defer { ownership?.unlock() }
        guard let job = tasks.removeValue(forKey: task.taskIdentifier), current(job) else { return }
        if let failure = job.failure { finish(job, .failure(failure)); return }
        if let error = error as? URLError {
            let unreachable: [URLError.Code] = [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed]
            finish(job, .failure(error.code == .timedOut ? .timeout : unreachable.contains(error.code) ? .unreachable : .network)); return
        }
        if error != nil { finish(job, .failure(.network)); return }
        guard let response = job.response else { finish(job, .failure(.network)); return }
        if job.expected >= 0 && job.data.count != job.expected { finish(job, .failure(.incomplete)); return }
        do {
            if job.revoking {
                guard (200..<300).contains(response.statusCode) || response.statusCode == 401 || response.statusCode == 409 else { throw FountainAccountError.revoke }
                try storage.write(FountainAccountCookies(), origin: job.origin)
                if !(job.request.session && job.request.method == "POST") { try storage.unblock(job.origin) }
                job.revoking = false
                if job.request.method != "DELETE" || !job.request.session {
                    guard let url = urls[job.request.id] else { throw FountainAccountError.stale }
                    try send(job, path: job.request.path, method: job.request.method, body: job.request.body, cookie: nil, url: url); return
                }
            } else if job.request.session && job.request.method == "POST" && (200..<300).contains(response.statusCode) {
                guard let cookie = try FountainAccountPolicy.responseCookie(response),
                      let object = try JSONSerialization.jsonObject(with: job.data) as? [String: Any], let authenticated = object["authenticated"] as? NSNumber, CFGetTypeID(authenticated) == CFBooleanGetTypeID(), authenticated.boolValue,
                      let binding = object["cache_binding"] as? String, FountainAccountPolicy.validBinding(binding), object["mode"] as? String == "account",
                      let expiryString = object["expires_at"] as? String else { throw FountainAccountError.invalid }
                let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard let expiry = parser.date(from: expiryString) ?? ISO8601DateFormatter().date(from: expiryString), expiry > Date(), expiry.timeIntervalSinceNow <= 604801 else { throw FountainAccountError.invalid }
                do {
                    try storage.write(FountainAccountCookies(active: cookie, binding: binding, expiresAt: expiry.timeIntervalSince1970 * 1000), origin: job.origin)
                    try storage.unblock(job.origin)
                } catch {
                    // The persistent negative marker prevents a Keychain write
                    // that succeeded just before an I/O error from being reused.
                    try? storage.block(job.origin)
                    try? storage.write(FountainAccountCookies(revoke: cookie, revokeBinding: binding), origin: job.origin)
                    poisoned = true; throw FountainAccountError.storage
                }
            } else if job.request.session && job.request.method == "GET" && response.statusCode == 200 {
                let object = try JSONSerialization.jsonObject(with: job.data) as? [String: Any]
                guard let authenticated = object?["authenticated"] as? NSNumber, CFGetTypeID(authenticated) == CFBooleanGetTypeID() else { throw FountainAccountError.invalid }
                let value = try state(job.origin)
                if authenticated.boolValue {
                    guard let binding = object?["cache_binding"] as? String, FountainAccountPolicy.validBinding(binding), value.binding == binding, value.active == job.sent else { throw FountainAccountError.stale }
                } else if value.active != nil {
                    _ = try quarantineUnauthorized(job.origin, value)
                    epoch += 1
                    for old in Array(jobs.values) where old !== job { finish(old, .failure(.stale)) }
                }
            } else if response.statusCode == 401 {
                var value = try state(job.origin)
                if let active = value.active, job.sent?.split(separator: ";").map({ $0.trimmingCharacters(in: .whitespaces) }).contains(active) == true {
                    value = try quarantineUnauthorized(job.origin, value)
                    epoch += 1
                    for old in Array(jobs.values) where old !== job { finish(old, .failure(.stale)) }
                    // Resolve this authoritative 401 while invalidating every
                    // other account response; no workspace effect exists.
                }
            }
            if job.request.method == "POST", response.statusCode == 200,
               job.request.path.range(of: "^/api/account/workspaces/[A-Za-z0-9_-]{1,160}/open$", options: .regularExpression) != nil,
               let request = try? JSONSerialization.jsonObject(with: job.request.body) as? [String: Any],
               let parent = request["session_binding"] as? String, FountainAccountPolicy.validBinding(parent),
               let evidence = job.workspaceEvidence, currentWorkspaceEvidence(evidence.0, evidence.1),
               let result = try? JSONSerialization.jsonObject(with: job.data) as? [String: Any], Set(result.keys) == Set(["workspace_id", "account_binding", "session"]),
               result["account_binding"] as? String == parent, let session = result["session"] as? [String: Any],
               let child = session["cache_binding"] as? String, FountainAccountPolicy.validBinding(child) {
                let workspace = String(job.request.path.split(separator: "/")[3]), value = try state(job.origin)
                guard result["workspace_id"] as? String == workspace, value.active == job.sent, value.binding == parent else { throw FountainAccountError.stale }
                let observed = try FountainWorkspacePolicy.verify(JSONSerialization.data(withJSONObject: session), workspace: workspace, binding: child, account: parent)
                try acceptWorkspaceEvidence(workspace, evidence.1)
                try onWorkspaceObservation?(observed)
            }
            if job.request.method == "POST", [403, 409].contains(response.statusCode),
               let route = job.request.path.range(of: "^/api/account/workspaces/([A-Za-z0-9_-]{1,160})/open$", options: .regularExpression), route.lowerBound == job.request.path.startIndex,
               let request = try? JSONSerialization.jsonObject(with: job.request.body) as? [String: Any],
               let expected = request["expected_binding"] as? String, FountainAccountPolicy.validBinding(expected),
               let parent = request["session_binding"] as? String, FountainAccountPolicy.validBinding(parent),
               FountainAccountPolicy.workspaceDenied(status: response.statusCode, body: job.data) {
                let value = try state(job.origin)
                guard value.active == job.sent, value.binding == parent else { throw FountainAccountError.stale }
                let workspace = String(job.request.path.split(separator: "/")[3])
                try onWorkspaceDenial?(workspace, expected, parent)
            }
            var headers: [String: String] = [:]
            for name in ["Content-Type", "Content-Length", "Cache-Control"] { if let value = response.value(forHTTPHeaderField: name) { headers[name.lowercased()] = value } }
            if job.request.method == "GET", job.request.path == FountainAccountPolicy.prefix + "session",
               response.value(forHTTPHeaderField: "X-Fountain-Account-Directory") == "absent" {
                headers["x-fountain-account-directory"] = "absent"
            }
            finish(job, .success(["generation": job.request.generation, "status": response.statusCode, "headers": headers, "bodyBase64": job.data.base64EncodedString()]))
        } catch { finish(job, .failure(error as? FountainAccountError ?? .storage)) }
    }
}
