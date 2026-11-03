import Foundation
import ClaudexorKit

@usableFromInline
enum LocalDaemonBootPolicy {
    /// A large recovered journal can keep the daemon below handshake readiness
    /// for more than 30 seconds even though startup is making healthy progress.
    @usableFromInline static let handshakeTimeout: TimeInterval = 90
    /// Cadence of the bounded post-launch handshake poll.
    @usableFromInline static let handshakePollInterval: TimeInterval = 0.5
    /// How long a launched child gets to be seen gone after its exact stop.
    static let launchExitGrace: TimeInterval = 5
}

enum LocalDaemonReconciliationDeferral: Sendable, Equatable {
    case busy
    case activityUnknown
    case explicitBuildSwitchRequired
    case targetNotNewer
    /// The selected runtime did not come up after a stop earlier in this app
    /// session, and the exact previous build restarted from saved files serves.
    case previousRestarted
    /// The selected runtime did not come up after a stop earlier in this app
    /// session, and another compatible engine serves now.
    case targetDidNotStart
}

/// One user action bound to the two builds shown by Settings. Never persisted
/// or replayed by connection polling, and invalidated by a changed observation.
struct LocalDaemonBuildSwitch: Sendable, Equatable {
    let serving: RuntimeClosureIdentity
    let target: RuntimeClosureIdentity
}

/// The build a replacement stopped when its selected runtime did not come up
/// and that build does not serve again. A restart that serves is `.returned`.
enum LocalDaemonPreviousEngine: Sendable, Equatable {
    /// No saved copy was verified before the stop: none exists where a saved
    /// build is kept, or no copy's `--probe` named this exact build.
    case notSaved(RuntimeClosureIdentity)
    /// An engine may still be running or starting: the exact stop refused, or
    /// the launched child did not exit. Nothing started beside it.
    case notRestarted(RuntimeClosureIdentity)
    /// The saved copy was not scheduled because launch files are missing.
    case couldNotLaunch(RuntimeClosureIdentity)
    /// The saved copy started but did not answer with this exact identity and
    /// normal admission within the boot window.
    case didNotReturn(RuntimeClosureIdentity)
    /// Within the boot window the saved copy answered with this exact identity
    /// only in recovery mode, and no other engine answered, as an older engine
    /// does on data a newer one already migrated. It may still hold the root,
    /// which no restart here can take back; the operator stop for its root can.
    case answeredOnlyInRecovery(RuntimeClosureIdentity, stopCommand: String?)
}

enum LocalDaemonReconciliationFailure: Sendable, Equatable {
    /// The shared lifecycle lock is unusable; nothing was observed or changed.
    case lifecycleUnavailable(LocalRuntimeLifecycleRefusal)
    case targetScriptUnavailable
    case targetAuthorityUnavailable
    case targetProbeFailed
    case targetAuthorityMismatch(
        expected: RuntimeClosureIdentity,
        got: RuntimeClosureIdentity)
    case servingIdentityUnavailable
    case stopFailed(expected: RuntimeClosureIdentity)
    case startFailed(expected: RuntimeClosureIdentity, previous: LocalDaemonPreviousEngine)
    case postStartMismatch(expected: RuntimeClosureIdentity, got: RuntimeClosureIdentity)
    case postStartUnreachable(expected: RuntimeClosureIdentity, previous: LocalDaemonPreviousEngine)
}

enum LocalDaemonReconciliationResult: Sendable, Equatable {
    case coherent(RuntimeClosureIdentity)
    case replaced(RuntimeClosureIdentity)
    /// The selected runtime did not come up, so the exact build that served
    /// before was restarted from saved files and answered with normal
    /// admission. The runtime pointer and the launcher's selection are unchanged.
    case returned(previous: RuntimeClosureIdentity, failedTarget: RuntimeClosureIdentity)
    case deferred(
        LocalDaemonReconciliationDeferral,
        serving: RuntimeClosureIdentity,
        target: RuntimeClosureIdentity)
    case deferredForLifecycle
    case failed(LocalDaemonReconciliationFailure)
    /// The requesting connection generation retired before destructive
    /// lifecycle admission. No stop or start was attempted.
    case supersededBeforeLifecycle
}

