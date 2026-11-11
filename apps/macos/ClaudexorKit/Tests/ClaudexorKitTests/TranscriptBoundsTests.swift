import Foundation
import Testing
@testable import ClaudexorKit

/// W23 regression tests: the transcript's MEASURABLE memory invariant —
/// text characters per run are hard-bounded (per block and in total), with
/// every cut disclosed. These catch the 30GB-hang class: an unbounded
/// thinking merge that SwiftUI then laid out on the main thread.
@Suite struct TranscriptBoundsTests {
    @Test func bufferedEvidenceDoesNotBecomeAnotherVisibleMessage() {
        var reducer = TranscriptReducer()
        reducer.apply(message(1, "Original"))
        let before = reducer.blocks
        let buffered = BusEnvelope(seq: 2, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string("Original"),
                                "payload": .object(["buffered": .bool(true)])])
        ]))
        let bufferedApplied = reducer.apply(buffered)
        #expect(!bufferedApplied)
        #expect(reducer.blocks == before)
        let replayApplied = reducer.apply(message(2, "Already consumed sequence"))
        #expect(!replayApplied)
        let nextApplied = reducer.apply(message(3, "Next message"))
        #expect(nextApplied)
        #expect(reducer.blocks.count == 2)
    }

    private func thinking(_ seq: Int, _ text: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("thinking"), "text": .string(text)])
        ]))
    }

    private func message(_ seq: Int, _ text: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text)])
        ]))
    }

    @Test func mergedThinkingNeverExceedsThePerBlockBound() {
        var r = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 10_000)
        for i in 1...50 { r.apply(thinking(i, String(repeating: "x", count: 400))) }
        guard case .thinking(_, let text, _) = r.blocks.last else {
            Issue.record("expected a merged thinking block")
            return
        }
        #expect(text.count <= 1_000)
        #expect(r.truncatedChars > 0)
        // The tail survives: live-progress semantics keep the NEWEST reasoning.
        #expect(text.hasSuffix("x"))
    }

    @Test func totalTextCharsStayUnderTheBudgetWithHonestTrimCount() {
        var r = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 3_000)
        for i in 1...20 { r.apply(message(i, String(repeating: "m", count: 500))) }
        #expect(r.textChars <= 3_000)
        #expect(r.trimmed > 0)
        #expect(r.blocks.count < 20)
        // The invariant accessor tells the truth about what is held.
        let held = r.blocks.reduce(0) { sum, block in
            if case .message(_, let text) = block { return sum + text.count }
            if case .thinking(_, let text, _) = block { return sum + text.count }
            return sum
        }
        #expect(held == r.textChars)
    }

    @Test func oversizedSingleMessageKeepsItsHeadAndDisclosesTheCut() {
        var r = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 10_000)
        r.apply(message(1, "HEAD" + String(repeating: "y", count: 5_000)))
        guard case .message(_, let text) = r.blocks.first else {
            Issue.record("expected a message block")
            return
        }
        #expect(text.count == 1_000)
        #expect(text.hasPrefix("HEAD"))
        #expect(r.truncatedChars == 4_004)
    }

    private func toolCall(_ seq: Int, name: String = "bash", target: String, useId: String? = nil) -> BusEnvelope {
        var tool: [String: JSONValue] = ["name": .string(name), "target": .string(target)]
        if let useId { tool["use_id"] = .string(useId) }
        return BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("tool_call"), "tool": .object(tool)])
        ]))
    }

    private func toolResult(_ seq: Int, useId: String, detail: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("tool_result"), "tool": .object([
                "use_id": .string(useId), "status": .string("ok"),
                "content_summary": .string(detail)
            ])])
        ]))
    }

    /// Tool strings are harness-supplied and NOT engine-bounded: a single
    /// multi-megabyte command target must not bypass the invariant (sol #2).
    @Test func oversizedToolTargetIsBoundedCountedAndDisclosed() {
        var r = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 10_000, toolFieldCap: 500)
        r.apply(toolCall(1, target: String(repeating: "t", count: 2_000_000)))
        guard case .tool(_, let block) = r.blocks.first else {
            Issue.record("expected a tool block")
            return
        }
        #expect((block.target?.count ?? 0) <= 500)
        #expect(r.truncatedChars >= 1_999_500)
        // Tool text COUNTS toward the invariant — no zero-rated escape hatch.
        #expect(r.textChars == block.name.count + (block.target?.count ?? 0))
    }

    @Test func oversizedToolResultDetailStaysBoundedThroughTheInPlaceUpdate() {
        var r = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 10_000, toolFieldCap: 500)
        r.apply(toolCall(1, target: "make build", useId: "u1"))
        let before = r.textChars
        r.apply(toolResult(2, useId: "u1", detail: String(repeating: "d", count: 100_000)))
        guard case .tool(_, let block) = r.blocks.first else {
            Issue.record("expected a tool block")
            return
        }
        #expect((block.detail?.count ?? 0) <= 500)
        #expect(r.textChars == before + (block.detail?.count ?? 0))
        #expect(r.truncatedChars == 99_500)
    }

    /// A TYPED final message is the answer bubble's content — repeating it in
    /// the live transcript would double the text the user just read (F2.5).
    @Test func typedFinalMessageNeverEntersTheTranscript() {
        var r = TranscriptReducer()
        r.apply(message(1, "narration"))
        r.apply(BusEnvelope(seq: 2, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object([
                "type": .string("message"),
                "text": .string("final answer"),
                "final": .bool(true)
            ])
        ])))
        #expect(r.blocks.count == 1)
        guard case .message(_, let text) = r.blocks.first else {
            Issue.record("expected the narration message")
            return
        }
        #expect(text == "narration")
    }

    private func thinkingAt(_ seq: Int, _ text: String, ts: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("thinking"), "text": .string(text), "ts": .string(ts)])
        ]))
    }

    /// F2.5 W-C3: a merged reasoning SEGMENT discloses its observed span from
    /// the events' own timestamps; a tool call closes the segment, and the
    /// next thinking starts a fresh timer.
    @Test func thinkingSegmentsDiscloseTheirObservedDurationPerSegment() {
        var r = TranscriptReducer()
        r.apply(thinkingAt(1, "start", ts: "2026-07-17T00:00:00Z"))
        r.apply(thinkingAt(2, "more", ts: "2026-07-17T00:00:12Z"))
        guard case .thinking(_, _, let firstSpan) = r.blocks.last else {
            Issue.record("expected a thinking segment")
            return
        }
        #expect(firstSpan == 12)

        r.apply(toolCall(3, target: "ls"))
        r.apply(thinkingAt(4, "next segment", ts: "2026-07-17T00:01:00Z"))
        r.apply(thinkingAt(5, "still next", ts: "2026-07-17T00:01:05Z"))
        guard case .thinking(_, _, let secondSpan) = r.blocks.last else {
            Issue.record("expected a second thinking segment")
            return
        }
        #expect(secondSpan == 5)

        // Missing timestamps degrade to 0 (the UI hides a zero timer).
        var bare = TranscriptReducer()
        bare.apply(thinking(1, "no ts"))
        bare.apply(thinking(2, "still none"))
        guard case .thinking(_, _, let unknownSpan) = bare.blocks.last else {
            Issue.record("expected a thinking segment")
            return
        }
        #expect(unknownSpan == 0)
    }

    private func deltaMessage(_ seq: Int, _ text: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text), "delta": .bool(true)])
        ]))
    }

    /// F2.5 W-C4: deltas grow ONE streaming block; the complete message then
    /// REPLACES it — never a duplicated paragraph; a tool block closes it.
    @Test func deltasGrowOneStreamingBlockAndTheFullMessageReplacesIt() {
        var r = TranscriptReducer()
        r.apply(deltaMessage(1, "The "))
        r.apply(deltaMessage(2, "answer"))
        r.apply(deltaMessage(3, " is 42."))
        #expect(r.blocks.count == 1)
        guard case .message(_, let streaming) = r.blocks.last else {
            Issue.record("expected the streaming message block")
            return
        }
        #expect(streaming == "The answer is 42.")

        r.apply(message(4, "The answer is 42."))
        #expect(r.blocks.count == 1)
        guard case .message(_, let replaced) = r.blocks.last else {
            Issue.record("expected the replaced message block")
            return
        }
        #expect(replaced == "The answer is 42.")
        let held = r.blocks.reduce(0) { sum, block in
            if case .message(_, let t) = block { return sum + t.count }
            return sum
        }
        #expect(held == r.textChars)

        // A tool block closes the stream: the next full message is its own block.
        r.apply(toolCall(5, target: "ls"))
        r.apply(message(6, "separate note"))
        #expect(r.blocks.count == 3)
    }

    /// The engine's actual wire shape (`harnessEventPayload`): the adapter's
    /// own flags ride the nested `payload`, as an AGY text fragment does.
    private func wireMessage(_ seq: Int, _ text: String, _ flags: [String: JSONValue]) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text),
                                "payload": .object(flags)])
        ]))
    }

    /// AGY fragments on the wire grow ONE exact block (whitespace-only and
    /// repeated frames kept); its retained non-success copy is not displayed.
    @Test func nestedWireDeltasGrowOneExactBlockAndBufferedEvidenceStaysHidden() {
        var r = TranscriptReducer()
        let fragments = ["Checking the ", "file", ".", "\n", "ha", "ha", " ", "done\n"]
        for (i, text) in fragments.enumerated() {
            r.apply(wireMessage(i + 1, text, ["delta": .bool(true)]))
        }
        #expect(r.blocks.count == 1)
        guard case .message(_, let streamed) = r.blocks.last else {
            Issue.record("expected one streaming message block")
            return
        }
        #expect(streamed == fragments.joined())
        let hidden = r.apply(wireMessage(20, fragments.joined(),
                                         ["buffered": .bool(true), "non_success_result": .bool(true)]))
        #expect(!hidden)
        #expect(r.blocks.count == 1)
    }

    // MARK: stream identity: one reducer per run, one stream per (attempt, harness, session)

    /// The journal's own identity fields (`harnessEventPayload`) around a message.
    private func streamMessage(_ seq: Int, _ text: String, attempt: String, session: String,
                               delta: Bool = true, final: Bool = false) -> BusEnvelope {
        var payload: [String: JSONValue] = [
            "type": .string("message"), "text": .string(text), "harness_id": .string("agy"),
            "attempt_id": .string(attempt), "session_id": .string(session)
        ]
        if final { payload["final"] = .bool(true) }
        if delta { payload["payload"] = .object(["delta": .bool(true)]) }
        return BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"), "payload": .object(payload)
        ]))
    }

    private func messageTexts(_ r: TranscriptReducer) -> [String] {
        r.blocks.compactMap { block in
            if case .message(_, let text) = block { return text }
            return nil
        }
    }

    /// A typed final seals ITS stream only: the next try of the same attempt (a
    /// fresh session after the answer reset) and a later attempt keep streaming,
    /// while the sealed stream's own late delta is still dropped.
    @Test func aFinalSealsOnlyItsOwnStream() {
        var r = TranscriptReducer()
        r.apply(streamMessage(1, "first ", attempt: "a01", session: "ses-1"))
        r.apply(streamMessage(2, "first answer", attempt: "a01", session: "ses-1", delta: false, final: true))
        let retried = r.apply(streamMessage(3, "retry ", attempt: "a01", session: "ses-2"))
        r.apply(streamMessage(4, "progress", attempt: "a01", session: "ses-2"))
        let ghost = r.apply(streamMessage(5, " GHOST", attempt: "a01", session: "ses-1"))
        let later = r.apply(streamMessage(6, "next attempt", attempt: "a02", session: "ses-3"))
        #expect(retried)
        #expect(!ghost)
        #expect(later)
        #expect(messageTexts(r) == ["first ", "retry progress", "next attempt"])
    }

    /// Interleaved candidates never join: a stream continues only its own block,
    /// and only while that block is still last (feed order is kept).
    @Test func interleavedStreamsNeverConcatenate() {
        var r = TranscriptReducer()
        r.apply(streamMessage(1, "A: checking ", attempt: "a01", session: "ses-a"))
        r.apply(streamMessage(2, "B: searching ", attempt: "a02", session: "ses-b"))
        r.apply(streamMessage(3, "file", attempt: "a01", session: "ses-a"))
        r.apply(streamMessage(4, "tests", attempt: "a02", session: "ses-b"))
        r.apply(streamMessage(5, ".", attempt: "a02", session: "ses-b"))
        #expect(messageTexts(r) == ["A: checking ", "B: searching ", "file", "tests."])
        let held = r.blocks.reduce(0) { sum, block in
            if case .message(_, let t) = block { return sum + t.count }
            return sum
        }
        #expect(held == r.textChars)
    }

    /// A complete flush reconciles its OWN stream's block, and a typed final
    /// removes only its own stream's twin.
    @Test func flushAndTwinRemovalStayWithinTheirStream() {
        var r = TranscriptReducer()
        r.apply(streamMessage(1, "Hel", attempt: "a01", session: "ses-a"))
        r.apply(streamMessage(2, "lo", attempt: "a01", session: "ses-a"))
        r.apply(streamMessage(3, "Other", attempt: "a02", session: "ses-b"))
        r.apply(streamMessage(4, "Hello", attempt: "a01", session: "ses-a", delta: false))
        #expect(messageTexts(r) == ["Hello", "Other"])
        r.apply(streamMessage(5, "Other", attempt: "a02", session: "ses-b", delta: false, final: true))
        #expect(messageTexts(r) == ["Hello"])
        r.apply(streamMessage(6, "Hello", attempt: "a01", session: "ses-a", delta: false, final: true))
        #expect(messageTexts(r).isEmpty)
        #expect(r.textChars == 0)
    }

    // MARK: native turns: a typed boundary reopens its own stream only

    /// Journal rows exactly as the actual Claude parser (`createClaudeParser`)
    /// and `harnessEventPayload` produce them when a queued live message runs
    /// as the next native turn of the SAME process: the first turn's typed
    /// final, the typed `native_turn_started` status, the next turn's fragment.
    private static let claudeNextTurnRows = [
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-02T05:51:03.928Z","type":"message","title":"FIRST ANSWER","text":"FIRST ANSWER","final":true,"payload":{"final_source":"result"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-02T05:51:03.928Z","type":"status","title":"native turn 2 started in the same session","text":"native turn 2 started in the same session","payload":{"code":"native_turn_started","turn":2}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-02T05:51:03.929Z","type":"message","title":"SECOND TURN LIVE TEXT","text":"SECOND TURN LIVE TEXT","speech":{"key":"claude:e37af165aef7:1:0","op":"fragment"},"payload":{"delta":true}}}"#
    ]

    private func journalRow(_ seq: Int, _ json: String) throws -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event",
                    event: try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
    }

    /// A Claude event of attempt a01 in `session`, on the same journal shape.
    private func claudeEvent(_ seq: Int, session: String, _ fields: [String: JSONValue]) -> BusEnvelope {
        var payload: [String: JSONValue] = [
            "harness_id": .string("claude"), "attempt_id": .string("a01"), "session_id": .string(session)
        ]
        payload.merge(fields) { _, field in field }
        return BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"), "payload": .object(payload)
        ]))
    }

    private func claudeDelta(_ seq: Int, session: String, _ text: String) -> BusEnvelope {
        claudeEvent(seq, session: session, ["type": .string("message"), "text": .string(text),
                                            "payload": .object(["delta": .bool(true)])])
    }

    /// The next native turn of the same session streams again after its earlier
    /// final, while a late delta BEFORE the boundary is still dropped, a status
    /// without the boundary code reopens nothing and another sealed stream
    /// stays sealed.
    @Test func aNativeTurnBoundaryReopensOnlyItsOwnStream() throws {
        var r = TranscriptReducer()
        r.apply(claudeEvent(1, session: "process-0", ["type": .string("message"),
                                                      "text": .string("OTHER"), "final": .bool(true)]))
        r.apply(try journalRow(2, Self.claudeNextTurnRows[0]))
        let late = r.apply(claudeDelta(3, session: "process-1", " GHOST"))
        let retry = r.apply(claudeEvent(4, session: "process-1", [
            "type": .string("status"), "text": .string("api retry"),
            "payload": .object(["code": .string("api_retry")])
        ]))
        let stillLate = r.apply(claudeDelta(5, session: "process-1", " GHOST"))
        let boundary = r.apply(try journalRow(6, Self.claudeNextTurnRows[1]))
        let otherStillSealed = r.apply(claudeDelta(7, session: "process-0", " GHOST"))
        let nextTurn = r.apply(try journalRow(8, Self.claudeNextTurnRows[2]))
        r.apply(claudeDelta(9, session: "process-1", " continues"))
        #expect(!late && !retry && !stillLate && !boundary && !otherStillSealed)
        #expect(nextTurn)
        #expect(messageTexts(r) == ["SECOND TURN LIVE TEXT continues"])
        // The new turn's own final seals it again.
        r.apply(claudeEvent(10, session: "process-1", ["type": .string("message"),
                                                       "text": .string("SECOND ANSWER"), "final": .bool(true)]))
        let afterSecondFinal = r.apply(claudeDelta(11, session: "process-1", " GHOST"))
        #expect(!afterSecondFinal)
        #expect(messageTexts(r) == ["SECOND TURN LIVE TEXT continues"])
    }

    /// A turn that ended without a typed final keeps its text: the next turn's
    /// complete message never replaces the earlier turn's block, and its final
    /// never removes an earlier turn's identical message as a twin.
    @Test func aNativeTurnBoundaryStartsFreshMessageState() throws {
        var r = TranscriptReducer()
        r.apply(claudeDelta(1, session: "process-1", "turn one "))
        r.apply(claudeDelta(2, session: "process-1", "partial"))
        r.apply(try journalRow(3, Self.claudeNextTurnRows[1]))
        r.apply(claudeEvent(4, session: "process-1", ["type": .string("message"), "text": .string("Done.")]))
        #expect(messageTexts(r) == ["turn one partial", "Done."])
        r.apply(claudeEvent(5, session: "process-1", [
            "type": .string("status"), "text": .string("native turn 3 started in the same session"),
            "payload": .object(["code": .string("native_turn_started"), "turn": .number(3)])
        ]))
        r.apply(claudeEvent(6, session: "process-1", ["type": .string("message"),
                                                      "text": .string("Done."), "final": .bool(true)]))
        #expect(messageTexts(r) == ["turn one partial", "Done."])
    }

    // MARK: speech identity: an abandoned speech keeps its text; a completion replaces only its own

    /// Journal rows exactly as the actual Claude parser (`createClaudeParser`)
    /// and `harnessEventPayload` produce them from the recorded 2.1.311
    /// fixtures `recorded-partial-replay.jsonl` (the CLI abandons the first
    /// response's keyed text, retries the request and completes the retried
    /// response under a new key), `recorded-partial-joined.jsonl` (one
    /// deferred frame joins a run of keyed blocks, `payload.joined_speech_keys`)
    /// and `recorded-partial-multiblock.jsonl` (keyed completes across tools).
    private static let claudeReplayRows = [
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.612Z","type":"started","title":"started","observed_model":"claude-opus-5-5","payload":{"tools":["Glob","Grep","Read","WebFetch","WebSearch"],"plugins":[{"name":"cc-plugin-agents-md","path":"builtin","source":"cc-plugin-agents-md@builtin"},{"name":"cc-plugin-plugin-authoring","path":"builtin","source":"cc-plugin-plugin-authoring@builtin"}],"mcp_servers":[],"native_session_id":"fixture-session-1"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.617Z","type":"message","title":"Checking","text":"Checking","speech":{"key":"claude:61670d65d08a:1:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.620Z","type":"message","title":" the","text":" the","speech":{"key":"claude:61670d65d08a:1:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.620Z","type":"status","title":"streamed text abandoned by the CLI","text":"streamed text abandoned by the CLI","speech":{"key":"claude:61670d65d08a:1:0","op":"abandoned"},"payload":{"code":"speech_abandoned","from_block_index":0}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.620Z","type":"status","title":"api_retry: unknown","text":"api_retry: unknown","status":{"kind":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":541,"error_category":"unknown"},"payload":{"api_retry":true,"retry_delay_ms":541}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.622Z","type":"message","title":"Checking","text":"Checking","speech":{"key":"claude:61670d65d08a:2:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.622Z","type":"message","title":" the","text":" the","speech":{"key":"claude:61670d65d08a:2:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.622Z","type":"message","title":" file first.","text":" file first.","speech":{"key":"claude:61670d65d08a:2:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.622Z","type":"message","title":"Checking the file first.","text":"Checking the file first.","speech":{"key":"claude:61670d65d08a:2:0","op":"complete"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.622Z","type":"tool_call","title":"Read","text":"Read","tool":{"name":"Read","kind":"file","use_id":"toolu_rp_1","target":"Read: /tmp/fixture-repo/missing.txt"},"payload":{"input":{"file_path":"/tmp/fixture-repo/missing.txt"}}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.626Z","type":"tool_result","title":"tool_result: error: File does not exist. Note: your current working directory is /tmp/fixture-repo.","text":"tool_result: error: File does not exist. Note: your current working directory is /tmp/fixture-repo.","tool":{"name":"Read","kind":"file","use_id":"toolu_rp_1","target":"Read: /tmp/fixture-repo/missing.txt","status":"error","error_summary":"File does not exist. Note: your current working directory is /tmp/fixture-repo.","content_summary":"File does not exist. Note: your current working directory is /tmp/fixture-repo."}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.627Z","type":"message","title":"The file","text":"The file","speech":{"key":"claude:61670d65d08a:3:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.627Z","type":"message","title":" does not exist.","text":" does not exist.","speech":{"key":"claude:61670d65d08a:3:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.627Z","type":"message","title":"The file does not exist.","text":"The file does not exist.","speech":{"key":"claude:61670d65d08a:3:0","op":"complete"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.627Z","type":"usage","title":"usage: 120 in / 25 out","usage":{"input_tokens":120,"output_tokens":25,"cached_input_tokens":0,"input_token_usage":{"total_tokens":120,"cache_read_tokens":0,"cache_write_tokens":0},"cost_usd":0.00098}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.627Z","type":"message","title":"The file does not exist.","text":"The file does not exist.","final":true,"payload":{"final_source":"result"}}}"#
    ]
    private static let claudeJoinedRows = [
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.792Z","type":"started","title":"started","observed_model":"claude-opus-5-5","payload":{"tools":["Glob","Grep","Read","WebFetch","WebSearch"],"plugins":[{"name":"cc-plugin-agents-md","path":"builtin","source":"cc-plugin-agents-md@builtin"},{"name":"cc-plugin-plugin-authoring","path":"builtin","source":"cc-plugin-plugin-authoring@builtin"}],"mcp_servers":[],"native_session_id":"fixture-session-1"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.793Z","type":"message","title":"Part one.","text":"Part one.","speech":{"key":"claude:f040126fbc52:1:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"message","title":" Part two.","text":" Part two.","speech":{"key":"claude:f040126fbc52:1:1","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"message","title":"Part one. Part two.","text":"Part one. Part two.","payload":{"joined_speech_keys":["claude:f040126fbc52:1:0","claude:f040126fbc52:1:1"]}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"tool_call","title":"Read","text":"Read","tool":{"name":"Read","kind":"file","use_id":"toolu_jn_1","target":"Read: /tmp/fixture-repo/missing.txt"},"payload":{"input":{"file_path":"/tmp/fixture-repo/missing.txt"}}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"tool_result","title":"tool_result: error: File does not exist. Note: your current working directory is /tmp/fixture-repo.","text":"tool_result: error: File does not exist. Note: your current working directory is /tmp/fixture-repo.","tool":{"name":"Read","kind":"file","use_id":"toolu_jn_1","target":"Read: /tmp/fixture-repo/missing.txt","status":"error","error_summary":"File does not exist. Note: your current working directory is /tmp/fixture-repo.","content_summary":"File does not exist. Note: your current working directory is /tmp/fixture-repo."}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"message","title":"Done","text":"Done","speech":{"key":"claude:f040126fbc52:2:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"message","title":".","text":".","speech":{"key":"claude:f040126fbc52:2:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"message","title":"Done.","text":"Done.","payload":{"joined_speech_keys":["claude:f040126fbc52:2:0"]}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"usage","title":"usage: 80 in / 24 out","usage":{"input_tokens":80,"output_tokens":24,"cached_input_tokens":0,"input_token_usage":{"total_tokens":80,"cache_read_tokens":0,"cache_write_tokens":0},"cost_usd":0.0008}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:03:18.794Z","type":"message","title":"Done.","text":"Done.","final":true,"payload":{"final_source":"result"}}}"#
    ]

    private static let claudeMultiblockRows = [
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.207Z","type":"started","title":"started","observed_model":"claude-opus-5-5","payload":{"tools":["Glob","Grep","Read","WebFetch","WebSearch"],"plugins":[{"name":"cc-plugin-agents-md","path":"builtin","source":"cc-plugin-agents-md@builtin"},{"name":"cc-plugin-plugin-authoring","path":"builtin","source":"cc-plugin-plugin-authoring@builtin"}],"mcp_servers":[],"native_session_id":"fixture-session-1"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.213Z","type":"message","title":"Two checks:","text":"Two checks:","speech":{"key":"claude:62d349f38a37:1:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.213Z","type":"message","title":" first.","text":" first.","speech":{"key":"claude:62d349f38a37:1:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.214Z","type":"message","title":"Two checks: first.","text":"Two checks: first.","speech":{"key":"claude:62d349f38a37:1:0","op":"complete"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.218Z","type":"tool_call","title":"Read","text":"Read","tool":{"name":"Read","kind":"file","use_id":"toolu_mb_1","target":"Read: /tmp/fixture-repo/missing-1.txt"},"payload":{"input":{"file_path":"/tmp/fixture-repo/missing-1.txt"}}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.219Z","type":"message","title":"Then","text":"Then","speech":{"key":"claude:62d349f38a37:1:2","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.219Z","type":"message","title":" the second.","text":" the second.","speech":{"key":"claude:62d349f38a37:1:2","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.219Z","type":"message","title":"Then the second.","text":"Then the second.","speech":{"key":"claude:62d349f38a37:1:2","op":"complete"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.219Z","type":"tool_call","title":"Read","text":"Read","tool":{"name":"Read","kind":"file","use_id":"toolu_mb_2","target":"Read: /tmp/fixture-repo/missing-2.txt"},"payload":{"input":{"file_path":"/tmp/fixture-repo/missing-2.txt"}}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.219Z","type":"tool_result","title":"tool_result: error: File does not exist. Note: your current working directory is /tmp/fixture-repo.","text":"tool_result: error: File does not exist. Note: your current working directory is /tmp/fixture-repo.","tool":{"name":"Read","kind":"file","use_id":"toolu_mb_2","target":"Read: /tmp/fixture-repo/missing-2.txt","status":"error","error_summary":"File does not exist. Note: your current working directory is /tmp/fixture-repo.","content_summary":"File does not exist. Note: your current working directory is /tmp/fixture-repo."}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.220Z","type":"tool_result","title":"tool_result: error: File does not exist. Note: your current working directory is /tmp/fixture-repo.","text":"tool_result: error: File does not exist. Note: your current working directory is /tmp/fixture-repo.","tool":{"name":"Read","kind":"file","use_id":"toolu_mb_1","target":"Read: /tmp/fixture-repo/missing-1.txt","status":"error","error_summary":"File does not exist. Note: your current working directory is /tmp/fixture-repo.","content_summary":"File does not exist. Note: your current working directory is /tmp/fixture-repo."}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.220Z","type":"message","title":"Both files","text":"Both files","speech":{"key":"claude:62d349f38a37:2:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.220Z","type":"message","title":" are missing.","text":" are missing.","speech":{"key":"claude:62d349f38a37:2:0","op":"fragment"},"payload":{"delta":true}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.220Z","type":"message","title":"Both files are missing.","text":"Both files are missing.","speech":{"key":"claude:62d349f38a37:2:0","op":"complete"}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.220Z","type":"usage","title":"usage: 80 in / 24 out","usage":{"input_tokens":80,"output_tokens":24,"cached_input_tokens":0,"input_token_usage":{"total_tokens":80,"cache_read_tokens":0,"cache_write_tokens":0},"cost_usd":0.0008}}}"#,
        #"{"type":"harness.event","payload":{"harness_id":"claude","attempt_id":"a01","session_id":"process-1","ts":"2026-11-03T00:15:09.220Z","type":"message","title":"Both files are missing.","text":"Both files are missing.","final":true,"payload":{"final_source":"result"}}}"#
    ]

    private func fold(_ rows: [String]) throws -> [[String]] {
        var r = TranscriptReducer()
        var after: [[String]] = []
        for (i, row) in rows.enumerated() {
            r.apply(try journalRow(i + 1, row))
            after.append(messageTexts(r))
        }
        return after
    }

    /// The abandoned partial stays as emitted beside the retried response: the
    /// retry's fragments start their own block, its completion replaces only
    /// that block, and the final removes only its own twin (QA-009).
    @Test func recordedClaudeReplayKeepsTheAbandonedPartialBesideTheRetry() throws {
        let after = try fold(Self.claudeReplayRows)
        #expect(after[2] == ["Checking the"])
        #expect(after[7] == ["Checking the", "Checking the file first."])
        #expect(after[8] == ["Checking the", "Checking the file first."])
        #expect(after[13] == ["Checking the", "Checking the file first.", "The file does not exist."])
        #expect(after.last == ["Checking the", "Checking the file first."])
    }

    /// A deferred frame naming its run of keyed blocks still reconciles their
    /// one streamed block, as an unkeyed complete message does.
    @Test func recordedClaudeJoinedRunStaysOneBlock() throws {
        let after = try fold(Self.claudeJoinedRows)
        #expect(after[2] == ["Part one. Part two."])
        #expect(after[3] == ["Part one. Part two."])
        #expect(after.last == ["Part one. Part two."])
    }

    /// Each keyed complete still replaces its own streamed block across tools.
    @Test func recordedClaudeMultiblockCompletesReplaceTheirOwnBlocks() throws {
        let after = try fold(Self.claudeMultiblockRows)
        #expect(after[3] == ["Two checks: first."])
        #expect(after[7] == ["Two checks: first.", "Then the second."])
        #expect(after[13] == ["Two checks: first.", "Then the second.", "Both files are missing."])
        #expect(after.last == ["Two checks: first.", "Then the second."])
    }

    private func speechEvent(_ seq: Int, _ type: String, _ text: String, key: String, op: String,
                             session: String = "process-1") -> BusEnvelope {
        var fields: [String: JSONValue] = [
            "type": .string(type), "text": .string(text),
            "speech": .object(["key": .string(key), "op": .string(op)])
        ]
        if op == "fragment" { fields["payload"] = .object(["delta": .bool(true)]) }
        return claudeEvent(seq, session: session, fields)
    }

    /// Without an observed abandonment two speeches can share one streamed
    /// block; a completion of one of them then gets its own block instead of
    /// erasing the other's text. Another speech's or another stream's
    /// abandonment closes nothing, and an unkeyed complete reconciles as before.
    @Test func aKeyedCompletionReplacesOnlyItsOwnSpeech() {
        var r = TranscriptReducer()
        r.apply(speechEvent(1, "message", "first ", key: "K1", op: "fragment"))
        r.apply(speechEvent(2, "status", "abandoned", key: "K9", op: "abandoned"))
        r.apply(speechEvent(3, "status", "abandoned", key: "K1", op: "abandoned", session: "process-2"))
        r.apply(speechEvent(4, "message", "second", key: "K2", op: "fragment"))
        #expect(messageTexts(r) == ["first second"])
        r.apply(speechEvent(5, "message", "second", key: "K2", op: "complete"))
        #expect(messageTexts(r) == ["first second", "second"])
        r.apply(speechEvent(6, "message", "own", key: "K3", op: "fragment"))
        r.apply(speechEvent(7, "message", "own text", key: "K3", op: "complete"))
        #expect(messageTexts(r) == ["first second", "second", "own text"])
        r.apply(claudeDelta(8, session: "process-1", "unkeyed"))
        r.apply(claudeEvent(9, session: "process-1", ["type": .string("message"), "text": .string("unkeyed.")]))
        #expect(messageTexts(r) == ["first second", "second", "own text", "unkeyed."])
    }

    private func finalMessage(_ seq: Int, _ text: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text), "final": .bool(true)])
        ]))
    }

    /// F2.5 sol #9: after a TYPED final the delta stream is sealed — a late
    /// stray delta must not append to a stale block or reopen a stream.
    @Test func aLateDeltaAfterTheFinalIsDropped() {
        var r = TranscriptReducer()
        r.apply(deltaMessage(1, "streaming"))
        r.apply(finalMessage(2, "the final answer"))  // seals; not in transcript
        r.apply(deltaMessage(3, " GHOST"))
        // Only the (now-complete) streaming narration block remains; the ghost
        // delta neither appended to it nor created a new live block.
        #expect(r.blocks.count == 1)
        guard case .message(_, let text) = r.blocks.last else {
            Issue.record("expected the sealed streaming block")
            return
        }
        #expect(text == "streaming")
    }

    private func emptyFinalMessage(_ seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(""), "final": .bool(true)])
        ]))
    }

    /// confirm #2: an EMPTY-text final must ALSO seal the stream (the old
    /// non-empty guard ran first, letting a post-empty-final delta through).
    @Test func anEmptyFinalStillSealsTheStream() {
        var r = TranscriptReducer()
        r.apply(deltaMessage(1, "streaming"))
        r.apply(emptyFinalMessage(2))     // empty final — must still seal
        r.apply(deltaMessage(3, " GHOST"))
        #expect(r.blocks.count == 1)
        guard case .message(_, let text) = r.blocks.last else {
            Issue.record("expected the sealed streaming block")
            return
        }
        #expect(text == "streaming")
    }

    /// confirm #1: deltas, THEN a tool block, THEN the authoritative full
    /// flush — the flush must RECONCILE the delta-built block by id (across
    /// the tool), not append a duplicate paragraph.
    @Test func aFullFlushReconcilesAcrossAnInterveningToolBlock() {
        var r = TranscriptReducer()
        r.apply(deltaMessage(1, "Hel"))
        r.apply(deltaMessage(2, "lo"))
        r.apply(toolCall(3, target: "ls"))         // orphans the streaming block from the tail
        r.apply(message(4, "Hello"))               // complete flush of the SAME message
        // The message block is replaced in place; no "Hel...lo" + "Hello" dup.
        let messages = r.blocks.filter { if case .message = $0 { return true }; return false }
        #expect(messages.count == 1)
        guard case .message(_, let text) = messages.first else {
            Issue.record("expected one reconciled message block")
            return
        }
        #expect(text == "Hello")
    }

    // MARK: QA-009 — the finalization twin never duplicates the answer bubble

    /// The exact live Codex sequence: a complete non-final agent message, then
    /// the SAME text repeated as the typed final. The twin must leave the
    /// transcript entirely so Activity is not a dim copy of the answer bubble.
    @Test func codexFinalizedTwinLeavesNoTranscriptMessage() {
        var r = TranscriptReducer()
        r.apply(message(1, "7"))          // codex last agent message (non-final)
        r.apply(finalMessage(2, "7"))     // codex turn.completed typed final
        #expect(r.blocks.isEmpty)
        #expect(r.textChars == 0)
    }

    /// QA-009 in the DEFAULT constrained WorkReport route: codex unwraps the
    /// envelope's `output` for BOTH the intermediate visible message and the typed
    /// final (the raw `{work_report, output}` envelope rides a typed payload field
    /// for the orchestrator, never the visible `text`). The final's display text
    /// therefore equals the intermediate's, so the exact-identity twin-removal
    /// leaves Activity with no dim copy of the answer bubble — the regression the
    /// raw-final form reintroduced.
    @Test func constrainedEnvelopeFinalRemovesTheUnwrappedTwin() {
        var r = TranscriptReducer()
        let unwrapped = "Ask — read-only; Plan — planning; Agent — edits."
        r.apply(message(1, unwrapped))   // codex intermediate agent message, unwrapped
        r.apply(BusEnvelope(seq: 2, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object([
                "type": .string("message"),
                "text": .string(unwrapped),   // DISPLAY truth: the unwrapped output
                "final": .bool(true),
                "final_source": .string("last_agent_message"),
                // MACHINE truth carried alongside; the reducer ignores it and
                // correlates on the visible text.
                "work_report_envelope": .string(
                    "{\"work_report\":{\"state\":\"completed\",\"required_inputs\":[]},\"output\":\"\(unwrapped)\"}")
            ])
        ])))
        #expect(r.blocks.isEmpty)
        #expect(r.textChars == 0)
    }

    /// A delta-streamed then finalized message (Claude/Cursor result shape): the
    /// reconciled streamed block is the twin and is removed on the identical
    /// final; accounting stays consistent.
    @Test func aDeltaStreamedMessageFinalizedByIdenticalTextIsRemoved() {
        var r = TranscriptReducer()
        r.apply(deltaMessage(1, "The "))
        r.apply(deltaMessage(2, "answer is 42."))
        r.apply(finalMessage(3, "The answer is 42."))
        #expect(r.blocks.isEmpty)
        #expect(r.textChars == 0)
    }

    /// Distinct narration then a genuinely NEW final: the narration is NOT the
    /// answer twin and must survive (only the typed final's own text is dropped).
    @Test func distinctNarrationBeforeANewFinalSurvives() {
        var r = TranscriptReducer()
        r.apply(message(1, "Looking into it…"))
        r.apply(finalMessage(2, "The answer is 42."))
        #expect(r.blocks.count == 1)
        guard case .message(_, let text) = r.blocks.first else {
            Issue.record("expected the distinct narration to remain")
            return
        }
        #expect(text == "Looking into it…")
    }

    /// A tool/thinking block between the finalized message and the typed final
    /// (the twin is no longer the tail): it is still removed by id, and the
    /// intervening tool row and its later result stay correctly correlated.
    @Test func finalizedTwinIsRemovedAcrossAnInterveningTool() {
        var r = TranscriptReducer()
        r.apply(message(1, "done"))                 // the twin (non-final)
        r.apply(toolCall(2, target: "ls", useId: "u1"))
        r.apply(finalMessage(3, "done"))            // removes msg-1
        r.apply(toolResult(4, useId: "u1", detail: "ok"))
        let messages = r.blocks.filter { if case .message = $0 { return true }; return false }
        #expect(messages.isEmpty)
        // The tool result still landed on the intervening tool (index repaired).
        guard case .tool(_, let block) = r.blocks.last else {
            Issue.record("expected the intervening tool block")
            return
        }
        #expect(block.status == .ok)
        #expect(block.detail == "ok")
    }

    @Test func toolFloodRespectsTheTotalBudgetLikeAnyOtherText() {
        var r = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 3_000, toolFieldCap: 500)
        for i in 1...20 { r.apply(toolCall(i, target: String(repeating: "c", count: 500))) }
        #expect(r.textChars <= 3_000)
        #expect(r.trimmed > 0)
        let held = r.blocks.reduce(0) { sum, block in
            guard case .tool(_, let b) = block else { return sum }
            return sum + b.name.count + (b.kind?.count ?? 0) + (b.target?.count ?? 0) + (b.detail?.count ?? 0)
        }
        #expect(held == r.textChars)
    }
}
