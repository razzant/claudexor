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

public struct ReviewerPanelEntry: Codable, Sendable, Equatable, Hashable {
    public var harness: String
    public var model: String?
    public var effort: String?

    public init(harness: String, model: String? = nil, effort: String? = nil) {
        self.harness = harness
        self.model = model
        self.effort = effort
    }
}

public struct ProtectedPathApproval: Codable, Sendable, Equatable, Hashable {
    public var path: String
    public var reason: String?

    public init(path: String, reason: String? = nil) {
        self.path = path
        self.reason = reason
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
    public var maxUsd: Double?
    public var access: String?
    public var web: String?
    public var tests: [String]?
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
                primaryHarness: String? = nil, portfolio: String? = nil, model: String? = nil,
                models: [String: String]? = nil,
                reviewerPanel: [ReviewerPanelEntry]? = nil,
                reviewerModels: [String: String]? = nil, reviewerEfforts: [String: String]? = nil,
                n: Int? = nil, maxUsd: Double? = nil, access: String? = nil,
                web: String? = nil,
                tests: [String]? = nil, protectedPathApprovals: [ProtectedPathApproval]? = nil,
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
        self.models = models
        self.reviewerPanel = reviewerPanel
        self.reviewerModels = reviewerModels
        self.reviewerEfforts = reviewerEfforts
        self.n = n
        self.maxUsd = maxUsd
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

// MARK: - Threads (A2 chat/session-first)

public struct ThreadSummary: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String?
    public let repoRoot: String?
    public let mode: String?
    /// in_place (default) mutates the live tree; isolated keeps a thread worktree.
    public let workspaceMode: String?
    public let authPreference: String?
    public let primaryHarness: String?
    /// Sticky eligible pool for the thread (absent on legacy payloads => nil).
    public let eligibleHarnesses: [String]?
    public let state: String?
    public let runIds: [String]
    public let headRunId: String?
    public let needsHuman: Bool
    public let createdAt: String
    public let updatedAt: String
}

/// Honest terminal outcome of a run (projected from work_product.yaml): answers
/// "what did this turn actually do?" — `plan` means a plan, NO files changed.
/// `applyState` decouples honest application from a clean terminal: a winner can be
/// `applied` (live tree mutated AND review clean) or `applied_review_blocked` (mutated
/// but review unconverged — never a green "succeeded"). `revertable` is true while the
/// live mutation can still be safely restored to `preTurnSha` (tree unchanged since).
public struct RunResult: Codable, Sendable, Equatable {
    public struct DiffStat: Codable, Sendable, Equatable {
        public let files: Int
        public let additions: Int
        public let deletions: Int
    }
    public let kind: String          // patch | answer | plan | report | none
    public let diffStat: DiffStat?
    public let blockers: Int
    public let adopted: Bool?
    /// not_applied | applied | applied_review_blocked | reverted.
    public let applyState: String
    /// Tree SHA before this turn mutated the in-place tree (revert restore target).
    public let preTurnSha: String?
    /// Tree SHA right after this turn's mutation (revert divergence fence).
    public let postTurnSha: String?
    /// True when the in-place mutation can still be safely reverted.
    public let revertable: Bool

    enum CodingKeys: String, CodingKey {
        case kind, diffStat, blockers, adopted, applyState, preTurnSha, postTurnSha, revertable
    }

    public init(kind: String, diffStat: DiffStat?, blockers: Int, adopted: Bool?,
                applyState: String = "not_applied", preTurnSha: String? = nil,
                postTurnSha: String? = nil, revertable: Bool = false) {
        self.kind = kind
        self.diffStat = diffStat
        self.blockers = blockers
        self.adopted = adopted
        self.applyState = applyState
        self.preTurnSha = preTurnSha
        self.postTurnSha = postTurnSha
        self.revertable = revertable
    }

    /// Tolerate older runs (and the embedded turn-card payloads) that predate the
    /// honest apply-state fields: default applyState "not_applied", revertable false.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "none"
        diffStat = try c.decodeIfPresent(DiffStat.self, forKey: .diffStat)
        blockers = try c.decodeIfPresent(Int.self, forKey: .blockers) ?? 0
        adopted = try c.decodeIfPresent(Bool.self, forKey: .adopted)
        applyState = try c.decodeIfPresent(String.self, forKey: .applyState) ?? "not_applied"
        preTurnSha = try c.decodeIfPresent(String.self, forKey: .preTurnSha)
        postTurnSha = try c.decodeIfPresent(String.self, forKey: .postTurnSha)
        revertable = try c.decodeIfPresent(Bool.self, forKey: .revertable) ?? false
    }
}

