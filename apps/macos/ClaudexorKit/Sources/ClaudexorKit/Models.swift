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

public struct RunScope: Codable, Sendable, Equatable {
    public var kind: String
    public var root: String?
    public var context: String?

    public static let none = RunScope(kind: "none", root: nil, context: nil)
    public static func project(root: String, context: String = "auto") -> RunScope {
        RunScope(kind: "project", root: root, context: context)
    }
}

public struct RunExecution: Codable, Sendable, Equatable {
    public var isolation: String

    public init(isolation: String = "envelope") {
        self.isolation = isolation
    }
}

/// Command to start a run (POST /runs). Mirrors the public control-api DTO a client
/// supplies; the server fills the rest. Policy fields flow through `daemon.enqueue`
/// to `orchestrator.run` so the composer's controls are actually applied.
public struct StartRunRequest: Codable, Sendable {
    public var prompt: String
    public var mode: String?
    public var scope: RunScope
    public var execution: RunExecution
    public var harnesses: [String]?
    public var primaryHarness: String?
    public var portfolio: String?
    public var model: String?
    public var reviewerModels: [String: String]?
    public var reviewerEfforts: [String: String]?
    public var n: Int?
    public var maxUsd: Double?
    public var access: String?
    public var web: String?
    public var tests: [String]?
    /// v0.9 strategy flags (modes collapsed to 5; strategies ride as flags).
    public var attempts: Int?
    public var untilClean: Bool?
    public var swarm: Bool?
    public var create: Bool?
    /// Thread linkage (chat/session-first): a run is a turn inside a thread.
    public var threadId: String?
    public var authPreference: String?

    public init(prompt: String, mode: String? = nil, scope: RunScope = .none,
                execution: RunExecution = RunExecution(), harnesses: [String]? = nil,
                primaryHarness: String? = nil, portfolio: String? = nil, model: String? = nil,
                reviewerModels: [String: String]? = nil, reviewerEfforts: [String: String]? = nil,
                n: Int? = nil, maxUsd: Double? = nil, access: String? = nil,
                web: String? = nil,
                tests: [String]? = nil,
                attempts: Int? = nil, untilClean: Bool? = nil, swarm: Bool? = nil, create: Bool? = nil,
                threadId: String? = nil, authPreference: String? = nil) {
        self.prompt = prompt
        self.mode = mode
        self.scope = scope
        self.execution = execution
        self.harnesses = harnesses
        self.primaryHarness = primaryHarness
        self.portfolio = portfolio
        self.model = model
        self.reviewerModels = reviewerModels
        self.reviewerEfforts = reviewerEfforts
        self.n = n
        self.maxUsd = maxUsd
        self.access = access
        self.web = web
        self.tests = tests
        self.attempts = attempts
        self.untilClean = untilClean
        self.swarm = swarm
        self.create = create
        self.threadId = threadId
        self.authPreference = authPreference
    }
}

// MARK: - Threads (A2 chat/session-first)

public struct ThreadSummary: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String?
    public let repoRoot: String?
    public let mode: String?
    public let authPreference: String?
    public let primaryHarness: String?
    public let state: String?
    public let runIds: [String]
    public let headRunId: String?
    public let needsHuman: Bool
    public let createdAt: String
    public let updatedAt: String
}

public struct ThreadSessionInfo: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let threadId: String
    public let harnessId: String
    public let nativeSessionId: String?
    public let observedModel: String?
    public let state: String?
}

public struct ThreadTurnInfo: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let threadId: String
    public let runId: String?
    public let parentRunId: String?
    public let kind: String?
    public let prompt: String
    public let state: String?
    public let createdAt: String
}

public struct ThreadListResponse: Codable, Sendable {
    public let threads: [ThreadSummary]
}

public struct ThreadDetailResponse: Codable, Sendable {
    public let thread: ThreadSummary
    public let sessions: [ThreadSessionInfo]
    public let turns: [ThreadTurnInfo]
}

public struct CreateThreadRequest: Codable, Sendable {
    public var title: String?
    public var scope: RunScope
    public var mode: String?
    public var authPreference: String?
    public var primaryHarness: String?

    public init(title: String? = nil, scope: RunScope = .none, mode: String? = nil,
                authPreference: String? = nil, primaryHarness: String? = nil) {
        self.title = title
        self.scope = scope
        self.mode = mode
        self.authPreference = authPreference
        self.primaryHarness = primaryHarness
    }
}