/// The AppModel-facing policy for a reconciliation result. Keeping this
/// reduction beside the lifecycle owner prevents connect and steady-state poll
/// from drifting into subtly different safety decisions.
enum LocalDaemonReconciliationPolicy: Sendable, Equatable {
    /// The protocol-compatible daemon remains usable. A non-nil notice explains
    /// why exact closure coherence could not be established yet.
    case useCompatible(notice: String?)
    /// Another lifecycle owner held the lease, so nothing was observed or
    /// changed. The daemon remains usable; facts published from an earlier
    /// observation are neither confirmed nor retired by this result.
    case unobserved
    /// The reconciler started a different process: the selected runtime, or
    /// the restarted previous build. Discovery/token/client state must be
    /// reacquired before any daemon-owned projection is hydrated.
    case reconnect
    /// A lifecycle transition began but did not finish with the exact target.
    /// The previous client is no longer safe to use.
    case failOffline(notice: String)
    /// A coalesced older generation retired before lifecycle admission. The
    /// current caller should re-probe without launching a fallback.
    case retry
    /// A newer connection generation owns every subsequent publication.
    case superseded

    init(_ result: LocalDaemonReconciliationResult) {
        switch result {
        case .coherent:
            self = .useCompatible(notice: nil)
        case .replaced, .returned:
            self = .reconnect
        case .deferred(.busy, _, _):
            self = .useCompatible(
                notice: "Engine refresh is deferred while work is active.")
        case .deferred(.activityUnknown, _, _):
            self = .useCompatible(
                notice: "Engine refresh is deferred until active work can be checked.")
        case .deferred(.explicitBuildSwitchRequired, _, _):
            self = .useCompatible(
                notice: "A different build of this engine version is running. Use Settings → General → Switch Engine Build when work is idle.")
        case .deferred(.targetNotNewer, _, _):
            self = .useCompatible(
                notice: "The running engine is newer, or version order cannot be verified. Continuing with the compatible running engine.")
        case let .deferred(.previousRestarted, serving, target):
            self = .useCompatible(notice: Self.sessionNotice(target: target, serving: serving, restarted: true))
        case let .deferred(.targetDidNotStart, serving, target):
            self = .useCompatible(notice: Self.sessionNotice(target: target, serving: serving, restarted: false))
        case .deferredForLifecycle:
            self = .unobserved
        case let .failed(.lifecycleUnavailable(refusal)):
            self = .useCompatible(
                notice: "Engine refresh is unavailable: \(refusal.reason). Continuing with the compatible running engine.")
        case .failed(.targetScriptUnavailable), .failed(.targetAuthorityUnavailable),
             .failed(.targetProbeFailed), .failed(.targetAuthorityMismatch(_, _)):
            self = .useCompatible(
                notice: "Could not verify the selected engine runtime; continuing with the compatible running engine.")
        case .failed(.servingIdentityUnavailable):
            self = .useCompatible(
                notice: "Could not verify the running engine build; continuing with its compatible protocol.")
        case .failed(.stopFailed):
            self = .failOffline(
                notice: "Engine refresh could not confirm that the previous engine stopped, so it did not start the selected runtime.")
        case let .failed(.startFailed(target, previous)):
            self = .failOffline(notice: Self.previousEngineNotice(
                target: target, outcome: "could not be launched because its script or the app's Node is missing",
                previous: previous))
        case let .failed(.postStartUnreachable(target, previous)):
            self = .failOffline(notice: Self.previousEngineNotice(
                target: target, outcome: "did not answer in time", previous: previous))
        case let .failed(.postStartMismatch(expected, got)):
            let (selected, answered) = Self.labels(expected, got)
            self = .failOffline(
                notice: "After the refresh, engine \(answered) answered instead of the selected \(selected).")
        case .supersededBeforeLifecycle:
            self = .retry
        }
    }

    /// Version labels for one sentence; a short build SHA joins each version
    /// only when both builds share it.
    private static func labels(
        _ first: RuntimeClosureIdentity, _ second: RuntimeClosureIdentity
    ) -> (String, String) {
        guard first.version == second.version else { return ("v\(first.version)", "v\(second.version)") }
        return ("v\(first.version) (\(AboutInfo.shortSha(first.buildSha)))",
                "v\(second.version) (\(AboutInfo.shortSha(second.buildSha)))")
    }

