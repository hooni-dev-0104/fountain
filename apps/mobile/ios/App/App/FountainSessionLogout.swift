import Foundation
import CoreFoundation
import Darwin

// This capability authorizes only a negative authentication transition. It is
// never a cached login, resource proof, role, lease, or permission to hydrate.
enum FountainSessionLogoutError: Error {
    case invalid, required, conflict
    var code: String {
        switch self { case .invalid: return "NATIVE_SESSION_INVALID"; case .required: return "NATIVE_SESSION_REQUIRED"; case .conflict: return "NATIVE_SESSION_CONFLICT" }
    }
    var status: Int { switch self { case .invalid: return 400; case .required: return 503; case .conflict: return 409 } }
}

// Access is serialized by the native plugin's ownership lock/queue. None of
// these methods or values is a renderer bridge method or persisted authority.
final class FountainSessionLogout {
    struct Intent {
        fileprivate let origin: String, cookieReference: String?, binding: String, observation: UUID
        fileprivate let generation: Int, auth: Int
    }
    enum HeaderCookie { case absent, value(String?) }
    private struct Observation {
        let origin: String, cookieReference: String?, binding: String, version: UUID
    }
    private var actual: Observation?

    func clear() { actual = nil }

    static func actualResponseBody(_ data: Data) throws -> Data {
        guard data.count <= 16 * 1024 * 1024,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let authenticated = body["authenticated"] as? NSNumber, CFGetTypeID(authenticated) == CFBooleanGetTypeID(), authenticated.boolValue,
              let value = binding(body["cache_binding"]) else { throw FountainSessionLogoutError.invalid }
        return try JSONSerialization.data(withJSONObject: ["cache_binding": value], options: [.sortedKeys])
    }

