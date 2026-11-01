import SwiftUI
import AppKit
import Observation
import ClaudexorKit

// MARK: - Navigation

enum SidebarRoute: Hashable {
    case threads
    case task(String)
}

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var glyph: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max"
        case .dark: return "moon.stars"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

// MARK: - App model

@MainActor
@Observable
final class AppModel {
    var health: Health = .connecting
    var endpoint: String = ""
    /// The serving engine's disclosed build identity (QA-002 / D20), retained
    /// from the connect handshake so Settings → About shows the real engine
    /// version + git sha. Nil until a handshake stamps it (or when the daemon
    /// omits the field — then About shows "unknown", never a guess). Cleared on
    /// hard-offline so a stale identity never outlives its connection.
    var engineIdentity: EngineBuildIdentity?
    var route: SidebarRoute = .threads {
        // Leaving a run's inspector is the P3 eviction point: an off-screen
        // terminal run releases its heavy feed/transcript arrays (reopen reloads).
        didSet { if oldValue != route { evictBackgroundRunData() } }
    }
    /// THE inspector visibility (W4.6 sol #17): explicit open/close, no auto-open.
    var inspectorPresented = false
    /// Native full-screen (item 7) — drives the opaque backdrop (BackdropPresentation).
    var isFullScreen = false

    /// Open a run in the inspector — the ONE owner of the reveal semantics
    /// (a direct assignment re-presents on same-route clicks; no counter).
    func openRun(_ id: String) {
        route = .task(id)
        inspectorPresented = true
    }
    /// Where this session's state persists (AppPersistence.swift), fixed
    /// before launch restore so the writers below save what it restores.
    let persistence: AppPersistence
    var appearance: AppearanceMode = .dark {
        didSet { persistence.preferences?.save(appearance.rawValue, "claudexor.appearance") }
    }
    /// The shared AuthSheet's target (harness default login, or a profile login).
    var authSheetTarget: AuthSheetTarget?
    var projectRoot: String = "" {
        didSet { persistence.preferences?.save(projectRoot, "claudexor.projectRoot") }
    }
    var recentProjects: [String] = [] {
        didSet { persistence.preferences?.save(recentProjects, "claudexor.recentProjects") }
    }
    /// A draft and every materialized thread have one immutable execution
    /// location. Local daemon ids are never assumed globally unique: the UI
    /// routes them together with this location id.
    var selectedExecutionLocation: ExecutionLocationID = .local
    var draftExecutionLocation: ExecutionLocationID = .local
    var draftRemoteProjectRoot: String?
    var remoteConnections: [RemoteConnection] = []
    /// Typed ~/.ssh/config scan outcome (never a silent empty array — the
    /// Connections copy distinguishes missing/empty/all-added/failed).
    var sshHostScan: SSHHostScanState = .configMissing
    var remoteThreadCache: [RemoteThreadCacheEntry] = []
    var remoteConnectionMessages: [UUID: String] = [:]
    var remoteDirectoryBrowser: RemoteDirectoryBrowserRequest?
    var remoteTerminalSheet: RemoteTerminalSheetRequest?
    /// Terminal work launched from Settings stays owned by that window. Using
    /// the main-window sheet here steals focus and makes Settings appear to
    /// close as soon as an installer starts.
    var settingsRemoteTerminalSheet: RemoteTerminalSheetRequest?
    /// Pending install confirmation: the disclosure text comes from the remote
    /// runtime's own `harness install --dry-run --json` answer, never from a
    /// string table in the app — what the user approves is what will run.
    var remoteHarnessInstallPrompt: RemoteHarnessInstallPrompt?
    var remoteDeviceLogin: RemoteDeviceLoginRequest?
    var remotePreview: RemotePreviewRequest?

