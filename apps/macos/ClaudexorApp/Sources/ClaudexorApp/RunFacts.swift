import SwiftUI
import ClaudexorKit

/// THE owner of run FACTS and their formatting (W4.5 sol #16): every text,
/// glyph, tone, and help string a surface shows about a run's route, apply
/// state, output, web evidence, or budget is produced here exactly once.
/// Surfaces (TurnCard, run-filtered workspace facts row) COMPOSE their layouts from
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

    /// #118: what the satisfied web activity returned, never more. A verified page is
    /// "Web verified" and verified search results "Web searched"; a web call without a
    /// typed result "Web reached"; completed web tools that retrieved nothing (a Browser
    /// close or click), or an engine that did not say, "Web tools used".
    static func webEvidence(_ status: String, verification: String? = nil, content: String? = nil)
        -> (label: String, glyph: String, tone: OutcomePresentation.Tone) {
        switch status {
        case "satisfied" where verification == "verified" && content == "search_results":
            return ("Web searched", "network", .success)
        case "satisfied" where verification == "verified": return ("Web verified", "network", .success)
        case "satisfied" where verification == "dispatched": return ("Web reached", "network", .neutral)
        case "satisfied": return ("Web tools used", "network", .neutral)
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

    /// A request the engine refused before sending it, keyed by the typed
    /// `RunFailure.code` (#147 raw context, #393 missing or rejected key, #395 no
    /// model chosen). The engine's message stays the complete source; this only
    /// names the refusal.
    struct Refusal: Equatable {
        /// The chat failure card's heading.
        let title: String
        /// The short run fact in the workspace facts row.
        let fact: String
        /// The receipt's attention chip.
        let chip: String
    }

    /// `retried`: the record's typed `poolAttempts` lists an earlier try of this
    /// run that failed after it was handed to its harness, so the refused request
    /// is a retry. A row does not say whether that try's request reached the
    /// provider (a connection that never opened is a row too), so no label claims
    /// it was sent, and none claims that nothing in the run was.
    static func refusal(code: String?, retried: Bool = false) -> Refusal? {
        let lead = retried ? "Retry not sent" : "Not sent"
        let named: (title: String, fact: String)
        switch code {
        case "raw_context_exceeds_window":
            named = ("the request doesn't fit the model's context window", "over the context window")
        case "raw_context_mandatory_unavailable":
            named = ("mandatory context files are unavailable", "mandatory files unavailable")
        case "model_catalog_unavailable":
            named = ("the API key is missing or was rejected", "API key missing or rejected")
        case "model_selection_required":
            named = ("no model is selected for this harness", "no model selected")
        default:
            return nil
        }
        return Refusal(title: "\(lead): \(named.title)", fact: "\(lead): \(named.fact)", chip: lead)
    }

    /// A raw patch, or the evidence it needs, the engine refused, keyed by the
    /// typed `RunFailure.code` (#551). The code names what is wrong, never
    /// whether a request was sent or paid (a patch intent without its packet is
    /// refused before any request, the rest after an answer), so this heading
    /// claims neither and is no `refusal`. The engine's message stays the
    /// complete source.
    static func patchRefusalTitle(code: String?) -> String? {
        let what: String
        switch code {
        case "raw_patch_apply_failed": what = "it does not apply to the candidate"
        case "raw_patch_outside_scope": what = "it touches a path outside its packet"
        case "raw_patch_stale_preimage": what = "it edits a file version its packet did not hold"
        case "raw_patch_path_traversal": what = "it names an invalid path"
        case "raw_patch_binary_unsupported": what = "binary changes are not accepted"
        case "raw_patch_truncated": what = "the answer was not a complete patch"
        case "raw_patch_missing_evidence": what = "its packet or evidence is missing"
        case "raw_patch_digest_mismatch": what = "its bytes do not match their digest"
        case "raw_patch_base_mismatch": what = "the candidate is not the tree its packet described"
        case "raw_patch_requires_isolation": what = "it can only apply in an isolated copy"
        default: return nil
        }
        return "Patch refused: \(what)"
    }

    static func refusal(_ task: TaskRun) -> Refusal? {
        refusal(code: task.failureCode, retried: task.failureRecord?.poolAttempts.isEmpty == false)
    }

    /// Compact token figure for a run fact: 950, 9.5k, 182k, 1.2M. Fixed
    /// English formatting, independent of the host locale.
    static func tokenCount(_ value: Int) -> String {
        func scaled(_ unit: Double, _ suffix: String) -> String {
            let figure = Double(value) / unit
            let text = figure < 9.95 ? String(format: "%.1f", figure) : String(format: "%.0f", figure)
            return (text.hasSuffix(".0") ? String(text.dropLast(2)) : text) + suffix
        }
        if value < 1_000 { return "\(value)" }
        return value < 999_500 ? scaled(1_000, "k") : scaled(1_000_000, "M")
    }

    /// #147: the two compact facts of the raw-api request the final attempt last
    /// prepared, from its typed receipt (`rawContext`), never from the adapter's
    /// status sentence. The receipt is stamped just before the POST, so it says
    /// what was prepared, not that the provider received it.
    static func rawContextFacts(_ raw: RawContextReceiptInfo) -> [Fact] {
        let estimate = "≈\(tokenCount(raw.estimatedRequestTokens))"
        let method = "Estimated as characters ÷ 4 plus about 1,600 per image, never a tokenizer count."
        var facts: [Fact] = []
        if let window = raw.checkedWindow {
            let answer = raw.budget.outputAllowanceTokens.map { " \($0) more were kept free for the answer." } ?? ""
            facts.append(Fact(
                id: "raw_context", text: "Context \(estimate) of \(tokenCount(window)) tokens · estimated",
                glyph: "doc.text", tone: .neutral,
                help: "The last request prepared for \(raw.model), sized against its \(window)-token context window from the model catalog.\(answer) \(method)"))
        } else if raw.budget.basis == "assumed_ceiling" {
            facts.append(Fact(
                id: "raw_context",
                text: "Context \(estimate) tokens · window unknown, assumed \(tokenCount(raw.budget.selectionLimitTokens))",
                glyph: "doc.text", tone: .warning,
                help: "The model catalog gave no context window for \(raw.model), so optional files were limited to an assumed \(raw.budget.selectionLimitTokens)-token ceiling, which is not a fact about the model. \(method)"))
        } else {
            facts.append(Fact(
                id: "raw_context", text: "Context \(estimate) tokens · window not checked", glyph: "doc.text",
                tone: .warning,
                help: "The packet was sized for \(raw.budget.model ?? "another model"); the window of \(raw.model) was not checked. \(method)"))
        }
        let omitted = raw.budget.omittedForBudget
        if omitted > 0 {
            facts.append(Fact(
                id: "raw_context_omitted", text: "\(omitted) optional file\(omitted == 1 ? "" : "s") left out",
                glyph: "doc.badge.ellipsis", tone: .neutral,
                help: "Left out so the request fits; the run's raw context packet lists them under omissions."))
        }
        return facts
    }

    /// #147 refusal sizes as the card shows them: one summary whose parts add up
    /// to the request, and the largest mandatory files with their estimates.
    struct Shortfall: Equatable {
        struct Row: Equatable {
            let label: String
            let size: String
            let isPath: Bool
        }
        let summary: String
        let rows: [Row]
    }

    /// `earlierFailedTries`: the record's `poolAttempts` count. Those tries failed
    /// after dispatch; whether their requests reached the provider is unknown, so
    /// the summary says only that this request was not sent.
    static func shortfall(_ s: RawContextShortfallInfo, earlierFailedTries: Int, maxFiles: Int = 5) -> Shortfall {
        let sent = earlierFailedTries == 0
            ? "This request was not sent."
            : "This retry was not sent; \(earlierFailedTries) earlier \(earlierFailedTries == 1 ? "try" : "tries") failed."
        let summary = "\(s.model) has a \(tokenCount(s.contextWindow))-token context window; this request needs about "
            + "\(tokenCount(s.neededTokens)): mandatory files ≈\(tokenCount(s.mandatoryTokens)), the rest of the request "
            + "≈\(tokenCount(s.otherRequestTokens)) and \(tokenCount(s.outputAllowanceTokens)) kept for the answer. \(sent)"
        var rows = s.mandatoryFiles.prefix(maxFiles).map {
            Shortfall.Row(label: $0.path, size: "≈\(tokenCount($0.estimatedTokens))", isPath: true)
        }
        let rest = s.mandatoryFiles.dropFirst(maxFiles)
        if !rest.isEmpty {
            rows.append(Shortfall.Row(
                label: "\(rest.count) more file\(rest.count == 1 ? "" : "s")",
                size: "≈\(tokenCount(rest.reduce(0) { $0 + $1.estimatedTokens }))", isPath: false))
        }
        return Shortfall(summary: summary, rows: rows)
    }

    /// Convenience over a task's own mode + requested `n` + delivered candidates.
    static func bestOfLabel(_ task: TaskRun) -> (text: String, degraded: Bool)? {
        bestOfLabel(isMultiCandidate: task.mode.isMultiCandidate,
                    requested: task.n, delivered: task.candidates.count)
    }

    // MARK: Workspace facts composition

    /// The PRIMARY workspace facts (W4.5: 3-4 facts — route, apply, attention).
    /// Supporting facts follow in the same run-filtered facts row.
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
        if task.blockingQuestionPending {
            facts.append(Fact(id: "needs_answer", text: "Needs your answer",
                              glyph: "questionmark.bubble.fill", tone: .warning,
                              help: "The harness asked a question; the run is waiting for you and declines benignly only if automatic expiry is configured."))
        } else if task.asyncQuestionsOnly {
            facts.append(Fact(id: "async_question", text: "Question asked · still working",
                              glyph: "questionmark.bubble", tone: .neutral,
                              help: "The agent asked a question and keeps working. An answer is passed to it as its next message; if nobody answers, nothing is sent."))
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
    /// web evidence, browser requirement. Rendered in the run-filtered
    /// workspace facts row; empty entries are simply absent (honest degradation).
    static func headerDetails(_ task: TaskRun) -> [Fact] {
        var facts: [Fact] = []
        facts.append(Fact(id: "mode", text: task.mode.label, glyph: task.mode.glyph,
                          tone: .neutral, help: nil))
        if let delegation = task.delegation,
           let receipt = DelegationPresentation.runReceipt(delegation) {
            let delegationTone: OutcomePresentation.Tone =
                DelegationPresentation.warningShaped(delegation) ? .warning : .neutral
            facts.append(contentsOf: [
                Fact(id: "delegation_requested", text: receipt.requested,
                     glyph: "arrow.triangle.branch", tone: delegationTone, help: receipt.detail),
                Fact(id: "delegation_effective", text: receipt.effective,
                     glyph: "checkmark.circle", tone: delegationTone, help: receipt.detail),
                Fact(id: "delegation_used", text: receipt.used,
                     glyph: "wrench.and.screwdriver", tone: delegationTone, help: receipt.detail),
                Fact(id: "delegation_reason", text: receipt.reason,
                     glyph: "info.circle", tone: delegationTone, help: receipt.detail),
            ])
        }
        if let child = DelegationPresentation.childReceipt(
            delegatedFromRunId: task.delegatedFromRunId) {
            facts.append(Fact(
                id: "delegated_child",
                text: "\(child.badge) · \(child.parentLabel)",
                glyph: "arrow.turn.down.right",
                tone: .neutral,
                help: "Claudexor child run delegated by \(child.parentRunId)."
            ))
        }
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
            // #413: the native setting prepared for each route, never "enforced".
            let qualifier = RouteControlsPresentation.boundaryQualifier(task.routeControls)
            facts.append(Fact(id: "access", text: qualifier.map { "\(access) · \($0)" } ?? access,
                              glyph: "lock.shield", tone: .neutral,
                              help: RouteControlsPresentation.accessHelp(task)))
        }
        if let refusal = refusal(task) {
            facts.append(Fact(
                id: "request_refused",
                text: refusal.fact,
                glyph: "hand.raised.fill",
                tone: .failure,
                help: task.engineError ?? refusal.title))
        }
        if let raw = task.rawContext { facts.append(contentsOf: rawContextFacts(raw)) }
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
            let evidence = webEvidence(web, verification: task.webVerification, content: task.webVerifiedContent)
            facts.append(Fact(id: "web", text: evidence.label, glyph: evidence.glyph,
                              tone: evidence.tone, help: RouteControlsPresentation.webHelp(task)))
        } else if task.externalContextPolicy == "off" {
            // #118: Web Off switches each route's own web tools; it is not a network switch.
            facts.append(Fact(id: "web", text: RouteControlsPresentation.webOffLabel(task.routeControls),
                              glyph: "network.slash", tone: .neutral,
                              help: RouteControlsPresentation.webHelp(task)))
        }
        if let browser = task.browserRequirementDetail {
            facts.append(Fact(id: "browser", text: browser, glyph: "globe", tone: .neutral,
                              help: RouteControlsPresentation.browserHelp(browser, task.routeControls)))
        }
        return facts
    }
}