    private static func sessionNotice(
        target: RuntimeClosureIdentity, serving: RuntimeClosureIdentity, restarted: Bool
    ) -> String {
        let (selected, running) = labels(target, serving)
        let kept = restarted
            ? "Engine \(selected) did not start, so Claudexor restarted the previous engine \(running)."
            : "Engine \(selected) did not start earlier, so Claudexor keeps the running engine \(running)."
        // Builds of one version switch only on request, so a reopened app keeps
        // this one; a newer selected version is tried again automatically.
        let until = target.version == serving.version
            ? "It stays in use until it exits; then \(selected) is tried again. To try it now, use Settings → General → Switch Engine Build when work is idle."
            : "It stays in use until it exits or the app is reopened; then \(selected) is tried again."
        return "\(kept) \(until)"
    }

    /// What a lifecycle failure reports when the engine this app started (the
    /// selected runtime, or the restarted previous build) answered and then
    /// stopped answering before any connection used it.
    static let lostSuccessorNotice =
        "The engine this refresh started stopped answering before Claudexor could use it."

    private static func previousEngineNotice(
        target: RuntimeClosureIdentity, outcome: String, previous: LocalDaemonPreviousEngine
    ) -> String {
        switch previous {
        case let .notSaved(identity):
            let (selected, earlier) = labels(target, identity)
            return "Engine \(selected) \(outcome), and no saved copy of the previous engine \(earlier) could be verified, so it was not restarted."
        case let .notRestarted(identity):
            let (selected, earlier) = labels(target, identity)
            return "Engine \(selected) \(outcome), and Claudexor could not confirm that no engine is still running or starting, so it did not restart the previous engine \(earlier) beside it."
        case let .couldNotLaunch(identity):
            let (selected, earlier) = labels(target, identity)
            return "Engine \(selected) \(outcome), and the saved copy of the previous engine \(earlier) could not be launched because its script or the app's Node is missing."
        case let .didNotReturn(identity):
            let (selected, earlier) = labels(target, identity)
            return "Engine \(selected) \(outcome), and the previous engine \(earlier) did not restart with normal service. It may not read data that a newer engine already upgraded."
        case let .answeredOnlyInRecovery(identity, stopCommand):
            let (selected, earlier) = labels(target, identity)
            let found = "Engine \(selected) \(outcome), and the restarted previous engine \(earlier) answered only in recovery mode, so it may not read data that a newer engine already upgraded."
            guard let stopCommand else {
                return "\(found) Stop that engine for this app's engine root, then choose Retry."
            }
            // The command starts its own line, so it reads and selects whole.
            return "\(found) To start \(selected) again, run this in Terminal, then choose Retry; stopping keeps all stored data:\n\(stopCommand)"
        }
    }
}

/// A selected runtime that did not come up after this app session stopped an
/// engine for it, and the exact previous build restarted instead, if any.
private struct LocalDaemonFailedTarget: Sendable, Equatable {
    let target: RuntimeClosureIdentity
    let restarted: RuntimeClosureIdentity?
}

