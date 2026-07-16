import SwiftUI
import ClaudexorKit

/// W21 (Квиз-7a): ONE owner reconciles a turn's terminal presentation from
/// three ORTHOGONAL axes — the execution terminal (`RunStatus`), the
/// delivery/apply state (`RunResult.applyState`), and the review gate — into a
/// headline that names at most TWO material facts ("Applied · review blocked"),
/// with everything else demoted to chips. Composition is the point: an
/// applied-but-review-blocked turn must NEVER read as a single clean winner,
/// and a failed terminal must never be drowned out by a delivery fact.
enum OutcomePresentation {
    struct Line: Equatable {
        var headline: String
        var tone: Tone
        var chips: [Chip]
    }

    struct Chip: Equatable {
        var text: String
        var tone: Tone
    }

    enum Tone: Equatable {
        case success, warning, failure, neutral

        var color: Color {
            switch self {
            case .success: return Theme.status(.succeeded)
            case .warning: return Theme.status(.blocked)
            case .failure: return Theme.status(.failed)
            case .neutral: return .secondary
            }
        }
    }

    /// Execution terminals that must LEAD the headline (a delivery fact never
    /// outranks a failure-shaped end). Cancelled is neutral, not red.
    private static let failureShaped: Set<RunStatus> = [
        .failed, .interrupted, .costUnverifiable, .exhaustedOvershoot,
        .exhausted, .notConverged, .stuckNoProgress, .unknown,
    ]

    /// The composed line for a TERMINAL turn; nil while active or when no axis
    /// produced a material fact (a plain answer needs no outcome row).
    static func line(status: RunStatus, result: RunResult?, reviewVerdict: ReviewVerdict) -> Line? {
        guard status.isTerminal else { return nil }
        // Ordered material facts: execution failure > delivery > review gate.
        var facts: [(text: String, tone: Tone)] = []

        if failureShaped.contains(status) {
            facts.append((status.label, .failure))
        } else if status == .cancelled {
            facts.append((status.label, .neutral))
        }

        switch result?.applyState {
        case "applied":
            facts.append((result?.adopted == true ? "Winner applied" : "Applied", .success))
        case "applied_review_blocked":
            // BOTH facts, always — never one victorious "Applied".
            facts.append(("Applied", .success))
            facts.append(("review blocked", .warning))
        case "reverted":
            facts.append(("Reverted", .neutral))
        default:
            if result?.kind == "patch", result?.adopted == true {
                facts.append(("Winner adopted", .success))
            }
        }

        // Review gate — only when the apply state has not already voiced it.
        if result?.applyState != "applied_review_blocked" {
            switch status {
            case .blocked: facts.append(("blocked on your decision", .warning))
            case .needsReview: facts.append(("needs review", .warning))
            case .ungated: facts.append(("ungated", .warning))
            case .reviewNotRun: facts.append(("review not run", .neutral))
            default:
                if reviewVerdict == .findings { facts.append(("review findings", .warning)) }
            }
        }
        // Chip-only facts: confirmations and counts never claim a headline
        // slot — the headline names states the user must RECONCILE.
        var chipOnly: [Chip] = []
        if reviewVerdict == .clean { chipOnly.append(Chip(text: "review clean", tone: .success)) }
        if let blockers = result?.blockers, blockers > 0 {
            chipOnly.append(Chip(text: "\(blockers) blocker\(blockers == 1 ? "" : "s")", tone: .warning))
        }

        guard !facts.isEmpty || !chipOnly.isEmpty else { return nil }
        guard !facts.isEmpty else { return nil }
        let head = facts.prefix(2)
        let overflow = facts.dropFirst(2).map { Chip(text: $0.text, tone: $0.tone) }
        var headline = head.map(\.text).joined(separator: " · ")
        headline = headline.prefix(1).uppercased() + headline.dropFirst()
        return Line(
            headline: headline,
            // The headline's tone is its most severe fact.
            tone: head.map(\.tone).max(by: { severity($0) < severity($1) }) ?? .neutral,
            chips: overflow + chipOnly
        )
    }

    private static func severity(_ tone: Tone) -> Int {
        switch tone {
        case .neutral: return 0
        case .success: return 1
        case .warning: return 2
        case .failure: return 3
        }
    }
}
