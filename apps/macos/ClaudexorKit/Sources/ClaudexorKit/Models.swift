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
    /// Caller-created service directories an Agent run may also write
    /// (`execution.auxiliaryWritableRoots`); nil is omitted on the wire.
    public var auxiliaryWritableRoots: [String]?

    public init(isolation: String = "envelope", auxiliaryWritableRoots: [String]? = nil) {
        self.isolation = isolation
        self.auxiliaryWritableRoots = auxiliaryWritableRoots
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
    /// Optional internal model-review intent; explicit panels also enable review.
    public var review: Bool?
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
                review: Bool? = nil, reviewerPanel: [ReviewerPanelEntry]? = nil,
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
        self.review = review
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


public struct RunSummary: Codable, Sendable, Identifiable, Equatable {
    public let jobId: String?
    public let runId: String
    public let taskId: String?
    public let state: String
    /// General server-owned run lineage (retry/follow-up/delegation).
    public let parentRunId: String?
    /// Narrow Delegate provenance: only the Claudexor belt sets it (native vendor subagents never do).
    public let delegatedFromRunId: String?
    /// Requested/effective/used Delegate facts for the run.
    public let delegation: RunDelegationInfo?
    public let runDir: String?
    public let error: String?
    public let failure: RunFailureInfo?
    public let project: RunProjectInfo?
    /// Where file references resolve (a delegated run's caller-owned workspace); identity stays `project`.
    public let executionRoot: String?
    public let mode: String?
    public let strategy: String? // v0.9 engine strategy flag (race/attempts/until_clean/swarm/create)
    public let prompt: String?
    public let harnesses: [String]?
    public let primaryHarness: String?
    public let routingGoal: String?
    public let model: String?
    public let review: Bool?
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
    /// Native web/access controls prepared for each route (#118/#413); nil from older engines.
    public let routeControls: [RouteControlInfo]?
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
    /// True while questions are pending and every one is async: the agent keeps
    /// working and the questions are attention only. False when none is pending
    /// or any pending question is blocking. Nil from older engines, read as false.
    public let asyncQuestionsOnly: Bool?
    public let route: RouteInfo?
    /// Auth route receipt incl. requested-vs-observed model mismatch (W10/W20).
    public let authRoute: RunAuthRoute?
    /// Size of the raw-api request the final attempt last prepared (#147); nil otherwise.
    public let rawContext: RawContextReceiptInfo?
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
    /// Retrieval-proof strength: `verified` when a typed result shows a retrieval,
    /// `dispatched` when a web call completed without one, `none` when no search or
    /// page retrieval was observed. Nil from older engines, never read as verified.
    public let verification: String?
    /// What a verified result returned: `page` or `search_results` (a search, not a
    /// fetched page). Nil when nothing was verified or the engine did not record it.
    public let verifiedContent: String?
    /// What the evidence covers (tool calls; network not measured); nil when unrecorded.
    public let observation: WebObservation?
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

/// Budget snapshot for a run (v3): the tagged cash cap, spend, and provenance.
/// `paidBudget` replaces the old flat `maxUsd` — the cap is `.finite`/`.unlimited`.
public struct BudgetSnapshot: Codable, Sendable, Equatable {
    public let paidBudget: PaidBudget
    public let cashKnowledge: String?
    /// CASH spend so far in USD; null when unknown.
    public let spendUsd: Double?
    /// The part of cash the finite cap governs (settled amounts on routes Claudexor
    /// controls); null when that cash is unknown. Known while `spendUsd` is nil when an
    /// included subscription reports no actual debit, so the total is unknown beside it.
    public let controllableSpendUsd: Double?
    /// Subscription VALUATION in USD (QA-023c): what this run's native-subscription
    /// work would approximately have cost by token valuation, accumulated separately
    /// from real billed cash. Nil when no valuation is known — an UNKNOWN valuation
    /// stays nil and is NEVER coerced to a fake $0.
    public let valuationUsd: Double?
    /// Confidence of `valuationUsd`: `exact` (natively priced), `estimated`
    /// (token-derived), or `unknown` (no usage reported — `valuationUsd` is then nil).
    public let valuationKnowledge: String
    /// Remaining finite cap after `controllableSpendUsd`; null when no cap or unknown.
    public let remainingUsd: Double?
    /// True when settled cash is estimated rather than exact. Subscription
    /// valuation confidence lives separately in `valuationKnowledge`.
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
                evidence: String = "complete", cashKnowledge: String? = nil,
                controllableSpendUsd: Double? = nil) {
        self.paidBudget = paidBudget
        self.cashKnowledge = cashKnowledge
        self.spendUsd = cashKnowledge == "unknown" ? nil : spendUsd
        self.controllableSpendUsd = controllableSpendUsd
        self.valuationUsd = valuationUsd
        self.valuationKnowledge = valuationKnowledge
        self.remainingUsd = remainingUsd
        self.estimated = estimated
        self.source = source
        self.evidence = evidence
    }

    enum CodingKeys: String, CodingKey {
        case paidBudget, spendUsd, controllableSpendUsd, valuationUsd, valuationKnowledge,
             remainingUsd, estimated, source, evidence, cashKnowledge
    }

    // Legacy defaults mirror ControlBudgetSnapshot; explicit unknown cash stays nil.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paidBudget = try c.decode(PaidBudget.self, forKey: .paidBudget)
        cashKnowledge = try c.decodeIfPresent(String.self, forKey: .cashKnowledge)
        spendUsd = cashKnowledge == "unknown" ? nil : try c.decodeIfPresent(Double.self, forKey: .spendUsd)
        // Older engines omit it: absent stays nil (never copied from the total).
        controllableSpendUsd = try c.decodeIfPresent(Double.self, forKey: .controllableSpendUsd) ?? nil
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

// User-level trust wire models (TrustEntry / list / update) live in
// TrustModels.swift.

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

    /// The engine's typed refusal of an interaction answer. The daemon sends every
    /// HTTP error as a `ControlProblem`, so the refused reply's `accepted` and
    /// `status` ride in `context` and its reason is the problem's `message`. Nil
    /// for any other failure of the answer request.
    public var interactionAnswerRefusal: InteractionAnswerResponse? {
        guard let problem = controlProblem,
              problem.context["accepted"]?.boolValue == false,
              let status = problem.context["status"]?.stringValue,
              !status.isEmpty
        else { return nil }
        return InteractionAnswerResponse(accepted: false, status: status, message: problem.message)
    }
}
