import SwiftUI
import AppKit
import ClaudexorKit

@main
struct ClaudexorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    // The only AppModel that reads and persists the user's real state.
    @State private var model = AppModel(
        persistence: .user,
        lifecycleOwner: LocalRuntimeLifecycleOwner(
            serviceRoot: ControlApiDiscovery.defaultPath().deletingLastPathComponent()))

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(model.appearance.colorScheme)
                .task {
                    delegate.model = model
                    await model.connect()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Thread") { model.startDraftThread() }
                    .keyboardShortcut("n", modifiers: .command)
            }
            // D-11: the standard macOS About panel, carrying the owner-locked
            // author/license and clickable links in its Credits. Replaces the
            // default About item so the app menu shows OUR panel; the
            // Check-for-Updates group below still anchors `after: .appInfo`.
            CommandGroup(replacing: .appInfo) {
                Button("About Claudexor") {
                    NSApp.orderFrontStandardAboutPanel(options: [
                        .credits: AboutPanel.credits,
                    ])
                    NSApp.activate(ignoringOtherApps: true)
                }
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

/// D-11: the standard About panel's Credits attributed string. Carries the same
/// owner-locked author/license/links as Settings → About (both read `AboutInfo`),
/// with the three URLs as real clickable `.link` runs.
enum AboutPanel {
    static var credits: NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.paragraphSpacing = 4

        let base: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
            .foregroundColor: NSColor.secondaryLabelColor,
            .paragraphStyle: paragraph,
        ]
        let result = NSMutableAttributedString()
        result.append(NSAttributedString(
            string: "\(AboutInfo.author)  ·  \(AboutInfo.license) License\n\n", attributes: base))

        func linkRow(_ label: String, _ url: URL, trailingNewline: Bool = true) {
            var attrs = base
            attrs[.link] = url
            attrs[.foregroundColor] = NSColor.linkColor
            result.append(NSAttributedString(string: label + (trailingNewline ? "\n" : ""), attributes: attrs))
        }
        linkRow(AboutInfo.telegramLabel, AboutInfo.telegramURL)
        linkRow(AboutInfo.twitterLabel, AboutInfo.twitterURL)
        linkRow(AboutInfo.repoLabel, AboutInfo.repoURL, trailingNewline: false)
        return result
    }
}

/// A bare SwiftPM executable does not get a regular activation policy automatically,
/// so its window may not appear. Force `.regular` + activate on launch. (Harmless for
/// the notarized .app bundle, essential for `swift run` dev/CI.)
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor weak var model: AppModel?
    private var terminationPending = false
    private weak var mainWindow: NSWindow?
    private var containmentInstalled = false
    private let containmentSettlement = WindowContainmentSettlement()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // Dock icon override. Essential for the bare dev executable (no .icns);
        // the packaged .app also passes through here and re-applies the same
        // artwork its AppIcon.icns was derived from — harmless by construction.
        // Never touch Bundle.module here: its generated accessor fatalErrors when the
        // resource bundle fails to load, and CFBundle refuses a quarantined bundle that
        // has no Info.plist — which crashed every browser-downloaded 3.0.0 install at
        // launch. A cosmetic icon must degrade to "no icon", not kill the app.
        if let url = Self.devIconURL, let img = NSImage(contentsOf: url) {
            NSApp.applicationIconImage = img
        }
        applyDebugSizeIfRequested()
        // QA-062: reclaim stale "Open externally" artifact copies from the tracked
        // handoff root on launch (bounded age; never deletes copies a receiver may
        // still hold open this session). Off the main thread — it walks the temp
        // dir. This is the lifecycle owner the scattered per-click copies lacked.
        DispatchQueue.global(qos: .utility).async {
            ExternalArtifactHandoff.standard().sweepStale()
        }
        // Make the window non-opaque so the behind-window material (GlassBackground)
        // blends with the DESKTOP, not a solid panel — the "desktop shows faintly
        // through the window" look. Done reliably here (the window exists by now);
        // the previous per-frame guard in the SwiftUI representable never fired.
        makeWindowsTranslucent()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            MainActor.assumeIsolated {
                self?.makeWindowsTranslucent()
                self?.installMainWindowContainmentIfNeeded()
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    @MainActor
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationPending, let model else { return .terminateNow }
        terminationPending = true
        Task {
            await model.shutdownRemoteConnections()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// Resolve the dev icon by plain file path — bypassing Bundle(url:) entirely, so a
    /// quarantined or otherwise unloadable resource bundle can never crash launch.
    /// Covers both layouts: the wrapped .app (Contents/Resources/<bundle>) and the bare
    /// `swift run` executable (bundle next to the binary).
    static var devIconURL: URL? {
        devIconURL(bases: [Bundle.main.resourceURL, Bundle.main.bundleURL])
    }

    nonisolated static func devIconURL(bases: [URL?]) -> URL? {
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

    /// Keep the main window inside the CURRENT owning screen's safe drawable
    /// area across resize, inspector negotiation, screen moves, full-screen
    /// reversal, and Dock/menu/display changes. `visibleFrame` is read on every
    /// event; it is intentionally never cached.
    @MainActor private func installMainWindowContainmentIfNeeded() {
        if mainWindow == nil {
            mainWindow = NSApp.windows.first(where: { $0.isVisible }) ?? NSApp.windows.first
        }
        guard let mainWindow else { return }
        containMainWindow(mainWindow)
        guard !containmentInstalled else { return }
        containmentInstalled = true

        let center = NotificationCenter.default
        for name in WindowContainment.clampWindowNotifications {
            center.addObserver(
                self,
                selector: #selector(mainWindowGeometryDidChange(_:)),
                name: name,
                object: mainWindow
            )
        }
        center.addObserver(
            self,
            selector: #selector(screenParametersDidChange(_:)),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    @objc private func mainWindowGeometryDidChange(_ note: Notification) {
        guard let window = note.object as? NSWindow else { return }
        scheduleMainWindowContainment(window)
    }

    @objc private func screenParametersDidChange(_ note: Notification) {
        guard let mainWindow else { return }
        scheduleMainWindowContainment(mainWindow)
    }

    @MainActor private func scheduleMainWindowContainment(_ window: NSWindow) {
        containmentSettlement.request { [weak self, weak window] in
            guard let self, let window else { return }
            self.containMainWindow(window)
        }
    }

    @MainActor private func containMainWindow(_ window: NSWindow) {
        guard !window.styleMask.contains(.fullScreen),
              let screen = window.screen ?? NSScreen.main else { return }
        let target = WindowContainment.clampedFrame(window.frame, within: screen.visibleFrame)
        guard target != window.frame else { return }
        window.setFrame(target, display: true)
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
