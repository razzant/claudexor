import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// A DMG-shaped install on disk: the bundled script is the selected target, and
/// the serving build survives only as `versions/<version>`. A shell script
/// stands in for Node, so no engine, daemon, account or endpoint is involved.
/// This exercises the app's own scheduling, permits and child tracking through
/// the production control and launcher. It says nothing about how a real engine
/// boots, its data floor or its helpers.
private struct StandInEngines: Sendable {
    static let node = #"""
    #!/bin/sh
    script="$1"
    case "$2" in
    --probe)
      probes=$(cat "$script.probes" 2>/dev/null || echo 0)
      echo $((probes + 1)) > "$script.probes"
      if [ -e "$script.vanish-on-probe" ]; then rm -f "$script"; fi
      # The second probe is the launcher's own, which precedes its spawn.
      if [ "$probes" -gt 0 ]; then
        n=0
        while [ -e "$script.hold-launch" ] && [ "$n" -lt 300 ]; do sleep 0.05; n=$((n + 1)); done
      fi
      cat "$script.identity"
      # Numbered, so a wait for the launcher's probe cannot be met by an earlier one.
      : > "$script.probe-$((probes + 1))-finished"
      ;;
    --stop)
      echo "$3" >> "$script.stops"
      cat "$script.stop-answer-$3"
      ;;
    *)
      echo $$ > "$script.spawned"
      if [ -e "$script.crash" ]; then : > "$script.exited"; exit 1; fi
      n=0
      while { [ ! -e "$script.release" ] || [ -e "$script.ignore-release" ]; } && [ "$n" -lt 1200 ]; do
        sleep 0.05; n=$((n + 1))
      done
      : > "$script.exited"
      ;;
    esac
    """#

    static let alreadyStopped = #"{"stopped":true,"alreadyStopped":true}"#
    /// What a script's second probe, the launcher's own, leaves when it finishes.
    static let launcherProbeFinished = "probe-2-finished"

    let root: URL
    let nodeURL: URL
    let runtimeRoot: URL
    let target: URL
    let saved: URL
    let serving = RuntimeClosureIdentity(version: "3.1.2", buildSha: String(repeating: "a", count: 40))
    let selected = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))

    init(stopOfTarget: String = StandInEngines.alreadyStopped) throws {
        let fm = FileManager.default
        root = fm.temporaryDirectory.appendingPathComponent("cx-drill-\(UUID().uuidString)", isDirectory: true)
        runtimeRoot = root.appendingPathComponent("runtime", isDirectory: true)
        let resources = root.appendingPathComponent("Resources", isDirectory: true)
        let version = runtimeRoot.appendingPathComponent("versions/\(serving.version)", isDirectory: true)
        try fm.createDirectory(at: resources, withIntermediateDirectories: true)
        try fm.createDirectory(at: version, withIntermediateDirectories: true)
        nodeURL = root.appendingPathComponent("stand-in-node")
        target = resources.appendingPathComponent("claudexord.bundle.cjs")
        saved = version.appendingPathComponent("claudexord.bundle.cjs")
        try Data(Self.node.utf8).write(to: nodeURL)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeURL.path)
        for script in [target, saved] { try Data("// stand-in".utf8).write(to: script) }
        try Self.json(selected).write(to: marker(target, "identity"), atomically: true, encoding: .utf8)
        try Self.json(serving).write(to: marker(saved, "identity"), atomically: true, encoding: .utf8)
        try Self.alreadyStopped.write(
            to: marker(target, "stop-answer-\(serving.version)"), atomically: true, encoding: .utf8)
        try stopOfTarget.write(
            to: marker(target, "stop-answer-\(selected.version)"), atomically: true, encoding: .utf8)
    }

    private static func json(_ identity: RuntimeClosureIdentity) -> String {
        #"{"version":"\#(identity.version)","buildSha":"\#(identity.buildSha)"}"#
    }

    func marker(_ script: URL, _ name: String) -> URL {
        URL(fileURLWithPath: "\(script.path).\(name)")
    }

    func mark(_ script: URL, _ name: String) throws {
        try Data().write(to: marker(script, name))
    }

    func has(_ script: URL, _ name: String) -> Bool {
        FileManager.default.fileExists(atPath: marker(script, name).path)
    }

    /// The versions the production stop was asked to stop, in order.
    var stops: [String] {
        let text = (try? String(contentsOf: marker(target, "stops"), encoding: .utf8)) ?? ""
        return text.split(separator: "\n").map(String.init)
    }

    func probes(of script: URL) -> Int {
        let text = (try? String(contentsOf: marker(script, "probes"), encoding: .utf8)) ?? "0"
        return Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }

    /// The serving build answers until it is stopped; then only a spawned saved
    /// copy marked to answer does. The selected target never answers here.
    private func handshake() -> RuntimeServingHandshake? {
        if !stops.contains(serving.version) || (has(saved, "answers") && has(saved, "spawned")) {
            return RuntimeServingHandshake(identity: serving, recoveryOnly: false)
        }
        return nil
    }

    func reconciler(timeout: TimeInterval) -> LocalDaemonReconciler {
        let engines = self
        return LocalDaemonReconciler(
            daemon: AppRuntimeDaemonControl(
                isBusyProbe: { false }, handshakeProbe: { engines.handshake() },
                node: nodeURL, bundledDaemon: target, installer: RuntimeInstaller(root: runtimeRoot)),
            lifecycleOwner: LocalRuntimeLifecycleOwner(),
            targetClosure: {
                LocalRuntimeClosureSelection(scriptURL: engines.target, authority: .bundledStampedProbe)
            },
            handshakePollInterval: 0.02, handshakePollTimeout: timeout)
    }

    /// Release live stand-ins and wait briefly for them, so none outlives its
    /// test. A spawned one that has not exited by then fails the test, and what
    /// it runs from stays as evidence. Each also ends by itself after its polls.
    func finish() {
        for script in [target, saved] { try? mark(script, "release") }
        let deadline = Date().addingTimeInterval(3)
        var unsettled: [String] = []
        for script in [target, saved] where has(script, "spawned") {
            while !has(script, "exited"), Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
            if !has(script, "exited") { unsettled.append(teardownFact(script)) }
        }
        guard unsettled.isEmpty else {
            Issue.record("Stand-in teardown did not settle: \(unsettled.joined(separator: "; ")). Fixture kept at \(root.path)")
            return
        }
        try? FileManager.default.removeItem(at: root)
    }

    /// The stand-in wrote its own pid when it spawned, so this speaks about that
    /// exact process and signals nothing.
    private func teardownFact(_ script: URL) -> String {
        let name = script.deletingLastPathComponent().lastPathComponent
        let text = (try? String(contentsOf: marker(script, "spawned"), encoding: .utf8)) ?? ""
        guard let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return "\(name) spawned with an unknown pid"
        }
        return kill(pid, 0) == 0
            ? "\(name) is still running as pid \(pid)"
            : "\(name) pid \(pid) ended without reaching its exit marker"
    }
}

@Suite(.serialized) struct LocalDaemonProcessDrillTests {
    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !condition(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    /// A proven child that did not exit is a failed teardown, not a tidy fixture:
    /// it is reported, and what it runs from is kept as evidence.
    @Test func aStandInThatDidNotExitIsReportedAndItsFixtureKept() async throws {
        let engines = try StandInEngines()
        let owner = LocalRuntimeLifecycleOwner()
        let lease = try #require(owner.claim(.reconciliation).lease)
        defer { owner.release(lease) }
        let permit = owner.launchPermit(for: lease, until: ContinuousClock.now.advanced(by: .seconds(30)))
        let record = DaemonLaunchRecord()
        try engines.mark(engines.target, "ignore-release")
        #expect(DaemonLauncher.startIfNeeded(
            scriptURL: engines.target, launchPermit: permit, launchRecord: record, node: engines.nodeURL))
        let spawned = await waitUntil { record.isRunning && engines.has(engines.target, "spawned") }
        #expect(spawned)

        withKnownIssue("the stand-in was told to ignore its release") {
            engines.finish()
        }

        #expect(record.isRunning)
        #expect(FileManager.default.fileExists(atPath: engines.target.path))
        try FileManager.default.removeItem(at: engines.marker(engines.target, "ignore-release"))
        let exited = await waitUntil { !record.isRunning }
        #expect(exited)
        engines.finish()
        #expect(!FileManager.default.fileExists(atPath: engines.root.path))
    }

    @Test func aTargetChildThatCrashedIsGoneSoTheSavedCopyStartsAfterIt() async throws {
        let engines = try StandInEngines()
        defer { engines.finish() }
        try engines.mark(engines.target, "crash")
        try engines.mark(engines.saved, "answers")

        let result = await engines.reconciler(timeout: 3).reconcile()

        #expect(result == .returned(previous: engines.serving, failedTarget: engines.selected))
        #expect(engines.has(engines.target, "spawned"))
        #expect(engines.has(engines.saved, "spawned"))
        #expect(engines.stops == [engines.serving.version, engines.selected.version])
    }

    /// The stop answers `alreadyStopped`, as it does before a booting child has
    /// taken the writer lease. The child's own life keeps the saved copy out.
    @Test func aTargetChildStillRunningKeepsTheSavedCopyFromStarting() async throws {
        let engines = try StandInEngines()
        defer { engines.finish() }
        try engines.mark(engines.saved, "answers")

        let result = await engines.reconciler(timeout: 3).reconcile()

        #expect(result == .failed(.postStartUnreachable(
            expected: engines.selected, previous: .notRestarted(engines.serving))))
        #expect(engines.has(engines.target, "spawned"))
        #expect(!engines.has(engines.saved, "spawned"))
        // Only the candidate probe ran: the launcher's own never began.
        #expect(engines.probes(of: engines.saved) == 1)
    }

    /// The launcher's queue has not reached its spawn when the permit expires,
    /// so the stop truly finds nothing. That queued spawn must never run later.
    @Test func aTargetSpawnStillQueuedAtTheDeadlineNeverRuns() async throws {
        let engines = try StandInEngines()
        defer { engines.finish() }
        try engines.mark(engines.target, "hold-launch")
        try engines.mark(engines.saved, "answers")

        let result = await engines.reconciler(timeout: 2).reconcile()

        #expect(result == .returned(previous: engines.serving, failedTarget: engines.selected))
        #expect(engines.has(engines.saved, "spawned"))
        try FileManager.default.removeItem(at: engines.marker(engines.target, "hold-launch"))
        let probeFinished = await waitUntil { engines.has(engines.target, StandInEngines.launcherProbeFinished) }
        #expect(probeFinished)
        try await Task.sleep(for: .milliseconds(500))
        #expect(!engines.has(engines.target, "spawned"))
    }

    @Test(arguments: [
        #"{"stopped":false,"code":"runtime_activity_unknown","retryable":true,"detail":"unknown writer-lease owner"}"#,
        #"{"stopped":false,"outcome":"still_alive","detail":"daemon pid 1 is still alive"}"#,
    ])
    func aStopThatProvesNothingKeepsTheSavedCopyFromStarting(answer: String) async throws {
        let engines = try StandInEngines(stopOfTarget: answer)
        defer { engines.finish() }
        try engines.mark(engines.target, "crash")
        try engines.mark(engines.saved, "answers")

        let result = await engines.reconciler(timeout: 1).reconcile()

        #expect(result == .failed(.postStartUnreachable(
            expected: engines.selected, previous: .notRestarted(engines.serving))))
        #expect(engines.stops == [engines.serving.version, engines.selected.version])
        #expect(!engines.has(engines.saved, "spawned"))
    }

    /// The selected script's bytes vanish after its probe: nothing is scheduled,
    /// so there is no boot wait and no child to wait out.
    @Test func aSelectedScriptThatVanishedSkipsTheBootWaitAndRestartsTheSavedCopy() async throws {
        let engines = try StandInEngines()
        defer { engines.finish() }
        try engines.mark(engines.target, "vanish-on-probe")
        try engines.mark(engines.saved, "answers")

        let result = await engines.reconciler(timeout: 3).reconcile()

        #expect(result == .returned(previous: engines.serving, failedTarget: engines.selected))
        #expect(!engines.has(engines.target, "spawned"))
        #expect(engines.has(engines.saved, "spawned"))
    }

    @Test func aSavedScriptThatVanishedAfterItsProbeIsNamedAsMissing() async throws {
        let engines = try StandInEngines()
        defer { engines.finish() }
        try engines.mark(engines.target, "crash")
        try engines.mark(engines.saved, "vanish-on-probe")

        let result = await engines.reconciler(timeout: 1).reconcile()

        #expect(result == .failed(.postStartUnreachable(
            expected: engines.selected, previous: .couldNotLaunch(engines.serving))))
        #expect(!engines.has(engines.saved, "spawned"))
    }

    /// A real child that exits at start, as a daemon refusing a newer data floor
    /// does before any transport binds. Nothing it could not prove is claimed.
    @Test func aSavedCopyThatExitsAtStartIsNotReportedAsRestarted() async throws {
        let engines = try StandInEngines()
        defer { engines.finish() }
        try engines.mark(engines.target, "crash")
        try engines.mark(engines.saved, "crash")

        let result = await engines.reconciler(timeout: 2).reconcile()

        #expect(result == .failed(.postStartUnreachable(
            expected: engines.selected, previous: .didNotReturn(engines.serving))))
        #expect(engines.has(engines.saved, "spawned"))
    }

    /// The record follows a process started off the caller's queue through its
    /// exit, and a missing asset schedules nothing at all.
    @Test func theLauncherRecordFollowsItsSpawnedChildToItsExit() async throws {
        let engines = try StandInEngines()
        defer { engines.finish() }
        let owner = LocalRuntimeLifecycleOwner()
        let lease = try #require(owner.claim(.reconciliation).lease)
        defer { owner.release(lease) }
        let permit = owner.launchPermit(for: lease, until: ContinuousClock.now.advanced(by: .seconds(30)))
        let record = DaemonLaunchRecord()
        #expect(!record.isRunning)

        #expect(DaemonLauncher.startIfNeeded(
            scriptURL: engines.target, launchPermit: permit, launchRecord: record, node: engines.nodeURL))
        let spawned = await waitUntil { record.isRunning }
        #expect(spawned)
        try engines.mark(engines.target, "release")
        let exited = await waitUntil { !record.isRunning }
        #expect(exited)

        let missing = engines.root.appendingPathComponent("missing.cjs")
        #expect(!DaemonLauncher.startIfNeeded(
            scriptURL: missing, launchPermit: permit, launchRecord: record, node: engines.nodeURL))
        #expect(!DaemonLauncher.startIfNeeded(
            scriptURL: engines.target, launchPermit: permit, launchRecord: record, node: missing))
    }

    /// Releasing the lease cancels a spawn still queued behind the launcher's
    /// probe, which also covers a transaction that ended on another answer.
    @Test func releasingTheLeaseCancelsASpawnStillQueued() async throws {
        let engines = try StandInEngines()
        defer { engines.finish() }
        try "1".write(to: engines.marker(engines.target, "probes"), atomically: true, encoding: .utf8)
        try engines.mark(engines.target, "hold-launch")
        let owner = LocalRuntimeLifecycleOwner()
        let lease = try #require(owner.claim(.reconciliation).lease)
        let permit = owner.launchPermit(for: lease, until: ContinuousClock.now.advanced(by: .seconds(30)))
        let record = DaemonLaunchRecord()

        #expect(DaemonLauncher.startIfNeeded(
            scriptURL: engines.target, launchPermit: permit, launchRecord: record, node: engines.nodeURL))
        owner.release(lease)
        try FileManager.default.removeItem(at: engines.marker(engines.target, "hold-launch"))
        let probeFinished = await waitUntil { engines.has(engines.target, StandInEngines.launcherProbeFinished) }
        #expect(probeFinished)
        try await Task.sleep(for: .milliseconds(500))

        #expect(!engines.has(engines.target, "spawned"))
        #expect(!record.isRunning)
    }
}
