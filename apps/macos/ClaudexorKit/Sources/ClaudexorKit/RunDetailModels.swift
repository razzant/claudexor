import Foundation

// Run-detail projection DTOs: the run inspector snapshot (RunDetail) and its
// satellites (candidates, live plan checklist). Split from Models.swift —
// one coherent owner for the /runs/:id projection shapes.

public struct PrimaryOutput: Codable, Sendable, Equatable {
    public let kind: String
    public let path: String
    public let text: String?
    public let bytes: Int?
    public let truncated: Bool?
}

/// One member of a plan council draft round (D31): who drafted or merged, and
/// whether their draft survived. Projected verbatim from the council receipt.
public struct CouncilMember: Codable, Sendable, Equatable, Hashable, Identifiable {
    public let harnessId: String
    /// primary | member
    public let role: String
    /// drafted | failed | merged
    public let status: String
    /// First redacted draft error; null unless the member failed.
    public let error: String?
    public var id: String { harnessId }

    public init(harnessId: String, role: String, status: String, error: String?) {
        self.harnessId = harnessId
        self.role = role
        self.status = status
        self.error = error
    }
}

/// Council plan-strategy projection (D31): how many members were requested,
/// how many drafts survived to the merge, whether the round degraded, and the
/// per-member roster. Null for non-council runs.
public struct CouncilInfo: Codable, Sendable, Equatable, Hashable {
    public let requested: Int
    public let drafted: Int
    public let degraded: Bool
    /// Harness that produced the unified plan (the primary); null if the merge failed.
    public let mergedBy: String?
    public let members: [CouncilMember]

    public init(requested: Int, drafted: Int, degraded: Bool, mergedBy: String?, members: [CouncilMember]) {
        self.requested = requested
        self.drafted = drafted
        self.degraded = degraded
        self.mergedBy = mergedBy
        self.members = members
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requested = try c.decode(Int.self, forKey: .requested)
        drafted = try c.decode(Int.self, forKey: .drafted)
        degraded = try c.decodeIfPresent(Bool.self, forKey: .degraded) ?? false
        mergedBy = try c.decodeIfPresent(String.self, forKey: .mergedBy)
        members = try c.decodeIfPresent([CouncilMember].self, forKey: .members) ?? []
    }
}

/// Auth ROUTE RECEIPT (INV-061 disclosure, W10/W11): the requested auth
/// preference, the effective route/source the deciding attempt disclosed, a
/// deterministic typed reason, and the requested-vs-observed model mismatch
/// (nil when they match or either side is unknown). Projected verbatim from
/// engine telemetry; nil on runs whose telemetry predates the receipt.
public struct RunAuthRoute: Codable, Sendable, Equatable, Hashable {
    public struct ModelMismatch: Codable, Sendable, Equatable, Hashable {
        public let requested: String
        public let observed: String
    }

    public let requested: String
    public let effective: String?
    public let source: String?
    public let reason: String
    public let harnessId: String?
    public let attemptId: String?
    public let modelMismatch: ModelMismatch?
}

/// Live plan checklist item (server-projected from plan.progress events).
public struct PlanProgressItem: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let status: String
}

public struct PlanProgress: Codable, Sendable, Equatable {
    public let items: [PlanProgressItem]
}

