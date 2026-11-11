import ClaudexorKit
import Foundation

/// One receipt mapper, shared with the existing card. Unknown counts, dates and
/// cash remain unknown; the history projection never synthesizes a transcript.
enum HistoryRunPresentation {
    static func head(_ head: ThreadHistoryHeader.Head, thread: ThreadHistoryThread) -> TaskRun {
        TaskRun(id: head.runId, title: thread.title ?? "Live run", prompt: "",
            mode: RunMode(apiValue: head.run.mode, strategy: head.run.strategy),
            phase: RunPhase(api: head.run.state), project: thread.repoRoot ?? "No project",
            harnesses: [], n: head.run.n ?? 1, createdAt: .now, updatedAt: .now,
            spendUsd: head.run.spendUsd ?? 0, capUsd: 0, spendKnown: head.run.spendUsd != nil,
            capKnown: false, routeProof: .unverified, attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [], isLive: true)
    }

    static func task(_ row: ThreadHistoryTurn, thread: ThreadHistoryThread?) -> TaskRun? {
        guard let run = row.run, let id = row.runId, row.runStatus == "available" else { return nil }
        let start = date(run.startedAt ?? run.createdAt)
        let finish = date(run.finishedAt)
        var task = TaskRun(id: id, title: String(row.prompt.prefix(64)), prompt: row.prompt,
            mode: RunMode(apiValue: run.mode, strategy: run.strategy), phase: RunPhase(api: run.state),
            project: thread?.repoRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No project",
            harnesses: (run.harnesses ?? []).map { HarnessFamily(rawValue: $0) }, n: run.n ?? 1,
            createdAt: start ?? .distantPast, updatedAt: finish ?? start ?? .distantPast,
            spendUsd: run.budget.spendUsd ?? 0, capUsd: run.budget.maxUsd ?? 0,
            spendKnown: run.budget.spendUsd != nil, capKnown: run.budget.maxUsd != nil,
            spendEstimated: run.budget.estimated, routeProof: run.route?.verified == true ? .verified : .unverified,
            attentionNote: nil, plan: [], activity: [], candidates: [], findings: [], diff: [])
        task.repoRoot = thread?.repoRoot
        task.executionRoot = thread?.workspaceMode == "delegated" ? thread?.workspaceRoot : thread?.repoRoot
        task.controllableSpendUsd = run.budget.controllableSpendUsd
        task.valuationUsd = run.budget.knownValuationUsd
        task.engineError = run.failure?.safeMessage
        task.failureCategory = run.failure?.category
        task.failureCode = run.failure?.code
        task.failureRecord = run.failure
        task.runDir = run.runDir ?? run.failure?.runDir
        task.authRoute = run.authRoute
        task.outcomeFacts = run.outcomeFacts
        task.outcomeBanner = run.outcomeBanner
        task.operatorDecisionAction = run.operatorDecision?.action
        task.applyEligibility = run.applyEligibilityCoverage == "unavailable" ? nil : run.applyEligibility
        task.planReadiness = run.planReadiness
        task.planQuestions = run.planQuestions
        task.delegation = run.delegation
        task.waitingOnUser = run.waitingOnUser
        task.serverAsyncQuestionsOnly = run.asyncQuestionsOnly ?? false
        task.outputReadyState = run.outputReadyState
        task.applyState = run.result.applyState
        task.adopted = run.result.adopted == true
        task.revertable = run.result.revertable
        task.primaryOutputPath = row.primaryOutput?.path
        task.primaryOutputTruncated = row.primaryOutput?.truncated == true
        if let output = row.primaryOutput, output.kind != "patch", output.kind != "diagnostic" {
            task.answerText = output.text
        }
        task.artifactPaths = [row.primaryOutput?.path, run.failure?.rawDetailRef].compactMap { $0 }
        return task
    }

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func count(_ count: ThreadHistoryCount, noun: String) -> String? {
        guard let value = count.value, count.coverage != "unavailable" else { return nil }
        return "\(value)\(count.coverage == "partial" ? "+" : "") \(noun)"
    }

    static func counts(_ run: ThreadHistoryRun) -> String? {
        let parts = [count(run.toolCount, noun: "tools"), count(run.fileCount, noun: "file calls")].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
