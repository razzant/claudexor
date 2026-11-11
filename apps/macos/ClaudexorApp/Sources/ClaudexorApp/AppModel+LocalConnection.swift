import Foundation
import ClaudexorKit

// MARK: - Local engine connection and exact runtime coherence

extension AppModel {
    func connect(ifCurrentGeneration expected: Int? = nil, allowInitialLaunch: Bool = true) async {
        if let expected, connectionGeneration != expected { return }
        connectionGeneration += 1
        let generation = connectionGeneration
        // A loop that may start an engine itself no longer depends on one.
        if allowInitialLaunch { localSuccessorPending = false }
        retireLocalDaemonBuildSwitchProgress()
        retireLocalDaemonBuildSwitchOffer()
        // Retire the previous exact client synchronously, before the new
        // generation's first suspension. Every projection owner can now reject
        // an old response by client identity even while discovery/handshake for
        // the successor is still in flight.
        client = nil
        endpoint = ""
        engineIdentity = nil
        health = .connecting
        cancelAllStreams()
        await localConnectionRecovery(generation: generation).run(launchAvailable: allowInitialLaunch)
    }

    /// Keep polling the exact client an explicit build-switch request left
    /// serving, under that request's generation: nothing is retired, launched
    /// or re-hydrated. Without a client there is nothing to resume.
    func resumeLocalConnection(generation: Int) async {
        guard connectionGeneration == generation else { return }
        guard client != nil else {
            await connect(ifCurrentGeneration: generation, allowInitialLaunch: false)
            return
        }
        await localConnectionRecovery(generation: generation).run(resumingConnection: true)
    }

    private func localConnectionRecovery(generation: Int) -> LocalConnectionRecoveryLoop {
        LocalConnectionRecoveryLoop(
            generation: generation,
            currentGeneration: { self.connectionGeneration },
            lifecycleOwner: localRuntimeLifecycleOwner,
            prepareProbe: {
                self.health = .connecting
                self.cancelAllStreams()
            },
            probe: { await self.tryConnect(generation: generation) },
            engineAnswers: { await self.localEngineAnswers() },
            pollConnected: {
                guard self.client != nil else { return .unavailable }
                return await self.pollLocalConnection(generation: generation)
            },
            startDaemon: { DaemonLauncher.startIfNeeded(launchPermit: $0) },
            enterOffline: { self.enterLocalOffline() },
            lifecycleRefused: { refusal in
                self.setLocalDaemonReconciliationNotice(refusal.map {
                    "Claudexor did not start the engine: \($0.reason)."
                })
            },
            pause: { try? await Task.sleep(for: .seconds(3)) })
    }