    var liveTasks: [TaskRun] = []
    var remoteTasks: [ExecutionLocationID: [TaskRun]] = [:]
    /// Located run ids the user has successfully cancelled. Daemon ids are not
    /// globally unique, so cancellation memory must never leak between local and
    /// remote engines (or between two cloned remote homes).
    var cancelledRunIds: Set<String> = []
    /// A turn POST is in flight (composerSend: from the click until the thread detail
    /// reflects the accepted turn). The head-turn busy-gate is detail-derived and
    /// can't see this window, so without it the composer would still show Send and a
    /// user could DOUBLE-SUBMIT (or, on a draft, create two threads). Folded into
    /// `selectedThreadBusy`/`selectedThreadStarting` and re-entry-guarded in
    /// composerSend so no turn-start path can bypass it.
    var turnSubmitting = false
    // Threads (chat/session-first): the conversation list + selected detail.
    var threads: [ThreadSummary] = []
    var selectedThreadId: String?
    var selectedThreadDetail: ThreadDetailResponse? // workspace-only, on demand
    var selectedHistory: ThreadHistoryStore?
    var workspaceHistoryVisible = false
    var workspaceHistoryError: String?
    @ObservationIgnored let workspaceHistoryLoader = WorkspaceHistoryLoader()
    var threadStatus: String?
    /// What a failed Delete Now said, and what each engine's last thread list
    /// could not show; later lists retire the banner (AppModel+ThreadTrash.swift).
    @ObservationIgnored var deleteNowBanner: DeleteNowBanner?
    @ObservationIgnored var threadListGaps: [ExecutionLocationID: ThreadListGaps] = [:]
    /// Projects the daemon skipped listing because their root is gone (QA-064):
    /// the sidebar surfaces a relink hint instead of silently hiding those
    /// threads. Server-owned — refreshed on every list, cleared when it resolves.
    var projectListingProblems: [ProjectListingProblem] = []
    /// The registered-project registry (QA-072): loaded so the composer can
    /// disclose a nesting overlap ("Nested inside …" / "Contains …") for the
    /// chosen project. Server-owned; the path MRU still drives selection.
    var registeredProjects: [RegisteredProject] = []
    /// DRAFT-thread routing (before the first message materializes a thread): the
    /// composer edits these; once a thread exists, primary/pool are sticky on the
    /// thread (PATCHed via setPrimaryHarness/setEligiblePool). nil/[] => inherit
    /// the global default from Settings.
    var draftPrimaryHarness: String?
    var draftEligiblePool: [String] = []
    /// Sticky credential profile selected from the ONE AccountsSurface before
    /// a draft materializes; real threads persist the same field server-side.
    var draftCredentialProfileId: String?
    /// DRAFT-thread sticky write scope (D26): the wire `access` value the first
    /// turn's thread inherits. nil => the repo trust default. Once a thread
    /// exists this is sticky server-side (PATCHed via setThreadAccess).
    var draftThreadAccess: String?
    /// Registered credential profiles + doctor readiness (INV-135). Drives the
    /// bottom-left accounts popover (list + guided add + per-account login).
    var credentialProfiles: [CredentialProfileEntry] = []
    var remoteCredentialProfiles: [ExecutionLocationID: [CredentialProfileEntry]] = [:]
    /// Server-computed `next_up` pool authority (INV-135). Account facts live
    /// on the profile rows; surfaces must never reconstruct this routing pool.
    var accountPools: [HarnessAccountPool] = []
    var remoteAccountPools: [ExecutionLocationID: [HarnessAccountPool]] = [:]
    /// Cached registry hydration is independent of an explicit atomic refresh:
    /// opening Accounts, connect, and mutations use the lighter endpoint and do
    /// not put the whole surface into a foreground Refreshing state.
    var accountsRegistryLoadStates: [ExecutionLocationID: ProjectionLoadState] = [:]
    @ObservationIgnored var accountsRegistryGenerations: [ExecutionLocationID: UInt64] = [:]
    @ObservationIgnored var accountsRegistryLoadTasks:
        [ExecutionLocationID: Task<String?, Never>] = [:]
    @ObservationIgnored var accountsRegistryLoadTokens: [ExecutionLocationID: UUID] = [:]
    /// A successful routing mutation fences any already-started registry GET
    /// and asks its per-location lane for one post-mutation trailing pass.
    @ObservationIgnored var accountsRegistryTrailingHydrations: Set<ExecutionLocationID> = []
    /// Monotonic per-location fence for overlapping complete Accounts loads.
    /// Internal request ordering is not UI state and stays off the observation graph.
    @ObservationIgnored var accountsRefreshGenerations: [ExecutionLocationID: UInt64] = [:]
    @ObservationIgnored var accountsRefreshTasks:
        [ExecutionLocationID: Task<AccountsRefreshReceipt, Never>] = [:]
    @ObservationIgnored var accountsRefreshTaskTokens: [ExecutionLocationID: UUID] = [:]
    /// Foreground Accounts truth shared by list, quota, and Harness Doctor.
    /// Tokens keep a slower predecessor from settling a newer visible refresh.
    var accountsLoadStates: [ExecutionLocationID: ProjectionLoadState] = [:]
    @ObservationIgnored var accountsLoadTokens: [ExecutionLocationID: UUID] = [:]
    /// Dedicated quota observers use the global journal transport but own an
    /// independent cursor. The general global stream must never consume an
    /// Accounts snapshot cursor because that could skip unrelated run/thread events.
    @ObservationIgnored var accountsQuotaStreamTasks:
        [ExecutionLocationID: Task<Void, Never>] = [:]
    @ObservationIgnored var accountsQuotaStreamTokens: [ExecutionLocationID: UUID] = [:]
    @ObservationIgnored var accountsQuotaEventCursors: [ExecutionLocationID: String] = [:]
    /// A failed explicit readiness refresh retires only the authority of the old
    /// readiness verdicts. Stable profile rows, identities, and Enabled values
    /// stay present; a later cached registry hydration can restore its own TTL-
    /// backed readiness authority.
    var accountsReadinessAuthorityFresh: [ExecutionLocationID: Bool] = [:]
    /// Presentation freshness for the server-computed `next_up` field only.
    /// Profiles, readiness, Enabled, and identity remain independently valid.
    var accountsNextUpAuthorityFresh: [ExecutionLocationID: Bool] = [:]
    /// M7 update-chip: latest availability (nil = nothing to advertise), read
    /// cheaply by refreshUpdateAvailability(); populated by checkForRuntimeUpdate().
    /// `updateProvider` (injectable for tests/dogfood) defaults to the real
    /// manifest-backed `runtimeUpdateProvider` cache each check writes.
    var updateAvailability: UpdateAvailability?
    var updateProvider: UpdateAvailabilityProviding = FileUpdateAvailabilityProvider()
    let runtimeUpdateProvider = RuntimeUpdateProvider()
    /// M7 last check result (verbatim in Check-for-Updates) + in-flight flag.
    var runtimeUpdateStatus: String?
    var runtimeUpdateChecking = false
    /// D-2 auto-INSTALL state: in-flight flag + honest per-phase status text
    /// (driven by RuntimeInstallPhase) so the update chip shows real progress and
    /// failure, never a fake "done".
    var runtimeInstalling = false
    var runtimeInstallStatus: String?
    /// Injectable daemon-control factory so tests drive the install coordinator
    /// with a stub; production builds the real port over the bundled Node +
    /// GatewayClient.
    @ObservationIgnored var makeDaemonControl: @Sendable () -> RuntimeDaemonControl = {
        AppRuntimeDaemonControl(
            isBusyProbe: {
                // Fail-closed (audit 5): count ALL active runs via state-filtered
                // queries (not just the newest 200-row page) AND any active
                // setup/login job. Any transport error → nil → treated as busy.
                guard let client = try? ControlApiDiscovery.load().makeClient() else { return nil }
                do { return try await client.engineHasActiveWork() } catch { return nil }
            },
            handshakeProbe: {
                guard let client = try? ControlApiDiscovery.load().makeClient() else { return nil }
                return await AppRuntimeDaemonControl.servingHandshake(using: client)
            })
    }
    @ObservationIgnored let localRuntimeLifecycleOwner: LocalRuntimeLifecycleOwner
    var localDaemonBuildSwitch: LocalDaemonBuildSwitch?
    /// Only the pending explicit switch owns this progress publication.
    @ObservationIgnored var localDaemonBuildSwitchProgress: (generation: Int, notice: String)?
    /// One lifecycle owner for the entire AppModel session. It is created lazily
    /// so tests can replace `makeDaemonControl` before the first reconciliation;
    /// the actor itself coalesces overlapping connect/poll attempts.
    @ObservationIgnored var localDaemonReconciler: LocalDaemonReconciler?
    /// Visible exact-closure coherence notice. This is separate from update
    /// discovery/install text so either owner can settle without erasing the
    /// other's state.
    var localDaemonReconciliationNotice: String?
    /// The update CHECKER (actor, off the observable graph) + an injectable
    /// transport factory so tests drive a stub without the network. One auto
    /// foreground check per session; the menu command forces a re-check. The chip
    /// offers a one-click in-place Install (D-2) that verifies the signed
    /// manifest, then runs the RuntimeInstallCoordinator sequence.
    @ObservationIgnored var runtimeUpdater: RuntimeUpdater?
    @ObservationIgnored var makeRuntimeTransport: @Sendable () -> RuntimeReleaseTransport = { GitHubRuntimeReleaseTransport() }
    @ObservationIgnored var didAutoCheckRuntime = false
    @ObservationIgnored var appVersionOverrideForUpdates: String? // test seam — doc at updateFlowAppVersion
    /// Optimistic auto-balance pick (tri-state since A6) while the settings
    /// save round-trips (owner dogfood: the control must flip INSTANTLY).
    /// Cleared when the save settles; a failed save snaps back.
    var autoBalanceOverride: AccountsAutoBalance.Choice?
    /// DRAFT-thread workspace mode: false => in_place (default; turns mutate the live
    /// tree), true => isolated (turns accumulate in a thread worktree, applied later via
    /// "Apply thread"). Fixed at thread creation, so it's only editable in the draft.
    var draftIsolatedWorkspace = false
    var liveHarnesses: [HarnessInfo] = []
    var remoteHarnesses: [ExecutionLocationID: [HarnessInfo]] = [:]
    /// Client freshness of the last server-authored doctor rows. This never
    /// rewrites their health/status; failed explicit refreshes only expire use.
    var harnessReadinessFresh: Bool?
    var remoteHarnessReadinessFresh: [ExecutionLocationID: Bool] = [:]
    /// Location-wide Git probe from /harnesses. It can trigger a root-scoped
    /// applicability refresh, but never decides a strategy itself.
    var gitCapability: WorkspaceGitCapability?
    var remoteGitCapabilities: [ExecutionLocationID: WorkspaceGitCapability] = [:]
    /// Root-scoped, Git-only run applicability. One projection per execution
    /// location; each value is tagged with its exact request root.
    var runApplicabilityProjections: [ExecutionLocationID: RunApplicabilityProjection] = [:]
    var runApplicabilityGenerations: [ExecutionLocationID: Int] = [:]
    var remoteSettingsSnapshots: [ExecutionLocationID: SettingsSnapshot] = [:]
    var remoteProjects: [ExecutionLocationID: [RegisteredProject]] = [:]
    var exactAuthSources: [HarnessFamily: [AuthSourceKind: HarnessAuthSource]] = [:]
    var remoteExactAuthSources:
        [ExecutionLocationID: [HarnessFamily: [AuthSourceKind: HarnessAuthSource]]] = [:]
    var settingsSnapshot: SettingsSnapshot?
    var settingsLoadStates: [ExecutionLocationID: ProjectionLoadState] = [:]
    @ObservationIgnored var settingsLoadTokens: [ExecutionLocationID: UUID] = [:]
    var quotaResponse: ControlQuotaResponse?
    var remoteQuotaResponses: [ExecutionLocationID: ControlQuotaResponse] = [:]
    /// Display freshness is intentionally separate from routing authority.
    /// Stale values may remain visible, but can never make `next_up` current.
    var accountsQuotaDisplayStates: [ExecutionLocationID: AccountsQuotaDisplayState] = [:]
    let accountResourceActions: AccountsResourceActions
    let accountsRoutingEvidence = AccountsRoutingEvidenceState()
    @ObservationIgnored var accountsQuotaDisplayGenerations: [ExecutionLocationID: UInt64] = [:]
    /// Per account, the binding changes (key or presence) seen: committed snapshots and acknowledged own writes.
    @ObservationIgnored var accountResourceBindingChanges: [ExecutionLocationID: [AccountTarget: UInt64]] = [:]
    @ObservationIgnored var accountsQuotaSubscribers:
        [ExecutionLocationID: Set<UUID>] = [:]
    @ObservationIgnored var accountsQuotaDisplayTasks:
        [ExecutionLocationID: Task<Void, Never>] = [:]
    @ObservationIgnored var accountsQuotaDisplayTaskTokens: [ExecutionLocationID: UUID] = [:]
    @ObservationIgnored var accountsQuotaDisplayTrailing: Set<ExecutionLocationID> = []
    /// Bounded recent-marker ring deduplicates the same event observed by both
    /// global streams even when one stream is briefly ahead of the other.
    @ObservationIgnored var accountsQuotaDisplayMarkerCursors:
        [ExecutionLocationID: [String]] = [:]
    var quotaStatus: String?
    var secretBackend = "unknown"
    var storedSecrets: [SecretInfo] = []
    var remoteSecretBackends: [ExecutionLocationID: String] = [:]
    var remoteStoredSecrets: [ExecutionLocationID: [SecretInfo]] = [:]
    var settingsStatus: String?
    /// Per-repo user-level trust files (Settings trust section).
    var trustEntries: [TrustEntry] = []
    var remoteTrustEntries: [ExecutionLocationID: [TrustEntry]] = [:]
    var trustStatus: String?
    var projects: [Project] { liveProjects }