/// Body for POST /threads/:id/turns — a reduced run start anchored by the thread.
public struct ThreadTurnRequest: Codable, Sendable {
    public var prompt: String
    public var mode: String?
    public var harnesses: [String]?
    public var n: Int?
    public var attempts: Int?
    public var untilClean: Bool?
    public var swarm: Bool?
    public var create: Bool?
    public var maxUsd: Double?

    public init(prompt: String, mode: String? = nil, harnesses: [String]? = nil, n: Int? = nil,
                attempts: Int? = nil, untilClean: Bool? = nil, swarm: Bool? = nil, create: Bool? = nil,
                maxUsd: Double? = nil) {
        self.prompt = prompt
        self.mode = mode
        self.harnesses = harnesses
        self.n = n
        self.attempts = attempts
        self.untilClean = untilClean
        self.swarm = swarm
        self.create = create
        self.maxUsd = maxUsd
    }
}

// MARK: - Operator decisions (review queue actions)

public struct RunDecisionRequest: Codable, Sendable {
    public var action: String
    public var findingIds: [String]
    public var feedback: String?
    public var acceptedRisks: [String]
    public var applyMode: String?

    public init(action: String, findingIds: [String] = [], feedback: String? = nil,
                acceptedRisks: [String] = [], applyMode: String? = nil) {
        self.action = action
        self.findingIds = findingIds
        self.feedback = feedback
        self.acceptedRisks = acceptedRisks
        self.applyMode = applyMode
    }
}

public struct RunDecisionResponse: Codable, Sendable, Equatable {
    public let accepted: Bool
    public let status: String
    public let newRunId: String?
    public let message: String?
}

/// Result of POST /runs/:id/apply (delivery DeliverResult projection).
public struct ApplyResultInfo: Codable, Sendable, Equatable {
    public let mode: String
    public let applied: Bool
    public let branch: String?
    public let commit: String?
    public let prUrl: String?
    public let detail: String?
}

public struct ApplyRunRequest: Codable, Sendable {
    public var target: ApplyTarget
    public var mode: String
    public var branch: String?
    public var message: String?

    public init(target: ApplyTarget = .originalProject, mode: String = "apply", branch: String? = nil, message: String? = nil) {
        self.target = target
        self.mode = mode
        self.branch = branch
        self.message = message
    }
}

public enum ApplyTarget: Codable, Sendable, Equatable {
    case originalProject
    case project(root: String)

    enum CodingKeys: String, CodingKey { case kind, root }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        if kind == "project" {
            self = .project(root: try c.decode(String.self, forKey: .root))
        } else {
            self = .originalProject
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .originalProject:
            try c.encode("original_project", forKey: .kind)
        case .project(let root):
            try c.encode("project", forKey: .kind)
            try c.encode(root, forKey: .root)
        }
    }
}

/// Response from POST /runs once the run id is known (returned early by the server).
public struct RunStartInfo: Codable, Sendable, Equatable {
    public let jobId: String?
    public let runId: String
    /// Optional in the wire contract; a response without it must not decode-fail a started run.
    public let taskId: String?
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

public struct RunFailureInfo: Codable, Sendable, Equatable {
    public let phase: String
    public let category: String
    public let harnessId: String?
    public let attemptId: String?
    public let safeMessage: String
    public let rawDetailRef: String?
    public let logRefs: [String]
    public let eventRefs: [String]
    public let runDir: String?
    public let nextActions: [String]

