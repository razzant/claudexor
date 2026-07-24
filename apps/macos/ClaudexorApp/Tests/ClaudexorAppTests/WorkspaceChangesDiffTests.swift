import Testing
@testable import ClaudexorApp

/// Ф3 r7 critical #2 (follow-on edge of the round-6 disclosure fixes): a lost
/// stream `running → unknown` (finalizeStream regressing the phase) must not
/// strand the run-diff slot in `.loading` behind a bare, reasonless spinner.
///
/// Root cause: the loader's invalidation key keyed only on `phase.isTerminal`.
/// Both `.running` and `.unknown` are non-terminal, so the key never changed and
/// `loadDiff()` never re-ran; and even if it had, `.unknown` with no patch fell
/// through to a dishonest "No changes." Two pure surfaces pin the fix: the key
/// now distinguishes the phases, and the step now maps the lost state to a
/// disclosed failure (which the diff body renders WITH a Retry).
@Suite struct WorkspaceChangesDiffTests {
    // MARK: invalidation key

    @Test func keyDistinguishesRunningFromUnknownSoTheLoaderReRuns() {
        let running = RunDiffSection.diffLoadKey(runId: "r1", hasPatchArtifact: false, phase: .running)
        let unknown = RunDiffSection.diffLoadKey(runId: "r1", hasPatchArtifact: false, phase: .unknown)
        // The regression: a terminality-only key made these identical. They MUST
        // differ so `.task(id:)` re-invokes the loader on the stream loss.
        #expect(running != unknown)
    }

    @Test func keyAlsoTracksPatchArrivalAndRunIdentity() {
        #expect(
            RunDiffSection.diffLoadKey(runId: "r1", hasPatchArtifact: false, phase: .succeeded)
            != RunDiffSection.diffLoadKey(runId: "r1", hasPatchArtifact: true, phase: .succeeded))
        #expect(
            RunDiffSection.diffLoadKey(runId: "r1", hasPatchArtifact: false, phase: .running)
            != RunDiffSection.diffLoadKey(runId: "r2", hasPatchArtifact: false, phase: .running))
    }

    // MARK: pre-fetch step mapping

    @Test func runningWithNoPatchIsPending() {
        #expect(RunDiffSection.diffLoadStep(
            runExists: true, diffIsEmpty: true, phase: .running, hasPatchArtifact: false) == .pending)
    }

    @Test func lostStreamUnknownWithNoPatchIsDisclosedFailureNotFalseEmpty() {
        // The core fix: `.unknown` + no captured patch is a LOST engine state, not
        // a clean no-change. It maps to the disclosed-failure step (rendered with
        // a Retry), never `.noPatch`/empty.
        let step = RunDiffSection.diffLoadStep(
            runExists: true, diffIsEmpty: true, phase: .unknown, hasPatchArtifact: false)
        #expect(step == .lostEngineState)
    }

    @Test func unknownButWithACapturedPatchStillFetches() {
        // A patch captured before the stream was lost still loads — the lost-state
        // branch only fires when there is genuinely nothing to show.
        #expect(RunDiffSection.diffLoadStep(
            runExists: true, diffIsEmpty: true, phase: .unknown, hasPatchArtifact: true) == .fetch)
    }

    @Test func alreadyHydratedDiffWinsRegardlessOfPhase() {
        #expect(RunDiffSection.diffLoadStep(
            runExists: true, diffIsEmpty: false, phase: .unknown, hasPatchArtifact: false) == .hydrated)
    }

    @Test func terminalNoPatchIsEmpty() {
        #expect(RunDiffSection.diffLoadStep(
            runExists: true, diffIsEmpty: true, phase: .succeeded, hasPatchArtifact: false) == .noPatch)
    }

    @Test func missingRunIsEmpty() {
        #expect(RunDiffSection.diffLoadStep(
            runExists: false, diffIsEmpty: true, phase: nil, hasPatchArtifact: false) == .noRun)
    }

    @Test func terminalWithPatchFetches() {
        #expect(RunDiffSection.diffLoadStep(
            runExists: true, diffIsEmpty: true, phase: .succeeded, hasPatchArtifact: true) == .fetch)
    }
}
