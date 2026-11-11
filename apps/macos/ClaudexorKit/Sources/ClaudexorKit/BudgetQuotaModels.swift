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
    public var freshness: String? = nil
    public var appliesToRequestKinds: [String]? = nil
    public var appliesToText: Bool { appliesToRequestKinds?.contains("text") ?? true }
    public let id: String
    public let label: String
    /// nil/empty means the window applies to every model. A non-empty list is
    /// the server-authored scope; clients render it but never infer account-wide
    /// exhaustion from a scoped ratio.
    public let appliesToModelPrefixes: [String]?
    public let appliesToModels: [String]?
    public let appliesToUnspecifiedModel: Bool?
    public let usedRatio: Double?
    public let windowSeconds: Double?
    public let resetsAt: String?
    public let cooldownUntil: String?
    public var modelScope: [String] { quotaModelScopeDisplay(appliesToModels ?? [], appliesToModelPrefixes ?? []) }

    private enum CodingKeys: String, CodingKey {
        case id, label, freshness
        case appliesToModels = "applies_to_models"
        case appliesToModelPrefixes = "applies_to_model_prefixes"
        case appliesToUnspecifiedModel = "applies_to_unspecified_model"
        case appliesToRequestKinds = "applies_to_request_kinds"
        case usedRatio = "used_ratio"
        case windowSeconds = "window_seconds"
        case resetsAt = "resets_at"
        case cooldownUntil = "cooldown_until"
    }

    /// Presentation identity of the vendor window, never its changing value,
    /// reset or display label. Distinct applicability must remain visible.
    public var presentationID: String {
        let scope: Any = appliesToModels.map { Array(Set($0)).sorted() as Any } ?? NSNull()
        var fields: [Any] = [id, windowSeconds as Any? ?? NSNull(), scope,
                             appliesToUnspecifiedModel == true]
        // Match the schema identity while preserving existing no-prefix ids.
        if let prefixes = appliesToModelPrefixes, !prefixes.isEmpty {
            fields.append(Array(Set(prefixes)).sorted())
        }
        if let kinds = appliesToRequestKinds { fields.append(["requestKinds": Array(Set(kinds)).sorted()]) }
        let data = try? JSONSerialization.data(withJSONObject: fields)
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? id
    }
}

public struct QuotaModelScopedExhaustion: Codable, Sendable, Equatable, Hashable {
    public let constraintId: String
    public let appliesToModelPrefixes: [String]?
    public let appliesToModels: [String]
    public var modelScope: [String] { quotaModelScopeDisplay(appliesToModels, appliesToModelPrefixes ?? []) }
    public let resetsAt: String?

    private enum CodingKeys: String, CodingKey {
        case constraintId = "constraint_id"
        case appliesToModels = "applies_to_models"
        case appliesToModelPrefixes = "applies_to_model_prefixes"
        case resetsAt = "resets_at"
    }
}

/// Server-derived spendability for one quota snapshot. Optional on the wire so
/// the app remains compatible with daemons that predate the projection; when it
/// is absent the UI shows usage windows without inventing an availability state.
public struct QuotaAvailability: Codable, Sendable, Equatable {
    public let state: String
    public let blockingConstraints: [String]
    public let resetsAt: String?
    public let modelScopedExhaustions: [QuotaModelScopedExhaustion]

    private enum CodingKeys: String, CodingKey {
        case state
        case blockingConstraints = "blocking_constraints"
        case resetsAt = "resets_at"
        case modelScopedExhaustions = "model_scoped_exhaustions"
    }
}

public struct QuotaSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let snapshotId: String?
    public let subject: QuotaSubject
    public let constraints: [QuotaConstraint]
    public let source: String
    public let observedAt: String
    public let freshness: String
    /// Decorated by the control boundary. Raw journal snapshots may omit it.
    public let availability: QuotaAvailability?

    private enum CodingKeys: String, CodingKey {
        case subject, constraints, source, freshness, availability
        case observedAt = "observed_at"
        case snapshotId = "snapshot_id"
    }

    public var id: String {
        snapshotId ?? [subject.harness, subject.credentialRoute, subject.subjectId ?? "", source].joined(separator: ":")
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

/// One subject (or a retained legacy vendor floor) a refresh did not re-fetch
/// because its poll cooldown is active; its snapshots/absences in the same response
/// are last-known registry data.
public struct QuotaRefreshSkipped: Codable, Sendable, Equatable, Identifiable {
    public let vendor: String
    public let notBefore: String
    public let subject: QuotaSubject?

    private enum CodingKeys: String, CodingKey {
        case vendor, subject
        case notBefore = "not_before"
    }

    public init(vendor: String, notBefore: String, subject: QuotaSubject? = nil) {
        self.vendor = vendor
        self.notBefore = notBefore
        self.subject = subject
    }

    public var id: String { subject.map { [vendor, $0.credentialRoute, $0.subjectId ?? ""].joined(separator: ":") } ?? vendor }
}

public struct ControlQuotaResponse: Codable, Sendable, Equatable {
    public var availabilityScope: QuotaAvailabilityScope? = nil
    public let snapshots: [QuotaSnapshot]
    /// Every registered subject reports either a snapshot or a typed absence.
    public let absences: [QuotaAbsence]
    public let refreshedAt: String?
    /// Present only on refresh responses that skipped at least one vendor's
    /// fan-out for an active poll rate-limit cooldown; those vendors' rows
    /// above are last-known data, not the product of this refresh. Optional
    /// so an absent wire field round-trips absent, never as a minted [].
    public let refreshSkipped: [QuotaRefreshSkipped]?
    /// Present only on the operation-catalog-negotiated resources projection.
    public let resources: [AccountResourceSnapshot]?

    private enum CodingKeys: String, CodingKey {
        case snapshots, absences, resources
        case availabilityScope = "availability_scope"
        case refreshedAt = "refreshed_at"
        case refreshSkipped = "refresh_skipped"
    }

    public init(
        snapshots: [QuotaSnapshot],
        absences: [QuotaAbsence] = [],
        refreshedAt: String?,
        refreshSkipped: [QuotaRefreshSkipped]? = nil,
        resources: [AccountResourceSnapshot]? = nil
    ) {
        self.snapshots = snapshots
        self.absences = absences
        self.refreshedAt = refreshedAt
        self.refreshSkipped = refreshSkipped
        self.resources = resources
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        snapshots = try c.decode([QuotaSnapshot].self, forKey: .snapshots)
        absences = try c.decodeIfPresent([QuotaAbsence].self, forKey: .absences) ?? []
        refreshedAt = try c.decodeIfPresent(String.self, forKey: .refreshedAt)
        refreshSkipped =
            try c.decodeIfPresent([QuotaRefreshSkipped].self, forKey: .refreshSkipped)
        resources = try c.decodeIfPresent([AccountResourceSnapshot].self, forKey: .resources)
        availabilityScope = try c.decodeIfPresent(QuotaAvailabilityScope.self, forKey: .availabilityScope)
    }
}

// A declared family already names every covered exact model. Preserve only
// uncovered aliases beside it, so catalog growth never expands the label.
private func quotaModelScopeDisplay(_ models: [String], _ prefixes: [String]) -> [String] {
    models.filter { model in !prefixes.contains(where: { model.hasPrefix($0) }) }
        + prefixes.map { $0 + "*" }
}
