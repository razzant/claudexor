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

// MARK: - SPEC-FLOW state

/// The client-side state of the SPEC-FLOW for the CURRENT thread (questions →
/// answers → deeper questions → freeze → implement). The interview is multi-tier
/// via `priorDecisions`; the frozen SpecPack remains one immutable contract
/// commit. The flow is keyed to a thread id so switching threads never shows a
/// stale spec card.
enum SpecFlowState: Equatable {
    /// The grounding plan is running (pre-questions): session creation is in flight,
    /// reading the repo to derive the interview. NOTHING is frozen yet — this is a
    /// distinct phase from `.freezing` so the spinner doesn't claim "freezing the
    /// SpecPack" while only the grounding plan runs (it can take minutes).
    case grounding
    /// The grounding plan ran; these questions await the user. `prompt` is the
    /// user's ORIGINAL spec intent — carried so the freeze call posts the exact same
    /// prompt the grounding plan ran on (not a stale head-turn prompt). `planDir`/
    /// `planRunId` thread back into the freeze call; `answers` are accumulated
    /// client-side. `error` is non-nil after an unresolved-clarifications 400 re-opens
    /// this card.
    case askingQuestions(prompt: String, questions: [SpecQuestion], planDir: String, planRunId: String, answers: [SpecAnswer], error: String?)
    /// The freeze call is in flight (assembling + persisting the SpecPack).
    case freezing
    /// The SpecPack is frozen and ready to implement (carries the file path an
    /// Implement turn reads).
    case frozen(specId: String, specPath: String, specHash: String, changes: Int)
    /// An honest, surfaced failure (e.g. unresolved-clarifications 400) — the
    /// question card stays open and shows this message.
    case error(String)
}

// MARK: - App model

@MainActor
@Observable
final class AppModel {
    var health: Health = .connecting
    var endpoint: String = ""
    var route: SidebarRoute = .threads {
        // Leaving a run's inspector is the P3 eviction point: terminal runs
        // that just went off-screen release their heavy feed/transcript
        // arrays (reopening reloads from the server).
        didSet { if oldValue != route { evictBackgroundRunData() } }
    }
    /// THE inspector visibility (W4.6 sol #17): explicit open (⧉/toolbar),
    /// manual close respected, no route-derived auto-open, no reveal seqs.
    var inspectorPresented = false