/// Compact run state embedded on a thread turn (so the chat renders without N+1).
public struct TurnRunCard: Codable, Sendable, Equatable {
    public let state: String
    public let mode: String?
    public let strategy: String?
    public let n: Int?
    public let result: RunResult?
    public let spendUsd: Double?
    public let outputReadyState: String?
    public let waitingOnUser: Bool?
    public let finishedAt: String?
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
    /// Set when this turn implements an approved plan from an earlier run.
    public let planRunId: String?
    public let kind: String?
    public let prompt: String
    /// Embedded run card (state + honest outcome) so the chat renders without N+1.
    public let run: TurnRunCard?
    public let createdAt: String
}

public struct ThreadListResponse: Codable, Sendable {
    public let threads: [ThreadSummary]
}

public struct ThreadDetailResponse: Codable, Sendable {
    public let thread: ThreadSummary
    public let sessions: [ThreadSessionInfo]
    public let turns: [ThreadTurnInfo]
    public init(thread: ThreadSummary, sessions: [ThreadSessionInfo], turns: [ThreadTurnInfo]) {
        self.thread = thread
        self.sessions = sessions
        self.turns = turns
    }
}

public struct CreateThreadRequest: Codable, Sendable {
    public var title: String?
    public var scope: RunScope
    public var mode: String?
    /// in_place (default) or isolated — how this thread's turns touch files.
    public var workspace: String?
    public var authPreference: String?
    public var primaryHarness: String?
    /// Sticky eligible harness pool for the thread (turns inherit it when unset).
    public var eligibleHarnesses: [String]?

    public init(title: String? = nil, scope: RunScope = .none, mode: String? = nil,
                workspace: String? = nil, authPreference: String? = nil, primaryHarness: String? = nil,
                eligibleHarnesses: [String]? = nil) {
        self.title = title
        self.scope = scope
        self.mode = mode
        self.workspace = workspace
        self.authPreference = authPreference
        self.primaryHarness = primaryHarness
        self.eligibleHarnesses = eligibleHarnesses
    }
}

/// Body for PATCH /threads/:id — rename, archive (state: active|closed), or switch the
/// sticky primary harness / eligible pool. Encoded only (request body).
public struct UpdateThreadRequest: Encodable, Sendable {
    public var title: String?
    public var state: String?
    /// Double-optional: .some(nil) clears primary back to auto; .none leaves unchanged.
    public var primaryHarness: String??
    public var eligibleHarnesses: [String]?
    public init(title: String? = nil, state: String? = nil,
                primaryHarness: String?? = nil, eligibleHarnesses: [String]? = nil) {
        self.title = title
        self.state = state
        self.primaryHarness = primaryHarness
        self.eligibleHarnesses = eligibleHarnesses
    }

    enum CodingKeys: String, CodingKey { case title, state, primaryHarness, eligibleHarnesses }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(state, forKey: .state)
        // .some(nil) encodes an explicit JSON null (= clear primary to auto).
        if let primaryHarness { try c.encode(primaryHarness, forKey: .primaryHarness) }
        try c.encodeIfPresent(eligibleHarnesses, forKey: .eligibleHarnesses)
    }
}

/// Body for POST /threads/:id/apply — deliver an isolated thread's worktree diff.
public struct ThreadApplyRequest: Codable, Sendable {
    public var mode: String
    public var branch: String?
    public var message: String?
    public init(mode: String = "apply", branch: String? = nil, message: String? = nil) {
        self.mode = mode
        self.branch = branch
        self.message = message
    }
}

public struct ThreadApplyResponse: Codable, Sendable {
    public let applied: Bool
    public let status: String
    public let headMoved: Bool
    public let detail: String?
}

