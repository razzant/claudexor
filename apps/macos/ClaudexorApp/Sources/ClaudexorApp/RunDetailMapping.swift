import Foundation
import ClaudexorKit

extension TaskRun {
    mutating func applyPaidBudget(_ budget: PaidBudget?) {
        guard let budget else { return }
        switch budget {
        case .unlimited:
            budgetUnlimited = true
            capKnown = false
        case .finite(let maxUsd):
            budgetUnlimited = false
            capUsd = maxUsd
            capKnown = true
        }
    }
}

/// Server-projection → domain-model mapping for the run inspector (one owner):
/// candidate evidence cards and the live plan checklist.
enum RunDetailMapping {
    /// The review verdict, derived from the honest v3 axes: persisted findings,
    /// the server-owned `outcomeFacts.review` (approved / blocked / not_run), the
    /// decision record, and candidate evidence. No mixed status enum — the wire
    /// `state` is lifecycle only.
    static func reviewVerdict(
        decision: JSONValue?, candidates: [CandidateInfo], findings: [Finding],
        failure: RunFailureInfo?, phase: RunPhase, outcomeFacts: RunOutcomeFacts?
    ) -> ReviewVerdict {
        if !findings.isEmpty { return .findings }
        if outcomeFacts?.review == "blocked" { return .findings }
        if failure?.phase == "review" { return .error }
        let outcome = decision?["outcome"]?.stringValue
        let basis = decision?["verification_basis"]?.stringValue
        if outcome == "ready" && (basis == "cross_family_review" || basis == "both") {
            return .clean
        }
        if candidates.contains(where: { $0.winner && $0.reviewVerified && $0.finalReviewClean == true }) {
            return .clean
        }
        if outcomeFacts?.review == "approved" { return .clean }
        return phase.isActive ? .running : .notRun
    }

    /// Live plan checklist: nil when the run never emitted plan.progress
    /// (callers keep their existing plan, e.g. the plan.md fallback row).
    static func planItems(_ progress: PlanProgress?) -> [PlanItem]? {
        guard let progress, !progress.items.isEmpty else { return nil }
        return progress.items.map { item in
            PlanItem(
                id: item.id,
                item.title,
                item.status == "completed" ? .done : item.status == "in_progress" ? .active : .pending
            )
        }
    }

    /// Candidate cards from the server projection. Honest per-candidate glyph:
    /// a candidate in a BLOCKED/failed run must not render green.
    static func candidates(_ cards: [CandidateInfo], runPhase: RunPhase) -> [Candidate] {
        cards.map { c in
            Candidate(
                id: c.label ?? c.attemptId,
                family: HarnessFamily(rawValue: c.harnessId),
                // Errored → failed; otherwise the candidate INHERITS the run
                // lifecycle — a clean loser card in a failed/cancelled run must
                // not render green. The review-blocker nuance is carried by
                // `reviewState` (.changesRequested), not the lifecycle phase.
                status: c.errored ? .failed : runPhase,
                costUsd: c.costUsd,
                estimated: c.costEstimated,
                gatesPassed: c.gatesPassed,
                gatesTotal: c.gatesTotal,
                reviewState: c.winner
                    ? .winner
                    : c.errored
                        ? .rejected
                        : c.blockers > 0
                            ? .changesRequested
                            : c.finalReviewClean == true ? .clean : .pending,
                reviewVerified: c.reviewVerified,
                finalReviewClean: c.finalReviewClean,
                // The verified chip: cross-family route-proof status is
                // evidence the operator should SEE, not a hidden field.
                summary: [
                    "\(c.harnessId) · \(c.attemptId)",
                    c.reviewVerified ? "verified" : nil,
                    c.errored ? (c.errorReason ?? "attempt errored") : nil,
                ].compactMap { $0 }.joined(separator: " · "),
                filesChanged: c.diffstat?.files ?? 0,
                added: c.diffstat?.additions ?? 0,
                removed: c.diffstat?.deletions ?? 0
            )
        }
    }

    static func winnerEvidenceText(_ candidate: Candidate) -> String {
        let selection = "Arbitration: \(candidate.family.label) (\(candidate.id)) selected on evidence — gates \(candidate.gatesPassed)/\(candidate.gatesTotal)."
        guard candidate.reviewVerified else {
            return "\(selection) Final review is unverified; selection does not claim a clean review."
        }
        if candidate.finalReviewClean == false {
            return "\(selection) Final review is verified but blocked or not clean."
        }
        if candidate.finalReviewClean == true {
            return "\(selection) Final review is verified clean."
        }
        return "\(selection) Final review verification is present, but the clean verdict is missing."
    }
}
