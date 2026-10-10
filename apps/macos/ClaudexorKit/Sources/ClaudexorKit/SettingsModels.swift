import Foundation

/// Swift consumer of the schema-owned finite timeout ceiling. Keep this wire
/// constant equal to `INTERACTION_TIMEOUT_MAX_MS` in @claudexor/schema.
public enum InteractionTimeoutContract {
    public static let maxFiniteMilliseconds = 8_000_000_000_000_000
}

// MARK: - Settings wire models
//
// GET/POST /v2/settings: the engine-owned settings snapshot and its partial
// patches. Split from Models.swift (readability ratchet) — same wire shapes.

public enum InteractionTimeoutSnapshotValue: Sendable, Equatable {
    /// Compatibility with older daemons that omitted the field entirely.
    case absent
    case disabled
    case finite(Int)
}

public struct SettingsSnapshot: Codable, Sendable, Equatable {
    public let sources: [String]
    public let routing: RoutingSettings
    public let budget: BudgetSettings
    public let runtime: RuntimeSettings?
    public let harnesses: [String: HarnessSettings]?
    /// Presence-aware wire value: old daemon omission, explicit no-expiry null,
    /// or a finite positive millisecond duration are distinct states.
    public let interactionTimeout: InteractionTimeoutSnapshotValue
    /// Admission notes of the write that produced this snapshot (INV-104): a
    /// model the harness's list could not verify was persisted and will be
    /// sent to the vendor as-is. Empty on reads and from older daemons.
    public let notes: [String]

    /// Compatibility projection for existing finite-value consumers. Disabled
    /// and old-daemon absence are both nil; new settings UI reads the typed
    /// `interactionTimeout` value above.
    public var interactionTimeoutMs: Int? {
        guard case .finite(let value) = interactionTimeout else { return nil }
        return value
    }

    enum CodingKeys: String, CodingKey {
        case sources, routing, budget, runtime, harnesses, interactionTimeoutMs, notes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sources = try c.decode([String].self, forKey: .sources)
        routing = try c.decode(RoutingSettings.self, forKey: .routing)
        budget = try c.decode(BudgetSettings.self, forKey: .budget)
        runtime = try c.decodeIfPresent(RuntimeSettings.self, forKey: .runtime)
        harnesses = try c.decodeIfPresent([String: HarnessSettings].self, forKey: .harnesses)
        notes = try c.decodeIfPresent([String].self, forKey: .notes) ?? []
        if !c.contains(.interactionTimeoutMs) {
            interactionTimeout = .absent
        } else if try c.decodeNil(forKey: .interactionTimeoutMs) {
            interactionTimeout = .disabled
        } else {
            interactionTimeout = .finite(try c.decode(Int.self, forKey: .interactionTimeoutMs))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sources, forKey: .sources)
        try c.encode(routing, forKey: .routing)
        try c.encode(budget, forKey: .budget)
        try c.encodeIfPresent(runtime, forKey: .runtime)
        try c.encodeIfPresent(harnesses, forKey: .harnesses)
        try c.encode(notes, forKey: .notes)
        switch interactionTimeout {
        case .absent:
            break
        case .disabled:
            try c.encodeNil(forKey: .interactionTimeoutMs)
        case .finite(let value):
            try c.encode(value, forKey: .interactionTimeoutMs)
        }
    }
}

public struct RoutingSettings: Codable, Sendable, Equatable {
    public let goal: String
    public let paidFallback: String
    public let qualityTiers: QualityTierSet
    public let primaryHarness: String?
    public let eligibleHarnesses: [String]
    public let envInheritance: String
    /// Engine auth route preference: subscription | api_key | auto.
    public let authPreference: String?
}

public struct BudgetSettings: Codable, Sendable, Equatable {
    public let paidBudgetPerRun: PaidBudget
}

public struct RuntimeSettings: Codable, Sendable, Equatable {
    public let reviewerTimeoutMs: Int
    /// Optional: daemons older than the watchdog omit it.
    public let harnessInactivityTimeoutMs: Int?
    /// Optional: older daemons do not disclose their concurrency limits.
    public let concurrency: RuntimeConcurrencySettings?
    public let transientRetry: RuntimeTransientRetrySettings
}

