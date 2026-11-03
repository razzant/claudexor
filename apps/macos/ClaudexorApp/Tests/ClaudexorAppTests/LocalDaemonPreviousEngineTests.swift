import AppKit
import Foundation
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// Answers `/healthz` and `/v2/handshake` from the engine that a
/// `ReconciliationDaemonStub` models for the request's port, so the app's
/// connection loop and the reconciler observe one engine. Other paths 503.
private final class EngineWorldURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var worlds: [Int: ReconciliationDaemonStub] = [:]

    static func serve(_ daemon: ReconciliationDaemonStub, port: Int) {
        lock.withLock { worlds[port] = daemon }
    }

    static func retire(port: Int) { lock.withLock { worlds[port] = nil } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let world = request.url?.port.flatMap { port in Self.lock.withLock { Self.worlds[port] } }
        switch request.url?.path {
        case "/healthz", "/v2/handshake":
            guard let engine = world?.clientView() else {
                client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
                return
            }
            guard request.url?.path == "/v2/handshake" else { return respond(200, #"{"ok":true}"#) }
            let mode = engine.recoveryOnly ? #","servingMode":"recovery_only""# : ""
            respond(200, #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"\#(engine.identity.version)","sha":"\#(engine.identity.buildSha)","entry":"/fixtures/engine.cjs"}\#(mode)}"#)
        default:
            respond(503, "{}")
        }
    }

    override func stopLoading() {}

    private func respond(_ status: Int, _ body: String) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

/// The production connection loop as `AppModel.connect()` composes it. Only
/// discovery (a fresh client per probe against this port's modeled engine)
/// and the outage launcher are fixtures; nothing is spawned or contacted.
@MainActor
private final class EngineWorldHarness {
    struct Seen: Equatable {
        let health: Health
        let notice: String?
    }

    let model: AppModel
    let daemon: ReconciliationDaemonStub
    let port: Int
    /// Runs at that pause (1-based), before the loop continues.
    var atPause: [Int: @MainActor () -> Void] = [:]
    /// This generation retires at that pause.
    var lastPause = 8
    /// What the ordinary launcher's start does to the modeled engine.
    var onOutageLaunch: (@MainActor () -> Void)?
    private(set) var outageLaunches = 0
    private(set) var pauses = 0
    /// What the user could see at each pause.
    private(set) var seen: [Seen] = []
    /// Whether the shared Retry offer was made at each pause.
    private(set) var offers: [Bool] = []

    init(_ daemon: ReconciliationDaemonStub, selected script: URL, port: Int) {
        self.daemon = daemon
        self.port = port
        model = AppModel(requestNotificationAuthorization: false)
        model.connectionGeneration = 1
        model.localDaemonReconciler = LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: model.localRuntimeLifecycleOwner,
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: script, authority: .bundledStampedProbe) },
            handshakePollInterval: 0.001, handshakePollTimeout: 0.05)
        EngineWorldURLProtocol.serve(daemon, port: port)
    }

    func gateway() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EngineWorldURLProtocol.self]
        return GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: "fixture",
            session: URLSession(configuration: configuration))
    }

    /// One connection generation. `launchAvailable: false` is the start an
    /// explicit build switch hands to `connect(allowInitialLaunch: false)`.
    func run(launchAvailable: Bool = true) async {
        let generation = model.connectionGeneration
        let loop = LocalConnectionRecoveryLoop(
            generation: generation,
            currentGeneration: { self.model.connectionGeneration },
            lifecycleOwner: model.localRuntimeLifecycleOwner,
            prepareProbe: {
                self.model.health = .connecting
                self.model.cancelAllStreams()
            },
            probe: {
                await self.model.tryConnect(
                    candidate: self.gateway(), endpoint: "127.0.0.1:\(self.port)",
                    generation: generation)
            },
            engineAnswers: { (try? await self.gateway().handshake())?.ok == true },
            pollConnected: {
                guard self.model.client != nil else { return .unavailable }
                return await self.model.pollLocalConnection(generation: generation)
            },
            startDaemon: { _ in
                self.outageLaunches += 1
                self.onOutageLaunch?()
                return true
            },
            enterOffline: { self.model.enterLocalOffline() },
            pause: {
                self.pauses += 1
                self.seen.append(Seen(
                    health: self.model.health, notice: self.model.localDaemonReconciliationNotice))
                self.offers.append(LocalEngineRetry.isOffered(for: self.model))
                self.atPause.removeValue(forKey: self.pauses)?()
                if self.pauses >= self.lastPause { self.model.connectionGeneration += 1 }
                await Task.yield()
            })
        await loop.run(launchAvailable: launchAvailable)
    }

    /// Continue as a later generation would, for the given number of pauses.
    func runAgain(pauses more: Int, launchAvailable: Bool = true) async {
        lastPause = pauses + more
        await run(launchAvailable: launchAvailable)
    }

    func finish() {
        model.cancelAllStreams()
        EngineWorldURLProtocol.retire(port: port)
    }
}

