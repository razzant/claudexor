import ClaudexorKit
import Foundation
import SwiftUI

/// UI-side domain models. These render the engine-service state read via `GatewayClient`.
/// The canonical shapes live in `packages/schema`; these are the minimal projections
/// the views display.

// MARK: - Connection

enum Health: Equatable {
    case connecting, connected, offline
    var label: String {
        switch self {
        case .connecting: return "Connecting"
        case .connected: return "Connected"
        case .offline: return "Offline"
        }
    }
    var glyph: String {
        switch self {
        case .connecting: return "dot.radiowaves.left.and.right"
        case .connected: return "bolt.horizontal.circle.fill"
        case .offline: return "bolt.slash"
        }
    }
}

// MARK: - Auth sheet target

/// What the shared `AuthSheet` is opened for: a harness's default login, or a
/// specific credential profile's login (INV-135). Presented model-level (via
/// `AppModel.authSheetTarget`) so it survives the accounts popover dismissing.
struct AuthSheetTarget: Identifiable, Hashable {
    let family: HarnessFamily
    var profileId: String? = nil
    /// D-17: open the sheet AND immediately start the native login (the
    /// "Add & log in" / account-row one-action flow). The sheet consumes this
    /// once on appear so a manual reopen never re-triggers a login.
    var autoStartLogin: Bool = false
    var id: String { profileId.map { "\(family.rawValue)#\($0)" } ?? family.rawValue }
}

// MARK: - Harness families

struct HarnessFamily: RawRepresentable, Identifiable, Hashable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let codex = Self(rawValue: "codex")
    static let claude = Self(rawValue: "claude")
    static let cursor = Self(rawValue: "cursor")
    static let opencode = Self(rawValue: "opencode")
    static let copilot = Self(rawValue: "copilot")
    static let agy = Self(rawValue: "agy")
    static let raw = Self(rawValue: "raw-api")
    /// The openrouter raw-API instance (registry.ts `createRawApiAdapter({ id: "openrouter" })`): a second api-key
    /// meta-host, not a built-in family row — it renders only when its key is configured and the daemon lists it live.
    static let openrouter = Self(rawValue: "openrouter")
    static let fake = Self(rawValue: "fake")
    static let builtIns: [Self] = [.codex, .claude, .cursor, .opencode, .copilot, .agy, .raw]
    var id: String { rawValue }

    /// Human-facing family names; anything else title-cases its rawValue. The
    /// vendor brands the PRODUCT "Antigravity" — `agy` is only its binary.
    private static let labels = [
        "codex": "Codex", "claude": "Claude", "cursor": "Cursor", "opencode": "OpenCode",
        "agy": "Antigravity", "grok": "Grok Build", "copilot": "GitHub Copilot", "raw-api": "Raw API", "openrouter": "OpenRouter", "fake": "Fake",
    ]
    var label: String {
        Self.labels[rawValue] ?? rawValue.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }
    // Vendor iconography is owned solely by `HarnessIcon` (M9-UX item 5): a real
    // brand mark where we ship one, else ONE shared generic glyph. No per-family
    // SF-Symbol placeholder lives on the model any more.
    var color: Color { Theme.harness(rawValue) }
    /// Setup and runtime use the same canonical harness id. The retired `raw`
    /// alias must never reappear at a client boundary.
    var setupHarnessId: String { rawValue }

    var defaultAuthReadinessRequest: AuthReadinessRefreshRequest? {
        if self == .codex || self == .claude || self == .cursor {
            AuthReadinessRefreshRequest(authRequest: .subscription, source: .nativeSession)
        } else if self == .opencode || self == .copilot || self == .raw || self == .openrouter {
            AuthReadinessRefreshRequest(authRequest: .apiKey, source: .apiKeyEnvironment)
        } else {
            nil
        }
    }

    var apiKeyAuthReadinessRequest: AuthReadinessRefreshRequest? {
        if self == .codex {
            AuthReadinessRefreshRequest(authRequest: .apiKey, source: .providerAuthFile)
        } else if self == .claude || self == .cursor || self == .opencode || self == .copilot || self == .raw || self == .openrouter {
            AuthReadinessRefreshRequest(authRequest: .apiKey, source: .apiKeyEnvironment)
        } else {
            nil
        }
    }

    func authReadinessRequest(after job: SetupJob?) -> AuthReadinessRefreshRequest? {
        if let disclosure = job?.authCapability?.disclosure {
            return AuthReadinessRefreshRequest(
                authRequest: disclosure.requested,
                source: disclosure.requiredSource
            )
        }
        return defaultAuthReadinessRequest
    }
}

