import Foundation

/// How the asking agent waits for an answer (schema `InteractionDelivery`).
/// `blocking`: its native tool call waits until the question is answered,
/// declined, expired or released. `async`: the agent keeps working; the question
/// is attention only, and an answer reaches the agent later as its next user
/// message. Silence, expiry and the run's end never answer either kind.
/// A value outside this set fails decoding instead of being dropped.
public enum InteractionDelivery: String, Codable, Sendable, Equatable, Hashable {
    case blocking
    case async
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
    /// When the question expires unanswered; nil = no automatic expiry. A blocking
    /// question then declines benignly; an async one closes and nothing is sent.
    public let timeoutAt: String?
    /// Absent from older engines and historical rows, which means `blocking`.
    public let delivery: InteractionDelivery
    public var id: String { interactionId }

    public init(interactionId: String, runId: String, attemptId: String?, harnessId: String?,
                sourceTool: String?, questions: [InteractionQuestion], requestedAt: String, timeoutAt: String?,
                delivery: InteractionDelivery = .blocking) {
        self.interactionId = interactionId
        self.runId = runId
        self.attemptId = attemptId
        self.harnessId = harnessId
        self.sourceTool = sourceTool
        self.questions = questions
        self.requestedAt = requestedAt
        self.timeoutAt = timeoutAt
        self.delivery = delivery
    }

    private enum CodingKeys: String, CodingKey {
        case interactionId, runId, attemptId, harnessId, sourceTool, questions, requestedAt, timeoutAt, delivery
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        interactionId = try c.decode(String.self, forKey: .interactionId)
        runId = try c.decode(String.self, forKey: .runId)
        attemptId = try c.decodeIfPresent(String.self, forKey: .attemptId)
        harnessId = try c.decodeIfPresent(String.self, forKey: .harnessId)
        sourceTool = try c.decodeIfPresent(String.self, forKey: .sourceTool)
        questions = try c.decode([InteractionQuestion].self, forKey: .questions)
        requestedAt = try c.decode(String.self, forKey: .requestedAt)
        timeoutAt = try c.decodeIfPresent(String.self, forKey: .timeoutAt)
        delivery = try c.decodeIfPresent(InteractionDelivery.self, forKey: .delivery) ?? .blocking
    }
}

/// The one client reading of a run's question attention, mirroring the engine's
/// `pendingQuestionAttention`. `waitingOnUser` stays the attention fact (any
/// question pending); async-only qualifies it. Loaded questions decide: at least
/// one, and every one async — a mixed set is blocking, so a blocking question
/// never hides behind an async one. With none loaded, the engine's
/// `asyncQuestionsOnly` flag stands. A run waiting on nobody is never async-only.
public enum PendingQuestionAttention {
    public static func asyncQuestionsOnly(
        pending: [PendingInteraction], waitingOnUser: Bool, serverFlag: Bool
    ) -> Bool {
        guard waitingOnUser else { return false }
        guard !pending.isEmpty else { return serverFlag }
        return pending.allSatisfy { $0.delivery == .async }
    }
}
