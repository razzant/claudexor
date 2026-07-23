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
    /// Context is engine-owned: the schema enum has exactly one member
    /// ("auto"), so the helper does not take a free-string parameter.
    public static func project(root: String) -> RunScope {
        RunScope(kind: "project", root: root, context: "auto")
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
    public var routingGoal: String?
    /// Scalar convenience: expands to the RESOLVED PRIMARY harness only (never
    /// the pool). Prefer `models` for anything multi-harness.
    public var model: String?
    /// Harness-scoped model map (harness id -> model id). Specific beats
    /// general: an entry wins over the scalar `model` and settings defaults.
    public var models: [String: String]?
    public var reviewerPanel: [ReviewerPanelEntry]?
    public var reviewerModels: [String: String]?
    public var reviewerEfforts: [String: String]?
    public var n: Int?
    public var paidBudget: PaidBudget?
    public var access: String?
    public var web: String?
    public var tests: [TestCommandInvocation]?
    public var protectedPathApprovals: [ProtectedPathApproval]?
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
                primaryHarness: String? = nil, routingGoal: String? = nil, model: String? = nil,
                models: [String: String]? = nil,
                reviewerPanel: [ReviewerPanelEntry]? = nil,
                reviewerModels: [String: String]? = nil, reviewerEfforts: [String: String]? = nil,
                n: Int? = nil, paidBudget: PaidBudget? = nil, access: String? = nil,
                web: String? = nil,
                tests: [TestCommandInvocation]? = nil, protectedPathApprovals: [ProtectedPathApproval]? = nil,
                attempts: Int? = nil, untilClean: Bool? = nil, swarm: Bool? = nil, create: Bool? = nil,
                threadId: String? = nil, authPreference: String? = nil) {
        self.prompt = prompt
        self.mode = mode
        self.scope = scope
        self.execution = execution
        self.harnesses = harnesses
        self.primaryHarness = primaryHarness
        self.routingGoal = routingGoal
        self.model = model
        self.models = models
        self.reviewerPanel = reviewerPanel
        self.reviewerModels = reviewerModels
        self.reviewerEfforts = reviewerEfforts
        self.n = n
        self.paidBudget = paidBudget
        self.access = access
        self.web = web
        self.tests = tests
        self.protectedPathApprovals = protectedPathApprovals
        self.attempts = attempts
        self.untilClean = untilClean
        self.swarm = swarm
        self.create = create
        self.threadId = threadId
        self.authPreference = authPreference
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
    /// v0.9 engine strategy flag on the mode (race/attempts/until_clean/swarm/create).
    public let strategy: String?
    public let prompt: String?
    public let harnesses: [String]?
    public let primaryHarness: String?
    public let routingGoal: String?
    public let model: String?
    public let reviewerPanel: [ReviewerPanelEntry]?
    public let protectedPathApprovals: [ProtectedPathApproval]?
    public let n: Int?
    public let paidBudget: PaidBudget?
    public let spendUsd: Double?
    public let spendEstimated: Bool?
    public let access: String?
    public let requestedAccess: String?
    public let effectiveAccess: String?
    public let externalContextPolicy: String?
    public let webRequired: Bool?
    public let webMode: String?
    public let webEvidence: WebEvidence?
    public let requestRequirements: [RequestRequirementResolution]?
    public let outputReadyState: String?
    public let toolWarningsTotal: Int?
    /// Honest terminal outcome (patch/answer/plan/report/none + diffstat/adopted).
    public let result: RunResult?
    /// The v3 terminal truth axes (D8/D18): lifecycle + noChanges + checks +
    /// review + typed reason. Null while the run is not terminal. This is the
    /// SINGLE source the App projects review/checks/apply presentation from —
    /// the wire `state` field is lifecycle ONLY (queued/running/succeeded/
    /// failed/cancelled/interrupted).
    public let outcomeFacts: RunOutcomeFacts?
    /// True while at least one harness question awaits the user's answer.
    public let waitingOnUser: Bool?
    public let route: RouteInfo?
    /// Auth route receipt incl. requested-vs-observed model mismatch (W10/W20).
    public let authRoute: RunAuthRoute?
    public let tests: [TestCommandInvocation]?
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
    /// Clean MIME (e.g. `image/png`, `text/plain`, `application/pdf`) from the
    /// server; lets a gallery render text vs image vs pdf. Absent for directories.
    public let mime: String?
    public var id: String { path }
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

public struct RequestRequirementResolution: Codable, Sendable, Equatable {
    public let capability: String
    public let harnessId: String
    public let eligible: Bool
    public let requested: Bool
    public let effective: Bool
    public let reason: String
    public let evidenceRefs: [String]

    enum CodingKeys: String, CodingKey {
        case capability, eligible, requested, effective, reason
        case harnessId = "harness_id"
        case evidenceRefs = "evidence_refs"
    }
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
    /// Unsupported per-harness knobs the route could NOT honor (INV-105),
    /// disclosed on `harness.started` (e.g. "max_turns=5 (manifest ... =false)").
    /// The row renders warning-shaped with these values, so a requested
    /// safety/behavior limit that was dropped is visible, not silent (QA-070).
    /// Optional so an older daemon that omits the key decodes to nil.
    public let ignoredSettings: [String]?
    public let rawRef: String?

    public init(type: String, ts: String?, harnessId: String?, attemptId: String?,
                title: String, detail: String?, severity: String?, toolName: String?,
                target: String?, errorSummary: String?, ignoredSettings: [String]? = nil,
                rawRef: String?) {
        self.type = type
        self.ts = ts
        self.harnessId = harnessId
        self.attemptId = attemptId
        self.title = title
        self.detail = detail
        self.severity = severity
        self.toolName = toolName
        self.target = target
        self.errorSummary = errorSummary
        self.ignoredSettings = ignoredSettings
        self.rawRef = rawRef
    }
}

/// Budget snapshot for a run (v3): the tagged cash cap, spend, and provenance.
/// `paidBudget` replaces the old flat `maxUsd` — the cap is `.finite`/`.unlimited`.
public struct BudgetSnapshot: Codable, Sendable, Equatable {
    public let paidBudget: PaidBudget
    /// CASH spend so far in USD; null when unknown.
    public let spendUsd: Double?
    /// Subscription VALUATION in USD (QA-023c): what this run's native-subscription
    /// work would approximately have cost by token valuation, accumulated separately
    /// from real billed cash. Nil when no valuation is known — an UNKNOWN valuation
    /// stays nil and is NEVER coerced to a fake $0.
    public let valuationUsd: Double?
    /// Confidence of `valuationUsd`: `exact` (natively priced), `estimated`
    /// (token-derived), or `unknown` (no usage reported — `valuationUsd` is then nil).
    public let valuationKnowledge: String
    /// Remaining budget in USD; null when no cap or unknown spend.
    public let remainingUsd: Double?
    /// True when spend is token-derived rather than natively reported.
    public let estimated: Bool
    /// Where the snapshot came from: decision | events | settings | unknown.
    public let source: String
    /// Integrity of the canonical events this spend fallback read:
    /// `complete` | `incomplete` | `unavailable`.
    public let evidence: String

    /// Convenience projection: the finite USD cap when capped, nil when unlimited.
    public var maxUsd: Double? { paidBudget.finiteMaxUsd }

    /// A displayable subscription valuation: the USD amount only when it is
    /// actually known (`exact`/`estimated`). An `unknown` valuation stays absent
    /// (nil) — never rendered as $0 (QA-023c).
    public var knownValuationUsd: Double? {
        valuationKnowledge == "unknown" ? nil : valuationUsd
    }

    public init(paidBudget: PaidBudget, spendUsd: Double?, remainingUsd: Double?,
                estimated: Bool, source: String,
                valuationUsd: Double? = nil, valuationKnowledge: String = "unknown",
                evidence: String = "complete") {
        self.paidBudget = paidBudget
        self.spendUsd = spendUsd
        self.valuationUsd = valuationUsd
        self.valuationKnowledge = valuationKnowledge
        self.remainingUsd = remainingUsd
        self.estimated = estimated
        self.source = source
        self.evidence = evidence
    }

    enum CodingKeys: String, CodingKey {
        case paidBudget, spendUsd, valuationUsd, valuationKnowledge, remainingUsd,
             estimated, source, evidence
    }

    // Custom decode so a legacy/version-skewed engine that omits the Ф2 valuation
    // and evidence fields defaults them honestly (nil valuation / "unknown" /
    // "complete") instead of failing the whole snapshot decode. Encode stays
    // synthesized and always emits them.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paidBudget = try c.decode(PaidBudget.self, forKey: .paidBudget)
        spendUsd = try c.decodeIfPresent(Double.self, forKey: .spendUsd) ?? nil
        valuationUsd = try c.decodeIfPresent(Double.self, forKey: .valuationUsd) ?? nil
        valuationKnowledge = try c.decodeIfPresent(String.self, forKey: .valuationKnowledge) ?? "unknown"
        remainingUsd = try c.decodeIfPresent(Double.self, forKey: .remainingUsd) ?? nil
        estimated = try c.decodeIfPresent(Bool.self, forKey: .estimated) ?? false
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "unknown"
        evidence = try c.decodeIfPresent(String.self, forKey: .evidence) ?? "complete"
    }
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

// Settings wire models (SettingsSnapshot / HarnessSettings / patches) live in
// SettingsModels.swift.

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

// MARK: - User-level trust (per-repo full-access grants)

/// One per-repo trust file (user-level, outside versioned repo config).
/// `repoRoot` is nil for legacy files written before provenance stamping —
/// those are disclosed as revocable only via `claudexor trust` in the repo.
public struct TrustEntry: Codable, Sendable, Identifiable, Equatable {
    public let repoRoot: String?
    public let path: String
    public let allowFullAccess: Bool
    public let accessDefault: String
    public var id: String { path }
}

public struct TrustListResponse: Codable, Sendable, Equatable {
    public let entries: [TrustEntry]
}

/// NARROW by design: exactly {repoRoot, allowFullAccess} — the only trust
/// field the control surface may write; everything else stays CLI-only.
public struct TrustUpdateRequest: Codable, Sendable, Equatable {
    public let repoRoot: String
    public let allowFullAccess: Bool
    public init(repoRoot: String, allowFullAccess: Bool) {
        self.repoRoot = repoRoot
        self.allowFullAccess = allowFullAccess
    }
}

public enum GatewayError: Error, Sendable, Equatable {
    case http(status: Int, body: String)
    case decoding(String)
    case transport(String)

    /// Shared typed decoder for every RFC-9457-style control-plane failure.
    /// Legacy endpoints may still return older shapes, in which case this is nil.
    public var controlProblem: ControlProblem? {
        guard case .http(_, let body) = self, let data = body.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(ControlProblem.self, from: data)
    }
}
