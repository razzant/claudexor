import Foundation

/// Starts the engine-service (claudexd) bundled inside the notarized .app, so the app is
/// one-click self-contained. The bundle ships a notarized `node` and a single-file
/// `claudexd.bundle.cjs` in Resources; this spawns them when nothing is already serving the
/// control-api. It is a safe no-op in the SwiftPM dev executable (no bundled assets), where
/// the developer runs `claudexd` from the repo instead.
enum DaemonLauncher {
    static var bundledNode: URL? { Bundle.main.resourceURL?.appendingPathComponent("node") }
    static var bundledDaemon: URL? { Bundle.main.resourceURL?.appendingPathComponent("claudexd.bundle.cjs") }

    static var isAvailable: Bool {
        guard let node = bundledNode, let daemon = bundledDaemon else { return false }
        let fm = FileManager.default
        return fm.isExecutableFile(atPath: node.path) && fm.fileExists(atPath: daemon.path)
    }

    /// Spawn the bundled daemon (detached so it outlives the app). Returns false if the
    /// bundled assets aren't present (dev) or the spawn failed.
    @discardableResult
    static func startIfNeeded() -> Bool {
        guard isAvailable, let node = bundledNode, let daemon = bundledDaemon else { return false }
        let process = Process()
        process.executableURL = node
        process.arguments = [daemon.path]
        // Inherit the user environment; claudexd persists to ~/.claudex/daemon by default.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            return true
        } catch {
            return false
        }
    }
}
