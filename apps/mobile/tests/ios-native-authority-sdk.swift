import XCTest
import Foundation
@testable import App

final class FountainNativeAuthorityTests: XCTestCase {
    func testProductionSQLiteAuthorityAndDurabilityRegressions() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), "Dedicated native QA Simulator required")
        let manager = FileManager.default, directory = manager.temporaryDirectory.appendingPathComponent("Fountain-authority-tests-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        defer { try? manager.removeItem(at: directory) }
        OutboxObserverFixture.checks = 0
        try OutboxObserverFixture.run(directory: directory)
        XCTAssertEqual(OutboxObserverFixture.checks, 181)
    }
}
