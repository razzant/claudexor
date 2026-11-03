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
        _ phase: RunPhase,
        reason: String? = nil,
        harnesses: [HarnessFamily] = [.codex],
        n: Int = 1,
        isRace: Bool = false,
        retry: String? = nil,
        needsDecision: Bool = false,
        waiting: Bool = false
    ) -> TurnPresentation.StatusLine {
        TurnPresentation.statusLine(
            phase: phase, reason: reason, harnesses: harnesses, n: n, isRace: isRace, retryLabel: retry,
            reviewNeedsDecision: needsDecision, waitingOnUser: waiting, unfinishedWork: nil)
    }

    private func attention(
        _ phase: RunPhase, reason: String? = nil, needsDecision: Bool = false, waiting: Bool = false
    ) -> TurnPresentation.Attention? {
        TurnPresentation.attention(
            phase: phase, reason: reason, reviewNeedsDecision: needsDecision, waitingOnUser: waiting,
            unfinishedWork: nil)
    }

    @Test func autoLoginRequiresProvenIdleRecovery() {
        let idle = SetupLifecycleSnapshot(connection: .idle)
        let unknown = SetupLifecycleSnapshot(
            connection: .streamLost, lastError: "snapshot unavailable")
        #expect(AuthSheetPresentation.shouldAutoStartLogin(
            requested: true, consumed: false, lifecycle: idle, targetVerified: false))
        #expect(!AuthSheetPresentation.shouldAutoStartLogin(
            requested: true, consumed: false, lifecycle: unknown, targetVerified: false))
        #expect(!AuthSheetPresentation.shouldAutoStartLogin(
            requested: true, consumed: true, lifecycle: idle, targetVerified: false))
        #expect(!AuthSheetPresentation.shouldAutoStartLogin(
            requested: true, consumed: false, lifecycle: idle, targetVerified: true))
    }

    @Test func activeRunSaysWorkingAndFoldsRetryIntoTheStateWord() {
        #expect(line(.running).stateWord == "Working…")
        // Retry is FOLDED into the state word (never a second capsule).
        #expect(line(.running, retry: "Retrying 2/10 · in 2.5s").stateWord == "Retrying 2/10 · in 2.5s")
        #expect(attention(.running) == nil)
    }

    @Test func identityIsSingleHarnessOrBestOfNeverAGuess() {
        let single = line(.running, harnesses: [.claude])
        #expect(single.identity == HarnessFamily.claude.label)
        #expect(single.family == .claude)
        // A race shows Best-of N — harnesses.first may be a LOSING candidate.
        let race = line(.running, harnesses: [.claude, .codex], n: 3, isRace: true)
        #expect(race.identity == "Best-of 3")
        #expect(race.family == nil)
        // A multi-harness pool alone does not prove a race.
        #expect(line(.running, harnesses: [.claude, .codex], n: 1).identity == nil)
        #expect(line(.running, harnesses: []).identity == nil)
    }

    @MainActor
    @Test func attemptsRunWithAMultiHarnessPoolDoesNotManufactureARaceCount() throws {
        let summary = try JSONDecoder().decode(
            RunSummary.self,
            from: Data(#"{"runId":"run-one","state":"running","mode":"agent","strategy":"attempts","harnesses":["claude","codex"]}"#.utf8))
        let run = AppModel.liveTask(from: summary)
        #expect(run.mode == .maxAttempts)
        #expect(run.n == 1)
        #expect(line(
            run.phase,
            harnesses: run.harnesses,
            n: run.n,
            isRace: run.mode == .bestOfN
        ).identity == nil)
    }

    @Test func quietTerminalsKeepAQuietStateWordAndNoChip() {
        #expect(line(.succeeded).stateWord == RunPhase.succeeded.label)
        #expect(attention(.succeeded) == nil)
        #expect(line(.cancelled).stateWord == RunPhase.cancelled.label)
        #expect(line(.cancelled, reason: "user_cancelled").stateWord == "Cancelled")
        #expect(line(.cancelled, reason: "wall_clock_exceeded").stateWord == "Time limit reached")
        #expect(attention(.cancelled) == nil)
    }

    @Test func maxTurnsStopIsNamedLikeTheEngineLabel() {
        // #299: the engine's `interrupted / turn_limit_reached` ("Turn limit reached").
        #expect(attention(.interrupted, reason: "turn_limit_reached")
            == TurnPresentation.Attention(text: "Turn limit reached", tone: .failure))
        #expect(line(.interrupted, reason: "turn_limit_reached").stateWord == nil)
        #expect(attention(.interrupted)
            == TurnPresentation.Attention(text: RunPhase.interrupted.label, tone: .failure))
    }

    @Test func attentionStatesRaiseOneLoudChipWithoutStutter() {
        // Failure: the chip voices the lifecycle terminal; the state word goes
        // silent — never "Failed [Failed]".
        let failed = attention(.failed)
        #expect(failed == TurnPresentation.Attention(text: RunPhase.failed.label, tone: .failure))
        #expect(line(.failed).stateWord == nil)
        // A typed reason names the failure precisely in the chip.
        #expect(attention(.failed, reason: "budget_overshoot")
            == TurnPresentation.Attention(text: "Budget overshot", tone: .failure))

        // A review that needs an operator decision (the ex `.blocked`/
        // `.needsReview` status) is derived from the axis, not a status enum.
        let needsDecision = attention(.succeeded, needsDecision: true)
        #expect(needsDecision == TurnPresentation.Attention(text: "Needs you", tone: .warning))
        #expect(line(.succeeded, needsDecision: true).stateWord == nil)

        // A pending question outranks everything — and the chip IS the state
        // fact: the quiet word yields so the line stays at four facts.
        let waiting = attention(.running, waiting: true)
        #expect(waiting == TurnPresentation.Attention(text: "Needs your answer", tone: .warning))
        #expect(line(.running, waiting: true).stateWord == nil)
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