    /// Live runs grouped into a light project tree for the sidebar.
    private var liveProjects: [Project] {
        let groups = Dictionary(grouping: liveTasks, by: { $0.project })
        return groups.keys.sorted().map { name in
            let ids = (groups[name] ?? []).map(\.id)
            return Project(id: name, name: name,
                           specs: [Spec(id: "\(name)-runs", title: "Runs", frozen: false, version: 0, runIds: ids)])
        }
    }

    var client: GatewayClient?
    @ObservationIgnored let sshConnectionManager: SSHConnectionManager
    @ObservationIgnored let remoteRuntimeInstaller: RemoteRuntimeInstaller
    /// Tokens only live inside these in-memory clients. Persistence stores
    /// connection labels and thread summaries, never credentials or endpoints.
    @ObservationIgnored var remoteClients: [ExecutionLocationID: GatewayClient] = [:]
    @ObservationIgnored var remoteControlForwards: [UUID: RemoteControlForwardLease] = [:]
    @ObservationIgnored var remotePreviewForwards: [UUID: RemotePreviewForwardLease] = [:]
    @ObservationIgnored var remoteActionLeases: [RemoteActionOwnerKey: RemoteActionLease] = [:]
    /// In-flight setup job cleanup ownership. This exists only across the
    /// create/adopt await window; visible sheets own their exact job afterward.
    @ObservationIgnored var remoteSetupJobOwnership: RemoteSetupJobOwnership?
    @ObservationIgnored var remoteTerminalPresentationLease: RemoteTerminalPresentationLease?
    @ObservationIgnored var remoteGlobalStreamTasks: [ExecutionLocationID: Task<Void, Never>] = [:]
    @ObservationIgnored var remoteGlobalStreamTokens: [ExecutionLocationID: UUID] = [:]
    @ObservationIgnored var remoteGlobalEventCursors: [ExecutionLocationID: String] = [:]
    @ObservationIgnored var remoteRunStreamTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var remoteRunStreamTokens: [String: UUID] = [:]
    @ObservationIgnored var remoteRunDetailLoadTokens: [RunDetailLoadKey: UUID] = [:]
    @ObservationIgnored var remoteConnectTasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored var remoteConnectionGenerations: [UUID: Int] = [:]
    @ObservationIgnored var pendingRemoteThreadSelection:
        (locationID: ExecutionLocationID, threadID: String)?
    var connectionGeneration = 0
    var threadLoadGeneration = 0
    var streamTasks: [String: Task<Void, Never>] = [:]
    var globalStreamTask: Task<Void, Never>?
    var globalEventCursor: String?
    var lastEventIds: [String: Int] = [:]
    /// Highest sequence reflected by snapshots (distinct from the stream cursor).
    var snapshotReplayFences: [String: Int] = [:]
    var snapshotLoadDepth: [String: Int] = [:]
    @ObservationIgnored var runDetailLoads: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var runDetailLoadTokens: [String: UUID] = [:]
    @ObservationIgnored var runDetailTrailing: Set<String> = []
    @ObservationIgnored var runDetailAcceptingTrailing: Set<String> = []
    /// Run details already hydrated for view presentation. `ensureRunDetail`
    /// uses this to avoid turning overlapping view tasks into serial duplicate
    /// GETs; event milestones continue to call `loadRunDetail` directly.
    @ObservationIgnored var hydratedRunDetails: Set<String> = []
    /// Stream envelopes deferred while a snapshot load is in flight. Hard-capped
    /// (W23): runs whose buffer overflowed are flagged here and get a FRESH
    /// snapshot instead of a replay — dropped envelopes are never reconstructed.
    var deferredEnvelopes: [String: [BusEnvelope]] = [:]
    var deferredOverflow: Set<String> = []
    /// SSE coalescing: events buffer here and flush in adaptive batches, so a burst
    /// of harness events (10+/sec) causes ONE SwiftUI re-render per batch instead of
    /// one per event. `@ObservationIgnored` so buffering never itself triggers a render.
    @ObservationIgnored var eventBuffers: [String: [BusEnvelope]] = [:]
    @ObservationIgnored var flushTasks: [String: Task<Void, Never>] = [:]
    /// Rolling per-run event rate estimate driving the ADAPTIVE flush window
    /// (64ms when calm, up to ~250ms under sustained bursts).
    @ObservationIgnored var flushRates: [String: (window: TimeInterval, lastAt: Date)] = [:]
    /// Highest `thread.head.updated` revision REFLECTED per thread (W12+W16
    /// sidebar-staleness ping). Dedupes duplicate/replayed pings within one
    /// connected stream; cleared with the rest of the stream state.
    @ObservationIgnored var threadHeadRevisions: [String: Int] = [:]
    /// Single-flight coalescer for ping-driven thread-list refetches: the
    /// global stream replays the whole journal on a fresh connect, so a burst
    /// of pings must fold into ONE listThreads call.
    @ObservationIgnored var threadsRefreshTask: Task<Void, Never>?
    @ObservationIgnored var threadsRefresh = ThreadsRefreshState()  // dirty-until-success + backoff (AppModel+Streams)
    /// Runs-list single-flight (QA-052): the one in-flight `refreshRuns` pass;
    /// `runsRefreshPending` folds any trigger that lands mid-refresh into ONE
    /// trailing pass. Cleared/cancelled on reconnect so a stale pass never paints.
    @ObservationIgnored var runsRefreshTask: Task<Void, Never>?
    @ObservationIgnored var runsRefreshPending = false
    @ObservationIgnored var successfulRunsRefreshes = 0
    /// Entering a draft clears thread identity before the next selection. Keep
    /// one bit so that next open still reconciles detail-restored off-page rows.
    @ObservationIgnored var runListReconciliationNeeded = false
    /// TERMINAL chat transcripts per run (live transcripts stream in the run's
    /// RunLiveBox; foldLiveBox moves the final reducer here at terminal).
    var transcripts: [String: TranscriptReducer] = [:]
    /// A REMOTE run's engine receipts (`workspace.prepared`, #563), keyed by
    /// location and run id so identical daemon run ids never mix. Remote runs
    /// fold no executor transcript; only these receipts reach their turn card.
    var remoteTranscripts: [RunDetailLoadKey: TranscriptReducer] = [:]
    /// Per-run live streaming boxes (P1 granularity): the dictionary property
    /// only changes on attach/fold (rare); hot per-event writes mutate the
    /// box CLASS internals and invalidate only that box's readers.
    var liveBoxes: [String: RunLiveBox] = [:]
    /// Engine timestamps come from `Date().toISOString()` WITH milliseconds; a
    /// plain ISO8601DateFormatter parses none of them. Try fractional first.
    private static let eventDateFormatterFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let eventDateFormatter = ISO8601DateFormatter()

