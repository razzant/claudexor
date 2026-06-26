import SwiftUI

/// v0.10 chat-first cockpit: ONE screen. The thread list + conversation IS the
/// app (ThreadsScreen); a run's detail (diff/timeline/review) opens in the
/// trailing inspector, not a separate kitchen-sink of tabs. Budget, Harness
/// Doctor, and preferences live in the Settings scene (⌘,).
struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var inspectorPresented = false
    @State private var workbenchMode: WorkbenchMode = .runDetail
    @AppStorage("claudexor.onboardingComplete") private var onboardingComplete = false

    enum WorkbenchMode: String, CaseIterable, Identifiable {
        case runDetail = "Run Detail", canvas = "Canvas"
        var id: String { rawValue }
    }

    var body: some View {
        @Bindable var model = model
        ZStack {
            GlassBackground()
                .ignoresSafeArea()
            ThreadsScreen()
                .inspector(isPresented: $inspectorPresented) {
                    runInspector
                        .inspectorColumnWidth(min: 320, ideal: 420, max: 560)
                }
                .toolbar { toolbarContent }
                // Hide the toolbar's own material so the behind-window blur is
                // continuous from the desktop through the title area (В2).
                .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
                .tint(Theme.accent)
        }
        // Clear the SwiftUI window container so the behind-window material (and the
        // desktop beneath it) shows through — the missing piece that made the window
        // read as a solid gray panel (В2). Window opacity is set in AppDelegate.
        .containerBackground(.clear, for: .window)
        .sheet(item: $model.authSheetHarness) { family in
            AuthSheet(family: family).environment(model)
        }
        .sheet(isPresented: Binding(get: { !onboardingComplete }, set: { _ in })) {
            OnboardingView(completed: $onboardingComplete).environment(model)
                .interactiveDismissDisabled(true)
        }
        // Opening a run from a turn reveals its detail in the inspector.
        .onChange(of: model.route) { _, new in
            if case .task = new { inspectorPresented = true }
        }
    }

    /// The trailing Workbench (Q13): ONE region with a [Run Detail | Canvas] switch.
    /// Run Detail is the opened run's tabs; Canvas hosts the artifacts gallery and
    /// the mini-browser.
    @ViewBuilder private var runInspector: some View {
        VStack(spacing: 0) {
            Picker("Workbench", selection: $workbenchMode) {
                ForEach(WorkbenchMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding([.horizontal, .top], Theme.Spacing.sm)
            switch workbenchMode {
            case .runDetail: runDetailContent
            case .canvas: CanvasView(runId: openRunId, repoRoot: openRepoRoot)
            }
        }
    }

    private var openRunId: String? {
        if case .task(let id) = model.route { return id }
        return nil
    }

    /// The open task's project root — drives the Canvas browser auto-load.
    private var openRepoRoot: String? {
        guard let id = openRunId else { return nil }
        return model.task(id)?.repoRoot
    }

    @ViewBuilder private var runDetailContent: some View {
        if case .task(let id) = model.route {
            TaskDetailView(taskId: id)
        } else {
            ContentUnavailableView(
                "No run open",
                systemImage: "sidebar.trailing",
                description: Text("Open a run from a turn to inspect its diff, timeline, and review.")
            )
        }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        // One minimal, native action cluster (trailing): appearance · inspector ·
        // settings · new. No custom status capsule and no Refresh button (В3/В4/В10) —
        // the engine reconnects automatically (launch + SSE), reconnect lives in
        // Settings, and the project/primary chips live in the composer, not here.
        // .iconOnly keeps each glyph centered in its glass toolbar chip.
        ToolbarItemGroup(placement: .primaryAction) {
            AppearanceMenu()

            Button { withAnimation(.snappy) { inspectorPresented.toggle() } } label: {
                Label("Run inspector", systemImage: "sidebar.trailing")
            }
            .labelStyle(.iconOnly)
            .help("Toggle the run inspector — diff, timeline, review")

            SettingsLink { Label("Settings", systemImage: "gearshape") }
                .labelStyle(.iconOnly)
                .help("Preferences, budget, harness doctor (⌘,)")

            Button { model.startDraftThread() } label: {
                Label("New Thread", systemImage: "square.and.pencil")
            }
            .labelStyle(.iconOnly)
            .help("New thread — pick a project and the first message starts it")
        }
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
