import Foundation
import ClaudexorKit

public enum LocalRuntimeClosureAuthority: Sendable, Equatable {
    /// `nil` means a legacy/corrupt pointer did not carry an authoritative SHA;
    /// reconciliation must keep the compatible daemon rather than guessing.
    case installed(RuntimeClosureIdentity?)
    /// The app-signed bundled script's own exact probe is its authority.
    case bundledStampedProbe
}

public struct LocalRuntimeClosureSelection: Sendable, Equatable {
    public let scriptURL: URL
    public let authority: LocalRuntimeClosureAuthority

    public init(scriptURL: URL, authority: LocalRuntimeClosureAuthority) {
        self.scriptURL = scriptURL
        self.authority = authority
    }
}

/// The process one scheduled launch spawned, once it got that far. Its lifecycle
/// owner must not start another engine while that process runs.
final class DaemonLaunchRecord: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?

    fileprivate func spawned(_ process: Process) {
        lock.withLock { self.process = process }
    }

    var isRunning: Bool {
        lock.withLock { process?.isRunning ?? false }
    }
}

/// Starts the engine-service (claudexord) bundled inside the notarized .app, so the app is
/// one-click self-contained. The bundle ships a notarized `node` and a single-file
/// `claudexord.bundle.cjs` in Resources; this spawns them when nothing is already serving the
/// control-api. It is a safe no-op in the SwiftPM dev executable (no bundled assets), where
/// the developer runs `claudexord` from the repo instead.
///
/// M7: the daemon SCRIPT is resolved through `~/.claudexor/runtime/current.json` when an
/// updated runtime closure is installed — `versions/<v>/claudexord.bundle.cjs` — falling back
/// to the app-bundled script on first run or a missing/corrupt pointer. `node` is ALWAYS the
/// app-bundled binary (a Node bump ships a new DMG, never a runtime update).
enum DaemonLauncher {
    static var bundledNode: URL? { Bundle.main.resourceURL?.appendingPathComponent("node") }
    static var bundledDaemon: URL? { Bundle.main.resourceURL?.appendingPathComponent("claudexord.bundle.cjs") }
    static var bundledCLI: URL? { Bundle.main.resourceURL?.appendingPathComponent("claudexor.bundle.cjs") }
    static var bundledVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// The daemon script to launch: a contained installed runtime only when it
    /// is strictly newer than the app-bundled runtime. A newer DMG therefore
    /// cannot stay pinned to an older (or same-version, different-build)
    /// `current.json` closure. Missing/unorderable versions fail closed to the
    /// bundle, which is the artifact the user explicitly installed.
    /// Nil only when there is no bundled script (dev/SwiftPM).
    static func resolvedDaemon(
        installer: RuntimeInstaller = RuntimeInstaller(),
        bundledDaemon: URL? = DaemonLauncher.bundledDaemon,
        bundledVersion: String? = DaemonLauncher.bundledVersion
    ) -> URL? {
        resolvedRuntime(
            installer: installer,
            bundledDaemon: bundledDaemon,
            bundledVersion: bundledVersion)?.scriptURL
    }

    /// Resolve the launch target together with the exact identity authority that
    /// steady reconciliation must bind to. Installed closures are governed by
    /// current.json; the code-signed bundled closure is governed by its probe.
    static func resolvedRuntime(
        installer: RuntimeInstaller = RuntimeInstaller(),
        bundledDaemon: URL? = DaemonLauncher.bundledDaemon,
        bundledVersion: String? = DaemonLauncher.bundledVersion
    ) -> LocalRuntimeClosureSelection? {
        guard let bundledDaemon else { return nil }
        // QA-073: the pointer's script is resolved through the containment guard
        // — a pointer whose path escapes runtime/versions/<v>, points at a
        // symlink, or names a non-regular file falls back to the bundled runtime
        // instead of launching an attacker-planted script.
        if let current = installer.readCurrent(),
            let script = installer.containedDaemonScript(current),
            let currentVersion = SemanticVersion(current.version),
            let bundledVersion,
            let appVersion = SemanticVersion(bundledVersion),
            currentVersion > appVersion
        {
            let expected = RuntimeClosureIdentity.validated(
                version: current.version, buildSha: current.engineSha)
            return LocalRuntimeClosureSelection(
                scriptURL: script, authority: .installed(expected))
        }
        return LocalRuntimeClosureSelection(
            scriptURL: bundledDaemon, authority: .bundledStampedProbe)
    }