    private static func binding(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.utf8.count <= 1000,
              !value.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) }) else { return nil }
        return value
    }
    private static func hexadecimal(_ bytes: [UInt8], _ position: Int) -> Int? {
        guard position + 4 <= bytes.count else { return nil }
        var result = 0
        for byte in bytes[position..<position + 4] {
            let value: UInt8
            switch byte { case 48...57: value = byte - 48; case 65...70: value = byte - 55; case 97...102: value = byte - 87; default: return nil }
            result = result * 16 + Int(value)
        }
        return result
    }
    static func requestedBinding(_ body: Data) throws -> String {
        guard !body.isEmpty, body.count <= 8192, String(data: body, encoding: .utf8) != nil else { throw FountainSessionLogoutError.invalid }
        let bytes = [UInt8](body), whitespace: Set<UInt8> = [9, 10, 13, 32]
        var index = 0
        func skipWhitespace() { while index < bytes.count, whitespace.contains(bytes[index]) { index += 1 } }
        func consume(_ byte: UInt8) throws {
            skipWhitespace()
            guard index < bytes.count, bytes[index] == byte else { throw FountainSessionLogoutError.invalid }
            index += 1
        }
        func string() throws -> String {
            skipWhitespace()
            let start = index
            try consume(34)
            while index < bytes.count {
                let byte = bytes[index]
                if byte == 34 {
                    index += 1
                    guard let value = try? JSONSerialization.jsonObject(with: Data(bytes[start..<index]), options: [.fragmentsAllowed]) as? String else { throw FountainSessionLogoutError.invalid }
                    return value
                }
                if byte == 92 {
                    index += 1; guard index < bytes.count else { throw FountainSessionLogoutError.invalid }
                    if bytes[index] == 117 {
                        guard let scalar = hexadecimal(bytes, index + 1) else { throw FountainSessionLogoutError.invalid }
                        index += 4
                        if (0xD800...0xDBFF).contains(scalar) {
                            guard index + 6 < bytes.count, bytes[index + 1] == 92, bytes[index + 2] == 117,
                                  let low = hexadecimal(bytes, index + 3), (0xDC00...0xDFFF).contains(low) else { throw FountainSessionLogoutError.invalid }
                            index += 6
                        } else if (0xDC00...0xDFFF).contains(scalar) { throw FountainSessionLogoutError.invalid }
                    } else if ![34, 47, 92, 98, 102, 110, 114, 116].contains(bytes[index]) { throw FountainSessionLogoutError.invalid }
                } else if byte < 32 { throw FountainSessionLogoutError.invalid }
                index += 1
            }
            throw FountainSessionLogoutError.invalid
        }
        // Parse the entire one-field grammar ourselves. Foundation's object
        // parser also accepts trailing commas and silently merges duplicate keys.
        try consume(123)
        guard try string() == "cache_binding" else { throw FountainSessionLogoutError.invalid }
        try consume(58)
        let supplied = try string()
        try consume(125)
        skipWhitespace()
        guard index == bytes.count, let binding = binding(supplied) else { throw FountainSessionLogoutError.invalid }
        return binding
    }

    // Only actual private native session GET/POST replies may call this. The
    // plugin checks current cookie/header/owner/auth/generation before capture.
    func observeActualSession(origin: String, requestOrigin: String, requestCookieReference: String?, currentCookieReference: String?, responseCookie: HeaderCookie, method: String, status: Int, data: Data) {
        guard ["GET", "POST"].contains(method), status == 200 else { return }
        guard origin == requestOrigin else { actual = nil; return }
        if method == "GET", requestCookieReference != currentCookieReference { actual = nil; return }
        switch responseCookie {
        case .absent: if method == "POST" { actual = nil; return }
        case .value(let returned):
            guard returned == currentCookieReference, method != "POST" || returned != nil else { actual = nil; return }
        }
        let cookieReference = currentCookieReference
        guard data.count <= 16 * 1024 * 1024,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let authenticated = body["authenticated"] as? NSNumber, CFGetTypeID(authenticated) == CFBooleanGetTypeID(), authenticated.boolValue,
              let binding = Self.binding(body["cache_binding"]) else { actual = nil; return }
        if let previous = actual, previous.origin == origin, previous.cookieReference == cookieReference, previous.binding.utf8.elementsEqual(binding.utf8) { return }
        actual = Observation(origin: origin, cookieReference: cookieReference, binding: binding, version: UUID())
    }
    func admit(body: Data, origin: String, generation: Int, auth: Int, cookieReference: () throws -> String?) throws -> Intent {
        let requested = try Self.requestedBinding(body)
        // Unknown/invalid requests do not even read the credential vault.
        guard let actual, actual.origin == origin else { throw FountainSessionLogoutError.required }
        let reference = try cookieReference()
        guard actual.cookieReference == reference else { throw FountainSessionLogoutError.required }
        guard actual.binding.utf8.elementsEqual(requested.utf8) else { throw FountainSessionLogoutError.conflict }
        return Intent(origin: origin, cookieReference: reference, binding: requested, observation: actual.version, generation: generation, auth: auth)
    }
    func ownsPending(_ intent: Intent, origin: String, activeCookieReference: String?, pendingCookieReference: String?) -> Bool {
        // Called only after the plugin also verifies the exact current job,
        // auth epoch and origin. No new active login or foreign pending cookie
        // can be cleared by an old public409 response.
        intent.origin == origin && activeCookieReference == nil && pendingCookieReference == intent.cookieReference
    }
    func recheck(_ intent: Intent, origin: String, generation: Int, auth: Int, cookieReference: () throws -> String?) throws {
        guard intent.origin == origin, intent.generation == generation, intent.auth == auth,
              let actual, actual.origin == origin, actual.version == intent.observation,
              actual.cookieReference == intent.cookieReference, actual.binding.utf8.elementsEqual(intent.binding.utf8) else { throw FountainSessionLogoutError.conflict }
        guard try cookieReference() == intent.cookieReference else { throw FountainSessionLogoutError.conflict }
    }
}

