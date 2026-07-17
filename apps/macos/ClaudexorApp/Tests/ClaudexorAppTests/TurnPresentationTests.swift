import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// W4.1/W4.2 state matrix (sol #14): the messenger card's status line and
/// attention chip come from a PURE mapper — no snapshot framework, layout is
/// owner visual-QA. These pin the semantics: quiet facts stay quiet, ONE loud
/// chip only when attention exists, retry folds into the state word, race
/// identity never guesses a winner.
@Suite struct TurnPresentationTests {
    private func line(
        _ status: RunStatus,
        harnesses: [HarnessFamily] = [.codex],
        n: Int = 1,
        retry: String? = nil,
        waiting: Bool = false
    ) -> TurnPresentation.StatusLine {
        TurnPresentation.statusLine(
            status: status, harnesses: harnesses, n: n, retryLabel: retry, waitingOnUser: waiting)
    }

    @Test func activeRunSaysWorkingAndFoldsRetryIntoTheStateWord() {
        #expect(line(.running).stateWord == "Working…")
        // Retry is FOLDED into the state word (never a second capsule).
        #expect(line(.running, retry: "Retrying 2/10 · in 2.5s").stateWord == "Retrying 2/10 · in 2.5s")
        #expect(TurnPresentation.attention(status: .running, waitingOnUser: false) == nil)
    }

    @Test func identityIsSingleHarnessOrBestOfNeverAGuess() {
        let single = line(.running, harnesses: [.claude])
        #expect(single.identity == HarnessFamily.claude.label)
        #expect(single.family == .claude)
        // A race shows Best-of N — harnesses.first may be a LOSING candidate.
        let race = line(.running, harnesses: [.claude, .codex], n: 3)
        #expect(race.identity == "Best-of 3")
        #expect(race.family == nil)
        #expect(line(.running, harnesses: []).identity == nil)
    }

    @Test func quietTerminalsKeepAQuietStateWordAndNoChip() {
        #expect(line(.succeeded).stateWord == RunStatus.succeeded.label)
        #expect(TurnPresentation.attention(status: .succeeded, waitingOnUser: false) == nil)
        #expect(line(.cancelled).stateWord == RunStatus.cancelled.label)
        #expect(TurnPresentation.attention(status: .cancelled, waitingOnUser: false) == nil)
    }

    @Test func attentionStatesRaiseOneLoudChipWithoutStutter() {
        // Failure: the chip voices the state; the state word goes silent —
        // never "Failed [Failed]".
        let failed = TurnPresentation.attention(status: .failed, waitingOnUser: false)
        #expect(failed == TurnPresentation.Attention(text: RunStatus.failed.label, tone: .failure))
        #expect(line(.failed).stateWord == nil)

        let blocked = TurnPresentation.attention(status: .blocked, waitingOnUser: false)
        #expect(blocked == TurnPresentation.Attention(text: "Needs you", tone: .warning))
        #expect(line(.blocked).stateWord == nil)

        // A pending question outranks everything.
        let waiting = TurnPresentation.attention(status: .running, waitingOnUser: true)
        #expect(waiting == TurnPresentation.Attention(text: "Needs your answer", tone: .warning))
        // …and the active state word stays (the run IS still working).
        #expect(line(.running, waiting: true).stateWord == "Working…")
    }

    @Test func activitySummaryCountsHonestlyAndDegradesToNil() {
        #expect(TurnPresentation.activitySummary(blocks: []) == nil)
        let blocks: [TranscriptBlock] = [
            .thinking(id: "t1", text: "…", seconds: 25),
            .thinking(id: "t2", text: "…", seconds: 15),
            .tool(id: "a", ToolBlock(name: "Bash", kind: "command", status: .ok)),
            .tool(id: "b", ToolBlock(name: "Read", kind: "file", status: .ok)),
            .tool(id: "c", ToolBlock(name: "Edit", kind: "file", status: .error)),
            .message(id: "m", text: "answer"),
        ]
        #expect(TurnPresentation.activitySummary(blocks: blocks) == "Thinking 40s · 3 tools · 2 files")
        // A poor stream (codex/cursor: no thinking events) omits the component
        // instead of rendering a hollow zero (honest degradation).
        let toolsOnly: [TranscriptBlock] = [
            .tool(id: "a", ToolBlock(name: "Bash", kind: "command", status: .ok))
        ]
        #expect(TurnPresentation.activitySummary(blocks: toolsOnly) == "1 tool")
        // Messages alone still open the strip with a neutral label.
        #expect(TurnPresentation.activitySummary(blocks: [.message(id: "m", text: "hi")]) == "Activity")
    }
}

/// W4.4 (В9а): the flat transcript fold — grouped runs, failures stand
/// alone, thinking is a timer row, poor streams degrade honestly.
@Suite struct TranscriptFoldTests {
    private func ok(_ id: String, _ name: String, kind: String = "file") -> TranscriptBlock {
        .tool(id: id, ToolBlock(name: name, kind: kind, status: .ok))
    }

