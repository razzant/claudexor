import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// W21 state-matrix fixtures: the reconciled outcome line over the three
/// orthogonal axes (execution terminal / delivery-apply / review gate).
@MainActor
@Suite struct OutcomePresentationTests {
    private func patch(applyState: String, adopted: Bool? = nil, blockers: Int = 0) -> RunResult {
        RunResult(kind: "patch", diffStat: nil,
                  blockers: blockers, adopted: adopted, applyState: applyState)
    }

    @Test func appliedReviewBlockedNeverReadsAsOneWinner() throws {
        // v3: a review-blocked apply is voiced by the apply fact; the review
        // gate branch is suppressed so it never doubles. Lifecycle is `succeeded`
        // (D8) — "blocked" is a review OUTCOME, not a lifecycle phase.
        let line = try #require(OutcomePresentation.line(
            phase: .succeeded, reason: nil, result: patch(applyState: "applied_review_blocked"),
            reviewVerdict: .findings
        ))
        // BOTH facts in the headline — the acceptance case of Quiz-7a.
        #expect(line.headline == "Applied · review blocked")
        #expect(line.tone == .warning)
        #expect(line.chips.isEmpty)
    }

    @Test func cleanAppliedLeadsWithApplyAndDemotesReviewToChip() throws {
        let line = try #require(OutcomePresentation.line(
            phase: .succeeded, reason: nil, result: patch(applyState: "applied"), reviewVerdict: .clean
        ))
        #expect(line.headline == "Applied")
        #expect(line.tone == .success)
        #expect(line.chips == [OutcomePresentation.Chip(text: "review clean", tone: .success)])
    }

    @Test func failureShapedTerminalAlwaysLeadsTheHeadline() throws {
        let line = try #require(OutcomePresentation.line(
            phase: .failed, reason: nil, result: patch(applyState: "applied"), reviewVerdict: .notRun
        ))
        #expect(line.headline == "Failed · Applied")
        #expect(line.tone == .failure)
    }

    /// A typed `RunReason` names the failure precisely (the ex `costUnverifiable`
    /// status): the reason label leads, not the bare "Failed".
    @Test func typedReasonNamesTheFailureHeadline() throws {
        let line = try #require(OutcomePresentation.line(
            phase: .failed, reason: "cost_unverifiable", result: nil, reviewVerdict: .notRun
        ))
        #expect(line.headline == "Cost unverifiable")
        #expect(line.tone == .failure)
    }

    @Test func cancelledIsNeutralNotRed() throws {
        let line = try #require(OutcomePresentation.line(
            phase: .cancelled, reason: nil, result: patch(applyState: "not_applied"), reviewVerdict: .notRun
        ))
        #expect(line.headline == "Cancelled")
        #expect(line.tone == .neutral)
    }

    /// Result-LESS terminals (a failure that produced no work product) still
    /// get their reconciled line — the mapper leads with the lifecycle/reason,
    /// and the card calls it outside the result guard (sol review #5).
    @Test func resultlessFailureCancellationAndReviewStillProduceTheHonestLine() throws {
        let failed = try #require(OutcomePresentation.line(
            phase: .failed, reason: nil, result: nil, reviewVerdict: .notRun
        ))
        #expect(failed.headline == "Failed")
        #expect(failed.tone == .failure)

        let cancelled = try #require(OutcomePresentation.line(
            phase: .cancelled, reason: nil, result: nil, reviewVerdict: .notRun
        ))
        #expect(cancelled.headline == "Cancelled")
        #expect(cancelled.tone == .neutral)

        // A clean-lifecycle terminal whose review found blockers reads "Needs
        // review" — the honest v3 review gate, derived from the verdict axis.
        let needsReview = try #require(OutcomePresentation.line(
            phase: .succeeded, reason: nil, result: nil, reviewVerdict: .findings
        ))
        #expect(needsReview.headline == "Needs review")
        #expect(needsReview.tone == .warning)
    }

    @Test func adoptedWinnerSaysSo() throws {
        let line = try #require(OutcomePresentation.line(
            phase: .succeeded, reason: nil, result: patch(applyState: "applied", adopted: true),
            reviewVerdict: .clean
        ))
        #expect(line.headline == "Winner applied")
    }

    @Test func revertedIsItsOwnNeutralFact() throws {
        let line = try #require(OutcomePresentation.line(
            phase: .succeeded, reason: nil, result: patch(applyState: "reverted"), reviewVerdict: .notRun
        ))
        #expect(line.headline == "Reverted")
        #expect(line.tone == .neutral)
    }

    @Test func blockersOverflowIntoChips() throws {
        let line = try #require(OutcomePresentation.line(
            phase: .succeeded, reason: nil,
            result: patch(applyState: "applied_review_blocked", blockers: 3),
            reviewVerdict: .findings
        ))
        #expect(line.headline == "Applied · review blocked")
        #expect(line.chips == [OutcomePresentation.Chip(text: "3 blockers", tone: .warning)])
    }

    @Test func plainAnswerAndActiveRunsRenderNothing() {
        #expect(OutcomePresentation.line(
            phase: .succeeded, reason: nil,
            result: RunResult(kind: "answer", diffStat: nil, blockers: 0, adopted: nil),
            reviewVerdict: .notRun
        ) == nil)
        #expect(OutcomePresentation.line(
            phase: .running, reason: nil, result: patch(applyState: "applied"), reviewVerdict: .running
        ) == nil)
    }
}

