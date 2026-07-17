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
}
