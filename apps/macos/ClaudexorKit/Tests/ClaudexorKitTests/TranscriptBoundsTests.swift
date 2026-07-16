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
        guard case .thinking(_, let text) = r.blocks.last else {
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
            if case .thinking(_, let text) = block { return sum + text.count }
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
}
