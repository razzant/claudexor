import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

@Suite(.serialized)
struct AppModelRefreshTests {
    @MainActor
    @Test func hardOfflineDropsDaemonProjectionsAndKeepsLocalDraft() throws {
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test"
        ), requestNotificationAuthorization: false)
        model.health = .connected
        model.endpoint = "127.0.0.1:1234"
        model.route = .task("stale-run")
        model.liveTasks = [TaskRun(
            id: "stale-run", title: "Stale", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"stale-thread","title":"Stale","repoRoot":"/tmp/project","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":["stale-run"],"headRunId":"stale-run","needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"}"#.utf8))
        model.threads = [thread]
        model.selectedThreadId = thread.id
        model.selectedThreadDetail = ThreadDetailResponse(thread: thread, sessions: [], turns: [])
        model.liveHarnesses = [HarnessInfo(family: .claude, health: .ok, version: "1.0.0", auth: "native", intents: ["implement"])]
        model.settingsSnapshot = try JSONDecoder().decode(SettingsSnapshot.self, from: Data(#"{"sources":[],"routing":{"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":900000}"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"{"snapshots":[],"refreshed_at":"2026-07-15T00:00:00Z"}"#.utf8))
        model.storedSecrets = [try JSONDecoder().decode(SecretInfo.self, from: Data(#"{"name":"stale","backend":"file","present":true}"#.utf8))]
        model.trustEntries = [try JSONDecoder().decode(TrustEntry.self, from: Data(#"{"repoRoot":"/tmp/project","path":"/tmp/trust.json","allowFullAccess":true,"accessDefault":"full"}"#.utf8))]
        model.draftPrimaryHarness = "claude"
        model.draftEligiblePool = ["claude"]
        model.draftIsolatedWorkspace = true
        let preservedProjectRoot = model.projectRoot
        let preservedAppearance = model.appearance

        model.enterHardOffline()

        #expect(model.health == .offline)
        #expect(model.client == nil)
        #expect(model.endpoint.isEmpty)
        #expect(model.route == .threads)
        #expect(model.liveTasks.isEmpty)
        #expect(model.threads.isEmpty)
        #expect(model.selectedThreadId == nil)
        #expect(model.selectedThreadDetail == nil)
        #expect(model.liveHarnesses.isEmpty)
        #expect(model.settingsSnapshot == nil)
        #expect(model.quotaResponse == nil)
        #expect(model.storedSecrets.isEmpty)
        #expect(model.trustEntries.isEmpty)
        #expect(model.secretBackend == "unknown")
        #expect(model.draftPrimaryHarness == "claude")
        #expect(model.draftEligiblePool == ["claude"])
        #expect(model.draftIsolatedWorkspace)
        #expect(model.projectRoot == preservedProjectRoot)
        #expect(model.appearance == preservedAppearance)
    }

    /// D26: with no thread selected, the sticky write scope is a DRAFT value the
    /// composer edits and `newThread` carries onto the created thread; clearing
    /// it (nil) falls back to the repo trust default (composer shows Workspace).
    @MainActor
    @Test func draftThreadAccessPersistsAndClearsWithoutAThread() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        #expect(model.effectiveThreadAccess == nil)
        await model.setThreadAccess("full")
        #expect(model.draftThreadAccess == "full")
        #expect(model.effectiveThreadAccess == "full")
        await model.setThreadAccess(nil)
        #expect(model.draftThreadAccess == nil)
        #expect(model.effectiveThreadAccess == nil)
    }

    /// Round-3 item 1a: a DRAFT composer chip selection (Claude + pinned profile
    /// claude4) must ride into the CREATE request body — the first turn requests
    /// exactly what the chip showed, with no window where a visible selection
    /// silently doesn't apply. Asserts the wire body, not just local state.
    @MainActor
    @Test func draftChipSelectionRidesIntoThreadCreateBody() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config))
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        model.health = .connected
        model.projectRoot = "/tmp/project"
        // The composer HarnessAccountChip in the draft state: Claude + claude4.
        await model.setThreadCredentialProfile("claude4", harnessId: "claude")
        #expect(model.draftPrimaryHarness == "claude")
        #expect(model.draftCredentialProfileId == "claude4")
        #expect(model.draftEligiblePool == ["claude"])

        let box = CreateBodyBox()
        let summary = #"{"id":"new-thread","title":null,"repoRoot":"/tmp/project","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":"claude","eligibleHarnesses":["claude"],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"}"#
        AppRequestStubURLProtocol.handler = { request in
            if request.httpMethod == "POST", request.url?.path == "/v2/threads" {
                box.data = appTestRequestBody(request)
                return (appResponse(for: request), Data(summary.utf8))
            }
            // openThread's follow-up detail GET — minimal, turn-less.
            let detail = #"{"thread":\#(summary),"sessions":[],"turns":[]}"#
            return (appResponse(for: request), Data(detail.utf8))
        }

        await model.newThread(title: nil)

        let body = try #require(box.data)
        let req = try JSONDecoder().decode(CreateThreadRequest.self, from: body)
        #expect(req.primaryHarness == "claude")
        #expect(req.credentialProfileId == "claude4")
        #expect(req.eligibleHarnesses == ["claude"])
    }

    /// Round-3 item 1b: the receipt disclosure line for a harness mismatch is
    /// built ONLY from typed event facts (requested/effective/reason) — never
    /// invented. "requested claude → ran on codex (claude quota exhausted)".
    @MainActor
    @Test func primaryDivergedNoteRendersFromEventFacts() {
        #expect(
            AppModel.primaryDivergedNote(requested: "claude", effective: "codex", reason: "quota_exhausted")
                == "requested claude → ran on codex (claude quota exhausted)")
        #expect(
            AppModel.primaryDivergedNote(requested: "claude", effective: "codex", reason: "auth_unavailable")
                == "requested claude → ran on codex (claude unavailable)")
        // No effective harness: honest "no harness could run".
        #expect(
            AppModel.primaryDivergedNote(requested: "claude", effective: nil, reason: "money_exhausted")
                == "requested claude → no harness could run (claude budget exhausted)")
    }

    @MainActor
    @Test func runlessGlobalQuotaEventRefreshesQuotaProjection() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        model.health = .connected
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/quota" else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), Data(#"{"snapshots":[],"refreshed_at":null}"#.utf8))
        }

        await model.handleGlobalEvent(JournalEvent(
            cursor: "epoch:2",
            partition: "global",
            type: "quota.snapshot.upserted",
            observedAt: "2026-07-15T00:00:00Z",
            payload: .object([:])
        ))

        #expect(model.quotaResponse?.snapshots.isEmpty == true)
        #expect(model.quotaStatus == nil)
    }

    @MainActor
    @Test func runListRefreshDoesNotNPlusOneHydrateEmptyReviewFindings() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let detailCalls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            if request.url?.path == "/v2/runs" {
                let json = #"{"runs":[{"runId":"r1","state":"succeeded"},{"runId":"r2","state":"failed"},{"runId":"r3","state":"blocked"}]}"#
                return (appResponse(for: request), Data(json.utf8))
            }
            if request.url?.path.hasPrefix("/v2/runs/") == true {
                detailCalls.increment()
            }
            throw AppRefreshTestError.badRequest
        }

        await model.refreshRuns()

        #expect(model.liveTasks.count == 3)
        #expect(detailCalls.count == 0)
    }

    @MainActor
    @Test func threadHeadPingRefetchesThreadListOnceAndDropsStaleRevisions() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        model.health = .connected
        let listCalls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/threads" else { throw AppRefreshTestError.badRequest }
            listCalls.increment()
            let json = #"{"threads":[{"id":"th-1","title":"Pinged","repoRoot":"/tmp/project","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":["run-1"],"headRunId":"run-1","needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-16T00:00:00Z"}]}"#
            return (appResponse(for: request), Data(json.utf8))
        }
        func ping(_ revision: Int) -> JournalEvent {
            JournalEvent(
                cursor: "epoch:\(revision)", partition: "global", type: "thread.head.updated",
                observedAt: "2026-07-16T00:00:00Z",
                payload: .object([
                    "thread_id": .string("th-1"),
                    "project_id": .null,
                    "revision": .number(Double(revision))
                ])
            )
        }

        // A replayed burst folds into ONE refetch (single-flight coalescer +
        // per-thread revision watermark).
        await model.handleGlobalEvent(ping(1))
        await model.handleGlobalEvent(ping(2))
        await model.handleGlobalEvent(ping(2)) // duplicate delivery — dropped
        await model.threadsRefreshTask?.value
        #expect(model.threads.map(\.id) == ["th-1"])
        #expect(listCalls.count == 1)

        // An already-reflected revision schedules nothing at all.
        await model.handleGlobalEvent(ping(2))
        #expect(model.threadsRefreshTask == nil)

        // A newer revision refetches again.
        await model.handleGlobalEvent(ping(3))
        await model.threadsRefreshTask?.value
        #expect(listCalls.count == 2)
    }

    @MainActor
    @Test func corruptedFractionalPingRevisionNeverBecomesAValidWatermark() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.health = .connected
        let listCalls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/threads" else { throw AppRefreshTestError.badRequest }
            listCalls.increment()
            return (appResponse(for: request), Data(#"{"threads":[]}"#.utf8))
        }
        func ping(_ revision: Double) -> JournalEvent {
            JournalEvent(
                cursor: "epoch:x", partition: "global", type: "thread.head.updated",
                observedAt: "2026-07-16T00:00:00Z",
                payload: .object([
                    "thread_id": .string("th-1"), "project_id": .null,
                    "revision": .number(revision)
                ])
            )
        }

        // A corrupted 1.6 must NOT round into watermark 2: it degrades to a
        // plain refetch with no dedupe claim…
        await model.handleGlobalEvent(ping(1.6))
        await model.threadsRefreshTask?.value
        #expect(model.threadHeadRevisions["th-1"] == nil)
        #expect(listCalls.count == 1)
        // …so the NEXT genuine revision 2 still refetches instead of being
        // swallowed as "already reflected".
        await model.handleGlobalEvent(ping(2))
        await model.threadsRefreshTask?.value
        #expect(listCalls.count == 2)
        #expect(model.threadHeadRevisions["th-1"] == 2)

        // Negative garbage also degrades to refetch-without-watermark.
        await model.handleGlobalEvent(ping(-3))
        await model.threadsRefreshTask?.value
        #expect(model.threadHeadRevisions["th-1"] == 2)
        #expect(listCalls.count == 3)
    }

    @MainActor
    @Test func failedPingRefetchStaysDirtyAndRetriesUntilTheListHeals() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.health = .connected
        let listCalls = AppRefreshCallCounter()
        // The daemon dies right after delivering the ping: the FIRST list
        // request fails, and no second ping will ever arrive (the cursor
        // already consumed the only one).
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/threads" else { throw AppRefreshTestError.badRequest }
            listCalls.increment()
            return (
                HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"error":"daemon restarting"}"#.utf8)
            )
        }
        await model.handleGlobalEvent(JournalEvent(
            cursor: "epoch:1", partition: "global", type: "thread.head.updated",
            observedAt: "2026-07-16T00:00:00Z",
            payload: .object(["thread_id": .string("th-1"), "project_id": .null, "revision": .number(1)])
        ))
        await model.threadsRefreshTask?.value
        #expect(listCalls.count == 1)
        // The invalidation is durable: dirty holds and a retry is re-armed.
        #expect(model.threadsRefresh.dirty)
        #expect(model.threadsRefreshTask != nil)

        // The daemon comes back: the retry heals the list WITHOUT a new ping.
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/threads" else { throw AppRefreshTestError.badRequest }
            listCalls.increment()
            let json = #"{"threads":[{"id":"th-1","title":"Healed","repoRoot":"/tmp/project","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-16T00:00:00Z"}]}"#
            return (appResponse(for: request), Data(json.utf8))
        }
        await model.threadsRefreshTask?.value
        #expect(listCalls.count == 2)
        #expect(!model.threadsRefresh.dirty)
        #expect(model.threads.map(\.id) == ["th-1"])
        #expect(model.threadsRefreshTask == nil)
    }

    @Test func taggedUnlimitedBudgetRendersUnlimitedInsteadOfUnknown() {
        var task = TaskRun(
            id: "run", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        task.applyPaidBudget(.unlimited)

        #expect(task.budgetUnlimited)
        #expect(task.budgetLabel == "Unknown / Unlimited")
    }

    @MainActor
    @Test func budgetEventAcceptsAnExplicitFiniteZeroCap() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-zero", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 1, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]

        model.apply(BusEnvelope(seq: 1, kind: "budget", event: .object([
            "type": .string("budget.lease.created"),
            "payload": .object(["max_usd": .number(0)])
        ])), to: "run-zero")

        #expect(model.liveTasks[0].capUsd == 0)
        #expect(model.liveTasks[0].capKnown)
    }

    @MainActor
    @Test func availabilityReadsServerRoutableIntentsNotLocalDerivation() {
        let model = AppModel(requestNotificationAuthorization: false)
        // Healthy + intent enabled, but the SERVER says not routable (e.g.
        // auth died between doctor runs): the chip must be unavailable — the
        // client never re-derives routability from health + enabled intents.
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "native",
            intents: ["implement"], routableIntents: [],
            reasons: ["claude session expired"]
        )]
        let unavailable = model.availability(for: .claude, mode: .agent)
        #expect(!unavailable.available)
        #expect(unavailable.reason == "claude session expired")

        // The server's routable verdict is sufficient for availability.
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "native",
            intents: ["implement"], routableIntents: ["implement"]
        )]
        #expect(model.availability(for: .claude, mode: .agent).available)
    }

    @MainActor
    @Test func onboardingIsDerivedFromServerRoutabilityNotStickyState() throws {
        let model = AppModel(requestNotificationAuthorization: false)
        model.health = .connected
        // Doctor rows not loaded yet: no verdict — the wizard must not flash.
        #expect(!model.needsOnboarding(userDismissed: false))

        // Rows loaded, none routable, a STALE SECRET present: onboarding is
        // needed — a stored key is not readiness (R18).
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .degraded, version: "1", auth: "session expired",
            intents: ["implement"], routableIntents: []
        )]
        model.storedSecrets = [try JSONDecoder().decode(
            SecretInfo.self, from: Data(#"{"name":"stale","backend":"file","present":true}"#.utf8)
        )]
        #expect(model.needsOnboarding(userDismissed: false))

        // The user's explicit dismissal wins and never auto-resets.
        #expect(!model.needsOnboarding(userDismissed: true))

        // One routable harness ends onboarding without any sticky flag.
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "native",
            intents: ["implement"], routableIntents: ["implement"]
        )]
        #expect(!model.needsOnboarding(userDismissed: false))

        // Offline again: the projection is gone, no verdict — no wizard.
        model.health = .offline
        #expect(!model.needsOnboarding(userDismissed: false))
    }

    @MainActor
    @Test func fullAccessGrantDrivesTheComposerCTAOnlyForTheExactRepo() throws {
        let model = AppModel(requestNotificationAuthorization: false)
        // No entries: nothing is granted — the CTA must show for Full access.
        #expect(!model.fullAccessGranted(repoRoot: "/tmp/project"))
        model.trustEntries = [try JSONDecoder().decode(
            TrustEntry.self,
            from: Data(#"{"repoRoot":"/tmp/project","path":"/tmp/trust.json","allowFullAccess":true,"accessDefault":"full"}"#.utf8)
        )]
        #expect(model.fullAccessGranted(repoRoot: "/tmp/project"))
        // A grant never leaks to another repo.
        #expect(!model.fullAccessGranted(repoRoot: "/tmp/other"))
    }

    /// W4.3: the cash fact renders through ONE formatter — plain dollars,
    /// $0.00 on subscription, sub-cent cash never reads as zero. The old
    /// route-based "≈$" inference is gone (the ledger owns billing truth).
    @MainActor
    @Test func cashSpendFormatsThroughTheOneOwner() {
        #expect(CashSpend.label(0) == "$0.00")
        #expect(CashSpend.label(1.234) == "$1.23")
        #expect(CashSpend.label(0.0043) == "$0.0043")
        #expect(CashSpend.label(0.01) == "$0.01")
        // A legacy estimate hedges in EVERY surface (never plain dollars).
        #expect(CashSpend.label(1.234, estimated: true) == "~$1.23")
    }

    /// Per-turn auth route honesty (sol review #1): "Thread default" (empty)
    /// sends NO override; explicit Auto rides the wire and beats a pinned
    /// thread preference instead of silently inheriting it.
    @MainActor
    @Test func perTurnAuthRouteSendsExplicitAutoAndOnlyEmptyInherits() {
        #expect(ThreadsScreen.authRouteRequest("") == nil)
        #expect(ThreadsScreen.authRouteRequest("auto") == "auto")
        #expect(ThreadsScreen.authRouteRequest("subscription") == "subscription")
        #expect(ThreadsScreen.authRouteRequest("api_key") == "api_key")

        #expect(ThreadsScreen.authRouteCaption("") == "Thread default")
        #expect(ThreadsScreen.authRouteCaption("auto") == "Auto")
        #expect(ThreadsScreen.authRouteCaption("api_key") == "API key")
        #expect(ThreadsScreen.authRouteCaption("subscription") == "Subscription")
    }

    /// Model catalogs cache per (family, route): reopening an unchanged
    /// popover fetches NOTHING; a route flip or newly pooled family fetches
    /// exactly the missing entries (sol review #7).
    @MainActor
    @Test func modelCatalogFetchPlanSkipsCachedFamilyRoutePairs() {
        let claude = HarnessFamily.claude, codex = HarnessFamily.codex
        // Nothing cached: fetch everything.
        #expect(ComposerModelsSection.familiesToFetch([claude, codex], route: nil, cached: [String]())
                == [claude, codex])
        // Reopen with both cached under the SAME route: zero fetches.
        let cached = [ComposerModelsSection.catalogKey(claude, route: nil),
                      ComposerModelsSection.catalogKey(codex, route: nil)]
        #expect(ComposerModelsSection.familiesToFetch([claude, codex], route: nil, cached: cached).isEmpty)
        // A route change is a different truth source: everything refetches.
        #expect(ComposerModelsSection.familiesToFetch([claude, codex], route: "api_key", cached: cached)
                == [claude, codex])
        // A newly pooled family fetches alone.
        #expect(ComposerModelsSection.familiesToFetch([claude, codex], route: nil,
                                                      cached: [ComposerModelsSection.catalogKey(claude, route: nil)])
                == [codex])
    }

    @MainActor
    @Test func routeScopedModelVisibilityHidesOnlyForeignAnnotatedModels() {
        let models = [
            HarnessModel(id: "native-only", routes: ["local_session"]),
            HarnessModel(id: "api-only", routes: ["api_key"]),
            HarnessModel(id: "everywhere"),
        ]
        // Subscription route: api-only models are hidden (the strict preflight
        // would refuse them), unannotated ride every route.
        #expect(ComposerModelsSection.visibleModels(models, route: "local_session").map(\.id)
                == ["native-only", "everywhere"])
        // Auto (nil): nothing is hidden — either route may win at run time.
        #expect(ComposerModelsSection.visibleModels(models, route: nil).map(\.id)
                == ["native-only", "api-only", "everywhere"])
    }

    @MainActor
    @Test func authModeLabelSpeaksSubscriptionApiKeyAndDegradesHonestly() {
        #expect(RunFacts.authModeLabel("local_session") == "Subscription")
        #expect(RunFacts.authModeLabel("api_key") == "API key")
        #expect(RunFacts.authModeLabel("future_mode") == "Future Mode")
    }

    @Test func quotaDatesParseFractionalIsoBeforePlainIso() {
        let fractional = "2026-07-15T10:00:01.123Z"
        let plain = "2026-07-15T10:00:01Z"
        #expect(formattedDate(fractional) != fractional)
        #expect(formattedDate(plain) != plain)
        #expect(formattedDate("not-a-date") == "not-a-date")
    }

    @MainActor
    @Test func freshHarnessRefreshReportsFailureAndKeepsLastKnownRows() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)

        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses", request.url?.query == "fresh=true" else {
                throw AppRefreshTestError.badRequest
            }
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"harnesses":[{"id":"claude","status":"ok","manifest":null}]}"#.utf8)
            )
        }
        #expect(await model.refreshHarnesses(fresh: true))
        #expect(model.liveHarnesses.map(\.family) == [.claude])

        AppRequestStubURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"error":"doctor unavailable"}"#.utf8)
            )
        }
        #expect(!(await model.refreshHarnesses(fresh: true)))
        #expect(model.liveHarnesses.map(\.family) == [.claude])
    }

    @MainActor
    @Test func imageSupportComesFromFiniteAttachmentInputManifest() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses" else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), Data(#"{"harnesses":[{"id":"claude","status":"ok","manifest":{"capability_profile":{"attachment_inputs":[{"kind":"image","mime_types":["image/png"],"max_bytes":1048576,"max_count":2,"transport":"file_path"}]}}}]}"#.utf8))
        }

        #expect(await model.refreshHarnesses())
        #expect(model.harnessInfo(for: .claude)?.acceptsImages == true)
    }

    @MainActor
    @Test func lifecycleRefreshTargetsOneExactSourceAndPreservesCatalogState() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)

        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses", request.url?.query == nil else {
                throw AppRefreshTestError.badRequest
            }
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"harnesses":[{"id":"claude","status":"degraded","manifest":{"version":"1.2.3"},"enabledIntents":["review"],"authSources":[{"source":"native_session","availability":"unknown","verification":"not_run"}]}]}"#.utf8)
            )
        }
        #expect(await model.refreshHarnesses())
        let aggregateSummary = model.harnessInfo(for: .claude)?.auth

        AppRequestStubURLProtocol.handler = { request in
            guard request.httpMethod == "POST",
                  request.url?.path == "/v2/harnesses/claude/auth-readiness",
                  request.url?.query == nil,
                  let body = appTestRequestBody(request),
                  let object = try JSONSerialization.jsonObject(with: body) as? [String: String],
                  object == ["authRequest":"subscription", "source":"native_session"] else {
                throw AppRefreshTestError.badRequest
            }
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"harnessId":"claude","authRequest":"subscription","requestedSource":"native_session","observedAt":"2026-07-14T00:00:00Z","readiness":{"source":"native_session","availability":"available","verification":"passed","detail":"Native session verified"}}"#.utf8)
            )
        }

        #expect(await model.refreshAuthReadinessAfterSetupLifecycle(for: .claude, job: nil))
        #expect(model.harnessInfo(for: .claude)?.nativeSessionReady == true)
        #expect(model.harnessInfo(for: .claude)?.health == .degraded)
        #expect(model.harnessInfo(for: .claude)?.version == "1.2.3")
        #expect(model.harnessInfo(for: .claude)?.intents == ["review"])
        #expect(model.harnessInfo(for: .claude)?.auth == aggregateSummary)
        #expect(model.authSource(for: .claude, source: .nativeSession)?.detail == "Native session verified")
    }

    @MainActor
    @Test func rawAPISetupAndAPIKeyReadinessNeverUseRetiredRawHarnessId() async throws {
        #expect(HarnessFamily.raw.setupHarnessId == "raw-api")
        #expect(HarnessFamily.raw.apiKeyAuthReadinessRequest == AuthReadinessRefreshRequest(
            authRequest: .apiKey,
            source: .apiKeyEnvironment
        ))
    }

    @MainActor
    @Test func successfulSecretWriteIsNotReportedAsFailedWhenExactProbeFails() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)

        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/secrets"):
                return (appResponse(for: request), Data("{}".utf8))
            case ("GET", "/v2/secrets"):
                return (appResponse(for: request), Data(#"{"backend":"file","secrets":[]}"#.utf8))
            case ("POST", "/v2/harnesses/raw-api/auth-readiness"):
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type":"application/problem+json"]
                )!
                return (response, Data(#"{"code":"probe_failed","message":"offline","retryable":true}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let outcome = await model.storeSecret(name: "raw_api", value: "redacted", for: .raw)
        #expect(outcome.stored)
        #expect(!outcome.readinessRefreshed)
        #expect(model.secretBackend == "file")
    }

    @MainActor
    @Test func typedControlProblemIsUsedForUserFacingGatewayFailure() {
        let model = AppModel(requestNotificationAuthorization: false)
        let error = GatewayError.http(status: 503, body: """
        {"code":"auth_readiness_probe_failed","message":"probe unavailable","retryable":true,
         "fieldErrors":{},"requiredActions":["retry_auth_readiness_refresh"],"evidenceRefs":[]}
        """)
        let message = model.userMessage(for: error)
        #expect(message.contains("auth_readiness_probe_failed"))
        #expect(message.contains("probe unavailable"))
        #expect(message.contains("retry_auth_readiness_refresh"))
    }

    @Test(arguments: [
        (SetupLifecycleConnection.recovering, false),
        (.reconnecting, false),
        (.streamLost, false),
        (.idle, true)
    ])
    func closePolicyGuardsUnknownLifecycleState(
        _ connection: SetupLifecycleConnection,
        _ actionInFlight: Bool
    ) {
        #expect(AuthSheetClosePolicy.requiresConfirmation(
            job: nil,
            connection: connection,
            actionInFlight: actionInFlight
        ))
    }

    @Test func closePolicyGuardsActiveAndUnconfirmedJobsButNotSafeTerminal() {
        let active = appSetupJob(id: "active", state: "running")
        let unsafe = appSetupJob(
            id: "unsafe", state: "cancelled",
            outcome: SetupJobOutcome(reason: .terminationUnconfirmed)
        )
        let safe = appSetupJob(
            id: "safe", state: "cancelled",
            outcome: SetupJobOutcome(reason: .cancelledByUser)
        )

        #expect(AuthSheetClosePolicy.requiresConfirmation(
            job: active, connection: .connected,
            actionInFlight: false
        ))
        #expect(AuthSheetClosePolicy.requiresConfirmation(
            job: unsafe, connection: .terminal,
            actionInFlight: false
        ))
        #expect(!AuthSheetClosePolicy.requiresConfirmation(
            job: safe, connection: .terminal,
            actionInFlight: false
        ))
    }

    @MainActor
    @Test func emptyFindingsNeverBecomeCleanWithoutEngineEvidence() {
        #expect(RunDetailMapping.reviewVerdict(
            decision: nil, candidates: [], findings: [], failure: nil, phase: .succeeded, outcomeFacts: nil
        ) == .notRun)
        let decision = JSONValue.object([
            "outcome": .string("ready"),
            "verification_basis": .string("cross_family_review")
        ])
        #expect(RunDetailMapping.reviewVerdict(
            decision: decision, candidates: [], findings: [], failure: nil, phase: .succeeded, outcomeFacts: nil
        ) == .clean)
    }

    @MainActor
    @Test func doctorAddsUnknownHarnessAndDeclaredEffortLevelsWithoutAppPatch() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        // Schema truth: the ladder lives at manifest.capabilities.effort_levels
        // (the old capability_profile path was a dead read — live manifests
        // never populated it, so every effort control stayed hidden).
        AppRequestStubURLProtocol.handler = { request in
            (appResponse(for: request), Data(#"{"harnesses":[{"id":"future-agent","status":"ok","manifest":{"capabilities":{"effort_levels":["fast","deep"]}}}]}"#.utf8))
        }
        #expect(await model.refreshHarnesses())
        #expect(model.selectableHarnesses.map(\.rawValue) == ["future-agent"])
        #expect(model.harnessInfo(for: HarnessFamily(rawValue: "future-agent"))?.effortLevels == ["fast", "deep"])
    }

    @MainActor
    @Test func delayedThreadAResponseCannotReplaceSelectedThreadB() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            let id = request.url!.lastPathComponent
            if id == "A" { Thread.sleep(forTimeInterval: 0.15) }
            let json = #"{"thread":{"id":"\#(id)","title":"\#(id)","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"},"sessions":[],"turns":[]}"#
            return (appResponse(for: request), Data(json.utf8))
        }
        let first = Task { await model.openThread("A") }
        try await Task.sleep(for: .milliseconds(20))
        await model.openThread("B")
        await first.value
        #expect(model.selectedThreadId == "B")
        #expect(model.selectedThreadDetail?.thread.id == "B")
    }

    @MainActor
    @Test func eventNewerThanDelayedDetailSnapshotReplaysAfterSnapshotMerge() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-delayed", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-delayed" else {
                throw AppRefreshTestError.badRequest
            }
            Thread.sleep(forTimeInterval: 0.18)
            let json = #"{"summary":{"runId":"run-delayed","state":"running","mode":"agent","spendUsd":1},"lastSeq":10}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        let load = Task { await model.loadRunDetail("run-delayed") }
        try await Task.sleep(for: .milliseconds(20))
        // The CASH disclosure (W4.3): cumulative, last-wins — the replayed
        // event is newer than the snapshot's spendUsd:1 and must overwrite it.
        model.ingestStreamEnvelope(BusEnvelope(
            seq: 11, kind: "budget",
            event: .object([
                "type": .string("budget.cash"),
                "payload": .object(["cash_spend_usd": .number(2)])
            ])
        ), to: "run-delayed")
        try await Task.sleep(for: .milliseconds(100))
        await load.value

        #expect(model.liveBoxes["run-delayed"]?.spendUsd == 2)
        #expect(model.liveBoxes["run-delayed"]?.spendKnown == true)
    }

    @MainActor
    @Test func runHydrationDoesNotFetchOrRenderRawDiagnosticsArtifacts() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-diag", title: "Run", prompt: "", mode: .agent, phase: .failed,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let artifactFetches = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            if request.url?.path == "/v2/runs/run-diag" {
                let json = #"{"summary":{"runId":"run-diag","state":"failed","mode":"agent"},"lastSeq":10,"artifacts":[{"path":"events.jsonl","kind":"file","bytes":3000000},{"path":"attempts/a01/rollout.jsonl","kind":"file","bytes":5000000},{"path":"final/patch.diff","kind":"file","bytes":2461063}]}"#
                return (appResponse(for: request), Data(json.utf8))
            }
            if request.url?.path.contains("/artifacts/") == true {
                if request.url?.path.contains("events.jsonl") == true
                    || request.url?.path.contains("rollout.jsonl") == true
                    || request.url?.path.contains("patch.diff") == true {
                    artifactFetches.increment()
                }
                if request.url?.path.contains("patch.diff") == true {
                    let patch = """
                    diff --git a/a.txt b/a.txt
                    --- a/a.txt
                    +++ b/a.txt
                    @@ -1 +1 @@
                    -old
                    +new

                    """
                    return (appResponse(for: request), Data(patch.utf8))
                }
                return (
                    HTTPURLResponse(
                        url: request.url!, statusCode: 404,
                        httpVersion: "HTTP/1.1", headerFields: nil)!,
                    Data()
                )
            }
            throw AppRefreshTestError.badRequest
        }

        await model.loadRunDetail("run-diag")

        #expect(artifactFetches.count == 0)
        let summary = model.liveTasks.first?.diagnosticText ?? ""
        #expect(summary.contains("events.jsonl · 3000000 bytes"))
        #expect(summary.contains("not loaded into the UI"))
        #expect(summary.count < 2_000)

        await model.loadRunDiff("run-diag")
        #expect(artifactFetches.count == 1)
        #expect(model.liveTasks.first?.diff.count == 1)
    }

    @MainActor
    @Test func milestoneBurstSharesOneDetailLoadAndAtMostOneTrailingRefresh() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-burst", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let calls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-burst" else {
                throw AppRefreshTestError.badRequest
            }
            calls.increment()
            Thread.sleep(forTimeInterval: 0.08)
            let json = #"{"summary":{"runId":"run-burst","state":"running","mode":"agent"},"lastSeq":10}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        let first = Task { await model.loadRunDetail("run-burst") }
        let duringTrailing = Task {
            try? await Task.sleep(for: .milliseconds(110))
            await model.loadRunDetail("run-burst")
        }
        try? await Task.sleep(for: .milliseconds(20))
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<5 {
                group.addTask { await model.loadRunDetail("run-burst") }
            }
        }
        await first.value
        await duringTrailing.value

        #expect(calls.count == 2)
    }

    @MainActor
    @Test func oversizedDiffReturnsVisibleFailureInsteadOfPerpetualLoading() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        var task = TaskRun(
            id: "run-large-diff", title: "Run", prompt: "", mode: .agent,
            phase: .succeeded, project: "Project",
            harnesses: [], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        task.artifactPaths = ["final/patch.diff"]
        model.liveTasks = [task]
        AppRequestStubURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 413, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type":"application/json"])!
            return (response, Data(#"{"error":"artifact exceeds 4 MiB text limit"}"#.utf8))
        }

        let outcome = await model.loadRunDiff("run-large-diff")

        guard case .failed(let message) = outcome else {
            Issue.record("expected a visible diff load failure")
            return
        }
        #expect(message.contains("413"))
        #expect(model.liveTasks[0].hasPatchArtifact)
    }

    /// W4.3: vendor cost ticks are VALUATION — they must never move the cash
    /// display. Only the ledger's budget.cash disclosure does.
    @MainActor
    @Test func valuationObservationsNeverMoveTheCashFact() async throws {
        let model = AppModel(
            client: GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test"),
            requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-cash", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        model.ingestStreamEnvelope(BusEnvelope(
            seq: 1, kind: "budget",
            event: .object([
                "type": .string("budget.observation"),
                "payload": .object(["usd": .number(2), "kind": .string("spend")])
            ])
        ), to: "run-cash")
        try await Task.sleep(for: .milliseconds(150)) // past the coalesced flush
        // A subscription run's vendor valuation ticked $2 — cash stays put.
        #expect((model.liveBoxes["run-cash"]?.spendUsd ?? 0) == 0)
        model.ingestStreamEnvelope(BusEnvelope(
            seq: 2, kind: "budget",
            event: .object([
                "type": .string("budget.cash"),
                "payload": .object(["cash_spend_usd": .number(0.4), "valuation_usd": .number(2)])
            ])
        ), to: "run-cash")
        // The cash disclosure MUST land. A fixed 150ms wait proved flaky on a
        // slow CI runner (v2.1.0 publish postmortem) — poll with a bounded
        // deadline instead; the assertions below still fail loudly on timeout.
        for _ in 0..<40 where model.liveBoxes["run-cash"]?.spendKnown != true {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(model.liveBoxes["run-cash"]?.spendUsd == 0.4)
        #expect(model.liveBoxes["run-cash"]?.spendKnown == true)
    }

    @Test func winnerEvidenceSeparatesSelectionFromFinalReviewTruth() throws {
        func candidate(reviewVerified: Bool, finalReviewClean: Bool?, blockers: Int = 0) throws -> Candidate {
            let cleanField = finalReviewClean.map { ",\"finalReviewClean\":\($0)" } ?? ""
            let json = """
            {"attemptId":"a01","harnessId":"claude","gatesPassed":2,"gatesTotal":2,
             "blockers":\(blockers),"reviewVerified":\(reviewVerified)\(cleanField),"winner":true}
            """
            let info = try JSONDecoder().decode(CandidateInfo.self, from: Data(json.utf8))
            return try #require(RunDetailMapping.candidates([info], runPhase: .succeeded).first)
        }

        let clean = try candidate(reviewVerified: true, finalReviewClean: true)
        #expect(RunDetailMapping.winnerEvidenceText(clean).contains("verified clean"))

        let unverified = try candidate(reviewVerified: false, finalReviewClean: true)
        #expect(RunDetailMapping.winnerEvidenceText(unverified).contains("unverified"))
        #expect(!RunDetailMapping.winnerEvidenceText(unverified).contains("verified clean"))

        let missing = try candidate(reviewVerified: true, finalReviewClean: nil)
        #expect(RunDetailMapping.winnerEvidenceText(missing).contains("clean verdict is missing"))

        let blocked = try candidate(reviewVerified: true, finalReviewClean: false, blockers: 1)
        #expect(RunDetailMapping.winnerEvidenceText(blocked).contains("blocked or not clean"))
    }

    // MARK: - V11b accounts binding (toggle → PATCH mapping)

    @MainActor
    @Test func setProfileEnabledPatchesTheCredentialProfileRoute() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)

        let patched = AppRefreshCallCounter()
        // The handler runs off the main actor (CFNetwork queue); keep body
        // decoding inline (no nested closure literal that would inherit the
        // test's @MainActor isolation and trap).
        AppRequestStubURLProtocol.handler = { request in
            if request.httpMethod == "PATCH",
               request.url?.path == "/v2/credential-profiles/claude/work" {
                guard let body = appTestRequestBody(request),
                      let object = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      object["enabled"] as? Bool == false else {
                    throw AppRefreshTestError.badRequest
                }
                patched.increment()
                let json = #"{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":false},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}"#
                return (appResponse(for: request), Data(json.utf8))
            }
            // The reload-after-PATCH re-reads the projection.
            if request.url?.path == "/v2/credential-profiles" {
                return (appResponse(for: request), Data(#"{"profiles":[],"harnessAccounts":[]}"#.utf8))
            }
            throw AppRefreshTestError.badRequest
        }

        let error = await model.setProfileEnabled(harnessId: "claude", profileId: "work", enabled: false)
        #expect(error == nil)
        #expect(patched.count == 1)
    }

    @MainActor
    @Test func setNativeCredentialsEnabledPatchesTheHarnessSettingsSurface() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)

        let patched = AppRefreshCallCounter()
        let settingsGets = AppRefreshCallCounter()
        let snapshot = #"{"sources":[],"routing":{"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":900000}"#
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/settings"):
                // The CLI-login toggle drives the per-harness native_credentials
                // setting via the settings PATCH surface — never the profile route.
                // Inline decode (no nested closure — the handler runs off-main).
                guard let body = appTestRequestBody(request),
                      let obj = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let harnesses = obj["harnesses"] as? [String: Any],
                      let claude = harnesses["claude"] as? [String: Any],
                      claude["nativeCredentialsEnabled"] as? Bool == false else {
                    throw AppRefreshTestError.badRequest
                }
                patched.increment()
                // The daemon answers a save with the fresh effective snapshot
                // (GET's shape), not the legacy v0.x {path} receipt (#20).
                return (appResponse(for: request), Data(snapshot.utf8))
            case ("GET", "/v2/settings"):
                // D1 fence (#20): the save answer IS the fresh snapshot; the
                // save path must never follow up with a GET. Counted, asserted 0.
                settingsGets.increment()
                return (appResponse(for: request), Data(snapshot.utf8))
            case (_, "/v2/harnesses"):
                return (appResponse(for: request), Data(#"{"harnesses":[]}"#.utf8))
            case (_, "/v2/credential-profiles"):
                return (appResponse(for: request), Data(#"{"profiles":[],"harnessAccounts":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let error = await model.setNativeCredentialsEnabled(harnessId: "claude", enabled: false)
        #expect(error == nil)
        #expect(patched.count == 1)
        #expect(settingsGets.count == 0)
        // The POST answer was APPLIED, not just decoded-and-dropped.
        #expect(model.settingsSnapshot?.interactionTimeoutMs == 900000)
        #expect(model.settingsSnapshot?.routing.envInheritance == "mirror_native")
    }
}

private func appSetupJob(
    id: String,
    state: String,
    outcome: SetupJobOutcome? = nil
) -> SetupJob {
    SetupJob(
        jobId: id,
        harness: .claude,
        action: .login,
        state: SetupJobState(rawValue: state)!,
        phase: state == "running" ? .awaitingUser : .completed,
        outcome: outcome,
        message: state,
        createdAt: "2026-07-14T00:00:00Z"
    )
}

private enum AppRefreshTestError: Error { case badRequest }

/// Thread-safe request counter (the URLProtocol handler runs off the main actor).
private final class AppRefreshCallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.lock(); value += 1; lock.unlock() }
    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

/// Captures a request body across the URLProtocol stub boundary (single-threaded
/// in these serialized tests; @unchecked to satisfy the @Sendable handler).
private final class CreateBodyBox: @unchecked Sendable {
    var data: Data?
}

private func appResponse(for request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type":"application/json"]
    )!
}

private func appTestRequestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { return nil }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

private final class AppRequestStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw AppRefreshTestError.badRequest }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@Suite(.serialized) struct DeferredEnvelopeBoundTests {
    /// W23: the snapshot-fence buffer is hard-capped; overflow flags the run
    /// for a FRESH snapshot instead of hoarding envelopes without limit.
    @MainActor
    @Test func deferredEnvelopesNeverExceedTheCapAndFlagOverflow() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.snapshotLoadDepth["run-flood"] = 1
        for seq in 1...(AppModel.deferredEnvelopeCap * 3) {
            model.apply(BusEnvelope(seq: seq, kind: "harness.event", event: .object([:])), to: "run-flood")
        }
        #expect((model.deferredEnvelopes["run-flood"]?.count ?? 0) <= AppModel.deferredEnvelopeCap)
        #expect(model.deferredOverflow.contains("run-flood"))
    }
}
