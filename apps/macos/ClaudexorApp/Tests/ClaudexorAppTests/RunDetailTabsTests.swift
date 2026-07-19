import Testing
@testable import ClaudexorApp

/// D15 four-tab defaults + the no-auto-jump-after-manual-selection guard.
@Suite struct RunDetailTabsTests {
    private func inputs(active: Bool = false, failure: Bool = false, answer: Bool = false) -> RunDetailTabInputs {
        RunDetailTabInputs(isActive: active, isFailureShaped: failure, hasAnswer: answer)
    }

    @Test func exactlyFourTabs() {
        #expect(RunDetailTab.allCases == [.outcome, .activity, .changes, .evidence])
    }

    @Test func runningDefaultsToActivity() {
        #expect(RunDetailTabPolicy.defaultTab(inputs(active: true)) == .activity)
    }

    @Test func terminalDefaultsToOutcome() {
        #expect(RunDetailTabPolicy.defaultTab(inputs(answer: true)) == .outcome)
    }

    @Test func reviewBlockedTerminalDefaultsToOutcomeNotEvidence() {
        // A clean-but-blocked terminal (has an answer, not failure-shaped) opens
        // on Outcome, where the decision controls now live.
        #expect(RunDetailTabPolicy.defaultTab(inputs(failure: false, answer: true)) == .outcome)
    }

    @Test func failureShapedWithNoAnswerDefaultsToEvidence() {
        #expect(RunDetailTabPolicy.defaultTab(inputs(failure: true, answer: false)) == .evidence)
    }

    @Test func failureShapedWithAnswerStaysOnOutcome() {
        #expect(RunDetailTabPolicy.defaultTab(inputs(failure: true, answer: true)) == .outcome)
    }

    @Test func noJumpAfterManualSelection() {
        // The user parked on Changes; the run then goes terminal. Resolve must
        // keep them on Changes rather than yanking to the new default.
        let resolved = RunDetailTabPolicy.resolve(
            current: .changes, userSelected: true, inputs: inputs(answer: true))
        #expect(resolved == .changes)
    }

    @Test func tracksDefaultUntilManualSelection() {
        // Before any manual selection, a state change re-applies the default.
        let running = RunDetailTabPolicy.resolve(
            current: .outcome, userSelected: false, inputs: inputs(active: true))
        #expect(running == .activity)
        let done = RunDetailTabPolicy.resolve(
            current: .activity, userSelected: false, inputs: inputs(answer: true))
        #expect(done == .outcome)
    }
}
