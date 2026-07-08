import Foundation

/// Starts the engine-service (claudexord) bundled inside the notarized .app, so the app is
/// one-click self-contained. The bundle ships a notarized `node` and a single-file
/// `claudexord.bundle.cjs` in Resources; this spawns them when nothing is already serving the
/// control-api. It is a safe no-op in the SwiftPM dev executable (no bundled assets), where
/// the developer runs `claudexord` from the repo instead.
enum DaemonLauncher {
    static var bundledNode: URL? { Bundle.main.resourceURL?.appendingPathComponent("node") }
    static var bundledDaemon: URL? { Bundle.main.resourceURL?.appendingPathComponent("claudexord.bundle.cjs") }

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
        process.environment = daemonEnvironment()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            return true
        } catch {
            return false
        }
    }

    private static func daemonEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if env["HOME", default: ""].isEmpty || env["HOME"] == "/" {
            env["HOME"] = home
        }
        let existingPath = env["PATH", default: "/usr/bin:/bin:/usr/sbin:/sbin"]
        let extraPaths = [
            "\(home)/.claudexor/node/bin",
            "\(home)/.local/bin",
            "\(home)/.npm-global/bin",
            "\(home)/.bun/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        var seen = Set<String>()
        env["PATH"] = (extraPaths + [existingPath])
            .flatMap { $0.split(separator: ":").map(String.init) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: ":")
        return env
    }
}
