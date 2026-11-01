import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// #563 (owner decision: the same preparation fact for SSH): a remote run's
/// `workspace.prepared` receipt reaches its own turn card through the remote
/// stream handler and the remote run-detail load, keyed by location and run id.
/// A local run and two remote runs sharing one run id never see each other's
/// transcript. Synthetic consumer qualification only: no remote machine.
@MainActor @Suite(.serialized)
struct RemotePreparedReceiptTests {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let name: String
            let event: JSONValue
            let row: TimelineEvent
        }
        let cases: [Case]
    }

    private static func fixture(_ name: String) throws -> Fixture.Case {
        let url = try #require(
            Bundle.module.url(forResource: "workspace-prepared-parity", withExtension: "json"))
        let cases = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).cases
        return try #require(cases.first { $0.name == name })
    }

    private static let runId = "run-same"

    private static func task(phase: RunPhase = .running, project: String) -> TaskRun {
        var run = TaskRun(
            id: runId, title: project, prompt: "Create the output", mode: .agent, phase: phase,
            project: project, harnesses: [], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        run.answerText = nil
        return run
    }

    /// A local run and two remote runs, all with the same daemon run id.
    private static func model(phase: RunPhase = .running, client: GatewayClient? = nil)
        -> (AppModel, ExecutionLocationID, ExecutionLocationID)
    {
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        let first = ExecutionLocationID.remote(UUID())
        let second = ExecutionLocationID.remote(UUID())
        model.liveTasks = [task(phase: phase, project: "Local")]
        model.remoteTasks[first] = [task(phase: phase, project: "Remote one")]
        model.remoteTasks[second] = [task(phase: phase, project: "Remote two")]
        if let client {
            model.remoteClients[first] = client
            model.selectedExecutionLocation = first
            model.draftExecutionLocation = first
        }
        return (model, first, second)
    }

    private static func envelope(_ event: JSONValue, seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "workspace.prepared", event: event)
    }

    private static func message(_ text: String, seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text)]),
        ]))
    }

    private static func notices(_ model: AppModel, at location: ExecutionLocationID) -> [TranscriptNotice] {
        (model.transcript(runId, at: location)?.blocks ?? []).compactMap {
            if case .notice(_, let notice) = $0 { notice } else { nil }
        }
    }

    @Test func theRemoteStreamFoldsItsReceiptForItsOwnLocationOnly() throws {
        let missing = try Self.fixture("missing-only")
        let partial = try Self.fixture("partial")
        let (model, first, second) = Self.model()
        model.apply(Self.message("Local executor step", seq: 1), to: Self.runId)
        model.applyRemoteHistoryCardEvent(Self.envelope(missing.event, seq: 1), runID: Self.runId, at: first)
        model.applyRemoteHistoryCardEvent(Self.envelope(partial.event, seq: 4), runID: Self.runId, at: second)

        #expect(Self.notices(model, at: first).map(\.text) == [missing.row.detail])
        #expect(Self.notices(model, at: first).first?.warning == true)
        #expect(Self.notices(model, at: second).map(\.text) == [partial.row.detail])
        // The local run with the same id shows its own executor step, no receipt.
        let local = model.transcript(Self.runId, at: .local)?.blocks ?? []
        #expect(local.count == 1)
        #expect(TurnPresentation.hasExecutorActivity(blocks: local))
        #expect(Self.notices(model, at: .local).isEmpty)
        // A remote location never shows the local executor step.
        #expect(!TurnPresentation.hasExecutorActivity(blocks: model.transcript(Self.runId, at: first)?.blocks ?? []))

        // Reconnect: the replayed frame, and the same receipt resumed at a later
        // seq, add nothing and count nothing.
        model.applyRemoteHistoryCardEvent(Self.envelope(missing.event, seq: 1), runID: Self.runId, at: first)
        model.applyRemoteHistoryCardEvent(Self.envelope(missing.event, seq: 9), runID: Self.runId, at: first)
        #expect(Self.notices(model, at: first).count == 1)
        #expect(model.transcript(Self.runId, at: first)?.trimmed == 0)
        // Only the receipt folds remotely: a remote harness event adds no transcript.
        model.applyRemoteHistoryCardEvent(Self.message("Remote step", seq: 10), runID: Self.runId, at: first)
        #expect(model.transcript(Self.runId, at: first)?.blocks.count == 1)
        #expect(model.transcript(Self.runId, at: .local)?.blocks.count == 1)
    }

    @Test func theRemoteRunDetailRestoresTheReceiptOnceWithoutAHistoryRefresh() async throws {
        defer { RemotePreparedStub.handler = nil }
        let partial = try Self.fixture("partial")
        let row = String(decoding: try JSONEncoder().encode(partial.row), as: UTF8.self)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RemotePreparedStub.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:43124")!, token: "test",
            session: URLSession(configuration: config))
        let (model, first, second) = Self.model(phase: .succeeded, client: client)
        let requests = RemotePreparedRequests()
        RemotePreparedStub.handler = { request in
            requests.append(request.url?.path ?? "?")
            guard request.url?.path == "/v2/runs/\(Self.runId)" else { throw RemotePreparedStub.Refused() }
            return Data(#"{"summary":{"runId":"run-same","state":"succeeded","mode":"agent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Done.","truncated":false},"timeline":[\#(row)],"lastSeq":9}"#.utf8)
        }

        #expect(await model.loadRunDetail(Self.runId, locationID: first))
        #expect(Self.notices(model, at: first).map(\.text) == [partial.row.detail])
        #expect(Self.notices(model, at: second).isEmpty)
        #expect(Self.notices(model, at: .local).isEmpty)
        // Re-polled detail (the stream refreshes it) and the live frame: still once.
        #expect(await model.loadRunDetail(Self.runId, locationID: first))
        model.applyRemoteHistoryCardEvent(Self.envelope(partial.event, seq: 3), runID: Self.runId, at: first)
        #expect(Self.notices(model, at: first).count == 1)
        #expect(model.transcript(Self.runId, at: first)?.trimmed == 0)
        #expect(model.transcript(Self.runId, at: first)?.truncatedChars == 0)
        // Only the run's own detail was read: no history scan.
        #expect(requests.paths == ["/v2/runs/\(Self.runId)", "/v2/runs/\(Self.runId)"])
    }

    @Test func retiringOneRemoteLocationDropsOnlyItsReceipts() throws {
        let missing = try Self.fixture("missing-only")
        let (model, first, second) = Self.model()
        model.applyRemoteHistoryCardEvent(Self.envelope(missing.event, seq: 1), runID: Self.runId, at: first)
        model.applyRemoteHistoryCardEvent(Self.envelope(missing.event, seq: 1), runID: Self.runId, at: second)
        model.apply(Self.envelope(missing.event, seq: 1), to: Self.runId)
        model.discardRemoteDaemonProjections(at: first)
        #expect(model.transcript(Self.runId, at: first) == nil)
        #expect(Self.notices(model, at: second).count == 1)
        #expect(Self.notices(model, at: .local).count == 1)
    }

}

private final class RemotePreparedRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    var paths: [String] { lock.withLock { values } }
    func append(_ path: String) { lock.withLock { values.append(path) } }
}

private final class RemotePreparedStub: URLProtocol {
    struct Refused: Error {}
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw Refused() }
            let data = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