/// W4.5 SSOT pin: the outcome line and the Run Detail header consume ONE
/// apply-state mapper — their vocabularies cannot drift again.
@Suite struct RunFactsSSOTTests {
    @Test func applyVocabularyIsSharedBetweenOutcomeLineAndHeader() throws {
        // The header fact and the composed line SAY THE SAME THING.
        let fact = try #require(RunFacts.applyFact(state: "applied_review_blocked", adopted: false))
        let line = try #require(OutcomePresentation.line(
            phase: .succeeded, reason: nil,
            result: RunResult(kind: "patch", diffStat: nil, blockers: 0, adopted: nil,
                              applyState: "applied_review_blocked"),
            reviewVerdict: .findings
        ))
        #expect(line.headline == fact.text)
        #expect(fact.tone == .warning) // never a victorious green "Applied"

        // A winner-adopted apply keeps its distinct vocabulary from ONE place.
        let winner = try #require(RunFacts.applyFact(state: "applied", adopted: true))
        #expect(winner.text == "Winner applied")
        #expect(RunFacts.applyFact(state: "not_applied", adopted: false) == nil)
        #expect(RunFacts.applyFact(state: nil, adopted: false) == nil)
    }

    @Test func headerPrimaryCarriesExactlyTheMaterialFacts() throws {
        // A populated run: route + adopted apply + a pending question. The
        // pin asserts the EXACT fact set — an empty array can never pass
        // (the old count<=4 check was vacuous, F4 final review #7).
        var task = TaskRun(
            id: "r1", title: "t", prompt: "", mode: .agent, phase: .succeeded,
            project: "p", harnesses: [.claude, .codex], n: 2,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: true, capKnown: true,
            routeProof: .verified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        task.authRoute = try JSONDecoder().decode(
            RunAuthRoute.self,
            from: Data(#"{"requested":"auto","effective":"api_key","reason":"readiness_preferred"}"#.utf8))
        task.applyState = "applied"
        task.adopted = true
        task.waitingOnUser = true
        let facts = RunFacts.headerPrimary(task)
        #expect(facts.map(\.id) == ["auth_route", "apply", "needs_answer"])
        #expect(facts.map(\.text) == ["API key", "Winner applied", "Needs your answer"])
        #expect(facts.count <= 4)
        // Non-primary evidence never leaks into the primary set.
        #expect(!facts.contains { ["mode", "spec", "web", "access"].contains($0.id) })
    }
}
