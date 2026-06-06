import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var inspectorPresented = true

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 210, ideal: 244, max: 300)
        } detail: {
            ContentRouter()
                .navigationTitle(routeTitle)
                .inspector(isPresented: $inspectorPresented) {
                    InspectorRouter()
                        .inspectorColumnWidth(min: 250, ideal: 300, max: 380)
                }
                .toolbar { toolbarContent }
        }
        .navigationSplitViewStyle(.balanced)
        .tint(Theme.accent)   // brand owns selection/controls (not the system blue)
        // App-wide search declared once on the split view (WWDC25 "Build a SwiftUI app with the
        // new design") → the toolbar search affordance is identical on every screen instead of
        // reflowing per-screen.
        .searchable(text: $model.searchQuery, placement: .toolbar, prompt: "Search")
        // Search is per-screen in meaning: don't leak one screen's query into the next.
        .onChange(of: model.route) { _, _ in
            if !model.searchQuery.isEmpty { model.searchQuery = "" }
        }
        .sheet(isPresented: $model.composerPresented) {
            ComposerView().environment(model)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button { Task { await model.connect() } } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .help("Reconnect & refresh runs")

            AppearanceMenu()

            Button {
                withAnimation(.snappy) { inspectorPresented.toggle() }
            } label: {
                Label("Inspector", systemImage: "sidebar.trailing")
            }
            .help("Toggle inspector")

            Button { model.composerPresented = true } label: {
                Label("New Task", systemImage: "plus")
            }
            .keyboardShortcut("n", modifiers: .command)
        }
    }

    private var routeTitle: String {
        switch model.route {
        case .overview: return "Home"
        case .tasks: return "Tasks"
        case .task: return model.selectedTask?.title ?? "Task"
        case .spec: return model.selectedSpec?.title ?? "Spec"
        case .interview: return "Spec Interview"
        case .review: return "Review Queue"
        case .budget: return "Budget"
        case .harnesses: return "Harnesses"
        case .benchmarks: return "Benchmarks"
        case .settings: return "Settings"
        }
    }
}

// MARK: - Content router

private struct ContentRouter: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Group {
            switch model.route {
            case .overview: HomeScreen()
            case .tasks: TasksScreen()
            case .task(let id): TaskDetailView(taskId: id)
            case .spec(let id): SpecDetailScreen(specId: id)
            case .interview: SpecInterviewScreen()
            case .review: ReviewScreen()
            case .budget: BudgetScreen()
            case .harnesses: HarnessesScreen()
            case .benchmarks: BenchmarksScreen()
            case .settings: SettingsScreen()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Inspector router

private struct InspectorRouter: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if let task = model.selectedTask {
            TaskInspectorView(task: task)
        } else {
            ContextInspectorView()
        }
    }
}

// MARK: - Sidebar (system Liquid Glass: NO custom background; full-row selectable)

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var model = model
        List(selection: $model.route) {
            Section {
                row("Home", "house", .overview)
                row("Tasks", "checklist", .tasks, badge: model.tasks.count)
                row("Review Queue", "person.2.badge.gearshape", .review,
                    badge: model.allFindings.count)
                row("Spec Interview", "bubble.left.and.text.bubble.right", .interview)
            }

            ForEach(model.projects) { project in
                Section(project.name) {
                    ForEach(project.specs) { spec in
                        specRow(spec)
                        ForEach(spec.runIds, id: \.self) { runId in
                            if let task = model.task(runId) { runRow(task) }
                        }
                    }
                }
            }

            Section("Operations") {
                row("Budget", "gauge.with.dots.needle.67percent", .budget)
                row("Harnesses", "cpu", .harnesses)
                row("Benchmarks", "chart.bar.xaxis", .benchmarks)
                row("Settings", "gearshape", .settings)
            }
        }
        .navigationTitle("Claudex")
        .safeAreaInset(edge: .bottom) { footer }
    }

    // Full-row selectable nav item (whole row is the click target).
    private func row(_ title: String, _ glyph: String, _ route: SidebarRoute, badge: Int? = nil) -> some View {
        Label(title, systemImage: glyph)
            .badge(badge.flatMap { $0 > 0 ? Text("\($0)") : nil })
            .tag(route)
    }

    private func specRow(_ spec: Spec) -> some View {
        Label {
            HStack(spacing: Theme.Spacing.xs) {
                Text(spec.title).lineLimit(1)
                if spec.frozen {
                    Text("v\(spec.version)").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        } icon: {
            Image(systemName: spec.frozen ? "doc.text.fill" : "doc.text")
                .foregroundStyle(spec.frozen ? Theme.accent : .secondary)
        }
        .tag(SidebarRoute.spec(spec.id))   // unique identity: never alias to a run's tag
    }

    private func runRow(_ task: TaskRun) -> some View {
        Label {
            Text(task.title).lineLimit(1).font(.callout)
        } icon: {
            Image(systemName: task.status.glyph).foregroundStyle(task.status.color)
        }
        .tag(SidebarRoute.task(task.id))
    }

    private var footer: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: model.health.glyph)
                .imageScale(.small)
                .foregroundStyle(model.health == .connected ? Theme.status(.succeeded) : (model.health == .connecting ? Theme.status(.running) : .secondary))
                .symbolEffect(.pulse, options: .repeating, isActive: model.health == .connecting && !reduceMotion)
            Text(model.health == .connected ? "Engine · \(model.endpoint)" : model.health.label)
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
        .accessibilityLabel("Engine \(model.health.label)")
    }
}

// MARK: - Appearance menu

struct AppearanceMenu: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        @Bindable var model = model
        Menu {
            Picker("Appearance", selection: $model.appearance) {
                ForEach(AppearanceMode.allCases) { mode in
                    Label(mode.label, systemImage: mode.glyph).tag(mode)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label("Appearance", systemImage: model.appearance.glyph)
        }
        .help("Light / Dark / System")
    }
}
