import Foundation
import ClaudexorKit

// MARK: - Production RuntimeDaemonControl (D-2)
//
// Wires the install coordinator's daemon-lifecycle port to the REAL machinery:
//  - probeIdentity: spawn the app-bundled Node against the unpacked closure's
//    daemon with `--probe` (side-effect-free exact identity, no socket).
//  - stopForRuntimeReplacement: spawn the app-bundled Node against the
//    app-bundled daemon with `--stop <observed-version> <observed-sha>`, which
//    uses the daemon-owned identity/idle/admission fence plus identity-proven
//    termination confirmation.
//  - start: DaemonLauncher (relaunch against the ACTIVE pointer).
//  - savedScripts: DaemonLauncher's saved copies of one exact build, for the
//    reconciler's bounded return after a failed replacement.
//  - operatorStopCommand: the manual stop a notice names when an engine that
//    cannot serve keeps this app's root.
//  - isBusy / handshake: injected async closures over the app's GatewayClient
//    (active-runs listing / protocol handshake), so this struct stays Sendable
//    and testable.

struct AppRuntimeDaemonControl: RuntimeDaemonControl {
    /// Active-runs probe: true = a run is queued/running (busy), false = idle,
    /// nil = the daemon could not be asked (coordinator treats nil as busy).
    let isBusyProbe: @Sendable () async -> Bool?
    /// One live handshake: exact identity plus product admission, nil when
    /// unreachable, incompatible or unstamped.
    let handshakeProbe: @Sendable () async -> RuntimeServingHandshake?
    /// Reconciliation's launch assets: the app bundle and the user's runtime
    /// directory in production, stand-ins in an offline process drill.
    let node: URL?
    let bundledDaemon: URL?
    let installer: RuntimeInstaller
    /// The CLI beside the bundled daemon, and the root this app's engine uses:
    /// the one its discovery reads, from the environment the launcher passes on.
    let cli: URL?
    let engineRoot: URL
    let environment: [String: String]

    init(
        isBusyProbe: @escaping @Sendable () async -> Bool?,
        handshakeProbe: @escaping @Sendable () async -> RuntimeServingHandshake? = { nil },
        node: URL? = DaemonLauncher.bundledNode,
        bundledDaemon: URL? = DaemonLauncher.bundledDaemon,
        installer: RuntimeInstaller = RuntimeInstaller(),
        cli: URL? = DaemonLauncher.bundledCLI,
        engineRoot: URL = ControlApiDiscovery.defaultPath()
            .deletingLastPathComponent().deletingLastPathComponent(),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.isBusyProbe = isBusyProbe
        self.handshakeProbe = handshakeProbe
        self.node = node
        self.bundledDaemon = bundledDaemon
        self.installer = installer
        self.cli = cli
        self.engineRoot = engineRoot
        self.environment = environment
    }

    func isBusy() async -> Bool? { await isBusyProbe() }
    func handshakeIdentity() async -> RuntimeClosureIdentity? { await handshakeProbe()?.identity }
    func servingHandshake() async -> RuntimeServingHandshake? { await handshakeProbe() }

    /// Reduce one live handshake to lifecycle facts. `ok` stays the Gateway's
    /// connectivity/protocol verdict, so a recovery-only engine still yields
    /// its exact identity; its admission travels beside it instead of being
    /// dropped.
    static func servingHandshake(using client: GatewayClient) async -> RuntimeServingHandshake? {
        guard let outcome = try? await client.handshake(), outcome.ok,
            let engine = outcome.engine,
            let identity = runtimeIdentity(version: engine.version, buildSha: engine.sha)
        else { return nil }
        return RuntimeServingHandshake(identity: identity, recoveryOnly: outcome.recoveryOnly)
    }

    func start() throws {
        guard DaemonLauncher.startIfNeeded() else {
            throw RuntimeInstallError.io("could not relaunch the engine daemon")
        }
    }

    func start(scriptURL: URL, launchPermit: LocalRuntimeLaunchPermit) throws -> RuntimeDaemonLaunch {
        let record = DaemonLaunchRecord()
        guard DaemonLauncher.startIfNeeded(
            scriptURL: scriptURL, launchPermit: launchPermit, launchRecord: record, node: node
        ) else {
            throw RuntimeInstallError.io("could not relaunch the selected engine daemon")
        }
        return RuntimeDaemonLaunch(isRunning: {
            // Ordered after any spawn the permit admitted, so a child that was
            // only just started cannot be missed.
            launchPermit.waitForAdmittedSpawn()
            return record.isRunning
        })
    }

