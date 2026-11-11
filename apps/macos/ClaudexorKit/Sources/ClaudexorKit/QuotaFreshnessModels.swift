import Foundation

public struct QuotaAvailabilityScope: Codable, Equatable, Sendable {
    public let model: String?
    public let basis: String
    public let requestKind: String
    private enum CodingKeys: String, CodingKey { case model, basis, requestKind }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard c.contains(.model) else { throw DecodingError.keyNotFound(CodingKeys.model, .init(codingPath: decoder.codingPath, debugDescription: "Missing model scope echo")) }
        basis = try c.decode(String.self, forKey: .basis)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        requestKind = try c.decode(String.self, forKey: .requestKind)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(model, forKey: .model)
        try c.encode(basis, forKey: .basis)
        try c.encode(requestKind, forKey: .requestKind)
    }
}

/// Opt-in whole-response validator; legacy data cannot acquire exact scope by
/// silently ignoring a missing echo or a partially dated constraint list.
public struct ControlAccountResourcesFreshnessResponse: Codable, Equatable, Sendable {
    public let quota: ControlQuotaResponse
    public var resources: [AccountResourceSnapshot] { quota.resources ?? [] }
    public var availabilityScope: QuotaAvailabilityScope { quota.availabilityScope! }
    public init(from decoder: Decoder) throws {
        quota = try ControlQuotaResponse(from: decoder)
        guard quota.resources != nil, let scope = quota.availabilityScope, scope.basis == "quota_block",
              ["text", "image"].contains(scope.requestKind),
              quota.snapshots.allSatisfy({ $0.constraints.allSatisfy { $0.freshness != nil } }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Incomplete resources_freshness response"))
        }
    }
    public func encode(to encoder: Encoder) throws { try quota.encode(to: encoder) }
}
