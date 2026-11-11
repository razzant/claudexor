import ClaudexorKit
import Foundation
import CryptoKit
import Testing
@testable import ClaudexorApp

@Suite(.serialized) struct HistoryGatewayTests {}
typealias ThreadHistoryIntegrationTests = HistoryGatewayTests.ThreadHistoryIntegrationTests

extension HistoryGatewayTests {
@MainActor @Suite(.serialized)
struct ThreadHistoryIntegrationTests {
    @Test(arguments: [ExecutionLocationID.local, ExecutionLocationID.remote(UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!)], ["running", "terminal-empty", "terminal-older"])
    func terminalPublicationDuringTrailingReplayWinsWithoutThirdGET(location: ExecutionLocationID, stale: String) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        source.runs[0].answerText = nil
        let (model, client) = makeModel(location)
        if location == .local { model.liveTasks = source.runs }
        else { model.remoteTasks[location] = source.runs }
        model.selectedThreadId = source.detail.thread.id
        let store = model.makeHistoryStore(locationID: location, id: source.detail.thread.id)
        // Drive the terminal reader explicitly: no streaming socket is needed
        // to order the real local/remote run-detail and GatewayClient paths.
        store.didReadHeader = nil
        model.selectedHistory = store
        let initial = try source.page(nil)
        store.install([initial], ids: initial.turns.map(\.id), reset: true, serial: 0)
        var gets = 0
        var runGets = 0
        let lead = HistoryReadGate(), tail = HistoryReadGate()
        HistoryURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/history") == true {
                gets += 1
                if gets == 2 && stale != "running" {
                    source.runs[0].phase = .succeeded
                    source.runs[0].answerText = stale == "terminal-older" ? "older terminal output" : nil
                }
                let snapshot = try source.page(.cursor("replay:0:1"))
                if gets == 1 { await lead.wait() } else { await tail.wait() }
                return (200, try JSONEncoder().encode(snapshot))
            }
            if request.url?.path == "/v2/runs/mock-run-0" {
                runGets += 1
                return (200, Data(#"{"summary":{"runId":"mock-run-0","state":"succeeded","mode":"agent","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"terminal answer published during trailing replay","truncated":false},"lastSeq":7}"#.utf8))
            }
            throw URLError(.badURL)
        }
        let first = Task { await store.refresh() }
        try await until { gets == 1 }
        let second = Task { await store.refresh() }
        try await until { store.trailing }
        lead.release()
        try await until { gets == 2 }
        let ignored = Task { await store.refresh() }
        #expect(model.gateway(for: location) === client)
        _ = await model.loadRunDetail("mock-run-0", locationID: location)
        let text = "terminal answer published during trailing replay"
        #expect(store.renderedRun(for: store.rows[0], live: model.task("mock-run-0", at: location))?.answerText == text)
        tail.release()
        await first.value; await second.value; await ignored.value
        #expect(gets == 2 && runGets == 1)
        #expect(store.renderedRun(for: store.rows[0], live: model.task("mock-run-0", at: location))?.answerText == text)
        #expect(store.refreshTask == nil && !store.trailing)
    }

