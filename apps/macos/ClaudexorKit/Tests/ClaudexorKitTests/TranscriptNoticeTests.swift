import Foundation
import Testing
@testable import ClaudexorKit

/// #563: an engine receipt in the transcript keeps the reducer's invariants:
/// one block per id, the same per-block character bound (disclosed), and a
/// receipt restored before later blocks does not misplace an open tool's result.
@Suite struct TranscriptNoticeTests {
    private func prepared(_ seq: Int, missing: [String]) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "workspace.prepared", event: .object([
            "type": .string("workspace.prepared"),
            "payload": .object([
                "attempt_id": .string("a01"), "source_root": .string("/work"),
                "scope_paths": .array(missing.map(JSONValue.string)),
                "copied": .object(["files": .number(0), "directories": .number(0), "symlinks": .number(0)]),
                "missing_paths": .array(missing.map(JSONValue.string)),
            ]),
        ]))
    }

    private func tool(_ seq: Int, _ type: String, status: String? = nil) -> BusEnvelope {
        var tool: [String: JSONValue] = ["name": .string("bash"), "use_id": .string("u1")]
        if let status { tool["status"] = .string(status) }
        return BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string(type), "tool": .object(tool)]),
        ]))
    }

    @Test func aPreparedEventIsOneWarningNotice() throws {
        var reducer = TranscriptReducer()
        let first = reducer.apply(prepared(1, missing: ["new.md"]))
        let replayed = reducer.apply(prepared(1, missing: ["new.md"]))
        let restoredAgain = reducer.applyNotice(id: TranscriptNotice.preparedId(attemptId: "a01"),
                                                TranscriptNotice(title: "x", text: "y", warning: false))
        #expect(first && !replayed && !restoredAgain)
        guard case .notice(let id, let notice)? = reducer.blocks.first, reducer.blocks.count == 1 else {
            Issue.record("expected exactly one notice block")
            return
        }
        #expect(id == "workspace.prepared-a01")
        #expect(notice.warning)
        #expect(notice.text.hasSuffix(#"Not found there when the copy was prepared: "new.md" (absent in the copy; may be created as new output)."#))
        #expect(reducer.textChars == notice.title.count + notice.text.count)
    }

    @Test func anOverlongReceiptIsBoundedAndDisclosed() {
        var reducer = TranscriptReducer(blockCharCap: 100)
        let paths = (0..<50).map { "out/file-\($0).md" }
        reducer.apply(prepared(1, missing: paths))
        guard case .notice(_, let notice)? = reducer.blocks.first else {
            Issue.record("expected a notice block")
            return
        }
        #expect(notice.text.count == 100)
        #expect(reducer.truncatedChars > 0)
    }

    @Test func aRestoredReceiptBeforeAnOpenToolKeepsItsResultInPlace() {
        var reducer = TranscriptReducer()
        reducer.apply(tool(5, "tool_call"))
        reducer.applyNotice(id: "workspace.prepared-a01",
                            TranscriptNotice(title: "Isolated workspace copy prepared", text: "t", warning: false),
                            atStart: true)
        reducer.apply(tool(6, "tool_result", status: "ok"))
        #expect(reducer.blocks.count == 2)
        guard case .notice? = reducer.blocks.first, case .tool(_, let block)? = reducer.blocks.last else {
            Issue.record("expected notice then tool")
            return
        }
        #expect(block.status == .ok)
    }

    private func message(_ seq: Int, _ text: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text)]),
        ]))
    }

    private let receipt = TranscriptNotice(
        title: "Isolated workspace copy prepared", text: String(repeating: "p", count: 30), warning: true)

    /// Restoring the same receipt into a full window (block cap) counts it once
    /// as an earlier block not shown; it never evicts another block, and a text
    /// bound is never disclosed for text that was not placed.
    @Test func aRestoredReceiptIntoAFullBlockWindowIsCountedOnce() {
        var reducer = TranscriptReducer(cap: 3, blockCharCap: 10)
        for seq in 1...3 { reducer.apply(message(seq, "m\(seq)")) }
        let before = reducer.blocks
        var placed: [Bool] = []
        for _ in 0..<3 { placed.append(reducer.applyNotice(id: "workspace.prepared-a01", receipt, atStart: true)) }
        #expect(placed == [false, false, false])
        #expect(reducer.blocks == before)
        #expect(reducer.trimmed == 1)
        #expect(reducer.truncatedChars == 0)
    }

    /// The same for the character budget, which the block count alone misses.
    @Test func aRestoredReceiptPastTheCharacterBudgetIsCountedOnce() {
        var reducer = TranscriptReducer(cap: 200, totalCharBudget: 50)
        reducer.apply(message(1, String(repeating: "x", count: 40)))
        let before = reducer.blocks
        for _ in 0..<3 { reducer.applyNotice(id: "workspace.prepared-a01", receipt, atStart: true) }
        #expect(reducer.blocks == before)
        #expect(reducer.trimmed == 1)
        #expect(reducer.truncatedChars == 0)
        #expect(reducer.textChars == 40)
    }

    /// A live receipt that later scrolls out is counted by ordinary eviction;
    /// restoring it afterwards does not bring it back or count it again.
    @Test func aLiveReceiptEvictedLaterIsNotRestoredOrRecounted() {
        var reducer = TranscriptReducer(cap: 2)
        reducer.apply(prepared(1, missing: ["new.md"]))
        reducer.apply(message(2, "m2"))
        reducer.apply(message(3, "m3"))
        #expect(reducer.trimmed == 1)
        #expect(reducer.blocks.map(\.id) == ["msg-2", "msg-3"])
        for _ in 0..<2 {
            reducer.applyNotice(id: "workspace.prepared-a01", receipt, atStart: true)
            reducer.apply(prepared(1, missing: ["new.md"]))
        }
        #expect(reducer.trimmed == 1)
        #expect(reducer.blocks.map(\.id) == ["msg-2", "msg-3"])
    }

    /// Below both bounds a restored receipt is placed first, keeping order.
    @Test func aRestoredReceiptWithRoomIsPlacedFirst() {
        var reducer = TranscriptReducer(cap: 3)
        reducer.apply(message(1, "m1"))
        let placed = reducer.applyNotice(id: "workspace.prepared-a01", receipt, atStart: true)
        #expect(placed)
        #expect(reducer.blocks.map(\.id) == ["workspace.prepared-a01", "msg-1"])
        #expect(reducer.trimmed == 0)
    }
}
