import Foundation
import ClaudexorKit

/// PURE fold of transcript blocks into the flat rows the chat renders (W4.4
/// V9a): one line per tool, runs of >3 same-name OK tools collapse into one
/// group row («Read · 6 calls»), thinking is a single timer line, and raw
/// output lives ONLY in the inspector. No inline chevrons anywhere. Honest
/// degradation: a stream without an event kind simply has no such rows.
enum TranscriptPresentation {
    enum Row: Equatable, Identifiable {
        case thinking(id: String, seconds: Double)
        case tool(id: String, ToolBlock)
        /// `count` consecutive OK calls of the same tool, one quiet line.
        case toolGroup(id: String, name: String, kind: String?, count: Int)
        case message(id: String, text: String)

        var id: String {
            switch self {
            case .thinking(let id, _): return id
            case .tool(let id, _): return id
            case .toolGroup(let id, _, _, _): return "group-\(id)"
            case .message(let id, _): return id
            }
        }
    }

    /// Consecutive OK tools with one name collapse once the run exceeds this.
    private static let groupThreshold = 3
    /// Chat is a progress summary, not the raw event artifact. Bound rendered
    /// rows and per-message text so a verbose multi-harness run cannot make
    /// SwiftUI lay out hundreds of rows / hundreds of thousands of characters.
    static let chatRowLimit = 80
    static let chatMessageCharLimit = 4_000

    static func rows(_ blocks: [TranscriptBlock]) -> [Row] {
        var rows: [Row] = []
        var pendingTools: [(id: String, tool: ToolBlock)] = []

        func flushTools() {
            guard !pendingTools.isEmpty else { return }
            if pendingTools.count > groupThreshold, let first = pendingTools.first {
                rows.append(.toolGroup(
                    id: first.id,
                    name: first.tool.name,
                    kind: first.tool.kind,
                    count: pendingTools.count
                ))
            } else {
                rows.append(contentsOf: pendingTools.map { .tool(id: $0.id, $0.tool) })
            }
            pendingTools.removeAll()
        }

        for block in blocks {
            switch block {
            case .thinking(let id, _, let seconds):
                flushTools()
                rows.append(.thinking(id: id, seconds: seconds))
            case .message(let id, let text):
                flushTools()
                rows.append(.message(id: id, text: text))
            case .tool(let id, let tool):
                // Only quiet successes group; a running or failed tool always
                // stands alone (its status is the information).
                if tool.status == .ok,
                   pendingTools.isEmpty || pendingTools.last?.tool.name == tool.name {
                    pendingTools.append((id, tool))
                } else {
                    flushTools()
                    if tool.status == .ok {
                        pendingTools.append((id, tool))
                    } else {
                        rows.append(.tool(id: id, tool))
                    }
                }
            }
        }
        flushTools()
        return rows
    }

    static func chatRows(_ blocks: [TranscriptBlock]) -> (rows: [Row], omitted: Int) {
        let all = rows(blocks)
        let omitted = max(0, all.count - chatRowLimit)
        return (Array(all.suffix(chatRowLimit)), omitted)
    }

    static func chatMessage(_ text: String) -> (text: String, omittedCharacters: Int) {
        guard text.count > chatMessageCharLimit else { return (text, 0) }
        let omitted = text.count - chatMessageCharLimit
        return (
            String(text.prefix(chatMessageCharLimit))
                + "\n\n_\(omitted) more characters are available in Diagnostics / events.jsonl._",
            omitted
        )
    }
}