/// The run LIFECYCLE (D8), the ONLY axis derived from the server run `state`.
/// This replaces the old `RunStatus` presentation enum: the six wire lifecycle
/// values plus an `unknown` sentinel used only when a stream is lost before a
/// terminal frame. Outcome quality — checks / review / delivery / typed reason —
/// is ORTHOGONAL and lives on `RunOutcomeFacts`; the presentation mappers read
/// those axes, never a mixed status enum. `isActive`/`isTerminal` drive the
/// streaming state machine.
enum RunPhase: String, CaseIterable, Identifiable, Hashable {
    case queued, running, succeeded, failed, cancelled, interrupted, unknown
    var id: String { rawValue }

    /// Map a wire lifecycle string. The v3 server `state` emits exactly the six
    /// lifecycle values; the aliases keep older dogfood artifacts and typed
    /// terminal reasons (crash_interrupted) decoding to the right phase.
    init(api: String) {
        switch api.lowercased() {
        case "queued", "pending": self = .queued
        case "running", "active", "in_progress": self = .running
        case "succeeded", "success", "done", "completed", "ok": self = .succeeded
        case "failed", "error": self = .failed
        case "cancelled", "canceled": self = .cancelled
        case "interrupted", "interrupted_unknown", "crash_interrupted": self = .interrupted
        default: self = .unknown
        }
    }

    /// The lifecycle word (D8 UI labels). Outcome nuance ("Done · not verified",
    /// "Needs review") is composed by `OutcomePresentation`, not baked here.
    var label: String {
        switch self {
        case .queued: return "Queued"
        case .running: return "Working"
        case .succeeded: return "Done"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .interrupted: return "Interrupted"
        case .unknown: return "Unknown"
        }
    }
    var glyph: String {
        switch self {
        case .queued: return "clock"
        case .running: return "circle.dotted"
        case .succeeded: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .cancelled: return "slash.circle"
        case .interrupted: return "pause.circle"
        case .unknown: return "questionmark.diamond"
        }
    }
    var tone: StatusTone {
        switch self {
        case .queued: return .queued
        case .running: return .info
        case .succeeded: return .positive
        case .failed: return .negative
        case .cancelled: return .neutral
        case .interrupted: return .interrupted
        case .unknown: return .neutral
        }
    }
    var color: Color { Theme.status(tone) }
    var isActive: Bool { self == .running || self == .queued }
    var isTerminal: Bool { !isActive && self != .unknown }
    /// A failure-shaped terminal: the lifecycle itself ended badly (a `.reason`
    /// on `RunOutcomeFacts` further qualifies it). Cancelled is NOT failure.
    var isFailureShaped: Bool { self == .failed || self == .interrupted || self == .unknown }
}

/// Human label for a typed terminal `RunReason` (RunOutcomeFacts.reason), projected
/// verbatim from the engine and never composed client-side beyond this display mapping.
enum RunReasonLabel {
    static func label(_ reason: String?) -> String? {
        switch reason {
        case "harness_failed": return "Harness failed"
        case "no_changes": return "No changes"
        case "review_blocked": return "Review blocked"
        case "checks_failed": return "Checks failed"
        case "budget_exhausted": return "Exhausted"
        case "budget_overshoot": return "Budget overshot"
        case "cost_unverifiable": return "Cost unverifiable"
        case "not_converged": return "Not converged"
        case "stuck_no_progress": return "Stuck/no progress"
        case "workspace_unavailable": return "Workspace unavailable"
        case "capture_refused": return "Changes not captured"
        case "wall_clock_exceeded": return "Time limit reached"
        case "crash_interrupted": return "Interrupted"
        case "user_cancelled": return "Cancelled"
        default: return nil
        }
    }
    /// The tone a failure-shaped reason should carry (budget overshoot/exhaust
    /// reads as an orange warning; everything else inherits the phase tone).
    static func tone(_ reason: String?) -> StatusTone? {
        switch reason {
        case "budget_exhausted", "budget_overshoot": return .warn
        default: return nil
        }
    }
}
enum RunMode: String, CaseIterable, Identifiable, Hashable {
    case ask, agent, bestOfN, maxAttempts, untilClean, plan, create, readOnlyAudit, unknown
    var id: String { rawValue }
    static var allCases: [RunMode] {
        [.ask, .agent, .bestOfN, .maxAttempts, .untilClean, .plan, .create, .readOnlyAudit]
    }

