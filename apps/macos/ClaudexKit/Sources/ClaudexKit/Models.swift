import Foundation

/// One sequence-numbered envelope from the control-api SSE stream. `seq` is the
/// SSE id used for Last-Event-ID resume; `kind` discriminates the payload
/// ("run" = RunEvent, "harness" = HarnessEvent, "gap"/"error"/"end" = control).
public struct BusEnvelope: Sendable, Equatable {
    public let seq: Int
    public let kind: String
    public let event: JSONValue

    public init(seq: Int, kind: String, event: JSONValue) {
        self.seq = seq
        self.kind = kind
        self.event = event
    }
}

/// Command to start a run (POST /runs). Mirrors the orchestrator RunInput subset a client
/// supplies; the server fills the rest. Policy fields (maxUsd/access/tests/repoRoot) flow
/// through `daemon.enqueue` to `orchestrator.run` so the composer's controls are actually
/// applied (not just displayed).
public struct StartRunRequest: Codable, Sendable {
    public var prompt: String
    public var mode: String?
    public var harnesses: [String]?
    public var primaryHarness: String?
    public var portfolio: String?
    public var model: String?
    public var n: Int?
    public var maxUsd: Double?
    public var access: String?
    public var tests: [String]?
    public var repoRoot: String?

    public init(prompt: String, mode: String? = nil, harnesses: [String]? = nil,
                primaryHarness: String? = nil, portfolio: String? = nil, model: String? = nil,
                n: Int? = nil, maxUsd: Double? = nil, access: String? = nil,
                tests: [String]? = nil, repoRoot: String? = nil) {
        self.prompt = prompt
        self.mode = mode
        self.harnesses = harnesses
        self.primaryHarness = primaryHarness
        self.portfolio = portfolio
        self.model = model
        self.n = n
        self.maxUsd = maxUsd
        self.access = access
        self.tests = tests
        self.repoRoot = repoRoot
    }
}

/// Response from POST /runs once the run id is known (returned early by the server).
public struct RunStartInfo: Codable, Sendable, Equatable {
    public let jobId: String?
    public let runId: String
    public let taskId: String
    public let runDir: String
}

public struct QueuedRunInfo: Codable, Sendable, Equatable {
    public let jobId: String
    public let state: String
    public let error: String?
}

public enum RunStartResult: Sendable, Equatable {
    case started(RunStartInfo)
    case queued(QueuedRunInfo)
}

public struct RunSummary: Codable, Sendable, Identifiable, Equatable {
    public let jobId: String?
    public let runId: String
    public let taskId: String?
    public let state: String
    public let runDir: String?
    public let error: String?
    public let mode: String?
    public let prompt: String?
    public let harnesses: [String]?
    public let primaryHarness: String?
    public let portfolio: String?
    public let model: String?
    public let n: Int?
    public let maxUsd: Double?
    public let access: String?
    public let tests: [String]?
    public let createdAt: String?
    public let startedAt: String?
    public let finishedAt: String?
    public var id: String { runId }
}

public struct RunListResponse: Codable, Sendable {
    public let runs: [RunSummary]
}

public struct ArtifactInfo: Codable, Sendable, Identifiable, Equatable {
    public let path: String
    public let kind: String
    public let bytes: Int?
    public var id: String { path }
}

public struct RunDetail: Codable, Sendable, Equatable {
    public let summary: RunSummary
    public let artifacts: [ArtifactInfo]
    public let finalSummary: String?
    public let decision: JSONValue?
    public let workProduct: JSONValue?
}

public struct HarnessStatus: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let status: String
    public let manifest: JSONValue?
    public let enabledIntents: [String]
    public let disabledIntents: [String]
    public let reasons: [String]?

    enum CodingKeys: String, CodingKey {
        case id, status, manifest, enabledIntents, disabledIntents, reasons
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(String.self, forKey: .status)
        manifest = try c.decodeIfPresent(JSONValue.self, forKey: .manifest)
        enabledIntents = try c.decodeIfPresent([String].self, forKey: .enabledIntents) ?? []
        disabledIntents = try c.decodeIfPresent([String].self, forKey: .disabledIntents) ?? []
        reasons = try c.decodeIfPresent([String].self, forKey: .reasons)
    }
}

