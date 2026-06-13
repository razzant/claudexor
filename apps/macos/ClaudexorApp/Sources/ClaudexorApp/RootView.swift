import SwiftUI

/// v0.10 chat-first cockpit: ONE screen. The thread list + conversation IS the
/// app (ThreadsScreen); a run's detail (diff/timeline/review) opens in the
/// trailing inspector, not a separate kitchen-sink of tabs. Budget, Harness
/// Doctor, and preferences live in the Settings scene (⌘,).
struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var inspectorPresented = false
    @AppStorage("claudexor.onboardingComplete") private var onboardingComplete = false

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
                .tint(Theme.accent)
        }
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

    /// The trailing inspector: the opened run's full detail (diff/timeline/review/
    /// diagnostics), reusing the existing TaskDetail surface beside the chat.
    @ViewBuilder private var runInspector: some View {
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
        ToolbarItemGroup(placement: .primaryAction) {
            EngineStatusDot()
            Button { Task { await model.connect() } } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .help("Reconnect & refresh")

            AppearanceMenu()

            Button { withAnimation(.snappy) { inspectorPresented.toggle() } } label: {
                Label("Run inspector", systemImage: "sidebar.trailing")
            }
            .help("Toggle the run inspector")

            SettingsLink { Label("Settings", systemImage: "gearshape") }
                .help("Preferences, budget, harness doctor (⌘,)")

            Button { model.startDraftThread() } label: {
                Label("New Thread", systemImage: "square.and.pencil")
            }
            .help("New thread — the first message starts it")
        }
    }
}

/// Compact engine-health indicator for the toolbar (replaces the old sidebar footer).
struct EngineStatusDot: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Image(systemName: model.health.glyph)
            .imageScale(.medium)
            .foregroundStyle(model.health == .connected ? Theme.status(.succeeded)
                             : (model.health == .connecting ? Theme.status(.running) : .secondary))
            .help(model.health == .connected ? "Engine · \(model.endpoint)" : model.health.label)
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
