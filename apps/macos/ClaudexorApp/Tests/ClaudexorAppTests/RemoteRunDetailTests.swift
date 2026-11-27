import ClaudexorKit
import Foundation
import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

@Suite(.serialized) struct RemoteRunDetailTests {
    @MainActor
    @Test func addressedAnswerWithUnclosedFence() throws {
        let earlier = "## Earlier assistant text\n\n```swift\nlet swatch = 1"
        let accepted = "B: The accepted correction remains prose."
        #expect(MarkdownOutputView.parse(accepted).first?.text == accepted)
        // Optional AppKit raster of the real component (includes its native
        // Markdown selection views). Does not show or focus any window.
        guard let path = ProcessInfo.processInfo.environment["CX756_PREVIEW_PNG"] else { return }
        let view = NSHostingView(rootView: AddressedAnswerContent(earlier: earlier, accepted: accepted)
            .padding(16).frame(width: 580))
        view.frame.size = view.fittingSize
        view.layoutSubtreeIfNeeded()
        let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    @MainActor
    @Test func failedRemoteDetailLoadRemainsRetryable() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let calls = RemoteRunDetailCounter()
        let (model, locationID) = makeModel(runId: "run-retry")
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-retry" else {
                throw RemoteRunDetailError.badRequest
            }
            if calls.incrementAndGet() == 1 {
                return (response(for: request, status: 503), Data("offline".utf8), 0)
            }
            let body = #"{"summary":{"runId":"run-retry","state":"succeeded","mode":"agent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"fresh answer","truncated":false},"lastSeq":2}"#
            return (response(for: request), Data(body.utf8), 0)
        }

        #expect(!(await model.loadRunDetail("run-retry", locationID: locationID)))
        #expect(model.task("run-retry", at: locationID)?.engineError?.contains(
            "Could not load run detail") == true)
        #expect(await model.loadRunDetail("run-retry", locationID: locationID))
        #expect(calls.value == 2)
        #expect(model.task("run-retry", at: locationID)?.answerText == "fresh answer")
    }

    @MainActor
    @Test func addressedAnswerShowsEarlierPreviewBeforeTheSameAcceptedText() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, locationID) = makeModel(runId: "run-speaks")
        let requests = RemoteRunDetailCounter()
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-speaks",
                  request.url?.query == "includeEarlierAssistantOutput=true" else {
                throw RemoteRunDetailError.badRequest // No implicit full-artifact fetch.
            }
            let sequence = requests.incrementAndGet()
            let earlier = sequence == 1 ? "" : ###", "earlierAssistantOutput":{"path":"final/earlier-assistant-output.md","text":"## Earlier assistant text (not the accepted final)\n\nInitial swatch report.","bytes":20000,"truncated":true}"###
            let body = #"{"summary":{"runId":"run-speaks","state":"succeeded","mode":"ask","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Accepted text.","truncated":false\#(earlier)},"lastSeq":\#(sequence)}"#
            return (response(for: request), Data(body.utf8), 0)
        }
        #expect(await model.loadRunDetail("run-speaks", locationID: locationID))
        #expect(model.task("run-speaks", at: locationID)?.answerText == "Accepted text.")
        #expect(await model.loadRunDetail("run-speaks", locationID: locationID))
        let task = model.task("run-speaks", at: locationID)
        let expected = "## Earlier assistant text (not the accepted final)\n\nInitial swatch report."
            + "\n\n[Earlier text preview bounded; full artifact: final/earlier-assistant-output.md]"
        #expect(task?.earlierAnswerText == expected)
        #expect(task?.answerText == "Accepted text.")
        #expect(task?.primaryOutputPath == "final/answer.md")
        #expect(requests.value == 2)
    }

    @MainActor
    @Test func remoteLegacyDetailUsesTheSharedBoundedArtifactFallback() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, locationID) = makeModel(runId: "run-legacy")
        let legacyAnswer = String(repeating: "é", count: 128_001)
        RemoteRunDetailURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs/run-legacy":
                let body = #"{"summary":{"runId":"run-legacy","state":"succeeded","mode":"ask"},"artifacts":[{"path":"final/answer.md","kind":"file","bytes":256002}],"lastSeq":3}"#
                return (response(for: request), Data(body.utf8), 0)
            case "/v2/runs/run-legacy/artifacts/final/answer.md":
                return (response(for: request), Data(legacyAnswer.utf8), 0)
            default:
                throw RemoteRunDetailError.badRequest
            }
        }

        #expect(await model.loadRunDetail("run-legacy", locationID: locationID))
        let answer = try #require(model.task("run-legacy", at: locationID)?.answerText)
        let preview = try #require(answer.components(
            separatedBy: "\n\n_Inline preview bounded").first)
        #expect(preview.utf8.count == 256_000)
        #expect(!answer.contains("�"))
        #expect(answer.contains("open final/answer.md for the full artifact"))
    }

    @MainActor
    @Test func newerRemoteDetailWinsWhenResponsesCompleteInReverseOrder() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let calls = RemoteRunDetailCounter()
        let (model, locationID) = makeModel(runId: "run-race")
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-race" else {
                throw RemoteRunDetailError.badRequest
            }
            let call = calls.incrementAndGet()
            let answer = call == 1 ? "stale answer" : "fresh answer"
            let sequence = call == 1 ? 1 : 2
            let body = #"{"summary":{"runId":"run-race","state":"succeeded","mode":"agent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"\#(answer)","truncated":false},"lastSeq":\#(sequence)}"#
            return (response(for: request), Data(body.utf8), call == 1 ? 0.15 : 0)
        }

        let first = Task { await model.loadRunDetail("run-race", locationID: locationID) }
        while calls.value < 1 { await Task.yield() }
        let second = Task { await model.loadRunDetail("run-race", locationID: locationID) }
        _ = await (first.value, second.value)

        #expect(calls.value == 2)
        #expect(model.task("run-race", at: locationID)?.answerText == "fresh answer")
    }

    @MainActor
    @Test func retainedReportKeepsCauseAndArtifactAcrossRemoteHydrationAndListRefresh() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, locationID) = makeModel(runId: "run-retained")
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-retained" else {
                throw RemoteRunDetailError.badRequest
            }
            let body = ##"{"summary":{"runId":"run-retained","state":"failed","mode":"agent","outputReadyState":"diagnostic","error":"Native stream closed"},"primaryOutput":{"kind":"report","path":"final/retained-output.md","text":"# Useful partial review","truncated":true},"outcomeBanner":"Failed","artifacts":[{"path":"attempts/a01/produced/images","kind":"directory"},{"path":"attempts/a01/produced/images/result.png","kind":"file"}],"lastSeq":8}"##
            return (response(for: request), Data(body.utf8), 0)
        }
        #expect(await model.loadRunDetail("run-retained", locationID: locationID))
        let task = try #require(model.task("run-retained", at: locationID))
        #expect(task.answerText == "# Useful partial review")
        #expect(task.hasRetainedOutput)
        #expect(task.primaryOutputPath == "final/retained-output.md")
        #expect(task.primaryOutputTruncated)
        #expect(task.capturedArtifactPaths == ["attempts/a01/produced/images/result.png"])
        #expect(task.engineError == "Native stream closed")
        let summary = try JSONDecoder().decode(RunSummary.self, from: Data(
            #"{"runId":"run-retained","state":"failed","mode":"agent","outputReadyState":"diagnostic"}"#.utf8))
        let refreshed = AppModel.mergeRefreshedTask(summary: summary, existing: task)
        #expect(refreshed.hasRetainedOutput)
        #expect(refreshed.primaryOutputPath == task.primaryOutputPath)
        #expect(refreshed.primaryOutputTruncated)
        #expect(refreshed.capturedArtifactPaths == task.capturedArtifactPaths)
    }

    @MainActor
    private func makeModel(runId: String) -> (AppModel, ExecutionLocationID) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RemoteRunDetailURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:43123")!, token: "test",
            session: URLSession(configuration: config))
        let locationID = ExecutionLocationID.remote(UUID())
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.selectedExecutionLocation = locationID
        model.draftExecutionLocation = locationID
        model.remoteClients[locationID] = client
        model.remoteTasks[locationID] = [TaskRun(
            id: runId, title: runId, prompt: "", mode: .agent, phase: .succeeded,
            project: "Remote", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])]
        return (model, locationID)
    }
}

private enum RemoteRunDetailError: Error { case badRequest }

private final class RemoteRunDetailCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.withLock { count } }
    func incrementAndGet() -> Int { lock.withLock { count += 1; return count } }
}

private func response(for request: URLRequest, status: Int = 200) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
}

private final class RemoteRunDetailURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler:
        ((URLRequest) throws -> (HTTPURLResponse, Data, TimeInterval))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw RemoteRunDetailError.badRequest }
            let (response, data, delay) = try handler(request)
            let deliver = { [weak self] in
                guard let self else { return }
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            }
            if delay > 0 {
                DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: deliver)
            } else {
                deliver()
            }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
