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
    /// The grounding plan is running (pre-questions): /spec/questions is in flight,
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

/// Single source of UI state. Prefers the live engine-service (loopback control-api):
/// connection health, the run list, starting/cancelling runs, and the live SSE activity
/// stream. Everything the control-api does not yet expose falls back to `DemoData` so
/// the app is fully legible offline. Live runs are tagged `isLive`.
@MainActor
@Observable
final class AppModel {
    var health: Health = .connecting
    var endpoint: String = ""
    var route: SidebarRoute = .threads
    var appearance: AppearanceMode = .dark {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "claudexor.appearance") }
    }
    var authSheetHarness: HarnessFamily?
    var projectRoot: String = "" {
        didSet { UserDefaults.standard.set(projectRoot, forKey: "claudexor.projectRoot") }
    }
    var projectContextMode: String = "auto" {
        didSet { UserDefaults.standard.set(projectContextMode, forKey: "claudexor.projectContextMode") }
    }
    /// Recently-used project roots (MRU, most-recent first, capped) — powers the
    /// composer's project chip so you Browse once, then pick from a menu (В6).
    var recentProjects: [String] = [] {
        didSet { UserDefaults.standard.set(recentProjects, forKey: "claudexor.recentProjects") }
    }

    /// Sample data is OFF by default and lives behind an explicit toggle, so live state is
    /// never silently mixed with mock content. When off, surfaces the engine doesn't expose
    /// yet show honest empty states instead of demo content.
    var demoMode = false {
        didSet { UserDefaults.standard.set(demoMode, forKey: "claudexor.demoMode") }
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
    /// not a single slot — so a long `/spec/questions` or `/spec/freeze` await that
    /// returns AFTER the user switched threads still records its result on the
    /// OWNING thread (never stranding that thread's card at `.grounding`/`.freezing`),
    /// and a concurrent spec on another thread is never clobbered. `specFlow` reads
    /// only the selected thread's entry, so a switch hides a non-current card.
    private var specFlowByThread: [String: SpecFlowState] = [:]
    /// Per-thread SPEC-FLOW generation. Spec grounding/freeze are NOT thread turns,
    /// so `selectedThreadBusy` can't block a second Spec on the same thread — two
    /// in-flight `/spec/questions` (or a cancel mid-grounding) would otherwise race
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
    var settingsSnapshot: SettingsSnapshot?
    var secretBackend = "unknown"
    var storedSecrets: [SecretInfo] = []
    var settingsStatus: String?
    let demoTasks: [TaskRun] = DemoData.tasks

    var projects: [Project] { demoMode ? DemoData.projects : liveProjects }
    var harnesses: [HarnessInfo] { demoMode ? DemoData.harnesses : liveHarnesses }

    /// Live runs grouped into a light project tree for the sidebar.
    private var liveProjects: [Project] {
        let groups = Dictionary(grouping: liveTasks, by: { $0.project })
        return groups.keys.sorted().map { name in
            let ids = (groups[name] ?? []).map(\.id)
            return Project(id: name, name: name,
                           specs: [Spec(id: "\(name)-runs", title: "Runs", frozen: false, version: 0, runIds: ids)])
        }
    }

    /// Engine-side defaults for launch surfaces (quick launch, retry).
    var defaultPortfolio: String { settingsSnapshot?.defaultPortfolio ?? "subscription-first" }
    var defaultMaxUsdPerRun: Double? { settingsSnapshot?.budget.maxUsdPerRun }

    private var client: GatewayClient?
    private var streamTasks: [String: Task<Void, Never>] = [:]
    /// Global live-only multiplex subscription (list liveness).
    private var globalStreamTask: Task<Void, Never>?
    /// Last SSE sequence seen per run so reconnects resume instead of replaying everything.
    private var lastEventIds: [String: Int] = [:]
    /// Reentrancy depth of in-flight detail loads per run (see loadRunDetail).
    private var snapshotLoadDepth: [String: Int] = [:]
    /// Stream envelopes deferred while a snapshot load is in flight.
    private var deferredEnvelopes: [String: [BusEnvelope]] = [:]
    /// SSE coalescing: events buffer here and flush in ~64ms batches, so a burst of
    /// harness events (10+/sec) causes ONE SwiftUI re-render per batch instead of one
    /// per event. `@ObservationIgnored` so buffering never itself triggers a render.
    @ObservationIgnored private var eventBuffers: [String: [BusEnvelope]] = [:]
    @ObservationIgnored private var flushTasks: [String: Task<Void, Never>] = [:]
    /// Live chat transcript per run (thinking / tools / messages folded from SSE).
    var transcripts: [String: TranscriptReducer] = [:]
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

    init() {
        // Without this first-run authorization request, run-completion
        // notifications are silently dropped in the bundled .app forever.
        Notifier.requestAuthIfPossible()
        if let raw = UserDefaults.standard.string(forKey: "claudexor.appearance"),
           let saved = AppearanceMode(rawValue: raw) {
            appearance = saved
        }
        demoMode = UserDefaults.standard.bool(forKey: "claudexor.demoMode")
        // Dev/QA only: force an appearance for deterministic screenshots.
        switch ProcessInfo.processInfo.environment["CLAUDEXOR_DEBUG_APPEARANCE"] {
        case "light": appearance = .light
        case "dark": appearance = .dark
        default: break
        }
        // Dev/QA only: open a run's inspector for deterministic screenshots. No
        // effect unless the env var is set. (The other v0.9 debug routes pointed
        // at screens removed in the v0.10 chat-first collapse — review #14.)
        if ProcessInfo.processInfo.environment["CLAUDEXOR_DEBUG_ROUTE"] != nil { demoMode = true }
        switch ProcessInfo.processInfo.environment["CLAUDEXOR_DEBUG_ROUTE"] {
        case "task": route = .task("run-7f3a91")
        case "convergence": route = .task("run-2bd180")
        default: break
        }
        projectRoot = UserDefaults.standard.string(forKey: "claudexor.projectRoot") ?? ProcessInfo.processInfo.environment["CLAUDEXOR_PROJECT_ROOT"] ?? ""
        projectContextMode = UserDefaults.standard.string(forKey: "claudexor.projectContextMode") ?? "auto"
        if projectContextMode != "deep" { projectContextMode = "auto" }
        recentProjects = UserDefaults.standard.stringArray(forKey: "claudexor.recentProjects") ?? []
    }

    var tasks: [TaskRun] { demoMode ? liveTasks + demoTasks : liveTasks }

    // A run parked on a pending question NEEDS the user even though its daemon
    // state is still "running".
    var attentionTasks: [TaskRun] { tasks.filter { $0.status.needsAttention || $0.waitingOnUser } }
    var activeTasks: [TaskRun] { tasks.filter { $0.status.isActive && !$0.waitingOnUser } }
    var allFindings: [Finding] {
        tasks.flatMap { task in
            task.findings.map { finding in
                var f = finding
                if f.taskId == nil { f.taskId = task.id }
                return f
            }
        }.sorted { $0.severity.rank < $1.severity.rank }
    }

    func task(_ id: String) -> TaskRun? { tasks.first { $0.id == id } }

    func harnessInfo(for family: HarnessFamily) -> HarnessInfo? {
        harnesses.first { $0.family == family }
    }

    func availability(for family: HarnessFamily, mode: RunMode) -> HarnessAvailability {
        let intent = mode.requiredIntent
        guard let info = harnessInfo(for: family) else {
            return HarnessAvailability(family: family, available: false,
                                       reason: "Harness Doctor has not loaded \(family.label). Reconnect the engine, then recheck.",
                                       intent: intent, info: nil)
        }
        // Engine-level per-harness settings gate routing; the composer must
        // mirror that truth instead of offering a chip the engine will reject.
        if settingsSnapshot?.harnesses?[family.rawValue]?.enabled == false {
            return HarnessAvailability(family: family, available: false,
                                       reason: "\(family.label) is disabled in Settings (Per-Harness Defaults).",
                                       intent: intent, info: info)
        }
        guard info.health == .ok else {
            return HarnessAvailability(family: family, available: false,
                                       reason: info.reasons.first ?? info.auth,
                                       intent: intent, info: info)
        }
        guard info.intents.contains(intent) else {
            let reason = info.reasons.first ?? "\(family.label) is not enabled for \(intent). Fix auth/install status in Harness Doctor."
            return HarnessAvailability(family: family, available: false,
                                       reason: reason, intent: intent, info: info)
        }
        return HarnessAvailability(family: family, available: true,
                                   reason: "\(family.label) can handle \(intent).",
                                   intent: intent, info: info)
    }

    func availableHarnesses(for mode: RunMode, selected: Set<HarnessFamily>) -> [HarnessFamily] {
        HarnessFamily.allCases
            .filter { $0 != .fake && $0 != .raw && selected.contains($0) }
            .filter { availability(for: $0, mode: mode).available }
    }

    // MARK: Connection

    func connect() async {
        health = .connecting
        // Streams hold the OLD client's connections; cancel before replacing it.
        cancelAllStreams()
        if await tryConnect() { return }
        // Offline: if a bundled engine ships in this .app, start it and retry once.
        if DaemonLauncher.startIfNeeded() {
            try? await Task.sleep(for: .seconds(3))
            if await tryConnect() { return }
        }
        health = .offline
        client = nil
    }

    private func tryConnect() async -> Bool {
        do {
            let discovery = try ControlApiDiscovery.load()
            endpoint = "\(discovery.host):\(discovery.port)"
            let client = try discovery.makeClient()
            self.client = client
            if try await client.health() {
                health = .connected
                await refreshRuns()
                await refreshHarnesses()
                await refreshSettings()
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
            let known = Set(demoTasks.map(\.id))
            let existingById = Dictionary(uniqueKeysWithValues: liveTasks.map { ($0.id, $0) })
            // Merge instead of replace: a refresh must not wipe locally-hydrated
            // detail (activity, diff, findings, outputs) for rows we already track.
            liveTasks = summaries
                .filter { !known.contains($0.runId) }
                .map { summary in
                    var task = Self.liveTask(from: summary)
                    if let existing = existingById[task.id] ?? summary.jobId.flatMap({ existingById[$0] }) {
                        if !existing.activity.isEmpty { task.activity = existing.activity }
                        if !existing.diff.isEmpty { task.diff = existing.diff }
                        if !existing.findings.isEmpty { task.findings = existing.findings }
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

    func refreshHarnesses() async {
        guard let client else { return }
        do {
            liveHarnesses = try await client.listHarnesses().compactMap { status in
                guard let family = HarnessFamily(rawValue: status.id) else { return nil }
                let health = HarnessHealth(rawValue: status.status) ?? .unavailable
                let version = status.manifest?["version"]?.stringValue ?? status.manifest?["adapter_version"]?.stringValue ?? "unknown"
                let auth = Self.harnessReadinessText(status: status, health: health)
                let checks = status.checks.map { "\($0.id): \($0.status)" }
                let acceptsImages = (status.manifest?["capability_profile"]?["image_input"]?.stringValue ?? "none") != "none"
                let acceptsBrowser = status.manifest?["capabilities"]?["browser_tool"]?.boolValue ?? false
                return HarnessInfo(family: family, health: health, version: version, auth: auth,
                                   intents: status.enabledIntents, reasons: status.reasons ?? [], checks: checks,
                                   acceptsImages: acceptsImages, acceptsBrowser: acceptsBrowser)
            }
        } catch {
            // Keep last-known harness rows.
        }
    }

    // MARK: - Artifacts (Phase 3 gallery)

    /// List a run's produced artifacts (path/kind/bytes/mime) for the gallery.
    func runArtifacts(runId: String) async -> [ArtifactInfo] {
        guard let client else { return [] }
        return (try? await client.listRunArtifacts(runId: runId)) ?? []
    }

    /// Raw bytes of one artifact (images / pdf) for inline rendering or open.
    func artifactBytes(runId: String, path: String) async -> Data? {
        guard let client else { return nil }
        return try? await client.artifactData(runId: runId, path: path)
    }

    /// Text content of one artifact (markdown / code / json / log).
    func artifactTextContent(runId: String, path: String) async -> String? {
        guard let client else { return nil }
        return try? await client.artifactText(runId: runId, path: path)
    }

    // MARK: - Produced outputs (project artifacts/, not the run tree)

    /// List a run's PRODUCED outputs — files the run writes into the project's
    /// `artifacts/` folder — for the Canvas gallery.
    func producedArtifacts(runId: String) async -> [ArtifactInfo] {
        guard let client else { return [] }
        return (try? await client.listProducedFiles(runId: runId)) ?? []
    }

    /// Raw bytes of one produced output (images / pdf) for inline rendering or open.
    func producedBytes(runId: String, path: String) async -> Data? {
        guard let client else { return nil }
        return try? await client.producedData(runId: runId, path: path)
    }

    /// Text content of one produced output (markdown / code / json / log).
    func producedTextContent(runId: String, path: String) async -> String? {
        guard let client else { return nil }
        guard let data = try? await client.producedData(runId: runId, path: path) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private static func harnessReadinessText(status: HarnessStatus, health: HarnessHealth) -> String {
        let smokeReady = status.checks.contains { $0.id.contains("smoke") && $0.status == "pass" }
        let sourceText = authSourceAvailability(manifest: status.manifest)
        switch health {
        case .ok:
            return smokeReady ? "Ready: doctor smoke passed. Auth sources: \(sourceText)." : "Ready by doctor. Auth sources: \(sourceText)."
        case .degraded:
            return "Not ready: doctor degraded. Auth sources: \(sourceText)."
        case .unavailable:
            return "Unavailable: install/login/smoke check required. Auth sources: \(sourceText)."
        }
    }

    private static func authSourceAvailability(manifest: JSONValue?) -> String {
        let auth = manifest?["capability_profile"]?["auth"]
        let supported = stringArray(auth?["supported_sources"])
        let present = stringArray(manifest?["auth_modes"])
        let presentLabel = present.isEmpty ? "present unknown" : "present \(present.joined(separator: ", "))"
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

    func startSetupJob(family: HarnessFamily, action: String) async -> SetupJob? {
        guard let client else {
            settingsStatus = "Engine offline: reconnect before starting \(family.label) setup."
            return nil
        }
        do {
            let job = try await client.createSetupJob(SetupJobCreateRequest(harness: family.setupHarnessId, action: action))
            settingsStatus = job.message
            return job
        } catch {
            settingsStatus = "Could not start \(family.label) setup: \(error)"
            return nil
        }
    }

    /// Enumerable models for one harness (ADP4 picker). Returns nil when the
    /// engine is offline OR the request fails, so the view falls back to free text.
    func harnessModels(for family: HarnessFamily) async -> HarnessModelsResponse? {
        guard let client else { return nil }
        return try? await client.harnessModels(harnessId: family.rawValue)
    }

    func confirmSetupJob(_ jobId: String) async -> SetupJob? {
        guard let client else {
            settingsStatus = "Engine offline: reconnect before confirming setup."
            return nil
        }
        do {
            let job = try await client.confirmSetupJob(jobId: jobId)
            settingsStatus = job.message
            return job
        } catch {
            settingsStatus = "Could not confirm setup job: \(error)"
            return nil
        }
    }

    func setupJobStatus(_ jobId: String) async -> SetupJob? {
        guard let client else { return nil }
        return try? await client.setupJob(jobId: jobId)
    }

    func refreshSettings() async {
        guard let client else { return }
        do {
            settingsSnapshot = try await client.settings()
        } catch {
            settingsStatus = "Could not load settings: \(error)"
        }
    }

    var normalizedProjectRoot: String {
        projectRoot.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var hasCurrentProject: Bool { !normalizedProjectRoot.isEmpty }

    var currentProjectName: String {
        guard hasCurrentProject else { return "No project" }
        return URL(fileURLWithPath: normalizedProjectRoot).lastPathComponent
    }

    /// The composer ProjectChip's "Browse…" — open the panel and set the project
    /// (+ record MRU) without touching thread selection. (Project selection lives
    /// only in the chat ProjectChip; Settings no longer owns a project picker.)
    func chooseProject() {
        if let path = runProjectPanel() { selectProject(path) }
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
        let families = (s.harnesses ?? []).compactMap { HarnessFamily(rawValue: $0) }
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
            activePhase: .review,
            spendUsd: s.spendUsd ?? 0, capUsd: s.maxUsd ?? 0,
            spendKnown: s.spendUsd != nil, capKnown: s.maxUsd != nil,
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
        task.requestedAccess = s.requestedAccess
        task.effectiveAccess = s.effectiveAccess
        task.externalContextPolicy = s.externalContextPolicy
        task.tests = s.tests ?? []
        task.reviewerPanel = s.reviewerPanel
        task.protectedPathApprovals = s.protectedPathApprovals
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
                  portfolio: String, model: String?, n: Int, capUsd: Double?,
                  access: String = "workspace_write", web: String = "auto",
                  tests: [String] = [], reviewerPanel: [ReviewerPanelEntry]? = nil,
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
        let launchContextMode = launchRepoRoot.isEmpty ? "off" : (projectContextMode == "deep" ? "deep" : "auto")
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
            activePhase: .contract,
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
                : RunScope.project(root: launchRepoRoot, context: launchContextMode == "deep" ? "deep" : "auto")
            let flags = mode.strategyFlags
            let req = StartRunRequest(prompt: prompt, mode: mode.apiValue,
                                      scope: scope,
                                      execution: RunExecution(isolation: "envelope"),
                                      harnesses: orderedHarnesses,
                                      primaryHarness: primary?.rawValue,
                                      portfolio: portfolio,
                                      model: model?.isEmpty == false ? model : nil,
                                      reviewerPanel: reviewerPanel,
                                      n: mode == .bestOfN ? max(n, flags.defaultN ?? 2) : nil,
                                      maxUsd: capUsd, access: access,
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
                // swap the optimistic row for one keyed by the real run id
                if let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id }) {
                    let prev = liveTasks[idx]
                    var started = TaskRun(
                        id: info.runId, title: prev.title, prompt: prev.prompt, mode: prev.mode,
                        status: .running, project: prev.project, specTitle: nil, harnesses: prev.harnesses,
                        n: prev.n, createdAt: prev.createdAt, updatedAt: .now, activePhase: .context,
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
                    liveTasks[idx] = started
                    route = .task(info.runId)
                    stream(runId: info.runId)
                }
            case .queued(let info):
                if let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id }) {
                    let prev = liveTasks[idx]
                    var row = TaskRun(
                        id: info.jobId, title: prev.title, prompt: prev.prompt, mode: prev.mode,
                        status: .queued, project: prev.project, specTitle: nil, harnesses: prev.harnesses,
                        n: prev.n, createdAt: prev.createdAt, updatedAt: .now, activePhase: .contract,
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
                    liveTasks[idx] = row
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

    func refreshThreads() async {
        guard let client else { return }
        do {
            threads = try await client.listThreads().threads
        } catch {
            // Engine builds without thread support return 501; keep the list empty.
            threads = []
        }
    }

    func openThread(_ id: String) async {
        guard let client else { return }
        selectedThreadId = id
        do {
            let detail = try await client.threadDetail(id: id)
            // The user may have switched threads (or hit New) during the await —
            // don't let a stale load overwrite the now-current selection/draft.
            guard selectedThreadId == id else { return }
            selectedThreadDetail = detail
            // Hydrate run details for the most recent turns so the conversation
            // can offer decision/apply actions (diff/findings) without requiring
            // a manual visit to each run's detail screen first.
            for turn in detail.turns.suffix(5) {
                guard selectedThreadId == id else { return }
                if let runId = turn.runId, liveTasks.contains(where: { $0.id == runId }) {
                    await loadRunDetail(runId)
                }
            }
        } catch {
            guard selectedThreadId == id else { return }  // don't surface a stale error on another thread
            threadStatus = "Could not load thread: \(userMessage(for: error))"
        }
    }

    /// Enter the DRAFT state: no thread selected, so the composer's first message
    /// materializes a fresh thread (on the Current Project). This is "New Thread".
    func startDraftThread() {
        selectedThreadId = nil
        selectedThreadDetail = nil
        threadStatus = nil
        // Clear the inspector route — a fresh draft has no run, so the inspector
        // must not keep showing the previous thread's run.
        if case .task = route { route = .threads }
        // Reset draft routing back to "inherit global default".
        draftPrimaryHarness = nil
        draftEligiblePool = []
        draftIsolatedWorkspace = false
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

    /// Eligible harness pool (Race runs this; one candidate per harness): thread
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
    private func applyThreadUpdate(_ updated: ThreadSummary) {
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
        let scope: RunScope = normalizedProjectRoot.isEmpty ? .none : .project(root: normalizedProjectRoot, context: "auto")
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
    /// (the turn is already on the server) — that would risk a duplicate send (#12).
    @discardableResult
    /// `onThread` binds the turn to a SPECIFIC owning thread (Implement-plan /
    /// Implement-spec capture their card's thread at tap time). When nil, the turn
    /// targets the current selection and materializes a draft thread if needed.
    /// Binding the target removes the thread-selection race: an action begun on one
    /// thread can't be re-pointed at a different thread the user switched to during
    /// the async send.
    func composerSend(prompt: String, mode: RunMode, planRunId: String? = nil, specPath: String? = nil, model: String? = nil, attachments: [AttachmentInput] = [], options: TurnOptions = .init(), onThread explicitThreadId: String? = nil) async -> Bool {
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

    /// Send a follow-up turn; returns true if the engine ACCEPTED it. The native
    /// session resumes (plan -> implement is one conversation).
    @discardableResult
    func sendTurn(threadId: String, prompt: String, mode: RunMode, planRunId: String? = nil, specPath: String? = nil, model: String? = nil, attachments: [AttachmentInput] = [], options: TurnOptions = .init()) async -> Bool {
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
        // Race runs the eligible pool: one candidate per AVAILABLE harness. Send the
        // pool EXPLICITLY (what the user sees races) and size n to that same set, so
        // the engine never wraps a too-large n back over a smaller resolved pool
        // (which would race a harness against itself). Other modes send no harnesses
        // and inherit the thread's sticky pool server-side (primary too).
        var racePool: [String] = []
        if mode == .bestOfN {
            let available = effectiveEligiblePool.filter { id in
                guard let family = HarnessFamily(rawValue: id) else { return false }
                return availability(for: family, mode: mode).available
            }
            racePool = available.isEmpty ? effectiveEligiblePool : available
        }
        // Race width = one candidate per harness in the pool (≥2). A SINGLE-harness
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
        // for a plain agent turn, never for Race. access/web/budget are per-turn.
        let writeMode = !mode.isReadOnly
        let repairMode = mode == .agent
        let result: RunStartResult
        do {
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
                maxUsd: options.maxUsd,
                // Per-turn model override (empty = harness default → don't send the key).
                model: model.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 },
                reviewerPanel: options.reviewerPanel,
                access: writeMode ? options.access : nil,
                web: options.web,
                browser: options.browser ? true : nil,
                planRunId: planRunId,
                specPath: specPath,
                attachments: attachments.isEmpty ? nil : attachments,
                protectedPathApprovals: options.protectedPathApprovals
            ))
        } catch {
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
    /// bootstrap), require a project, then run the grounding plan synchronously via
    /// /spec/questions. Empty questions => freeze directly (nothing to ask). The
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
        // `.askingQuestions` since startSpec — so /spec/freeze posts the exact prompt
        // the grounding plan ran on (not the stale head-turn prompt, which on a fresh
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
    /// Multi-tier interview (Q14): record this tier's answers as prior decisions and
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
                // spec doesn't lose tiers 0..N-1 (#8/#9).
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
    func decide(runId: String, action: String, feedback: String? = nil, acceptedRisks: [String] = []) async -> String? {
        guard let client else { return "Engine offline." }
        do {
            let res = try await client.decide(runId: runId, body: RunDecisionRequest(action: action, feedback: feedback, acceptedRisks: acceptedRisks))
            await refreshRuns()
            return res.accepted ? nil : (res.message ?? "Decision was not accepted (\(res.status)).")
        } catch {
            return "Decision failed: \(error)"
        }
    }

    /// Apply a run's reviewed patch through the server-owned gate.
    func applyRun(runId: String, mode: String = "apply") async -> String? {
        guard let client else { return "Engine offline." }
        do {
            let res = try await client.apply(runId: runId, body: ApplyRunRequest(mode: mode))
            return res.applied ? nil : (res.detail ?? "Apply was refused.")
        } catch {
            return "Apply failed: \(error)"
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
                for env in deferred { apply(env, to: id) }
            }
        }
        do {
            let detail = try await client.runDetail(runId: id)
            // Re-resolve the row BY ID after the await: refreshes/inserts may
            // have reordered liveTasks, and a stale index would merge this
            // snapshot into (and copy hydrated fields from) a DIFFERENT run.
            guard let baseIdx = liveTasks.firstIndex(where: { $0.id == id }) else { return }
            // Snapshot fence: everything with seq <= lastSeq is reflected in this
            // snapshot, so the stream resumes from here without gaps or dupes.
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
            task.capUsd = detail.summary.maxUsd ?? task.capUsd
            task.capKnown = detail.summary.maxUsd != nil || task.capKnown
            task.spendUsd = detail.summary.spendUsd ?? task.spendUsd
            task.spendKnown = detail.summary.spendUsd != nil || task.spendKnown
            task.spendEstimated = detail.summary.spendEstimated ?? task.spendEstimated
            let failure = detail.failure ?? detail.summary.failure
            task.engineError = failure?.safeMessage ?? detail.summary.error
            task.runDir = detail.summary.runDir ?? failure?.runDir ?? task.runDir
            task.outputReadyState = detail.summary.outputReadyState
            task.pendingInteractions = detail.pendingInteractions
            task.waitingOnUser = detail.summary.waitingOnUser ?? !detail.pendingInteractions.isEmpty
            if let route = detail.summary.route {
                task.observedModel = route.observedModel
                task.routeProof = route.verified == true ? .verified : .unverified
            }
            task.requestedAccess = detail.summary.requestedAccess
            task.effectiveAccess = detail.summary.effectiveAccess
            task.externalContextPolicy = detail.summary.externalContextPolicy
            task.tests = detail.summary.tests ?? task.tests
            task.reviewerPanel = detail.summary.reviewerPanel
            task.protectedPathApprovals = detail.summary.protectedPathApprovals
            if detail.summary.webEvidence?.available == false {
                task.webEvidenceStatus = nil
                task.webEvidenceDetail = "Web/tool telemetry unavailable for this run (predates telemetry.yaml or still running)."
            } else {
                task.webEvidenceStatus = detail.summary.webEvidence?.status
                task.webEvidenceDetail = Self.webEvidenceDetail(detail.summary.webEvidence)
            }
            task.artifactPaths = detail.artifacts.map(\.path)
            if let budget = detail.budget {
                if let cap = budget.maxUsd { task.capUsd = cap }
                if let spend = budget.spendUsd { task.spendUsd = spend }
                task.capKnown = budget.maxUsd != nil
                task.spendKnown = budget.spendUsd != nil
                task.spendEstimated = budget.estimated
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
            }
            task.diagnosticText = await diagnosticText(client: client, runId: id, detail: detail, error: task.engineError)
            let persistedFindings = detail.reviewFindings.compactMap { Self.finding(from: $0, taskTitle: task.title) }
            if !persistedFindings.isEmpty {
                task.findings = persistedFindings
            }
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

    /// Minimal unified-diff parser for the Diff tab (paths, +/- counts, hunks).
    static func parseUnifiedDiff(_ patch: String) -> [DiffFile] {
        var files: [DiffFile] = []
        var currentPath: String?
        var currentHunks: [DiffHunk] = []
        var currentLines: [DiffLine] = []
        var currentHeader: String?
        var added = 0
        var removed = 0

        func closeHunk() {
            if let header = currentHeader {
                currentHunks.append(DiffHunk(header: header, lines: currentLines))
            }
            currentHeader = nil
            currentLines = []
        }
        func closeFile() {
            closeHunk()
            if let path = currentPath {
                files.append(DiffFile(path: path, added: added, removed: removed, hunks: currentHunks))
            }
            currentPath = nil
            currentHunks = []
            added = 0
            removed = 0
        }

        for line in patch.components(separatedBy: "\n") {
            if line.hasPrefix("diff --git ") {
                closeFile()
                // "diff --git a/path b/path" -> take the b/ path
                let parts = line.split(separator: " ")
                if let bPart = parts.last, bPart.hasPrefix("b/") {
                    currentPath = String(bPart.dropFirst(2))
                } else {
                    currentPath = parts.count > 2 ? String(parts[2].dropFirst(2)) : line
                }
                continue
            }
            guard currentPath != nil else { continue }
            if line.hasPrefix("@@") {
                closeHunk()
                currentHeader = line
                continue
            }
            guard currentHeader != nil else { continue }
            if line.hasPrefix("+") && !line.hasPrefix("+++") {
                added += 1
                currentLines.append(DiffLine(kind: .add, text: String(line.dropFirst())))
            } else if line.hasPrefix("-") && !line.hasPrefix("---") {
                removed += 1
                currentLines.append(DiffLine(kind: .remove, text: String(line.dropFirst())))
            } else if line.hasPrefix(" ") {
                currentLines.append(DiffLine(kind: .context, text: String(line.dropFirst())))
            }
        }
        closeFile()
        return files
    }

    func storeSecret(name: String, value: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.setSecret(name: name, value: value)
            await refreshSecrets()
            await refreshHarnesses()
            return true
        } catch {
            return false
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

    // MARK: Live SSE stream

    /// Attach (idempotently) a live stream for a run. Reconnects with
    /// Last-Event-ID after transient drops instead of dying silently, and only
    /// stops on the server's terminal `end` frame or repeated failures.
    func stream(runId: String) {
        guard client != nil else { return }
        guard streamTasks[runId] == nil else { return } // already attached; never restart a live stream
        streamTasks[runId] = Task { [weak self] in
            var attempt = 0
            var lostStream = false
            while !Task.isCancelled {
                guard let self, let client = self.client else { break }
                let resumeFrom = self.lastEventIds[runId]
                do {
                    for try await env in client.events(runId: runId, lastEventId: resumeFrom) {
                        // Snapshot fence: a concurrent detail load may already
                        // reflect this event; never re-apply older sequence ids.
                        if env.seq > 0, env.seq <= (self.lastEventIds[runId] ?? 0) { continue }
                        if env.seq > 0 { self.lastEventIds[runId] = env.seq }
                        // Buffer + coalesce: a 64ms flush applies a batch synchronously,
                        // so SwiftUI does ONE re-render for the batch (not per event).
                        self.eventBuffers[runId, default: []].append(env)
                        self.scheduleFlush(runId)
                    }
                    self.drainBuffer(runId) // flush the tail before terminal reconciliation
                    break // clean end frame: the run is terminal
                } catch {
                    if Task.isCancelled { break }
                    attempt += 1
                    if attempt > 5 {
                        lostStream = true
                        break
                    }
                    try? await Task.sleep(for: .seconds(min(Double(attempt) * 2.0, 10.0)))
                }
            }
            // One reducer path for terminal reconciliation: re-snapshot the FULL
            // detail (status + content together). A status-only patch is exactly
            // the "Succeeded with no answer" bug class this replaced.
            await self?.finalizeStream(runId: runId, lostStream: lostStream)
            self?.streamTasks[runId] = nil
            self?.lastEventIds[runId] = nil
        }
    }

    /// Schedule a coalesced flush of this run's buffered SSE events (throttle: at
    /// most one flush per ~64ms window). The batch applies synchronously, so SwiftUI
    /// renders the whole batch once.
    private func scheduleFlush(_ runId: String) {
        guard flushTasks[runId] == nil else { return }
        flushTasks[runId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(64))
            guard let self else { return }
            self.flushTasks[runId] = nil
            self.drainBuffer(runId)
        }
    }

    /// Apply all buffered envelopes for a run in one synchronous batch.
    private func drainBuffer(_ runId: String) {
        let batch = eventBuffers[runId] ?? []
        guard !batch.isEmpty else { return }
        eventBuffers[runId] = []
        for env in batch { apply(env, to: runId) }
    }

    /// Cancel every live stream (daemon/client about to be replaced).
    private func cancelAllStreams() {
        globalStreamTask?.cancel()
        globalStreamTask = nil
        for task in streamTasks.values { task.cancel() }
        streamTasks.removeAll()
        lastEventIds.removeAll()
        for task in flushTasks.values { task.cancel() }
        flushTasks.removeAll()
        eventBuffers.removeAll()
    }

    /// Stream ended (terminal end frame or repeated failures): load the full
    /// snapshot so status and content land atomically, then notify.
    private func finalizeStream(runId: String, lostStream: Bool) async {
        let before = liveTasks.first(where: { $0.id == runId })?.status
        await loadRunDetail(runId)
        guard let idx = liveTasks.firstIndex(where: { $0.id == runId }) else { return }
        if lostStream, liveTasks[idx].status.isActive {
            liveTasks[idx].status = .unknown
            liveTasks[idx].activity.append(ActivityEvent(.system, "Lost engine stream before a terminal status. Reconnect to refresh this run."))
        }
        liveTasks[idx].updatedAt = .now
        if let before {
            Self.notifyTransition(from: before, to: liveTasks[idx].status, title: liveTasks[idx].title)
        }
    }

    /// Global live-only multiplex: keeps the run LIST alive (new runs from the
    /// CLI, terminal flips for rows without an attached detail stream). Per-run
    /// streams remain the gap-free source for open rows.
    private func startGlobalStream() {
        globalStreamTask?.cancel()
        globalStreamTask = Task { [weak self] in
            var firstAttach = true
            while !Task.isCancelled {
                guard let self, let client = self.client else { break }
                do {
                    // The global stream is LIVE-ONLY (documented contract): runs
                    // started and terminal flips that happened while this stream
                    // was down are invisible to it, so every (re)attach repairs
                    // the gap with a list snapshot first.
                    if !firstAttach { await self.refreshRuns() }
                    firstAttach = false
                    for try await env in client.globalEvents() {
                        let runId = env.event["run_id"]?.stringValue ?? ""
                        guard !runId.isEmpty else { continue }
                        let type = env.event["type"]?.stringValue ?? ""
                        let isTerminalEvent = type == "run.completed" || type == "run.failed" || type == "run.blocked"
                        // Live thread updates: events carry thread_id, so an event for
                        // the OPEN thread refreshes its conversation. On run.created we
                        // also start streaming the just-started run — this is how a
                        // QUEUED (202) turn (which returned no runId) goes live (D4).
                        if let threadId = env.event["thread_id"]?.stringValue, !threadId.isEmpty {
                            if threadId == self.selectedThreadId, (type == "run.created" || isTerminalEvent) {
                                await self.openThread(threadId)
                                if type == "run.created", self.streamTasks[runId] == nil { self.stream(runId: runId) }
                            }
                            if isTerminalEvent { await self.refreshThreads() }
                        }
                        if !self.liveTasks.contains(where: { $0.id == runId }) {
                            // A run this app has never seen (e.g. CLI-started).
                            await self.refreshRuns()
                            continue
                        }
                        if self.streamTasks[runId] == nil, isTerminalEvent || type == "interaction.requested" {
                            await self.loadRunDetail(runId)
                        }
                    }
                } catch {
                    if Task.isCancelled { break }
                }
                guard !Task.isCancelled else { break }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    /// Native notification when a live run reaches a state that wants the user's attention.
    private static func notifyTransition(from: RunStatus, to: RunStatus, title: String) {
        guard from != to else { return }
        switch to {
        case .succeeded: Notifier.post(title: "Run succeeded", body: title)
        case .failed: Notifier.post(title: "Run failed", body: title)
        case .needsReview: Notifier.post(title: "Needs your review", body: title)
        case .blocked: Notifier.post(title: "Run blocked — needs permission", body: title)
        case .ungated: Notifier.post(title: "Run ungated", body: title)
        case .reviewNotRun: Notifier.post(title: "Review not run", body: title)
        case .exhausted: Notifier.post(title: "Run exhausted", body: title)
        case .notConverged: Notifier.post(title: "Run did not converge", body: title)
        case .stuckNoProgress: Notifier.post(title: "Run stuck with no progress", body: title)
        case .unknown: Notifier.post(title: "Run status unknown", body: title)
        default: break
        }
    }

    /// Translate one canonical run event into UI state. The live daemon path names each
    /// SSE event by its RunEvent `type` (`run.created`, `harness.event`, `gate.completed`,
    /// `review.finding.proposed`, `run.completed`, …) and sends the full record as data;
    /// the in-proc bus uses a normalized kind. We classify off the record's own `type`,
    /// falling back to the SSE kind — so it works against both servers.
    private func apply(_ env: BusEnvelope, to runId: String) {
        // Snapshot fence, write side: never interleave with an in-flight
        // detail load; the load's defer re-applies these in arrival order.
        if snapshotLoadDepth[runId] ?? 0 > 0 {
            deferredEnvelopes[runId, default: []].append(env)
            return
        }
        // Fold the live transcript (the chat shows working progress — reasoning +
        // tools — as it happens, not just the final answer).
        var reducer = transcripts[runId] ?? TranscriptReducer()
        if reducer.apply(env) { transcripts[runId] = reducer }
        guard let idx = liveTasks.firstIndex(where: { $0.id == runId }) else { return }
        let type = env.event["type"]?.stringValue ?? env.kind
        let payload = env.event["payload"] ?? env.event
        let before = liveTasks[idx].status
        var t = liveTasks[idx]
        var shouldLoadDetail = false
        defer {
            t.updatedAt = .now
            liveTasks[idx] = t
            Self.notifyTransition(from: before, to: t.status, title: t.title)
            if shouldLoadDetail {
                Task { await self.loadRunDetail(runId) }
            }
        }

        if type == "end" {
            return
        }
        if let phase = Self.phase(for: type) { t.activePhase = phase }

        if type.hasPrefix("run.") {
            if type == "run.completed" {
                if let s = payload["status"]?.stringValue ?? payload["state"]?.stringValue {
                    t.status = RunStatus(api: s)
                } else {
                    t.status = .succeeded
                }
                shouldLoadDetail = true
            } else if type == "run.failed" {
                if let s = payload["status"]?.stringValue ?? payload["state"]?.stringValue {
                    t.status = RunStatus(api: s)
                } else {
                    t.status = .failed
                }
                shouldLoadDetail = true
            }
            else if type == "run.blocked" {
                t.status = RunStatus(api: payload["status"]?.stringValue ?? "blocked")
                shouldLoadDetail = true
            }
            else if let s = payload["status"]?.stringValue ?? payload["state"]?.stringValue { t.status = RunStatus(api: s) }
            else if t.status == .queued { t.status = .running }
        } else if type.hasPrefix("harness.") {
            let detail = payload["type"]?.stringValue ?? payload["kind"]?.stringValue ?? ""
            let kind: ActivityKind = detail.contains("file") ? .file
                : detail.contains("tool") ? .tool
                : detail.contains("think") ? .thinking
                : detail.contains("message") ? .message : .tool
            let h = (payload["harness_id"]?.stringValue ?? payload["harness"]?.stringValue).flatMap { HarnessFamily(rawValue: $0) }
            if let h, !t.harnesses.contains(h) { t.harnesses.append(h) }
            t.activity.append(ActivityEvent(kind, harness: h, Self.title(payload) ?? Self.pretty(type), detail: payload["text"]?.stringValue ?? payload["error"]?.stringValue, code: payload["rawRef"]?.stringValue, at: .now))
        } else if type.hasPrefix("gate.") {
            t.activity.append(ActivityEvent(.gate, Self.title(payload) ?? Self.pretty(type), at: .now))
        } else if type.hasPrefix("review.") || type.hasPrefix("finding.") {
            t.activity.append(ActivityEvent(.review, Self.title(payload) ?? Self.pretty(type), at: .now))
            if type == "review.finding.proposed", let f = Self.finding(from: payload, taskTitle: t.title) {
                t.findings.append(f)
            }
        } else if type.hasPrefix("budget.") {
            if type == "budget.observation", let usd = payload["usd"]?.doubleValue {
                // Observations are per-event INCREMENTS (live spend ticks up mid-run).
                t.spendUsd += usd
                t.spendKnown = true
                if payload["estimated"]?.boolValue == true { t.spendEstimated = true }
            } else if let spend = payload["spend_usd"]?.doubleValue ?? payload["cost_usd"]?.doubleValue {
                t.spendUsd = spend
                t.spendKnown = true
                t.spendEstimated = payload["estimated"]?.boolValue ?? t.spendEstimated
            }
            if let cap = payload["max_usd"]?.doubleValue, cap > 0 {
                t.capUsd = cap
                t.capKnown = true
            }
        } else if type == "output.ready" {
            t.outputReadyState = payload["state"]?.stringValue ?? "ready"
            shouldLoadDetail = true
        } else if type == "interaction.requested" {
            if let pending = Self.pendingInteraction(from: payload, runId: runId) {
                t.pendingInteractions.removeAll { $0.interactionId == pending.interactionId }
                t.pendingInteractions.append(pending)
                t.waitingOnUser = true
                let summary = pending.questions.map(\.question).joined(separator: " | ")
                t.activity.append(ActivityEvent(.system, "Question: \(String(summary.prefix(200)))", at: .now))
                Notifier.post(title: "Claudexor needs your answer", body: String(summary.prefix(120)))
            }
        } else if type == "interaction.answered" || type == "interaction.timeout" {
            if let interactionId = payload["interaction_id"]?.stringValue {
                t.pendingInteractions.removeAll { $0.interactionId == interactionId }
            }
            t.waitingOnUser = !t.pendingInteractions.isEmpty
            t.activity.append(ActivityEvent(.system, type == "interaction.answered" ? "Answer delivered" : "Question timed out — continuing with assumptions", at: .now))
        } else {
            t.activity.append(ActivityEvent(.system, Self.title(payload) ?? Self.pretty(type), at: .now))
        }
    }

    /// Decode a pending interaction from the interaction.requested event payload.
    private static func pendingInteraction(from payload: JSONValue, runId: String) -> PendingInteraction? {
        guard let interactionId = payload["interaction_id"]?.stringValue else { return nil }
        var questions: [InteractionQuestion] = []
        if case .array(let raw)? = payload["questions"] {
            for q in raw {
                guard let text = q["question"]?.stringValue, !text.isEmpty else { continue }
                var options: [InteractionOption] = []
                if case .array(let rawOptions)? = q["options"] {
                    for o in rawOptions {
                        guard let label = o["label"]?.stringValue, !label.isEmpty else { continue }
                        options.append(InteractionOption(label: label, description: o["description"]?.stringValue))
                    }
                }
                questions.append(InteractionQuestion(
                    id: q["id"]?.stringValue ?? "q\(questions.count + 1)",
                    question: text,
                    header: q["header"]?.stringValue,
                    options: options,
                    multiSelect: q["multi_select"]?.boolValue ?? false
                ))
            }
        }
        guard !questions.isEmpty else { return nil }
        return PendingInteraction(
            interactionId: interactionId,
            runId: runId,
            attemptId: payload["attempt_id"]?.stringValue,
            harnessId: payload["harness_id"]?.stringValue,
            sourceTool: payload["source_tool"]?.stringValue,
            questions: questions,
            requestedAt: payload["requested_at"]?.stringValue ?? "",
            timeoutAt: payload["timeout_at"]?.stringValue
        )
    }

    private static func phase(for type: String) -> Phase? {
        switch type {
        case "run.created", "task.contract.created": return .contract
        case "context.pack.created": return .context
        case "budget.lease.created", "budget.observation": return .budget
        case "harness.started", "harness.event", "harness.completed": return .envelope
        case "gate.started", "gate.completed": return .gates
        case "review.started", "review.finding.proposed", "finding.revalidated": return .review
        case "synthesis.started": return .synthesis
        case "arbitration.completed": return .arbitration
        case "work_product.emitted", "run.completed", "run.failed": return .final
        default: return nil
        }
    }

    private static func title(_ payload: JSONValue?) -> String? {
        payload?["title"]?.stringValue ?? payload?["message"]?.stringValue ?? payload?["summary"]?.stringValue
    }

    /// "review.finding.proposed" -> "Review · finding proposed"
    private static func pretty(_ type: String) -> String {
        let parts = type.split(separator: ".")
        guard let head = parts.first else { return type }
        let rest = parts.dropFirst().joined(separator: " ")
        return rest.isEmpty ? head.capitalized : "\(head.capitalized) · \(rest)"
    }

    private static func finding(from payload: JSONValue?, taskTitle: String) -> Finding? {
        guard let payload else { return nil }
        let sevRaw = (payload["severity"]?.stringValue ?? "minor").lowercased()
        // NEEDS_HUMAN is the review-queue gate: it must read as blocking, never
        // collapse into a low-priority tint.
        let severity: Severity = sevRaw.contains("block") || sevRaw.contains("needs_human") ? .blocker
            : sevRaw.contains("fix_first") || sevRaw.contains("major") || sevRaw.contains("high") ? .major
            : sevRaw.contains("nit") || sevRaw.contains("low") || sevRaw.contains("out_of_scope") || sevRaw.contains("insufficient_evidence") ? .nit : .minor
        let evidenceFile = payload["file"]?.stringValue ?? payload["path"]?.stringValue ?? Self.firstEvidenceFile(payload)?.path
        let evidenceLine = payload["line"]?.doubleValue.map(Int.init) ?? Self.firstEvidenceFile(payload)?.line
        let reviewerRaw = payload["reviewer"]?.stringValue
            ?? payload["reviewer"]?["harness_id"]?.stringValue
            ?? payload["harness"]?.stringValue
        let routeProofRaw = payload["reviewer"]?["route_proof_status"]?.stringValue
        let title = payload["title"]?.stringValue ?? payload["summary"]?.stringValue ?? payload["claim"]?.stringValue ?? "Finding"
        let detail = payload["detail"]?.stringValue ?? payload["body"]?.stringValue ?? payload["claim"]?.stringValue ?? ""
        return Finding(
            id: payload["id"]?.stringValue ?? UUID().uuidString,
            severity: severity,
            category: payload["category"]?.stringValue ?? "Review",
            title: title,
            detail: detail,
            reviewer: reviewerRaw.flatMap { HarnessFamily(rawValue: $0) } ?? .raw,
            routeProof: Self.routeProof(from: routeProofRaw, routeVerified: payload["route_verified"]?.boolValue ?? false),
            evidenceFile: evidenceFile,
            evidenceLine: evidenceLine,
            status: FindingStatus(api: payload["status"]?.stringValue),
            taskTitle: taskTitle
        )
    }

    private static func firstEvidenceFile(_ payload: JSONValue) -> (path: String?, line: Int?)? {
        guard case .array(let files) = payload["evidence"]?["files"], let first = files.first else { return nil }
        let lines = first["lines"]?.stringValue
        let line = lines.flatMap { raw in raw.split(separator: "-").first.map(String.init).flatMap(Int.init) }
        return (first["path"]?.stringValue, line)
    }

    private static func routeProof(from raw: String?, routeVerified: Bool) -> RouteProof {
        if routeVerified { return .verified }
        switch raw {
        case "verified": return .verified
        case "accepted_model_arg": return .acceptedModelArg
        case "same_model_fallback": return .sameModelFallback
        default: return .unverified
        }
    }
}
