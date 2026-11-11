import Foundation
import Testing
@testable import ClaudexorApp

private actor SuspendedRecoveryProbe {
    private var entered = false
    private var released = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        entered = true
        let waiters = enteredWaiters
        enteredWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        guard !released else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { enteredWaiters.append($0) }
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }
}

@MainActor
private final class LocalConnectionRecoveryHarness {
    let lifecycleOwner: LocalRuntimeLifecycleOwner
    var generation = 1
    var probeResults: [LocalConnectionProbeResult]
    var pollResults: [LocalConnectionProbeResult]
    var startResults: [Bool]
    var probeOverride: (@MainActor () async -> LocalConnectionProbeResult)?
    var pauseActions: [Int: @MainActor () -> Void] = [:]
    /// Re-observation answers under the outage lease; none answer by default.
    var engineAnswerResults: [Bool] = []

    private(set) var prepareCount = 0
    private(set) var probeCount = 0
    private(set) var engineAnswerCount = 0
    private(set) var pollCount = 0
    private(set) var startCount = 0
    private(set) var offlineCount = 0
    private(set) var pauseCount = 0

    init(
        lifecycleOwner: LocalRuntimeLifecycleOwner = LocalRuntimeLifecycleOwner(),
        probes: [LocalConnectionProbeResult],
        polls: [LocalConnectionProbeResult] = [],
        starts: [Bool] = []
    ) {
        self.lifecycleOwner = lifecycleOwner
        probeResults = probes
        pollResults = polls
        startResults = starts
    }

    func run(
        generation runGeneration: Int? = nil, launchAvailable: Bool = true,
        resumingConnection: Bool = false
    ) async {
        let loop = LocalConnectionRecoveryLoop(
            generation: runGeneration ?? generation,
            currentGeneration: { self.generation },
            lifecycleOwner: lifecycleOwner,
            prepareProbe: { self.prepareCount += 1 },
            probe: { await self.nextProbe() },
            engineAnswers: { self.nextEngineAnswer() },
            pollConnected: { await self.nextPoll() },
            startDaemon: { _ in self.nextStart() },
            enterOffline: { self.offlineCount += 1 },
            pause: { await self.pause() })
        await loop.run(launchAvailable: launchAvailable, resumingConnection: resumingConnection)
    }

    private func nextEngineAnswer() -> Bool {
        engineAnswerCount += 1
        return engineAnswerResults.isEmpty ? false : engineAnswerResults.removeFirst()
    }

    private func nextProbe() async -> LocalConnectionProbeResult {
        probeCount += 1
        if let probeOverride { return await probeOverride() }
        guard !probeResults.isEmpty else {
            generation += 1
            return .unavailable
        }
        return probeResults.removeFirst()
    }

    private func nextPoll() async -> LocalConnectionProbeResult {
        pollCount += 1
        return pollResults.isEmpty ? .unavailable : pollResults.removeFirst()
    }

    private func nextStart() -> Bool {
        startCount += 1
        return startResults.isEmpty ? true : startResults.removeFirst()
    }

    private func pause() async {
        pauseCount += 1
        pauseActions.removeValue(forKey: pauseCount)?()
        await Task.yield()
    }
}

