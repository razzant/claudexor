import SwiftUI
import AppKit

@main
struct ClaudexorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(model.appearance.colorScheme)
                .task { await model.connect() }
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Thread") { model.startDraftThread() }
                    .keyboardShortcut("n", modifiers: .command)
            }
            // M7: user-invokable engine-runtime update check (no background timer).
            CommandGroup(after: .appInfo) {
                Button(model.runtimeUpdateChecking ? "Checking for Updates…" : "Check for Updates…") {
                    Task { await model.checkForRuntimeUpdate() }
                }
                .disabled(model.runtimeUpdateChecking)
            }
        }

        Settings {
            SettingsScreen()
                .environment(model)
                .preferredColorScheme(model.appearance.colorScheme)
                .frame(width: 760, height: 680)
        }
    }
}

/// A bare SwiftPM executable does not get a regular activation policy automatically,
/// so its window may not appear. Force `.regular` + activate on launch. (Harmless for
/// the notarized .app bundle, essential for `swift run` dev/CI.)
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // Dock icon for the dev executable (the notarized .app uses AppIcon.icns directly).
        // Never touch Bundle.module here: its generated accessor fatalErrors when the
        // resource bundle fails to load, and CFBundle refuses a quarantined bundle that
        // has no Info.plist — which crashed every browser-downloaded 3.0.0 install at
        // launch. A cosmetic icon must degrade to "no icon", not kill the app.
        if let url = Self.devIconURL, let img = NSImage(contentsOf: url) {
            NSApp.applicationIconImage = img
        }
        applyDebugSizeIfRequested()
        // Make the window non-opaque so the behind-window material (GlassBackground)
        // blends with the DESKTOP, not a solid panel — the "desktop shows faintly
        // through the window" look. Done reliably here (the window exists by now);
        // the previous per-frame guard in the SwiftUI representable never fired.
        makeWindowsTranslucent()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            MainActor.assumeIsolated { self?.makeWindowsTranslucent() }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    /// Resolve the dev icon by plain file path — bypassing Bundle(url:) entirely, so a
    /// quarantined or otherwise unloadable resource bundle can never crash launch.
    /// Covers both layouts: the wrapped .app (Contents/Resources/<bundle>) and the bare
    /// `swift run` executable (bundle next to the binary).
    static var devIconURL: URL? {
        devIconURL(bases: [Bundle.main.resourceURL, Bundle.main.bundleURL])
    }

    static func devIconURL(bases: [URL?]) -> URL? {
        let bundleName = "ClaudexorApp_ClaudexorApp.bundle"
        for base in bases {
            guard let base else { continue }
            let candidate = base.appendingPathComponent(bundleName).appendingPathComponent("AppIcon.png")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// Non-opaque + clear background on titled content windows so the behind-window
    /// blur reaches the desktop. This runs ONLY at launch (here + one 0.3s retry),
    /// when just the main WindowGroup window exists — the Settings scene opens later
    /// (⌘,) and is never reached by this pass, so it keeps its default opaque
    /// background (the `.titled` check alone would NOT exclude it). Reduce
    /// Transparency is handled in SwiftUI (`GlassBackground`).
    @MainActor private func makeWindowsTranslucent() {
        for win in NSApp.windows where win.contentView != nil && win.styleMask.contains(.titled) {
            win.isOpaque = false
            win.backgroundColor = .clear
        }
    }

    /// Dev/QA only: deterministically size+center the window for screenshot testing at
    /// known aspect ratios. No effect unless CLAUDEXOR_DEBUG_SIZE="WxH" is set.
    private func applyDebugSizeIfRequested() {
        guard let raw = ProcessInfo.processInfo.environment["CLAUDEXOR_DEBUG_SIZE"] else { return }
        let parts = raw.split(separator: "x").compactMap { Double($0) }
        guard parts.count == 2 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
            guard let win = NSApp.windows.first(where: { $0.isVisible }) ?? NSApp.windows.first else { return }
            win.setContentSize(NSSize(width: parts[0], height: parts[1]))
            win.center()
            win.makeKeyAndOrderFront(nil)
        }
    }
}
