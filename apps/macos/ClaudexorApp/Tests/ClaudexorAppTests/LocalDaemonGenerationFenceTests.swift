import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

actor SuspendedReconciliationEffect {
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

private actor ReconciliationGenerationValidity {
    private var current = true

    func isCurrent() -> Bool { current }
    func supersede() { current = false }
}

private enum GenerationFenceTestError: Error { case unexpectedRequest }

private final class GenerationFenceCallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.withLock { value += 1 } }
    var count: Int { lock.withLock { value } }
}

private final class GenerationFenceURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler:
        ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw GenerationFenceTestError.unexpectedRequest
            }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class LostCompletionHandshakeGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var entered = false
    private var released = false

    var hasEntered: Bool { condition.withLock { entered } }

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

/// Production-shaped unavailable handshake: the first `/v2/handshake` can be
/// held across another lifecycle completion, then every attempt fails through
/// the real `GatewayClient`/`AppModel.tryConnect` path.
private final class LostCompletionURLProtocol: URLProtocol {
    private static let stateLock = NSLock()
    nonisolated(unsafe) private static var firstHandshakeGate:
        LostCompletionHandshakeGate?
    nonisolated(unsafe) private static var handshakeAttempts = 0

    static func reset(gate: LostCompletionHandshakeGate?) {
        stateLock.withLock {
            firstHandshakeGate = gate
            handshakeAttempts = 0
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        switch request.url?.path {
        case "/healthz":
            respond(status: 200, body: #"{"ok":true}"#)
        case "/v2/handshake":
            let (attempt, gate) = Self.stateLock.withLock {
                Self.handshakeAttempts += 1
                return (Self.handshakeAttempts, Self.firstHandshakeGate)
            }
            if attempt == 1 { gate?.block() }
            respond(status: 503, body: #"{"error":"booting"}"#)
        default:
            client?.urlProtocol(self, didFailWithError: GenerationFenceTestError.unexpectedRequest)
        }
    }

    override func stopLoading() {}

    private func respond(status: Int, body: String) {
        let response = generationFenceResponse(request, status: status)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
private final class LostCompletionRecoveryHarness {
    let model: AppModel
    let candidate: GatewayClient
    private(set) var probeCount = 0
    private(set) var fallbackStartsAtProbe: [Int] = []
    private(set) var pauseCount = 0

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LostCompletionURLProtocol.self]
        candidate = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:41180")!, token: "test",
            session: URLSession(configuration: config))
        model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.connectionGeneration = 1
    }

    var owner: LocalRuntimeLifecycleOwner { model.localRuntimeLifecycleOwner }

    func run() async {
        let loop = LocalConnectionRecoveryLoop(
            generation: 1,
            currentGeneration: { self.model.connectionGeneration },
            lifecycleOwner: owner,
            prepareProbe: {},
            probe: {
                self.probeCount += 1
                return await self.model.tryConnect(
                    candidate: self.candidate,
                    endpoint: "127.0.0.1:41180",
                    generation: 1)
            },
            // Production shape: re-observation is another real handshake.
            engineAnswers: { (try? await self.candidate.handshake())?.ok == true },
            pollConnected: { .unavailable },
            startDaemon: { _ in
                self.fallbackStartsAtProbe.append(self.probeCount)
                return true
            },
            enterOffline: {},
            pause: {
                self.pauseCount += 1
                if self.pauseCount == 2 { self.model.connectionGeneration = 2 }
                await Task.yield()
            })
        await loop.run()
    }
}

private func generationFenceGateway(port: Int) -> GatewayClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [GenerationFenceURLProtocol.self]
    return GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: "test",
        session: URLSession(configuration: config))
}

private func generationFenceResponse(
    _ request: URLRequest,
    status: Int = 200
) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
}

@MainActor
private func waitForGenerationFence(
    _ counter: GenerationFenceCallCounter,
    message: String
) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while counter.count == 0, ContinuousClock.now < deadline { await Task.yield() }
    try #require(counter.count > 0, Comment(rawValue: message))
}

@MainActor
private func waitForLostCompletionHandshake(
    _ gate: LostCompletionHandshakeGate
) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !gate.hasEntered, ContinuousClock.now < deadline { await Task.yield() }
    try #require(gate.hasEntered, "unavailable handshake never suspended")
}

