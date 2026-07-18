import ClaudexorKit

extension AppModel {
    /// Restore a durable Spec interview after app restart/thread switching.
    /// Exact thread binding wins. Legacy unbound sessions are restored only
    /// when exactly one active session exists for this project — never guess.
    func recoverSpecFlow(threadId: String, repoRoot: String?) async {
        guard specFlowByThread[threadId] == nil, let client else { return }
        guard let sessions = try? await client.specSessions() else { return }
        let activeStates = Set(["grounding", "questions", "answered", "freezing", "frozen"])
        let exact = sessions.first {
            $0.threadId == threadId && activeStates.contains($0.state)
        }
        let legacy = sessions.filter {
            $0.threadId == nil
                && $0.scope.root == repoRoot
                && activeStates.contains($0.state)
        }
        guard let session = exact ?? (legacy.count == 1 ? legacy[0] : nil) else { return }
        specPrior[threadId] = session.priorDecisions
        switch session.state {
        case "grounding":
            setSpecFlow(.grounding, for: threadId)
        case "questions", "answered":
            setSpecFlow(
                .askingQuestions(
                    prompt: session.prompt,
                    questions: session.questions,
                    planDir: session.sessionId,
                    planRunId: session.planRunId ?? "",
                    answers: session.answers,
                    error: session.error),
                for: threadId)
        case "freezing":
            setSpecFlow(.freezing, for: threadId)
        case "frozen":
            if let id = session.specId,
               let path = session.specPath,
               let hash = session.specHash {
                setSpecFlow(
                    .frozen(specId: id, specPath: path, specHash: hash, changes: 0),
                    for: threadId)
            } else {
                setSpecFlow(.error("Frozen Spec session is missing its artifact path."), for: threadId)
            }
        default:
            break
        }
    }
}