/// claudexor#155: an idle engine is still replaced automatically, but when the
/// selected runtime does not come up the exact previous build is restarted
/// only from files that really survived, and every other case says so.
@Suite(.serialized) struct LocalDaemonPreviousEngineTests {
    private let old = RuntimeClosureIdentity(version: "3.1.2", buildSha: String(repeating: "a", count: 40))
    private let target = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
    private let other = RuntimeClosureIdentity(version: "3.1.5", buildSha: String(repeating: "c", count: 40))
    private let selected = URL(fileURLWithPath: "/fixtures/App-B/Contents/Resources/claudexord.bundle.cjs")
    private let saved = URL(fileURLWithPath: "/fixtures/runtime/versions/3.1.2/claudexord.bundle.cjs")

    private let restarted = "Engine v3.2.0 did not start, so Claudexor restarted the previous engine v3.1.2. It stays in use until it exits or the app is reopened; then v3.2.0 is tried again."
    private let kept = "Engine v3.2.0 did not start earlier, so Claudexor keeps the running engine v3.1.5. It stays in use until it exits or the app is reopened; then v3.2.0 is tried again."
    private let notSaved = "Engine v3.2.0 did not answer in time, and no saved copy of the previous engine v3.1.2 could be verified, so it was not restarted."
    /// What the fake port reports as this app's exact operator stop.
    private let stopCommand = "CLAUDEXOR_CONFIG_DIR='/fixtures/root/v3' '/fixtures/App-B/Contents/Resources/node' '/fixtures/App-B/Contents/Resources/claudexor.bundle.cjs' daemon stop"
    private var answeredOnlyInRecovery: String {
        "Engine v3.2.0 did not answer in time, and the restarted previous engine v3.1.2 answered only in recovery mode, so it may not read data that a newer engine already upgraded. To start v3.2.0 again, run this in Terminal, then choose Retry; stopping keeps all stored data:\n\(stopCommand)"
    }
    private let didNotReturn = "Engine v3.2.0 did not answer in time, and the previous engine v3.1.2 did not restart with normal service. It may not read data that a newer engine already upgraded."
    private let mayStillBeStarting = "Engine v3.2.0 did not answer in time, and Claudexor could not confirm that no engine is still running or starting, so it did not restart the previous engine v3.1.2 beside it."

    /// Serving `old`, idle; this app selects the newer `target`, which never
    /// answers unless a test says so.
    private func world(savedCopy: Bool = true) -> ReconciliationDaemonStub {
        let daemon = ReconciliationDaemonStub()
        daemon.servingIdentity = old
        daemon.targetIdentity = target
        daemon.runningIdentity = nil
        daemon.operatorStopCommandValue = stopCommand
        if savedCopy {
            daemon.savedScriptURLs = [saved]
            daemon.probeIdentities = [saved: old]
            daemon.returnedIdentity = old
        }
        return daemon
    }

    private var replacementThenReturn: [String] {
        ["stop 3.1.2", "start \(selected.path)", "stop 3.2.0", "start \(saved.path)"]
    }

    @MainActor
    @Test func restartsTheSavedPreviousEngineAndPassivePollsNeverStopItAgain() async {
        let daemon = world()
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41301)
        defer { sut.finish() }