/// Per-candidate evidence card for a race run (server-projected).
public struct CandidateInfo: Codable, Sendable, Identifiable, Equatable {
    public let attemptId: String
    public let harnessId: String
    public let label: String?
    public let costUsd: Double
    public let costEstimated: Bool
    public let errored: Bool
    public let errorReason: String?
    public let gatesPassed: Int
    public let gatesTotal: Int
    public let blockers: Int
    public let reviewVerified: Bool
    public let finalReviewClean: Bool?
    public let winner: Bool
    public let diffstat: CandidateDiffstat?
    public var id: String { attemptId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        attemptId = try c.decode(String.self, forKey: .attemptId)
        harnessId = try c.decode(String.self, forKey: .harnessId)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        costUsd = try c.decodeIfPresent(Double.self, forKey: .costUsd) ?? 0
        costEstimated = try c.decodeIfPresent(Bool.self, forKey: .costEstimated) ?? false
        errored = try c.decodeIfPresent(Bool.self, forKey: .errored) ?? false
        errorReason = try c.decodeIfPresent(String.self, forKey: .errorReason)
        gatesPassed = try c.decodeIfPresent(Int.self, forKey: .gatesPassed) ?? 0
        gatesTotal = try c.decodeIfPresent(Int.self, forKey: .gatesTotal) ?? 0
        blockers = try c.decodeIfPresent(Int.self, forKey: .blockers) ?? 0
        reviewVerified = try c.decodeIfPresent(Bool.self, forKey: .reviewVerified) ?? false
        finalReviewClean = try c.decodeIfPresent(Bool.self, forKey: .finalReviewClean)
        winner = try c.decodeIfPresent(Bool.self, forKey: .winner) ?? false
        diffstat = try c.decodeIfPresent(CandidateDiffstat.self, forKey: .diffstat)
    }
}

public struct CandidateDiffstat: Codable, Sendable, Equatable {
    public let files: Int
    public let additions: Int
    public let deletions: Int
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
    /// Per-candidate evidence cards for race runs (empty otherwise).
    public let candidates: [CandidateInfo]
    /// Live plan checklist; nil when the run never emitted one.
    public let planProgress: PlanProgress?
    /// Server-persisted operator unblock decision (hash-bound); the apply
    /// affordance derives from THIS, never from local UI state.
    public let operatorDecisionAction: String?
    /// Server-owned outcome headline (status-projection.outcomeBanner). Rendered
    /// VERBATIM as the Outcome-tab headline — never composed client-side. Null
    /// while the run is not terminal.
    public let outcomeBanner: String?
    /// Derived apply-gate verdict (single producer: the delivery gate); the
    /// Apply controls follow THIS exclusively. Null when the run has no patch.
    public let applyEligibility: ApplyEligibility?
    /// Server-derived readiness of a plan run (D17); null for non-plan runs.
    public let planReadiness: PlanReadiness?
    /// Open questions of a plan run (projected from final/questions.json); empty otherwise.
    public let planQuestions: [PlanQuestion]
    /// Council plan-strategy projection (D31); null for non-council runs.
    public let council: CouncilInfo?

    enum CodingKeys: String, CodingKey {
        case summary, lastSeq, artifacts, primaryOutput, timeline, budget, finalSummary, decision, workProduct, reviewFindings, pendingInteractions, failure, candidates, planProgress, operatorDecision
        case outcomeBanner, applyEligibility, planReadiness, planQuestions, council
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
        candidates = try c.decodeIfPresent([CandidateInfo].self, forKey: .candidates) ?? []
        planProgress = try c.decodeIfPresent(PlanProgress.self, forKey: .planProgress)
        operatorDecisionAction = (try c.decodeIfPresent(OperatorDecisionDto.self, forKey: .operatorDecision))?.action
        outcomeBanner = try c.decodeIfPresent(String.self, forKey: .outcomeBanner)
        applyEligibility = try c.decodeIfPresent(ApplyEligibility.self, forKey: .applyEligibility)
        planReadiness = try c.decodeIfPresent(PlanReadiness.self, forKey: .planReadiness)
        planQuestions = try c.decodeIfPresent([PlanQuestion].self, forKey: .planQuestions) ?? []
        council = try c.decodeIfPresent(CouncilInfo.self, forKey: .council)
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
        try c.encode(candidates, forKey: .candidates)
        try c.encodeIfPresent(planProgress, forKey: .planProgress)
        try c.encodeIfPresent(operatorDecisionAction.map { OperatorDecisionDto(action: $0) }, forKey: .operatorDecision)
        try c.encodeIfPresent(outcomeBanner, forKey: .outcomeBanner)
        try c.encodeIfPresent(applyEligibility, forKey: .applyEligibility)
        try c.encodeIfPresent(planReadiness, forKey: .planReadiness)
        try c.encode(planQuestions, forKey: .planQuestions)
        try c.encodeIfPresent(council, forKey: .council)
    }
}