    enum CodingKeys: String, CodingKey {
        case phase, category, harnessId, attemptId, safeMessage, rawDetailRef, logRefs, eventRefs, runDir, nextActions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phase = try c.decodeIfPresent(String.self, forKey: .phase) ?? "unknown"
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? "unknown"
        harnessId = try c.decodeIfPresent(String.self, forKey: .harnessId)
        attemptId = try c.decodeIfPresent(String.self, forKey: .attemptId)
        safeMessage = try c.decode(String.self, forKey: .safeMessage)
        rawDetailRef = try c.decodeIfPresent(String.self, forKey: .rawDetailRef)
        logRefs = try c.decodeIfPresent([String].self, forKey: .logRefs) ?? []
        eventRefs = try c.decodeIfPresent([String].self, forKey: .eventRefs) ?? []
        runDir = try c.decodeIfPresent(String.self, forKey: .runDir)
        nextActions = try c.decodeIfPresent([String].self, forKey: .nextActions) ?? []
    }
}

public struct RunProjectInfo: Codable, Sendable, Equatable {
    public let kind: String
    public let root: String?
    public let projectName: String?
    public let context: String
}

/// Run-level route evidence: requested vs STREAM-OBSERVED model. `verified`
/// is true only when the harness stream itself disclosed a model identity.
public struct RouteInfo: Codable, Sendable, Equatable {
    public let requestedModel: String?
    public let observedModel: String?
    public let harnessId: String?
    public let verified: Bool?
}

public struct RunSummary: Codable, Sendable, Identifiable, Equatable {
    public let jobId: String?
    public let runId: String
    public let taskId: String?
    public let state: String
    public let runDir: String?
    public let error: String?
    public let failure: RunFailureInfo?
    public let project: RunProjectInfo?
    public let mode: String?
    public let prompt: String?
    public let harnesses: [String]?
    public let primaryHarness: String?
    public let portfolio: String?
    public let model: String?
    public let n: Int?
    public let maxUsd: Double?
    public let spendUsd: Double?
    public let spendEstimated: Bool?
    public let access: String?
    public let requestedAccess: String?
    public let effectiveAccess: String?
    public let externalContextPolicy: String?
    public let webRequired: Bool?
    public let webMode: String?
    public let webEvidence: WebEvidence?
    public let outputReadyState: String?
    /// True while at least one harness question awaits the user's answer.
    public let waitingOnUser: Bool?
    public let route: RouteInfo?
    public let tests: [String]?
    public let specId: String?
    public let specHash: String?
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

public struct PrimaryOutput: Codable, Sendable, Equatable {
    public let kind: String
    public let path: String
    public let text: String?
    public let bytes: Int?
}

public struct WebEvidence: Codable, Sendable, Equatable {
    public let required: Bool
    public let mode: String
    /// Mode the selected route actually executed (disclosed upgrades, e.g. claude cached->live).
    public let effectiveMode: String?
    public let attempted: Bool
    public let satisfied: Bool
    public let status: String
    public let tool: String?
    public let target: String?
    public let errorSummary: String?
    public let rawDetailRef: String?
    /// False when the run predates telemetry.yaml: render "telemetry unavailable", never a guess.
    public let available: Bool?
}

public struct TimelineEvent: Codable, Sendable, Identifiable, Equatable {
    public var id: String { "\(type)-\(ts ?? "")-\(title)-\(attemptId ?? "")" }
    public let type: String
    public let ts: String?
    public let harnessId: String?
    public let attemptId: String?
    public let title: String
    public let detail: String?
    public let severity: String?
    public let toolName: String?
    public let target: String?
    public let errorSummary: String?
    public let rawRef: String?
}

public struct BudgetSnapshot: Codable, Sendable, Equatable {
    public let maxUsd: Double?
    public let spendUsd: Double?
    public let remainingUsd: Double?
    public let estimated: Bool
    public let source: String
    public let nativeQuota: [NativeQuota]
}

public struct NativeQuota: Codable, Sendable, Equatable {
    public let provider: String
    public let label: String
    public let remaining: String?
    public let resetsAt: String?
    public let source: String
}

/// One option of a pending interactive question.
public struct InteractionOption: Codable, Sendable, Equatable, Hashable {
    public let label: String
    public let description: String?

    public init(label: String, description: String?) {
        self.label = label
        self.description = description
    }
}

public struct InteractionQuestion: Codable, Sendable, Identifiable, Equatable, Hashable {
    public let id: String
    public let question: String
    public let header: String?
    public let options: [InteractionOption]
    public let multiSelect: Bool

    enum CodingKeys: String, CodingKey {
        case id, question, header, options
        case multiSelect = "multi_select"
    }

    public init(id: String, question: String, header: String?, options: [InteractionOption], multiSelect: Bool) {
        self.id = id
        self.question = question
        self.header = header
        self.options = options
        self.multiSelect = multiSelect
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        question = try c.decode(String.self, forKey: .question)
        header = try c.decodeIfPresent(String.self, forKey: .header)
        options = try c.decodeIfPresent([InteractionOption].self, forKey: .options) ?? []
        multiSelect = try c.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false
    }
}

/// A live harness question awaiting the user's answer (waiting_on_user).
public struct PendingInteraction: Codable, Sendable, Identifiable, Equatable, Hashable {
    public let interactionId: String
    public let runId: String
    public let attemptId: String?
    public let harnessId: String?
    public let sourceTool: String?
    public let questions: [InteractionQuestion]
    public let requestedAt: String
    public let timeoutAt: String?
    public var id: String { interactionId }

