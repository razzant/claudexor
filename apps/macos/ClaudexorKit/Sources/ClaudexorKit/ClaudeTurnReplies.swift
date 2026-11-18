import Foundation

/// Bounded card previews of successful Claude result messages, identified by
/// their run journal sequence. The retained events own the complete text.
public struct ClaudeTurnReplies: Codable, Equatable, Sendable {
    public struct Source: Codable, Equatable, Sendable {
        public let attemptId: String?
        public let sessionId: String?
        public let afterStop: Bool?

        public var attribution: String {
            let attempt = attemptId.map { "Attempt \($0)" } ?? "Attempt unknown"
            let session = sessionId.map { "Session \($0)" } ?? "Session unknown"
            return "\(attempt) · \(session)"
        }
    }

    public struct Reply: Codable, Equatable, Identifiable, Sendable {
        public let seq: Int
        public let source: Source?
        public let text: String
        public let truncated: Bool
        public var id: Int { seq }
        public var isTurnReply: Bool { source?.afterStop == false }
    }

    public private(set) var rows: [Reply] = []
    public private(set) var partial = false

    public init(partial: Bool = false) { self.partial = partial }

    /// A journal address can remain useful even when an old producer did not
    /// record whether the message arrived before Stop.
    public static func journalReply(in event: BusEnvelope) -> (source: Source, text: String)? {
        guard event.event["type"]?.stringValue == "harness.event",
              let payload = event.event["payload"],
              payload["harness_id"]?.stringValue == "claude",
              payload["type"]?.stringValue == "message", payload["final"]?.boolValue == true,
              payload["buffered"]?.boolValue != true, payload["payload"]?["buffered"]?.boolValue != true,
              let text = payload["text"]?.stringValue, !text.isEmpty else { return nil }
        func id(_ field: String) -> String? {
            guard let id = payload[field]?.stringValue, !id.isEmpty else { return nil }
            return id
        }
        return (Source(attemptId: id("attempt_id"), sessionId: id("session_id"),
                       afterStop: payload["after_stop"]?.boolValue), text)
    }

    public static func matchesAddress(_ event: BusEnvelope, runID: String?) -> Bool {
        guard let runID, !runID.isEmpty else { return false }
        return event.seq > 0 && event.seq <= 9_007_199_254_740_991 &&
            event.event["run_id"]?.stringValue?.utf8.elementsEqual(runID.utf8) == true &&
            (event.event["seq"] == nil || event.event["seq"]?.doubleValue == Double(event.seq))
    }

    @discardableResult mutating func observe(_ event: BusEnvelope, runID: String?) -> Bool {
        guard Self.matchesAddress(event, runID: runID),
              event.seq > (rows.last?.seq ?? 0), let reply = Self.journalReply(in: event),
              reply.source.afterStop != true else { return false }
        let text = reply.source.afterStop == false ? reply.text : ""
        // Match the history page's UTF-8 preview budget at a scalar boundary.
        let bytes = text.utf8
        var end = bytes.index(bytes.startIndex, offsetBy: 8192, limitedBy: bytes.endIndex) ?? bytes.endIndex
        while end != bytes.endIndex && bytes[end] & 0xc0 == 0x80 { end = bytes.index(before: end) }
        rows.append(Reply(seq: event.seq, source: reply.source, text: String(decoding: bytes[..<end], as: UTF8.self),
                          truncated: reply.source.afterStop == nil || end != bytes.endIndex))
        if rows.count > 4 { rows.removeFirst(); partial = true }
        return true
    }

    public func merging(_ live: Self?) -> Self {
        guard let live, !live.rows.isEmpty else { return self }
        var result = self
        let bySeq = Dictionary((rows + live.rows).map { ($0.seq, $0) }, uniquingKeysWith: { _, latest in latest })
        result.rows = Array(bySeq.values.sorted { $0.seq < $1.seq }.suffix(4))
        result.partial = partial || live.partial || bySeq.count > result.rows.count
        return result
    }

    public static func forCard(history: Self?, live: Self?) -> Self {
        (history ?? Self(partial: true)).merging(live)
    }
}