    /// The wire MODE (v3: three intents — Ask/Plan/Agent — with strategies as
    /// flags, see `strategyFlags`). The remaining enum cases (Best-of / Create /
    /// …) are DISPLAY/strategy projections of `agent`|`audit`, kept so historical
    /// runs render and the composer's pool/`n` logic is unchanged. The retired
    /// `explore`/`orchestrate` aliases were removed in v3 (D30).
    var apiValue: String {
        switch self {
        case .ask: return "ask"
        case .readOnlyAudit: return "audit"
        case .agent, .bestOfN, .maxAttempts, .untilClean, .create: return "agent"
        case .plan: return "plan"
        case .unknown: return "unknown"
        }
    }

    /// v0.9 strategy flags accompanying `apiValue` on a run start request.
    var strategyFlags: (untilClean: Bool, swarm: Bool, create: Bool, defaultN: Int?) {
        switch self {
        case .bestOfN: return (false, false, false, 2)
        case .untilClean: return (true, false, false, nil)
        case .create: return (false, false, true, nil)
        default: return (false, false, false, nil)
        }
    }

    /// Display mode derived from the wire (mode, strategy) pair — `agent --n`
    /// renders as Best-of-N, etc.
    init(apiValue: String?, strategy: String?) {
        switch (apiValue, strategy) {
        case ("agent", "race"): self = .bestOfN
        case ("agent", "attempts"): self = .maxAttempts
        case ("agent", "until_clean"): self = .untilClean
        case ("agent", "create"): self = .create
        default: self = RunMode(apiValue: apiValue)
        }
    }

    init(apiValue: String?) {
        switch apiValue {
        case "ask": self = .ask
        case "agent": self = .agent
        case "plan": self = .plan
        case "audit": self = .readOnlyAudit
        // Legacy ids from pre-v0.9 dogfood artifacts decode leniently for
        // DISPLAY only (the engine hard-errors on them at run time).
        case "best_of_n": self = .bestOfN
        case "max_attempts": self = .maxAttempts
        case "until_clean": self = .untilClean
        case "create": self = .create
        case "readonly_audit": self = .readOnlyAudit
        default: self = .unknown
        }
    }
    var label: String {
        switch self {
        case .ask: return "Ask"
        case .agent: return "Agent"
        case .bestOfN: return "Best-of-N"
        case .maxAttempts: return "Max Attempts"
        case .untilClean: return "Until Clean"
        case .plan: return "Plan"
        case .create: return "Create"
        case .readOnlyAudit: return "Read-only Audit"
        case .unknown: return "Unknown Mode"
        }
    }
    var glyph: String {
        switch self {
        case .ask: return "questionmark.bubble"
        case .agent: return "bolt.fill"
        case .bestOfN: return "flag.checkered.2.crossed"
        case .maxAttempts: return "repeat"
        case .untilClean: return "arrow.triangle.2.circlepath"
        case .plan: return "list.bullet.clipboard"
        case .create: return "plus.square.on.square"
        case .readOnlyAudit: return "magnifyingglass"
        case .unknown: return "exclamationmark.triangle"
        }
    }
    var isMultiCandidate: Bool { self == .bestOfN }
    var isReadOnly: Bool { self == .ask || self == .plan || self == .readOnlyAudit }
    var requiresProject: Bool { self != .ask }
    var requiredIntent: String {
        switch self {
        case .ask: return "explain"
        case .plan: return "plan"
        case .readOnlyAudit: return "audit"
        case .create: return "create_from_scratch"
        case .unknown: return "implement"
        default: return "implement"
        }
    }
}