        await sut.run()

        // The target was proven gone before the saved build started, and the
        // saved copy was probed once, before the first stop.
        #expect(daemon.events == replacementThenReturn)
        // A target spawn still queued at that moment could no longer run.
        #expect(daemon.earlierSpawnAdmitted == [false])
        #expect(daemon.probedScripts.filter { $0 == saved }.count == 1)
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.version == old.version)
        #expect(sut.model.engineIdentity?.sha == old.buildSha)
        #expect(sut.model.localDaemonReconciliationNotice == restarted)
        #expect(!sut.model.localEngineAwaitsRetry)
        #expect(!LocalEngineRetry.isOffered(for: sut.model))
        #expect(!UpdateChip.showsCompleteNotice(for: sut.model))
        // Different versions: the Settings build switch is not offered.
        #expect(sut.model.localDaemonBuildSwitch == nil)
        #expect(sut.outageLaunches == 0)
        // Every later pause was a connected poll that replaced nothing.
        #expect(sut.seen.suffix(4).allSatisfy { $0 == .init(health: .connected, notice: restarted) })
    }

    @MainActor
    @Test func withoutASavedCopyTheAppStaysOfflineWithItsReasonAndStartsNothingOnItsOwn() async {
        // A DMG replaced the bundle: its script is the selected target now and
        // no versions/3.1.2 closure was ever installed.
        let daemon = world(savedCopy: false)
        daemon.savedScriptURLs = [selected]
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41302)
        defer { sut.finish() }

        await sut.run()

        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)"])
        // Probed once as the target, never again as a saved copy of 3.1.2.
        #expect(daemon.probedScripts == [selected])
        #expect(sut.model.health == .offline)
        #expect(sut.model.engineIdentity == nil)
        #expect(sut.model.localDaemonReconciliationNotice == notSaved)
        #expect(sut.seen.allSatisfy { $0.notice == notSaved })
        #expect(sut.model.localEngineAwaitsRetry)
        #expect(LocalEngineRetry.isOffered(for: sut.model))
        #expect(RootView.showsEnginePlaceholder(for: sut.model))
        #expect(sut.outageLaunches == 0)
    }

    enum SavedCopyAnswer: CaseIterable {
        /// It exits before answering, as after a data floor it cannot open.
        case never
        /// It answers only in recovery mode, as for an unsupported store schema.
        case recoveryOnly
        /// Another engine took the endpoint meanwhile.
        case anotherEngine
    }

    @MainActor
    @Test(arguments: SavedCopyAnswer.allCases)
    func aSavedCopyThatCannotServeAgainIsNeverReportedAsRestarted(answer: SavedCopyAnswer) async {
        let daemon = world()
        switch answer {
        case .never: daemon.returnedIdentity = nil
        case .recoveryOnly: daemon.returnedRecoveryOnly = true
        case .anotherEngine: daemon.returnedIdentity = other
        }
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41303)
        defer { sut.finish() }

        await sut.run()

        #expect(daemon.events == replacementThenReturn)
        let failure = answer == .recoveryOnly ? answeredOnlyInRecovery : didNotReturn
        #expect(sut.seen.first == .init(health: .offline, notice: failure))
        #expect(!sut.seen.contains { $0.notice == restarted })
        #expect(sut.outageLaunches == 0)
        switch answer {
        case .never:
            #expect(sut.model.health == .offline)
            #expect(sut.model.localDaemonReconciliationNotice == didNotReturn)
            #expect(LocalEngineRetry.isOffered(for: sut.model))
        case .recoveryOnly:
            // It keeps the endpoint without admission: Connecting, not adopted.
            #expect(sut.model.health == .connecting)
            #expect(sut.model.client == nil)
            #expect(sut.model.localDaemonReconciliationNotice == failure)
            // Retry is offered only Offline, never against an answering engine.
            #expect(sut.model.localEngineAwaitsRetry)
            #expect(!LocalEngineRetry.isOffered(for: sut.model))
        case .anotherEngine:
            // That engine is kept and not stopped for the same target again.
            #expect(sut.model.health == .connected)
            #expect(sut.model.engineIdentity?.version == other.version)
            #expect(sut.model.localDaemonReconciliationNotice == kept)
            #expect(!sut.model.localEngineAwaitsRetry)
        }
    }

    @MainActor
    @Test func aDifferentEngineAnsweringAfterTheStartIsNeitherRolledBackNorReplacedAgain() async {
        let daemon = world()
        daemon.runningIdentity = other
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41304)
        defer { sut.finish() }

        await sut.run()

        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)"])
        #expect(sut.seen.first == .init(
            health: .offline, notice: "After the refresh, engine v3.1.5 answered instead of the selected v3.2.0."))
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.version == other.version)
        #expect(sut.model.localDaemonReconciliationNotice == kept)
    }

    /// The exact stop passes while nothing holds the writer lease yet, which is
    /// what a child still booting looks like. Only its own exit proves it gone.
    @MainActor
    @Test func aLaunchedChildStillRunningGetsNoSecondEngineEvenWhenItsStopPasses() async {
        let daemon = world()
        daemon.runningLaunchReads = [selected: .max]
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41311)
        defer { sut.finish() }
        sut.atPause[3] = { daemon.setRunningIdentity(self.target) }

        await sut.run()

        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)", "stop 3.2.0"])
        #expect(sut.seen.first == .init(health: .offline, notice: mayStillBeStarting))
        // It answers later and is adopted; the previous engine never started.
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.version == target.version)
        #expect(sut.model.localDaemonReconciliationNotice == nil)
        #expect(sut.outageLaunches == 0)
    }

    @MainActor
    @Test func anUnclearFirstStopIsNotRepeatedByPassivePolls() async {
        let daemon = world()
        daemon.stopThrows = true
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41312)
        defer { sut.finish() }

        await sut.run()

        #expect(daemon.events == ["stop 3.1.2"])
        #expect(sut.seen.first == .init(
            health: .offline,
            notice: "Engine refresh could not confirm that the previous engine stopped, so it did not start the selected runtime."))
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.version == old.version)
        #expect(sut.model.localDaemonReconciliationNotice
            == "Engine v3.2.0 did not start earlier, so Claudexor keeps the running engine v3.1.2. It stays in use until it exits or the app is reopened; then v3.2.0 is tried again.")
        #expect(!sut.model.localEngineAwaitsRetry)
    }

    @MainActor
    @Test func missingLaunchFilesAreNamedInsteadOfADataHedge() async {
        // The selected script is missing, and a saved copy exists: no boot wait.
        let restores = world()
        restores.failingStartScripts = [selected]
        let restored = EngineWorldHarness(restores, selected: selected, port: 41313)
        defer { restored.finish() }
        await restored.run()
        #expect(restores.events == replacementThenReturn)
        #expect(restored.model.engineIdentity?.version == old.version)
        #expect(restored.model.localDaemonReconciliationNotice == self.restarted)

        // The selected script is missing, and no saved copy exists.
        let noCopy = world(savedCopy: false)
        noCopy.failingStartScripts = [selected]
        let offline = EngineWorldHarness(noCopy, selected: selected, port: 41314)
        defer { offline.finish() }
        await offline.run()
        #expect(offline.model.health == .offline)
        #expect(offline.model.localDaemonReconciliationNotice
            == "Engine v3.2.0 could not be launched because its script or the app's Node is missing, and no saved copy of the previous engine v3.1.2 could be verified, so it was not restarted.")
        #expect(offline.model.localEngineAwaitsRetry)

        // The saved copy's own files vanished after its probe.
        let vanished = world()
        vanished.failingStartScripts = [saved]
        let gone = EngineWorldHarness(vanished, selected: selected, port: 41315)
        defer { gone.finish() }
        await gone.run()
        #expect(vanished.events == replacementThenReturn)
        #expect(gone.model.health == .offline)
        #expect(gone.model.localDaemonReconciliationNotice
            == "Engine v3.2.0 did not answer in time, and the saved copy of the previous engine v3.1.2 could not be launched because its script or the app's Node is missing.")
        #expect(gone.model.localEngineAwaitsRetry)
    }

    @MainActor
    @Test(arguments: [true, false])
    func busyOrUnknownActivityDefersBeforeAnySavedCopyIsProbed(busy: Bool) async {
        let daemon = world()
        daemon.busy = busy ? true : nil
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41305)
        defer { sut.finish() }

        await sut.run()

        #expect(daemon.events.isEmpty)
        #expect(!daemon.probedScripts.contains(saved))
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.version == old.version)
        #expect(sut.model.localDaemonReconciliationNotice == (busy
            ? "Engine refresh is deferred while work is active."
            : "Engine refresh is deferred until active work can be checked."))
    }

    @MainActor
    @Test func aTargetThatMayStillBeStartingGetsNoSecondEngineAndIsAdoptedWhenItAnswers() async {
        let daemon = world()
        // Its writer lease is held while its socket is not up yet.
        daemon.targetStopRefusal = .activityUnknown
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41306)
        defer { sut.finish() }
        sut.atPause[3] = { daemon.setRunningIdentity(self.target) }

        await sut.run()

        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)", "stop 3.2.0"])
        #expect(sut.seen.first == .init(health: .offline, notice: mayStillBeStarting))
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.version == target.version)
        #expect(sut.model.localDaemonReconciliationNotice == nil)
        #expect(!sut.model.localEngineAwaitsRetry)
        #expect(sut.outageLaunches == 0)
    }

    @MainActor
    @Test func aRecoveryOnlyTargetIsKeptAndNeverRolledBack() async {
        let daemon = world()
        daemon.runningIdentity = target
        daemon.runningRecoveryOnly = true
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41307)
        defer { sut.finish() }

        await sut.run()

        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)"])
        #expect(sut.model.health == .connecting)
        #expect(sut.model.client == nil)
        #expect(sut.model.localDaemonReconciliationNotice == nil)
        #expect(!LocalEngineRetry.isOffered(for: sut.model))
        #expect(sut.outageLaunches == 0)
    }

    /// The exact target answered once in recovery mode, so it was kept, and
    /// then died before normal admission. The loop's start went to that
    /// lifecycle, so Offline must say so and offer Retry.
    @MainActor
    @Test func aKeptRecoveryOnlyTargetThatDiesIsALifecycleFailureWithRetry() async {
        let daemon = world()
        daemon.runningIdentity = target
        daemon.runningRecoveryOnly = true
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41316)
        defer { sut.finish() }
        sut.atPause[3] = { daemon.setExternalEngine(nil) }

        await sut.run()

        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)"])
        #expect(sut.seen.prefix(3).allSatisfy { $0 == .init(health: .connecting, notice: nil) })
        #expect(sut.model.health == .offline)
        #expect(sut.model.localDaemonReconciliationNotice == LocalDaemonReconciliationPolicy.lostSuccessorNotice)
        #expect(LocalEngineRetry.isOffered(for: sut.model))
        #expect(sut.outageLaunches == 0)
    }

    /// The same loss after an explicit switch, whose reconnect runs without a
    /// start allowance of its own.
    @MainActor
    @Test func aSwitchedEngineLostBeforeAdoptionIsALifecycleFailureWithRetry() async throws {
        let buildA = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "a", count: 40))
        let buildB = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
        let daemon = ReconciliationDaemonStub()
        daemon.servingIdentity = buildA
        daemon.targetIdentity = buildB
        daemon.runningIdentity = buildB
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41317)
        defer { sut.finish() }
        let pair = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        sut.lastPause = 2
        await sut.run()
        try #require(sut.model.localDaemonBuildSwitch == pair)

        guard case .reconnect? = await sut.model.switchLocalDaemonBuild(pair) else {
            Issue.record("A replaced build must reconnect")
            return
        }
        daemon.setExternalEngine(nil)
        await sut.runAgain(pauses: 3, launchAvailable: false)

        #expect(daemon.events == ["stop 3.2.0", "start \(selected.path)"])
        #expect(sut.model.health == .offline)
        #expect(sut.model.localDaemonReconciliationNotice == LocalDaemonReconciliationPolicy.lostSuccessorNotice)
        #expect(LocalEngineRetry.isOffered(for: sut.model))
        #expect(sut.outageLaunches == 0)
    }

    /// Opus's reproduction: the restarted older engine keeps the root in
    /// recovery mode. The notice names this app's exact operator stop; once
    /// that engine is gone, Offline offers Retry, which may start the target.
    @MainActor
    @Test func aSavedCopyKeepingTheRootInRecoveryNamesTheExactStopThenOffersRetry() async {
        let daemon = world()
        daemon.returnedRecoveryOnly = true
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41318)
        defer { sut.finish() }
        sut.atPause[4] = { daemon.setExternalEngine(nil) }

        await sut.run()

        #expect(daemon.events == replacementThenReturn)
        // While it answers in recovery: Connecting with the stop, no Retry.
        #expect(sut.seen[1...3].allSatisfy { $0 == .init(health: .connecting, notice: answeredOnlyInRecovery) })
        #expect(sut.offers[1...3].allSatisfy { !$0 })
        // Once it is gone: Offline, the same reason, and Retry.
        #expect(sut.offers.last == true)
        #expect(sut.model.health == .offline)
        #expect(sut.model.localDaemonReconciliationNotice == answeredOnlyInRecovery)
        #expect(LocalEngineRetry.isOffered(for: sut.model))
        #expect(sut.outageLaunches == 0)
    }

    /// Remote work keeps the thread screen instead of the placeholder; the
    /// sidebar then carries the complete reason and the same Retry offer.
    @MainActor
    @Test func remoteWorkKeepsTheThreadScreenAndTheSidebarCarriesTheSameOffer() async {
        let daemon = world(savedCopy: false)
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41319)
        defer { sut.finish() }
        await sut.run()
        sut.model.remoteConnections = [RemoteConnection(sshAlias: "fixture-host")]

        #expect(!RootView.showsEnginePlaceholder(for: sut.model))
        #expect(UpdateChip.notice(for: sut.model) == notSaved)
        #expect(UpdateChip.showsCompleteNotice(for: sut.model))
        #expect(LocalEngineRetry.isOffered(for: sut.model))
    }

    @MainActor
    @Test func theNextOutageStartsTheLauncherSelectionAgain() async {
        let daemon = world()
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41308)
        defer { sut.finish() }
        // The restarted engine exits; the ordinary launcher starts the target.
        sut.atPause[3] = { daemon.setExternalEngine(nil) }
        sut.onOutageLaunch = {
            daemon.setExternalEngine(RuntimeServingHandshake(identity: self.target, recoveryOnly: false))
        }

        await sut.run()

        #expect(daemon.events == replacementThenReturn)
        #expect(sut.outageLaunches == 1)
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.version == target.version)
        #expect(sut.model.localDaemonReconciliationNotice == nil)
    }

    @MainActor
    @Test func retryingFromOfflineStartsTheSelectedEngineOnceThroughTheLauncher() async throws {
        let daemon = world(savedCopy: false)
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41309)
        defer { sut.finish() }
        await sut.run()
        try #require(sut.model.health == .offline)
        #expect(sut.model.localEngineAwaitsRetry)
        #expect(sut.outageLaunches == 0)

        // Retry is `connect()`: a new generation whose loop may start once.
        sut.model.connectionGeneration += 1
        sut.onOutageLaunch = {
            daemon.setExternalEngine(RuntimeServingHandshake(identity: self.target, recoveryOnly: false))
        }
        await sut.runAgain(pauses: 4)

        #expect(sut.outageLaunches == 1)
        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)"])
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.version == target.version)
        #expect(sut.model.localDaemonReconciliationNotice == nil)
        #expect(!sut.model.localEngineAwaitsRetry)
    }

    @MainActor
    @Test func anExplicitSameVersionSwitchRetriesWhatPassivePollsKeep() async throws {
        let buildA = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "a", count: 40))
        let buildB = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
        let savedA = URL(fileURLWithPath: "/fixtures/runtime/versions/3.2.0/claudexord.bundle.cjs")
        let daemon = ReconciliationDaemonStub()
        daemon.servingIdentity = buildA
        daemon.targetIdentity = buildB
        daemon.savedScriptURLs = [savedA]
        daemon.probeIdentities = [savedA: buildA]
        daemon.returnedIdentity = buildA
        let sut = EngineWorldHarness(daemon, selected: selected, port: 41310)
        defer { sut.finish() }
        let pair = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        // Builds of one version never switch on their own, so a reopened app
        // keeps A: the notice promises a retry only at exit or by request.
        let restartedA = "Engine v3.2.0 (bbbbbbbbbbbb) did not start, so Claudexor restarted the previous engine v3.2.0 (aaaaaaaaaaaa). It stays in use until it exits; then v3.2.0 (bbbbbbbbbbbb) is tried again. To try it now, use Settings → General → Switch Engine Build when work is idle."

        // Passive polls only offer the switch between builds of one version.
        sut.lastPause = 2
        await sut.run()
        try #require(sut.model.localDaemonBuildSwitch == pair)
        #expect(daemon.events.isEmpty)

        // The explicit switch: B does not come up, so A is restarted.
        guard case let .reconnect(generation)? = await sut.model.switchLocalDaemonBuild(pair) else {
            Issue.record("The switch must hand its generation to a reconnect")
            return
        }
        #expect(generation == sut.model.connectionGeneration)
        await sut.runAgain(pauses: 4, launchAvailable: false)
        #expect(daemon.events == ["stop 3.2.0", "start \(selected.path)", "stop 3.2.0", "start \(savedA.path)"])
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.sha == buildA.buildSha)
        #expect(sut.model.localDaemonReconciliationNotice == restartedA)
        try #require(sut.model.localDaemonBuildSwitch == pair)
        #expect(sut.outageLaunches == 0)

        // A second explicit switch retries B, which now answers.
        daemon.setRunningIdentity(buildB)
        guard case .reconnect? = await sut.model.switchLocalDaemonBuild(pair) else {
            Issue.record("The retried switch must reconnect to its replacement")
            return
        }
        await sut.runAgain(pauses: 3, launchAvailable: false)
        #expect(daemon.events.suffix(2) == ["stop 3.2.0", "start \(selected.path)"])
        #expect(daemon.starts == 3)
        #expect(sut.model.health == .connected)
        #expect(sut.model.engineIdentity?.sha == buildB.buildSha)
        #expect(sut.model.localDaemonReconciliationNotice == nil)
        #expect(sut.model.localDaemonBuildSwitch == nil)
    }
}

