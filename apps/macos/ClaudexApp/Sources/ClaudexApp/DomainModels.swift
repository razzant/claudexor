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
}

// MARK: - Run status

enum RunStatus: String, CaseIterable, Identifiable, Hashable {
    case queued, running, needsReview, blocked, succeeded, failed, cancelled, interrupted
    var id: String { rawValue }

    /// Map the control-api / daemon state strings onto a UI status.
    init(api: String) {
        switch api.lowercased() {
        case "queued", "pending": self = .queued
        case "running", "active", "in_progress": self = .running
        case "needs-review", "needs_review", "review": self = .needsReview
        case "blocked", "needs-permission": self = .blocked
        case "succeeded", "success", "done", "completed", "ok": self = .succeeded
        case "failed", "error": self = .failed
        case "cancelled", "canceled": self = .cancelled
        case "interrupted": self = .interrupted
        default: self = .running
        }
    }

    var label: String {
        switch self {
        case .queued: return "Queued"
        case .running: return "Running"
        case .needsReview: return "Needs review"
        case .blocked: return "Blocked"
        case .succeeded: return "Succeeded"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .interrupted: return "Interrupted"
        }
    }
    var glyph: String {
        switch self {
        case .queued: return "clock"
        case .running: return "circle.dotted"
        case .needsReview: return "checkmark.seal"
        case .blocked: return "exclamationmark.triangle.fill"
        case .succeeded: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .cancelled: return "slash.circle"
        case .interrupted: return "pause.circle"
        }
    }
    var color: Color { Theme.status(self) }
    var isActive: Bool { self == .running || self == .queued }
    var needsAttention: Bool { self == .needsReview || self == .blocked }
}

// MARK: - Run modes

enum RunMode: String, CaseIterable, Identifiable, Hashable {
    case ask, agent, bestOfN, maxAttempts, untilClean, plan, create, readOnlyAudit, benchmark, unknown
    var id: String { rawValue }
    static var allCases: [RunMode] {
        [.ask, .agent, .bestOfN, .maxAttempts, .untilClean, .plan, .create, .readOnlyAudit, .benchmark]
    }

    /// The wire value the control-api / orchestrator expects.
    var apiValue: String {
        switch self {
        case .ask: return "ask"
        case .agent: return "agent"
        case .bestOfN: return "best_of_n"
        case .maxAttempts: return "max_attempts"
        case .untilClean: return "until_clean"
        case .plan: return "plan"
        case .create: return "create"
        case .readOnlyAudit: return "readonly_audit"
        case .benchmark: return "benchmark"
        case .unknown: return "unknown"
        }
    }
    init(apiValue: String?) {
        switch apiValue {
        case "ask": self = .ask
        case "agent": self = .agent
        case "best_of_n": self = .bestOfN
        case "max_attempts": self = .maxAttempts
        case "until_clean": self = .untilClean
        case "plan": self = .plan
        case "create": self = .create
        case "readonly_audit": self = .readOnlyAudit
        case "benchmark": self = .benchmark
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
        case .benchmark: return "Benchmark"
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
        case .benchmark: return "chart.bar.xaxis"
        case .unknown: return "exclamationmark.triangle"
        }
    }
    var blurb: String {
        switch self {
        case .ask: return "Read-only answer. No edit, run, or apply controls."
        case .agent: return "Single primary-biased route. Direct edit path."
        case .bestOfN: return "N candidates in isolated envelopes, cross-reviewed, best wins."
        case .maxAttempts: return "Repair loop with a hard attempt cap and gates."
        case .untilClean: return "One envelope repaired until gates/review are clean."
        case .plan: return "Multi-harness planning → adversarial plan review → SpecPack."
        case .create: return "Scaffold a brand-new repo or component."
        case .readOnlyAudit: return "Read-only audit / map of a codebase."
        case .benchmark: return "Run a benchmark suite (SWE-bench, Terminal-Bench)."
        case .unknown: return "Persisted run uses an unsupported or legacy mode id."
        }
    }
    var isMultiCandidate: Bool { self == .bestOfN }
    var isReadOnly: Bool { self == .ask || self == .plan || self == .readOnlyAudit }
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
    var code: String?
    var timestamp: Date
    init(id: String = UUID().uuidString, _ kind: ActivityKind, harness: HarnessFamily? = nil,
         _ title: String, detail: String? = nil, code: String? = nil, at: Date = .now) {
        self.id = id; self.kind = kind; self.harness = harness; self.title = title
        self.detail = detail; self.code = code; self.timestamp = at
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
    case verified, unverified, sameModelFallback
    var label: String {
        switch self {
        case .verified: return "Route verified"
        case .unverified: return "Route unverified"
        case .sameModelFallback: return "Same-model fallback"
        }
    }
    var glyph: String {
        switch self {
        case .verified: return "checkmark.shield.fill"
        case .unverified: return "shield"
        case .sameModelFallback: return "exclamationmark.shield"
        }
    }
    var color: Color {
        switch self {
        case .verified: return Theme.status(.succeeded)
        case .unverified: return .secondary
        case .sameModelFallback: return Theme.status(.blocked)
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
    var accepted: Bool?
    var taskTitle: String = ""
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
    var routeProof: RouteProof
    var attentionNote: String?
    var plan: [PlanItem]
    var activity: [ActivityEvent]
    var candidates: [Candidate]
    var findings: [Finding]
    var diff: [DiffFile]
    var isLive: Bool = false

    var planDone: Int { plan.filter { $0.state == .done }.count }
    var filesChanged: Int { diff.count }
    var spendFraction: Double { capUsd > 0 ? min(spendUsd / capUsd, 1) : 0 }
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
    var id: String { family.rawValue }
}

// MARK: - Budget cockpit

struct BudgetState: Hashable {
    var spend: Double
    var cap: Double
    var breakerTier: Int            // 0 = healthy, 1 = warn, 2 = throttle, 3 = open
    var perHarness: [HarnessFamily: Double]
    static let empty = BudgetState(spend: 0, cap: 0, breakerTier: 0, perHarness: [:])
    var fraction: Double { cap > 0 ? min(spend / cap, 1) : 0 }
    var breakerLabel: String {
        switch breakerTier {
        case 0: return "Healthy"
        case 1: return "Watch"
        case 2: return "Throttling"
        default: return "Breaker open"
        }
    }
    var breakerColor: Color {
        switch breakerTier {
        case 0: return Theme.status(.succeeded)
        case 1: return Theme.status(.needsReview)
        case 2: return Theme.status(.blocked)
        default: return Theme.status(.failed)
        }
    }
}

// MARK: - Benchmarks

struct BenchmarkRun: Identifiable, Hashable {
    let id: String
    var suite: String
    var instance: String
    var status: RunStatus
    var resolved: Bool?
    var costUsd: Double
}

// MARK: - Spec interview

enum QuestionKind { case single, multi, text }

struct InterviewOption: Identifiable, Hashable {
    let id = UUID()
    var text: String
    var detail: String?
}

struct InterviewQuestion: Identifiable, Hashable {
    let id: String
    var tier: Int
    var prompt: String
    var rationale: String?
    var kind: QuestionKind
    var options: [InterviewOption]
    var citationFile: String?
    var needsClarification: Bool = false
}