public struct HarnessListResponse: Codable, Sendable {
    public let harnesses: [HarnessStatus]
}

public struct SettingsSnapshot: Codable, Sendable, Equatable {
    public let sources: [String]
    public let defaultPortfolio: String
    public let routing: RoutingSettings
    public let budget: BudgetSettings
}

public struct RoutingSettings: Codable, Sendable, Equatable {
    public let defaultPolicy: String
    public let primaryHarness: String?
    public let eligibleHarnesses: [String]
    public let defaultModel: String?
    public let envInheritance: String
}

public struct BudgetSettings: Codable, Sendable, Equatable {
    public let maxUsdPerRun: Double?
    public let maxUsdPerDay: Double?
}

public struct SettingsUpdateRequest: Encodable, Sendable, Equatable {
    public var defaultPortfolio: String?
    public var routingPolicy: String?
    public var primaryHarness: String?
    public var defaultModel: String?
    public var eligibleHarnesses: [String]?
    public var envInheritance: String?
    public var maxUsdPerRun: Double?
    public var maxUsdPerDay: Double?
    public var clearMaxUsdPerRun: Bool
    public var clearMaxUsdPerDay: Bool

    public init(defaultPortfolio: String? = nil, routingPolicy: String? = nil,
                primaryHarness: String? = nil, defaultModel: String? = nil,
                eligibleHarnesses: [String]? = nil, envInheritance: String? = nil,
                maxUsdPerRun: Double? = nil, maxUsdPerDay: Double? = nil,
                clearMaxUsdPerRun: Bool = false, clearMaxUsdPerDay: Bool = false) {
        self.defaultPortfolio = defaultPortfolio
        self.routingPolicy = routingPolicy
        self.primaryHarness = primaryHarness
        self.defaultModel = defaultModel
        self.eligibleHarnesses = eligibleHarnesses
        self.envInheritance = envInheritance
        self.maxUsdPerRun = maxUsdPerRun
        self.maxUsdPerDay = maxUsdPerDay
        self.clearMaxUsdPerRun = clearMaxUsdPerRun
        self.clearMaxUsdPerDay = clearMaxUsdPerDay
    }

    enum CodingKeys: String, CodingKey {
        case defaultPortfolio, routingPolicy, primaryHarness, defaultModel, eligibleHarnesses, envInheritance, maxUsdPerRun, maxUsdPerDay, clearMaxUsdPerRun, clearMaxUsdPerDay
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(defaultPortfolio, forKey: .defaultPortfolio)
        try c.encodeIfPresent(routingPolicy, forKey: .routingPolicy)
        try c.encodeIfPresent(primaryHarness, forKey: .primaryHarness)
        try c.encodeIfPresent(defaultModel, forKey: .defaultModel)
        try c.encodeIfPresent(eligibleHarnesses, forKey: .eligibleHarnesses)
        try c.encodeIfPresent(envInheritance, forKey: .envInheritance)
        try c.encodeIfPresent(maxUsdPerRun, forKey: .maxUsdPerRun)
        try c.encodeIfPresent(maxUsdPerDay, forKey: .maxUsdPerDay)
        if clearMaxUsdPerRun { try c.encode(true, forKey: .clearMaxUsdPerRun) }
        if clearMaxUsdPerDay { try c.encode(true, forKey: .clearMaxUsdPerDay) }
    }
}

public struct SettingsUpdateResponse: Codable, Sendable, Equatable {
    public let path: String
}

public struct SecretListResponse: Codable, Sendable, Equatable {
    public let backend: String
    public let secrets: [SecretInfo]
}

public struct SecretInfo: Codable, Sendable, Identifiable, Equatable {
    public let name: String
    public let backend: String
    public let present: Bool
    public var id: String { name }
}

public struct ApplyCheckResult: Codable, Sendable, Equatable {
    public let ok: Bool
    public let code: Int?
    public let stderr: String
}

public struct SecretSetRequest: Codable, Sendable, Equatable {
    public let name: String
    public let value: String
    public init(name: String, value: String) {
        self.name = name
        self.value = value
    }
}

public enum GatewayError: Error, Sendable, Equatable {
    case http(status: Int, body: String)
    case decoding(String)
    case transport(String)
}
