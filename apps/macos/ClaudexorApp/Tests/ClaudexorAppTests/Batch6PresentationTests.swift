import Testing
import Foundation
import ClaudexorKit
@testable import ClaudexorApp

/// Batch-6 item b: the auto-switch toggle targets harnesses with a SECOND account
/// and reports on/off/mixed/unavailable honestly.
@Suite struct AccountsAutoBalanceTests {
    @Test func eligibleRequiresASecondAccount() {
        // claude has a profile (native + profile = 2 identities) ⇒ eligible;
        // codex has none (only its native login) ⇒ not eligible.
        #expect(AccountsAutoBalance.eligibleHarnessIds(profileHarnessIds: ["claude"]) == ["claude"])
    }

    @Test func bothCapableHarnessesEligibleInCanonicalOrder() {
        let ids = AccountsAutoBalance.eligibleHarnessIds(profileHarnessIds: ["codex", "claude", "codex"])
        #expect(ids == ["claude", "codex"])
    }

    @Test func nonCapableHarnessProfilesAreIgnored() {
        // Only config_dir_login families can register a 2nd account.
        #expect(AccountsAutoBalance.eligibleHarnessIds(profileHarnessIds: ["cursor", "opencode"]).isEmpty)
    }

    @Test func stateAggregates() {
        #expect(AccountsAutoBalance.state(actions: []) == .unavailable)
        #expect(AccountsAutoBalance.state(actions: ["rotate", "rotate"]) == .on)
        #expect(AccountsAutoBalance.state(actions: ["fail", "ask"]) == .off)
        #expect(AccountsAutoBalance.state(actions: ["rotate", "fail"]) == .mixed)
    }
}

/// Batch-6 item g: the api-key meta-hosts (raw-api AND the openrouter raw-API
/// instance) render an accounts row only when configured, hidden otherwise.
@Suite struct ApiKeyMetaHostTests {
    /// W2-A3: BOTH raw-api and openrouter are api-key meta-hosts — the gating must
    /// match the copy, or a live openrouter host mis-renders as a native-login row.
    @Test func rawAndOpenRouterAreMetaHosts() {
        #expect(HarnessFamily.raw.isApiKeyMetaHost)
        #expect(HarnessFamily.openrouter.isApiKeyMetaHost)
        #expect(!HarnessFamily.claude.isApiKeyMetaHost)
        #expect(!HarnessFamily.codex.isApiKeyMetaHost)
        #expect(!HarnessFamily.cursor.isApiKeyMetaHost)
        #expect(!HarnessFamily.opencode.isApiKeyMetaHost)
    }
}

/// D42 item 4: the sidebar row status precedence (running outranks needs-decision).
@Suite struct ThreadRowStatusTests {
    @Test func runningWins() {
        #expect(ThreadRowStatus.of(running: true, needsHuman: true) == .running)
        #expect(ThreadRowStatus.of(running: true, needsHuman: false) == .running)
    }

    @Test func needsDecisionWhenNotRunning() {
        #expect(ThreadRowStatus.of(running: false, needsHuman: true) == .needsDecision)
    }

    @Test func idleOtherwise() {
        #expect(ThreadRowStatus.of(running: false, needsHuman: false) == .idle)
    }
}

/// D42: the thread's runs are aggregated in conversation order, de-duplicated.
@Suite struct ThreadWorkspaceRunIdsTests {
    private func turn(_ id: String, run: String?) -> ThreadTurnInfo {
        ThreadTurnInfo(id: id, threadId: "t", runId: run, parentRunId: nil, planRunId: nil,
                       kind: nil, prompt: "", run: nil, createdAt: "2026-07-20T00:00:00Z")
    }

    @Test func orderedAndDeduped() {
        let detail = ThreadDetailResponse(
            thread: sampleThread(),
            sessions: [],
            turns: [turn("a", run: "r1"), turn("b", run: nil), turn("c", run: "r2"), turn("d", run: "r1")])
        #expect(ThreadWorkspacePanel.threadRunIds(detail) == ["r1", "r2"])
    }

    @Test func emptyWhenNoRuns() {
        let detail = ThreadDetailResponse(thread: sampleThread(), sessions: [], turns: [turn("a", run: nil)])
        #expect(ThreadWorkspacePanel.threadRunIds(detail).isEmpty)
    }

    private func sampleThread() -> ThreadSummary {
        // ThreadSummary's memberwise init is internal to the Kit; decode the wire
        // shape instead (also exercises the DTO decode).
        let json = #"""
        {"id":"t","title":"T","repoRoot":"/x","workspaceMode":"in_place","runIds":["r1","r2"],
         "headRunId":"r2","needsHuman":false,"createdAt":"2026-07-20T00:00:00Z","updatedAt":"2026-07-20T00:00:00Z"}
        """#
        return try! JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
    }
}
