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
        model.credentialProfiles = [try JSONDecoder().decode(CredentialProfileEntry.self, from: Data(#"{"profile":{"profile_id":"p1","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","isolation_locator":null,"enabled":true},"status":{"availability":"available","verification":"not_run","detail":null,"last_verified_at":null}}"#.utf8))]
        model.accountPools = [try JSONDecoder().decode(HarnessAccountPool.self, from: Data(#"{"harness_id":"claude","next_up":{"kind":"profile","profileId":"p1"}}"#.utf8))]
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
        #expect(model.harnessReadinessFresh == nil)
        #expect(model.gitCapability == nil)
        #expect(model.settingsSnapshot == nil)
        #expect(model.quotaResponse == nil)
        #expect(model.storedSecrets.isEmpty)
        #expect(model.trustEntries.isEmpty)
        // X140 class: the account registries the sessions footer reads are wiped
        // so the last daemon's accounts are not presented as current truth.
        #expect(model.credentialProfiles.isEmpty)
        #expect(model.accountPools.isEmpty)
        #expect(model.secretBackend == "unknown")
        #expect(model.draftPrimaryHarness == "claude")
        #expect(model.draftEligiblePool == ["claude"])
        #expect(model.draftIsolatedWorkspace)
        #expect(model.projectRoot == preservedProjectRoot)
        #expect(model.appearance == preservedAppearance)
    }

    @MainActor
    @Test func localOfflineKeepsRemoteSubmissionAndCancellationState() {
        let model = AppModel(requestNotificationAuthorization: false)
        let remote = ExecutionLocationID.remote(UUID())
        model.selectedExecutionLocation = remote
        model.selectedThreadId = "remote-thread"
        model.turnSubmitting = true
        model.rememberRunCancelled("local-run", at: .local)
        model.rememberRunCancelled("remote-run", at: remote)

        model.enterHardOffline()

        #expect(model.turnSubmitting)
        #expect(!model.wasRunCancelled("local-run", at: .local))
        #expect(model.wasRunCancelled("remote-run", at: remote))
        #expect(model.selectedThreadId == "remote-thread")
        #expect(model.selectedExecutionLocation == remote)
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
    @Test func generalGlobalStreamDropsQuotaMarkersWithoutALiveSubscriber() async throws {
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
        let quotaCalls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            quotaCalls.increment()
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

        #expect(quotaCalls.count == 0)
        #expect(model.quotaResponse == nil)
        #expect(model.quotaStatus == nil)
        #expect(model.accountsQuotaDisplayMarkerCursors[.local] == nil)
    }

    @MainActor
    @Test func connectionRetirementCannotLeaveAccountsLanesLoading() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.accountsRegistryLoadStates[.local] = .loading
        model.accountsLoadStates[.local] = .loading
        model.accountsReadinessAuthorityFresh[.local] = true
        model.accountsNextUpAuthorityFresh[.local] = true

        model.retireAccountsRequests(at: .local)

        #expect(model.accountsRegistryLoadStates[.local] == .idle)
        #expect(model.accountsLoadStates[.local] == .idle)
        #expect(model.accountsReadinessAuthorityFresh[.local] == false)
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
    }

    @MainActor
    @Test func accountsSubscriberHydratesQuotaBeforeAnyFullRefreshAndMarkerReplacesIt() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41130), requestNotificationAuthorization: false)
        let quotaCalls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/quota", request.httpMethod == "GET" else {
                throw AppRefreshTestError.badRequest
            }
            let call = quotaCalls.incrementAndGet()
            return (appResponse(for: request), appQuotaResponse(
                subjectID: "work",
                observedAt: "2026-08-09T00:00:0\(call)Z"))
        }

        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await waitForAppTest(
            { quotaCalls.count == 1 && model.quotaResponse != nil },
            message: "initial subscriber quota GET never committed")
        #expect(model.accountsRefreshGenerations[.local] == nil)

        await model.handleGlobalEvent(JournalEvent(
            cursor: "epoch:3",
            partition: "global",
            type: AppModel.quotaProjectionMarker,
            observedAt: "2026-08-09T00:00:02Z",
            payload: .object([:])))
        try await waitForAppTest(
            { quotaCalls.count == 2 && model.accountsQuotaDisplayTasks[.local] == nil },
            message: "marker-triggered display quota GET never settled")
        #expect(model.quotaResponse?.refreshedAt == "2026-08-09T00:00:02Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] != true)
    }

    @MainActor
    @Test func remoteQuotaMarkersCoalesceToOneLeadAndOneTrailingDisplayRead() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let remote = ExecutionLocationID.remote(UUID())
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.remoteClients[remote] = appTestGateway(port: 41131)
        let calls = AppRefreshCallCounter()
        let firstArrived = AppRefreshCallCounter()
        let secondArrived = AppRefreshCallCounter()
        let releaseFirst = DispatchSemaphore(value: 0)
        let releaseSecond = DispatchSemaphore(value: 0)
        defer { releaseFirst.signal(); releaseSecond.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/quota", request.url?.port == 41131 else {
                throw AppRefreshTestError.badRequest
            }
            let call = calls.incrementAndGet()
            if call == 1 {
                firstArrived.increment()
                _ = releaseFirst.wait(timeout: .now() + 5)
            } else {
                secondArrived.increment()
                _ = releaseSecond.wait(timeout: .now() + 5)
            }
            return (appResponse(for: request), appQuotaResponse(
                subjectID: "remote",
                observedAt: "2026-08-09T00:00:0\(call)Z"))
        }

        let subscription = model.beginAccountsQuotaSubscription(locationID: remote)
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await waitForAppTest(firstArrived, message: "remote lead quota GET never started")
        for _ in 0..<4 {
            model.noteQuotaProjectionMarker(at: remote, invalidateNextUp: false)
        }
        releaseFirst.signal()
        try await waitForAppTest(secondArrived, message: "remote trailing quota GET never started")
        for _ in 0..<4 {
            model.noteQuotaProjectionMarker(at: remote, invalidateNextUp: false)
        }
        releaseSecond.signal()
        try await waitForAppTest(
            { model.accountsQuotaDisplayTasks[remote] == nil },
            message: "remote display quota lane never settled")

        #expect(calls.count == 2)
        #expect(model.remoteQuotaResponses[remote]?.refreshedAt == "2026-08-09T00:00:02Z")
    }

    @MainActor
    @Test func generalAndDedicatedStreamsDeduplicateTheSameQuotaMarker() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41136), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        let markerArrived = AppRefreshCallCounter()
        let releaseMarker = DispatchSemaphore(value: 0)
        defer { releaseMarker.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/quota", request.httpMethod == "GET" else {
                throw AppRefreshTestError.badRequest
            }
            let call = calls.incrementAndGet()
            if call == 2 {
                markerArrived.increment()
                _ = releaseMarker.wait(timeout: .now() + 5)
            }
            return (appResponse(for: request), appQuotaResponse(
                subjectID: "work",
                observedAt: "2026-08-09T00:00:0\(call)Z"))
        }

        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await waitForAppTest(
            { calls.count == 1 && model.accountsQuotaDisplayTasks[.local] == nil },
            message: "initial subscriber quota GET never settled")

        let marker = JournalEvent(
            cursor: "quota:shared",
            partition: "global",
            type: AppModel.quotaProjectionMarker,
            observedAt: "2026-08-09T00:00:02Z",
            payload: .object([:]))
        await model.handleGlobalEvent(marker)
        try await waitForAppTest(markerArrived, message: "marker quota GET never started")
        model.accountsNextUpAuthorityFresh[.local] = true
        model.noteQuotaProjectionMarker(
            at: .local, invalidateNextUp: true, cursor: marker.cursor)
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)

        releaseMarker.signal()
        try await waitForAppTest(
            { model.accountsQuotaDisplayTasks[.local] == nil },
            message: "deduplicated marker quota GET never settled")
        #expect(calls.count == 2)
        #expect(model.quotaResponse?.refreshedAt == "2026-08-09T00:00:02Z")

        model.noteQuotaProjectionMarker(
            at: .local, invalidateNextUp: false, cursor: "quota:newer")
        try await waitForAppTest(
            { calls.count == 3 && model.accountsQuotaDisplayTasks[.local] == nil },
            message: "newer marker quota GET never settled")
        model.noteQuotaProjectionMarker(
            at: .local, invalidateNextUp: true, cursor: marker.cursor)
        #expect(calls.count == 3)
        #expect(model.accountsQuotaDisplayTasks[.local] == nil)
    }

    @MainActor
    @Test func quotaMarkerDeduplicationMemoryIsBounded() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        for index in 0..<40 {
            model.noteQuotaProjectionMarker(
                at: .local, invalidateNextUp: true, cursor: "quota:\(index)")
        }

        #expect(model.accountsQuotaDisplayMarkerCursors[.local]?.count == 32)
        #expect(model.accountsQuotaDisplayMarkerCursors[.local]?.first == "quota:8")
        #expect(model.accountsQuotaDisplayMarkerCursors[.local]?.last == "quota:39")
        #expect(model.accountsQuotaDisplayTasks[.local] == nil)
    }

    @MainActor
    @Test func successfulFullSnapshotSeedsItsMarkerBeforeGeneralStreamDelivery() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41138), requestNotificationAuthorization: false)
        let quotaCalls = AppRefreshCallCounter()
        let laterQuotaArrived = AppRefreshCallCounter()
        let releaseLaterQuota = DispatchSemaphore(value: 0)
        let releaseObserver = DispatchSemaphore(value: 0)
        defer {
            model.suspendAccountsQuotaObserver(at: .local, discardCursor: true)
            releaseLaterQuota.signal()
            releaseObserver.signal()
        }
        AppRequestStubURLProtocol.handler = { request in
            switch (request.url?.path, request.url?.query) {
            case ("/v2/quota", _):
                let call = quotaCalls.incrementAndGet()
                if call == 2 {
                    laterQuotaArrived.increment()
                    _ = releaseLaterQuota.wait(timeout: .now() + 5)
                }
                return (appResponse(for: request), appQuotaResponse(
                    subjectID: "work",
                    observedAt: call == 1
                        ? "2026-08-09T00:00:01Z" : "2026-08-09T00:00:07Z"))
            case ("/v2/credential-profiles", "snapshot=true"):
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "work", displayName: "Work",
                    observedAt: "2026-08-09T00:00:05Z",
                    quotaEventCursor: "quota:atomic"))
            case ("/v2/global/events", _):
                _ = releaseObserver.wait(timeout: .now() + 5)
                return (appResponse(for: request), Data())
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await waitForAppTest(
            { quotaCalls.count == 1 && model.accountsQuotaDisplayTasks[.local] == nil },
            message: "initial display quota GET never settled")
        #expect(await model.refreshAccounts() == nil)
        #expect(model.activeAccountsQuotaDisplayState == .current(
            observedAt: "2026-08-09T00:00:05Z"))
        #expect(model.accountsNextUpAuthorityFresh[.local] == true)

        await model.handleGlobalEvent(JournalEvent(
            cursor: "quota:atomic",
            partition: "global",
            type: AppModel.quotaProjectionMarker,
            observedAt: "2026-08-09T00:00:05Z",
            payload: .object([:])))
        #expect(quotaCalls.count == 1)
        #expect(model.accountsQuotaDisplayTasks[.local] == nil)
        #expect(model.activeAccountsQuotaDisplayState == .current(
            observedAt: "2026-08-09T00:00:05Z"))
        #expect(model.accountsNextUpAuthorityFresh[.local] == true)

        await model.handleGlobalEvent(JournalEvent(
            cursor: "quota:later",
            partition: "global",
            type: AppModel.quotaProjectionMarker,
            observedAt: "2026-08-09T00:00:06Z",
            payload: .object([:])))
        try await waitForAppTest(
            laterQuotaArrived, message: "later marker display quota GET never started")
        if case .stale = model.activeAccountsQuotaDisplayState {} else {
            Issue.record("a later marker must stale display data while its cheap GET runs")
        }
        #expect(model.accountsNextUpAuthorityFresh[.local] == true)

        model.noteQuotaProjectionMarker(
            at: .local, invalidateNextUp: true, cursor: "quota:later")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        releaseLaterQuota.signal()
        try await waitForAppTest(
            { quotaCalls.count == 2 && model.accountsQuotaDisplayTasks[.local] == nil },
            message: "later marker display quota GET never settled")
        #expect(model.activeAccountsQuotaDisplayState == .current(
            observedAt: "2026-08-09T00:00:07Z"))
    }

    @MainActor
    @Test func laterDisplayHydrationStaysCurrentWhenAnOlderFullRefreshFails() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41132), requestNotificationAuthorization: false)
        let fullArrived = AppRefreshCallCounter()
        let releaseFull = DispatchSemaphore(value: 0)
        defer { releaseFull.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch (request.url?.path, request.url?.query) {
            case ("/v2/credential-profiles", "snapshot=true"):
                fullArrived.increment()
                _ = releaseFull.wait(timeout: .now() + 5)
                return (appResponse(for: request, status: 503), Data(#"{"error":"full failed"}"#.utf8))
            case ("/v2/quota", _):
                return (appResponse(for: request), appQuotaResponse(
                    subjectID: "display-new", observedAt: "2026-08-09T00:00:05Z"))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let full = Task { await model.refreshAccounts() }
        try await waitForAppTest(fullArrived, message: "full refresh never started")
        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await waitForAppTest(
            { model.quotaResponse?.refreshedAt == "2026-08-09T00:00:05Z" },
            message: "later display hydration never committed")

        releaseFull.signal()
        #expect(await full.value != nil)
        #expect(model.activeAccountsQuotaDisplayState == .current(
            observedAt: "2026-08-09T00:00:05Z"))
        #expect(model.quotaResponse?.refreshedAt == "2026-08-09T00:00:05Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
    }

    @MainActor
    @Test func laterLocalDisplayHydrationWinsAnOlderSuccessfulFullRefresh() async throws {
        try await assertLaterDisplayHydrationWinsSuccessfulFull(
            at: .local, port: 41141)
    }

    @MainActor
    @Test func laterRemoteDisplayHydrationWinsAnOlderSuccessfulFullRefresh() async throws {
        try await assertLaterDisplayHydrationWinsSuccessfulFull(
            at: .remote(UUID()), port: 41142)
    }

    @MainActor
    private func assertLaterDisplayHydrationWinsSuccessfulFull(
        at locationID: ExecutionLocationID,
        port: Int
    ) async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let requestClient = appTestGateway(port: port)
        let model = AppModel(
            client: locationID == .local ? requestClient : nil,
            requestNotificationAuthorization: false)
        if locationID != .local {
            model.remoteClients[locationID] = requestClient
            model.draftExecutionLocation = locationID
        }
        let quotaCalls = AppRefreshCallCounter()
        let fullArrived = AppRefreshCallCounter()
        let releaseFull = DispatchSemaphore(value: 0)
        let releaseObserver = DispatchSemaphore(value: 0)
        defer {
            model.suspendAccountsQuotaObserver(at: locationID, discardCursor: true)
            releaseFull.signal()
            releaseObserver.signal()
        }
        AppRequestStubURLProtocol.handler = { request in
            switch (request.url?.path, request.url?.query) {
            case ("/v2/quota", _):
                let call = quotaCalls.incrementAndGet()
                return (appResponse(for: request), appQuotaResponse(
                    subjectID: "display-\(call)",
                    observedAt: call == 1
                        ? "2026-08-09T00:00:01Z" : "2026-08-09T00:00:03Z"))
            case ("/v2/credential-profiles", "snapshot=true"):
                fullArrived.increment()
                _ = releaseFull.wait(timeout: .now() + 5)
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "work", displayName: "Work",
                    observedAt: "2026-08-09T00:00:02Z",
                    quotaEventCursor: "quota:atomic-old"))
            case ("/v2/global/events", _):
                _ = releaseObserver.wait(timeout: .now() + 5)
                return (appResponse(for: request), Data())
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let subscription = model.beginAccountsQuotaSubscription(locationID: locationID)
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await waitForAppTest(
            { quotaCalls.count == 1 && model.accountsQuotaDisplayTasks[locationID] == nil },
            message: "initial display hydration never settled")

        let full = Task { await model.refreshAccounts(locationID: locationID) }
        try await waitForAppTest(fullArrived, message: "older full refresh never started")
        model.noteQuotaProjectionMarker(
            at: locationID, invalidateNextUp: false, cursor: "quota:newer")
        try await waitForAppTest(
            {
                quotaCalls.count == 2
                    && model.accountsQuotaDisplayTasks[locationID] == nil
                    && model.quotaResponse(at: locationID)?.refreshedAt
                        == "2026-08-09T00:00:03Z"
            },
            message: "newer display hydration never committed")

        releaseFull.signal()
        #expect(await full.value == nil)
        #expect(model.quotaResponse(at: locationID)?.refreshedAt
            == "2026-08-09T00:00:03Z")
        #expect(model.accountsQuotaDisplayStates[locationID]
            == .current(observedAt: "2026-08-09T00:00:03Z"))
        #expect(model.accountsQuotaEventCursors[locationID] == "quota:atomic-old")
        #expect(model.accountsNextUpAuthorityFresh[locationID] == true)
        #expect(model.accountsReadinessAuthorityFresh[locationID] == true)

        // The dedicated observer may replay the already-seen newer marker from
        // the full snapshot's older cursor. Dedupe suppresses another display
        // GET, but the dedicated owner still expires quota-derived next_up.
        model.noteQuotaProjectionMarker(
            at: locationID, invalidateNextUp: true, cursor: "quota:newer")
        #expect(quotaCalls.count == 2)
        #expect(model.quotaResponse(at: locationID)?.refreshedAt
            == "2026-08-09T00:00:03Z")
        #expect(model.accountsNextUpAuthorityFresh[locationID] == false)
    }

    @MainActor
    @Test func firstRegistryHydrationNeverPresentsColdFailureAsEmpty() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41133), requestNotificationAuthorization: false)
        let arrived = AppRefreshCallCounter()
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/credential-profiles",
                  request.url?.query == nil
            else { throw AppRefreshTestError.badRequest }
            arrived.increment()
            _ = release.wait(timeout: .now() + 5)
            return (appResponse(for: request, status: 503), Data(#"{"error":"registry unavailable"}"#.utf8))
        }

        let hydration = Task { await model.loadCredentialProfiles() }
        try await waitForAppTest(arrived, message: "registry hydration never started")
        #expect(model.activeCredentialProfiles.isEmpty)
        #expect(model.activeAccountsRegistryLoadState == .loading)
        release.signal()
        let error = await hydration.value
        #expect(error != nil)
        #expect(model.activeAccountsRegistryLoadState == .failed(error!))
    }

    @MainActor
    @Test func successfulLocalMutationFencesAPreMutationRegistryRead() async throws {
        try await assertSuccessfulMutationFencesRegistryRead(
            at: .local, port: 41143)
    }

    @MainActor
    @Test func successfulRemoteMutationFencesAPreMutationRegistryRead() async throws {
        try await assertSuccessfulMutationFencesRegistryRead(
            at: .remote(UUID()), port: 41144)
    }

    @MainActor
    private func assertSuccessfulMutationFencesRegistryRead(
        at locationID: ExecutionLocationID,
        port: Int
    ) async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let requestClient = appTestGateway(port: port)
        let model = AppModel(
            client: locationID == .local ? requestClient : nil,
            requestNotificationAuthorization: false)
        if locationID != .local {
            model.remoteClients[locationID] = requestClient
            model.draftExecutionLocation = locationID
        }
        let seed = try JSONDecoder().decode(
            CredentialProfilesResponse.self,
            from: appAccountsSnapshot(
                profileID: "work", displayName: "Seed",
                observedAt: "2026-08-09T00:00:00Z", profileEnabled: false))
        model.storeCredentialProfiles(
            seed.profiles, accountPools: seed.accountPools, at: locationID)

        let registryCalls = AppRefreshCallCounter()
        let firstArrived = AppRefreshCallCounter()
        let secondArrived = AppRefreshCallCounter()
        let patchArrived = AppRefreshCallCounter()
        let releaseFirst = DispatchSemaphore(value: 0)
        let releaseSecond = DispatchSemaphore(value: 0)
        defer { releaseFirst.signal(); releaseSecond.signal() }
        AppRequestStubURLProtocol.handler = { request in
            if request.httpMethod == "GET",
               request.url?.path == "/v2/credential-profiles",
               request.url?.query == nil
            {
                let call = registryCalls.incrementAndGet()
                if call == 1 {
                    firstArrived.increment()
                    _ = releaseFirst.wait(timeout: .now() + 5)
                } else {
                    secondArrived.increment()
                    _ = releaseSecond.wait(timeout: .now() + 5)
                }
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "work",
                    displayName: call == 1 ? "Pre-mutation" : "Post-mutation",
                    observedAt: "2026-08-09T00:00:0\(call)Z",
                    profileEnabled: call != 2))
            }
            if request.httpMethod == "PATCH",
               request.url?.path == "/v2/credential-profiles/claude/work"
            {
                patchArrived.increment()
                let json = #"{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":false},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}"#
                return (appResponse(for: request), Data(json.utf8))
            }
            throw AppRefreshTestError.badRequest
        }

        let oldHydration = Task { await model.loadCredentialProfiles(locationID: locationID) }
        try await waitForAppTest(firstArrived, message: "pre-mutation registry GET never started")
        let mutation = Task {
            await model.setProfileEnabled(
                harnessId: "claude", profileId: "work", enabled: false)
        }
        try await waitForAppTest(
            {
                patchArrived.count == 1
                    && model.accountsRegistryTrailingHydrations.contains(locationID)
            },
            message: "successful mutation did not request a trailing hydration")

        releaseFirst.signal()
        try await waitForAppTest(secondArrived, message: "post-mutation registry GET never started")
        let profilesBeforePostMutationRead = locationID == .local
            ? model.credentialProfiles
            : (model.remoteCredentialProfiles[locationID] ?? [])
        #expect(profilesBeforePostMutationRead.first?.profile.enabled == false)
        releaseSecond.signal()

        #expect(await oldHydration.value == nil)
        #expect(await mutation.value == nil)
        #expect(registryCalls.count == 2)
        let profilesAfterPostMutationRead = locationID == .local
            ? model.credentialProfiles
            : (model.remoteCredentialProfiles[locationID] ?? [])
        #expect(profilesAfterPostMutationRead.first?.profile.enabled == false)
        #expect(model.accountsRegistryLoadStates[locationID] == .loaded)
        #expect(model.accountsRegistryLoadTasks[locationID] == nil)
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

    /// QA-052 / Ф3 wave-2: a burst of triggers during an in-flight refresh SHARES
    /// the one request and folds into AT MOST ONE trailing pass — never a
    /// per-trigger fan-out, and never a re-arming `while true` spin. A trigger that
    /// lands during the trailing pass does NOT extend it (bounded to 2 passes).
    @MainActor
    @Test func refreshRunsBurstSharesOneRequestAndAtMostOneTrailingPass() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        let leadArrived = AppRefreshCallCounter()
        let trailingArrived = AppRefreshCallCounter()
        let expiredGates = AppRefreshCallCounter()
        let releaseLead = DispatchSemaphore(value: 0)
        let releaseTrailing = DispatchSemaphore(value: 0)
        defer { releaseLead.signal(); releaseTrailing.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs" else { throw AppRefreshTestError.badRequest }
            let call = calls.incrementAndGet()
            if call == 1 {
                leadArrived.increment()
                if releaseLead.wait(timeout: .now() + 5) == .timedOut { expiredGates.increment() }
            } else if call == 2 {
                trailingArrived.increment()
                if releaseTrailing.wait(timeout: .now() + 5) == .timedOut { expiredGates.increment() }
            }
            return (appResponse(for: request), Data(#"{"runs":[]}"#.utf8))
        }

        // Gate each trigger on the pass it must land in, not on wall-clock
        // sleeps: a loaded runner can delay a sleeper past a whole pass. A
        // main-actor trigger counts itself in the same job that enters
        // `refreshRuns`, so a counted trigger has already folded.
        let lead = Task { await model.refreshRuns() }
        try await waitForAppTest(leadArrived, message: "lead runs GET never started")
        let burstEntered = AppRefreshCallCounter()
        let burst = (0..<5).map { _ in
            Task { @MainActor in
                burstEntered.increment()
                await model.refreshRuns()
            }
        }
        try await waitForAppTest({ burstEntered.count == 5 }, message: "burst never folded into the lead")
        releaseLead.signal()
        try await waitForAppTest(trailingArrived, message: "trailing runs GET never started")
        let trailingEntered = AppRefreshCallCounter()
        let duringTrailing = Task { @MainActor in
            trailingEntered.increment()
            await model.refreshRuns()                     // lands in the trailing pass
        }
        try await waitForAppTest(trailingEntered, message: "trailing-pass trigger never ran")
        releaseTrailing.signal()
        await lead.value
        for trigger in burst { await trigger.value }
        await duringTrailing.value

        #expect(expiredGates.count == 0)          // expired placement cannot look like a valid pass
        #expect(calls.count == 2)                 // lead + exactly one trailing
        #expect(model.runsRefreshTask == nil)     // settled, nothing dangling
    }

    /// QA-052 identity guard: if a reconnect fence (`cancelAllStreams`) clears and
    /// REPLACES the runs-refresh task mid-flight, the completing pass must only
    /// clear the task if it STILL owns it — an unconditional `= nil` would niled
    /// the reconnect's fresh task (the leak/stale defect).
    @MainActor
    @Test func refreshRunsIdentityGuardDoesNotClobberAReconnectTask() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs" else { throw AppRefreshTestError.badRequest }
            Thread.sleep(forTimeInterval: 0.05)
            return (appResponse(for: request), Data(#"{"runs":[]}"#.utf8))
        }

        let refresh = Task { await model.refreshRuns() }
        try await Task.sleep(for: .milliseconds(10))     // lead pass now in flight
        // Reconnect fence fires mid-flight, then a fresh connect installs a NEW task.
        model.cancelAllStreams()
        let sentinel = Task<Void, Never> {}
        model.runsRefreshTask = sentinel
        await refresh.value

        // The completing lead pass no longer owned runsRefreshTask, so it left the
        // reconnect's sentinel intact (an unconditional nil would have dropped it).
        #expect(model.runsRefreshTask == sentinel)
        await sentinel.value
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
    @Test func terminalEventCarriesDeadlineFactsBeforeTheDetailRefresh() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-deadline", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let facts: JSONValue = .object([
            "lifecycle": .string("cancelled"),
            "noChanges": .bool(false),
            "checks": .string("not_configured"),
            "review": .string("not_run"),
            "reason": .string("wall_clock_exceeded"),
        ])

        model.apply(BusEnvelope(
            seq: 1,
            kind: "run.failed",
            event: .object([
                "type": .string("run.failed"),
                "payload": .object([
                    "lifecycle": .string("cancelled"),
                    "facts": facts,
                ]),
            ])), to: "run-deadline")

        #expect(model.liveTasks[0].phase == .cancelled)
        #expect(model.liveTasks[0].outcomeFacts?.reason == "wall_clock_exceeded")
        #expect(AppModel.terminalOutcomeFacts(
            from: .object(["facts": facts]), expectedLifecycle: "failed") == nil)
    }

    @MainActor
    @Test func interactionCancellationNeverPresentsAsAnAutomaticTimeout() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-interaction", title: "Run", prompt: "", mode: .ask, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]

        model.apply(BusEnvelope(seq: 1, kind: "interaction.timeout", event: .object([
            "type": .string("interaction.timeout"),
            "payload": .object([
                "interaction_id": .string("int-cancelled"),
                "reason": .string("cancelled"),
            ]),
        ])), to: "run-interaction")
        let cancelledTitle = model.liveBoxes["run-interaction"]?.activity.last?.title ?? ""
        #expect(cancelledTitle == "Question closed — run cancelled")
        #expect(!cancelledTitle.localizedCaseInsensitiveContains("timed out"))
        #expect(!cancelledTitle.localizedCaseInsensitiveContains("assumptions"))

        model.apply(BusEnvelope(seq: 2, kind: "interaction.timeout", event: .object([
            "type": .string("interaction.timeout"),
            "payload": .object(["interaction_id": .string("int-timeout")]),
        ])), to: "run-interaction")
        #expect(model.liveBoxes["run-interaction"]?.activity.last?.title ==
            "Question timed out — continuing with assumptions")
    }

    @MainActor
    @Test func harnessWithdrawnInteractionClosesItsCardWithoutTimeoutWording() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-withdrawn", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let question: JSONValue = .object([
            "id": .string("approval"), "header": .string("Codex approval"),
            "question": .string("Approve this single native action?"),
            "options": .array([.object(["label": .string("Approve once"), "description": .string("")])]),
            "multi_select": .bool(false),
        ])
        for (seq, id) in [(1, "int-withdrawn"), (2, "int-next")] {
            model.apply(BusEnvelope(seq: seq, kind: "interaction.requested", event: .object([
                "type": .string("interaction.requested"),
                "payload": .object([
                    "interaction_id": .string(id), "harness_id": .string("codex"),
                    "source_tool": .string("item/fileChange/requestApproval"),
                    "questions": .array([question]), "requested_at": .string("2026-10-17T00:00:00.000Z"),
                    "timeout_at": .null,
                ]),
            ])), to: "run-withdrawn")
        }
        #expect(model.liveTasks[0].pendingInteractions.map(\.interactionId) == ["int-withdrawn", "int-next"])

        model.apply(BusEnvelope(seq: 3, kind: "interaction.withdrawn", event: .object([
            "type": .string("interaction.withdrawn"),
            "payload": .object(["interaction_id": .string("int-withdrawn"), "harness_id": .string("codex")]),
        ])), to: "run-withdrawn")

        #expect(model.liveTasks[0].pendingInteractions.map(\.interactionId) == ["int-next"])
        #expect(model.liveTasks[0].waitingOnUser)
        let title = model.liveBoxes["run-withdrawn"]?.activity.last?.title ?? ""
        #expect(title == "Question withdrawn by the agent — no answer needed")
        #expect(!title.localizedCaseInsensitiveContains("timed out"))
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
    @Test func onboardingUsesTheActiveRemoteGatewayAndHarnessProjection() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.health = .connected
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .degraded, version: "1", auth: "expired",
            intents: ["implement"], routableIntents: []
        )]

        let remote = ExecutionLocationID.remote(UUID())
        model.draftExecutionLocation = remote
        model.remoteClients[remote] = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test")
        model.remoteHarnesses[remote] = [HarnessInfo(
            family: .codex, health: .ok, version: "1", auth: "native",
            intents: ["implement"], routableIntents: ["implement"]
        )]

        #expect(model.hasRoutableHarness)
        #expect(!model.needsOnboarding(userDismissed: false))

        model.remoteHarnesses[remote] = [HarnessInfo(
            family: .codex, health: .degraded, version: "1", auth: "expired",
            intents: ["implement"], routableIntents: []
        )]
        #expect(model.needsOnboarding(userDismissed: false))
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
        #expect(CashSpend.label(0, estimated: false) == "$0.00")
        #expect(CashSpend.label(0, estimated: true) == "~$0.00")
        #expect(CashSpend.label(1.234) == "$1.23")
        #expect(CashSpend.label(0.0043) == "$0.0043")
        #expect(CashSpend.label(0.01) == "$0.01")
        // Estimated API cash hedges in EVERY surface (never plain dollars).
        #expect(CashSpend.label(1.234, estimated: true) == "~$1.23")
        #expect(CashSpend.help(estimated: true).contains("API key"))
        #expect(CashSpend.help(estimated: true).contains("Subscription valuation is tracked separately"))
        #expect(!CashSpend.help(estimated: true).contains("predating"))
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

        let offline = AppModel(requestNotificationAuthorization: false)
        offline.liveHarnesses = model.liveHarnesses
        offline.harnessReadinessFresh = true
        #expect(!(await offline.refreshHarnesses(fresh: true, markStaleOnFailure: true)))
        #expect(offline.harnessReadinessFresh == false)
        #expect(offline.liveHarnesses.map(\.family) == [.claude])
    }

    @MainActor
    @Test func laterSettingsSaveMakesHeldSameClientHarnessResponseInert() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let client = appTestGateway(port: 41101)
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        let harnessCalls = AppRefreshCallCounter()
        let firstArrived = AppRefreshCallCounter()
        let secondArrived = AppRefreshCallCounter()
        let releaseFirst = DispatchSemaphore(value: 0)
        let releaseSecond = DispatchSemaphore(value: 0)
        defer { releaseFirst.signal(); releaseSecond.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/settings"):
                return (appResponse(for: request), appSettingsSnapshotData)
            case ("GET", "/v2/harnesses"):
                if harnessCalls.incrementAndGet() == 1 {
                    firstArrived.increment()
                    _ = releaseFirst.wait(timeout: .now() + 5)
                    return (appResponse(for: request), appHarnessSnapshot(
                        version: "held-old", status: "degraded"))
                }
                secondArrived.increment()
                _ = releaseSecond.wait(timeout: .now() + 5)
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "latest", status: "ok"))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        #expect(await model.writeSettings(
            SettingsUpdateRequest(routingGoal: "economy"),
            at: .local,
            admittedGeneration: model.executionLocationGeneration(for: .local)) == .saved)
        try await waitForAppTest(firstArrived, message: "first harness GET never started")
        #expect(await model.writeSettings(
            SettingsUpdateRequest(paidFallback: "never"),
            at: .local,
            admittedGeneration: model.executionLocationGeneration(for: .local)) == .saved)

        releaseFirst.signal()
        try await waitForAppTest(secondArrived, message: "trailing harness GET never started")
        #expect(model.liveHarnesses.first?.version != "held-old")
        releaseSecond.signal()
        try await waitForAppTest(
            { model.liveHarnesses.first?.version == "latest" },
            message: "latest harness snapshot never projected")
        #expect(harnessCalls.count == 2)
    }

    @MainActor
    @Test func accountsClaimsHarnessProjectionBeforeItsRequestAwaits() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41102), requestNotificationAuthorization: false)
        let harnessArrived = AppRefreshCallCounter()
        let accountsArrived = AppRefreshCallCounter()
        let releaseHarness = DispatchSemaphore(value: 0)
        let releaseAccounts = DispatchSemaphore(value: 0)
        let releaseObserver = DispatchSemaphore(value: 0)
        defer { releaseHarness.signal(); releaseAccounts.signal(); releaseObserver.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/harnesses":
                harnessArrived.increment()
                _ = releaseHarness.wait(timeout: .now() + 60)
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "held-old", status: "degraded"))
            case "/v2/credential-profiles":
                accountsArrived.increment()
                _ = releaseAccounts.wait(timeout: .now() + 60)
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "accounts", displayName: "Accounts",
                    observedAt: "2026-07-29T00:00:00Z"))
            case "/v2/global/events":
                // Held like the sibling tests: an immediate failure could invalidate next-up
                // before the test suspends the observer this refresh starts (#527).
                _ = releaseObserver.wait(timeout: .now() + 60)
                return (appResponse(for: request), Data())
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let oldHarness = Task { await model.refreshHarnesses(fresh: true) }
        try await waitForAppTest(harnessArrived, message: "held harness GET never started")
        let accounts = Task { await model.refreshAccounts() }
        try await waitForAppTest(accountsArrived, message: "Accounts request never started")

        releaseHarness.signal()
        _ = await oldHarness.value
        #expect(model.liveHarnesses.isEmpty)

        releaseAccounts.signal()
        #expect(await accounts.value == nil)
        model.suspendAccountsQuotaObserver(at: .local)
        #expect(model.liveHarnesses.first?.health == .ok)
        #expect(model.accountPools.first?.nextUp.isProfile("accounts") == true)
        #expect(model.accountsNextUpAuthorityFresh[.local] == true)
    }

    @MainActor
    @Test func foregroundAccountsSuccessSupersededByHarnessRefreshSettlesOnlyAccountsSlices()
        async throws
    {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41114), requestNotificationAuthorization: false)
        try seedAppAccounts(model, profileID: "seed", observedAt: "2026-07-29T00:00:00Z")
        let accountsArrived = AppRefreshCallCounter()
        let releaseAccounts = DispatchSemaphore(value: 0)
        defer { releaseAccounts.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/credential-profiles":
                accountsArrived.increment()
                _ = releaseAccounts.wait(timeout: .now() + 5)
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "incoming", displayName: "Incoming",
                    observedAt: "2026-07-29T00:00:01Z"))
            case "/v2/harnesses":
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "newer-harness", status: "ok", gitVersion: "git newer"))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let accounts = Task { await model.refreshAccounts() }
        try await waitForAppTest(accountsArrived, message: "Accounts request never started")
        #expect(model.activeAccountsLoadState == .loading)
        #expect(await model.refreshHarnesses(fresh: true))
        releaseAccounts.signal()

        let accountsError = await accounts.value
        #expect(accountsError?.contains("Retry Accounts") == true)
        // The newer harness owner wins its slice; the full response may still
        // update stable registry fields, and old display quota is retained.
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["incoming"])
        #expect(model.accountPools.first?.nextUp.isProfile("incoming") == true)
        #expect(model.quotaResponse?.refreshedAt == "2026-07-29T00:00:00Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        #expect(model.accountsQuotaEventCursors[.local] == "seed-cursor")
        #expect(model.liveHarnesses.first?.version == "newer-harness")
        #expect(model.harnessReadinessFresh == true)
        #expect(model.gitCapability?.version == "git newer")
        model.suspendAccountsQuotaObserver(at: .local, discardCursor: true)
    }

    @MainActor
    @Test func cachedRegistryHydrationDoesNotOwnHarnessQuotaOrObserverCursor()
        async throws
    {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41115), requestNotificationAuthorization: false)
        try seedAppAccounts(model, profileID: "seed", observedAt: "2026-07-29T00:00:02Z")
        let accountsArrived = AppRefreshCallCounter()
        let releaseAccounts = DispatchSemaphore(value: 0)
        defer { releaseAccounts.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/credential-profiles":
                accountsArrived.increment()
                _ = releaseAccounts.wait(timeout: .now() + 5)
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "incoming", displayName: "Incoming",
                    observedAt: "2026-07-29T00:00:03Z"))
            case "/v2/harnesses":
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "newer-harness", status: "ok", gitVersion: "git newer"))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let accounts = Task { await model.loadCredentialProfiles() }
        try await waitForAppTest(accountsArrived, message: "Accounts request never started")
        #expect(await model.refreshHarnesses(fresh: true))
        releaseAccounts.signal()

        let accountsError = await accounts.value
        #expect(accountsError == nil)
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["incoming"])
        #expect(model.accountPools.first?.nextUp.isProfile("incoming") == true)
        #expect(model.quotaResponse?.refreshedAt == "2026-07-29T00:00:02Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        #expect(model.accountsQuotaEventCursors[.local] == "seed-cursor")
        #expect(model.accountsQuotaStreamTokens[.local] == nil)
        #expect(model.liveHarnesses.first?.version == "newer-harness")
        #expect(model.harnessReadinessFresh == true)
        #expect(model.gitCapability?.version == "git newer")
    }

    @MainActor
    @Test func foregroundAccountsFailureCannotStaleANewerHarnessProjection() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41116), requestNotificationAuthorization: false)
        try seedAppAccounts(model, profileID: "seed", observedAt: "2026-07-29T00:00:04Z")
        let accountsArrived = AppRefreshCallCounter()
        let releaseAccounts = DispatchSemaphore(value: 0)
        defer { releaseAccounts.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/credential-profiles":
                accountsArrived.increment()
                _ = releaseAccounts.wait(timeout: .now() + 5)
                return (appResponse(for: request, status: 503), Data(#"{"error":"failed"}"#.utf8))
            case "/v2/harnesses":
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "newer-harness", status: "ok", gitVersion: "git newer"))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let accounts = Task { await model.refreshAccounts() }
        try await waitForAppTest(accountsArrived, message: "Accounts request never started")
        #expect(await model.refreshHarnesses(fresh: true))
        releaseAccounts.signal()

        let accountsError = await accounts.value
        #expect(accountsError?.contains("Retry Accounts") == true)
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["seed"])
        #expect(model.accountPools.first?.nextUp.isProfile("seed") == true)
        #expect(model.quotaResponse?.refreshedAt == "2026-07-29T00:00:04Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        #expect(model.liveHarnesses.first?.version == "newer-harness")
        #expect(model.harnessReadinessFresh == true)
        #expect(model.gitCapability?.version == "git newer")
    }

    @MainActor
    @Test func standaloneHarnessSnapshotExpiresNextUpAuthority() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41103), requestNotificationAuthorization: false)
        model.accountsNextUpAuthorityFresh[.local] = true
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses" else {
                throw AppRefreshTestError.badRequest
            }
            return (appResponse(for: request), appHarnessSnapshot(
                version: "standalone", status: "ok"))
        }

        #expect(await model.refreshHarnesses(fresh: true))
        #expect(model.liveHarnesses.first?.version == "standalone")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
    }

    @MainActor
    @Test func blockedRemoteSettingsProjectionDoesNotBlockLocalProjection() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let localClient = appTestGateway(port: 41104)
        let remoteClient = appTestGateway(port: 41105)
        let model = AppModel(client: localClient, requestNotificationAuthorization: false)
        let remote = ExecutionLocationID.remote(UUID())
        model.remoteClients[remote] = remoteClient
        let remoteArrived = AppRefreshCallCounter()
        let localArrived = AppRefreshCallCounter()
        let releaseRemote = DispatchSemaphore(value: 0)
        defer { releaseRemote.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path, request.url?.port) {
            case ("POST", "/v2/settings", _):
                return (appResponse(for: request), appSettingsSnapshotData)
            case ("GET", "/v2/harnesses", 41105):
                remoteArrived.increment()
                _ = releaseRemote.wait(timeout: .now() + 5)
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "remote", status: "ok"))
            case ("GET", "/v2/harnesses", 41104):
                localArrived.increment()
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "local", status: "ok"))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        #expect(await model.writeSettings(
            SettingsUpdateRequest(routingGoal: "economy"),
            at: remote,
            admittedGeneration: model.executionLocationGeneration(for: remote)) == .saved)
        try await waitForAppTest(remoteArrived, message: "remote harness GET never started")
        #expect(await model.writeSettings(
            SettingsUpdateRequest(routingGoal: "economy"),
            at: .local,
            admittedGeneration: model.executionLocationGeneration(for: .local)) == .saved)

        let localWasIndependent = await appTestEventually { localArrived.count == 1 }
        #expect(localWasIndependent)
        releaseRemote.signal()
        try await waitForAppTest(
            { model.liveHarnesses.first?.version == "local" },
            message: "local harness snapshot never projected")
    }

    @MainActor
    @Test func harnessRefreshBurstCoalescesToOneLeadAndOneLatestTrailing() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41106), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        let leadArrived = AppRefreshCallCounter()
        let releaseLead = DispatchSemaphore(value: 0)
        defer { releaseLead.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses" else {
                throw AppRefreshTestError.badRequest
            }
            let call = calls.incrementAndGet()
            if call == 1 {
                leadArrived.increment()
                _ = releaseLead.wait(timeout: .now() + 5)
            }
            return (appResponse(for: request), appHarnessSnapshot(
                version: "call-\(call)", status: "ok"))
        }

        let lead = Task { await model.refreshHarnesses(fresh: false) }
        try await waitForAppTest(leadArrived, message: "lead harness GET never started")
        let second = Task { await model.refreshHarnesses(fresh: false) }
        let third = Task { await model.refreshHarnesses(fresh: true) }
        let latest = Task { await model.refreshHarnesses(fresh: true) }
        for _ in 0..<200 { await Task.yield() }
        #expect(calls.count == 1)

        releaseLead.signal()
        #expect(await lead.value)
        #expect(await second.value)
        #expect(await third.value)
        #expect(await latest.value)
        #expect(calls.count == 2)
        #expect(model.liveHarnesses.first?.version == "call-2")
    }

    @MainActor
    @Test func laterWeakRefreshCannotDropPendingFreshRequirement() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41111), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        let leadArrived = AppRefreshCallCounter()
        let releaseLead = DispatchSemaphore(value: 0)
        defer { releaseLead.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses" else {
                throw AppRefreshTestError.badRequest
            }
            let call = calls.incrementAndGet()
            if call == 1 {
                leadArrived.increment()
                _ = releaseLead.wait(timeout: .now() + 5)
            } else if request.url?.query != "fresh=true" {
                throw AppRefreshTestError.badRequest
            }
            return (appResponse(for: request), appHarnessSnapshot(
                version: "call-\(call)", status: "ok"))
        }

        let lead = Task { await model.refreshHarnesses(fresh: false) }
        try await waitForAppTest(leadArrived, message: "lead harness GET never started")
        let strong = Task { await model.refreshHarnesses(fresh: true) }
        await Task.yield()
        let laterWeak = Task { await model.refreshHarnesses(fresh: false) }
        for _ in 0..<100 { await Task.yield() }

        releaseLead.signal()
        #expect(await lead.value)
        #expect(await strong.value)
        #expect(await laterWeak.value)
        #expect(calls.count == 2)
        #expect(model.liveHarnesses.first?.version == "call-2")
    }

    @MainActor
    @Test func laterWeakRefreshCannotDropPendingStaleOnFailureRequirement() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41112), requestNotificationAuthorization: false)
        model.harnessReadinessFresh = true
        let calls = AppRefreshCallCounter()
        let leadArrived = AppRefreshCallCounter()
        let releaseLead = DispatchSemaphore(value: 0)
        defer { releaseLead.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses" else {
                throw AppRefreshTestError.badRequest
            }
            if calls.incrementAndGet() == 1 {
                leadArrived.increment()
                _ = releaseLead.wait(timeout: .now() + 5)
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "superseded", status: "ok"))
            }
            throw AppRefreshTestError.badRequest
        }

        let lead = Task { await model.refreshHarnesses(markStaleOnFailure: false) }
        try await waitForAppTest(leadArrived, message: "lead harness GET never started")
        let strong = Task {
            await model.refreshHarnesses(markStaleOnFailure: true)
        }
        await Task.yield()
        let laterWeak = Task {
            await model.refreshHarnesses(markStaleOnFailure: false)
        }
        for _ in 0..<100 { await Task.yield() }

        releaseLead.signal()
        #expect(!(await lead.value))
        #expect(!(await strong.value))
        #expect(!(await laterWeak.value))
        #expect(calls.count == 2)
        #expect(model.harnessReadinessFresh == false)
    }

    @MainActor
    @Test func preAdoptionConnectLeaseSurvivesFirstRemoteClientAdoption() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let location = ExecutionLocationID.remote(UUID())
        let client = appTestGateway(port: 41113)
        let lease = try #require(model.claimHarnessProjection(
            at: location, client: client, requireCurrentClient: false))
        #expect(!model.harnessProjectionIsCurrent(lease))

        model.adoptRemoteClientForReconnect(client, at: location)

        #expect(model.harnessProjectionIsCurrent(lease))
        let snapshot = try JSONDecoder().decode(
            HarnessListResponse.self,
            from: appHarnessSnapshot(version: "connect", status: "ok"))
        #expect(model.acceptHarnessSnapshot(
            snapshot.harnesses, git: snapshot.git, lease: lease))
        #expect(model.remoteHarnesses[location]?.first?.version == "connect")
    }

    @MainActor
    @Test func reconnectRetiresOnlyItsOwnHarnessProjectionLane() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let locationA = ExecutionLocationID.remote(UUID())
        let locationB = ExecutionLocationID.remote(UUID())
        let oldAClient = appTestGateway(port: 41107)
        let clientB = appTestGateway(port: 41108)
        let newAClient = appTestGateway(port: 41109)
        model.remoteClients[locationA] = oldAClient
        model.remoteClients[locationB] = clientB
        let oldAArrived = AppRefreshCallCounter()
        let bArrived = AppRefreshCallCounter()
        let newAArrived = AppRefreshCallCounter()
        let releaseOldA = DispatchSemaphore(value: 0)
        let releaseB = DispatchSemaphore(value: 0)
        let releaseNewA = DispatchSemaphore(value: 0)
        defer { releaseOldA.signal(); releaseB.signal(); releaseNewA.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.port {
            case 41107:
                oldAArrived.increment()
                _ = releaseOldA.wait(timeout: .now() + 5)
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "old-a", status: "degraded"))
            case 41108:
                bArrived.increment()
                _ = releaseB.wait(timeout: .now() + 5)
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "b", status: "ok"))
            case 41109:
                newAArrived.increment()
                _ = releaseNewA.wait(timeout: .now() + 5)
                return (appResponse(for: request), appHarnessSnapshot(
                    version: "new-a", status: "ok"))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let oldA = Task { await model.refreshHarnesses(locationID: locationA) }
        let b = Task { await model.refreshHarnesses(locationID: locationB) }
        try await waitForAppTest(oldAArrived, message: "old A refresh never started")
        try await waitForAppTest(bArrived, message: "B refresh never started")

        let idA = try #require(locationA.remoteConnectionID)
        model.remoteConnectionGenerations[idA, default: 0] += 1
        model.adoptRemoteClientForReconnect(newAClient, at: locationA)
        let replacementA = Task { await model.refreshHarnesses(locationID: locationA) }
        try await waitForAppTest(newAArrived, message: "replacement A refresh never started")
        let replacementRunnerID = try #require(
            model.harnessProjectionLanes[locationA]?.runnerID)

        // Let the detached old URL load finish only after the replacement lane
        // exists. Its late cleanup must not clear that lane's task or identity.
        releaseOldA.signal()
        #expect(!(await oldA.value))
        #expect(model.harnessProjectionLanes[locationA]?.runnerID == replacementRunnerID)
        #expect(model.harnessProjectionLanes[locationA]?.task != nil)

        releaseNewA.signal()
        #expect(await replacementA.value)
        #expect(newAArrived.count == 1)
        #expect(model.remoteHarnesses[locationA]?.first?.version == "new-a")

        releaseB.signal()
        #expect(await b.value)
        #expect(model.remoteHarnesses[locationA]?.first?.version == "new-a")
        #expect(model.remoteHarnesses[locationB]?.first?.version == "b")
    }

    @MainActor
    @Test func pointAuthReadinessCannotPatchANewerHarnessSnapshot() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41110), requestNotificationAuthorization: false)
        model.accountsNextUpAuthorityFresh[.local] = true
        let pointArrived = AppRefreshCallCounter()
        let releasePoint = DispatchSemaphore(value: 0)
        defer { releasePoint.signal() }
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/harnesses/claude/auth-readiness"):
                pointArrived.increment()
                _ = releasePoint.wait(timeout: .now() + 5)
                return (appResponse(for: request), Data(#"{"harnessId":"claude","authRequest":"subscription","requestedSource":"native_session","observedAt":"2026-07-29T00:00:00Z","readiness":{"source":"native_session","availability":"available","verification":"passed","detail":"old point probe"}}"#.utf8))
            case ("GET", "/v2/harnesses"):
                return (appResponse(for: request), Data(#"{"harnesses":[{"id":"claude","status":"degraded","manifest":{"version":"new-full"},"authSources":[{"source":"native_session","availability":"unavailable","verification":"failed","detail":"new full snapshot"}]}]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let point = Task { await model.refreshAuthReadiness(
            for: .claude,
            request: AuthReadinessRefreshRequest(
                authRequest: .subscription, source: .nativeSession)) }
        try await waitForAppTest(pointArrived, message: "point readiness request never started")
        #expect(await model.refreshHarnesses(fresh: true))
        releasePoint.signal()
        #expect(!(await point.value))

        let source = model.authSource(for: .claude, source: .nativeSession)
        #expect(source?.verification == "failed")
        #expect(source?.detail == "new full snapshot")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
    }

    @MainActor
    @Test func accountsRefreshUsesFreshReadinessProfilesAndQuotaInOneCycle() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path, request.url?.query) {
            case ("GET", "/v2/credential-profiles", "snapshot=true"):
                calls.increment()
                return (appResponse(for: request), Data(#"{"profiles":[],"harnessAccounts":[],"accountPools":[{"harness_id":"claude","next_up":{"kind":"profile","profileId":"work"}}],"git":{"status":"available","version":"git version test","detail":null,"remediation":null},"harnesses":[{"id":"claude","status":"ok","manifest":null,"routableIntents":["implement"],"authSources":[{"source":"native_session","availability":"available","verification":"passed"}]}],"quotaEventCursor":"quota:1","quota":{"snapshots":[],"absences":[],"refreshed_at":"2026-07-28T00:00:00Z"}}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        #expect(await model.refreshAccounts() == nil)
        #expect(calls.count == 1)
        #expect(model.liveHarnesses.first?.routableIntents == ["implement"])
        #expect(model.harnessReadinessFresh == true)
        #expect(model.accountPools.first?.nextUp.isProfile("work") == true)
        #expect(model.quotaResponse != nil)
        #expect(model.quotaResponse?.refreshedAt == "2026-07-28T00:00:00Z")
        #expect(model.gitCapability?.available == true)
        #expect(model.activeAccountsLoadState == .loaded)
    }

    @MainActor
    @Test func cachedRegistryHydrationUsesPlainEndpointAndDropsUnfencedNextUp() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path, request.url?.query) {
            case ("GET", "/v2/credential-profiles", nil):
                calls.increment()
                return (appResponse(for: request), Data(#"{"profiles":[],"harnessAccounts":[],"accountPools":[{"harness_id":"claude","next_up":{"kind":"profile","profileId":"work"}}]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        model.accountsNextUpAuthorityFresh[.local] = true
        #expect(await model.loadCredentialProfiles(discardOnFailure: true) == nil)
        #expect(calls.count == 1)
        #expect(model.accountPools.first?.nextUp.isProfile("work") == true)
        // The plain response's next_up is stored only with its stable row fields.
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        #expect(model.activeAccountsRegistryLoadState == .loaded)
    }

    @MainActor
    @Test func incompleteFullResponseKeepsStableNativeAndQuotaSlices() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41134), requestNotificationAuthorization: false)
        try seedAppAccounts(
            model, profileID: "seed", observedAt: "2026-08-09T00:00:01Z")
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/credential-profiles",
                  request.url?.query == "snapshot=true"
            else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), Data(#"""
            {"profiles":[{"profile":{"profile_id":"new-profile","harness_id":"claude",
              "display_name":"New Profile","credential_kind":"config_dir_login","enabled":true},
              "status":{"availability":"available","verification":"passed","detail":null,
              "last_verified_at":null}}]}
            """#.utf8))
        }

        let error = await model.refreshAccounts()
        #expect(error?.contains("incomplete") == true)
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["new-profile"])
        #expect(model.accountPools.first?.nextUp.isProfile("seed") == true)
        #expect(model.quotaResponse?.refreshedAt == "2026-08-09T00:00:01Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        #expect(model.activeAccountsRegistryLoadState == .loaded)
    }

    @MainActor
    @Test func completeAccountsSnapshotReplacesOlderPointProbeReadiness() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/credential-profiles",
                  request.url?.query == "snapshot=true"
            else { throw AppRefreshTestError.badRequest }
            let body = #"{"profiles":[],"harnessAccounts":[],"accountPools":[{"harness_id":"claude","next_up":{"kind":"none","reason":"no enabled account"}}],"git":{"status":"available","version":"git version test","detail":null,"remediation":null},"harnesses":[{"id":"claude","status":"degraded","manifest":null,"routableIntents":[],"authSources":[{"source":"native_session","availability":"unavailable","verification":"failed"}]}],"quotaEventCursor":"quota:2","quota":{"snapshots":[],"absences":[],"refreshed_at":"2026-07-28T00:00:00Z"}}"#
            return (appResponse(for: request), Data(body.utf8))
        }

        #expect(await model.refreshAccounts() == nil)
        let source = model.authSource(for: .claude, source: .nativeSession)
        #expect(source?.availability == "unavailable")
        #expect(source?.verification == "failed")
        // Unified account model: no pseudo-row is synthesized from doctor
        // readiness — with zero profile rows the accounts list stays empty.
        #expect(AccountsPresentation.rows(model: model).isEmpty)
    }

    @MainActor
    @Test func failedAccountsRefreshExpiresReadinessButPreservesStableRowsAndQuota() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "Ready by doctor.",
            authSources: [HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed")],
            intents: ["implement"], routableIntents: ["implement"],
            readiness: [ReadinessCheck(
                kind: "auth", id: "native", title: "Native", status: "pass")]
        )]
        model.credentialProfiles = [try JSONDecoder().decode(
            CredentialProfileEntry.self,
            from: Data(#"{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","isolation_locator":null,"enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}"#.utf8))]
        model.accountPools = [try JSONDecoder().decode(
            HarnessAccountPool.self,
            from: Data(#"{"harness_id":"claude","next_up":{"kind":"profile","profileId":"work"}}"#.utf8))]
        model.quotaResponse = try JSONDecoder().decode(
            ControlQuotaResponse.self,
            from: appQuotaResponse(subjectID: "work", observedAt: "2026-08-09T00:00:00Z"))
        AppRequestStubURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                headerFields: nil)!
            return (response, Data(#"{"error":"refresh failed"}"#.utf8))
        }

        let refreshError = await model.refreshAccounts()
        #expect(refreshError != nil)
        if let refreshError {
            #expect(model.activeAccountsLoadState == .failed(refreshError))
        }
        // Server facts remain verbatim; only their client freshness expires.
        #expect(model.liveHarnesses.first?.health == .ok)
        #expect(model.liveHarnesses.first?.routableIntents == ["implement"])
        #expect(model.harnessReadinessFresh == false)
        let row = AccountsPresentation.rows(model: model).first
        #expect(row?.readiness == .unknown)
        #expect(row?.verified == false)
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["work"])
        #expect(model.accountPools.first?.nextUp.isProfile("work") == true)
        #expect(model.quotaResponse?.refreshedAt == "2026-08-09T00:00:00Z")
        #expect(model.accountsReadinessAuthorityFresh[.local] == false)
        if case .stale = model.activeAccountsQuotaDisplayState {} else {
            Issue.record("failed full refresh must retain quota as stale display data")
        }
    }

    @MainActor
    @Test func successfulRegistryHydrationHasIndependentStateFromOlderFullFailure() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41112),
            requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/credential-profiles" else {
                throw AppRefreshTestError.badRequest
            }
            if calls.incrementAndGet() == 1 {
                guard request.url?.query == "snapshot=true" else {
                    throw AppRefreshTestError.badRequest
                }
                return (
                    HTTPURLResponse(
                        url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": "application/json"]
                    )!,
                    Data(#"{"error":"foreground failed"}"#.utf8)
                )
            }
            guard request.url?.query == nil else { throw AppRefreshTestError.badRequest }
            return (
                appResponse(for: request),
                appAccountsSnapshot(
                    profileID: "recovered", displayName: "Recovered",
                    observedAt: "2026-07-29T00:00:00Z")
            )
        }

        let foregroundError = await model.refreshAccounts()
        #expect(foregroundError != nil)
        if let foregroundError {
            #expect(model.activeAccountsLoadState == .failed(foregroundError))
        }

        await model.refreshCredentialProfiles()

        if case .failed = model.activeAccountsLoadState {} else {
            Issue.record("cached registry hydration must not settle the full-refresh state")
        }
        #expect(model.activeAccountsRegistryLoadState == .loaded)
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["recovered"])
        #expect(model.accountPools.first?.nextUp.isProfile("recovered") == true)
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
    }

    @MainActor
    @Test func laterRegistryHydrationKeepsReadinessWhenOlderFullFailureSettles() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41137), requestNotificationAuthorization: false)
        let fullArrived = AppRefreshCallCounter()
        let releaseFull = DispatchSemaphore(value: 0)
        defer { releaseFull.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/credential-profiles" else {
                throw AppRefreshTestError.badRequest
            }
            if request.url?.query == "snapshot=true" {
                fullArrived.increment()
                _ = releaseFull.wait(timeout: .now() + 5)
                return (appResponse(for: request, status: 503), Data(#"{"error":"old full failed"}"#.utf8))
            }
            guard request.url?.query == nil else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), appAccountsSnapshot(
                profileID: "recovered", displayName: "Recovered",
                observedAt: "2026-08-09T00:00:02Z"))
        }

        let full = Task { await model.refreshAccounts() }
        try await waitForAppTest(fullArrived, message: "full Accounts request never started")
        #expect(await model.loadCredentialProfiles() == nil)
        #expect(model.accountsReadinessAuthorityFresh[.local] == true)

        releaseFull.signal()
        #expect(await full.value != nil)
        #expect(model.accountsReadinessAuthorityFresh[.local] == true)
        let recovered = try #require(
            AccountsPresentation.rows(model: model).first { $0.profileId == "recovered" })
        #expect(recovered.readiness == .ready)
    }

    @MainActor
    @Test func laterRegistryHydrationWinsStableFieldsOverAnInFlightFullRefresh() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let fullArrived = AppRefreshCallCounter()
        let fullCalls = AppRefreshCallCounter()
        let hydrationArrived = AppRefreshCallCounter()
        let releaseFull = DispatchSemaphore(value: 0)
        let releaseHydration = DispatchSemaphore(value: 0)
        let releaseObserver = DispatchSemaphore(value: 0)
        defer {
            releaseFull.signal()
            releaseHydration.signal()
            releaseObserver.signal()
            releaseObserver.signal()
        }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/credential-profiles" else {
                if request.url?.path == "/v2/global/events" {
                    _ = releaseObserver.wait(timeout: .now() + 5)
                    return (appResponse(for: request), Data())
                }
                throw AppRefreshTestError.badRequest
            }
            if request.url?.query == "snapshot=true" {
                fullArrived.increment()
                let call = fullCalls.incrementAndGet()
                if call == 1 { _ = releaseFull.wait(timeout: .now() + 5) }
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: call == 1 ? "full-old" : "full-final",
                    displayName: call == 1 ? "Full Old" : "Full Final",
                    observedAt: call == 1
                        ? "2026-07-29T00:00:01Z" : "2026-07-29T00:00:03Z"))
            }
            guard request.url?.query == nil else { throw AppRefreshTestError.badRequest }
            hydrationArrived.increment()
            _ = releaseHydration.wait(timeout: .now() + 5)
            return (appResponse(for: request), appAccountsSnapshot(
                profileID: "hydrated-new", displayName: "Hydrated New",
                observedAt: "2026-07-29T00:00:02Z"))
        }

        let foreground = Task { await model.refreshAccounts() }
        try await waitForAppTest(
            fullArrived, message: "full Accounts request never started")
        let background = Task { await model.refreshCredentialProfiles() }
        try await waitForAppTest(
            hydrationArrived, message: "registry hydration never started")

        releaseHydration.signal()
        await background.value
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["hydrated-new"])
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)

        releaseFull.signal()
        let fullError = await foreground.value
        #expect(fullError?.contains("Accounts changed") == true)
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["hydrated-new"])
        #expect(model.quotaResponse?.refreshedAt == "2026-07-29T00:00:01Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)

        #expect(await model.refreshAccounts() == nil)
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["full-final"])
        #expect(model.quotaResponse?.refreshedAt == "2026-07-29T00:00:03Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == true)
    }

    @MainActor
    @Test func exactProfileRefreshRejectsItsRetiredProjectionReceipt() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"stale","harness_id":"codex","display_name":"Stale","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))

        let exactArrived = AppRefreshCallCounter()
        let newerArrived = AppRefreshCallCounter()
        let releaseExact = DispatchSemaphore(value: 0)
        let releaseNewer = DispatchSemaphore(value: 0)
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/credential-profiles" else {
                if request.url?.path == "/v2/global/events" {
                    return (appResponse(for: request), Data())
                }
                throw AppRefreshTestError.badRequest
            }
            if request.url?.query == "snapshot=true" {
                exactArrived.increment()
                _ = releaseExact.wait(timeout: .now() + 5)
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "stale", displayName: "Retired stale",
                    observedAt: "2026-07-29T00:00:01Z"))
            }
            guard request.url?.query == nil else { throw AppRefreshTestError.badRequest }
            newerArrived.increment()
            _ = releaseNewer.wait(timeout: .now() + 5)
            return (appResponse(for: request), appAccountsSnapshot(
                profileID: "fresh", displayName: "Fresh",
                observedAt: "2026-07-29T00:00:02Z"))
        }

        let exact = Task {
            await model.refreshExactCredentialProfile(
                harnessID: "codex", profileID: "stale")
        }
        try await waitForAppTest(exactArrived, message: "exact refresh never started")
        let newer = Task { await model.refreshCredentialProfiles() }
        try await waitForAppTest(newerArrived, message: "newer refresh never started")

        releaseExact.signal()
        #expect(await exact.value == nil)
        releaseNewer.signal()
        await newer.value
        #expect(model.credentialProfiles.map(\.profile.profileId) == ["fresh"])
    }

    @MainActor
    @Test func concurrentFullAccountsRefreshesShareOneAtomicRequest() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        let oldArrived = AppRefreshCallCounter()
        let observerArrived = AppRefreshCallCounter()
        let releaseOld = DispatchSemaphore(value: 0)
        let releaseObserver = DispatchSemaphore(value: 0)
        defer {
            model.suspendAccountsQuotaObserver(at: .local, discardCursor: true)
            releaseOld.signal()
            releaseObserver.signal()
        }
        AppRequestStubURLProtocol.handler = { request in
            if request.url?.path == "/v2/global/events" {
                observerArrived.increment()
                _ = releaseObserver.wait(timeout: .now() + 5)
                return (appResponse(for: request), Data())
            }
            guard request.url?.path == "/v2/credential-profiles",
                  request.url?.query == "snapshot=true"
            else { throw AppRefreshTestError.badRequest }
            calls.increment()
            oldArrived.increment()
            _ = releaseOld.wait(timeout: .now() + 5)
            return (appResponse(for: request), appAccountsSnapshot(
                profileID: "shared", displayName: "Shared", observedAt: "2026-07-28T00:00:02Z"))
        }

        let older = Task { await model.refreshAccounts() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while oldArrived.count == 0 {
            try #require(ContinuousClock.now <= deadline, "older Accounts load never reached the stub")
            await Task.yield()
        }
        let newer = Task { await model.refreshAccounts() }
        for _ in 0..<100 { await Task.yield() }
        #expect(calls.count == 1)
        releaseOld.signal()
        #expect(await newer.value == nil)
        try await waitForAppTest(observerArrived, message: "quota observer never started")
        #expect(await older.value == nil)

        #expect(model.credentialProfiles.map(\.profile.profileId) == ["shared"])
        #expect(model.accountPools.first?.nextUp.isProfile("shared") == true)
        #expect(model.quotaResponse?.refreshedAt == "2026-07-28T00:00:02Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == true)
        #expect(model.activeAccountsLoadState == .loaded)
    }

    @MainActor
    @Test func concurrentFailedFullAccountsRefreshesShareOneFailure() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        let oldArrived = AppRefreshCallCounter()
        let releaseOld = DispatchSemaphore(value: 0)
        defer {
            model.suspendAccountsQuotaObserver(at: .local, discardCursor: true)
            releaseOld.signal()
        }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/credential-profiles",
                  request.url?.query == "snapshot=true"
            else { throw AppRefreshTestError.badRequest }
            calls.increment()
            oldArrived.increment()
            _ = releaseOld.wait(timeout: .now() + 5)
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"{"error":"shared failure"}"#.utf8))
        }

        let older = Task { await model.refreshAccounts() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while oldArrived.count == 0 {
            try #require(ContinuousClock.now <= deadline, "older Accounts load never reached the stub")
            await Task.yield()
        }
        let newer = Task { await model.refreshAccounts() }
        for _ in 0..<100 { await Task.yield() }
        #expect(calls.count == 1)
        releaseOld.signal()
        let newerError = await newer.value
        let olderError = await older.value

        #expect(newerError == olderError)
        #expect(newerError?.contains("shared failure") == true)
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        if case .failed = model.activeAccountsLoadState {} else {
            Issue.record("shared full failure must settle the foreground state")
        }
    }

    @MainActor
    @Test func quotaProjectionExpiryKeepsAccountIdentityButDropsDerivedAuthority() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null},"identity":{"email":"work@example.test","plan":"max"}}]"#.utf8))
        model.accountPools = try JSONDecoder().decode(
            [HarnessAccountPool].self,
            from: Data(#"[{"harness_id":"claude","next_up":{"kind":"profile","profileId":"work"}}]"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(
            ControlQuotaResponse.self,
            from: appQuotaResponse(subjectID: "work", observedAt: "2026-07-28T00:00:04Z"))
        model.accountsNextUpAuthorityFresh[.local] = true

        model.expireAccountsQuotaProjection(at: .local)

        #expect(model.quotaResponse?.refreshedAt == "2026-07-28T00:00:04Z")
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        #expect(model.credentialProfiles.first?.identity?.email == "work@example.test")
        #expect(model.credentialProfiles.first?.status.verification == "passed")
        if case .stale = model.activeAccountsQuotaDisplayState {} else {
            Issue.record("quota invalidation must retain last-known values as stale")
        }
    }

    @MainActor
    @Test func staleQuotaCursorExpiresOnceAndNeverStartsAnAutomaticResnapshotLoop() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let requestClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config))
        let model = AppModel(client: requestClient, requestNotificationAuthorization: false)
        let snapshotCalls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/global/events":
                return (
                    HTTPURLResponse(
                        url: request.url!, statusCode: 409, httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": "application/json"]
                    )!,
                    Data(#"{"error":"stale cursor"}"#.utf8)
                )
            case "/v2/credential-profiles":
                snapshotCalls.increment()
                throw AppRefreshTestError.badRequest
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        model.accountsNextUpAuthorityFresh[.local] = true
        model.quotaResponse = try JSONDecoder().decode(
            ControlQuotaResponse.self,
            from: appQuotaResponse(subjectID: "old", observedAt: "2026-07-28T00:00:01Z"))
        model.startAccountsQuotaObserver(
            at: .local, client: requestClient, after: "stale-cursor")
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while model.accountsQuotaStreamTokens[.local] != nil {
            try #require(ContinuousClock.now <= deadline, "stale observer did not stop")
            await Task.yield()
        }

        #expect(snapshotCalls.count == 0)
        #expect(model.accountsNextUpAuthorityFresh[.local] == false)
        #expect(model.quotaResponse?.refreshedAt == "2026-07-28T00:00:01Z")
        if case .stale = model.activeAccountsQuotaDisplayState {} else {
            Issue.record("lost dedicated cursor must keep last-known quota stale")
        }
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
        #expect(model.harnessInfo(for: .claude)?.attachmentInputs.map(\.kind) == ["image"])
    }

    @MainActor
    @Test func planComposerUploadsExactBytesAndSendsOnlyTheFinalizedResourceReference() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let payload = Data("PLAN_ATTACHMENT_SENTINEL\n".utf8)
        let exercised = AppRefreshCallCounter()

        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/uploads"):
                guard let body = appTestRequestBody(request),
                      let object = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      object["kind"] as? String == "file",
                      object["mime"] as? String == "text/plain",
                      object["name"] as? String == "plan-note.txt",
                      object["sizeBytes"] as? Int == payload.count else {
                    throw AppRefreshTestError.badRequest
                }
                exercised.increment()
                return (
                    appResponse(for: request, status: 201),
                    Data(#"{"uploadId":"upload-plan"}"#.utf8)
                )
            case ("PUT", "/v2/uploads/upload-plan/bytes"):
                guard appTestRequestBody(request) == payload else {
                    throw AppRefreshTestError.badRequest
                }
                exercised.increment()
                return (appResponse(for: request), Data())
            case ("POST", "/v2/uploads/upload-plan/finalize"):
                exercised.increment()
                return (
                    appResponse(for: request, status: 201),
                    Data(#"{"resourceId":"resource-plan"}"#.utf8)
                )
            case ("POST", "/v2/threads/thread-plan/turns"):
                guard let body = appTestRequestBody(request),
                      let object = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      object["prompt"] as? String == "Use the attached planning context",
                      object["mode"] as? String == "plan",
                      object["access"] == nil,
                      let attachments = object["attachments"] as? [[String: Any]],
                      attachments.count == 1,
                      attachments[0].count == 1,
                      attachments[0]["resourceId"] as? String == "resource-plan" else {
                    throw AppRefreshTestError.badRequest
                }
                exercised.increment()
                return (
                    appResponse(for: request, status: 202),
                    Data(#"{"jobId":"job-plan","state":"queued","error":null}"#.utf8)
                )
            case ("GET", "/v2/runs"):
                return (appResponse(for: request), Data(#"{"runs":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let target = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread-plan",
            repoRoot: "/tmp/project",
            workspaceMode: "in_place",
            eligibleHarnesses: [])
        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(root: "/tmp/project"))

        let sent = await model.composerSend(
            prompt: "Use the attached planning context",
            mode: .plan,
            attachments: [PendingAttachment(
                kind: "file", mime: "text/plain", name: "plan-note.txt", data: payload
            )],
            target: target
        )

        #expect(sent)
        #expect(exercised.count == 4)
    }

    @MainActor
    @Test func explicitBestOfPreservesUnavailableSelectedMembersOnTheWire() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.draftEligiblePool = ["claude", "cursor"]
        model.liveHarnesses = [
            HarnessInfo(
                family: .claude, health: .ok, version: "1", auth: "ready",
                intents: ["implement"], routableIntents: ["implement"]
            ),
            HarnessInfo(
                family: .cursor, health: .unavailable, version: "1", auth: "not ready",
                intents: ["implement"], routableIntents: []
            ),
        ]
        let bodyBox = CreateBodyBox()

        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/threads/thread-race/turns"):
                bodyBox.data = appTestRequestBody(request)
                return (
                    appResponse(for: request, status: 202),
                    Data(#"{"jobId":"job-race","state":"queued","error":null}"#.utf8)
                )
            case ("GET", "/v2/runs"):
                return (appResponse(for: request), Data(#"{"runs":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let target = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread-race",
            repoRoot: "/tmp/project",
            workspaceMode: "in_place",
            eligibleHarnesses: ["claude", "cursor"])
        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(root: "/tmp/project"))

        let sent = await model.composerSend(
            prompt: "Race the selected pool",
            mode: .bestOfN,
            target: target
        )

        let request = try JSONDecoder().decode(
            ThreadTurnRequest.self, from: #require(bodyBox.data)
        )
        #expect(sent)
        #expect(request.harnesses == ["claude", "cursor"])
        #expect(request.n == 2)
    }

    @MainActor
    @Test func ordinaryPlanSendPreservesPerHarnessModelsEffortAndAuthRoute() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let bodyBox = CreateBodyBox()

        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/threads/thread-routing/turns"):
                bodyBox.data = appTestRequestBody(request)
                return (
                    appResponse(for: request, status: 202),
                    Data(#"{"jobId":"job-routing","state":"queued","error":null}"#.utf8)
                )
            case ("GET", "/v2/runs"):
                return (appResponse(for: request), Data(#"{"runs":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let target = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread-routing",
            repoRoot: "/tmp/project",
            workspaceMode: "in_place",
            eligibleHarnesses: ["codex", "claude"])
        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(root: "/tmp/project"))
        var options = TurnOptions()
        options.models = ["codex": "gpt-5.6-terra", "claude": "claude-opus-5"]
        options.authRoute = "subscription"
        options.effort = "high"

        let sent = await model.composerSend(
            prompt: "Plan this change",
            mode: .plan,
            options: options,
            target: target)
        let request = try JSONDecoder().decode(
            ThreadTurnRequest.self, from: #require(bodyBox.data))

        #expect(sent)
        #expect(request.mode == "plan")
        #expect(request.models == options.models)
        #expect(request.effort == "high")
        #expect(request.authPreference == "subscription")
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
    @Test func profileSheetRefreshUsesOnlyThatProfilesDoctorSnapshot() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41118), requestNotificationAuthorization: false)
        let calls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            guard request.httpMethod == "GET",
                  request.url?.path == "/v2/credential-profiles",
                  request.url?.query == "snapshot=true"
            else { throw AppRefreshTestError.badRequest }
            calls.increment()
            let body = #"{"profiles":[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":"profile ready","last_verified_at":null}}],"harnessAccounts":[],"git":{"status":"available","version":"git version test","detail":null,"remediation":null},"harnesses":[],"quotaEventCursor":"quota:profile","quota":{"snapshots":[],"absences":[],"refreshed_at":"2026-07-29T00:00:00Z"}}"#
            return (appResponse(for: request), Data(body.utf8))
        }

        #expect(await model.refreshCredentialReadiness(
            for: .claude, profileId: "work", after: nil))
        #expect(calls.count == 1)
        #expect(model.credentialProfiles.first?.status.verification == "passed")
        #expect(model.exactAuthSources[.claude] == nil)
    }

    /// A terminal profile-less job is the BOOTSTRAP login (claude/codex):
    /// its credential lands on the `<harness>-default` REGISTRY row. The
    /// readiness-only refresh left that row invisible — the accounts panel
    /// said "No accounts yet" right after a SUCCESSFUL login, until a manual
    /// popover Refresh. The nil-profileId refresh must re-read the registry
    /// too, so the row appears in the presentation rows.
    @MainActor
    @Test func terminalBootstrapLoginRefreshesTheProfilesRegistry() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41147), requestNotificationAuthorization: false)
        let registryCalls = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/harnesses/claude/auth-readiness"):
                return (appResponse(for: request), Data(
                    #"{"harnessId":"claude","authRequest":"subscription","requestedSource":"native_session","observedAt":"2026-08-18T00:00:00Z","readiness":{"source":"native_session","availability":"available","verification":"passed","detail":"Native session verified"}}"#.utf8))
            case ("GET", "/v2/harnesses"):
                return (appResponse(for: request), appHarnessSnapshot(version: "1", status: "ok"))
            case ("GET", "/v2/credential-profiles"):
                registryCalls.increment()
                return (appResponse(for: request), Data(
                    #"{"profiles":[{"profile":{"profile_id":"claude-default","harness_id":"claude","display_name":"claude default login","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}],"harnessAccounts":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let job = SetupJob(
            jobId: "bootstrap-1", harness: .claude, action: .login,
            state: .succeeded, phase: .completed, message: "Login verified",
            createdAt: "2026-08-18T00:00:00Z", profileId: nil)
        #expect(model.activeCredentialProfiles.isEmpty)
        #expect(await model.refreshCredentialReadiness(
            for: .claude, profileId: nil, after: job))
        #expect(registryCalls.count == 1)
        #expect(AccountsPresentation.rows(model: model).map(\.profileId)
            == ["claude-default"])
    }

    @MainActor
    @Test func rawAPISetupAndAPIKeyReadinessNeverUseRetiredRawHarnessId() async throws {
        #expect(HarnessFamily.raw.setupHarnessId == "raw-api")
        #expect(HarnessFamily.raw.apiKeyAuthReadinessRequest == AuthReadinessRefreshRequest(
            authRequest: .apiKey,
            source: .apiKeyEnvironment
        ))
    }

    /// #132: the openrouter sheet's readiness mappings exist and target the
    /// `openrouter` harness id. Without BOTH requests the sheet's Recheck and
    /// the post-store verify always reported "refresh failed" without probing.
    @MainActor
    @Test func openrouterAuthReadinessMappingsTargetTheOpenrouterHarness() async throws {
        #expect(HarnessFamily.openrouter.setupHarnessId == "openrouter")
        #expect(HarnessFamily.openrouter.defaultAuthReadinessRequest == AuthReadinessRefreshRequest(
            authRequest: .apiKey,
            source: .apiKeyEnvironment
        ))
        #expect(HarnessFamily.openrouter.apiKeyAuthReadinessRequest == AuthReadinessRefreshRequest(
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
            case ("GET", "/v2/harnesses"):
                // R1 M-C1: the store now always ends with the fresh aggregate
                // re-list; the probe failure above stays this test's subject.
                return (appResponse(for: request), Data(#"{"harnesses":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        // "raw" is the REAL managed slot name for this family (packages/util/
        // src/secret-names.ts) — the retired "raw_api" string was never in the
        // managed grammar and would be refused by the live daemon.
        let outcome = await model.storeSecret(name: "raw", value: "redacted", for: .raw)
        #expect(outcome.stored)
        #expect(!outcome.readinessRefreshed)
        #expect(model.secretBackend == "file")
    }

    /// #132 end-to-end: storing the OpenRouter key reaches the daemon with the
    /// exact managed slot name `openrouter`, requests the exact api_key_env
    /// readiness refresh for the `openrouter` harness, and (R1 M-C1) re-lists
    /// the harnesses FRESH — so the card leaves its pre-store "Unavailable"
    /// for the locked post-store state (degraded "key present but route
    /// unproven" + Retry check) without a manual full refresh.
    @MainActor
    @Test func openrouterStoreKeyUsesTheManagedSlotAndRefreshesExactReadiness() async throws {
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
                guard let body = appTestRequestBody(request),
                      let object = try JSONSerialization.jsonObject(with: body) as? [String: String],
                      object == ["name": "openrouter", "value": "redacted"] else {
                    throw AppRefreshTestError.badRequest
                }
                return (appResponse(for: request), Data("{}".utf8))
            case ("GET", "/v2/secrets"):
                return (appResponse(for: request), Data(
                    #"{"backend":"file","secrets":[{"name":"openrouter","backend":"file","present":true}]}"#.utf8))
            case ("POST", "/v2/harnesses/openrouter/auth-readiness"):
                guard let body = appTestRequestBody(request),
                      let object = try JSONSerialization.jsonObject(with: body) as? [String: String],
                      object == ["authRequest": "api_key", "source": "api_key_env"] else {
                    throw AppRefreshTestError.badRequest
                }
                return (
                    appResponse(for: request),
                    Data(#"{"harnessId":"openrouter","authRequest":"api_key","requestedSource":"api_key_env","observedAt":"2026-08-08T00:00:00Z","readiness":{"source":"api_key_env","availability":"available","verification":"not_run","detail":"key present; route unproven"}}"#.utf8)
                )
            case ("GET", "/v2/harnesses"):
                // Seed (no query): the pre-store card truth — unavailable.
                // The post-store aggregate refresh must be the NON-CACHED
                // re-list Recheck runs (fresh=true) — only it serves the
                // degraded daemon-normalized snapshot.
                guard request.url?.query == "fresh=true" else {
                    return (appResponse(for: request), Data(
                        #"{"harnesses":[{"id":"openrouter","status":"unavailable","manifest":null}]}"#.utf8))
                }
                return (appResponse(for: request), Data(
                    #"{"harnesses":[{"id":"openrouter","status":"degraded","manifest":null,"reasons":["key present but route unproven"],"authSources":[{"source":"api_key_env","availability":"available","verification":"not_run","detail":"key present; route unproven"}]}]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        // Seed the pre-store truth: the harness card shows "Unavailable".
        #expect(await model.refreshHarnesses())
        #expect(model.harnessInfo(for: .openrouter)?.health == .unavailable)

        let outcome = await model.storeSecret(name: "openrouter", value: "redacted", for: .openrouter)
        #expect(outcome.stored)
        #expect(outcome.readinessRefreshed)
        #expect(model.authSource(for: .openrouter, source: .apiKeyEnvironment)?.verification == "not_run")

        // R1 M-C1: the store itself lands the card in the locked post-store
        // state — degraded with the daemon's reason — no manual refresh.
        let info = try #require(model.harnessInfo(for: .openrouter))
        #expect(info.health == .degraded)
        #expect(info.reasons == ["key present but route unproven"])

        // …and the footer CTA becomes Retry check, exactly as the sheet
        // wires it: health not ok, no native path, key now stored.
        let cta = AuthSheetPresentation.primaryCTA(
            healthOk: info.health == .ok,
            nativeSupported: SetupHarness(rawValue: HarnessFamily.openrouter.setupHarnessId) != nil,
            nativeReady: false,
            keyStored: model.activeStoredSecrets.contains { $0.name == "openrouter" },
            streamLost: false,
            jobActive: false,
            blocksReplacement: false)
        #expect(cta == .retryProbe)
        #expect(cta.label == "Retry check")
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

    @MainActor
    @Test func refusedTurnReadsTypedContextAndKeepsLegacyFallback() {
        let typed = GatewayError.http(status: 503, body: #"{"code":"git_missing","message":"Git unavailable","retryable":true,"context":{"turnId":"tn-context"}}"#)
        #expect(AppModel.refusedTurn(from: typed)?.turnId == "tn-context")
        #expect(AppModel.refusedTurn(from: typed)?.retryable == true)

        let legacy = GatewayError.http(status: 400, body: #"{"error":"old","turnId":"tn-legacy","retryable":false}"#)
        #expect(AppModel.refusedTurn(from: legacy)?.turnId == "tn-legacy")
        #expect(AppModel.refusedTurn(from: legacy)?.retryable == false)
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
        #expect(model.selectedHistory?.header?.thread.id == "B")
    }

    @MainActor
    @Test func remoteStreamRefreshKeepsVisibleConversationUntilReplacementArrives() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let requestClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let locationID = ExecutionLocationID.remote(UUID())
        model.remoteClients[locationID] = requestClient

        let oldThread = try JSONDecoder().decode(
            ThreadSummary.self,
            from: Data(#"{"id":"remote-thread","title":"Visible","repoRoot":"/tmp/project","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"}"#.utf8))
        model.selectedExecutionLocation = locationID
        model.selectedThreadId = oldThread.id
        let oldDetail = ThreadDetailResponse(thread: oldThread, sessions: [], turns: [])
        let oldPage = try JSONDecoder().decode(ThreadHistoryPage.self,
            from: LegacyHistoryFixture.response(JSONEncoder().encode(oldDetail), sequence: 1))
        let history = model.makeHistoryStore(locationID: locationID, id: oldThread.id)
        model.selectedHistory = history
        history.install([oldPage], ids: [], reset: true, serial: 0)

        AppRequestStubURLProtocol.handler = { request in
            Thread.sleep(forTimeInterval: 0.15)
            let json = #"{"thread":{"id":"remote-thread","title":"Refreshed","repoRoot":"/tmp/project","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:01Z"},"sessions":[],"turns":[]}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        let refresh = Task {
            await model.refreshOpenThread(locationID: locationID, id: oldThread.id)
        }
        try await Task.sleep(for: .milliseconds(20))
        #expect(model.selectedHistory?.header?.thread.title == "Visible")
        await refresh.value
        #expect(model.selectedHistory?.header?.thread.title == "Refreshed")
    }

    @MainActor
    @Test func detailRefreshesDelegateLineageAndTerminalFacts() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        var task = TaskRun(
            id: "run-child", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        task.delegation = RunDelegationInfo(
            requested: true, effective: false, used: false, reason: "pending")
        model.liveTasks = [task]
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-child" else {
                throw AppRefreshTestError.badRequest
            }
            let json = #"{"summary":{"runId":"run-child","state":"succeeded","mode":"agent","parentRunId":"run-parent","delegatedFromRunId":"run-parent","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"}},"lastSeq":7}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        await model.loadRunDetail("run-child")

        let refreshed = try #require(model.liveTasks.first)
        #expect(refreshed.parentRunId == "run-parent")
        #expect(refreshed.delegatedFromRunId == "run-parent")
        #expect(refreshed.delegation == RunDelegationInfo(
            requested: true, effective: true, used: true, reason: "used"))
    }

    @MainActor
    @Test func detailAcceptsExistingOptimisticJobIdAliasAndRestoresChildrenAgainstRealRunId() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "job-queued", title: "Queued", prompt: "", mode: .agent, phase: .queued,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/job-queued" else {
                throw AppRefreshTestError.badRequest
            }
            let json = #"{"summary":{"jobId":"job-queued","runId":"run-real","state":"succeeded","mode":"agent"},"children":[{"runId":"run-child","state":"succeeded","mode":"ask","parentRunId":"run-real","delegatedFromRunId":"run-real"}],"lastSeq":3}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        await model.loadRunDetail("job-queued")

        #expect(model.liveTasks.map(\.id) == ["job-queued", "run-child"])
        let parent = try! #require(model.liveTasks.first)
        #expect(parent.phase == .succeeded)
        #expect(parent.resolvedRunId == "run-real")
        #expect(model.liveTasks.last?.delegatedFromRunId == "run-real")
        #expect(model.delegatedChildren(of: parent).map(\.id) == ["run-child"])
    }

    @Test func utf8ArtifactPreviewBoundsBytesWithoutSplittingAScalar() {
        let source = "abc🙂def"
        let bounded = AppModel.boundedUTF8Prefix(source, maxBytes: 6)
        #expect(bounded == "abc")
        #expect(bounded.utf8.count <= 6)
        #expect(AppModel.boundedUTF8Prefix("abcdef", maxBytes: 4) == "abcd")
    }

    @MainActor
    @Test func parentDetailRestoresHistoricalDelegateChildOutsideRunList() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        nonisolated(unsafe) var detailCalls = 0
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/threads/thread-old":
                let json = #"{"thread":{"id":"thread-old","title":"Old","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":["run-parent"],"headRunId":"run-parent","needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"},"sessions":[],"turns":[{"id":"turn-old","threadId":"thread-old","runId":"run-parent","parentRunId":null,"kind":"agent","prompt":"Old Delegate turn","run":{"state":"succeeded","mode":"agent","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"},"delegatedChildRunIds":["run-historical-child"]},"createdAt":"2026-07-15T00:00:00Z"}]}"#
                return (appResponse(for: request), Data(json.utf8))
            case "/v2/runs/run-parent":
                detailCalls += 1
                let json = #"{"summary":{"runId":"run-parent","state":"succeeded","mode":"agent","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"}},"children":[{"runId":"run-historical-child","state":"succeeded","mode":"ask","parentRunId":"run-parent","delegatedFromRunId":"run-parent"}],"lastSeq":9}"#
                return (appResponse(for: request), Data(json.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        await model.openThread("thread-old")

        #expect(model.liveTasks.map(\.id) == ["run-parent", "run-historical-child"])
        #expect(model.delegatedChildren(of: "run-parent").map(\.id) == ["run-historical-child"])
        #expect(detailCalls == 1)
    }

    @MainActor
    @Test func coldDelegateHydrationRejectsWrongSummaryIdentity() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/threads/thread-wrong":
                let json = #"{"thread":{"id":"thread-wrong","title":"Wrong","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":["run-parent"],"headRunId":"run-parent","needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"},"sessions":[],"turns":[{"id":"turn-wrong","threadId":"thread-wrong","runId":"run-parent","parentRunId":null,"kind":"agent","prompt":"Delegate","run":{"state":"succeeded","mode":"agent","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"}},"createdAt":"2026-07-15T00:00:00Z"}]}"#
                return (appResponse(for: request), Data(json.utf8))
            case "/v2/runs/run-parent":
                let json = #"{"summary":{"runId":"run-foreign","state":"succeeded","mode":"agent"},"children":[{"runId":"run-child","state":"succeeded","delegatedFromRunId":"run-parent"}],"lastSeq":1}"#
                return (appResponse(for: request), Data(json.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        await model.openThread("thread-wrong")
        model.workspaceHistoryVisible = true
        await model.loadWorkspaceHistory()
        await model.ensureRunDetail("run-parent", insertingIfMissing: true)

        #expect(model.liveTasks.isEmpty)
        #expect(!model.hydratedRunDetails.contains("run-parent"))
    }

    @MainActor
    @Test func projectedThreadChildIdAuthorizesLazyColdInsertion() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(
            #"{"id":"thread-child","title":"Child","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":["run-parent"],"headRunId":"run-parent","needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"}"#.utf8))
        let card = try JSONDecoder().decode(TurnRunCard.self, from: Data(
            #"{"state":"succeeded","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"},"delegatedChildRunIds":["run-child-projected"]}"#.utf8))
        let turn = ThreadTurnInfo(
            id: "turn-parent", threadId: thread.id, runId: "run-parent",
            parentRunId: nil, planRunId: nil, kind: "agent", prompt: "Delegate",
            run: card, createdAt: "2026-07-15T00:00:00Z")
        model.selectedThreadId = thread.id
        model.selectedThreadDetail = ThreadDetailResponse(
            thread: thread, sessions: [], turns: [turn])
        model.workspaceHistoryVisible = true
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-child-projected" else {
                throw AppRefreshTestError.badRequest
            }
            let json = #"{"summary":{"runId":"run-child-projected","state":"succeeded","mode":"ask","delegatedFromRunId":"run-parent"},"lastSeq":2}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        await model.ensureRunDetail("run-child-projected", insertingIfMissing: true)

        #expect(model.liveTasks.map(\.id) == ["run-child-projected"])
        #expect(model.liveTasks.first?.delegatedFromRunId == "run-parent")
    }

    @MainActor
    @Test func lateColdDetailFromPreviousThreadCannotRestoreRowsOrStreams() async throws {
        let releaseParent = DispatchSemaphore(value: 0)
        defer {
            releaseParent.signal()
            AppRequestStubURLProtocol.handler = nil
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let parentStarted = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/threads/A":
                let json = #"{"thread":{"id":"A","title":"A","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":["run-parent"],"headRunId":"run-parent","needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"},"sessions":[],"turns":[{"id":"turn-A","threadId":"A","runId":"run-parent","parentRunId":null,"kind":"agent","prompt":"Delegate","run":{"state":"running","mode":"agent","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"}},"createdAt":"2026-07-15T00:00:00Z"}]}"#
                return (appResponse(for: request), Data(json.utf8))
            case "/v2/threads/B":
                let json = #"{"thread":{"id":"B","title":"B","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"},"sessions":[],"turns":[]}"#
                return (appResponse(for: request), Data(json.utf8))
            case "/v2/runs/run-parent":
                parentStarted.increment()
                _ = releaseParent.wait(timeout: .now() + 5)
                let json = #"{"summary":{"runId":"run-parent","state":"running","mode":"agent","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"}},"children":[{"runId":"run-child","state":"running","mode":"ask","delegatedFromRunId":"run-parent"}],"lastSeq":9}"#
                return (appResponse(for: request), Data(json.utf8))
            case "/v2/runs":
                return (appResponse(for: request), Data(#"{"runs":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let openA = Task { await model.openThread("A") }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while parentStarted.count == 0 {
            try #require(ContinuousClock.now <= deadline, "parent detail never reached the stub")
            await Task.yield()
        }
        model.runListReconciliationNeeded = true
        await model.openThread("B")
        releaseParent.signal()
        await openA.value

        #expect(model.selectedThreadId == "B")
        #expect(model.liveTasks.isEmpty)
        #expect(model.streamTasks["run-child"] == nil)
        #expect(!model.hydratedRunDetails.contains("run-parent"))
    }

    @MainActor
    @Test func failedDirectThreadSwitchReconciliationStaysDirtyUntilRetrySucceeds() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        nonisolated(unsafe) var parentDetailCalls = 0
        nonisolated(unsafe) var listCalls = 0
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/threads/A":
                let json = #"{"thread":{"id":"A","title":"A","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":["run-parent"],"headRunId":"run-parent","needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"},"sessions":[],"turns":[{"id":"turn-A","threadId":"A","runId":"run-parent","parentRunId":null,"kind":"agent","prompt":"Delegate","run":{"state":"succeeded","mode":"agent","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"},"delegatedChildRunIds":["run-child"]},"createdAt":"2026-07-15T00:00:00Z"}]}"#
                return (appResponse(for: request), Data(json.utf8))
            case "/v2/threads/B":
                let json = #"{"thread":{"id":"B","title":"B","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"},"sessions":[],"turns":[]}"#
                return (appResponse(for: request), Data(json.utf8))
            case "/v2/runs/run-parent":
                parentDetailCalls += 1
                let json = #"{"summary":{"runId":"run-parent","state":"succeeded","mode":"agent","delegation":{"requested":true,"effective":true,"used":true,"reason":"used"}},"children":[{"runId":"run-child","state":"succeeded","mode":"ask","delegatedFromRunId":"run-parent"}],"lastSeq":9}"#
                return (appResponse(for: request), Data(json.utf8))
            case "/v2/runs":
                listCalls += 1
                if listCalls == 1 { throw AppRefreshTestError.badRequest }
                return (appResponse(for: request), Data(#"{"runs":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        await model.openThread("A")
        #expect(model.liveTasks.map(\.id) == ["run-parent", "run-child"])
        await model.openThread("B")
        #expect(model.liveTasks.map(\.id) == ["run-parent", "run-child"])
        #expect(model.runListReconciliationNeeded)

        // No daemon event: reopening the same selected thread retries the dirty
        // bounded reconciliation instead of losing it after the failed list.
        await model.openThread("B")
        #expect(model.liveTasks.isEmpty)
        #expect(!model.runListReconciliationNeeded)

        await model.openThread("A")
        #expect(model.liveTasks.map(\.id) == ["run-parent", "run-child"])
        #expect(parentDetailCalls == 2)
    }

    @MainActor
    @Test func waitingDelegateChildRefreshesPastHydrationCacheAndStopsWhenLoaded() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        var child = TaskRun(
            id: "run-waiting-child", title: "Child", prompt: "", mode: .ask, phase: .running,
            project: "Project", harnesses: [.codex], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .verified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        child.delegatedFromRunId = "run-parent"
        child.waitingOnUser = true
        model.liveTasks = [child]
        // The exact stale-cache scenario: this child was hydrated before the
        // parent/list overlay announced waitingOnUser without the question body.
        model.hydratedRunDetails.insert(child.id)

        nonisolated(unsafe) var detailCalls = 0
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-waiting-child" else {
                throw AppRefreshTestError.badRequest
            }
            detailCalls += 1
            let json = #"{"summary":{"runId":"run-waiting-child","state":"running","mode":"ask","waitingOnUser":true,"delegatedFromRunId":"run-parent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Waiting","bytes":7,"truncated":false},"pendingInteractions":[{"interactionId":"int-child","runId":"run-waiting-child","attemptId":"a1","harnessId":"codex","sourceTool":"request_user_input","questions":[{"id":"q1","question":"Continue?","header":"Choice","options":[{"label":"Yes","description":null}],"multi_select":false}],"requestedAt":"2026-07-26T00:00:00Z","timeoutAt":null}],"lastSeq":4}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        await model.hydrateDelegatedChildInteractions(child)

        let hydrated = try #require(model.task(child.id))
        #expect(detailCalls == 1)
        #expect(hydrated.pendingInteractions.map(\.interactionId) == ["int-child"])
        #expect(hydrated.waitingOnUser)

        // The rendered row's next task pass receives the refreshed value and
        // must not issue another detail request once the question is present.
        await model.hydrateDelegatedChildInteractions(hydrated)
        #expect(detailCalls == 1)
    }

    @MainActor
    @Test func waitingDelegateChildRetryRecoversAfterDetailFailure() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        var child = TaskRun(
            id: "run-retry-child", title: "Child", prompt: "", mode: .ask, phase: .running,
            project: "Project", harnesses: [.codex], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .verified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        child.delegatedFromRunId = "run-parent"
        child.waitingOnUser = true
        model.liveTasks = [child]

        nonisolated(unsafe) var detailCalls = 0
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-retry-child" else {
                throw AppRefreshTestError.badRequest
            }
            detailCalls += 1
            if detailCalls == 1 {
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 503,
                    httpVersion: "HTTP/1.1", headerFields: nil)!
                return (response, Data(#"{"error":"temporarily unavailable"}"#.utf8))
            }
            let json = #"{"summary":{"runId":"run-retry-child","state":"running","mode":"ask","waitingOnUser":true,"delegatedFromRunId":"run-parent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Waiting","bytes":7,"truncated":false},"pendingInteractions":[{"interactionId":"int-retry","runId":"run-retry-child","attemptId":"a1","harnessId":"codex","sourceTool":"request_user_input","questions":[{"id":"q1","question":"Continue?","options":[],"multi_select":false}],"requestedAt":"2026-07-26T00:00:00Z","timeoutAt":null}],"lastSeq":5}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        await model.hydrateDelegatedChildInteractions(child)
        let failed = try #require(model.task(child.id))
        #expect(detailCalls == 1)
        #expect(failed.engineError?.hasPrefix("Could not load run detail:") == true)
        #expect(failed.pendingInteractions.isEmpty)
        #expect(DelegationPresentation.childInteractionLoadFailure(
            waitingOnUser: failed.waitingOnUser,
            pendingInteractionCount: failed.pendingInteractions.count,
            engineError: failed.engineError) != nil)

        // This is the Retry button's exact action.
        await model.hydrateDelegatedChildInteractions(failed)
        let recovered = try #require(model.task(child.id))
        #expect(detailCalls == 2)
        #expect(recovered.engineError == nil)
        #expect(recovered.pendingInteractions.map(\.interactionId) == ["int-retry"])
    }

    @MainActor
    @Test func interactionAnswerUsesCanonicalPendingRunIdAcrossQueuedAlias() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        var child = TaskRun(
            id: "job-child", resolvedRunId: "run-child", title: "Child", prompt: "",
            mode: .ask, phase: .running, project: "Project", harnesses: [.codex], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .verified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        child.waitingOnUser = true
        child.pendingInteractions = [PendingInteraction(
            interactionId: "int-child", runId: "run-child", attemptId: "a1",
            harnessId: "codex", sourceTool: "request_user_input", questions: [],
            requestedAt: "2026-07-26T00:00:00Z", timeoutAt: nil)]
        model.liveTasks = [child]

        AppRequestStubURLProtocol.handler = { request in
            guard request.httpMethod == "POST",
                  request.url?.path == "/v2/runs/run-child/interactions/int-child/answer" else {
                throw AppRefreshTestError.badRequest
            }
            return (appResponse(for: request), Data(
                #"{"accepted":true,"status":"accepted","message":null}"#.utf8))
        }

        let failure = await model.answerInteraction(
            runId: child.pendingInteractions[0].runId,
            interactionId: "int-child",
            answers: [InteractionAnswerPayload(
                questionId: "q1", selectedLabels: ["Yes"], freeText: nil)])

        #expect(failure == nil)
        let updated = try #require(model.task("job-child"))
        #expect(updated.pendingInteractions.isEmpty)
        #expect(!updated.waitingOnUser)
    }

    @MainActor
    @Test func overlappingViewHydrationUsesOneRunDetailRequest() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-static", title: "Run", prompt: "", mode: .agent, phase: .succeeded,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        nonisolated(unsafe) var calls = 0
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-static" else {
                throw AppRefreshTestError.badRequest
            }
            calls += 1
            Thread.sleep(forTimeInterval: 0.06)
            return (appResponse(for: request), Data(
                #"{"summary":{"runId":"run-static","state":"succeeded","mode":"agent"},"lastSeq":2}"#.utf8))
        }

        let first = Task { await model.ensureRunDetail("run-static") }
        try await Task.sleep(for: .milliseconds(10))
        await model.ensureRunDetail("run-static")
        await first.value
        await model.ensureRunDetail("run-static")

        #expect(calls == 1)
    }

    @MainActor
    @Test func delayedOldClientDetailCannotRepopulateAfterReconnectFence() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-stale-detail", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-stale-detail" else {
                throw AppRefreshTestError.badRequest
            }
            Thread.sleep(forTimeInterval: 0.12)
            return (appResponse(for: request), Data(
                #"{"summary":{"runId":"run-stale-detail","state":"succeeded","mode":"agent"},"lastSeq":4}"#.utf8))
        }

        let load = Task { await model.loadRunDetail("run-stale-detail") }
        try await Task.sleep(for: .milliseconds(20))
        model.enterHardOffline()
        await load.value

        #expect(model.liveTasks.isEmpty)
    }

    @MainActor
    @Test func delayedOldArtifactFallbackCannotPoisonReconnectHydration() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-stale-artifact", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let artifactStarted = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs/run-stale-artifact":
                return (appResponse(for: request), Data(
                    #"{"summary":{"runId":"run-stale-artifact","state":"succeeded","mode":"agent"},"lastSeq":4}"#.utf8))
            case "/v2/runs/run-stale-artifact/artifacts/final/answer.md":
                artifactStarted.increment()
                Thread.sleep(forTimeInterval: 0.15)
                return (appResponse(for: request), Data("stale answer".utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let load = Task { await model.loadRunDetail("run-stale-artifact") }
        for _ in 0..<100 where artifactStarted.count == 0 {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(artifactStarted.count == 1)
        model.enterHardOffline()
        await load.value

        #expect(model.liveTasks.isEmpty)
        #expect(!model.hydratedRunDetails.contains("run-stale-artifact"))
    }

    @MainActor
    @Test func detailRemovedDuringArtifactFallbackIsNotMarkedHydrated() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-removed", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let artifactStarted = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs/run-removed":
                return (appResponse(for: request), Data(
                    #"{"summary":{"runId":"run-removed","state":"succeeded","mode":"agent"},"lastSeq":4}"#.utf8))
            case "/v2/runs/run-removed/artifacts/final/answer.md":
                artifactStarted.increment()
                Thread.sleep(forTimeInterval: 0.15)
                return (appResponse(for: request), Data("answer".utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let load = Task { await model.loadRunDetail("run-removed") }
        for _ in 0..<100 where artifactStarted.count == 0 {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(artifactStarted.count == 1)
        model.liveTasks.removeAll()
        await load.value

        #expect(model.liveTasks.isEmpty)
        #expect(!model.hydratedRunDetails.contains("run-removed"))
    }

    @MainActor
    @Test func lateOldClientCannotClearNewSameRunDetailState() async throws {
        let releaseOld = DispatchSemaphore(value: 0)
        defer {
            releaseOld.signal()
            AppRequestStubURLProtocol.handler = nil
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let oldClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1111")!, token: "old",
            session: URLSession(configuration: config))
        let newClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:2222")!, token: "new",
            session: URLSession(configuration: config))
        let model = AppModel(client: oldClient, requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-overlap", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let oldStarted = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-overlap" else {
                throw AppRefreshTestError.badRequest
            }
            if request.url?.port == 1111 {
                oldStarted.increment()
                _ = releaseOld.wait(timeout: .now() + 5)
                let json = #"{"summary":{"runId":"run-overlap","state":"failed","mode":"agent","error":"old failure"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"old answer","truncated":false},"lastSeq":5}"#
                return (appResponse(for: request), Data(json.utf8))
            }
            let json = #"{"summary":{"runId":"run-overlap","state":"succeeded","mode":"agent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"new answer","truncated":false},"lastSeq":20}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        let oldLoad = Task { await model.loadRunDetail("run-overlap") }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while oldStarted.count == 0 {
            try #require(ContinuousClock.now <= deadline, "old detail never reached the stub")
            await Task.yield()
        }
        // Same state retirement as hard-offline, without cancelling the old
        // task, so its response can land deterministically after the new load.
        model.retireRunDetailState(cancelInFlight: false)
        model.adoptClientForReconnect(newClient)
        await model.loadRunDetail("run-overlap")
        releaseOld.signal()
        await oldLoad.value

        let task = try #require(model.liveTasks.first)
        #expect(task.phase == .succeeded)
        #expect(task.answerText == "new answer")
        #expect(task.engineError == nil)
        #expect(model.hydratedRunDetails.contains("run-overlap"))
        #expect(model.runDetailLoads["run-overlap"] == nil)
        #expect(model.runDetailLoadTokens["run-overlap"] == nil)
        #expect(model.snapshotLoadDepth["run-overlap"] == nil)
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
        let snapshotArrived = AppRefreshCallCounter()
        let releaseSnapshot = DispatchSemaphore(value: 0)
        defer { releaseSnapshot.signal() }
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-delayed" else {
                throw AppRefreshTestError.badRequest
            }
            snapshotArrived.increment()
            _ = releaseSnapshot.wait(timeout: .now() + 5)
            let json = #"{"summary":{"runId":"run-delayed","state":"running","mode":"agent","spendUsd":1},"lastSeq":10}"#
            return (appResponse(for: request), Data(json.utf8))
        }

        let load = Task { await model.loadRunDetail("run-delayed") }
        try await waitForAppTest(
            snapshotArrived, message: "delayed detail snapshot never reached the stub")
        // The CASH disclosure (W4.3): cumulative, last-wins — the replayed
        // event is newer than the snapshot's spendUsd:1 and must overwrite it.
        model.apply(BusEnvelope(
            seq: 11, kind: "budget",
            event: .object([
                "type": .string("budget.cash"),
                "payload": .object(["cash_spend_usd": .number(2)])
            ])
        ), to: "run-delayed")
        #expect(model.deferredEnvelopes["run-delayed"]?.map(\.seq) == [11])
        releaseSnapshot.signal()
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
                let json = #"{"summary":{"runId":"run-diag","state":"failed","mode":"agent","failure":{"phase":"terminalization","category":"internal","code":"delegation_child_drain_timeout","safeMessage":"Timed out draining delegated children.","logRefs":[],"eventRefs":[],"nextActions":[]}},"failure":{"phase":"terminalization","category":"internal","code":"delegation_child_drain_timeout","safeMessage":"Timed out draining delegated children.","logRefs":[],"eventRefs":[],"nextActions":[]},"lastSeq":10,"artifacts":[{"path":"events.jsonl","kind":"file","bytes":3000000},{"path":"attempts/a01/rollout.jsonl","kind":"file","bytes":5000000},{"path":"final/patch.diff","kind":"file","bytes":2461063}]}"#
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
        #expect(summary.contains("code: delegation_child_drain_timeout"))
        #expect(summary.count < 2_000)

        await model.loadRunDiff("run-diag")
        #expect(artifactFetches.count == 1)
        #expect(model.liveTasks.first?.diff.count == 1)
    }

    @MainActor
    @Test func diagnosticPresentationKeepsStandardPrimaryOutOfTheAnswerLane() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-diagnostic-primary", title: "Run", prompt: "", mode: .ask,
            phase: .cancelled, project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]
        let artifactFetches = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            if request.url?.path == "/v2/runs/run-diagnostic-primary" {
                let json = #"{"summary":{"runId":"run-diagnostic-primary","state":"cancelled","mode":"ask","outputReadyState":"diagnostic"},"lastSeq":3,"artifacts":[{"path":"final/answer.md","kind":"file","bytes":25}],"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Unverified partial answer","truncated":false}}"#
                return (appResponse(for: request), Data(json.utf8))
            }
            if request.url?.path.contains("/artifacts/") == true {
                artifactFetches.increment()
                return (
                    HTTPURLResponse(
                        url: request.url!, statusCode: 404,
                        httpVersion: "HTTP/1.1", headerFields: nil)!,
                    Data()
                )
            }
            throw AppRefreshTestError.badRequest
        }

        await model.loadRunDetail("run-diagnostic-primary")

        #expect(model.liveTasks.first?.answerText == nil)
        #expect(model.liveTasks.first?.diagnosticText?.contains("Unverified partial answer") == true)
        #expect(artifactFetches.count == 0)
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
        // Round-3 #2: the failure names the artifact PATH, not just a run id.
        #expect(message.contains("final/patch.diff"))
        #expect(model.liveTasks[0].hasPatchArtifact)
    }

    /// Round-3 #9: an OFFLINE terminal run that HAS a patch artifact must render an
    /// honest failure+Retry, not an empty Changes tab masquerading as `.loaded`.
    @MainActor
    @Test func offlineDiffWithAPatchArtifactFailsInsteadOfFakeLoaded() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        var task = TaskRun(
            id: "run-offline-diff", title: "Run", prompt: "", mode: .agent, phase: .succeeded,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        task.artifactPaths = ["final/patch.diff"]
        model.liveTasks = [task]

        guard case .failed(let message) = await model.loadRunDiff("run-offline-diff") else {
            Issue.record("offline + patch artifact should be a visible failure, not .loaded")
            return
        }
        #expect(message.contains("offline"))
        #expect(message.contains("final/patch.diff"))
    }

    /// Round-3 crit #1: a `loadRunDetail → refreshRuns` sequence must NOT wipe the
    /// truth only Run Detail hydrates. The bare list summary carries none of these
    /// satellites, so the merge has to carry the last hydrated value forward.
    @MainActor
    @Test func listRefreshPreservesDetailOnlyReceipts() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.health = .connected
        var hydrated = TaskRun(
            id: "run-detail", title: "Run", prompt: "", mode: .agent, phase: .succeeded,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        hydrated.valuationUsd = 4.20
        hydrated.council = CouncilInfo(requested: 2, drafted: 2, degraded: false, mergedBy: "claude", members: [])
        hydrated.outcomeBanner = "Succeeded — patch ready"
        hydrated.applyEligibility = ApplyEligibility(eligible: true, state: "ok", reason: nil, requiredAction: nil)
        hydrated.planReadiness = PlanReadiness(state: "ready", questionCount: 0)
        hydrated.operatorDecisionAction = "accept_risk"
        // SSE-only disclosures (round-4 #6): attentionNote is a receipt the user must
        // keep seeing; retryStatus is transient and must NOT survive onto a terminal run.
        hydrated.attentionNote = "Rotated to claude after codex diverged"
        hydrated.retryStatus = RetryStatusNote(kind: "api_retry", attempt: 2, maxRetries: 10, retryDelayMs: 2500, errorCategory: "overloaded")
        model.liveTasks = [hydrated]

        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs" else { throw AppRefreshTestError.badRequest }
            // A bare list summary — NONE of the detail-only satellites ride here.
            return (appResponse(for: request), Data(#"{"runs":[{"runId":"run-detail","state":"succeeded"}]}"#.utf8))
        }

        await model.refreshRuns()

        let merged = try #require(model.liveTasks.first)
        #expect(merged.valuationUsd == 4.20)
        #expect(merged.council?.requested == 2)
        #expect(merged.outcomeBanner == "Succeeded — patch ready")
        #expect(merged.applyEligibility?.eligible == true)
        #expect(merged.planReadiness?.state == "ready")
        #expect(merged.operatorDecisionAction == "accept_risk")
        // The rotation/diverged disclosure survives the list refresh.
        #expect(merged.attentionNote == "Rotated to claude after codex diverged")
        // The transient retry note is NOT resurrected onto a now-terminal run.
        #expect(merged.retryStatus == nil)
    }

    /// Round-5 crit (INV-093): the LIST summary carries the terminal apply axes, so a
    /// CLI apply/revert while the app is open must retire the stale eligible-Apply
    /// affordance on the next refresh. `summary.result` is SERVER TRUTH and wins over
    /// the locally-hydrated "not_applied" the eligible run still holds.
    @MainActor
    @Test func listRefreshProjectsServerApplyStateOverStaleEligibleRun() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.health = .connected
        // An eligible, not-yet-applied decision-flow run: Apply is offered.
        var hydrated = TaskRun(
            id: "run-apply", title: "Run", prompt: "", mode: .agent, phase: .succeeded,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        hydrated.applyEligibility = ApplyEligibility(eligible: true, state: "ok", reason: nil, requiredAction: nil)
        hydrated.operatorDecisionAction = "accept_risk"   // decision-flow → showsApply gate
        hydrated.applyState = "not_applied"
        model.liveTasks = [hydrated]
        #expect(DecisionApplyPresentation.showsApply(hydrated))   // live before the CLI apply

        // The CLI applied the run: the list summary now carries result.applyState=applied.
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs" else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), Data(#"{"runs":[{"runId":"run-apply","state":"succeeded","result":{"kind":"patch","blockers":0,"applyState":"applied","revertable":true,"adopted":true}}]}"#.utf8))
        }
        await model.refreshRuns()
        let applied = try #require(model.liveTasks.first)
        #expect(applied.applyState == "applied")
        #expect(applied.adopted)
        #expect(applied.revertable)
        // Server truth wins even though the stale detail-only eligibility is still true.
        #expect(applied.applyEligibility?.eligible == true)
        #expect(!DecisionApplyPresentation.showsApply(applied))   // affordance retired

        // A subsequent CLI REVERT flips it to reverted; still no Apply affordance.
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs" else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), Data(#"{"runs":[{"runId":"run-apply","state":"succeeded","result":{"kind":"patch","blockers":0,"applyState":"reverted","revertable":false,"adopted":false}}]}"#.utf8))
        }
        await model.refreshRuns()
        let reverted = try #require(model.liveTasks.first)
        #expect(reverted.applyState == "reverted")
        #expect(!reverted.adopted)
        #expect(!DecisionApplyPresentation.showsApply(reverted))
    }

    /// Round-4 #6: the W-C2 api_retry note is SSE-only, so a list refresh landing
    /// mid-retry on a STILL-ACTIVE run must not wipe it (the live status line would
    /// otherwise blink out the "Retrying 2/10" disclosure). attentionNote likewise
    /// survives on an active run.
    @MainActor
    @Test func listRefreshPreservesRetryStatusForActiveRun() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.health = .connected
        var running = TaskRun(
            id: "run-live", title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        running.retryStatus = RetryStatusNote(kind: "api_retry", attempt: 3, maxRetries: 10, retryDelayMs: 800, errorCategory: "overloaded")
        running.attentionNote = "Waiting on Anthropic — retrying"
        model.liveTasks = [running]

        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs" else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), Data(#"{"runs":[{"runId":"run-live","state":"running"}]}"#.utf8))
        }

        await model.refreshRuns()

        let merged = try #require(model.liveTasks.first)
        #expect(merged.retryStatus?.attempt == 3)
        #expect(merged.retryStatus?.errorCategory == "overloaded")
        #expect(merged.attentionNote == "Waiting on Anthropic — retrying")
    }

    /// Round-3 crit #5: a runs-list response completing AFTER a reconnect fence
    /// (`enterHardOffline` nils the client) must not repopulate the wiped snapshot
    /// from the OLD client — the post-await generation/identity re-check drops it.
    @MainActor
    @Test func delayedOldClientRunsResponseCannotRepopulateAfterReconnectFence() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        model.health = .connected
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs" else { throw AppRefreshTestError.badRequest }
            Thread.sleep(forTimeInterval: 0.12)   // still in flight when the fence fires
            return (appResponse(for: request), Data(#"{"runs":[{"runId":"stale-r1","state":"succeeded"}]}"#.utf8))
        }

        let refresh = Task { await model.refreshRuns() }
        try await Task.sleep(for: .milliseconds(20))   // lead pass now awaiting listRuns
        model.enterHardOffline()                        // reconnect fence: client → nil
        await refresh.value

        // The OLD client's response never resurrected a run into the wiped snapshot.
        #expect(model.liveTasks.isEmpty)
    }

    /// Round-3 crit #3: a produced text file with malformed UTF-8 is REFUSED as
    /// not-renderable (naming its path), never silently U+FFFD-replaced and painted
    /// as if it were real text.
    @MainActor
    @Test func producedTextOutcomeRefusesMalformedUtf8() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            // A lone 0xFF byte is never valid UTF-8.
            return (appResponse(for: request), Data([0xFF, 0xFE, 0x41]))
        }

        let outcome = await model.producedTextOutcome(runId: "r", path: "artifacts/report.txt")
        guard case .failure(.notRenderable(let message)) = outcome else {
            Issue.record("malformed UTF-8 should map to .notRenderable, got \(outcome)")
            return
        }
        #expect(message.contains("not valid UTF-8"))
        #expect(message.contains("artifacts/report.txt"))
    }

    /// Round-4 advisory #2: the run-tree artifact-text surface is symmetric with
    /// producedTextOutcome — a malformed-UTF-8 body is REFUSED as not-renderable
    /// (naming its path), never silently U+FFFD-replaced. `artifactText` now decodes
    /// strictly in the client and the outcome layer maps `.decoding` → `.notRenderable`.
    @MainActor
    @Test func artifactTextOutcomeRefusesMalformedUtf8() async {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            // A lone 0xFF byte is never valid UTF-8.
            return (appResponse(for: request), Data([0xFF, 0xFE, 0x41]))
        }

        let outcome = await model.artifactTextOutcome(runId: "r", path: "final/report.md")
        guard case .failure(.notRenderable(let message)) = outcome else {
            Issue.record("malformed UTF-8 should map to .notRenderable, got \(outcome)")
            return
        }
        #expect(message.contains("not valid UTF-8"))
        #expect(message.contains("final/report.md"))
    }

    /// Round-4 advisory #4: a FAILED project-registry refresh must not keep
    /// presenting the old registry — the composer would show STALE nesting overlap
    /// as current truth. On failure the registry is cleared so nesting is genuinely
    /// undisclosed (the documented contract), never a stale warning shown as fresh.
    @MainActor
    @Test func refreshProjectsFailureClearsStaleNestingInsteadOfShowingItAsFresh() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        // A previously-loaded registry whose nesting overlap the composer discloses.
        let child = try JSONDecoder().decode(RegisteredProject.self, from: Data(#"""
        {"schemaVersion":1,"id":"child","root":"/repo/child","createdAt":"2026-07-19T12:00:00.000Z",
         "updatedAt":"2026-07-19T12:00:00.000Z",
         "nesting":[{"relation":"inside","root":"/repo","projectId":"parent"}]}
        """#.utf8))
        model.registeredProjects = [child]
        #expect(!model.projectNesting(forRoot: "/repo/child").isEmpty)   // disclosed before the failure

        // The registry GET now FAILS (engine hiccup): listProjects throws.
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/projects" else { throw AppRefreshTestError.badRequest }
            let response = HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (response, Data("{}".utf8))
        }
        let ok = await model.refreshProjects()

        #expect(ok == false)
        // Stale overlap is NOT presented as current truth after a failed refresh.
        #expect(model.projectNesting(forRoot: "/repo/child").isEmpty)
        #expect(model.registeredProjects.isEmpty)
    }

    /// Round-4 advisory #5: the steady-state connectivity poll re-HANDSHAKES, so a
    /// daemon SWAPPED at the same endpoint refreshes its disclosed build identity —
    /// About never pins the old version/sha. Successive handshakes with different
    /// identities must each update engineIdentity.
    @MainActor
    @Test func pollEngineIdentityRefreshesSwappedDaemonIdentity() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        // Keep this connectivity-only test hermetic: exact local-runtime
        // lifecycle behavior has its own injected AppModel coverage in
        // LocalDaemonReconcilerTests and must never probe/stop a host daemon.
        model.localDaemonReconciler = LocalDaemonReconciler(
            daemon: AppRuntimeDaemonControl(
                isBusyProbe: { nil }, handshakeProbe: { nil }),
            lifecycleOwner: model.localRuntimeLifecycleOwner,
            targetClosure: { nil })
        model.health = .connected
        let handshakes = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/healthz"):
                return (appResponse(for: request), Data(#"{"ok":true}"#.utf8))
            case ("POST", "/v2/handshake"):
                handshakes.increment()
                // Same endpoint, DIFFERENT serving build across successive polls.
                let version = handshakes.count == 1 ? "3.1.0" : "3.1.1"
                let sha = handshakes.count == 1 ? "sha-A" : "sha-B"
                return (appResponse(for: request), Data(#"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"\#(version)","sha":"\#(sha)","entry":"/opt/claudexor/daemon.js"}}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        #expect(await model.pollEngineIdentity())
        #expect(model.engineIdentity?.sha == "sha-A")
        #expect(model.engineIdentity?.version == "3.1.0")

        // Daemon replaced at the same endpoint: the next poll picks up the NEW identity.
        #expect(await model.pollEngineIdentity())
        #expect(model.engineIdentity?.sha == "sha-B")
        #expect(model.engineIdentity?.version == "3.1.1")
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
                "payload": .object([
                    "cash_spend_usd": .number(0.4),
                    "valuation_usd": .number(2),
                    "estimated": .bool(true)
                ])
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
        #expect(model.liveBoxes["run-cash"]?.spendEstimated == true)

        model.ingestStreamEnvelope(BusEnvelope(
            seq: 3, kind: "budget",
            event: .object([
                "type": .string("budget.cash"),
                "payload": .object([
                    "cash_spend_usd": .number(0),
                    "valuation_usd": .number(2),
                    "estimated": .bool(true)
                ])
            ])
        ), to: "run-cash")
        for _ in 0..<40 where model.liveBoxes["run-cash"]?.spendUsd != 0 {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(model.liveBoxes["run-cash"]?.spendUsd == 0)
        #expect(model.liveBoxes["run-cash"]?.spendEstimated == false)

        model.ingestStreamEnvelope(BusEnvelope(
            seq: 4, kind: "budget",
            event: .object([
                "type": .string("budget.cash"),
                "payload": .object([
                    "cash_spend_usd": .number(0),
                    "valuation_usd": .number(2),
                    "estimated": .bool(true),
                    "valuation_knowledge": .string("estimated")
                ])
            ])
        ), to: "run-cash")
        for _ in 0..<40 where model.liveBoxes["run-cash"]?.spendEstimated != true {
            try await Task.sleep(for: .milliseconds(50))
        }
        // Current component-aware events are not legacy: preserve the engine's
        // explicit cash-estimated bit even when the cumulative cash value is 0.
        #expect(model.liveBoxes["run-cash"]?.spendUsd == 0)
        #expect(model.liveBoxes["run-cash"]?.spendEstimated == true)
        model.ingestStreamEnvelope(BusEnvelope(seq: 5, kind: "budget", event: .object([
            "type": .string("budget.cash"),
            "payload": .object(["cash_spend_usd": .number(0), "estimated": .bool(true),
                                "cash_knowledge": .string("unknown"), "valuation_usd": .number(2)])
        ])), to: "run-cash")
        for _ in 0..<40 where model.liveBoxes["run-cash"]?.spendKnown != false {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(model.liveBoxes["run-cash"]?.spendKnown == false)
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
    @Test func profileToggleRefusalReturnsInlineReasonAndKeepsWireState() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41145), requestNotificationAuthorization: false)
        let seed = try JSONDecoder().decode(
            CredentialProfilesResponse.self,
            from: appAccountsSnapshot(
                profileID: "work", displayName: "Work",
                observedAt: "2026-08-09T00:00:00Z"))
        model.storeCredentialProfiles(
            seed.profiles, accountPools: seed.accountPools, at: .local)
        let patched = AppRefreshCallCounter()
        let reloaded = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            if request.httpMethod == "PATCH",
               request.url?.path == "/v2/credential-profiles/claude/work"
            {
                patched.increment()
                return (appResponse(for: request, status: 409),
                        Data(#"{"error":"account is busy logging in"}"#.utf8))
            }
            if request.httpMethod == "GET",
               request.url?.path == "/v2/credential-profiles",
               request.url?.query == nil
            {
                reloaded.increment()
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "work", displayName: "Work",
                    observedAt: "2026-08-09T00:00:01Z"))
            }
            throw AppRefreshTestError.badRequest
        }

        let row = try #require(AccountsPresentation.rows(model: model).first)
        let error = await AccountsSurface.setEnabled(row, to: false, model: model)

        #expect(error == "Request failed (HTTP 409): account is busy logging in")
        #expect(patched.count == 1)
        #expect(reloaded.count == 1)
        #expect(AccountsPresentation.rows(model: model).first?.enabled == true)
    }

    /// D-U4: a partial credential cleanup is a typed RETRYABLE 503
    /// (`credential_cleanup_failed`) that keeps the row registered — the app
    /// surfaces it as a retryable error state, never as a removed-with-warning
    /// success. (The retired `setNativeCredentialsEnabled` settings path died
    /// with the CLI-login pseudo-row; every Enabled toggle is the profile
    /// PATCH now — pinned by setProfileEnabledPatchesTheCredentialProfileRoute.)
    @MainActor
    @Test func deleteCleanupFailureSurfacesRetryableErrorAndKeepsTheRow() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let model = AppModel(
            client: appTestGateway(port: 41146), requestNotificationAuthorization: false)
        let seed = try JSONDecoder().decode(
            CredentialProfilesResponse.self,
            from: appAccountsSnapshot(
                profileID: "work", displayName: "Work",
                observedAt: "2026-08-09T00:00:00Z"))
        model.storeCredentialProfiles(seed.profiles, accountPools: seed.accountPools, at: .local)
        let deleted = AppRefreshCallCounter()
        let reloaded = AppRefreshCallCounter()
        AppRequestStubURLProtocol.handler = { request in
            if request.httpMethod == "DELETE",
               request.url?.path == "/v2/credential-profiles/claude/work"
            {
                deleted.increment()
                return (appResponse(for: request, status: 503), Data(
                    #"{"code":"credential_cleanup_failed","message":"credential cleanup failed; the account is still registered — retry the removal: rm failed.","retryable":true,"fieldErrors":{},"requiredActions":[],"evidenceRefs":[]}"#.utf8))
            }
            if request.httpMethod == "GET",
               request.url?.path == "/v2/credential-profiles",
               request.url?.query == nil
            {
                reloaded.increment()
                return (appResponse(for: request), appAccountsSnapshot(
                    profileID: "work", displayName: "Work",
                    observedAt: "2026-08-09T00:00:01Z"))
            }
            throw AppRefreshTestError.badRequest
        }

        let notice = await model.deleteCredentialProfile(harnessId: "claude", profileId: "work")

        #expect(deleted.count == 1)
        #expect(reloaded.count == 1)
        #expect(notice.isError)
        #expect(notice.message.contains("still registered"))
        #expect(notice.message.contains("Try Remove again"))
        // The row survives the failed delete — never a half-deleted success.
        #expect(AccountsPresentation.rows(model: model).first?.profileId == "work")
    }

    /// Concurrent saves are SERIALIZED (X10/X14): the second save's POST must
    /// not reach the wire while the first is in flight, answers apply in issue
    /// order (= daemon commit order under the config lock), and the last
    /// save's answer is the surviving projection (INV-002).
    @MainActor
    @Test func concurrentSavesSerializeAndApplyInIssueOrder() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)

        func snapshot(timeoutMs: Int) -> String {
            #"{"sources":[],"routing":{"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":"# + String(timeoutMs) + "}"
        }
        let saveAArrived = AppRefreshCallCounter()
        let saveBArrived = AppRefreshCallCounter()
        // Save A (patches "codex") BLOCKS in the stub until the TEST releases
        // it (the handler runs off the main actor, so the wait cannot deadlock
        // the model's continuations); the serialization contract says B's POST
        // must not arrive while A holds the chain.
        let releaseSaveA = DispatchSemaphore(value: 0)
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/settings"):
                guard let body = appTestRequestBody(request),
                      let obj = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let harnesses = obj["harnesses"] as? [String: Any] else {
                    throw AppRefreshTestError.badRequest
                }
                if harnesses["codex"] != nil {
                    saveAArrived.increment()
                    _ = releaseSaveA.wait(timeout: .now() + 5)
                    return (appResponse(for: request), Data(snapshot(timeoutMs: 111_000).utf8))
                }
                saveBArrived.increment()
                return (appResponse(for: request), Data(snapshot(timeoutMs: 222_000).utf8))
            case (_, "/v2/harnesses"):
                return (appResponse(for: request), Data(#"{"harnesses":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let saveA = Task { await model.saveSettings(SettingsUpdateRequest(
            harnesses: ["codex": HarnessSettingsPatch(effort: "high")])) }
        // Bounded wait (no unbounded-hang loop): A's request must reach the
        // stub within ~5s so A is provably issued before B.
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while saveAArrived.count == 0 {
            try #require(ContinuousClock.now <= deadline, "save A never reached the stub")
            await Task.yield()
        }
        let saveB = Task { await model.saveSettings(SettingsUpdateRequest(
            harnesses: ["claude": HarnessSettingsPatch(effort: "low")])) }
        // Serialization fence: while A is blocked in the stub, B's POST must
        // NOT arrive — give the scheduler real chances to violate it.
        for _ in 0..<200 { await Task.yield() }
        #expect(saveBArrived.count == 0)
        releaseSaveA.signal()
        let okA = await saveA.value
        let okB = await saveB.value
        #expect(okA && okB)
        #expect(saveBArrived.count == 1)
        // Issue order == apply order: the LAST save's answer survives.
        #expect(model.settingsSnapshot?.interactionTimeoutMs == 222_000)
        #expect(model.settingsStatus == "Saved engine defaults.")
    }

    /// A newer save that FAILS must keep its failure status: the serialized
    /// chain means an earlier success can never land after it and mask it.
    @MainActor
    @Test func failedNewerSaveKeepsItsFailureStatusAndOlderTruth() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let okSnapshot = #"{"sources":[],"routing":{"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":111000}"#
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/settings"):
                guard let body = appTestRequestBody(request),
                      let obj = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let harnesses = obj["harnesses"] as? [String: Any] else {
                    throw AppRefreshTestError.badRequest
                }
                if harnesses["codex"] != nil {
                    return (appResponse(for: request), Data(okSnapshot.utf8))
                }
                throw AppRefreshTestError.badRequest
            case (_, "/v2/harnesses"):
                return (appResponse(for: request), Data(#"{"harnesses":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }
        let okA = await model.saveSettings(SettingsUpdateRequest(
            harnesses: ["codex": HarnessSettingsPatch(effort: "high")]))
        let okB = await model.saveSettings(SettingsUpdateRequest(
            harnesses: ["claude": HarnessSettingsPatch(effort: "low")]))
        #expect(okA && !okB)
        // A's applied truth survives; B's FAILURE status is not masked.
        #expect(model.settingsSnapshot?.interactionTimeoutMs == 111_000)
        #expect(model.settingsStatus?.hasPrefix("Could not save settings") == true)
    }

    /// X20/X24 fence: enterHardOffline while a save is IN FLIGHT — the late
    /// answer must not repopulate the cleared projection (post-await epoch
    /// re-check), and a save QUEUED before offline retires inert.
    @MainActor
    @Test func hardOfflineRetiresInFlightAndQueuedSettingsSaves() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        let okSnapshot = #"{"sources":[],"routing":{"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":333000}"#
        let saveArrived = AppRefreshCallCounter()
        let releaseSave = DispatchSemaphore(value: 0)
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/settings"):
                saveArrived.increment()
                _ = releaseSave.wait(timeout: .now() + 5)
                return (appResponse(for: request), Data(okSnapshot.utf8))
            case (_, "/v2/harnesses"):
                return (appResponse(for: request), Data(#"{"harnesses":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }
        let inFlight = Task { await model.saveSettings(SettingsUpdateRequest(
            harnesses: ["codex": HarnessSettingsPatch(effort: "high")])) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while saveArrived.count == 0 {
            try #require(ContinuousClock.now <= deadline, "in-flight save never reached the stub")
            await Task.yield()
        }
        let queued = Task { await model.saveSettings(SettingsUpdateRequest(
            harnesses: ["claude": HarnessSettingsPatch(effort: "low")])) }
        // Let the queued save START (capture the pre-offline epoch and enqueue
        // behind the in-flight save) before the offline transition.
        for _ in 0..<50 { await Task.yield() }
        model.enterHardOffline()
        releaseSave.signal()
        let okInFlight = await inFlight.value
        let okQueued = await queued.value
        #expect(!okInFlight && !okQueued)
        // The late answer did not repopulate the offline-cleared projection,
        // no status was written over the reset, and the queued save never
        // reached the wire.
        #expect(model.settingsSnapshot == nil)
        #expect(model.settingsStatus == nil)
        #expect(saveArrived.count == 1)
    }

    /// X30 fence: offline + reconnect while a save is STILL in flight — the
    /// post-reconnect save must not reach the wire until the old request
    /// settles (the chain tail survives enterHardOffline), and only the new
    /// save's answer is applied.
    @MainActor
    @Test func reconnectSaveWaitsForTheOldInFlightRequest() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config))
        let model = AppModel(client: client, requestNotificationAuthorization: false)

        func snapshot(timeoutMs: Int) -> String {
            #"{"sources":[],"routing":{"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":"# + String(timeoutMs) + "}"
        }
        let oldArrived = AppRefreshCallCounter()
        let newArrived = AppRefreshCallCounter()
        let releaseOld = DispatchSemaphore(value: 0)
        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/settings"):
                guard let body = appTestRequestBody(request),
                      let obj = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let harnesses = obj["harnesses"] as? [String: Any] else {
                    throw AppRefreshTestError.badRequest
                }
                if harnesses["codex"] != nil {
                    oldArrived.increment()
                    _ = releaseOld.wait(timeout: .now() + 5)
                    return (appResponse(for: request), Data(snapshot(timeoutMs: 111_000).utf8))
                }
                newArrived.increment()
                return (appResponse(for: request), Data(snapshot(timeoutMs: 222_000).utf8))
            case (_, "/v2/harnesses"):
                return (appResponse(for: request), Data(#"{"harnesses":[]}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }
        let oldSave = Task { await model.saveSettings(SettingsUpdateRequest(
            harnesses: ["codex": HarnessSettingsPatch(effort: "high")])) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while oldArrived.count == 0 {
            try #require(ContinuousClock.now <= deadline, "old save never reached the stub")
            await Task.yield()
        }
        model.enterHardOffline()
        model.adoptClientForReconnect(client)
        let newSave = Task { await model.saveSettings(SettingsUpdateRequest(
            harnesses: ["claude": HarnessSettingsPatch(effort: "low")])) }
        // Single-chain fence: the post-reconnect save must NOT reach the wire
        // while the old request is still in flight.
        for _ in 0..<200 { await Task.yield() }
        #expect(newArrived.count == 0)
        releaseOld.signal()
        let okOld = await oldSave.value
        let okNew = await newSave.value
        #expect(!okOld && okNew)
        #expect(newArrived.count == 1)
        // Only the new-epoch answer was applied; the old one retired inert.
        #expect(model.settingsSnapshot?.interactionTimeoutMs == 222_000)
        #expect(model.settingsStatus == "Saved engine defaults.")
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

private func appQuotaResponse(subjectID: String, observedAt: String) -> Data {
    Data("""
    {"snapshots":[{"subject":{"harness":"claude","credential_route":"profile",
      "plan_label":"max","subject_id":"\(subjectID)"},"constraints":[],"source":"test",
      "observed_at":"\(observedAt)","freshness":"fresh"}],"absences":[],
      "refreshed_at":"\(observedAt)"}
    """.utf8)
}

private func appAccountsSnapshot(
    profileID: String,
    displayName: String,
    observedAt: String,
    profileEnabled: Bool = true,
    quotaEventCursor: String = "quota-snapshot-cursor"
) -> Data {
    // Unified account model: the engine emits `harnessAccounts: []` for wire
    // compat and carries the routing verdict in `accountPools`.
    Data("""
    {"profiles":[{"profile":{"profile_id":"\(profileID)","harness_id":"claude",
      "display_name":"\(displayName)","credential_kind":"config_dir_login",
      "isolation_locator":null,"enabled":\(profileEnabled)},"status":{"availability":"available",
      "verification":"passed","detail":null,"last_verified_at":null},
      "identity":{"email":"\(profileID)@example.test","plan":"max"}}],
      "harnessAccounts":[],
      "accountPools":[{"harness_id":"claude",
      "next_up":{"kind":"profile","profileId":"\(profileID)"}}],
      "harnesses":[{"id":"claude","status":"ok","manifest":null,
      "routableIntents":["implement"],"authSources":[{"source":"native_session",
      "availability":"available","verification":"passed"}]}],
      "git":{"status":"available","version":"git version test","detail":null,"remediation":null},
      "quotaEventCursor":"\(quotaEventCursor)",
      "quota":\(String(decoding: appQuotaResponse(
          subjectID: profileID, observedAt: observedAt), as: UTF8.self))}
    """.utf8)
}

@MainActor
private func seedAppAccounts(
    _ model: AppModel,
    profileID: String,
    observedAt: String
) throws {
    let snapshot = try JSONDecoder().decode(
        CredentialProfilesResponse.self,
        from: appAccountsSnapshot(
            profileID: profileID,
            displayName: profileID.capitalized,
            observedAt: observedAt,
            quotaEventCursor: "seed-cursor"))
    model.credentialProfiles = snapshot.profiles
    model.accountPools = snapshot.accountPools
    model.quotaResponse = snapshot.quota
    model.accountsNextUpAuthorityFresh[.local] = true
    model.accountsQuotaEventCursors[.local] = "seed-cursor"
}

private let appSettingsSnapshotData = Data(#"{"sources":[],"routing":{"goal":"economy","paidFallback":"never","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":900000}"#.utf8)

private func appHarnessSnapshot(
    version: String,
    status: String,
    gitVersion: String? = nil
) -> Data {
    let git = gitVersion.map {
        #", "git":{"status":"available","version":"\#($0)","detail":null,"remediation":null}"#
    } ?? ""
    return Data(
        #"{"harnesses":[{"id":"claude","status":"\#(status)","manifest":{"version":"\#(version)"}}]\#(git)}"#.utf8)
}

private func appTestGateway(port: Int) -> GatewayClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [AppRequestStubURLProtocol.self]
    return GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: "test",
        session: URLSession(configuration: config))
}

@MainActor
private func appTestEventually(
    timeout: Duration = .seconds(1),
    _ predicate: @escaping @MainActor () -> Bool
) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while !predicate(), ContinuousClock.now <= deadline { await Task.yield() }
    return predicate()
}

@MainActor
private func waitForAppTest(
    _ counter: AppRefreshCallCounter,
    message: String
) async throws {
    try await waitForAppTest({ counter.count > 0 }, message: message)
}

@MainActor
private func waitForAppTest(
    _ predicate: @escaping @MainActor () -> Bool,
    message: String
) async throws {
    // Parallel UI suites can hold the main actor for seconds (#527); this only bounds a failing test.
    try #require(
        await appTestEventually(timeout: .seconds(60), predicate),
        Comment(rawValue: message))
}

/// Thread-safe request counter (the URLProtocol handler runs off the main actor).
private final class AppRefreshCallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.lock(); value += 1; lock.unlock() }
    func incrementAndGet() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
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

private func appResponse(for request: URLRequest, status: Int = 200) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
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

    // Each request is handled on its own global-queue thread so a handler
    // that intentionally BLOCKS (the response-reorder race tests) cannot
    // stall the loading queue and serialize sibling requests.
    override func startLoading() {
        DispatchQueue.global().async { [self] in
            do {
                guard let handler = Self.handler else { throw AppRefreshTestError.badRequest }
                var fixtureRequest = request
                let history = request.url?.path.hasSuffix("/history") == true
                if history { fixtureRequest.url = request.url?.deletingLastPathComponent() }
                let (response, raw) = try handler(fixtureRequest)
                let data = history ? try LegacyHistoryFixture.response(raw) : raw
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
