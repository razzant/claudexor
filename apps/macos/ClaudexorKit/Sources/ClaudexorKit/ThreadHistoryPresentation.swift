import Foundation

extension ThreadHistoryThread {
    /// PATCH owns editable metadata; a concurrent history read still owns head facts.
    public func applying(_ value: ThreadSummary) -> Self {
        Self(id: id, title: value.title, folder: value.folder, repoRoot: value.repoRoot,
            mode: value.mode, workspaceMode: value.workspaceMode ?? workspaceMode,
            workspaceRoot: value.workspaceRoot, authPreference: value.authPreference ?? authPreference,
            primaryHarness: value.primaryHarness, eligibleHarnesses: value.eligibleHarnesses ?? [],
            credentialProfileId: value.credentialProfileId, access: value.access,
            state: value.state ?? state, trashedAt: value.trashedAt, purgeAfter: value.purgeAfter,
            headRunId: headRunId, needsHuman: needsHuman, createdAt: createdAt, updatedAt: value.updatedAt)
    }

    /// Metadata adapter for existing composer/workspace-scope controls. This is
    /// not an archive run inventory; only the workspace detail read owns that.
    public var summary: ThreadSummary {
        ThreadSummary(id: id, title: title, folder: folder, repoRoot: repoRoot, mode: mode,
            workspaceMode: workspaceMode, workspaceRoot: workspaceRoot, authPreference: authPreference,
            credentialProfileId: credentialProfileId, primaryHarness: primaryHarness,
            eligibleHarnesses: eligibleHarnesses, access: access, state: state, trashedAt: trashedAt,
            purgeAfter: purgeAfter, runIds: [], headRunId: headRunId, needsHuman: needsHuman,
            createdAt: createdAt, updatedAt: updatedAt)
    }
}

extension ThreadHistoryTurn {
    public var turnInfo: ThreadTurnInfo {
        ThreadTurnInfo(id: id, threadId: threadId, runId: runId, parentRunId: parentRunId,
            answersPlanRunId: answersPlanRunId, planRunId: planRunId, kind: kind, prompt: prompt,
            run: run.map { value in
                TurnRunCard(state: value.state, mode: value.mode, strategy: value.strategy, n: value.n,
                    result: value.result, outcomeFacts: value.outcomeFacts, spendUsd: value.spendUsd,
                    outputReadyState: value.outputReadyState, waitingOnUser: value.waitingOnUser,
                    asyncQuestionsOnly: value.asyncQuestionsOnly,
                    finishedAt: value.finishedAt, delegation: value.delegation,
                    delegatedChildRunIds: value.delegatedChildRunIds)
            }, planHash: planHash, planReadinessOverridden: planReadinessOverridden, enqueueError: enqueueError, continuity: continuity, createdAt: createdAt)
    }
}