/// Offscreen captures of what a failed replacement leaves on screen: the
/// Connecting/Offline placeholder when no engine is adopted, otherwise the
/// sidebar update chip's notice. Each state comes from the production loop
/// above. No window is shown, nothing is spawned and no endpoint is contacted.
@MainActor @Suite(.serialized)
struct LocalDaemonPreviousEngineRenderTests {
    enum Scenario: String, CaseIterable {
        case savedCopyRestarted = "saved-copy-restarted"
        case noSavedCopy = "no-saved-copy"
        case savedCopyRefused = "saved-copy-refused"
        case targetMayStillBeStarting = "target-may-still-be-starting"
        case launchFilesMissing = "launch-files-missing"
        case keptTargetLost = "kept-recovery-target-lost"
        case savedCopyHoldsRootInRecovery = "saved-copy-holds-root-in-recovery"
        case remoteKeepsThreadScreen = "remote-keeps-thread-screen"
    }

    private let old = RuntimeClosureIdentity(version: "3.1.2", buildSha: String(repeating: "a", count: 40))
    private let target = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
    private let selected = URL(fileURLWithPath: "/fixtures/App-B/Contents/Resources/claudexord.bundle.cjs")
    private let saved = URL(fileURLWithPath: "/fixtures/runtime/versions/3.1.2/claudexord.bundle.cjs")

