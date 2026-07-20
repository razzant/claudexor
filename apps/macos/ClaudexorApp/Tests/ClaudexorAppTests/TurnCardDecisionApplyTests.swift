import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// B6 (apply-after-accept-risk): a review-blocked run has NO apply path until the
/// operator accepts risk, at which point the SERVER re-derives eligibility. The
/// receipt must RELOAD on accept-risk (applyLoadKey keyed on riskAccepted) and
/// render Apply from the refreshed eligibility — never leave an eligible
/// accepted-risk run apply-less (the workspace defers decision-flow apply to the
/// receipt, so a hidden receipt Apply would mean no path at all). These lock the
/// blocked → accept-risk → eligible transition.
@Suite struct TurnCardDecisionApplyTests {
    private func run(reviewVerdict: ReviewVerdict = .notRun,
                     operatorDecisionAction: String? = nil,
                     eligible: Bool? = nil) -> TaskRun {
        var t = TaskRun(
            id: "r1", title: "t", prompt: "", mode: .agent, phase: .succeeded,
            project: "p", harnesses: [.codex], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, routeProof: .verified, attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [])
        t.reviewVerdict = reviewVerdict
        t.operatorDecisionAction = operatorDecisionAction
        if let eligible {
            t.applyEligibility = ApplyEligibility(
                eligible: eligible, state: eligible ? "ok" : "needs_review",
                reason: eligible ? nil : "blocking findings remain", requiredAction: nil)
        }
        return t
    }

    /// A review-blocked run: DecisionBar shows, Apply is HIDDEN on the stale
    /// blocked eligibility, and it IS a decision-flow run.
    @Test func blockedRunShowsDecisionBarAndHidesApply() {
        let blocked = run(reviewVerdict: .findings, operatorDecisionAction: nil, eligible: false)
        #expect(blocked.reviewNeedsDecision)
        #expect(DecisionApplyPresentation.isDecisionFlow(blocked))
        #expect(DecisionApplyPresentation.showsDecisionBar(blocked, riskAccepted: false))
        #expect(!DecisionApplyPresentation.showsApply(blocked))
    }

    /// Accepting risk locally hides the DecisionBar AND re-keys the eligibility
    /// reload — so the `.task(id: applyLoadKey)` re-fires and the stale blocked
    /// eligibility is replaced (the crux of B6).
    @Test func acceptingRiskReKeysTheEligibilityReload() {
        let blocked = run(reviewVerdict: .findings, operatorDecisionAction: nil, eligible: false)
        let before = DecisionApplyPresentation.applyLoadKey(blocked, riskAccepted: false)
        let after = DecisionApplyPresentation.applyLoadKey(blocked, riskAccepted: true)
        #expect(before != after)
        #expect(!DecisionApplyPresentation.showsDecisionBar(blocked, riskAccepted: true))
    }

    /// Once the server records the accept-risk decision and re-derives
    /// eligibility as eligible, Apply RENDERS on the receipt (still a
    /// decision-flow run, so the workspace stays deferred — no duplicate apply).
    @Test func acceptedRiskEligibleRunShowsApplyOnReceipt() {
        let eligible = run(reviewVerdict: .findings, operatorDecisionAction: "accept_risk", eligible: true)
        #expect(!eligible.reviewNeedsDecision)                        // decision recorded
        #expect(DecisionApplyPresentation.isDecisionFlow(eligible))   // still decision-flow
        #expect(!DecisionApplyPresentation.showsDecisionBar(eligible, riskAccepted: false))
        #expect(DecisionApplyPresentation.showsApply(eligible))       // Apply now visible
    }

    /// A clean (non-decision-flow) run never applies from the receipt — that is
    /// the workspace Changes tab's job (no duplicate apply, D42).
    @Test func cleanRunDoesNotApplyFromReceipt() {
        let clean = run(reviewVerdict: .clean, operatorDecisionAction: nil, eligible: true)
        #expect(!DecisionApplyPresentation.isDecisionFlow(clean))
        #expect(!DecisionApplyPresentation.showsApply(clean))
    }
}
