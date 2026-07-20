import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Credential profiles (INV-135)
//
// Wire shape of GET /v2/credential-profiles: the durable NON-SECRET registry
// entry paired with its doctor readiness projection. Unlike the camelCase
// control projections, the registry entry and status ride RAW schema field
// names (snake_case) — mapped explicitly here.

public struct CredentialProfileEntry: Codable, Sendable, Identifiable, Equatable {
    public struct Profile: Codable, Sendable, Equatable {
        public let profileId: String
        public let harnessId: String
        public let displayName: String
        /// config_dir_login | oauth_token | api_key.
        public let credentialKind: String
        /// Canonical absolute config-dir path for config_dir_login profiles; nil
        /// for secret-ref kinds. The macOS accounts surface reads the vendor
        /// identity (codex auth.json id_token claims / claude oauthAccount) from
        /// THIS local path — the wire never carries the email/plan (INV-135).
        public let isolationLocator: String?
        public let enabled: Bool

        enum CodingKeys: String, CodingKey {
            case profileId = "profile_id"
            case harnessId = "harness_id"
            case displayName = "display_name"
            case credentialKind = "credential_kind"
            case isolationLocator = "isolation_locator"
            case enabled
        }
    }

    /// Doctor readiness (never durable config): availability is the routing
    /// verdict; verification says whether a live probe actually ran.
    public struct Status: Codable, Sendable, Equatable {
        public let availability: String
        public let verification: String
        public let detail: String?
        public let lastVerifiedAt: String?

        enum CodingKeys: String, CodingKey {
            case availability, verification, detail
            case lastVerifiedAt = "last_verified_at"
        }
    }

    public let profile: Profile
    public let status: Status
    public var id: String { "\(profile.harnessId)/\(profile.profileId)" }
}

/// Server-computed NEXT-UP identity for a harness's accounts (INV-135, F1
/// engine cut): the identity an UNPINNED run/turn would route to next, computed
/// from enabled + readiness + quota. INFORMATIONAL only — the engine deleted
/// user-settable Active; the Enabled toggle is the only routing control, and a
/// per-thread pin overrides. A discriminated union on `kind`; no surface
/// re-derives the symmetry.
public enum ControlNextUpIdentity: Decodable, Sendable, Equatable {
    /// An enabled credential profile is who an unpinned run routes to next.
    case profile(profileId: String)
    /// The native/CLI login is the next-up subject of an unpinned run.
    case native
    /// An unpinned run has nothing routable (CLI login disabled, nothing pinned).
    case none(reason: String)

    enum CodingKeys: String, CodingKey { case kind, profileId, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "profile": self = .profile(profileId: try c.decode(String.self, forKey: .profileId))
        case "native": self = .native
        case "none": self = .none(reason: try c.decode(String.self, forKey: .reason))
        case let other:
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Unknown next-up-identity kind '\(other)'"))
        }
    }

    /// True when the native/CLI login is the next-up identity.
    public var isNative: Bool { if case .native = self { return true }; return false }
    /// True when `id` is the next-up credential profile.
    public func isProfile(_ id: String) -> Bool {
        if case .profile(let profileId) = self { return profileId == id }
        return false
    }
}

/// Per-harness ACCOUNTS AUTHORITY projection (INV-135, F1 engine cut): the
/// native "CLI login" pseudo-row state and the server-computed next-up identity,
/// computed ONCE on the server so no client re-derives the symmetry. The engine
/// DELETED user-settable Active — there is no `active_profile_id`; `next_up` is
/// informational (what routing would pick). Rides RAW schema field names
/// (snake_case).
public struct HarnessAccounts: Decodable, Sendable, Equatable {
    public let harnessId: String
    /// Whether the native/CLI login participates in this harness's ladder.
    public let nativeCredentialsEnabled: Bool
    /// Whether a native/default vendor login is currently detected available.
    public let nativeLoginDetected: Bool
    /// The identity an unpinned run would route to next (informational).
    public let nextUp: ControlNextUpIdentity

