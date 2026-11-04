import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

// Real Foundation over real loopback HTTP/1.1 (promoted from the e5e19b44 H1
// probe and its unrun H1xH2 compound). Long-lived event streams must never hold
// the connections ordinary requests need, and a thread switch reads its history
// while those streams stay open and an unrelated run-list read is still slow.
// The stream count is the request session's own per-host connection limit —
// the exact capacity that used to starve requests — read, never assumed.

@MainActor private final class FrameTally {
    var frames: [String: Int] = [:]
}

@MainActor @Suite(.serialized)
struct StreamTransportIsolationTests {
    private func capacity(of session: URLSession) throws -> Int {
        let limit = session.configuration.httpMaximumConnectionsPerHost
        try #require((1...64).contains(limit), "unexpected per-host connection limit \(limit)")
        return limit
    }

    private func until(_ what: String, _ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !predicate() {
            try #require(ContinuousClock.now < deadline, "timed out waiting for \(what)")
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    @Test func ordinaryRequestsDoNotQueueBehindPoolCapacityStreams() async throws {
        let token = UUID().uuidString
        let server = try LoopbackControlServer(token: token, routes: [
            "/v2/runs": .init(body: Data(#"{"runs":[]}"#.utf8)),
        ])
        let base = try await server.start()
        defer { server.stop() }
        let session = URLSession(configuration: .ephemeral)
        let streams = try capacity(of: session)
        let client = GatewayClient(baseURL: base, token: token, session: session)
        let tally = FrameTally()
        let consumers = (0..<streams).map { index in
            Task { @MainActor in
                for try await _ in client.events(runId: "run-\(index)") { tally.frames["run-\(index)", default: 0] += 1 }
            }
        }
        defer { consumers.forEach { $0.cancel() } }
        try await until("\(streams) open streams") { server.openStreamPaths.count == streams }

        let listed = Task { try await client.listRuns() }
        try await until("the run-list request to reach the server") {
            server.requests.contains { $0.path == "/v2/runs" }
        }
        #expect(try await listed.value.isEmpty)
        let arrival = try #require(server.requests.first { $0.path == "/v2/runs" })
        #expect(arrival.openStreams == streams)
        #expect(server.openStreamPaths.count == streams)

        // The streams are still alive and delivering after the request.
        server.pushRunFrame(id: 1)
        try await until("a frame on every stream") { tally.frames.count == streams }
        // Cancellation still closes each stream connection at its owner.
        consumers.forEach { $0.cancel() }
        try await until("every stream closed") { server.openStreamPaths.isEmpty }
        #expect(server.unauthorizedRequests == 0)
    }

    @Test func threadSwitchReadsHistoryWhileStreamsHoldThePoolAndRunsAreSlow() async throws {
        let token = UUID().uuidString
        let source = try HistoryTestSource(count: 3)
        let threadB = source.detail.thread.id
        let session = URLSession(configuration: .ephemeral)
        let streams = try capacity(of: session)
        try #require(streams >= 2, "compound fixture needs another live run beside the global stream")
        let others = (0..<(streams - 1)).map { "run-other-\($0)" }
        let runList = others.map { #"{"runId":"\#($0)","state":"running","mode":"agent"}"# }
        let server = try LoopbackControlServer(token: token, routes: [
            "/v2/runs": .init(body: Data(#"{"runs":[\#(runList.joined(separator: ","))]}"#.utf8),
                              held: true),
            "/v2/threads/\(threadB)/history": .init(body: try JSONEncoder().encode(source.page(nil))),
        ])
        let base = try await server.start()
        defer { server.stop() }
        let client = GatewayClient(baseURL: base, token: token, session: session)
        let model = AppModel(client: client, requestNotificationAuthorization: false, loadPersistedState: false)
        defer { model.cancelAllStreams() }
        // Live runs of OTHER threads through the production stream owners: one
        // global journal stream plus a per-run stream each — pool capacity.
        model.liveTasks = others.map(liveRunInAnotherThread)
        model.startGlobalStream()
        for id in others { model.stream(runId: id) }
        try await until("\(streams) open streams") { server.openStreamPaths.count == streams }
        model.selectedThreadId = "thread-previous"
        model.selectedHistory = model.makeHistoryStore(locationID: .local, id: "thread-previous")

        let switched = Task { await model.openThread(threadB) }
        let beforeRelease: Result<Void, Error>
        do {
            // These independent reads may arrive in either order. Observe both
            // before releasing /runs; history must already be installed.
            try await until("history installed while run-list response is held") {
                model.selectedHistory?.state == .ready
                    && server.requests.contains { $0.path == "/v2/runs" }
            }
            #expect(model.selectedHistory?.rows.count == 3)
            #expect(server.answeredAt("/v2/runs") == nil, "history waited for the unrelated run list")
            let history = try #require(server.requests.first { $0.path == "/v2/threads/\(threadB)/history" })
            #expect(history.openStreams == streams)
            let runListRequest = try #require(server.requests.first { $0.path == "/v2/runs" })
            #expect(runListRequest.openStreams == streams)
            #expect(model.runListReconciliationNeeded)
            beforeRelease = .success(())
        } catch {
            // Also drain the real requests on a failed assertion/timeout path.
            switched.cancel()
            model.cancelAllStreams()
            beforeRelease = .failure(error)
        }
        server.release("/v2/runs")
        await switched.value
        try beforeRelease.get()
        #expect(server.answeredAt("/v2/runs") != nil)
        #expect(!model.runListReconciliationNeeded)
        #expect(model.selectedThreadId == threadB)
        // The switch neither closed nor restricted any stream.
        #expect(server.openStreamPaths.count == streams)
        #expect(Set(model.streamTasks.keys) == Set(others))
        #expect(Set(model.liveTasks.map(\.id)) == Set(others))
        #expect(server.unauthorizedRequests == 0)
        model.cancelAllStreams()
        try await until("every stream closed by its owner") { server.openStreamPaths.isEmpty }
    }

    /// The client owns its stream pool: a live stream keeps it alive after the
    /// caller lets go, cancelling the stream releases it, and its release never
    /// invalidates the session the caller injected.
    @Test func aLiveStreamOwnsItsClientAndTheCallersSessionOutlivesIt() async throws {
        let token = UUID().uuidString
        let server = try LoopbackControlServer(token: token, routes: [
            "/v2/runs": .init(body: Data(#"{"runs":[]}"#.utf8)),
        ])
        let base = try await server.start()
        defer { server.stop() }
        let session = URLSession(configuration: .ephemeral)
        let tally = FrameTally()
        weak var released: GatewayClient?
        var consumer: Task<Void, Error>?
        do {
            let client = GatewayClient(baseURL: base, token: token, session: session)
            released = client
            let stream = client.events(runId: "run-owned")
            consumer = Task { @MainActor in
                for try await _ in stream { tally.frames["run-owned", default: 0] += 1 }
            }
        }
        try await until("the stream to open") { server.openStreamPaths.count == 1 }
        #expect(released != nil) // only the live stream still holds the client
        server.pushRunFrame(id: 1)
        try await until("a frame after the caller let go") { tally.frames["run-owned"] == 1 }
        consumer?.cancel()
        try await until("the stream to close") { server.openStreamPaths.isEmpty }
        try await until("the client to be released") { released == nil }
        let next = GatewayClient(baseURL: base, token: token, session: session)
        #expect(try await next.listRuns().isEmpty)
    }

    /// The production reconnect fence closes the old endpoint's streams at
    /// their owner; the adopted client opens its own pool, authenticates with
    /// its own token, and nothing late reaches the retired endpoint.
    @Test func endpointChangeRetiresTheOldStreamsAndServesTheNewEndpoint() async throws {
        let tokenA = UUID().uuidString, tokenB = UUID().uuidString
        let session = URLSession(configuration: .ephemeral)
        let streams = try capacity(of: session)
        let oldRuns = (0..<(streams - 1)).map { "run-a-\($0)" }
        let newRuns = (0..<(streams - 1)).map { "run-b-\($0)" }
        func runList(_ ids: [String]) -> Data {
            Data(#"{"runs":[\#(ids.map { #"{"runId":"\#($0)","state":"running","mode":"agent"}"# }.joined(separator: ","))]}"#.utf8)
        }
        let serverA = try LoopbackControlServer(token: tokenA, routes: ["/v2/runs": .init(body: runList(oldRuns))])
        let serverB = try LoopbackControlServer(token: tokenB, routes: ["/v2/runs": .init(body: runList(newRuns))])
        let baseA = try await serverA.start(), baseB = try await serverB.start()
        defer { serverA.stop(); serverB.stop() }
        let model = AppModel(client: GatewayClient(baseURL: baseA, token: tokenA, session: session),
                             requestNotificationAuthorization: false, loadPersistedState: false)
        defer { model.cancelAllStreams() }
        model.liveTasks = oldRuns.map(liveRunInAnotherThread)
        model.startGlobalStream()
        for id in oldRuns { model.stream(runId: id) }
        try await until("old endpoint streams") { serverA.openStreamPaths.count == streams }

        model.enterHardOffline()
        try await until("old streams closed at their owner") { serverA.openStreamPaths.isEmpty }
        let retiredRequests = serverA.requests.count
        model.adoptClientForReconnect(GatewayClient(baseURL: baseB, token: tokenB, session: session))
        model.startGlobalStream()
        await model.refreshRuns() // adopts the new engine's active runs and streams each
        try await until("new endpoint streams") { serverB.openStreamPaths.count == streams }
        let listed = Task { await model.refreshRuns() }
        try await until("a run list on the new endpoint while its streams are open") {
            serverB.requests.filter { $0.path == "/v2/runs" }.count == 2
        }
        await listed.value
        let list = try #require(serverB.requests.last { $0.path == "/v2/runs" })
        #expect(list.openStreams == streams)
        #expect(Set(model.streamTasks.keys) == Set(newRuns))
        #expect(serverA.requests.count == retiredRequests)
        #expect(serverA.unauthorizedRequests == 0 && serverB.unauthorizedRequests == 0)
    }

    /// The remote consumers (forwarded engine, default request session) hold
    /// their streams in the remote client's own pool: the remote history read
    /// is not queued behind them.
    @Test func remoteHistoryIsReadWhileRemoteStreamsHoldTheirPool() async throws {
        let token = UUID().uuidString
        let source = try HistoryTestSource(count: 3)
        let threadID = source.detail.thread.id
        let server = try LoopbackControlServer(token: token, routes: [
            "/v2/threads/\(threadID)/history": .init(body: try JSONEncoder().encode(source.page(nil))),
        ])
        let base = try await server.start()
        defer { server.stop() }
        let streams = try capacity(of: URLSession.shared)
        let location = ExecutionLocationID.remote(UUID())
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        model.remoteClients[location] = GatewayClient(baseURL: base, token: token) // the remote forward's form
        defer { model.cancelRemoteStreams(location) }
        model.startRemoteGlobalStream(location)
        for index in 0..<(streams - 1) {
            model.streamRemoteRun(locationID: location, runID: "remote-run-\(index)", threadID: "remote-other")
        }
        try await until("remote streams") { server.openStreamPaths.count == streams }
        let opened = Task { await model.openThread(locationID: location, id: threadID) }
        try await until("the remote history to install") {
            model.selectedHistory?.locationID == location && model.selectedHistory?.state == .ready
        }
        await opened.value
        #expect(model.selectedHistory?.rows.count == 3)
        let history = try #require(server.requests.first { $0.path.hasSuffix("/history") })
        #expect(history.openStreams == streams)
        #expect(server.openStreamPaths.count == streams)
        model.cancelRemoteStreams(location)
        try await until("remote streams closed by their owner") { server.openStreamPaths.isEmpty }
        #expect(server.unauthorizedRequests == 0)
    }
}
