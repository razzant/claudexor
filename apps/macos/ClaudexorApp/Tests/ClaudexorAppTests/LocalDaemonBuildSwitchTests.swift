import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

private final class LateBuildHandshakeURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let body: String
        let status: Int
        switch request.url?.path {
        case "/healthz":
            status = 200
            body = #"{"ok":true}"#
        case "/v2/handshake":
            status = 200
            body = #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"3.2.0","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","entry":"/fixtures/App-B"}}"#
        default:
            status = 503
            body = "{}"
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Answers by port, so parallel tests share no mutable answer: 41201 serves
/// build A normally, 41202 serves it in recovery mode, 41203 drops every
/// request, and 41204 serves build A while counting its handshakes.
private final class BuildAHandshakeURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var counted = 0
    static var countedHandshakes: Int { lock.withLock { counted } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let port = request.url?.port
        guard port != 41203 else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let mode = port == 41202 ? #","servingMode":"recovery_only""# : ""
        let body: String
        let status: Int
        switch request.url?.path {
        case "/healthz":
            status = 200
            body = #"{"ok":true}"#
        case "/v2/handshake":
            if port == 41204 { Self.lock.withLock { Self.counted += 1 } }
            status = 200
            body = #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"3.2.0","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entry":"/fixtures/App-A"}\#(mode)}"#
        default:
            status = 503
            body = "{}"
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

struct LocalDaemonBuildSwitchTests {
    private let buildA = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "a", count: 40))
    private let buildB = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
    private let script = URL(fileURLWithPath: "/fixtures/App-B/claudexord.bundle.cjs")
    private let contentionNotice = "Another engine lifecycle action is in progress. Try Switch Engine Build again."

    /// A canonical private service root, as the lifecycle owner tests use, so
    /// two owners contend through the real cross-copy descriptor lock.
    private func lifecycleRoot() throws -> URL {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../tmp/lifecycle-\(UUID().uuidString)")
            .standardizedFileURL
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root
    }

    private func gateway(port: Int) -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BuildAHandshakeURLProtocol.self]
        return GatewayClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: "fixture",
            session: URLSession(configuration: configuration))
    }

    /// Connected to a client that answers build A; this app selects build B.
    @MainActor
    private func connectedModel(
        _ daemon: ReconciliationDaemonStub, owner: LocalRuntimeLifecycleOwner, port: Int = 41201
    ) -> AppModel {
        let model = AppModel(
            client: gateway(port: port), requestNotificationAuthorization: false, lifecycleOwner: owner)
        model.health = .connected
        model.connectionGeneration = 1
        model.localDaemonReconciler = reconciler(daemon, owner: owner)
        return model
    }

    private func reconciler(
        _ daemon: ReconciliationDaemonStub,
        owner: LocalRuntimeLifecycleOwner = LocalRuntimeLifecycleOwner()
    ) -> LocalDaemonReconciler {
        LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: owner,
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: script, authority: .installed(buildB)) },
            handshakePollInterval: 0, handshakePollTimeout: 0)
    }

    private func daemon() -> ReconciliationDaemonStub {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = buildB
        daemon.servingIdentity = buildA
        daemon.runningIdentity = buildB
        return daemon
    }

    @Test func explicitSameVersionSwitchRunsOnceAndPassiveCopiesCannotSwitchItBack() async {
        let daemon = daemon()
        let sut = reconciler(daemon)
        let request = LocalDaemonBuildSwitch(serving: buildA, target: buildB)

        #expect(await sut.reconcile(switchBuild: request) == .replaced(buildB))
        #expect(await sut.reconcile() == .coherent(buildB))
        // A second app still selects A, but observes B after the explicit switch.
        let other = ReconciliationDaemonStub()
        other.targetIdentity = buildA
        other.servingIdentity = buildB
        let otherCopy = LocalDaemonReconciler(
            daemon: other, lifecycleOwner: LocalRuntimeLifecycleOwner(),
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: script, authority: .installed(buildA)) })
        #expect(await otherCopy.reconcile() == .deferred(.explicitBuildSwitchRequired, serving: buildB, target: buildA))
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.startedScripts == [script])
        #expect(other.stops == 0)
        #expect(other.starts == 0)
    }

    @Test(arguments: [true, false])
    func explicitSwitchCannotStopBusyOrUnknownDaemon(busy: Bool) async {
        let daemon = daemon()
        daemon.busy = busy ? true : nil
        let result = await reconciler(daemon).reconcile(
            switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB))
        #expect(result == .deferred(busy ? .busy : .activityUnknown, serving: buildA, target: buildB))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test(arguments: [RuntimeReplacementStopError.busy, .activityUnknown])
    func explicitSwitchPreservesDaemonAtomicRefusal(refusal: RuntimeReplacementStopError) async {
        let daemon = daemon()
        daemon.replacementStopRefusal = refusal
        let result = await reconciler(daemon).reconcile(
            switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB))
        #expect(result == .deferred(refusal == .busy ? .busy : .activityUnknown, serving: buildA, target: buildB))
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.starts == 0)
    }

    @Test func changedServingIdentityInvalidatesTheDisplayedSwitch() async {
        let daemon = daemon()
        daemon.servingIdentity = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "c", count: 40))
        #expect(await reconciler(daemon).reconcile(
            switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB)) == .supersededBeforeLifecycle)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func servingIdentityIsRecheckedAfterTheAdvisoryBusyAwait() async {
        let daemon = daemon()
        let gate = SuspendedReconciliationEffect()
        daemon.busyGate = gate
        let sut = reconciler(daemon)
        let task = Task { await sut.reconcile(switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB)) }
        await gate.waitUntilEntered()
        daemon.setServingIdentity(buildB)
        await gate.release()
        #expect(await task.value == .supersededBeforeLifecycle)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func explicitActionWaitingBehindPassiveObservationIsNotConsumed() async throws {
        let daemon = daemon()
        let gate = SuspendedReconciliationEffect()
        daemon.probeGate = gate
        let owner = LocalRuntimeLifecycleOwner()
        let sut = reconciler(daemon, owner: owner)
        let passive = Task { await sut.reconcile() }
        await gate.waitUntilEntered()
        let explicit = Task { await sut.reconcile(switchBuild: LocalDaemonBuildSwitch(serving: buildA, target: buildB)) }
        await Task.yield()
        await gate.release()
        #expect(await passive.value == .deferred(.explicitBuildSwitchRequired, serving: buildA, target: buildB))
        #expect(await explicit.value == .replaced(buildB))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
        let lease = try #require(owner.claim(.installation).lease)
        owner.release(lease)
    }

    @Test func explicitActionDoesNotAuthorizeADowngrade() async {
        let daemon = daemon()
        let newer = RuntimeClosureIdentity(version: "3.3.0", buildSha: buildA.buildSha)
        daemon.servingIdentity = newer
        #expect(await reconciler(daemon).reconcile(switchBuild: LocalDaemonBuildSwitch(serving: newer, target: buildB))
            == .deferred(.targetNotNewer, serving: newer, target: buildB))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func settingsActionIsSeparateFromPassiveReconnectPolicy() async {
        let daemon = daemon()
        let model = AppModel(requestNotificationAuthorization: false)
        model.localDaemonReconciler = reconciler(daemon, owner: model.localRuntimeLifecycleOwner)
        model.engineIdentity = EngineBuildIdentity(version: buildA.version, sha: buildA.buildSha, entry: "/fixtures/App-A")

        _ = await model.localDaemonPolicy(for: model.engineIdentity)
        #expect(daemon.stops == 0)
        #expect(model.localDaemonBuildSwitch == LocalDaemonBuildSwitch(serving: buildA, target: buildB))
        let request = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        let receipt = await model.switchLocalDaemonBuild(request)
        #expect(receipt == .reconnect(generation: model.connectionGeneration))
        #expect(model.localDaemonBuildSwitch == nil)
        #expect(model.engineIdentity == nil)
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.starts == 1)
        #expect(await model.switchLocalDaemonBuild(request) == nil)
    }

    @MainActor
    @Test(arguments: [false, true], [nil, "Successor owns this state"] as [String?])
    func staleExplicitCallbackCannotOverwriteANewerConnection(admitted: Bool, successorNotice: String?) async {
        let daemon = daemon()
        let model = AppModel(requestNotificationAuthorization: false)
        model.localDaemonReconciler = reconciler(daemon, owner: model.localRuntimeLifecycleOwner)
        model.localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        let gate = SuspendedReconciliationEffect()
        if admitted { daemon.stopGate = gate } else { daemon.busyGate = gate }
        let request = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        let task = Task { @MainActor in await model.switchLocalDaemonBuild(request) }
        await gate.waitUntilEntered()
        model.connectionGeneration += 1
        if let successorNotice { model.localDaemonReconciliationNotice = successorNotice }
        model.localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: buildB, target: buildA)
        await gate.release()
        #expect(await task.value == nil)
        #expect(model.localDaemonReconciliationNotice == successorNotice)
        #expect(model.localDaemonBuildSwitch == LocalDaemonBuildSwitch(serving: buildB, target: buildA))
        #expect(daemon.stops == (admitted ? 1 : 0))
        #expect(daemon.starts == (admitted ? 1 : 0))
    }

    @MainActor
    @Test(arguments: [false, true])
    func queuedButtonIntentCannotSwitchThePairPublishedByALaterPoll(targetChanged: Bool) async {
        let daemon = daemon()
        let model = AppModel(requestNotificationAuthorization: false)
        model.localDaemonReconciler = reconciler(daemon, owner: model.localRuntimeLifecycleOwner)
        let displayed = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        model.localDaemonBuildSwitch = displayed
        let buildC = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "c", count: 40))
        let latest = targetChanged
            ? LocalDaemonBuildSwitch(serving: buildA, target: buildC)
            : LocalDaemonBuildSwitch(serving: buildC, target: buildB)
        model.localDaemonBuildSwitch = latest // a poll before the button Task runs
        let generation = model.connectionGeneration
        #expect(await model.switchLocalDaemonBuild(displayed) == nil)
        #expect(model.connectionGeneration == generation)
        #expect(model.localDaemonBuildSwitch == latest)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func failedSwitchProofCleansOfflineStateAndLateBuildReconnectsWithoutAnotherLaunch() async throws {
        let daemon = daemon()
        daemon.runningIdentity = nil // the zero-budget post-start proof expires
        let model = AppModel(requestNotificationAuthorization: false)
        defer { model.cancelAllStreams() }
        model.localDaemonReconciler = reconciler(daemon, owner: model.localRuntimeLifecycleOwner)
        model.engineIdentity = EngineBuildIdentity(version: buildA.version, sha: buildA.buildSha, entry: "/fixtures/App-A")
        let request = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        model.localDaemonBuildSwitch = request
        model.secretBackend = "stale fixture projection"
        model.settingsStatus = "stale fixture settings"
        let epoch = model.settingsEpoch
        let switched = await model.switchLocalDaemonBuild(request)
        guard case let .reconnect(receipt)? = switched else {
            Issue.record("A failed proof must hand its generation to a reconnect, got \(String(describing: switched))")
            return
        }
        #expect(model.health == .offline)
        #expect(model.secretBackend == "unknown")
        #expect(model.settingsStatus == nil)
        #expect(model.settingsEpoch > epoch)
        #expect(model.localDaemonReconciliationNotice
            == "Engine v3.2.0 (bbbbbbbbbbbb) did not answer in time, and no saved copy of the previous engine v3.2.0 (aaaaaaaaaaaa) could be verified, so it was not restarted.")
        #expect(model.localEngineAwaitsRetry)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LateBuildHandshakeURLProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "fixture",
            session: URLSession(configuration: configuration))
        var probes = 0
        var fallbackStarts = 0
        let recovery = LocalConnectionRecoveryLoop(
            generation: receipt, currentGeneration: { model.connectionGeneration },
            lifecycleOwner: model.localRuntimeLifecycleOwner, prepareProbe: {},
            probe: {
                probes += 1
                if probes == 1 { return .unavailable }
                return await model.tryConnect(candidate: client, endpoint: "fixture", generation: receipt)
            },
            engineAnswers: { false },
            pollConnected: {
                #expect(model.health == .connected)
                #expect(model.engineIdentity?.sha == buildB.buildSha)
                model.connectionGeneration += 1
                return .superseded
            },
            startDaemon: { _ in fallbackStarts += 1; return false },
            enterOffline: { model.enterHardOffline() },
            pause: { daemon.runningIdentity = buildB; await Task.yield() })
        await recovery.run(launchAvailable: false)
        #expect(probes == 2)
        #expect(fallbackStarts == 0)
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.starts == 1)
        #expect(model.health == .connected)
    }

    // MARK: - Contention is no new observation

    @MainActor
    @Test func passivePollUnderCrossCopyContentionKeepsThePublishedOfferAndNotice() async throws {
        let root = try lifecycleRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let daemon = daemon()
        let model = connectedModel(daemon, owner: LocalRuntimeLifecycleOwner(serviceRoot: root))
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let pair = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        #expect(await model.pollLocalConnection(generation: 1) == .connected)
        try #require(model.localDaemonBuildSwitch == pair)
        let notice = try #require(model.localDaemonReconciliationNotice)

        // Another copy's lifecycle transaction, or its own periodic check,
        // holds the shared lock while this copy keeps polling.
        let held = try #require(otherCopy.claim(.reconciliation).lease)
        defer { otherCopy.release(held) }
        for _ in 0..<2 {
            #expect(await model.pollLocalConnection(generation: 1) == .connected)
            #expect(model.localDaemonBuildSwitch == pair)
            #expect(model.localDaemonReconciliationNotice == notice)
            #expect(model.engineIdentity?.sha == buildA.buildSha)
        }
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func explicitSwitchUnderCrossCopyContentionKeepsThePairAndItsConnection() async throws {
        let root = try lifecycleRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let daemon = daemon()
        let model = connectedModel(daemon, owner: LocalRuntimeLifecycleOwner(serviceRoot: root))
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let pair = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        #expect(await model.pollLocalConnection(generation: 1) == .connected)
        try #require(model.localDaemonBuildSwitch == pair)
        let client = try #require(model.client)
        let held = try #require(otherCopy.claim(.installation).lease)
        defer { otherCopy.release(held) }

        // Nothing was checked or changed: the exact pair is offered again with
        // the reason, and the same connection keeps serving. No retry happens.
        #expect(await model.switchLocalDaemonBuild(pair) == .resume(generation: model.connectionGeneration))
        #expect(model.localDaemonBuildSwitch == pair)
        #expect(model.localDaemonReconciliationNotice == contentionNotice)
        #expect(model.client === client)
        #expect(model.health == .connected)
        #expect(model.engineIdentity?.sha == buildA.buildSha)
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    /// The switch's generation retires the old polling loop; the production
    /// resume path must hand that generation to a live loop on the same client.
    @MainActor
    @Test func resumedPollingKeepsTheSameClientUnderTheSwitchGeneration() async throws {
        let root = try lifecycleRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let daemon = daemon()
        let model = connectedModel(daemon, owner: LocalRuntimeLifecycleOwner(serviceRoot: root), port: 41204)
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let pair = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        #expect(await model.pollLocalConnection(generation: 1) == .connected)
        try #require(model.localDaemonBuildSwitch == pair)
        let held = try #require(otherCopy.claim(.installation).lease)
        defer { otherCopy.release(held) }
        let switched = await model.switchLocalDaemonBuild(pair)
        guard case let .resume(generation)? = switched else {
            Issue.record("Contention must resume the kept connection, got \(String(describing: switched))")
            return
        }
        let client = try #require(model.client)
        let before = BuildAHandshakeURLProtocol.countedHandshakes

        let polling = Task { @MainActor in await model.resumeLocalConnection(generation: generation) }
        // The first resumed poll follows the ordinary three-second pause.
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while BuildAHandshakeURLProtocol.countedHandshakes == before, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(BuildAHandshakeURLProtocol.countedHandshakes > before)
        #expect(model.connectionGeneration == generation)
        #expect(model.client === client)
        #expect(model.health == .connected)
        #expect(model.localDaemonBuildSwitch == pair)
        polling.cancel()
        await polling.value
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func busyExplicitSwitchKeepsItsClientAndResumesInsteadOfReconnecting() async throws {
        let daemon = daemon()
        daemon.busy = true
        let model = connectedModel(daemon, owner: LocalRuntimeLifecycleOwner())
        let pair = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        #expect(await model.pollLocalConnection(generation: 1) == .connected)
        try #require(model.localDaemonBuildSwitch == pair)
        let client = try #require(model.client)

        #expect(await model.switchLocalDaemonBuild(pair) == .resume(generation: model.connectionGeneration))
        #expect(model.localDaemonReconciliationNotice == "Engine refresh is deferred while work is active.")
        #expect(model.localDaemonBuildSwitch == pair)
        #expect(model.client === client)
        #expect(model.health == .connected)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func explicitSwitchReplacesStaleGuidanceWhileItsOneRequestRuns() async throws {
        let daemon = daemon()
        let gate = SuspendedReconciliationEffect()
        daemon.busyGate = gate
        let model = connectedModel(daemon, owner: LocalRuntimeLifecycleOwner())
        let pair = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        #expect(await model.pollLocalConnection(generation: 1) == .connected)
        try #require(model.localDaemonBuildSwitch == pair)
        let guidance = try #require(model.localDaemonReconciliationNotice)

        let task = Task { @MainActor in await model.switchLocalDaemonBuild(pair) }
        await gate.waitUntilEntered()
        // The button is gone, so its guidance must not keep pointing at it.
        #expect(model.localDaemonBuildSwitch == nil)
        #expect(model.localDaemonReconciliationNotice != guidance)
        #expect(model.localDaemonReconciliationNotice == "Switching engine build if work is idle…")
        await gate.release()
        #expect(await task.value == .reconnect(generation: model.connectionGeneration))
        #expect(model.localDaemonReconciliationNotice == nil)
        #expect(daemon.stoppedIdentities == [buildA])
        #expect(daemon.starts == 1)
    }

    @MainActor
    @Test func contentionOnAChangedServingIdentityRetiresFactsPublishedForTheOldOne() async throws {
        let root = try lifecycleRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let model = connectedModel(daemon(), owner: LocalRuntimeLifecycleOwner(serviceRoot: root))
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let buildC = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "c", count: 40))
        model.engineIdentity = EngineBuildIdentity(version: buildC.version, sha: buildC.buildSha, entry: "/fixtures/App-C")
        model.localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: buildC, target: buildB)
        model.localDaemonReconciliationNotice = "Published while build C served this endpoint."
        let held = try #require(otherCopy.claim(.reconciliation).lease)
        defer { otherCopy.release(held) }

        #expect(await model.pollLocalConnection(generation: 1) == .connected)
        #expect(model.localDaemonBuildSwitch == nil)
        #expect(model.localDaemonReconciliationNotice == nil)
        #expect(model.engineIdentity?.sha == buildA.buildSha)
    }

    @MainActor
    @Test func connectingUnderContentionPublishesNoEarlierConnectionsFacts() async throws {
        let root = try lifecycleRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let model = AppModel(requestNotificationAuthorization: false, lifecycleOwner: owner)
        defer { model.cancelAllStreams() }
        model.connectionGeneration = 1
        model.localDaemonReconciler = reconciler(daemon(), owner: owner)
        model.localDaemonReconciliationNotice = "Claudexor did not start the engine: fixture."
        let held = try #require(otherCopy.claim(.reconciliation).lease)
        defer { otherCopy.release(held) }

        let candidate = gateway(port: 41201)
        #expect(await model.tryConnect(candidate: candidate, endpoint: "fixture", generation: 1) == .connected)
        #expect(model.client === candidate)
        #expect(model.localDaemonReconciliationNotice == nil)
        #expect(model.localDaemonBuildSwitch == nil)
    }

    @MainActor
    @Test func recoveryOnlyAnswersRetireAStaleSwitchOfferOnPollAndConnect() async throws {
        let pair = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        let daemon = daemon()
        let polled = connectedModel(daemon, owner: LocalRuntimeLifecycleOwner())
        #expect(await polled.pollLocalConnection(generation: 1) == .connected)
        let guidance = try #require(polled.localDaemonReconciliationNotice)
        try #require(polled.localDaemonBuildSwitch == pair)
        // The same endpoint's next handshake closes product admission.
        polled.client = gateway(port: 41202)
        #expect(await polled.pollLocalConnection(generation: 1) == .retryWithoutLaunch)
        #expect(polled.localDaemonBuildSwitch == nil)
        #expect(polled.localDaemonReconciliationNotice == nil)
        #expect(polled.client != nil)
        let connecting = AppModel(requestNotificationAuthorization: false)
        connecting.connectionGeneration = 1
        connecting.localDaemonBuildSwitch = pair
        connecting.localDaemonReconciliationNotice = guidance
        #expect(await connecting.tryConnect(candidate: gateway(port: 41202), endpoint: "fixture", generation: 1)
            == .retryWithoutLaunch)
        #expect(connecting.localDaemonBuildSwitch == nil)
        #expect(connecting.localDaemonReconciliationNotice == nil)
        #expect(connecting.client == nil)

        // A terminal reason without an offer remains useful during recovery.
        let failure = "Engine v3.2.0 (bbbbbbbbbbbb) did not answer in time, and no saved copy of the previous engine v3.2.0 (aaaaaaaaaaaa) could be verified, so it was not restarted."
        polled.localDaemonReconciliationNotice = failure
        connecting.localDaemonReconciliationNotice = failure
        #expect(await polled.pollLocalConnection(generation: 1) == .retryWithoutLaunch)
        #expect(await connecting.tryConnect(candidate: gateway(port: 41202), endpoint: "fixture", generation: 1)
            == .retryWithoutLaunch)
        #expect(polled.localDaemonReconciliationNotice == failure)
        #expect(connecting.localDaemonReconciliationNotice == failure)
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
    }

    @MainActor
    @Test func manualReconnectRetiresPendingSwitchProgressBeforeFailedLaunch() async throws {
        try await isolatedRuntimeConsumer(
            "LocalDaemonBuildSwitchTests/manualReconnectRetiresPendingSwitchProgressBeforeFailedLaunch"
        ) {
            // No app resources: the production launcher returns false without
            // spawning anything. Discovery and HOME belong only to this child.
            try #require(!DaemonLauncher.isAvailable)
            let daemon = daemon()
            let model = connectedModel(daemon, owner: LocalRuntimeLifecycleOwner())
            #expect(await model.pollLocalConnection(generation: 1) == .connected)
            let pair = try #require(model.localDaemonBuildSwitch)
            let gate = SuspendedReconciliationEffect()
            daemon.busyGate = gate
            let switching = Task { @MainActor in await model.switchLocalDaemonBuild(pair) }
            await gate.waitUntilEntered()
            let oldGeneration = model.connectionGeneration
            let connecting = Task { @MainActor in await model.connect() }
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while model.connectionGeneration == oldGeneration, ContinuousClock.now < deadline { await Task.yield() }
            #expect(model.connectionGeneration > oldGeneration)
            #expect(model.localDaemonReconciliationNotice == nil)
            await gate.release()
            #expect(await switching.value == nil)
            // Let the reconnect actually acquire/release its own outage lease
            // after contention ends; absent bundle resources make launch fail.
            let releasedSwitch = model.localRuntimeLifecycleOwner.completionSnapshot()
            while model.localRuntimeLifecycleOwner.completionSnapshot() == releasedSwitch,
                  ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(model.localRuntimeLifecycleOwner.completionSnapshot() != releasedSwitch)
            #expect(model.health == .offline)
            #expect(model.localDaemonReconciliationNotice == nil)
            connecting.cancel()
            await connecting.value
            #expect(daemon.stops == 0)
            #expect(daemon.starts == 0)
        }
    }

    @MainActor
    @Test func failedSwitchNoticeSurvivesItsRealReconnect() async throws {
        try await isolatedRuntimeConsumer("LocalDaemonBuildSwitchTests/failedSwitchNoticeSurvivesItsRealReconnect") {
            let daemon = daemon()
            daemon.runningIdentity = nil
            let model = connectedModel(daemon, owner: LocalRuntimeLifecycleOwner())
            #expect(await model.pollLocalConnection(generation: 1) == .connected)
            let pair = try #require(model.localDaemonBuildSwitch)
            let result = await model.switchLocalDaemonBuild(pair)
            guard case let .reconnect(generation)? = result else {
                Issue.record("Failed switch must reconnect")
                return
            }
            let failure = try #require(model.localDaemonReconciliationNotice)
            let connecting = Task { @MainActor in
                await model.connect(ifCurrentGeneration: generation, allowInitialLaunch: false)
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while model.connectionGeneration == generation, ContinuousClock.now < deadline { await Task.yield() }
            #expect(model.localDaemonReconciliationNotice == failure)
            while model.health != .offline, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(model.health == .offline)
            #expect(model.localDaemonReconciliationNotice == failure)
            connecting.cancel()
            await connecting.value
            #expect(daemon.stops == 1)
            #expect(daemon.starts == 1)
        }
    }

    @MainActor
    @Test func lostHandshakeRetiresTheOfferAndNoticeOfTheEngineItDescribed() async {
        let model = connectedModel(daemon(), owner: LocalRuntimeLifecycleOwner(), port: 41203)
        model.localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        model.localDaemonReconciliationNotice = "Engine refresh is deferred while work is active."
        #expect(await model.pollLocalConnection(generation: 1) == .unavailable)
        #expect(model.localDaemonBuildSwitch == nil)
        #expect(model.localDaemonReconciliationNotice == nil)
    }

    @MainActor
    @Test func switchReconnectReceiptCannotRetireANewerGeneration() async {
        let model = AppModel(requestNotificationAuthorization: false)
        model.connectionGeneration = 4
        model.engineIdentity = EngineBuildIdentity(version: buildB.version, sha: buildB.buildSha, entry: "/fixtures/successor")
        model.health = .connected
        await model.connect(ifCurrentGeneration: 3, allowInitialLaunch: false)
        #expect(model.connectionGeneration == 4)
        #expect(model.engineIdentity?.sha == buildB.buildSha)
        #expect(model.health == .connected)
    }
}
