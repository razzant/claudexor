import Foundation

/// One dispatched Server-Sent Event.
public struct SSEFrame: Sendable, Equatable {
    public let id: Int?
    public let event: String
    public let data: String

    public init(id: Int?, event: String, data: String) {
        self.id = id
        self.event = event
        self.data = data
    }
}

/// Incremental byte-level SSE parser per the WHATWG EventSource spec.
///
/// Foundation's `URLSession.AsyncBytes.lines` swallows the EMPTY lines that
/// delimit SSE events (the documented `.lines`-for-SSE pitfall), which is
/// exactly the bug that froze every live run view in v0.7. This parser works
/// on raw bytes: it splits on `\n`, trims a trailing `\r` (CRLF servers),
/// accumulates `data:` lines, ignores `:` comments/heartbeats, tracks the last
/// `id:` for Last-Event-ID resume, and dispatches a frame on each blank line.
public struct SSEParser: Sendable {
    private var buffer: [UInt8] = []
    private var dataLines: [String] = []
    private var eventName = "message"
    private var frameId: Int?
    private var lastSeenId: Int?

    public init() {}

    /// Feed a chunk of bytes; returns every frame completed by this chunk.
    public mutating func feed(_ chunk: some Sequence<UInt8>) -> [SSEFrame] {
        buffer.append(contentsOf: chunk)
        var frames: [SSEFrame] = []
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            var lineEnd = newlineIndex
            if lineEnd > 0, buffer[lineEnd - 1] == 0x0D { lineEnd -= 1 } // CRLF
            let line = String(decoding: buffer[0..<lineEnd], as: UTF8.self)
            buffer.removeFirst(newlineIndex + 1)
            if let frame = consume(line: line) { frames.append(frame) }
        }
        return frames
    }

    private mutating func consume(line: String) -> SSEFrame? {
        if line.isEmpty {
            // Blank line = dispatch. Per spec, an event with an empty data
            // buffer resets state without dispatching.
            defer {
                dataLines = []
                eventName = "message"
                frameId = nil
            }
            guard !dataLines.isEmpty else { return nil }
            return SSEFrame(id: frameId ?? lastSeenId, event: eventName, data: dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil } // comment / heartbeat
        let (field, value) = Self.splitField(line)
        switch field {
        case "id":
            if let id = Int(value) {
                frameId = id
                lastSeenId = id
            }
        case "event":
            eventName = value
        case "data":
            dataLines.append(value)
        default:
            break // unknown fields are ignored per spec
        }
        return nil
    }

    /// "field: value" — the colon separator with at most ONE leading space
    /// stripped from the value (WHATWG field parsing).
    private static func splitField(_ line: String) -> (String, String) {
        guard let colon = line.firstIndex(of: ":") else { return (line, "") }
        let field = String(line[line.startIndex..<colon])
        var valueStart = line.index(after: colon)
        if valueStart < line.endIndex, line[valueStart] == " " {
            valueStart = line.index(after: valueStart)
        }
        return (field, String(line[valueStart...]))
    }
}
