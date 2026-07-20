import Testing
@testable import ClaudexorApp

/// M5c best-of degradation label — a run that produced fewer candidates than
/// requested reads honestly ("best-of 2/3"), never as a full race.
@Suite struct RunFactsBestOfTests {
    @Test func fullRaceIsNotDegraded() {
        let label = RunFacts.bestOfLabel(isMultiCandidate: true, requested: 3, delivered: 3)
        #expect(label?.text == "best-of 3")
        #expect(label?.degraded == false)
    }

    @Test func fewerCandidatesShowsHonestCount() {
        let label = RunFacts.bestOfLabel(isMultiCandidate: true, requested: 3, delivered: 2)
        #expect(label?.text == "best-of 2/3")
        #expect(label?.degraded == true)
    }

    @Test func zeroCandidatesStillReportsRequested() {
        let label = RunFacts.bestOfLabel(isMultiCandidate: true, requested: 3, delivered: 0)
        #expect(label?.text == "best-of 0/3")
        #expect(label?.degraded == true)
    }

    @Test func negativeDeliveredIsClampedToZero() {
        let label = RunFacts.bestOfLabel(isMultiCandidate: true, requested: 2, delivered: -1)
        #expect(label?.text == "best-of 0/2")
    }

    @Test func nonMultiCandidateHasNoLabel() {
        #expect(RunFacts.bestOfLabel(isMultiCandidate: false, requested: 3, delivered: 1) == nil)
    }

    @Test func singleRequestedIsNotABestOf() {
        #expect(RunFacts.bestOfLabel(isMultiCandidate: true, requested: 1, delivered: 1) == nil)
    }
}

/// W2-A4: the honest apply-DELIVERY line (`RunFacts.applyFact`) that D42 dropped
/// from the chat turn is restored inline in TurnCard.applyStateLine. These lock
/// the single-owner mapper so a review-blocked apply is voiced as BOTH facts,
/// never a victorious bare "Applied", and so `not_applied` renders nothing.
@Suite struct ApplyFactHonestLineTests {
    @Test func reviewBlockedApplyVoicesBothFacts() {
        let fact = RunFacts.applyFact(state: "applied_review_blocked", adopted: false)
        #expect(fact?.text == "Applied · review blocked")
        #expect(fact?.tone == .warning)
    }

    @Test func cleanApplyAndAdoptedWinner() {
        #expect(RunFacts.applyFact(state: "applied", adopted: false)?.text == "Applied")
        #expect(RunFacts.applyFact(state: "applied", adopted: true)?.text == "Winner applied")
        #expect(RunFacts.applyFact(state: "applied", adopted: false)?.tone == .success)
    }

    @Test func revertedIsNeutralAndNotAppliedIsSilent() {
        #expect(RunFacts.applyFact(state: "reverted", adopted: false)?.text == "Reverted")
        // not_applied / unknown render NO line (the turn is silent about delivery).
        #expect(RunFacts.applyFact(state: "not_applied", adopted: false) == nil)
        #expect(RunFacts.applyFact(state: nil, adopted: false) == nil)
    }
}
