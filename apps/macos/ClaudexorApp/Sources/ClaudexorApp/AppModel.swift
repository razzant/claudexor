import SwiftUI
import AppKit
import Observation
import ClaudexorKit

// MARK: - Navigation

enum SidebarRoute: Hashable {
    case threads
    case overview
    case tasks
    case task(String)
    case spec(String)
    case interview
    case review
    case budget
    case harnesses
    case settings
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

/// Single source of UI state. Prefers the live engine-service (loopback control-api):
/// connection health, the run list, starting/cancelling runs, and the live SSE activity
/// stream. Everything the control-api does not yet expose falls back to `DemoData` so
/// the app is fully legible offline. Live runs are tagged `isLive`.
@MainActor
@Observable
final class AppModel {
    var health: Health = .connecting
    var endpoint: String = ""
    var route: SidebarRoute = .overview
    var appearance: AppearanceMode = .dark {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "claudexor.appearance") }
    }
    var composerPresented = false
    var authSheetHarness: HarnessFamily?
    var projectRoot: String = "" {
        didSet { UserDefaults.standard.set(projectRoot, forKey: "claudexor.projectRoot") }
    }
    var projectContextMode: String = "auto" {
        didSet { UserDefaults.standard.set(projectContextMode, forKey: "claudexor.projectContextMode") }
    }

    /// App-wide search query. Declared once on the NavigationSplitView (per WWDC25 "Build a
    /// SwiftUI app with the new design") so the toolbar search affordance is identical on every
    /// screen; list screens filter their content by this text.
    var searchQuery = ""

    /// Sample data is OFF by default and lives behind an explicit toggle, so live state is
    /// never silently mixed with mock content. When off, surfaces the engine doesn't expose
    /// yet show honest empty states instead of demo content.
    var demoMode = false {
        didSet { UserDefaults.standard.set(demoMode, forKey: "claudexor.demoMode") }
    }

    var liveTasks: [TaskRun] = []
    // Threads (chat/session-first): the conversation list + selected detail.
    var threads: [ThreadSummary] = []
    var selectedThreadId: String?
    var selectedThreadDetail: ThreadDetailResponse?
    var threadStatus: String?
    var liveHarnesses: [HarnessInfo] = []
    var liveBudget: BudgetState = .empty
    var settingsSnapshot: SettingsSnapshot?
    var secretBackend = "unknown"
    var storedSecrets: [SecretInfo] = []
    var settingsStatus: String?
    let demoTasks: [TaskRun] = DemoData.tasks

    var projects: [Project] { demoMode ? DemoData.projects : liveProjects }
    var harnesses: [HarnessInfo] { demoMode ? DemoData.harnesses : liveHarnesses }
    var budget: BudgetState { demoMode ? DemoData.budget : observedLiveBudget }
    var interviewQuestions: [InterviewQuestion] { demoMode ? DemoData.interviewQuestions : [] }

    /// Live runs grouped into a light project tree for the sidebar.
    private var liveProjects: [Project] {
        let groups = Dictionary(grouping: liveTasks, by: { $0.project })
        return groups.keys.sorted().map { name in
            let ids = (groups[name] ?? []).map(\.id)
            return Project(id: name, name: name,
                           specs: [Spec(id: "\(name)-runs", title: "Runs", frozen: false, version: 0, runIds: ids)])
        }
    }

    private var observedLiveBudget: BudgetState {
        let spendSamples = liveTasks.filter(\.spendKnown)
        let spend = spendSamples.reduce(0) { $0 + $1.spendUsd }
        let spendEstimated = spendSamples.contains(where: \.spendEstimated)
        let spendKnown = !spendSamples.isEmpty
        let dayCap = settingsSnapshot?.budget.maxUsdPerDay
        let capKnown = dayCap != nil
        let cap = dayCap ?? 0
        let breaker: Int
        if spendKnown && capKnown && cap > 0 {
            let fraction = min(spend / cap, 1)
            breaker = fraction >= 1 ? 3 : fraction > 0.85 ? 2 : fraction > 0.75 ? 1 : 0
        } else {
            breaker = 0
        }
        return BudgetState(
            spend: spend,
            cap: cap,
            spendKnown: spendKnown,
            capKnown: capKnown,
            spendEstimated: spendEstimated,
            source: spendKnown || capKnown ? "runs/settings" : "unknown",
            nativeQuota: liveBudget.nativeQuota,
            breakerTier: breaker,
            perHarness: [:]
        )
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
        // Dev/QA only: jump straight to a screen for deterministic screenshots, with
        // sample data on so the screens are populated. No effect unless the env var is set.
        if ProcessInfo.processInfo.environment["CLAUDEXOR_DEBUG_ROUTE"] != nil { demoMode = true }
        switch ProcessInfo.processInfo.environment["CLAUDEXOR_DEBUG_ROUTE"] {
        case "tasks": route = .tasks
        case "task": route = .task("run-7f3a91")
        case "convergence": route = .task("run-2bd180")
        case "interview": route = .interview
        case "review": route = .review
        case "budget": route = .budget
        case "harnesses": route = .harnesses
        case "settings": route = .settings
        case "composer": composerPresented = true
        default: break
        }
        projectRoot = UserDefaults.standard.string(forKey: "claudexor.projectRoot") ?? ProcessInfo.processInfo.environment["CLAUDEXOR_PROJECT_ROOT"] ?? ""
        projectContextMode = UserDefaults.standard.string(forKey: "claudexor.projectContextMode") ?? "auto"
        if projectContextMode != "deep" { projectContextMode = "auto" }
    }

    var tasks: [TaskRun] { demoMode ? liveTasks + demoTasks : liveTasks }

    var selectedTaskId: String? {
        if case let .task(id) = route { return id }
        return nil
    }

    var selectedTask: TaskRun? {
        guard let id = selectedTaskId else { return nil }
        return tasks.first { $0.id == id }
    }

    var selectedSpecId: String? {
        if case let .spec(id) = route { return id }
        return nil
    }

    var selectedSpec: Spec? {
        guard let id = selectedSpecId else { return nil }
        return projects.flatMap(\.specs).first { $0.id == id }
    }

    func project(forSpec specId: String) -> Project? {
        projects.first { $0.specs.contains { $0.id == specId } }
    }

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
                return HarnessInfo(family: family, health: health, version: version, auth: auth,
                                   intents: status.enabledIntents, reasons: status.reasons ?? [], checks: checks)
            }
        } catch {
            // Keep last-known harness rows.
        }
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

    func prepareHarnessSetup(family: HarnessFamily, action: String) async -> HarnessSetupResponse? {
        guard let client else {
            settingsStatus = "Engine offline: reconnect before preparing \(family.label) setup."
            return nil
        }
        do {
            let response = try await client.setupHarness(HarnessSetupRequest(harness: family.setupHarnessId, action: action))
            settingsStatus = response.message
            return response
        } catch {
            settingsStatus = "Could not prepare \(family.label) setup: \(error)"
            return nil
        }
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

    func chooseProject() {
        let panel = NSOpenPanel()
        panel.title = "Choose Current Project"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose / Create"
        panel.resolvesAliases = true
        if hasCurrentProject {
            panel.directoryURL = URL(fileURLWithPath: normalizedProjectRoot, isDirectory: true)
        }
        if panel.runModal() == .OK, let url = panel.url {
            projectRoot = url.path
        }
    }

    func clearProject() {
        projectRoot = ""
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
                  tests: [String] = [], repoRootOverride: String? = nil) async {
        composerPresented = false
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
                                      n: mode == .bestOfN ? max(n, flags.defaultN ?? 2) : nil,
                                      maxUsd: capUsd, access: access,
                                      web: web,
                                      tests: tests.isEmpty ? nil : tests,
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
            selectedThreadDetail = detail
            // Hydrate run details for the most recent turns so the conversation
            // can offer decision/apply actions (diff/findings) without requiring
            // a manual visit to each run's detail screen first.
            for turn in detail.turns.suffix(5) {
                if let runId = turn.runId, liveTasks.contains(where: { $0.id == runId }) {
                    await loadRunDetail(runId)
                }
            }
        } catch {
            threadStatus = "Could not load thread: \(error)"
        }
    }

    func newThread(title: String?) async {
        guard let client else {
            threadStatus = "Engine offline: reconnect before creating a thread."
            return
        }
        let scope: RunScope = normalizedProjectRoot.isEmpty ? .none : .project(root: normalizedProjectRoot, context: "auto")
        do {
            let thread = try await client.createThread(CreateThreadRequest(title: title, scope: scope))
            threads.insert(thread, at: 0)
            await openThread(thread.id)
        } catch {
            threadStatus = "Could not create thread: \(error)"
        }
    }

    /// Send a follow-up turn; the engine resumes each harness's native session
    /// (plan -> implement is one conversation, not a context reset).
    func sendTurn(threadId: String, prompt: String, mode: RunMode) async {
        guard let client else {
            threadStatus = "Engine offline: reconnect before sending a turn."
            return
        }
        guard mode != .unknown else {
            threadStatus = "This run used a legacy mode id; pick an intent from the composer instead."
            return
        }
        let flags = mode.strategyFlags
        do {
            let result = try await client.sendTurn(threadId: threadId, body: ThreadTurnRequest(
                prompt: prompt,
                mode: mode.apiValue,
                n: mode == .bestOfN ? (flags.defaultN ?? 2) : nil,
                attempts: mode == .maxAttempts ? 3 : nil,
                untilClean: flags.untilClean ? true : nil,
                swarm: flags.swarm ? true : nil,
                create: flags.create ? true : nil
            ))
            if case .started(let info) = result {
                threadStatus = nil
                await refreshRuns()
                await openThread(threadId)
                // Follow the new run live in the conversation.
                stream(runId: info.runId)
            } else {
                threadStatus = "Turn queued; the engine is busy."
            }
        } catch let GatewayError.queueBusy(message) {
            threadStatus = "Engine busy: \(message)"
        } catch {
            threadStatus = "Turn failed: \(error)"
        }
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
                liveBudget = BudgetState(
                    spend: budget.spendUsd ?? 0,
                    cap: budget.maxUsd ?? 0,
                    spendKnown: budget.spendUsd != nil,
                    capKnown: budget.maxUsd != nil,
                    spendEstimated: budget.estimated,
                    source: budget.source,
                    nativeQuota: budget.nativeQuota.map { "\($0.provider): \($0.label)\($0.remaining.map { " \($0)" } ?? "")" },
                    breakerTier: 0,
                    perHarness: [:]
                )
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
                        self.apply(env, to: runId)
                    }
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

    /// Cancel every live stream (daemon/client about to be replaced).
    private func cancelAllStreams() {
        globalStreamTask?.cancel()
        globalStreamTask = nil
        for task in streamTasks.values { task.cancel() }
        streamTasks.removeAll()
        lastEventIds.removeAll()
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
                        if !self.liveTasks.contains(where: { $0.id == runId }) {
                            // A run this app has never seen (e.g. CLI-started).
                            await self.refreshRuns()
                            continue
                        }
                        let type = env.event["type"]?.stringValue ?? ""
                        let isTerminalEvent = type == "run.completed" || type == "run.failed" || type == "run.blocked"
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
