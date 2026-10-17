import XCTest
import Foundation
@testable import App

final class FountainSessionLogoutTests: XCTestCase {
    private func run(_ name: String) throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), "Dedicated native QA Simulator required")
        let manager = FileManager.default, directory = manager.temporaryDirectory.appendingPathComponent("Fountain-session-scope-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        defer { try? manager.removeItem(at: directory) }
        try IOSSessionLogoutFixture.run(name, directory: directory)
    }
    func testStaleBindingCannotReachActualSQLiteEffects() throws { try run("stale-preserves-sqlite") }
    func testMatchingLogoutIsNegativeOnlyForBlockedOrExpiredState() throws { try run("matching-negative-only") }
    func testUnknownAndMalformedDoNotReadVault() throws { try run("unknown-no-vault-read") }
    func testCookieAndOriginChangesAreFenced() throws { try run("cookie-origin-fences") }
    func testQueuedOldBindingCannotFollowNewLogin() throws { try run("queued-old-scope") }
    func testActualSessionCaptureChecksCookieAndHeaders() throws { try run("actual-capture-guards") }
    func testStrictDuplicateUnicodeAndByteBounds() throws { try run("strict-parser") }
    func testPublic409ClearsOnlyItsExactPendingScope() throws { try run("exact-public409-pending") }
    func testPublicContextSurvivesFailedVaultWritesAndTwoRestarts() throws { try run("durable-bound-restart") }
    func testPublicPreflightFailureHasNoAuthenticationEffects() throws { try run("public-preflight-denied") }
    func testBoundContextCannotBecomeLegacyOrForeignCookie() throws { try run("bound-mismatch-corruption") }
    func testLocalNilContextIsOriginTaggedAndNeverWildcard() throws { try run("durable-local-sentinel") }
    func testActualNewCookieRollbackCannotBorrowOldBinding() throws { try run("actual-new-cookie-rollback") }
    func testVisibleContextAfterFailedDirectorySealMustReseal() throws { try run("failed-directory-seal-retry") }
    func testLocalCallerKeepsBoundContextAtDispatchAndDrainsBeforeStartup() throws { try run("local-caller-dispatch-before-ack") }
}
