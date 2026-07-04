/**
 * Thread/turn DTOs (A2 chat/session-first): thin decodable projections of
 * the control-api thread surface. ThreadListResponse decodes per-row
 * (lossy) so one schema-skewed record never blanks the sidebar (T6#5).
 */
import Foundation

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

/// Why a turn has NO run: the enqueue/preflight refusal (e.g. the trust gate
/// rejected `access: full`) persisted on the turn by the daemon. Renders as an
/// inline failure card — a refused turn must never be a silent empty bubble.
public struct TurnEnqueueErrorInfo: Codable, Sendable, Equatable {
    /// The trust gate's machine code (engine-owned constant): remedies key on
    /// `code`, never on substring-matching the human message.
    public static let trustFullAccessCode = "trust_full_access_required"

    public let message: String
    /// Machine-readable refusal code from the typed throw; nil when the
    /// failure had no code (older servers omit the field entirely).
    public let code: String?
    /// False when NO recorded job exists to replay (the enqueue itself
    /// threw): the card offers "send a new message" instead of Retry.
    /// nil (older servers) reads as retryable.
    public let retryable: Bool?
    public let failedAt: String

    public init(message: String, code: String? = nil, retryable: Bool? = nil, failedAt: String) {
        self.message = message
        self.code = code
        self.retryable = retryable
        self.failedAt = failedAt
    }
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
    /// Present when the turn's run could not be enqueued (refusal reason);
    /// nil once a run binds (retry clears it server-side).
    public let enqueueError: TurnEnqueueErrorInfo?
    public let createdAt: String

    public init(id: String, threadId: String, runId: String?, parentRunId: String?,
                planRunId: String?, kind: String?, prompt: String, run: TurnRunCard?,
                enqueueError: TurnEnqueueErrorInfo? = nil, createdAt: String) {
        self.id = id
        self.threadId = threadId
        self.runId = runId
        self.parentRunId = parentRunId
        self.planRunId = planRunId
        self.kind = kind
        self.prompt = prompt
        self.run = run
        self.enqueueError = enqueueError
        self.createdAt = createdAt
    }
}

public struct ThreadListResponse: Codable, Sendable {
    public let threads: [ThreadSummary]
    /** Rows the decoder had to DROP (schema-skewed records). Not a wire
     * field — computed at decode so the sidebar can disclose the loss
     * instead of silently blanking (T6#5). */
    public var droppedThreads: Int = 0

    enum CodingKeys: String, CodingKey { case threads }

    public init(threads: [ThreadSummary]) {
        self.threads = threads
    }

    public init(from decoder: Decoder) throws {
        // Per-row salvage: ONE malformed ThreadSummary must not blank the
        // whole sidebar. Failed rows are consumed (JSONValue) and counted.
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var unkeyed = try c.nestedUnkeyedContainer(forKey: .threads)
        var ok: [ThreadSummary] = []
        var dropped = 0
        while !unkeyed.isAtEnd {
            if let t = try? unkeyed.decode(ThreadSummary.self) {
                ok.append(t)
            } else {
                _ = try? unkeyed.decode(JSONValue.self)
                dropped += 1
            }
        }
        self.threads = ok
        self.droppedThreads = dropped
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(threads, forKey: .threads)
    }
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

