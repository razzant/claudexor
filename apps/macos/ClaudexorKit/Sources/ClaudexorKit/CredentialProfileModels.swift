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

/// Non-secret {email, plan} identity of one account (INV-067), derived
/// DAEMON-SIDE under the exact binding's effective credential route when the
/// harness exposes it. The app RENDERS this projection — it never reads a
/// vendor credential file itself (the removed app-side reader was the
/// INV-067/INV-002 violation). Both fields are optional because a harness may
/// disclose one field or no machine-readable identity at all.
public struct AccountIdentity: Codable, Sendable, Equatable {
    public let email: String?
    public let plan: String?

    public init(email: String? = nil, plan: String? = nil) {
        self.email = email
        self.plan = plan
    }
}

public struct CredentialProfileEntry: Codable, Sendable, Identifiable, Equatable {
    public struct Profile: Codable, Sendable, Equatable {
        public let profileId: String
        public let harnessId: String
        public let displayName: String
        /// config_dir_login | oauth_token | api_key.
        public let credentialKind: String
        /// Canonical absolute config-dir path for config_dir_login profiles; nil
        /// for secret-ref kinds. INFORMATIONAL only — the app NEVER reads this
        /// local path: the profile's non-secret identity arrives on the entry's
        /// `identity` field, projected daemon-side (INV-067).
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
        /// WHAT the `verification` verdict is worth: `local_store` = only that
        /// this binding's required local state or managed secret is present and
        /// well-formed, which cannot tell a live token from a revoked one;
        /// `vendor` = the vendor answered under this binding's exact environment
        /// and effective platform credential policy.
        /// Dropping it made `passed` read as vendor-confirmed on every client.
        public let verificationSource: String
        public let detail: String?
        public let lastVerifiedAt: String?

        enum CodingKeys: String, CodingKey {
            case availability, verification, detail
            case verificationSource = "verification_source"
            case lastVerifiedAt = "last_verified_at"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            availability = try c.decode(String.self, forKey: .availability)
            verification = try c.decode(String.self, forKey: .verification)
            // Absent = an older daemon that predates the distinction; the weaker
            // claim is the honest default, never "vendor".
            verificationSource =
                try c.decodeIfPresent(String.self, forKey: .verificationSource) ?? "local_store"
            detail = try c.decodeIfPresent(String.self, forKey: .detail)
            lastVerifiedAt = try c.decodeIfPresent(String.self, forKey: .lastVerifiedAt)
        }
    }

    public let profile: Profile
    public let status: Status
    /// Non-secret {email, plan} of this account, projected daemon-side under
    /// the exact binding's effective credential route (INV-067). nil when
    /// absent/undisclosed, or when an older daemon omits the field
    /// (`decodeIfPresent`).
    public let identity: AccountIdentity?
    public var id: String { "\(profile.harnessId)/\(profile.profileId)" }

    enum CodingKeys: String, CodingKey { case profile, status, identity }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profile = try c.decode(Profile.self, forKey: .profile)
        status = try c.decode(Status.self, forKey: .status)
        identity = try c.decodeIfPresent(AccountIdentity.self, forKey: .identity)
    }
}

/// The POOL routing verdict for one harness's UNPINNED runs (unified account
/// model, INV-135): every account is a named registry row, so `next_up` is
/// either an enabled row, the policy-governed API-key ROUTE (INV-061 — a
/// route, never a row), or nothing routable. Carried ONLY by `accountPools`;
/// the legacy per-harness `next_up` never learns new kinds. INFORMATIONAL —
/// the Enabled toggle is the only routing control, and a per-thread pin
/// overrides. FORWARD-COMPATIBLE by contract: a kind this build does not know
/// decodes as `.unknown` instead of failing the whole accounts response (the
/// legacy decoder threw on unknown kinds; that failure class dies here).
public enum ControlPoolNextUp: Decodable, Sendable, Equatable {
    /// An enabled account row is who an unpinned run routes to next.
    case profile(profileId: String)
    /// The pool is empty/exhausted; the unpinned route is the policy-governed
    /// API key (INV-061) — a route, never an account row.
    case apiKeyRoute
    /// An unpinned run has nothing routable, with a human reason.
    case none(reason: String)
    /// A newer engine's kind this build does not know. Rendered as "no badge"
    /// rather than a decode failure.
    case unknown(kind: String)

    enum CodingKeys: String, CodingKey { case kind, profileId, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "profile": self = .profile(profileId: try c.decode(String.self, forKey: .profileId))
        case "api_key_route": self = .apiKeyRoute
        case "none": self = .none(reason: try c.decode(String.self, forKey: .reason))
        case let other: self = .unknown(kind: other)
        }
    }

    /// True when `id` is the next-up account row.
    public func isProfile(_ id: String) -> Bool {
        if case .profile(let profileId) = self { return profileId == id }
        return false
    }
    /// True when the unpinned route is the policy API key (a route, not a row).
    public var isApiKeyRoute: Bool { if case .apiKeyRoute = self { return true }; return false }
}

