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
        if let url = Bundle.module.url(forResource: "AppIcon", withExtension: "png"),
           let img = NSImage(contentsOf: url) {
            NSApp.applicationIconImage = img
        }
        applyDebugSizeIfRequested()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

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
