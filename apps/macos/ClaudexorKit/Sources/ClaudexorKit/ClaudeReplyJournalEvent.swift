import CryptoKit
import Foundation

/// A user-paged event read. Retains one page and the running checksum.
public struct ClaudeReplyJournalEvent {
    public static let pageBytes = 8192

    public struct Part: Decodable, Sendable {
        struct Projection: Decodable, Sendable {
            let source: ClaudeTurnReplies.Source
            let partSha256: String
        }
        let runId: String
        let seq: Int
        let type: String
        let offset: Int
        let nextOffset: Int
        let totalBytes: Int
        let sha256: String
        let text: String
        let claudeTurnReply: Projection?
    }

    public let runID: String
    public let seq: Int
    private let expected: ClaudeTurnReplies.Reply?
    private var digest = SHA256()
    private var last: Part?
    public private(set) var text = ""
    public private(set) var source: ClaudeTurnReplies.Source?
    public var offset: Int { last?.offset ?? 0 }
    public var nextOffset: Int { last?.nextOffset ?? 0 }
    public var totalBytes: Int { last?.totalBytes ?? 0 }
    public var complete: Bool { last != nil && nextOffset == totalBytes }
    public var isRawPage: Bool { last != nil && source == nil }

    public init(runID: String, seq: Int, expected: ClaudeTurnReplies.Reply? = nil) {
        self.runID = runID
        self.seq = seq
        self.expected = expected
    }

    public mutating func accept(_ part: Part) throws {
        guard part.runId == runID, part.seq == seq, seq > 0, part.offset == nextOffset,
              part.nextOffset > part.offset, part.nextOffset <= part.totalBytes,
              part.nextOffset - part.offset <= Self.pageBytes,
              part.nextOffset - part.offset == part.text.utf8.count, isLowercaseHexSHA256(part.sha256)
        else { throw GatewayError.decoding("The journal page does not match its address or byte range.") }
        if let last {
            guard part.sha256 == last.sha256, part.totalBytes == last.totalBytes, part.type == last.type,
                  part.claudeTurnReply?.source == last.claudeTurnReply?.source
            else { throw GatewayError.decoding("The journal event changed between pages.") }
        }
        let bytes = Data(part.text.utf8)
        var nextDigest = digest
        nextDigest.update(data: bytes)
        if part.nextOffset == part.totalBytes, Self.hex(nextDigest.finalize()) != part.sha256 {
            throw GatewayError.decoding("The journal event checksum did not match.")
        }
        var pageSource = part.claudeTurnReply?.source
        var pageText = part.text
        if let projection = part.claudeTurnReply {
            guard part.type == "harness.event", Self.hex(SHA256.hash(data: bytes)) == projection.partSha256
            else { throw GatewayError.decoding("The reply page checksum or type did not match.") }
        } else if part.offset == 0, part.nextOffset == part.totalBytes {
            let raw = try JSONDecoder().decode(JSONValue.self, from: bytes)
            let frame = BusEnvelope(seq: seq, kind: part.type, event: raw)
            guard ClaudeTurnReplies.matchesAddress(frame, runID: runID), raw["type"]?.stringValue == part.type
            else { throw GatewayError.decoding("The stored event has a different identity.") }
            if let reply = ClaudeTurnReplies.journalReply(in: frame) {
                pageSource = reply.source
                pageText = reply.text
            }
        }
        if let expected {
            guard expected.seq == seq else { throw GatewayError.decoding("The card names a different event.") }
            if let pageSource {
                let remainingPreview = expected.text.utf8.dropFirst(part.offset)
                let totalTextBytes = part.claudeTurnReply == nil ? pageText.utf8.count : part.totalBytes
                guard expected.source == nil || expected.source == pageSource,
                      pageText.utf8.starts(with: remainingPreview.prefix(pageText.utf8.count)),
                      expected.text.utf8.count <= totalTextBytes,
                      expected.truncated || expected.text.utf8.count == totalTextBytes
                else { throw GatewayError.decoding("The addressed event does not match the card preview.") }
            } else if part.offset == 0 && part.nextOffset == part.totalBytes {
                throw GatewayError.decoding("The addressed event does not contain the expected reply.")
            }
        }
        digest = nextDigest
        last = part
        source = pageSource
        text = pageText
    }

