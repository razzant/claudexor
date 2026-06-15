import ClaudexorKit
import Foundation
import SwiftUI

/// UI-side domain models. These render the engine-service state read via `GatewayClient`
/// (live) or `DemoData` (showcase fallback). The canonical shapes live in
/// `packages/schema`; these are the minimal projections the views display.

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

// MARK: - Harness families

enum HarnessFamily: String, CaseIterable, Identifiable, Hashable {
    case codex, claude, cursor, opencode
    case raw = "raw-api"
    case fake
    var id: String { rawValue }

    var label: String {
        switch self {
        case .codex: return "Codex"
        case .claude: return "Claude"
        case .cursor: return "Cursor"
        case .opencode: return "OpenCode"
        case .raw: return "Raw API"
        case .fake: return "Fake"
        }
    }
    var glyph: String {
        switch self {
        case .codex: return "chevron.left.forwardslash.chevron.right"
        case .claude: return "sparkles"
        case .cursor: return "cursorarrow.rays"
        case .opencode: return "curlybraces"
        case .raw: return "bolt.horizontal"
        case .fake: return "testtube.2"
        }
    }
    var color: Color { Theme.harness(rawValue) }
    var setupHarnessId: String { self == .raw ? "raw" : rawValue }
}

// MARK: - Run status

enum RunStatus: String, CaseIterable, Identifiable, Hashable {
    case queued, running, needsReview, blocked, succeeded, noOp, ungated, reviewNotRun, failed, cancelled, interrupted, exhausted, notConverged, unknown
    var id: String { rawValue }

    /// Map the control-api / daemon state strings onto a UI status.
    init(api: String) {
        switch api.lowercased() {
        case "queued", "pending": self = .queued
        case "running", "active", "in_progress": self = .running
        case "needs-review", "needs_review", "review": self = .needsReview
        case "blocked", "needs-permission": self = .blocked
        case "succeeded", "success", "done", "completed", "ok": self = .succeeded
        case "no_op", "no-op": self = .noOp
        case "ungated": self = .ungated
        case "review_not_run", "review-not-run": self = .reviewNotRun
        case "failed", "error": self = .failed
        case "exhausted": self = .exhausted
        case "not_converged", "not-converged": self = .notConverged
        case "cancelled", "canceled": self = .cancelled
        case "interrupted": self = .interrupted
        default: self = .unknown
        }
    }

    var label: String {
        switch self {
        case .queued: return "Queued"
        case .running: return "Running"
        case .needsReview: return "Needs review"
        case .blocked: return "Blocked"
        case .succeeded: return "Succeeded"
        case .noOp: return "No-op"
        case .ungated: return "Ungated"
        case .reviewNotRun: return "Review not run"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .interrupted: return "Interrupted"
        case .exhausted: return "Exhausted"
        case .notConverged: return "Not converged"
        case .unknown: return "Unknown"
        }
    }
    var glyph: String {
        switch self {
        case .queued: return "clock"
        case .running: return "circle.dotted"
        case .needsReview: return "checkmark.seal"
        case .blocked: return "exclamationmark.triangle.fill"
        case .succeeded: return "checkmark.circle.fill"
        case .noOp: return "minus.circle"
        case .ungated: return "shield.slash"
        case .reviewNotRun: return "person.2.slash"
        case .failed: return "xmark.octagon.fill"
        case .cancelled: return "slash.circle"
        case .interrupted: return "pause.circle"
        case .exhausted: return "gauge.with.dots.needle.100percent"
        case .notConverged: return "arrow.triangle.2.circlepath.circle"
        case .unknown: return "questionmark.diamond"
        }
    }
    var color: Color { Theme.status(self) }
    var isActive: Bool { self == .running || self == .queued }
    var isTerminal: Bool { !isActive && self != .unknown }
    var needsAttention: Bool { self == .needsReview || self == .blocked || self == .ungated || self == .reviewNotRun || self == .failed || self == .exhausted || self == .notConverged || self == .unknown }
}

// MARK: - Run modes

enum RunMode: String, CaseIterable, Identifiable, Hashable {
    case ask, explore, agent, bestOfN, maxAttempts, untilClean, plan, create, readOnlyAudit, orchestrate, unknown
    var id: String { rawValue }
    static var allCases: [RunMode] {
        [.ask, .explore, .agent, .bestOfN, .maxAttempts, .untilClean, .plan, .create, .readOnlyAudit, .orchestrate]
    }

