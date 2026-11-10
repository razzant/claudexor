import Foundation
import Testing
@testable import ClaudexorKit

/// #575: live message text folded from rows the real producer journals.
/// Fixtures/cursor-text-deltas-transcript.json is generated
/// (scripts/gen-cursor-transcript-fixture.ts, `pnpm fixtures:swift`) by running
/// a synthetic Cursor stream using recorded native frame shapes through
/// `createCursorParser` and `harnessEventPayload`; `fixtures:swift:check` fails
/// when it drifts. Tests reorder those rows, vary identities/text and add explicit
/// boundary controls, then deliver SSE frames through `GatewayClient.events`
/// into the production reducer. This is not a live vendor recording.
@Suite(.serialized) struct TranscriptProducerShapeTests {
    private typealias Row = [String: Any]

    private static func rows() throws -> [Row] {
        let url = try #require(Bundle.module.url(
            forResource: "cursor-text-deltas-transcript", withExtension: "json", subdirectory: "Fixtures"))
        let fixture = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try #require(fixture["rows"] as? [Row])
    }

    private static func payload(_ row: Row) -> Row { row["payload"] as? Row ?? [:] }
    private static func flags(_ row: Row) -> Row { payload(row)["payload"] as? Row ?? [:] }
    private static func type(_ row: Row) -> String? { payload(row)["type"] as? String }

    private static func pick(_ rows: [Row], _ predicate: (Row) -> Bool) throws -> Row {
        let found = rows.first(where: predicate)
        return try #require(found)
    }

    /// The synthetic stream's rows, by what the real producer made of each frame.
    private struct Cast {
        let deltas: [Row], buffered: Row, flush: Row, final: Row, toolCall: Row, toolResult: Row

        init(_ rows: [Row]) throws {
            let messages = rows.filter { TranscriptProducerShapeTests.type($0) == "message" }
            deltas = messages.filter { TranscriptProducerShapeTests.flags($0)["delta"] as? Bool == true }
            buffered = try TranscriptProducerShapeTests.pick(messages) {
                TranscriptProducerShapeTests.flags($0)["buffered"] as? Bool == true
            }
            final = try TranscriptProducerShapeTests.pick(messages) {
                TranscriptProducerShapeTests.payload($0)["final"] as? Bool == true
            }
            flush = try TranscriptProducerShapeTests.pick(messages) {
                TranscriptProducerShapeTests.flags($0).isEmpty
                    && TranscriptProducerShapeTests.payload($0)["final"] == nil
            }
            toolCall = try TranscriptProducerShapeTests.pick(rows) { TranscriptProducerShapeTests.type($0) == "tool_call" }
            toolResult = try TranscriptProducerShapeTests.pick(rows) { TranscriptProducerShapeTests.type($0) == "tool_result" }
        }
    }

    /// Serve `rows` in the given order as the run's SSE frames (seq renumbered
    /// to that order) and collect the envelopes the production client decodes.
    private static func envelopes(_ rows: [Row]) async throws -> [BusEnvelope] {
        var frames = ""
        for (index, row) in rows.enumerated() {
            var numbered = row
            numbered["seq"] = index + 1
            let line = String(decoding: try JSONSerialization.data(withJSONObject: numbered), as: UTF8.self)
            frames += "id: \(index + 1)\nevent: harness.event\ndata: \(line)\n\n"
        }
        let body = Data((frames + "event: end\ndata: {}\n\n").utf8)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [TranscriptSSEStubProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
                                   session: URLSession(configuration: config))
        TranscriptSSEStubProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-575/events" else { throw URLError(.badURL) }
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream; charset=utf-8"])!
            return (response, body)
        }
        defer { TranscriptSSEStubProtocol.handler = nil }
        var out: [BusEnvelope] = []
        for try await envelope in client.events(runId: "run-575") { out.append(envelope) }
        #expect(out.count == rows.count)
        return out
    }

    private static func messages(_ reducer: TranscriptReducer) -> [String] {
        reducer.blocks.compactMap { if case .message(_, let text) = $0 { return text }; return nil }
    }

    /// The fixture's original order: reasoning, a tool, two deltas, the retained
    /// buffered duplicate, the complete flush, usage and the typed final.
    @Test func theProducerFixtureGrowsOneMessageAndItsFinalLeavesNoTwin() async throws {
        let rows = try Self.rows()
        let cast = try Cast(rows)
        #expect(cast.deltas.count == 2)
        let envelopes = try await Self.envelopes(rows)
        var reducer = TranscriptReducer()
        var seen: [String: [String]] = [:]
        for (row, envelope) in zip(rows, envelopes) {
            reducer.apply(envelope)
            if Self.flags(row)["delta"] as? Bool == true { seen["delta"] = Self.messages(reducer) }
            if Self.flags(row)["buffered"] as? Bool == true { seen["buffered"] = Self.messages(reducer) }
            if Self.type(row) == "message", Self.flags(row).isEmpty { seen["flush"] = Self.messages(reducer) }
        }
        #expect(seen["delta"] == ["Final answer."])
        #expect(seen["buffered"] == ["Final answer."])
        #expect(seen["flush"] == ["Final answer."])
        #expect(Self.messages(reducer).isEmpty)
        let tools = reducer.blocks.compactMap { block -> ToolBlock? in
            if case .tool(_, let tool) = block { return tool }
            return nil
        }
        #expect(tools.map(\.status) == [.ok])
    }

    /// The same rows with the tool between the deltas and their flush: the
    /// flush reconciles the streamed block in place, across the tool.
    @Test func aToolBetweenTheDeltasAndTheFlushReconcilesInPlace() async throws {
        let cast = try Cast(try Self.rows())
        let envelopes = try await Self.envelopes(cast.deltas + [cast.toolCall, cast.toolResult, cast.flush])
        var reducer = TranscriptReducer()
        for envelope in envelopes { reducer.apply(envelope) }
        #expect(Self.messages(reducer) == ["Final answer."])
        #expect(reducer.blocks.count == 2)
        guard case .message = reducer.blocks.first else {
            Issue.record("the reconciled message keeps its place before the tool")
            return
        }
    }

    /// A delta or buffered row arriving after the typed final changes nothing.
    @Test func lateRowsAfterTheFinalChangeNothing() async throws {
        let cast = try Cast(try Self.rows())
        let ordered = cast.deltas + [cast.toolCall, cast.toolResult, cast.flush, cast.final]
        let envelopes = try await Self.envelopes(ordered + [cast.deltas[1], cast.buffered])
        var reducer = TranscriptReducer()
        for envelope in envelopes.prefix(ordered.count) { reducer.apply(envelope) }
        let sealed = reducer.blocks
        #expect(Self.messages(reducer).isEmpty)
        let lateDelta = reducer.apply(envelopes[ordered.count])
        let lateBuffered = reducer.apply(envelopes[ordered.count + 1])
        #expect(!lateDelta)
        #expect(!lateBuffered)
        #expect(reducer.blocks == sealed)
    }

    /// The older flat spelling (`delta` beside `type`) stays accepted, and folds
    /// to the same transcript as the journaled nested spelling.
    @Test func theFlatDeltaSpellingFoldsLikeTheJournaledOne() async throws {
        let cast = try Cast(try Self.rows())
        let flat = cast.deltas.map { row -> Row in
            var outer = row
            var payload = Self.payload(row)
            payload["payload"] = nil
            payload["delta"] = true
            outer["payload"] = payload
            return outer
        }
        var nestedFold = TranscriptReducer()
        for envelope in try await Self.envelopes(cast.deltas) { nestedFold.apply(envelope) }
        var flatFold = TranscriptReducer()
        for envelope in try await Self.envelopes(flat) { flatFold.apply(envelope) }
        #expect(Self.messages(nestedFold) == ["Final answer."])
        #expect(nestedFold.blocks == flatFold.blocks)
    }

    // MARK: attempts: producer-shaped fixture rows with authored later-try identities

    /// The rows of another physical try: only the identity the journal writes
    /// (`harnessEventPayload`) and the words change.
    private static func of(_ row: Row, attempt: String, session: String, text: String? = nil) -> Row {
        var outer = row
        var payload = Self.payload(row)
        payload["attempt_id"] = attempt
        payload["session_id"] = session
        if let text { payload["text"] = text }
        outer["payload"] = payload
        return outer
    }

    /// The same row with no stream identity: an older engine, another producer.
    private static func withoutIdentity(_ row: Row) -> Row {
        var outer = row
        var payload = Self.payload(row)
        for key in ["attempt_id", "harness_id", "session_id"] { payload[key] = nil }
        outer["payload"] = payload
        return outer
    }

    /// Fold `rows` as SSE frames, reporting after each row whether it changed
    /// the transcript and what the messages then read.
    private static func fold(_ rows: [Row]) async throws -> (TranscriptReducer, [(changed: Bool, messages: [String])]) {
        var reducer = TranscriptReducer()
        var steps: [(changed: Bool, messages: [String])] = []
        for envelope in try await Self.envelopes(rows) {
            let changed = reducer.apply(envelope)
            steps.append((changed, Self.messages(reducer)))
        }
        return (reducer, steps)
    }

    /// #575 review: an earlier attempt's typed final seals that attempt only.
    /// A later attempt grows live, and an earlier attempt's late row stays
    /// rejected both after the later one starts and after the later one's final.
    @Test func aLaterAttemptStreamsPastAnEarlierFinalAndLateRowsStayRejected() async throws {
        let cast = try Cast(try Self.rows())
        let first = [cast.deltas[0], cast.deltas[1], cast.flush, cast.final]
        func second(_ row: Row, _ text: String? = nil) -> Row { Self.of(row, attempt: "a02", session: "ses-2", text: text) }
        let rows: [Row] = first
            + [second(cast.deltas[0], "Round 2 "), second(cast.deltas[1], "checking")]
            + [cast.deltas[1]]                                          // late a01, a02 has started
            + [second(cast.deltas[1], " again")]
            + [second(cast.final, "Round 2 checking again")]
            + [cast.deltas[1]]                                          // late a01, a02 is final
            + [second(cast.deltas[1], " GHOST")]                        // late a02, a02 is final
        let (_, steps) = try await Self.fold(rows)
        #expect(steps[3].messages.isEmpty, "a01's final leaves no twin")
        #expect(steps[4].changed)
        #expect(steps[4].messages == ["Round 2 "])
        #expect(steps[5].messages == ["Round 2 checking"], "a02 grows one block live")
        #expect(!steps[6].changed, "a late a01 delta after a02 started")
        #expect(steps[6].messages == ["Round 2 checking"])
        #expect(steps[7].messages == ["Round 2 checking again"], "a02 still continues its own block")
        #expect(steps[8].messages.isEmpty, "a02's final removes its own twin")
        #expect(!steps[9].changed, "a late a01 delta after a02's final")
        #expect(!steps[10].changed, "a late a02 delta after a02's final")
        #expect(steps[10].messages.isEmpty)
    }

    /// A producer with no complete flush (GitHub Copilot over ACP: chunks, then a
    /// final with other words): the later attempt's narration stays, as streamed.
    @Test func aLaterAttemptWithoutAFlushKeepsItsNarration() async throws {
        let cast = try Cast(try Self.rows())
        func second(_ row: Row, _ text: String? = nil) -> Row { Self.of(row, attempt: "a02", session: "ses-2", text: text) }
        let rows: [Row] = [cast.deltas[0], cast.deltas[1], cast.final]
            + [second(cast.deltas[0], "Round 1: "), second(cast.deltas[1], "checking first."),
               second(cast.toolCall), second(cast.toolResult), second(cast.final, "Round 1 is done.")]
        let (reducer, steps) = try await Self.fold(rows)
        #expect(steps[3].changed)
        #expect(steps[4].messages == ["Round 1: checking first."])
        #expect(Self.messages(reducer) == ["Round 1: checking first."], "a distinct final keeps the narration")
    }

    /// Rows of two attempts interleaved in the journal: no text joins across
    /// attempts, each flush and final touches only its own attempt, and a late row
    /// of a finished attempt stays rejected while the other streams on. A fragment
    /// separated from its own earlier one keeps its own row, as the feed order has
    /// it; the engine streams deltas only on single-candidate lanes, so no recorded
    /// run reaches the earlier rows staying beside a flush.
    @Test func interleavedAttemptsKeepTheirOwnTextAndFinals() async throws {
        let cast = try Cast(try Self.rows())
        func second(_ row: Row, _ text: String? = nil) -> Row { Self.of(row, attempt: "a02", session: "ses-2", text: text) }
        let rows: [Row] = [
            cast.deltas[0],                                  // a01 "Final"
            second(cast.deltas[0], "Other"),                 // a02 "Other"
            cast.deltas[1],                                  // a01 " answer."
            second(cast.deltas[1], " words"),                // a02 " words"
            cast.flush,                                      // a01 complete
            second(cast.flush, "Other words"),               // a02 complete
            second(cast.deltas[1], " still"),                // a02 goes on after its flush
            cast.final,                                      // a01 final
            cast.deltas[1],                                  // late a01
            second(cast.final, "Other words still"),         // a02 final
            second(cast.deltas[1], " GHOST"),                // late a02
        ]
        let (_, steps) = try await Self.fold(rows)
        #expect(steps[3].messages == ["Final", "Other", " answer.", " words"], "\(steps[3].messages)")
        #expect(steps[5].messages == ["Final", "Other", "Final answer.", "Other words"], "\(steps[5].messages)")
        #expect(steps[7].messages == ["Final", "Other", "Other words", " still"], "a01's final removes only its own twin")
        #expect(!steps[8].changed)
        #expect(steps[9].messages == ["Final", "Other", "Other words", " still"], "a02's final has words of its own")
        #expect(!steps[10].changed)
    }

    /// Rows with no identity share one legacy stream: a final seals it, its late
    /// row stays rejected, and a typed native turn boundary reopens it.
    @Test func rowsWithoutIdentityShareOneStreamUntilAReset() async throws {
        let cast = try Cast(try Self.rows())
        var boundary: Row = ["seq": 0, "ts": "2026-10-29T00:00:09.000Z", "type": "harness.event"]
        boundary["payload"] = ["type": "status", "payload": ["code": "native_turn_started"]] as Row
        let legacy = [cast.deltas[0], cast.deltas[1], cast.final].map(Self.withoutIdentity)
        let next = Self.withoutIdentity(Self.of(cast.deltas[0], attempt: "a01", session: "x", text: "Next turn"))
        let (_, steps) = try await Self.fold(legacy + [legacy[1], boundary, next])
        #expect(steps[1].messages == ["Final answer."])
        #expect(steps[2].messages.isEmpty)
        #expect(!steps[3].changed, "a late legacy delta stays rejected")
        #expect(!steps[4].changed, "the boundary itself renders nothing")
        #expect(steps[5].changed, "the boundary reopened the legacy stream")
        #expect(steps[5].messages == ["Next turn"])
    }

    /// A native turn boundary reopens only its own attempt's stream: another
    /// attempt's seal holds, and a row of the reopened stream grows a new block.
    @Test func aResetReopensOnlyItsOwnAttempt() async throws {
        let cast = try Cast(try Self.rows())
        var boundary: Row = ["seq": 0, "ts": "2026-10-29T00:00:09.000Z", "type": "harness.event"]
        boundary["payload"] = ["type": "status", "harness_id": "cursor", "attempt_id": "a02", "session_id": "ses-2",
                               "payload": ["code": "native_turn_started"]] as Row
        func second(_ row: Row, _ text: String? = nil) -> Row { Self.of(row, attempt: "a02", session: "ses-2", text: text) }
        let rows: [Row] = [cast.final, second(cast.final, "Second answer."), boundary,
                           second(cast.deltas[0], "Next turn"), cast.deltas[1]]
        let (_, steps) = try await Self.fold(rows)
        #expect(steps[3].messages == ["Next turn"])
        #expect(!steps[4].changed, "a01's seal is not reopened by a02's boundary")
    }

    // MARK: thinking: the same incoming flag

    private static func thinkingTexts(_ reducer: TranscriptReducer) -> [String] {
        reducer.blocks.compactMap { if case .thinking(_, let text, _) = $0 { return text }; return nil }
    }

    /// The fixture's reasoning fragments fold to the text they spell: no separator
    /// is written inside model prose, and the whitespace-only fragment survives.
    @Test func fixtureThinkingFragmentsFoldWithoutSeparators() async throws {
        let rows = try Self.rows()
        let fragments = rows.filter { Self.type($0) == "thinking" && Self.flags($0)["delta"] as? Bool == true }
        #expect(fragments.count == 4)
        let (reducer, _) = try await Self.fold(fragments)
        #expect(Self.thinkingTexts(reducer) == ["UX and interaction plan · with authored punctuation.\n"])
        #expect(reducer.textChars == "UX and interaction plan · with authored punctuation.\n".count)
    }

    /// Only a fragment of the SAME stream continues the words. A complete block
    /// (no flag) and another attempt's fragment still start their own line.
    @Test func thinkingFragmentsJoinOnlyWithinTheirStream() async throws {
        let rows = try Self.rows()
        let fragments = rows.filter { Self.type($0) == "thinking" && Self.flags($0)["delta"] as? Bool == true }
        func complete(_ text: String) -> Row {
            var outer = fragments[0]
            var payload = Self.payload(outer)
            payload["payload"] = nil
            payload["text"] = text
            outer["payload"] = payload
            return outer
        }
        let (reducer, _) = try await Self.fold([
            fragments[0], fragments[1],
            Self.of(fragments[0], attempt: "a02", session: "ses-2", text: "Oth"),
            Self.of(fragments[1], attempt: "a02", session: "ses-2", text: "er"),
            complete("A whole block"), complete("Another whole block"),
        ])
        #expect(Self.thinkingTexts(reducer) == ["UX and interaction\nOther\nA whole block\nAnother whole block"])
    }
}

