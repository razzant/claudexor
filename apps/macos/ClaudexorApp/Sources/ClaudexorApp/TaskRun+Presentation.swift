import Foundation

extension RunReasonLabel {
    /// What a surface shows for a typed reason. A reason this build has no words
    /// for (a newer engine's) is spelled from its code: it still qualifies the
    /// terminal, so it never collapses into the bare lifecycle word.
    static func label(_ reason: String?) -> String? {
        known(reason) ?? reason.flatMap { code -> String? in
            let words = code.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
            return words.isEmpty ? nil : words.prefix(1).uppercased() + words.dropFirst()
        }
    }

    /// A reason this build has no words for.
    static func isUnrecognized(_ reason: String?) -> Bool {
        reason != nil && known(reason) == nil
    }

    /// The engine's words for an unfinished `work_state` (status-projection
    /// `runOutcomeLabel`); nil for completed, unverified, absent or future work.
    static func workStateLabel(_ state: String?) -> String? {
        switch state {
        case "needs_input": return "Needs input"
        case "incomplete": return "Incomplete"
        default: return nil
        }
    }
}

extension TaskRun {
    /// The effective review presentation. Terminal facts outrank mutable live
    /// progress; active and legacy runs retain their last evidence projection.
    var effectiveReviewVerdict: ReviewVerdict {
        RunDetailMapping.effectiveReviewVerdict(
            outcomeFacts: outcomeFacts, fallback: reviewVerdict)
    }

    /// A risk-overridable terminal needs an operator decision: review blocked or
    /// checks failed after a succeeded lifecycle, with no decision recorded yet.
    /// This mirrors the server-owned needsDecision predicate exactly.
    var reviewNeedsDecision: Bool {
        guard phase.isTerminal else { return false }
        let blocked = outcomeFacts.map {
            $0.lifecycle == "succeeded"
                && ($0.review == "blocked" || $0.checks == "failed")
        } ?? (effectiveReviewVerdict == .findings)
        return blocked && operatorDecisionAction == nil
    }

    /// "Needs input" / "Incomplete" while the engine's non-overridable
    /// `needsOperatorInput` holds: the lifecycle succeeded but the attested
    /// work_state is unfinished, whatever reason arbitration recorded. Kept
    /// apart from `reviewNeedsDecision`: no operator decision resolves it.
    var unfinishedWorkLabel: String? {
        guard phase.isTerminal, let facts = outcomeFacts, facts.needsOperatorInput else { return nil }
        return RunReasonLabel.workStateLabel(facts.workState?.state)
    }

    /// The one word for a compact row: the unfinished work, else the typed reason,
    /// else the lifecycle. The same words the receipt row uses.
    var terminalWord: String {
        guard phase.isTerminal else { return phase.label }
        return unfinishedWorkLabel ?? RunReasonLabel.label(outcomeFacts?.reason) ?? phase.label
    }

    /// The status dot's tone: the lifecycle's, with a succeeded one qualified.
    var terminalTone: StatusTone {
        phase == .succeeded ? succeededTone : phase.tone
    }

    /// How a succeeded run reads, for its dot and its outcome banner: success
    /// only when nothing qualifies it. Unfinished work, a blocked review or failed
    /// checks (decided or not) and a result applied past a blocked review are a
    /// caution; a reason this build cannot read stays neutral.
    var succeededTone: StatusTone {
        if unfinishedWorkLabel != nil || reviewNeedsDecision
            || outcomeFacts?.review == "blocked" || outcomeFacts?.checks == "failed"
            || applyState == "applied_review_blocked" { return .caution }
        return RunReasonLabel.isUnrecognized(outcomeFacts?.reason) ? .neutral : .positive
    }

    /// Human-readable effective access, including an explicit upgrade receipt.
    var accessLabel: String? {
        guard let effective = effectiveAccess else {
            return requestedAccess.map(AccessProfile.humanize)
        }
        if let requested = requestedAccess, requested != effective {
            return "\(AccessProfile.humanize(requested)) → \(AccessProfile.humanize(effective))"
        }
        return AccessProfile.humanize(effective)
    }

    var planDone: Int { plan.filter { $0.state == .done }.count }
    var filesChanged: Int { diff.count }
    /// The finite cap, when the run has one the app knows.
    var finiteCapUsd: Double? { capKnown && !budgetUnlimited ? capUsd : nil }
    /// Share of the finite cap used. The cap governs `controllableSpendUsd`, which stays
    /// known when the total is unknown; engines that omit it fall back to the known total.
    var spendFraction: Double {
        guard let cap = finiteCapUsd, cap > 0 else { return 0 }
        guard let used = controllableSpendUsd ?? (spendKnown ? spendUsd : nil) else { return 0 }
        return min(used / cap, 1)
    }
    var budgetLabel: String {
        let cap = budgetUnlimited
            ? "Unlimited"
            : capKnown ? String(format: "$%.2f", capUsd) : "Unknown"
        if spendKnown {
            return "\(spendEstimated ? "~" : "")\(String(format: "$%.4f", spendUsd)) / \(cap)"
        }
        // An unknown total is never a number; the cap-governed part is labelled as such.
        if let governed = controllableSpendUsd, finiteCapUsd != nil {
            return "Unknown · \(String(format: "$%.4f", governed)) of \(cap) cap"
        }
        return "Unknown / \(cap)"
    }

    /// A terminal status is presented as Finalizing until its final content is
    /// hydrated; this prevents a green result beside an empty Outcome panel.
    var isFinalizing: Bool {
        guard isLive, phase.isTerminal, phase != .cancelled else { return false }
        let diagnosticIsContent = phase != .succeeded || outputReadyState == "diagnostic"
        let hasContent =
            !(answerText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || hasPatchArtifact
            || (diagnosticIsContent
                && !(diagnosticText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            || engineError != nil
        return !hasContent
    }
}
