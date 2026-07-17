import SwiftUI
import ClaudexorKit

/// The live working-progress feed of a turn (reasoning + narration + tools),
/// extracted from `TurnCard` so the transcript rendering has one owner
/// (INV-124). Ф2.5 W-C3/W-C6: reasoning segments disclose their observed
/// duration, mid-run narration reads DIMMED (the final answer is the W22
/// bubble — it never appears here), and tool rows lead with a humane short
/// title; the raw command/target stays one disclosure away, never lost.
struct TranscriptView: View {
    let blocks: [TranscriptBlock]
    /// Oldest blocks the reducer's cap dropped (honest truncation marker).
    var trimmedOlder: Int = 0
    /// Characters the reducer's per-block byte bound cut (W23) — disclosed.
    var truncatedChars: Int = 0
    /// Image/file scope for narration markdown (thread repoRoot / run dir).
    var fileScopeRoots: [String] = []

    var body: some View {
        // W4.4 (В9а): a FLAT log — one line per tool, grouped runs, a single
        // timer line for thinking. Zero inline chevrons; the raw reasoning
        // text and full tool output live in the run inspector only.
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if trimmedOlder > 0 || truncatedChars > 0 {
                Text(truncationNote)
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            ForEach(TranscriptPresentation.rows(blocks)) { row in
                switch row {
                case .thinking(_, let seconds):
                    Label(Self.thinkingLabel(seconds: seconds), systemImage: "circle.lefthalf.filled")
                        .font(.caption).foregroundStyle(.secondary)
                case .tool(_, let tool):
                    ToolRow(tool: tool)
                case .toolGroup(_, let name, let kind, let count):
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Theme.status(.succeeded))
                            .font(.caption2)
                        Image(systemName: ToolRow.kindGlyph(kind))
                            .foregroundStyle(.secondary)
                            .font(.caption2)
                        Text("\(name) · \(count) calls")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                case .message(_, let text):
                    // Mid-run NARRATION (a typed final never reaches the
                    // transcript): markdown, but dimmed — the finish must not
                    // compete with its own progress notes.
                    MarkdownOutputView(markdown: text, fileScopeRoots: fileScopeRoots)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .opacity(0.7)
                }
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    /// "Thinking · 12s" / "Thinking · 2m 05s" once the segment's span is
    /// known from event timestamps; a plain "Thinking" while unknown (0).
    static func thinkingLabel(seconds: Double) -> String {
        guard seconds >= 1 else { return "Thinking" }
        let s = Int(seconds)
        return s < 60
            ? "Thinking · \(s)s"
            : "Thinking · \(s / 60)m \(String(format: "%02d", s % 60))s"
    }

    private var truncationNote: String {
        var parts: [String] = []
        if trimmedOlder > 0 { parts.append("\(trimmedOlder) earlier transcript blocks collapsed") }
        if truncatedChars > 0 { parts.append("\(truncatedChars) characters of overlong blocks bounded") }
        return parts.joined(separator: " · ") + " — the full stream lives in the run's events.jsonl artifact."
    }
}

/// One tool call/result row (W-C6/W4.4): a kind icon + short humane title
/// lead — ONE line, no chevron; the full output lives in the run inspector.
/// A FAILED tool carries its error summary as a second dimmed line (its
/// status is the information); everything else stays a single quiet row.
struct ToolRow: View {
    let tool: ToolBlock

    var body: some View {
        if tool.status == .error, let error = errorLine {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                header
                Text(error)
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.status(.failed).opacity(0.85))
                    .lineLimit(3)
                    .textSelection(.enabled)
                    .padding(.leading, Theme.Spacing.lg)
            }
        } else {
            header
        }
    }

    /// The failed tool's honest reason (bounded by the reducer upstream).
    private var errorLine: String? {
        let detail = (tool.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !detail.isEmpty { return detail }
        if let code = tool.exitCode, code != 0 { return "exit \(code)" }
        return nil
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: statusGlyph)
                .foregroundStyle(statusColor)
                .font(.caption2)
            Image(systemName: Self.kindGlyph(tool.kind))
                .foregroundStyle(.secondary)
                .font(.caption2)
            Text(Self.title(tool))
                .font(.caption.weight(.medium))
                .textSelection(.enabled)
            if let subtitle = Self.subtitle(tool), !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .textSelection(.enabled)
            }
            Spacer()
            if let code = tool.exitCode, code != 0 {
                Text("exit \(code)").font(.caption2).foregroundStyle(Theme.status(.failed))
            }
        }
    }

    /// Short humane title. For a command, the binary's basename from the
    /// TYPED target (first whitespace token) — presentation shortening of a
    /// typed field, not prose governance. Other kinds keep the tool name.
    static func title(_ tool: ToolBlock) -> String {
        guard tool.kind == "command",
              let target = tool.target?.trimmingCharacters(in: .whitespaces),
              !target.isEmpty
        else { return tool.name }
        let first = target.split(separator: " ", maxSplits: 1).first.map(String.init) ?? target
        return first.split(separator: "/").last.map(String.init) ?? first
    }

    /// The single-line context after the title: a command shows its (bounded
    /// by the reducer) full target; other kinds show their target verbatim.
    static func subtitle(_ tool: ToolBlock) -> String? {
        guard let target = tool.target, !target.isEmpty else { return nil }
        // Don't repeat a target that IS the title (e.g. bare "ls").
        return target == title(tool) ? nil : target
    }

    /// SF Symbol per typed ToolKind (schema vocabulary: web/file/command/
    /// mcp/search/other) — every name is exercised by a unit test, so a
    /// bad symbol never renders as an invisible blank.
    static func kindGlyph(_ kind: String?) -> String {
        switch kind {
        case "command": return "terminal"
        case "web": return "globe"
        case "file": return "doc.text"
        case "mcp": return "puzzlepiece.extension"
        case "search": return "magnifyingglass"
        default: return "wrench.and.screwdriver"
        }
    }

    private var statusGlyph: String {
        switch tool.status {
        case .running: return "circle.dotted"
        case .ok: return "checkmark.circle.fill"
        case .error: return "xmark.circle.fill"
        }
    }
    private var statusColor: Color {
        switch tool.status {
        case .running: return .secondary
        case .ok: return Theme.status(.succeeded)
        case .error: return Theme.status(.failed)
        }
    }
}
