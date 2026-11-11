import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import ClaudexorKit

@Suite(.serialized)
struct ThreadHistoryTests {
    private func fixture(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures/wire"))
        let envelope = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: #require(envelope["value"]))
    }

    @Test func sendsMountedEdgesAndPromptOffsetsAndPreservesTypedFailures() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HistoryURLProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "token", session: URLSession(configuration: config))
        defer { HistoryURLProtocol.handler = nil }
        let history = try fixture("thread-history-receipts")
        HistoryURLProtocol.handler = { request in
            let url = try #require(request.url)
            #expect(url.path == "/v2/threads/th-history/history")
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            #expect(query.contains(URLQueryItem(name: "beforeTurnId", value: "mounted-edge")))
            #expect(query.contains(URLQueryItem(name: "limit", value: "20")))
            return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, history)
        }
        let page = try await client.threadHistory(id: "th-history", selector: .beforeTurnId("mounted-edge"))
        #expect(page.turns.count == 2)
        #expect(page.header.latestOrdinal == 1)
        #expect(page.turns[1].run?.runDir == "/fixtures/runs/run-history")
        #expect(page.turns[1].run?.authRoute?.profileId == "profile-history")
        #expect(page.turns[1].answeredByPrompt?.prompt == "Continue")
        let partData = try fixture("thread-prompt-part")
        HistoryURLProtocol.handler = { request in
            let url = try #require(request.url)
            #expect(url.path == "/v2/threads/th-history/turns/turn-refused/prompt")
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            #expect(query.contains(URLQueryItem(name: "maxBytes", value: "32")))
            return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, partData)
        }
        let part = try await client.threadPromptPart(id: "th-history", turnId: "turn-refused", maxBytes: 32)
        #expect(part.text == "Question 😀")
        HistoryURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!,
             Data(#"{"code":"thread_history_cursor_stale","message":"resnapshot","retryable":false,"requiredActions":["resnapshot"]}"#.utf8))
        }
        do {
            _ = try await client.threadHistory(id: "th-history", selector: .cursor("stale"))
            Issue.record("stale cursor became a successful page")
        } catch let error as GatewayError {
            #expect(error.controlProblem?.code == "thread_history_cursor_stale")
        }
    }

    @Test func onlyTheEnginesUnknownRouteReplyMeansAnOlderEngine() {
        #expect(GatewayError.http(status: 404, body: #"{"error":"not found"}"#).isUnknownRoute)
        #expect(!GatewayError.http(status: 404, body: #"{"code":"thread_not_found","message":"gone"}"#).isUnknownRoute)
        #expect(!GatewayError.http(status: 404, body: #"{"error":"no such run"}"#).isUnknownRoute)
        #expect(!GatewayError.http(status: 500, body: #"{"error":"not found"}"#).isUnknownRoute)
        #expect(!GatewayError.transport("offline").isUnknownRoute)
    }

    @Test func revisionsRejectDelayedObservationsAndDoNotCompareIncarnations() throws {
        let page = try JSONDecoder().decode(ThreadHistoryPage.self, from: fixture("thread-history-receipts"))
        let older = ThreadHistoryRevision(epoch: page.revision.epoch, sequence: page.revision.sequence - 1)
        #expect(page.revision.isNewer(than: older))
        #expect(!older.isNewer(than: page.revision))
        #expect(!page.revision.isNewer(than: ThreadHistoryRevision(epoch: "another-owner", sequence: 0)))
    }

    @Test func decodesRetentionAndUnverifiableEvidenceWithoutInventingReceipts() throws {
        let retained = try JSONDecoder().decode(ThreadHistoryPage.self, from: fixture("thread-history-not-retained"))
        #expect(retained.header.headRunStatus == "not_retained")
        #expect(retained.header.headRun == nil)
        #expect(retained.turns[0].runStatus == "unbound")
        #expect(retained.turns[1].runStatus == "not_retained")
        #expect(retained.turns[1].run == nil)
        #expect(retained.turns[1].primaryOutputStatus == "not_retained")
        let unavailable = try JSONDecoder().decode(ThreadHistoryPage.self, from: fixture("thread-history-unavailable-evidence"))
        let run = try #require(unavailable.turns[1].run)
        #expect(run.applyEligibilityCoverage == "unavailable")
        #expect(run.operatorDecisionCoverage == "unavailable")
        #expect(run.operatorDecision == nil)
        #expect(run.unverifiedOperatorDecision?.action == "accept_risk")
        #expect(run.failureMessageInfo?.truncated == true)
        #expect(run.failure?.rawDetailRef == "final/failure.yaml")
    }
}

private final class HistoryURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let handler = try #require(Self.handler)
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