@Suite(.serialized) struct LocalConnectionRecoveryTests {
    @MainActor
    @Test func initialUnavailableConsumesAtMostOneLaunch() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .unavailable, .unavailable])

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.pauseCount == 3)
    }

    @MainActor
    @Test func startupOwnershipLastsUntilHandshakeThenReleasesBeforeConnectedPolling() async throws {
        let owner = LocalRuntimeLifecycleOwner()
        var generation = 1
        var probes = 0
        var starts = 0
        let loop = LocalConnectionRecoveryLoop(
            generation: 1, currentGeneration: { generation }, lifecycleOwner: owner,
            prepareProbe: {},
            probe: {
                probes += 1
                if probes == 1 { return .unavailable }
                #expect(owner.claim(.installation) == .contended)
                return probes == 2 ? .unavailable : .connected
            },
            engineAnswers: { false },
            pollConnected: {
                let lease = owner.claim(.installation).lease
                #expect(lease != nil)
                if let lease { owner.release(lease) }
                generation += 1
                return .superseded
            },
            startDaemon: { _ in starts += 1; return true }, enterOffline: {},
            pause: { await Task.yield() })
        await loop.run()
        #expect(starts == 1)
        #expect(probes == 3)
        let lease = try #require(owner.claim(.installation).lease)
        owner.release(lease)
    }

    @MainActor
    @Test func retiringAConnectingGenerationCancelsItsPendingSpawnBeforeReleasingOwnership() async throws {
        let owner = LocalRuntimeLifecycleOwner()
        var generation = 1
        var pending: LocalRuntimeLaunchPermit?
        var actualSpawns = 0
        let loop = LocalConnectionRecoveryLoop(
            generation: 1, currentGeneration: { generation }, lifecycleOwner: owner,
            prepareProbe: {}, probe: { .unavailable }, engineAnswers: { false },
            pollConnected: { .unavailable },
            startDaemon: { pending = $0; return true }, enterOffline: {}, pause: { generation += 1 })
        await loop.run()
        let lease = try #require(owner.claim(.reconciliation).lease)
        let oldLaunch = try #require(pending)
        #expect(oldLaunch.perform { actualSpawns += 1; return true } == false)
        #expect(actualSpawns == 0)
        #expect(owner.claim(.installation) == .contended)
        owner.release(lease)
    }

    @Test func expiredLaunchCannotSpawnAndAFreshLeaseCanStillLaunch() throws {
        let owner = LocalRuntimeLifecycleOwner()
        let oldLease = try #require(owner.claim(.outageRecovery).lease)
        let expired = owner.launchPermit(for: oldLease, until: ContinuousClock.now.advanced(by: .seconds(-1)))
        var spawns = 0
        #expect(expired.perform { spawns += 1; return true } == false)
        owner.release(oldLease)
        let freshLease = try #require(owner.claim(.outageRecovery).lease)
        let fresh = owner.launchPermit(for: freshLease, until: ContinuousClock.now.advanced(by: .seconds(5)))
        #expect(fresh.perform { spawns += 1; return true })
        #expect(spawns == 1)
        owner.release(freshLease)
    }

    @MainActor
    @Test func falseStartConsumesTheAttemptBeforeCallingTheStarter() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .unavailable], starts: [false, true])

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.offlineCount == 2)
    }

    @MainActor
    @Test func confirmedConnectionThenPollLossGetsOneSuccessorAttempt() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .connected, .unavailable, .unavailable],
            polls: [.unavailable])

        await sut.run()

        #expect(sut.startCount == 2)
        #expect(sut.pollCount == 1)
    }

    @MainActor
    @Test func repeatedUnavailablePollsNeverAddAttemptsWithinOneOutage() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: Array(repeating: .unavailable, count: 5))

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.prepareCount == 6)
    }

    @MainActor
    @Test func everySecondConfirmedConnectionRearmsExactlyOneFurtherOutage() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [
                .unavailable,
                .connected, .unavailable,
                .connected, .unavailable, .unavailable,
            ],
            polls: [.unavailable, .unavailable])

        await sut.run()

        #expect(sut.startCount == 3)
        #expect(sut.pollCount == 2)
    }

    @MainActor
    @Test func reconciliationReconnectSuppressesFallbackUntilConfirmedConnection() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.reconnect, .unavailable, .connected, .unavailable],
            polls: [.unavailable])

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.probeCount >= 4)
    }

    @MainActor
    @Test func staleGenerationAfterAwaitedProbeCannotLaunchOrPublishOffline() async {
        let gate = SuspendedRecoveryProbe()
        let sut = LocalConnectionRecoveryHarness(probes: [])
        sut.probeOverride = {
            await gate.wait()
            return .unavailable
        }
        let oldGeneration = sut.generation

        let task = Task { await sut.run(generation: oldGeneration) }
        await gate.waitUntilEntered()
        sut.generation += 1
        await gate.release()
        await task.value

        #expect(sut.startCount == 0)
        #expect(sut.offlineCount == 0)
        #expect(sut.pauseCount == 0)
    }

    @MainActor
    @Test func busyLifecycleDefersWithoutConsumingThenLaunchesOnceReleased() async throws {
        let owner = LocalRuntimeLifecycleOwner()
        let busyLease = try #require(owner.claim(.installation).lease)
        let sut = LocalConnectionRecoveryHarness(
            lifecycleOwner: owner,
            probes: [.unavailable, .unavailable, .unavailable])
        sut.pauseActions[1] = { owner.release(busyLease) }

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.probeCount >= 3)
    }

    @Test func lifecycleCompletionSnapshotAndConditionalClaimAreAtomicAndTokenBound() throws {
        let owner = LocalRuntimeLifecycleOwner()
        let initial = owner.completionSnapshot()
        let installation = try #require(owner.claim(.installation).lease)

        // Being busy refuses without fabricating a completion.
        #expect(owner.claim(
            .outageRecovery, ifNoCompletionSince: initial) == .contended)
        #expect(owner.completionSnapshot() == initial)

        owner.release(installation)
        let completed = owner.completionSnapshot()
        #expect(completed != initial)
        // The stale observation cannot claim even though the owner is idle.
        #expect(owner.claim(
            .outageRecovery, ifNoCompletionSince: initial) == .contended)

        let recovery = try #require(owner.claim(
            .outageRecovery, ifNoCompletionSince: completed).lease)
        owner.release(installation)
        // A stale token neither clears the current owner nor advances receipt.
        #expect(owner.completionSnapshot() == completed)
        #expect(owner.claim(.reconciliation) == .contended)

        owner.release(recovery)
        #expect(owner.completionSnapshot() != completed)
        #expect(owner.claim(.reconciliation).lease != nil)
    }

    @MainActor
    @Test func exhaustedAllowanceKeepsPollingAndExternalRecoveryRearmsIt() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .unavailable, .connected, .unavailable],
            polls: [.unavailable], starts: [false, true])

        await sut.run()

        #expect(sut.startCount == 2)
        #expect(sut.pollCount == 1)
        #expect(sut.prepareCount == 5)
    }

    @MainActor
    @Test func manualReconnectRetiresOldGenerationAndFreshGenerationCanLaunch() async {
        let gate = SuspendedRecoveryProbe()
        let sut = LocalConnectionRecoveryHarness(probes: [])
        sut.probeOverride = {
            await gate.wait()
            return .unavailable
        }
        let oldGeneration = sut.generation

        let oldTask = Task { await sut.run(generation: oldGeneration) }
        await gate.waitUntilEntered()
        sut.generation += 1
        await gate.release()
        await oldTask.value
        #expect(sut.startCount == 0)

        sut.probeOverride = nil
        sut.probeResults = [.unavailable]
        await sut.run(generation: sut.generation)

        #expect(sut.startCount == 1)
    }

    @MainActor
    @Test func steadyReplacementConsumesTheOutageFallback() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.connected, .unavailable, .unavailable],
            polls: [.reconnect])

        await sut.run()

        #expect(sut.pollCount == 1)
        #expect(sut.startCount == 0)
        #expect(sut.probeCount >= 3)
    }

    @MainActor
    @Test func explicitSwitchReconnectCannotLaunchUntilAFreshConnectionRearmsIt() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .connected, .unavailable], polls: [.unavailable])
        sut.pauseActions[1] = { #expect(sut.startCount == 0) }
        await sut.run(launchAvailable: false)
        #expect(sut.startCount == 1)
        #expect(sut.pollCount == 1)
    }

    @MainActor
    @Test func steadyPostStartFailureConsumesTheOutageFallback() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.connected, .unavailable, .unavailable],
            polls: [.lifecycleFailed])

        await sut.run()

        #expect(sut.pollCount == 1)
        #expect(sut.startCount == 0)
        #expect(sut.offlineCount >= 1)
    }

    @MainActor
    @Test func supersededTypedPollTerminatesWithoutFallbackOrOfflinePublication() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.connected], polls: [.superseded])

        await sut.run()

        #expect(sut.pollCount == 1)
        #expect(sut.startCount == 0)
        #expect(sut.offlineCount == 0)
    }

    @MainActor
    @Test func preLifecycleRetryPreservesAllowanceForOneRealOutage() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.connected, .unavailable, .unavailable],
            polls: [.retryWithoutLaunch])

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.offlineCount == 1)
    }

    @MainActor
    @Test func resumedConnectionPollsItsClientWithoutProbingAndArmsOneOutageLaunch() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable], polls: [.connected, .unavailable])
        sut.pauseActions[1] = {
            // The kept client is polled first: no Connecting reset, no discovery.
            #expect(sut.prepareCount == 0)
            #expect(sut.probeCount == 0)
        }

        await sut.run(resumingConnection: true)

        #expect(sut.pollCount == 2)
        #expect(sut.engineAnswerCount == 1)
        #expect(sut.startCount == 1)
    }

    @MainActor
    @Test func engineAnsweringUnderTheLeaseKeepsTheAllowanceForARealOutage() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.unavailable, .unavailable, .unavailable])
        sut.engineAnswerResults = [true, false]

        await sut.run()

        // The first claim found an engine and released; the second one started.
        #expect(sut.engineAnswerCount == 2)
        #expect(sut.startCount == 1)
        #expect(sut.offlineCount == 1)
    }

    @MainActor
    @Test func generationRetiredDuringReobservationReleasesTheLeaseWithoutLaunching() async throws {
        let owner = LocalRuntimeLifecycleOwner()
        var generation = 1
        var starts = 0
        let loop = LocalConnectionRecoveryLoop(
            generation: 1, currentGeneration: { generation }, lifecycleOwner: owner,
            prepareProbe: {}, probe: { .unavailable },
            engineAnswers: {
                #expect(owner.claim(.installation) == .contended)
                generation += 1 // a manual Reconnect while discovery is re-read
                return false
            },
            pollConnected: { .unavailable },
            startDaemon: { _ in starts += 1; return true }, enterOffline: {},
            pause: { await Task.yield() })
        await loop.run()
        #expect(starts == 0)
        let lease = try #require(owner.claim(.installation).lease)
        owner.release(lease)
    }

    @MainActor
    @Test func confirmedRecoveryAfterLifecycleFailureRearmsOneLaterOutage() async {
        let sut = LocalConnectionRecoveryHarness(
            probes: [.connected, .connected, .unavailable, .unavailable],
            polls: [.lifecycleFailed, .unavailable])

        await sut.run()

        #expect(sut.startCount == 1)
        #expect(sut.pollCount == 2)
    }
}