/// Body for POST /threads/:id/turns — a reduced run start anchored by the thread.
/// One inbound attachment on a turn. Mirrors the control `AttachmentInput`:
/// bytes ride base64-inline in `data` for a fresh upload (the daemon decodes
/// them to a scoped file). `kind` is "image" or "file"; `mime` is used for the
/// per-harness serializer. Vision gating reads the harness manifest's
/// `capability_profile.image_input` — never send an image to a `none` harness.
public struct AttachmentInput: Codable, Sendable, Identifiable, Equatable {
    /// Stable-enough identity for SwiftUI chips (NOT encoded — computed).
    public var id: String { "\(name):\(data?.count ?? path?.count ?? 0)" }
    public var kind: String
    public var mime: String
    public var name: String
    public var data: String?
    public var path: String?
    public init(kind: String, mime: String, name: String, data: String? = nil, path: String? = nil) {
        self.kind = kind
        self.mime = mime
        self.name = name
        self.data = data
        self.path = path
    }
}

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
    /// Per-turn primary harness override (bias hint; engine pins it first). When
    /// nil the turn inherits the thread's sticky primary_harness.
    public var primaryHarness: String?
    /// Per-turn scalar model override: expands to the RESOLVED PRIMARY only.
    /// Prefer `models` for anything multi-harness (a race pool).
    public var model: String?
    /// Harness-scoped model map (harness id -> model id) for this turn. Specific
    /// beats general: an entry wins over the scalar and settings defaults.
    public var models: [String: String]?
    /// Explicit reviewer panel for this turn. Mirrors StartRunRequest/control DTO
    /// so thread turns can exercise the same CLI-first review route.
    public var reviewerPanel: [ReviewerPanelEntry]?
    public var reviewerModels: [String: String]?
    public var reviewerEfforts: [String: String]?
    /// Per-turn access profile: readonly | workspace_write | full.
    public var access: String?
    /// Per-turn external-context policy: auto | off | cached | live.
    public var web: String?
    /// Arm the agent-driven browser (Playwright MCP) for this turn. Honored only
    /// for browser-capable harnesses at full access; the engine drops it otherwise.
    public var browser: Bool?
    /// Implement an approved plan from an earlier turn (forces agent mode).
    public var planRunId: String?
    /// Implement a FROZEN spec: the path to the SpecPack file the orchestrator
    /// reads (fails loudly if unreadable). Carried by an Implement-spec turn.
    public var specPath: String?
    /// Files/images attached to this turn (bytes ride base64-inline in each
    /// AttachmentInput.data; the daemon resolves them to scoped paths).
    public var attachments: [AttachmentInput]?
    /// Optional per-turn gate/test command list; mirrors ControlRunStartRequest.
    public var tests: [String]?
    /// Typed approvals for protected gate/test path changes; never inferred from prompt text.
    public var protectedPathApprovals: [ProtectedPathApproval]?
    /// Per-turn auth route override; nil inherits the thread setting/server default.
    public var authPreference: String?

    public init(prompt: String, mode: String? = nil, harnesses: [String]? = nil, n: Int? = nil,
                attempts: Int? = nil, untilClean: Bool? = nil, swarm: Bool? = nil, create: Bool? = nil,
                maxUsd: Double? = nil, primaryHarness: String? = nil, model: String? = nil,
                models: [String: String]? = nil,
                reviewerPanel: [ReviewerPanelEntry]? = nil,
                reviewerModels: [String: String]? = nil, reviewerEfforts: [String: String]? = nil,
                access: String? = nil, web: String? = nil, browser: Bool? = nil, planRunId: String? = nil,
                specPath: String? = nil, attachments: [AttachmentInput]? = nil,
                tests: [String]? = nil, protectedPathApprovals: [ProtectedPathApproval]? = nil,
                authPreference: String? = nil) {
        self.prompt = prompt
        self.mode = mode
        self.harnesses = harnesses
        self.n = n
        self.attempts = attempts
        self.untilClean = untilClean
        self.swarm = swarm
        self.create = create
        self.maxUsd = maxUsd
        self.primaryHarness = primaryHarness
        self.model = model
        self.models = models
        self.reviewerPanel = reviewerPanel
        self.reviewerModels = reviewerModels
        self.reviewerEfforts = reviewerEfforts
        self.access = access
        self.web = web
        self.browser = browser
        self.planRunId = planRunId
        self.specPath = specPath
        self.attachments = attachments
        self.tests = tests
        self.protectedPathApprovals = protectedPathApprovals
        self.authPreference = authPreference
    }
}

// MARK: - SPEC-FLOW (server-owned interview: questions -> answers -> freeze)

