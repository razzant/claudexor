import ClaudexorKit

extension AppModel {
    /// Restore a durable Spec interview after app restart/thread switching.
    /// Exact thread binding wins. Legacy unbound sessions are restored only
    /// when exactly one active session exists for this project — never guess.
    func recoverSpecFlow(threadId: String, repoRoot: String?) async {
        guard specFlowByThread[threadId] == nil, let client else { return }
        guard let sessions = try? await client.specSessions() else { return }
        let activeStates = Set([
            "grounding", "questions", "answered", "freezing", "frozen",
            "failed", "interrupted_unknown",
        ])
        let exact = sessions.first {
            $0.threadId == threadId && activeStates.contains($0.state)
        }
        let legacy = sessions.filter {
            $0.threadId == nil
                && $0.scope.root == repoRoot
                && activeStates.contains($0.state)
        }
        guard let session = exact ?? (legacy.count == 1 ? legacy[0] : nil) else { return }
        restoreSpecSession(session, threadId: threadId)
    }

    func resumeSpecSession(threadId: String, sessionId: String) async {
        guard let client else { return }
        do {
            restoreSpecSession(try await client.resumeSpecSession(sessionId), threadId: threadId)
        } catch {
            setSpecFlow(
                .interrupted(sessionId: sessionId, message: userMessage(for: error)),
                for: threadId)
        }
    }

    private func restoreSpecSession(_ session: SpecSessionSnapshot, threadId: String) {
        specPrior[threadId] = session.priorDecisions
        switch session.state {
        case "grounding", "freezing":
            setSpecFlow(
                .recovering(sessionId: session.sessionId, phase: session.state),
                for: threadId)
            Task { await followSpecSession(threadId: threadId, sessionId: session.sessionId) }
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
        case "frozen":
            if let id = session.specId,
               let path = session.specPath,
               let hash = session.specHash {
                setSpecFlow(
                    .frozen(sessionId: session.sessionId, specId: id, specPath: path,
                            specHash: hash, changes: 0, recovered: true),
                    for: threadId)
            } else {
                setSpecFlow(.error("Frozen Spec session is missing its artifact path."), for: threadId)
            }
        case "failed", "interrupted_unknown":
            setSpecFlow(
                .interrupted(
                    sessionId: session.sessionId,
                    message: session.error ?? "Spec work was interrupted. Resume or dismiss it."),
                for: threadId)
        case "cancelled":
            setSpecFlow(nil, for: threadId)
        default: break
        }
    }

    private func followSpecSession(threadId: String, sessionId: String) async {
        guard let client else { return }
        for _ in 0..<600 {
            try? await Task.sleep(for: .seconds(2))
            guard case .recovering(let current, _) = specFlowByThread[threadId],
                  current == sessionId else { return }
            do {
                let session = try await client.specSession(sessionId)
                if session.state == "grounding" || session.state == "freezing" {
                    setSpecFlow(
                        .recovering(sessionId: sessionId, phase: session.state),
                        for: threadId)
                    continue
                }
                restoreSpecSession(session, threadId: threadId)
                return
            } catch {
                setSpecFlow(
                    .interrupted(sessionId: sessionId, message: userMessage(for: error)),
                    for: threadId)
                return
            }
        }
        setSpecFlow(
            .interrupted(
                sessionId: sessionId,
                message: "Spec work is still pending after 20 minutes. Resume or dismiss it."),
            for: threadId)
    }
}
