import Foundation

enum LocalConnectionProbeResult: Equatable {
    case connected
    case reconnect
    case unavailable
    case retryWithoutLaunch
    case lifecycleFailed
    case superseded
}

/// Owns the bounded local-daemon start allowance for one connection generation.
/// A confirmed connection rearms one later outage; a start attempt consumes the
/// allowance before the launcher schedules its spawn. The shared lifecycle lease
/// keeps outage recovery from overlapping installation or reconciliation.
@MainActor
struct LocalConnectionRecoveryLoop {
    private let generation: Int
    private let currentGeneration: @MainActor () -> Int
    private let lifecycleOwner: LocalRuntimeLifecycleOwner
    private let prepareProbe: @MainActor () -> Void
    private let probe: @MainActor () async -> LocalConnectionProbeResult
    /// One fresh discovery read and handshake that adopts nothing, asked while
    /// this loop holds its outage lease and before it consumes the allowance.
    private let engineAnswers: @MainActor () async -> Bool
    private let pollConnected: @MainActor () async -> LocalConnectionProbeResult
    private let startDaemon: @MainActor (LocalRuntimeLaunchPermit) -> Bool
    private let enterOffline: @MainActor () -> Void
    /// Publishes the refusal an outage start meets, again only if it changes
    /// within that outage, or nil once that lock is usable again. Contention is
    /// never reported here.
    private let lifecycleRefused: @MainActor (LocalRuntimeLifecycleRefusal?) -> Void
    private let pause: @MainActor () async -> Void

    init(
        generation: Int,
        currentGeneration: @escaping @MainActor () -> Int,
        lifecycleOwner: LocalRuntimeLifecycleOwner,
        prepareProbe: @escaping @MainActor () -> Void,
        probe: @escaping @MainActor () async -> LocalConnectionProbeResult,
        engineAnswers: @escaping @MainActor () async -> Bool,
        pollConnected: @escaping @MainActor () async -> LocalConnectionProbeResult,
        startDaemon: @escaping @MainActor (LocalRuntimeLaunchPermit) -> Bool,
        enterOffline: @escaping @MainActor () -> Void,
        lifecycleRefused: @escaping @MainActor (LocalRuntimeLifecycleRefusal?) -> Void = { _ in },
        pause: @escaping @MainActor () async -> Void
    ) {
        self.generation = generation
        self.currentGeneration = currentGeneration
        self.lifecycleOwner = lifecycleOwner
        self.prepareProbe = prepareProbe
        self.probe = probe
        self.engineAnswers = engineAnswers
        self.pollConnected = pollConnected
        self.startDaemon = startDaemon
        self.enterOffline = enterOffline
        self.lifecycleRefused = lifecycleRefused
        self.pause = pause
    }