    /// Drop every daemon-owned projection when the engine is unreachable. The
    /// reconnect path repopulates these from `/v2`; user preferences and the
    /// current composer draft remain local and are intentionally preserved.
    func enterHardOffline() {
        localDaemonBuildSwitch = nil
        let keepRemoteSelection = activeExecutionLocation != .local
        health = .offline
        endpoint = ""
        client = nil
        engineIdentity = nil
        authSheetTarget = nil
        cancelAllStreams()
        // Retire queued settings ops (X20) but KEEP the chain tail (X30): a
        // post-reconnect op must still await the old in-flight request, or two
        // settings requests overlap on the wire and break the X14 single-chain
        // criterion. Old ops retire inert through their epoch guards.
        settingsEpoch += 1
        retireHarnessProjection(at: .local)

        if !keepRemoteSelection { route = .threads }
        liveTasks.removeAll()
        discardCancelledRunMemory(at: .local)
        transcripts.removeAll()
        liveBoxes.removeAll()
        retireRunDetailState(cancelInFlight: true)
        runListReconciliationNeeded = false
        if !keepRemoteSelection { turnSubmitting = false }

        threads.removeAll()
        projectListingProblems.removeAll()
        registeredProjects.removeAll()
        if !keepRemoteSelection {
            selectedThreadId = nil
            selectedThreadDetail = nil
            selectedHistory = nil
            threadStatus = nil
            threadLoadGeneration += 1
        }

        liveHarnesses.removeAll()
        harnessReadinessFresh = nil
        gitCapability = nil
        retireRunApplicability(at: .local)
        // X140 class: the credential-profile + harness-account registries load on
        // connect and feed the sessions footer/accounts surfaces — leaving them
        // presents the last daemon's registry as truth. Reconnect repopulates.
        credentialProfiles.removeAll()
        accountPools.removeAll()
        retireAccountsRequests(at: .local)
        accountsRegistryLoadStates.removeValue(forKey: .local)
        accountsLoadTokens.removeValue(forKey: .local)
        accountsLoadStates.removeValue(forKey: .local)
        accountsReadinessAuthorityFresh.removeValue(forKey: .local)
        accountsNextUpAuthorityFresh.removeValue(forKey: .local)
        suspendAccountsQuotaObserver(at: .local, discardCursor: true)
        exactAuthSources.removeAll()
        settingsSnapshot = nil
        settingsLoadTokens.removeValue(forKey: .local)
        settingsLoadStates.removeValue(forKey: .local)
        settingsStatus = nil
        retireAccountsQuotaDisplayRequest(at: .local, discardProjection: true)
        quotaStatus = nil
        secretBackend = "unknown"
        storedSecrets.removeAll()
        trustEntries.removeAll()
        trustStatus = nil
    }

    /// A daemon replacement cannot inherit a local cancel verdict for a reused
    /// run id. Keep cancellation memory scoped to the exact location epoch.
    func discardCancelledRunMemory(at locationID: ExecutionLocationID) {
        let prefix = "\(locationID.rawValue)|"
        cancelledRunIds = Set(cancelledRunIds.filter { !$0.hasPrefix(prefix) })
    }

    func rememberRunCancelled(_ id: String, at locationID: ExecutionLocationID) {
        cancelledRunIds.insert(locatedRunKey(id, at: locationID))
    }

    func wasRunCancelled(_ id: String, at locationID: ExecutionLocationID) -> Bool {
        cancelledRunIds.contains(locatedRunKey(id, at: locationID))
    }

    /// Retire every per-run detail owner at a connection boundary. Tests may
    /// leave the old task uncancelled to release its response after a new
    /// same-id request and prove the client/token fences deterministically.
    func retireRunDetailState(cancelInFlight: Bool) {
        snapshotLoadDepth.removeAll()
        snapshotReplayFences.removeAll()
        hydratedRunDetails.removeAll()
        if cancelInFlight {
            for task in runDetailLoads.values { task.cancel() }
        }
        runDetailLoads.removeAll()
        runDetailLoadTokens.removeAll()
        runDetailTrailing.removeAll()
        runDetailAcceptingTrailing.removeAll()
        deferredEnvelopes.removeAll()
        deferredOverflow.removeAll()
    }

    /// Publish exact-closure coherence independently from update/install state.
    private func setLocalDaemonReconciliationNotice(_ notice: String?) {
        localDaemonReconciliationNotice = notice
    }

    /// A lifecycle this app ran ended without an engine the loop will start by
    /// itself: keep its reason visible and offer Retry until one is adopted.
    func publishLocalLifecycleFailure(_ notice: String) {
        localDaemonReconciliationNotice = notice
        localEngineAwaitsRetry = true
        localSuccessorPending = false
    }

    /// The connection loop's Offline transition. If the engine this app just
    /// started was lost before any connection adopted it, the loop's start was
    /// already spent on that lifecycle, so this is a lifecycle failure too.
    func enterLocalOffline() {
        enterHardOffline()
        if localSuccessorPending {
            publishLocalLifecycleFailure(LocalDaemonReconciliationPolicy.lostSuccessorNotice)
        }
    }

    private func tryConnect(generation: Int) async -> LocalConnectionProbeResult {
        do {
            let discovery = try ControlApiDiscovery.load()
            let candidate = try discovery.makeClient()
            return await tryConnect(
                candidate: candidate,
                endpoint: "\(discovery.host):\(discovery.port)",
                generation: generation)
        } catch {
            return localConnectionGenerationIsCurrent(generation)
                ? .unavailable : .superseded
        }
    }