/// W4.4 (V9a): the flat transcript fold — grouped runs, failures stand
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

/// W4.8 (V21a): one primary CTA by cause; one merged job status — never
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

    /// The card renders for every managed harness now that a terminal-mode
    /// claude/cursor login discloses its `oauth_url` through the same overlay.
    /// While it named OpenAI unconditionally it told a user signing in to
    /// Anthropic to sign in to OpenAI, and offered a codex-only escape hatch
    /// that could not run — a card that renders nothing is a missing feature,
    /// a card that states the wrong vendor is a false statement on screen.
    @Test func loginDisclosureCardNamesItsOwnHarnessAndHidesTheCodexOnlyAction() {
        let codex = AuthSheetPresentation.loginDisclosureCard(harness: .codex)
        #expect(codex.vendor == "Codex")
        #expect(codex.offersBrowserCallback)

        for (harness, vendor) in [(SetupHarness.claude, "Claude"), (.cursor, "Cursor")] {
            let card = AuthSheetPresentation.loginDisclosureCard(harness: harness)
            #expect(card.vendor == vendor)
            #expect(card.vendor != "OpenAI")
            // The browser-callback flow is a codex app-server selector; there
            // is nothing for a terminal login to switch to.
            #expect(!card.offersBrowserCallback)
        }
    }

    /// The paste field of an `oauth_url_input` sign-in. Submit is disabled for
    /// exactly three causes and each one says WHY (INV-134), and the lapsed
    /// window outranks the rest: once the vendor closed it, no code the user
    /// types can succeed, so "type it again" would be a lie on screen.
    @Test func signInCodeSubmitNamesItsRealBlockingCause() {
        typealias Availability = AuthSheetPresentation.SignInCodeAvailability
        #expect(Availability(windowLapsed: false, sending: false, codeField: "PASTE-42").enabled)

        let empty = Availability(windowLapsed: false, sending: false, codeField: "   \n")
        #expect(!empty.enabled)
        #expect(empty.blockedReason == .emptyField)
        #expect(empty.help.contains("Paste the code"))

        let sending = Availability(windowLapsed: false, sending: true, codeField: "PASTE-42")
        #expect(sending.blockedReason == .sending)

        // Lapsed wins over a filled field AND over an in-flight submission.
        for (isSending, field) in [(false, "PASTE-42"), (true, "PASTE-42"), (false, "")] {
            let lapsed = Availability(windowLapsed: true, sending: isSending, codeField: field)
            #expect(lapsed.blockedReason == .windowLapsed)
            #expect(lapsed.help.contains("new link"))
        }
    }

    @Test func namedProfileNeverExposesTheGlobalFallbackKeyPanel() {
        #expect(AuthSheetPresentation.showsGlobalApiKeyPanel(
            profileId: nil, secretName: "anthropic"))
        #expect(!AuthSheetPresentation.showsGlobalApiKeyPanel(
            profileId: "work", secretName: "anthropic"))
        #expect(!AuthSheetPresentation.showsGlobalApiKeyPanel(
            profileId: nil, secretName: nil))
    }

    /// #132 class fix: the Store-key action has ONE availability owner. Its
    /// causes rank by severity — offline beats busy beats empty field — and
    /// each cause explains itself, so the hover never claims "empty field"
    /// while the real blocker is the engine connection or a running action.
    @Test func storeKeyAvailabilityRanksItsCausesAndExplainsEachOne() {
        typealias Availability = AuthSheetPresentation.StoreKeyAvailability
        let offline = Availability(gatewayAvailable: false, actionInFlight: true, keyField: "")
        #expect(offline.blockedReason == .gatewayOffline)
        #expect(!offline.enabled)
        #expect(offline.panelHelp == "Engine offline: reconnect before storing a key.")

        let busy = Availability(gatewayAvailable: true, actionInFlight: true, keyField: "")
        #expect(busy.blockedReason == .actionInFlight)
        #expect(busy.panelHelp == "Wait for the current action to finish.")

        // Whitespace-only input is as empty as no input: the store guard
        // trims before writing, so the projection trims before enabling.
        let empty = Availability(gatewayAvailable: true, actionInFlight: false, keyField: " \n")
        #expect(empty.blockedReason == .emptyKeyField)
        #expect(empty.panelHelp == "Enter the API key in the fallback field first.")

        let ready = Availability(gatewayAvailable: true, actionInFlight: false, keyField: "sk-x")
        #expect(ready.enabled)
        #expect(ready.blockedReason == nil)
        #expect(ready.panelHelp
            == "Store this fallback API key, then refresh exactly that credential source.")
    }

    /// The projection takes no family input, so every key family (opencode,
    /// raw, openrouter) shares it by construction; the footer help path is
    /// the one place a family enters the signature — pin that each family
    /// gets the SAME cause-specific text there, and that the projection's
    /// cause outranks the generic busy wording for the store-key CTA only.
    @Test func storeKeyFooterHelpIsCauseSpecificForEveryKeyFamily() {
        for family in [HarnessFamily.opencode, .raw, .openrouter] {
            #expect(AuthSheetPresentation.PrimaryCTA.storeKey.help(
                family: family.label, busy: false, storeKeyBlocked: .emptyKeyField
            ) == "Enter the API key in the fallback field first.")
            // Offline outranks busy: the footer must not say "wait" while
            // the engine is unreachable.
            #expect(AuthSheetPresentation.PrimaryCTA.storeKey.help(
                family: family.label, busy: true, storeKeyBlocked: .gatewayOffline
            ) == "Engine offline: reconnect before storing a key.")
        }
        // A non-storeKey CTA ignores the store-key cause and keeps its ladder.
        #expect(AuthSheetPresentation.PrimaryCTA.retryProbe.help(
            family: "OpenRouter", busy: false, storeKeyBlocked: .emptyKeyField
        ) == "Run a fresh, non-cached Harness Doctor probe.")
    }

    /// #132 R1 (M-C2): the family→managed-slot mapping is a pure helper the
    /// sheet consumes, pinned HERE against the exact engine grammar
    /// (packages/util/src/secret-names.ts) — a view-only revert of
    /// AuthSheet.swift can no longer silently drop a family's slot while the
    /// suite stays green. Rendering of the private view state still needs the
    /// VM visual acceptance.
    @Test func managedSecretSlotPinsTheEngineGrammarPerFamily() {
        #expect(AuthSheetPresentation.managedSecretSlot(for: .openrouter) == "openrouter")
        #expect(AuthSheetPresentation.managedSecretSlot(for: .raw) == "raw")
        #expect(AuthSheetPresentation.managedSecretSlot(for: .copilot) == "copilot")
        // A family without an API-key fallback maps to nil: no key panel,
        // no Store-key CTA.
        #expect(AuthSheetPresentation.managedSecretSlot(for: .fake) == nil)
    }

    /// Copilot's only credential is the managed token: the sheet's Recheck and
    /// the post-store verify both probe the api-key route, as for opencode.
    @Test func copilotReadinessRequestsProbeTheManagedTokenRoute() {
        let apiKey = AuthReadinessRefreshRequest(authRequest: .apiKey, source: .apiKeyEnvironment)
        #expect(HarnessFamily.copilot.defaultAuthReadinessRequest == apiKey)
        #expect(HarnessFamily.copilot.apiKeyAuthReadinessRequest == apiKey)
    }

    @Test func serverOwnedJobTargetWinsWithoutTreatingDefaultAsMissing() {
        let profileJob = fallbackJob(
            harness: .codex, state: .notSupported,
            errorCode: .deviceAuthUnsupported, profileId: "work")
        #expect(AuthSheetPresentation.setupTarget(
            requestedProfileId: "other", job: profileJob, bootstrapProfileId: "codex-default"
        ) == .init(profileId: "work", differsFromRequested: true))

        let defaultJob = fallbackJob(
            harness: .codex, state: .notSupported,
            errorCode: .deviceAuthUnsupported, profileId: nil)
        #expect(AuthSheetPresentation.setupTarget(
            requestedProfileId: "work", job: defaultJob, bootstrapProfileId: "codex-default"
        ) == .init(profileId: nil, differsFromRequested: true))
        #expect(AuthSheetPresentation.setupTarget(
            requestedProfileId: "work", job: nil, bootstrapProfileId: "codex-default"
        ) == .init(profileId: "work", differsFromRequested: false))
    }

    /// Unified account model (K.4): a PROFILE-LESS request is the bootstrap
    /// sugar — the engine may resolve the job onto the `<harness>-default` row
    /// and report that id. The sheet FOLLOWS the resolution (verification and
    /// controls target the row), and it is not presented as a target mismatch.
    @Test func bootstrapLoginResolvesOntoItsRowWithoutAMismatch() {
        let resolvedJob = fallbackJob(
            harness: .cursor, state: .notSupported,
            errorCode: .deviceAuthUnsupported, profileId: "cursor-default")
        #expect(AuthSheetPresentation.setupTarget(
            requestedProfileId: nil, job: resolvedJob, bootstrapProfileId: "cursor-default"
        ) == .init(profileId: "cursor-default", differsFromRequested: false))
        // A claude/codex bootstrap keeps the default-store job (null target) —
        // still the requested flow, never a mismatch.
        let defaultJob = fallbackJob(
            harness: .codex, state: .notSupported,
            errorCode: .deviceAuthUnsupported, profileId: nil)
        #expect(AuthSheetPresentation.setupTarget(
            requestedProfileId: nil, job: defaultJob, bootstrapProfileId: "codex-default"
        ) == .init(profileId: nil, differsFromRequested: false))
    }

    /// The bootstrap suppression must not swallow OWNERSHIP: a family sheet
    /// (nil target) that adopts an active login of someone else's NAMED row
    /// keeps the disclosure — only the family's own bootstrap resolution and
    /// jobs this sheet created itself are silent.
    @Test func familySheetDisclosesAForeignNamedRowsLoginButNotItsOwn() {
        let foreignJob = fallbackJob(
            harness: .claude, state: .notSupported,
            errorCode: .deviceAuthUnsupported, profileId: "work")
        // Adopted from the server, not created here: the ownership note stays.
        #expect(AuthSheetPresentation.setupTarget(
            requestedProfileId: nil, job: foreignJob, bootstrapProfileId: "claude-default"
        ) == .init(profileId: "work", differsFromRequested: true))
        // The SAME job started by this sheet is the user's own choice here.
        #expect(AuthSheetPresentation.setupTarget(
            requestedProfileId: nil, job: foreignJob, bootstrapProfileId: "claude-default",
            sheetCreatedJob: true
        ) == .init(profileId: "work", differsFromRequested: false))
        // And the family's bootstrap row id is the reserved `<harness>-default`.
        #expect(AccountsPresentation.bootstrapProfileId(for: .claude) == "claude-default")
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

    // D-17 audit point 8: the codex device-code `not_supported` state is a
    // first-class native ACTION, not a dead-end label — keyed on the consistent
    // typed code `device_auth_unsupported` on the native-command receipt.
    private func fallbackJob(
        harness: SetupHarness, state: SetupJobState, errorCode: SetupNativeCommandErrorCode?,
        profileId: String? = nil
    ) -> SetupJob {
        let receipt: SetupNativeCommandReceipt? = errorCode.map {
            SetupNativeCommandReceipt(
                executionId: "exec-1", commandDigest: String(repeating: "a", count: 64),
                manifestDigest: String(repeating: "b", count: 64), permitIssuedAt: nil,
                commandStarted: false, exitCode: nil, signal: nil, errorCode: $0,
                finishedAt: "2026-07-23T00:00:00Z")
        }
        return SetupJob(
            jobId: "j", harness: harness, action: .login, state: state, phase: .completed,
            outcome: SetupJobOutcome(reason: state == .notSupported ? .notSupported : .commandFailed),
            message: "m", createdAt: "2026-07-23T00:00:00Z", nativeCommand: receipt,
            profileId: profileId)
    }

    @Test func deviceAuthUnsupportedExposesTheTerminalFallbackAction() {
        let job = fallbackJob(harness: .codex, state: .notSupported, errorCode: .deviceAuthUnsupported)
        // Not a dead-end label: the state yields a first-class native action.
        #expect(AuthSheetPresentation.deviceAuthFallback(job: job) == .terminalLogin)
    }

    @Test func notSupportedWithoutTheTypedCodeHasNoFallbackAction() {
        // e.g. vendor not installed — no device_auth_unsupported receipt, so the
        // Terminal-fallback action is not claimed.
        let job = fallbackJob(harness: .codex, state: .notSupported, errorCode: nil)
        #expect(AuthSheetPresentation.deviceAuthFallback(job: job) == nil)
    }

    @Test func deviceAuthFallbackIsCodexOnlyAndNotSupportedOnly() {
        #expect(AuthSheetPresentation.deviceAuthFallback(
            job: fallbackJob(harness: .claude, state: .notSupported, errorCode: .deviceAuthUnsupported)) == nil)
        #expect(AuthSheetPresentation.deviceAuthFallback(
            job: fallbackJob(harness: .codex, state: .failed, errorCode: .deviceAuthUnsupported)) == nil)
    }
}
