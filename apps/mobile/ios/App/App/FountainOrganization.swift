import Foundation
import Security

// This realm deliberately has no workspace profile, outbox or logout observer.
enum FountainOrganizationError: Error {
    case invalid, stale, busy, storage, revoke, network, timeout, cancelled, redirect, tooLarge, incomplete
    var code: String {
        switch self {
        case .invalid: return "NATIVE_INVALID"
        case .stale: return "NATIVE_STALE"
        case .busy: return "NATIVE_BUSY"
        case .storage: return "NATIVE_STORAGE"
        case .revoke: return "NATIVE_REVOKE_REQUIRED"
        case .network: return "NATIVE_NETWORK"
        case .timeout: return "NATIVE_TIMEOUT"
        case .cancelled: return "NATIVE_CANCELLED"
        case .redirect: return "NATIVE_REDIRECT"
        case .tooLarge: return "NATIVE_TOO_LARGE"
        case .incomplete: return "NATIVE_INCOMPLETE"
        }
    }
}

struct FountainOrganizationCookies: Codable, Equatable {
    var active: String?
    var revoke: String?
    var binding: String?
    var revokeBinding: String?
}

protocol FountainOrganizationStorage {
    func read(_ origin: String) throws -> FountainOrganizationCookies
    func write(_ value: FountainOrganizationCookies, origin: String) throws
    func blocked(_ origin: String) throws -> Bool
    func block(_ origin: String) throws
    func unblock(_ origin: String) throws
}

final class FountainOrganizationKeychain: FountainOrganizationStorage {
    private func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "dev.fountain.workspace") + ".native-organization-session",
         kSecAttrAccount as String: origin, kSecAttrSynchronizable as String: false]
    }
    private func markerQuery(_ origin: String) -> [String: Any] {
        var attributes = query(origin)
        attributes[kSecAttrService as String] = (Bundle.main.bundleIdentifier ?? "dev.fountain.workspace") + ".native-organization-session.blocked"
        return attributes
    }
    func blocked(_ origin: String) throws -> Bool {
        var attributes = markerQuery(origin); attributes[kSecReturnData as String] = true
        var found: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &found)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess, let data = found as? Data, data == Data([1]) else { throw FountainOrganizationError.storage }
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
        guard status == errSecSuccess else { throw FountainOrganizationError.storage }
    }
    func unblock(_ origin: String) throws {
        let status = SecItemDelete(markerQuery(origin) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw FountainOrganizationError.storage }
    }
    func read(_ origin: String) throws -> FountainOrganizationCookies {
        var attributes = query(origin); attributes[kSecReturnData as String] = true; attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &found)
        if status == errSecItemNotFound { return FountainOrganizationCookies() }
        guard status == errSecSuccess, let data = found as? Data,
              let value = try? JSONDecoder().decode(FountainOrganizationCookies.self, from: data),
              (value.active == nil || value.revoke == nil),
              [value.active, value.revoke].compactMap({ $0 }).allSatisfy(FountainOrganizationPolicy.validStoredCookie) else { throw FountainOrganizationError.storage }
        return value
    }
    func write(_ value: FountainOrganizationCookies, origin: String) throws {
        let attributes = query(origin)
        if value == FountainOrganizationCookies() {
            let status = SecItemDelete(attributes as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw FountainOrganizationError.storage }; return
        }
        let data = try JSONEncoder().encode(value)
        let update = [kSecValueData as String: data]
        var status = SecItemUpdate(attributes as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = attributes; insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw FountainOrganizationError.storage }
    }
}

