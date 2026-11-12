import Foundation
import ClaudexorKit

struct RunDetailLoadKey: Hashable {
    let locationID: ExecutionLocationID
    let runId: String
}

extension AppModel {
    /// Load run detail from the daemon that owns the execution location.
    ///
    /// Local detail hydration stays on the mainline request owner in
    /// `AppModel+RunDetailLoading`; remote rows are kept in their location-scoped
    /// collection so identical daemon run ids can never collide.
    @discardableResult
    func loadRunDetail(_ id: String, locationID: ExecutionLocationID) async -> Bool {
        if locationID == .local {
            await loadRunDetail(id)
            return hydratedRunDetails.contains(id)
        }
        return await performRemoteRunDetailLoad(id, locationID: locationID)
    }

    private func performRemoteRunDetailLoad(
        _ id: String,
        locationID: ExecutionLocationID
    ) async -> Bool {
        let loadKey = RunDetailLoadKey(locationID: locationID, runId: id)
        let loadToken = UUID()
        remoteRunDetailLoadTokens[loadKey] = loadToken
        defer {
            if remoteRunDetailLoadTokens[loadKey] == loadToken {
                remoteRunDetailLoadTokens[loadKey] = nil
            }
        }
        guard let requestClient = gateway(for: locationID) else { return false }
        let original = remoteTasks[locationID]?.first { $0.id == id || $0.resolvedRunId == id }
        guard original != nil || selectedThreadAuthorizesColdRun(id) else { return false }
        do {
            let detail = try await requestClient.runDetail(runId: id)
            guard selectedExecutionLocation == locationID,
                  gateway(for: locationID) === requestClient,
                  remoteRunDetailLoadTokens[loadKey] == loadToken
            else { return false }
            var task = Self.liveTask(from: detail.summary)
            task.diff = original?.diff ?? []
            task.operatorDecisionAction = detail.operatorDecisionAction
            task.outcomeBanner = detail.outcomeBanner
            task.applyEligibility = detail.applyEligibility
            task.planReadiness = detail.planReadiness
            task.planQuestions = detail.planQuestions
            task.council = detail.council
            task.pendingInteractions = detail.pendingInteractions
            task.waitingOnUser =
                detail.summary.waitingOnUser ?? !detail.pendingInteractions.isEmpty
            task.artifactPaths = detail.artifacts.map(\.path)
            if let planItems = RunDetailMapping.planItems(detail.planProgress) {
                task.plan = planItems
            }
            task.candidates = RunDetailMapping.candidates(
                detail.candidates, runPhase: task.phase)
            if let budget = detail.budget {
                if let cap = budget.maxUsd { task.capUsd = cap }
                if let spend = budget.spendUsd { task.spendUsd = spend }
                task.capKnown = budget.maxUsd != nil
                task.spendKnown = budget.spendUsd != nil
                task.spendEstimated = budget.estimated
                task.controllableSpendUsd = budget.controllableSpendUsd
                task.valuationUsd = budget.knownValuationUsd
            }
            if !detail.timeline.isEmpty {
                task.activity = detail.timeline.map(Self.activityEvent(from:))
            }
            task.adoptPrimaryOutput(detail)
            task.answerText = await answerText(
                for: detail, client: requestClient, runId: id)
            guard selectedExecutionLocation == locationID,
                  gateway(for: locationID) === requestClient,
                  remoteRunDetailLoadTokens[loadKey] == loadToken,
                  detail.summary.runId == id else { return false }
            if remoteTasks[locationID]?.contains(where: { $0.id == id }) != true {
                guard selectedThreadAuthorizesColdRun(id) else { return false }
                remoteTasks[locationID, default: []].append(task)
            }
            guard let index = remoteTasks[locationID]?.firstIndex(where: { $0.id == id }) else { return false }
            let failure = detail.failure ?? detail.summary.failure
            let findings = detail.reviewFindings.compactMap {
                Self.finding(from: $0, taskTitle: task.title)
            }
            if !findings.isEmpty { task.findings = findings }
            task.reviewVerdict = RunDetailMapping.reviewVerdict(
                decision: detail.decision,
                candidates: detail.candidates,
                findings: task.findings,
                failure: failure,
                phase: task.phase,
                outcomeFacts: task.outcomeFacts)
            task.diagnosticText = RunDiagnosticsPresentation.summary(
                detail: detail, error: task.engineError)
            reconcileHistoryInteractions(&task, lastSeq: detail.lastSeq, at: locationID)
            foldTimelineNotices(id, detail.timeline, at: locationID)
            remoteTasks[locationID]?[index] = task
            remoteTasks[locationID] = Self.mergingDelegatedChildren(
                detail.children, parentRunId: detail.summary.runId, into: remoteTasks[locationID] ?? [])
            publishHistoryLive(task, locationID: locationID)
            return true
        } catch {
            guard gateway(for: locationID) === requestClient,
                  remoteRunDetailLoadTokens[loadKey] == loadToken,
                  let index = remoteTasks[locationID]?.firstIndex(where: {
                      $0.id == id || $0.resolvedRunId == id
                  })
            else { return false }
            let message = "Could not load run detail: \(error)"
            remoteTasks[locationID]?[index].engineError = message
            remoteTasks[locationID]?[index].diagnosticText = message
            return false
        }
    }
}
