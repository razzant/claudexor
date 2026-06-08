import SwiftUI
import AppKit
import Observation
import ClaudexorKit

// MARK: - Navigation

enum SidebarRoute: Hashable {
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
    var liveHarnesses: [HarnessInfo] = []
    var settingsSnapshot: SettingsSnapshot?
    var secretBackend = "unknown"
    var storedSecrets: [SecretInfo] = []
    var settingsStatus: String?
    let demoTasks: [TaskRun] = DemoData.tasks

    var projects: [Project] { demoMode ? DemoData.projects : liveProjects }
    var harnesses: [HarnessInfo] { demoMode ? DemoData.harnesses : liveHarnesses }
    var budget: BudgetState { demoMode ? DemoData.budget : .empty }
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

    private var client: GatewayClient?
    private var streamTask: Task<Void, Never>?

    init() {
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

    var attentionTasks: [TaskRun] { tasks.filter { $0.status.needsAttention } }
    var activeTasks: [TaskRun] { tasks.filter { $0.status.isActive } }
    var allFindings: [Finding] {
        tasks.flatMap { $0.findings }.sorted { $0.severity.rank < $1.severity.rank }
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
            liveTasks = summaries
                .filter { !known.contains($0.runId) }
                .map { Self.liveTask(from: $0) }
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
                let auth = status.reasons?.joined(separator: ", ") ?? (health == .ok ? "ready" : "native / key fallback")
                return HarnessInfo(family: family, health: health, version: version, auth: auth,
                                   intents: status.enabledIntents, reasons: status.reasons ?? [])
            }
        } catch {
            // Keep last-known harness rows.
        }
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
        panel.allowsMultipleSelection = false
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
            mode: RunMode(apiValue: s.mode),
            status: RunStatus(api: s.state),
            project: projectName,
            specTitle: nil,
            harnesses: families,
            n: s.n ?? max(1, families.count),
            createdAt: .now, updatedAt: .now,
            activePhase: .review,
            spendUsd: 0, capUsd: s.maxUsd ?? 0,
            routeProof: .unverified,
            attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [],
            isLive: true
        )
        task.repoRoot = s.project?.root
        task.engineError = s.failure?.safeMessage ?? s.error
        task.runDir = s.runDir ?? s.failure?.runDir
        task.artifactPaths = s.failure.map { ($0.rawDetailRef.map { [$0] } ?? []) + $0.eventRefs + $0.logRefs } ?? []
        if let failure = s.failure {
            task.diagnosticText = failure.safeMessage
        }
        return task
    }

    private static func prettyTitle(_ id: String) -> String {
        "Live run · " + String(id.suffix(8))
    }

    // MARK: Commands

    func startRun(prompt: String, mode: RunMode, harnesses: [HarnessFamily], primary: HarnessFamily?,
                  portfolio: String, model: String?, n: Int, capUsd: Double,
                  access: String = "workspace_write", tests: [String] = [], repoRootOverride: String? = nil) async {
        composerPresented = false
        let launchRepoRoot = repoRootOverride?.trimmingCharacters(in: .whitespacesAndNewlines) ?? normalizedProjectRoot
        guard !mode.requiresProject || !launchRepoRoot.isEmpty else {
            settingsStatus = "Choose a Current Project before launching \(mode.label). Ask can run without a project."
            return
        }
        let launchContextMode = launchRepoRoot.isEmpty ? "off" : (projectContextMode == "deep" ? "deep" : "auto")
        let launchProjectName = launchRepoRoot.isEmpty ? "No project" : URL(fileURLWithPath: launchRepoRoot).lastPathComponent
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
            spendUsd: 0, capUsd: capUsd,
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
            let req = StartRunRequest(prompt: prompt, mode: mode.apiValue,
                                      scope: scope,
                                      execution: RunExecution(isolation: "envelope"),
                                      harnesses: orderedHarnesses,
                                      primaryHarness: primary?.rawValue,
                                      portfolio: portfolio,
                                      model: model?.isEmpty == false ? model : nil,
                                      n: n,
                                      maxUsd: capUsd, access: access,
                                      tests: tests.isEmpty ? nil : tests)
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
                        spendUsd: 0, capUsd: prev.capUsd, routeProof: .unverified, attentionNote: nil,
                        plan: [], activity: prev.activity, candidates: [], findings: [], diff: [], isLive: true)
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
                        spendUsd: 0, capUsd: prev.capUsd, routeProof: .unverified, attentionNote: nil,
                        plan: [], activity: prev.activity, candidates: [], findings: [], diff: [], isLive: true)
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

    func loadRunDetail(_ id: String) async {
        guard let client, let idx = liveTasks.firstIndex(where: { $0.id == id }) else { return }
        do {
            let detail = try await client.runDetail(runId: id)
            var task = liveTasks[idx]
            task.status = RunStatus(api: detail.summary.state)
            task.mode = RunMode(apiValue: detail.summary.mode)
            task.prompt = detail.summary.prompt ?? task.prompt
            if !task.prompt.isEmpty { task.title = String(task.prompt.prefix(64)) }
            task.project = detail.summary.project?.projectName ?? detail.summary.project?.root.map { URL(fileURLWithPath: $0).lastPathComponent } ?? task.project
            task.repoRoot = detail.summary.project?.root ?? task.repoRoot
            task.harnesses = (detail.summary.harnesses ?? []).compactMap { HarnessFamily(rawValue: $0) }
            task.capUsd = detail.summary.maxUsd ?? task.capUsd
            let failure = detail.failure ?? detail.summary.failure
            task.engineError = failure?.safeMessage ?? detail.summary.error
            task.runDir = detail.summary.runDir ?? failure?.runDir ?? task.runDir
            task.artifactPaths = detail.artifacts.map(\.path)
            if let final = detail.finalSummary, !final.isEmpty,
               !task.activity.contains(where: { $0.title == "Final summary" }) {
                task.activity.append(ActivityEvent(.message, "Final summary", detail: final))
            }
            task.answerText = await firstArtifactText(client: client, runId: id, paths: ["final/answer.md", "final/report.md", "final/summary.md"])
            task.diagnosticText = await diagnosticText(client: client, runId: id, detail: detail, error: task.engineError)
            let persistedFindings = detail.reviewFindings.compactMap { Self.finding(from: $0, taskTitle: task.title) }
            if !persistedFindings.isEmpty {
                task.findings = persistedFindings
            }
            if !detail.artifacts.isEmpty, task.plan.isEmpty {
                task.plan = detail.artifacts
                    .filter { $0.kind == "file" }
                    .prefix(8)
                    .map { PlanItem($0.path, .done, note: $0.bytes.map { "\($0) bytes" }) }
            }
            liveTasks[idx] = task
        } catch {
            if let idx = liveTasks.firstIndex(where: { $0.id == id }) {
                liveTasks[idx].engineError = "Could not load run detail: \(error)"
                liveTasks[idx].diagnosticText = liveTasks[idx].engineError
                liveTasks[idx].updatedAt = .now
            }
        }
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

    func stream(runId: String) {
        guard let client else { return }
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            do {
                for try await env in client.events(runId: runId) {
                    guard let self else { return }
                    self.apply(env, to: runId)
                }
            } catch {
                // stream ended or errored — fall through to a reconciling refresh
            }
            // The SSE stream finished (terminal `end` event closes it without yielding a
            // payload). Reconcile the row's final status from the canonical run list so a
            // completed run never stays stuck on "Running".
            await self?.reconcile(runId: runId)
        }
    }

    private func reconcile(runId: String) async {
        guard let client, let idx = liveTasks.firstIndex(where: { $0.id == runId }) else { return }
        let before = liveTasks[idx].status
        if let summary = try? await client.listRuns().first(where: { $0.runId == runId }) {
            liveTasks[idx].status = RunStatus(api: summary.state)
        } else if liveTasks[idx].status.isActive {
            liveTasks[idx].status = .unknown
            liveTasks[idx].activity.append(ActivityEvent(.system, "Lost engine stream before a terminal status. Reconnect to refresh this run."))
        }
        liveTasks[idx].updatedAt = .now
        Self.notifyTransition(from: before, to: liveTasks[idx].status, title: liveTasks[idx].title)
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
            else if let s = payload["status"]?.stringValue ?? payload["state"]?.stringValue { t.status = RunStatus(api: s) }
            else if t.status == .queued { t.status = .running }
        } else if type.hasPrefix("harness.") {
            let detail = payload["type"]?.stringValue ?? payload["kind"]?.stringValue ?? ""
            let kind: ActivityKind = detail.contains("file") ? .file
                : detail.contains("tool") ? .tool
                : detail.contains("think") ? .thinking
                : detail.contains("message") ? .message : .tool
            let h = (payload["harness"]?.stringValue).flatMap { HarnessFamily(rawValue: $0) }
            if let h, !t.harnesses.contains(h) { t.harnesses.append(h) }
            t.activity.append(ActivityEvent(kind, harness: h, Self.title(payload) ?? Self.pretty(type), at: .now))
        } else if type.hasPrefix("gate.") {
            t.activity.append(ActivityEvent(.gate, Self.title(payload) ?? Self.pretty(type), at: .now))
        } else if type.hasPrefix("review.") || type.hasPrefix("finding.") {
            t.activity.append(ActivityEvent(.review, Self.title(payload) ?? Self.pretty(type), at: .now))
            if type == "review.finding.proposed", let f = Self.finding(from: payload, taskTitle: t.title) {
                t.findings.append(f)
            }
        } else if type.hasPrefix("budget.") {
            if let spend = payload["spend_usd"]?.doubleValue ?? payload["cost_usd"]?.doubleValue ?? payload["usd"]?.doubleValue { t.spendUsd = spend }
            if let cap = payload["max_usd"]?.doubleValue, cap > 0 { t.capUsd = cap }
        } else {
            t.activity.append(ActivityEvent(.system, Self.title(payload) ?? Self.pretty(type), at: .now))
        }
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
        let severity: Severity = sevRaw.contains("block") ? .blocker
            : sevRaw.contains("fix_first") || sevRaw.contains("major") || sevRaw.contains("high") ? .major
            : sevRaw.contains("nit") || sevRaw.contains("low") ? .nit : .minor
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