    public init(interactionId: String, runId: String, attemptId: String?, harnessId: String?,
                sourceTool: String?, questions: [InteractionQuestion], requestedAt: String, timeoutAt: String?) {
        self.interactionId = interactionId
        self.runId = runId
        self.attemptId = attemptId
        self.harnessId = harnessId
        self.sourceTool = sourceTool
        self.questions = questions
        self.requestedAt = requestedAt
        self.timeoutAt = timeoutAt
    }
}

/// One answer in POST /runs/:id/interactions/:id/answer.
public struct InteractionAnswerPayload: Codable, Sendable, Equatable {
    public let questionId: String
    public let selectedLabels: [String]
    public let freeText: String?

    public init(questionId: String, selectedLabels: [String], freeText: String? = nil) {
        self.questionId = questionId
        self.selectedLabels = selectedLabels
        self.freeText = freeText
    }
}

public struct InteractionAnswerResponse: Codable, Sendable, Equatable {
    public let accepted: Bool
    public let status: String
    public let message: String?
}

public struct RunDetail: Codable, Sendable, Equatable {
    public let summary: RunSummary
    /// Highest event seq reflected in this snapshot — subscribe to the event
    /// stream from this cursor (snapshot-then-subscribe, no gaps, no dupes).
    public let lastSeq: Int
    public let artifacts: [ArtifactInfo]
    public let primaryOutput: PrimaryOutput?
    public let timeline: [TimelineEvent]
    public let budget: BudgetSnapshot?
    public let finalSummary: String?
    public let decision: JSONValue?
    public let workProduct: JSONValue?
    public let reviewFindings: [JSONValue]
    public let pendingInteractions: [PendingInteraction]
    public let failure: RunFailureInfo?

    enum CodingKeys: String, CodingKey {
        case summary, lastSeq, artifacts, primaryOutput, timeline, budget, finalSummary, decision, workProduct, reviewFindings, pendingInteractions, failure
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = try c.decode(RunSummary.self, forKey: .summary)
        lastSeq = try c.decodeIfPresent(Int.self, forKey: .lastSeq) ?? 0
        artifacts = try c.decodeIfPresent([ArtifactInfo].self, forKey: .artifacts) ?? []
        primaryOutput = try c.decodeIfPresent(PrimaryOutput.self, forKey: .primaryOutput)
        timeline = try c.decodeIfPresent([TimelineEvent].self, forKey: .timeline) ?? []
        budget = try c.decodeIfPresent(BudgetSnapshot.self, forKey: .budget)
        finalSummary = try c.decodeIfPresent(String.self, forKey: .finalSummary)
        decision = try c.decodeIfPresent(JSONValue.self, forKey: .decision)
        workProduct = try c.decodeIfPresent(JSONValue.self, forKey: .workProduct)
        reviewFindings = try c.decodeIfPresent([JSONValue].self, forKey: .reviewFindings) ?? []
        pendingInteractions = try c.decodeIfPresent([PendingInteraction].self, forKey: .pendingInteractions) ?? []
        failure = try c.decodeIfPresent(RunFailureInfo.self, forKey: .failure)
    }
}

public struct HarnessStatus: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let status: String
    public let manifest: JSONValue?
    public let enabledIntents: [String]
    public let disabledIntents: [String]
    public let checks: [HarnessCheck]
    public let reasons: [String]?

    enum CodingKeys: String, CodingKey {
        case id, status, manifest, enabledIntents, disabledIntents, checks, reasons
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(String.self, forKey: .status)
        manifest = try c.decodeIfPresent(JSONValue.self, forKey: .manifest)
        enabledIntents = try c.decodeIfPresent([String].self, forKey: .enabledIntents) ?? []
        disabledIntents = try c.decodeIfPresent([String].self, forKey: .disabledIntents) ?? []
        checks = try c.decodeIfPresent([HarnessCheck].self, forKey: .checks) ?? []
        reasons = try c.decodeIfPresent([String].self, forKey: .reasons)
    }
}

public struct HarnessCheck: Codable, Sendable, Equatable {
    public let id: String
    public let status: String
    public let detail: String?
}

public struct HarnessListResponse: Codable, Sendable {
    public let harnesses: [HarnessStatus]
}

public struct HarnessSetupRequest: Codable, Sendable, Equatable {
    public let harness: String
    public let action: String