    /// The addressed part pins the checksum. Copy can take the entire row
    /// from one replay, including when an older engine serves raw JSON parts.
    func fullReply(from frame: SSEFrame) throws -> String {
        guard frame.id == String(seq), frame.event == "harness.event"
        else { throw GatewayError.decoding("The saved reply is unavailable at this event.") }
        return try verifiedReply(in: frame.data)
    }

    fileprivate func verifiedReply(in json: String) throws -> String {
        guard let last, last.type == "harness.event",
              let raw = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        else { throw GatewayError.decoding("The saved event is not a Claude reply.") }
        let event = BusEnvelope(seq: seq, kind: last.type, event: raw)
        guard ClaudeTurnReplies.matchesAddress(event, runID: runID),
              let reply = ClaudeTurnReplies.journalReply(in: event),
              last.claudeTurnReply.map({ $0.source == reply.source }) ?? true,
              expected?.source == nil || expected?.source == reply.source,
              reply.text.utf8.starts(with: (expected?.text ?? "").utf8),
              expected?.truncated != false || expected?.text.utf8.count == reply.text.utf8.count
        else { throw GatewayError.decoding("The journal reply does not match the card.") }
        let bytes = Data((last.claudeTurnReply == nil ? json : reply.text).utf8)
        guard bytes.count == last.totalBytes, Self.hex(SHA256.hash(data: bytes)) == last.sha256
        else { throw GatewayError.decoding("The saved reply changed during the read.") }
        return reply.text
    }

    private static func hex(_ digest: SHA256.Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}

extension GatewayClient {
    public func fullClaudeReply(runID: String, reply: ClaudeTurnReplies.Reply,
                               firstPart: ClaudeReplyJournalEvent.Part) async throws -> String {
        try Task.checkCancellation()
        var event = ClaudeReplyJournalEvent(runID: runID, seq: reply.seq, expected: reply)
        try event.accept(firstPart)
        if event.complete, event.source != nil { return event.text }
        // A replay can supply all the bytes at once. Only the addressed parts
        // decide availability when its first frame cannot prove the same row.
        do {
            for try await frame in sseFrames(path: "runs/\(runID)/events", replaySeq: reply.seq) {
                if frame.event == "error",
                   (try? Self.decoder.decode(ControlProblem.self, from: Data(frame.data.utf8)))?.code == "run_expired_by_retention" {
                    throw GatewayError.http(status: 410, body: frame.data)
                }
                if let text = try? event.fullReply(from: frame) {
                    try Task.checkCancellation()
                    return text
                }
                break
            }
        } catch GatewayError.http(410, let body) {
            throw GatewayError.http(status: 410, body: body)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            try Task.checkCancellation()
        }
        var contents = firstPart.text
        while !event.complete {
            try Task.checkCancellation()
            let part = try await claudeReplyJournalPart(runId: runID, seq: reply.seq, offset: event.nextOffset)
            try event.accept(part)
            contents.append(part.text)
        }
        try Task.checkCancellation()
        return firstPart.claudeTurnReply == nil ? try event.verifiedReply(in: contents) : contents
    }

    public func claudeReplyJournalPart(runId: String, seq: Int, offset: Int) async throws -> ClaudeReplyJournalEvent.Part {
        let query = [URLQueryItem(name: "offset", value: String(offset)),
                     URLQueryItem(name: "limit", value: String(ClaudeReplyJournalEvent.pageBytes))]
        return try await historyRead("runs/\(runId)/events/\(seq)", query: query,
                                     replyProjection: true, as: ClaudeReplyJournalEvent.Part.self)
    }
}
