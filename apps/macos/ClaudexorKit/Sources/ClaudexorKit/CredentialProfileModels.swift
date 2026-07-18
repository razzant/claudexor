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
        public let enabled: Bool

        enum CodingKeys: String, CodingKey {
            case profileId = "profile_id"
            case harnessId = "harness_id"
            case displayName = "display_name"
            case credentialKind = "credential_kind"
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

public struct CredentialProfilesResponse: Codable, Sendable {
    public let profiles: [CredentialProfileEntry]
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
}