// MARK: - Per-turn composer options ("⋯")

/// UI-side bag of per-turn knobs the composer's "⋯" panel collects. These map
/// onto fields that already exist on the engine's run-start request (budget cap,
/// access, web policy, agent repair strategies) — NOT new UI-only semantics.
/// primary/pool are NOT here: they are sticky on the thread (PATCHed separately).
struct TurnOptions: Equatable {
    static let singleDefaultAttempts = 3

    var maxUsd: Double? = nil
    var access: String? = nil          // AccessProfile.wire
    var web: String? = nil             // auto | off | cached | live
    var untilClean: Bool = false
    var maxAttempts: Int? = TurnOptions.singleDefaultAttempts
    /// Agent delegation belt (D32); agent-only. Sent as `delegate` on the turn.
    var delegate: Bool = false
    /// Plan council (D31); plan-only. Sent as `council`; `councilN` sets width.
    var council: Bool = false
    var councilN: Int? = nil
    var browser: Bool = false          // arm the agent-driven browser; access stays independent
    /// Harness-scoped per-turn models (harness id -> model id). Built by the
    /// composer's per-harness pickers; empty entries are dropped before send.
    var models: [String: String] = [:]
    /// Ordinary Agent skips internal model review; explicit strategies/panels enable it.
    var review: Bool = false
    var reviewerPanel: [ReviewerPanelEntry]? = nil
    var protectedPathApprovals: [ProtectedPathApproval]? = nil
    /// QA-010: optional deterministic gate command(s) the operator authorizes for
    /// THIS turn (Create especially — the project's test script does not exist
    /// until the run scaffolds it). Rides the run-start request's typed `tests`
    /// field so it becomes a post-candidate acceptance gate, never inferred from
    /// prompt text. Empty = no deterministic checks configured.
    var tests: [TestCommandInvocation] = []
    /// Per-turn auth route REQUEST ("subscription" | "api_key"); nil = auto /
    /// inherit the thread preference. The effective route is a post-run receipt.
    var authRoute: String? = nil
    /// Per-turn reasoning effort from the primary harness's declared ladder;
    /// nil = harness default (the control hides when the ladder is empty).
    var effort: String? = nil
    /// D17: override the server's plan-readiness gate. Set ONLY by the explicit,
    /// destructive-style "Implement anyway" action when open plan questions/
    /// blockers remain — the engine otherwise refuses implement with 409.
    var overridePlanReadiness: Bool = false
}

// MARK: - Agent plan / todo list (the "task list" Codex & Claude Code surface)

enum PlanItemState: String, Hashable {
    case pending, active, done, blocked
    var glyph: String {
        switch self {
        case .pending: return "circle"
        case .active: return "circle.dotted"
        case .done: return "checkmark.circle.fill"
        case .blocked: return "exclamationmark.circle.fill"
        }
    }
    var color: Color {
        switch self {
        case .pending: return .secondary
        case .active: return Theme.status(.info)
        case .done: return Theme.status(.positive)
        case .blocked: return Theme.status(.caution)
        }
    }
}

struct PlanItem: Identifiable, Hashable {
    let id: String
    var title: String
    var state: PlanItemState
    var note: String?
    init(id: String = UUID().uuidString, _ title: String, _ state: PlanItemState, note: String? = nil) {
        self.id = id; self.title = title; self.state = state; self.note = note
    }
}

// MARK: - Activity transcript

enum ActivityKind: String, Hashable {
    case thinking, tool, file, message, gate, review, system
    var glyph: String {
        switch self {
        case .thinking: return "brain"
        case .tool: return "wrench.and.screwdriver"
        case .file: return "doc.badge.gearshape"
        case .message: return "text.bubble"
        case .gate: return "checklist"
        case .review: return "person.2"
        case .system: return "gearshape"
        }
    }
    // Restrained: brand for the agent's own actions, status hues for gate/review,
    // neutral for ambient chatter. No arbitrary rainbow.
    var tint: Color {
        switch self {
        case .thinking: return .secondary
        case .tool: return Theme.accent
        case .file: return Theme.accent
        case .message: return .secondary
        case .gate: return Theme.status(.positive)
        case .review: return Theme.status(.attention)
        case .system: return .secondary
        }
    }
}

