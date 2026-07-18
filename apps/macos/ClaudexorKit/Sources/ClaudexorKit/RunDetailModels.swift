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

    enum CodingKeys: String, CodingKey {
        case summary, lastSeq, artifacts, primaryOutput, timeline, budget, finalSummary, decision, workProduct, reviewFindings, pendingInteractions, failure, candidates, planProgress, operatorDecision
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
    }
}

