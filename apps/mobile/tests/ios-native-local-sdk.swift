import XCTest
import Foundation
import Darwin
@testable import App

// Isolated synthetic source enters the actual native commit/archive protocol.
// This runner exercises SDK SQLite; the device does not emulate the backend.
final class FountainNativeLocalRecoveryTests: XCTestCase {
    func testNativeLocalProvenanceCompleteBodiesAndExportPolicy() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["FOUNTAIN_QA"] == "1" && (environment["SIMULATOR_DEVICE_NAME"] ?? "").hasPrefix("Fountain QA"), "Dedicated native QA Simulator required")
        let manager = FileManager.default, documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let input = documents.appendingPathComponent("fountain-native-local-input.json"), output = documents.appendingPathComponent("fountain-native-local-result.json")
        try XCTSkipUnless(manager.fileExists(atPath: input.path), "Private synthetic corpus input required")
        let descriptor = Darwin.open(input.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw FountainOutboxError.storage }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o777 == 0o600, info.st_uid == getuid(),
              info.st_size > 0, info.st_size <= 16 * 1024 * 1024, unlink(input.path) == 0,
              let bytes = try handle.read(upToCount: 16 * 1024 * 1024 + 1), bytes.count == Int(info.st_size),
              FountainOutbox.hash(bytes) == "bf11801d1dc7df79a547e5a7fd04247a2e4deaee8fe95f34833c2ac368b31747",
              let corpus = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw FountainOutboxError.invalid }
        let isolated = manager.temporaryDirectory.appendingPathComponent("Fountain-native-local-" + UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: isolated, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete]); defer { try? manager.removeItem(at: isolated) }
        let local = try IOSNativeLocalExportFixtures.run(corpus, directory: isolated)
        let bodies = try IOSPromotionBodyFixtures.run(corpus, directory: isolated, large: true)
        var projections: [[String: Any]] = []
        for file in try manager.contentsOfDirectory(at: isolated, includingPropertiesForKeys: nil).filter({ $0.lastPathComponent.hasPrefix("body-projection-") && $0.pathExtension == "json" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let raw = try Data(contentsOf: file)
            guard raw.count <= 16 * 1024 * 1024, let projection = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else { throw FountainOutboxError.invalid }
            projections.append(["case": file.deletingPathExtension().lastPathComponent, "projection": projection])
        }
        let result: [String: Any] = ["platform": "iOS", "actualProductionSwiftSQLite": true, "local": local, "bodies": bodies, "syntheticBackendProjections": projections, "corpusSHA256": FountainOutbox.hash(bytes), "processID": Int(ProcessInfo.processInfo.processIdentifier)]
        try IOSReconcileVectors.json(result).write(to: output, options: [.atomic, .completeFileProtection]); try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
        XCTAssertEqual(local["checks"] as? Int, 56)
        XCTAssertEqual((bodies["passed"] as? [String])?.count, 18)
        XCTAssertEqual(bodies["skipped"] as? Int, 0)
        XCTAssertEqual(projections.count, 6)
    }
}