struct ActivityEvent: Identifiable, Hashable {
    let id: String
    var kind: ActivityKind
    var harness: HarnessFamily?
    var title: String
    var detail: String?
    /// Engine-typed severity ("info" | "warning" | "error") used to tint rows.
    var severity: String?
    var code: String?
    var timestamp: Date
    init(id: String = UUID().uuidString, _ kind: ActivityKind, harness: HarnessFamily? = nil,
         _ title: String, detail: String? = nil, severity: String? = nil, code: String? = nil, at: Date = .now) {
        self.id = id; self.kind = kind; self.harness = harness; self.title = title
        self.detail = detail; self.severity = severity; self.code = code; self.timestamp = at
    }
}

// MARK: - Candidates

enum ReviewState: String, Hashable {
    case pending, clean, changesRequested, winner, rejected
    var label: String {
        switch self {
        case .pending: return "Reviewing"
        case .clean: return "Clean"
        case .changesRequested: return "Changes requested"
        case .winner: return "Winner"
        case .rejected: return "Rejected"
        }
    }
    var color: Color {
        switch self {
        case .pending: return Theme.status(.info)
        case .clean: return Theme.status(.positive)
        case .changesRequested: return Theme.status(.caution)
        case .winner: return Theme.accent
        case .rejected: return Theme.status(.negative)
        }
    }
}

struct Candidate: Identifiable, Hashable {
    let id: String
    var family: HarnessFamily
    var status: RunPhase
    var costUsd: Double
    var estimated: Bool
    var gatesPassed: Int
    var gatesTotal: Int
    var reviewState: ReviewState
    var reviewVerified: Bool = false
    var finalReviewClean: Bool? = nil
    var summary: String
    var isSynthesis: Bool = false
    var filesChanged: Int = 0
    var added: Int = 0
    var removed: Int = 0
    /// False when the candidate has no line counts (no rendered patch): unknown is not zero.
    var hasLineCounts: Bool = true
}