// This origin-local journal contains only negative authentication context.
// It never stores the cookie, supplies a login, or grants resource access.
final class FountainSessionInvalidation {
    struct PublicContext: Equatable {
        fileprivate let cookieRefHash: String, expectedBinding: String
        static func == (lhs: PublicContext, rhs: PublicContext) -> Bool {
            lhs.cookieRefHash == rhs.cookieRefHash && lhs.expectedBinding.utf8.elementsEqual(rhs.expectedBinding.utf8)
        }
        fileprivate var local: Bool { cookieRefHash.hasPrefix("local-no-cookie:") }
        func body(cookieRefHash: String?) throws -> Data {
            guard self.cookieRefHash == cookieRefHash || (cookieRefHash == nil && self.cookieRefHash.hasPrefix("local-no-cookie:")) else { throw FountainSessionLogoutError.conflict }
            return try JSONSerialization.data(withJSONObject: ["cache_binding": expectedBinding], options: [.sortedKeys])
        }
    }
    enum State { case legacy, bound(PublicContext) }
    struct Revocation { let cookie: String?, body: Data }
    struct Transition { let preserveEmptyContext: Bool, blockCheck: Bool; let pending: Revocation? }
    private let directory: Int32, name: String
    private let syncDirectory: (Int32) -> Int32
    init(directory: Int32, name: String) { self.directory = directory; self.name = name; self.syncDirectory = Darwin.fsync }
    #if DEBUG
    init(directory: Int32, name: String, testingDirectorySync: @escaping (Int32) -> Int32) {
        self.directory = directory; self.name = name; self.syncDirectory = testingDirectorySync
    }
    #endif
    private func validDirectory() throws {
        var info = stat()
        guard fstat(directory, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR), (info.st_mode & 0o777) == 0o700,
              name.range(of: "^[a-f0-9]{64}\\.invalid$", options: .regularExpression) != nil else { throw CocoaError(.fileReadNoPermission) }
    }
    private func raw() throws -> Data? {
        try validDirectory()
        let descriptor = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if descriptor < 0 { if errno == ENOENT { return nil }; throw CocoaError(.fileReadUnknown) }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), (info.st_mode & 0o777) == 0o600,
              (1...4096).contains(info.st_size) else { throw CocoaError(.fileReadCorruptFile) }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        let count = bytes.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
        guard count == bytes.count else { throw CocoaError(.fileReadCorruptFile) }
        return Data(bytes)
    }
    private func encoded(_ context: PublicContext) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["version": 1, "cookieRefHash": context.cookieRefHash, "expectedBinding": context.expectedBinding], options: [.sortedKeys])
    }
    func state() throws -> State? {
        guard let data = try raw() else { return nil }
        if data == Data([1]) { return .legacy }
        guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["version", "cookieRefHash", "expectedBinding"],
              let version = value["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let reference = value["cookieRefHash"] as? String,
              reference.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil || reference == "local-no-cookie:" + name.prefix(64),
              let binding = value["expectedBinding"] as? String else { throw CocoaError(.fileReadCorruptFile) }
        let context = PublicContext(cookieRefHash: reference, expectedBinding: binding)
        _ = try FountainSessionLogout.requestedBinding(context.body(cookieRefHash: context.cookieRefHash))
        guard data == (try encoded(context)) else { throw CocoaError(.fileReadCorruptFile) }
        return .bound(context)
    }
    private func replace(_ data: Data) throws {
        try validDirectory()
        let temporary = "." + name + "." + UUID().uuidString + ".tmp"
        let descriptor = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK, mode_t(0o600))
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(descriptor); _ = unlinkat(directory, temporary, 0) }
        let count = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
        guard count == data.count, fsync(descriptor) == 0,
              renameat(directory, temporary, directory, name) == 0, syncDirectory(directory) == 0,
              try raw() == data else { throw CocoaError(.fileWriteUnknown) }
    }
    func writeLegacy() throws {
        if case .bound(let context) = try state() {
            // A previous rename may be visible after a failed directory fsync.
            // Preserve and reseal, rather than assuming visibility is durable.
            try replace(encoded(context)); return
        }
        try replace(Data([1]))
    }
    func preparePublic(_ intent: FountainSessionLogout.Intent) throws {
        guard intent.cookieReference == nil || intent.cookieReference?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw FountainSessionLogoutError.conflict }
        let context = PublicContext(cookieRefHash: intent.cookieReference ?? "local-no-cookie:" + name.prefix(64), expectedBinding: intent.binding)
        if case .bound(let previous) = try state() {
            guard previous == context else { throw FountainSessionLogoutError.conflict }
        }
        try replace(encoded(context))
    }
    func pendingBody(cookieRefHash: String?) throws -> Data {
        switch try state() {
        case .bound(let context):
            let body = try context.body(cookieRefHash: cookieRefHash)
            try replace(encoded(context))
            return body
        case .legacy, nil: return Data()
        }
    }
    func restore(active: String?, revoke: String?, cookieReference: (String?) -> String?) throws -> (active: String?, revoke: String?) {
        guard let current = try state() else { return (active, revoke) }
        let pending = revoke ?? active
        if case .bound(let context) = current, let pending {
            _ = try context.body(cookieRefHash: cookieReference(pending))
        }
        return (nil, pending)
    }
    func transition(mode: String, active: String?, revoke: String?, cookieReference: (String?) -> String?) throws -> Transition {
        let current = try state()
        let pending: Revocation?
        var boundEmpty = false
        if case .bound(let context) = current {
            boundEmpty = active == nil && revoke == nil
            if revoke != nil || context.local {
                pending = Revocation(cookie: revoke, body: try pendingBody(cookieRefHash: cookieReference(revoke)))
            } else { pending = nil }
        } else {
            pending = revoke.map { Revocation(cookie: $0, body: Data()) }
        }
        return Transition(preserveEmptyContext: boundEmpty && ["login", "logout"].contains(mode),
                          blockCheck: mode == "check" && boundEmpty && pending == nil, pending: pending)
    }
    func clear() throws {
        _ = try state() // Unknown/corrupt context cannot silently become absent.
        guard unlinkat(directory, name, 0) == 0 || errno == ENOENT,
              syncDirectory(directory) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
}