    public init(harness: String, action: String = "login") {
        self.harness = harness
        self.action = action
    }
}

public struct HarnessSetupResponse: Codable, Sendable, Equatable {
    public let harness: String
    public let action: String
    public let status: String
    public let command: String?
    public let guideUrl: String?
    public let logPath: String?
    public let message: String
}

public struct SetupJobCreateRequest: Codable, Sendable, Equatable {
    public let harness: String
    public let action: String

    public init(harness: String, action: String) {
        self.harness = harness
        self.action = action
    }
}

public struct SetupJob: Codable, Sendable, Equatable {
    public let jobId: String
    public let harness: String
    public let action: String
    public let state: String
    public let command: String?
    public let guideUrl: String?
    public let logPath: String?
    public let message: String
    public let riskFlags: [String]
    public let requiresConfirmation: Bool
    public let createdAt: String
    public let startedAt: String?
    public let firstOutputAt: String?
    public let lastOutputAt: String?
    public let finishedAt: String?
    public let retryCount: Int?
}

public struct SetupJobListResponse: Codable, Sendable, Equatable {
    public let jobs: [SetupJob]
}

public struct SetupJobConfirmRequest: Codable, Sendable, Equatable {
    public let confirmed: Bool

    public init(confirmed: Bool = true) {
        self.confirmed = confirmed
    }
}

public struct SettingsSnapshot: Codable, Sendable, Equatable {
    public let sources: [String]
    public let defaultPortfolio: String
    public let routing: RoutingSettings
    public let budget: BudgetSettings
    public let harnesses: [String: HarnessSettings]?
    /// Wait before an unanswered interactive question declines benignly (ms).
    /// Optional: pre-v0.8 daemons do not report it.
    public let interactionTimeoutMs: Int?
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

public struct HarnessSettings: Codable, Sendable, Equatable {
    public let enabled: Bool
    public let defaultModel: String?
    public let effort: String?
    public let maxTurns: Int?
    public let maxRounds: Int?
    public let maxUsd: Double?
    public let toolsAllow: [String]
    public let toolsDeny: [String]
    public let fallbackModel: String?
    public let web: String
    public let nativeOptions: [String: JSONValue]
}

/// Partial per-harness settings patch; absent fields keep their stored value.
public struct HarnessSettingsPatch: Encodable, Sendable, Equatable {
    public var enabled: Bool?
    public var defaultModel: String??
    public var effort: String??
    public var web: String?

    public init(enabled: Bool? = nil, defaultModel: String?? = nil, effort: String?? = nil, web: String? = nil) {
        self.enabled = enabled
        self.defaultModel = defaultModel
        self.effort = effort
        self.web = web
    }

    enum CodingKeys: String, CodingKey { case enabled, defaultModel, effort, web }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(enabled, forKey: .enabled)
        // Double-optional: .some(nil) encodes an explicit JSON null (= clear override).
        if let defaultModel { try c.encode(defaultModel, forKey: .defaultModel) }
        if let effort { try c.encode(effort, forKey: .effort) }
        try c.encodeIfPresent(web, forKey: .web)
    }
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
    public var interactionTimeoutMs: Int?
    public var harnesses: [String: HarnessSettingsPatch]?

    public init(defaultPortfolio: String? = nil, routingPolicy: String? = nil,
                primaryHarness: String? = nil, defaultModel: String? = nil,
                eligibleHarnesses: [String]? = nil, envInheritance: String? = nil,
                maxUsdPerRun: Double? = nil, maxUsdPerDay: Double? = nil,
                clearMaxUsdPerRun: Bool = false, clearMaxUsdPerDay: Bool = false,
                interactionTimeoutMs: Int? = nil,
                harnesses: [String: HarnessSettingsPatch]? = nil) {
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
        self.interactionTimeoutMs = interactionTimeoutMs
        self.harnesses = harnesses
    }

    enum CodingKeys: String, CodingKey {
        case defaultPortfolio, routingPolicy, primaryHarness, defaultModel, eligibleHarnesses, envInheritance, maxUsdPerRun, maxUsdPerDay, clearMaxUsdPerRun, clearMaxUsdPerDay, interactionTimeoutMs, harnesses
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
        try c.encodeIfPresent(interactionTimeoutMs, forKey: .interactionTimeoutMs)
        try c.encodeIfPresent(harnesses, forKey: .harnesses)
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
