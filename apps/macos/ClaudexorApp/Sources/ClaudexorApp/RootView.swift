import SwiftUI
import AppKit

/// v0.10 chat-first cockpit: ONE screen. The thread list + conversation IS the
/// app (ThreadsScreen); the trailing inspector is the THREAD WORKSPACE (D42) —
/// the current thread's Changes / Artifacts / Evidence, filtered to a run when a
/// chat receipt is selected. Budget, Harness Doctor, and preferences live in the
/// Settings scene (⌘,).
struct RootView: View {
    @Environment(AppModel.self) private var model
    /// The user's EXPLICIT wizard dismissal (W15/R18) — the only sticky bit.
    /// Whether onboarding is NEEDED is derived from the server's routability
    /// projection each launch (the old `onboardingComplete` flag hid the
    /// wizard forever even when a fresh v2 runtime had no routable harness).
    /// Never auto-reset; Settings → Harness Doctor is the way back in.
    @AppStorage("claudexor.onboardingDismissed") private var onboardingDismissed = false

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
                    ThreadWorkspacePanel()
                        .inspectorColumnWidth(min: 340, ideal: 460, max: 620)
                }
                .toolbar { toolbarContent }
                // Hide the toolbar's own material so the behind-window blur is
                // continuous from the desktop through the title area.
                .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
                .tint(Theme.accent)
        }
        // Global text selection (batch-6 item c / DESIGN_SYSTEM §2.9): applied
        // ONCE at the window's root content so EVERY descendant Text is selectable
        // — the mechanism, not per-Text opt-in. Genuinely non-text controls opt
        // OUT locally; nothing opts in.
        .textSelection(.enabled)
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

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        // One minimal, native action cluster (trailing): appearance · inspector ·
        // settings · new. No custom status capsule and no Refresh button —
        // the engine reconnects automatically (launch + SSE), reconnect lives in
        // Settings, and the project/primary chips live in the composer, not here.
        // .iconOnly keeps each glyph centered in its glass toolbar chip.
        ToolbarItemGroup(placement: .primaryAction) {
            AppearanceMenu()

            Button { withAnimation(.snappy) { model.inspectorPresented.toggle() } } label: {
                Label("Thread workspace", systemImage: "sidebar.trailing")
            }
            .labelStyle(.iconOnly)
            .help("Toggle the thread workspace — changes, artifacts, evidence")

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
            appearanceLabelIcon
        }
        // QA-003 (issue-003): the primary AX NAME stays the stable English
        // product concept "Appearance"; the SELECTED mode is exposed as the
        // accessibility VALUE. Otherwise the label inferred from the mode glyph
        // (`sun.max` / `moon.stars` / `circle.lefthalf.filled`) and read as the
        // host-localized SF Symbol description (`Ясная Ночь` / `Повысить
        // Яркость`) — a name that also RENAMED the action every time the theme
        // changed. `.help` stays the separate hover hint, never the name.
        .accessibilityLabel("Appearance")
        .accessibilityValue(model.appearance.label)
        .help("Light / Dark / System")
    }

    /// GH #21: the appearance glyph differs by mode, and `sun.max` /
    /// `moon.stars` / `circle.lefthalf.filled` have DIFFERENT intrinsic widths.
    /// As this is the LEADING item of the trailing toolbar cluster, a glyph swap
    /// on a theme change re-sized it and the whole pill cluster visibly jumped.
    /// Stacking all mode glyphs (only the active one visible) reserves the widest
    /// glyph's box, so the label keeps a CONSTANT intrinsic width across theme
    /// switches — a reserved intrinsic size, no magic number. The hidden glyphs
    /// are decorative (`.accessibilityHidden`); the Menu owns the AX name/value.
    private var appearanceLabelIcon: some View {
        ZStack {
            ForEach(AppearanceMode.allCases) { mode in
                Image(systemName: mode.glyph)
                    .opacity(mode == model.appearance ? 1 : 0)
                    .accessibilityHidden(true)
            }
        }
    }
}
