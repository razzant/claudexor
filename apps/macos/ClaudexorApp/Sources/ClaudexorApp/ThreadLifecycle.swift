import Foundation
import ClaudexorKit

/// Thread lifecycle actions (rename / archive / reopen) — server-owned via
/// the one PATCH /threads/:id endpoint; the app never invents thread state.
extension AppModel {
    func openThread(_ id: String) async {
        await openThread(locationID: .local, id: id)
    }

    func openThread(locationID: ExecutionLocationID, id: String) async {
        await loadThread(
            locationID: locationID,
            id: id,
            mayReconnect: true,
            preserveExistingDetail: false)
    }

    /// Refresh the already-visible thread without replacing the conversation
    /// with the empty/loading state. Remote run streams call this repeatedly,
    /// so clearing `selectedThreadDetail` here would make the whole feed flash
    /// on every event.
    func refreshOpenThread(
        locationID: ExecutionLocationID,
        id: String,
        mayReconnect: Bool = false
    ) async {
        await loadThread(
            locationID: locationID,
            id: id,
            mayReconnect: mayReconnect,
            preserveExistingDetail: true)
    }

    private func loadThread(
        locationID: ExecutionLocationID,
        id: String,
        mayReconnect: Bool,
        preserveExistingDetail: Bool
    ) async {
        let keepsVisibleDetail =
            preserveExistingDetail
            && selectedExecutionLocation == locationID
            && selectedThreadId == id
            && selectedThreadDetail?.thread.id == id
        if gateway(for: locationID) == nil, let connectionID = locationID.remoteConnectionID {
            selectedExecutionLocation = locationID
            selectedThreadId = id
            if !keepsVisibleDetail { selectedThreadDetail = nil }
            if mayReconnect {
                pendingRemoteThreadSelection = (locationID, id)
                await connectRemote(connectionID)
            }
        }
        guard let requestClient = gateway(for: locationID) else {
            selectedExecutionLocation = locationID
            selectedThreadId = id
            if !keepsVisibleDetail { selectedThreadDetail = nil }
            threadStatus = "This host is offline. Reconnect it to load the conversation."
            return
        }
        if pendingRemoteThreadSelection?.locationID == locationID,
           pendingRemoteThreadSelection?.threadID == id
        {
            pendingRemoteThreadSelection = nil
        }
        // View hydration is presentation-scoped. Once another thread is
        // selected, a later bounded runs refresh may evict this thread's
        // off-page Delegate family; reopening must be allowed to restore it.
        let reconcileRunList = locationID == .local && (
            runListReconciliationNeeded || (
                selectedThreadId != nil && selectedThreadId != id && !liveTasks.isEmpty
            )
        )
        if locationID == .local, selectedThreadId != id {
            hydratedRunDetails.removeAll()
        }
        threadLoadGeneration += 1
        let generation = threadLoadGeneration
        selectedExecutionLocation = locationID
        selectedThreadId = id
        if !keepsVisibleDetail { selectedThreadDetail = nil }
        threadStatus = nil
        // Start the new thread fetch before reconciling the bounded global run
        // page. The two requests overlap, while the list pass reclaims any
        // detail-restored family from the previous selection in a quiet daemon.
        let detailLoad = Task { try await requestClient.threadDetail(id: id) }
        if reconcileRunList {
            // Dirty-before-I/O: a direct A→B switch must retry reclamation if
            // this bounded list request fails, just like the draft detour.
            runListReconciliationNeeded = true
            let refreshSuccesses = successfulRunsRefreshes
            await refreshRuns()
            guard isCurrentGateway(requestClient, at: locationID),
                  selectedExecutionLocation == locationID,
                  selectedThreadId == id,
                  threadLoadGeneration == generation
            else { return }
            if successfulRunsRefreshes > refreshSuccesses {
                runListReconciliationNeeded = false
            }
        }
        do {
            let detail = try await detailLoad.value
            guard isCurrentGateway(requestClient, at: locationID),
                  selectedExecutionLocation == locationID,
                  selectedThreadId == id,
                  threadLoadGeneration == generation
            else { return }
            selectedThreadDetail = detail
            guard isCurrentGateway(requestClient, at: locationID),
                  selectedExecutionLocation == locationID,
                  selectedThreadId == id, threadLoadGeneration == generation else { return }
            evictBackgroundRunData()
            // Existing run projection is local-daemon scoped. Remote chat cards
            // carry their server-owned run summaries inline and are refreshed by
            // the remote poller, avoiding daemon-id collisions.
            if locationID == .local {
                for turn in detail.turns.suffix(5) {
                    guard isCurrentGateway(requestClient, at: locationID),
                          selectedThreadId == id,
                          threadLoadGeneration == generation
                    else { return }
                    if let runId = turn.runId {
                        let missing = !liveTasks.contains(where: { $0.id == runId })
                        if !missing || turn.run?.delegation?.requested == true {
                            await ensureRunDetail(runId, insertingIfMissing: missing)
                        }
                    }
                }
            } else {
                // Match local bounded hydration: completed remote turns carry
                // detail-only apply/evidence fields that the runs list omits.
                for turn in detail.turns.suffix(5) {
                    guard isCurrentGateway(requestClient, at: locationID),
                          selectedExecutionLocation == locationID,
                          selectedThreadId == id,
                          threadLoadGeneration == generation
                    else { return }
                    if let runID = turn.runId,
                       remoteTasks[locationID]?.contains(where: { $0.id == runID }) == true
                    {
                        await loadRunDetail(runID, locationID: locationID)
                    }
                }
                if let runID = detail.thread.headRunId,
                   remoteTasks[locationID]?.first(where: {
                       $0.id == runID
                   })?.phase.isActive == true
                {
                    streamRemoteRun(
                        locationID: locationID, runID: runID, threadID: id)
                }
            }
        } catch {
            guard isCurrentGateway(requestClient, at: locationID),
                  selectedExecutionLocation == locationID,
                  selectedThreadId == id, threadLoadGeneration == generation else { return }
            if mayReconnect,
               isRecoverableRemoteTransportFailure(error),
               let connectionID = locationID.remoteConnectionID
            {
                let host = remoteConnection(for: locationID)?.displayName ?? "remote host"
                threadStatus = "Reconnecting to \(host)…"
                pendingRemoteThreadSelection = (locationID, id)
                await disconnectRemote(connectionID)
                await connectRemote(connectionID)
                guard selectedExecutionLocation == locationID,
                      selectedThreadId == id
                else { return }
                if gateway(for: locationID) != nil {
                    await loadThread(
                        locationID: locationID,
                        id: id,
                        mayReconnect: false,
                        preserveExistingDetail: keepsVisibleDetail)
                } else {
                    threadStatus =
                        remoteConnectionMessages[connectionID]
                        ?? "Could not reconnect to \(host)."
                }
                return
            }
            let detail = locationID == .local
                ? userMessage(for: error)
                : userMessageForRemote(error)
            threadStatus = "Could not load thread: \(detail)"
        }
    }