/// Body for POST /spec/questions — run the grounding plan synchronously and
/// extract the open-questions interview. Mirrors ControlSpecQuestionsRequest
/// (the server .strict()-parses it; scope must be a project root).
/// One already-answered decision carried into a deeper interview tier so the
/// server asks the NEXT layer instead of re-asking. Mirrors control priorDecisions.
public struct SpecPriorDecision: Codable, Sendable, Equatable {
    public let question: String
    public let answer: String
    public init(question: String, answer: String) {
        self.question = question
        self.answer = answer
    }
}

public struct SpecQuestionsRequest: Codable, Sendable {
    public var prompt: String
    public var scope: RunScope
    public var harnesses: [String]?
    /// Accumulated prior-tier decisions → the interview goes deeper each round.
    public var priorDecisions: [SpecPriorDecision]?

    public init(prompt: String, scope: RunScope, harnesses: [String]? = nil, priorDecisions: [SpecPriorDecision]? = nil) {
        self.prompt = prompt
        self.scope = scope
        self.harnesses = harnesses
        self.priorDecisions = priorDecisions
    }
}

/// One option of an interview question (id is the wire value an answer carries,
/// label is the human text shown on the chip). Mirrors InterviewOption.
public struct SpecOption: Codable, Sendable, Equatable, Hashable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// One interview "quiz card". `tier` is hierarchical depth (0 = foundational;
/// v1 is single-tier). `kind` is single | multi | text; `allowText` permits a
/// free-text answer in addition to / instead of the options. Mirrors
/// InterviewQuestion (snake_case `allow_text`).
public struct SpecQuestion: Codable, Sendable, Identifiable, Equatable, Hashable {
    public let id: String
    public let tier: Int
    public let prompt: String
    public let kind: String
    public let options: [SpecOption]
    public let allowText: Bool
    public let rationale: String?

    enum CodingKeys: String, CodingKey {
        case id, tier, prompt, kind, options, rationale
        case allowText = "allow_text"
    }

    public init(id: String, tier: Int = 0, prompt: String, kind: String = "single",
                options: [SpecOption] = [], allowText: Bool = false, rationale: String? = nil) {
        self.id = id
        self.tier = tier
        self.prompt = prompt
        self.kind = kind
        self.options = options
        self.allowText = allowText
        self.rationale = rationale
    }

    /// Tolerate payloads that omit defaulted fields (tier/kind/options/allow_text).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tier = try c.decodeIfPresent(Int.self, forKey: .tier) ?? 0
        prompt = try c.decode(String.self, forKey: .prompt)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "single"
        options = try c.decodeIfPresent([SpecOption].self, forKey: .options) ?? []
        allowText = try c.decodeIfPresent(Bool.self, forKey: .allowText) ?? false
        rationale = try c.decodeIfPresent(String.self, forKey: .rationale)
    }
}

/// Response from POST /spec/questions: the grounding plan ran (planRunId/planDir)
/// and produced this interview. Empty `questions` => nothing to ask, freeze directly.
public struct SpecQuestionsResponse: Codable, Sendable {
    public let planRunId: String
    public let planDir: String
    public let questions: [SpecQuestion]
}

/// One answer to an interview question: option ids selected (NOT labels) and/or
/// free text. Mirrors InterviewAnswer (snake_case keys).
public struct SpecAnswer: Codable, Sendable, Equatable {
    public let questionId: String
    public let optionIds: [String]
    public let text: String?

    enum CodingKeys: String, CodingKey {
        case questionId = "question_id"
        case optionIds = "option_ids"
        case text
    }

    public init(questionId: String, optionIds: [String] = [], text: String? = nil) {
        self.questionId = questionId
        self.optionIds = optionIds
        self.text = text
    }
}

/// Body for POST /spec/freeze — assemble + freeze the SpecPack from the grounding
/// plan (planDir or inline plan) and the user's answers. Mirrors
/// ControlSpecFreezeRequest. Unresolved clarifications => the server 400s (the
/// interview refuses to silently guess).
public struct SpecFreezeRequest: Codable, Sendable {
    public var prompt: String
    public var scope: RunScope
    public var planDir: String?
    public var plan: String?
    public var answers: [SpecAnswer]?
    /// Accumulated prior-tier interview decisions, folded into the frozen
    /// SpecPack's decided_tradeoffs so a multi-tier spec keeps every tier.
    public var priorDecisions: [SpecPriorDecision]?

