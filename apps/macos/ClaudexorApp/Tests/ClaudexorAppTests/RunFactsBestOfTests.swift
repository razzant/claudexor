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