/// Read-only projection of configured caps and the daemon's startup snapshot.
public struct RuntimeConcurrencySettings: Codable, Sendable, Equatable {
    public let configured: RuntimeConcurrencyCaps
    public let effective: RuntimeConcurrencyCaps
    public let restartRequired: Bool
}

public struct RuntimeConcurrencyCaps: Codable, Sendable, Equatable {
    public let maxConcurrent: ConcurrencyLimit?
    public let maxConcurrentNonModelJobs: ConcurrencyLimit?
    public let maxConcurrentModelOperations: ConcurrencyLimit?
    public let maxParallelCandidates: Int
    public let maxDeepScanWidth: Int
    public let maxCouncilMembers: Int
    /// Absence on older engines is unknown provenance, never an implicit cap.
    public let sources: [String: ConcurrencySource]?
}

public enum ConcurrencySource: String, Codable, Sendable, Equatable {
    case `default`, config, environment, embedder, unknown
}

/// A real finite capacity or an explicit unlimited value. Missing support is
/// represented by an optional field, independently of the three strategy widths.
public enum ConcurrencyLimit: Codable, Sendable, Equatable {
    case finite(Int)
    case unlimited

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let count = try? value.decode(Int.self), count > 0, count <= 9_007_199_254_740_991 {
            self = .finite(count)
        } else if (try? value.decode(String.self)) == "unlimited" {
            self = .unlimited
        } else {
            throw DecodingError.dataCorruptedError(in: value, debugDescription: "Expected a positive safe integer or unlimited")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .finite(let count): try value.encode(count)
        case .unlimited: try value.encode("unlimited")
        }
    }
}

public struct RuntimeTransientRetrySettings: Codable, Sendable, Equatable {
    public let maxRetries: Int
    public let initialDelayMs: Int
    public let maxDelayMs: Int
}

public struct HarnessSettings: Codable, Sendable, Equatable {
    public let enabled: Bool
    /// Whether the native/CLI login participates in this harness's credential
    /// ladder (INV-135 / V11b). Optional — pre-V11b daemons omit it.
    public let nativeCredentialsEnabled: Bool?
    public let defaultModel: String?
    public let effort: String?
    public let maxTurns: Int?
    public let maxRounds: Int?
    public let toolsAllow: [String]
    public let toolsDeny: [String]
    public let fallbackModel: String?
    public let web: String
    public let authPreference: String?
    /// Behaviour when this harness hits a credential-profile quota limit
    /// (INV-135 auto-balance): "fail" | "ask" | "rotate". Optional — pre-INV-135
    /// daemons omit it.
    public let profileLimitAction: String?
}

/// Partial per-harness settings patch; absent fields keep their stored value.
/// Codable (not just Encodable) so the TS→Swift wire-fixture round trip can
/// decode a maximal patch and re-encode it — a stray key drifting from the
/// daemon's strict ControlHarnessSettingsPatch schema then fails that gate.
public struct HarnessSettingsPatch: Codable, Sendable, Equatable {
    public var enabled: Bool?
    /// Toggle the native/CLI login in this harness's credential ladder (V11b).
    public var nativeCredentialsEnabled: Bool?
    public var defaultModel: String??
    public var effort: String??
    public var web: String?
    public var toolsAllow: [String]?
    public var toolsDeny: [String]?
    public var fallbackModel: String??
    public var maxTurns: Int??
    public var maxRounds: Int??
    public var authPreference: String?
    /// Auto-balance action at a profile quota limit: "fail" | "ask" | "rotate".
    public var profileLimitAction: String?

    public init(enabled: Bool? = nil,
                nativeCredentialsEnabled: Bool? = nil,
                defaultModel: String?? = nil, effort: String?? = nil, web: String? = nil,
                toolsAllow: [String]? = nil, toolsDeny: [String]? = nil,
                fallbackModel: String?? = nil, maxTurns: Int?? = nil, maxRounds: Int?? = nil,
                authPreference: String? = nil, profileLimitAction: String? = nil) {
        self.enabled = enabled
        self.nativeCredentialsEnabled = nativeCredentialsEnabled
        self.defaultModel = defaultModel
        self.effort = effort
        self.web = web
        self.toolsAllow = toolsAllow
        self.toolsDeny = toolsDeny
        self.fallbackModel = fallbackModel
        self.maxTurns = maxTurns
        self.maxRounds = maxRounds
        self.authPreference = authPreference
        self.profileLimitAction = profileLimitAction
    }

