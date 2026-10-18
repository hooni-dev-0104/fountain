import XCTest
import Foundation
@testable import App

final class FountainMultiworkspaceSDKTests: XCTestCase {
    func testProductionURLSessionAndSQLiteParking() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA Multiworkspace"), "Dedicated multiworkspace QA Simulator required")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fountain-multiworkspace-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        defer { try? FileManager.default.removeItem(at: directory) }
        try IOSMultiworkspaceFixture.run(directory: directory)
    }
    func testActualIndependentAccountKeychain() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA Multiworkspace"), "Dedicated multiworkspace QA Simulator required")
        let origin = "https://account-keychain-" + UUID().uuidString.lowercased() + ".invalid"
        let account = FountainAccountKeychain(), organization = FountainOrganizationKeychain()
        let token = Data(repeating: 3, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let value = FountainAccountCookies(active: "fountain_account_session=" + token, binding: String(repeating: "a", count: 32), expiresAt: Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000)
        defer { try? account.write(FountainAccountCookies(), origin: origin); try? account.unblock(origin) }
        try account.block(origin); try account.write(value, origin: origin)
        XCTAssertEqual(try account.read(origin), value)
        XCTAssertTrue(try account.blocked(origin))
        XCTAssertEqual(try organization.read(origin), FountainOrganizationCookies())
        XCTAssertFalse(try organization.blocked(origin))
        try account.unblock(origin)
        XCTAssertFalse(try account.blocked(origin))
        let vault = FountainWorkspaceKeychain()
        let parent = IOSMultiworkspaceFixture.parent, binding = IOSMultiworkspaceFixture.bindingA
        let session = IOSMultiworkspaceFixture.session("A", binding)
        let sealed = try FountainWorkspacePolicy.verify(IOSMultiworkspaceFixture.bytes(session), workspace: "A", binding: binding, account: parent)
        defer { try? vault.remove(origin: origin, workspace: "A", binding: binding) }
        try vault.seal(sealed, origin: origin, reference: "private-parent-reference")
        let restored = try vault.open(origin: origin, workspace: "A", member: "member-A", binding: binding, account: parent, expires: sealed.expiresAt, reference: "private-parent-reference")
        XCTAssertEqual(restored.binding, binding)
        XCTAssertEqual(restored.expiresAt, sealed.expiresAt)
        XCTAssertThrowsError(try vault.open(origin: origin, workspace: "A", member: "member-A", binding: binding, account: parent, expires: sealed.expiresAt + 1, reference: "private-parent-reference"))
        XCTAssertThrowsError(try vault.open(origin: origin, workspace: "A", member: "member-A", binding: binding, account: parent, expires: sealed.expiresAt, reference: "foreign-parent-reference"))
        XCTAssertThrowsError(try vault.open(origin: origin, workspace: "A", member: "member-A", binding: binding, account: String(repeating: "b", count: 32), expires: sealed.expiresAt, reference: "private-parent-reference"))
    }
}
