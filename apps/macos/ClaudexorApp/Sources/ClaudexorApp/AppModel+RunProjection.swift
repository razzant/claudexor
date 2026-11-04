import ClaudexorKit
import Foundation

extension AppModel {
    static func liveTask(from summary: RunSummary) -> TaskRun {
        let prompt = summary.prompt ?? ""
        let title = prompt.isEmpty ? prettyTitle(summary.runId) : String(prompt.prefix(64))
        let families = (summary.harnesses ?? []).map { HarnessFamily(rawValue: $0) }
        let projectName = summary.project?.projectName
            ?? summary.project?.root.map { URL(fileURLWithPath: $0).lastPathComponent }
            ?? "No project"
        var task = TaskRun(
            id: summary.runId,
            title: title,
            prompt: prompt,
            mode: RunMode(apiValue: summary.mode, strategy: summary.strategy),
            phase: RunPhase(api: summary.state),
            project: projectName,
            harnesses: families,
            // `harnesses` is the eligible/observed pool, not proof that the
            // run was a race. Only the typed race strategy may project a
            // Best-of count when an older summary omitted `n`.
            n: summary.n ?? (summary.strategy == "race" ? max(1, families.count) : 1),
            createdAt: .now, updatedAt: .now,
            spendUsd: summary.spendUsd ?? 0, capUsd: summary.paidBudget?.finiteMaxUsd ?? 0,
            spendKnown: summary.spendUsd != nil,
            capKnown: summary.paidBudget?.finiteMaxUsd != nil,
            spendEstimated: summary.spendEstimated ?? false,
            routeProof: .unverified,
            attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [],
            isLive: true
        )
        task.resolvedRunId = summary.runId
        task.repoRoot = summary.project?.root
        task.executionRoot = summary.executionRoot
        task.engineError = summary.failure?.safeMessage ?? summary.error
        task.runDir = summary.runDir ?? summary.failure?.runDir
        task.parentRunId = summary.parentRunId
        task.delegatedFromRunId = summary.delegatedFromRunId
        task.delegation = summary.delegation
        task.outputReadyState = summary.outputReadyState
        // The terminal axes ride the list summary; Run Detail refines the
        // banner and apply projection without replacing this engine truth.
        task.outcomeFacts = summary.outcomeFacts
        // A CLI apply/revert must win over stale local eligibility on refresh.
        if let result = summary.result {
            task.applyState = result.applyState
            task.revertable = result.revertable
            task.adopted = result.adopted == true
        }
        task.waitingOnUser = summary.waitingOnUser ?? false
        if let route = summary.route {
            task.observedModel = route.observedModel
            task.routeProof = route.verified == true ? .verified : .unverified
        }
        task.authRoute = summary.authRoute
        task.failureCategory = summary.failure?.category
        task.failureCode = summary.failure?.code
        task.failureRecord = summary.failure
        task.rawContext = summary.rawContext
        task.requestedAccess = summary.requestedAccess
        task.effectiveAccess = summary.effectiveAccess
        task.externalContextPolicy = summary.externalContextPolicy
        task.tests = summary.tests ?? []
        task.applyPaidBudget(summary.paidBudget)
        task.reviewRequested = summary.review
        task.reviewerPanel = summary.reviewerPanel
        task.protectedPathApprovals = summary.protectedPathApprovals
        task.browserRequirementDetail = browserRequirementDetail(summary.requestRequirements,
                                                                 routes: summary.routeControls ?? [])
        task.applyRouteFacts(summary)
        // Missing engine telemetry is disclosed, never replaced with a guess.
        if summary.webEvidence?.available == false {
            task.webEvidenceStatus = nil
            task.webEvidenceDetail = RouteControlsPresentation.telemetryUnavailable
        } else {
            task.webEvidenceStatus = summary.webEvidence?.status
            task.webEvidenceDetail = webEvidenceDetail(summary.webEvidence)
        }
        task.artifactPaths = summary.failure.map {
            ($0.rawDetailRef.map { [$0] } ?? []) + $0.eventRefs + $0.logRefs
        } ?? []
        if let failure = summary.failure { task.diagnosticText = failure.safeMessage }
        return task
    }

    private static func prettyTitle(_ id: String) -> String {
        "Live run · " + String(id.suffix(8))
    }

    static func webEvidenceDetail(_ evidence: WebEvidence?) -> String? {
        guard let evidence, evidence.attempted || evidence.required else { return nil }
        var parts = ["web \(evidence.status)"]
        if let effective = evidence.effectiveMode, effective != evidence.mode {
            parts.append("requested \(evidence.mode) → route policy \(effective)")
        }
        if let tool = evidence.tool { parts.append(tool) }
        if let target = evidence.target { parts.append(target) }
        if let error = evidence.errorSummary { parts.append(error) }
        return parts.joined(separator: " · ")
    }

    /// Merge the parent's bounded direct-child snapshot into the global task
    /// collection. Exact server-owned lineage is required; unrelated or
    /// malformed rows fail closed. This is restoration-only: without a
    /// per-child event cursor, a parent snapshot must never overwrite a child
    /// row that may already contain newer list/detail/SSE state.
    static func mergingDelegatedChildren(
        _ summaries: [RunSummary],
        parentRunId: String,
        into tasks: [TaskRun]
    ) -> [TaskRun] {
        var merged = tasks
        for summary in summaries where summary.delegatedFromRunId == parentRunId {
            let alreadyRepresented = merged.contains {
                $0.id == summary.runId || summary.jobId == $0.id
            }
            if !alreadyRepresented {
                merged.append(liveTask(from: summary))
            }
        }
        return merged
    }

    static func restoredActiveChildIds(
        _ summaries: [RunSummary],
        parentRunId: String,
        existingIds: Set<String>
    ) -> [String] {
        summaries.compactMap { summary in
            guard summary.delegatedFromRunId == parentRunId,
                  !existingIds.contains(summary.runId),
                  summary.jobId.map(existingIds.contains) != true,
                  RunPhase(api: summary.state).isActive else { return nil }
            return summary.runId
        }
    }

    /// A bounded global runs refresh must not immediately delete the older
    /// parent/child rows restored for the selected thread. Preserve only that
    /// selected family, in its existing order; unrelated off-page history is
    /// still reclaimed.
    static func preservingSelectedThreadFamily(
        refreshed: [TaskRun],
        existing: [TaskRun],
        parentRunIds: Set<String>
    ) -> [TaskRun] {
        var result = refreshed
        var ids = Set(refreshed.map(\.id))
        for task in existing {
            let selectedParent = parentRunIds.contains(task.id)
            let selectedChild = task.delegatedFromRunId.map(parentRunIds.contains) == true
            if (selectedParent || selectedChild), ids.insert(task.id).inserted {
                result.append(task)
            }
        }
        return result
    }
}
