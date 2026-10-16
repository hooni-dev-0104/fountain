import UIKit
import Capacitor
import Foundation
import WebKit
import Security
import Darwin
import CryptoKit

// Foundation only: activation requires the resource-proof/recovery/device gate.
private let OUTBOX_ENABLED = false

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

// CAPPluginCall does not retain WKFrameInfo. Filter the actual native message
// before forwarding to Capacitor, then recheck the current document at dispatch.
final class FountainBridgeGate: NSObject, WKScriptMessageHandler {
    weak var controller: FountainBridgeViewController?
    weak var delegate: WebViewDelegationHandler?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let controller = controller,
              controller.bundled(message.frameInfo.request.url), controller.bundled(controller.webView?.url),
              let body = message.body as? [String: Any], body["type"] as? String == "message",
              body["pluginId"] as? String == "FountainNative",
              let method = body["methodName"] as? String,
              ["getConfiguration", "configure", "request", "cancel", "download", "saveData", "outboxOpen", "stageDelta", "commitDelta", "readPage"].contains(method) else { return }
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

// Capacitor's generic file URL route otherwise serves writable sandbox files at
// the privileged app origin. Keep the scheme handler confined to bundled assets.
private final class FountainAssetGate: NSObject, WKURLSchemeHandler {
    let original: WKURLSchemeHandler
    init(_ original: WKURLSchemeHandler) { self.original = original }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == "capacitor", url.host == "localhost",
              safe(url.path) else { urlSchemeTask.didFailWithError(URLError(.unsupportedURL)); return }
        original.webView(webView, start: urlSchemeTask)
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { original.webView(webView, stop: urlSchemeTask) }
    private func safe(_ input: String) -> Bool {
        var path = input
        for _ in 0..<16 {
            guard !path.hasPrefix(CapacitorBridge.fileStartIdentifier),
                  !path.hasPrefix(CapacitorBridge.httpInterceptorStartIdentifier), !path.contains("\\"),
                  !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return false }
            guard let next = path.removingPercentEncoding else { return false }
            if next == path { return true }
            path = next
        }
        return false
    }
}

@objc(FountainBridgeViewController)
final class FountainBridgeViewController: CAPBridgeViewController {
    private var gate: FountainBridgeGate?
    private var native: FountainNative?

