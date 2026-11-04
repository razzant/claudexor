import Darwin
import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// Release qualification of a failed engine replacement on real engine bytes:
/// the production launcher and reconciler under the Node the app ships, retained
/// closures, real handshakes, the real exact stop and the CLI a notice names. No
/// window, account, provider or generation is involved.
///
/// Off unless `CX_REAL_ENGINE_DRILL` names one test. Discovery and the launcher
/// read this process's environment, so each test needs its own process, with
/// `HOME`, `CFFIXED_USER_HOME`, `CLAUDEXOR_CONFIG_DIR`, `CLAUDEXOR_DAEMON_SOCK` and
/// `TMPDIR` all under `CX_REAL_ENGINE_DRILL_ROOT`; it refuses anything else. That
/// root must be canonical and without `/private`, as a home is: the lifecycle lock
/// and the saved-copy containment guard each refuse one spelling of `/tmp`.
/// `CX_REAL_ENGINE_DRILL_NODE` is the Node. `CX_REAL_ENGINE_DRILL_PREVIOUS` and
/// `CX_REAL_ENGINE_DRILL_SELECTED` are folders laid out like an app's Resources.
/// `CX_REAL_ENGINE_DRILL_SELECTED_IDENTITY` (`version:sha`) names a selected build
/// newer than any retained one; its `--stop` still runs the real selected bytes.
private func drillRequested(_ name: String) -> Bool {
    ProcessInfo.processInfo.environment["CX_REAL_ENGINE_DRILL"] == name
}

private final class RealEngineDrill: @unchecked Sendable {
    /// What the selected engine does once the app launches it. Everything else
    /// here is real bytes; these name the only stand-in, a failure at its start.
    enum Selected: String {
        case real
        /// Dies as soon as it is launched, before any store or transport.
        case diesAtStart = "die"
        /// Runs the real selected engine until it has migrated this root and
        /// advanced its data floor, then kills it before an answer was seen.
        case migratesThenDies = "migrate-then-die"
        /// Stands in for a newer engine that migrated the store and died. Only
        /// the store's schema number is a fixture.
        case leavesNewerSchema = "schema-then-die"
    }

    private static let closureParts = [
        "claudexord.bundle.cjs", "claudexor.bundle.cjs", "setup-login-runner.cjs",
        "browser-mcp-runtime", "native",
    ]

    let root: URL
    let node: URL
    let previousSource: URL
    let resources: URL
    /// The script the app selects: the real bytes, or a stand-in in front of them.
    let bundled: URL
    let selectedReal: URL
    let cli: URL
    let daemonDir: URL
    let target: RuntimeClosureIdentity
    /// As the app wires it: the real descriptor lock in this root's discovery folder.
    let owner = LocalRuntimeLifecycleOwner(
        serviceRoot: ControlApiDiscovery.defaultPath().deletingLastPathComponent())
    let installer = RuntimeInstaller()
    private let began = Date()
    private let lock = NSLock()
    private var launches: [(script: URL, launch: RuntimeDaemonLaunch)] = []
    private var lastAnswer = ""
    private var commandCount = 0