    /// One fresh discovery read and handshake that adopts nothing. Outage
    /// recovery asks it while holding its lease, right before a launch.
    private func localEngineAnswers() async -> Bool {
        guard let candidate = try? ControlApiDiscovery.load().makeClient() else { return false }
        return (try? await candidate.handshake())?.ok == true
    }

    /// Injected candidate seam for deterministic connection-generation tests.
    /// Discovery and candidate construction remain side-effect-free; this method
    /// owns the first handshake and the single generation-bound adoption point.
    func tryConnect(
        candidate: GatewayClient,
        endpoint candidateEndpoint: String,
        generation: Int
    ) async -> LocalConnectionProbeResult {
        do {
            // One handshake serves both the connectivity verdict AND the engine
            // build identity (QA-002): retain what the daemon discloses instead
            // of a bare Bool that drops version/sha on the floor.
            let outcome = try await candidate.handshake()
            guard localConnectionGenerationIsCurrent(generation) else {
                return .superseded
            }
            if outcome.ok {
                // Issue #165 D5: a recovery-only daemon owns the endpoint but
                // keeps product admission closed. Stay in the existing
                // Connecting behavior — no adoption, no hydration, no
                // reconciliation lifecycle, no fallback launch — and keep
                // polling the handshake until normal admission opens. No build
                // switch can be offered against it either.
                if outcome.recoveryOnly {
                    retireLocalDaemonBuildSwitchOffer()
                    return .retryWithoutLaunch
                }
                let policy = await localDaemonPolicy(for: outcome.engine, generation: generation)
                switch policy {
                case .useCompatible, .unobserved:
                    guard localConnectionGenerationIsCurrent(generation) else {
                        return .superseded
                    }
                    endpoint = candidateEndpoint
                    adoptClientForReconnect(candidate)
                    localEngineAwaitsRetry = false
                    localSuccessorPending = false
                    // A new connection publishes only its own observation.
                    // Contention made none yet, so nothing earlier stays.
                    if case let .useCompatible(notice) = policy {
                        setLocalDaemonReconciliationNotice(notice)
                    } else {
                        localDaemonBuildSwitch = nil
                        setLocalDaemonReconciliationNotice(nil)
                    }
                    engineIdentity = outcome.engine
                    health = .connected
                    await refreshRuns()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    await refreshSettings()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    await refreshSecrets()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    await refreshThreads()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    await refreshProjects()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    // The full Accounts snapshot is intentionally explicit-only.
                    // Connect hydrates the cached harness + registry owners.
                    _ = await refreshHarnesses()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    // QA-065: resolve credential-profile DISPLAY NAMES on connect, not
                    // only when the accounts popover opens — otherwise the sessions
                    // footer shows raw profile ids by default until that popover loads.
                    await refreshCredentialProfiles()
                    guard localConnectionLeaseIsCurrent(generation, candidate) else {
                        return .superseded
                    }
                    // A popover may survive a transient reconnect. Its existing
                    // subscriber does not re-run onAppear, so resume exactly one
                    // cheap display read against the replacement gateway.
                    scheduleAccountsQuotaDisplayHydration(at: .local)
                    startGlobalStream()
                    return .connected
                case .reconnect:
                    guard localConnectionGenerationIsCurrent(generation) else {
                        return .superseded
                    }
                    setLocalDaemonReconciliationNotice(nil)
                    client = nil
                    endpoint = ""
                    engineIdentity = nil
                    health = .connecting
                    return .reconnect
                case let .failOffline(notice):
                    guard localConnectionGenerationIsCurrent(generation) else {
                        return .superseded
                    }
                    publishLocalLifecycleFailure(notice)
                    client = nil
                    engineIdentity = nil
                    return .lifecycleFailed
                case .superseded:
                    return .superseded
                case .retry:
                    return .retryWithoutLaunch
                }
            }
        } catch {
            // fall through to caller (offline / auto-start path)
        }
        return localConnectionGenerationIsCurrent(generation) ? .unavailable : .superseded
    }