    @Test func workspaceReadIsOnDemandAndIndependentOfHistoryRefresh() async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 30)
        let (model, _) = makeModel(.local)
        var historyGets = 0, workspaceGets = 0, runGets = 0
        HistoryURLProtocol.handler = { request in
            let path = request.url!.path
            if path.hasSuffix("/history") { historyGets += 1; return (200, try JSONEncoder().encode(source.page(nil))) }
            if path == "/v2/threads/\(source.detail.thread.id)" {
                workspaceGets += 1; return (200, try JSONEncoder().encode(source.detail))
            }
            runGets += 1
            throw URLError(.badURL)
        }
        await model.openThread(source.detail.thread.id)
        #expect(model.selectedHistory?.rows.count == 20 && model.selectedThreadDetail == nil)
        await model.loadWorkspaceHistory()
        #expect(workspaceGets == 0 && runGets == 0)
        await model.refreshOpenThread(locationID: .local, id: source.detail.thread.id)
        #expect(historyGets == 2 && workspaceGets == 0)
        model.workspaceHistoryVisible = true
        await model.loadWorkspaceHistory()
        #expect(workspaceGets == 1 && model.selectedThreadDetail?.turns.count == 30)
        await model.selectedHistory?.refresh()
        #expect(workspaceGets == 1 && runGets == 0)
    }

    @Test func fullPromptChunksAreOnlyRequestedByAnExplicitAction() async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        let (model, _) = makeModel(.local)
        let prompt = String(repeating: "é", count: 20_000)
        var offsets: [Int] = []
        HistoryURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/history") { return (200, try JSONEncoder().encode(source.page(nil))) }
            if request.url!.path.hasSuffix("/prompt") {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                let offset = Int(query.first { $0.name == "offset" }!.value!)!
                offsets.append(offset)
                let count = min(32_768, prompt.utf8.count - offset)
                let text = String(decoding: Array(prompt.utf8)[offset..<(offset + count)], as: UTF8.self)
                return (200, try JSONSerialization.data(withJSONObject: ["threadId": source.detail.thread.id,
                    "turnId": "mock-turn-0", "totalBytes": prompt.utf8.count, "sha256": SHA256.hash(data: Data(prompt.utf8)).map { String(format: "%02x", $0) }.joined(),
                    "offset": offset, "nextOffset": offset + count, "text": text]))
            }
            throw URLError(.badURL)
        }
        await model.openThread(source.detail.thread.id)
        await model.selectedHistory?.refresh()
        #expect(offsets.isEmpty)
        let full = try await model.fullHistoryPrompt(turnID: "mock-turn-0", locationID: .local, threadID: source.detail.thread.id)
        #expect(full == prompt && offsets == [0, 32_768])
    }

    @Test func composerUsesTheHeaderWhileReadingOldTurnsAndPrunedHeadIsHonest() async throws {
        let source = try HistoryTestSource(count: 55)
        source.runs[54].phase = .running
        let (model, _) = makeModel(.local)
        let store = try source.store(loaded: true)
        model.selectedHistory = store; model.selectedThreadId = source.detail.thread.id
        await store.earlier(retaining: 2)
        #expect(!store.mountedIDs.contains("mock-turn-54"))
        #expect(model.selectedHeadRunId == "mock-run-54" && model.composerTurnState != .idle)
        source.transform = { json in
            var header = json["header"] as! [String: Any]
            header["headRunStatus"] = "not_retained"; header["headRun"] = NSNull()
            json["header"] = header
        }
        await store.refresh()
        #expect(model.composerTurnState == .idle)
    }

    func makeModel(_ location: ExecutionLocationID) -> (AppModel, GatewayClient) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HistoryURLProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://history.invalid")!, token: "fixture", session: URLSession(configuration: config))
        let model = AppModel(client: location == .local ? client : nil,
            requestNotificationAuthorization: false, loadPersistedState: false)
        model.selectedExecutionLocation = location
        if location != .local { model.remoteClients[location] = client }
        return (model, client)
    }

    func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<2_000 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        throw URLError(.timedOut)
    }
}

}

@MainActor private final class HistoryReadGate {
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { continuation = $0 } }
    func release() { continuation?.resume(); continuation = nil }
}

final class HistoryURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@MainActor (URLRequest) async throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let owner = HistoryProtocolOwner(self)
        let request = request
        Task { @MainActor in
            do {
                guard let handler = Self.handler else { throw URLError(.badURL) }
                let (status, data) = try await handler(request)
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"])!
                owner.value.client?.urlProtocol(owner.value, didReceive: response, cacheStoragePolicy: .notAllowed)
                owner.value.client?.urlProtocol(owner.value, didLoad: data)
                owner.value.client?.urlProtocolDidFinishLoading(owner.value)
            } catch { owner.value.client?.urlProtocol(owner.value, didFailWithError: error) }
        }
    }
    override func stopLoading() {}
}

// URLProtocol callbacks may arrive on any transport queue. The box moves only
// that callback handle; test routing and gates remain serialized on MainActor.
private final class HistoryProtocolOwner: @unchecked Sendable {
    let value: HistoryURLProtocol
    init(_ value: HistoryURLProtocol) { self.value = value }
}