    public init(prompt: String, scope: RunScope, planDir: String? = nil,
                plan: String? = nil, answers: [SpecAnswer]? = nil, priorDecisions: [SpecPriorDecision]? = nil) {
        self.prompt = prompt
        self.scope = scope
        self.planDir = planDir
        self.plan = plan
        self.answers = answers
        self.priorDecisions = priorDecisions
    }
}

/// Response from POST /spec/freeze: the frozen SpecPack. `specPath` is the file an
/// Implement run reads (a bare specId does not load content). `changes` is a
/// section-level diff vs the prior revision (opaque to the UI — count it).
public struct SpecFreezeResponse: Codable, Sendable {
    public let specId: String
    public let specDir: String
    public let specPath: String
    public let specHash: String
    public let changes: [JSONValue]

    enum CodingKeys: String, CodingKey { case specId, specDir, specPath, specHash, changes }

    public init(specId: String, specDir: String, specPath: String, specHash: String, changes: [JSONValue] = []) {
        self.specId = specId
        self.specDir = specDir
        self.specPath = specPath
        self.specHash = specHash
        self.changes = changes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        specId = try c.decode(String.self, forKey: .specId)
        specDir = try c.decode(String.self, forKey: .specDir)
        specPath = try c.decode(String.self, forKey: .specPath)
        specHash = try c.decode(String.self, forKey: .specHash)
        changes = try c.decodeIfPresent([JSONValue].self, forKey: .changes) ?? []
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
    /// v0.9 engine strategy flag on the mode (race/attempts/until_clean/swarm/create).
    public let strategy: String?
    public let prompt: String?
    public let harnesses: [String]?
    public let primaryHarness: String?
    public let portfolio: String?
    public let model: String?
    public let reviewerPanel: [ReviewerPanelEntry]?
    public let protectedPathApprovals: [ProtectedPathApproval]?
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
    public let toolWarningsTotal: Int?
    /// Honest terminal outcome (patch/answer/plan/report/none + diffstat/adopted).
    public let result: RunResult?
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
    /// Clean MIME (e.g. `image/png`, `text/plain`, `application/pdf`) from the
    /// server; lets a gallery render text vs image vs pdf. Absent for directories.
    public let mime: String?
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
    /// Server-persisted operator unblock decision (hash-bound); the apply
    /// affordance derives from THIS, never from local UI state.
    public let operatorDecisionAction: String?

    enum CodingKeys: String, CodingKey {
        case summary, lastSeq, artifacts, primaryOutput, timeline, budget, finalSummary, decision, workProduct, reviewFindings, pendingInteractions, failure, operatorDecision
    }

    private struct OperatorDecisionDto: Codable { let action: String? }

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
        operatorDecisionAction = (try c.decodeIfPresent(OperatorDecisionDto.self, forKey: .operatorDecision))?.action
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(summary, forKey: .summary)
        try c.encode(lastSeq, forKey: .lastSeq)
        try c.encode(artifacts, forKey: .artifacts)
        try c.encodeIfPresent(primaryOutput, forKey: .primaryOutput)
        try c.encode(timeline, forKey: .timeline)
        try c.encodeIfPresent(budget, forKey: .budget)
        try c.encodeIfPresent(finalSummary, forKey: .finalSummary)
        try c.encodeIfPresent(decision, forKey: .decision)
        try c.encodeIfPresent(workProduct, forKey: .workProduct)
        try c.encode(reviewFindings, forKey: .reviewFindings)
        try c.encode(pendingInteractions, forKey: .pendingInteractions)
        try c.encodeIfPresent(failure, forKey: .failure)
        try c.encodeIfPresent(operatorDecisionAction.map { OperatorDecisionDto(action: $0) }, forKey: .operatorDecision)
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
    /// The user's configured per-harness default model, if any.
    public let configuredModel: String?
    /// Strict truth-source verdict for `configuredModel` ("ok"/"rejected" +
    /// actionable message) — the UI renders the doctor's honesty.
    public let configuredModelCheck: HarnessModelCheck?

    enum CodingKeys: String, CodingKey {
        case id, status, manifest, enabledIntents, disabledIntents, checks, reasons, configuredModel, configuredModelCheck
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
        configuredModel = try c.decodeIfPresent(String.self, forKey: .configuredModel)
        configuredModelCheck = try c.decodeIfPresent(HarnessModelCheck.self, forKey: .configuredModelCheck)
    }
}

public struct HarnessModelCheck: Codable, Sendable, Equatable {
    public let status: String
    public let message: String?
}

public struct HarnessCheck: Codable, Sendable, Equatable {
    public let id: String
    public let status: String
    public let detail: String?
}

public struct HarnessListResponse: Codable, Sendable {
    public let harnesses: [HarnessStatus]
}

/// One enumerable model a harness offers. Mirrors the control-api `HarnessModel`
/// (deliberately small: only fields a real `GET /v1/models` enumeration can
/// honestly populate). `label`/`contextWindow` are nullable on the wire.
public struct HarnessModel: Codable, Sendable, Identifiable, Equatable, Hashable {
    public let id: String
    public let label: String?
    public let contextWindow: Int?

