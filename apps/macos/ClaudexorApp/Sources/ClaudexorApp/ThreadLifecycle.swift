import Foundation
import ClaudexorKit

/// Thread lifecycle actions (rename / archive / reopen) — server-owned via
/// the one PATCH /threads/:id endpoint; the app never invents thread state.
extension AppModel {
    func openThread(_ id: String) async {
        await openThread(locationID: .local, id: id)
    }

    func openThread(locationID: ExecutionLocationID, id: String) async {
        await loadThread(locationID: locationID, id: id, mayReconnect: true)
    }

    func refreshOpenThread(locationID: ExecutionLocationID, id: String, mayReconnect: Bool = false) async {
        guard selectedExecutionLocation == locationID, selectedThreadId == id else { return }
        await loadThread(locationID: locationID, id: id, mayReconnect: mayReconnect)
    }

    private func loadThread(locationID: ExecutionLocationID, id: String, mayReconnect: Bool) async {
        let changed = selectedHistory?.locationID != locationID || selectedHistory?.threadID != id
        if changed {
            if locationID == .local, selectedThreadId != nil, selectedThreadId != id, !liveTasks.isEmpty {
                runListReconciliationNeeded = true
            }
            threadLoadGeneration += 1
            selectedThreadDetail = nil
            hydratedRunDetails.removeAll()
            selectedHistory = makeHistoryStore(locationID: locationID, id: id)
        }
        selectedExecutionLocation = locationID
        selectedThreadId = id
        let history = selectedHistory!
        threadStatus = nil
        if gateway(for: locationID) == nil, mayReconnect, let connectionID = locationID.remoteConnectionID {
            pendingRemoteThreadSelection = (locationID, id)
            await connectRemote(connectionID)
        }
        guard selectedHistory === history else { return }
        guard gateway(for: locationID) != nil else {
            let message = "This host is offline. Reconnect it to load the conversation."
            threadStatus = message
            if history.header == nil { history.state = .failed(message) }
            return
        }
        pendingRemoteThreadSelection = nil
        // The global run-list reconciliation never gates this thread's page: it
        // runs beside the read and settles before eviction. Its refresh takes
        // the preserved family from the selection current when /runs answers.
        async let reconciliation: Void = reconcileRunList(at: locationID)
        await history.open()
        guard selectedHistory === history else { return }
        await loadHistoryDelegates(history)
        if let reason = history.errorMessage { threadStatus = "Could not load thread: \(reason)" }
        await reconciliation
        evictBackgroundRunData()
    }

    /// One bounded global refresh after a selection change; failure keeps it due.
    private func reconcileRunList(at locationID: ExecutionLocationID) async {
        guard locationID == .local, runListReconciliationNeeded else { return }
        let successes = successfulRunsRefreshes
        await refreshRuns()
        if successfulRunsRefreshes > successes { runListReconciliationNeeded = false }
    }

    func startDraftThread() {
        let previousLocation = selectedExecutionLocation
        let previousRoot = currentThread?.repoRoot
        runListReconciliationNeeded = runListReconciliationNeeded || !liveTasks.isEmpty
        hydratedRunDetails.removeAll()
        threadLoadGeneration += 1
        selectedThreadId = nil
        selectedThreadDetail = nil
        selectedHistory = nil
        threadStatus = nil
        if case .task = route { route = .threads }
        draftPrimaryHarness = nil
        draftEligiblePool = []
        draftCredentialProfileId = nil
        draftIsolatedWorkspace = false
        // QA-007: the sticky write scope must NOT leak from an earlier draft into
        // a fresh one. nil => the new target repo's own trust default is the
        // baseline; a stale Full is never carried into an unrelated project draft.
        draftThreadAccess = nil
        if previousLocation != .local, let previousRoot {
            draftExecutionLocation = previousLocation
            draftRemoteProjectRoot = previousRoot
        } else if previousLocation == .local {
            draftExecutionLocation = .local
            draftRemoteProjectRoot = nil
        }
    }