// MARK: - Task (a run)
struct TaskRun: Identifiable, Hashable {
    let id: String
    /// Canonical server run id after an optimistic queued job-id alias binds.
    /// `id` stays stable for SwiftUI identity during the in-flight detail load.
    var resolvedRunId: String? = nil
    var title: String
    var prompt: String
    var mode: RunMode
    /// Process lifecycle (D8); outcome quality comes from `outcomeFacts` and review verdict.
    var phase: RunPhase
    var project: String
    var harnesses: [HarnessFamily]
    var n: Int
    var createdAt: Date
    var updatedAt: Date
    /// Mutable review progress/legacy fallback; terminal facts determine the effective verdict first.
    var reviewVerdict: ReviewVerdict = .notRun
    var retryStatus: RetryStatusNote?  // latest typed transient status (W-C2/sol #6); cleared on progress
    var spendUsd: Double
    var capUsd: Double
    var spendKnown: Bool = true
    var capKnown: Bool = true
    var budgetUnlimited: Bool = false
    var spendEstimated: Bool = false
    var controllableSpendUsd: Double? // cap-governed cash; nil = unknown, may be known while `spendKnown` is false
    /// Subscription token valuation (QA-023c), separate from cash; nil is unknown, never $0.
    var valuationUsd: Double?
    var routeProof: RouteProof
    var attentionNote: String?
    var plan: [PlanItem]
    var activity: [ActivityEvent]
    var candidates: [Candidate]
    var findings: [Finding]
    var diff: [DiffFile]
    var isLive: Bool = false
    var answerText: String?
    var primaryOutputPath: String?
    var primaryOutputTruncated = false
    var capturedArtifactPaths: [String] = []
    var diagnosticText: String?
    var engineError: String?
    var artifactPaths: [String] = []
    var runDir: String?
    var repoRoot: String?
    var executionRoot: String? // summary `executionRoot`: where file links resolve; nil = run dir only
    /// General server-owned lineage (retry/follow-up/delegation).
    var parentRunId: String? = nil
    /// Narrow provenance set only by the Claudexor belt (native vendor subagents never set it).
    var delegatedFromRunId: String? = nil
    /// Durable requested/effective/used Delegate outcome facts.
    var delegation: RunDelegationInfo? = nil
    var outputReadyState: String?
    var webEvidenceStatus: String?
    var webEvidenceDetail: String?
    var browserRequirementDetail: String?
    var requestedAccess: String?
    var effectiveAccess: String?
    /** Run-level external web policy (off|auto|cached|live), for honest Retry. */
    var externalContextPolicy: String?
    /** Deterministic gate commands attached to this run, for honest Retry parity. */
    var tests: [TestCommandInvocation] = []
    /// Frozen intent from the server; absent on legacy runs, never inferred from defaults.
    var reviewRequested: Bool?
    var reviewerPanel: [ReviewerPanelEntry]?
    var protectedPathApprovals: [ProtectedPathApproval]?
    /// Model identity the harness stream actually reported (route evidence).
    var observedModel: String?
    /// Auth route receipt incl. requested-vs-observed model mismatch (W20/W18).
    var authRoute: RunAuthRoute?
    /// Typed failure category from the run's failure record (W18 failure card).
    var failureCategory: String?
    /// Machine-readable failure sub-code (`RunFailure.code`), e.g. a request the
    /// engine refused before sending (#147/#393). Never parsed from the message.
    var failureCode: String?
    /// The typed failure record itself: refusal sizes, next actions, earlier tries.
    var failureRecord: RunFailureInfo?
    /// Size of the raw-api request the final attempt last prepared (#147); nil otherwise.
    var rawContext: RawContextReceiptInfo?
    /// Live harness questions awaiting the user (waiting_on_user).
    var pendingInteractions: [PendingInteraction] = []
    var waitingOnUser: Bool = false
    /// Server-persisted operator unblock decision action (accept_risk/override), if any.
    var operatorDecisionAction: String?
    /// Honest in-place application state (projected from the run's work_product):
    /// not_applied | applied | applied_review_blocked | reverted. Decoupled from the
    /// terminal status so a green "Succeeded" never sits next to a review-blocked apply.
    var applyState: String = "not_applied"
    /// True when the race winner's patch was adopted (wire result.adopted).
    var adopted: Bool = false
    /// True when this turn's in-place mutation can still be safely reverted (server-owned).
    var revertable: Bool = false
    /// Last immutable delivery receipt returned by the server for this run.
    var deliveryReceipt: ApplyResultInfo?
    /// The v3 terminal-truth axes (D8/D18) projected from the run summary:
    /// lifecycle + noChanges + checks + review + typed reason. The SINGLE source
    /// the presentation projects review/checks/apply state from — never the
    /// wire `state` (that is lifecycle only). Nil while non-terminal.
    var outcomeFacts: RunOutcomeFacts?
    /// Server-owned outcome headline (D18), rendered VERBATIM as the Run Detail
    /// Outcome headline — never composed client-side. Nil while non-terminal.
    var outcomeBanner: String?
    /// Derived apply-gate verdict (single producer: the delivery gate). Apply
    /// controls in Run Detail follow THIS exclusively. Nil when no patch / not
    /// yet loaded (chat cards fall back to phase + review state).
    var applyEligibility: ApplyEligibility?
    /// Server-derived plan readiness (D17); nil for non-plan runs.
    var planReadiness: PlanReadiness?
    /// Engine-parsed open plan questions (D17); empty for non-plan runs.
    var planQuestions: [PlanQuestion] = []
    /// Council plan-strategy projection (D31); nil for non-council runs.
    var council: CouncilInfo?
}

// MARK: - Projects & specs

struct Spec: Identifiable, Hashable {
    let id: String
    var title: String
    var frozen: Bool
    var version: Int
    var runIds: [String]
}

struct Project: Identifiable, Hashable {
    let id: String
    var name: String
    var specs: [Spec]
}