    /// The wire MODE (v0.9: five canonical ids — strategies ride as flags, see `strategyFlags`).
    var apiValue: String {
        switch self {
        case .ask: return "ask"
        case .explore, .readOnlyAudit: return "audit"
        case .agent, .bestOfN, .maxAttempts, .untilClean, .create: return "agent"
        case .plan: return "plan"
        case .orchestrate: return "orchestrate"
        case .unknown: return "unknown"
        }
    }

    /// v0.9 strategy flags accompanying `apiValue` on a run start request.
    var strategyFlags: (untilClean: Bool, swarm: Bool, create: Bool, defaultN: Int?) {
        switch self {
        case .bestOfN: return (false, false, false, 2)
        case .untilClean: return (true, false, false, nil)
        case .explore: return (false, true, false, nil)
        case .create: return (false, false, true, nil)
        default: return (false, false, false, nil)
        }
    }

    /// Display mode derived from the wire (mode, strategy) pair — `agent --n`
    /// renders as Best-of-N, `audit --swarm` as Explore, etc.
    init(apiValue: String?, strategy: String?) {
        switch (apiValue, strategy) {
        case ("agent", "race"): self = .bestOfN
        case ("agent", "attempts"): self = .maxAttempts
        case ("agent", "until_clean"): self = .untilClean
        case ("agent", "create"): self = .create
        case ("audit", "swarm"): self = .explore
        default: self = RunMode(apiValue: apiValue)
        }
    }

    init(apiValue: String?) {
        switch apiValue {
        case "ask": self = .ask
        case "agent": self = .agent
        case "plan": self = .plan
        case "audit": self = .readOnlyAudit
        case "orchestrate": self = .orchestrate
        // Legacy ids from pre-v0.9 dogfood artifacts decode leniently for
        // DISPLAY only (the engine hard-errors on them at run time).
        case "explore": self = .explore
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
        case .explore: return "Explore"
        case .agent: return "Agent"
        case .bestOfN: return "Best-of-N"
        case .maxAttempts: return "Max Attempts"
        case .untilClean: return "Until Clean"
        case .plan: return "Plan"
        case .create: return "Create"
        case .readOnlyAudit: return "Read-only Audit"
        case .orchestrate: return "Orchestrate"
        case .unknown: return "Unknown Mode"
        }
    }
    var glyph: String {
        switch self {
        case .ask: return "questionmark.bubble"
        case .explore: return "map"
        case .agent: return "bolt.fill"
        case .bestOfN: return "flag.checkered.2.crossed"
        case .maxAttempts: return "repeat"
        case .untilClean: return "arrow.triangle.2.circlepath"
        case .plan: return "list.bullet.clipboard"
        case .create: return "plus.square.on.square"
        case .readOnlyAudit: return "magnifyingglass"
        case .orchestrate: return "brain.head.profile"
        case .unknown: return "exclamationmark.triangle"
        }
    }
    var blurb: String {
        switch self {
        case .ask: return "Read-only answer. No edit, run, or apply controls."
        case .explore: return "Bounded read-only research swarm with verified synthesis and omissions."
        case .agent: return "Single primary-biased envelope route; apply explicitly after review."
        case .bestOfN: return "N candidates in isolated envelopes, cross-reviewed, best wins."
        case .maxAttempts: return "Repair loop with a hard attempt cap and gates."
        case .untilClean: return "One envelope repaired until gates/review are clean."
        case .plan: return "Multi-harness planning → adversarial plan review → SpecPack."
        case .create: return "Scaffold a brand-new repo or component."
        case .readOnlyAudit: return "Read-only audit / map of a codebase."
        case .orchestrate: return "Brain: routed like reviewers; produces a typed orchestration plan over the tool belt."
        case .unknown: return "Persisted run uses an unsupported or legacy mode id."
        }
    }
    var isMultiCandidate: Bool { self == .bestOfN }
    var isReadOnly: Bool { self == .ask || self == .explore || self == .plan || self == .readOnlyAudit || self == .orchestrate }
    var requiresProject: Bool { self != .ask }
    var requiredIntent: String {
        switch self {
        case .ask: return "explain"
        case .explore: return "audit"
        case .plan: return "plan"
        case .readOnlyAudit: return "audit"
        case .create: return "create_from_scratch"
        case .orchestrate: return "orchestrate"
        case .unknown: return "implement"
        default: return "implement"
        }
    }
}