    init(selected: Selected) throws {
        let environment = ProcessInfo.processInfo.environment
        root = URL(fileURLWithPath: try #require(environment["CX_REAL_ENGINE_DRILL_ROOT"]))
        node = URL(fileURLWithPath: try #require(environment["CX_REAL_ENGINE_DRILL_NODE"]))
        previousSource = URL(fileURLWithPath: try #require(environment["CX_REAL_ENGINE_DRILL_PREVIOUS"]))
        let selectedSource = URL(fileURLWithPath: try #require(environment["CX_REAL_ENGINE_DRILL_SELECTED"]))

        // Nothing below may reach the operator's home, stores or live engine.
        let operatorHome = String(cString: try #require(getpwuid(getuid())).pointee.pw_dir)
        let inside = root.path + "/"
        try #require(!inside.hasPrefix(operatorHome + "/"))
        for name in ["HOME", "CFFIXED_USER_HOME", "CLAUDEXOR_CONFIG_DIR", "CLAUDEXOR_DAEMON_SOCK", "TMPDIR"] {
            try #require(environment[name]?.hasPrefix(inside) == true, "\(name) is not private to this drill")
        }
        try #require(FileManager.default.homeDirectoryForCurrentUser.path.hasPrefix(inside))
        try #require(ControlApiDiscovery.defaultPath().path.hasPrefix(inside))

        daemonDir = ControlApiDiscovery.defaultPath().deletingLastPathComponent()
        resources = root.appendingPathComponent("app/Contents/Resources", isDirectory: true)
        bundled = resources.appendingPathComponent("claudexord.bundle.cjs")
        cli = resources.appendingPathComponent("claudexor.bundle.cjs")
        let real = selected == .real ? resources : resources.appendingPathComponent("selected-real", isDirectory: true)
        selectedReal = real.appendingPathComponent("claudexord.bundle.cjs")
        try Self.copyClosure(from: selectedSource, to: real)

        let override = environment["CX_REAL_ENGINE_DRILL_SELECTED_IDENTITY"]?.split(separator: ":").map(String.init)
        if let override, override.count == 2 {
            target = try #require(RuntimeClosureIdentity.validated(version: override[0], buildSha: override[1]))
        } else {
            target = try #require(Self.probe(selectedReal, node: node))
        }
        if selected != .real {
            try Self.copyClosure(from: selectedSource, to: resources, parts: ["claudexor.bundle.cjs"])
            let identity = override == nil ? "null" : #"{"version":"\#(target.version)","buildSha":"\#(target.buildSha)"}"#
            try Self.standIn(mode: selected.rawValue, identity: identity)
                .write(to: bundled, atomically: true, encoding: .utf8)
        }
        say("node=\(node.path) version=\(run(node.path, ["--version"]).out)")
        say("selected=\(target.version) (\(target.buildSha)) launched as \(selected.rawValue)")
    }

    private static func copyClosure(from source: URL, to destination: URL, parts: [String] = closureParts) throws {
        let files = FileManager.default
        try files.createDirectory(at: destination, withIntermediateDirectories: true)
        for part in parts where files.fileExists(atPath: source.appendingPathComponent(part).path) {
            // A clone: each case gets its own closure without filling the disk.
            let copy = try Process.run(
                URL(fileURLWithPath: "/bin/cp"),
                arguments: ["-cR", source.appendingPathComponent(part).path, destination.path])
            copy.waitUntilExit()
            try #require(copy.terminationStatus == 0)
        }
    }

    private static func probe(_ script: URL, node: URL) -> RuntimeClosureIdentity? {
        AppRuntimeDaemonControl.runNodeJSON([script.path, "--probe"], node: node, timeout: 20)
            .flatMap(AppRuntimeDaemonControl.runtimeIdentity(from:))
    }

    private static func standIn(mode: String, identity: String) -> String {
        #"""
        "use strict";
        const { spawn, spawnSync } = require("node:child_process");
        const fs = require("node:fs");
        const path = require("node:path");
        const real = path.join(__dirname, "selected-real", "claudexord.bundle.cjs");
        const identity = \#(identity);
        const args = process.argv.slice(2);
        if (args[0] === "--probe" && identity) {
          process.stdout.write(JSON.stringify(identity) + "\n");
          process.exit(0);
        }
        if (args[0] === "--probe" || args[0] === "--stop") {
          process.exit(spawnSync(process.execPath, [real, ...args], { stdio: "inherit" }).status ?? 1);
        }
        const daemon = path.join(process.env.CLAUDEXOR_CONFIG_DIR, "daemon");
        if ("\#(mode)" === "schema-then-die") {
          const { DatabaseSync } = require("node:sqlite");
          const db = new DatabaseSync(path.join(daemon, "engine.sqlite"));
          db.exec(`PRAGMA user_version=${db.prepare("PRAGMA user_version").get().user_version + 1}`);
          db.close();
        }
        if ("\#(mode)" !== "migrate-then-die") process.exit(1);
        const version = JSON.parse(spawnSync(process.execPath, [real, "--probe"], { encoding: "utf8" }).stdout).version;
        const child = spawn(process.execPath, [real], { stdio: "ignore" });
        const marker = path.join(daemon, "claudexord.sock.writer", "root-authority-v2.json");
        const giveUp = Date.now() + 60000;
        setInterval(() => {
          let floor;
          try { floor = JSON.parse(fs.readFileSync(marker, "utf8")).floor; } catch {}
          if (floor === version || Date.now() > giveUp) {
            child.kill("SIGKILL");
            process.exit(floor === version ? 1 : 2);
          }
        }, 50);
        """#
    }

    // MARK: Evidence

    func say(_ text: String) {
        let seconds = String(format: "%7.2f", Date().timeIntervalSince(began))
        FileHandle.standardOutput.write(Data("[drill +\(seconds)s] \(text)\n".utf8))
    }

    /// Every command is bounded and its output goes to files, so a descendant
    /// holding a pipe cannot hang the drill. A nil status means it was stopped.
    @discardableResult
    func run(
        _ executable: String, _ arguments: [String], input: String? = nil,
        environment: [String: String]? = nil, timeout: TimeInterval = 60
    ) -> (status: Int32?, out: String, err: String) {
        let number = lock.withLock { () -> Int in commandCount += 1; return commandCount }
        let scratch = root.appendingPathComponent("t/command-\(number)")
        let (outURL, errURL) = (scratch.appendingPathExtension("out"), scratch.appendingPathExtension("err"))
        FileManager.default.createFile(atPath: outURL.path, contents: nil)
        FileManager.default.createFile(atPath: errURL.path, contents: nil)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let environment { process.environment = environment }
        process.standardOutput = try? FileHandle(forWritingTo: outURL)
        process.standardError = try? FileHandle(forWritingTo: errURL)
        let stdin = input.map { _ in Pipe() }
        process.standardInput = stdin ?? FileHandle.nullDevice
        do { try process.run() } catch { return (nil, "", "did not start: \(error)") }
        if let input, let stdin {
            stdin.fileHandleForWriting.write(Data(input.utf8))
            try? stdin.fileHandleForWriting.close()
        }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        var status: Int32?
        if process.isRunning {
            process.terminate()
            let grace = Date().addingTimeInterval(5)
            while process.isRunning, Date() < grace { Thread.sleep(forTimeInterval: 0.02) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        } else {
            status = process.terminationStatus
        }
        let text = { (url: URL) in
            String(decoding: (try? Data(contentsOf: url)) ?? Data(), as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return (status, text(outURL), text(errURL))
    }

    /// An exact process from the kernel: `/bin/ps` is setuid, which the drill's
    /// sandbox cannot execute.
    func process(_ pid: Int32) -> (parent: Int32, arguments: [String])? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        var query = [CTL_KERN, KERN_PROCARGS2, pid]
        var length = 0
        guard sysctl(&query, 3, nil, &length, nil, 0) == 0, length > 4 else { return nil }
        var bytes = [UInt8](repeating: 0, count: length)
        guard sysctl(&query, 3, &bytes, &length, nil, 0) == 0 else { return nil }
        let count = bytes.withUnsafeBytes { $0.load(as: Int32.self) }
        let arguments = bytes[4..<length].split(separator: 0).dropFirst().prefix(Int(count))
            .map { String(decoding: $0, as: UTF8.self) }
        return (info.kp_eproc.e_ppid, arguments)
    }

    /// The engine serving now, tied to the launch: the writer-lease owner must be
    /// this process's own child, running the app's Node on this exact script.
    func expectEngine(_ label: String, runningFrom script: URL) async throws {
        let client = try ControlApiDiscovery.load().makeClient()
        let outcome = try await client.handshake()
        let pid = try #require(leaseOwnerPid())
        let running = try #require(process(pid))
        say("\(label): engine=\(outcome.engine?.version ?? "-") sha=\(outcome.engine?.sha ?? "-") "
            + "entry=\(outcome.engine?.entry ?? "-") mode=\(outcome.servingMode ?? "-") "
            + "lease owner pid=\(pid) parent=\(running.parent) drill=\(getpid()) argv=\(running.arguments)")
        #expect(outcome.engine?.entry == script.path)
        #expect(running.parent == getpid())
        #expect(running.arguments.first == node.path)
        #expect(running.arguments.last == script.path)
    }

    func leaseOwnerPid() -> Int32? {
        let url = daemonDir.appendingPathComponent("claudexord.sock.writer/active.writer/owner.json")
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return (json["pid"] as? NSNumber)?.int32Value
    }

    func floor() -> String? {
        let url = daemonDir.appendingPathComponent("claudexord.sock.writer/root-authority-v2.json")
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json["floor"] as? String
    }

    /// Store files with their sizes and digests, for a before and after.
    func storeFiles() -> [String: String] {
        guard let walker = FileManager.default.enumerator(at: daemonDir, includingPropertiesForKeys: nil) else { return [:] }
        var found: [String: String] = [:]
        for case let url as URL in walker {
            let name = url.path.replacingOccurrences(of: daemonDir.path + "/", with: "")
            guard name.hasPrefix("engine.sqlite") || name.hasPrefix("journal/"),
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true
            else { continue }
            found[name] = run("/usr/bin/shasum", ["-a", "256", url.path]).out.split(separator: " ").first.map(String.init)
        }
        return found
    }

    func sqlite(_ statement: String) -> String {
        let script = #"""
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        const row = db.prepare(process.argv[2]).get();
        console.log(row ? JSON.stringify(row) : "");
        db.close();
        """#
        return run(node.path, ["-e", script, daemonDir.appendingPathComponent("engine.sqlite").path, statement]).out
    }

    // MARK: The production path

    var control: RecordingDaemonControl {
        RecordingDaemonControl(
            real: AppRuntimeDaemonControl(
                // The same two probes as AppModel's production factory.
                isBusyProbe: {
                    guard let client = try? ControlApiDiscovery.load().makeClient() else { return nil }
                    do { return try await client.engineHasActiveWork() } catch { return nil }
                },
                handshakeProbe: {
                    guard let client = try? ControlApiDiscovery.load().makeClient() else { return nil }
                    return await AppRuntimeDaemonControl.servingHandshake(using: client)
                },
                node: node, bundledDaemon: bundled, cli: cli),
            drill: self)
    }

    func reconciler(
        interval: TimeInterval = LocalDaemonBootPolicy.handshakePollInterval,
        timeout: TimeInterval = LocalDaemonBootPolicy.handshakeTimeout
    ) -> LocalDaemonReconciler {
        let selected = bundled
        return LocalDaemonReconciler(
            daemon: control, lifecycleOwner: owner,
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: selected, authority: .bundledStampedProbe) },
            handshakePollInterval: interval, handshakePollTimeout: timeout)
    }

    /// Installs the retained closure where a saved build is kept, and returns the
    /// identity its own probe names under this Node.
    func installPrevious() throws -> (identity: RuntimeClosureIdentity, script: URL) {
        let identity = try #require(
            Self.probe(previousSource.appendingPathComponent("claudexord.bundle.cjs"), node: node))
        try Self.copyClosure(
            from: previousSource,
            to: installer.versionsDir.appendingPathComponent(identity.version, isDirectory: true))
        return (identity, try #require(installer.containedDaemonScript(version: identity.version)))
    }

    /// A copy of the previous closure outside where saved builds are kept: what
    /// served before, without being one of the saved copies the app may restart.
    func previousOutsideSavedCopies() throws -> URL {
        let copy = root.appendingPathComponent("earlier-app", isDirectory: true)
        try Self.copyClosure(from: previousSource, to: copy)
        return copy.appendingPathComponent("claudexord.bundle.cjs")
    }

    func remember(_ script: URL, _ launch: RuntimeDaemonLaunch) {
        lock.withLock { launches.append((script, launch)) }
        say("launcher scheduled \(script.path)")
    }

    func launchCount(of script: URL) -> Int {
        lock.withLock { launches.filter { $0.script == script }.count }
    }

    func noteAnswer(_ answer: String) {
        let changed = lock.withLock { () -> Bool in
            defer { lastAnswer = answer }
            return lastAnswer != answer
        }
        if changed { say("handshake -> \(answer)") }
    }

    /// The launcher under a lifecycle lease, as Retry reaches it, until this
    /// exact engine answers with this admission.
    @discardableResult
    func launchAndAwait(
        _ script: URL, serving identity: RuntimeClosureIdentity, recoveryOnly: Bool = false
    ) async throws -> GatewayHandshakeOutcome {
        let lease = try #require(owner.claim(.reconciliation).lease)
        defer { owner.release(lease) }
        _ = try control.start(
            scriptURL: script,
            launchPermit: owner.launchPermit(for: lease, until: ContinuousClock.now.advanced(by: .seconds(60))))
        return try #require(await awaitServing(identity, recoveryOnly: recoveryOnly))
    }

    func awaitServing(
        _ identity: RuntimeClosureIdentity, recoveryOnly: Bool = false, within seconds: TimeInterval = 60
    ) async -> GatewayHandshakeOutcome? {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let client = try? ControlApiDiscovery.load().makeClient(),
               let outcome = try? await client.handshake(), outcome.ok,
               outcome.engine?.version == identity.version, outcome.engine?.sha == identity.buildSha,
               outcome.recoveryOnly == recoveryOnly {
                return outcome
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return nil
    }

    func awaitEngineGone(within seconds: TimeInterval = 30) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if !anyLaunchRunning() { return true }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return !anyLaunchRunning()
    }

    private func anyLaunchRunning() -> Bool {
        lock.withLock { launches }.contains { $0.launch.isRunning() }
    }

    /// Stored data a run does not need a provider for, read back through the API.
    func seedProject() async throws {
        let folder = root.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let client = try ControlApiDiscovery.load().makeClient()
        let project = try await client.registerProject(root: folder.path)
        say("seeded project \(project.id)")
    }

    func seedIsReadable() async -> Bool {
        let folder = root.appendingPathComponent("project", isDirectory: true).path
        guard let client = try? ControlApiDiscovery.load().makeClient(),
              let projects = try? await client.listProjects().projects
        else { return false }
        say("projects read back: \(projects.map(\.root))")
        return projects.contains { $0.root == folder }
    }

    func notice(for result: LocalDaemonReconciliationResult) -> String? {
        switch LocalDaemonReconciliationPolicy(result) {
        case let .failOffline(notice): notice
        case let .useCompatible(notice): notice
        default: nil
        }
    }

    /// Helpers resolve beside the running script under this Node when used, so
    /// each runs here the way the engine would start it.
    func exerciseHelpers(closure: URL, entry: URL, enginePid: Int32) {
        func report(_ name: String, _ result: (status: Int32?, out: String, err: String)) {
            say("helper \(name): status=\(result.status.map(String.init) ?? "stopped") "
                + "out=[\(result.out.prefix(240))] err=[\(result.err.prefix(160))]")
        }
        let status = run(node.path, [closure.appendingPathComponent("claudexor.bundle.cjs").path, "daemon", "status", "--json"])
        report("retained CLI daemon status", status)
        #expect(status.status == 0)
        let identity = closure.appendingPathComponent("native/claudexor-process-identity")
        let identified = run(identity.path, ["--pid", String(enginePid)])
        report("process identity", identified)
        #expect(identified.status == 0)
        let belt = run(
            node.path, [entry.path, "mcp", "serve-belt"],
            input: #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"drill","version":"0"}}}"# + "\n",
            timeout: 10)
        report("delegation belt", belt)
        #expect(belt.out.contains("serverInfo"))
        let browser = run(node.path, [closure.appendingPathComponent("browser-mcp-runtime/dist/browser-mcp-launcher.js").path, "--help"])
        report("browser MCP help", browser)
        #expect(browser.out.contains("Playwright MCP"))
        let setup = run(node.path, [closure.appendingPathComponent("setup-login-runner.cjs").path])
        report("setup login runner", setup)
        #expect(setup.status == 2)
        let scanner = closure.appendingPathComponent("native/betterleaks/darwin-arm64/betterleaks")
        if FileManager.default.fileExists(atPath: scanner.path) {
            let scanned = run(scanner.path, ["version"])
            report("publication scanner", scanned)
            #expect(scanned.status == 0)
        } else {
            say("helper publication scanner: this closure ships none")
        }
    }

    /// Stops what this drill started, for this root only, and verifies it by the
    /// launch handles. An engine still running is a failure that keeps its evidence;
    /// only the exact writer-lease owner running from this root is signalled. The
    /// runner checks the process table afterwards, from outside the sandbox.
    func settle() {
        let stop = run(node.path, [cli.path, "daemon", "stop"], timeout: 45)
        say("settle: daemon stop status=\(stop.status.map(String.init) ?? "stopped") [\(stop.out)] [\(stop.err.prefix(200))]")
        if awaitEngineGone() {
            say("settle: every launch handle has exited")
            return
        }
        Issue.record("A launched engine did not exit. Evidence kept at \(root.path)")
        guard let pid = leaseOwnerPid(),
              process(pid)?.arguments.contains(where: { $0.hasPrefix(root.path + "/") }) == true
        else { return }
        kill(pid, SIGTERM)
        if !awaitEngineGone(within: 5) { kill(pid, SIGKILL) }
        say("settle: signalled exact lease owner \(pid)")
    }
}

/// The production control, with each lifecycle call on the record.
private struct RecordingDaemonControl: RuntimeDaemonControl {
    let real: AppRuntimeDaemonControl
    let drill: RealEngineDrill

    func isBusy() async -> Bool? {
        let busy = await real.isBusy()
        drill.say("active work probe -> \(busy.map(String.init) ?? "unknown")")
        return busy
    }

    func stopForRuntimeReplacement(expectedIdentity: RuntimeClosureIdentity) async throws {
        drill.say("exact stop of \(expectedIdentity.version) asked")
        do {
            try await real.stopForRuntimeReplacement(expectedIdentity: expectedIdentity)
            drill.say("exact stop of \(expectedIdentity.version) -> confirmed")
        } catch {
            drill.say("exact stop of \(expectedIdentity.version) -> refused: \(error)")
            throw error
        }
    }

    func start() throws {
        Issue.record("Reconciliation must not use the pointer-based start")
        try real.start()
    }

    func start(scriptURL: URL, launchPermit: LocalRuntimeLaunchPermit) throws -> RuntimeDaemonLaunch {
        let launch = try real.start(scriptURL: scriptURL, launchPermit: launchPermit)
        drill.remember(scriptURL, launch)
        return launch
    }

    func probeIdentity(scriptURL: URL) async -> RuntimeClosureIdentity? {
        let identity = await real.probeIdentity(scriptURL: scriptURL)
        drill.say("probe \(scriptURL.path) -> \(identity.map { "\($0.version) \($0.buildSha)" } ?? "not verified")")
        return identity
    }

    func handshakeIdentity() async -> RuntimeClosureIdentity? {
        let identity = await real.handshakeIdentity()
        drill.noteAnswer(identity.map { "\($0.version) \($0.buildSha)" } ?? "no answer")
        return identity
    }

    func servingHandshake() async -> RuntimeServingHandshake? {
        let serving = await real.servingHandshake()
        drill.noteAnswer(serving.map { "\($0.identity.version) \($0.identity.buildSha) recoveryOnly=\($0.recoveryOnly)" } ?? "no answer")
        return serving
    }

    func savedScripts(for identity: RuntimeClosureIdentity) -> [URL] { real.savedScripts(for: identity) }
    func operatorStopCommand() -> String? { real.operatorStopCommand() }
}

@Suite(.serialized) struct LocalDaemonRealEngineDrillTests {
    /// The automatic replacement this feature must not disturb, with no stand-in
    /// at all, and the older engine's own refusal once the root has moved on.
    @Test(.enabled(if: drillRequested("replace")))
    func aRealSelectedEngineReplacesTheRetainedOneAndTheOlderOneIsThenRefused() async throws {
        let drill = try RealEngineDrill(selected: .real)
        defer { drill.settle() }
        let previous = try drill.installPrevious()
        try await drill.launchAndAwait(previous.script, serving: previous.identity)
        try await drill.expectEngine("previous engine serving", runningFrom: previous.script)
        try await drill.seedProject()

        let reconciler = drill.reconciler()
        let result = await reconciler.reconcile()
        drill.say("reconcile -> \(result)")

        #expect(result == .replaced(drill.target))
        let serving = try #require(await drill.awaitServing(drill.target))
        #expect(serving.engine?.entry == drill.bundled.path)
        try await drill.expectEngine("selected engine serving", runningFrom: drill.bundled)
        #expect(await drill.seedIsReadable())
        #expect(drill.floor() == drill.target.version)
        #expect(await reconciler.reconcile() == .coherent(drill.target))

        try await drill.control.stopForRuntimeReplacement(expectedIdentity: drill.target)
        #expect(drill.awaitEngineGone())
        let refusal = drill.run(drill.node.path, [previous.script.path], timeout: 20)
        drill.say("older engine over this root: status=\(refusal.status.map(String.init) ?? "stopped") err=[\(refusal.err.suffix(600))]")
        #expect(refusal.status != nil && refusal.status != 0)
        #expect(refusal.err.contains("floor"))
    }

    /// The bounded return under production timing: only the selected engine's
    /// death at start is a stand-in.
    @Test(.enabled(if: drillRequested("return")))
    func theRetainedClosureServesAgainWhenTheSelectedEngineDiesAtStart() async throws {
        let drill = try RealEngineDrill(selected: .diesAtStart)
        defer { drill.settle() }
        let previous = try drill.installPrevious()
        try await drill.launchAndAwait(previous.script, serving: previous.identity)
        try await drill.expectEngine("previous engine serving", runningFrom: previous.script)
        let firstOwner = drill.leaseOwnerPid()
        try await drill.seedProject()

        let reconciler = drill.reconciler()
        let began = Date()
        let result = await reconciler.reconcile()
        drill.say("reconcile -> \(result) after \(Int(Date().timeIntervalSince(began))) s")

        #expect(result == .returned(previous: previous.identity, failedTarget: drill.target))
        #expect(drill.launchCount(of: drill.bundled) == 1)
        #expect(drill.launchCount(of: previous.script) == 2)
        let serving = try #require(await drill.awaitServing(previous.identity))
        #expect(serving.engine?.entry == previous.script.path)
        try await drill.expectEngine("restarted engine serving", runningFrom: previous.script)
        let owner = try #require(drill.leaseOwnerPid())
        #expect(owner != firstOwner)
        #expect(await drill.seedIsReadable())

        // A later poll keeps it and says why; nothing is stopped or launched.
        let kept = await reconciler.reconcile()
        #expect(kept == .deferred(.previousRestarted, serving: previous.identity, target: drill.target))
        drill.say("passive poll -> \(drill.notice(for: kept) ?? "no notice")")
        #expect(drill.leaseOwnerPid() == owner)

        drill.exerciseHelpers(
            closure: previous.script.deletingLastPathComponent(), entry: previous.script, enginePid: owner)

        // The exact stop the app uses proves that owner's exit by its handle.
        try await drill.control.stopForRuntimeReplacement(expectedIdentity: previous.identity)
        #expect(drill.awaitEngineGone())
        #expect(kill(owner, 0) != 0)
    }

    /// The selected engine really migrated the root and died unseen, so the saved
    /// closure really is refused. Retry's selection still serves that data.
    @Test(.enabled(if: drillRequested("floor")))
    func theRetainedClosureRefusedByANewerDataFloorIsReportedAndTheDataSurvives() async throws {
        let drill = try RealEngineDrill(selected: .migratesThenDies)
        defer { drill.settle() }
        let previous = try drill.installPrevious()
        try await drill.launchAndAwait(previous.script, serving: previous.identity)
        try await drill.expectEngine("previous engine serving", runningFrom: previous.script)
        try await drill.seedProject()

        // Polls slower than the migration, so no answer is seen before it dies.
        let reconciler = drill.reconciler(interval: 15, timeout: 20)
        let result = await reconciler.reconcile()
        drill.say("reconcile -> \(result)")

        #expect(result == .failed(.postStartUnreachable(
            expected: drill.target, previous: .didNotReturn(previous.identity))))
        #expect(drill.floor() == drill.target.version)
        #expect(drill.launchCount(of: previous.script) == 2)
        #expect(drill.awaitEngineGone())
        let notice = try #require(drill.notice(for: result))
        drill.say("notice: \(notice)")
        #expect(notice.contains("did not restart with normal service"))

        // The launcher discards the child's output, so ask the same script again.
        let refusal = drill.run(drill.node.path, [previous.script.path], timeout: 20)
        drill.say("the refusal itself: status=\(refusal.status.map(String.init) ?? "stopped") err=[\(refusal.err.suffix(600))]")
        #expect(refusal.status != nil && refusal.status != 0)
        #expect(refusal.err.contains("floor"))

        let serving = try await drill.launchAndAwait(drill.selectedReal, serving: drill.target)
        #expect(serving.engine?.entry == drill.selectedReal.path)
        try await drill.expectEngine("selected engine serving after Retry's launch", runningFrom: drill.selectedReal)
        #expect(await drill.seedIsReadable())
        #expect(await reconciler.reconcile() == .coherent(drill.target))
    }

    /// The saved closure answers only in recovery and keeps the root. The exact
    /// stop refuses it; the command its notice names stops it and keeps the data.
    @Test(.enabled(if: drillRequested("recovery")))
    func theRetainedClosureInRecoveryStopsWithTheCommandItsNoticeNames() async throws {
        let drill = try RealEngineDrill(selected: .leavesNewerSchema)
        defer { drill.settle() }
        let previous = try drill.installPrevious()
        try await drill.launchAndAwait(previous.script, serving: previous.identity)
        try await drill.expectEngine("previous engine serving", runningFrom: previous.script)
        try await drill.seedProject()
        let schema = drill.sqlite("PRAGMA user_version")
        drill.say("store schema before: \(schema)")

        let environment = ProcessInfo.processInfo.environment
        let command = "CLAUDEXOR_CONFIG_DIR='\(environment["CLAUDEXOR_CONFIG_DIR"] ?? "")' "
            + "CLAUDEXOR_DAEMON_SOCK='\(environment["CLAUDEXOR_DAEMON_SOCK"] ?? "")' "
            + "'\(drill.node.path)' '\(drill.cli.path)' daemon stop"
        let result = await drill.reconciler(timeout: 20).reconcile()
        drill.say("reconcile -> \(result)")

        #expect(result == .failed(.postStartUnreachable(
            expected: drill.target, previous: .answeredOnlyInRecovery(previous.identity, stopCommand: command))))
        let notice = try #require(drill.notice(for: result))
        drill.say("notice: \(notice)")
        #expect(notice.hasSuffix("\n\(command)"))
        let serving = try #require(await drill.awaitServing(previous.identity, recoveryOnly: true))
        #expect(serving.engine?.entry == previous.script.path)
        try await drill.expectEngine("restarted engine holding the root", runningFrom: previous.script)
        let owner = try #require(drill.leaseOwnerPid())

        do {
            try await drill.control.stopForRuntimeReplacement(expectedIdentity: previous.identity)
            Issue.record("The exact stop should refuse a recovery-only engine")
        } catch {
            #expect(error as? RuntimeReplacementStopError == .activityUnknown)
        }
        #expect(kill(owner, 0) == 0)
        #expect(drill.leaseOwnerPid() == owner)

        let before = drill.storeFiles()
        drill.say("store files before the named stop: \(before.sorted { $0.key < $1.key })")
        // Only what the notice carries: a shell with none of this drill's engine variables.
        let stop = drill.run(
            "/bin/sh", ["-c", command],
            environment: ["PATH": "/usr/bin:/bin", "HOME": environment["HOME"] ?? ""], timeout: 45)
        drill.say("named command: status=\(stop.status.map(String.init) ?? "stopped") out=[\(stop.out)] err=[\(stop.err.suffix(300))]")
        #expect(stop.status == 0)
        #expect(drill.awaitEngineGone())
        #expect(kill(owner, 0) != 0)

        let after = drill.storeFiles()
        drill.say("store files after the named stop: \(after.sorted { $0.key < $1.key })")
        #expect(Set(before.keys).isSubset(of: Set(after.keys)))
        #expect(after["engine.sqlite"] == before["engine.sqlite"])
        #expect(drill.sqlite("PRAGMA user_version") != schema)

        // The fixture's schema number restored, the same engine reads the same data.
        let number = schema.filter(\.isNumber)
        drill.say("restoring schema number \(number): \(drill.sqlite("PRAGMA user_version=\(number)"))")
        let again = try await drill.launchAndAwait(previous.script, serving: previous.identity)
        #expect(again.engine?.entry == previous.script.path)
        #expect(await drill.seedIsReadable())
    }

    /// A kept closure this Node cannot load is "not verified": nothing starts from
    /// it, the notice says so, and Retry's selection still serves the same root.
    @Test(.enabled(if: drillRequested("unverified")))
    func aKeptClosureThatCannotLoadIsNotVerifiedAndNothingStartsFromIt() async throws {
        let drill = try RealEngineDrill(selected: .diesAtStart)
        defer { drill.settle() }
        let previous = try drill.installPrevious()
        let earlier = try drill.previousOutsideSavedCopies()
        let truncated = try Data(contentsOf: previous.script)
        try truncated.prefix(truncated.count / 2).write(to: previous.script)
        try await drill.launchAndAwait(earlier, serving: previous.identity)
        try await drill.expectEngine("previous engine serving", runningFrom: earlier)
        try await drill.seedProject()

        let result = await drill.reconciler(timeout: 6).reconcile()
        drill.say("reconcile -> \(result)")

        #expect(result == .failed(.postStartUnreachable(
            expected: drill.target, previous: .notSaved(previous.identity))))
        #expect(drill.launchCount(of: previous.script) == 0)
        let notice = try #require(drill.notice(for: result))
        drill.say("notice: \(notice)")
        #expect(notice.contains("could be verified, so it was not restarted"))
        #expect(drill.awaitEngineGone())

        try await drill.launchAndAwait(drill.selectedReal, serving: drill.target)
        try await drill.expectEngine("selected engine serving after Retry's launch", runningFrom: drill.selectedReal)
        #expect(await drill.seedIsReadable())
    }
}