    override func instanceDescriptor() -> InstanceDescriptor {
        // Do not call super: its implementation restores a writable persisted
        // serverBasePath. Only this signed application's bundled shell may boot.
        let descriptor = InstanceDescriptor()
        descriptor.appLocation = (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("public", isDirectory: true)
        descriptor.serverURL = nil
        descriptor.appStartPath = nil
        descriptor.errorPath = nil
        descriptor.urlScheme = "capacitor"
        descriptor.urlHostname = "localhost"
        descriptor.allowedNavigationHostnames = []
        descriptor.loggingBehavior = .none
        descriptor.isWebDebuggable = false
        descriptor.pluginConfigurations = ["CapacitorHttp": ["enabled": false], "CapacitorCookies": ["enabled": false]]
        return descriptor
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        if let original = configuration.urlSchemeHandler(forURLScheme: "capacitor") {
            configuration.setURLSchemeHandler(nil, forURLScheme: "capacitor")
            configuration.setURLSchemeHandler(FountainAssetGate(original), forURLScheme: "capacitor")
        }
        return super.webView(with: frame, configuration: configuration)
    }

    func shutdownNative() { native?.shutdownNative() }
    deinit { native?.shutdownNative() }

    func bundled(_ url: URL?) -> Bool {
        guard let url = url, let local = bridge?.config.localURL else { return false }
        return url.scheme == local.scheme && url.host == local.host && url.port == local.port
            && url.scheme == "capacitor" && url.user == nil && url.password == nil
    }

    override func capacitorDidLoad() {
        // Capacitor otherwise prints prefixes of API response bodies in debug builds.
        CAPLog.enableLogging = false
        guard let realBridge = bridge as? CapacitorBridge, let webView = webView else { return }
        let filter = FountainBridgeGate()
        filter.controller = self
        filter.delegate = realBridge.webViewDelegationHandler
        let messages = webView.configuration.userContentController
        messages.removeScriptMessageHandler(forName: "bridge")
        messages.add(filter, name: "bridge")
        gate = filter
        let plugin = FountainNative()
        native = plugin
        bridge?.registerPluginInstance(plugin)
    }
}

private enum FountainFailure: Error {
    case invalid, stale, cancelled, network, timeout, storage, durableInvalidation, redirect, tooLarge, incomplete, busy, revoke, unavailable
    var code: String {
        switch self {
        case .invalid: return "NATIVE_INVALID"
        case .stale: return "NATIVE_STALE"
        case .cancelled: return "NATIVE_CANCELLED"
        case .network: return "NATIVE_NETWORK"
        case .timeout: return "NATIVE_TIMEOUT"
        case .storage: return "NATIVE_STORAGE"
        case .durableInvalidation: return "NATIVE_DURABLE_INVALIDATION_FAILED"
        case .redirect: return "NATIVE_REDIRECT"
        case .tooLarge: return "NATIVE_TOO_LARGE"
        case .incomplete: return "NATIVE_INCOMPLETE"
        case .busy: return "NATIVE_BUSY"
        case .revoke: return "NATIVE_REVOKE"
        case .unavailable: return "NATIVE_UNAVAILABLE"
        }
    }
    var message: String {
        switch self {
        case .invalid: return "Invalid native request"
        case .stale: return "Native session or server configuration changed"
        case .cancelled: return "Native request cancelled"
        case .network: return "Native network request failed"
        case .timeout: return "Native request timed out"
        case .storage: return "Secure native storage is unavailable"
        case .durableInvalidation: return "DURABLE_INVALIDATION_FAILED: secure session invalidation could not be confirmed"
        case .redirect: return "Native redirects are not allowed"
        case .tooLarge: return "Native transfer exceeds its limit"
        case .incomplete: return "Native download was incomplete"
        case .busy: return "A native session or export operation is already in progress"
        case .revoke: return "The previous session must be revoked before continuing"
        case .unavailable: return "Native document export is unavailable"
        }
    }
}

private struct FountainCookies: Codable {
    var active: String?
    var revoke: String?
}

private final class FountainJob {
    let id: String
    let call: CAPPluginCall
    let generation: Int
    var auth: Int
    let path: String
    let method: String
    let headers: [String: String]
    let body: Data
    let timeout: TimeInterval
    let mode: String
    var sentCookie: String?
    var task: URLSessionDataTask?
    var file: URL?
    var revoking = false
    var callClosed = false
    var cancelAfterRevoke = false
    var timer: DispatchSourceTimer?
    init(id: String, call: CAPPluginCall, generation: Int, auth: Int, path: String, method: String,
         headers: [String: String], body: Data, timeout: TimeInterval, mode: String) {
        self.id = id; self.call = call; self.generation = generation; self.auth = auth
        self.path = path; self.method = method; self.headers = headers; self.body = body
        self.timeout = timeout; self.mode = mode
    }
}

private final class FountainTransfer {
    var response: HTTPURLResponse?
    var data = Data()
    var received: Int64 = 0
    var expected: Int64 = -1
    var error: FountainFailure?
    var sink: FileHandle?
    var timer: DispatchSourceTimer?
    let streamed: Bool
    let done: (HTTPURLResponse?, Data, FountainFailure?) -> Void
    init(streamed: Bool, sink: FileHandle?, done: @escaping (HTTPURLResponse?, Data, FountainFailure?) -> Void) {
        self.streamed = streamed; self.sink = sink; self.done = done
    }
}

@objc(FountainNative)
final class FountainNative: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate, UIDocumentPickerDelegate {
    private static let ownership = NSRecursiveLock()
    private static weak var currentOwner: FountainNative?
    private static var exportsCleaned = false
    let identifier = "FountainNative"
    let jsName = "FountainNative"
    let pluginMethods: [CAPPluginMethod] = ["getConfiguration", "configure", "request", "cancel", "download", "saveData", "outboxOpen", "stageDelta", "commitDelta", "readPage"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let queue = DispatchQueue(label: "dev.fountain.native-state")
    private var session: URLSession!
    private var origin: String?
    private var generation = 0
    private var auth = 0
    private var jobs: [String: FountainJob] = [:]
    private var transfers: [Int: FountainTransfer] = [:]
    private var authQueue: [FountainJob] = []
    private var authJob: FountainJob?
    private var authDrainSuspended = 0
    private var exportID: String?
    private weak var picker: UIDocumentPickerViewController?
    // Main-thread only; a dismissed old picker cannot complete a newer export.
    private var pickerJobID: String?
    private var storageFailed = false
    private var terminated = false
    private let outboxOwner = UUID().uuidString
    private var outbox: FountainOutbox?
    private var outboxFailed = false
    private let defaults = UserDefaults.standard
    private let safeHeaders = Set(["content-type", "content-length", "content-range", "accept-ranges", "etag", "content-disposition"])

    override func load() {
        Self.ownership.lock()
        let previous = Self.currentOwner
        Self.currentOwner = self
        Self.cleanAbandonedExports()
        Self.ownership.unlock()
        if previous !== self { previous?.shutdownNative() }
        origin = defaults.string(forKey: "FountainNative.origin")
        generation = defaults.integer(forKey: "FountainNative.generation")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegates = OperationQueue()
        delegates.maxConcurrentOperationCount = 1
        delegates.underlyingQueue = queue
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegates)
    }

    private static func cleanAbandonedExports() {
        guard !exportsCleaned else { return }
        exportsCleaned = true
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory
        guard let directories = try? manager.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil) else { return }
        for directory in directories {
            let name = directory.lastPathComponent
            guard name.hasPrefix("Fountain-"), UUID(uuidString: String(name.dropFirst(9))) != nil,
                  let attributes = try? manager.attributesOfItem(atPath: directory.path),
                  attributes[.type] as? FileAttributeType == .typeDirectory,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                  (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700,
                  let children = try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil), children.count <= 1 else { continue }
            let privateFiles = children.allSatisfy { child in
                guard let info = try? manager.attributesOfItem(atPath: child.path) else { return false }
                return info[.type] as? FileAttributeType == .typeRegular
                    && (info[.ownerAccountID] as? NSNumber)?.uint32Value == getuid()
                    && (info[.posixPermissions] as? NSNumber)?.intValue == 0o600
            }
            if privateFiles { try? manager.removeItem(at: directory) }
        }
    }

    private func ownsBridge() -> Bool {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        return Self.currentOwner === self
    }