enum FountainOrganizationPolicy {
    static let prefix = "/api/organization/"
    static func integer(_ input: Any?) throws -> Int {
        guard let number = input as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991 else { throw FountainOrganizationError.invalid }
        return number.intValue
    }
    static func route(_ raw: String, method: String) throws -> String {
        guard raw.utf8.count <= 8192, raw.hasPrefix(prefix), !raw.contains("#"), !raw.contains("\\"),
              !raw.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }) else { throw FountainOrganizationError.invalid }
        let pieces = raw.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(pieces[0])
        // The API grammar needs no encoded path characters. Refusing them also
        // prevents repeated decoding from crossing into another cookie realm.
        guard !path.contains("%"), !path.contains("//"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { throw FountainOrganizationError.invalid }
        let tail = String(path.dropFirst(prefix.count))
        let uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
        let operations: [(String, [String])] = [
            ("session", ["GET", "POST", "DELETE"]), ("setup-eligibility", ["GET"]), ("organizations", ["GET", "POST"]),
            ("bootstrap", ["POST"]), ("workspace-preview", ["POST"]), ("workspace-accept", ["POST"]),
            ("organizations/" + uuid, ["GET", "PATCH"]), ("organizations/" + uuid + "/owners", ["POST"]),
            ("organizations/" + uuid + "/owners/" + uuid, ["DELETE"]),
            ("organizations/" + uuid + "/workspace-requests", ["POST"]),
            ("organizations/" + uuid + "/workspaces/" + uuid, ["DELETE"])
        ]
        guard operations.contains(where: { tail.range(of: "^" + $0.0 + "$", options: .regularExpression) != nil && $0.1.contains(method) }) else { throw FountainOrganizationError.invalid }
        if pieces.count == 2 {
            guard method == "GET", tail != "session", !pieces[1].isEmpty,
                  let components = URLComponents(string: "https://organization.invalid" + raw),
                  let items = components.queryItems, items.count == 1, items[0].name == "session_binding",
                  let value = items[0].value, validBinding(value), !value.contains("%") else { throw FountainOrganizationError.invalid }
        } else if method == "GET", tail != "session" { throw FountainOrganizationError.invalid }
        return path
    }
    static func needsWorkspace(path: String, method: String) -> Bool {
        (method == "GET" && path == prefix + "setup-eligibility") ||
        (method == "POST" && ["organizations", "workspace-preview", "workspace-accept"].contains(String(path.dropFirst(prefix.count))))
    }
    static func validBinding(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 1000 && !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
    }
    static func logoutBinding(_ body: Data) throws -> String {
        guard body.count <= 65536, let raw = String(data: body, encoding: .utf8),
              raw.range(of: #"^\s*\{\s*"session_binding"\s*:\s*"(?:[^"\\\x00-\x1F]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"\s*\}\s*$"#, options: .regularExpression) != nil,
              let json = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              let binding = json["session_binding"] as? String, validBinding(binding) else { throw FountainOrganizationError.invalid }
        return binding
    }
    static func validStoredCookie(_ cookie: String) -> Bool {
        let prefix = "fountain_organization_session="
        guard cookie.hasPrefix(prefix) else { return false }
        return validToken(String(cookie.dropFirst(prefix.count)))
    }
    static func validToken(_ token: String) -> Bool {
        guard token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let data = Data(base64Encoded: token.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="), data.count == 32 else { return false }
        return data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == token
    }
    static func responseCookie(_ response: HTTPURLResponse, now: Date = Date()) throws -> String? {
        guard let header = response.value(forHTTPHeaderField: "Set-Cookie") else { return nil }
        guard header.utf8.count <= 8192, !header.contains("\r"), !header.contains("\n") else { throw FountainOrganizationError.invalid }
        // Only one host-only cookie is admitted. In particular a merged second
        // cookie cannot disguise an organization token overwrite.
        let parts = header.split(separator: ";", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first = parts.first, first.hasPrefix("fountain_organization_session="), validStoredCookie(first) else { throw FountainOrganizationError.invalid }
        var names = Set<String>(); var secure = false; var httpOnly = false; var sameSite = false; var root = false; var expiry: Date?; var maxAge: Date?
        for part in parts.dropFirst() {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let name = String(pair[0]).lowercased(); let value = pair.count == 2 ? String(pair[1]) : ""
            guard names.insert(name).inserted else { throw FountainOrganizationError.invalid }
            switch name {
            case "secure": guard pair.count == 1 else { throw FountainOrganizationError.invalid }; secure = true
            case "httponly": guard pair.count == 1 else { throw FountainOrganizationError.invalid }; httpOnly = true
            case "samesite": guard value.lowercased() == "strict" else { throw FountainOrganizationError.invalid }; sameSite = true
            case "path": guard value == "/" else { throw FountainOrganizationError.invalid }; root = true
            case "max-age": guard let seconds = Int(value), seconds > 0, seconds <= 604800, String(seconds) == value else { throw FountainOrganizationError.invalid }; maxAge = now.addingTimeInterval(Double(seconds))
            case "expires":
                let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"; formatter.isLenient = false
                guard let date = formatter.date(from: value), date > now, date.timeIntervalSince(now) <= 604801 else { throw FountainOrganizationError.invalid }
                if let previous = expiry, abs(previous.timeIntervalSince(date)) > 2 { throw FountainOrganizationError.invalid }; expiry = date
            default: throw FountainOrganizationError.invalid
            }
        }
        if let expiry, let maxAge, abs(expiry.timeIntervalSince(maxAge)) > 2 { throw FountainOrganizationError.invalid }
        guard secure, httpOnly, sameSite, root, expiry != nil || maxAge != nil else { throw FountainOrganizationError.invalid }
        return first
    }
}

// A serial queue confines origin, auth epoch, Keychain transitions and tasks.
final class FountainOrganization: NSObject, URLSessionDataDelegate {
    struct Request {
        let id: String; let generation: Int; let path: String; let method: String
        let headers: [String: String]; let body: Data; let timeout: Int
        init(_ input: [String: Any]) throws {
            guard Set(input.keys).isSubset(of: ["id", "generation", "path", "method", "headers", "bodyBase64", "timeoutMs"]),
                  let id = input["id"] as? String, !id.isEmpty, id.utf8.count <= 160,
                  let path = input["path"] as? String else { throw FountainOrganizationError.invalid }
            if let method = input["method"], !(method is String) { throw FountainOrganizationError.invalid }
            let method = input["method"] as? String ?? "GET"
            _ = try FountainOrganizationPolicy.route(path, method: method)
            var headers: [String: String] = [:]
            if let raw = input["headers"] {
                guard let values = raw as? [String: String] else { throw FountainOrganizationError.invalid }
                for (key, value) in values {
                    let name = key.lowercased()
                    guard ["content-type", "accept"].contains(name), headers[name] == nil, value.utf8.count <= 4096,
                          !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw FountainOrganizationError.invalid }
                    headers[name] = value
                }
            }
            if let value = input["bodyBase64"], !(value is String) { throw FountainOrganizationError.invalid }
            let encoded = input["bodyBase64"] as? String ?? ""
            guard encoded.utf8.count <= 87384, let body = Data(base64Encoded: encoded), body.count <= 65536, body.base64EncodedString() == encoded else { throw FountainOrganizationError.tooLarge }
            guard method != "GET" || body.isEmpty else { throw FountainOrganizationError.invalid }
            let timeout = try input["timeoutMs"].map(FountainOrganizationPolicy.integer) ?? 45000
            guard (1...45000).contains(timeout) else { throw FountainOrganizationError.invalid }
            self.id = id; self.generation = try FountainOrganizationPolicy.integer(input["generation"])
            self.path = path; self.method = method; self.headers = headers; self.body = body; self.timeout = timeout
        }
        var session: Bool { path == FountainOrganizationPolicy.prefix + "session" }
        var transition: Bool { session && method != "GET" }
    }
    private final class Job {
        let request: Request; let epoch: Int; let origin: String
        let done: (Result<[String: Any], FountainOrganizationError>) -> Void
        var task: URLSessionDataTask?; var timer: DispatchSourceTimer?
        var data = Data(); var response: HTTPURLResponse?; var expected = -1; var failure: FountainOrganizationError?
        var sent: String?; var revoking = false
        var deadline: DispatchTime
        init(_ request: Request, epoch: Int, origin: String, done: @escaping (Result<[String: Any], FountainOrganizationError>) -> Void) {
            self.request = request; self.epoch = epoch; self.origin = origin; self.done = done
            self.deadline = .now() + .milliseconds(request.timeout)
        }
    }
    private let queue: DispatchQueue
    private let storage: FountainOrganizationStorage
    private var session: URLSession!
    private var origin: String?
    private var generation = 0
    private var epoch = 0
    private var jobs: [String: Job] = [:]
    private var tasks: [Int: Job] = [:]
    private var transition: String?
    private var poisoned = false
    private var closed = false
    init(queue: DispatchQueue, storage: FountainOrganizationStorage = FountainOrganizationKeychain(), protocolClasses: [AnyClass]? = nil) {
        self.queue = queue; self.storage = storage; super.init()
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
        self.origin = origin; self.generation = generation; poisoned = false
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
        jobs[job.request.id] === job && origin == job.origin && generation == job.request.generation && epoch == job.epoch
    }
    private func state(_ origin: String) throws -> FountainOrganizationCookies {
        var value = try storage.read(origin)
        if try storage.blocked(origin), let active = value.active {
            value.active = nil; value.revoke = active; value.revokeBinding = value.binding; value.binding = nil
            try storage.write(value, origin: origin)
        }
        return value
    }
    private func quarantine(_ origin: String, _ value: FountainOrganizationCookies) throws -> FountainOrganizationCookies {
        do { try storage.block(origin) } catch { poisoned = true; throw FountainOrganizationError.storage }
        var next = value
        if let active = value.active { next.revoke = active; next.revokeBinding = value.binding }
        next.active = nil; next.binding = nil
        do { try storage.write(next, origin: origin) } catch { poisoned = true; throw FountainOrganizationError.storage }
        return next
    }
    func request(_ request: Request, workspaceCookie: () throws -> String?, url: @escaping (String, String) throws -> URL,
                 done: @escaping (Result<[String: Any], FountainOrganizationError>) -> Void) throws {
        guard !closed, !poisoned, let origin, request.generation == generation else { throw FountainOrganizationError.stale }
        guard jobs[request.id] == nil, jobs.count < 16, transition == nil else { throw FountainOrganizationError.busy }
        let path = try FountainOrganizationPolicy.route(request.path, method: request.method)
        var value = try state(origin)
        if request.session && request.method == "DELETE" {
            let binding = try FountainOrganizationPolicy.logoutBinding(request.body)
            guard (value.binding ?? value.revokeBinding) == binding, value.active != nil || value.revoke != nil else { throw FountainOrganizationError.stale }
        }
        if request.transition {
            // The negative marker precedes every cancellation or network effect.
            value = try quarantine(origin, value)
            epoch += 1
            for old in Array(jobs.values) { finish(old, .failure(.stale)) }
        } else if try value.revoke != nil || storage.blocked(origin) { throw FountainOrganizationError.revoke }
        let workspace = FountainOrganizationPolicy.needsWorkspace(path: path, method: request.method) ? try workspaceCookie() : nil
        let job = Job(request, epoch: epoch, origin: origin, done: done)
        jobs[request.id] = job; if request.transition { transition = request.id }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: job.deadline); timer.setEventHandler { [weak self, weak job] in if let self, let job { self.finish(job, .failure(.timeout)) } }
        job.timer = timer; timer.resume()
        // Cross-realm cookies are selected before allocating a task and never
        // copied into the organization vault, renderer, or session observer.
        do {
            if let pending = value.revoke {
                guard let binding = value.revokeBinding, FountainOrganizationPolicy.validBinding(binding) else { throw FountainOrganizationError.revoke }
                let body = try JSONSerialization.data(withJSONObject: ["session_binding": binding], options: [.sortedKeys])
                job.revoking = true
                try send(job, path: FountainOrganizationPolicy.prefix + "session", method: "DELETE", body: body, cookie: pending, url: url)
            } else if request.session && request.method == "DELETE" { throw FountainOrganizationError.stale }
            else { try send(job, path: request.path, method: request.method, body: request.body, cookie: [value.active, workspace].compactMap({ $0 }).joined(separator: "; "), url: url) }
        } catch { finish(job, .failure(error as? FountainOrganizationError ?? .network)) }
    }
    // Native-owned URL construction is injected by the existing fixed-origin
    // adapter. The helper independently checks that its origin cannot escape.
    private var urls: [String: (String, String) throws -> URL] = [:]
    private func send(_ job: Job, path: String, method: String, body: Data, cookie: String?, url: @escaping (String, String) throws -> URL) throws {
        guard current(job), job.deadline > .now() else { throw FountainOrganizationError.stale }
        let target = try url(job.origin, path)
        guard let base = URL(string: job.origin), target.scheme == "https", target.host == base.host, target.port == base.port, target.user == nil, target.password == nil else { throw FountainOrganizationError.invalid }
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Double(job.request.timeout) / 1000)
        request.httpMethod = method; request.httpBody = body.isEmpty ? nil : body
        for (name, value) in job.request.headers { request.setValue(value, forHTTPHeaderField: name) }
        if !body.isEmpty { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        request.setValue("1", forHTTPHeaderField: "X-Fountain-Request"); request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let cookie, !cookie.isEmpty { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        job.sent = cookie; job.data = Data(); job.response = nil; job.expected = -1; job.failure = nil
        let task = session.dataTask(with: request); job.task = task; tasks[task.taskIdentifier] = job; urls[job.request.id] = url; task.resume()
    }
    private func finish(_ job: Job, _ result: Result<[String: Any], FountainOrganizationError>) {
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
        guard let job = tasks.removeValue(forKey: task.taskIdentifier), current(job) else { return }
        if let failure = job.failure { finish(job, .failure(failure)); return }
        if let error = error as? URLError { finish(job, .failure(error.code == .timedOut ? .timeout : .network)); return }
        if error != nil { finish(job, .failure(.network)); return }
        guard let response = job.response else { finish(job, .failure(.network)); return }
        if job.expected >= 0 && job.data.count != job.expected { finish(job, .failure(.incomplete)); return }
        do {
            if job.revoking {
                guard (200..<300).contains(response.statusCode) || response.statusCode == 401 || response.statusCode == 409 else { throw FountainOrganizationError.revoke }
                try storage.write(FountainOrganizationCookies(), origin: job.origin)
                if !(job.request.session && job.request.method == "POST") { try storage.unblock(job.origin) }
                job.revoking = false
                if job.request.method != "DELETE" || !job.request.session {
                    guard let url = urls[job.request.id] else { throw FountainOrganizationError.stale }
                    try send(job, path: job.request.path, method: job.request.method, body: job.request.body, cookie: nil, url: url); return
                }
            } else if job.request.session && job.request.method == "POST" && (200..<300).contains(response.statusCode) {
                guard let cookie = try FountainOrganizationPolicy.responseCookie(response),
                      let object = try JSONSerialization.jsonObject(with: job.data) as? [String: Any], let authenticated = object["authenticated"] as? NSNumber, CFGetTypeID(authenticated) == CFBooleanGetTypeID(), authenticated.boolValue,
                      let binding = object["cache_binding"] as? String, FountainOrganizationPolicy.validBinding(binding) else { throw FountainOrganizationError.invalid }
                do {
                    try storage.write(FountainOrganizationCookies(active: cookie, binding: binding), origin: job.origin)
                    try storage.unblock(job.origin)
                } catch {
                    // The persistent negative marker prevents a Keychain write
                    // that succeeded just before an I/O error from being reused.
                    try? storage.block(job.origin)
                    try? storage.write(FountainOrganizationCookies(revoke: cookie, revokeBinding: binding), origin: job.origin)
                    poisoned = true; throw FountainOrganizationError.storage
                }
            } else if job.request.session && job.request.method == "GET" && response.statusCode == 200 {
                let object = try JSONSerialization.jsonObject(with: job.data) as? [String: Any]
                guard let authenticated = object?["authenticated"] as? NSNumber, CFGetTypeID(authenticated) == CFBooleanGetTypeID() else { throw FountainOrganizationError.invalid }
                let value = try state(job.origin)
                if authenticated.boolValue {
                    guard let binding = object?["cache_binding"] as? String, FountainOrganizationPolicy.validBinding(binding), value.binding == binding, value.active == job.sent else { throw FountainOrganizationError.stale }
                } else if value.active != nil {
                    _ = try quarantine(job.origin, value)
                    epoch += 1
                    for old in Array(jobs.values) where old !== job { finish(old, .failure(.stale)) }
                }
            } else if response.statusCode == 401 {
                var value = try state(job.origin)
                if let active = value.active, job.sent?.split(separator: ";").map({ $0.trimmingCharacters(in: .whitespaces) }).contains(active) == true {
                    value = try quarantine(job.origin, value)
                    epoch += 1
                    for old in Array(jobs.values) where old !== job { finish(old, .failure(.stale)) }
                    // Resolve this authoritative 401 while invalidating every
                    // other organization response; no workspace effect exists.
                }
            }
            var headers: [String: String] = [:]
            for name in ["Content-Type", "Content-Length", "Cache-Control"] { if let value = response.value(forHTTPHeaderField: name) { headers[name.lowercased()] = value } }
            finish(job, .success(["generation": job.request.generation, "status": response.statusCode, "headers": headers, "bodyBase64": job.data.base64EncodedString()]))
        } catch { finish(job, .failure(error as? FountainOrganizationError ?? .storage)) }
    }
}
