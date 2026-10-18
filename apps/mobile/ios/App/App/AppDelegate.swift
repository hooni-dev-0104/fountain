import UIKit
import Capacitor
import Foundation
import WebKit
import Security
import Darwin
import CryptoKit

private let OUTBOX_ENABLED = true
private var ACTIVE_OUTBOX_ENABLED: Bool {
    if OUTBOX_ENABLED { return true }
    #if DEBUG && targetEnvironment(simulator)
    let environment = ProcessInfo.processInfo.environment
    return environment["FOUNTAIN_OUTBOX_QA"] == "1" && environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA")
    #else
    return false
    #endif
}

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
              ["getConfiguration", "configure", "request", "cancel", "organizationRequest", "organizationCancel", "accountRequest", "accountCancel", "activateWorkspace", "parkWorkspace", "resumeWorkspaceOffline", "download", "saveData", "outboxOpen", "outboxReconcile", "stageDelta", "commitDelta", "readPage", "recoveryInventory", "recoveryExport"].contains(method) else { return }
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
        guard let original = configuration.urlSchemeHandler(forURLScheme: "capacitor") else {
            return super.webView(with: frame, configuration: configuration)
        }
        // WebKit rejects even nil re-registration of a registered scheme.
        // Carry Capacitor's configured state into a fresh configuration and
        // register only the confined asset wrapper, exactly once.
        let confined = WKWebViewConfiguration()
        confined.userContentController = configuration.userContentController
        confined.websiteDataStore = configuration.websiteDataStore
        confined.preferences = configuration.preferences
        confined.defaultWebpagePreferences = configuration.defaultWebpagePreferences
        confined.allowsInlineMediaPlayback = configuration.allowsInlineMediaPlayback
        confined.allowsAirPlayForMediaPlayback = configuration.allowsAirPlayForMediaPlayback
        confined.mediaTypesRequiringUserActionForPlayback = configuration.mediaTypesRequiringUserActionForPlayback
        confined.suppressesIncrementalRendering = configuration.suppressesIncrementalRendering
        confined.limitsNavigationsToAppBoundDomains = configuration.limitsNavigationsToAppBoundDomains
        confined.applicationNameForUserAgent = configuration.applicationNameForUserAgent
        confined.setURLSchemeHandler(FountainAssetGate(original), forURLScheme: "capacitor")
        return super.webView(with: frame, configuration: confined)
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
    case invalid, stale, accountRequired, cancelled, network, timeout, storage, durableInvalidation, redirect, tooLarge, incomplete, busy, revoke, unavailable, sessionInvalid, sessionRequired, sessionConflict
    var code: String {
        switch self {
        case .sessionInvalid: return "NATIVE_SESSION_INVALID"
        case .sessionRequired: return "NATIVE_SESSION_REQUIRED"
        case .sessionConflict: return "NATIVE_SESSION_CONFLICT"
        case .invalid: return "NATIVE_INVALID"
        case .stale: return "NATIVE_STALE"
        case .accountRequired: return "ACCOUNT_AUTH_REQUIRED"
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
    static func session(_ error: FountainSessionLogoutError) -> FountainFailure {
        switch error { case .invalid: return .sessionInvalid; case .required: return .sessionRequired; case .conflict: return .sessionConflict }
    }
    var message: String {
        switch self {
        case .sessionInvalid: return "A valid logout binding is required"
        case .sessionRequired: return "Verify the current native session before logout"
        case .sessionConflict: return "The logout binding does not match the current native session"
        case .invalid: return "Invalid native request"
        case .stale: return "Native session or server configuration changed"
        case .accountRequired: return "Account login is required"
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

// Job downloads accept one canonical UUID query and use Int64 counters, independently of attachment limits.
struct FountainBackupPlan {
    let size: Int64, sha: String, expires: Date
    static func id(_ path: String) throws -> String? {
        guard path.hasPrefix("/api/backup?") else { return nil }
        guard path.range(of: "^/api/backup\\?job_id=[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$", options: .regularExpression) == path.startIndex..<path.endIndex else { throw FountainFailure.invalid }
        return String(path.dropFirst("/api/backup?job_id=".count))
    }
    init(_ data: Data, id: String) throws {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], value["id"] as? String == id,
              value["phase"] as? String == "ready", let number = value["size"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue >= 1, number.doubleValue <= 9_007_199_254_740_991,
              number.doubleValue.rounded(.towardZero) == number.doubleValue,
              let sha = value["sha256"] as? String, sha.utf8.count == 64, sha.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let raw = value["expires_at"] as? String else { throw FountainFailure.invalid }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expires = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw), expires > Date() else { throw FountainFailure.stale }
        self.size = number.int64Value; self.sha = sha; self.expires = expires
    }
    func piece(_ response: HTTPURLResponse, offset: Int64, length: Int, received: Int) throws {
        guard offset >= 0, offset < size, length > 0, length <= 262144, received == length, response.statusCode == 206,
              response.value(forHTTPHeaderField: "Content-Range") == "bytes \(offset)-\(offset + Int64(length) - 1)/\(size)",
              response.value(forHTTPHeaderField: "Content-Length") == String(length), expires > Date() else { throw FountainFailure.incomplete }
    }
}

private final class FountainJob {
    let id: String
    let call: CAPPluginCall
    let generation: Int
    var auth: Int
    let path: String
    var logicalPath: String { FountainWorkspacePolicy.scoped(path)?.logical ?? path }
    func wire(_ logical: String) -> String {
        guard let route = FountainWorkspacePolicy.scoped(path), logical.hasPrefix("/api/") else { return logical }
        return "/api/w/" + route.workspace + "/" + route.binding + String(logical.dropFirst(4))
    }
    let method: String
    let headers: [String: String]
    let body: Data
    let timeout: TimeInterval
    let mode: String
    let startedAt = Date().timeIntervalSince1970 * 1000
    var backupAuthority: FountainRecovery.Authority?
    var backupPlan: FountainBackupPlan?
    var backupOffset: Int64 = 0
    var backupHash = SHA256()
    var sentCookie: String?
    var workspaceEvidence: Int?
    var logoutActor: FountainOutbox.LogoutActor?
    var logoutIntent: FountainSessionLogout.Intent?
    var logoutCookie: String?
    var logoutOrigin: String?
    var requestOrigin: String?
    var reconcileAdmission: FountainOutbox.ReconcileAdmission?
    var syncAdmission: FountainOutbox.SyncAdmission?
    var httpAdmission: FountainOutbox.HTTPAdmission?
    var deliveryAdmission: FountainOutbox.HTTPAdmission?
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
    var scopedAccount = false
    var sessionEvidence: (workspace: String, binding: String, parent: String, version: Int)?
    var sentCookie: String?
    var accountParent: String?
    var accountEpoch: Int?
    var authorityOrigin: String?
    var authorityGeneration = -1
    var authorityAuth = -1
    var authorityWorkspaceEpoch = -1
    var data = Data()
    var received: Int64 = 0
    var expected: Int64 = -1
    var maximum: Int64 = 16 * 1024 * 1024
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
#if DEBUG
    // Native XCTest-only creation-time seam; never a Capacitor method or URL/
    // credential override. Release builds contain neither storage nor setter.
    private static var qaProtocolClass: URLProtocol.Type?
    private static var qaPreinstallBlocked = 0
    private static var qaPreinstallAllocated = 0
    private static var qaOutboxCounters: [String: Int] = [:]
    private static func qaOutboxRecord(_ call: CAPPluginCall, _ event: String) {
        guard ProcessInfo.processInfo.environment["FOUNTAIN_QA"] == "1", (ProcessInfo.processInfo.environment["FOUNTAIN_OUTBOX_QA"] == "1" || ProcessInfo.processInfo.environment["FOUNTAIN_DEFAULT_OUTBOX_QA"] == "1"),
              (ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"),
              let method = call.methodName, ["outboxOpen", "outboxReconcile", "stageDelta", "commitDelta", "readPage"].contains(method) else { return }
        var label = method
        if method == "outboxReconcile" { let phase = call.getString("phase") ?? "invalid"; label += "." + (["prepare", "commit", "cancel", "settle"].contains(phase) ? phase : "invalid") }
        let allowed = ["start", "actionDone", "deliveryScheduled", "delivered", "deliveryFailed", "NATIVE_OUTBOX_INVALID", "NATIVE_OUTBOX_LIMIT", "NATIVE_OUTBOX_STALE", "NATIVE_OUTBOX_HEAD", "NATIVE_OUTBOX_CONFLICT", "NATIVE_OUTBOX_BLOCKED", "NATIVE_STORAGE", "OUTBOX_ACCESS_REQUIRED", "OUTBOX_RECONCILE_RETRY", "OUTBOX_CONFIRMATION_REQUIRED", "otherError"]
        guard allowed.contains(event) else { return }
        ownership.lock(); defer { ownership.unlock() }
        let key = "outbox." + label + "." + event; qaOutboxCounters[key] = min(1_000_000, qaOutboxCounters[key, default: 0] + 1)
    }
    static func qaLaunchNetworkEvidence() -> [String: Int] {
        ownership.lock(); defer { ownership.unlock() }
        var evidence = qaOutboxCounters; evidence["blocked"] = qaPreinstallBlocked; evidence["allocated"] = qaPreinstallAllocated
        for (key, value) in FountainOutbox.qaStorageEvidence() { evidence[key] = value }
        return evidence
    }
    // Device-test SQL inspection must obey the same serialization as native
    // writes; it is trusted XCTest code and is never a Capacitor method.
    static func withQAOutboxOwnership<T>(_ operation: () throws -> T) throws -> T {
        guard ProcessInfo.processInfo.environment["FOUNTAIN_QA"] == "1",
              (ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA") else { throw FountainFailure.invalid }
        ownership.lock(); defer { ownership.unlock() }
        return try operation()
    }
    static func setQAProtocolClass(_ value: URLProtocol.Type?) throws {
        guard ProcessInfo.processInfo.environment["FOUNTAIN_QA"] == "1",
              ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] == "Fountain QA" else { throw FountainFailure.invalid }
        ownership.lock(); defer { ownership.unlock() }
        qaProtocolClass = value
    }
#endif
    let identifier = "FountainNative"
    let jsName = "FountainNative"
    let pluginMethods: [CAPPluginMethod] = ["getConfiguration", "configure", "request", "cancel", "organizationRequest", "organizationCancel", "accountRequest", "accountCancel", "activateWorkspace", "parkWorkspace", "resumeWorkspaceOffline", "download", "saveData", "outboxOpen", "outboxReconcile", "stageDelta", "commitDelta", "readPage", "recoveryInventory", "recoveryExport"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let queue = DispatchQueue(label: "dev.fountain.native-state")
    private var session: URLSession!
    private var organizationTransport: FountainOrganization?
    private var accountTransport: FountainAccount?
    private var workspace: FountainWorkspace?
    private var lastWorkspace: FountainWorkspace?
    private var workspaceEpoch = 0
    private var workspaceOffline = false
    private let workspaceVault = FountainWorkspaceKeychain()
    private var origin: String?
    private var generation = 0
    private var auth = 0
    private var jobs: [String: FountainJob] = [:]
    private var transfers: [Int: FountainTransfer] = [:]
    private var authQueue: [FountainJob] = []
    private var authJob: FountainJob?
    private var authDrainSuspended = 0
    private let sessionLogout = FountainSessionLogout()
    private var exportID: String?
    private weak var picker: UIDocumentPickerViewController?
    // Main-thread only; a dismissed old picker cannot complete a newer export.
    private var pickerJobID: String?
    private var storageFailed = false
    private var terminated = false
    private let outboxOwner = UUID().uuidString
    private var outbox: FountainOutbox?
    private var outboxFailed = false
    private var httpAdmissionSequence = 0
    #if DEBUG && targetEnvironment(simulator)
    private var qaSessionOptedIn = false
    #endif
    private var recoveryMode = false
    private var recovery: FountainRecovery?
    private var recoveryGrant: FountainRecovery.Authority?
    private var recoveryGrantAuth: Int?
    private var recoveryGrantGeneration: Int?
    private var recoveryFiles: [String: [URL]] = [:]
    private var recoverySaveTokens: [String: String] = [:]
    private var recoverySaveAuthority: [String: FountainRecovery.Authority] = [:]
    private var recoveryReaders: [String: FountainRecovery] = [:]
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
        initializeSession()
    }

    private func initializeSession() {
        let configuration = URLSessionConfiguration.ephemeral
#if DEBUG
        Self.ownership.lock()
        if ProcessInfo.processInfo.environment["FOUNTAIN_QA"] == "1",
           ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] == "Fountain QA",
           let protocolClass = Self.qaProtocolClass {
            configuration.protocolClasses = [protocolClass]
            #if targetEnvironment(simulator)
            qaSessionOptedIn = true
            #endif
        }
        Self.ownership.unlock()
#endif
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegates = OperationQueue()
        delegates.maxConcurrentOperationCount = 1
        delegates.underlyingQueue = queue
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegates)
        organizationTransport = FountainOrganization(queue: queue, protocolClasses: configuration.protocolClasses, ownership: Self.ownership, admission: { [weak self] in self?.ownsBridge() == true && self?.terminated == false })
        try? organizationTransport?.configure(origin: origin, generation: generation)
        accountTransport = FountainAccount(queue: queue, protocolClasses: configuration.protocolClasses, ownership: Self.ownership, admission: { [weak self] in self?.ownsBridge() == true && self?.terminated == false })
        accountTransport?.onInvalidation = { [weak self] in
            guard let self else { return }
            try self.closeAccountWorkspaces(failure: self.accountTransport?.authorizationLost == true ? .accountRequired : .stale, cancelAccountJobs: false)
        }
        accountTransport?.onWorkspaceDenial = { [weak self] workspace, binding, parent in
            guard let self, self.ownsBridge(), !self.terminated else { throw FountainAccountError.stale }
            if ACTIVE_OUTBOX_ENABLED { try self.outboxStore().denyAccount(workspace: workspace, binding: binding, parentBinding: parent) }
            if let current = self.workspace, current.workspaceId == workspace, current.binding == binding, current.accountBinding == parent { try self.parkSelectedWorkspace() }
        }
        accountTransport?.onWorkspaceObservation = { [weak self] observed in
            guard let self, self.ownsBridge(), !self.terminated else { throw FountainAccountError.stale }
            if ACTIVE_OUTBOX_ENABLED, try self.outboxStore().observeAccountSelection(observed.session, parentBinding: observed.accountBinding) { try self.parkSelectedWorkspace() }
        }
        try? accountTransport?.configure(origin: origin, generation: generation)
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
            self.terminated = true; self.sessionLogout.clear(); self.auth += 1; self.authDrainSuspended += 1
            for job in Array(self.jobs.values) { self.end(job, failure: .stale) }
            self.authQueue.removeAll()
            self.session?.invalidateAndCancel()
            self.organizationTransport?.shutdown()
            self.accountTransport?.shutdown()
            self.recovery?.close(); self.recovery = nil
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
                    if let recoveryError = error as? FountainRecoveryError { call.reject(recoveryError.message, recoveryError.code); return }
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
        var retained: [[String: Any]] = []
        if ACTIVE_OUTBOX_ENABLED, let account = accountTransport, let parent = try? account.activeBinding(), let cookie = try? account.activeCookie(binding: parent) {
            retained = (try? outboxStore().retainedAccountScopes(parentBinding: parent, sessionRef: outboxReference(cookie)!)) ?? []
        }
        return ["origin": origin as Any? ?? NSNull(), "generation": generation,
                "outboxVersion": 1, "outboxEnabled": ACTIVE_OUTBOX_ENABLED, "recoveryVersion": 1, "recoveryEnabled": true,
                "workspaceVersion": 1, "workspaceEpoch": workspaceEpoch, "workspace": lastWorkspace?.publicValue as Any? ?? NSNull(), "retainedWorkspaceScopes": retained]
    }

    // All callers hold ownership and execute on queue; the default transport
    // path never reaches this constructor while the foundation is disabled.
    private func outboxStore() throws -> FountainOutbox {
        guard ACTIVE_OUTBOX_ENABLED, let backend = origin, !storageFailed, !outboxFailed else { throw FountainOutboxError.blocked }
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

    private func currentCookie() throws -> String? {
        if let workspace {
            guard workspace.expiresAt > Date().timeIntervalSince1970 * 1000 else { try closeAccountWorkspaces(); throw FountainFailure.stale }
            return try accountTransport?.activeCookie(binding: workspace.accountBinding)
        }
        return try cookies().active
    }
    private func fenceWorkspace(failure: FountainFailure = .stale, cancelAccountJobs: Bool = true) {
        workspaceEpoch += 1; auth += 1
        if cancelAccountJobs { accountTransport?.fenceWorkspaceJobs() }
        for job in Array(jobs.values) { end(job, failure: failure) }
        recovery?.close(); recovery = nil
        organizationTransport?.fenceWorkspaceJobs()
    }
    private func closeAccountWorkspaces(failure: FountainFailure = .stale, cancelAccountJobs: Bool = true) throws {
        fenceWorkspace(failure: failure, cancelAccountJobs: cancelAccountJobs); workspace = nil; lastWorkspace = nil; workspaceOffline = false
        if ACTIVE_OUTBOX_ENABLED { try FountainWorkspacePolicy.invalidatePersistedAccount(origin: origin) { try self.outboxStore().suspendAccounts() } }
    }
    private func parkSelectedWorkspace() throws {
        fenceWorkspace()
        if ACTIVE_OUTBOX_ENABLED { try outboxStore().parkAccount() }
        workspace = nil; workspaceOffline = false
    }
    private func outboxReference(_ cookie: String?) -> String? {
        cookie.map { FountainOutbox.hash(Data($0.utf8)) }
    }

    private func validatedOutbox() throws -> FountainOutbox {
        let store = try outboxStore()
        if workspace != nil {
            try store.validateSession(outboxReference(try currentCookie()), eligible: !storageFailed, beforeMutation: { self.recovery?.close(); self.recovery = nil })
        } else {
            let value = try cookies()
            let invalidated = try hasInvalidation(origin!)
            try store.validateSession(outboxReference(value.active) ?? "local-no-cookie",
                                      eligible: value.revoke == nil && !invalidated && !storageFailed, beforeMutation: { self.recovery?.close(); self.recovery = nil })
        }
        try store.ensureOwner(outboxOwner, epoch: auth)
        return store
    }

    private func outboxCall(_ call: CAPPluginCall, _ action: @escaping (FountainOutbox) throws -> [String: Any]) {
        #if DEBUG
        Self.qaOutboxRecord(call, "start")
        #endif
        // No SQLite access, migration or auth storage work in the disabled path.
        guard ACTIVE_OUTBOX_ENABLED else { call.reject("Native outbox foundation is disabled", "OUTBOX_DISABLED"); return }
        fromMainFrame(call) {
            do {
                guard try self.integer(call, "generation") == self.generation else { throw FountainOutboxError.stale }
                if self.workspace != nil { guard try self.integer(call, "workspaceEpoch") == self.workspaceEpoch else { throw FountainOutboxError.stale } }
                let store = try self.validatedOutbox()
                if self.recoveryMode {
                    let reference = self.outboxReference(try self.currentCookie()) ?? "local-no-cookie"
                    guard call.methodName != "readPage", let authority = self.recoveryGrant, authority.deadline > Date().timeIntervalSince1970 * 1000,
                          reference == authority.reference, authority.origin == self.origin,
                          self.recoveryGrantAuth == self.auth, self.recoveryGrantGeneration == self.generation,
                          try store.matchesReconciliationAuthority(workspace: authority.workspace, member: authority.member, binding: authority.binding, reference: authority.reference) else { throw FountainOutboxError.access }
                }
                if call.methodName == "stageDelta" || call.methodName == "commitDelta" || call.methodName == "outboxReconcile" {
                    guard self.exportID == nil else { throw FountainOutboxError.stale }
                    // DELETE-journal writers must never wait for this same
                    // process's inventory snapshot. Keep authority/latch; only
                    // old inventory/export capabilities become stale.
                    self.recovery?.close(); self.recovery = nil
                }
                let startingAuth = self.auth, startingOrigin = self.origin, startingGeneration = self.generation
                var result = try action(store)
                #if DEBUG
                Self.qaOutboxRecord(call, "actionDone")
                #endif
                result["generation"] = startingGeneration
                if self.workspace != nil { result["workspaceEpoch"] = self.workspaceEpoch }
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
                #if DEBUG
                Self.qaOutboxRecord(call, "deliveryScheduled")
                #endif
                DispatchQueue.main.async { [weak self] in
                    Self.ownership.lock(); defer { Self.ownership.unlock() }
                    guard let self = self, Self.currentOwner === self, !self.terminated,
                          self.generation == startingGeneration, self.auth == startingAuth,
                          self.origin == startingOrigin, !self.storageFailed, !self.outboxFailed,
                          self.outbox === store, store.boundary == boundary,
                          store.observedProofEpoch == startingProofEpoch,
                          fragmentDeadline == nil || fragmentDeadline! > Date().timeIntervalSince1970 * 1000,
                          let controller = self.bridge?.viewController as? FountainBridgeViewController,
                          controller.bundled(controller.webView?.url), let webView = controller.webView else {
                        #if DEBUG
                        Self.qaOutboxRecord(call, "deliveryFailed")
                        #endif
                        call.reject(FountainFailure.stale.message, FountainFailure.stale.code); return
                    }
                    self.deliverDirect(call, result: deliveryResult, webView: webView)

                }
            } catch let error as FountainOutboxError {
                #if DEBUG
                Self.qaOutboxRecord(call, error.code)
                #endif
                if error == .storage { self.poisonOutbox() }
                call.reject(error.message, error.code)
            } catch {
                #if DEBUG
                Self.qaOutboxRecord(call, "otherError")
                #endif
                throw error
            }
        }
    }

    // Call only at a checked final main-thread boundary under ownership.
    private func deliverDirect(_ call: CAPPluginCall, result: [String: Any], webView: WKWebView) {
        guard let callbackID = call.callbackId, let methodName = call.methodName else { call.reject(FountainFailure.invalid.message, FountainFailure.invalid.code); return }
        let envelope: [String: Any] = ["callbackId": callbackID, "pluginId": "FountainNative", "methodName": methodName, "save": false, "success": true, "data": result]
        guard let bytes = try? JSONSerialization.data(withJSONObject: envelope, options: [.fragmentsAllowed]), let payload = String(data: bytes, encoding: .utf8) else { call.reject(FountainFailure.invalid.message, FountainFailure.invalid.code); return }
        call.keepAlive = false; bridge?.releaseCall(call)
        webView.evaluateJavaScript("window.Capacitor.fromNative(" + payload + ")") { _, error in
            #if DEBUG
            Self.qaOutboxRecord(call, error == nil ? "delivered" : "deliveryFailed")
            #endif
        }
    }

    @objc func outboxOpen(_ call: CAPPluginCall) {
        outboxCall(call) { try $0.open() }
    }
    @objc func outboxReconcile(_ call: CAPPluginCall) {
        outboxCall(call) { store in
            let input = try FountainOutbox.reconciliationBridgePayload(call.options)
            let result = try store.reconcile(input, admissionWatermark: self.httpAdmissionSequence,
                                             sessionRef: self.outboxReference(try self.currentCookie()))
            if self.recoveryMode, input["phase"] as? String == "prepare" {
                self.recoveryMode = false; self.recovery?.close(); self.recovery = nil; self.recoveryGrant = nil; self.recoveryGrantAuth = nil; self.recoveryGrantGeneration = nil
            }
            return result
        }
    }
    @objc func stageDelta(_ call: CAPPluginCall) {
        outboxCall(call) { store in
            guard let lease = call.getString("lease"), let tx = call.getString("txId"),
                  let encoded = call.getString("bytesBase64"), encoded.utf8.count <= 349_528,
                  let bytes = Data(base64Encoded: encoded) else { throw FountainOutboxError.invalid }
            let part = try self.integer(call, "part")
            try store.stage(lease: lease, txID: tx, baseHead: self.integer(call, "baseHead"), proofEpoch: self.integer(call, "proofEpoch"), part: part, bytes: bytes, sessionRef: self.outboxReference(try self.currentCookie()))
            return ["part": part]
        }
    }
    @objc func commitDelta(_ call: CAPPluginCall) {
        outboxCall(call) { store in
            guard let lease = call.getString("lease"), let tx = call.getString("txId"), let digest = call.getString("digest") else { throw FountainOutboxError.invalid }
            return try store.commit(lease: lease, txID: tx, baseHead: self.integer(call, "baseHead"), proofEpoch: self.integer(call, "proofEpoch"), digest: digest, quarantineOnly: self.recoveryMode, sessionRef: self.outboxReference(try self.currentCookie()))
        }
    }
    @objc func readPage(_ call: CAPPluginCall) {
        outboxCall(call) { store in
            guard let lease = call.getString("lease") else { throw FountainOutboxError.invalid }
            return try store.read(lease: lease, head: self.integer(call, "head"), proofEpoch: self.integer(call, "proofEpoch"), cursor: call.getString("cursor"), byteLimit: self.integer(call, "byteLimit"))
        }
    }

    private func observePrivateSession(_ job: FountainJob, response: HTTPURLResponse, data: Data, method: String) throws {
        guard response.statusCode == 200, current(job), let backend = origin, let requestedOrigin = job.requestOrigin else { return }
        let value = try cookies()
        guard value.revoke == nil, let responseURL = response.url else { sessionLogout.clear(); return }
        let fields = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            if let key = entry.key as? String { result[key] = String(describing: entry.value) }
        }
        let returned = HTTPCookie.cookies(withResponseHeaderFields: fields, for: responseURL).filter { $0.name == "fountain_session" }
        guard returned.count <= 1 else { sessionLogout.clear(); return }
        let header: FountainSessionLogout.HeaderCookie
        if let cookie = returned.first {
            header = .value(outboxReference(cookie.value.isEmpty ? nil : "fountain_session=" + cookie.value))
        } else { header = .absent }
        sessionLogout.observeActualSession(origin: backend, requestOrigin: requestedOrigin,
            requestCookieReference: outboxReference(job.sentCookie), currentCookieReference: outboxReference(value.active),
            responseCookie: header, method: method, status: response.statusCode, data: data)
    }
    private func observeOutboxSession(_ job: FountainJob, response: HTTPURLResponse, data: Data) throws {
        guard ACTIVE_OUTBOX_ENABLED else { return }
        let store = try outboxStore()
        if response.statusCode == 401 { try store.suspend(); return }
        guard ["login", "check"].contains(job.mode), response.statusCode == 200 else { return }
        guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            try store.suspend(); return
        }
        let value = try cookies()
        guard value.revoke == nil, !(try hasInvalidation(origin!)) else { try store.suspend(); return }
        if body["authenticated"] as? Bool != true { try store.suspend(); return }
        // Outbox recovery gates do not turn an actual successful session HTTP
        // response into a transport error. outboxOpen exposes the blocked state.
        do {
            try store.grant(body, sessionRef: outboxReference(value.active), beforeMutation: { self.recovery?.close(); self.recovery = nil })
            if recoveryMode {
                recoveryGrant = try FountainRecovery.Authority.session(data, origin: origin!, reference: outboxReference(value.active) ?? "local-no-cookie")
                recoveryGrantAuth = auth; recoveryGrantGeneration = generation
            }
        }
        catch FountainOutboxError.access { return }
        catch FountainOutboxError.blocked { return }
    }

    private func observeOutboxResource(_ job: FountainJob, response: HTTPURLResponse, data: Data) throws {
        guard ACTIVE_OUTBOX_ENABLED, !recoveryMode,
              job.reconcileAdmission != nil || FountainOutbox.observedResource(path: job.logicalPath, method: job.method, status: response.statusCode) != nil else { return }
        guard current(job), try currentCookie() == job.sentCookie else { throw FountainOutboxError.stale }
        let store = try outboxStore()
        guard store.permitsHTTPObservation(job.httpAdmission) else { return }
        try store.observeReconcileResource(admission: job.reconcileAdmission, path: job.logicalPath, method: job.method, status: response.statusCode,
                                                  data: data, sessionRef: outboxReference(job.sentCookie))
    }

    static func validOrigin(_ raw: String) throws -> String {
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

    static func validPath(_ raw: String) throws -> String {
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

    // The renderer supplies only an origin and an already restricted logical API path.
    // Default Supabase routing is native-owned and is shared by JSON and file traffic.
    static func requestURL(origin: String, path: String) throws -> URL {
        let backend = try validOrigin(origin)
        _ = try Self.validPath(path)
        guard let base = URL(string: backend), let host = base.host else { throw FountainFailure.invalid }
        let prefix = base.port == nil && host.range(of: "^[a-z0-9]{20}\\.supabase\\.co$", options: .regularExpression) != nil ? "/functions/v1/fountain-api" : ""
        guard let url = URL(string: backend + prefix + path), url.scheme == "https", url.host == base.host,
              url.port == base.port, url.user == nil, url.password == nil else { throw FountainFailure.invalid }
        return url
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

    private func invalidationState(_ backend: String) throws -> FountainSessionInvalidation.State? {
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        return try FountainSessionInvalidation(directory: directory, name: markerName(backend)).state()
    }

    private func hasInvalidation(_ backend: String) throws -> Bool {
        try invalidationState(backend) != nil
    }

    private func writeInvalidation(_ backend: String) throws {
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        try FountainSessionInvalidation(directory: directory, name: markerName(backend)).writeLegacy()
    }

    private func preparePublicInvalidation(_ intent: FountainSessionLogout.Intent, backend: String) throws {
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        try FountainSessionInvalidation(directory: directory, name: markerName(backend)).preparePublic(intent)
    }

    private func pendingRevokeBody(_ cookie: String?) throws -> Data {
        guard let backend = origin else { throw FountainFailure.stale }
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        return try FountainSessionInvalidation(directory: directory, name: markerName(backend)).pendingBody(cookieRefHash: outboxReference(cookie))
    }

    private func invalidationTransition(_ job: FountainJob, cookies: FountainCookies) throws -> FountainSessionInvalidation.Transition {
        guard let backend = origin else { throw FountainFailure.stale }
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        return try FountainSessionInvalidation(directory: directory, name: markerName(backend)).transition(mode: job.mode, active: cookies.active, revoke: cookies.revoke, cookieReference: outboxReference)
    }

    private func clearInvalidation(_ backend: String) throws {
        let directory = try journalDirectory()
        defer { Darwin.close(directory) }
        try FountainSessionInvalidation(directory: directory, name: markerName(backend)).clear()
    }

    private func cookies() throws -> FountainCookies {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard Self.currentOwner === self else { throw FountainFailure.stale }
        guard !storageFailed, let backend = origin else { throw FountainFailure.storage }
        let invalidated = try invalidationState(backend)
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
        if invalidated != nil {
            let directory = try journalDirectory()
            defer { Darwin.close(directory) }
            let masked = try FountainSessionInvalidation(directory: directory, name: markerName(backend)).restore(active: value.active, revoke: value.revoke, cookieReference: outboxReference)
            return FountainCookies(active: masked.active, revoke: masked.revoke)
        }
        return value
    }

    private func saveCookies(_ value: FountainCookies, allowBestEffortRevoke: Bool = true, actualRollbackBody: Data? = nil) throws {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard Self.currentOwner === self else { throw FountainFailure.stale }
        guard !storageFailed, let backend = origin else { throw FountainFailure.storage }
        sessionLogout.clear()
        var journalReady = false
        if value.active == nil {
            do { try writeInvalidation(backend); journalReady = true }
            catch { /* A confirmed Keychain update/delete remains a durable path. */ }
        }
        do {
            if ACTIVE_OUTBOX_ENABLED, !recoveryMode, value.active == nil { try outboxStore().suspend() }
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
                if ACTIVE_OUTBOX_ENABLED, !recoveryMode, value.active == nil {
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
            if allowBestEffortRevoke { bestEffortRevoke(value.revoke ?? value.active, actualBody: actualRollbackBody) }
            throw failure
        }
    }

    private func bestEffortRevoke(_ cookie: String?, actualBody: Data? = nil) {
        // actualBody is supplied only for a current private POST200 response
        // whose newly returned cookie failed durable adoption. Old context
        // cannot authorize a bodyless rollback of that different cookie.
        guard ownsBridge(), !terminated, let body = actualBody ?? (try? pendingRevokeBody(cookie)),
              let task = try? network(path: "/api/session", method: "DELETE", headers: [:], body: body,
                                      cookie: cookie, timeout: 45, file: nil, done: { _, _, _ in }) else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(45))
        timer.setEventHandler { [weak task] in task?.cancel() }
        transfers[task.taskIdentifier]?.timer = timer
        timer.resume()
    }

    private func authCookies(logoutActor: FountainOutbox.LogoutActor?) throws -> FountainCookies {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard Self.currentOwner === self, let backend = origin else { throw FountainFailure.stale }
        // Fence before reading: even a locked/unavailable Keychain cannot leave
        // an old active cookie eligible for use after a failed logout/relaunch.
        var journalReady = false
        do { try writeInvalidation(backend); journalReady = true }
        catch { /* A confirmed Keychain change/delete can still invalidate it. */ }
        do {
            let value = try cookies()
            if ACTIVE_OUTBOX_ENABLED, !recoveryMode {
                do {
                    let store = try outboxStore()
                    if let actor = logoutActor { try store.eraseActor(actor) }
                    else { try store.suspend() }
                }
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
            let updated = try Self.validOrigin(value)
            if self.origin == updated { call.resolve(self.configuration()); return }
            guard self.authJob == nil, self.authQueue.isEmpty else { throw FountainFailure.busy }
            if self.origin != nil {
                let current = try self.cookies()
                guard current.active == nil, current.revoke == nil else { throw FountainFailure.revoke }
            }
            do { try self.accountTransport?.configure(origin: updated, generation: self.generation + 1); try self.closeAccountWorkspaces(); try self.organizationTransport?.configure(origin: updated, generation: self.generation + 1) }
            catch { throw FountainFailure.storage }
            if ACTIVE_OUTBOX_ENABLED, !self.recoveryMode { try self.outbox?.suspend() }
            self.recovery?.close(); self.recovery = nil
            self.outbox?.close(); self.outbox = nil
            self.sessionLogout.clear(); self.generation += 1; self.auth += 1
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
        if workspace != nil { guard try integer(call, "workspaceEpoch") == workspaceEpoch else { throw FountainFailure.stale } }
        let path = mode == "saveData" || mode.hasPrefix("recovery") ? ((workspace?.prefix ?? "/api") + "/__native-local__") : (call.getString("path") ?? "")
        let decoded = try Self.validPath(path)
        guard decoded != "/api/account", !decoded.hasPrefix("/api/account/"), decoded != "/api/organization", !decoded.hasPrefix(FountainOrganizationPolicy.prefix) else { throw FountainFailure.invalid }
        if decoded == "/api/w" || decoded.hasPrefix("/api/w/") {
            guard let route = FountainWorkspacePolicy.scoped(path), let workspace,
                  route.workspace == workspace.workspaceId, route.binding == workspace.binding,
                  try integer(call, "workspaceEpoch") == workspaceEpoch,
                  workspace.expiresAt > Date().timeIntervalSince1970 * 1000 else { throw FountainFailure.stale }
            let logical = try Self.validPath(route.logical)
            guard logical != "/api/account", !logical.hasPrefix("/api/account/"), logical != "/api/organization", !logical.hasPrefix("/api/organization/"), logical != "/api/w", !logical.hasPrefix("/api/w/") else { throw FountainFailure.invalid }
        } else if workspace != nil, mode != "saveData", !mode.hasPrefix("recovery") { throw FountainFailure.stale }
        let method = mode == "request" ? (call.getString("method") ?? "GET").uppercased() : "GET"
        guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method) else { throw FountainFailure.invalid }
        if FountainWorkspacePolicy.scoped(path)?.logical == "/api/session", method != "GET" { throw FountainFailure.invalid }
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
        let publicLogout = mode == "request" && decoded == "/api/session" && method == "DELETE"
        let limit = publicLogout ? 8192 : mode == "saveData" ? 8 * 1024 * 1024 : 10_000_000
        guard encoded.utf8.count <= ((limit + 2) / 3) * 4,
              let body = Data(base64Encoded: encoded), body.count <= limit else { throw publicLogout ? FountainFailure.sessionInvalid : FountainFailure.tooLarge }
        guard mode != "download" || body.isEmpty else { throw FountainFailure.invalid }
        let timeout: Int
        if call.options["timeoutMs"] == nil { timeout = 45_000 }
        else { timeout = try integer(call, "timeoutMs") }
        guard (1...45_000).contains(timeout) else { throw FountainFailure.invalid }
        let kind = mode == "request" && decoded == "/api/session" ? (method == "POST" ? "login" : method == "DELETE" ? "logout" : method == "GET" ? "check" : mode) : mode
        let job = FountainJob(id: id, call: call, generation: generation, auth: auth, path: path,
                              method: method, headers: headers, body: body, timeout: Double(timeout) / 1000, mode: kind)
        job.requestOrigin = origin
        if publicLogout {
            do {
                job.logoutIntent = try sessionLogout.admit(body: body, origin: origin!, generation: generation, auth: auth) {
                    let value = try self.cookies()
                    guard value.revoke == nil else { throw FountainSessionLogoutError.required }
                    return self.outboxReference(value.active)
                }
            } catch let error as FountainSessionLogoutError { throw FountainFailure.session(error) }
        }
        jobs[id] = job
        if mode == "request" || mode.hasPrefix("recovery") {
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
            if self.recoveryMode, job.method != "GET", !["login", "logout"].contains(job.mode) {
                self.failRecovery(job, FountainRecoveryError.access); return
            }
            if ["login", "logout", "check"].contains(job.mode) {
                self.authQueue.append(job); self.nextAuth()
            } else {
                guard self.authJob == nil else { self.end(job, failure: .busy); return }
                self.send(job)
            }
        }
    }

    @objc func accountRequest(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            do {
                guard let transport = self.accountTransport, let options = call.options as? [String: Any] else { throw FountainAccountError.stale }
                let request = try FountainAccount.Request(options)
                try transport.request(request, workspaceCookie: { nil }, url: Self.requestURL) { result in
                    let fence = transport.deliveryFence()
                    DispatchQueue.main.async {
                        guard fence(), self.ownsBridge(), !self.terminated,
                              let controller = self.bridge?.viewController as? FountainBridgeViewController, controller.bundled(controller.webView?.url) else { call.reject("Account response is stale", "NATIVE_STALE"); return }
                        switch result {
                        case .success(let value): call.resolve(value)
                        case .failure(let error): call.reject("Account request failed", error.code)
                        }
                    }
                }
            } catch { call.reject("Account request failed", (error as? FountainAccountError)?.code ?? "NATIVE_STORAGE") }
        }
    }
    @objc func accountCancel(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            do {
                guard let options = call.options as? [String: Any], Set(options.keys) == Set(["id", "generation"]), let id = call.getString("id") else { throw FountainAccountError.invalid }
                call.resolve(["cancelled": self.accountTransport?.cancel(id: id, generation: try FountainAccountPolicy.integer(options["generation"])) ?? false])
            } catch { call.reject("Account cancellation failed", "NATIVE_INVALID") }
        }
    }
    @objc func parkWorkspace(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            do {
                guard let options = call.options as? [String: Any], Set(options.keys) == Set(["generation", "workspaceEpoch"]),
                      try self.integer(call, "generation") == self.generation, try self.integer(call, "workspaceEpoch") == self.workspaceEpoch else { throw FountainAccountError.stale }
                try self.parkSelectedWorkspace()
                call.resolve(["generation": self.generation, "workspaceEpoch": self.workspaceEpoch, "parked": true])
            } catch { call.reject("Workspace parking failed", (error as? FountainAccountError)?.code ?? "NATIVE_STORAGE") }
        }
    }
    @objc func activateWorkspace(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            do {
                guard let options = call.options as? [String: Any], Set(options.keys).isSubset(of: ["id", "generation", "workspace_id", "session_binding", "account_binding", "timeoutMs"]),
                      let id = call.getString("id"), let workspace = call.getString("workspace_id"), let binding = call.getString("session_binding"), let account = call.getString("account_binding"),
                      FountainAccountPolicy.validWorkspace(workspace), FountainAccountPolicy.validBinding(binding), FountainAccountPolicy.validBinding(account),
                      try self.integer(call, "generation") == self.generation, let transport = self.accountTransport else { throw FountainAccountError.invalid }
                let generation = self.generation
                let request = try FountainAccount.Request(["id": id, "generation": generation, "path": "/api/w/" + workspace + "/" + binding + "/session", "method": "GET", "timeoutMs": options["timeoutMs"] ?? 45000], workspaceVerification: true)
                let cookie = try transport.activeCookie(binding: account)
                try self.parkSelectedWorkspace()
                let epoch = self.workspaceEpoch, evidence = try transport.beginWorkspaceEvidence(workspace)
                try transport.request(request, workspaceCookie: { nil }, workspaceFence: { self.workspaceEpoch == epoch && self.ownsBridge() && !self.terminated }, url: Self.requestURL) { result in
                    do {
                        let value = try result.get()
                        if value["status"] as? Int == 401 { call.reject("Account login is required", "ACCOUNT_AUTH_REQUIRED"); return }
                        guard self.ownsBridge(), !self.terminated, self.workspaceEpoch == epoch, self.generation == generation, transport.currentWorkspaceEvidence(workspace, evidence), try transport.activeCookie(binding: account) == cookie else { throw FountainAccountError.stale }
                        guard value["status"] as? Int == 200, let encoded = value["bodyBase64"] as? String, let data = Data(base64Encoded: encoded) else {
                            if let encoded = value["bodyBase64"] as? String, let deniedBody = Data(base64Encoded: encoded), FountainAccountPolicy.workspaceDenied(status: value["status"] as? Int ?? 0, body: deniedBody), ACTIVE_OUTBOX_ENABLED { try self.outboxStore().denyAccount(workspace: workspace, binding: binding, parentBinding: account) }
                            throw FountainAccountError.stale
                        }
                        let verified = try FountainWorkspacePolicy.verify(data, workspace: workspace, binding: binding, account: account)
                        try transport.acceptWorkspaceEvidence(workspace, evidence)
                        if ACTIVE_OUTBOX_ENABLED {
                            let store = try self.outboxStore()
                            try store.activateAccount(verified.session, sessionRef: self.outboxReference(cookie)!, parentBinding: account)
                            try store.ensureOwner(self.outboxOwner, epoch: self.auth)
                        }
                        try self.workspaceVault.seal(verified, origin: self.origin!, reference: self.outboxReference(cookie)!)
                        self.workspace = verified; self.lastWorkspace = verified; self.workspaceOffline = false
                        let reply: [String: Any] = ["generation": generation, "workspaceEpoch": epoch, "workspace": verified.publicValue]
                        let fence = transport.deliveryFence()
                        DispatchQueue.main.async {
                            guard fence(), self.ownsBridge(), !self.terminated, self.workspaceEpoch == epoch,
                                  let controller = self.bridge?.viewController as? FountainBridgeViewController, controller.bundled(controller.webView?.url) else { call.reject("Workspace activation is stale", "NATIVE_STALE"); return }
                            call.resolve(reply)
                        }
                    } catch { call.reject("Workspace activation failed", (error as? FountainAccountError)?.code ?? "NATIVE_STORAGE") }
                }
            } catch { call.reject("Workspace activation failed", (error as? FountainAccountError)?.code ?? "NATIVE_STORAGE") }
        }
    }

    @objc func resumeWorkspaceOffline(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            do {
                guard let options = call.options as? [String: Any], Set(options.keys) == Set(["generation", "workspace_id", "member_id", "session_binding", "account_binding", "expires_at_ms"]),
                      try self.integer(call, "generation") == self.generation,
                      let id = call.getString("workspace_id"), FountainAccountPolicy.validWorkspace(id),
                      let member = call.getString("member_id"), !member.isEmpty, member.utf8.count <= 1000,
                      let binding = call.getString("session_binding"), FountainAccountPolicy.validBinding(binding),
                      let parent = call.getString("account_binding"), FountainAccountPolicy.validBinding(parent),
                      let origin = self.origin, let transport = self.accountTransport else { throw FountainAccountError.invalid }
                let expires = Double(try self.integer(call, "expires_at_ms")), cookie = try transport.activeCookie(binding: parent)
                let sealed = try self.workspaceVault.open(origin: origin, workspace: id, member: member, binding: binding, account: parent, expires: expires, reference: self.outboxReference(cookie)!)
                try self.parkSelectedWorkspace()
                let store = try self.outboxStore()
                try store.resumeAccountOffline(sealed.session, sessionRef: self.outboxReference(cookie)!, parentBinding: parent)
                try store.ensureOwner(self.outboxOwner, epoch: self.auth)
                self.workspace = sealed; self.lastWorkspace = sealed; self.workspaceOffline = true
                let epoch = self.workspaceEpoch, generation = self.generation, fence = transport.deliveryFence()
                let result: [String: Any] = ["generation": generation, "workspaceEpoch": epoch, "workspace": sealed.publicValue, "offline": true]
                DispatchQueue.main.async {
                    guard fence(), self.ownsBridge(), !self.terminated, self.workspaceEpoch == epoch,
                          let controller = self.bridge?.viewController as? FountainBridgeViewController, controller.bundled(controller.webView?.url) else { call.reject("Offline workspace response is stale", "NATIVE_STALE"); return }
                    call.resolve(result)
                }
            } catch { call.reject("Offline workspace admission failed", (error as? FountainAccountError)?.code ?? "NATIVE_STALE") }
        }
    }

    @objc func organizationRequest(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            do {
                guard let transport = self.organizationTransport else { throw FountainOrganizationError.stale }
                guard let options = call.options as? [String: Any] else { throw FountainOrganizationError.invalid }
                let request = try FountainOrganization.Request(options)
                var explicitWorkspace: (String, String)?
                if FountainOrganizationPolicy.needsWorkspace(path: String(request.path.split(separator: "?", maxSplits: 1)[0]), method: request.method) {
                    let fields: [String: Any]
                    if request.method == "GET" {
                        fields = Dictionary(uniqueKeysWithValues: (URLComponents(string: "https://local.invalid" + request.path)?.queryItems ?? []).map { ($0.name, $0.value as Any) })
                    } else { fields = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:] }
                    if fields["workspace_id"] != nil {
                        guard let id = fields["workspace_id"] as? String, let binding = fields["workspace_binding"] as? String,
                              let current = self.workspace, !self.workspaceOffline, current.workspaceId == id, current.binding == binding else { throw FountainOrganizationError.stale }
                        explicitWorkspace = (id, binding)
                    }
                }
                let capturedEpoch = self.workspaceEpoch
                let crossFence: (() -> Bool)? = explicitWorkspace == nil ? nil : { self.workspaceEpoch == capturedEpoch }
                try transport.request(request, workspaceCookie: {
                    if explicitWorkspace != nil { return try self.currentCookie() }
                    // Read-only, exact cross-realm routes are selected inside
                    // the independent transport. Never grant Outbox admission.
                    let value = try self.cookies()
                    guard value.revoke == nil else { return nil }
                    return value.active
                }, workspaceFence: crossFence, url: Self.requestURL) { result in
                    let fence = transport.deliveryFence()
                    DispatchQueue.main.async {
                        guard fence(), self.ownsBridge(), !self.terminated, explicitWorkspace == nil || self.workspaceEpoch == capturedEpoch,
                              let controller = self.bridge?.viewController as? FountainBridgeViewController,
                              controller.bundled(controller.webView?.url) else {
                            call.reject("Organization response is stale", "NATIVE_STALE"); return
                        }
                        switch result {
                        case .success(let value): call.resolve(value)
                        case .failure(let failure): call.reject("Organization request failed", failure.code)
                        }
                    }
                }
            } catch {
                call.reject("Organization request failed", (error as? FountainOrganizationError)?.code ?? "NATIVE_STORAGE")
            }
        }
    }

    @objc func organizationCancel(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            do {
                guard let options = call.options as? [String: Any], Set(options.keys).isSubset(of: ["id", "generation"]), let id = call.getString("id") else { throw FountainOrganizationError.invalid }
                let generation = try FountainOrganizationPolicy.integer(call.options["generation"])
                call.resolve(["cancelled": self.organizationTransport?.cancel(id: id, generation: generation) ?? false])
            } catch { call.reject("Organization cancellation failed", "NATIVE_INVALID") }
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

    private func qualifyPublicLogout(_ job: FountainJob) throws {
        guard let backend = origin, let intent = job.logoutIntent else { throw FountainFailure.sessionRequired }
        var selected: FountainCookies?
        try sessionLogout.recheck(intent, origin: backend, generation: generation, auth: auth) {
            let value = try self.cookies()
            guard value.revoke == nil else { throw FountainSessionLogoutError.conflict }
            selected = value
            return self.outboxReference(value.active)
        }
        guard let selected else { throw FountainFailure.sessionRequired }
        // The durable negative context must exist before auth/cancellation,
        // Vault, Recovery or Outbox effects. Failure leaves them untouched.
        try preparePublicInvalidation(intent, backend: backend)
        job.logoutCookie = selected.active; job.logoutOrigin = backend; job.logoutActor = nil
        if ACTIVE_OUTBOX_ENABLED, !recoveryMode {
            job.logoutActor = try outboxStore().actorForLogout(reference: outboxReference(selected.active) ?? "local-no-cookie")
        }
    }
    private func clearPublicLogoutPending(_ job: FountainJob, rejected: Bool) throws {
        guard current(job), origin == job.logoutOrigin else { throw FountainFailure.stale }
        let value = try cookies()
        guard let intent = job.logoutIntent, sessionLogout.ownsPending(intent, origin: origin!, activeCookieReference: outboxReference(value.active), pendingCookieReference: outboxReference(value.revoke)) else { throw FountainFailure.stale }
        // A server409 disqualifies this explicit binding. It must never become
        // an unconditional later bodyless retry, including storage-error paths.
        try saveCookies(FountainCookies(), allowBestEffortRevoke: !rejected)
    }
    private func nextAuth() {
        Self.ownership.lock(); defer { Self.ownership.unlock() }
        guard authJob == nil, authDrainSuspended == 0 else { return }
        while !authQueue.isEmpty {
            let job = authQueue.removeFirst()
            guard jobs[job.id] === job else { continue }
            if job.mode == "logout" {
                do { try qualifyPublicLogout(job) }
                catch {
                    let failure = (error as? FountainSessionLogoutError).map(FountainFailure.session) ?? (error as? FountainFailure) ?? .storage
                    authDrainSuspended += 1; end(job, failure: failure); authDrainSuspended -= 1
                    continue
                }
            }
            authJob = job
            do {
                if job.mode != "check" {
                    sessionLogout.clear()
                    recovery?.close(); recovery = nil
                    auth += 1
                    for other in Array(jobs.values) where other !== job && !authQueue.contains(where: { $0 === other }) {
                        end(other, failure: .stale)
                    }
                }
                job.auth = auth
                var value: FountainCookies
                if job.mode == "check" { value = try cookies() }
                else { value = try authCookies(logoutActor: job.mode == "logout" ? job.logoutActor : nil) }
                if job.mode != "check", let active = value.active { value.active = nil; value.revoke = active }
                let transition = try invalidationTransition(job, cookies: value)
                if transition.blockCheck { throw FountainFailure.revoke }
                if job.mode != "check" {
                    // An explicitly submitted login may use confirmed empty
                    // credentials, retaining context until its actual POST200
                    // cookie is durable. Unknown GET never consumes context.
                    if !transition.preserveEmptyContext { try saveCookies(value) }
                }
                if job.mode == "logout" || transition.pending != nil {
                    let old = job.mode == "logout" ? job.logoutCookie : transition.pending?.cookie
                    let revokeBody = job.mode == "logout" ? job.body : transition.pending!.body
                    job.revoking = true
                    job.task = try network(path: job.mode == "logout" ? job.path : "/api/session", method: "DELETE", headers: job.mode == "logout" ? job.headers : [:], body: revokeBody, cookie: old,
                                           timeout: job.timeout, file: nil) { response, data, error in
                        job.revoking = false
                        guard self.current(job) else { return }
                        guard error == nil, let response = response else { self.end(job, failure: .revoke); return }
                        if job.mode == "logout", response.statusCode == 409 {
                            do { try self.clearPublicLogoutPending(job, rejected: true); self.resolve(job, response: response, data: data) }
                            catch { self.end(job, failure: error as? FountainFailure ?? .storage) }
                            return
                        }
                        guard (200..<300).contains(response.statusCode) || response.statusCode == 401 else { self.end(job, failure: .revoke); return }
                        do {
                            if job.mode == "logout" { try self.clearPublicLogoutPending(job, rejected: false) }
                            else { try self.saveCookies(FountainCookies()) }
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
            job.sentCookie = try currentCookie()
            let recoveryObservation = try recoveryObservation(job, path: job.logicalPath, method: job.method)
            job.task = try network(path: job.path, method: job.method, headers: job.headers, body: job.body,
                                   cookie: job.sentCookie, timeout: job.timeout, file: job.mode == "download" ? job.file : nil,
                                   admitted: { job.reconcileAdmission = $0; job.syncAdmission = $1; job.httpAdmission = $2; job.deliveryAdmission = $2 }, sessionEvidence: { job.workspaceEvidence = $0 }) { response, data, error in
                guard self.current(job) else { return }
                guard error == nil, let response = response else { self.outbox?.failedReconcile(job.reconcileAdmission); self.end(job, failure: error ?? .network); return }
                do {
                    if response.statusCode != 401, let admission = job.httpAdmission {
                        guard let store = self.outbox else { throw FountainOutboxError.stale }
                        try store.checkHTTPAdmission(admission, sessionRef: self.outboxReference(try self.currentCookie()))
                    }
                    if response.statusCode == 401 { self.recovery?.close(); self.recovery = nil }
                    if job.mode == "login", (200..<300).contains(response.statusCode) {
                        let fields = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
                            if let key = entry.key as? String { result[key] = String(describing: entry.value) }
                        }
                        guard let responseURL = response.url else { throw FountainFailure.invalid }
                        let found = HTTPCookie.cookies(withResponseHeaderFields: fields, for: responseURL).filter { $0.name == "fountain_session" }
                        guard found.count == 1, found[0].path == "/", !found[0].value.isEmpty,
                              found[0].value.utf8.count <= 4096,
                              !found[0].value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value >= 127 || $0.value == 59 }) else { throw FountainFailure.invalid }
                        let rollbackBody = try FountainSessionLogout.actualResponseBody(data)
                        try self.saveCookies(FountainCookies(active: "fountain_session=" + found[0].value, revoke: nil), actualRollbackBody: rollbackBody)
                    } else if response.statusCode == 401, FountainWorkspacePolicy.scoped(job.path) != nil {
                        try self.accountTransport?.invalidate(authRequired: true)
                        self.end(job, failure: .stale); return
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
                    if let route = FountainWorkspacePolicy.scoped(job.path), route.logical == "/api/session", let current = self.workspace {
                        if response.statusCode == 200 {
                            guard let evidence = job.workspaceEvidence, self.accountTransport?.currentWorkspaceEvidence(current.workspaceId, evidence) == true else { throw FountainFailure.stale }
                            let verified = try FountainWorkspacePolicy.verify(data, workspace: current.workspaceId, binding: current.binding, account: current.accountBinding)
                            try self.accountTransport?.acceptWorkspaceEvidence(current.workspaceId, evidence)
                            if ACTIVE_OUTBOX_ENABLED {
                                let store = try self.outboxStore()
                                try store.activateAccount(verified.session, sessionRef: self.outboxReference(job.sentCookie)!, parentBinding: current.accountBinding, requireReconcile: false)
                                try store.ensureOwner(self.outboxOwner, epoch: self.auth)
                            }
                            try self.workspaceVault.seal(verified, origin: self.origin!, reference: self.outboxReference(job.sentCookie)!)
                            self.workspace = verified; self.lastWorkspace = verified
                        } else if FountainAccountPolicy.workspaceDenied(status: response.statusCode, body: data) {
                            if ACTIVE_OUTBOX_ENABLED { try self.outboxStore().denyAccount(workspace: current.workspaceId, binding: current.binding, parentBinding: current.accountBinding) }
                        }
                    }
                    if self.recoveryMode, ["check", "login"].contains(job.mode), let reader = self.recovery,
                       !reader.sameSession(data, origin: self.origin ?? "", reference: self.outboxReference(try self.currentCookie()) ?? "local-no-cookie") {
                        reader.close(); self.recovery = nil
                    }
                    if let (store, admission, authority) = recoveryObservation {
                        try self.noteRecoveryServerObservation(store, admission: admission, authority: authority, job: job, path: job.path, status: response.statusCode, data: data)
                    }
                    if self.recoveryMode, job.method == "GET", self.recovery?.observes(job.logicalPath) == true {
                        self.recovery?.noteCanonical(path: job.logicalPath, status: response.statusCode, data: data)
                    }
                    if ["check", "login"].contains(job.mode) {
                        try self.observePrivateSession(job, response: response, data: data, method: job.method)
                    }
                    try self.observeOutboxSession(job, response: response, data: data)
                    if ACTIVE_OUTBOX_ENABLED, job.path == "/api/session", response.statusCode == 200 {
                        let store = try self.outboxStore(); try store.ensureOwner(self.outboxOwner, epoch: self.auth)
                        job.deliveryAdmission = try store.captureHTTPDelivery(sessionRef: self.outboxReference(try self.currentCookie()), allowBlockedMetadata: true)
                    }
                    if response.statusCode != 401 { try self.observeOutboxResource(job, response: response, data: data) }
                    if ACTIVE_OUTBOX_ENABLED, !self.recoveryMode, job.syncAdmission != nil {
                        guard try self.currentCookie() == job.sentCookie else { throw FountainOutboxError.stale }
                        try self.outboxStore().observeSync(job.syncAdmission, status: response.statusCode, data: data, sessionRef: self.outboxReference(job.sentCookie))
                    }
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

#if DEBUG
    // Not a Capacitor method. A fresh QA-only instance avoids load()/currentOwner,
    // configuration, Keychain, cookies, generations and all outbox/session state.
    func probeAnonymousCloudRoute(origin: String, done: @escaping ([String: Any]?, Error?) -> Void) throws {
        guard ProcessInfo.processInfo.environment["FOUNTAIN_QA"] == "1",
              (ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"),
              origin == "https://ehnovtfadpkwtubmwltl.supabase.co", self.origin == nil, session == nil else { throw FountainFailure.invalid }
        self.origin = try Self.validOrigin(origin)
        initializeSession()
        _ = try network(path: "/api/session", method: "GET", headers: [:], body: Data(), cookie: nil,
                        timeout: 45, file: nil, maximum: 65536) { [self] response, data, error in
            session.invalidateAndCancel()
            guard error == nil, let response = response else { done(nil, error ?? FountainFailure.network); return }
            done(["status": response.statusCode, "headers": renderedHeaders(response), "bodyBase64": data.base64EncodedString()], nil)
        }
    }
#endif

    private func network(path: String, method: String, headers: [String: String], body: Data, cookie: String?,
                         timeout: TimeInterval, file: URL?, maximum: Int64 = 16 * 1024 * 1024,
                         admitted: ((FountainOutbox.ReconcileAdmission?, FountainOutbox.SyncAdmission?, FountainOutbox.HTTPAdmission?) -> Void)? = nil,
                         sessionEvidence: ((Int) -> Void)? = nil,
                         done: @escaping (HTTPURLResponse?, Data, FountainFailure?) -> Void) throws -> URLSessionDataTask {
        guard let backend = origin else { throw FountainFailure.invalid }
        if workspaceOffline, FountainWorkspacePolicy.scoped(path) != nil { throw FountainFailure.network }
        if FountainWorkspacePolicy.scoped(path) != nil, method != "GET", ACTIVE_OUTBOX_ENABLED, !(try outboxStore().accountCanTransmit()) { throw FountainOutboxError.access }
        #if DEBUG && targetEnvironment(simulator)
        let environment = ProcessInfo.processInfo.environment
        if environment["FOUNTAIN_QA"] == "1", (environment["FOUNTAIN_OUTBOX_QA"] == "1" || environment["FOUNTAIN_DEFAULT_OUTBOX_QA"] == "1"), (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), !qaSessionOptedIn { Self.qaPreinstallBlocked += 1; throw FountainFailure.network }
        #endif
        let url = try Self.requestURL(origin: backend, path: path)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method; request.httpBody = body.isEmpty ? nil : body
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("1", forHTTPHeaderField: "X-Fountain-Request")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let cookie = cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        guard httpAdmissionSequence < 9_007_199_254_740_991 else { throw FountainOutboxError.storage }
        httpAdmissionSequence += 1
        let nativeStore = ACTIVE_OUTBOX_ENABLED && !recoveryMode ? try outboxStore() : nil
        let logicalPath = FountainWorkspacePolicy.scoped(path)?.logical ?? path
        let http = ACTIVE_OUTBOX_ENABLED && !recoveryMode ? try nativeStore?.admitHTTP(path: logicalPath, sessionRef: outboxReference(cookie)) : nil
        let tag = ACTIVE_OUTBOX_ENABLED && !recoveryMode ? try outbox?.admitReconcile(path: logicalPath, method: method, sessionRef: outboxReference(cookie), sequence: httpAdmissionSequence) : nil
        let sync = ACTIVE_OUTBOX_ENABLED && !recoveryMode ? try outbox?.admitSync(path: logicalPath, method: method, body: body, sessionRef: outboxReference(cookie)) : nil
        admitted?(tag, sync, http)
        #if DEBUG && targetEnvironment(simulator)
        if environment["FOUNTAIN_QA"] == "1", (environment["FOUNTAIN_OUTBOX_QA"] == "1" || environment["FOUNTAIN_DEFAULT_OUTBOX_QA"] == "1"), (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), !qaSessionOptedIn { Self.qaPreinstallAllocated += 1 }
        #endif
        let sink = try file.map { try FileHandle(forWritingTo: $0) }
        let transfer = FountainTransfer(streamed: file != nil, sink: sink, done: done)
        transfer.maximum = maximum
        transfer.scopedAccount = FountainWorkspacePolicy.scoped(path) != nil
        transfer.sentCookie = cookie
        transfer.authorityOrigin = backend; transfer.authorityGeneration = generation
        transfer.authorityAuth = auth; transfer.authorityWorkspaceEpoch = workspaceEpoch
        if transfer.scopedAccount, let workspace, let accountTransport {
            guard try accountTransport.activeCookie(binding: workspace.accountBinding) == cookie else { throw FountainFailure.stale }
            transfer.accountParent = workspace.accountBinding; transfer.accountEpoch = accountTransport.privateEpoch
        }
        if let route = FountainWorkspacePolicy.scoped(path), route.logical == "/api/session", method == "GET", let workspace, let accountTransport {
            guard route.workspace == workspace.workspaceId, route.binding == workspace.binding else { throw FountainFailure.stale }
            let version = try accountTransport.beginWorkspaceEvidence(route.workspace)
            transfer.sessionEvidence = (route.workspace, route.binding, workspace.accountBinding, version)
            sessionEvidence?(version)
        }
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
        if !transfer.streamed && transfer.expected > transfer.maximum { transfer.error = .tooLarge }
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
                guard transfer.received <= transfer.maximum else { throw FountainFailure.tooLarge }
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
        if transfer.scopedAccount {
            let validParent: Bool
            if ownsBridge(), !terminated, transfer.authorityOrigin == origin, transfer.authorityGeneration == generation,
               transfer.authorityAuth == auth, transfer.authorityWorkspaceEpoch == workspaceEpoch,
               let parent = transfer.accountParent, let epoch = transfer.accountEpoch, let accountTransport, accountTransport.privateEpoch == epoch {
                validParent = (try? accountTransport.activeCookie(binding: parent)) == transfer.sentCookie
            } else { validParent = false }
            if !validParent { transfer.done(transfer.response, transfer.data, .stale); return }
            // A trusted matching-parent401 header is negative authority even
            // when a binary stream/body contract cancels the remaining bytes.
            if transfer.response?.statusCode == 401 { try? accountTransport?.invalidate(authRequired: true) }
        }
        if transfer.error == nil, networkFailure == nil, let evidence = transfer.sessionEvidence, let response = transfer.response, let accountTransport {
            do {
                guard try accountTransport.activeCookie(binding: evidence.parent) == transfer.sentCookie else { throw FountainFailure.stale }
                if response.statusCode == 200 {
                    guard accountTransport.currentWorkspaceEvidence(evidence.workspace, evidence.version) else { throw FountainFailure.stale }
                    let observed = try FountainWorkspacePolicy.verify(transfer.data, workspace: evidence.workspace, binding: evidence.binding, account: evidence.parent)
                    try accountTransport.acceptWorkspaceEvidence(evidence.workspace, evidence.version)
                    if ACTIVE_OUTBOX_ENABLED, try outboxStore().observeAccountSelection(observed.session, parentBinding: evidence.parent) { try parkSelectedWorkspace() }
                } else if FountainAccountPolicy.workspaceDenied(status: response.statusCode, body: transfer.data), ACTIVE_OUTBOX_ENABLED {
                    try outboxStore().denyAccount(workspace: evidence.workspace, binding: evidence.binding, parentBinding: evidence.parent)
                    if let current = workspace, current.workspaceId == evidence.workspace, current.binding == evidence.binding, current.accountBinding == evidence.parent { try parkSelectedWorkspace() }
                }
            } catch { transfer.error = .stale }
        }
        transfer.done(transfer.response, transfer.data, transfer.error ?? networkFailure)
    }

    private func renderedHeaders(_ response: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (name, value) in response.allHeaderFields {
            if let name = name as? String, safeHeaders.contains(name.lowercased()) { headers[name] = String(describing: value) }
        }
        return headers
    }

    private func resolve(_ job: FountainJob, response: HTTPURLResponse, data: Data) {
        let headers = renderedHeaders(response)
        var result: [String: Any] = ["status": response.statusCode, "headers": headers, "bodyBase64": data.base64EncodedString(), "generation": job.generation]
        if FountainWorkspacePolicy.scoped(job.path) != nil { result["workspaceEpoch"] = workspaceEpoch }
        end(job, result: result)
    }

    private func end(_ job: FountainJob, result: [String: Any]? = nil, failure: FountainFailure? = nil) {
        guard jobs[job.id] === job else { return }
        jobs.removeValue(forKey: job.id)
        job.timer?.cancel(); job.timer = nil
        job.task?.cancel()
        if job.mode.hasPrefix("recovery"), failure != nil { recoveryReaders[job.id]?.cancelPrepared() }
        recoveryReaders.removeValue(forKey: job.id)
        let recoveryURLs = recoveryFiles.removeValue(forKey: job.id) ?? []
        for file in recoveryURLs { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        recoverySaveTokens.removeValue(forKey: job.id); recoverySaveAuthority.removeValue(forKey: job.id)
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
            else if job.generation == generation && job.auth == auth, var result = result {
                if FountainWorkspacePolicy.scoped(job.path) != nil { result["workspaceEpoch"] = workspaceEpoch }
                let capturedOrigin = origin, capturedAuth = auth, capturedGeneration = generation, store = outbox, admission = job.deliveryAdmission
                let deliveryFence: FountainOutbox.HTTPDeliveryFence?
                do {
                    if let admission { guard let store else { throw FountainOutboxError.stale }; deliveryFence = try store.captureHTTPFence(admission, path: job.logicalPath, method: job.method, status: (result["status"] as? Int) ?? 0) }
                    else { deliveryFence = nil }
                } catch { job.call.reject(FountainFailure.stale.message, FountainFailure.stale.code); if authJob === job { authJob = nil }; nextAuth(); return }
                DispatchQueue.main.async { [weak self] in
                    Self.ownership.lock(); defer { Self.ownership.unlock() }
                    guard let self, Self.currentOwner === self, !self.terminated, !self.storageFailed,
                          self.origin == capturedOrigin, self.auth == capturedAuth, self.generation == capturedGeneration,
                          let controller = self.bridge?.viewController as? FountainBridgeViewController, controller.bundled(controller.webView?.url), let webView = controller.webView else {
                        job.call.reject(FountainFailure.stale.message, FountainFailure.stale.code); return
                    }
                    if let deliveryFence {
                        guard let store, self.outbox === store, !self.outboxFailed, store.canDeliverHTTP(deliveryFence) else {
                            job.call.reject(FountainFailure.stale.message, FountainFailure.stale.code); return
                        }
                    }
                    self.deliverDirect(job.call, result: result, webView: webView)
                }
            }
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
            _ = try Self.validPath(path)
            let logical = FountainWorkspacePolicy.scoped(path)?.logical ?? path
            let decoded = try Self.validPath(logical)
            let pieces = decoded.split(separator: "/")
            let backupID = try FountainBackupPlan.id(logical)
            guard backupID != nil || (!logical.contains("?") && (decoded == "/api/backup" ||
                    (pieces.count == 4 && pieces[0] == "api" && pieces[1] == "attachments" && pieces[3] == "download"))) else { throw FountainFailure.invalid }
            let job = try self.newJob(call, mode: "download")
            do {
                job.file = try self.temporary(name)
                if let id = backupID { job.sentCookie = try self.currentCookie(); self.startBackup(job, id: id) }
                else { self.send(job) }
            }
            catch { self.end(job, failure: .storage) }
        }
    }

    private func backupOwner(_ job: FountainJob, done: @escaping () -> Void) {
        do {
            guard current(job), let cookie = job.sentCookie, try currentCookie() == cookie, let backend = origin else { throw FountainFailure.stale }
            job.task = try network(path: job.wire("/api/session"), method: "GET", headers: [:], body: Data(), cookie: cookie, timeout: job.timeout, file: nil, maximum: 65536) { response, data, error in
                guard self.current(job) else { return }
                do {
                    guard error == nil, response?.statusCode == 200, try self.currentCookie() == cookie,
                          let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let member = body["member"] as? [String: Any], member["role"] as? String == "owner" else { throw error ?? FountainFailure.stale }
                    let proof = try FountainRecovery.Authority.session(data, origin: backend, reference: cookie)
                    if let previous = job.backupAuthority { guard previous.matches(proof) else { throw FountainFailure.stale } }
                    job.backupAuthority = proof; done()
                } catch { self.end(job, failure: error as? FountainFailure ?? .stale) }
            }
        } catch { end(job, failure: error as? FountainFailure ?? .stale) }
    }

    private func startBackup(_ job: FountainJob, id: String) {
        backupOwner(job) {
            do {
                job.task = try self.network(path: job.wire("/api/backup/jobs/" + id), method: "GET", headers: [:], body: Data(), cookie: job.sentCookie, timeout: job.timeout, file: nil, maximum: 65536) { response, data, error in
                    guard self.current(job) else { return }
                    do {
                        guard error == nil, response?.statusCode == 200 else { throw error ?? FountainFailure.network }
                        job.backupPlan = try FountainBackupPlan(data, id: id)
                        self.backupPiece(job, id: id)
                    } catch { self.end(job, failure: error as? FountainFailure ?? .invalid) }
                }
            } catch { self.end(job, failure: error as? FountainFailure ?? .network) }
        }
    }

    private func backupPiece(_ job: FountainJob, id: String) {
        guard current(job), let plan = job.backupPlan, let file = job.file else { end(job, failure: .stale); return }
        backupOwner(job) {
            do {
                guard plan.expires > Date() else { throw FountainFailure.stale }
                if job.backupOffset == plan.size {
                    let digest = job.backupHash.finalize().map { String(format: "%02x", $0) }.joined()
                    let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value
                    guard digest == plan.sha, size == plan.size else { throw FountainFailure.incomplete }
                    self.export(job); return
                }
                let offset = job.backupOffset, length = Int(min(262144, plan.size - offset))
                job.task = try self.network(path: job.wire("/api/backup?job_id=" + id), method: "GET", headers: ["Range": "bytes=\(offset)-\(offset + Int64(length) - 1)"], body: Data(), cookie: job.sentCookie, timeout: job.timeout, file: nil, maximum: Int64(length)) { response, data, error in
                    guard self.current(job) else { return }
                    do {
                        guard error == nil, let response = response, try self.currentCookie() == job.sentCookie else { throw error ?? FountainFailure.stale }
                        try plan.piece(response, offset: offset, length: length, received: data.count)
                        let sink = try FileHandle(forWritingTo: file); defer { try? sink.close() }
                        try sink.seekToEnd(); try sink.write(contentsOf: data); try sink.synchronize()
                        job.backupHash.update(data: data); job.backupOffset += Int64(data.count)
                        self.backupPiece(job, id: id)
                    } catch { self.end(job, failure: error as? FountainFailure ?? .storage) }
                }
            } catch { self.end(job, failure: error as? FountainFailure ?? .storage) }
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

    // These explicit APIs use a separate in-memory authority and read-only SQL.
    // Arming remains latched after close; there is no automatic outbox resume.
    @objc func recoveryInventory(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            self.recoveryMode = true
            guard self.authJob == nil, self.exportID == nil else { throw FountainFailure.busy }
            let job = try self.newJob(call, mode: "recoveryInventory")
            for other in Array(self.jobs.values) where other !== job && other.mode.hasPrefix("recovery") { self.end(other, failure: .stale) }
            if call.getString("cursor") == nil { self.recovery?.close(); self.recovery = nil }
            self.recoverySession(job) { authority in
                if call.getString("cursor") == nil { self.recovery?.close(); self.recovery = try FountainRecovery(authority: authority) }
                guard let reader = self.recovery else { throw FountainRecoveryError.stale }
                self.recoveryReaders[job.id] = reader
                var result = try reader.inventory(authority, cursor: call.getString("cursor"), count: self.integer(call, "limit"))
                result["generation"] = job.generation
                self.resolveRecovery(job, result: result, reader: reader, authority: authority)
            }
        }
    }
    @objc func recoveryExport(_ call: CAPPluginCall) {
        fromMainFrame(call) {
            self.recoveryMode = true
            guard try self.integer(call, "generation") == self.generation, let reader = self.recovery,
                  call.getString("inventoryToken") == reader.token else { throw FountainRecoveryError.stale }
            let phase = call.getString("phase") ?? ""
            if phase == "cancel" {
                let matched: Bool
                if let token = call.getString("exportToken") { matched = reader.cancelToken(token) }
                else { reader.close(); self.recovery = nil; matched = true }
                if matched { for job in Array(self.jobs.values) where self.recoveryReaders[job.id] === reader { self.end(job, failure: .cancelled) } }
                call.resolve(["generation": self.generation, "cancelled": true]); return
            }
            guard ["prepare", "save"].contains(phase), let handles = call.options["handles"] as? [String],
                  !handles.isEmpty, handles.count <= 100, self.authJob == nil, self.exportID == nil else { throw FountainRecoveryError.stale }
            let job = try self.newJob(call, mode: "recoveryExport")
            for other in Array(self.jobs.values) where other !== job && other.mode.hasPrefix("recovery") { self.end(other, failure: .stale) }
            self.recoveryReaders[job.id] = reader
            self.recoverySession(job) { authority in
                guard self.recovery === reader else { throw FountainRecoveryError.stale }
                let paths: [String]
                if phase == "save" {
                    guard let token = call.getString("exportToken") else { throw FountainRecoveryError.stale }
                    paths = try reader.preparedPaths(token, handles: handles, other: authority)
                } else { paths = try reader.authorityPaths(handles, authority) }
                self.recoveryResources(job, paths: paths) { responses in
                    if phase == "save" {
                        let token = call.getString("exportToken")!
                        let files = try reader.saveFiles(token, handles: handles, other: authority, responses: responses)
                        guard !files.isEmpty else { throw FountainRecoveryError.access }
                        self.recoveryFiles[job.id] = files; self.recoverySaveTokens[job.id] = token; self.recoverySaveAuthority[job.id] = authority
                        job.file = files.first; self.export(job)
                    } else {
                        let additional = try reader.additionalPaths(handles, authority, responses: responses)
                        self.recoveryResources(job, paths: additional, initial: responses) { complete in
                            var result = try reader.prepare(handles, other: authority, responses: complete, observedAt: job.startedAt, makeFile: self.temporary)
                            result["generation"] = job.generation
                            self.resolveRecovery(job, result: result, reader: reader, authority: authority)
                        }
                    }
                }
            }
        }
    }
    private func recoverySession(_ job: FountainJob, _ completion: @escaping (FountainRecovery.Authority) throws -> Void) {
        do {
            guard current(job), let backend = origin else { throw FountainRecoveryError.stale }
            if workspace != nil { job.sentCookie = try currentCookie() }
            else {
                let cookies = try self.cookies()
                guard cookies.revoke == nil, !(try hasInvalidation(backend)) else { throw FountainRecoveryError.auth }
                job.sentCookie = cookies.active
            }
            job.task = try network(path: job.wire("/api/session"), method: "GET", headers: [:], body: Data(), cookie: job.sentCookie, timeout: job.timeout, file: nil) { response, data, error in
                guard self.current(job) else { return }
                do {
                    if response?.statusCode == 401 { try self.recoveryUnauthorized(job) }
                    guard error == nil, let response = response, response.statusCode == 200 else { throw FountainRecoveryError.auth }
                    guard try self.currentCookie() == job.sentCookie else { throw FountainRecoveryError.stale }
                    if FountainWorkspacePolicy.scoped(job.path) == nil { try self.observePrivateSession(job, response: response, data: data, method: "GET") }
                    let authority = try FountainRecovery.Authority.session(data, origin: backend, reference: self.outboxReference(job.sentCookie) ?? "local-no-cookie")
                    // This explicit Recovery session remains authoritative even
                    // when a permanently suspended Outbox grant cannot mutate.
                    // Fence queued old-role metadata and shorten reader expiry.
                    if let reader = self.recovery, !reader.sameSession(data, origin: backend, reference: authority.reference) {
                        reader.close(); self.recovery = nil
                    }
                    if ACTIVE_OUTBOX_ENABLED {
                        self.recoveryGrant = authority
                        self.recoveryGrantAuth = self.auth; self.recoveryGrantGeneration = self.generation
                        do {
                            guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw FountainRecoveryError.auth }
                            try self.outboxStore().grant(body, sessionRef: self.outboxReference(job.sentCookie), beforeMutation: { self.recovery?.close(); self.recovery = nil })
                            // Prime private owner/lease/handle metadata before
                            // completion opens the read-only inventory snapshot.
                            _ = try self.validatedOutbox().open()
                        } catch let error as FountainOutboxError { if error == .storage { self.poisonOutbox() } }
                    }
                    try completion(authority)
                } catch { self.failRecovery(job, error) }
            }
        } catch { failRecovery(job, error) }
    }
    private func recoveryObservation(_ job: FountainJob, path: String, method: String) throws -> (FountainOutbox, FountainOutbox.RecoveryObservation, FountainRecovery.Authority)? {
        guard ACTIVE_OUTBOX_ENABLED, recoveryMode, method == "GET",
              let resource = FountainOutbox.canonicalResource(path: path, method: method), ["workspace", "page"].contains(resource.0) else { return nil }
        guard current(job), let authority = recoveryGrant, authority.origin == origin,
              recoveryGrantAuth == auth, recoveryGrantGeneration == generation,
              authority.reference == (outboxReference(job.sentCookie) ?? "local-no-cookie"),
              try currentCookie() == job.sentCookie else { throw FountainRecoveryError.stale }
        let store = try outboxStore()
        return (store, try store.admitRecoveryObservation(authority, sessionRef: outboxReference(job.sentCookie)), authority)
    }
    private func noteRecoveryServerObservation(_ store: FountainOutbox, admission: FountainOutbox.RecoveryObservation, authority: FountainRecovery.Authority, job: FountainJob, path: String, status: Int, data: Data) throws {
        guard current(job), outbox === store, try currentCookie() == job.sentCookie,
              recoveryGrantAuth == auth, recoveryGrantGeneration == generation,
              let currentAuthority = recoveryGrant, currentAuthority.matches(authority),
              min(currentAuthority.deadline, authority.deadline) > Date().timeIntervalSince1970 * 1000 else { throw FountainRecoveryError.stale }
        do {
            let changed = try store.observeRecoveryServerPage(admission: admission, path: path, status: status, data: data, sessionRef: outboxReference(job.sentCookie)) {
                self.recovery?.close(); self.recovery = nil
            }
            // A first permanent restriction changes inventory's source/meaning.
            // Keep Recovery authority/latch and ask its existing stale/reload UI.
            if changed { throw FountainRecoveryError.stale }
        } catch let error as FountainOutboxError {
            if error == .storage { poisonOutbox(); throw FountainRecoveryError.storage }
            throw FountainRecoveryError.stale
        }
    }
    private func recoveryResources(_ job: FountainJob, paths: [String], initial: FountainRecovery.Responses = [:], completion: @escaping (FountainRecovery.Responses) throws -> Void) {
        guard current(job) else { return }
        do {
            guard paths.count + initial.count <= 200, initial.values.reduce(0, { $0 + $1.1.count }) <= 64 * 1024 * 1024 else { throw FountainRecoveryError.access }
            guard let path = paths.first else { try completion(initial); return }
            _ = try Self.validPath(path)
            let recoveryObservation = try recoveryObservation(job, path: path, method: "GET")
            job.task = try network(path: job.wire(path), method: "GET", headers: [:], body: Data(), cookie: job.sentCookie, timeout: job.timeout, file: nil) { response, data, error in
                guard self.current(job) else { return }
                do {
                    guard error == nil, let response = response else { throw FountainRecoveryError.storage }
                    guard try self.currentCookie() == job.sentCookie else { throw FountainRecoveryError.stale }
                    guard response.statusCode != 401 else { throw FountainRecoveryError.auth }
                    if let (store, admission, authority) = recoveryObservation {
                        try self.noteRecoveryServerObservation(store, admission: admission, authority: authority, job: job, path: path, status: response.statusCode, data: data)
                    }
                    self.recovery?.noteCanonical(path: path, status: response.statusCode, data: data)
                    var collected = initial; collected[path] = (response.statusCode, data)
                    self.recoveryResources(job, paths: Array(paths.dropFirst()), initial: collected, completion: completion)
                } catch { self.failRecovery(job, error) }
            }
        } catch { failRecovery(job, error) }
    }
    private func failRecovery(_ job: FountainJob, _ error: Error) {
        recoveryReaders[job.id]?.cancelPrepared()
        let failure = error as? FountainRecoveryError ?? .storage
        if case .auth = failure { recovery?.close(); recovery = nil }
        job.callClosed = true; job.call.reject(failure.message, failure.code)
        end(job, failure: .cancelled)
    }
    private func recoveryUnauthorized(_ job: FountainJob) throws {
        if workspace != nil { try accountTransport?.invalidate(authRequired: true); return }
        if let sent = job.sentCookie, try cookies().active == sent {
            try saveCookies(FountainCookies(active: nil, revoke: sent))
            auth += 1; job.auth = auth; authDrainSuspended += 1
            for other in Array(jobs.values) where other !== job && !authQueue.contains(where: { $0 === other }) { end(other, failure: .stale) }
            authDrainSuspended -= 1
        }
        recovery?.close(); recovery = nil
        throw FountainRecoveryError.auth
    }
    private func resolveRecovery(_ job: FountainJob, result: [String: Any], reader: FountainRecovery, authority: FountainRecovery.Authority) {
        guard current(job) else { return }
        job.callClosed = true
        var result = result
        if FountainWorkspacePolicy.scoped(job.path) != nil { result["workspaceEpoch"] = workspaceEpoch }
        let startingAuth = auth, startingGeneration = generation, startingBoundary = reader.boundary
        let cleanStale = { [weak self] in
            self?.queue.async {
                Self.ownership.lock(); defer { Self.ownership.unlock() }
                guard reader.boundary == startingBoundary else { return }
                if let token = result["exportToken"] as? String { reader.cancelToken(token) }
                else { reader.cancelPrepared() }
            }
        }
        DispatchQueue.main.async { [weak self] in
            Self.ownership.lock(); defer { Self.ownership.unlock() }
            guard let self = self, Self.currentOwner === self, !self.terminated, self.recovery === reader,
                  self.auth == startingAuth, self.generation == startingGeneration, authority.deadline > Date().timeIntervalSince1970 * 1000,
                  reader.boundary == startingBoundary, reader.validMetadata(result["exportToken"] as? String, other: authority),
                  let controller = self.bridge?.viewController as? FountainBridgeViewController,
                  controller.bundled(controller.webView?.url), let webView = controller.webView,
                  let callback = job.call.callbackId, let method = job.call.methodName else { cleanStale(); job.call.reject(FountainRecoveryError.stale.message, FountainRecoveryError.stale.code); return }
            let envelope: [String: Any] = ["callbackId": callback, "pluginId": "FountainNative", "methodName": method, "save": false, "success": true, "data": result]
            guard let bytes = try? JSONSerialization.data(withJSONObject: envelope), let payload = String(data: bytes, encoding: .utf8) else { cleanStale(); job.call.reject(FountainRecoveryError.storage.message, FountainRecoveryError.storage.code); return }
            webView.evaluateJavaScript("window.Capacitor.fromNative(" + payload + ")", completionHandler: nil)
        }
        end(job)
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
                    Self.ownership.lock(); defer { Self.ownership.unlock() }
                    guard self.current(job), self.exportID == job.id else { return }
                    if let proof = job.backupAuthority {
                        guard (try? self.currentCookie()) == job.sentCookie, proof.deadline > Date().timeIntervalSince1970 * 1000 else { self.queue.async { self.end(job, failure: .stale) }; return }
                    }
                    if let token = self.recoverySaveTokens[job.id], let authority = self.recoverySaveAuthority[job.id], self.recovery?.validSave(token, other: authority) != true {
                        self.queue.async { self.failRecovery(job, FountainRecoveryError.stale) }; return
                    }
                    let picker = UIDocumentPickerViewController(forExporting: self.recoveryFiles[job.id] ?? [file], asCopy: true)
                    picker.delegate = self; self.picker = picker; self.pickerJobID = job.id
                    controller.present(picker, animated: true)
                }
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishExport(controller, savedCount: 0) }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finishExport(controller, savedCount: urls.count) }
    private func finishExport(_ controller: UIDocumentPickerViewController, savedCount: Int) {
        guard picker === controller, let id = pickerJobID else { return }
        queue.async {
            guard self.exportID == id, let job = self.jobs[id] else { return }
            if let token = self.recoverySaveTokens[id], let authority = self.recoverySaveAuthority[id], let reader = self.recoveryReaders[id] {
                guard self.current(job), (try? self.currentCookie()) == job.sentCookie, reader.validSave(token, other: authority) else { self.failRecovery(job, FountainRecoveryError.stale); return }
                do { try reader.checkSource(authority) } catch { self.failRecovery(job, error); return }
                let expected = self.recoveryFiles[id]?.count ?? 0, saved = min(savedCount, expected)
                reader.cancelPrepared()
                self.resolveRecovery(job, result: ["saved": saved == expected && expected > 0, "filesSaved": saved, "generation": job.generation], reader: reader, authority: authority)
            } else {
                if let proof = job.backupAuthority { guard self.current(job), (try? self.currentCookie()) == job.sentCookie, proof.deadline > Date().timeIntervalSince1970 * 1000 else { self.end(job, failure: .stale); return } }
                self.end(job, result: ["saved": savedCount > 0, "generation": job.generation])
            }
        }
    }
}