// MARK: - Access profile (per-turn write scope)

/// How much a write turn may touch — surfaced in the composer's "⋯" options and
/// sent on the turn (the engine's `access` field). Read-only modes ignore it.
enum AccessProfile: String, CaseIterable, Identifiable {
    case readOnly, workspaceWrite, elevated
    var id: String { rawValue }
    var label: String {
        switch self {
        case .readOnly: return "Read only"
        case .workspaceWrite: return "Workspace write"
        case .elevated: return "Elevated"
        }
    }
    var glyph: String {
        switch self {
        case .readOnly: return "eye"
        case .workspaceWrite: return "square.and.pencil"
        case .elevated: return "lock.open"
        }
    }
    /// The engine wire value for `ControlRunStartRequest.access`.
    var wire: String {
        switch self {
        case .readOnly: return "readonly"
        case .workspaceWrite: return "workspace_write"
        case .elevated: return "full"
        }
    }
}

// MARK: - Per-turn composer options ("⋯")

/// UI-side bag of per-turn knobs the composer's "⋯" panel collects. These map
/// onto fields that already exist on the engine's run-start request (budget cap,
/// access, web policy, agent repair strategies) — NOT new UI-only semantics.
/// primary/pool are NOT here: they are sticky on the thread (PATCHed separately).
struct TurnOptions: Equatable {
    var maxUsd: Double? = nil
    var access: String? = nil          // AccessProfile.wire
    var web: String? = nil             // auto | off | cached | live
    var untilClean: Bool = false
    var maxAttempts: Int? = nil        // nil => engine default repair cap
}

// MARK: - Phase pipeline

enum Phase: Int, CaseIterable, Identifiable {
    case contract, context, risk, budget, envelope, gates, review, synthesis, arbitration, final
    var id: Int { rawValue }
    var label: String {
        switch self {
        case .contract: return "Contract"
        case .context: return "Context"
        case .risk: return "Risk"
        case .budget: return "Budget"
        case .envelope: return "Envelope"
        case .gates: return "Gates"
        case .review: return "Review"
        case .synthesis: return "Synthesis"
        case .arbitration: return "Arbitration"
        case .final: return "Final"
        }
    }
    var glyph: String {
        switch self {
        case .contract: return "doc.text"
        case .context: return "books.vertical"
        case .risk: return "shield.lefthalf.filled"
        case .budget: return "dollarsign.circle"
        case .envelope: return "shippingbox"
        case .gates: return "checklist"
        case .review: return "person.2.badge.gearshape"
        case .synthesis: return "wand.and.stars"
        case .arbitration: return "scale.3d"
        case .final: return "flag.checkered"
        }
    }
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
        case .active: return Theme.status(.running)
        case .done: return Theme.status(.succeeded)
        case .blocked: return Theme.status(.blocked)
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
        case .gate: return Theme.status(.succeeded)
        case .review: return Theme.status(.needsReview)
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
        case .pending: return Theme.status(.running)
        case .clean: return Theme.status(.succeeded)
        case .changesRequested: return Theme.status(.blocked)
        case .winner: return Theme.accent
        case .rejected: return Theme.status(.failed)
        }
    }
}

struct Candidate: Identifiable, Hashable {
    let id: String
    var family: HarnessFamily
    var status: RunStatus
    var costUsd: Double
    var estimated: Bool
    var gatesPassed: Int
    var gatesTotal: Int
    var reviewState: ReviewState
    var summary: String
    var isSynthesis: Bool = false
    var filesChanged: Int = 0
    var added: Int = 0
    var removed: Int = 0
}

// MARK: - Review findings