    /// One steady-state connectivity poll (round-4 #5 / QA-002): re-HANDSHAKE
    /// rather than the bare `health()` Bool, so a daemon SWAPPED at the same
    /// endpoint refreshes its disclosed build identity instead of pinning the old
    /// version/sha in About forever. A dropped or incompatible handshake returns
    /// false → the caller falls to the reconnect path.
    @discardableResult
    func pollEngineIdentity() async -> Bool {
        await pollLocalConnection() == .connected
    }

    /// Typed steady-state poll. The recovery loop must distinguish an ordinary
    /// transport loss (which earns one outage launch) from reconciliation that
    /// already launched, or attempted to launch, the selected closure.
    func pollLocalConnection(generation: Int? = nil) async -> LocalConnectionProbeResult {
        guard let current = client else {
            return requestedConnectionGenerationIsCurrent(generation)
                ? .unavailable : .superseded
        }
        guard let outcome = try? await current.handshake(), outcome.ok else {
            guard requestedConnectionGenerationIsCurrent(generation) else {
                return .superseded
            }
            // The engine these facts described stopped answering. Connecting
            // and Offline must not keep its build offer or its notice.
            localDaemonBuildSwitch = nil
            setLocalDaemonReconciliationNotice(nil)
            return .unavailable
        }
        guard requestedConnectionGenerationIsCurrent(generation) else {
            return .superseded
        }
        // A connected daemon that re-enters recovery (restart into a
        // recovery-needed root) closes product admission: fall back to the
        // Connecting discovery loop without inventing an outage launch.
        if outcome.recoveryOnly {
            retireLocalDaemonBuildSwitchOffer()
            return .retryWithoutLaunch
        }
        let policy = await localDaemonPolicy(for: outcome.engine, generation: generation)
        switch policy {
        case .useCompatible, .unobserved:
            guard requestedConnectionGenerationIsCurrent(generation), client === current else {
                return .superseded
            }
            if case let .useCompatible(notice) = policy {
                setLocalDaemonReconciliationNotice(notice)
            } else if engineIdentity != outcome.engine {
                // Contention observed nothing, but this handshake names another
                // engine: what was published for the previous one no longer applies.
                localDaemonBuildSwitch = nil
                setLocalDaemonReconciliationNotice(nil)
            }
            engineIdentity = outcome.engine
            return .connected
        case .reconnect:
            guard requestedConnectionGenerationIsCurrent(generation) else {
                return .superseded
            }
            // The old handshake and the replacement's internal proof are both
            // deliberately unpublished. The connect owner reacquires discovery,
            // handshakes again, then hydrates the new daemon as one coherent unit.
            setLocalDaemonReconciliationNotice(nil)
            client = nil
            endpoint = ""
            engineIdentity = nil
            health = .connecting
            cancelAllStreams()
            return .reconnect
        case let .failOffline(notice):
            guard requestedConnectionGenerationIsCurrent(generation) else {
                return .superseded
            }
            publishLocalLifecycleFailure(notice)
            client = nil
            engineIdentity = nil
            cancelAllStreams()
            return .lifecycleFailed
        case .superseded:
            return .superseded
        case .retry:
            return .retryWithoutLaunch
        }
    }

    private func localConnectionGenerationIsCurrent(_ generation: Int) -> Bool {
        !Task.isCancelled && connectionGeneration == generation
    }

    private func localConnectionLeaseIsCurrent(
        _ generation: Int,
        _ requestClient: GatewayClient
    ) -> Bool {
        localConnectionGenerationIsCurrent(generation) && client === requestClient
    }

    private func requestedConnectionGenerationIsCurrent(_ generation: Int?) -> Bool {
        guard let generation else { return !Task.isCancelled }
        return localConnectionGenerationIsCurrent(generation)
    }
}
