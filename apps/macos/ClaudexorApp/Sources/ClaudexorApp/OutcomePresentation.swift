import SwiftUI
import ClaudexorKit

/// W21 (Quiz-7a): ONE owner reconciles a turn's terminal presentation from
/// three ORTHOGONAL v3 axes — the lifecycle terminal (`RunPhase` + typed
/// `RunReason`), the delivery/apply state (`RunResult.applyState`), and the
/// review gate (`ReviewVerdict`) — into a headline that names at most TWO
/// material facts ("Applied · review blocked"), with everything else demoted to
/// chips. Composition is the point: an applied-but-review-blocked turn must
/// NEVER read as a single clean winner, and a failed terminal must never be
/// drowned out by a delivery fact.
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
            case .success: return Theme.status(.positive)
            case .warning: return Theme.status(.caution)
            case .failure: return Theme.status(.negative)
            case .neutral: return .secondary
            }
        }
    }

    /// The composed line for a TERMINAL turn; nil while active or when no axis
    /// produced a material fact (a plain answer needs no outcome row). Driven by
    /// the honest v3 axes: `phase` is the lifecycle terminal, `reason` the typed
    /// `RunOutcomeFacts.reason` qualifying a non-clean end, `reviewVerdict` the
    /// review gate — no mixed status enum, no client-side banner composition.
    static func line(phase: RunPhase, reason: String?, result: RunResult?, reviewVerdict: ReviewVerdict) -> Line? {
        guard phase.isTerminal else { return nil }
        // Ordered material facts: execution failure > delivery > review gate.
        var facts: [(text: String, tone: Tone)] = []

        if phase.isFailureShaped {
            // A typed reason names the failure precisely ("Cost unverifiable",
            // "Budget overshot"); otherwise the bare lifecycle word.
            facts.append((RunReasonLabel.label(reason) ?? phase.label, .failure))
        } else if phase == .cancelled {
            facts.append((phase.label, .neutral))
        }

        // The ONE apply-state mapper (RunFacts, W4.5) — the detail header and
        // this line can no longer drift vocabularies.
        if let apply = RunFacts.applyFact(state: result?.applyState, adopted: result?.adopted == true) {
            facts.append((apply.text, apply.tone))
        } else if result?.kind == "patch", result?.adopted == true {
            facts.append(("Winner adopted", .success))
        }

        // Review gate — only when the apply state has not already voiced it.
        // The gate word comes from the honest review verdict, not a status enum.
        if result?.applyState != "applied_review_blocked" {
            switch reviewVerdict {
            case .findings: facts.append(("Needs review", .warning))
            case .ungated: facts.append(("Ungated", .warning))
            default: break
            }
        }
        // Chip-only facts: confirmations and counts never claim a headline
        // slot — the headline names states the user must RECONCILE.
        var chipOnly: [Chip] = []
        if reviewVerdict == .clean { chipOnly.append(Chip(text: "review clean", tone: .success)) }
        if let blockers = result?.blockers, blockers > 0 {
            chipOnly.append(Chip(text: "\(blockers) blocker\(blockers == 1 ? "" : "s")", tone: .warning))
        }

        // Chip-only facts without a headline fact have nothing to attach to:
        // a bare "review clean" row would just duplicate the status pill.
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