/// Per-harness POOL AUTHORITY of the unified account model: routing facts live
/// here; account facts live on the profile rows. Rides RAW schema field names
/// (snake_case).
public struct HarnessAccountPool: Decodable, Sendable, Equatable {
    public let harnessId: String
    /// Who an unpinned run of this harness routes to next (informational).
    public let nextUp: ControlPoolNextUp

    enum CodingKeys: String, CodingKey {
        case harnessId = "harness_id"
        case nextUp = "next_up"
    }
}

public struct CredentialProfilesResponse: Decodable, Sendable {
    public let profiles: [CredentialProfileEntry]
    /// Per-harness pool authority (unified account model): the server-computed
    /// `next_up` routing verdicts. Defaults to empty so an older daemon that
    /// omits the key still decodes; surfaces then render no next-up badge.
    /// The retired `harnessAccounts` key (the "CLI login" pseudo-row) is
    /// deliberately NOT decoded: a unified-model engine always emits `[]`
    /// there, and no surface may re-derive rows from it.
    public let accountPools: [HarnessAccountPool]
    /// Present only for `?snapshot=true`; omission is an older/legacy response.
    public let harnesses: [HarnessStatus]?
    public let git: WorkspaceGitCapability?
    public let quota: ControlQuotaResponse?
    /// Opaque global-journal boundary for the dedicated quota observer.
    /// Present on a current complete snapshot; nil for a legacy daemon.
    public let quotaEventCursor: String?

    enum CodingKeys: String, CodingKey {
        case profiles, accountPools, harnesses, git, quota, quotaEventCursor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profiles = try c.decode([CredentialProfileEntry].self, forKey: .profiles)
        accountPools = try c.decodeIfPresent([HarnessAccountPool].self, forKey: .accountPools) ?? []
        harnesses = try c.decodeIfPresent([HarnessStatus].self, forKey: .harnesses)
        git = try c.decodeIfPresent(WorkspaceGitCapability.self, forKey: .git)
        quota = try c.decodeIfPresent(ControlQuotaResponse.self, forKey: .quota)
        quotaEventCursor = try c.decodeIfPresent(String.self, forKey: .quotaEventCursor)
    }
}

/// Body for PATCH /v2/credential-profiles/:harness/:id — toggle a profile's
/// `enabled` (the Enabled row of the accounts symmetry).
public struct UpdateCredentialProfileRequest: Encodable, Sendable, Equatable {
    public let enabled: Bool
    public init(enabled: Bool) { self.enabled = enabled }
}

/// Body for POST /v2/credential-profiles. Registration only covers
/// config_dir_login harnesses (agy|claude|codex|cursor); the server validates
/// the slug and rejects a duplicate id (409) or an unsupported harness (400).
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

public struct VendorCredentialDisposition: Decodable, Sendable, Equatable {
    public enum Owner: String, Decodable, Sendable { case vendor }
    public enum Scope: String, Decodable, Sendable { case osUser = "os_user" }
    public enum State: String, Decodable, Sendable { case leftUnchanged = "left_unchanged" }

    public let owner: Owner
    public let scope: Scope
    public let state: State
}

/// Receipt for DELETE /v2/credential-profiles/:harness/:id. Success proves the
/// binding and any Claudexor-owned state or managed secret were removed. A
/// typed disposition records when a vendor-owned OS-user credential was left
/// unchanged.
public struct DeleteCredentialProfileReceipt: Decodable, Sendable {
    public let removed: Bool
    /// config_dir_removed | secret_deleted | none.
    public let credentialCleanup: String
    /// DEPRECATED wire-compat field: a unified-model engine never emits it;
    /// only an older engine's removed-with-warning receipt still carries one.
    public let cleanupWarning: String?
    public let vendorCredentialDisposition: VendorCredentialDisposition?
}

public extension GatewayClient {
    func credentialProfiles(
        snapshot: Bool = false, resources: Bool = false, apiKeys: Bool = false
    ) async throws -> CredentialProfilesResponse {
        var query = snapshot ? [URLQueryItem(name: "snapshot", value: "true")] : []
        if snapshot && resources { query.append(URLQueryItem(name: "view", value: "resources")) }
        if snapshot && resources && apiKeys { query.append(URLQueryItem(name: "includeApiKeys", value: "true")) }
        let req = request("credential-profiles", method: "GET", queryItems: query)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(CredentialProfilesResponse.self, from: data)
    }

    /// Prefer the opt-in atomic snapshot; retry the legacy shape only when an
    /// older strict daemon rejects the new query parameter.
    func credentialProfilesSnapshot(
        resources: Bool = false, apiKeys: Bool = false
    ) async throws -> CredentialProfilesResponse {
        do {
            return try await credentialProfiles(snapshot: true, resources: resources, apiKeys: apiKeys)
        } catch let GatewayError.http(status, _) where status == 400 {
            return try await credentialProfiles()
        }
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

    /// Remove a credential profile: the daemon deletes the binding plus any
    /// Claudexor-owned state or managed secret. A vendor OS-user credential may
    /// be left unchanged. 409 = a login job is active;
    /// 503 `credential_cleanup_failed` = a partial cleanup failure that kept
    /// the row registered — retry the removal (D-U4).
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
