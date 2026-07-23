import Foundation
import ClaudexorKit

// MARK: - Production RuntimeDaemonControl (D-2)
//
// Wires the install coordinator's daemon-lifecycle port to the REAL machinery:
//  - probeVersion: spawn the app-bundled Node against the unpacked closure's
//    daemon with `--probe` (side-effect-free version handshake, no socket).
//  - stop: spawn the app-bundled Node against the app-bundled daemon with
//    `--stop`, which reuses the daemon's socket `claudexor.shutdown` +
//    identity-proven termination confirmation (never a raw kill).
//  - start: DaemonLauncher (relaunch against the ACTIVE pointer).
//  - isBusy / handshakeVersion: injected async closures over the app's
//    GatewayClient (active-runs listing / protocol handshake), so this struct
//    stays Sendable and testable.

struct AppRuntimeDaemonControl: RuntimeDaemonControl {
    /// Active-runs probe: true = a run is queued/running (busy), false = idle,
    /// nil = the daemon could not be asked (coordinator treats nil as busy).
    let isBusyProbe: @Sendable () async -> Bool?
    /// Live handshake engine version, nil when unreachable.
    let handshakeProbe: @Sendable () async -> String?

    func isBusy() async -> Bool? { await isBusyProbe() }
    func handshakeVersion() async -> String? { await handshakeProbe() }

    func start() throws {
        guard DaemonLauncher.startIfNeeded() else {
            throw RuntimeInstallError.io("could not relaunch the engine daemon")
        }
    }

    func stop() async throws {
        guard let node = DaemonLauncher.bundledNode, let daemon = DaemonLauncher.bundledDaemon else {
            throw RuntimeInstallError.io("no bundled daemon to drive the identity-proven stop")
        }
        let result = Self.runNodeJSON([daemon.path, "--stop"], node: node, timeout: 30)
        guard let result, (result["stopped"] as? Bool) == true else {
            throw RuntimeInstallError.io(
                "identity-proven daemon stop did not confirm termination"
                    + (result.flatMap { ($0["detail"] as? String).map { d in ": \(d)" } } ?? ""))
        }
    }

    func probeVersion(scriptURL: URL) async -> String? {
        guard let node = DaemonLauncher.bundledNode else { return nil }
        let result = Self.runNodeJSON([scriptURL.path, "--probe"], node: node, timeout: 20)
        return result?["version"] as? String
    }

    // MARK: - Subprocess helper

    /// Run the bundled Node with `args`, capture stdout, and parse the LAST
    /// JSON-object line. Returns nil on spawn failure, timeout, or unparseable
    /// output (fail-closed — the coordinator treats a nil probe/stop as failure).
    static func runNodeJSON(_ args: [String], node: URL, timeout: TimeInterval) -> [String: Any]? {
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
        // Hard timeout so a hung child never wedges an install.
        let killer = DispatchWorkItem { if proc.isRunning { proc.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        killer.cancel()
        guard proc.terminationStatus == 0 else { return nil }
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n").reversed() {
            if let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] {
                return obj
            }
        }
        return nil
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
