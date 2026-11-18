import CryptoKit
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
            #expect(request.value(forHTTPHeaderField: "X-Claudexor-Claude-Turn-Replies") == "1")
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            #expect(query.contains(URLQueryItem(name: "beforeTurnId", value: "mounted-edge")))
            #expect(query.contains(URLQueryItem(name: "limit", value: "20")))
            return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, history)
        }
        let page = try await client.threadHistory(id: "th-history", selector: .beforeTurnId("mounted-edge"))
        #expect(page.turns.count == 2)
        #expect(page.header.latestOrdinal == 1)
        #expect(page.turns[1].run?.runDir == "/fixtures/runs/run-history")
        #expect(page.turns[1].run?.claudeTurnReplies == nil)
        let replies = ClaudeTurnReplies.forCard(history: page.turns[1].run?.claudeTurnReplies, live: nil)
        #expect(replies.partial)
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

    @Test func copyUsesOneMatchingReplayForALargeReply() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HistoryURLProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://history.invalid")!, token: "fixture",
                                   session: URLSession(configuration: config))
        defer { HistoryURLProtocol.handler = nil }
        var requested: [String] = []
        HistoryURLProtocol.handler = { request in
            let url = try #require(request.url)
            requested.append(url.path)
            #expect(request.value(forHTTPHeaderField: "X-Claudexor-Claude-Turn-Replies") == "1")
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            #expect(query.contains(URLQueryItem(name: "offset", value: "0")))
            #expect(query.contains(URLQueryItem(name: "limit", value: "8192")))
            if url.path == "/v2/runs/r/events/3" {
                return (HTTPURLResponse(url: url, statusCode: 422, httpVersion: nil, headerFields: nil)!,
                        Data(#"{"code":"run_event_invalid"}"#.utf8))
            }
            // The server holds three million x bytes. Only its first 8 KiB cross this request.
            let body = #"""
                {"runId":"r","seq":8,"type":"harness.event","offset":0,"nextOffset":8192,"totalBytes":3000000,
                 "sha256":"e55b8bdf621ddaa8f462c74745db9680d3bb7536a9cf854f8d6668b34a287890",
                 "text":"\#(String(repeating: "x", count: 8192))",
                 "claudeTurnReply":{"source":{"attemptId":"b","sessionId":"s2","afterStop":false},
                  "partSha256":"18f8d2eb4a387bbc1e37ec099a7326805739bc9c99ecf0f14b808a5bcb65bf49"}}
                """#
            return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        await #expect(throws: GatewayError.self) {
            try await client.claudeReplyJournalPart(runId: "r", seq: 3, offset: 0)
        }
        let part = try await client.claudeReplyJournalPart(runId: "r", seq: 8, offset: 0)
        var read = ClaudeReplyJournalEvent(runID: "r", seq: 8)
        try read.accept(part)
        #expect(read.totalBytes == 3_000_000 && read.text.utf8.count == 8192 && !read.complete)
        #expect(read.source?.attemptId == "b" && read.source?.sessionId == "s2")
        #expect(requested == ["/v2/runs/r/events/3", "/v2/runs/r/events/8"])
        // Explicit whole-message copy replays the known event once. No scans
        // of neighboring seqs or requests for the remaining 8 KiB pages.
        let whole = String(repeating: "x", count: 3_000_000)
        HistoryURLProtocol.handler = { request in
            let url = try #require(request.url)
            requested.append(url.path)
            #expect(url.path == "/v2/runs/r/events")
            #expect(request.value(forHTTPHeaderField: "Last-Event-ID") == "7")
            let raw = #"{"type":"harness.event","run_id":"r","seq":8,"payload":{"type":"message","harness_id":"claude","final":true,"after_stop":false,"attempt_id":"b","session_id":"s2","text":"\#(whole)"}}"#
            let frames = "id: 8\nevent: harness.event\ndata: \(raw)\n\nevent: end\ndata: {}\n\n"
            return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"])!, Data(frames.utf8))
        }
        let card = ClaudeTurnReplies.Reply(seq: 8, source: read.source, text: read.text, truncated: true)
        let copied = try await client.fullClaudeReply(runID: "r", reply: card, firstPart: part)
        #expect(copied == whole)
        #expect(requested == ["/v2/runs/r/events/3", "/v2/runs/r/events/8", "/v2/runs/r/events"])
        let reclaimed = #"{"code":"run_expired_by_retention","message":"Journal reclaimed.","retryable":false}"#
        HistoryURLProtocol.handler = { request in
            #expect(request.url?.path == "/v2/runs/r/events")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"])!, Data("event: error\ndata: \(reclaimed)\n\n".utf8))
        }
        await #expect(throws: GatewayError.http(status: 410, body: reclaimed)) {
            try await client.fullClaudeReply(runID: "r", reply: card, firstPart: part)
        }
    }

    @Test(arguments: [true, false])
    func copyFallsBackToThePinnedAddressAndVerifiesTheWholeReply(rawPages: Bool) async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HistoryURLProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://history.invalid")!, token: "fixture",
                                   session: URLSession(configuration: config))
        defer { HistoryURLProtocol.handler = nil }
        let whole = String(repeating: "a", count: 9_000) + "END"
        let source = ClaudeTurnReplies.Source(attemptId: "a", sessionId: "s", afterStop: false)
        let card = ClaudeTurnReplies.Reply(seq: 8, source: source, text: "aaaa", truncated: true)
        func hash(_ text: String) -> String {
            SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        func copy(storedRun: String = "r", damageTail: Bool = false, status: Int = 200,
                  noReplay: Bool = false) async throws -> String {
            let raw = #"{"type":"harness.event","run_id":"\#(storedRun)","seq":8,"payload":{"harness_id":"claude","type":"message","final":true,"after_stop":false,"attempt_id":"a","session_id":"s","text":"\#(whole)"}}"#
            let stored = rawPages ? raw : whole
            let split = ClaudeReplyJournalEvent.pageBytes
            let first = String(stored.prefix(split))
            let firstPart = ClaudeReplyJournalEvent.Part(runId: "r", seq: 8, type: "harness.event", offset: 0,
                nextOffset: split, totalBytes: stored.utf8.count, sha256: hash(stored), text: first,
                claudeTurnReply: rawPages ? nil : .init(source: source, partSha256: hash(first)))
            var paths: [String] = []
            HistoryURLProtocol.handler = { request in
                let url = try #require(request.url)
                paths.append(url.path)
                if url.path == "/v2/runs/r/events" {
                    #expect(request.value(forHTTPHeaderField: "Last-Event-ID") == "7")
                    // Both rows get positional id 8 in SSE. The strict addressed reader skips them.
                    let collision = rawPages ? "event: malformed\ndata: damaged"
                        : "event: harness.event\ndata: " + raw.replacingOccurrences(of: #""seq":8"#, with: #""seq":"8""#)
                    let frames = (noReplay ? "" : "id: 8\n" + collision + "\n\n") + "event: end\ndata: {}\n\n"
                    return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                        headerFields: ["Content-Type": "text/event-stream"])!, Data(frames.utf8))
                }
                #expect(url.path == "/v2/runs/r/events/8")
                let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                #expect(query.contains(URLQueryItem(name: "offset", value: String(split))))
                var tail = String(stored.dropFirst(split))
                if damageTail { tail.replaceSubrange(tail.startIndex...tail.startIndex, with: "X") }
                var part: [String: Any] = ["runId": "r", "seq": 8, "type": "harness.event", "offset": split,
                    "nextOffset": stored.utf8.count, "totalBytes": stored.utf8.count, "sha256": hash(stored), "text": tail]
                if !rawPages {
                    part["claudeTurnReply"] = ["source": ["attemptId": "a", "sessionId": "s", "afterStop": false],
                                               "partSha256": hash(tail)] as [String: Any]
                }
                return (HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!,
                        try JSONSerialization.data(withJSONObject: part))
            }
            defer { #expect(paths == ["/v2/runs/r/events", "/v2/runs/r/events/8"]) }
            return try await client.fullClaudeReply(runID: "r", reply: card, firstPart: firstPart)
        }
        #expect(try await copy() == whole)
        #expect(try await copy(noReplay: true) == whole)
        await #expect(throws: GatewayError.self) { try await copy(damageTail: true) }
        if rawPages {
            await #expect(throws: GatewayError.self) { try await copy(storedRun: "foreign") }
        }
        do {
            _ = try await copy(status: 410)
            Issue.record("Retention returned a copied reply")
        } catch GatewayError.http(let status, _) { #expect(status == 410) }
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