/// File-local SSE stub: one canned response body per test (suite is serialized).
private final class TranscriptSSEStubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.resourceUnavailable) }
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

/// #628: Codex's async question arrives as a visible message tagged
/// `delivery: async` (harness-codex parse) between the ordinary message the
/// final repeats and that final. The question stays and the twin still drops;
/// a distinct narration stays. Rows are built here in the producer's shape.
extension TranscriptProducerShapeTests {
    private static func harnessEvent(_ seq: Int, _ fields: [String: JSONValue]) -> BusEnvelope {
        var event = fields
        event["session_id"] = .string("s1")
        event["harness_id"] = .string("codex")
        return BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"), "payload": .object(event),
        ]))
    }

    private static func foldAskedBetween(_ first: String, asyncTag: Bool) -> [String] {
        var flags: [String: JSONValue] = ["item_id": .string("call-1")]
        if asyncTag { flags["delivery"] = .string("async") }
        var reducer = TranscriptReducer()
        for env in [
            harnessEvent(1, ["type": .string("message"), "text": .string(first)]),
            harnessEvent(2, ["type": .string("message"), "text": .string("Which store should I use?"),
                             "payload": .object(flags)]),
            BusEnvelope(seq: 3, kind: "interaction.requested", event: .object([
                "type": .string("interaction.requested"),
                "payload": .object(["interaction_id": .string("i1"), "delivery": .string("async")]),
            ])),
            harnessEvent(4, ["type": .string("message"), "final": .bool(true), "text": .string("Use SQLite.")]),
        ] { _ = reducer.apply(env) }
        return messages(reducer)
    }

    @Test func anAsyncQuestionMessageIsNeverTheFinalsTwinCandidate() {
        #expect(Self.foldAskedBetween("Use SQLite.", asyncTag: true) == ["Which store should I use?"])
        #expect(Self.foldAskedBetween("Checking the schema.", asyncTag: true)
            == ["Checking the schema.", "Which store should I use?"])
        // Control: an untagged message in the same place is ordinary narration,
        // so the final's exact identity check cannot reach the earlier twin.
        #expect(Self.foldAskedBetween("Use SQLite.", asyncTag: false)
            == ["Use SQLite.", "Which store should I use?"])
    }
}