@MainActor
private func seedSuccessorProjections(_ model: AppModel) throws {
    let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"new-thread","title":"New","repoRoot":"/tmp/new","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-08-13T00:00:00Z","updatedAt":"2026-08-13T00:00:00Z"}"#.utf8))
    let project = try JSONDecoder().decode(RegisteredProject.self, from: Data(#"{"schemaVersion":1,"id":"new-project","root":"/tmp/new","createdAt":"2026-08-13T00:00:00Z","updatedAt":"2026-08-13T00:00:00Z","nesting":[]}"#.utf8))
    let secret = try JSONDecoder().decode(SecretInfo.self, from: Data(#"{"name":"new-secret","backend":"keychain","present":true}"#.utf8))
    model.threads = [thread]
    model.registeredProjects = [project]
    model.secretBackend = "keychain"
    model.storedSecrets = [secret]
}

@Suite(.serialized) struct LocalDaemonGenerationFenceTests {
    private let script = URL(fileURLWithPath: "/selected/claudexord.bundle.cjs")
    private let old = RuntimeClosureIdentity(
        version: "3.1.2", buildSha: String(repeating: "a", count: 40))
    private let target = RuntimeClosureIdentity(
        version: "3.2.0", buildSha: String(repeating: "b", count: 40))

    private func reconciler(_ daemon: ReconciliationDaemonStub) -> LocalDaemonReconciler {
        daemon.servingIdentity = old
        return LocalDaemonReconciler(
            daemon: daemon,
            lifecycleOwner: LocalRuntimeLifecycleOwner(),
            targetClosure: {
                LocalRuntimeClosureSelection(
                    scriptURL: script, authority: .bundledStampedProbe)
            },
            handshakePollInterval: 0.001,
            handshakePollTimeout: 0.1)
    }

    @Test func supersededGenerationBeforeStopAdmissionPerformsNoLifecycleMutation() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let gate = SuspendedReconciliationEffect()
        daemon.busyGate = gate
        let validity = ReconciliationGenerationValidity()

        let task = Task {
            await reconciler(daemon).reconcile(
                serving: old, isCurrent: { await validity.isCurrent() })
        }
        await gate.waitUntilEntered()
        await validity.supersede()
        await gate.release()

        #expect(await task.value == .supersededBeforeLifecycle)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func admittedStopFinishesExactRecoveryAfterGenerationIsSuperseded() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let gate = SuspendedReconciliationEffect()
        daemon.stopGate = gate
        let validity = ReconciliationGenerationValidity()

        let task = Task {
            await reconciler(daemon).reconcile(
                serving: old, isCurrent: { await validity.isCurrent() })
        }
        await gate.waitUntilEntered()
        await validity.supersede()
        await gate.release()

        #expect(await task.value == .replaced(target))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func currentGenerationRetriesAfterCoalescedPreStopSupersession() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let gate = SuspendedReconciliationEffect()
        daemon.busyGate = gate
        let validity = ReconciliationGenerationValidity()
        let sut = reconciler(daemon)

        let oldTask = Task {
            await sut.reconcile(
                serving: old, isCurrent: { await validity.isCurrent() })
        }
        await gate.waitUntilEntered()
        let currentTask = Task {
            await sut.reconcile(serving: old, isCurrent: { true })
        }
        await Task.yield()
        await validity.supersede()
        await gate.release()

        #expect(await oldTask.value == .supersededBeforeLifecycle)
        #expect(await currentTask.value == .supersededBeforeLifecycle)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)

        daemon.busyGate = nil
        #expect(await sut.reconcile(serving: old) == .replaced(target))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @Test func currentGenerationCoalescesWithCommittedReplacementWithoutSecondStart() async {
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.runningIdentity = target
        let gate = SuspendedReconciliationEffect()
        daemon.stopGate = gate
        let sut = reconciler(daemon)

        let oldTask = Task { await sut.reconcile(serving: old) }
        await gate.waitUntilEntered()
        let currentTask = Task { await sut.reconcile(serving: old) }
        await Task.yield()
        await gate.release()

        #expect(await oldTask.value == .replaced(target))
        #expect(await currentTask.value == .replaced(target))
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
    }

    @MainActor
    @Test func unavailableHandshakeCannotDuplicateACompletedReconciliationLaunch() async throws {
        let handshakeGate = LostCompletionHandshakeGate()
        LostCompletionURLProtocol.reset(gate: handshakeGate)
        defer {
            handshakeGate.release()
            LostCompletionURLProtocol.reset(gate: nil)
        }
        let recovery = LostCompletionRecoveryHarness()
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = target
        daemon.servingIdentity = old
        daemon.runningIdentity = target
        let stopGate = SuspendedReconciliationEffect()
        daemon.stopGate = stopGate
        let reconciler = LocalDaemonReconciler(
            daemon: daemon,
            lifecycleOwner: recovery.owner,
            targetClosure: {
                LocalRuntimeClosureSelection(
                    scriptURL: self.script, authority: .bundledStampedProbe)
            },
            handshakePollInterval: 0.001,
            handshakePollTimeout: 0.1)

        let reconciliation = Task { await reconciler.reconcile(serving: old) }
        await stopGate.waitUntilEntered()
        let recoveryTask = Task { @MainActor in await recovery.run() }
        try await waitForLostCompletionHandshake(handshakeGate)

        await stopGate.release()
        #expect(await reconciliation.value == .replaced(target))
        #expect(daemon.starts == 1)
        #expect(recovery.fallbackStartsAtProbe.isEmpty)

        handshakeGate.release()
        await recoveryTask.value

        // The stale first handshake cannot launch. The still-live allowance is
        // consumed only after the next independent unavailable handshake.
        #expect(recovery.probeCount == 2)
        #expect(recovery.fallbackStartsAtProbe == [2])
        #expect(recovery.pauseCount == 2)
        #expect(daemon.starts == 1)
    }

    @MainActor
    @Test func unavailableHandshakeCannotDuplicateACompletedInstallationLifecycle() async throws {
        let handshakeGate = LostCompletionHandshakeGate()
        LostCompletionURLProtocol.reset(gate: handshakeGate)
        defer {
            handshakeGate.release()
            LostCompletionURLProtocol.reset(gate: nil)
        }
        let recovery = LostCompletionRecoveryHarness()
        let installation = try #require(recovery.owner.claim(.installation).lease)
        let recoveryTask = Task { @MainActor in await recovery.run() }
        try await waitForLostCompletionHandshake(handshakeGate)

        recovery.owner.release(installation)
        #expect(recovery.fallbackStartsAtProbe.isEmpty)
        handshakeGate.release()
        await recoveryTask.value

        #expect(recovery.probeCount == 2)
        #expect(recovery.fallbackStartsAtProbe == [2])
        #expect(recovery.pauseCount == 2)
    }

    @MainActor
    @Test func delayedOldHydrationSuccessCannotOverwriteNewConnectionProjections() async throws {
        defer { GenerationFenceURLProtocol.handler = nil }
        let model = AppModel(
            client: generationFenceGateway(port: 41160), requestNotificationAuthorization: false)
        model.connectionGeneration = 1
        try seedSuccessorProjections(model)

        for (index, path) in ["/v2/secrets", "/v2/threads", "/v2/projects"].enumerated() {
            let arrived = GenerationFenceCallCounter()
            GenerationFenceURLProtocol.handler = { request in
                guard request.url?.path == path else {
                    throw GenerationFenceTestError.unexpectedRequest
                }
                arrived.increment()
                Thread.sleep(forTimeInterval: 0.12)
                let body: String = switch path {
                case "/v2/secrets": #"{"backend":"file","secrets":[]}"#
                case "/v2/threads": #"{"threads":[]}"#
                default: #"{"projects":[]}"#
                }
                return (generationFenceResponse(request), Data(body.utf8))
            }
            let request: Task<Void, Never> = switch path {
            case "/v2/secrets": Task { await model.refreshSecrets() }
            case "/v2/threads": Task { _ = await model.refreshThreads() }
            default: Task { _ = await model.refreshProjects() }
            }
            try await waitForGenerationFence(
                arrived, message: "old hydration success never started")
            model.connectionGeneration += 1
            model.adoptClientForReconnect(generationFenceGateway(port: 41161 + index))
            await request.value
        }

        #expect(model.secretBackend == "keychain")
        #expect(model.storedSecrets.map(\.name) == ["new-secret"])
        #expect(model.threads.map(\.id) == ["new-thread"])
        #expect(model.registeredProjects.map(\.id) == ["new-project"])
    }

    @MainActor
    @Test func delayedOldHydrationFailureCannotClearNewConnectionProjections() async throws {
        defer { GenerationFenceURLProtocol.handler = nil }
        let model = AppModel(
            client: generationFenceGateway(port: 41164), requestNotificationAuthorization: false)
        model.connectionGeneration = 1
        try seedSuccessorProjections(model)
        model.threadStatus = "new status"

        for (index, path) in ["/v2/secrets", "/v2/threads", "/v2/projects"].enumerated() {
            let arrived = GenerationFenceCallCounter()
            GenerationFenceURLProtocol.handler = { request in
                guard request.url?.path == path else {
                    throw GenerationFenceTestError.unexpectedRequest
                }
                arrived.increment()
                Thread.sleep(forTimeInterval: 0.12)
                return (generationFenceResponse(request, status: 503), Data("{}".utf8))
            }
            let request: Task<Void, Never> = switch path {
            case "/v2/secrets": Task { await model.refreshSecrets() }
            case "/v2/threads": Task { _ = await model.refreshThreads() }
            default: Task { _ = await model.refreshProjects() }
            }
            try await waitForGenerationFence(
                arrived, message: "old hydration failure never started")
            model.connectionGeneration += 1
            model.adoptClientForReconnect(generationFenceGateway(port: 41165 + index))
            await request.value
        }

        #expect(model.secretBackend == "keychain")
        #expect(model.storedSecrets.map(\.name) == ["new-secret"])
        #expect(model.threads.map(\.id) == ["new-thread"])
        #expect(model.threadStatus == "new status")
        #expect(model.registeredProjects.map(\.id) == ["new-project"])
    }

    @MainActor
    @Test func generationChangeMidConnectStopsAllLaterHydrationAndStreamAdmission() async throws {
        defer { GenerationFenceURLProtocol.handler = nil }
        let candidate = generationFenceGateway(port: 41170)
        let successor = generationFenceGateway(port: 41171)
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.connectionGeneration = 1
        model.localDaemonReconciler = LocalDaemonReconciler(
            daemon: AppRuntimeDaemonControl(isBusyProbe: { nil }),
            lifecycleOwner: model.localRuntimeLifecycleOwner,
            targetClosure: { nil })
        let calls = GenerationFenceCallCounter()
        let runsArrived = GenerationFenceCallCounter()
        let releaseRuns = DispatchSemaphore(value: 0)
        defer { releaseRuns.signal() }
        GenerationFenceURLProtocol.handler = { request in
            calls.increment()
            switch request.url?.path {
            case "/healthz":
                return (generationFenceResponse(request), Data(#"{"ok":true}"#.utf8))
            case "/v2/handshake":
                return (generationFenceResponse(request), Data(#"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"3.3.15","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entry":"/candidate/daemon.js"}}"#.utf8))
            case "/v2/runs":
                runsArrived.increment()
                releaseRuns.wait()
                return (generationFenceResponse(request), Data(#"{"runs":[]}"#.utf8))
            default:
                throw GenerationFenceTestError.unexpectedRequest
            }
        }

        let task = Task { @MainActor in
            await model.tryConnect(
                candidate: candidate, endpoint: "127.0.0.1:41170", generation: 1)
        }
        try await waitForGenerationFence(
            runsArrived, message: "connect hydration never reached runs")
        model.connectionGeneration = 2
        model.adoptClientForReconnect(successor)
        model.endpoint = "127.0.0.1:41171"
        model.health = .connecting
        releaseRuns.signal()

        #expect(await task.value == .superseded)
        #expect(model.client === successor)
        #expect(model.endpoint == "127.0.0.1:41171")
        #expect(model.health == .connecting)
        #expect(model.globalStreamTask == nil)
        #expect(calls.count == 3)
    }
}