    /// `resumingConnection` continues a client that an explicit build-switch
    /// request left serving, as an already confirmed connection, without a probe.
    func run(
        launchAvailable initialLaunchAvailable: Bool = true, resumingConnection: Bool = false
    ) async {
        var launchAvailable = initialLaunchAvailable
        var resuming = resumingConnection
        var startupLease: LocalRuntimeLifecycleLease?
        var startupDeadline: ContinuousClock.Instant?
        var reportedRefusal: LocalRuntimeLifecycleRefusal?
        // Exact release also invalidates the queued launch permit. A retired
        // connection therefore cannot leave a probe that spawns after unlock.
        defer { if let startupLease { lifecycleOwner.release(startupLease) } }
        while isCurrent {
            if !resuming { prepareProbe() }
            // A lifecycle can replace or install the successor while this
            // handshake is suspended. Its completion must make a negative
            // result stale rather than authorize a second fallback launch.
            let lifecycleSnapshot = lifecycleOwner.completionSnapshot()
            let result: LocalConnectionProbeResult
            if resuming {
                resuming = false
                result = .connected
            } else {
                result = await probe()
            }
            // Manual Reconnect advances the generation while discovery or a
            // handshake is suspended. Its predecessor may publish nothing.
            guard isCurrent else { return }
            if let lease = startupLease,
               result == .connected || startupDeadline.map({ ContinuousClock.now >= $0 }) == true {
                lifecycleOwner.release(lease)
                startupLease = nil
                startupDeadline = nil
            }

            switch result {
            case .connected:
                launchAvailable = true
                // This connection replaced any refusal notice, so the next
                // outage reports the refusal it meets, even an identical one.
                reportedRefusal = nil
                connected: while isCurrent {
                    await pause()
                    guard isCurrent else { return }
                    let pollResult = await pollConnected()
                    guard isCurrent else { return }
                    switch pollResult {
                    case .connected:
                        continue
                    case .unavailable:
                        break connected
                    case .retryWithoutLaunch:
                        break connected
                    case .reconnect:
                        // The reconciler already launched and identity-proved a
                        // successor. The next discovery pass must not launch it
                        // again merely because the old client disconnected.
                        launchAvailable = false
                        break connected
                    case .lifecycleFailed:
                        // A stop/start lifecycle was admitted but did not reach
                        // the exact target. Consume this outage's fallback and
                        // keep polling for external/manual recovery.
                        launchAvailable = false
                        enterOffline()
                        await pause()
                        break connected
                    case .superseded:
                        return
                    }
                }

            case .reconnect:
                // Reconciliation already started and identity-verified the
                // selected closure. Suppress a second fallback start until a
                // later confirmed connection creates a new outage allowance.
                launchAvailable = false

            case .unavailable:
                if launchAvailable {
                    let claim = lifecycleOwner.claim(
                        .outageRecovery,
                        ifNoCompletionSince: lifecycleSnapshot)
                    // An unusable lock is not another app's transaction. Name
                    // it, keep the allowance, and re-check after the ordinary
                    // pause in case the user repairs it.
                    let refusal: LocalRuntimeLifecycleRefusal? =
                        if case let .refused(refusal) = claim { refusal } else { nil }
                    if refusal != reportedRefusal {
                        lifecycleRefused(refusal)
                        reportedRefusal = refusal
                    }
                    guard let lease = claim.lease else {
                        // Busy, completed-since-snapshot and refused are the
                        // same launch decision: preserve the allowance and
                        // require a fresh probe before any launch.
                        enterOffline()
                        await pause()
                        continue
                    }
                    // The probe preceded this lease. Another app copy may have
                    // finished starting or replacing the engine and released the
                    // shared lock since, which this app's completion snapshot
                    // cannot see. Re-read discovery once under the lease.
                    let answering = await engineAnswers()
                    if answering || !isCurrent {
                        lifecycleOwner.release(lease)
                        guard isCurrent else { return }
                        // The ordinary next probe adopts that engine; the
                        // allowance stays for a real outage.
                        await pause()
                        continue
                    }
                    // Consume before start, including a synchronous false.
                    launchAvailable = false
                    let deadline = ContinuousClock.now.advanced(by: .seconds(LocalDaemonBootPolicy.handshakeTimeout))
                    let started = startDaemon(lifecycleOwner.launchPermit(for: lease, until: deadline))
                    if started {
                        // The launcher schedules its probe/spawn off-thread.
                        // Hold app transaction ownership through the boot window,
                        // until a handshake or the bounded deadline. Retirement
                        // cancels a still-pending spawn through its exact permit.
                        startupLease = lease
                        startupDeadline = deadline
                        // Preserve the existing Connecting boot window; a spawn
                        // that fails off-thread surfaces at the next probe. Missing
                        // assets fail synchronously and publish Offline at once.
                        await pause()
                        continue
                    }
                    lifecycleOwner.release(lease)
                }
                enterOffline()
                await pause()

            case .retryWithoutLaunch:
                // A coalesced predecessor retired before destructive lifecycle
                // admission. Retry discovery without inventing an outage start
                // and without consuming the still-valid allowance.
                await pause()

            case .lifecycleFailed:
                launchAvailable = false
                enterOffline()
                await pause()

            case .superseded:
                return
            }
        }
    }

    private var isCurrent: Bool {
        !Task.isCancelled && generation == currentGeneration()
    }
}
