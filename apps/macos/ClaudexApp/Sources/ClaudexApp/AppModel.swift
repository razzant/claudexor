import SwiftUI
import Observation
import ClaudexKit

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
    case benchmarks
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
    var appearance: AppearanceMode = .dark
    var composerPresented = false

    /// App-wide search query. Declared once on the NavigationSplitView (per WWDC25 "Build a
    /// SwiftUI app with the new design") so the toolbar search affordance is identical on every
    /// screen; list screens filter their content by this text.
    var searchQuery = ""

    /// Sample data is OFF by default and lives behind an explicit toggle, so live state is
    /// never silently mixed with mock content. When off, surfaces the engine doesn't expose
    /// yet show honest empty states instead of demo content.
    var demoMode = false

    var liveTasks: [TaskRun] = []
    var liveHarnesses: [HarnessInfo] = []
    let demoTasks: [TaskRun] = DemoData.tasks

    var projects: [Project] { demoMode ? DemoData.projects : liveProjects }
    var harnesses: [HarnessInfo] { demoMode ? DemoData.harnesses : liveHarnesses }
    var budget: BudgetState { demoMode ? DemoData.budget : .empty }
    var benchmarks: [BenchmarkRun] { demoMode ? DemoData.benchmarks : [] }
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
        // Dev/QA only: force an appearance for deterministic screenshots.
        switch ProcessInfo.processInfo.environment["CLAUDEX_DEBUG_APPEARANCE"] {
        case "light": appearance = .light
        case "dark": appearance = .dark
        default: break
        }
        // Dev/QA only: jump straight to a screen for deterministic screenshots, with
        // sample data on so the screens are populated. No effect unless the env var is set.
        if ProcessInfo.processInfo.environment["CLAUDEX_DEBUG_ROUTE"] != nil { demoMode = true }
        switch ProcessInfo.processInfo.environment["CLAUDEX_DEBUG_ROUTE"] {
        case "tasks": route = .tasks
        case "task": route = .task("run-7f3a91")
        case "convergence": route = .task("run-2bd180")
        case "interview": route = .interview
        case "review": route = .review
        case "budget": route = .budget
        case "harnesses": route = .harnesses
        case "benchmarks": route = .benchmarks
        case "settings": route = .settings
        case "composer": composerPresented = true
        default: break
        }
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
                return HarnessInfo(family: family, health: health, version: "live", auth: status.reasons?.joined(separator: ", ") ?? "native / key fallback", intents: [])
            }
        } catch {
            // Keep last-known harness rows.
        }
    }

    private static func liveTask(from s: RunSummary) -> TaskRun {
        let prompt = s.prompt ?? ""
        let title = prompt.isEmpty ? prettyTitle(s.runId) : String(prompt.prefix(64))
        let families = (s.harnesses ?? []).compactMap { HarnessFamily(rawValue: $0) }
        return TaskRun(
            id: s.runId,
            title: title,
            prompt: prompt,
            mode: RunMode(apiValue: s.mode),
            status: RunStatus(api: s.state),
            project: "live",
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
    }

    private static func prettyTitle(_ id: String) -> String {
        "Live run · " + String(id.suffix(8))
    }

    // MARK: Commands

    func startRun(prompt: String, mode: RunMode, harnesses: [HarnessFamily], primary: HarnessFamily?,
                  portfolio: String, model: String?, n: Int, capUsd: Double,
                  access: String = "workspace_write", tests: [String] = []) async {
        composerPresented = false
        let optimistic = TaskRun(
            id: "pending-\(UUID().uuidString.prefix(6))",
            title: String(prompt.prefix(64)),
            prompt: prompt,
            mode: mode,
            status: .queued,
            project: "live",
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
        liveTasks.insert(optimistic, at: 0)
        route = .task(optimistic.id)

        guard let client else { return }
        do {
            let orderedHarnesses = harnesses.map(\.rawValue)
            let req = StartRunRequest(prompt: prompt, mode: mode.apiValue,
                                      harnesses: orderedHarnesses,
                                      primaryHarness: primary?.rawValue,
                                      portfolio: portfolio,
                                      model: model?.isEmpty == false ? model : nil,
                                      n: n,
                                      maxUsd: capUsd, access: access,
                                      tests: tests.isEmpty ? nil : tests)
            let info = try await client.startRun(req)
            // swap the optimistic row for one keyed by the real run id
            if let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id }) {
                let prev = liveTasks[idx]
                liveTasks[idx] = TaskRun(
                    id: info.runId, title: prev.title, prompt: prev.prompt, mode: prev.mode,
                    status: .running, project: prev.project, specTitle: nil, harnesses: prev.harnesses,
                    n: prev.n, createdAt: prev.createdAt, updatedAt: .now, activePhase: .context,
                    spendUsd: 0, capUsd: prev.capUsd, routeProof: .unverified, attentionNote: nil,
                    plan: [], activity: prev.activity, candidates: [], findings: [], diff: [], isLive: true)
                route = .task(info.runId)
                stream(runId: info.runId)
            }
        } catch {
            if let idx = liveTasks.firstIndex(where: { $0.id == optimistic.id }) {
                liveTasks[idx].status = .failed
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
            task.mode = RunMode(apiValue: detail.summary.mode)
            task.prompt = detail.summary.prompt ?? task.prompt
            if !task.prompt.isEmpty { task.title = String(task.prompt.prefix(64)) }
            task.harnesses = (detail.summary.harnesses ?? []).compactMap { HarnessFamily(rawValue: $0) }
            task.capUsd = detail.summary.maxUsd ?? task.capUsd
            if let final = detail.finalSummary, !final.isEmpty,
               !task.activity.contains(where: { $0.title == "Final summary" }) {
                task.activity.append(ActivityEvent(.message, "Final summary", detail: final))
            }
            if !detail.artifacts.isEmpty, task.plan.isEmpty {
                task.plan = detail.artifacts
                    .filter { $0.kind == "file" }
                    .prefix(8)
                    .map { PlanItem($0.path, .done, note: $0.bytes.map { "\($0) bytes" }) }
            }
            liveTasks[idx] = task
        } catch {
            // Detail is opportunistic; live stream remains authoritative for progress.
        }
    }

    func storeSecret(name: String, value: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.setSecret(name: name, value: value)
            return true
        } catch {
            return false
        }
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
            liveTasks[idx].status = .succeeded
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
        defer { t.updatedAt = .now; liveTasks[idx] = t; Self.notifyTransition(from: before, to: t.status, title: t.title) }

        if type == "end" {
            if t.status.isActive { t.status = .succeeded }
            return
        }
        if let phase = Self.phase(for: type) { t.activePhase = phase }

        if type.hasPrefix("run.") {
            if type == "run.completed" { t.status = .succeeded }
            else if type == "run.failed" { t.status = .failed }
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
            : sevRaw.contains("major") || sevRaw.contains("high") ? .major
            : sevRaw.contains("nit") || sevRaw.contains("low") ? .nit : .minor
        let title = payload["title"]?.stringValue ?? payload["summary"]?.stringValue ?? "Finding"
        return Finding(
            id: payload["id"]?.stringValue ?? UUID().uuidString,
            severity: severity,
            category: payload["category"]?.stringValue ?? "Review",
            title: title,
            detail: payload["detail"]?.stringValue ?? payload["body"]?.stringValue ?? "",
            reviewer: (payload["reviewer"]?.stringValue ?? payload["harness"]?.stringValue).flatMap { HarnessFamily(rawValue: $0) } ?? .raw,
            routeProof: (payload["route_verified"]?.boolValue ?? false) ? .verified : .unverified,
            evidenceFile: payload["file"]?.stringValue ?? payload["path"]?.stringValue,
            evidenceLine: payload["line"]?.doubleValue.map(Int.init),
            accepted: nil,
            taskTitle: taskTitle
        )
    }
}
