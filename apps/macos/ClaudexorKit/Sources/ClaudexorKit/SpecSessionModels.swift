import Foundation

/// Durable server projection used to restore an in-progress Spec interview
/// after app restart/thread switching (INV-136).
public struct SpecSessionSnapshot: Codable, Sendable, Equatable, Identifiable {
    public let sessionId: String
    public let threadId: String?
    public let prompt: String
    public let scope: RunScope
    public let state: String
    public let planRunId: String?
    public let questions: [SpecQuestion]
    public let answers: [SpecAnswer]
    public let priorDecisions: [SpecPriorDecision]
    public let specId: String?
    public let specPath: String?
    public let specHash: String?
    public let error: String?
    public let updatedAt: String
    public var id: String { sessionId }
}