    enum CodingKeys: String, CodingKey {
        case id, label
        case contextWindow = "context_window"
    }

    public init(id: String, label: String? = nil, contextWindow: Int? = nil) {
        self.id = id
        self.label = label
        self.contextWindow = contextWindow
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        contextWindow = try c.decodeIfPresent(Int.self, forKey: .contextWindow)
    }
}

/// Models enumerable for one harness (GET /harnesses/:id/models). `source` is
/// honest about provenance: "api" when the adapter implemented a real
/// enumeration, "manifest" reserved for a future manifest list, "none" when the
/// adapter cannot enumerate (the list is then empty).
public struct HarnessModelsResponse: Codable, Sendable, Equatable {
    public let harnessId: String
    public let models: [HarnessModel]
    /// "api" | "manifest" | "none".
    public let source: String
    /// Freshness note for manifest-sourced lists: the vendor CLI version the
    /// known-model hints were last verified against (nil for api/none).
    public let verifiedAgainst: String?

    enum CodingKeys: String, CodingKey { case harnessId, models, source, verifiedAgainst }

    public init(harnessId: String, models: [HarnessModel] = [], source: String, verifiedAgainst: String? = nil) {
        self.harnessId = harnessId
        self.models = models
        self.source = source
        self.verifiedAgainst = verifiedAgainst
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        harnessId = try c.decode(String.self, forKey: .harnessId)
        models = try c.decodeIfPresent([HarnessModel].self, forKey: .models) ?? []
        source = try c.decode(String.self, forKey: .source)
        verifiedAgainst = try c.decodeIfPresent(String.self, forKey: .verifiedAgainst)
    }

    /// True when a truth source exists (STRICT D3: no truth source = the
    /// harness runs its default only; there is no free-text model entry).
    public var canEnumerate: Bool { source != "none" && !models.isEmpty }
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
    public let runtime: RuntimeSettings?
    public let harnesses: [String: HarnessSettings]?
    /// Wait before an unanswered interactive question declines benignly (ms).
    /// Optional: pre-v0.8 daemons do not report it.
    public let interactionTimeoutMs: Int?
}

public struct RoutingSettings: Codable, Sendable, Equatable {
    public let defaultPolicy: String
    public let primaryHarness: String?
    public let eligibleHarnesses: [String]
    public let envInheritance: String
    /// Engine auth route preference: subscription | api_key | auto.
    public let authPreference: String?
}

public struct BudgetSettings: Codable, Sendable, Equatable {
    public let maxUsdPerRun: Double?
}

public struct RuntimeSettings: Codable, Sendable, Equatable {
    public let reviewerTimeoutMs: Int
    public let transientRetry: RuntimeTransientRetrySettings
}

public struct RuntimeTransientRetrySettings: Codable, Sendable, Equatable {
    public let maxRetries: Int
    public let initialDelayMs: Int
    public let maxDelayMs: Int
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
    public let authPreference: String?
}

/// Partial per-harness settings patch; absent fields keep their stored value.
public struct HarnessSettingsPatch: Encodable, Sendable, Equatable {
    public var enabled: Bool?
    public var defaultModel: String??
    public var effort: String??
    public var web: String?
    public var maxUsd: Double??
    public var toolsAllow: [String]?
    public var toolsDeny: [String]?
    public var fallbackModel: String??
    public var maxTurns: Int??
    public var maxRounds: Int??
    public var authPreference: String?