    enum CodingKeys: String, CodingKey {
        case enabled, nativeCredentialsEnabled, defaultModel, effort, web, toolsAllow, toolsDeny, fallbackModel, maxTurns, maxRounds, authPreference, profileLimitAction
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(enabled, forKey: .enabled)
        try c.encodeIfPresent(nativeCredentialsEnabled, forKey: .nativeCredentialsEnabled)
        if let defaultModel { try c.encode(defaultModel, forKey: .defaultModel) }
        if let effort { try c.encode(effort, forKey: .effort) }
        try c.encodeIfPresent(web, forKey: .web)
        try c.encodeIfPresent(toolsAllow, forKey: .toolsAllow)
        try c.encodeIfPresent(toolsDeny, forKey: .toolsDeny)
        if let fallbackModel { try c.encode(fallbackModel, forKey: .fallbackModel) }
        if let maxTurns { try c.encode(maxTurns, forKey: .maxTurns) }
        if let maxRounds { try c.encode(maxRounds, forKey: .maxRounds) }
        try c.encodeIfPresent(authPreference, forKey: .authPreference)
        try c.encodeIfPresent(profileLimitAction, forKey: .profileLimitAction)
    }
}

public struct SettingsUpdateRequest: Encodable, Sendable, Equatable {
    public var routingGoal: String?
    public var paidFallback: String?
    public var qualityTiers: QualityTierSet?
    /// Double-optional: `.some(nil)` encodes an explicit JSON null = CLEAR the
    /// primary (no `"__none"` sentinel — the server rejects magic strings).
    public var primaryHarness: String??
    public var eligibleHarnesses: [String]?
    public var envInheritance: String?
    public var authPreference: String?
    public var paidBudgetPerRun: PaidBudget?
    /// Double optional preserves PATCH semantics: outer nil omits the key;
    /// `.some(nil)` sends JSON null to disable automatic expiry.
    public var interactionTimeoutMs: Int??
    public var harnesses: [String: HarnessSettingsPatch]?

    public init(routingGoal: String? = nil, paidFallback: String? = nil,
                qualityTiers: QualityTierSet? = nil,
                primaryHarness: String?? = nil,
                eligibleHarnesses: [String]? = nil, envInheritance: String? = nil,
                authPreference: String? = nil,
                paidBudgetPerRun: PaidBudget? = nil,
                interactionTimeoutMs: Int?? = nil,
                harnesses: [String: HarnessSettingsPatch]? = nil) {
        self.routingGoal = routingGoal
        self.paidFallback = paidFallback
        self.qualityTiers = qualityTiers
        self.primaryHarness = primaryHarness
        self.eligibleHarnesses = eligibleHarnesses
        self.envInheritance = envInheritance
        self.authPreference = authPreference
        self.paidBudgetPerRun = paidBudgetPerRun
        self.interactionTimeoutMs = interactionTimeoutMs
        self.harnesses = harnesses
    }

    enum CodingKeys: String, CodingKey {
        case routingGoal, paidFallback, qualityTiers, primaryHarness, eligibleHarnesses, envInheritance, authPreference, paidBudgetPerRun, interactionTimeoutMs, harnesses
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(routingGoal, forKey: .routingGoal)
        try c.encodeIfPresent(paidFallback, forKey: .paidFallback)
        try c.encodeIfPresent(qualityTiers, forKey: .qualityTiers)
        if let outer = primaryHarness {
            if let value = outer { try c.encode(value, forKey: .primaryHarness) }
            else { try c.encodeNil(forKey: .primaryHarness) }
        }
        try c.encodeIfPresent(eligibleHarnesses, forKey: .eligibleHarnesses)
        try c.encodeIfPresent(envInheritance, forKey: .envInheritance)
        try c.encodeIfPresent(authPreference, forKey: .authPreference)
        try c.encodeIfPresent(paidBudgetPerRun, forKey: .paidBudgetPerRun)
        if let interactionTimeoutMs {
            if let value = interactionTimeoutMs {
                try c.encode(value, forKey: .interactionTimeoutMs)
            } else {
                try c.encodeNil(forKey: .interactionTimeoutMs)
            }
        }
        try c.encodeIfPresent(harnesses, forKey: .harnesses)
    }
}
