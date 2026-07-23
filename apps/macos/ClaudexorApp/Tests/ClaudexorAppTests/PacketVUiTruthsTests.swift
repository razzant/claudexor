import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// Ф3 packet V — the UI-truth items (QA-006/007/008/009/012). Model- and
/// presentation-level tests only (following TurnCardPerfTests' model-level
/// pattern) — no SwiftUI snapshot machinery.
@Suite(.serialized)
struct PacketVUiTruthsTests {

    // Minimal TaskRun factory: only the axes a test needs are set; everything
    // else defaults to a benign terminal-succeeded shape.
    private func run(
        id: String = "run-1",
        phase: RunPhase = .succeeded,
        artifactPaths: [String] = [],
        outcomeFacts: RunOutcomeFacts? = nil
    ) -> TaskRun {
        var t = TaskRun(
            id: id, title: "T", prompt: "", mode: .agent, phase: phase,
            project: "P", harnesses: [], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        t.artifactPaths = artifactPaths
        t.outcomeFacts = outcomeFacts
        return t
    }

    // MARK: QA-012 — composer create-vs-continue copy

    @Test func composerCopyKeysOnlyOnSelectedThreadIdentity() {
        let draft = ComposerInputCopy(hasSelectedThread: false)
        #expect(draft.placeholder.contains("first message starts a thread"))
        #expect(draft.accessibilityHint == "Sending starts a new thread.")

        let existing = ComposerInputCopy(hasSelectedThread: true)
        #expect(existing.placeholder.hasPrefix("Continue this conversation"))
        #expect(!existing.placeholder.contains("starts a thread"))
        #expect(!existing.placeholder.contains("native session"))  // conversation, not a lane
        #expect(existing.accessibilityHint == "Sending adds a turn to this conversation.")
        // The accessible NAME is short/stable, not the punctuation-heavy placeholder.
        #expect(existing.accessibilityName == "Conversation message")
        #expect(existing.accessibilityName.count < existing.placeholder.count)
    }

    // MARK: QA-006 — an explicit path back to no-project Ask

    @MainActor
    @Test func clearProjectReturnsADraftToNoProjectAndKeepsMRU() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.projectRoot = "/tmp/proj-a"
        model.recentProjects = ["/tmp/proj-a", "/tmp/proj-b"]

        model.clearProject()

        #expect(model.selectedThreadId == nil)
        #expect(model.normalizedProjectRoot.isEmpty)
        #expect(!model.hasCurrentProject)
        #expect(model.recentProjects == ["/tmp/proj-a", "/tmp/proj-b"])  // scope choice, not deletion
    }

    @MainActor
    @Test func clearProjectFromABoundThreadStartsAFreshDraftWithoutMutatingIt() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.projectRoot = "/tmp/proj-a"
        model.selectedThreadId = "th-bound"

        model.clearProject()