    private func world(_ scenario: Scenario) -> ReconciliationDaemonStub {
        let daemon = ReconciliationDaemonStub()
        daemon.servingIdentity = old
        daemon.targetIdentity = target
        daemon.operatorStopCommandValue = DaemonLauncher.operatorStopCommand(
            root: URL(fileURLWithPath: "/Users/fixture/.claudexor/v3"),
            node: URL(fileURLWithPath: "/Applications/Claudexor.app/Contents/Resources/node"),
            cli: URL(fileURLWithPath: "/Applications/Claudexor.app/Contents/Resources/claudexor.bundle.cjs"),
            environment: [:], fileExists: { _ in true })
        if scenario == .launchFilesMissing { daemon.failingStartScripts = [selected] }
        if scenario == .keptTargetLost {
            daemon.runningIdentity = target
            daemon.runningRecoveryOnly = true
            return daemon
        }
        guard ![.noSavedCopy, .launchFilesMissing, .remoteKeepsThreadScreen].contains(scenario)
        else { return daemon }
        daemon.savedScriptURLs = [saved]
        daemon.probeIdentities = [saved: old]
        daemon.returnedIdentity = scenario == .savedCopyRefused ? nil : old
        daemon.returnedRecoveryOnly = scenario == .savedCopyHoldsRootInRecovery
        if scenario == .targetMayStillBeStarting { daemon.targetStopRefusal = .activityUnknown }
        return daemon
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_ENGINE_RETURN_RENDER_QA"] == "1"))
    func capturesWhatAFailedReplacementLeavesOnScreen() async throws {
        let environment = ProcessInfo.processInfo.environment
        let output = URL(fileURLWithPath: try #require(environment["CX_ENGINE_RETURN_RENDER_OUTPUT"]), isDirectory: true)
        let phase = environment["CX_ENGINE_RETURN_RENDER_PHASE"] ?? "capture"
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        var manifest: [[String: Any]] = []
        for (index, scenario) in Scenario.allCases.enumerated() {
            let daemon = world(scenario)
            let sut = EngineWorldHarness(daemon, selected: selected, port: 41320 + index)
            if scenario == .keptTargetLost { sut.atPause[3] = { daemon.setExternalEngine(nil) } }
            // Stop at a pause where that recovery-only copy still answers.
            if scenario == .savedCopyHoldsRootInRecovery { sut.lastPause = 3 }
            await sut.run()
            if scenario == .remoteKeepsThreadScreen {
                sut.model.remoteConnections = [RemoteConnection(sshAlias: "fixture-host")]
            }
            let placeholder = RootView.showsEnginePlaceholder(for: sut.model)
            let size = placeholder ? CGSize(width: 720, height: 440) : CGSize(width: 280, height: 220)
            for (name, appearance, scheme) in [("light", NSAppearance.Name.aqua, ColorScheme.light),
                                                ("dark", .darkAqua, .dark)] {
                let surface = Group {
                    if placeholder {
                        EnginePlaceholder()
                    } else {
                        VStack(spacing: 0) {
                            Spacer(minLength: 0)
                            UpdateChip()
                        }
                    }
                }
                .environment(sut.model)
                .frame(width: size.width, height: size.height)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
                .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                let host = NSHostingView(rootView: surface)
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                    styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                host.frame = NSRect(origin: .zero, size: size)
                host.appearance = NSAppearance(named: appearance)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                host.displayIfNeeded()
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                let file = "\(phase)-\(scenario.rawValue)-\(placeholder ? "offline-placeholder" : "sidebar-chip")-\(name).png"
                try png.write(to: output.appendingPathComponent(file))
                #expect(!window.isVisible && !window.isKeyWindow)
                manifest.append([
                    "file": file, "scenario": scenario.rawValue, "appearance": name,
                    "surface": placeholder ? "EnginePlaceholder" : "UpdateChip",
                    "health": "\(sut.model.health)",
                    "retry_offered": LocalEngineRetry.isOffered(for: sut.model),
                    "notice": sut.model.localDaemonReconciliationNotice ?? NSNull(),
                    "width_points": size.width, "height_points": size.height,
                    "capture": "NSHostingView.cacheDisplay", "window_shown": window.isVisible,
                ])
                window.close()
            }
            sut.finish()
        }
        try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("\(phase)-manifest.json"))
    }
}
