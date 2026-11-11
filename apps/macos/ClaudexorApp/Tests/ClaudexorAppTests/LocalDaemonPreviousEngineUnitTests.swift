import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// Result-level and lookup contracts behind claudexor#155, below the
/// production-loop tests in `LocalDaemonPreviousEngineTests`.
@Suite(.serialized) struct LocalDaemonPreviousEngineUnitTests {
    private let old = RuntimeClosureIdentity(version: "3.1.2", buildSha: String(repeating: "a", count: 40))
    private let target = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
    private let selected = URL(fileURLWithPath: "/fixtures/App-B/Contents/Resources/claudexord.bundle.cjs")
    private let saved = URL(fileURLWithPath: "/fixtures/runtime/versions/3.1.2/claudexord.bundle.cjs")

    private func reconciler(_ daemon: ReconciliationDaemonStub) -> LocalDaemonReconciler {
        LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: LocalRuntimeLifecycleOwner(),
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: selected, authority: .bundledStampedProbe) },
            handshakePollInterval: 0.001, handshakePollTimeout: 0.05)
    }

    private func world() -> ReconciliationDaemonStub {
        let daemon = ReconciliationDaemonStub()
        daemon.servingIdentity = old
        daemon.targetIdentity = target
        daemon.savedScriptURLs = [saved]
        daemon.probeIdentities = [saved: old]
        daemon.returnedIdentity = old
        return daemon
    }

    @Test func aLaunchThatThrowsAlsoRestartsTheSavedBuildAfterAnExactStop() async {
        let daemon = world()
        daemon.failingStartScripts = [selected]

        let result = await reconciler(daemon).reconcile(serving: old)

        #expect(result == .returned(previous: old, failedTarget: target))
        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)", "stop 3.2.0", "start \(saved.path)"])
        #expect(LocalDaemonReconciliationPolicy(result) == .reconnect)
    }

    @Test func eachTargetFailureNamesWhatHappenedToThePreviousBuild() async {
        let noCopy = ReconciliationDaemonStub()
        noCopy.servingIdentity = old
        noCopy.targetIdentity = target
        #expect(await reconciler(noCopy).reconcile(serving: old)
            == .failed(.postStartUnreachable(expected: target, previous: .notSaved(old))))

        let starting = world()
        starting.targetStopRefusal = .busy
        #expect(await reconciler(starting).reconcile(serving: old)
            == .failed(.postStartUnreachable(expected: target, previous: .notRestarted(old))))
        #expect(starting.starts == 1)

        let refused = world()
        refused.returnedIdentity = nil
        #expect(await reconciler(refused).reconcile(serving: old)
            == .failed(.postStartUnreachable(expected: target, previous: .didNotReturn(old))))

        let unlaunched = world()
        unlaunched.failingStartScripts = [selected, saved]
        #expect(await reconciler(unlaunched).reconcile(serving: old)
            == .failed(.startFailed(expected: target, previous: .couldNotLaunch(old))))

        let runningChild = world()
        runningChild.runningLaunchReads = [selected: .max]
        #expect(await reconciler(runningChild).reconcile(serving: old)
            == .failed(.postStartUnreachable(expected: target, previous: .notRestarted(old))))
        #expect(runningChild.starts == 1)

        // Seen only in recovery: the failure carries the port's exact stop.
        let recovering = world()
        recovering.returnedRecoveryOnly = true
        recovering.operatorStopCommandValue = "CLAUDEXOR_CONFIG_DIR='/r' claudexor daemon stop"
        #expect(await reconciler(recovering).reconcile(serving: old)
            == .failed(.postStartUnreachable(expected: target, previous: .answeredOnlyInRecovery(
                old, stopCommand: "CLAUDEXOR_CONFIG_DIR='/r' claudexor daemon stop"))))

        // Recovery first and another engine later is not this copy holding it.
        // The window is long enough that the swap below lands inside it.
        let replacedMeanwhile = world()
        replacedMeanwhile.returnedRecoveryOnly = true
        let patient = LocalDaemonReconciler(
            daemon: replacedMeanwhile, lifecycleOwner: LocalRuntimeLifecycleOwner(),
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: selected, authority: .bundledStampedProbe) },
            handshakePollInterval: 0.001, handshakePollTimeout: 2)
        let pending = Task { await patient.reconcile(serving: old) }
        while replacedMeanwhile.recordedEvents().count < 4 { try? await Task.sleep(for: .milliseconds(5)) }
        replacedMeanwhile.setExternalEngine(RuntimeServingHandshake(
            identity: RuntimeClosureIdentity(version: "3.1.5", buildSha: String(repeating: "c", count: 40)),
            recoveryOnly: false))
        #expect(await pending.value
            == .failed(.postStartUnreachable(expected: target, previous: .didNotReturn(old))))
    }

    /// `Process` reports an exit asynchronously, so a child its exact stop just
    /// ended can read as running briefly without losing the return.
    @Test func aChildSeenGoneWithinTheGraceStillLetsTheSavedBuildStart() async {
        let daemon = world()
        daemon.runningLaunchReads = [selected: 2]
        let sut = LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: LocalRuntimeLifecycleOwner(),
            targetClosure: { LocalRuntimeClosureSelection(scriptURL: selected, authority: .bundledStampedProbe) },
            handshakePollInterval: 0.001, handshakePollTimeout: 1)

        #expect(await sut.reconcile(serving: old) == .returned(previous: old, failedTarget: target))
        #expect(daemon.events == ["stop 3.1.2", "start \(selected.path)", "stop 3.2.0", "start \(saved.path)"])
    }

    /// Every lifecycle notice, exact. The retry sentence differs by design:
    /// builds of one version never switch on their own, a newer version does.
    @Test func everyNoticeSaysWhatIsTrueForItsCase() {
        let other = RuntimeClosureIdentity(version: "3.1.5", buildSha: String(repeating: "c", count: 40))
        let sameVersion = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "a", count: 40))
        let launchMissing = "Engine v3.2.0 could not be launched because its script or the app's Node is missing"
        let noAnswer = "Engine v3.2.0 did not answer in time"
        let cases: [(LocalDaemonReconciliationResult, LocalDaemonReconciliationPolicy)] = [
            (.deferred(.previousRestarted, serving: old, target: target), .useCompatible(notice:
                "Engine v3.2.0 did not start, so Claudexor restarted the previous engine v3.1.2. It stays in use until it exits or the app is reopened; then v3.2.0 is tried again.")),
            (.deferred(.targetDidNotStart, serving: other, target: target), .useCompatible(notice:
                "Engine v3.2.0 did not start earlier, so Claudexor keeps the running engine v3.1.5. It stays in use until it exits or the app is reopened; then v3.2.0 is tried again.")),
            (.deferred(.previousRestarted, serving: sameVersion, target: target), .useCompatible(notice:
                "Engine v3.2.0 (bbbbbbbbbbbb) did not start, so Claudexor restarted the previous engine v3.2.0 (aaaaaaaaaaaa). It stays in use until it exits; then v3.2.0 (bbbbbbbbbbbb) is tried again. To try it now, use Settings → General → Switch Engine Build when work is idle.")),
            (.deferred(.targetDidNotStart, serving: sameVersion, target: target), .useCompatible(notice:
                "Engine v3.2.0 (bbbbbbbbbbbb) did not start earlier, so Claudexor keeps the running engine v3.2.0 (aaaaaaaaaaaa). It stays in use until it exits; then v3.2.0 (bbbbbbbbbbbb) is tried again. To try it now, use Settings → General → Switch Engine Build when work is idle.")),
            (.failed(.postStartUnreachable(expected: target, previous: .notSaved(old))), .failOffline(notice:
                "\(noAnswer), and no saved copy of the previous engine v3.1.2 could be verified, so it was not restarted.")),
            (.failed(.postStartUnreachable(expected: target, previous: .notRestarted(old))), .failOffline(notice:
                "\(noAnswer), and Claudexor could not confirm that no engine is still running or starting, so it did not restart the previous engine v3.1.2 beside it.")),
            (.failed(.postStartUnreachable(expected: target, previous: .couldNotLaunch(old))), .failOffline(notice:
                "\(noAnswer), and the saved copy of the previous engine v3.1.2 could not be launched because its script or the app's Node is missing.")),
            (.failed(.postStartUnreachable(expected: target, previous: .didNotReturn(old))), .failOffline(notice:
                "\(noAnswer), and the previous engine v3.1.2 did not restart with normal service. It may not read data that a newer engine already upgraded.")),
            (.failed(.startFailed(expected: target, previous: .notSaved(old))), .failOffline(notice:
                "\(launchMissing), and no saved copy of the previous engine v3.1.2 could be verified, so it was not restarted.")),
            (.failed(.postStartUnreachable(expected: target, previous: .answeredOnlyInRecovery(
                old, stopCommand: "CLAUDEXOR_CONFIG_DIR='/r' claudexor daemon stop"))), .failOffline(notice:
                "\(noAnswer), and the restarted previous engine v3.1.2 answered only in recovery mode, so it may not read data that a newer engine already upgraded. To start v3.2.0 again, run this in Terminal, then choose Retry; stopping keeps all stored data:\nCLAUDEXOR_CONFIG_DIR='/r' claudexor daemon stop")),
            (.failed(.postStartUnreachable(expected: target, previous: .answeredOnlyInRecovery(
                old, stopCommand: nil))), .failOffline(notice:
                "\(noAnswer), and the restarted previous engine v3.1.2 answered only in recovery mode, so it may not read data that a newer engine already upgraded. Stop that engine for this app's engine root, then choose Retry.")),
            (.failed(.startFailed(expected: target, previous: .notRestarted(old))), .failOffline(notice:
                "\(launchMissing), and Claudexor could not confirm that no engine is still running or starting, so it did not restart the previous engine v3.1.2 beside it.")),
            (.failed(.startFailed(expected: target, previous: .couldNotLaunch(old))), .failOffline(notice:
                "\(launchMissing), and the saved copy of the previous engine v3.1.2 could not be launched because its script or the app's Node is missing.")),
            (.failed(.startFailed(expected: target, previous: .didNotReturn(old))), .failOffline(notice:
                "\(launchMissing), and the previous engine v3.1.2 did not restart with normal service. It may not read data that a newer engine already upgraded.")),
            (.failed(.postStartMismatch(expected: target, got: other)), .failOffline(notice:
                "After the refresh, engine v3.1.5 answered instead of the selected v3.2.0.")),
            (.failed(.stopFailed(expected: target)), .failOffline(notice:
                "Engine refresh could not confirm that the previous engine stopped, so it did not start the selected runtime.")),
            (.returned(previous: old, failedTarget: target), .reconnect),
        ]
        for (result, policy) in cases {
            #expect(LocalDaemonReconciliationPolicy(result) == policy)
        }
        #expect(LocalDaemonReconciliationPolicy.lostSuccessorNotice
            == "The engine this refresh started stopped answering before Claudexor could use it.")
    }

    /// The operator stop names the root explicitly, so a shell's own
    /// `CLAUDEXOR_CONFIG_DIR` cannot redirect it, and quotes every path.
    @Test func theOperatorStopNamesTheAppsRootAndItsOwnCli() {
        let root = URL(fileURLWithPath: "/Users/o'brien/My Root/v3")
        let node = URL(fileURLWithPath: "/Applications/Claudexor.app/Contents/Resources/node")
        let cli = URL(fileURLWithPath: "/Applications/Claudexor.app/Contents/Resources/claudexor.bundle.cjs")
        #expect(DaemonLauncher.operatorStopCommand(
            root: root, node: node, cli: cli, environment: [:], fileExists: { _ in true })
            == "CLAUDEXOR_CONFIG_DIR='/Users/o'\\''brien/My Root/v3' CLAUDEXOR_DAEMON_SOCK='' '/Applications/Claudexor.app/Contents/Resources/node' '/Applications/Claudexor.app/Contents/Resources/claudexor.bundle.cjs' daemon stop")
        // The app's own socket override travels with it.
        #expect(DaemonLauncher.operatorStopCommand(
            root: URL(fileURLWithPath: "/r"), node: node, cli: cli,
            environment: ["CLAUDEXOR_DAEMON_SOCK": "/tmp/s.sock"], fileExists: { _ in true })
            == "CLAUDEXOR_CONFIG_DIR='/r' CLAUDEXOR_DAEMON_SOCK='/tmp/s.sock' '/Applications/Claudexor.app/Contents/Resources/node' '/Applications/Claudexor.app/Contents/Resources/claudexor.bundle.cjs' daemon stop")
        // Without the bundled pair, the CLI on PATH, still for this root.
        #expect(DaemonLauncher.operatorStopCommand(
            root: URL(fileURLWithPath: "/r"), node: node, cli: cli, environment: [:],
            fileExists: { $0 == node.path })
            == "CLAUDEXOR_CONFIG_DIR='/r' CLAUDEXOR_DAEMON_SOCK='' claudexor daemon stop")
        // Production derives the root from the same discovery path the app reads.
        let control = AppRuntimeDaemonControl(isBusyProbe: { false })
        #expect(control.engineRoot == ControlApiDiscovery.defaultPath()
            .deletingLastPathComponent().deletingLastPathComponent())
        #expect(control.operatorStopCommand()?.hasPrefix(
            "CLAUDEXOR_CONFIG_DIR='\(control.engineRoot.path)' ") == true)
        #expect(control.operatorStopCommand()?.hasSuffix(" daemon stop") == true)
    }

    /// The command as typed into a Terminal whose own environment names another
    /// root and another socket. Print-only stand-ins take the place of Node and
    /// of the CLI on PATH: they show what the real CLI would receive, and nothing
    /// is stopped or contacted.
    @Test func theOperatorStopKeepsTheAppsEndpointInAShellThatNamesAnother() throws {
        let files = FileManager.default
        let scratch = runtimeTestTemporaryDirectory.appendingPathComponent(
            "cx-stop-\(UUID().uuidString.prefix(8))", isDirectory: true)
        defer { try? files.removeItem(at: scratch) }
        let resources = scratch.appendingPathComponent("App's Resources", isDirectory: true)
        try files.createDirectory(at: resources, withIntermediateDirectories: true)
        let printer = #"""
        #!/bin/sh
        echo "root=[${CLAUDEXOR_CONFIG_DIR-unset}]"
        echo "socket=[${CLAUDEXOR_DAEMON_SOCK-unset}]"
        for argument in "$@"; do echo "argument=[$argument]"; done
        """#
        let node = resources.appendingPathComponent("node")
        let cli = resources.appendingPathComponent("claudexor.bundle.cjs")
        let onPath = resources.appendingPathComponent("claudexor")
        for script in [node, onPath] {
            try Data(printer.utf8).write(to: script)
            try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        }
        try Data("// read by nothing".utf8).write(to: cli)
        let root = scratch.appendingPathComponent("engine root's v3", isDirectory: true)
        func typed(_ command: String) throws -> [String] {
            let shell = Process()
            shell.executableURL = URL(fileURLWithPath: "/bin/sh")
            shell.arguments = ["-c", command]
            shell.environment = [
                "PATH": "\(resources.path):/usr/bin:/bin",
                "CLAUDEXOR_CONFIG_DIR": "/fixture/terminal-root",
                "CLAUDEXOR_DAEMON_SOCK": "/fixture/terminal-other.sock",
            ]
            let output = Pipe()
            shell.standardOutput = output
            shell.standardError = output
            try shell.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            shell.waitUntilExit()
            #expect(shell.terminationStatus == 0)
            return String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
        }
        let rootLine = "root=[\(root.path)]"
        let cliLine = "argument=[\(cli.path)]"

        // An app without its own override: the engine it launched uses the root's
        // default socket, so the Terminal's override must not reach the CLI.
        let bundled = try typed(DaemonLauncher.operatorStopCommand(
            root: root, node: node, cli: cli, environment: [:]))
        #expect(bundled == [rootLine, "socket=[]", cliLine, "argument=[daemon]", "argument=[stop]"])
        // The CLI on PATH when the bundled pair is missing: the same root and socket.
        let onPathCommand = try typed(DaemonLauncher.operatorStopCommand(
            root: root, node: nil, cli: nil, environment: [:]))
        #expect(onPathCommand == [rootLine, "socket=[]", "argument=[daemon]", "argument=[stop]"])
        // The app's own override travels with it.
        let own = scratch.appendingPathComponent("app's d.sock").path
        let overridden = try typed(DaemonLauncher.operatorStopCommand(
            root: root, node: node, cli: cli, environment: ["CLAUDEXOR_DAEMON_SOCK": own]))
        #expect(overridden == [rootLine, "socket=[\(own)]", cliLine, "argument=[daemon]", "argument=[stop]"])
    }

    /// `waitForAdmittedSpawn` must not return while a spawn its permit already
    /// admitted is still running, so the read after it is ordered. A real owner,
    /// lease and permit; the spawn is a closure held open on another thread.
    @Test func waitingForAnAdmittedSpawnReturnsOnlyAfterThatSpawnFinished() throws {
        let owner = LocalRuntimeLifecycleOwner()
        let lease = try #require(owner.claim(.reconciliation).lease)
        defer { owner.release(lease) }
        let permit = owner.launchPermit(for: lease, until: ContinuousClock.now.advanced(by: .seconds(30)))
        let inside = DispatchSemaphore(value: 0)
        let finish = DispatchSemaphore(value: 0)
        let waited = DispatchSemaphore(value: 0)
        let spawnFinished = AdmittedSpawnFlag()
        Thread.detachNewThread {
            _ = permit.perform {
                inside.signal()
                finish.wait()
                spawnFinished.set()
                return true
            }
        }
        try #require(inside.wait(timeout: .now() + 5) == .success)
        Thread.detachNewThread {
            permit.waitForAdmittedSpawn()
            waited.signal()
        }
        // Control: the spawn is still in progress, so the wait must still block.
        #expect(waited.wait(timeout: .now() + 0.5) == .timedOut)
        #expect(!spawnFinished.value)
        finish.signal()
        #expect(waited.wait(timeout: .now() + 5) == .success)
        #expect(spawnFinished.value)
        // With nothing admitted, the wait returns at once.
        let idle = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            permit.waitForAdmittedSpawn()
            idle.signal()
        }
        #expect(idle.wait(timeout: .now() + 5) == .success)
    }

    /// Retry's action is the Reconnect connection. In an isolated home with no
    /// app resources, it opens a new generation, claims the outage lease for one
    /// start, fails to launch, and the reason and the offer survive.
    @MainActor
    @Test func retryRunsTheReconnectThatMayStartTheEngineAndStaysOfferedWhenThatFails() async throws {
        try await isolatedRuntimeConsumer(
            "LocalDaemonPreviousEngineUnitTests/retryRunsTheReconnectThatMayStartTheEngineAndStaysOfferedWhenThatFails"
        ) {
            try #require(!DaemonLauncher.isAvailable)
            let model = AppModel(requestNotificationAuthorization: false)
            model.health = .offline
            model.publishLocalLifecycleFailure("Fixture lifecycle failure.")
            try #require(LocalEngineRetry.isOffered(for: model))
            let generation = model.connectionGeneration
            let before = model.localRuntimeLifecycleOwner.completionSnapshot()

            let retrying = Task { @MainActor in await LocalEngineRetry.perform(model) }
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while model.localRuntimeLifecycleOwner.completionSnapshot() == before || model.health != .offline,
                  ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }

            #expect(model.connectionGeneration == generation + 1)
            #expect(model.localRuntimeLifecycleOwner.completionSnapshot() != before)
            #expect(model.health == .offline)
            #expect(model.localDaemonReconciliationNotice == "Fixture lifecycle failure.")
            #expect(LocalEngineRetry.isOffered(for: model))
            retrying.cancel()
            await retrying.value
        }
    }

    @Test func passiveReconciliationKeepsTheRestartedBuildUntilTheTargetIsSeenServing() async {
        let daemon = world()
        let sut = reconciler(daemon)
        #expect(await sut.reconcile(serving: old) == .returned(previous: old, failedTarget: target))

        for _ in 0..<3 {
            #expect(await sut.reconcile(serving: old) == .deferred(.previousRestarted, serving: old, target: target))
        }
        #expect(daemon.stops == 2)
        #expect(daemon.starts == 2)

        // Another compatible engine is kept as well, with its own wording.
        let other = RuntimeClosureIdentity(version: "3.1.5", buildSha: String(repeating: "c", count: 40))
        daemon.setExternalEngine(RuntimeServingHandshake(identity: other, recoveryOnly: false))
        #expect(await sut.reconcile(serving: other) == .deferred(.targetDidNotStart, serving: other, target: target))

        // Once the target is observed serving, the memory is gone: a later
        // older engine is replaced automatically again.
        daemon.setExternalEngine(RuntimeServingHandshake(identity: target, recoveryOnly: false))
        #expect(await sut.reconcile(serving: target) == .coherent(target))
        daemon.setExternalEngine(RuntimeServingHandshake(identity: old, recoveryOnly: false))
        daemon.setRunningIdentity(target)
        #expect(await sut.reconcile(serving: old) == .replaced(target))
        #expect(daemon.stops == 3)
    }

    @Test func savedScriptsPreferTheContainedVersionClosureAndNeverWriteThePointer() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-saved-runtime-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let versionDir = root.appendingPathComponent("versions/3.1.2")
        try FileManager.default.createDirectory(at: versionDir, withIntermediateDirectories: true)
        let installed = versionDir.appendingPathComponent("claudexord.bundle.cjs")
        try Data("// saved".utf8).write(to: installed)
        let pointer = RuntimeCurrent(
            version: "3.2.0", path: RuntimeCurrent.versionPath("3.2.0"),
            sha256: String(repeating: "1", count: 64), installedAt: "now", engineSha: target.buildSha)
        try installer.writeCurrentAtomic(pointer)
        let pointerBytes = try Data(contentsOf: installer.currentPointerURL)
        let bundled = root.appendingPathComponent("bundled.cjs")
        try Data("// bundled".utf8).write(to: bundled)

        #expect(DaemonLauncher.savedScripts(for: old, installer: installer, bundledDaemon: bundled)
            == [installed, bundled])
        // A missing bundle or version directory offers nothing for it.
        let absent = root.appendingPathComponent("absent.cjs")
        #expect(DaemonLauncher.savedScripts(for: target, installer: installer, bundledDaemon: absent).isEmpty)
        #expect(try Data(contentsOf: installer.currentPointerURL) == pointerBytes)

        // The existing containment guard still refuses a linked version directory.
        let outside = root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data("// outside".utf8).write(to: outside.appendingPathComponent("claudexord.bundle.cjs"))
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("versions/3.1.5"), withDestinationURL: outside)
        let linked = RuntimeClosureIdentity(version: "3.1.5", buildSha: String(repeating: "c", count: 40))
        #expect(DaemonLauncher.savedScripts(for: linked, installer: installer, bundledDaemon: nil).isEmpty)
    }

    @Test func conformersWithoutALookupOfferNoSavedCopyAndNeverVouchForALaunch() throws {
        struct Minimal: RuntimeDaemonControl {
            func isBusy() async -> Bool? { false }
            func stopForRuntimeReplacement(expectedIdentity: RuntimeClosureIdentity) async throws {}
            func start() throws {}
        }
        #expect(Minimal().savedScripts(for: old).isEmpty)
        let owner = LocalRuntimeLifecycleOwner()
        let lease = try #require(owner.claim(.reconciliation).lease)
        defer { owner.release(lease) }
        let launch = try Minimal().start(
            scriptURL: selected, launchPermit: owner.launchPermit(for: lease, until: ContinuousClock.now))
        #expect(launch.isRunning())
    }
}

/// A lock-protected flag a held spawn sets from its own thread.
private final class AdmittedSpawnFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { lock.withLock { flag } }
    func set() { lock.withLock { flag = true } }
}