/// Reconciles the compatible local daemon already serving the app with the
/// exact closure selected by `DaemonLauncher`. Protocol compatibility remains
/// the Gateway's concern; this owner only prevents an app upgrade from silently
/// continuing on stale, app-owned engine bytes.
///
/// The actor coalesces overlapping reconnect polls into one lifecycle change.
/// It never stops a daemon unless exact target probing succeeded and active work
/// was authoritatively reported idle. When the selected runtime does not come
/// up, it restarts the exact previous build only from a saved copy probed
/// before the stop, and remembers that target for the app session so passive
/// polls never stop a compatible engine for it again.
actor LocalDaemonReconciler {
    private let daemon: any RuntimeDaemonControl
    private let lifecycleOwner: LocalRuntimeLifecycleOwner
    private let targetClosure: @Sendable () -> LocalRuntimeClosureSelection?
    private let handshakePollInterval: TimeInterval
    private let handshakePollTimeout: TimeInterval
    private var inFlight: Task<LocalDaemonReconciliationResult, Never>?
    private var failedTarget: LocalDaemonFailedTarget?

    init(
        daemon: any RuntimeDaemonControl,
        lifecycleOwner: LocalRuntimeLifecycleOwner,
        targetClosure: @escaping @Sendable () -> LocalRuntimeClosureSelection? = {
            DaemonLauncher.resolvedRuntime()
        },
        handshakePollInterval: TimeInterval = LocalDaemonBootPolicy.handshakePollInterval,
        handshakePollTimeout: TimeInterval = LocalDaemonBootPolicy.handshakeTimeout
    ) {
        self.daemon = daemon
        self.lifecycleOwner = lifecycleOwner
        self.targetClosure = targetClosure
        self.handshakePollInterval = handshakePollInterval
        self.handshakePollTimeout = handshakePollTimeout
    }

    /// A connection observation is only a hint. Lifecycle decisions always use
    /// a fresh serving identity read while the lifecycle lease is held.
    func reconcile(
        serving _: RuntimeClosureIdentity? = nil,
        switchBuild: LocalDaemonBuildSwitch? = nil,
        isCurrent: @escaping @Sendable () async -> Bool = { true }
    ) async -> LocalDaemonReconciliationResult {
        if let inFlight {
            let result = await inFlight.value
            guard switchBuild != nil else { return result }
            // A passive task cannot consume an explicit action. Its ownership
            // is released before its result resolves; re-admit with fresh facts.
            return await reconcile(switchBuild: switchBuild, isCurrent: isCurrent)
        }
        guard await isCurrent() else { return .supersededBeforeLifecycle }
        // Exact session admission precedes target resolution and the first await.
        // It excludes RuntimeInstallCoordinator's independent actor from the same
        // stop/start lifecycle rather than relying on a sampled UI boolean.
        let lifecycleLease: LocalRuntimeLifecycleLease
        switch lifecycleOwner.claim(.reconciliation) {
        case let .acquired(lease): lifecycleLease = lease
        case .contended: return .deferredForLifecycle
        case let .refused(refusal): return .failed(.lifecycleUnavailable(refusal))
        }

        let daemon = self.daemon
        let targetClosure = self.targetClosure
        let pollInterval = handshakePollInterval
        let pollTimeout = handshakePollTimeout
        let remembered = failedTarget
        let owner = lifecycleOwner
        let launchPermit: @Sendable (ContinuousClock.Instant) -> LocalRuntimeLaunchPermit = {
            owner.launchPermit(for: lifecycleLease, until: $0)
        }
        let task = Task {
            let result = await Self.perform(
                daemon: daemon, targetClosure: targetClosure, switchBuild: switchBuild,
                failedTarget: remembered, launchPermit: launchPermit,
                handshakePollInterval: pollInterval, handshakePollTimeout: pollTimeout,
                isCurrent: isCurrent)
            // Cleanup belongs to the task, so an old waiter cannot clear a
            // successor task or release its lease after this result resolves.
            failedTarget = Self.memory(after: result, was: remembered)
            inFlight = nil
            lifecycleOwner.release(lifecycleLease)
            return result
        }
        inFlight = task
        return await task.value
    }

    /// A target whose replacement failed after stop admission is remembered
    /// until it is observed serving; any other result keeps the memory.
    private static func memory(
        after result: LocalDaemonReconciliationResult, was remembered: LocalDaemonFailedTarget?
    ) -> LocalDaemonFailedTarget? {
        switch result {
        case let .returned(previous, target):
            return LocalDaemonFailedTarget(target: target, restarted: previous)
        case let .failed(.stopFailed(target)), let .failed(.startFailed(target, _)),
             let .failed(.postStartUnreachable(target, _)), let .failed(.postStartMismatch(target, _)):
            return LocalDaemonFailedTarget(target: target, restarted: nil)
        case let .coherent(identity), let .replaced(identity):
            return identity == remembered?.target ? nil : remembered
        default:
            return remembered
        }
    }

    private static func perform(
        daemon: any RuntimeDaemonControl,
        targetClosure: @Sendable () -> LocalRuntimeClosureSelection?,
        switchBuild: LocalDaemonBuildSwitch?,
        failedTarget: LocalDaemonFailedTarget?,
        launchPermit: @escaping @Sendable (ContinuousClock.Instant) -> LocalRuntimeLaunchPermit,
        handshakePollInterval: TimeInterval,
        handshakePollTimeout: TimeInterval,
        isCurrent: @escaping @Sendable () async -> Bool
    ) async -> LocalDaemonReconciliationResult {
        guard let selected = targetClosure() else { return .failed(.targetScriptUnavailable) }
        let expected: RuntimeClosureIdentity?
        switch selected.authority {
        case .installed(let pointerIdentity):
            guard let pointerIdentity else {
                return .failed(.targetAuthorityUnavailable)
            }
            expected = pointerIdentity
        case .bundledStampedProbe:
            expected = nil
        }
        guard let probed = await daemon.probeIdentity(scriptURL: selected.scriptURL) else {
            return .failed(.targetProbeFailed)
        }
        let target: RuntimeClosureIdentity
        if let expected {
            guard probed == expected else {
                return .failed(.targetAuthorityMismatch(expected: expected, got: probed))
            }
            target = expected
        } else {
            // The bundled script is inside the signed app closure; its stamped
            // exact probe is the authority for this launch target.
            target = probed
        }
        guard let serving = await daemon.handshakeIdentity() else {
            return .failed(.servingIdentityUnavailable)
        }
        if serving == target { return .coherent(target) }
        if let switchBuild,
           switchBuild != LocalDaemonBuildSwitch(serving: serving, target: target) {
            return .supersededBeforeLifecycle
        }
        if serving.version != target.version {
            // SemanticVersion also accepts incomplete versions and strips
            // suffixes. Only the engine's stable x.y.z contract proves order.
            guard stableVersion(serving.version), stableVersion(target.version),
                  let current = SemanticVersion(serving.version),
                  let next = SemanticVersion(target.version), next > current else {
                return .deferred(.targetNotNewer, serving: serving, target: target)
            }
        }
        if switchBuild == nil {
            // Without a request, a runtime that did not come up after a stop
            // this session is not tried again, and builds of one version stay.
            if let failedTarget, failedTarget.target == target {
                let kept: LocalDaemonReconciliationDeferral =
                    failedTarget.restarted == serving ? .previousRestarted : .targetDidNotStart
                return .deferred(kept, serving: serving, target: target)
            }
            if serving.version == target.version {
                return .deferred(.explicitBuildSwitchRequired, serving: serving, target: target)
            }
        }

        switch await daemon.isBusy() {
        case true:
            return .deferred(.busy, serving: serving, target: target)
        case nil:
            return .deferred(.activityUnknown, serving: serving, target: target)
        case false:
            break
        }
        // Before any stop: the only build a failed replacement may restart is a
        // saved copy whose side-effect-free probe names the serving engine.
        let savedCopy = await savedCopy(of: serving, besides: selected.scriptURL, daemon: daemon)

        // Everything above this point is side-effect-free observation. This is
        // the generation-bound admission point for the destructive lifecycle:
        // a request superseded before it stops the daemon performs no mutation.
        // Once stop is invoked the exact stop/start/proof transaction must run
        // to a safe terminal state even if a newer connect begins meanwhile.
        guard await isCurrent() else { return .supersededBeforeLifecycle }
        guard let freshServing = await daemon.handshakeIdentity() else {
            return .failed(.servingIdentityUnavailable)
        }
        guard freshServing == serving, await isCurrent() else {
            return .supersededBeforeLifecycle
        }

        do {
            try await daemon.stopForRuntimeReplacement(expectedIdentity: serving)
        } catch RuntimeReplacementStopError.busy {
            return .deferred(.busy, serving: serving, target: target)
        } catch RuntimeReplacementStopError.activityUnknown {
            return .deferred(.activityUnknown, serving: serving, target: target)
        } catch {
            return .failed(.stopFailed(expected: target))
        }
        // The launcher only schedules this spawn. Its permit ends with the poll
        // below, so a spawn still queued then can never run beside what follows.
        let targetDeadline = deadline(after: handshakePollTimeout)
        let targetLaunch: RuntimeDaemonLaunch
        do {
            targetLaunch = try daemon.start(
                scriptURL: selected.scriptURL, launchPermit: launchPermit(targetDeadline))
        } catch {
            return await restartPrevious(
                serving, from: savedCopy, after: target, targetLaunch: nil, daemon: daemon,
                launchPermit: launchPermit,
                interval: handshakePollInterval, timeout: handshakePollTimeout
            ) { .startFailed(expected: target, previous: $0) }
        }
        guard let running = await poll(every: handshakePollInterval, until: targetDeadline, {
            await daemon.handshakeIdentity()
        }) else {
            return await restartPrevious(
                serving, from: savedCopy, after: target, targetLaunch: targetLaunch, daemon: daemon,
                launchPermit: launchPermit,
                interval: handshakePollInterval, timeout: handshakePollTimeout
            ) { .postStartUnreachable(expected: target, previous: $0) }
        }
        // Any answer ends the replacement: an exact target is kept even in
        // recovery mode, and another engine is never stopped as a rollback.
        return running == target
            ? .replaced(target)
            : .failed(.postStartMismatch(expected: target, got: running))
    }

    /// The first saved copy, other than the selected script, whose
    /// side-effect-free probe names the serving engine exactly.
    private static func savedCopy(
        of serving: RuntimeClosureIdentity, besides selected: URL,
        daemon: any RuntimeDaemonControl
    ) async -> URL? {
        for script in daemon.savedScripts(for: serving)
        where script.standardizedFileURL != selected.standardizedFileURL {
            if await daemon.probeIdentity(scriptURL: script) == serving { return script }
        }
        return nil
    }

    /// The bounded return after the selected runtime did not come up. The saved
    /// copy starts only when nothing can run beside it: the target's permit has
    /// expired, its exact stop passed (proven absence, or a live owner's proven
    /// exit; a live or unknown owner refuses), and the child this app launched
    /// has exited, because that stop also passes before a booting child takes
    /// the writer lease. The copy counts only with its exact identity and normal
    /// admission; the runtime pointer is never written.
    private static func restartPrevious(
        _ previous: RuntimeClosureIdentity, from savedCopy: URL?,
        after target: RuntimeClosureIdentity, targetLaunch: RuntimeDaemonLaunch?,
        daemon: any RuntimeDaemonControl,
        launchPermit: @Sendable (ContinuousClock.Instant) -> LocalRuntimeLaunchPermit,
        interval: TimeInterval, timeout: TimeInterval,
        failure: (LocalDaemonPreviousEngine) -> LocalDaemonReconciliationFailure
    ) async -> LocalDaemonReconciliationResult {
        guard let savedCopy else { return .failed(failure(.notSaved(previous))) }
        do {
            try await daemon.stopForRuntimeReplacement(expectedIdentity: target)
        } catch {
            return .failed(failure(.notRestarted(previous)))
        }
        let exitDeadline = deadline(after: min(LocalDaemonBootPolicy.launchExitGrace, timeout))
        let exited: Bool? = await poll(every: interval, until: exitDeadline) {
            targetLaunch?.isRunning() == true ? nil : true
        }
        guard exited == true else { return .failed(failure(.notRestarted(previous))) }
        let returnDeadline = deadline(after: timeout)
        do {
            _ = try daemon.start(scriptURL: savedCopy, launchPermit: launchPermit(returnDeadline))
        } catch {
            return .failed(failure(.couldNotLaunch(previous)))
        }
        // A recovery-only answer keeps waiting; any other engine ends the wait.
        var answeredInRecovery = false
        let answer = await poll(every: interval, until: returnDeadline) { () async -> RuntimeServingHandshake? in
            guard let serving = await daemon.servingHandshake() else { return nil }
            guard serving.identity == previous, serving.recoveryOnly else { return serving }
            answeredInRecovery = true
            return nil
        }
        if let answer, answer.identity == previous, !answer.recoveryOnly {
            return .returned(previous: previous, failedTarget: target)
        }
        // Another engine answering is not this copy. A copy that answered only
        // in recovery may still hold the root even if it went quiet later.
        guard answer == nil, answeredInRecovery else { return .failed(failure(.didNotReturn(previous))) }
        return .failed(failure(.answeredOnlyInRecovery(previous, stopCommand: daemon.operatorStopCommand())))
    }

    private static func deadline(after seconds: TimeInterval) -> ContinuousClock.Instant {
        ContinuousClock.now.advanced(by: .seconds(max(0, seconds)))
    }

    /// Ask until an answer arrives or the deadline passes; nil means none did.
    private static func poll<Answer: Sendable>(
        every interval: TimeInterval, until deadline: ContinuousClock.Instant,
        _ ask: () async -> Answer?
    ) async -> Answer? {
        while true {
            if let answer = await ask() { return answer }
            if ContinuousClock.now >= deadline { return nil }
            let nanoseconds = UInt64(max(0, interval) * 1_000_000_000)
            if nanoseconds == 0 {
                await Task.yield()
            } else {
                try? await Task.sleep(nanoseconds: nanoseconds)
            }
        }
    }

    private static func stableVersion(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 3 && parts.allSatisfy { part in
            !part.isEmpty && part.utf8.allSatisfy { (48...57).contains($0) }
        }
    }
}
