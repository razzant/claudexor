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
        let line = try #require(OutcomePresentation.line(
            status: .blocked, result: patch(applyState: "applied_review_blocked"),
            reviewVerdict: .findings
        ))
        // BOTH facts in the headline — the acceptance case of Квиз-7a.
        #expect(line.headline == "Applied · review blocked")
        #expect(line.tone == .warning)
        #expect(line.chips.isEmpty)
    }

    @Test func cleanAppliedLeadsWithApplyAndDemotesReviewToChip() throws {
        let line = try #require(OutcomePresentation.line(
            status: .succeeded, result: patch(applyState: "applied"), reviewVerdict: .clean
        ))
        #expect(line.headline == "Applied")
        #expect(line.tone == .success)
        #expect(line.chips == [OutcomePresentation.Chip(text: "review clean", tone: .success)])
    }

    @Test func failureShapedTerminalAlwaysLeadsTheHeadline() throws {
        let line = try #require(OutcomePresentation.line(
            status: .failed, result: patch(applyState: "applied"), reviewVerdict: .notRun
        ))
        #expect(line.headline == "Failed · Applied")
        #expect(line.tone == .failure)
    }

    @Test func cancelledIsNeutralNotRed() throws {
        let line = try #require(OutcomePresentation.line(
            status: .cancelled, result: patch(applyState: "not_applied"), reviewVerdict: .notRun
        ))
        #expect(line.headline == "Cancelled")
        #expect(line.tone == .neutral)
    }

    /// Result-LESS terminals (a failure that produced no work product) still
    /// get their reconciled line — the mapper leads with the status, and the
    /// card calls it outside the result guard (sol review #5).
    @Test func resultlessFailureCancellationAndBlockStillProduceTheHonestLine() throws {
        let failed = try #require(OutcomePresentation.line(
            status: .failed, result: nil, reviewVerdict: .notRun
        ))
        #expect(failed.headline == "Failed")
        #expect(failed.tone == .failure)

        let cancelled = try #require(OutcomePresentation.line(
            status: .cancelled, result: nil, reviewVerdict: .notRun
        ))
        #expect(cancelled.headline == "Cancelled")
        #expect(cancelled.tone == .neutral)

        let blocked = try #require(OutcomePresentation.line(
            status: .blocked, result: nil, reviewVerdict: .running
        ))
        #expect(blocked.headline == "Blocked on your decision")
        #expect(blocked.tone == .warning)
    }

    @Test func adoptedWinnerSaysSo() throws {
        let line = try #require(OutcomePresentation.line(
            status: .succeeded, result: patch(applyState: "applied", adopted: true),
            reviewVerdict: .clean
        ))
        #expect(line.headline == "Winner applied")
    }

    @Test func revertedIsItsOwnNeutralFact() throws {
        let line = try #require(OutcomePresentation.line(
            status: .succeeded, result: patch(applyState: "reverted"), reviewVerdict: .notRun
        ))
        #expect(line.headline == "Reverted")
        #expect(line.tone == .neutral)
    }

    @Test func blockersOverflowIntoChips() throws {
        let line = try #require(OutcomePresentation.line(
            status: .blocked, result: patch(applyState: "applied_review_blocked", blockers: 3),
            reviewVerdict: .findings
        ))
        #expect(line.headline == "Applied · review blocked")
        #expect(line.chips == [OutcomePresentation.Chip(text: "3 blockers", tone: .warning)])
    }

    @Test func plainAnswerAndActiveRunsRenderNothing() {
        #expect(OutcomePresentation.line(
            status: .succeeded,
            result: RunResult(kind: "answer", diffStat: nil, blockers: 0, adopted: nil),
            reviewVerdict: .notRun
        ) == nil)
        #expect(OutcomePresentation.line(
            status: .running, result: patch(applyState: "applied"), reviewVerdict: .running
        ) == nil)
    }

    @Test func ungatedTerminalIsAnHonestWarningHeadline() throws {
        let line = try #require(OutcomePresentation.line(
            status: .ungated, result: patch(applyState: "not_applied"), reviewVerdict: .ungated
        ))
        #expect(line.headline == "Ungated")
        #expect(line.tone == .warning)
    }
}
