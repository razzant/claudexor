import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

private struct ReconciliationTestError: Error {}

private final class ReconciliationHandshakeGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var entered = false
    private var released = false

    var hasEntered: Bool {
        condition.withLock { entered }
    }

    func block() {
        condition.lock()
        entered = true
        condition.broadcast()
        while !released { condition.wait() }
        condition.unlock()
    }

    func release() {
        condition.withLock {
            released = true
            condition.broadcast()
        }
    }
}

private final class DaemonHandshakeURLProtocol: URLProtocol {
    nonisolated(unsafe) static var engine = EngineBuildIdentity(
        version: "3.1.2", sha: String(repeating: "a", count: 40), entry: "/old/daemon.js")
    nonisolated(unsafe) static var gate: ReconciliationHandshakeGate?
    /// Issue #165: optional handshake servingMode ("recovery_only"/"normal").
    nonisolated(unsafe) static var servingMode: String?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.gate?.block()
        respond()
    }

    private func respond() {
        let data: Data
        switch request.url?.path {
        case "/healthz":
            data = Data(#"{"ok":true}"#.utf8)
        case "/v2/handshake":
            let engine = Self.engine
            let mode = Self.servingMode.map { #","servingMode":"\#($0)""# } ?? ""
            data = Data(#"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"\#(engine.version)","sha":"\#(engine.sha)","entry":"\#(engine.entry)"}\#(mode)}"#.utf8)
        default:
            client?.urlProtocol(self, didFailWithError: ReconciliationTestError())
            return
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class ReconciliationDaemonStub: RuntimeDaemonControl, @unchecked Sendable {
    private let lock = NSLock()
    var busy: Bool? = false
    var targetIdentity: RuntimeClosureIdentity?
    var servingIdentity: RuntimeClosureIdentity?
    var runningIdentity: RuntimeClosureIdentity?
    /// Admission of `runningIdentity` once a started selected script answers.
    var runningRecoveryOnly = false
    /// Saved copies offered for a return, and what each script's probe names
    /// (any other script probes as `targetIdentity`).
    var savedScriptURLs: [URL] = []
    var probeIdentities: [URL: RuntimeClosureIdentity] = [:]
    /// What a started saved script answers; nil never answers.
    var returnedIdentity: RuntimeClosureIdentity?
    var returnedRecoveryOnly = false
    /// The exact stop of `targetIdentity` refuses, as for an engine that may
    /// still be starting.
    var targetStopRefusal: RuntimeReplacementStopError?
    /// What `operatorStopCommand()` reports; nil keeps the protocol's meaning.
    var operatorStopCommandValue: String?
    var handshakeNilCount = 0
    var busyDelayNanoseconds: UInt64 = 0
    var busyGate: SuspendedReconciliationEffect?
    var probeGate: SuspendedReconciliationEffect?
    var stopGate: SuspendedReconciliationEffect?
    var stopThrows = false
    var replacementStopRefusal: RuntimeReplacementStopError?
    var startThrows = false
    /// Starts of these scripts throw, as a missing launch asset does.
    var failingStartScripts: Set<URL> = []
    /// Reads of a launch's `isRunning` that still report that script's child as
    /// running, as for a child still booting when its exact stop passes.
    var runningLaunchReads: [URL: Int] = [:]
    private(set) var busyProbes = 0
    private(set) var stops = 0
    private(set) var starts = 0
    private(set) var startedScripts: [URL] = []
    private(set) var stoppedIdentities: [RuntimeClosureIdentity] = []
    private(set) var probedScripts: [URL] = []
    /// Stops and starts in call order, e.g. "stop 3.1.2" or "start /saved".
    private(set) var events: [String] = []
    /// At each start, whether a spawn still queued from each earlier launch
    /// would have been admitted by its permit. A real spawn presents it later.
    private(set) var earlierSpawnAdmitted: [Bool] = []
    private var earlierPermits: [LocalRuntimeLaunchPermit] = []
    private var lastStarted: URL?
    /// A change outside this port (the engine exits, or the app's outage
    /// launcher starts one); a later start through this port replaces it.
    private var external: RuntimeServingHandshake??

    func isBusy() async -> Bool? {
        let (delay, gate) = lock.withLock {
            busyProbes += 1
            return (busyDelayNanoseconds, busyGate)
        }
        if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
        await gate?.wait()
        return lock.withLock { busy }
    }

    func stopForRuntimeReplacement(expectedIdentity: RuntimeClosureIdentity) async throws {
        let gate = try lock.withLock {
            stops += 1
            stoppedIdentities.append(expectedIdentity)
            events.append("stop \(expectedIdentity.version)")
            if expectedIdentity == targetIdentity, let targetStopRefusal { throw targetStopRefusal }
            if let replacementStopRefusal { throw replacementStopRefusal }
            if stopThrows { throw ReconciliationTestError() }
            return stopGate
        }
        await gate?.wait()
    }

    func start() throws {
        try recordStart(of: URL(fileURLWithPath: "/unused"), launchPermit: nil)
    }

    func start(scriptURL: URL, launchPermit: LocalRuntimeLaunchPermit) throws -> RuntimeDaemonLaunch {
        try recordStart(of: scriptURL, launchPermit: launchPermit)
        return RuntimeDaemonLaunch(isRunning: { self.readLaunchRunning(scriptURL) })
    }

    private func recordStart(of scriptURL: URL, launchPermit: LocalRuntimeLaunchPermit?) throws {
        try lock.withLock {
            starts += 1
            startedScripts.append(scriptURL)
            events.append("start \(scriptURL.path)")
            if startThrows || failingStartScripts.contains(scriptURL) { throw ReconciliationTestError() }
            earlierSpawnAdmitted += earlierPermits.map { $0.perform { true } }
            if let launchPermit { earlierPermits.append(launchPermit) }
            lastStarted = scriptURL
            external = nil
        }
    }

    private func readLaunchRunning(_ scriptURL: URL) -> Bool {
        lock.withLock {
            guard let reads = runningLaunchReads[scriptURL], reads > 0 else { return false }
            runningLaunchReads[scriptURL] = reads - 1
            return true
        }
    }

    func savedScripts(for identity: RuntimeClosureIdentity) -> [URL] {
        lock.withLock { savedScriptURLs }
    }

    func operatorStopCommand() -> String? {
        lock.withLock { operatorStopCommandValue }
    }

    func probeIdentity(scriptURL: URL) async -> RuntimeClosureIdentity? {
        let gate = lock.withLock {
            probedScripts.append(scriptURL)
            return probeGate
        }
        await gate?.wait()
        return lock.withLock { probeIdentities[scriptURL] ?? targetIdentity }
    }

    func handshakeIdentity() async -> RuntimeClosureIdentity? {
        await servingHandshake()?.identity
    }

    func servingHandshake() async -> RuntimeServingHandshake? {
        lock.withLock { engine(consumingBootDelay: true) }
    }

    /// The engine a client handshake sees right now, for an app-side fixture.
    func clientView() -> RuntimeServingHandshake? {
        lock.withLock { engine(consumingBootDelay: false) }
    }

    /// The event log, read under the lock while a reconciliation still runs.
    func recordedEvents() -> [String] {
        lock.withLock { events }
    }

    func setExternalEngine(_ engine: RuntimeServingHandshake?) {
        lock.withLock { external = .some(engine) }
    }

    private func engine(consumingBootDelay: Bool) -> RuntimeServingHandshake? {
        if let external { return external }
        if starts == 0 { return servingIdentity.map { .init(identity: $0, recoveryOnly: false) } }
        guard let lastStarted else { return nil }
        if handshakeNilCount > 0 {
            if consumingBootDelay { handshakeNilCount -= 1 }
            return nil
        }
        if savedScriptURLs.contains(lastStarted) {
            return returnedIdentity.map { .init(identity: $0, recoveryOnly: returnedRecoveryOnly) }
        }
        return runningIdentity.map { .init(identity: $0, recoveryOnly: runningRecoveryOnly) }
    }

    func setBusy(_ value: Bool?) { lock.withLock { busy = value } }
    func setServingIdentity(_ value: RuntimeClosureIdentity?) {
        lock.withLock { servingIdentity = value }
    }
    func setRunningIdentity(_ value: RuntimeClosureIdentity?) {
        lock.withLock { runningIdentity = value }
    }
}

@Suite(.serialized) struct LocalDaemonReconcilerTests {
    private let script = URL(fileURLWithPath: "/selected/claudexord.bundle.cjs")
    private let old = RuntimeClosureIdentity(version: "3.1.2", buildSha: String(repeating: "a", count: 40))
    private let target = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))

    @Test func bootPolicyCoversJournalHeavyColdStarts() {
        #expect(LocalDaemonBootPolicy.handshakeTimeout == 90)
    }

    private func reconciler(
        _ daemon: ReconciliationDaemonStub,
        lifecycleOwner: LocalRuntimeLifecycleOwner = LocalRuntimeLifecycleOwner(),
        targetClosure: LocalRuntimeClosureSelection? = nil,
        pollInterval: TimeInterval = 0.001,
        pollTimeout: TimeInterval = 0.1
    ) -> LocalDaemonReconciler {
        // Pre-stop identity is independent of the simulated post-launch result.
        if daemon.servingIdentity == nil { daemon.servingIdentity = old }
        return LocalDaemonReconciler(
            daemon: daemon,
            lifecycleOwner: lifecycleOwner,
            targetClosure: {
                targetClosure ?? LocalRuntimeClosureSelection(
                    scriptURL: script, authority: .bundledStampedProbe)
            },
            handshakePollInterval: pollInterval, handshakePollTimeout: pollTimeout)
    }

    @MainActor
    private func appModel(_ daemon: ReconciliationDaemonStub) -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DaemonHandshakeURLProtocol.self]
        let model = AppModel(
            client: GatewayClient(
                baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
                session: URLSession(configuration: config)),
            requestNotificationAuthorization: false)
        model.health = .connected
        model.localDaemonReconciler = reconciler(
            daemon, lifecycleOwner: model.localRuntimeLifecycleOwner)
        return model
    }

    @Test func exactIdentityIsANoop() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.servingIdentity = target

        let result = await reconciler(daemon).reconcile(serving: target)

        #expect(result == .coherent(target))
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func mismatchWhileIdleStopsStartsSelectedClosureAndPollsExactIdentity() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        daemon.handshakeNilCount = 2

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .replaced(target))
        #expect(daemon.stops == 1)
        #expect(daemon.stoppedIdentities == [old])
        #expect(daemon.starts == 1)
        #expect(daemon.startedScripts == [script])
    }

    @Test func busyDaemonIsDeferredWithoutStopping() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = true

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .deferred(.busy, serving: old, target: target))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func unknownActivityIsDeferredWithoutStopping() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = nil

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .deferred(.activityUnknown, serving: old, target: target))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func atomicStopDefersWhenWorkArrivesAfterTheAdvisoryIdleSnapshot() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = false
        daemon.replacementStopRefusal = .busy

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .deferred(.busy, serving: old, target: target))
        #expect(daemon.busyProbes == 1)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 0)
    }

    @Test func atomicStopMapsALateAuthorityFailureToActivityUnknown() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = false
        daemon.replacementStopRefusal = .activityUnknown

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .deferred(.activityUnknown, serving: old, target: target))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 0)
    }

    @Test func aDeferredMismatchCanReconcileAfterWorkBecomesIdle() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        daemon.busy = true
        let sut = reconciler(daemon)

        let deferred = await sut.reconcile(serving: old)
        #expect(deferred == .deferred(.busy, serving: old, target: target))
        daemon.setBusy(false)
        let replaced = await sut.reconcile(serving: old)
        #expect(replaced == .replaced(target))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func targetProbeFailureNeverStopsAKnownWorkingDaemon() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = nil

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .failed(.targetProbeFailed))
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func selectedInstalledPointerRejectsAProbeWithTheWrongBuildSha() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-selected-runtime-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let selectedDir = root.appendingPathComponent("versions/3.2.0")
        try FileManager.default.createDirectory(
            at: selectedDir, withIntermediateDirectories: true)
        try Data("// selected".utf8).write(
            to: selectedDir.appendingPathComponent("claudexord.bundle.cjs"))
        try installer.writeCurrentAtomic(RuntimeCurrent(
            version: target.version,
            path: RuntimeCurrent.versionPath(target.version),
            sha256: String(repeating: "1", count: 64),
            installedAt: "now",
            engineSha: target.buildSha))
        let bundled = root.appendingPathComponent("bundled.cjs")
        try Data("// bundled".utf8).write(to: bundled)
        let selected = try #require(DaemonLauncher.resolvedRuntime(
            installer: installer, bundledDaemon: bundled, bundledVersion: "3.1.0"))
        #expect(selected.authority == .installed(target))

        let daemon = ReconciliationDaemonStub()
        let wrong = RuntimeClosureIdentity(
            version: target.version, buildSha: String(repeating: "c", count: 40))
        daemon.targetIdentity = wrong

        let result = await reconciler(
            daemon, targetClosure: selected).reconcile(serving: old)

        #expect(result == .failed(.targetAuthorityMismatch(
            expected: target, got: wrong)))
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func wrongPostStartIdentityFailsWithoutClaimingCoherence() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = old

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .failed(.postStartMismatch(expected: target, got: old)))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func unreachablePostStartIdentityFailsAfterTheBoundedPoll() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = nil

        let result = await reconciler(daemon, pollTimeout: 0.01).reconcile(serving: old)

        #expect(result == .failed(.postStartUnreachable(expected: target, previous: .notSaved(old))))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func concurrentRequestsCoalesceIntoOneLifecycleTransition() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        daemon.busyDelayNanoseconds = 30_000_000
        let sut = reconciler(daemon)

        async let first = sut.reconcile(serving: old)
        async let second = sut.reconcile(serving: old)
        let firstResult = await first
        let secondResult = await second

        #expect([firstResult, secondResult] == [.replaced(target), .replaced(target)])
        #expect(daemon.busyProbes == 1)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func policyKeepsCompatibleOnlyForPreLifecycleFailures() {
        #expect(LocalDaemonReconciliationPolicy(.failed(.targetProbeFailed))
            == .useCompatible(notice: "Could not verify the selected engine runtime; continuing with the compatible running engine."))
        #expect(LocalDaemonReconciliationPolicy(.failed(.servingIdentityUnavailable))
            == .useCompatible(notice: "Could not verify the running engine build; continuing with its compatible protocol."))
        #expect(LocalDaemonReconciliationPolicy(.failed(.startFailed(expected: target, previous: .notSaved(old))))
            == .failOffline(notice: "Engine v3.2.0 could not be launched because its script or the app's Node is missing, and no saved copy of the previous engine v3.1.2 could be verified, so it was not restarted."))
        #expect(LocalDaemonReconciliationPolicy(.replaced(target)) == .reconnect)
        #expect(LocalDaemonReconciliationPolicy(.supersededBeforeLifecycle) == .retry)
    }

    @MainActor
    @Test func appPollKeepsBusyCompatibleDaemonThenRetriesWhenIdle() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.busy = true
        let model = appModel(daemon)

        #expect(await model.pollEngineIdentity())

        #expect(model.engineIdentity?.sha == old.buildSha)
        #expect(model.localDaemonReconciliationNotice
            == "Engine refresh is deferred while work is active.")
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)

        daemon.runningIdentity = target
        daemon.setBusy(false)
        #expect(await model.pollEngineIdentity() == false)
        #expect(model.engineIdentity == nil)
        #expect(model.localDaemonReconciliationNotice == nil)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @MainActor
    @Test func appPollReplacementForcesReconnectWithoutPublishingEitherIdentity() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let model = appModel(daemon)
        model.engineIdentity = DaemonHandshakeURLProtocol.engine

        #expect(await model.pollEngineIdentity() == false)

        #expect(model.engineIdentity == nil)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @MainActor
    @Test func appPollPostLifecycleMismatchFailsOfflineWithoutPublishing() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = old
        let model = appModel(daemon)

        #expect(await model.pollEngineIdentity() == false)

        #expect(model.engineIdentity == nil)
        #expect(model.localDaemonReconciliationNotice
            == "After the refresh, engine v3.1.2 answered instead of the selected v3.2.0.")
    }

    @MainActor
    @Test func recoveryOnlyHandshakeKeepsConnectingWithoutAdoptionOrReconciliation() async {
        // Issue #165 D5: a recovery-only daemon proves transport but keeps
        // product admission closed. tryConnect must NOT adopt the candidate,
        // hydrate, run the reconciliation lifecycle, or earn a fallback
        // launch — it stays in the Connecting loop (.retryWithoutLaunch).
        DaemonHandshakeURLProtocol.servingMode = "recovery_only"
        defer { DaemonHandshakeURLProtocol.servingMode = nil }
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        let model = appModel(daemon)
        model.connectionGeneration = 1
        let previousClient = model.client
        let previousEndpoint = model.endpoint
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DaemonHandshakeURLProtocol.self]
        let candidate = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:4321")!, token: "test",
            session: URLSession(configuration: config))

        let result = await model.tryConnect(
            candidate: candidate, endpoint: "127.0.0.1:4321", generation: 1)

        #expect(result == .retryWithoutLaunch)
        #expect(model.client === previousClient)
        #expect(model.endpoint == previousEndpoint)
        #expect(model.engineIdentity == nil)
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func connectedPollFallsBackToConnectingWhenDaemonReentersRecovery() async {
        // A daemon RESTARTED into a recovery-needed root re-answers the
        // steady-state poll with recovery_only: the poll returns
        // .retryWithoutLaunch (no outage launch, no reconciliation) and
        // leaves the published state for the recovery loop to unwind.
        DaemonHandshakeURLProtocol.servingMode = "recovery_only"
        defer { DaemonHandshakeURLProtocol.servingMode = nil }
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let model = appModel(daemon)
        model.connectionGeneration = 1
        model.engineIdentity = DaemonHandshakeURLProtocol.engine

        let result = await model.pollLocalConnection(generation: 1)

        #expect(result == .retryWithoutLaunch)
        #expect(model.client != nil)
        #expect(model.engineIdentity?.sha == DaemonHandshakeURLProtocol.engine.sha)
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func stalePollBeforeStopAdmissionCannotLaunchOrPublish() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let gate = SuspendedReconciliationEffect()
        daemon.busyGate = gate
        let model = appModel(daemon)
        model.connectionGeneration = 1
        model.engineIdentity = DaemonHandshakeURLProtocol.engine

        let task = Task { @MainActor in
            await model.pollLocalConnection(generation: 1)
        }
        await gate.waitUntilEntered()
        model.connectionGeneration = 2
        await gate.release()

        #expect(await task.value == .superseded)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
        #expect(model.engineIdentity?.sha == old.buildSha)
    }

    @MainActor
    @Test func delayedInitialHandshakeCannotAdoptAfterManualReconnect() async {
        let gate = ReconciliationHandshakeGate()
        DaemonHandshakeURLProtocol.gate = gate
        defer { DaemonHandshakeURLProtocol.gate = nil }
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = old
        let model = appModel(daemon)
        model.connectionGeneration = 1
        let oldCandidate = try! #require(model.client)
        let successor = appModel(ReconciliationDaemonStub()).client!

        let task = Task { @MainActor in
            await model.tryConnect(
                candidate: oldCandidate, endpoint: "127.0.0.1:old", generation: 1)
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !gate.hasEntered, ContinuousClock.now < deadline { await Task.yield() }
        #expect(gate.hasEntered)
        model.connectionGeneration = 2
        model.adoptClientForReconnect(successor)
        model.endpoint = "127.0.0.1:new"
        model.health = .connected
        model.engineIdentity = EngineBuildIdentity(
            version: target.version, sha: target.buildSha, entry: "/new/daemon.js")
        gate.release()

        #expect(await task.value == .superseded)
        #expect(model.client === successor)
        #expect(model.endpoint == "127.0.0.1:new")
        #expect(model.health == .connected)
        #expect(model.engineIdentity?.sha == target.buildSha)
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func admittedPollRecoveryFinishesButStaleCallerPublishesNothing() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let gate = SuspendedReconciliationEffect()
        daemon.stopGate = gate
        let model = appModel(daemon)
        model.connectionGeneration = 1
        model.engineIdentity = DaemonHandshakeURLProtocol.engine

        let task = Task { @MainActor in
            await model.pollLocalConnection(generation: 1)
        }
        await gate.waitUntilEntered()
        model.connectionGeneration = 2
        await gate.release()

        #expect(await task.value == .superseded)
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
        #expect(model.engineIdentity?.sha == old.buildSha)
    }

    @MainActor
    @Test func appPollSkipsLifecycleWhileRuntimeInstallOwnsIt() async {
        DaemonHandshakeURLProtocol.engine = EngineBuildIdentity(
            version: old.version, sha: old.buildSha, entry: "/old/daemon.js")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        let model = appModel(daemon)
        let lease = try! #require(
            model.localRuntimeLifecycleOwner.claim(.installation).lease)
        defer { model.localRuntimeLifecycleOwner.release(lease) }
        model.runtimeInstalling = true
        model.runtimeInstallStatus = "Installing…"

        #expect(await model.pollEngineIdentity())

        #expect(model.engineIdentity?.sha == old.buildSha)
        #expect(model.runtimeInstallStatus == "Installing…")
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }
}