    func startDraftThread() {
        let previousLocation = selectedExecutionLocation
        let previousRoot = currentThread?.repoRoot
        runListReconciliationNeeded = runListReconciliationNeeded || !liveTasks.isEmpty
        hydratedRunDetails.removeAll()
        threadLoadGeneration += 1
        selectedThreadId = nil
        selectedThreadDetail = nil
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

    /// Permanent delete is deliberately two-phase: the server must acknowledge
    /// recoverable trash before the irreversible purge is attempted.
    func permanentlyDeleteThread(locationID: ExecutionLocationID, id: String) async {
        func refreshProjection() async {
            if locationID == .local {
                await refreshThreads()
            } else {
                await refreshRemoteThreads(locationID)
            }
        }

        guard !isThreadBusy(id, at: locationID) else {
            threadStatus = "Stop the running turn before permanently deleting this thread."
            return
        }
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to delete this thread."
            return
        }
        var trashed = false
        do {
            _ = try await requestClient.trashThread(id: id)
            trashed = true
            guard isCurrentGateway(requestClient, at: locationID) else {
                await refreshProjection()
                threadStatus = "Engine connection changed after trashing; permanent deletion was not attempted."
                return
            }
            _ = try await requestClient.purgeThread(id: id)
            guard isCurrentGateway(requestClient, at: locationID) else {
                await refreshProjection()
                threadStatus = "Thread was purged, but the engine connection changed before refresh."
                return
            }

            if selectedExecutionLocation == locationID, selectedThreadId == id {
                startDraftThread()
            }
            await refreshProjection()
        } catch {
            if trashed {
                await refreshProjection()
                threadStatus = "Thread was trashed, but permanent deletion could not be confirmed: \(userMessage(for: error))"
            } else {
                threadStatus = "Could not permanently delete thread: \(userMessage(for: error))"
            }
        }
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