    /// Open a run in the inspector — the ONE owner of the reveal semantics
    /// (a direct assignment re-presents on same-route clicks; no counter).
    func openRun(_ id: String) {
        route = .task(id)
        inspectorPresented = true
    }
    var appearance: AppearanceMode = .dark {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "claudexor.appearance") }
    }
    var authSheetHarness: HarnessFamily?
    var projectRoot: String = "" {
        didSet { UserDefaults.standard.set(projectRoot, forKey: "claudexor.projectRoot") }
    }
    var recentProjects: [String] = [] {
        didSet { UserDefaults.standard.set(recentProjects, forKey: "claudexor.recentProjects") }
    }

    var liveTasks: [TaskRun] = []
    /// Run ids the user has successfully cancelled. Lets `composerTurnState` treat a
    /// cancelled run as inactive IMMEDIATELY — even in the bound-but-not-yet-hydrated
    /// window where no live row exists to flip and the embedded card still says
    /// "running" (otherwise Stop would appear to do nothing until hydration).
    private var cancelledRunIds: Set<String> = []
    /// A turn POST is in flight (composerSend: from the click until the thread detail
    /// reflects the accepted turn). The head-turn busy-gate is detail-derived and
    /// can't see this window, so without it the composer would still show Send and a
    /// user could DOUBLE-SUBMIT (or, on a draft, create two threads). Folded into
    /// `selectedThreadBusy`/`selectedThreadStarting` and re-entry-guarded in
    /// composerSend so no turn-start path can bypass it.
    private(set) var turnSubmitting = false
    // Threads (chat/session-first): the conversation list + selected detail.
    var threads: [ThreadSummary] = []
    var selectedThreadId: String?
    var selectedThreadDetail: ThreadDetailResponse?
    var threadStatus: String?
    /// SPEC-FLOW state (questions → freeze → implement) keyed PER THREAD. Keyed —
    /// not a single slot — so a long spec create or freeze await that
    /// returns AFTER the user switched threads still records its result on the
    /// OWNING thread (never stranding that thread's card at `.grounding`/`.freezing`),
    /// and a concurrent spec on another thread is never clobbered. `specFlow` reads
    /// only the selected thread's entry, so a switch hides a non-current card.
    private var specFlowByThread: [String: SpecFlowState] = [:]
    /// Per-thread SPEC-FLOW generation. Spec grounding/freeze are NOT thread turns,
    /// so `selectedThreadBusy` can't block a second Spec on the same thread — two
    /// in-flight spec create (or a cancel mid-grounding) would otherwise race
    /// and the LAST response would clobber the newest interview. Each start / submit
    /// / cancel bumps the generation; an await that returns stale (its gen is no
    /// longer current) drops its write instead of overwriting fresher state.
    private var specFlowGen: [String: Int] = [:]
    /// Per-turn model + options the user set in the composer when they STARTED a
    /// spec, kept per thread so the eventual Implement turn honors them (the visible
    /// composer controls would otherwise be silently ignored by the spec flow). The
    /// grounding plan / freeze run read-only on harness defaults; these apply to the
    /// write turn that implements the frozen spec.
    private var specPendingModel: [String: String] = [:]
    private var specPendingOptions: [String: TurnOptions] = [:]
    /// Accumulated decisions across interview tiers (per thread) — each "Ask deeper"
    /// round carries them so the server surfaces the NEXT layer instead of re-asking.
    private var specPrior: [String: [SpecPriorDecision]] = [:]
    /// The active SPEC-FLOW state — scoped to the selected thread (nil otherwise).
    var specFlow: SpecFlowState? {
        guard let tid = selectedThreadId else { return nil }
        return specFlowByThread[tid]
    }
    /// DRAFT-thread routing (before the first message materializes a thread): the
    /// composer edits these; once a thread exists, primary/pool are sticky on the
    /// thread (PATCHed via setPrimaryHarness/setEligiblePool). nil/[] => inherit
    /// the global default from Settings.
    var draftPrimaryHarness: String?
    var draftEligiblePool: [String] = []
    /// DRAFT-thread workspace mode: false => in_place (default; turns mutate the live
    /// tree), true => isolated (turns accumulate in a thread worktree, applied later via
    /// "Apply thread"). Fixed at thread creation, so it's only editable in the draft.
    var draftIsolatedWorkspace = false
    var liveHarnesses: [HarnessInfo] = []
    private var exactAuthSources: [HarnessFamily: [AuthSourceKind: HarnessAuthSource]] = [:]
    var settingsSnapshot: SettingsSnapshot?
    var quotaResponse: ControlQuotaResponse?
    var quotaStatus: String?
    var secretBackend = "unknown"
    var storedSecrets: [SecretInfo] = []
    var settingsStatus: String?
    /// Per-repo user-level trust files (Settings trust section).
    var trustEntries: [TrustEntry] = []
    var trustStatus: String?

    var projects: [Project] { liveProjects }
    var harnesses: [HarnessInfo] { liveHarnesses }
    /// Controls enumerate doctor truth, not a compiled enum. Built-ins remain
    /// available before the first successful refresh; any adapter returned by
    /// the daemon appears without a Swift patch.
    var selectableHarnesses: [HarnessFamily] {
        let live = liveHarnesses.map(\.family).filter { $0 != .fake }
        return live.isEmpty ? HarnessFamily.builtIns : live
    }

    /// Live runs grouped into a light project tree for the sidebar.
    private var liveProjects: [Project] {
        let groups = Dictionary(grouping: liveTasks, by: { $0.project })
        return groups.keys.sorted().map { name in
            let ids = (groups[name] ?? []).map(\.id)
            return Project(id: name, name: name,
                           specs: [Spec(id: "\(name)-runs", title: "Runs", frozen: false, version: 0, runIds: ids)])
        }
    }

    var defaultRoutingGoal: String { settingsSnapshot?.routing.goal ?? "auto" }
    var defaultMaxUsdPerRun: Double? { settingsSnapshot?.budget.paidBudgetPerRun.finiteMaxUsd }

    private(set) var client: GatewayClient?
    private var connectionGeneration = 0
    var threadLoadGeneration = 0
    var streamTasks: [String: Task<Void, Never>] = [:]
    var globalStreamTask: Task<Void, Never>?
    var globalEventCursor: String?
    /// Last SSE sequence seen per run so reconnects resume instead of replaying everything.
    var lastEventIds: [String: Int] = [:]
    /// Highest sequence reflected by in-flight detail snapshots — separate
    /// from `lastEventIds`: the cursor may pass a still-loading snapshot.
    private var snapshotReplayFences: [String: Int] = [:]
    /// Reentrancy depth of in-flight detail loads per run (see loadRunDetail).
    var snapshotLoadDepth: [String: Int] = [:]
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
    /// TERMINAL chat transcripts per run (live transcripts stream in the run's
    /// RunLiveBox; foldLiveBox moves the final reducer here at terminal).
    var transcripts: [String: TranscriptReducer] = [:]
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

    init(client: GatewayClient? = nil, requestNotificationAuthorization: Bool = true) {
        self.client = client
        // Without this first-run authorization request, run-completion
        // notifications are silently dropped in the bundled .app forever.
        if requestNotificationAuthorization { Notifier.requestAuthIfPossible() }
        if let raw = UserDefaults.standard.string(forKey: "claudexor.appearance"),
           let saved = AppearanceMode(rawValue: raw) {
            appearance = saved
        }
        // Dev/QA only: force an appearance for deterministic screenshots.
        switch ProcessInfo.processInfo.environment["CLAUDEXOR_DEBUG_APPEARANCE"] {
        case "light": appearance = .light
        case "dark": appearance = .dark
        default: break
        }
        projectRoot = UserDefaults.standard.string(forKey: "claudexor.projectRoot") ?? ProcessInfo.processInfo.environment["CLAUDEXOR_PROJECT_ROOT"] ?? ""
        recentProjects = UserDefaults.standard.stringArray(forKey: "claudexor.recentProjects") ?? []
    }

    var tasks: [TaskRun] { liveTasks }

    func task(_ id: String) -> TaskRun? { tasks.first { $0.id == id } }

    // MARK: Connection

    func connect() async {
        connectionGeneration += 1
        let generation = connectionGeneration
        var attemptedLaunch = false
        while !Task.isCancelled, generation == connectionGeneration {
            health = .connecting
            cancelAllStreams()
            if await tryConnect() {
                while !Task.isCancelled, generation == connectionGeneration {
                    try? await Task.sleep(for: .seconds(3))
                    guard generation == connectionGeneration, let current = client else { break }
                    if (try? await current.health()) != true { break }
                }
            } else if !attemptedLaunch, DaemonLauncher.startIfNeeded() {
                attemptedLaunch = true
                try? await Task.sleep(for: .seconds(3))
                continue
            }
            guard generation == connectionGeneration else { return }
            enterHardOffline()
            try? await Task.sleep(for: .seconds(3))
        }
    }

    /// Drop every daemon-owned projection when the engine is unreachable. The
    /// reconnect path repopulates these from `/v2`; user preferences and the
    /// current composer draft remain local and are intentionally preserved.
    func enterHardOffline() {
        health = .offline
        endpoint = ""
        client = nil
        authSheetHarness = nil
        cancelAllStreams()

        route = .threads
        liveTasks.removeAll()
        cancelledRunIds.removeAll()
        transcripts.removeAll()
        liveBoxes.removeAll()
        snapshotLoadDepth.removeAll()
        deferredEnvelopes.removeAll()
        deferredOverflow.removeAll()
        turnSubmitting = false

        threads.removeAll()
        selectedThreadId = nil
        selectedThreadDetail = nil
        threadStatus = nil
        threadLoadGeneration += 1
        specFlowByThread.removeAll()
        specFlowGen.removeAll()
        specPendingModel.removeAll()
        specPendingOptions.removeAll()
        specPrior.removeAll()

        liveHarnesses.removeAll()
        exactAuthSources.removeAll()
        settingsSnapshot = nil
        settingsStatus = nil
        quotaResponse = nil
        quotaStatus = nil
        secretBackend = "unknown"
        storedSecrets.removeAll()
        trustEntries.removeAll()
        trustStatus = nil
    }

    private func tryConnect() async -> Bool {
        do {
            let discovery = try ControlApiDiscovery.load()
            let client = try discovery.makeClient()
            endpoint = "\(discovery.host):\(discovery.port)"
            self.client = client
            if try await client.health() {
                health = .connected
                await refreshRuns()
                await refreshHarnesses()
                await refreshSettings()
                await refreshQuota()
                await refreshSecrets()
                await refreshThreads()
                startGlobalStream()
                return true
            }
        } catch {
            // fall through to caller (offline / auto-start path)
        }
        return false
    }

    func refreshRuns() async {
        guard let client else { return }
        do {
            let summaries = try await client.listRuns()
            let existingById = Dictionary(uniqueKeysWithValues: liveTasks.map { ($0.id, $0) })
            // Merge instead of replace: a refresh must not wipe locally-hydrated
            // detail (activity, diff, findings, outputs) for rows we already track.
            liveTasks = summaries
                .map { summary in
                    var task = Self.liveTask(from: summary)
                    if let existing = existingById[task.id] ?? summary.jobId.flatMap({ existingById[$0] }) {
                        if !existing.activity.isEmpty { task.activity = existing.activity }
                        if !existing.diff.isEmpty { task.diff = existing.diff }
                        if !existing.findings.isEmpty { task.findings = existing.findings }
                        task.reviewVerdict = existing.reviewVerdict
                        if !existing.plan.isEmpty { task.plan = existing.plan }
                        task.answerText = existing.answerText ?? task.answerText
                        task.diagnosticText = existing.diagnosticText ?? task.diagnosticText
                        if task.artifactPaths.isEmpty { task.artifactPaths = existing.artifactPaths }
                        // Carry hydrated questions only while the daemon still says the
                        // run waits on the user; otherwise an answered/timed-out
                        // interaction would resurrect on every list refresh.
                        if task.pendingInteractions.isEmpty, task.waitingOnUser { task.pendingInteractions = existing.pendingInteractions }
                        task.observedModel = task.observedModel ?? existing.observedModel
                        if task.routeProof == .unverified, existing.routeProof != .unverified { task.routeProof = existing.routeProof }
                        task.authRoute = task.authRoute ?? existing.authRoute
                        task.failureCategory = task.failureCategory ?? existing.failureCategory
                    }
                    return task
                }
            // A 202-queued row was keyed by jobId; once the daemon surfaces the
            // runId the open detail route must follow instead of dangling.
            if case .task(let openId) = route, !liveTasks.contains(where: { $0.id == openId }) {
                if let mapped = summaries.first(where: { $0.jobId == openId }) {
                    route = .task(mapped.runId)
                }
            }
            // Live progress for EVERY active run — including CLI-started runs and
            // runs that were already active when the app (re)connected.
            for task in liveTasks where task.isLive && task.status.isActive {
                stream(runId: task.id)
            }
            await hydrateReviewFindings()
        } catch {
            // keep last-known live tasks; connection badge reflects reality elsewhere
        }
    }

    @discardableResult
    func refreshHarnesses(fresh: Bool = false) async -> Bool {
        guard let client else { return false }
        do {
            liveHarnesses = try await client.listHarnesses(fresh: fresh).map { status in
                let family = HarnessFamily(rawValue: status.id)
                let health = HarnessHealth(rawValue: status.status) ?? .unavailable
                let version = status.manifest?["version"]?.stringValue ?? status.manifest?["adapter_version"]?.stringValue ?? "unknown"
                let auth = Self.harnessReadinessText(status: status, health: health)
                let checks = status.checks.map { "\($0.id): \($0.status)" }
                let acceptsImages = Self.acceptsImages(manifest: status.manifest)
                let acceptsBrowser = status.manifest?["capabilities"]?["browser_tool"]?.boolValue ?? false
                let effortLevels: [String] = {
                    // Schema truth: HarnessCapabilities.effort_levels lives under
                    // manifest.capabilities (the old capability_profile path was
                    // never populated — the ladder read empty for EVERY harness).
                    guard case .array(let values) = status.manifest?["capabilities"]?["effort_levels"] else { return [] }
                    return values.compactMap(\.stringValue)
                }()
                // The doctor's configured-model verdict rides the DTO —
                // surface a rejection so a doomed default is visible in Settings.
                let modelIssue: String? = {
                    guard let check = status.configuredModelCheck, check.status == "rejected" else { return nil }
                    let model = status.configuredModel ?? "configured model"
                    return "\(model): \(check.message ?? "refused by the model truth source")"
                }()
                return HarnessInfo(family: family, health: health, version: version, auth: auth,
                                   authSources: status.authSources,
                                   intents: status.enabledIntents, routableIntents: status.routableIntents,
                                   reasons: status.reasons ?? [], checks: checks, readiness: status.readiness,
                                   acceptsImages: acceptsImages, acceptsBrowser: acceptsBrowser,
                                   effortLevels: effortLevels,
                                   configuredModelIssue: modelIssue)
            }
            return true
        } catch {
            // Keep last-known harness rows.
            return false
        }
    }

    @discardableResult
    func refreshAuthReadinessAfterSetupLifecycle(for family: HarnessFamily, job: SetupJob?) async -> Bool {
        guard let request = family.authReadinessRequest(after: job) else { return false }
        return await refreshAuthReadiness(for: family, request: request)
    }

    @discardableResult
    func refreshAuthReadiness(for family: HarnessFamily, request: AuthReadinessRefreshRequest) async -> Bool {
        guard let client else { return false }
        do {
            let response = try await client.refreshAuthReadiness(harnessId: family.rawValue, request: request)
            let source = HarnessAuthSource(
                source: response.readiness.source.rawValue,
                availability: response.readiness.availability.rawValue,
                verification: response.readiness.verification.rawValue,
                detail: response.readiness.detail
            )
            exactAuthSources[family, default: [:]][response.requestedSource] = source
            if let index = liveHarnesses.firstIndex(where: { $0.family == family }) {
                if let sourceIndex = liveHarnesses[index].authSources.firstIndex(where: { $0.source == source.source }) {
                    liveHarnesses[index].authSources[sourceIndex] = source
                } else {
                    liveHarnesses[index].authSources.append(source)
                }
            }
            return true
        } catch {
            return false
        }
    }

    func authSource(for family: HarnessFamily, source: AuthSourceKind) -> HarnessAuthSource? {
        exactAuthSources[family]?[source]
            ?? harnessInfo(for: family)?.authSources.first { $0.source == source.rawValue }
    }

    private static func harnessReadinessText(status: HarnessStatus, health: HarnessHealth) -> String {
        let smokeReady = status.readiness.contains { $0.kind == "smoke" && $0.status == "pass" }
        let sourceText = authSourceAvailability(status: status)
        switch health {
        case .ok:
            return smokeReady ? "Ready: doctor smoke passed. Auth sources: \(sourceText)." : "Ready by doctor. Auth sources: \(sourceText)."
        case .degraded:
            return "Not ready: doctor degraded. Auth sources: \(sourceText)."
        case .unavailable:
            return "Unavailable: install/login/smoke check required. Auth sources: \(sourceText)."
        }
    }

    private static func authSourceAvailability(status: HarnessStatus) -> String {
        if !status.authSources.isEmpty {
            return status.authSources.map { source in
                "\(source.source): \(source.availability), verification \(source.verification)"
            }.joined(separator: "; ")
        }
        // Legacy manifest auth_modes describe availability, never readiness.
        let manifest = status.manifest
        let auth = manifest?["capability_profile"]?["auth"]
        let supported = stringArray(auth?["supported_sources"])
        let present = stringArray(manifest?["auth_modes"])
        let presentLabel = present.isEmpty ? "legacy readiness not reported" : "legacy availability \(present.joined(separator: ", ")); unverified"
        if !supported.isEmpty {
            let preferred = auth?["preferred_source"]?.stringValue
            let supportedLabel = "supported \(supported.joined(separator: ", "))"
            return preferred.map { "\(presentLabel); \(supportedLabel); preferred \($0)" } ?? "\(presentLabel); \(supportedLabel)"
        }
        return presentLabel
    }

    private static func stringArray(_ value: JSONValue?) -> [String] {
        guard case .array(let values)? = value else { return [] }
        return values.compactMap(\.stringValue)
    }

    func harnessModels(for family: HarnessFamily, route: String? = nil) async -> HarnessModelsResponse? {
        guard let client else { return nil }
        return try? await client.harnessModels(harnessId: family.rawValue, route: route)
    }

    func refreshSettings() async {
        guard let client else { return }
        do {
            settingsSnapshot = try await client.settings()
        } catch {
            settingsStatus = "Could not load settings: \(error)"
        }
    }
    func refreshQuota(force: Bool = false) async {
        guard health == .connected, let client else {
            quotaResponse = nil; quotaStatus = "Quota is unavailable while the engine is offline."
            return
        }
        do {
            quotaResponse = try await client.quota(refresh: force); quotaStatus = nil
        } catch { quotaStatus = "Could not load quota: \(error)" }
    }
    var normalizedProjectRoot: String {
        projectRoot.trimmingCharacters(in: .whitespacesAndNewlines)
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
        if hasCurrentProject {
            panel.directoryURL = URL(fileURLWithPath: normalizedProjectRoot, isDirectory: true)
        }
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return url.path
    }

    func refreshSecrets() async {
        guard let client else { return }
        do {
            let res = try await client.listSecrets()
            secretBackend = res.backend
            storedSecrets = res.secrets
        } catch {
            secretBackend = "unknown"
        }
    }

    /// Model-internal busy bracket for turn-start paths that live in other
    /// files (retryTurn in AppModelTrust.swift): `turnSubmitting` keeps its
    /// private(set) so views can never write it directly.
    func withTurnSubmission<T>(_ body: () async -> T) async -> T {
        turnSubmitting = true
        defer { turnSubmitting = false }
        return await body()
    }

    func saveSettings(_ patch: SettingsUpdateRequest) async -> Bool {
        guard let client else {
            settingsStatus = "Engine offline: reconnect before saving settings."
            return false
        }
        do {
            let res = try await client.updateSettings(patch)
            settingsStatus = "Saved engine defaults to \(res.path)."
            await refreshSettings()
            await refreshHarnesses()
            return true
        } catch {
            settingsStatus = "Could not save settings: \(error)"
            return false
        }
    }

    private static func liveTask(from s: RunSummary) -> TaskRun {
        let prompt = s.prompt ?? ""
        let title = prompt.isEmpty ? prettyTitle(s.runId) : String(prompt.prefix(64))
        let families = (s.harnesses ?? []).map { HarnessFamily(rawValue: $0) }
        let projectName = s.project?.projectName ?? s.project?.root.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No project"
        var task = TaskRun(
            id: s.runId,
            title: title,
            prompt: prompt,
            mode: RunMode(apiValue: s.mode, strategy: s.strategy),
            status: RunStatus(api: s.state),
            project: projectName,
            specTitle: nil,
            harnesses: families,
            n: s.n ?? max(1, families.count),
            createdAt: .now, updatedAt: .now,
            spendUsd: s.spendUsd ?? 0, capUsd: s.paidBudget?.finiteMaxUsd ?? 0,
            spendKnown: s.spendUsd != nil, capKnown: s.paidBudget?.finiteMaxUsd != nil,
            spendEstimated: s.spendEstimated ?? false,
            routeProof: .unverified,
            attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [],
            isLive: true
        )
        task.repoRoot = s.project?.root
        task.engineError = s.failure?.safeMessage ?? s.error
        task.runDir = s.runDir ?? s.failure?.runDir
        task.outputReadyState = s.outputReadyState
        task.waitingOnUser = s.waitingOnUser ?? false
        if let route = s.route {
            task.observedModel = route.observedModel
            task.routeProof = route.verified == true ? .verified : .unverified
        }
        // W18/W20 disclosures ride the LIST summary too — a refresh must not
        // erase the route/mismatch badges or the failure category chip.
        task.authRoute = s.authRoute
        task.failureCategory = s.failure?.category
        task.requestedAccess = s.requestedAccess
        task.effectiveAccess = s.effectiveAccess
        task.externalContextPolicy = s.externalContextPolicy
        task.tests = s.tests ?? []
        task.applyPaidBudget(s.paidBudget)
        task.reviewerPanel = s.reviewerPanel
        task.protectedPathApprovals = s.protectedPathApprovals
        task.browserRequirementDetail = browserRequirementDetail(s.requestRequirements)
        // Surfaces project engine telemetry only: when the artifact is absent
        // (legacy / mid-run) the UI says "telemetry unavailable", never a guess.
        if s.webEvidence?.available == false {
            task.webEvidenceStatus = nil
            task.webEvidenceDetail = "Web/tool telemetry unavailable for this run (predates telemetry.yaml or still running)."
        } else {
            task.webEvidenceStatus = s.webEvidence?.status
            task.webEvidenceDetail = Self.webEvidenceDetail(s.webEvidence)
        }
        task.artifactPaths = s.failure.map { ($0.rawDetailRef.map { [$0] } ?? []) + $0.eventRefs + $0.logRefs } ?? []
        if let failure = s.failure {
            task.diagnosticText = failure.safeMessage
        }
        return task
    }
    private static func prettyTitle(_ id: String) -> String {
        "Live run · " + String(id.suffix(8))
    }

    private static func webEvidenceDetail(_ evidence: WebEvidence?) -> String? {
        guard let evidence, evidence.attempted || evidence.required else { return nil }
        var parts = ["web \(evidence.status)"]
        if let effective = evidence.effectiveMode, effective != evidence.mode {
            parts.append("requested \(evidence.mode) → ran \(effective)")
        }
        if let tool = evidence.tool { parts.append(tool) }
        if let target = evidence.target { parts.append(target) }
        if let error = evidence.errorSummary { parts.append(error) }
        return parts.joined(separator: " · ")
    }
    // MARK: Commands

    func startRun(prompt: String, mode: RunMode, harnesses: [HarnessFamily], primary: HarnessFamily?,
                  routingGoal: String, model: String?, n: Int, capUsd: Double?,
                  access: String = "workspace_write", web: String = "auto",
                  tests: [TestCommandInvocation] = [], reviewerPanel: [ReviewerPanelEntry]? = nil,
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
            status: .queued,
            project: launchProjectName,
            specTitle: nil,
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
        optimistic.reviewerPanel = reviewerPanel
        optimistic.protectedPathApprovals = protectedPathApprovals
        liveTasks.insert(optimistic, at: 0)
        route = .task(optimistic.id)

        guard let client else {
            if let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id }) {
                liveTasks[idx].status = .failed
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
                        status: .running, project: prev.project, specTitle: nil, harnesses: prev.harnesses,
                        n: prev.n, createdAt: prev.createdAt, updatedAt: .now,
                        spendUsd: prev.spendUsd, capUsd: prev.capUsd,
                        spendKnown: false, capKnown: prev.capKnown,
                        routeProof: .unverified, attentionNote: nil,
                        plan: [], activity: prev.activity, candidates: [], findings: [], diff: [],
                        isLive: true)
                    started.runDir = info.runDir
                    started.repoRoot = prev.repoRoot
                    started.tests = prev.tests
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
                        status: .queued, project: prev.project, specTitle: nil, harnesses: prev.harnesses,
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
                    row.reviewerPanel = prev.reviewerPanel
                    row.protectedPathApprovals = prev.protectedPathApprovals
                    if let idx { liveTasks[idx] = row } else { liveTasks.insert(row, at: 0) }
                    route = .task(info.jobId)
                }
            }
        } catch {
            if let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id }) {
                liveTasks[idx].status = .failed
                liveTasks[idx].engineError = "Failed to start: \(error)"
                liveTasks[idx].diagnosticText = liveTasks[idx].engineError
                liveTasks[idx].activity.append(ActivityEvent(.system, "Failed to start: \(error)"))
            }
        }
    }

    func cancel(_ id: String) async {
        guard let client else { return }
        do {
            try await client.cancel(runId: id)
            // Record the cancel authoritatively. When the live row already exists we
            // flip it; but in the bound-but-NOT-yet-hydrated window there is no row to
            // flip, and the head turn's EMBEDDED card still reads "running" — so the
            // composer would stay stuck on Stop after a successful cancel. Remember the
            // cancelled id so `composerTurnState` reports it inactive immediately,
            // until the real (cancelled) row hydrates. runIds are unique, so this is
            // always-correct for that id and never needs pruning for correctness.
            cancelledRunIds.insert(id)
            if let idx = liveTasks.firstIndex(where: { $0.id == id }) {
                liveTasks[idx].status = .cancelled
                liveTasks[idx].updatedAt = .now
            }
        } catch {
            // leave the row's status untouched if the server did not confirm the cancel
        }
    }

    // MARK: Threads (chat/session-first)

    /// Returns true when the list now REFLECTS server truth (incl. the honest
    /// 501 empty state); false on transport failure (last-known rows kept) so
    /// the ping watermark can surrender instead of dropping future pings.
    @discardableResult
    func refreshThreads() async -> Bool {
        guard let client else { return false }
        do {
            let list = try await client.listThreads()
            threads = list.threads
            if list.droppedThreads > 0 {
                // Per-row salvage disclosed: the store carried rows this
                // app build cannot decode — say so instead of hiding them.
                threadStatus = "\(list.droppedThreads) thread(s) could not be decoded by this app version and are hidden."
            } else if threadStatus?.contains("could not be decoded") == true {
                // The condition is gone; a stale warning must not linger.
                threadStatus = nil
            }
            return true
        } catch let GatewayError.http(status, _) where status == 501 {
            // Engine builds without thread support: honestly empty.
            threads = []
            return true
        } catch {
            // A transport/decode failure is NOT an empty thread list: keep the
            // last-known rows and surface the error.
            threadStatus = "Could not refresh threads: \(userMessage(for: error))"
            return false
        }
    }

    /// The thread the conversation is currently showing (detail preferred — it is
    /// the freshest copy after a PATCH/turn — falling back to the list summary).
    var currentThread: ThreadSummary? {
        if let d = selectedThreadDetail { return d.thread }
        if let id = selectedThreadId { return threads.first { $0.id == id } }
        return nil
    }

    /// The repo bound to a SPECIFIC thread (the freshest copy for the selected one,
    /// else the list summary). Used by thread-scoped spec actions so they resolve
    /// the owning thread's repo, not whatever is selected when the await resolves.
    func threadRepoRoot(_ tid: String) -> String? {
        if tid == selectedThreadId, let d = selectedThreadDetail { return d.thread.repoRoot }
        return threads.first { $0.id == tid }?.repoRoot
    }

    /// The eligible pool bound to a SPECIFIC thread, not live selection. Used by
    /// card actions that carry their owning thread id and may run after selection
    /// changes.
    func threadEligiblePool(_ tid: String) -> [String] {
        if tid == selectedThreadId, let d = selectedThreadDetail {
            let sticky = d.thread.eligibleHarnesses ?? []
            if !sticky.isEmpty { return sticky }
        }
        let sticky = threads.first { $0.id == tid }?.eligibleHarnesses ?? []
        if !sticky.isEmpty { return sticky }
        return settingsSnapshot?.routing.eligibleHarnesses ?? []
    }

    /// The selected thread's HEAD turn runId — the CANCEL target. Present as soon
    /// as the head turn binds a runId, EVEN BEFORE its live `TaskRun` row hydrates
    /// (so Stop is actionable in that window). nil only during the 202 pre-bind
    /// window, where there is nothing to cancel yet.
    var selectedHeadRunId: String? {
        // Prefer the loaded detail's head turn runId; during the detail-load window
        // (detail not yet this thread) fall back to the thread summary's headRunId so
        // Stop stays actionable for a thread you just selected while it's still live.
        if selectedThreadDetail?.thread.id == selectedThreadId,
           let runId = selectedThreadDetail?.turns.last?.runId {
            return runId
        }
        return threads.first { $0.id == selectedThreadId }?.headRunId
    }

    /// The composer Send/Stop affordance for the head turn, resolved by the pure
    /// Kit core (`resolveComposerTurnState`) so every window is unit-tested. See
    /// `ComposerTurnState` for the precedence; the inputs are:
    ///  - headRunId: the cancel target (nil = 202 pre-bind window).
    ///  - hydratedRowActive: the live row's `isActive` once it has merged into
    ///    `liveTasks` (authoritative — reflects cancel/completion); nil otherwise.
    ///  - embeddedStateActive: the embedded run-card state (fallback while no live
    ///    row has hydrated — covers the 202 and bound-but-not-hydrated windows).
    var composerTurnState: ComposerTurnState {
        // Trust the loaded detail ONLY when it actually belongs to the selected
        // thread. openThread sets selectedThreadId BEFORE the detail arrives, so
        // during that load window selectedThreadDetail is still the PREVIOUS thread's
        // (or nil) — using it would judge the wrong thread. `.idle` here makes the
        // composer's busy-gate fall back to the thread-summary head run (isThreadBusy).
        guard selectedThreadDetail?.thread.id == selectedThreadId,
              let last = selectedThreadDetail?.turns.last else { return .idle }
        let headRunId = last.runId
        // hydratedRowActive is authoritative when known: a run WE cancelled is
        // inactive even before its (cancelled) live row hydrates — otherwise the
        // composer would stay on Stop after a successful cancel in the not-yet-
        // hydrated window (the embedded card still says "running").
        let hydratedRowActive: Bool? = headRunId.flatMap { id in
            cancelledRunIds.contains(id) ? false : task(id)?.status.isActive
        }
        let embeddedStateActive = last.run.map { RunStatus(api: $0.state).isActive } ?? false
        return resolveComposerTurnState(headRunId: headRunId,
                                        hydratedRowActive: hydratedRowActive,
                                        embeddedStateActive: embeddedStateActive)
    }

    /// Is a specific thread too busy to accept a new turn? A submit in flight blocks
    /// ALL threads (the engine processes one turn-start at a time). The SELECTED
    /// thread is judged by its rich `composerTurnState` (embedded + hydrated). A
    /// NON-selected target (Implement plan/spec on a card whose owning thread isn't
    /// current) is judged from its thread-summary head run via the global `liveTasks`
    /// list (refreshRuns loads all runs), honoring a pending cancel — so the client
    /// busy gate holds for those too, not only the per-thread server serialization.
    func isThreadBusy(_ id: String?) -> Bool {
        if turnSubmitting { return true }
        guard let id else { return false }
        // Rich state ONLY when this thread's detail is actually loaded (the selected
        // thread, post-hydration). During openThread's load window the detail is the
        // previous thread's, so fall through to the summary head run below.
        if id == selectedThreadId, selectedThreadDetail?.thread.id == id {
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
        guard let headRunId = threads.first(where: { $0.id == id })?.headRunId else { return false }
        if cancelledRunIds.contains(headRunId) { return false }
        return task(headRunId)?.status.isActive ?? false
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
        let resolved = sticky ?? settingsSnapshot?.routing.primaryHarness
        // Honesty guard: never SURFACE a primary that is outside a non-empty effective
        // pool — the engine wouldn't route to it (it drops/clears such a primary), so
        // showing it would be a lie. This also covers the draft case where the primary
        // comes from the GLOBAL default while the pool is a narrower draft pool.
        let pool = effectiveEligiblePool
        if let r = resolved, !pool.isEmpty, !pool.contains(r) { return nil }
        return resolved
    }

    /// Eligible harness pool (Best-of runs this; one candidate per harness): thread
    /// sticky > global default. Empty => engine auto-pools doctor-ok harnesses.
    var effectiveEligiblePool: [String] {
        let sticky = selectedThreadId == nil ? draftEligiblePool : (currentThread?.eligibleHarnesses ?? [])
        if !sticky.isEmpty { return sticky }
        return settingsSnapshot?.routing.eligibleHarnesses ?? []
    }

    /// Switch the sticky primary harness. On a real thread this PATCHes the thread
    /// (persists, survives reload); on a draft it updates the local draft value.
    /// Thin gateway: the engine owns routing — orderPool just pins primary first.
    func setPrimaryHarness(_ harness: String?) async {
        guard let id = selectedThreadId else { draftPrimaryHarness = harness; return }
        guard let client else { threadStatus = "Engine offline — reconnect to change the primary harness."; return }
        do {
            let updated = try await client.updateThread(id: id, body: UpdateThreadRequest(primaryHarness: .some(harness)))
            applyThreadUpdate(updated)
        } catch { threadStatus = userMessage(for: error) }
    }

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
        guard let client else { threadStatus = "Engine offline — reconnect to change the harness pool."; return }
        do {
            let updated = try await client.updateThread(id: id, body: UpdateThreadRequest(eligibleHarnesses: pool))
            applyThreadUpdate(updated)
        } catch { threadStatus = userMessage(for: error) }
    }

    /// Apply a PATCH-thread response OPTIMISTICALLY: update the list row and the
    /// open detail in place from the returned `ThreadSummary` — no heavy
    /// `refreshThreads()` + `openThread()` re-fetch (which re-hydrated everything,
    /// flickered, and conflated a later GET's error with the PATCH).
    func applyThreadUpdate(_ updated: ThreadSummary) {
        threadStatus = nil
        if let i = threads.firstIndex(where: { $0.id == updated.id }) { threads[i] = updated }
        if selectedThreadId == updated.id, let detail = selectedThreadDetail {
            selectedThreadDetail = ThreadDetailResponse(thread: updated, sessions: detail.sessions, turns: detail.turns)
        }
    }

    /// Apply an ISOLATED thread's accumulated worktree diff to its project. Returns
    /// nil on success, else an honest message (empty/conflict/rejected, or a transport
    /// error). On success refreshes the thread (its head/state may have moved).
    func applyThread(id: String, mode: String = "apply") async -> String? {
        guard let client else { return "Engine offline — reconnect to apply this thread." }
        do {
            let res = try await client.applyThread(id: id, body: ThreadApplyRequest(mode: mode))
            if res.applied {
                await refreshThreads()
                await openThread(id)
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

    func newThread(title: String?) async {
        guard let client else {
            threadStatus = "Engine offline: reconnect before creating a thread."
            return
        }
        let scope: RunScope = normalizedProjectRoot.isEmpty ? .none : .project(root: normalizedProjectRoot)
        do {
            // Materialize the draft routing onto the new thread (sticky from turn one).
            // Send the GUARDED primary (`effectivePrimaryHarness` already returns nil
            // when the resolved primary — including the global-settings fallback —
            // falls outside the effective pool), so an inconsistent global config can't
            // persist a primary the engine's pool-fallback would reject on the first
            // turn. The empty draft pool stays omitted (engine inherits the global pool,
            // the same pool the guard checked against).
            let thread = try await client.createThread(CreateThreadRequest(
                title: title,
                scope: scope,
                // Isolated => turns accumulate in a thread worktree (applied later);
                // in_place is the engine default, so omit it rather than send it.
                workspace: draftIsolatedWorkspace ? "isolated" : nil,
                primaryHarness: effectivePrimaryHarness,
                eligibleHarnesses: draftEligiblePool.isEmpty ? nil : draftEligiblePool
            ))
            threads.insert(thread, at: 0)
            await openThread(thread.id)
        } catch {
            threadStatus = "Could not create thread: \(userMessage(for: error))"
        }
    }

    /// Send from the composer. If no thread is selected (the empty/draft state),
    /// the FIRST message MATERIALIZES a thread on the Current Project — an empty
    /// chat composer is never a silent no-op (the v0.9 bug). Returns once sent.
    /// Returns true when the turn was accepted by the engine (so the composer can
    /// clear its text). A POST-send thread reload failure does NOT make this false
    /// (the turn is already on the server) — that would risk a duplicate send.
    @discardableResult
    /// `onThread` binds the turn to a SPECIFIC owning thread (Implement-plan /
    /// Implement-spec capture their card's thread at tap time). When nil, the turn
    /// targets the current selection and materializes a draft thread if needed.
    /// Binding the target removes the thread-selection race: an action begun on one
    /// thread can't be re-pointed at a different thread the user switched to during
    /// the async send.
    func composerSend(prompt: String, mode: RunMode, planRunId: String? = nil, specPath: String? = nil, model: String? = nil, attachments: [PendingAttachment] = [], options: TurnOptions = .init(), onThread explicitThreadId: String? = nil) async -> Bool {
        let targetId = explicitThreadId ?? selectedThreadId
        // Single busy gate for EVERY turn-start path (composer, Implement-plan,
        // Implement-spec all funnel through here), so none can start a turn over a
        // live one — gated on the TARGET thread, not live selection. `isThreadBusy`
        // folds in `turnSubmitting`, so this also blocks a double-submit during the
        // pre-detail window (checked synchronously before `turnSubmitting = true`, so
        // concurrent main-actor calls can't both pass). The composer's send() also
        // routes ⌘↩→Stop while busy; non-composer buttons rely on this guard.
        guard !isThreadBusy(targetId) else {
            threadStatus = "Wait for the running turn to finish, or Stop it, before starting another."
            return false
        }
        turnSubmitting = true
        defer { turnSubmitting = false }
        var threadId = targetId
        if threadId == nil {
            await newThread(title: nil)
            threadId = selectedThreadId
            guard threadId != nil else { return false } // newThread set threadStatus on failure
        }
        guard let tid = threadId else { return false }
        return await sendTurn(threadId: tid, prompt: prompt, mode: mode, planRunId: planRunId, specPath: specPath, model: model, attachments: attachments, options: options)
    }

    /// Trim + drop empty entries; nil when nothing remains (key omitted on the wire).
    private func normalizedTurnModels(_ models: [String: String]) -> [String: String]? {
        let cleaned = models.compactMapValues { value -> String? in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return cleaned.isEmpty ? nil : cleaned
    }

    /// Send a follow-up turn; returns true if the engine ACCEPTED it. The native
    /// session resumes (plan -> implement is one conversation).
    @discardableResult
    func sendTurn(threadId: String, prompt: String, mode: RunMode, planRunId: String? = nil, specPath: String? = nil, model: String? = nil, attachments: [PendingAttachment] = [], options: TurnOptions = .init()) async -> Bool {
        guard let client else {
            threadStatus = "Engine offline — reconnect before sending."
            return false
        }
        // `.spec` is NOT a wire turn — it is driven client-side via startSpec
        // (questions) + implementSpec (which sends an .agent turn with specPath).
        // Reject both the sentinel mode and a leaked spec mode loudly here.
        guard mode != .unknown, mode != .spec else {
            threadStatus = "Unknown mode — pick an intent from the composer."
            return false
        }
        let flags = mode.strategyFlags
        // Best-of runs the eligible pool: one candidate per AVAILABLE harness. Send the
        // pool EXPLICITLY (what the user sees races) and size n to that same set, so
        // the engine never wraps a too-large n back over a smaller resolved pool
        // (which would race a harness against itself). Other modes send no harnesses
        // and inherit the thread's sticky pool server-side (primary too).
        var racePool: [String] = []
        if mode == .bestOfN {
            let available = effectiveEligiblePool.filter { id in
                let family = HarnessFamily(rawValue: id)
                return availability(for: family, mode: mode).available
            }
            racePool = available.isEmpty ? effectiveEligiblePool : available
        }
        // Best-of width = one candidate per harness in the pool (≥2). A SINGLE-harness
        // pool can't race against itself: send n=1 so the engine single-routes that
        // one harness instead of duplicating it (a wasteful self-race). An EMPTY pool
        // (auto) keeps the default 2 so the engine auto-pools two doctor-ok harnesses.
        let raceN: Int?
        if mode == .bestOfN {
            raceN = racePool.count == 1 ? 1 : max(2, racePool.count)
        } else {
            raceN = nil
        }
        // Until Clean / Max Attempts are SINGLE-candidate repair strategies — the
        // engine routes them to convergence (ignoring n), so they only make sense
        // for a plain agent turn, never for Best-of. access/web/budget are per-turn.
        let writeMode = !mode.isReadOnly
        let repairMode = mode == .agent
        let result: RunStartResult
        do {
            let attachmentRefs = try await uploadAttachments(attachments, client: client)
            result = try await client.sendTurn(threadId: threadId, body: ThreadTurnRequest(
                prompt: prompt,
                mode: mode.apiValue,
                harnesses: racePool.isEmpty ? nil : racePool,
                n: raceN,
                // "Until clean" and "Max attempts" are mutually exclusive repair
                // strategies (no-fixed-cap vs hard-cap) — never send both. Until-clean
                // wins: drop the attempts cap when it's on.
                attempts: (repairMode && !options.untilClean) ? options.maxAttempts : nil,
                untilClean: (repairMode && options.untilClean) ? true : (flags.untilClean ? true : nil),
                swarm: flags.swarm ? true : nil,
                create: flags.create ? true : nil,
                paidBudget: options.maxUsd.map { .finite(maxUsd: $0) },
                // Per-turn model override (empty = harness default → don't send the key).
                model: model.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 },
                // Harness-scoped map: specific beats the scalar and defaults.
                models: normalizedTurnModels(options.models),
                reviewerPanel: options.reviewerPanel,
                access: writeMode ? options.access : nil,
                web: options.web,
                browser: options.browser ? true : nil,
                planRunId: planRunId,
                specPath: specPath,
                attachments: attachmentRefs.isEmpty ? nil : attachmentRefs,
                protectedPathApprovals: options.protectedPathApprovals,
                authPreference: options.authRoute,
                effort: options.effort
            ))
        } catch {
            // A REFUSED turn is not a lost turn: when the server persisted the
            // refusal on a recorded turn (the error body carries its turnId),
            // reload the thread so the inline card shows IMMEDIATELY.
            if let refusal = Self.refusedTurn(from: error) {
                await refreshRuns()
                await openThread(threadId)
                if refusal.retryable {
                    // The prompt lives on the refused turn and Retry replays
                    // it — report "sent" so the composer clears (no duplicate
                    // unsent draft).
                    threadStatus = nil
                    return true
                }
                // NOT retryable (no recorded job to replay): keep the draft —
                // "send a new message" is the remedy the card states.
                threadStatus = userMessage(for: error)
                return false
            }
            threadStatus = userMessage(for: error)
            return false
        }
        // The turn is ACCEPTED here. Anything below (refresh/reload) is best-effort
        // presentation; its failure must NOT be read as a send failure.
        threadStatus = nil
        await refreshRuns()
        await openThread(threadId)
        if case .started(let info) = result {
            stream(runId: info.runId)
        }
        return true
    }

    // MARK: SPEC-FLOW (server-owned interview)

    /// Set/clear the SPEC-FLOW state for a given thread (keyed per thread so a
    /// thread switch hides a non-current card and a late await records on its own
    /// thread). Writing is unconditional on the current selection: the getter
    /// already gates visibility by `selectedThreadId`.
    private func setSpecFlow(_ state: SpecFlowState?, for threadId: String) {
        specFlowByThread[threadId] = state
    }

    /// Bump and return the SPEC-FLOW generation for a thread (called at every
    /// start / submit / cancel so an older in-flight await can detect it is stale).
    private func nextSpecGen(_ tid: String) -> Int {
        let g = (specFlowGen[tid] ?? 0) + 1
        specFlowGen[tid] = g
        return g
    }

    /// True while `gen` is still the live generation for `tid` — i.e. no newer
    /// start/submit/cancel superseded the in-flight request that captured it.
    private func isCurrentSpecGen(_ tid: String, _ gen: Int) -> Bool {
        specFlowGen[tid] == gen
    }

    /// Begin the SPEC-FLOW: resolve/create a thread (reusing the existing draft
    /// bootstrap), require a project, then create a durable spec session.
    /// Empty questions => freeze directly (nothing to ask). The
    /// question card and the frozen card both render off `specFlow`.
    ///
    /// Returns TRUE when the flow was accepted OR an error CARD was established (any
    /// path that left durable UI state for the thread). Returns FALSE on a HARD
    /// failure with no durable state (engine offline / no project / no thread) — the
    /// caller should then RESTORE the composer text, mirroring how composerSend
    /// failures preserve the prompt. The discardable annotation keeps existing
    /// fire-and-forget callers compiling.
    @discardableResult
    func startSpec(prompt: String, model: String = "", options: TurnOptions = .init()) async -> Bool {
        guard let client else {
            threadStatus = "Engine offline — reconnect before starting a spec."
            return false
        }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        // A spec is project-scoped: the grounding plan reads the repo. Resolve the
        // repo BEFORE materializing a thread (mirrors composerSend's ordering) so the
        // no-project path fails loud WITHOUT leaving an empty orphan draft thread.
        // Prefer the selected thread's bound repo, fall back to the Current Project.
        let repoRoot = currentThread?.repoRoot?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? normalizedProjectRoot
        guard !repoRoot.isEmpty else {
            threadStatus = "Spec needs a project — pick one before starting an interview."
            return false
        }
        // Materialize a thread the same way composerSend does, so spec turns and
        // the eventual Implement turn share one conversation/native session.
        var threadId = selectedThreadId
        if threadId == nil {
            await newThread(title: nil)
            threadId = selectedThreadId
            guard threadId != nil else { return false }  // newThread set threadStatus
        }
        guard let tid = threadId else { return false }
        // Past this point a durable spec CARD exists for `tid` (grounding → questions /
        // freeze / error), so every remaining path returns true: a thread switch leaves
        // that card intact and the engine error surfaces in-card, not via lost text.
        // A fresh generation supersedes any in-flight grounding for this thread.
        let gen = nextSpecGen(tid)
        // Remember the composer's per-turn model + options for the eventual Implement
        // turn (the grounding/freeze run read-only; these apply to the write turn).
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        specPendingModel[tid] = trimmedModel.isEmpty ? nil : trimmedModel
        specPendingOptions[tid] = options
        specPrior[tid] = []  // fresh interview: drop any accumulated decisions
        setSpecFlow(.grounding, for: tid)  // "running the grounding plan" while it runs (minutes)
        threadStatus = nil
        // Honor the user's eligible pool for the grounding plan too (the composer
        // exposes pool chips while Spec is selected) — otherwise the questions could
        // come from a harness outside the pool the Implement turn will use. Empty =>
        // engine default (nil). Same pool a normal turn resolves.
        let pool = effectiveEligiblePool
        do {
            let res = try await client.specQuestions(
                SpecQuestionsRequest(prompt: trimmed, scope: .project(root: repoRoot),
                                     harnesses: pool.isEmpty ? nil : pool)
            )
            // State is keyed by `tid`, so record the result on its OWNING thread even
            // if the user switched away during the long await (the getter hides a
            // non-current card). This prevents a stranded `.grounding` spinner. But
            // DROP the write if a newer start/cancel superseded this grounding.
            guard isCurrentSpecGen(tid, gen) else { return true }
            if res.questions.isEmpty {
                // Nothing to clarify: freeze straight from the grounding plan (no
                // prior questions to preserve — pass them explicitly, not re-read).
                await freezeSpec(prompt: trimmed, repoRoot: repoRoot, planDir: res.planDir,
                                 answers: [], threadId: tid, gen: gen,
                                 priorQuestions: [], priorPlanRunId: "")
            } else {
                setSpecFlow(.askingQuestions(prompt: trimmed, questions: res.questions, planDir: res.planDir,
                                             planRunId: res.planRunId, answers: [], error: nil), for: tid)
            }
        } catch {
            guard isCurrentSpecGen(tid, gen) else { return true }
            setSpecFlow(.error(userMessage(for: error)), for: tid)
        }
        return true
    }

    /// Submit the user's interview answers and freeze the SpecPack. On an
    /// unresolved-clarifications 400 the question card STAYS open with the server's
    /// reason (no silent guessing); on success the flow advances to `.frozen`.
    func submitSpecAnswers(threadId tid: String, answers: [SpecAnswer]) async {
        // Bound to the OWNING thread (passed by the card), not live selection — a
        // thread switch during the freeze can't mis-apply or drop the answers.
        guard case .askingQuestions(let prompt, let questions, let planDir, let planRunId, _, _) = specFlowByThread[tid] else { return }
        guard let repoRoot = threadRepoRoot(tid)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !repoRoot.isEmpty else {
            setSpecFlow(.error("Spec needs a project — the owning thread has no repo."), for: tid)
            return
        }
        // A fresh generation supersedes any in-flight freeze for this thread.
        let gen = nextSpecGen(tid)
        // The freeze prompt is the user's ORIGINAL spec intent, carried on
        // `.askingQuestions` since startSpec; the durable session retains the exact
        // prompt the grounding plan ran on (not the stale head-turn prompt, which on a fresh
        // thread is generic and on an existing thread is the PREVIOUS turn's). The
        // current questions/planRunId are passed EXPLICITLY (not re-read from mutable
        // state) so a 400 can re-open the SAME card.
        await freezeSpec(prompt: prompt, repoRoot: repoRoot, planDir: planDir,
                         answers: answers, threadId: tid, gen: gen,
                         priorQuestions: questions, priorPlanRunId: planRunId)
    }

    /// Shared freeze step (used by both the empty-questions fast path and the
    /// answered path). Keeps the question card open on an unresolved-clarifications
    /// 400 by re-deriving the asking state with the error attached. `priorQuestions`/
    /// `priorPlanRunId` are passed in by the caller (not re-read from mutable state),
    /// and `gen` guards the post-await writes against a superseding start/cancel.
    /// Multi-tier interview: record this tier's answers as prior decisions and
    /// re-run the grounding for the NEXT, DEEPER tier — or freeze if the model has no
    /// further questions. Drives the 8A backend (`priorDecisions`).
    func askDeeperSpec(threadId tid: String, decisions: [SpecPriorDecision]) async {
        guard let client else { setSpecFlow(.error("Engine offline — reconnect before continuing."), for: tid); return }
        guard case .askingQuestions(let prompt, _, _, _, _, _) = specFlowByThread[tid] else { return }
        guard let repoRoot = threadRepoRoot(tid)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !repoRoot.isEmpty else {
            setSpecFlow(.error("Spec needs a project — the owning thread has no repo."), for: tid)
            return
        }
        specPrior[tid] = (specPrior[tid] ?? []) + decisions
        let gen = nextSpecGen(tid)
        setSpecFlow(.grounding, for: tid)  // re-grounding the repo for the deeper tier (minutes)
        let pool = threadEligiblePool(tid)
        do {
            let res = try await client.specQuestions(
                SpecQuestionsRequest(prompt: prompt, scope: .project(root: repoRoot),
                                     harnesses: pool.isEmpty ? nil : pool, priorDecisions: specPrior[tid])
            )
            guard isCurrentSpecGen(tid, gen) else { return }
            if res.questions.isEmpty {
                // The model has no further open decisions: freeze the deeper-grounded plan.
                await freezeSpec(prompt: prompt, repoRoot: repoRoot, planDir: res.planDir,
                                 answers: [], threadId: tid, gen: gen, priorQuestions: [], priorPlanRunId: "")
            } else {
                setSpecFlow(.askingQuestions(prompt: prompt, questions: res.questions, planDir: res.planDir,
                                             planRunId: res.planRunId, answers: [], error: nil), for: tid)
            }
        } catch {
            guard isCurrentSpecGen(tid, gen) else { return }
            setSpecFlow(.error(userMessage(for: error)), for: tid)
        }
    }

    private func freezeSpec(prompt: String, repoRoot: String, planDir: String,
                            answers: [SpecAnswer], threadId tid: String, gen: Int,
                            priorQuestions: [SpecQuestion], priorPlanRunId: String) async {
        guard let client else {
            setSpecFlow(.error("Engine offline — reconnect before freezing the spec."), for: tid)
            return
        }
        setSpecFlow(.freezing, for: tid)
        do {
            let res = try await client.specFreeze(
                // priorDecisions = every EARLIER tier's decisions (the current tier
                // rides `answers`); folded into the frozen SpecPack so a multi-tier
                // spec doesn't lose tiers 0..N-1.
                SpecFreezeRequest(prompt: prompt, scope: .project(root: repoRoot),
                                  planDir: planDir, answers: answers,
                                  priorDecisions: specPrior[tid] ?? [])
            )
            // Keyed by `tid`: record on the owning thread even if the user navigated
            // away during the freeze await (the getter hides a non-current card), so
            // the card never strands at `.freezing`. DROP if superseded.
            guard isCurrentSpecGen(tid, gen) else { return }
            setSpecFlow(.frozen(specId: res.specId, specPath: res.specPath,
                                specHash: res.specHash, changes: res.changes.count), for: tid)
        } catch {
            guard isCurrentSpecGen(tid, gen) else { return }
            let message = userMessage(for: error)
            // Unresolved clarifications (and any freeze refusal): keep the question
            // card OPEN with the reason in its error slot so the user can answer the
            // missing fields — never guess.
            if !priorQuestions.isEmpty {
                setSpecFlow(.askingQuestions(prompt: prompt, questions: priorQuestions, planDir: planDir,
                                             planRunId: priorPlanRunId, answers: answers,
                                             error: message), for: tid)
            } else {
                setSpecFlow(.error(message), for: tid)
            }
        }
    }

    /// Implement a FROZEN spec: send an .agent turn carrying the spec FILE path
    /// (the orchestrator reads it and fails loud if unreadable). Clears the spec
    /// card on a successful send (the new turn renders the run).
    func implementSpec(threadId tid: String, specPath: String) async {
        // Bound to the OWNING thread (passed by the frozen card): the Implement turn
        // and the card-clear both target that thread, not live selection. Honor the
        // per-turn model + options the user set when they started the spec.
        let sent = await composerSend(prompt: "Implement the frozen spec.", mode: .agent,
                                      specPath: specPath, model: specPendingModel[tid],
                                      options: specPendingOptions[tid] ?? .init(), onThread: tid)
        if sent {
            setSpecFlow(nil, for: tid)
            specPendingModel[tid] = nil
            specPendingOptions[tid] = nil
        }
    }

    /// Dismiss the SPEC-FLOW (e.g. the user cancels the question card). Bumps the
    /// generation so a grounding/freeze still in flight can't RE-SHOW the dismissed
    /// card when its await returns (its write is dropped as stale).
    func cancelSpec(threadId tid: String) {
        // Thread-bound (the card passes its owning thread) so a dismiss can't clear a
        // different thread's spec if selection changed.
        _ = nextSpecGen(tid)
        setSpecFlow(nil, for: tid)
        specPendingModel[tid] = nil
        specPendingOptions[tid] = nil
    }

    /// Human-readable message for a gateway error (never a raw Swift dump in the UI).
    /// For HTTP failures it surfaces the SERVER's own error body (fail-loud — a bare
    /// "HTTP 400" hid the real reason during the v0.10 polish).
    func userMessage(for error: Error) -> String {
        switch error {
        case let gateway as GatewayError where gateway.controlProblem != nil:
            guard case GatewayError.http(let status, _) = gateway,
                  let problem = gateway.controlProblem else { return "Request failed." }
            let action = problem.requiredActions.first.map { " Required action: \($0)." } ?? ""
            return "Request failed (HTTP \(status), \(problem.code)): \(problem.message)\(action)"
        case GatewayError.http(let status, let body):
            if status == 501 { return "This engine build does not support threads. Update Claudexor." }
            if status == 404 { return "The engine is out of date — restart the daemon." }
            if let detail = serverErrorMessage(from: body) { return "Request failed (HTTP \(status)): \(detail)" }
            return "Request failed (HTTP \(status))."
        case is URLError:
            return "Cannot reach the engine — is the daemon running?"
        default:
            return "Something went wrong. Try again."
        }
    }

    /// Pull the engine's reason out of a failed HTTP body. Transport/gate errors use
    /// `{ "error": "..." }`; a refused decision (e.g. the 409 revert-refusal path)
    /// instead carries `ControlRunDecisionResponse.message` — so honor BOTH, else a
    /// rejection's concrete reason (the divergence message) is swallowed.
    private func serverErrorMessage(from body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let error = obj["error"] as? String, !error.isEmpty { return error }
        if let message = obj["message"] as? String, !message.isEmpty { return message }
        return nil
    }

    /// Typed operator decision on a blocked run (review queue actions).
    func decide(runId: String, action: String, feedback: String? = nil, acceptedRisks: [String]? = nil) async -> String? {
        guard let client else { return "Engine offline." }
        do {
            let res = try await client.decide(runId: runId, body: RunDecisionRequest(action: action, feedback: feedback, acceptedRisks: acceptedRisks ?? []))
            await refreshRuns()
            return res.accepted ? nil : (res.message ?? "Decision was not accepted (\(res.status)).")
        } catch {
            return "Decision failed: \(error)"
        }
    }

    /// Apply PRE-FLIGHT: dry-run the apply gate BEFORE the user presses Apply, so the
    /// UI shows WHY apply would be refused (the gate reason) up front instead of only
    /// on press. Returns nil when apply would proceed cleanly, or the server's honest
    /// refusal reason (the gate error body, or the patch's non-applying stderr).
    func applyCheck(runId: String) async -> String? {
        guard let client else { return "Engine offline." }
        do {
            let res = try await client.applyCheck(runId: runId)
            return res.ok ? nil : (res.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "The patch would not apply cleanly."
                : res.stderr)
        } catch {
            // The gate refusal (e.g. blocked/needs-human, secret-like token) comes
            // back as an HTTP error whose body carries the real reason — surface it.
            return userMessage(for: error)
        }
    }

    /// Revert this turn's in-place mutation through the server-owned restore. Returns
    /// nil on success, else the server's honest refusal (it refuses if the tree
    /// diverged from the recorded post-turn state). Refreshes the run/thread on success.
    func revertRun(runId: String) async -> String? {
        guard let client else { return "Engine offline." }
        do {
            let res = try await client.revertRun(runId: runId)
            guard res.accepted else { return res.message ?? "Revert was refused (\(res.status))." }
            await refreshRuns()
            await loadRunDetail(runId)
            if let tid = selectedThreadId { await openThread(tid) }
            return nil
        } catch {
            return userMessage(for: error)
        }
    }

    /// Deliver the user's answers for a pending interactive question. Returns
    /// an error message on failure (the question card surfaces it verbatim).
    func answerInteraction(runId: String, interactionId: String, answers: [InteractionAnswerPayload]) async -> String? {
        guard let client else { return "Engine offline: reconnect before answering." }
        do {
            let response = try await client.answerInteraction(runId: runId, interactionId: interactionId, answers: answers)
            guard response.accepted else {
                return response.message ?? "Answer was not accepted (\(response.status))."
            }
            if let idx = liveTasks.firstIndex(where: { $0.id == runId }) {
                liveTasks[idx].pendingInteractions.removeAll { $0.interactionId == interactionId }
                liveTasks[idx].waitingOnUser = !liveTasks[idx].pendingInteractions.isEmpty
                liveTasks[idx].updatedAt = .now
            }
            return nil
        } catch {
            return "Could not deliver the answer: \(error)"
        }
    }

    func loadRunDetail(_ id: String) async {
        guard let client, liveTasks.contains(where: { $0.id == id }) else { return }
        // Snapshot fence, write side: stream events arriving DURING this load
        // are deferred and re-applied after the snapshot lands. Without this,
        // the final `liveTasks[writeIdx] = task` write (built from a pre-await
        // copy) would erase them — and lastEventIds has already advanced past
        // their seq, so they would never be replayed.
        snapshotLoadDepth[id, default: 0] += 1
        defer {
            snapshotLoadDepth[id, default: 1] -= 1
            if snapshotLoadDepth[id] ?? 0 <= 0 {
                snapshotLoadDepth[id] = nil
                let deferred = deferredEnvelopes[id] ?? []
                deferredEnvelopes[id] = nil
                // Seq fence for the REPLAY too: the snapshot we just
                // merged reflects everything <= lastSeq; re-applying a
                // deferred envelope from that range would double-count spend
                // and duplicate timeline rows.
                let fence = snapshotReplayFences.removeValue(forKey: id) ?? 0
                for env in deferred where !(env.seq > 0 && env.seq <= fence) { apply(env, to: id) }
                if deferredOverflow.remove(id) != nil {
                    // W23: envelopes were dropped at the cap — a replay would be
                    // incomplete, so a FRESH snapshot supersedes them instead.
                    Task { await self.loadRunDetail(id) }
                }
            }
        }
        do {
            let detail = try await client.runDetail(runId: id)
            // Re-resolve the row BY ID after the await: refreshes/inserts may
            // have reordered liveTasks, and a stale index would merge this
            // snapshot into (and copy hydrated fields from) a DIFFERENT run.
            guard let baseIdx = liveTasks.firstIndex(where: { $0.id == id }) else { return }
            // Snapshot truth and stream progress are related but distinct: the
            // resume cursor may already be newer than this response.
            snapshotReplayFences[id] = max(snapshotReplayFences[id] ?? 0, detail.lastSeq)
            lastEventIds[id] = max(lastEventIds[id] ?? 0, detail.lastSeq)
            var task = liveTasks[baseIdx]
            task.status = RunStatus(api: detail.summary.state)
            task.mode = RunMode(apiValue: detail.summary.mode, strategy: detail.summary.strategy)
            task.operatorDecisionAction = detail.operatorDecisionAction
            if let result = detail.summary.result {
                task.applyState = result.applyState
                task.revertable = result.revertable
            }
            task.prompt = detail.summary.prompt ?? task.prompt
            if !task.prompt.isEmpty { task.title = String(task.prompt.prefix(64)) }
            task.project = detail.summary.project?.projectName ?? detail.summary.project?.root.map { URL(fileURLWithPath: $0).lastPathComponent } ?? task.project
            task.repoRoot = detail.summary.project?.root ?? task.repoRoot
            task.harnesses = (detail.summary.harnesses ?? []).compactMap { HarnessFamily(rawValue: $0) }
            task.applyPaidBudget(detail.summary.paidBudget)
            task.spendUsd = detail.summary.spendUsd ?? task.spendUsd
            task.spendKnown = detail.summary.spendUsd != nil || task.spendKnown
            task.spendEstimated = detail.summary.spendEstimated ?? task.spendEstimated
            let failure = detail.failure ?? detail.summary.failure
            task.engineError = failure?.safeMessage ?? detail.summary.error
            task.failureCategory = failure?.category
            task.runDir = detail.summary.runDir ?? failure?.runDir ?? task.runDir
            task.outputReadyState = detail.summary.outputReadyState
            task.pendingInteractions = detail.pendingInteractions
            task.waitingOnUser = detail.summary.waitingOnUser ?? !detail.pendingInteractions.isEmpty
            if let route = detail.summary.route {
                task.observedModel = route.observedModel
                task.routeProof = route.verified == true ? .verified : .unverified
            }
            task.authRoute = detail.summary.authRoute ?? task.authRoute
            task.requestedAccess = detail.summary.requestedAccess
            task.effectiveAccess = detail.summary.effectiveAccess
            task.externalContextPolicy = detail.summary.externalContextPolicy
            task.tests = detail.summary.tests ?? task.tests
            task.reviewerPanel = detail.summary.reviewerPanel
            task.protectedPathApprovals = detail.summary.protectedPathApprovals
            task.browserRequirementDetail = browserRequirementDetail(detail.summary.requestRequirements)
            if detail.summary.webEvidence?.available == false {
                task.webEvidenceStatus = nil
                task.webEvidenceDetail = "Web/tool telemetry unavailable for this run (predates telemetry.yaml or still running)."
            } else {
                task.webEvidenceStatus = detail.summary.webEvidence?.status
                task.webEvidenceDetail = Self.webEvidenceDetail(detail.summary.webEvidence)
            }
            task.artifactPaths = detail.artifacts.map(\.path)
            // Live plan checklist + candidate cards: mapping owned
            // by RunDetailMapping.swift.
            if let planItems = RunDetailMapping.planItems(detail.planProgress) { task.plan = planItems }
            task.candidates = RunDetailMapping.candidates(detail.candidates, runStatus: task.status)
            if let budget = detail.budget {
                if let cap = budget.maxUsd { task.capUsd = cap }
                if let spend = budget.spendUsd { task.spendUsd = spend }
                task.capKnown = budget.maxUsd != nil
                task.spendKnown = budget.spendUsd != nil
                task.spendEstimated = budget.estimated
            }
            // Seed the live box's spend from the snapshot (authoritative up to
            // lastSeq): post-fence budget.observation increments then add ON
            // TOP — same "seed from replay OR summary, never both" rule.
            if let box = liveBoxes[id], task.spendKnown {
                box.spendUsd = task.spendUsd
                box.spendKnown = true
                box.spendEstimated = task.spendEstimated
            }
            if let final = detail.finalSummary, !final.isEmpty,
               !task.activity.contains(where: { $0.title == "Final summary" }) {
                task.activity.append(ActivityEvent(.message, "Final summary", detail: final))
            }
            if let primary = detail.primaryOutput, let text = primary.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if primary.kind == "diagnostic" {
                    task.diagnosticText = text
                    task.answerText = nil
                } else if primary.kind == "patch" {
                    // A raw diff is NEVER markdown-rendered as the Outcome; it
                    // belongs to the Diff tab (parsed below).
                    task.answerText = nil
                } else {
                    task.answerText = text
                }
            } else {
                task.answerText = await firstArtifactText(client: client, runId: id, paths: ["final/answer.md", "final/explore.md", "final/report.md", "final/plan.md", "final/summary.md"])
            }
            // Diff tab truth: load and parse the final patch artifact when present.
            if task.diff.isEmpty, detail.artifacts.contains(where: { $0.path == "final/patch.diff" }) {
                if let patchText = try? await client.artifactText(runId: id, path: "final/patch.diff"),
                   !patchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    task.diff = Self.parseUnifiedDiff(patchText)
                }
            }
            if !detail.timeline.isEmpty {
                task.activity = detail.timeline.map(Self.activityEvent(from:))
                // A STREAMING run's feed lives in its box (views read the box
                // overlay): the snapshot timeline is authoritative up to
                // lastSeq, so it replaces the SSE-accumulated feed (the ring
                // counter resets with it — the server snapshot carries its own
                // truncation marker); deferred envelopes past the fence
                // re-append after this load.
                if let box = liveBoxes[id] {
                    box.activity = task.activity
                    box.activityDropped = 0
                }
            }
            task.diagnosticText = await diagnosticText(client: client, runId: id, detail: detail, error: task.engineError)
            let persistedFindings = detail.reviewFindings.compactMap { Self.finding(from: $0, taskTitle: task.title) }
            if !persistedFindings.isEmpty {
                task.findings = persistedFindings
            }
            task.reviewVerdict = RunDetailMapping.reviewVerdict(
                decision: detail.decision, candidates: detail.candidates,
                findings: task.findings, failure: failure, status: task.status
            )
            if !detail.artifacts.isEmpty, task.plan.isEmpty, task.mode == .plan {
                // Only the actual SpecPack artifact is a "plan" row; arbitrary
                // nested paths must not be synthesized into plan steps.
                task.plan = detail.artifacts
                    .filter { $0.kind == "file" && $0.path == "final/plan.md" }
                    .map { PlanItem($0.path, .done, note: $0.bytes.map { "\($0) bytes" }) }
            }
            // Re-resolve the row index at WRITE time: streams/refreshes may have
            // inserted or removed rows during the awaits above.
            if let writeIdx = liveTasks.firstIndex(where: { $0.id == id }) {
                liveTasks[writeIdx] = task
            }
        } catch {
            if let idx = liveTasks.firstIndex(where: { $0.id == id }) {
                liveTasks[idx].engineError = "Could not load run detail: \(error)"
                liveTasks[idx].diagnosticText = liveTasks[idx].engineError
                liveTasks[idx].updatedAt = .now
            }
        }
    }

    func storeSecret(name: String, value: String, for family: HarnessFamily) async -> (stored: Bool, readinessRefreshed: Bool) {
        guard let client else { return (false, false) }
        do {
            try await client.setSecret(name: name, value: value)
            await refreshSecrets()
            guard let request = family.apiKeyAuthReadinessRequest else { return (true, false) }
            return (true, await refreshAuthReadiness(for: family, request: request))
        } catch {
            return (false, false)
        }
    }

    private func firstArtifactText(client: GatewayClient, runId: String, paths: [String]) async -> String? {
        for path in paths {
            if let text = try? await client.artifactText(runId: runId, path: path), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return text
            }
        }
        return nil
    }

    private static func activityEvent(from event: TimelineEvent) -> ActivityEvent {
        let kind: ActivityKind
        if event.type.contains("review") || event.type.contains("finding") {
            kind = .review
        } else if event.type.contains("gate") {
            kind = .gate
        } else if event.type.contains("harness") {
            let lowered = (event.detail ?? event.title).lowercased()
            kind = lowered.contains("file") ? .file : lowered.contains("tool") ? .tool : lowered.contains("think") ? .thinking : .message
        } else {
            kind = .system
        }
        let detailParts = [event.detail, event.target.map { "target: \($0)" }, event.errorSummary.map { "error: \($0)" }]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return ActivityEvent(
            kind,
            harness: event.harnessId.flatMap { HarnessFamily(rawValue: $0) },
            event.title,
            detail: detailParts.isEmpty ? nil : detailParts.joined(separator: "\n"),
            severity: event.severity,
            code: event.rawRef,
            at: parseEventDate(event.ts) ?? .now
        )
    }

    private func hydrateReviewFindings() async {
        guard let client else { return }
        let ids = liveTasks.map(\.id)
        for id in ids {
            guard let idx = liveTasks.firstIndex(where: { $0.id == id }) else { continue }
            if !liveTasks[idx].findings.isEmpty { continue }
            guard let detail = try? await client.runDetail(runId: id) else { continue }
            let title = liveTasks[idx].title
            let findings = detail.reviewFindings.compactMap { Self.finding(from: $0, taskTitle: title) }
            if !findings.isEmpty {
                liveTasks[idx].findings = findings
            }
        }
    }

    private func diagnosticText(client: GatewayClient, runId: String, detail: RunDetail, error: String?) async -> String {
        var sections: [String] = []
        let failure = detail.failure ?? detail.summary.failure
        if let failure {
            var failureLines = [
                "phase: \(failure.phase)",
                "category: \(failure.category)",
                "message: \(failure.safeMessage)"
            ]
            if let harness = failure.harnessId { failureLines.append("harness: \(harness)") }
            if let attempt = failure.attemptId { failureLines.append("attempt: \(attempt)") }
            if let ref = failure.rawDetailRef { failureLines.append("detail: \(ref)") }
            if !failure.eventRefs.isEmpty { failureLines.append("events:\n" + failure.eventRefs.map { "- \($0)" }.joined(separator: "\n")) }
            if !failure.logRefs.isEmpty { failureLines.append("logs:\n" + failure.logRefs.map { "- \($0)" }.joined(separator: "\n")) }
            if let runDir = failure.runDir { failureLines.append("runDir: \(runDir)") }
            if !failure.nextActions.isEmpty { failureLines.append("next actions:\n" + failure.nextActions.map { "- \($0)" }.joined(separator: "\n")) }
            sections.append("# Failure\n\n" + failureLines.joined(separator: "\n"))
        }
        if let error, !error.isEmpty { sections.append("# Engine Error\n\n\(error)") }
        if let web = detail.summary.webEvidence, web.attempted || web.required {
            var lines = [
                "status: \(web.status)",
                "mode: \(web.mode)",
                "required: \(web.required)",
                "attempted: \(web.attempted)",
                "satisfied: \(web.satisfied)"
            ]
            if let tool = web.tool { lines.append("tool: \(tool)") }
            if let target = web.target { lines.append("target: \(target)") }
            if let error = web.errorSummary { lines.append("error: \(error)") }
            if let ref = web.rawDetailRef { lines.append("detail: \(ref)") }
            sections.append("# Web Evidence\n\n" + lines.joined(separator: "\n"))
        }
        var diagnosticPaths: [String] = ["final/failure.yaml", "context/context_error.md"]
        if let failure {
            if let ref = failure.rawDetailRef { diagnosticPaths.append(ref) }
            diagnosticPaths.append(contentsOf: failure.eventRefs)
            diagnosticPaths.append(contentsOf: failure.logRefs)
        }
        diagnosticPaths.append(contentsOf: ["attempts/a01/events.jsonl", "events.jsonl", "arbitration/decision.yaml", "final/work_product.yaml"])
        var seen = Set<String>()
        for path in diagnosticPaths where seen.insert(path).inserted {
            if let text = try? await client.artifactText(runId: runId, path: path), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                sections.append("## \(path)\n\n\(text)")
            }
        }
        if sections.isEmpty {
            let paths = detail.artifacts.map(\.path).joined(separator: "\n")
            sections.append(paths.isEmpty ? "No diagnostics artifacts are available yet." : "Artifacts:\n\(paths)")
        }
        return sections.joined(separator: "\n\n")
    }

}