    func stopForRuntimeReplacement(expectedIdentity: RuntimeClosureIdentity) async throws {
        guard let node, let daemon = bundledDaemon else {
            throw RuntimeInstallError.io("no bundled daemon to drive the identity-proven stop")
        }
        guard let execution = Self.runNodeJSONExecution(
            [daemon.path, "--stop", expectedIdentity.version, expectedIdentity.buildSha],
            node: node, timeout: 30)
        else {
            throw RuntimeInstallError.io("identity-proven daemon stop did not run")
        }
        let result = execution.payload
        switch result?["code"] as? String {
        case "runtime_replacement_busy":
            throw RuntimeReplacementStopError.busy
        case "runtime_activity_unknown":
            throw RuntimeReplacementStopError.activityUnknown
        default:
            break
        }
        guard execution.status == 0, let result, (result["stopped"] as? Bool) == true else {
            throw RuntimeInstallError.io(
                "identity-proven daemon stop did not confirm termination"
                    + (result.flatMap { ($0["detail"] as? String).map { d in ": \(d)" } } ?? ""))
        }
    }

    func operatorStopCommand() -> String? {
        DaemonLauncher.operatorStopCommand(
            root: engineRoot, node: node, cli: cli, environment: environment)
    }

    func savedScripts(for identity: RuntimeClosureIdentity) -> [URL] {
        DaemonLauncher.savedScripts(for: identity, installer: installer, bundledDaemon: bundledDaemon)
    }

    func probeIdentity(scriptURL: URL) async -> RuntimeClosureIdentity? {
        guard let node,
            let result = Self.runNodeJSON([scriptURL.path, "--probe"], node: node, timeout: 20)
        else { return nil }
        return Self.runtimeIdentity(from: result)
    }

    static func runtimeIdentity(from result: [String: Any]) -> RuntimeClosureIdentity? {
        runtimeIdentity(
            version: result["version"] as? String,
            buildSha: result["buildSha"] as? String)
    }

    /// Both subprocess probes and live handshakes use the same exact identity
    /// contract. In particular, `unknown`, abbreviated SHAs, and uppercase hex
    /// are presentation values, not lifecycle authority.
    static func runtimeIdentity(
        version: String?, buildSha: String?
    ) -> RuntimeClosureIdentity? {
        RuntimeClosureIdentity.validated(version: version, buildSha: buildSha)
    }

    // MARK: - Subprocess helper

    /// Run the bundled Node with `args`, capture stdout, and parse the LAST
    /// JSON-object line. Returns nil on spawn failure, a nonzero exit (such as
    /// a child terminated at its deadline), or unparseable output (fail-closed —
    /// the coordinator treats a nil probe/stop as failure).
    static func runNodeJSON(_ args: [String], node: URL, timeout: TimeInterval) -> [String: Any]? {
        guard let execution = runNodeJSONExecution(args, node: node, timeout: timeout),
              execution.status == 0
        else { return nil }
        return execution.payload
    }

    /// Preserve the final JSON refusal even when the subprocess exits nonzero;
    /// runtime replacement needs its typed busy/unknown result to remain a safe
    /// deferral rather than becoming an ambiguous lifecycle failure.
    static func runNodeJSONExecution(
        _ args: [String], node: URL, timeout: TimeInterval
    ) -> (status: Int32, payload: [String: Any]?)? {
        let proc = Process()
        proc.executableURL = node
        proc.arguments = args
        proc.environment = probeEnvironment()
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            return nil
        }
        // A nominal stage timeout: at the deadline the child gets SIGTERM, and
        // this still waits for its exit and for EOF on its output. A child that
        // ignores SIGTERM, or a descendant holding the pipe, keeps the caller
        // waiting, and an answer it prints before exiting 0 still counts.
        let killer = DispatchWorkItem { if proc.isRunning { proc.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        killer.cancel()
        var payload: [String: Any]?
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n").reversed() {
            if let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] {
                payload = obj
                break
            }
        }
        return (proc.terminationStatus, payload)
    }

    /// Minimal environment for the probe/stop child: inherit the app's env but
    /// ensure HOME and the bundled Node bin dir resolve (mirrors DaemonLauncher).
    private static func probeEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if (env["HOME"] ?? "").isEmpty || env["HOME"] == "/" { env["HOME"] = home }
        return env
    }
}