    public init(enabled: Bool? = nil, defaultModel: String?? = nil, effort: String?? = nil, web: String? = nil,
                maxUsd: Double?? = nil, toolsAllow: [String]? = nil, toolsDeny: [String]? = nil,
                fallbackModel: String?? = nil, maxTurns: Int?? = nil, maxRounds: Int?? = nil,
                authPreference: String? = nil) {
        self.enabled = enabled
        self.defaultModel = defaultModel
        self.effort = effort
        self.web = web
        self.maxUsd = maxUsd
        self.toolsAllow = toolsAllow
        self.toolsDeny = toolsDeny
        self.fallbackModel = fallbackModel
        self.maxTurns = maxTurns
        self.maxRounds = maxRounds
        self.authPreference = authPreference
    }

    enum CodingKeys: String, CodingKey {
        case enabled, defaultModel, effort, web, maxUsd, toolsAllow, toolsDeny, fallbackModel, maxTurns, maxRounds, authPreference
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(enabled, forKey: .enabled)
        // Double-optional: .some(nil) encodes an explicit JSON null (= clear override).
        if let defaultModel { try c.encode(defaultModel, forKey: .defaultModel) }
        if let effort { try c.encode(effort, forKey: .effort) }
        try c.encodeIfPresent(web, forKey: .web)
        if let maxUsd { try c.encode(maxUsd, forKey: .maxUsd) }
        try c.encodeIfPresent(toolsAllow, forKey: .toolsAllow)
        try c.encodeIfPresent(toolsDeny, forKey: .toolsDeny)
        if let fallbackModel { try c.encode(fallbackModel, forKey: .fallbackModel) }
        if let maxTurns { try c.encode(maxTurns, forKey: .maxTurns) }
        if let maxRounds { try c.encode(maxRounds, forKey: .maxRounds) }
        try c.encodeIfPresent(authPreference, forKey: .authPreference)
    }
}

public struct SettingsUpdateRequest: Encodable, Sendable, Equatable {
    public var defaultPortfolio: String?
    public var routingPolicy: String?
    /// Double-optional: `.some(nil)` encodes an explicit JSON null = CLEAR the
    /// primary (no `"__none"` sentinel — the server rejects magic strings).
    public var primaryHarness: String??
    public var eligibleHarnesses: [String]?
    public var envInheritance: String?
    public var authPreference: String?
    public var maxUsdPerRun: Double?
    public var clearMaxUsdPerRun: Bool
    public var interactionTimeoutMs: Int?
    public var harnesses: [String: HarnessSettingsPatch]?

    public init(defaultPortfolio: String? = nil, routingPolicy: String? = nil,
                primaryHarness: String?? = nil,
                eligibleHarnesses: [String]? = nil, envInheritance: String? = nil,
                authPreference: String? = nil,
                maxUsdPerRun: Double? = nil,
                clearMaxUsdPerRun: Bool = false,
                interactionTimeoutMs: Int? = nil,
                harnesses: [String: HarnessSettingsPatch]? = nil) {
        self.defaultPortfolio = defaultPortfolio
        self.routingPolicy = routingPolicy
        self.primaryHarness = primaryHarness
        self.eligibleHarnesses = eligibleHarnesses
        self.envInheritance = envInheritance
        self.authPreference = authPreference
        self.maxUsdPerRun = maxUsdPerRun
        self.clearMaxUsdPerRun = clearMaxUsdPerRun
        self.interactionTimeoutMs = interactionTimeoutMs
        self.harnesses = harnesses
    }

    enum CodingKeys: String, CodingKey {
        case defaultPortfolio, routingPolicy, primaryHarness, eligibleHarnesses, envInheritance, authPreference, maxUsdPerRun, clearMaxUsdPerRun, interactionTimeoutMs, harnesses
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(defaultPortfolio, forKey: .defaultPortfolio)
        try c.encodeIfPresent(routingPolicy, forKey: .routingPolicy)
        if let outer = primaryHarness {
            if let value = outer { try c.encode(value, forKey: .primaryHarness) }
            else { try c.encodeNil(forKey: .primaryHarness) }
        }
        try c.encodeIfPresent(eligibleHarnesses, forKey: .eligibleHarnesses)
        try c.encodeIfPresent(envInheritance, forKey: .envInheritance)
        try c.encodeIfPresent(authPreference, forKey: .authPreference)
        try c.encodeIfPresent(maxUsdPerRun, forKey: .maxUsdPerRun)
        if clearMaxUsdPerRun { try c.encode(true, forKey: .clearMaxUsdPerRun) }
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
