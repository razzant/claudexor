import Foundation
import ClaudexorKit

/// What one Settings switch request leaves for the connection loop that takes
/// over its generation.
enum LocalDaemonBuildSwitchReceipt: Equatable {
    /// The compatible engine still serves the exact client: keep polling it.
    case resume(generation: Int)
    /// The client was retired or must be re-acquired before anything hydrates.
    case reconnect(generation: Int)
}

extension AppModel {
    private func daemonReconciliationOwner() -> LocalDaemonReconciler {
        if let localDaemonReconciler { return localDaemonReconciler }
        let reconciler = LocalDaemonReconciler(
            daemon: makeDaemonControl(), lifecycleOwner: localRuntimeLifecycleOwner)
        localDaemonReconciler = reconciler
        return reconciler
    }

    func localDaemonPolicy(
        for engine: EngineBuildIdentity?,
        generation: Int? = nil,
        switchBuild: LocalDaemonBuildSwitch? = nil
    ) async -> LocalDaemonReconciliationPolicy {
        let generation = generation ?? connectionGeneration
        let serving = engine.flatMap {
            AppRuntimeDaemonControl.runtimeIdentity(version: $0.version, buildSha: $0.sha)
        }
        let result = await daemonReconciliationOwner().reconcile(
            serving: serving, switchBuild: switchBuild,
            isCurrent: { @MainActor [weak self] in
                !Task.isCancelled && self?.connectionGeneration == generation
            })
        guard !Task.isCancelled, connectionGeneration == generation else { return .superseded }
        // Contention is no observation: it neither confirms nor retires the
        // published offer. Each caller decides what its own boundary keeps.
        if result == .deferredForLifecycle { return .unobserved }
        localDaemonBuildSwitch = nil
        switch result {
        case .replaced, .returned: localSuccessorPending = true
        default: break
        }
        // A fresh lifecycle observation must not authorize publishing the older
        // caller's handshake, even when both builds speak a compatible protocol.
        switch result {
        case let .coherent(observed):
            if observed != serving { return .retry }
        case let .deferred(_, observed, target):
            if observed != serving { return .retry }
            if observed.version == target.version, observed != target {
                localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: observed, target: target)
            }
        default:
            break
        }
        return LocalDaemonReconciliationPolicy(result)
    }

    /// Retire only the value this pending switch published. A replacement
    /// notice, including a failure carried into reconnect, belongs to its owner.
    func retireLocalDaemonBuildSwitchProgress() {
        guard let progress = localDaemonBuildSwitchProgress else { return }
        localDaemonBuildSwitchProgress = nil
        if localDaemonReconciliationNotice == progress.notice {
            localDaemonReconciliationNotice = nil
        }
    }

    /// Guidance published with an offer has no action once admission closes.
    /// Terminal failures/refusals have no offer and keep their own reason.
    func retireLocalDaemonBuildSwitchOffer() {
        if localDaemonBuildSwitch != nil { localDaemonReconciliationNotice = nil }
        localDaemonBuildSwitch = nil
    }

    /// Settings' Switch Engine Build action: one request, then the connection
    /// loop that request's generation belongs to.
    func requestLocalDaemonBuildSwitch(_ request: LocalDaemonBuildSwitch) async {
        switch await switchLocalDaemonBuild(request) {
        case let .resume(generation)?:
            await resumeLocalConnection(generation: generation)
        case let .reconnect(generation)?:
            await connect(ifCurrentGeneration: generation, allowInitialLaunch: false)
        case nil:
            break
        }
    }

    /// The bounded, one-shot switch behind that action. Reconnect and passive
    /// polls never pass a build-switch request. Its new generation retires the
    /// polling loop, so the receipt names the loop that continues; nil means a
    /// newer connection already owns everything.
    func switchLocalDaemonBuild(_ request: LocalDaemonBuildSwitch) async -> LocalDaemonBuildSwitchReceipt? {
        guard localDaemonBuildSwitch == request, !runtimeInstalling else { return nil }
        connectionGeneration += 1
        let generation = connectionGeneration
        localDaemonBuildSwitch = nil
        // Replaces guidance that points at the button this request just hid.
        let progress = "Switching engine build if work is idle…"
        localDaemonBuildSwitchProgress = (generation, progress)
        localDaemonReconciliationNotice = progress
        defer {
            if localDaemonBuildSwitchProgress?.generation == generation {
                retireLocalDaemonBuildSwitchProgress()
            }
        }
        let policy = await localDaemonPolicy(
            for: engineIdentity, generation: generation, switchBuild: request)
        guard connectionGeneration == generation, !Task.isCancelled else { return nil }
        switch policy {
        case let .useCompatible(notice):
            localDaemonReconciliationNotice = notice
            return .resume(generation: generation)
        case .unobserved:
            // Another lifecycle owner held the lease, so nothing was checked or
            // changed. Offer the same exact pair again; retrying is the user's call.
            localDaemonBuildSwitch = request
            localDaemonReconciliationNotice = "Another engine lifecycle action is in progress. Try Switch Engine Build again."
            return .resume(generation: generation)
        case let .failOffline(notice):
            enterHardOffline()
            publishLocalLifecycleFailure(notice)
        case .reconnect:
            localDaemonReconciliationNotice = nil
            client = nil
            engineIdentity = nil
            endpoint = ""
            health = .connecting
            cancelAllStreams()
        case .retry:
            localDaemonReconciliationNotice = "The engine selection changed. Reconnecting before offering another build switch."
        case .superseded:
            return nil
        }
        return .reconnect(generation: generation)
    }
}
