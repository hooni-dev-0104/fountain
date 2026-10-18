import Foundation
import Security

// Public selection is a snapshot. Only a native scoped HTTP response grants it.
struct FountainWorkspace {
    let workspaceId: String, memberId: String, binding: String, accountBinding: String
    let expiresAt: Double
    let session: [String: Any]
    var publicValue: [String: Any] { ["workspaceId": workspaceId, "memberId": memberId, "binding": binding, "accountBinding": accountBinding, "expiresAt": expiresAt, "session": session] }
    var prefix: String { "/api/w/" + workspaceId + "/" + binding }
}
enum FountainWorkspacePolicy {
    struct Route { let workspace: String, binding: String, logical: String }
    static func invalidatePersistedAccount(origin: String?, _ invalidate: () throws -> Void) rethrows {
        guard origin != nil else { return }
        try invalidate()
    }

    static func scoped(_ raw: String) -> Route? {
        guard raw.hasPrefix("/api/w/"), !raw.contains("#"), !raw.contains("\\") else { return nil }
        let parts = raw.split(separator: "/", maxSplits: 5, omittingEmptySubsequences: false)
        guard parts.count == 6, parts[0].isEmpty, parts[1] == "api", parts[2] == "w",
              FountainAccountPolicy.validWorkspace(String(parts[3])), FountainAccountPolicy.validBinding(String(parts[4])),
              !parts[5].isEmpty, !parts[5].hasPrefix("/") else { return nil }
        return Route(workspace: String(parts[3]), binding: String(parts[4]), logical: "/api/" + parts[5])
    }
    static func verify(_ body: Data, workspace: String, binding: String, account: String, now: Double = Date().timeIntervalSince1970 * 1000) throws -> FountainWorkspace {
        guard let value = try JSONSerialization.jsonObject(with: body) as? [String: Any],
              Set(value.keys).subtracting(["public_web_origin"]) == Set(["enabled", "required", "authenticated", "mode", "identity", "member", "workspace_id", "cache_binding", "expires_at", "account_binding"]),
              let enabled = value["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(), enabled.boolValue,
              let required = value["required"] as? NSNumber, CFGetTypeID(required) == CFBooleanGetTypeID(), required.boolValue,
              let identity = value["identity"] as? String, !identity.isEmpty, identity.utf8.count <= 4000,
              let authenticated = value["authenticated"] as? NSNumber, CFGetTypeID(authenticated) == CFBooleanGetTypeID(), authenticated.boolValue,
              value["mode"] as? String == "accounts", value["workspace_id"] as? String == workspace,
              value["cache_binding"] as? String == binding, value["account_binding"] as? String == account,
              let member = value["member"] as? [String: Any], Set(member.keys) == Set(["id", "name", "email", "role", "active"]),
              let name = member["name"] as? String, !name.isEmpty, name.utf8.count <= 4000,
              let email = member["email"] as? String, email.utf16.count <= 1000,
              let actor = member["id"] as? String, !actor.isEmpty, actor.utf8.count <= 1000, !actor.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let active = member["active"] as? NSNumber, CFGetTypeID(active) == CFBooleanGetTypeID(), active.boolValue,
              ["owner", "admin", "member", "guest"].contains(member["role"] as? String ?? ""), let expiry = value["expires_at"] as? String else { throw FountainAccountError.invalid }
        if let supplied = value["public_web_origin"] {
            guard let text = supplied as? String, text.utf8.count <= 1024,
                  !text.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }), !text.contains("\\"),
                  let url = URLComponents(string: text), url.scheme == "https", let host = url.host, !host.isEmpty,
                  url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil, url.fragment == nil,
                  text == "https://" + host + (url.port.map { ":" + String($0) } ?? "") else { throw FountainAccountError.invalid }
        }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: expiry) ?? ISO8601DateFormatter().date(from: expiry),
              date.timeIntervalSince1970 * 1000 > now, date.timeIntervalSince1970 * 1000 <= now + 604801000 else { throw FountainAccountError.stale }
        return FountainWorkspace(workspaceId: workspace, memberId: actor, binding: binding, accountBinding: account, expiresAt: (date.timeIntervalSince1970 * 1000).rounded(.down), session: value)
    }
}

// Last server-selected scope is sealed in its own OS vault. It is never a new
// online grant: offline admission must also match the original SQLite identity.
final class FountainWorkspaceKeychain {
    private func query(origin: String, workspace: String, binding: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "dev.fountain.workspace") + ".native-workspace-scope",
         kSecAttrAccount as String: origin + "|" + workspace + "|" + binding, kSecAttrSynchronizable as String: false]
    }
    func seal(_ value: FountainWorkspace, origin: String, reference: String) throws {
        let data = try JSONSerialization.data(withJSONObject: ["session": value.session, "reference": reference], options: [.sortedKeys])
        guard data.count <= 2 * 1024 * 1024 else { throw FountainAccountError.storage }
        let attributes = query(origin: origin, workspace: value.workspaceId, binding: value.binding)
        let update = [kSecValueData as String: data]
        var status = SecItemUpdate(attributes as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = attributes; insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw FountainAccountError.storage }
    }
    func open(origin: String, workspace: String, member: String, binding: String, account: String, expires: Double, reference: String) throws -> FountainWorkspace {
        var attributes = query(origin: origin, workspace: workspace, binding: binding); attributes[kSecReturnData as String] = true
        var found: CFTypeRef?
        guard SecItemCopyMatching(attributes as CFDictionary, &found) == errSecSuccess, let data = found as? Data, data.count <= 2 * 1024 * 1024,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["reference"] as? String == reference,
              let session = object["session"] as? [String: Any] else { throw FountainAccountError.stale }
        let verified = try FountainWorkspacePolicy.verify(JSONSerialization.data(withJSONObject: session), workspace: workspace, binding: binding, account: account)
        guard verified.memberId == member, verified.expiresAt == expires else { throw FountainAccountError.stale }
        return verified
    }
    func remove(origin: String, workspace: String, binding: String) throws {
        let status = SecItemDelete(query(origin: origin, workspace: workspace, binding: binding) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw FountainAccountError.storage }
    }
}
