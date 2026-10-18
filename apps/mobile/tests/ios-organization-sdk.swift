import XCTest
import Foundation
@testable import App

final class FountainOrganizationSDKTests: XCTestCase {
    func testIndependentTransportAndActualWorkspaceSQLite() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA Organization"), "Dedicated organization QA Simulator required")
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent("Fountain-organization-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        defer { try? manager.removeItem(at: directory) }
        try IOSOrganizationFixture.run(directory: directory)
    }

    func testActualSeparateKeychainNamespace() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA Organization"), "Dedicated organization QA Simulator required")
        // An unrouteable, per-test backend account keeps this test independent
        // of every configured workspace cookie, origin or Outbox.
        let origin = "https://organization-keychain-" + UUID().uuidString.lowercased() + ".invalid"
        let storage = FountainOrganizationKeychain()
        let token = Data(repeating: 9, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let value = FountainOrganizationCookies(active: "fountain_organization_session=" + token, binding: "organization-keychain-fixture")
        defer { try? storage.write(FountainOrganizationCookies(), origin: origin); try? storage.unblock(origin) }
        XCTAssertEqual(try storage.read(origin), FountainOrganizationCookies())
        XCTAssertFalse(try storage.blocked(origin))
        try storage.block(origin)
        XCTAssertTrue(try storage.blocked(origin))
        try storage.write(value, origin: origin)
        XCTAssertEqual(try storage.read(origin), value)
        XCTAssertEqual(try storage.read(origin + ".different"), FountainOrganizationCookies())
        try storage.write(FountainOrganizationCookies(), origin: origin)
        try storage.unblock(origin)
        XCTAssertEqual(try storage.read(origin), FountainOrganizationCookies())
        XCTAssertFalse(try storage.blocked(origin))
    }
}
