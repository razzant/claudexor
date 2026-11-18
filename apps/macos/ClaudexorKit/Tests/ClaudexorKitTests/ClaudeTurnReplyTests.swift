import CryptoKit
import Foundation
import Testing
@testable import ClaudexorKit

struct ClaudeTurnReplyTests {
    private func event(_ seq: Int, type: String = "message", _ text: String,
                       harness: String = "claude", final: Bool = false,
                       attempt: String = "a01", session: String? = "session", stopped: Bool? = false,
                       meta: [String: JSONValue] = [:]) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "run_id": .string("r"), "seq": .number(Double(seq)),
            "type": .string("harness.event"), "payload": .object([
                "type": .string(type), "text": .string(text), "harness_id": .string(harness),
                "attempt_id": .string(attempt), "session_id": session.map(JSONValue.string) ?? .null,
                "after_stop": stopped.map(JSONValue.bool) ?? .null,
                "final": .bool(final), "payload": .object(meta),
            ]),
        ]))
    }

    @Test func concurrentAttemptsAndUnknownProvenanceRetainTheirOwnAddresses() {
        var fold = TranscriptReducer()
        fold.apply(event(1, "Same", final: true), replyRunID: "r")
        fold.apply(event(2, "Same", final: true, attempt: "b", session: "other"), replyRunID: "r")
        fold.apply(event(3, "Saved before Stop", final: true, session: nil), replyRunID: "r")
        fold.apply(event(4, "Only drained", final: true, stopped: true), replyRunID: "r")
        fold.apply(event(5, "Old receipt", final: true, stopped: nil), replyRunID: "r")
        let rows = fold.claudeTurnReplies.rows
        #expect(rows.map(\.seq) == [1, 2, 3, 5])
        #expect(rows.map { $0.source?.attemptId } == ["a01", "b", "a01", "a01"])
        #expect(rows.map { $0.source?.sessionId } == ["session", "other", nil, "session"])
        #expect(rows.filter(\.isTurnReply).map(\.text) == ["Same", "Same", "Saved before Stop"])
        #expect(rows.last?.text.isEmpty == true)
    }

    @Test func twoResultsSurviveTheirActivityTwinsAndReplay() throws {
        var fold = TranscriptReducer()
        fold.apply(event(1, "Checking"), replyRunID: "r")
        fold.apply(event(2, "First answer"), replyRunID: "r")
        let first = event(3, "First answer", final: true)
        fold.apply(first, replyRunID: "r")
        fold.apply(event(4, type: "status", "", meta: ["code": .string("native_turn_started")]), replyRunID: "r")
        fold.apply(event(5, "Correct", meta: ["delta": .bool(true)]), replyRunID: "r")
        fold.apply(event(6, "Corrected answer"), replyRunID: "r")
        let correction = event(7, "Corrected answer", final: true)
        fold.apply(correction, replyRunID: "r")
        fold.apply(correction, replyRunID: "r")
        fold.apply(event(8, type: "status", "Failure detail", meta: ["non_success_result": .bool(true)]), replyRunID: "r")
        fold.apply(event(9, type: "error", "Failure detail"), replyRunID: "r")
        fold.apply(event(10, "Different harness", harness: "codex", final: true), replyRunID: "r")
        fold.apply(event(11, "", final: true), replyRunID: "r")
        fold.apply(BusEnvelope(seq: 12, kind: "output.ready", event: .object(["type": .string("output.ready")])))
        #expect(fold.blocks == [.message(id: "msg-1", text: "Checking")])
        #expect(fold.claudeTurnReplies.rows.map(\.text) == ["First answer", "Corrected answer"])
        let saved = try JSONDecoder().decode(ClaudeTurnReplies.self, from: Data(
            #"{"rows":[{"seq":3,"text":"First answer","truncated":false}],"partial":false}"#.utf8))
        #expect(saved.merging(fold.claudeTurnReplies) == fold.claudeTurnReplies)
        #expect(!fold.claudeTurnReplies.partial)
    }

    @Test func repeatedWordsAreSeparateRepliesAndBoundsRespectUTF8() {
        var fold = TranscriptReducer()
        for seq in 1...4 { fold.apply(event(seq, "Same", final: true), replyRunID: "r") }
        let prefix = String(repeating: "a", count: 8191)
        fold.apply(event(5, prefix + "🍎", final: true), replyRunID: "r")
        #expect(fold.claudeTurnReplies.rows.map(\.seq) == [2, 3, 4, 5])
        #expect(fold.claudeTurnReplies.partial)
        #expect(fold.claudeTurnReplies.rows.last?.text == prefix)
        #expect(fold.claudeTurnReplies.rows.last?.truncated == true)
    }

    private func hash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    @Test func addressedReplyPagesVerifyBytesAndIdentityBeforeReplacingTheVisiblePage() throws {
        let source = ClaudeTurnReplies.Source(attemptId: "a", sessionId: "s", afterStop: false)
        let expected = ClaudeTurnReplies.Reply(seq: 8, source: source, text: "rés", truncated: true)
        let whole = "résumé 🍎"
        func part(_ text: String, at offset: Int, run: String = "r", seq: Int = 8,
                  origin: ClaudeTurnReplies.Source? = nil, checksum: String? = nil) -> ClaudeReplyJournalEvent.Part {
            .init(runId: run, seq: seq, type: "harness.event", offset: offset,
                  nextOffset: offset + text.utf8.count, totalBytes: whole.utf8.count,
                  sha256: hash(whole), text: text,
                  claudeTurnReply: .init(source: origin ?? source, partSha256: checksum ?? hash(text)))
        }
        var read = ClaudeReplyJournalEvent(runID: "r", seq: 8, expected: expected)
        for invalid in [part("rés", at: 0, run: "elsewhere"), part("rés", at: 0, seq: 7),
                        part("", at: 0), part("rés", at: 1), part("rét", at: 0),
                        part("rés", at: 0, checksum: hash("other"))] {
            #expect(throws: GatewayError.self) { try read.accept(invalid) }
            #expect(read.nextOffset == 0)
        }
        try read.accept(part("rés", at: 0))
        let offset = read.nextOffset
        #expect(read.text == "rés" && !read.complete)
        let raw = #"{"run_id":"r","seq":8,"type":"harness.event","payload":{"type":"message","final":true,"harness_id":"claude","attempt_id":"a","session_id":"s","after_stop":false,"text":"résumé 🍎"}}"#
        func replay(_ data: String, id: String = "8") -> SSEFrame {
            SSEFrame(id: id, event: "harness.event", data: data)
        }
        #expect(try read.fullReply(from: replay(raw)) == whole)
        for foreign in [replay(raw, id: "9"), replay(raw.replacingOccurrences(of: #""run_id":"r""#, with: #""run_id":"other""#)),
                        replay(raw.replacingOccurrences(of: #""seq":8"#, with: #""seq":88"#)),
                        replay(raw.replacingOccurrences(of: "🍎", with: "🍏")),
                        replay(raw.replacingOccurrences(of: #""session_id":"s""#, with: #""session_id":"other""#))] {
            #expect(throws: GatewayError.self) { try read.fullReply(from: foreign) }
        }
        let foreign = ClaudeTurnReplies.Source(attemptId: "a", sessionId: "other", afterStop: false)
        #expect(throws: GatewayError.self) { try read.accept(part("umé 🍎", at: offset, origin: foreign)) }
        // A valid page checksum cannot override the mismatched whole-event digest.
        #expect(throws: GatewayError.self) { try read.accept(part("umé 🍏", at: offset)) }
        #expect(read.text == "rés" && read.nextOffset == offset)
        try read.accept(part("umé 🍎", at: offset))
        #expect(read.text == "umé 🍎" && read.complete && read.source == source)
    }

    @Test func defaultPartsFromAnOlderEngineKeepEvidenceAndCheckTheInnerEventAddress() throws {
        let raw = #"{"run_id":"r","seq":8,"type":"harness.event","payload":{"harness_id":"claude","type":"message","final":true,"attempt_id":"b","text":"Saved"}}"#
        func part(_ text: String) -> ClaudeReplyJournalEvent.Part {
            .init(runId: "r", seq: 8, type: "harness.event", offset: 0,
                  nextOffset: text.utf8.count, totalBytes: text.utf8.count,
                  sha256: hash(text), text: text, claudeTurnReply: nil)
        }
        var read = ClaudeReplyJournalEvent(runID: "r", seq: 8)
        for invalid in [raw.replacingOccurrences(of: #""seq":8"#, with: #""seq":7"#),
                        raw.replacingOccurrences(of: #""run_id":"r""#, with: #""run_id":"foreign""#)] {
            #expect(throws: GatewayError.self) { try read.accept(part(invalid)) }
        }
        try read.accept(part(raw))
        #expect(read.text == "Saved" && read.source?.attemptId == "b")
        #expect(read.source?.sessionId == nil && read.source?.afterStop == nil)
        #expect(read.source?.afterStop == nil && read.complete)
    }
}
