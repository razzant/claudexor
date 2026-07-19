import SwiftUI
import AppKit

/// v0.10 chat-first cockpit: ONE screen. The thread list + conversation IS the
/// app (ThreadsScreen); a run's detail (diff/timeline/review) opens in the
/// trailing inspector, not a separate kitchen-sink of tabs. Budget, Harness
/// Doctor, and preferences live in the Settings scene (⌘,).
struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var workbenchMode: WorkbenchMode = .runDetail
    /// The user's EXPLICIT wizard dismissal (W15/R18) — the only sticky bit.
    /// Whether onboarding is NEEDED is derived from the server's routability
    /// projection each launch (the old `onboardingComplete` flag hid the
    /// wizard forever even when a fresh v2 runtime had no routable harness).
    /// Never auto-reset; Settings → Harness Doctor is the way back in.
    @AppStorage("claudexor.onboardingDismissed") private var onboardingDismissed = false

    enum WorkbenchMode: String, CaseIterable, Identifiable {
        case runDetail = "Run Detail", canvas = "Canvas"
        var id: String { rawValue }
    }

    var body: some View {
        @Bindable var model = model
        ZStack {
            GlassBackground()
                .ignoresSafeArea()
            Group {
                if model.health == .connected {
                    ThreadsScreen()
                } else {
                    ContentUnavailableView(
                        model.health == .connecting ? "Connecting to engine" : "Engine offline",
                        systemImage: model.health == .connecting ? "dot.radiowaves.left.and.right" : "wifi.slash",
                        description: Text(model.health == .connecting
                            ? "Operational data will appear after the local engine handshake completes."
                            : "Claudexor is reconnecting automatically. Run and thread mutations stay unavailable while offline.")
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
                .inspector(isPresented: Bindable(model).inspectorPresented) {
                    runInspector
                        .inspectorColumnWidth(min: 320, ideal: 420, max: 560)
                }
                .toolbar { toolbarContent }
                // Hide the toolbar's own material so the behind-window blur is
                // continuous from the desktop through the title area.
                .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
                .tint(Theme.accent)
        }
        // Clear the SwiftUI window container so the behind-window material (and the
        // desktop beneath it) shows through — the missing piece that made the window
        // read as a solid gray panel. Window opacity is set in AppDelegate.
        .containerBackground(.clear, for: .window)
        // M9-UX item 7: track native full-screen so the backdrop switches to its
        // opaque variant (no desktop behind the window) and the floating insets
        // collapse (no stray rounded-corner chrome artifacts).
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.willEnterFullScreenNotification)) { _ in
            model.isFullScreen = true
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.willExitFullScreenNotification)) { _ in
            model.isFullScreen = false
        }
        .sheet(item: $model.authSheetTarget) { target in
            AuthSheet(family: target.family, profileId: target.profileId).environment(model)
        }
        .sheet(isPresented: Binding(
            get: { model.needsOnboarding(userDismissed: onboardingDismissed) },
            set: { presented in if !presented { onboardingDismissed = true } }
        )) {
            OnboardingView(dismissed: $onboardingDismissed).environment(model)
                .interactiveDismissDisabled(true)
        }
    }

    /// The trailing Workbench: ONE region with a [Run Detail | Canvas] switch.
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
        // settings · new. No custom status capsule and no Refresh button —
        // the engine reconnects automatically (launch + SSE), reconnect lives in
        // Settings, and the project/primary chips live in the composer, not here.
        // .iconOnly keeps each glyph centered in its glass toolbar chip.
        ToolbarItemGroup(placement: .primaryAction) {
            AppearanceMenu()

            Button { withAnimation(.snappy) { model.inspectorPresented.toggle() } } label: {
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
