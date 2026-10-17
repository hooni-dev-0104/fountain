// Shared vectors execute actual production Swift and SQLite on macOS. Unsupported
// event protocols are failures, never skipped or counted as platform evidence.
import Foundation
import SQLite3

#if os(iOS)
@testable import App
#endif
#if os(macOS)
@main
#endif
struct IOSReconcileVectors {
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]) }
    static func sql(_ file: URL, _ query: String, _ values: [Any] = []) throws -> [[Any]] {
        var db: OpaquePointer?, statement: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        defer { sqlite3_finalize(statement); sqlite3_close(db) }
        guard sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK else { throw FountainOutboxError.storage }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in values.enumerated() {
            let parameter = Int32(index + 1)
            if let data = value as? Data { _ = data.withUnsafeBytes { sqlite3_bind_blob(statement, parameter, $0.baseAddress, Int32(data.count), transient) } }
            else if let string = value as? String { sqlite3_bind_text(statement, parameter, string, -1, transient) }
            else if let number = value as? Int { sqlite3_bind_int64(statement, parameter, Int64(number)) }
            else { sqlite3_bind_null(statement, parameter) }
        }
        var result: [[Any]] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return result }; guard status == SQLITE_ROW else { throw FountainOutboxError.storage }
            result.append((0..<sqlite3_column_count(statement)).map { column -> Any in
                switch sqlite3_column_type(statement, column) {
                case SQLITE_BLOB: return Data(bytes: sqlite3_column_blob(statement, column)!, count: Int(sqlite3_column_bytes(statement, column)))
                case SQLITE_INTEGER: return Int(sqlite3_column_int64(statement, column))
                default: return sqlite3_column_text(statement, column).map { String(cString: $0) } ?? ""
                }
            })
        }
    }
    static func require(_ condition: Bool, _ message: String) throws { if !condition { throw NSError(domain: "SharedVector", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) } }
    static func adapt(_ value: Any, field: String = "", shift: Double) throws -> Any {
        if let object = value as? [String: Any] { return try object.mapValuesWithKey { try adapt($1, field: $0, shift: shift) } }
        if let array = value as? [Any] { return try array.map { try adapt($0, field: field, shift: shift) } }
        if let text = value as? String {
            if field == "deltaJSON" { return String(data: try json(adapt(JSONSerialization.jsonObject(with: Data(text.utf8)), shift: shift)), encoding: .utf8)! }
            if field == "expires_at" {
                let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                var date = parser.date(from: text)
                if date == nil { parser.formatOptions = [.withInternetDateTime]; date = parser.date(from: text) }
                guard let date else { throw FountainOutboxError.invalid }
                parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return parser.string(from: date.addingTimeInterval(shift / 1000))
            }
            return text
        }
        if let number = value as? NSNumber, ["validUntil", "updatedAt", "createdAt", "expiresAt", "lastModified"].contains(field) { return Int(number.doubleValue + shift) }
        return value
    }
    static func runSuite(_ raw: [String: Any], directory root: URL) throws -> [String: Any] {
        let shift = Date().timeIntervalSince1970 * 1000 - (raw["clockMs"] as! NSNumber).doubleValue
        let corpus = try adapt(raw, shift: shift) as! [String: Any]
        var pass: [String] = [], delegated: [String] = [], failures: [[String: String]] = []
        for vector in corpus["cases"] as! [[String: Any]] {
            let id = vector["id"] as! String, targets = vector["executionTargets"] as! [String]
            if targets == ["js"] { delegated.append(id); continue }
            guard targets == ["native"] else { failures.append(["id": id, "error": "Unknown execution target"]); continue }
            do { try IOSReconcileVectorDriver(vector, corpus: corpus, directory: root.appendingPathComponent(id, isDirectory: true)).run(); pass.append(id) }
            catch { failures.append(["id": id, "error": (error as? FountainOutboxError)?.code ?? error.localizedDescription]) }
        }
        try require(pass.count + failures.count == 62 && delegated.count == 5, "Assigned execution manifest changed")
        #if os(iOS)
        let platform = "iOS"
        #else
        let platform = "macOS"
        #endif
        var supplemental: [String] = []
        if CommandLine.arguments.contains("--promotion") { supplemental = try IOSPromotionProjectionFixtures.run(corpus, directory: root) }
        return ["actualProductionSwiftSQLite": true, "platform": platform, "passed": pass, "failures": failures, "delegatedJS": delegated, "skippedNative": 0, "supplemental": supplemental]
    }
    static func main() throws {
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
        #if FOUNTAIN_LOCAL_EXPORT_FIXTURES
        let local = try IOSNativeLocalExportFixtures.run(raw, directory: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
        print(String(data: try json(local), encoding: .utf8)!); return
        #endif
        let result = try runSuite(raw, directory: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
        print(String(data: try json(result), encoding: .utf8)!)
        if !(result["failures"] as! [[String: String]]).isEmpty { exit(1) }
    }
}

private extension Dictionary where Key == String, Value == Any {
    func mapValuesWithKey(_ transform: (String, Any) throws -> Any) rethrows -> [String: Any] {
        var output: [String: Any] = [:]; for (key, value) in self { output[key] = try transform(key, value) }; return output
    }
}
