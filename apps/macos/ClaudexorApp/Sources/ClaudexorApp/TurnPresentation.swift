import Foundation
import ClaudexorKit

/// PURE mapper for the chat turn card's messenger layout (W4.1/W4.2, sol #14):
/// run state -> the ONE status line (identity | state word | time | cash) and
/// the ONE attention chip. No views, no model — a unit-tested state matrix.
/// The card composes layout from these values; the pill is gone (W4.2): quiet
/// facts stay quiet, and attention states raise a single loud chip only when
/// they exist.
enum TurnPresentation {
    struct StatusLine: Equatable {
        /// "Codex" for an unambiguous single harness, "Best-of 3" for a race,
        /// nil when identity is unknown (a race's first harness may be a
        /// losing candidate — never guess, sol #19).
        var identity: String?
        /// The single-family identity for glyph/color, when unambiguous.
        var family: HarnessFamily?
        /// The QUIET state word: "Working…" (retry folds in: "Retrying 2/10")
        /// while active; the terminal label otherwise — or nil when the
        /// attention chip already voices the terminal state (no "Failed
        /// [Failed]" stutter).
        var stateWord: String?
    }

    /// The one LOUD element (W4.2): present only for states that need the
    /// user. Everything else renders quiet.
    struct Attention: Equatable {
        var text: String
        var tone: OutcomePresentation.Tone
    }

    /// The ONE loud chip, driven by the honest v3 axes: a pending question, a
    /// review gate awaiting your decision, or a failure-shaped terminal (named
    /// by its typed reason when present). Quiet states return nil.
    static func attention(
        phase: RunPhase, reason: String?, reviewNeedsDecision: Bool, waitingOnUser: Bool
    ) -> Attention? {
        if waitingOnUser { return Attention(text: "Needs your answer", tone: .warning) }
        if reviewNeedsDecision { return Attention(text: "Needs you", tone: .warning) }
        if phase.isFailureShaped {
            return Attention(text: RunReasonLabel.label(reason) ?? phase.label, tone: .failure)
        }
        return nil
    }

    static func statusLine(
        phase: RunPhase,
        reason: String?,
        harnesses: [HarnessFamily],
        n: Int,
        retryLabel: String?,
        reviewNeedsDecision: Bool,
        waitingOnUser: Bool
    ) -> StatusLine {
        let racing = n > 1 || harnesses.count > 1
        let identity: String?
        let family: HarnessFamily?
        if racing {
            identity = "Best-of \(max(n, harnesses.count))"
            family = nil
        } else if let single = harnesses.first {
            identity = single.label
            family = single
        } else {
            identity = nil
            family = nil
        }
        // The attention chip IS the state fact (W4.1 caps the line at four
        // facts): whenever a chip exists the quiet word yields — including a
        // waiting-active run, where "Needs your answer" outranks "Working…".
        let stateWord: String?
        if attention(phase: phase, reason: reason, reviewNeedsDecision: reviewNeedsDecision,
                     waitingOnUser: waitingOnUser) != nil {
            stateWord = nil
        } else if phase.isActive {
            stateWord = retryLabel ?? "Working…"
        } else {
            stateWord = phase.label
        }
        return StatusLine(identity: identity, family: family, stateWord: stateWord)
    }

    /// The Activity strip's counter label: «Thinking 40s · 9 tools · 3 files».
    /// Honest degradation: a component with no evidence is simply absent; an
    /// empty stream returns nil (no strip at all — never a hollow row).
    static func activitySummary(blocks: [TranscriptBlock]) -> String? {
        guard !blocks.isEmpty else { return nil }
        var thinkingSeconds = 0.0
        var tools = 0
        var files = 0
        for block in blocks {
            switch block {
            case .thinking(_, _, let seconds): thinkingSeconds += seconds
            case .tool(_, let tool):
                tools += 1
                if tool.kind == "file" { files += 1 }
            case .message: break
            }
        }
        var parts: [String] = []
        if thinkingSeconds >= 1 { parts.append("Thinking \(Int(thinkingSeconds))s") }
        if tools > 0 { parts.append("\(tools) tool\(tools == 1 ? "" : "s")") }
        if files > 0 { parts.append("\(files) file\(files == 1 ? "" : "s")") }
        return parts.isEmpty ? "Activity" : parts.joined(separator: " · ")
    }

    /// The CURRENT live activity as ONE line for a COLLAPSED active run's
    /// receipt: the most recent tool or thinking entry (skipping narration
    /// messages), so progress stays visible without expanding the transcript
    /// (e.g. «bash python3 -m http.server 4173»). Derived from the same typed
    /// transcript blocks the expanded view renders — never invented. nil when
    /// nothing has happened yet (no hollow line). Bounded so a runaway target
    /// can't balloon the row; the view still clamps to one line.
    static func lastActivityLine(blocks: [TranscriptBlock]) -> String? {
        for block in blocks.reversed() {
            switch block {
            case .tool(_, let tool):
                let title = ToolRow.title(tool)
                let line = ToolRow.subtitle(tool).map { "\(title) \($0)" } ?? title
                return String(line.prefix(140))
            case .thinking(_, _, let seconds):
                return seconds >= 1 ? "Thinking · \(Int(seconds))s" : "Thinking"
            case .message:
                continue
            }
        }
        return nil
    }
}