    /// Composer project chip — "No project (Ask only)" (QA-006). Returns the draft
    /// to no-project scope so a general read-only Ask is reachable again after any
    /// project has been used. A bound thread is immutable: start a NEW draft first,
    /// then clear its project (never mutate the bound thread). The empty choice
    /// persists (projectRoot didSet) so relaunch does not silently restore the
    /// former project; the MRU is preserved — "no project" is a scope choice, not
    /// an MRU deletion.
    func clearProject() {
        if selectedThreadId != nil { startDraftThread() }
        draftExecutionLocation = .local
        draftRemoteProjectRoot = nil
        projectRoot = ""
    }

    /// Apply a run's reviewed patch through the server-owned delivery gate.
    func applyRun(
        runId: String,
        mode: String = "apply",
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) async -> String? {
        let locationID = requestedLocationID ?? selectedExecutionLocation
        let selectionWasAtTarget = selectedExecutionLocation == locationID
        let targetThreadID = selectedThreadId
        guard let requestClient = gateway(for: locationID) else { return "Engine offline." }
        do {
            let result = try await requestClient.apply(
                runId: runId, body: ApplyRunRequest(mode: mode))
            guard isCurrentGateway(requestClient, at: locationID) else {
                return Self.turnStartConnectionChangedMessage
            }
            mutateTask(runId, at: locationID) { $0.deliveryReceipt = result }
            guard result.applied else { return result.detail ?? "Apply was refused." }
            guard selectionWasAtTarget,
                  selectedExecutionLocation == locationID,
                  selectedThreadId == targetThreadID
            else { return nil }
            if locationID == .local {
                await loadRunDetail(runId, locationID: locationID)
            } else {
                await refreshRemoteThreads(locationID, using: requestClient)
                if isCurrentGateway(requestClient, at: locationID),
                   selectedExecutionLocation == locationID,
                   selectedThreadId == targetThreadID,
                   let targetThreadID {
                    await openThread(locationID: locationID, id: targetThreadID)
                }
            }
            if isCurrentGateway(requestClient, at: locationID),
               selectedExecutionLocation == locationID,
               selectedThreadId == targetThreadID {
                route = .task(runId)
            }
            return nil
        } catch { return "Apply failed: \(error)" }
    }

    func retryRunExact(
        _ runId: String,
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) async -> String? {
        let locationID = requestedLocationID ?? selectedExecutionLocation
        let selectionWasAtTarget = selectedExecutionLocation == locationID
        let targetThreadID = selectedThreadId
        guard let requestClient = gateway(for: locationID) else { return "Engine offline." }
        do {
            let retry = try await requestClient.retryRun(runId: runId)
            guard isCurrentGateway(requestClient, at: locationID) else {
                return Self.turnStartConnectionChangedMessage
            }
            if locationID == .local, let id = retry.runId {
                stream(runId: id)
            }
            guard selectionWasAtTarget,
                  selectedExecutionLocation == locationID,
                  selectedThreadId == targetThreadID
            else { return nil }
            if locationID == .local {
                await refreshRuns()
                if isCurrentGateway(requestClient, at: locationID),
                   selectedExecutionLocation == locationID,
                   selectedThreadId == targetThreadID,
                   let id = retry.runId {
                    route = .task(id)
                }
            } else {
                await refreshRemoteThreads(locationID, using: requestClient)
                if isCurrentGateway(requestClient, at: locationID),
                   selectedExecutionLocation == locationID,
                   selectedThreadId == targetThreadID,
                   let targetThreadID {
                    await openThread(locationID: locationID, id: targetThreadID)
                }
            }
            return nil
        } catch { return "Retry failed: \(userMessage(for: error))" }
    }