    /// Saved copies that may still hold an exact build after a failed
    /// replacement: the contained `versions/<version>` closure, whose helpers
    /// sit beside its script, then the app-bundled script. The caller proves
    /// each with `--probe`; nothing here touches the runtime pointer.
    static func savedScripts(
        for identity: RuntimeClosureIdentity,
        installer: RuntimeInstaller = RuntimeInstaller(),
        bundledDaemon: URL? = DaemonLauncher.bundledDaemon
    ) -> [URL] {
        let bundled = bundledDaemon.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
        return [installer.containedDaemonScript(version: identity.version), bundled].compactMap { $0 }
    }

    /// The operator stop for one engine root, spelled for a POSIX shell. Root
    /// and socket are both explicit, so a shell's own values cannot redirect
    /// it: the app's socket override travels with it, and without one the
    /// variable is set empty, which the engine reads as the root's default
    /// socket, as did the engine this app launched. The app's bundled Node and
    /// CLI are named when both exist, else the CLI on `PATH`.
    static func operatorStopCommand(
        root: URL, node: URL?, cli: URL?, environment: [String: String],
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> String {
        var words = [
            "CLAUDEXOR_CONFIG_DIR=\(shellQuoted(root.path))",
            "CLAUDEXOR_DAEMON_SOCK=\(shellQuoted(environment["CLAUDEXOR_DAEMON_SOCK", default: ""]))",
        ]
        if let node, let cli, fileExists(node.path), fileExists(cli.path) {
            words += [shellQuoted(node.path), shellQuoted(cli.path)]
        } else {
            words.append("claudexor")
        }
        return (words + ["daemon", "stop"]).joined(separator: " ")
    }

    private static func shellQuoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static var isAvailable: Bool {
        guard let node = bundledNode, let daemon = resolvedDaemon() else { return false }
        let fm = FileManager.default
        return fm.isExecutableFile(atPath: node.path) && fm.fileExists(atPath: daemon.path)
    }

    /// Spawn the resolved daemon (detached so it outlives the app). Returns false if the
    /// bundled assets aren't present (dev). Node is always app-bundled; only the
    /// daemon-script path is resolved through the installed runtime. The engine's probe
    /// names the heap ceiling first and runs off the caller's thread (outage recovery
    /// calls this on the main actor), so the spawn follows a moment later and a failed
    /// spawn surfaces through the callers' existing handshake polls. Outage
    /// recovery and reconciliation supply an exact lease/deadline permit, checked
    /// after the probe under ownership at Process.run, so retired queued work
    /// cannot spawn late. Reconciliation also reads back what was spawned.
    @discardableResult
    static func startIfNeeded(
        scriptURL: URL? = nil, launchPermit: LocalRuntimeLaunchPermit? = nil,
        launchRecord: DaemonLaunchRecord? = nil, node: URL? = DaemonLauncher.bundledNode
    ) -> Bool {
        guard let node, let daemon = scriptURL ?? resolvedDaemon() else { return false }
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: daemon.path) else {
            return false
        }
        let environment = daemonEnvironment()
        DispatchQueue.global(qos: .userInitiated).async {
            let probe = AppRuntimeDaemonControl.runNodeJSON(
                [daemon.path, "--probe"], node: node, timeout: 20)
            let process = Process()
            process.executableURL = node
            process.arguments = heapNodeArguments(probe: probe, environment: environment) + [daemon.path]
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            let spawn = {
                do {
                    try process.run()
                    launchRecord?.spawned(process)
                    return true
                } catch {
                    return false
                }
            }
            if let launchPermit {
                _ = launchPermit.perform(spawn)
            } else {
                _ = spawn()
            }
        }
        return true
    }

    /// The engine names its own V8 heap ceiling in its side-effect-free probe
    /// (`launch.nodeArgs`); the launcher only passes it before the script, where
    /// the daemon's strict argv never sees it. An operator `NODE_OPTIONS` heap
    /// flag wins, an engine without `launch` starts exactly as before, and any
    /// argument other than `--max-old-space-size=<MiB>` drops the whole list.
    static func heapNodeArguments(probe: [String: Any]?, environment: [String: String]) -> [String] {
        if environment["NODE_OPTIONS", default: ""].contains("--max-old-space-size") { return [] }
        guard let launch = probe?["launch"] as? [String: Any],
            let args = launch["nodeArgs"] as? [String],
            args.allSatisfy(isHeapCeilingArgument)
        else { return [] }
        return args
    }

    static func isHeapCeilingArgument(_ argument: String) -> Bool {
        let prefix = "--max-old-space-size="
        guard argument.hasPrefix(prefix) else { return false }
        let mebibytes = argument.dropFirst(prefix.count)
        return (3...6).contains(mebibytes.count) && mebibytes.allSatisfy { $0.isASCII && $0.isNumber }
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
