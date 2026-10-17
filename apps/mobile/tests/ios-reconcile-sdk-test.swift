import XCTest
import Foundation
import Darwin
@testable import App

// The same driver executes production App code and actual iOS SQLite. The
// corpus is private test input, never an application/renderer capability.
final class FountainReconcileVectorTests: XCTestCase {
    func testAllAssignedNativeReconciliationVectors() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), "Dedicated native QA Simulator required")
        let manager = FileManager.default, documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let input = documents.appendingPathComponent("fountain-shared-reconcile-input.json"), output = documents.appendingPathComponent("fountain-shared-reconcile-result.json")
        try XCTSkipUnless(manager.fileExists(atPath: input.path), "Private shared corpus input required")
        let descriptor = Darwin.open(input.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw FountainOutboxError.storage }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o777 == 0o600, info.st_uid == getuid(),
              info.st_size > 0, info.st_size <= 16 * 1024 * 1024, unlink(input.path) == 0, let bytes = try handle.read(upToCount: 16 * 1024 * 1024 + 1), bytes.count == Int(info.st_size),
              FountainOutbox.hash(bytes) == "bf11801d1dc7df79a547e5a7fd04247a2e4deaee8fe95f34833c2ac368b31747",
              let corpus = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw FountainOutboxError.invalid }
        let isolated = manager.temporaryDirectory.appendingPathComponent("Fountain-shared-vectors-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: isolated, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete]); defer { try? manager.removeItem(at: isolated) }
        var result = try IOSReconcileVectors.runSuite(corpus, directory: isolated)
        result["supplemental"] = try IOSPromotionProjectionFixtures.run(corpus, directory: isolated)
        result["corpusSHA256"] = FountainOutbox.hash(bytes); result["processID"] = Int(ProcessInfo.processInfo.processIdentifier)
        try IOSReconcileVectors.json(result).write(to: output, options: [.atomic, .completeFileProtection]); try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        XCTAssertEqual((result["passed"] as! [String]).count, 62)
        XCTAssertEqual((result["delegatedJS"] as! [String]).count, 5)
        let failureMessage = String(data: try IOSReconcileVectors.json(result["failures"]!), encoding: .utf8)!
        XCTAssertTrue((result["failures"] as! [[String: String]]).isEmpty, failureMessage)
        XCTAssertEqual(result["skippedNative"] as? Int, 0)
        XCTAssertEqual((result["supplemental"] as? [String])?.count, 3)
    }
}