    func shutdownNative() {
        Self.ownership.lock()
        if Self.currentOwner === self { Self.currentOwner = nil }
        Self.ownership.unlock()
        queue.async {
            Self.ownership.lock(); defer { Self.ownership.unlock() }
            guard !self.terminated else { return }
            self.terminated = true; self.auth += 1; self.authDrainSuspended += 1
            for job in Array(self.jobs.values) { self.end(job, failure: .stale) }
            self.authQueue.removeAll()
            self.session?.invalidateAndCancel()
            self.outbox?.close(); self.outbox = nil
        }
    }

    private func fromMainFrame(_ call: CAPPluginCall, _ action: @escaping () throws -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let controller = self.bridge?.viewController as? FountainBridgeViewController,
                  controller.bundled(controller.webView?.url) else {
                call.reject("Native bridge is restricted to the bundled main frame", "BRIDGE_DENIED"); return
            }
            self.queue.async {
                Self.ownership.lock(); defer { Self.ownership.unlock() }
                do {
                    guard self.ownsBridge(), !self.terminated else { throw FountainFailure.stale }
                    try action()
                }
                catch {
                    if let outboxError = error as? FountainOutboxError {
                        if outboxError == .storage { self.poisonOutbox() }
                        call.reject(outboxError.message, outboxError.code); return
                    }
                    let failure = error as? FountainFailure ?? .invalid
                    call.reject(failure.message, failure.code)
                }
            }
        }
    }

    private func integer(_ call: CAPPluginCall, _ name: String) throws -> Int {
        guard let number = call.options[name] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991 else { throw FountainFailure.invalid }
        return number.intValue
    }

    private func configuration() -> [String: Any] {
        return ["origin": origin as Any? ?? NSNull(), "generation": generation,
                "outboxVersion": 1, "outboxEnabled": OUTBOX_ENABLED]
    }

    // All callers hold ownership and execute on queue; the default transport
    // path never reaches this constructor while the foundation is disabled.
    private func outboxStore() throws -> FountainOutbox {
        guard OUTBOX_ENABLED, let backend = origin, !storageFailed, !outboxFailed else { throw FountainOutboxError.blocked }
        if let outbox = outbox { return outbox }
        do {
            let created = try FountainOutbox(origin: backend)
            outbox = created
            return created
        } catch { poisonOutbox(); throw FountainOutboxError.storage }
    }

    private func poisonOutbox() {
        outboxFailed = true
        outbox?.close(); outbox = nil
    }

    private func outboxReference(_ cookie: String?) -> String? {
        cookie.map { FountainOutbox.hash(Data($0.utf8)) }
    }

    private func validatedOutbox() throws -> FountainOutbox {
        let store = try outboxStore()
        let value = try cookies()
        let invalidated = try hasInvalidation(origin!)
        try store.validateSession(outboxReference(value.active) ?? "local-no-cookie",
                                  eligible: value.revoke == nil && !invalidated && !storageFailed)
        try store.ensureOwner(outboxOwner, epoch: auth)
        return store
    }

    private func outboxCall(_ call: CAPPluginCall, _ action: @escaping (FountainOutbox) throws -> [String: Any]) {
        // No SQLite access, migration or auth storage work in the disabled path.
        guard OUTBOX_ENABLED else { call.reject("Native outbox foundation is disabled", "OUTBOX_DISABLED"); return }
        fromMainFrame(call) {
            do {
                guard try self.integer(call, "generation") == self.generation else { throw FountainOutboxError.stale }
                let store = try self.validatedOutbox()
                let startingAuth = self.auth, startingOrigin = self.origin, startingGeneration = self.generation
                var result = try action(store)
                result["generation"] = startingGeneration
                let boundary = store.boundary
                let startingProofEpoch = try store.proofEpoch()
                var fragmentDeadline: Double?
                if result["fragments"] != nil {
                    let deadline = try store.deliveryDeadline()
                    guard deadline > Date().timeIntervalSince1970 * 1000 else { throw FountainOutboxError.access }
                    fragmentDeadline = deadline
                }
                let deliveryResult = result
                // CAPPluginCall.resolve itself queues another main hop. Deliver
                // this outbox-only envelope at the checked final UI boundary.
                DispatchQueue.main.async { [weak self] in
                    Self.ownership.lock(); defer { Self.ownership.unlock() }
                    guard let self = self, Self.currentOwner === self, !self.terminated,
                          self.generation == startingGeneration, self.auth == startingAuth,
                          self.origin == startingOrigin, !self.storageFailed, !self.outboxFailed,
                          self.outbox === store, store.boundary == boundary,
                          store.observedProofEpoch == startingProofEpoch,
                          fragmentDeadline == nil || fragmentDeadline! > Date().timeIntervalSince1970 * 1000,
                          let controller = self.bridge?.viewController as? FountainBridgeViewController,
                          controller.bundled(controller.webView?.url), let webView = controller.webView,
                          let callbackID = call.callbackId, let methodName = call.methodName else {
                        call.reject(FountainFailure.stale.message, FountainFailure.stale.code); return
                    }
                    let envelope: [String: Any] = ["callbackId": callbackID,
                        "pluginId": "FountainNative", "methodName": methodName,
                        "save": false, "success": true, "data": deliveryResult]
                    guard let bytes = try? JSONSerialization.data(withJSONObject: envelope, options: [.fragmentsAllowed]),
                          let payload = String(data: bytes, encoding: .utf8) else {
                        call.reject(FountainFailure.invalid.message, FountainFailure.invalid.code); return
                    }
                    webView.evaluateJavaScript("window.Capacitor.fromNative(" + payload + ")", completionHandler: nil)
                }
            } catch let error as FountainOutboxError {
                if error == .storage { self.poisonOutbox() }
                call.reject(error.message, error.code)
            }
        }
    }

    @objc func outboxOpen(_ call: CAPPluginCall) {
        outboxCall(call) { try $0.open() }
    }
    @objc func stageDelta(_ call: CAPPluginCall) {
        outboxCall(call) { store in
            guard let lease = call.getString("lease"), let tx = call.getString("txId"),
                  let encoded = call.getString("bytesBase64"), encoded.utf8.count <= 349_528,
                  let bytes = Data(base64Encoded: encoded) else { throw FountainOutboxError.invalid }
            let part = try self.integer(call, "part")
            try store.stage(lease: lease, txID: tx, baseHead: self.integer(call, "baseHead"), proofEpoch: self.integer(call, "proofEpoch"), part: part, bytes: bytes)
            return ["part": part]
        }
    }
    @objc func commitDelta(_ call: CAPPluginCall) {
        outboxCall(call) { store in
            guard let lease = call.getString("lease"), let tx = call.getString("txId"), let digest = call.getString("digest") else { throw FountainOutboxError.invalid }
            return try store.commit(lease: lease, txID: tx, baseHead: self.integer(call, "baseHead"), proofEpoch: self.integer(call, "proofEpoch"), digest: digest)
        }
    }
    @objc func readPage(_ call: CAPPluginCall) {
        outboxCall(call) { store in
            guard let lease = call.getString("lease") else { throw FountainOutboxError.invalid }
            return try store.read(lease: lease, head: self.integer(call, "head"), proofEpoch: self.integer(call, "proofEpoch"), cursor: call.getString("cursor"), byteLimit: self.integer(call, "byteLimit"))
        }
    }

    private func observeOutboxSession(_ job: FountainJob, response: HTTPURLResponse, data: Data) throws {
        guard OUTBOX_ENABLED else { return }
        let store = try outboxStore()
        if response.statusCode == 401 { try store.revoke(); return }
        guard ["login", "check"].contains(job.mode), response.statusCode == 200 else { return }
        guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            try store.revoke(); throw FountainOutboxError.invalid
        }
        let value = try cookies()
        guard value.revoke == nil, !(try hasInvalidation(origin!)) else { try store.revoke(); throw FountainOutboxError.blocked }
        if body["authenticated"] as? Bool != true { try store.revoke(); return }
        try store.grant(body, sessionRef: outboxReference(value.active))
    }

    private func observeOutboxResource(_ job: FountainJob, response: HTTPURLResponse, data: Data) throws {
        guard OUTBOX_ENABLED, FountainOutbox.canonicalResource(path: job.path, method: job.method) != nil else { return }
        guard current(job), try cookies().active == job.sentCookie else { throw FountainOutboxError.stale }
        try outboxStore().observeResource(path: job.path, method: job.method, status: response.statusCode,
                                         data: data, sessionRef: outboxReference(job.sentCookie))
    }

    private func validOrigin(_ raw: String) throws -> String {
        guard !raw.contains("\\"), !raw.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              var parts = URLComponents(string: raw), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!) else { throw FountainFailure.invalid }
        parts.scheme = "https"; parts.host = host.lowercased(); parts.path = ""
        if parts.port == 443 { parts.port = nil }
        guard let url = parts.url else { throw FountainFailure.invalid }
        return url.absoluteString
    }

    private func validPath(_ raw: String) throws -> String {
        guard raw.utf8.count <= 8192, !raw.contains("#") else { throw FountainFailure.invalid }
        let path = String(raw.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        var decoded = path
        var stable = false
        for _ in 0..<16 {
            guard decoded.hasPrefix("/api/"), !decoded.hasPrefix("//"), !decoded.contains("\\"),
                  !decoded.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  !decoded.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) else { throw FountainFailure.invalid }
            guard let next = decoded.removingPercentEncoding else {
                if decoded.range(of: "%[0-9A-Fa-f]{2}", options: .regularExpression) != nil { throw FountainFailure.invalid }
                stable = true; break
            }
            if next == decoded { stable = true; break }
            decoded = next
        }
        guard stable, !raw.contains("\\"), !raw.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              decoded != "/api/session" || path == "/api/session" else { throw FountainFailure.invalid }
        return decoded
    }

    private func cookieQuery(_ backend: String) -> [String: Any] {
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "dev.fountain.workspace") + ".native-session",
                kSecAttrAccount as String: backend, kSecAttrSynchronizable as String: false]
    }

    // A marker contains no credential. openat/no-follow and fsync make presence
    // durable independently of a failed Keychain update, without plaintext auth.
    private func journalDirectory() throws -> Int32 {
        let manager = FileManager.default
        let parent = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                     appropriateFor: nil, create: true).resolvingSymlinksInPath()
        let parentFD = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard parentFD >= 0 else { throw FountainFailure.storage }
        defer { Darwin.close(parentFD) }
        if mkdirat(parentFD, "FountainSessionInvalidations", mode_t(0o700)) == 0 {
            guard fsync(parentFD) == 0 else { throw FountainFailure.storage }
        } else if errno != EEXIST { throw FountainFailure.storage }
        let descriptor = openat(parentFD, "FountainSessionInvalidations", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw FountainFailure.storage }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
              (info.st_mode & mode_t(0o777)) == mode_t(0o700) else {
            Darwin.close(descriptor); throw FountainFailure.storage
        }
        return descriptor
    }

    private func markerName(_ backend: String) -> String {
        return SHA256.hash(data: Data(backend.utf8)).map { String(format: "%02x", $0) }.joined() + ".invalid"
    }

    private func hasInvalidation(_ backend: String) throws -> Bool {
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        var info = stat()
        if fstatat(directory, markerName(backend), &info, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return false }
            throw FountainFailure.storage
        }
        guard (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), info.st_uid == getuid(),
              (info.st_mode & mode_t(0o777)) == mode_t(0o600) else { throw FountainFailure.storage }
        return true
    }

    private func writeInvalidation(_ backend: String) throws {
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        let name = markerName(backend)
        var descriptor = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK, mode_t(0o600))
        if descriptor < 0 && errno == EEXIST { descriptor = openat(directory, name, O_WRONLY | O_NOFOLLOW | O_NONBLOCK) }
        guard descriptor >= 0 else { throw FountainFailure.storage }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              info.st_uid == getuid(), (info.st_mode & mode_t(0o777)) == mode_t(0o600) else { throw FountainFailure.storage }
        var marker: UInt8 = 1
        guard Darwin.write(descriptor, &marker, 1) == 1, fsync(descriptor) == 0, fsync(directory) == 0 else { throw FountainFailure.storage }
    }

    private func clearInvalidation(_ backend: String) throws {
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        guard unlinkat(directory, markerName(backend), 0) == 0 || errno == ENOENT else { throw FountainFailure.storage }
        guard fsync(directory) == 0 else { throw FountainFailure.storage }
    }

    private func cookies() throws -> FountainCookies {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard Self.currentOwner === self else { throw FountainFailure.stale }
        guard !storageFailed, let backend = origin else { throw FountainFailure.storage }
        let invalidated = try hasInvalidation(backend)
        var query = cookieQuery(backend)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return FountainCookies() }
        guard status == errSecSuccess, let data = result as? Data,
              let value = try? JSONDecoder().decode(FountainCookies.self, from: data),
              value.active == nil || value.revoke == nil,
              [value.active, value.revoke].compactMap({ $0 }).allSatisfy({ cookie in
                  cookie.hasPrefix("fountain_session=") && cookie.utf8.count > 17 && cookie.utf8.count <= 4113
                      && !cookie.unicodeScalars.contains(where: { $0.value <= 32 || $0.value >= 127 || $0.value == 59 })
              }) else { throw FountainFailure.storage }
        if invalidated {
            return FountainCookies(active: nil, revoke: value.revoke ?? value.active)
        }
        return value
    }

    private func saveCookies(_ value: FountainCookies) throws {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard Self.currentOwner === self else { throw FountainFailure.stale }
        guard !storageFailed, let backend = origin else { throw FountainFailure.storage }
        var journalReady = false
        if value.active == nil {
            do { try writeInvalidation(backend); journalReady = true }
            catch { /* A confirmed Keychain update/delete remains a durable path. */ }
        }
        do {
            if OUTBOX_ENABLED, value.active == nil { try outboxStore().revoke() }
            let data = try JSONEncoder().encode(value)
            let query = cookieQuery(backend)
            let update = [kSecValueData as String: data]
            var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            if status == errSecItemNotFound {
                var item = query
                item[kSecValueData as String] = data
                item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                status = SecItemAdd(item as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw FountainFailure.storage }
            if value.revoke == nil {
                if OUTBOX_ENABLED, value.active == nil {
                    guard try outboxStore().revocationConfirmed() else { throw FountainFailure.storage }
                }
                try clearInvalidation(backend)
            }
        } catch {
            storageFailed = true
            if !journalReady {
                do { try writeInvalidation(backend); journalReady = true }
                catch { /* Fall back to deleting this origin's Keychain item. */ }
            }
            let deletion = SecItemDelete(cookieQuery(backend) as CFDictionary)
            let deleted = deletion == errSecSuccess || deletion == errSecItemNotFound
            let failure: FountainFailure = journalReady || deleted ? .storage : .durableInvalidation
            auth += 1
            authDrainSuspended += 1
            for job in Array(jobs.values) { end(job, failure: failure) }
            authDrainSuspended -= 1
            nextAuth()
            // Never send a revoke-only cookie through an ordinary API request.
            // A vault failure must not prevent best-effort DELETE using RAM.
            bestEffortRevoke(value.revoke ?? value.active)
            throw failure
        }
    }

    private func bestEffortRevoke(_ cookie: String?) {
        guard ownsBridge(), !terminated,
              let task = try? network(path: "/api/session", method: "DELETE", headers: [:], body: Data(),
                                      cookie: cookie, timeout: 45, file: nil, done: { _, _, _ in }) else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(45))
        timer.setEventHandler { [weak task] in task?.cancel() }
        transfers[task.taskIdentifier]?.timer = timer
        timer.resume()
    }

    private func authCookies() throws -> FountainCookies {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard Self.currentOwner === self, let backend = origin else { throw FountainFailure.stale }
        // Fence before reading: even a locked/unavailable Keychain cannot leave
        // an old active cookie eligible for use after a failed logout/relaunch.
        var journalReady = false
        do { try writeInvalidation(backend); journalReady = true }
        catch { /* A confirmed Keychain change/delete can still invalidate it. */ }
        do {
            let value = try cookies()
            if OUTBOX_ENABLED {
                do { try outboxStore().revoke() }
                catch {
                    // Keep the native invalidation marker; database failure
                    // cannot prevent a RAM-only best-effort anonymous DELETE.
                    bestEffortRevoke(value.revoke ?? value.active)
                    throw FountainFailure.storage
                }
            }
            return value
        }
        catch {
            let status = SecItemDelete(cookieQuery(backend) as CFDictionary)
            storageFailed = true
            if journalReady || status == errSecSuccess || status == errSecItemNotFound { throw FountainFailure.storage }
            throw FountainFailure.durableInvalidation
        }
    }

    @objc func getConfiguration(_ call: CAPPluginCall) {
        fromMainFrame(call) { call.resolve(self.configuration()) }
    }

    @objc func configure(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            guard let value = call.getString("origin") else { throw FountainFailure.invalid }
            let updated = try self.validOrigin(value)
            if self.origin == updated { call.resolve(self.configuration()); return }
            guard self.authJob == nil, self.authQueue.isEmpty else { throw FountainFailure.busy }
            if self.origin != nil {
                let current = try self.cookies()
                guard current.active == nil, current.revoke == nil else { throw FountainFailure.revoke }
            }
            if OUTBOX_ENABLED { try self.outbox?.revoke() }
            self.outbox?.close(); self.outbox = nil
            self.generation += 1; self.auth += 1
            for job in Array(self.jobs.values) { self.end(job, failure: .stale) }
            self.origin = updated
            self.defaults.set(updated, forKey: "FountainNative.origin")
            self.defaults.set(self.generation, forKey: "FountainNative.generation")
            call.resolve(self.configuration())
        }
    }

    private func newJob(_ call: CAPPluginCall, mode: String) throws -> FountainJob {
        guard let id = call.getString("id"), !id.isEmpty, id.utf8.count <= 160, jobs[id] == nil, jobs.count < 16,
              origin != nil, try integer(call, "generation") == generation else { throw FountainFailure.stale }
        let path = mode == "saveData" ? "/api/" : (call.getString("path") ?? "")
        let decoded = try validPath(path)
        let method = mode == "request" ? (call.getString("method") ?? "GET").uppercased() : "GET"
        guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method) else { throw FountainFailure.invalid }
        var headers: [String: String] = [:]
        if let input = call.options["headers"] {
            guard mode == "request" else { throw FountainFailure.invalid }
            guard let values = input as? [String: String] else { throw FountainFailure.invalid }
            for (key, value) in values {
                let name = key.lowercased()
                guard ["content-type", "accept", "range", "if-none-match"].contains(name), headers[name] == nil,
                      value.utf8.count <= 4096, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw FountainFailure.invalid }
                headers[name] = value
            }
        }
        let encoded = call.getString("bodyBase64") ?? ""
        let limit = mode == "saveData" ? 8 * 1024 * 1024 : 10_000_000
        guard encoded.utf8.count <= ((limit + 2) / 3) * 4,
              let body = Data(base64Encoded: encoded), body.count <= limit else { throw FountainFailure.tooLarge }
        guard mode != "download" || body.isEmpty else { throw FountainFailure.invalid }
        let timeout: Int
        if call.options["timeoutMs"] == nil { timeout = 45_000 }
        else { timeout = try integer(call, "timeoutMs") }
        guard (1...45_000).contains(timeout) else { throw FountainFailure.invalid }
        let kind = mode == "request" && decoded == "/api/session" ? (method == "POST" ? "login" : method == "DELETE" ? "logout" : method == "GET" ? "check" : mode) : mode
        let job = FountainJob(id: id, call: call, generation: generation, auth: auth, path: path,
                              method: method, headers: headers, body: body, timeout: Double(timeout) / 1000, mode: kind)
        jobs[id] = job
        if mode == "request" {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + .milliseconds(timeout))
            timer.setEventHandler { [weak self, weak job] in
                guard let self = self, let job = job else { return }
                self.end(job, failure: .timeout)
            }
            job.timer = timer
            timer.resume()
        }
        return job
    }

    @objc func request(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            let job = try self.newJob(call, mode: "request")
            if ["login", "logout", "check"].contains(job.mode) {
                self.authQueue.append(job); self.nextAuth()
            } else {
                guard self.authJob == nil else { self.end(job, failure: .busy); return }
                self.send(job)
            }
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            guard let id = call.getString("id"), let job = self.jobs[id], job.mode != "logout", !job.callClosed else {
                call.resolve(["cancelled": false]); return
            }
            if job.revoking {
                // Close the caller now, but finish DELETE and never start the
                // cancelled login/session check after that protected phase.
                job.cancelAfterRevoke = true; job.callClosed = true
                job.call.reject(FountainFailure.cancelled.message, FountainFailure.cancelled.code)
            } else { self.end(job, failure: .cancelled) }
            call.resolve(["cancelled": true])
        }
    }

    private func current(_ job: FountainJob) -> Bool {
        return ownsBridge() && !terminated && jobs[job.id] === job && job.generation == generation && job.auth == auth
    }

    private func nextAuth() {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard authJob == nil, authDrainSuspended == 0 else { return }
        while !authQueue.isEmpty {
            let job = authQueue.removeFirst()
            guard jobs[job.id] === job else { continue }
            authJob = job
            do {
                if job.mode != "check" {
                    auth += 1
                    for other in Array(jobs.values) where other !== job && !authQueue.contains(where: { $0 === other }) {
                        end(other, failure: .stale)
                    }
                }
                job.auth = auth
                var value: FountainCookies
                if job.mode == "check" { value = try cookies() }
                else { value = try authCookies() }
                if job.mode != "check" {
                    if let active = value.active { value.active = nil; value.revoke = active }
                    try saveCookies(value)
                }
                if let old = value.revoke {
                    job.revoking = true
                    job.task = try network(path: "/api/session", method: "DELETE", headers: [:], body: Data(), cookie: old,
                                           timeout: job.timeout, file: nil) { response, data, error in
                        job.revoking = false
                        guard self.current(job) else { return }
                        guard error == nil, let response = response, (200..<300).contains(response.statusCode) || response.statusCode == 401 else {
                            self.end(job, failure: .revoke); return
                        }
                        do {
                            try self.saveCookies(FountainCookies())
                            if job.cancelAfterRevoke { self.end(job, failure: .cancelled) }
                            else if job.mode == "logout" { self.resolve(job, response: response, data: data) }
                            else { self.send(job) }
                        } catch { self.end(job, failure: .storage) }
                    }
                } else { send(job) }
            } catch { end(job, failure: error as? FountainFailure ?? .storage) }
            return
        }
    }

    private func send(_ job: FountainJob) {
        guard current(job) else { end(job, failure: .stale); return }
        do {
            job.sentCookie = try cookies().active
            job.task = try network(path: job.path, method: job.method, headers: job.headers, body: job.body,
                                   cookie: job.sentCookie, timeout: job.timeout, file: job.mode == "download" ? job.file : nil) { response, data, error in
                guard self.current(job) else { return }
                guard error == nil, let response = response else { self.end(job, failure: error ?? .network); return }
                do {
                    if job.mode == "login", (200..<300).contains(response.statusCode) {
                        let fields = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
                            if let key = entry.key as? String { result[key] = String(describing: entry.value) }
                        }
                        guard let responseURL = response.url else { throw FountainFailure.invalid }
                        let found = HTTPCookie.cookies(withResponseHeaderFields: fields, for: responseURL).filter { $0.name == "fountain_session" }
                        guard found.count == 1, found[0].path == "/", !found[0].value.isEmpty,
                              found[0].value.utf8.count <= 4096,
                              !found[0].value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value >= 127 || $0.value == 59 }) else { throw FountainFailure.invalid }
                        try self.saveCookies(FountainCookies(active: "fountain_session=" + found[0].value, revoke: nil))
                    } else if response.statusCode == 401, let sent = job.sentCookie {
                        let value = try self.cookies()
                        if value.active == sent {
                            try self.saveCookies(FountainCookies(active: nil, revoke: sent))
                            self.auth += 1; job.auth = self.auth
                            self.authDrainSuspended += 1
                            for other in Array(self.jobs.values) where other !== job && !self.authQueue.contains(where: { $0 === other }) {
                                self.end(other, failure: .stale)
                            }
                            self.authDrainSuspended -= 1
                        }
                    }
                    try self.observeOutboxSession(job, response: response, data: data)
                    if response.statusCode != 401 { try self.observeOutboxResource(job, response: response, data: data) }
                    if job.mode == "download" {
                        guard (200..<300).contains(response.statusCode) else { throw FountainFailure.network }
                        self.export(job)
                    } else { self.resolve(job, response: response, data: data) }
                } catch {
                    if let error = error as? FountainOutboxError, error == .storage { self.poisonOutbox() }
                    if let error = error as? FountainOutboxError {
                        job.callClosed = true; job.call.reject(error.message, error.code)
                    }
                    self.end(job, failure: error as? FountainFailure ?? .storage)
                }
            }
        } catch { end(job, failure: error as? FountainFailure ?? .network) }
    }

    private func network(path: String, method: String, headers: [String: String], body: Data, cookie: String?,
                         timeout: TimeInterval, file: URL?, done: @escaping (HTTPURLResponse?, Data, FountainFailure?) -> Void) throws -> URLSessionDataTask {
        guard let backend = origin, let url = URL(string: backend + path), let base = URL(string: backend),
              url.scheme == "https", url.host == base.host, url.port == base.port else { throw FountainFailure.invalid }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method; request.httpBody = body.isEmpty ? nil : body
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("1", forHTTPHeaderField: "X-Fountain-Request")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let cookie = cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        let sink = try file.map { try FileHandle(forWritingTo: $0) }
        let transfer = FountainTransfer(streamed: file != nil, sink: sink, done: done)
        let task = session.dataTask(with: request)
        transfers[task.taskIdentifier] = transfer
        task.resume()
        return task
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        transfers[task.taskIdentifier]?.error = .redirect
        completionHandler(nil)
        task.cancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let transfer = transfers[dataTask.taskIdentifier], let http = response as? HTTPURLResponse else { completionHandler(.cancel); return }
        transfer.response = http; transfer.expected = response.expectedContentLength
        if (300..<400).contains(http.statusCode) { transfer.error = .redirect }
        if transfer.streamed && (transfer.expected < 0 || http.statusCode != 200) { transfer.error = .incomplete }
        if !transfer.streamed && transfer.expected > 16 * 1024 * 1024 { transfer.error = .tooLarge }
        completionHandler(transfer.error == nil ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let transfer = transfers[dataTask.taskIdentifier], transfer.error == nil else { return }
        let size = Int64(data.count)
        guard transfer.received <= Int64.max - size else { transfer.error = .tooLarge; dataTask.cancel(); return }
        transfer.received += size
        if transfer.expected >= 0 && transfer.received > transfer.expected { transfer.error = .incomplete; dataTask.cancel(); return }
        do {
            if let sink = transfer.sink { try sink.write(contentsOf: data) }
            else {
                guard transfer.received <= 16 * 1024 * 1024 else { throw FountainFailure.tooLarge }
                transfer.data.append(data)
            }
        } catch { transfer.error = error as? FountainFailure ?? .storage; dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard let transfer = transfers.removeValue(forKey: task.taskIdentifier) else { return }
        transfer.timer?.cancel()
        do { try transfer.sink?.synchronize(); try transfer.sink?.close() }
        catch { transfer.error = .storage }
        if transfer.streamed && transfer.expected != transfer.received { transfer.error = transfer.error ?? .incomplete }
        let networkFailure: FountainFailure?
        if let error = error as? URLError {
            networkFailure = error.code == .timedOut ? .timeout : error.code == .cancelled ? .cancelled : .network
        } else { networkFailure = error == nil ? nil : .network }
        transfer.done(transfer.response, transfer.data, transfer.error ?? networkFailure)
    }

    private func resolve(_ job: FountainJob, response: HTTPURLResponse, data: Data) {
        var headers: [String: String] = [:]
        for (name, value) in response.allHeaderFields {
            if let name = name as? String, safeHeaders.contains(name.lowercased()) { headers[name] = String(describing: value) }
        }
        end(job, result: ["status": response.statusCode, "headers": headers,
                          "bodyBase64": data.base64EncodedString(), "generation": job.generation])
    }

    private func end(_ job: FountainJob, result: [String: Any]? = nil, failure: FountainFailure? = nil) {
        guard jobs[job.id] === job else { return }
        jobs.removeValue(forKey: job.id)
        job.timer?.cancel(); job.timer = nil
        job.task?.cancel()
        if let file = job.file { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        if exportID == job.id {
            exportID = nil
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.pickerJobID == job.id else { return }
                self.picker?.dismiss(animated: true); self.picker = nil; self.pickerJobID = nil
            }
        }
        if !job.callClosed {
            job.callClosed = true
            if let failure = failure { job.call.reject(failure.message, failure.code) }
            else if job.generation == generation && job.auth == auth, let result = result { job.call.resolve(result) }
            else { job.call.reject(FountainFailure.stale.message, FountainFailure.stale.code) }
        }
        if authJob === job { authJob = nil }
        nextAuth()
    }

    private func filename(_ call: CAPPluginCall) throws -> String {
        guard let name = call.getString("filename"), !name.isEmpty, name.utf8.count <= 255,
              name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw FountainFailure.invalid }
        return name
    }

    private func temporary(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Fountain-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        let file = root.appendingPathComponent(name)
        guard FileManager.default.createFile(atPath: file.path, contents: nil,
            attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.complete]) else {
            try? FileManager.default.removeItem(at: root); throw FountainFailure.storage
        }
        return file
    }

    @objc func download(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            guard self.authJob == nil else { throw FountainFailure.busy }
            let name = try self.filename(call)
            let path = call.getString("path") ?? ""
            let decoded = try self.validPath(path)
            let pieces = decoded.split(separator: "/")
            guard !path.contains("?"), decoded == "/api/backup" ||
                    (pieces.count == 4 && pieces[0] == "api" && pieces[1] == "attachments" && pieces[3] == "download") else { throw FountainFailure.invalid }
            let job = try self.newJob(call, mode: "download")
            do { job.file = try self.temporary(name); self.send(job) }
            catch { self.end(job, failure: .storage) }
        }
    }

    @objc func saveData(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            guard self.authJob == nil else { throw FountainFailure.busy }
            let name = try self.filename(call)
            let job = try self.newJob(call, mode: "saveData")
            do {
                job.file = try self.temporary(name)
                let handle = try FileHandle(forWritingTo: job.file!)
                do { try handle.write(contentsOf: job.body); try handle.synchronize(); try handle.close() }
                catch { try? handle.close(); throw error }
                self.export(job)
            } catch { self.end(job, failure: .storage) }
        }
    }

    private func export(_ job: FountainJob) {
        guard current(job), exportID == nil, let file = job.file else { end(job, failure: .busy); return }
        exportID = job.id
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let controller = self.bridge?.viewController,
                  controller.viewIfLoaded?.window != nil, controller.presentedViewController == nil else {
                self?.queue.async { self?.end(job, failure: .unavailable) }; return
            }
            self.queue.async {
                guard self.current(job), self.exportID == job.id else { return }
                DispatchQueue.main.async {
                    let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
                    picker.delegate = self; self.picker = picker; self.pickerJobID = job.id
                    controller.present(picker, animated: true)
                }
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishExport(controller, saved: false) }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finishExport(controller, saved: !urls.isEmpty) }
    private func finishExport(_ controller: UIDocumentPickerViewController, saved: Bool) {
        guard picker === controller, let id = pickerJobID else { return }
        queue.async {
            guard self.exportID == id, let job = self.jobs[id] else { return }
            self.end(job, result: ["saved": saved, "generation": job.generation])
        }
    }
}
