import Foundation
import ClaudexorKit

/// Server-projection → domain-model mapping for the run inspector (one owner):
/// candidate evidence cards (D13) and the live plan checklist (D14).
enum RunDetailMapping {
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
    static func candidates(_ cards: [CandidateInfo], runStatus: RunStatus) -> [Candidate] {
        cards.map { c in
            Candidate(
                id: c.label ?? c.attemptId,
                family: HarnessFamily(rawValue: c.harnessId) ?? (c.harnessId.hasPrefix("fake") ? .fake : .raw),
                // Errored → failed; review blockers → blocked; otherwise the
                // candidate INHERITS the run terminal — a clean loser card in
                // a failed/cancelled run must not render green.
                status: c.errored ? .failed : c.blockers > 0 && runStatus != .running ? .blocked : runStatus,
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
                // The verified chip: cross-family route-proof status is
                // evidence the operator should SEE, not a hidden field.
                summary: c.reviewVerified ? "\(c.harnessId) · \(c.attemptId) · verified" : "\(c.harnessId) · \(c.attemptId)",
                filesChanged: c.diffstat?.files ?? 0,
                added: c.diffstat?.additions ?? 0,
                removed: c.diffstat?.deletions ?? 0
            )
        }
    }
}
