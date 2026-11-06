import Foundation

/// Read revisions are ordered only within one serving read-owner incarnation.
/// A different epoch requires a fresh snapshot, never a cross-epoch comparison.
public struct ThreadHistoryRevision: Codable, Sendable, Equatable {
    public let epoch: String
    public let sequence: Int
    public func isNewer(than previous: Self) -> Bool {
        epoch == previous.epoch && sequence > previous.sequence
    }
}

public struct ThreadHistoryTextFacts: Codable, Sendable, Equatable {
    public let textBytes: Int
    public let totalTextBytes: Int?
    public let truncated: Bool
}

public struct ThreadHistoryOutput: Codable, Sendable, Equatable {
    public let kind: String
    public let path: String
    public let text: String?
    public let bytes: Int?
    public let truncated: Bool
    public let textBytes: Int
    public let totalTextBytes: Int?
}

public struct ThreadHistoryCount: Codable, Sendable, Equatable {
    public let value: Int?
    /// complete | partial | unavailable; nil is never a zero count.
    public let coverage: String
}

public struct ThreadHistoryRequiredAction: Codable, Sendable, Equatable {
    public let id: String
    public let detail: String
}

public struct ThreadHistoryOperatorDecision: Codable, Sendable, Equatable {
    public let action: String
    public let decidedAt: String?
}

/// Settled receipt facts from the engine; activity remains a separate run read.
public struct ThreadHistoryRun: Codable, Sendable, Equatable {
    public let state: String
    public let mode: String?
    public let strategy: String?
    public let n: Int?
    public let result: RunResult
    public let outcomeFacts: RunOutcomeFacts?
    public let spendUsd: Double?
    public let spendEstimated: Bool?
    public let outputReadyState: String
    public let waitingOnUser: Bool
    public let createdAt: String?
    public let startedAt: String?
    public let finishedAt: String?
    public let harnesses: [String]?
    public let primaryHarness: String?
    public let runDir: String?
    public let authRoute: RunAuthRoute?
    public let route: RouteInfo?
    public let delegation: RunDelegationInfo?
    public let delegatedChildRunIds: [String]
    public let budget: BudgetSnapshot
    public let failure: RunFailureInfo?
    public let applyEligibility: ApplyEligibility?
    public let applyEligibilityCoverage: String
    public let operatorDecisionCoverage: String
    public let unverifiedOperatorDecision: ThreadHistoryOperatorDecision?
    public let failureMessageInfo: ThreadHistoryTextFacts?
    public let requiredActions: [ThreadHistoryRequiredAction]
    public let planReadiness: PlanReadiness?
    public let planQuestions: [PlanQuestion]
    public let outcomeBanner: String?
    public let operatorDecision: ThreadHistoryOperatorDecision?
    public let toolCount: ThreadHistoryCount
    public let fileCount: ThreadHistoryCount
}

public struct ThreadHistoryTurn: Codable, Sendable, Equatable, Identifiable {
    public struct PlanAnswer: Codable, Sendable, Equatable {
        public let id: String
        public let prompt: String
        public let promptInfo: ThreadHistoryTextFacts
    }
    public let id: String
    public let threadId: String
    public let runId: String?
    public let parentRunId: String?
    public let answersPlanRunId: String?
    public let planRunId: String?
    public let planHash: String?
    public let planReadinessOverridden: Bool
    public let kind: String
    public let prompt: String
    public let enqueueError: TurnEnqueueErrorInfo?
    public let continuity: ThreadTurnContinuity?
    public let createdAt: String
    public let ordinal: Int
    public let revision: ThreadHistoryRevision
    public let promptInfo: ThreadHistoryTextFacts
    public let run: ThreadHistoryRun?
    /// available | unbound | not_retained; absent receipts never imply zero counts.
    public let runStatus: String
    public let primaryOutput: ThreadHistoryOutput?
    /// available | none | not_retained; retention may remove the artifact address.
    public let primaryOutputStatus: String
    public let answeredByTurnId: String?
    public let answeredByPrompt: PlanAnswer?
    public let planAnswerComplete: Bool
}

/// Compact ControlThread projection; runIds deliberately has no representation.
public struct ThreadHistoryThread: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String?
    public let folder: String?
    public let repoRoot: String?
    public let mode: String?
    public let workspaceMode: String
    public let workspaceRoot: String?
    public let authPreference: String
    public let primaryHarness: String?
    public let eligibleHarnesses: [String]
    public let credentialProfileId: String?
    public let access: String?
    public let state: String
    public let trashedAt: String?
    public let purgeAfter: String?
    public let headRunId: String?
    public let needsHuman: Bool
    public let createdAt: String
    public let updatedAt: String
}

public struct ThreadHistoryHeader: Codable, Sendable, Equatable {
    public struct Admission: Codable, Sendable, Equatable {
        public let id: String
        public let runId: String?
        public let enqueueError: TurnEnqueueErrorInfo?
        public let jobId: String?
        public let state: String?
    }
    public struct Head: Codable, Sendable, Equatable {
        public let runId: String
        public let run: TurnRunCard
    }
    public var thread: ThreadHistoryThread
    public let latestTurnId: String?
    /// Nil on older servers without ordinal evidence, or an empty thread.
    public let latestOrdinal: Int?
    public let latestAdmission: Admission?
    public let headRun: Head?
    public let headRunStatus: String
    public let sessions: [ThreadSessionInfo]
    public let sessionsComplete: Bool
}

public struct ThreadHistoryPage: Codable, Sendable, Equatable {
    public let storeId: String
    public let threadId: String
    public let epoch: String
    public let revision: ThreadHistoryRevision
    public let header: ThreadHistoryHeader
    public let turns: [ThreadHistoryTurn]
    public let hasOlder: Bool
    public let hasNewer: Bool
    public let olderCursor: String?
    public let newerCursor: String?
    public let replayCursor: String?
    public let replayNextCursor: String?
    public let limitedBy: String?
}

public struct ThreadPromptPart: Codable, Sendable, Equatable {
    public let threadId: String
    public let turnId: String
    public let totalBytes: Int
    public let sha256: String
    public let offset: Int
    public let nextOffset: Int
    public let text: String
}

/// Exactly one history selector; nil selects the newest page.
public enum ThreadHistorySelector: Sendable, Equatable {
    case cursor(String), beforeTurnId(String), afterTurnId(String), aroundTurnId(String)
    var queryItem: URLQueryItem {
        switch self {
        case .cursor(let value): return URLQueryItem(name: "cursor", value: value)
        case .beforeTurnId(let value): return URLQueryItem(name: "beforeTurnId", value: value)
        case .afterTurnId(let value): return URLQueryItem(name: "afterTurnId", value: value)
        case .aroundTurnId(let value): return URLQueryItem(name: "aroundTurnId", value: value)
        }
    }
}
