import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A live pre-progress refusal mark: this account's started session refused
/// this requested model before progress. Ordering evidence for that model only.
public struct AccountRefusalMark: Decodable, Sendable, Equatable {
    public let harnessId: String
    public let profileId: String
    /// nil = the harness default model.
    public let requestedModel: String?
    public let observedAt: String
    public let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case harnessId = "harness_id", profileId = "profile_id", requestedModel = "requested_model"
        case observedAt = "observed_at", expiresAt = "expires_at"
    }

    /// A mark whose self-expiry has passed (or cannot be read) is not live.
    public func isLive(at now: Date = Date()) -> Bool {
        parseOffsetTimestamp(expiresAt).map { $0 > now } ?? false
    }
}

/// The latest request an account served for one requested model: a routing
/// observation, never a quota or authentication verdict.
public struct AccountLastService: Decodable, Sendable, Equatable {
    public let harnessId: String
    public let profileId: String
    /// nil = the harness default model.
    public let requestedModel: String?
    public let observedAt: String

    enum CodingKeys: String, CodingKey {
        case harnessId = "harness_id", profileId = "profile_id", requestedModel = "requested_model"
        case observedAt = "observed_at"
    }
}

/// A live typed refusal of ONE model on a registered account
/// (`credentialUnusable[]`): dated evidence beside the row, never its status.
/// A credential-wide refusal is the row's status instead, so `model` always
/// names the refused model and never means the default model.
public struct AccountCredentialUnusableMark: Decodable, Sendable, Equatable {
    public let harnessId: String
    public let profileId: String
    public let model: String
    /// The engine's typed reason (`capability_refused`, `auth_revoked`, `verification_failed`).
    public let code: String
    /// Redacted typed evidence such as the vendor's error category; nil when none was observed.
    public let detail: String?
    public let observedAt: String
    public let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case harnessId = "harness_id", profileId = "profile_id", model, code, detail
        case observedAt = "observed_at", expiresAt = "expires_at"
    }

    /// An observation whose self-expiry has passed (or cannot be read) is not live.
    public func isLive(at now: Date = Date()) -> Bool {
        parseOffsetTimestamp(expiresAt).map { $0 > now } ?? false
    }
}

/// `GET /v2/accounts/routing-evidence`: a separate additive read whose route is
/// negotiated through the operation catalog
/// (`AccountResourceCapabilities.routingEvidence`), so the legacy Accounts payloads
/// stay unchanged for every client.
public struct AccountRoutingEvidence: Decodable, Sendable, Equatable {
    public let refusals: [AccountRefusalMark]
    /// Most recent service first.
    public let lastService: [AccountLastService]
    /// Model-scoped credential refusals; empty from an engine that predates them.
    public let credentialUnusable: [AccountCredentialUnusableMark]

    public init(refusals: [AccountRefusalMark], lastService: [AccountLastService],
                credentialUnusable: [AccountCredentialUnusableMark] = []) {
        self.refusals = refusals
        self.lastService = lastService
        self.credentialUnusable = credentialUnusable
    }

    enum CodingKeys: String, CodingKey { case refusals, lastService, credentialUnusable }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        refusals = try c.decode([AccountRefusalMark].self, forKey: .refusals)
        lastService = try c.decode([AccountLastService].self, forKey: .lastService)
        credentialUnusable = try c.decodeIfPresent(
            [AccountCredentialUnusableMark].self, forKey: .credentialUnusable) ?? []
    }
}

public extension GatewayClient {
    /// Call only when the catalog advertises the read; a failure is the
    /// caller's to disclose and never invalidates the Accounts listing. It asks
    /// for the model-scoped credential refusals; an engine whose strict route
    /// predates that query answers 400 and is read again without it, as the
    /// CLI does.
    func accountRoutingEvidence() async throws -> AccountRoutingEvidence {
        let data: Data
        do {
            data = try await accountResourceData(request(
                "accounts/routing-evidence", method: "GET",
                queryItems: [URLQueryItem(name: "includeCredentialUnusable", value: "true")]))
        } catch let GatewayError.http(status, _) where status == 400 {
            data = try await accountResourceData(request("accounts/routing-evidence", method: "GET"))
        }
        return try Self.decoder.decode(AccountRoutingEvidence.self, from: data)
    }
}
