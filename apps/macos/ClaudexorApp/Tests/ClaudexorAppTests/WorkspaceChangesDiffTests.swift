import Foundation
import Testing
import ClaudexorKit
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

    @Test func missingProjectedRunIsRetryableFailureNotFalseEmpty() {
        #expect(RunDiffSection.diffLoadStep(
            runExists: false, diffIsEmpty: true, phase: nil, hasPatchArtifact: false) == .noRun)
        #expect(RunDiffSection.missingProjectedRunMessage.contains("retry"))
        #expect(!RunDiffSection.missingProjectedRunMessage.contains("No changes"))
    }

    @Test func terminalWithPatchFetches() {
        #expect(RunDiffSection.diffLoadStep(
            runExists: true, diffIsEmpty: true, phase: .succeeded, hasPatchArtifact: true) == .fetch)
    }

    // MARK: #535 unrendered object result

    @Test func unrenderedResultIsATypedViewAbsenceNotNoChanges() {
        let body = #"{"error":"too large","code":"patch_view_unavailable","reason":"exceeds_view_limit","limitBytes":268435456,"estimatedBytes":1441795100,"inventory":{"exact":false,"changedFiles":3,"largest":[]}}"#
        let message = ArtifactFetchError.unrenderedPatchMessage(body: body)
        #expect(message?.contains("too large to show as one patch") == true)
        #expect(message?.contains("3 changed files") == true)
        #expect(message?.contains("Apply and Revert still work") == true)
        #expect(message?.contains("No changes") == false)
        if case .notRenderable(let text) = ArtifactFetchError.payloadError(
            from: GatewayError.http(status: 413, body: body), path: "final/patch.diff") {
            #expect(text == message)
        } else {
            Issue.record("a typed 413 must map to notRenderable with the engine's reason")
        }
        // An ordinary oversize artifact keeps its own message.
        #expect(ArtifactFetchError.unrenderedPatchMessage(body: #"{"error":"artifact is big"}"#) == nil)
    }

    @Test func failedRenderIsNotCalledTooLarge() {
        let body = #"{"error":"could not be rendered","code":"patch_view_unavailable","reason":"render_failed","limitBytes":268435456,"estimatedBytes":4096,"inventory":{"exact":false,"changedFiles":1,"largest":[]}}"#
        let message = ArtifactFetchError.unrenderedPatchMessage(body: body)
        #expect(message?.contains("could not be rendered") == true)
        #expect(message?.contains("too large") == false)
        #expect(message?.contains("1 changed file;") == true)
        #expect(message?.contains("Apply and Revert still work") == true)
    }

    @Test func changedRunWithoutPatchFileStillFetchesTheView() {
        var run = TaskRun(id: "run-1", title: "Large result", prompt: "p",
            mode: .agent, phase: .succeeded, project: "p", harnesses: [], n: 1,
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0),
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false, routeProof: .unverified,
            attentionNote: nil, plan: [], activity: [], candidates: [], findings: [], diff: [])
        run.artifactPaths = ["final/work_product.yaml"]
        run.outcomeFacts = RunOutcomeFacts(
            lifecycle: "succeeded", noChanges: false, checks: "not_configured", review: "not_run", reason: nil)
        #expect(run.hasPatchArtifact)
        run.outcomeFacts = RunOutcomeFacts(
            lifecycle: "succeeded", noChanges: true, checks: "not_configured", review: "not_run", reason: nil)
        #expect(!run.hasPatchArtifact)
    }

    // MARK: #535 R4 A1: a directory result also has final/work_product.yaml

    /// A changed run listing final/work_product.yaml but no final/patch.diff, loaded
    /// through an engine that answers every request with `status`.
    @MainActor
    private func loadChangedRun(answering status: Int, listing paths: [String]) async -> RunDiffLoadOutcome {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StatusByHostURLProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://status-\(status).invalid")!, token: "fixture",
            session: URLSession(configuration: config))
        let model = AppModel(client: client, requestNotificationAuthorization: false, loadPersistedState: false)
        var run = TaskRun(id: "run-1", title: "Changed result", prompt: "p",
            mode: .agent, phase: .succeeded, project: "p", harnesses: [], n: 1,
            createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0),
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false, routeProof: .unverified,
            attentionNote: nil, plan: [], activity: [], candidates: [], findings: [], diff: [])
        run.artifactPaths = paths
        run.outcomeFacts = RunOutcomeFacts(
            lifecycle: "succeeded", noChanges: false, checks: "not_configured", review: "not_run", reason: nil)
        model.liveTasks = [run]
        return await model.loadRunDiff("run-1", locationID: .local)
    }

    @MainActor @Test func directoryResultWithoutPatchShowsNoChangesNotAnOutdatedEngine() async {
        // An ordinary-folder result writes final/work_product.yaml and never a patch
        // view, so the engine has no final/patch.diff to answer: 404, as on main.
        let outcome = await loadChangedRun(answering: 404, listing: ["final/work_product.yaml"])
        if case .unavailable = outcome {} else {
            Issue.record("a directory result's missing patch is no patch to show, not \(outcome)")
        }
    }

    @MainActor @Test func listedPatchThatIsMissingStaysADisclosedFailure() async {
        let outcome = await loadChangedRun(
            answering: 404, listing: ["final/work_product.yaml", "final/patch.diff"])
        if case .failed(let message) = outcome {
            #expect(message.contains("final/patch.diff"))
        } else {
            Issue.record("a listed patch the engine cannot find must fail with Retry, not \(outcome)")
        }
    }

    @MainActor @Test func unrenderedObjectResultStillAnswersItsTypedViewAbsence() async {
        let outcome = await loadChangedRun(answering: 413, listing: ["final/work_product.yaml"])
        if case .tooLarge(let message) = outcome {
            #expect(message.contains("Apply and Revert still work"))
        } else {
            Issue.record("the typed 413 of an unrendered object result must stay tooLarge, not \(outcome)")
        }
    }
}

/// Answers every request with the HTTP status its host names (`status-404.invalid`): a
/// test owns its engine's answers without shared state, so suites may run in parallel.
private final class StatusByHostURLProtocol: URLProtocol {
    static let unrenderedBody = #"{"error":"too large","code":"patch_view_unavailable","reason":"exceeds_view_limit","limitBytes":268435456,"estimatedBytes":1441795100,"inventory":{"exact":false,"changedFiles":3,"largest":[]}}"#
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let host = request.url?.host ?? ""
        let status = Int(host.split(separator: ".").first?.split(separator: "-").last ?? "") ?? 500
        let body = status == 413 ? Self.unrenderedBody : #"{"error":"no such artifact"}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
