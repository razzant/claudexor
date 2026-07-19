import SwiftUI
import ClaudexorKit

/// THE owner of run FACTS and their formatting (W4.5 sol #16): every text,
/// glyph, tone, and help string a surface shows about a run's route, apply
/// state, output, web evidence, or budget is produced here exactly once.
/// Surfaces (TurnCard, Run Detail header) COMPOSE their own layouts from
/// these facts — layout stays per-surface, the facts never fork. The terminal
/// outcome LINE stays composed by `OutcomePresentation` (F2 W21), which
/// consumes the same single apply-state mapper below.
enum RunFacts {
    struct Fact: Identifiable, Equatable {
        let id: String
        let text: String
        let glyph: String?
        let tone: OutcomePresentation.Tone
        let help: String?
    }

    // MARK: Single-owner mappers

    /// The ONE apply-state mapper (previously forked between
    /// OutcomePresentation and TaskDetailBadges, drifting vocabularies).
    /// nil => not_applied/unknown: render nothing.
    static func applyFact(state: String?, adopted: Bool) -> (text: String, glyph: String, tone: OutcomePresentation.Tone)? {
        switch state {
        case "applied":
            return (adopted ? "Winner applied" : "Applied", "checkmark.seal.fill", .success)
        case "applied_review_blocked":
            // BOTH facts, always — never one victorious "Applied".
            return ("Applied · review blocked", "exclamationmark.triangle.fill", .warning)
        case "reverted":
            return ("Reverted", "arrow.uturn.backward.circle", .neutral)
        default:
            return nil
        }
    }

    /// Wire `AuthMode` (the route a run actually executed under) -> label.
    /// Distinct vocabulary from `credential_route` (humanizeCredentialRoute).
    static func authModeLabel(_ mode: String) -> String {
        switch mode {
        case "local_session": return "Subscription"
        case "api_key": return "API key"
        default: return mode.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func outputReadyLabel(_ state: String) -> String {
        switch state {
        case "pending": return "Output pending"
        case "finalizing": return "Output finalizing"
        case "diagnostic": return "Diagnostic output"
        case "ready": return "Output ready"
        default: return state
        }
    }

    static func webEvidence(_ status: String) -> (label: String, glyph: String, tone: OutcomePresentation.Tone) {
        switch status {
        case "satisfied": return ("Web verified", "network", .success)
        case "failed": return ("Web failed", "exclamationmark.icloud", .failure)
        case "attempted": return ("Web attempted", "icloud", .neutral)
        case "unverified": return ("Web unverified", "questionmark.diamond", .warning) // a policy gap
        default: return (status, "icloud", .neutral)
        }
    }

    /// Best-of degradation (M5c): a best-of run that produced FEWER candidates
    /// than requested must say so honestly ("best-of 2/3"), never silently read
    /// as a full race. Returns nil for non-multi-candidate runs and for a single
    /// requested candidate (not a best-of). `degraded` is true only when fewer
    /// candidates landed than were asked for.
    static func bestOfLabel(isMultiCandidate: Bool, requested: Int, delivered: Int)
        -> (text: String, degraded: Bool)? {
        guard isMultiCandidate, requested >= 2 else { return nil }
        let landed = max(delivered, 0)
        let degraded = landed < requested
        return degraded
            ? ("best-of \(landed)/\(requested)", true)
            : ("best-of \(requested)", false)
    }

    /// Convenience over a task's own mode + requested `n` + delivered candidates.
    static func bestOfLabel(_ task: TaskRun) -> (text: String, degraded: Bool)? {
        bestOfLabel(isMultiCandidate: task.mode.isMultiCandidate,
                    requested: task.n, delivered: task.candidates.count)
    }

    // MARK: Header composition (Run Detail)

    /// The PRIMARY header facts (W4.5: 3-4 facts — route, apply, attention;
    /// status rides the ScreenHeader accessory and budget renders as
    /// BudgetMini beside this row). Everything else belongs in Details.
    static func headerPrimary(_ task: TaskRun) -> [Fact] {
        var facts: [Fact] = []
        if let route = task.authRoute, let effective = route.effective, effective != "unknown" {
            facts.append(Fact(
                id: "auth_route",
                text: authModeLabel(effective),
                glyph: "person.badge.key",
                tone: .neutral,
                help: "Auth route taken: \(authModeLabel(effective)). Requested: \(route.requested)\(route.source.map { " · source: \($0)" } ?? "") · reason: \(route.reason)."
            ))
        }
        if let (text, glyph, tone) = applyFact(state: task.applyState, adopted: task.adopted) {
            facts.append(Fact(id: "apply", text: text, glyph: glyph, tone: tone,
                              help: "Honest application state of this turn's in-place change."))
        }
        if task.waitingOnUser {
            facts.append(Fact(id: "needs_answer", text: "Needs your answer",
                              glyph: "questionmark.bubble.fill", tone: .warning,
                              help: "The harness asked a question; the run is waiting for you (it declines benignly on timeout)."))
        }
        // Best-of count — honest degradation when fewer candidates landed than
        // requested (never a silent full-race read).
        if let bestOf = bestOfLabel(task) {
            facts.append(Fact(
                id: "best_of",
                text: bestOf.text,
                glyph: bestOf.degraded ? "flag.slash" : "flag.checkered.2.crossed",
                tone: bestOf.degraded ? .warning : .neutral,
                help: bestOf.degraded
                    ? "Best-of degraded: \(task.candidates.count) of \(task.n) requested candidates were produced."
                    : "Best-of race across \(task.n) candidates."))
        }
        return facts
    }

    /// The DETAILS facts: real evidence that does not belong in the primary
    /// row — provenance, mode, model mismatch, access, output state,
    /// web evidence, browser requirement. Rendered by the header's Details
    /// disclosure; empty entries are simply absent (honest degradation).
    static func headerDetails(_ task: TaskRun) -> [Fact] {
        var facts: [Fact] = []
        facts.append(Fact(id: "mode", text: task.mode.label, glyph: task.mode.glyph,
                          tone: .neutral, help: nil))
        if let mismatch = task.authRoute?.modelMismatch {
            facts.append(Fact(
                id: "model_mismatch",
                text: "\(mismatch.observed) ≠ \(mismatch.requested)",
                glyph: "arrow.triangle.2.circlepath",
                tone: .warning,
                help: "The vendor served \(mismatch.observed) instead of the requested \(mismatch.requested) on the deciding attempt."
            ))
        }
        if let access = task.accessLabel {
            facts.append(Fact(id: "access", text: access, glyph: "lock.shield", tone: .neutral,
                              help: "Access profile the engine enforced (requested vs effective)."))
        }
        if let outputReady = task.outputReadyState, outputReady != "ready" {
            facts.append(Fact(
                id: "output_ready",
                text: outputReadyLabel(outputReady),
                glyph: outputReady == "diagnostic" ? "exclamationmark.triangle" : "clock",
                tone: outputReady == "diagnostic" ? .failure : .neutral,
                help: "Output ready state from Control API."
            ))
        }
        if let web = task.webEvidenceStatus, web != "none" {
            let evidence = webEvidence(web)
            facts.append(Fact(id: "web", text: evidence.label, glyph: evidence.glyph,
                              tone: evidence.tone, help: task.webEvidenceDetail))
        }
        if let browser = task.browserRequirementDetail {
            facts.append(Fact(id: "browser", text: browser, glyph: "globe", tone: .neutral, help: browser))
        }
        return facts
    }
}
