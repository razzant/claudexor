import Foundation
import ClaudexorKit

extension AppModel {
    /// Rebuild a live `TaskRun` from a fresh `GET /v2/runs` summary while PRESERVING
    /// the truth only Run Detail hydrates. A list summary carries the terminal axes
    /// but never the detail-only satellites, so a `loadRunDetail → refreshRuns`
    /// sequence would otherwise WIPE visible receipts (round-3 crit #1): the
    /// subscription valuation, council roster, server outcome banner, single-producer
    /// apply eligibility, plan readiness/questions, candidate cards, the operator
    /// decision gate, and the last delivery receipt. EVERY detail-only projection is
    /// carried forward from `existing` when the summary offers no replacement — the
    /// same last-hydrated-wins rule the answerText/applyState fields already use.
    static func mergeRefreshedTask(summary: RunSummary, existing: TaskRun?) -> TaskRun {
        var task = liveTask(from: summary)
        guard let existing else { return task }
        // Locally-hydrated payloads the summary never re-sends.
        if !existing.activity.isEmpty { task.activity = existing.activity }
        if !existing.diff.isEmpty { task.diff = existing.diff }
        if !existing.findings.isEmpty { task.findings = existing.findings }
        task.reviewVerdict = existing.reviewVerdict
        if !existing.plan.isEmpty { task.plan = existing.plan }
        task.answerText = existing.answerText ?? task.answerText
        task.diagnosticText = existing.diagnosticText ?? task.diagnosticText
        if task.artifactPaths.isEmpty { task.artifactPaths = existing.artifactPaths }
        // Carry hydrated questions only while the daemon still says the run waits on
        // the user; otherwise an answered/timed-out interaction would resurrect on
        // every list refresh.
        if task.pendingInteractions.isEmpty, task.waitingOnUser { task.pendingInteractions = existing.pendingInteractions }
        task.observedModel = task.observedModel ?? existing.observedModel
        if task.routeProof == .unverified, existing.routeProof != .unverified { task.routeProof = existing.routeProof }
        task.authRoute = task.authRoute ?? existing.authRoute
        task.failureCategory = task.failureCategory ?? existing.failureCategory
        // Detail-only truth the list summary NEVER carries (crit #1): the summary
        // build resets these to nil/empty, so a refresh mid-thread would blank the
        // Run Detail receipts unless the last hydrated value is kept.
        task.valuationUsd = task.valuationUsd ?? existing.valuationUsd
        task.council = task.council ?? existing.council
        task.outcomeBanner = task.outcomeBanner ?? existing.outcomeBanner
        task.applyEligibility = task.applyEligibility ?? existing.applyEligibility
        task.planReadiness = task.planReadiness ?? existing.planReadiness
        task.operatorDecisionAction = task.operatorDecisionAction ?? existing.operatorDecisionAction
        task.deliveryReceipt = task.deliveryReceipt ?? existing.deliveryReceipt
        if task.planQuestions.isEmpty { task.planQuestions = existing.planQuestions }
        if task.candidates.isEmpty { task.candidates = existing.candidates }
        // List summaries carry no result: keep the last hydrated apply truth as ONE
        // unit (no flicker).
        if task.applyState == "not_applied",
           existing.applyState != "not_applied" || existing.adopted || existing.revertable {
            task.applyState = existing.applyState
            task.adopted = existing.adopted
            task.revertable = existing.revertable
        }
        return task
    }
}
