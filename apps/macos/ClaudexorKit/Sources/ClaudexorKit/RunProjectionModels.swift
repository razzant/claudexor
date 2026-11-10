import Foundation

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

/// Engine-owned Delegate outcome facts. `requested` records the user's
/// permission, `effective` records whether the Claudexor belt was actually
/// injected, and `used` records typed evidence that the harness called a
/// Claudexor belt tool. A capable belt that the model did not use is therefore
/// distinct from a pre-start downgrade. `reason` is the daemon's closed state/
/// cause vocabulary (`pending`, `not_requested`, `injected_unused`, `used`,
/// the three pre-start causes, `partially_degraded`, or `startup_failed`).
public struct RunDelegationInfo: Codable, Sendable, Equatable, Hashable {
    public let requested: Bool
    public let effective: Bool
    public let used: Bool
    public let reason: String
    /// Engine-owned recovery guidance for degraded or failed Delegate setup.
    /// Nil for healthy states and legacy runtimes that did not project it.
    public let remediation: String?

    public init(
        requested: Bool,
        effective: Bool,
        used: Bool,
        reason: String,
        remediation: String? = nil
    ) {
        self.requested = requested
        self.effective = effective
        self.used = used
        self.reason = reason
        self.remediation = remediation
    }
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
    /// Immutable external content-addressed revert anchor (survives git gc).
    public let revertAnchorId: String?
    /// True when the in-place mutation can still be safely reverted.
    public let revertable: Bool

    enum CodingKeys: String, CodingKey {
        case kind, diffStat, blockers, adopted, applyState, preTurnSha, postTurnSha, revertAnchorId, revertable
    }

    public init(kind: String, diffStat: DiffStat?, blockers: Int, adopted: Bool?,
                applyState: String = "not_applied", preTurnSha: String? = nil,
                postTurnSha: String? = nil, revertAnchorId: String? = nil, revertable: Bool = false) {
        self.kind = kind
        self.diffStat = diffStat
        self.blockers = blockers
        self.adopted = adopted
        self.applyState = applyState
        self.preTurnSha = preTurnSha
        self.postTurnSha = postTurnSha
        self.revertAnchorId = revertAnchorId
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
        revertAnchorId = try c.decodeIfPresent(String.self, forKey: .revertAnchorId)
        revertable = try c.decodeIfPresent(Bool.self, forKey: .revertable) ?? false
    }
}
