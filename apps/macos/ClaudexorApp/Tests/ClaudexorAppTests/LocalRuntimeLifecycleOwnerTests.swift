import Darwin
import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

struct LocalRuntimeLifecycleOwnerTests {
    private func root() throws -> URL {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../tmp/lifecycle-\(UUID().uuidString)")
            .standardizedFileURL
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root
    }

    /// Read-only macOS namespace regression: Foundation removes /private from
    /// these physical paths. The engine uses POSIX realpath without that rewrite.
    /// No owner claims or permission repairs target these system directories.
    @Test(arguments: ["/private/tmp", "/private/var"])
    func privateCanonicalSpellingMatchesPOSIX(path: String) throws {
        let resolved = try #require(realpath(path, nil))
        defer { free(resolved) }
        try #require(String(cString: resolved) == path)
        #expect(LocalRuntimeLifecycleOwner.hasCanonicalServiceDirectoryPath(URL(fileURLWithPath: path)))
        let alias = String(path.dropFirst("/private".count))
        #expect(!LocalRuntimeLifecycleOwner.hasCanonicalServiceDirectoryPath(URL(fileURLWithPath: alias)))
    }

    /// Uses only the runner's synthetic TMPDIR. With a canonical /private/tmp
    /// or /private/var TMPDIR this also exercises the full admission there.
    @Test func canonicalTemporaryServiceRootAdmitsButItsAliasDoesNot() throws {
        let fixture = runtimeTestTemporaryDirectory
            .appendingPathComponent("cx-canonical-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: fixture) }
        let resolved = try #require(realpath(fixture.path, nil))
        defer { free(resolved) }
        let canonical = URL(fileURLWithPath: String(cString: resolved))
        let service = canonical.appendingPathComponent("config/daemon")
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: service)
        let lease = try #require(owner.claim(.installation).lease)
        owner.release(lease)
        print("CANONICAL-SERVICE-ADMITTED \(service.path)")
        // A real symlink ancestor remains a typed refusal before permissions
        // change, even when it points into this test's own directory.
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: service.path)
        let alias = canonical.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: canonical.appendingPathComponent("config"))
        let aliasedService = alias.appendingPathComponent("daemon")
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: aliasedService).claim(.installation)
            == .refused(.unsafeServiceDirectory(path: aliasedService.path)))
        // On Darwin's temporary namespaces, the /tmp or /var spelling is also
        // an alias, not an input the lifecycle owner may silently normalize.
        if service.path.hasPrefix("/private/tmp/") || service.path.hasPrefix("/private/var/") {
            let systemAlias = String(service.path.dropFirst("/private".count))
            #expect(LocalRuntimeLifecycleOwner(serviceRoot: URL(fileURLWithPath: systemAlias)).claim(.installation)
                == .refused(.unsafeServiceDirectory(path: systemAlias)))
        }
        let permissions = try FileManager.default.attributesOfItem(atPath: service.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o755)
    }

    @Test func independentAppOwnersShareOneTransactionAndReleaseOnlyExactLeases() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let second = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let original = try #require(first.claim(.installation).lease)
        #expect(second.claim(.reconciliation) == .contended)
        #expect(second.claim(.outageRecovery) == .contended)
        first.release(original)
        let successor = try #require(second.claim(.reconciliation).lease)
        first.release(original)
        #expect(first.claim(.installation) == .contended)
        second.release(successor)
        let next = try #require(first.claim(.outageRecovery).lease)
        first.release(original)
        #expect(second.claim(.installation) == .contended)
        first.release(next)
    }

    @Test func distinctServiceRootsRemainIndependent() throws {
        let firstRoot = try root()
        let secondRoot = try root()
        defer {
            try? FileManager.default.removeItem(at: firstRoot)
            try? FileManager.default.removeItem(at: secondRoot)
        }
        let first = LocalRuntimeLifecycleOwner(serviceRoot: firstRoot)
        let second = LocalRuntimeLifecycleOwner(serviceRoot: secondRoot)
        let firstLease = try #require(first.claim(.installation).lease)
        let secondLease = try #require(second.claim(.reconciliation).lease)
        first.release(firstLease)
        second.release(secondLease)
    }

    @Test func createsOnlyPrivateMissingServiceDirectories() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let missing = root.appendingPathComponent("config/daemon")
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: missing)
        let lease = try #require(owner.claim(.outageRecovery).lease)
        let attributes = try FileManager.default.attributesOfItem(atPath: missing.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        // Foundation applies the private mode to each created intermediate too.
        let intermediate = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("config").path)
        #expect((intermediate[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        owner.release(lease)
        #expect(FileManager.default.fileExists(atPath: missing.appendingPathComponent("lifecycle.lock").path))
    }

    @MainActor
    @Test(arguments: [false, true])
    func cleanFirstLaunchCreatesTheMissingDefaultLayoutAndReachesConnected(existingOwnedDirectory: Bool) async throws {
        let fixtureHome = try root()
        defer { try? FileManager.default.removeItem(at: fixtureHome) }
        // The default discovery layout under an isolated synthetic HOME; do not
        // consult ambient config overrides or any actual discovery/token file.
        let serviceRoot = fixtureHome.appendingPathComponent(".claudexor/v3/daemon")
        if existingOwnedDirectory {
            try FileManager.default.createDirectory(
                at: serviceRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        }
        #expect(FileManager.default.fileExists(atPath: serviceRoot.path) == existingOwnedDirectory)
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: serviceRoot)
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: serviceRoot)
        var generation = 1
        var probes = 0
        var starts = 0
        var connectedPolls = 0
        let loop = LocalConnectionRecoveryLoop(
            generation: 1, currentGeneration: { generation }, lifecycleOwner: owner,
            prepareProbe: {},
            probe: {
                probes += 1
                return probes == 1 ? .unavailable : .connected
            },
            engineAnswers: {
                // Re-observation runs under the shared lease and, with nothing
                // serving yet, leaves first launch to start the engine.
                #expect(otherCopy.claim(.installation) == .contended)
                return false
            },
            pollConnected: {
                connectedPolls += 1
                let lease = otherCopy.claim(.reconciliation).lease
                #expect(lease != nil)
                if let lease { otherCopy.release(lease) }
                generation += 1
                return .superseded
            },
            startDaemon: { _ in
                starts += 1
                #expect(FileManager.default.fileExists(atPath: serviceRoot.path))
                #expect(otherCopy.claim(.installation) == .contended)
                return true // injected launcher only; no process is launched
            },
            enterOffline: { Issue.record("First launch unexpectedly denied") },
            pause: { await Task.yield() })
        await loop.run()
        #expect(starts == 1)
        #expect(probes == 2)
        #expect(connectedPolls == 1)
        let permissions = try FileManager.default.attributesOfItem(atPath: serviceRoot.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o700)
    }

    @Test(arguments: ["symlink", "hardlink", "directory", "permissions", "fifo"])
    func unsafeLockObjectsRefuseWithoutChangingTheirTargets(kind: String) throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let leaf = root.appendingPathComponent("lifecycle.lock")
        let target = root.appendingPathComponent("untouched")
        let bytes = Data("fixture bytes".utf8)
        try bytes.write(to: target)
        switch kind {
        case "symlink":
            try FileManager.default.createSymbolicLink(at: leaf, withDestinationURL: target)
        case "hardlink":
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            try FileManager.default.linkItem(at: target, to: leaf)
        case "directory":
            try FileManager.default.createDirectory(at: leaf, withIntermediateDirectories: false)
        case "permissions":
            try bytes.write(to: leaf)
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: leaf.path)
        default:
            #expect(mkfifo(leaf.path, 0o600) == 0)
        }
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: root).claim(.reconciliation)
            == .refused(.unsafeLockFile(path: leaf.path)))
        #expect(try Data(contentsOf: target) == bytes)
    }

    @Test func symlinkServiceRootRefusesWithoutRepairingItsTarget() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let privateDirectory = root.appendingPathComponent("real")
        try FileManager.default.createDirectory(
            at: privateDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        let alias = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: privateDirectory)
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: alias).claim(.installation)
            == .refused(.unsafeServiceDirectory(path: alias.path)))
        let permissions = try FileManager.default.attributesOfItem(atPath: privateDirectory.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o755)
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: privateDirectory)
        let lease = try #require(owner.claim(.installation).lease)
        owner.release(lease)
        let repaired = try FileManager.default.attributesOfItem(atPath: privateDirectory.path)[.posixPermissions] as? NSNumber
        #expect(repaired?.intValue == 0o700)
    }

    @Test func canonicalDirectoryRepairRejectsASymlinkAncestor() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let real = root.appendingPathComponent("real")
        let directory = real.appendingPathComponent("daemon")
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        let alias = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
        let aliased = alias.appendingPathComponent("daemon")
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: aliased).claim(.installation)
            == .refused(.unsafeServiceDirectory(path: aliased.path)))
        let permissions = try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o755)
    }

    @Test func exactReleaseUnlocksEvenWhileADuplicateRetainsTheDescriptor() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let second = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let original = try #require(first.claim(.installation).lease)
        defer { first.release(original) }
        // Observe only this fixture owner's private descriptor, without adding a
        // production test API or scanning unrelated process descriptors. A real
        // dup retains the same open-file description; reopening the path would
        // create an independent description and would not exercise this defect.
        let field = try #require(Mirror(reflecting: first).children.first { $0.label == "descriptor" })
        let stored: Int32? = try #require(field.value as? Optional<Int32>)
        let originalFD = try #require(stored)
        let retained = fcntl(originalFD, F_DUPFD_CLOEXEC, 0)
        try #require(retained >= 0)
        defer { close(retained) }
        #expect(second.claim(.reconciliation) == .contended)
        first.release(original)
        // No retry: a retained reference must not prolong a released lease.
        let successor = try #require(second.claim(.reconciliation).lease)
        defer { second.release(successor) }
        first.release(original)
        #expect(first.claim(.outageRecovery) == .contended)
    }

    @Test func descriptorExcludesAnotherProcessAndReleasesWithoutUnlinking() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let lease = try #require(owner.claim(.reconciliation).lease)
        let leaf = root.appendingPathComponent("lifecycle.lock")
        let before = try FileManager.default.attributesOfItem(atPath: leaf.path)[.systemFileNumber] as? NSNumber
        // A tiny offline helper performs exactly one nonblocking flock and exits.
        // It launches no daemon and reads no runtime/config/auth material.
        #expect(try helperLockStatus(leaf) == 2)
        owner.release(lease)
        #expect(try helperLockStatus(leaf) == 0)
        let after = try FileManager.default.attributesOfItem(atPath: leaf.path)[.systemFileNumber] as? NSNumber
        #expect(before == after)
        let next = try #require(owner.claim(.installation).lease)
        owner.release(next)
    }

    private func helperLockStatus(_ leaf: URL) throws -> Int32 {
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        helper.environment = ["PATH": "/usr/bin:/bin"]
        helper.arguments = ["-MFcntl=:flock", "-e",
            "open my $lock, '+<', $ARGV[0] or exit 3; exit(flock($lock, LOCK_EX | LOCK_NB) ? 0 : 2);", leaf.path]
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = FileHandle.nullDevice
        try helper.run()
        helper.waitUntilExit()
        return helper.terminationStatus
    }

    @Test func reconciliationUsesFreshIdentityAfterAnotherAppReleasesOwnership() async throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let lease = try #require(otherCopy.claim(.installation).lease)
        let old = RuntimeClosureIdentity(version: "3.1.0", buildSha: String(repeating: "a", count: 40))
        let selected = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
        let newer = RuntimeClosureIdentity(version: "3.3.0", buildSha: String(repeating: "c", count: 40))
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = selected
        daemon.servingIdentity = old
        let sut = LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: owner,
            targetClosure: { LocalRuntimeClosureSelection(
                scriptURL: URL(fileURLWithPath: "/fixtures/daemon"), authority: .installed(selected)) })
        #expect(await sut.reconcile(serving: old) == .deferredForLifecycle)
        daemon.servingIdentity = newer
        otherCopy.release(lease)
        #expect(await sut.reconcile(serving: old) == .deferred(.targetNotNewer, serving: newer, target: selected))
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func refusalIsNotContentionAndNamesTheUnusableObject() throws {
        let root = try root()
        defer {
            chmod(root.path, 0o700)
            try? FileManager.default.removeItem(at: root)
        }
        let leaf = root.appendingPathComponent("lifecycle.lock")
        let holder = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let held = try #require(holder.claim(.installation).lease)
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: root).claim(.reconciliation) == .contended)
        holder.release(held)

        try FileManager.default.removeItem(at: leaf)
        try FileManager.default.createSymbolicLink(
            at: leaf, withDestinationURL: root.appendingPathComponent("elsewhere"))
        let refusal = LocalRuntimeLifecycleRefusal.unsafeLockFile(path: leaf.path)
        #expect(LocalRuntimeLifecycleOwner(serviceRoot: root).claim(.outageRecovery) == .refused(refusal))
        #expect(refusal.reason.contains("lifecycle.lock"))
        #expect(!refusal.reason.localizedCaseInsensitiveContains("another"))

        // A missing service directory under an unwritable parent is a refusal
        // with its own cause, and creates nothing.
        #expect(chmod(root.path, 0o500) == 0)
        let missing = root.appendingPathComponent("config/daemon")
        let denied = LocalRuntimeLifecycleOwner(serviceRoot: missing).claim(.installation)
        #expect(denied == .refused(.serviceDirectoryUnavailable(path: missing.path, code: EACCES)))
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("config").path))
    }

    @Test func reconciliationReportsARefusedLockWithoutObservingOrStopping() async throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let leaf = root.appendingPathComponent("lifecycle.lock")
        try FileManager.default.createSymbolicLink(
            at: leaf, withDestinationURL: root.appendingPathComponent("elsewhere"))
        let old = RuntimeClosureIdentity(version: "3.1.0", buildSha: String(repeating: "a", count: 40))
        let selected = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = selected
        daemon.servingIdentity = old
        let sut = LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: LocalRuntimeLifecycleOwner(serviceRoot: root),
            targetClosure: { LocalRuntimeClosureSelection(
                scriptURL: URL(fileURLWithPath: "/fixtures/daemon"), authority: .installed(selected)) })
        let refusal = LocalRuntimeLifecycleRefusal.unsafeLockFile(path: leaf.path)
        let result = await sut.reconcile(serving: old)
        #expect(result == .failed(.lifecycleUnavailable(refusal)))
        #expect(LocalDaemonReconciliationPolicy(result) == .useCompatible(
            notice: "Engine refresh is unavailable: \(refusal.reason). Continuing with the compatible running engine."))
        // Contention is no observation: it neither publishes nor retires a notice.
        #expect(LocalDaemonReconciliationPolicy(.deferredForLifecycle) == .unobserved)
        #expect(daemon.busyProbes == 0)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func appPolicyAndExplicitSwitchSurfaceARefusedLockAndKeepTheCompatibleEngine() async throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let leaf = root.appendingPathComponent("lifecycle.lock")
        try FileManager.default.createSymbolicLink(
            at: leaf, withDestinationURL: root.appendingPathComponent("elsewhere"))
        let buildA = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "a", count: 40))
        let buildB = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "b", count: 40))
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = buildB
        daemon.servingIdentity = buildA
        let model = AppModel(
            requestNotificationAuthorization: false,
            lifecycleOwner: LocalRuntimeLifecycleOwner(serviceRoot: root))
        model.localDaemonReconciler = LocalDaemonReconciler(
            daemon: daemon, lifecycleOwner: model.localRuntimeLifecycleOwner,
            targetClosure: { LocalRuntimeClosureSelection(
                scriptURL: URL(fileURLWithPath: "/fixtures/App-B/claudexord.bundle.cjs"),
                authority: .installed(buildB)) },
            handshakePollInterval: 0, handshakePollTimeout: 0)
        model.engineIdentity = EngineBuildIdentity(
            version: buildA.version, sha: buildA.buildSha, entry: "/fixtures/App-A")
        let notice = "Engine refresh is unavailable: \(LocalRuntimeLifecycleRefusal.unsafeLockFile(path: leaf.path).reason). Continuing with the compatible running engine."

        #expect(await model.localDaemonPolicy(for: model.engineIdentity) == .useCompatible(notice: notice))
        #expect(model.localDaemonBuildSwitch == nil)

        // A stale-looking exact request cannot bypass the refused lock either.
        model.localDaemonBuildSwitch = LocalDaemonBuildSwitch(serving: buildA, target: buildB)
        // The compatible engine keeps serving its client, so polling resumes.
        #expect(await model.switchLocalDaemonBuild(LocalDaemonBuildSwitch(serving: buildA, target: buildB))
            == .resume(generation: model.connectionGeneration))
        #expect(model.localDaemonReconciliationNotice == notice)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @MainActor
    @Test func outageRecoveryNamesARefusedLockKeepsItsAllowanceAndStartsOnceRepaired() async throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let leaf = root.appendingPathComponent("lifecycle.lock")
        try FileManager.default.createSymbolicLink(
            at: leaf, withDestinationURL: root.appendingPathComponent("elsewhere"))
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: root)
        var generation = 1
        var pauses = 0
        var starts = 0
        var offline = 0
        var reports: [LocalRuntimeLifecycleRefusal?] = []
        let loop = LocalConnectionRecoveryLoop(
            generation: 1, currentGeneration: { generation }, lifecycleOwner: owner,
            prepareProbe: {}, probe: { .unavailable }, engineAnswers: { false },
            pollConnected: { .unavailable },
            startDaemon: { _ in
                starts += 1
                return true // injected launcher only; no process is launched
            },
            enterOffline: { offline += 1 },
            lifecycleRefused: { reports.append($0) },
            pause: {
                pauses += 1
                if pauses == 2 { try? FileManager.default.removeItem(at: leaf) }
                if pauses == 3 { generation += 1 }
            })
        await loop.run()
        #expect(reports == [.unsafeLockFile(path: leaf.path), nil])
        #expect(offline == 2)
        #expect(starts == 1)
        let lease = try #require(owner.claim(.installation).lease)
        owner.release(lease)
    }

    @MainActor
    @Test func eachOutageReportsTheRefusedLockItMeetsAfterAConnection() async throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let leaf = root.appendingPathComponent("lifecycle.lock")
        try FileManager.default.createSymbolicLink(
            at: leaf, withDestinationURL: root.appendingPathComponent("elsewhere"))
        var generation = 1
        var probes = 0
        var reports: [LocalRuntimeLifecycleRefusal?] = []
        let loop = LocalConnectionRecoveryLoop(
            generation: 1, currentGeneration: { generation },
            lifecycleOwner: LocalRuntimeLifecycleOwner(serviceRoot: root),
            prepareProbe: {},
            probe: {
                probes += 1
                switch probes {
                case 1, 3: return .unavailable
                // An engine started elsewhere connects; its notice replaces the
                // refusal, and the lock stays unusable when it exits again.
                case 2: return .connected
                default:
                    generation += 1
                    return .unavailable
                }
            },
            engineAnswers: { false },
            pollConnected: { .unavailable },
            startDaemon: { _ in
                Issue.record("A refused lock never starts the engine")
                return false
            },
            enterOffline: {},
            lifecycleRefused: { reports.append($0) },
            pause: { await Task.yield() })
        await loop.run()
        let refusal = LocalRuntimeLifecycleRefusal.unsafeLockFile(path: leaf.path)
        #expect(reports == [refusal, refusal])
    }

    @MainActor
    @Test func anotherCopysCompletedStartIsReobservedUnderTheLeaseInsteadOfStartedAgain() async throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = LocalRuntimeLifecycleOwner(serviceRoot: root)
        let otherCopy = LocalRuntimeLifecycleOwner(serviceRoot: root)
        // The other copy is starting the engine when this copy's handshake fails.
        let otherStart = try #require(otherCopy.claim(.outageRecovery).lease)
        var generation = 1
        var probes = 0
        var answers = 0
        var starts = 0
        let loop = LocalConnectionRecoveryLoop(
            generation: 1, currentGeneration: { generation }, lifecycleOwner: owner,
            prepareProbe: {},
            probe: {
                probes += 1
                guard probes == 1 else { return .connected }
                // Its engine answers and it releases the lock after this
                // negative observation; this app's own snapshot cannot see that.
                otherCopy.release(otherStart)
                return .unavailable
            },
            engineAnswers: {
                answers += 1
                #expect(otherCopy.claim(.installation) == .contended)
                return true
            },
            pollConnected: {
                generation += 1
                return .superseded
            },
            startDaemon: { _ in
                starts += 1
                return true // injected launcher only; no process is launched
            },
            enterOffline: { Issue.record("An answering engine is not an outage") },
            pause: { await Task.yield() })
        await loop.run()
        #expect(answers == 1)
        #expect(starts == 0)
        #expect(probes == 2)
        let lease = try #require(otherCopy.claim(.installation).lease)
        otherCopy.release(lease)
    }

    /// Production wiring for a first launch with nothing else to show: the
    /// real `connect()` loop refuses the unusable lock and the reachable
    /// Offline placeholder shows that cause. Runs in an isolated HOME/config.
    @MainActor
    @Test func offlineFirstLaunchShowsTheRefusedLockOnThePlaceholder() async throws {
        try await isolatedRuntimeConsumer(
            "LocalRuntimeLifecycleOwnerTests/offlineFirstLaunchShowsTheRefusedLockOnThePlaceholder"
        ) {
            let config = try #require(ProcessInfo.processInfo.environment["CLAUDEXOR_CONFIG_DIR"])
            // The service root expression ClaudexorApp passes to its owner.
            let serviceRoot = ControlApiDiscovery.defaultPath().deletingLastPathComponent()
            try #require(serviceRoot.path.hasPrefix(URL(fileURLWithPath: config).path + "/"))
            try FileManager.default.createDirectory(
                at: serviceRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let leaf = serviceRoot.appendingPathComponent("lifecycle.lock")
            try FileManager.default.createSymbolicLink(
                at: leaf, withDestinationURL: serviceRoot.appendingPathComponent("elsewhere"))
            // A temporary root behind a symlinked ancestor refuses the directory
            // itself; a canonical one reaches the lock. Either is a real refusal.
            guard case let .refused(refusal) = LocalRuntimeLifecycleOwner(serviceRoot: serviceRoot)
                .claim(.installation) else {
                Issue.record("The fixture lock must be refused")
                return
            }
            if LocalRuntimeLifecycleOwner.hasCanonicalServiceDirectoryPath(serviceRoot) {
                #expect(refusal == .unsafeLockFile(path: leaf.path))
            }

            let model = AppModel(
                requestNotificationAuthorization: false,
                lifecycleOwner: LocalRuntimeLifecycleOwner(serviceRoot: serviceRoot))
            let connecting = Task { @MainActor in await model.connect() }
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while model.localDaemonReconciliationNotice == nil, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            let notice = "Claudexor did not start the engine: \(refusal.reason)."
            #expect(model.localDaemonReconciliationNotice == notice)
            #expect(model.health == .offline)
            // No local connection, remote or cached thread: the placeholder is
            // what this launch shows, and it carries the cause.
            #expect(RootView.showsEnginePlaceholder(for: model))
            #expect(UpdateChip.notice(for: model) == notice)
            connecting.cancel()
            await connecting.value
            #expect(!FileManager.default.fileExists(atPath: serviceRoot.appendingPathComponent("elsewhere").path))
        }
    }
}