    func loadRunAgainDraft(
        _ runId: String,
        locationID: ExecutionLocationID? = nil
    ) async -> RunAgainDraft? {
        guard let requestClient = gateway(for: locationID ?? selectedExecutionLocation) else { return nil }
        return try? await requestClient.runAgainDraft(runId: runId)
    }

    func startRunAgain(
        _ draft: RunAgainDraft,
        prompt: String,
        access: AccessProfile? = nil,
        locationID: ExecutionLocationID
    ) async -> String? {
        let selectionWasAtTarget = selectedExecutionLocation == locationID
        let targetThreadID = selectedThreadId
        guard let requestClient = gateway(for: locationID) else { return "Engine offline." }
        if draft.accessChoice.required && access == nil {
            return "Run Again requires an explicit access choice."
        }
        do {
            let result = try await requestClient.startRunAgain(
                request: draft.request, prompt: prompt, access: access?.wire)
            guard isCurrentGateway(requestClient, at: locationID) else {
                threadStatus =
                    "Run Again was accepted, but the engine connection changed before it could be refreshed."
                return nil
            }
            if locationID == .local {
                await refreshRuns()
            } else {
                await refreshRemoteThreads(locationID, using: requestClient)
            }
            guard isCurrentGateway(requestClient, at: locationID) else { return nil }
            if locationID == .local, case .started(let info) = result {
                stream(runId: info.runId)
                if selectionWasAtTarget,
                   selectedExecutionLocation == locationID,
                   selectedThreadId == targetThreadID {
                    route = .task(info.runId)
                }
            }
            return nil
        } catch { return "Run Again failed: \(userMessage(for: error))" }
    }

    /// Rename a thread: server-owned title via the existing PATCH.
    func renameThread(_ id: String, title: String) async {
        await renameThread(locationID: selectedExecutionLocation, id: id, title: title)
    }

    func renameThread(locationID: ExecutionLocationID, id: String, title: String) async {
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to rename."; return
        }
        do {
            let updated = try await requestClient.updateThread(
                id: id, body: UpdateThreadRequest(title: title))
            if locationID == .local {
                applyThreadUpdate(updated)
                await refreshThreads()
            } else {
                await refreshRemoteThreads(locationID)
                if selectedExecutionLocation == locationID, selectedThreadId == id {
                    await openThread(locationID: locationID, id: id)
                }
            }
        } catch { threadStatus = userMessage(for: error) }
    }

    /// Archive (close) a thread; it stays inspectable, out of the active list.
    func archiveThread(_ id: String) async {
        await setThreadState(locationID: selectedExecutionLocation, id: id, state: "closed")
    }

    func archiveThread(locationID: ExecutionLocationID, id: String) async {
        await setThreadState(locationID: locationID, id: id, state: "closed")
    }

    /// Reopen a previously archived thread. The server ThreadState enum is
    /// `active | closed` — "open" is NOT a member and 400s.
    func reopenThread(_ id: String) async {
        await setThreadState(locationID: selectedExecutionLocation, id: id, state: "active")
    }

    func reopenThread(locationID: ExecutionLocationID, id: String) async {
        await setThreadState(locationID: locationID, id: id, state: "active")
    }

    private func setThreadState(
        locationID: ExecutionLocationID,
        id: String,
        state: String
    ) async {
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to change thread state."; return
        }
        do {
            let updated = try await requestClient.updateThread(
                id: id, body: UpdateThreadRequest(state: state))
            if locationID == .local {
                applyThreadUpdate(updated)
                await refreshThreads()
            } else {
                await refreshRemoteThreads(locationID)
            }
        } catch { threadStatus = userMessage(for: error) }
    }
}

func isRecoverableRemoteTransportFailure(_ error: Error) -> Bool {
    guard let urlError = error as? URLError else { return false }
    switch urlError.code {
    case .cannotConnectToHost,
         .networkConnectionLost,
         .notConnectedToInternet,
         .timedOut,
         .cannotLoadFromNetwork:
        return true
    default:
        return false
    }
}