    @Test func runsOfMoreThanThreeSameNameOkToolsCollapse() {
        let rows = TranscriptPresentation.rows([
            ok("1", "Read"), ok("2", "Read"), ok("3", "Read"), ok("4", "Read"),
            ok("5", "Bash", kind: "command"),
        ])
        #expect(rows == [
            .toolGroup(id: "1", name: "Read", kind: "file", count: 4),
            .tool(id: "5", ToolBlock(name: "Bash", kind: "command", status: .ok)),
        ])
        // Exactly three stays ungrouped (the threshold is >3).
        let three = TranscriptPresentation.rows([ok("1", "Read"), ok("2", "Read"), ok("3", "Read")])
        #expect(three.count == 3)
    }

    @Test func failuresAndRunningToolsNeverGroupAndBreakRuns() {
        let failed = TranscriptBlock.tool(
            id: "f", ToolBlock(name: "Read", kind: "file", status: .error, detail: "boom", exitCode: 1))
        let rows = TranscriptPresentation.rows([
            ok("1", "Read"), ok("2", "Read"), failed, ok("3", "Read"), ok("4", "Read"),
        ])
        // The failure splits the run: 2 + 2 stay under the threshold, and the
        // failed row stands alone with its status intact.
        #expect(rows.count == 5)
        if case .tool(_, let tool) = rows[2] { #expect(tool.status == .error) }
        else { Issue.record("failed tool must stand alone") }
    }

    @Test func poorStreamsDegradeHonestly() {
        // codex/cursor: no thinking events -> no thinking rows, nothing invented.
        let toolsOnly = TranscriptPresentation.rows([ok("1", "Bash", kind: "command")])
        #expect(toolsOnly == [.tool(id: "1", ToolBlock(name: "Bash", kind: "command", status: .ok))])
        #expect(TranscriptPresentation.rows([]).isEmpty)
        // Thinking is a single timer row — never an expandable body in chat.
        let thinking = TranscriptPresentation.rows([.thinking(id: "t", text: "reasoning…", seconds: 12)])
        #expect(thinking == [.thinking(id: "t", seconds: 12)])
    }
}

/// W4.6 (sol #17): inspector visibility is a SIMPLE state machine — explicit
/// open, manual close respected, no route-derived auto-present.
@Suite struct InspectorVisibilityTests {
    @MainActor
    @Test func inspectorPresentsOnlyOnExplicitOpenAndRespectsManualClose() {
        let model = AppModel(
            client: GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test"),
            requestNotificationAuthorization: false)
        #expect(model.inspectorPresented == false)

        // Derived navigation (launch bookkeeping, jobId->runId remap) must
        // never pop the inspector.
        model.route = .task("r1")
        #expect(model.inspectorPresented == false)

        // The explicit affordance opens it — including a same-route click.
        model.openRun("r1")
        #expect(model.inspectorPresented)

        // A manual close STAYS closed through further navigation…
        model.inspectorPresented = false
        model.route = .task("r2")
        #expect(model.inspectorPresented == false)

        // …until the next explicit open.
        model.openRun("r2")
        #expect(model.inspectorPresented)
    }
}

/// W4.8 (В21а): one primary CTA by cause; one merged job status — never
/// contradictory combos.
@Suite struct AuthSheetPresentationTests {
    private func cta(
        healthOk: Bool = false, nativeSupported: Bool = true, nativeReady: Bool = false,
        keyStored: Bool = false, streamLost: Bool = false, jobActive: Bool = false,
        blocksReplacement: Bool = false
    ) -> AuthSheetPresentation.PrimaryCTA {
        AuthSheetPresentation.primaryCTA(
            healthOk: healthOk, nativeSupported: nativeSupported, nativeReady: nativeReady,
            keyStored: keyStored, streamLost: streamLost, jobActive: jobActive,
            blocksReplacement: blocksReplacement)
    }

    @Test func primaryCTAFollowsTheCauseLadder() {
        // Unknown process state resolves before anything else.
        #expect(cta(streamLost: true) == .reconnect)
        #expect(cta(blocksReplacement: true) == .reconnect)
        // An active job means the primary thing is already happening.
        #expect(cta(jobActive: true) == .done)
        // Healthy sheet: closing is the only primary act.
        #expect(cta(healthOk: true, nativeReady: true) == .done)
        // The readiness ladder: the CTA addresses the CAUSE. Native path:
        // no verified session -> log in; verified but degraded -> re-probe
        // (a missing fallback key is `skip`, never the cause — triad sol #1).
        #expect(cta() == .login)
        #expect(cta(nativeReady: true) == .retryProbe)
        #expect(cta(nativeReady: true, keyStored: true) == .retryProbe)
        // Non-native path: the key IS the credential — store it, then re-probe.
        #expect(cta(nativeSupported: false) == .storeKey)
        #expect(cta(nativeSupported: false, keyStored: true) == .retryProbe)
    }

    @Test func jobStatusLineNeverContradictsItself() {
        // Active: the phase speaks, the state stays silent.
        #expect(AuthSheetPresentation.jobStatusLine(
            state: .waitingForInput, phase: .awaitingUser, outcomeReason: nil, exitCode: nil
        ) == "Waiting for you to finish the login")
        // Success is ONE phrase — no state+outcome+exit pileup.
        #expect(AuthSheetPresentation.jobStatusLine(
            state: .succeeded, phase: .completed, outcomeReason: "completed", exitCode: 0
        ) == "Login verified")
        // Failure folds its evidence into one phrase.
        #expect(AuthSheetPresentation.jobStatusLine(
            state: .failed, phase: .completed, outcomeReason: "command_failed", exitCode: 1
        ) == "Failed (exit 1)")
        #expect(AuthSheetPresentation.jobStatusLine(
            state: .failed, phase: .completed, outcomeReason: "auth_not_ready", exitCode: 0
        ) == "Failed (auth not ready)")
        // The unconfirmed-termination special case keeps its exact warning.
        #expect(AuthSheetPresentation.jobStatusLine(
            state: .interruptedUnknown, phase: .completed,
            outcomeReason: "termination_unconfirmed", exitCode: nil
        ) == "Process termination is unconfirmed")
    }
}