    enum CodingKeys: String, CodingKey {
        case harnessId = "harness_id"
        case nativeCredentialsEnabled = "native_credentials_enabled"
        case nativeLoginDetected = "native_login_detected"
        case nextUp = "next_up"
    }
}

public struct CredentialProfilesResponse: Decodable, Sendable {
    public let profiles: [CredentialProfileEntry]
    /// Per-harness accounts authority (V11b). Defaults to empty so an older
    /// daemon that omits the projection still decodes; surfaces then fall back
    /// to client-derived state.
    public let harnessAccounts: [HarnessAccounts]

    enum CodingKeys: String, CodingKey { case profiles, harnessAccounts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profiles = try c.decode([CredentialProfileEntry].self, forKey: .profiles)
        harnessAccounts = try c.decodeIfPresent([HarnessAccounts].self, forKey: .harnessAccounts) ?? []
    }
}

/// Body for PATCH /v2/credential-profiles/:harness/:id — toggle a profile's
/// `enabled` (the Enabled row of the accounts symmetry).
public struct UpdateCredentialProfileRequest: Encodable, Sendable, Equatable {
    public let enabled: Bool
    public init(enabled: Bool) { self.enabled = enabled }
}

/// Body for POST /v2/credential-profiles. Registration only covers
/// config_dir_login harnesses (claude|codex); the server validates the slug
/// and rejects a duplicate id (409) or an unsupported harness (400).
public struct CreateCredentialProfileRequest: Encodable, Sendable, Equatable {
    public let harnessId: String
    public let profileId: String
    public let displayName: String?

    public init(harnessId: String, profileId: String, displayName: String? = nil) {
        self.harnessId = harnessId
        self.profileId = profileId
        self.displayName = displayName
    }

    enum CodingKeys: String, CodingKey { case harnessId, profileId, displayName }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(harnessId, forKey: .harnessId)
        try c.encode(profileId, forKey: .profileId)
        try c.encodeIfPresent(displayName, forKey: .displayName)
    }
}

/// Receipt for DELETE /v2/credential-profiles/:harness/:id. The registry entry
/// is gone when this decodes; `cleanupWarning` discloses a failed cleanup of the
/// profile's own credential material (scoped login dir / namespaced secret).
public struct DeleteCredentialProfileReceipt: Decodable, Sendable {
    public let removed: Bool
    /// config_dir_removed | secret_deleted | none.
    public let credentialCleanup: String
    public let cleanupWarning: String?
}

public extension GatewayClient {
    func credentialProfiles() async throws -> CredentialProfilesResponse {
        let req = request("credential-profiles", method: "GET")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(CredentialProfilesResponse.self, from: data)
    }

    /// Register a new credential profile. The 200 body is one `{profile, status}`
    /// entry — the SAME shape as a `credentialProfiles()` list element.
    func createCredentialProfile(_ body: CreateCredentialProfileRequest) async throws -> CredentialProfileEntry {
        var req = request("credential-profiles", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(CredentialProfileEntry.self, from: data)
    }

    /// Toggle a credential profile's `enabled` (V11b — the Enabled row of the
    /// accounts symmetry). The 200 body is the updated `{profile, status}` entry
    /// — the SAME shape as a `credentialProfiles()` list element.
    func updateCredentialProfile(harnessId: String, profileId: String, enabled: Bool) async throws
        -> CredentialProfileEntry {
        let harness = harnessId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? harnessId
        let profile = profileId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? profileId
        var req = request("credential-profiles/\(harness)/\(profile)", method: "PATCH")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(UpdateCredentialProfileRequest(enabled: enabled))
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(CredentialProfileEntry.self, from: data)
    }

    /// Remove a credential profile: the daemon deletes the registry entry plus
    /// the profile's own credential material. 409 = a login job is active.
    func deleteCredentialProfile(harnessId: String, profileId: String) async throws
        -> DeleteCredentialProfileReceipt {
        let harness = harnessId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? harnessId
        let profile = profileId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? profileId
        let req = request("credential-profiles/\(harness)/\(profile)", method: "DELETE")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(DeleteCredentialProfileReceipt.self, from: data)
    }
}
