import Foundation

// MARK: - Settings wire models
//
// GET/POST /v2/settings: the engine-owned settings snapshot and its partial
// patches. Split from Models.swift (readability ratchet) — same wire shapes.

public struct SettingsSnapshot: Codable, Sendable, Equatable {
    public let sources: [String]
    public let routing: RoutingSettings
    public let budget: BudgetSettings
    public let runtime: RuntimeSettings?
    public let harnesses: [String: HarnessSettings]?
    /// Wait before an unanswered interactive question declines benignly (ms).
    /// Optional: pre-v0.8 daemons do not report it.
    public let interactionTimeoutMs: Int?
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
    public let transientRetry: RuntimeTransientRetrySettings
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
    public var interactionTimeoutMs: Int?
    public var harnesses: [String: HarnessSettingsPatch]?

    public init(routingGoal: String? = nil, paidFallback: String? = nil,
                qualityTiers: QualityTierSet? = nil,
                primaryHarness: String?? = nil,
                eligibleHarnesses: [String]? = nil, envInheritance: String? = nil,
                authPreference: String? = nil,
                paidBudgetPerRun: PaidBudget? = nil,
                interactionTimeoutMs: Int? = nil,
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
        try c.encodeIfPresent(interactionTimeoutMs, forKey: .interactionTimeoutMs)
        try c.encodeIfPresent(harnesses, forKey: .harnesses)
    }
}

public struct SettingsUpdateResponse: Codable, Sendable, Equatable {
    public let path: String
}
