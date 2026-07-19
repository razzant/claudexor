import Foundation

public enum PaidBudget: Codable, Sendable, Equatable {
    case unlimited
    case finite(maxUsd: Double)

    private enum CodingKeys: String, CodingKey { case kind, maxUsd }
    private enum Kind: String, Codable { case unlimited, finite }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .unlimited:
            self = .unlimited
        case .finite:
            let value = try container.decode(Double.self, forKey: .maxUsd)
            guard value >= 0 else {
                throw DecodingError.dataCorruptedError(
                    forKey: .maxUsd,
                    in: container,
                    debugDescription: "finite paid budget requires maxUsd >= 0"
                )
            }
            self = .finite(maxUsd: value)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .unlimited:
            try container.encode(Kind.unlimited, forKey: .kind)
        case .finite(let maxUsd):
            try container.encode(Kind.finite, forKey: .kind)
            try container.encode(maxUsd, forKey: .maxUsd)
        }
    }

    public var finiteMaxUsd: Double? {
        if case .finite(let maxUsd) = self { return maxUsd }
        return nil
    }
}

public struct CostEvidence: Codable, Sendable, Equatable {
    public let knowledge: String
    public let billing: String
    public let source: String
    public let provenance: [String]
    public let estimatedUsd: Double?
}

public struct QualityTierRoute: Codable, Sendable, Equatable, Hashable {
    public let harness: String
    public let model: String
    public let effort: String
}

public typealias QualityTierSet = [String: [[QualityTierRoute]]]

public struct QuotaSubject: Codable, Sendable, Equatable, Hashable {
    public let harness: String
    public let credentialRoute: String
    public let planLabel: String?
    public let subjectId: String?

    private enum CodingKeys: String, CodingKey {
        case harness
        case credentialRoute = "credential_route"
        case planLabel = "plan_label"
        case subjectId = "subject_id"
    }
}

public struct QuotaConstraint: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let usedRatio: Double?
    public let windowSeconds: Double?
    public let resetsAt: String?
    public let cooldownUntil: String?

    private enum CodingKeys: String, CodingKey {
        case id, label
        case usedRatio = "used_ratio"
        case windowSeconds = "window_seconds"
        case resetsAt = "resets_at"
        case cooldownUntil = "cooldown_until"
    }
}

public struct QuotaSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let subject: QuotaSubject
    public let constraints: [QuotaConstraint]
    public let source: String
    public let observedAt: String
    public let freshness: String

    private enum CodingKeys: String, CodingKey {
        case subject, constraints, source, freshness
        case observedAt = "observed_at"
    }

    public var id: String {
        [subject.harness, subject.credentialRoute, subject.subjectId ?? "", source].joined(separator: ":")
    }
}

/// A registered subject's typed missing-snapshot (D29): absence is STATED,
/// never inferred from empty snapshots (zen: absence ≠ empty).
public struct QuotaAbsence: Codable, Sendable, Equatable, Identifiable {
    public let subject: QuotaSubject
    /// not_logged_in | transport_unavailable | platform_unsupported |
    /// refresh_failed | no_source
    public let reason: String
    public let detail: String?
    public let observedAt: String

    private enum CodingKeys: String, CodingKey {
        case subject, reason, detail
        case observedAt = "observed_at"
    }

    public var id: String {
        [subject.harness, subject.credentialRoute, subject.subjectId ?? "", reason].joined(separator: ":")
    }
}

public struct ControlQuotaResponse: Codable, Sendable, Equatable {
    public let snapshots: [QuotaSnapshot]
    /// Every registered subject reports either a snapshot or a typed absence.
    public let absences: [QuotaAbsence]
    public let refreshedAt: String?

    private enum CodingKeys: String, CodingKey {
        case snapshots, absences
        case refreshedAt = "refreshed_at"
    }

    public init(snapshots: [QuotaSnapshot], absences: [QuotaAbsence] = [], refreshedAt: String?) {
        self.snapshots = snapshots
        self.absences = absences
        self.refreshedAt = refreshedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        snapshots = try c.decode([QuotaSnapshot].self, forKey: .snapshots)
        absences = try c.decodeIfPresent([QuotaAbsence].self, forKey: .absences) ?? []
        refreshedAt = try c.decodeIfPresent(String.self, forKey: .refreshedAt)
    }
}
