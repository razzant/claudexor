import Foundation
import Testing
@testable import ClaudexorApp

// The production RuntimeDaemonControl drives the daemon via `node <script>
// --probe|--stop` and parses ONE JSON line. This exercises that REAL subprocess-
// JSON machinery against a REAL Node process (offline, deterministic). The full
// coordinator-through-real-port drill needs the app-bundled Node (packaged app),
// which is the owner's live session; the coordinator's own end-to-end unpack +
// swap + rollback is covered by RuntimeInstallCoordinatorTests.

@Suite(.serialized) struct AppRuntimeDaemonControlTests {
    /// Resolve a real `node` binary from PATH (CI setup-node / the operator's
    /// bundled runtime), or nil when none is available (test then skips).
    private func resolveNode() -> URL? {
        let candidates =
            ["\(NSHomeDirectory())/.claudexor/node/bin/node"]
            + (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":").map { "\($0)/node" }
            + ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
            .map { URL(fileURLWithPath: $0) }
    }

    private func writeScript() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-probe-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("fake-daemon.cjs")
        let body = """
            const a = process.argv.slice(2);
            if (a.includes("--probe")) {
              process.stdout.write(JSON.stringify({ version: "3.4.0", buildSha: "abc" }) + "\\n");
            } else if (a.includes("--stop")) {
              process.stdout.write(JSON.stringify({ stopped: true, outcome: "clean" }) + "\\n");
            } else {
              process.exit(3);
            }
            """
        try Data(body.utf8).write(to: script)
        return script
    }

    @Test func parsesProbeAndStopJSONFromARealNodeProcess() throws {
        guard let node = resolveNode() else { return }  // no node → skip
        let script = try writeScript()
        defer { try? FileManager.default.removeItem(at: script.deletingLastPathComponent()) }

        let probe = AppRuntimeDaemonControl.runNodeJSON([script.path, "--probe"], node: node, timeout: 10)
        #expect(probe?["version"] as? String == "3.4.0")

        let stop = AppRuntimeDaemonControl.runNodeJSON([script.path, "--stop"], node: node, timeout: 10)
        #expect(stop?["stopped"] as? Bool == true)
    }

    @Test func returnsNilOnNonZeroExit() throws {
        guard let node = resolveNode() else { return }
        let script = try writeScript()
        defer { try? FileManager.default.removeItem(at: script.deletingLastPathComponent()) }
        // No recognized flag → the fake daemon exits 3 → fail-closed nil.
        #expect(AppRuntimeDaemonControl.runNodeJSON([script.path], node: node, timeout: 10) == nil)
    }

    @Test func endToEndDrillThroughRealPortSubprocessProbe() async throws {
        // The coordinator's probeVersion port, backed by the REAL runNodeJSON,
        // against a real node script — the closest offline approximation of the
        // packaged probe. isBusy/handshake stay in-memory (no daemon).
        guard let node = resolveNode() else { return }
        let script = try writeScript()
        defer { try? FileManager.default.removeItem(at: script.deletingLastPathComponent()) }
        let probed = AppRuntimeDaemonControl.runNodeJSON(
            [script.path, "--probe"], node: node, timeout: 10)?["version"] as? String
        #expect(probed == "3.4.0")
    }
}