enum Severity: String, CaseIterable, Hashable {
    case blocker, major, minor, nit
    var label: String { rawValue.capitalized }
    var glyph: String {
        switch self {
        case .blocker: return "xmark.octagon.fill"
        case .major: return "exclamationmark.triangle.fill"
        case .minor: return "exclamationmark.circle"
        case .nit: return "sparkle"
        }
    }
    var color: Color {
        switch self {
        case .blocker: return Theme.status(.failed)
        case .major: return Theme.status(.blocked)
        case .minor: return Theme.status(.running)
        case .nit: return .secondary
        }
    }
    var rank: Int { Self.allCases.firstIndex(of: self) ?? 9 }
}

enum RouteProof: String, Hashable {
    case verified, acceptedModelArg, unverified, sameModelFallback
    var label: String {
        switch self {
        case .verified: return "Route verified"
        case .acceptedModelArg: return "Model arg accepted"
        case .unverified: return "Route unverified"
        case .sameModelFallback: return "Same-model fallback"
        }
    }
    var glyph: String {
        switch self {
        case .verified: return "checkmark.shield.fill"
        case .acceptedModelArg: return "checkmark.shield"
        case .unverified: return "shield"
        case .sameModelFallback: return "exclamationmark.shield"
        }
    }
    var color: Color {
        switch self {
        case .verified: return Theme.status(.succeeded)
        case .acceptedModelArg: return Theme.accent
        case .unverified: return .secondary
        case .sameModelFallback: return Theme.status(.blocked)
        }
    }
}

enum FindingStatus: String, Hashable {
    case proposed
    case accepted
    case rebutted
    case fixed
    case acceptedRisk
    case duplicate
    case stale
    case outOfScope
    case insufficientEvidence

    init(api: String?) {
        switch api?.lowercased() {
        case "accepted": self = .accepted
        case "rebutted": self = .rebutted
        case "fixed": self = .fixed
        case "accepted_risk", "accepted-risk": self = .acceptedRisk
        case "duplicate": self = .duplicate
        case "stale": self = .stale
        case "out_of_scope", "out-of-scope": self = .outOfScope
        case "insufficient_evidence", "insufficient-evidence": self = .insufficientEvidence
        default: self = .proposed
        }
    }

    var label: String {
        switch self {
        case .proposed: return "Proposed"
        case .accepted: return "Accepted"
        case .rebutted: return "Rebutted"
        case .fixed: return "Fixed"
        case .acceptedRisk: return "Accepted Risk"
        case .duplicate: return "Duplicate"
        case .stale: return "Stale"
        case .outOfScope: return "Out of Scope"
        case .insufficientEvidence: return "Insufficient"
        }
    }

    var color: Color {
        switch self {
        case .accepted, .fixed: return Theme.status(.succeeded)
        case .rebutted, .outOfScope: return Theme.status(.failed)
        case .insufficientEvidence, .acceptedRisk: return Theme.status(.blocked)
        case .duplicate, .stale, .proposed: return .secondary
        }
    }
}

struct Finding: Identifiable, Hashable {
    let id: String
    var severity: Severity
    var category: String
    var title: String
    var detail: String
    var reviewer: HarnessFamily
    var routeProof: RouteProof
    var evidenceFile: String?
    var evidenceLine: Int?
    var status: FindingStatus = .proposed
    var taskTitle: String = ""
    /// Run id the finding belongs to — the review queue routes here for the
    /// typed decision actions (decide/apply live on the run/turn surfaces).
    var taskId: String?
    var hasEvidence: Bool { evidenceFile != nil }
}

// MARK: - Diff

enum DiffLineKind { case context, add, remove, hunk }

struct DiffLine: Identifiable, Hashable {
    let id = UUID()
    var kind: DiffLineKind
    var text: String
    var oldNo: Int?
    var newNo: Int?
}

struct DiffHunk: Identifiable, Hashable {
    let id = UUID()
    var header: String
    var lines: [DiffLine]
}

struct DiffFile: Identifiable, Hashable {
    let id = UUID()
    var path: String
    var added: Int
    var removed: Int
    var hunks: [DiffHunk]
    var accepted: Bool = true
}

// MARK: - Task (a run)

