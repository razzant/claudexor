import Foundation
import Testing
@testable import ClaudexorKit

/// W23 regression tests: the transcript's MEASURABLE memory invariant —
/// text characters per run are hard-bounded (per block and in total), with
/// every cut disclosed. These catch the 30GB-hang class: an unbounded
/// thinking merge that SwiftUI then laid out on the main thread.
@Suite struct TranscriptBoundsTests {
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