    static func parseEventDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        return eventDateFormatterFractional.date(from: raw) ?? eventDateFormatter.date(from: raw)
    }

    /// Reconnect seam (X30 test fence): adopt a client exactly as tryConnect
    /// does after discovery, without the discovery I/O.
    func adoptClientForReconnect(_ newClient: GatewayClient) {
        if client !== newClient {
            retireRunApplicability(at: .local)
            retireHarnessProjection(at: .local)
        }
        client = newClient
    }

    init(client: GatewayClient? = nil, requestNotificationAuthorization: Bool = true, loadPersistedState: Bool = true,
         persistence: AppPersistence = .memoryOnly,
         lifecycleOwner: LocalRuntimeLifecycleOwner = LocalRuntimeLifecycleOwner()) {
        self.localRuntimeLifecycleOwner = lifecycleOwner
        self.persistence = persistence
        self.accountResourceActions = AccountsResourceActions(preferences: persistence.accountResetRecovery)
        let sshManager = SSHConnectionManager()
        self.sshConnectionManager = sshManager
        self.remoteRuntimeInstaller = RemoteRuntimeInstaller(ssh: sshManager)
        self.client = client
        // Bind the update chip to the real, manifest-backed provider by default.
        // Tests/dogfood can still swap in the file-override provider.
        updateProvider = runtimeUpdateProvider
        // Without this first-run authorization request, run-completion
        // notifications are silently dropped in the bundled .app forever.
        if requestNotificationAuthorization { Notifier.requestAuthIfPossible() }
        if loadPersistedState { restore() }
    }

    /// Launch restore. It assigns through the `didSet` writers, as the app
    /// always has: the restored appearance, project and recents are saved
    /// again, and an applied `CLAUDEXOR_DEBUG_APPEARANCE` or
    /// `CLAUDEXOR_PROJECT_ROOT` value becomes the saved one.
    private func restore() {
        if let raw = persistence.preferences?.load("claudexor.appearance") as? String,
           let saved = AppearanceMode(rawValue: raw) {
            appearance = saved
        }
        switch persistence.environment["CLAUDEXOR_DEBUG_APPEARANCE"] {
        case "light": appearance = .light
        case "dark": appearance = .dark
        default: break
        }
        projectRoot = persistence.preferences?.load("claudexor.projectRoot") as? String
            ?? persistence.environment["CLAUDEXOR_PROJECT_ROOT"] ?? ""
        recentProjects = persistence.preferences?.load("claudexor.recentProjects") as? [String] ?? []
        remoteConnections = ((try? persistence.remoteConnections?().load()) ?? [])
            .map { stored in
                var value = stored
                value.status = .offline
                return value
            }
        remoteThreadCache = (try? persistence.remoteThreadCache?().load()) ?? []
        if persistence.scansSSHConfig { sshHostScan = SSHHostScanState.scan() }
    }

    /// Single-flight + coalescing runs-list refresh (QA-052), mirroring the
    /// threads refresh: `GET /v2/runs` serves a bounded newest-first page
    /// (default limit + hard cap, run-list.ts), yet overlapping lifecycle/event
    /// triggers must still SHARE one in-flight request rather than fan out N
    /// parallel refetches. A trigger that lands while a refresh runs folds into
    /// exactly ONE trailing pass (so the settled list still reflects it). A caller
    /// that STARTS a fresh refresh awaits its full lead(+trailing) result; a caller
    /// that FOLDS into the in-flight lead awaits only that lead — its own trigger is
    /// what arms the trailing pass, which the folded caller does not itself await
    /// (the bounded design is correct per ledger X96).
    func refreshRuns() async {
        if let inFlight = runsRefreshTask {
            runsRefreshPending = true      // fold this trigger into the single trailing pass
            await inFlight.value
            return
        }
        // Lead pass + AT MOST ONE trailing pass (bounded, never re-arming): a trigger
        // landing during the trailing pass folds into the NEXT refreshRuns call, so it
        // can't spin. The `=== task` identity guard mirrors the reconnect fence (QA-052).
        for pass in 0...1 {
            if pass == 1, !runsRefreshPending { break }
            runsRefreshPending = false
            let task = Task { @MainActor [weak self] in _ = await self?.performRunsRefresh() }
            runsRefreshTask = task
            await task.value
            if runsRefreshTask == task { runsRefreshTask = nil }
        }
    }

    private func performRunsRefresh() async {
        // Capture the connection identity BEFORE the request: a reconnect fence
        // (enterHardOffline / connect) can nil-or-replace the client and bump the
        // generation while listRuns() is in flight (round-3 crit #5).
        guard let requestClient = client else { return }
        let requestGeneration = connectionGeneration
        do {
            let summaries = try await requestClient.listRuns()
            // A response that raced a reconnect must NEVER assign liveTasks from the
            // OLD client — that clobbers the fresh (or wiped) snapshot. Re-check the
            // generation, the exact client identity, and cancellation before any
            // mutation (round-3 crit #5).
            guard !Task.isCancelled, connectionGeneration == requestGeneration,
                  client === requestClient else { return }
            // Merge instead of replace: a refresh must not wipe locally-hydrated
            // detail — including the Run-Detail-only satellites (crit #1). The merge
            // owner lives in AppModel+RunMerge.swift.
            let existingTasks = liveTasks
            let existingById = Dictionary(uniqueKeysWithValues: existingTasks.map { ($0.id, $0) })
            let refreshed = summaries.map { summary in
                Self.mergeRefreshedTask(
                    summary: summary,
                    existing: existingById[summary.runId] ?? summary.jobId.flatMap { existingById[$0] })
            }
            let threadParents = Set(selectedHistory?.rows.compactMap(\.runId) ?? [])
            liveTasks = Self.preservingSelectedThreadFamily(
                refreshed: refreshed,
                existing: existingTasks,
                parentRunIds: threadParents)
            // A 202-queued row was keyed by jobId; once the daemon surfaces the
            // runId the open detail route must follow instead of dangling.
            if case .task(let openId) = route, !liveTasks.contains(where: { $0.id == openId }) {
                if let mapped = summaries.first(where: { $0.jobId == openId }) {
                    route = .task(mapped.runId)
                }
            }
            // Live progress for EVERY active run — including CLI-started runs and
            // runs that were already active when the app (re)connected.
            for task in liveTasks where task.isLive && task.phase.isActive {
                stream(runId: task.id)
            }
            successfulRunsRefreshes += 1
        } catch {
            // keep last-known live tasks; connection badge reflects reality elsewhere
        }
    }

    @discardableResult
    func harnessModels(for family: HarnessFamily, route: String? = nil) async -> HarnessModelsResponse? {
        let locationID = activeExecutionLocation
        guard let requestClient = gateway(for: locationID) else { return nil }
        // A nil return is a MEANINGFUL failure signal (QA-055b): the composer's
        // per-harness model row turns it into an honest "Couldn't load · Retry"
        // instead of hanging forever on "Loading models…". The explicit catch
        // (not a swallowing `try?`) makes that failure path deliberate — the
        // caller surfaces the retry state.
        do {
            return try await requestClient.harnessModels(
                harnessId: family.rawValue, route: route)
        } catch {
            return nil
        }
    }

    /// Tail of the serialized settings-operation chain + its offline epoch
    /// (consumed by AppModel+Settings.swift; stored properties cannot live in
    /// extensions). enterHardOffline bumps the epoch so already-queued ops
    /// retire instead of firing against a reconnected client (X20).
    var settingsChain: Task<Void, Never>?
    /// One latest-wins harness projection lane per local/remote daemon.
    @ObservationIgnored var harnessProjectionLanes:
        [ExecutionLocationID: HarnessProjectionLane] = [:]
    var settingsEpoch = 0

    var normalizedProjectRoot: String {
        if draftExecutionLocation != .local {
            return draftRemoteProjectRoot?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        return projectRoot.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var hasCurrentProject: Bool { !normalizedProjectRoot.isEmpty }

    var currentProjectName: String {
        guard hasCurrentProject else { return "No project" }
        return URL(fileURLWithPath: normalizedProjectRoot).lastPathComponent
    }

    /// Set the working project and push it to the MRU (used everywhere a project is chosen).
    func selectProject(_ path: String) {
        let p = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return }
        draftExecutionLocation = .local
        draftRemoteProjectRoot = nil
        projectRoot = p
        rememberProject(p)
    }

    /// Composer project chip — pick a recent project. A thread's repo is bound, so
    /// choosing another project starts a NEW draft thread on it (issue #8: "New made
    /// a chat in the old project"). In the draft state it just sets the project.
    func pickProject(_ path: String) {
        if selectedThreadId != nil { startDraftThread() }
        selectProject(path)
    }

    /// Composer project chip — "Browse…". Same draft-switch semantics as `pickProject`,
    /// but only after a folder is actually chosen (cancel changes nothing).
    func browseProject() {
        guard let path = runProjectPanel() else { return }
        if selectedThreadId != nil { startDraftThread() }
        selectProject(path)
    }

    private func rememberProject(_ path: String) {
        var list = recentProjects.filter { $0 != path }
        list.insert(path, at: 0)
        recentProjects = Array(list.prefix(7))
    }

    /// Present the folder chooser; returns the chosen path (nil if cancelled).
    private func runProjectPanel() -> String? {
        let panel = NSOpenPanel()
        panel.title = "Choose Project"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose / Create"
        panel.resolvesAliases = true
        if hasCurrentProject, draftExecutionLocation == .local {
            panel.directoryURL = URL(fileURLWithPath: normalizedProjectRoot, isDirectory: true)
        }
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return url.path
    }

    /// Model-internal busy bracket for turn-start paths that live in other
    /// files (retryTurn in AppModelTrust.swift): `turnSubmitting` keeps its
    /// private(set) so views can never write it directly.
    func withTurnSubmission<T>(_ body: () async -> T) async -> T {
        turnSubmitting = true
        defer { turnSubmitting = false }
        return await body()
    }

    // MARK: Commands

    func startRun(prompt: String, mode: RunMode, harnesses: [HarnessFamily], primary: HarnessFamily?,
                  routingGoal: String, model: String?, n: Int, capUsd: Double?,
                  access: String = "workspace_write", web: String = "auto",
                  tests: [TestCommandInvocation] = [], review: Bool? = nil, reviewerPanel: [ReviewerPanelEntry]? = nil,
                  protectedPathApprovals: [ProtectedPathApproval]? = nil,
                  repoRootOverride: String? = nil) async {
        guard mode != .unknown else {
            settingsStatus = "This run used a legacy mode id the engine no longer accepts; relaunch it with a current intent."
            return
        }
        let launchRepoRoot = repoRootOverride?.trimmingCharacters(in: .whitespacesAndNewlines) ?? normalizedProjectRoot
        guard !mode.requiresProject || !launchRepoRoot.isEmpty else {
            settingsStatus = "Choose a Current Project before launching \(mode.label). Ask can run without a project."
            return
        }
        let launchProjectName = launchRepoRoot.isEmpty ? "No project" : URL(fileURLWithPath: launchRepoRoot).lastPathComponent
        let hasExplicitCap = capUsd != nil
        var optimistic = TaskRun(
            id: "pending-\(UUID().uuidString.prefix(6))",
            title: String(prompt.prefix(64)),
            prompt: prompt,
            mode: mode,
            phase: .queued,
            project: launchProjectName,
            harnesses: harnesses,
            n: n,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: capUsd ?? 0,
            spendKnown: false, capKnown: hasExplicitCap,
            routeProof: .unverified,
            attentionNote: nil,
            plan: [], activity: [ActivityEvent(.system, "Queued · \(mode.label)")],
            candidates: [], findings: [], diff: [],
            isLive: true
        )
        optimistic.repoRoot = launchRepoRoot.isEmpty ? nil : launchRepoRoot
        optimistic.tests = tests
        optimistic.reviewRequested = composerReviewWire(
            mode: mode, requestedReview: review, hasExplicitPanel: !(reviewerPanel ?? []).isEmpty,
            untilClean: mode.strategyFlags.untilClean)
        optimistic.reviewerPanel = reviewerPanel
        optimistic.protectedPathApprovals = protectedPathApprovals
        liveTasks.insert(optimistic, at: 0)
        route = .task(optimistic.id)

        guard let client else {
            if let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id }) {
                liveTasks[idx].phase = .failed
                liveTasks[idx].engineError = "Engine offline: reconnect the local engine before launching a run."
                liveTasks[idx].diagnosticText = liveTasks[idx].engineError
                liveTasks[idx].activity.append(ActivityEvent(.system, "Engine offline: reconnect the local engine before launching a run."))
            }
            return
        }
        do {
            let orderedHarnesses = harnesses.map(\.rawValue)
            let scope = launchRepoRoot.isEmpty
                ? RunScope.none
                : RunScope.project(root: launchRepoRoot)
            let flags = mode.strategyFlags
            let req = StartRunRequest(prompt: prompt, mode: mode.apiValue,
                                      scope: scope,
                                      execution: RunExecution(isolation: "envelope"),
                                      harnesses: orderedHarnesses,
                                      primaryHarness: primary?.rawValue,
                                      routingGoal: routingGoal,
                                      model: model?.isEmpty == false ? model : nil,
                                      review: optimistic.reviewRequested,
                                      reviewerPanel: reviewerPanel,
                                      n: mode == .bestOfN ? max(n, flags.defaultN ?? 2) : nil,
                                      paidBudget: capUsd.map { .finite(maxUsd: $0) }, access: access,
                                      web: web,
                                      tests: tests.isEmpty ? nil : tests,
                                      protectedPathApprovals: protectedPathApprovals,
                                      attempts: mode == .maxAttempts ? 3 : nil,
                                      untilClean: flags.untilClean ? true : nil,
                                      swarm: flags.swarm ? true : nil,
                                      create: flags.create ? true : nil)
            let result = try await client.startRun(req)
            switch result {
            case .started(let info):
                // Swap the optimistic row for one keyed by the real run id.
                // A refresh may have raced in during the await: drop
                // any server row already inserted under the real id (dedupe)
                // and INSERT when the optimistic row is gone (never lose the
                // started run from the list).
                liveTasks.removeAll { $0.id == info.runId }
                do {
                    let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id })
                    let prev = idx.map { liveTasks[$0] } ?? optimistic
                    var started = TaskRun(
                        id: info.runId, title: prev.title, prompt: prev.prompt, mode: prev.mode,
                        phase: .running, project: prev.project, harnesses: prev.harnesses,
                        n: prev.n, createdAt: prev.createdAt, updatedAt: .now,
                        spendUsd: prev.spendUsd, capUsd: prev.capUsd,
                        spendKnown: false, capKnown: prev.capKnown,
                        routeProof: .unverified, attentionNote: nil,
                        plan: [], activity: prev.activity, candidates: [], findings: [], diff: [],
                        isLive: true)
                    started.runDir = info.runDir
                    started.repoRoot = prev.repoRoot
                    started.tests = prev.tests
                    started.reviewRequested = prev.reviewRequested
                    started.reviewerPanel = prev.reviewerPanel
                    started.protectedPathApprovals = prev.protectedPathApprovals
                    if let idx { liveTasks[idx] = started } else { liveTasks.insert(started, at: 0) }
                    route = .task(info.runId)
                    stream(runId: info.runId)
                }
            case .queued(let info):
                liveTasks.removeAll { $0.id == info.jobId }
                do {
                    let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id })
                    let prev = idx.map { liveTasks[$0] } ?? optimistic
                    var row = TaskRun(
                        id: info.jobId, title: prev.title, prompt: prev.prompt, mode: prev.mode,
                        phase: .queued, project: prev.project, harnesses: prev.harnesses,
                        n: prev.n, createdAt: prev.createdAt, updatedAt: .now,
                        spendUsd: prev.spendUsd, capUsd: prev.capUsd,
                        spendKnown: false, capKnown: prev.capKnown,
                        routeProof: .unverified, attentionNote: nil,
                        plan: [], activity: prev.activity, candidates: [], findings: [], diff: [],
                        isLive: true)
                    row.activity.append(ActivityEvent(.system, "Queued in daemon · \(info.state)"))
                    if let error = info.error {
                        row.engineError = error
                        row.diagnosticText = error
                    }
                    row.repoRoot = prev.repoRoot
                    row.tests = prev.tests
                    row.reviewRequested = prev.reviewRequested
                    row.reviewerPanel = prev.reviewerPanel
                    row.protectedPathApprovals = prev.protectedPathApprovals
                    if let idx { liveTasks[idx] = row } else { liveTasks.insert(row, at: 0) }
                    route = .task(info.jobId)
                }
            }
        } catch {
            if let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id }) {
                liveTasks[idx].phase = .failed
                liveTasks[idx].engineError = "Failed to start: \(error)"
                liveTasks[idx].diagnosticText = liveTasks[idx].engineError
                liveTasks[idx].activity.append(ActivityEvent(.system, "Failed to start: \(error)"))
            }
        }
    }

    func cancel(_ id: String) async {
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else { return }
        do {
            try await requestClient.cancel(runId: id)
            // Record the cancel authoritatively. When the live row already exists we
            // flip it; but in the bound-but-NOT-yet-hydrated window there is no row to
            // flip, and the head turn's EMBEDDED card still reads "running" — so the
            // composer would stay stuck on Stop after a successful cancel. Remember the
            // cancelled located id so `composerTurnState` reports it inactive
            // immediately until the owning daemon's row hydrates.
            rememberRunCancelled(id, at: locationID)
            mutateTask(id, at: locationID) {
                $0.phase = .cancelled
                $0.updatedAt = .now
            }
            if locationID != .local, let threadId = selectedThreadId {
                await refreshRemoteThreads(locationID)
                await openThread(locationID: locationID, id: threadId)
            }
        } catch {
            // leave the row's status untouched if the server did not confirm the cancel
        }
    }

    // MARK: Threads (chat/session-first)

    /// The thread the conversation is currently showing (detail preferred — it is
    /// the freshest copy after a PATCH/turn — falling back to the list summary).
    var currentThread: ThreadSummary? {
        if let header = selectedHistory?.header { return header.thread.summary }
        if let d = selectedThreadDetail { return d.thread }
        if let id = selectedThreadId {
            if selectedExecutionLocation == .local {
                return threads.first { $0.id == id }
            }
            return remoteThreadCache.first {
                $0.locationID == selectedExecutionLocation && $0.thread.id == id
            }?.thread
        }
        return nil
    }

    /// The repo bound to a SPECIFIC thread (the freshest copy for the selected one,
    /// else the list summary). Used by thread-scoped spec actions so they resolve
    /// the owning thread's repo, not whatever is selected when the await resolves.
    func threadRepoRoot(_ tid: String) -> String? {
        if tid == selectedThreadId { return currentThread?.repoRoot }
        if selectedExecutionLocation == .local {
            return threads.first { $0.id == tid }?.repoRoot
        }
        return remoteThreadCache.first {
            $0.locationID == selectedExecutionLocation && $0.thread.id == tid
        }?.thread.repoRoot
    }

    /// Is a specific thread too busy to accept a new turn? A submit in flight blocks
    /// ALL threads (the engine processes one turn-start at a time). The SELECTED
    /// thread is judged by its rich `composerTurnState` (embedded + hydrated). A
    /// NON-selected target (Implement plan/spec on a card whose owning thread isn't
    /// current) is judged from its thread-summary head run via the global `liveTasks`
    /// list (refreshRuns loads all runs), honoring a pending cancel — so the client
    /// busy gate holds for those too, not only the per-thread server serialization.
    func isThreadBusy(_ id: String?, at locationID: ExecutionLocationID) -> Bool {
        if turnSubmitting { return true }
        guard let id else { return false }
        // Rich state ONLY when this thread's detail is actually loaded (the selected
        // thread, post-hydration). During openThread's load window the detail is the
        // previous thread's, so fall through to the summary head run below.
        if locationID == selectedExecutionLocation,
           id == selectedThreadId,
           selectedHistory?.header?.thread.id == id {
            return composerTurnState != .idle
        }
        // Non-selected target, OR the selected thread whose detail hasn't loaded yet:
        // judge from the thread summary's head run via the global liveTasks list
        // (refreshRuns loads all runs), honoring a pending cancel.
        //
        // If the head run row isn't hydrated yet we return false (idle) rather than
        // assuming busy: a thread's summary `state` is its LIFECYCLE state ("active"),
        // NOT head-run liveness, so it can't distinguish a running head from a
        // completed one — treating any headRunId as busy would falsely BLOCK turns on
        // a thread whose head run already finished. This transient, self-correcting
        // window (it resolves the instant the detail/live row hydrates) is backstopped
        // by the per-thread server turn serialization, which rejects a real overlap.
        guard let headRunId = threadSummary(id, at: locationID)?.headRunId else { return false }
        if wasRunCancelled(headRunId, at: locationID) { return false }
        return task(headRunId, at: locationID)?.phase.isActive ?? false
    }

    func isThreadBusy(_ id: String?) -> Bool {
        isThreadBusy(id, at: activeExecutionLocation)
    }

    /// True while the selected thread's head turn is live (a submit is in flight,
    /// the turn is running, OR the 202-bind window) — a new turn can't start over
    /// it. Folds the pre-detail `turnSubmitting` window into the detail-derived
    /// `composerTurnState`.
    var selectedThreadBusy: Bool { isThreadBusy(selectedThreadId) }

    /// True while there is NO cancel target yet: a submit is in flight (pre-detail)
    /// OR the turn is accepted but its runId hasn't bound (202 window). The composer
    /// shows a disabled "Starting…". Once a runId binds, `.busy` (Stop) wins — even
    /// while the submit task is still wrapping up, and even if the live row has not
    /// hydrated (the runId is the cancel target).
    var selectedThreadStarting: Bool {
        if composerTurnState == .busy { return false }
        return turnSubmitting || composerTurnState == .starting
    }

    /// Primary harness that will answer in chat: thread sticky > global default.
    /// In the draft state, the local draft value > global default. nil => engine auto.
    var effectivePrimaryHarness: String? {
        let sticky = selectedThreadId == nil ? draftPrimaryHarness : currentThread?.primaryHarness
        let resolved = sticky ?? activeSettingsSnapshot?.routing.primaryHarness
        // Honesty guard: never SURFACE a primary that is outside a non-empty effective
        // pool — the engine wouldn't route to it (it drops/clears such a primary), so
        // showing it would be a lie. This also covers the draft case where the primary
        // comes from the GLOBAL default while the pool is a narrower draft pool.
        let pool = effectiveEligiblePool
        if let r = resolved, !pool.isEmpty, !pool.contains(r) { return nil }
        return resolved
    }

    /// Eligible harness pool (Best-of runs this; one candidate per harness): thread
    /// sticky > global default. Empty => engine auto-pools doctor-OK or exact-profile-ready lanes.
    var effectiveEligiblePool: [String] {
        let sticky = selectedThreadId == nil ? draftEligiblePool : (currentThread?.eligibleHarnesses ?? [])
        if !sticky.isEmpty { return sticky }
        return activeSettingsSnapshot?.routing.eligibleHarnesses ?? []
    }

    /// Switch the sticky primary harness. On a real thread this PATCHes the thread
    /// (persists, survives reload); on a draft it updates the local draft value.
    /// Thin gateway: the engine owns routing — orderPool just pins primary first.
    func setPrimaryHarness(_ harness: String?) async {
        guard let id = selectedThreadId else { draftPrimaryHarness = harness; return }
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to change the primary harness."; return
        }
        do {
            let updated = try await requestClient.updateThread(
                id: id, body: UpdateThreadRequest(primaryHarness: .some(harness)))
            applyThreadUpdate(updated, at: locationID)
        } catch {
            if selectedExecutionLocation == locationID, selectedThreadId == id {
                threadStatus = userMessage(for: error)
            }
        }
    }

    /// The thread's sticky write scope (D26): the open thread's server-side
    /// `access`, or the draft value before a thread exists. nil => the repo
    /// trust default (the composer chip shows Workspace write as that default).
    var effectiveThreadAccess: String? {
        if selectedThreadId == nil { return draftThreadAccess }
        return currentThread?.access
    }

    /// Switch the thread's sticky write scope (D26). On a real thread this
    /// PATCHes `access` (persists, survives reload); on a draft it updates the
    /// local draft value the first turn's thread will inherit. Passing nil
    /// clears the scope back to the repo trust default. Mirrors
    /// setPrimaryHarness — the engine still owns the trust gate at run time.
    func setThreadAccess(_ access: String?) async {
        guard let id = selectedThreadId else { draftThreadAccess = access; return }
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to change the write scope."; return
        }
        do {
            let updated = try await requestClient.updateThread(
                id: id, body: UpdateThreadRequest(access: .some(access)))
            applyThreadUpdate(updated, at: locationID)
        } catch {
            if selectedExecutionLocation == locationID, selectedThreadId == id {
                threadStatus = userMessage(for: error)
            }
        }
    }

    // Credential-profile registry + auto-balance actions live in
    // AppModel+CredentialProfiles.swift (INV-135).

    /// Replace the sticky eligible pool (PATCH on a real thread; draft otherwise).
    func setEligiblePool(_ pool: [String]) async {
        guard let id = selectedThreadId else {
            draftEligiblePool = pool
            // Mirror the engine invariant locally for the draft: a primary outside a
            // non-empty pool clears to Auto, so the chip never shows a harness the
            // first turn won't route to. (On a real thread the PATCH response carries
            // the cleared primary back via applyThreadUpdate.)
            if let p = draftPrimaryHarness, !pool.isEmpty, !pool.contains(p) { draftPrimaryHarness = nil }
            return
        }
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to change the harness pool."; return
        }
        do {
            let updated = try await requestClient.updateThread(
                id: id, body: UpdateThreadRequest(eligibleHarnesses: pool))
            applyThreadUpdate(updated, at: locationID)
        } catch {
            if selectedExecutionLocation == locationID, selectedThreadId == id {
                threadStatus = userMessage(for: error)
            }
        }
    }

    /// Apply a PATCH-thread response OPTIMISTICALLY: update the list row and the
    /// open detail in place from the returned `ThreadSummary` — no heavy
    /// `refreshThreads()` + `openThread()` re-fetch (which re-hydrated everything,
    /// flickered, and conflated a later GET's error with the PATCH).
    func applyThreadUpdate(
        _ updated: ThreadSummary,
        at locationID: ExecutionLocationID = .local
    ) {
        if locationID == .local {
            if let i = threads.firstIndex(where: { $0.id == updated.id }) {
                threads[i] = updated
            }
        } else {
            remoteThreadCache.removeAll {
                $0.locationID == locationID && $0.thread.id == updated.id
            }
            remoteThreadCache.append(RemoteThreadCacheEntry(
                locationID: locationID, thread: updated, syncedAt: .now))
            persistRemoteThreadCache()
        }
        if selectedExecutionLocation == locationID,
           selectedThreadId == updated.id
        {
            selectedHistory?.acknowledgeMetadata(updated)
            threadStatus = nil
            if let detail = selectedThreadDetail {
                selectedThreadDetail = ThreadDetailResponse(
                    thread: updated,
                    sessions: detail.sessions,
                    turns: detail.turns)
            }
        }
    }

    /// Apply an ISOLATED thread's accumulated worktree diff to its project. Returns
    /// nil on success, else an honest message (empty/conflict/rejected, or a transport
    /// error). On success refreshes the thread (its head/state may have moved).
    func applyThread(id: String, mode: String = "apply") async -> String? {
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            return "Engine offline — reconnect to apply this thread."
        }
        do {
            let res = try await requestClient.applyThread(
                id: id, body: ThreadApplyRequest(mode: mode))
            if res.applied {
                if locationID == .local {
                    await refreshThreads()
                } else {
                    await refreshRemoteThreads(locationID)
                }
                await openThread(locationID: locationID, id: id)
                return nil
            }
            // Honest non-applied outcomes: surface the server's status + detail verbatim.
            let base = Self.threadApplyLabel(res.status)
            let head = res.headMoved ? " (project HEAD moved past the thread base)" : ""
            return res.detail.map { "\(base): \($0)\(head)" } ?? "\(base)\(head)"
        } catch {
            return userMessage(for: error)
        }
    }

    /// Human-readable label for a ControlThreadApplyResponse.status.
    private static func threadApplyLabel(_ status: String) -> String {
        switch status {
        case "applied": return "Applied"
        case "branched": return "Applied as branch"
        case "committed": return "Committed"
        case "pr_opened": return "PR opened"
        case "empty": return "Nothing to apply"
        case "conflict": return "Conflict — apply refused"
        case "rejected": return "Apply rejected"
        default: return status
        }
    }

    @discardableResult
    func newThread(
        title: String?,
        shouldSelectCreatedThread: ((String) -> Bool)? = nil,
        completionIsRelevant: (() -> Bool)? = nil
    ) async -> String? {
        let target = composerTurnStartTarget.replacingDraftTitle(title)
        guard target.createRequest != nil else {
            applyComposerCompletionStatus(
                "Start a new draft before creating another thread.",
                isRelevant: completionIsRelevant)
            return nil
        }
        return await materializeThread(
            target: target,
            shouldSelectCreatedThread: shouldSelectCreatedThread,
            completionIsRelevant: completionIsRelevant)
    }

    private func materializeThread(
        target: TurnStartTarget,
        using preparedClient: GatewayClient? = nil,
        shouldSelectCreatedThread: ((String) -> Bool)?,
        completionIsRelevant: (() -> Bool)?
    ) async -> String? {
        guard let createRequest = target.createRequest else { return nil }
        let locationID = target.locationID
        if preparedClient == nil,
           gateway(for: locationID) == nil,
           let connectionID = locationID.remoteConnectionID {
            await connectRemote(connectionID)
        }
        guard let requestClient = preparedClient ?? gateway(for: locationID),
              isCurrentGateway(requestClient, at: locationID)
        else {
            applyComposerCompletionStatus(
                "Engine offline: reconnect before creating a thread.",
                isRelevant: completionIsRelevant
            )
            return nil
        }
        do {
            let thread = try await requestClient.createThread(createRequest)
            guard isCurrentGateway(requestClient, at: locationID) else {
                applyComposerCompletionStatus(
                    Self.turnStartConnectionChangedMessage,
                    isRelevant: completionIsRelevant)
                return nil
            }
            if locationID == .local {
                threads.insert(thread, at: 0)
            } else {
                remoteThreadCache.removeAll {
                    $0.locationID == locationID && $0.thread.id == thread.id
                }
                remoteThreadCache.append(RemoteThreadCacheEntry(
                    locationID: locationID, thread: thread, syncedAt: .now))
                persistRemoteThreadCache()
                if let projectList = try? await requestClient.listProjects(),
                   isCurrentGateway(requestClient, at: locationID) {
                    remoteProjects[locationID] = projectList.projects
                }
            }
            guard isCurrentGateway(requestClient, at: locationID) else {
                applyComposerCompletionStatus(
                    Self.turnStartConnectionChangedMessage,
                    isRelevant: completionIsRelevant)
                return nil
            }
            // First-turn send registers this exact server-created id with the
            // composer's generation fence before selection. If the user selected
            // another thread while createThread awaited, do not steal it back.
            let shouldSelect = shouldSelectCreatedThread?(thread.id) ?? true
            if shouldSelect {
                await openThread(locationID: locationID, id: thread.id)
                guard isCurrentGateway(requestClient, at: locationID) else {
                    applyComposerCompletionStatus(
                        Self.turnStartConnectionChangedMessage,
                        isRelevant: completionIsRelevant)
                    return nil
                }
            }
            return thread.id
        } catch {
            applyComposerCompletionStatus(
                "Could not create thread: \(userMessage(for: error))",
                isRelevant: completionIsRelevant
            )
            return nil
        }
    }

    /// Send from the composer. If no thread is selected (the empty/draft state),
    /// the FIRST message MATERIALIZES a thread on the Current Project — an empty
    /// chat composer is never a silent no-op (the v0.9 bug). Returns once sent.
    /// Returns true when the turn was accepted by the engine (so the composer can
    /// clear its text). A POST-send thread reload failure does NOT make this false
    /// (the turn is already on the server) — that would risk a duplicate send.
    @discardableResult
    /// `target` is an immutable existing-thread identity or complete draft-create
    /// request. When omitted it is captured synchronously from the composer.
    func composerSend(
        prompt: String,
        mode: RunMode,
        answersPlanRunId: String? = nil,
        planRunId: String? = nil,
        model: String? = nil,
        attachments: [PendingAttachment] = [],
        options: TurnOptions = .init(),
        target explicitTarget: TurnStartTarget? = nil,
        onMaterializedThread: ((String) -> Bool)? = nil,
        completionIsRelevant: (() -> Bool)? = nil
    ) async -> Bool {
        let target = explicitTarget ?? composerTurnStartTarget
        guard mode != .unknown else {
            applyComposerCompletionStatus(
                "Unknown mode — pick an intent from the composer.",
                isRelevant: completionIsRelevant)
            return false
        }
        // Single busy gate for EVERY turn-start path (composer, Implement-plan,
        // plan answers all funnel through here), so none can start a turn over a
        // live one — gated on the TARGET thread, not live selection. `isThreadBusy`
        // folds in `turnSubmitting`, so this also blocks a double-submit during the
        // pre-detail window (checked synchronously before `turnSubmitting = true`, so
        // concurrent main-actor calls can't both pass). The composer's send() also
        // routes ⌘↩→Stop while busy; non-composer buttons rely on this guard.
        guard !isThreadBusy(target.threadID, at: target.locationID) else {
            threadStatus = "Wait for the running turn to finish, or Stop it, before starting another."
            return false
        }
        turnSubmitting = true
        defer { turnSubmitting = false }

        let prepared: PreparedTurnStart
        switch await prepareTurnStart(target) {
        case .ready(let value):
            prepared = value
        case .blocked(let message):
            applyComposerCompletionStatus(message, isRelevant: completionIsRelevant)
            return false
        }
        // Defense-in-depth immediately before ANY create/upload/turn mutation.
        // Backend preflight remains authoritative; this is the thin UI
        // projection of the same server-authored matrix.
        if let blocker = turnStartAdmission(
            target: target,
            mode: mode,
            options: options,
            applicability: prepared.applicability).finalBlocker {
            applyComposerCompletionStatus(blocker, isRelevant: completionIsRelevant)
            return false
        }

        var threadId = target.threadID
        if threadId == nil {
            threadId = await materializeThread(
                target: target,
                using: prepared.client,
                shouldSelectCreatedThread: onMaterializedThread,
                completionIsRelevant: completionIsRelevant
            )
            guard threadId != nil else { return false }
        }
        guard let tid = threadId else { return false }
        return await sendTurn(
            target: target,
            using: prepared.client,
            threadId: tid,
            prompt: prompt,
            mode: mode,
            answersPlanRunId: answersPlanRunId,
            planRunId: planRunId,
            model: model,
            attachments: attachments,
            options: options,
            completionIsRelevant: completionIsRelevant)
    }

    /// Trim + drop empty entries; nil when nothing remains (key omitted on the wire).
    private func normalizedTurnModels(_ models: [String: String]) -> [String: String]? {
        let cleaned = models.compactMapValues { value -> String? in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return cleaned.isEmpty ? nil : cleaned
    }

    @discardableResult
    private func sendTurn(
        target: TurnStartTarget,
        using requestClient: GatewayClient,
        threadId: String,
        prompt: String,
        mode: RunMode,
        answersPlanRunId: String? = nil,
        planRunId: String? = nil,
        model: String? = nil,
        attachments: [PendingAttachment] = [],
        options: TurnOptions = .init(),
        completionIsRelevant: (() -> Bool)? = nil
    ) async -> Bool {
        let locationID = target.locationID
        guard isCurrentGateway(requestClient, at: locationID) else {
            applyComposerCompletionStatus(
                Self.turnStartConnectionChangedMessage,
                isRelevant: completionIsRelevant
            )
            return false
        }
        let flags = mode.strategyFlags
        // Best-of sends the exact explicit eligible pool the user selected. The
        // engine owns explicit-lane availability and fails loudly rather than the
        // app silently shrinking the request. Empty means Auto and remains omitted
        // so the engine may resolve available candidates. Other modes inherit the
        // thread's sticky pool server-side (primary too).
        var racePool: [String] = []
        if mode == .bestOfN {
            racePool = target.eligibleHarnesses
        }
        // Best-of width = one candidate per harness in the pool (≥2). A SINGLE-harness
        // pool can't race against itself: send n=1 so the engine single-routes that
        // one harness instead of duplicating it (a wasteful self-race). An EMPTY pool
        // (auto) keeps the default 2 so the engine can pool two doctor-OK or exact-profile-ready lanes.
        let raceN: Int?
        if mode == .bestOfN {
            raceN = racePool.count == 1 ? 1 : max(2, racePool.count)
        } else if mode == .plan, options.council, let n = options.councilN {
            // Council membership width (D31): `n` on a plan run is legal ONLY
            // with council; the engine clamps to distinct available harnesses.
            raceN = n
        } else {
            raceN = nil
        }
        // Until Clean / Max Attempts are SINGLE-candidate repair strategies — the
        // engine routes them to convergence (ignoring n), so they only make sense
        // for a plain agent turn, never for Best-of. access/web/budget are per-turn.
        let repair = composerRepairWire(
            mode: mode,
            access: options.access.flatMap(AccessProfile.init(wire:)) ?? .workspaceWrite,
            requestedAttempts: options.maxAttempts,
            requestedUntilClean: options.untilClean)
        let result: RunStartResult
        do {
            let attachmentRefs = try await uploadAttachments(
                attachments,
                client: requestClient,
                locationID: locationID)
            guard isCurrentGateway(requestClient, at: locationID) else {
                applyComposerCompletionStatus(
                    Self.turnStartConnectionChangedMessage,
                    isRelevant: completionIsRelevant)
                return false
            }
            result = try await requestClient.sendTurn(threadId: threadId, body: ThreadTurnRequest(
                prompt: prompt,
                mode: mode.apiValue,
                answersPlanRunId: answersPlanRunId,
                harnesses: racePool.isEmpty ? nil : racePool,
                n: raceN,
                // "Until clean" and "Max attempts" are mutually exclusive repair
                // strategies (no-fixed-cap vs hard-cap) — never send both. Until-clean
                // wins: drop the attempts cap when it's on.
                attempts: repair.attempts,
                untilClean: repair.untilClean,
                // Ask deep-scan rides the wire's `deepScan` (was `swarm`); the
                // engine accepts either, prefer the v3 name.
                deepScan: flags.swarm ? true : nil,
                create: flags.create ? true : nil,
                // Plan council (D31) and Agent delegation belt (D32).
                council: options.council ? true : nil,
                delegate: options.delegate ? true : nil,
                paidBudget: options.maxUsd.map { .finite(maxUsd: $0) },
                // Per-turn model override (empty = harness default → don't send the key).
                model: model.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 },
                // Harness-scoped map: specific beats the scalar and defaults.
                models: normalizedTurnModels(options.models),
                review: composerReviewWire(
                    mode: mode, requestedReview: options.review,
                    hasExplicitPanel: !(options.reviewerPanel ?? []).isEmpty,
                    untilClean: repair.untilClean == true),
                reviewerPanel: options.reviewerPanel,
                access: !mode.isReadOnly ? options.access : nil,
                web: options.web,
                browser: options.browser ? true : nil,
                planRunId: planRunId,
                overridePlanReadiness: options.overridePlanReadiness ? true : nil,
                attachments: attachmentRefs.isEmpty ? nil : attachmentRefs,
                // QA-010: the operator-authorized deterministic gate command(s)
                // for this turn (Create), so acceptance runs a real post-candidate
                // gate instead of falling back to review-only.
                tests: options.tests.isEmpty ? nil : options.tests,
                protectedPathApprovals: options.protectedPathApprovals,
                authPreference: options.authRoute,
                effort: options.effort
            ))
        } catch {
            // A REFUSED turn is not a lost turn: when the server persisted the
            // refusal on a recorded turn (the error body carries its turnId),
            // reload the thread so the inline card shows IMMEDIATELY.
            if let refusal = Self.refusedTurn(from: error) {
                if isCurrentGateway(requestClient, at: locationID) {
                    if locationID == .local {
                        await refreshRuns()
                    } else {
                        await refreshRemoteThreads(locationID, using: requestClient)
                    }
                    if isCurrentGateway(requestClient, at: locationID),
                       selectedExecutionLocation == locationID,
                       selectedThreadId == threadId {
                        await openThread(locationID: locationID, id: threadId)
                    }
                }
                if refusal.retryable {
                    // The prompt lives on the refused turn and Retry replays
                    // it — report "sent" so the composer clears (no duplicate
                    // unsent draft).
                    applyComposerCompletionStatus(nil, isRelevant: completionIsRelevant)
                    return true
                }
                // NOT retryable (no recorded job to replay): keep the draft —
                // "send a new message" is the remedy the card states.
                applyComposerCompletionStatus(
                    userMessage(for: error), isRelevant: completionIsRelevant
                )
                return false
            }
            if !isCurrentGateway(requestClient, at: locationID) {
                applyComposerCompletionStatus(
                    Self.turnStartConnectionChangedMessage,
                    isRelevant: completionIsRelevant)
                return false
            }
            applyComposerCompletionStatus(
                userMessage(for: error), isRelevant: completionIsRelevant
            )
            return false
        }
        // The turn is ACCEPTED here. Anything below (refresh/reload) is best-effort
        // presentation; its failure must NOT be read as a send failure.
        applyComposerCompletionStatus(nil, isRelevant: completionIsRelevant)
        guard isCurrentGateway(requestClient, at: locationID) else {
            applyComposerCompletionStatus(
                "Turn accepted, but the engine connection changed before it could be refreshed.",
                isRelevant: completionIsRelevant)
            return true
        }
        if locationID == .local {
            await refreshRuns()
        } else {
            await refreshRemoteThreads(locationID, using: requestClient)
        }
        guard isCurrentGateway(requestClient, at: locationID) else { return true }
        if selectedExecutionLocation == locationID, selectedThreadId == threadId {
            if selectedHistory == nil { await openThread(locationID: locationID, id: threadId) }
            await selectedHistory?.jump()
            invalidateWorkspaceHistory()
        }
        guard isCurrentGateway(requestClient, at: locationID) else { return true }
        if case .started(let info) = result {
            if locationID == .local {
                stream(runId: info.runId)
            } else {
                streamRemoteRun(
                    locationID: locationID,
                    runID: info.runId,
                    threadID: threadId)
            }
        }
        return true
    }

    /// Composer-only async completion fence. Other action surfaces omit the
    /// predicate and retain their existing global status behavior.
    private func applyComposerCompletionStatus(
        _ completion: String?,
        isRelevant: (() -> Bool)?
    ) {
        threadStatus = ComposerCompletionStatus.resolving(
            current: threadStatus,
            completion: completion,
            ownsCompletion: isRelevant?() ?? true
        )
    }

}