struct TaskRun: Identifiable, Hashable {
    let id: String
    var title: String
    var prompt: String
    var mode: RunMode
    var status: RunStatus
    var project: String
    var specTitle: String?
    var harnesses: [HarnessFamily]
    var n: Int
    var createdAt: Date
    var updatedAt: Date
    var activePhase: Phase
    var spendUsd: Double
    var capUsd: Double
    var spendKnown: Bool = true
    var capKnown: Bool = true
    var spendEstimated: Bool = false
    var routeProof: RouteProof
    var attentionNote: String?
    var plan: [PlanItem]
    var activity: [ActivityEvent]
    var candidates: [Candidate]
    var findings: [Finding]
    var diff: [DiffFile]
    var isLive: Bool = false
    var answerText: String?
    var diagnosticText: String?
    var engineError: String?
    var artifactPaths: [String] = []
    var runDir: String?
    var repoRoot: String?
    var outputReadyState: String?
    var webEvidenceStatus: String?
    var webEvidenceDetail: String?
    var requestedAccess: String?
    var effectiveAccess: String?
    /** Run-level external web policy (off|auto|cached|live), for honest Retry. */
    var externalContextPolicy: String?
    /// Model identity the harness stream actually reported (route evidence).
    var observedModel: String?
    /// Live harness questions awaiting the user (waiting_on_user).
    var pendingInteractions: [PendingInteraction] = []
    var waitingOnUser: Bool = false
    /// Server-persisted operator unblock decision action (accept_risk/override), if any.
    var operatorDecisionAction: String?
    /// Honest in-place application state (projected from the run's work_product):
    /// not_applied | applied | applied_review_blocked | reverted. Decoupled from the
    /// terminal status so a green "Succeeded" never sits next to a review-blocked apply.
    var applyState: String = "not_applied"
    /// True when this turn's in-place mutation can still be safely reverted (server-owned).
    var revertable: Bool = false

    /// "workspace_write" or "readonly → readonly" style badge; nil when unknown.
    var accessLabel: String? {
        guard let effective = effectiveAccess else { return requestedAccess }
        if let requested = requestedAccess, requested != effective { return "\(requested) → \(effective)" }
        return effective
    }

    var planDone: Int { plan.filter { $0.state == .done }.count }
    var filesChanged: Int { diff.count }
    var spendFraction: Double { spendKnown && capKnown && capUsd > 0 ? min(spendUsd / capUsd, 1) : 0 }
    var budgetLabel: String {
        let spend = spendKnown ? "\(spendEstimated ? "~" : "")\(String(format: "$%.4f", spendUsd))" : "Unknown"
        let cap = capKnown ? String(format: "$%.2f", capUsd) : "Unknown"
        return "\(spend) / \(cap)"
    }

    /// State-machine invariant: a terminal status may only be PRESENTED with
    /// its final content. Until the snapshot lands, the run is "Finalizing" —
    /// never a green Succeeded badge next to an empty Outcome.
    var isFinalizing: Bool {
        guard isLive, status.isTerminal, status != .cancelled else { return false }
        // loadRunDetail ALWAYS fills diagnosticText with at least a
        // placeholder, so for a GREEN badge (succeeded) diagnostics only
        // count as content when the engine explicitly marked the output as
        // diagnostic — otherwise "Succeeded" could sit next to an empty
        // Outcome, exactly the bug this state exists to prevent. For
        // failure-shaped terminals (failed/blocked/exhausted/no-op/...) the
        // diagnostics blob IS the legitimate final content.
        let diagnosticIsContent = status != .succeeded || outputReadyState == "diagnostic"
        let hasContent =
            !(answerText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !diff.isEmpty
            || (diagnosticIsContent && !(diagnosticText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            || engineError != nil
        return !hasContent
    }
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

// MARK: - Harness doctor

enum HarnessHealth: String { case ok, degraded, unavailable
    var color: Color {
        switch self {
        case .ok: return Theme.status(.succeeded)
        case .degraded: return Theme.status(.blocked)
        case .unavailable: return Theme.status(.failed)
        }
    }
    var glyph: String {
        switch self {
        case .ok: return "checkmark.circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .unavailable: return "minus.circle"
        }
    }
}

struct HarnessInfo: Identifiable, Hashable {
    var family: HarnessFamily
    var health: HarnessHealth
    var version: String
    var auth: String
    var intents: [String]
    var reasons: [String] = []
    var checks: [String] = []
    var id: String { family.rawValue }
}

struct HarnessAvailability: Hashable {
    var family: HarnessFamily
    var available: Bool
    var reason: String
    var intent: String
    var info: HarnessInfo?
}