        // A new draft (selection cleared), scopeless — the bound thread is never
        // mutated (no client call was even possible here).
        #expect(model.selectedThreadId == nil)
        #expect(model.normalizedProjectRoot.isEmpty)
    }

    // MARK: QA-007 — a fresh draft must not leak the prior draft's write scope

    @MainActor
    @Test func startDraftThreadResetsTheStickyDraftAccess() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        await model.setThreadAccess("full")     // an earlier draft chose Full
        #expect(model.draftThreadAccess == "full")

        model.startDraftThread()

        // The fresh draft baselines to the repo trust default (nil), never Full.
        #expect(model.draftThreadAccess == nil)
        #expect(model.effectiveThreadAccess == nil)
    }

    // MARK: QA-008 / QA-069 — honest Changes load states

    @MainActor
    @Test func noChangeOutcomeIsEmptyAndNeverFetchesOrFails() async {
        let fetched = FetchFlag()
        AppRequestStubURLProtocol.handler = { _ in fetched.hit = true; return (stubOK(), Data()) }
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = stubbedModel()
        // A terminal no-change agent run whose canonical zero-byte patch path exists.
        model.liveTasks = [run(
            artifactPaths: ["final/patch.diff"],
            outcomeFacts: RunOutcomeFacts(lifecycle: "succeeded", noChanges: true,
                                          checks: "not_configured", review: "not_run",
                                          reason: "no_changes"))]

        let outcome = await model.loadRunDiff("run-1")

        #expect(isEmpty(outcome))       // legitimate empty, never .failed + Retry
        #expect(fetched.hit == false)   // short-circuited before any GET
    }

    @MainActor
    @Test func aFetchedZeroBytePatchIsEmptyNotFailed() async {
        AppRequestStubURLProtocol.handler = { _ in (stubOK(), Data("   \n".utf8)) }
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = stubbedModel()
        // No typed noChanges fact, but the fetched body is blank — benign empty.
        model.liveTasks = [run(artifactPaths: ["final/patch.diff"])]

        let outcome = await model.loadRunDiff("run-1")
        #expect(isEmpty(outcome))
    }

    @MainActor
    @Test func aRealPatchLoads() async {
        let diff = """
        diff --git a/f.txt b/f.txt
        index 000..111 100644
        --- a/f.txt
        +++ b/f.txt
        @@ -0,0 +1 @@
        +hello
        """
        AppRequestStubURLProtocol.handler = { _ in (stubOK(), Data(diff.utf8)) }
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = stubbedModel()
        model.liveTasks = [run(artifactPaths: ["final/patch.diff"])]

        let outcome = await model.loadRunDiff("run-1")
        #expect(isLoaded(outcome))
        #expect(model.task("run-1")?.diff.isEmpty == false)
    }

    // MARK: QA-052 — runs-list refresh single-flight / coalescing

    @MainActor
    @Test func overlappingRunRefreshesCoalesceIntoOneInFlightRequest() async {
        let count = ListCounter()
        AppRequestStubURLProtocol.handler = { _ in
            count.n += 1
            // A tiny delay so several refreshRuns calls genuinely overlap.
            Thread.sleep(forTimeInterval: 0.05)
            return (stubOK(), Data(#"{"runs":[]}"#.utf8))
        }
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = stubbedModel()

        // Fire several refreshes concurrently: they must SHARE the in-flight pass
        // (at most one trailing) — never five parallel full-history GETs.
        async let a: Void = model.refreshRuns()
        async let b: Void = model.refreshRuns()
        async let c: Void = model.refreshRuns()
        async let d: Void = model.refreshRuns()
        async let e: Void = model.refreshRuns()
        _ = await (a, b, c, d, e)

        #expect(count.n <= 2)              // one in-flight + at most one trailing
        #expect(model.runsRefreshTask == nil)   // settled, nothing dangling
    }

    // MARK: QA-065 — session account label resolution

    @MainActor
    @Test func sessionAccountLabelResolvesProfileNameWithFallbacks() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        // nil profile = the harness's default vendor login.
        #expect(model.sessionAccountLabel(harnessId: "claude", profileId: nil) == "Default account")
        // Unknown profile (registry not loaded) falls back to the raw id, visibly.
        #expect(model.sessionAccountLabel(harnessId: "claude", profileId: "work") == "work")
    }

    // MARK: QA-072 — project nesting lookup

    @MainActor
    @Test func projectNestingLooksUpByCanonicalRoot() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let child = try JSONDecoder().decode(RegisteredProject.self, from: Data(#"""
        {"schemaVersion":1,"id":"child","root":"/repo/child","createdAt":"2026-07-19T12:00:00.000Z",
         "updatedAt":"2026-07-19T12:00:00.000Z",
         "nesting":[{"relation":"inside","root":"/repo","projectId":"parent"}]}
        """#.utf8))
        model.registeredProjects = [child]

        #expect(model.projectNesting(forRoot: "/repo/child").first?.relation == "inside")
        #expect(model.projectNesting(forRoot: "/repo/other").isEmpty)   // disjoint stays quiet
        #expect(model.projectNesting(forRoot: "").isEmpty)
    }

    // Helpers -------------------------------------------------------------

    @MainActor
    private func stubbedModel() -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config))
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        model.health = .connected
        return model
    }

    private func isEmpty(_ o: RunDiffLoadOutcome) -> Bool {
        if case .empty = o { return true }; return false
    }
    private func isLoaded(_ o: RunDiffLoadOutcome) -> Bool {
        if case .loaded = o { return true }; return false
    }
}

private final class FetchFlag: @unchecked Sendable { var hit = false }
private final class ListCounter: @unchecked Sendable { var n = 0 }

private func stubOK() -> HTTPURLResponse {
    HTTPURLResponse(url: URL(string: "http://127.0.0.1:1234")!, statusCode: 200,
                    httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
}

private final class AppRequestStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        DispatchQueue.global().async { [self] in
            do {
                guard let handler = Self.handler else {
                    throw NSError(domain: "stub", code: 1)
                }
                let (response, data) = try handler(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }
    override func stopLoading() {}
}
