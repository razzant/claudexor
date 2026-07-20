import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

// M7 orchestration (offline, stubbed): sha256-verify abort, rollback on
// handshake failure, ETag caching, current.json round-trip, and DaemonLauncher
// resolution. The honest file core runs against a real temp `runtime/` root
// with a hand-built .tar.gz; network/probe/handshake go through stubs.

// MARK: - Stubs

private final class StubTransport: RuntimeReleaseTransport, @unchecked Sendable {
    private let lock = NSLock()
    var queuedFetches: [ReleaseFetchResult] = []
    var receivedETags: [String?] = []
    var downloadCount = 0
    var assetData: [String: Data] = [:]
    var downloadDefault = Data()

    func fetchLatestRelease(etag: String?) async throws -> ReleaseFetchResult {
        try lock.withLock {
            receivedETags.append(etag)
            guard !queuedFetches.isEmpty else { throw RuntimeUpdateError.transport("no queued fetch") }
            return queuedFetches.removeFirst()
        }
    }

    func downloadAsset(from url: URL) async throws -> Data {
        lock.withLock {
            downloadCount += 1
            return assetData[url.absoluteString] ?? downloadDefault
        }
    }
}

private struct StubProbe: RuntimeProbe {
    let result: Bool
    func verify(versionDir: URL, expectedVersion: String) async -> Bool { result }
}

private struct StubHandshake: RuntimeHandshakeVerifier {
    /// A fixed verdict, OR (when `servingVersion` is set) true ONLY for that
    /// version — so a rollback test can fail the NEW version's handshake while
    /// the RESTORED version's handshake succeeds (B4 proven rollback).
    let fixed: Bool
    let servingVersion: String?
    init(result: Bool) { self.fixed = result; self.servingVersion = nil }
    init(serving version: String) { self.fixed = false; self.servingVersion = version }
    func verifyServing(expectedVersion: String) async -> Bool {
        if let servingVersion { return expectedVersion == servingVersion }
        return fixed
    }
}

/// Records the ORDER of daemon lifecycle calls so the install's stop/relaunch
/// sequence (and the rollback's stop-before-restore) is asserted; `stopResult`
/// drives the honor-the-return path (B4).
private final class RecordingLifecycle: RuntimeDaemonLifecycle, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls: [String] = []
    var stopResult: Bool
    init(stopResult: Bool = true) { self.stopResult = stopResult }
    func stopIdleDaemon() async -> Bool { lock.withLock { calls.append("stop"); return stopResult } }
    func relaunch() async -> Bool { lock.withLock { calls.append("relaunch"); return true } }
    var order: [String] { lock.withLock { calls } }
}

/// A stubbed process-identity reader (the "helper" B4 asks to stub): maps a pid
/// to a fixed observation so the recycled-pid / missing / unverifiable paths run
/// offline without touching a real process.
private struct StubIdentityReader: ProcessIdentityReading {
    let byPid: [Int: ProcessIdentityObservation]
    let fallback: ProcessIdentityObservation
    init(_ byPid: [Int: ProcessIdentityObservation], fallback: ProcessIdentityObservation = .unknown) {
        self.byPid = byPid
        self.fallback = fallback
    }
    func observe(pid: Int) -> ProcessIdentityObservation { byPid[pid] ?? fallback }
}

// MARK: - Fixtures

@Suite(.serialized) struct RuntimeUpdaterTests {
    /// A scratch `runtime/` root that is cleaned up.
    private func tempRoot() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-runtime-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Build a real runtime .tar.gz whose ROOT holds `claudexord.bundle.cjs`, and
    /// return (bytes, lowercase-hex sha256).
    private func makeRuntimeTarball(daemonBody: String = "// daemon\n") throws -> (Data, String) {
        let staging = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-stage-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        try Data(daemonBody.utf8).write(to: staging.appendingPathComponent("claudexord.bundle.cjs"))
        let tarball = FileManager.default.temporaryDirectory
            .appendingPathComponent("closure-\(UUID().uuidString).tar.gz")
        defer { try? FileManager.default.removeItem(at: tarball) }
        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        // -C staging with "." so the closure files sit at the tarball root.
        tar.arguments = ["-czf", tarball.path, "-C", staging.path, "."]
        try tar.run()
        tar.waitUntilExit()
        #expect(tar.terminationStatus == 0)
        let bytes = try Data(contentsOf: tarball)
        return (bytes, RuntimeInstaller.sha256Hex(bytes))
    }

    private func manifest(version: String, sha: String, minApp: String = "0.0.1") -> RuntimeManifest {
        RuntimeManifest(version: version, sha256: sha, minAppVersion: minApp)
    }

    // MARK: - sha256 verify FAILURE → no unpack, no swap

    @Test func shaMismatchAbortsBeforeUnpackAndSwap() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let transport = StubTransport()
        transport.downloadDefault = Data("totally the wrong bytes".utf8)  // sha won't match

        let m = manifest(version: "3.2.0", sha: String(repeating: "a", count: 64))
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true), handshakeVerifier: StubHandshake(result: true)
        )
        let outcome = await updater.install(manifest: m, tarballURL: URL(string: "https://example/c.tar.gz")!)

        guard case let .failed(error, rolledBack) = outcome else {
            Issue.record("expected failure, got \(outcome)"); return
        }
        if case .shaMismatch = error {} else { Issue.record("expected shaMismatch, got \(error)") }
        #expect(rolledBack == false)
        // No unpack, no pointer.
        #expect(!FileManager.default.fileExists(atPath: installer.versionDir("3.2.0").path))
        #expect(installer.readCurrent() == nil)
    }

    // MARK: - Rollback on handshake failure

    @Test func handshakeFailureRollsBackToLastKnownGood() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Seed an existing ACTIVE runtime (the rollback target).
        let previous = RuntimeCurrent(
            version: "3.1.0", path: RuntimeCurrent.versionPath("3.1.0"),
            sha256: String(repeating: "b", count: 64),
            installedAt: "2026-07-18T00:00:00Z", engineSha: "old")
        try installer.writeCurrent(previous)

        let (bytes, sha) = try makeRuntimeTarball()
        let transport = StubTransport()
        transport.downloadDefault = bytes
        let m = manifest(version: "3.2.0", sha: sha)

        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true),          // boots fine
            // The NEW version's serving handshake FAILS; the RESTORED 3.1.0's
            // handshake succeeds, so the rollback is PROVEN, not assumed (B4).
            handshakeVerifier: StubHandshake(serving: "3.1.0")
        )
        let outcome = await updater.install(manifest: m, tarballURL: URL(string: "https://example/c.tar.gz")!)

        guard case let .failed(_, rolledBack) = outcome else {
            Issue.record("expected failure, got \(outcome)"); return
        }
        #expect(rolledBack == true)
        // current.json restored to the previous active runtime.
        #expect(installer.readCurrent() == previous)
        // The new closure was still unpacked (whole-closure dirs are kept).
        #expect(FileManager.default.fileExists(atPath: installer.versionDir("3.2.0").path))
    }

    // MARK: - B4: lifecycle order (stop → swap → relaunch → handshake) + rollback

    @Test func priorRuntimeInstallStopsBeforeSwapThenRelaunches() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        try installer.writeCurrent(RuntimeCurrent(
            version: "3.1.0", path: RuntimeCurrent.versionPath("3.1.0"),
            sha256: String(repeating: "b", count: 64), installedAt: "x", engineSha: "old"))
        let (bytes, sha) = try makeRuntimeTarball()
        let transport = StubTransport(); transport.downloadDefault = bytes
        let lifecycle = RecordingLifecycle()
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true), handshakeVerifier: StubHandshake(result: true),
            lifecycle: lifecycle)

        let outcome = await updater.install(manifest: manifest(version: "3.2.0", sha: sha),
                                            tarballURL: URL(string: "https://example/c.tar.gz")!)
        #expect(outcome == .installed(version: "3.2.0"))
        // Stop precedes the swap; relaunch follows it, before the handshake.
        #expect(lifecycle.order == ["stop", "relaunch"])
    }

    @Test func firstInstallStopsBeforeSwapThenRelaunches() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)  // NO prior runtime
        let (bytes, sha) = try makeRuntimeTarball()
        let transport = StubTransport(); transport.downloadDefault = bytes
        let lifecycle = RecordingLifecycle()
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true), handshakeVerifier: StubHandshake(result: true),
            lifecycle: lifecycle)

        let outcome = await updater.install(manifest: manifest(version: "3.2.0", sha: sha),
                                            tarballURL: URL(string: "https://example/c.tar.gz")!)
        #expect(outcome == .installed(version: "3.2.0"))
        #expect(lifecycle.order == ["stop", "relaunch"])
    }

    @Test func rollbackStopsAndDeathProvesFailedRuntimeBeforeRestore() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let previous = RuntimeCurrent(
            version: "3.1.0", path: RuntimeCurrent.versionPath("3.1.0"),
            sha256: String(repeating: "b", count: 64), installedAt: "x", engineSha: "old")
        try installer.writeCurrent(previous)
        let (bytes, sha) = try makeRuntimeTarball()
        let transport = StubTransport(); transport.downloadDefault = bytes
        let lifecycle = RecordingLifecycle()
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true),
            handshakeVerifier: StubHandshake(serving: "3.1.0"),  // new fails, restored passes
            lifecycle: lifecycle)

        let outcome = await updater.install(manifest: manifest(version: "3.2.0", sha: sha),
                                            tarballURL: URL(string: "https://example/c.tar.gz")!)
        guard case let .failed(_, rolledBack) = outcome else { Issue.record("expected failure"); return }
        #expect(rolledBack == true)
        #expect(installer.readCurrent() == previous)
        // stop (pre-swap) → relaunch (bring up the NEW engine for the handshake)
        // → handshake FAILS → stop (death-prove the failed new runtime) →
        // relaunch (the RESTORED runtime). The second stop is B4's fix: the
        // failed runtime is death-proven BEFORE the pointer is restored.
        #expect(lifecycle.order == ["stop", "relaunch", "stop", "relaunch"])
    }

    @Test func unconfirmedStopAbortsBeforeSwap() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let previous = RuntimeCurrent(
            version: "3.1.0", path: RuntimeCurrent.versionPath("3.1.0"),
            sha256: String(repeating: "b", count: 64), installedAt: "x", engineSha: "old")
        try installer.writeCurrent(previous)
        let (bytes, sha) = try makeRuntimeTarball()
        let transport = StubTransport(); transport.downloadDefault = bytes
        let lifecycle = RecordingLifecycle(stopResult: false)  // stop cannot be confirmed
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true), handshakeVerifier: StubHandshake(result: true),
            lifecycle: lifecycle)

        let outcome = await updater.install(manifest: manifest(version: "3.2.0", sha: sha),
                                            tarballURL: URL(string: "https://example/c.tar.gz")!)
        guard case let .failed(error, rolledBack) = outcome else { Issue.record("expected failure"); return }
        if case .daemonStopUnconfirmed = error {} else { Issue.record("expected daemonStopUnconfirmed, got \(error)") }
        #expect(rolledBack == false)
        // Aborted BEFORE the swap: only the stop was attempted, and current.json
        // still points at the previous runtime (nothing was mutated).
        #expect(lifecycle.order == ["stop"])
        #expect(installer.readCurrent() == previous)
        #expect(installer.readLastKnownGood() == nil)
    }

    // MARK: - Happy path install

    @Test func successfulInstallPointsCurrentAtNewVersion() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try makeRuntimeTarball()
        let transport = StubTransport()
        transport.downloadDefault = bytes
        let m = manifest(version: "3.2.0", sha: sha)

        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true), handshakeVerifier: StubHandshake(result: true))
        let outcome = await updater.install(manifest: m, tarballURL: URL(string: "https://example/c.tar.gz")!)

        #expect(outcome == .installed(version: "3.2.0"))
        let current = installer.readCurrent()
        #expect(current?.version == "3.2.0")
        #expect(current?.path == "versions/3.2.0")
        #expect(current?.sha256 == sha)
        #expect(FileManager.default.fileExists(
            atPath: installer.versionDir("3.2.0").appendingPathComponent("claudexord.bundle.cjs").path))
    }

    // MARK: - Install wiring: resolve the tarball from the release doc → install

    @Test func installAvailableResolvesTarballFromReleaseDocAndInstalls() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try makeRuntimeTarball()
        let transport = StubTransport()
        let tarballURL = "https://example/claudexor-runtime-3.2.0.tar.gz"
        // The latest-release doc carries the runtime tarball asset by name.
        let releaseJSON = #"{"assets":[{"name":"claudexor-runtime-3.2.0.tar.gz","browser_download_url":"\#(tarballURL)"}]}"#
        transport.queuedFetches = [ReleaseFetchResult(status: 200, etag: nil, data: Data(releaseJSON.utf8))]
        transport.assetData[tarballURL] = bytes
        let m = manifest(version: "3.2.0", sha: sha)
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true), handshakeVerifier: StubHandshake(result: true))

        let outcome = await updater.installAvailable(manifest: m)
        #expect(outcome == .installed(version: "3.2.0"))
        #expect(installer.readCurrent()?.version == "3.2.0")
    }

    @Test func installAvailableReportsMissingTarballAsset() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let transport = StubTransport()
        // Release doc has the manifest asset but NOT the runtime tarball.
        transport.queuedFetches = [ReleaseFetchResult(status: 200, etag: nil, data: Data(#"{"assets":[]}"#.utf8))]
        let m = manifest(version: "3.2.0", sha: String(repeating: "a", count: 64))
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true), handshakeVerifier: StubHandshake(result: true))

        let outcome = await updater.installAvailable(manifest: m)
        guard case let .failed(error, _) = outcome else { Issue.record("expected failure"); return }
        if case let .transport(msg) = error { #expect(msg.contains("claudexor-runtime-3.2.0.tar.gz")) }
        else { Issue.record("expected transport error, got \(error)") }
    }

    // MARK: - First-install handshake failure with NO last-known-good

    @Test func firstInstallHandshakeFailureRemovesCurrentForBundledFallback() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)  // NO prior current.json
        let (bytes, sha) = try makeRuntimeTarball()
        let transport = StubTransport()
        transport.downloadDefault = bytes
        let m = manifest(version: "3.2.0", sha: sha)
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true),
            handshakeVerifier: StubHandshake(result: false))  // serving handshake FAILS

        let outcome = await updater.install(manifest: m, tarballURL: URL(string: "https://example/c.tar.gz")!)
        guard case let .failed(_, rolledBack) = outcome else { Issue.record("expected failure"); return }
        // Nothing to roll back to on a first install.
        #expect(rolledBack == false)
        // The stranding fresh pointer was REMOVED so the daemon falls back to the
        // app-bundled runtime (never stuck on a closure that failed its handshake).
        #expect(installer.readCurrent() == nil)
        #expect(installer.readLastKnownGood() == nil)
    }

    // MARK: - Tar-entry sanitization (reject symlink / traversal / absolute)

    @Test func unpackRejectsASymlinkEntry() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Build a tarball that plants a symlink alongside the daemon script.
        let staging = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-evil-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        try Data("// daemon\n".utf8).write(to: staging.appendingPathComponent("claudexord.bundle.cjs"))
        try FileManager.default.createSymbolicLink(
            at: staging.appendingPathComponent("evil"),
            withDestinationURL: URL(fileURLWithPath: "/etc/passwd"))
        let tarball = FileManager.default.temporaryDirectory
            .appendingPathComponent("evil-\(UUID().uuidString).tar.gz")
        defer { try? FileManager.default.removeItem(at: tarball) }
        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-czf", tarball.path, "-C", staging.path, "."]
        try tar.run(); tar.waitUntilExit()
        #expect(tar.terminationStatus == 0)

        // Unpack must REFUSE the tarball (never extract a symlink).
        var threw = false
        do { try installer.unpack(tarball: tarball, version: "9.9.9") }
        catch { threw = true; if case RuntimeUpdateError.unpackFailed = error {} else { Issue.record("expected unpackFailed, got \(error)") } }
        #expect(threw)
        // Nothing was extracted.
        #expect(!FileManager.default.fileExists(atPath: installer.versionDir("9.9.9").appendingPathComponent("evil").path))
    }

    // MARK: - ETag caching

    @Test func secondCheckSendsIfNoneMatchAnd304IsNoChange() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let transport = StubTransport()

        let manifestURL = "https://example/runtime-manifest.json"
        let releaseJSON = #"{"assets":[{"name":"runtime-manifest.json","browser_download_url":"\#(manifestURL)"}]}"#
        let manifestJSON = #"{"version":"3.2.0","sha256":"\#(String(repeating: "a", count: 64))","minAppVersion":"0.0.1"}"#
        transport.assetData[manifestURL] = Data(manifestJSON.utf8)
        // First fetch: 200 with an ETag + release body. Second: 304 (not modified).
        transport.queuedFetches = [
            ReleaseFetchResult(status: 200, etag: "\"etag-v1\"", data: Data(releaseJSON.utf8)),
            ReleaseFetchResult(status: 304, etag: "\"etag-v1\"", data: nil),
        ]
        let updater = RuntimeUpdater(
            transport: transport, installer: installer,
            probe: StubProbe(result: true), handshakeVerifier: StubHandshake(result: true))

        let first = try await updater.check(runningEngineVersion: "3.1.0", appVersion: "dev")
        #expect(first == .decided(.available(RuntimeManifest.parse(Data(manifestJSON.utf8))!)))
        let downloadsAfterFirst = transport.downloadCount
        #expect(downloadsAfterFirst == 1)  // manifest downloaded once

        let second = try await updater.check(runningEngineVersion: "3.1.0", appVersion: "dev")
        #expect(second == .notModified)
        // The stored ETag was sent as If-None-Match on the second fetch.
        #expect(transport.receivedETags == [nil, "\"etag-v1\""])
        // A 304 does NOT re-download the manifest.
        #expect(transport.downloadCount == downloadsAfterFirst)
    }

    // MARK: - current.json read/write/atomic-swap round-trip

    @Test func currentPointerRoundTripAndSwapPromotesLastKnownGood() throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        #expect(installer.readCurrent() == nil)

        let v1 = RuntimeCurrent(version: "3.1.0", path: "versions/3.1.0",
                                sha256: String(repeating: "a", count: 64),
                                installedAt: "2026-07-18T00:00:00Z", engineSha: nil)
        try installer.writeCurrent(v1)
        #expect(installer.readCurrent() == v1)
        #expect(installer.readLastKnownGood() == nil)  // first write has no rollback target

        let v2 = RuntimeCurrent(version: "3.2.0", path: "versions/3.2.0",
                                sha256: String(repeating: "c", count: 64),
                                installedAt: "2026-07-19T00:00:00Z", engineSha: "sha2")
        try installer.swapCurrent(to: v2)
        #expect(installer.readCurrent() == v2)
        #expect(installer.readLastKnownGood() == v1)  // outgoing promoted

        try installer.rollbackToLastKnownGood()
        #expect(installer.readCurrent() == v1)
    }

    // MARK: - DaemonLauncher resolution

    @Test func daemonResolvesToVersionDirWhenCurrentValid() throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Lay down versions/3.2.0/claudexord.bundle.cjs and point current.json at it.
        let versionDir = installer.versionDir("3.2.0")
        try FileManager.default.createDirectory(at: versionDir, withIntermediateDirectories: true)
        try Data("// daemon".utf8).write(to: versionDir.appendingPathComponent("claudexord.bundle.cjs"))
        try installer.writeCurrent(RuntimeCurrent(
            version: "3.2.0", path: "versions/3.2.0",
            sha256: String(repeating: "a", count: 64), installedAt: "x", engineSha: nil))

        let resolved = DaemonLauncher.resolvedDaemon(installer: installer)
        #expect(resolved?.path == versionDir.appendingPathComponent("claudexord.bundle.cjs").path)
    }

    @Test func daemonFallsBackToBundledWhenPointerMissing() throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)  // no current.json
        // No installed runtime → resolve to the app-bundled script (nil in SwiftPM).
        #expect(DaemonLauncher.resolvedDaemon(installer: installer) == DaemonLauncher.bundledDaemon)
    }

    @Test func daemonFallsBackWhenPointerReferencesMissingScript() throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Pointer present but the version dir has no claudexord.bundle.cjs.
        try installer.writeCurrent(RuntimeCurrent(
            version: "9.9.9", path: "versions/9.9.9",
            sha256: String(repeating: "a", count: 64), installedAt: "x", engineSha: nil))
        #expect(DaemonLauncher.resolvedDaemon(installer: installer) == DaemonLauncher.bundledDaemon)
    }
}

/// Thread-safe recorder for the injected SIGTERM (a `@Sendable` closure can't
/// capture a mutable local).
private final class SignalBox: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var signals: [(Int32, Int32)] = []
    func record(_ pid: Int32, _ sig: Int32) { lock.withLock { signals.append((pid, sig)) } }
    var count: Int { lock.withLock { signals.count } }
    var lastSignal: Int32? { lock.withLock { signals.last?.1 } }
}

/// B4: `stopIdleDaemon` verifies the daemon's recorded BIRTH IDENTITY before it
/// ever signals — a recycled pid is never touched, an unverifiable identity fails
/// closed, and a verified match is signalled then death-proven. The bundled
/// process-identity helper is stubbed (StubIdentityReader); the SIGTERM is
/// captured (never sent to a real process).
@Suite(.serialized) struct DaemonLifecycleStopTests {
    private func daemonDir(pid: Int, startToken: String, processGroupId: Int,
                           recordedIdentity: Bool = true, withSocket: Bool = true) -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-daemon-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if withSocket {
            FileManager.default.createFile(
                atPath: dir.appendingPathComponent("claudexord.sock").path, contents: Data())
        }
        let writer = dir.appendingPathComponent("claudexord.sock.writer", isDirectory: true)
        try? FileManager.default.createDirectory(at: writer, withIntermediateDirectories: true)
        var owner: [String: Any] = ["pid": pid, "token": "tok"]
        if recordedIdentity {
            owner["identity"] = ["status": "known", "pid": pid, "platform": "darwin",
                                 "source": "proc_pidinfo", "startToken": startToken,
                                 "processGroupId": processGroupId]
        }
        if let data = try? JSONSerialization.data(withJSONObject: owner) {
            try? data.write(to: writer.appendingPathComponent("owner.json"))
        }
        return dir
    }

    private func lifecycle(_ dir: URL, reader: ProcessIdentityReading, box: SignalBox,
                           onSignal: (@Sendable (Int32, Int32) -> Void)? = nil) -> DefaultRuntimeDaemonLifecycle {
        DefaultRuntimeDaemonLifecycle(
            daemonDir: dir, stopTimeout: 3, identityReader: reader,
            signal: { pid, sig in box.record(pid, sig); onSignal?(pid, sig) })
    }

    @Test func absentSocketIsAlreadyIdle() async {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-daemon-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let box = SignalBox()
        #expect(await lifecycle(dir, reader: StubIdentityReader([:]), box: box).stopIdleDaemon())
        #expect(box.count == 0)
    }

    @Test func recycledPidIsNeverSignalled() async {
        let dir = daemonDir(pid: 4242, startToken: "darwin:1000:000001", processGroupId: 4242)
        defer { try? FileManager.default.removeItem(at: dir) }
        let box = SignalBox()
        // Alive, but a DIFFERENT birth token — the pid was recycled.
        let reader = StubIdentityReader([4242: .known(ObservedProcessIdentity(
            pid: 4242, startToken: "darwin:9999:000009", processGroupId: 4242))])
        #expect(await lifecycle(dir, reader: reader, box: box).stopIdleDaemon())
        #expect(box.count == 0)  // never signalled the newcomer
    }

    @Test func missingProcessIsConfirmedStoppedWithoutSignal() async {
        let dir = daemonDir(pid: 4242, startToken: "darwin:1000:000001", processGroupId: 4242)
        defer { try? FileManager.default.removeItem(at: dir) }
        let box = SignalBox()
        #expect(await lifecycle(dir, reader: StubIdentityReader([4242: .missing]), box: box).stopIdleDaemon())
        #expect(box.count == 0)
    }

    @Test func unverifiableIdentityFailsClosed() async {
        let dir = daemonDir(pid: 4242, startToken: "darwin:1000:000001", processGroupId: 4242)
        defer { try? FileManager.default.removeItem(at: dir) }
        let box = SignalBox()
        #expect(!(await lifecycle(dir, reader: StubIdentityReader([4242: .unknown]), box: box).stopIdleDaemon()))
        #expect(box.count == 0)  // never signalled an unverifiable pid
    }

    @Test func leaseWithoutRecordedIdentityFailsClosed() async {
        let dir = daemonDir(pid: 4242, startToken: "x", processGroupId: 4242, recordedIdentity: false)
        defer { try? FileManager.default.removeItem(at: dir) }
        let box = SignalBox()
        let reader = StubIdentityReader([4242: .known(ObservedProcessIdentity(
            pid: 4242, startToken: "darwin:1000:000001", processGroupId: 4242))])
        #expect(!(await lifecycle(dir, reader: reader, box: box).stopIdleDaemon()))
        #expect(box.count == 0)
    }

    @Test func verifiedDaemonIsSignalledThenDeathProven() async {
        let dir = daemonDir(pid: 4242, startToken: "darwin:1000:000001", processGroupId: 4242)
        defer { try? FileManager.default.removeItem(at: dir) }
        let socket = dir.appendingPathComponent("claudexord.sock")
        let box = SignalBox()
        let reader = StubIdentityReader([4242: .known(ObservedProcessIdentity(
            pid: 4242, startToken: "darwin:1000:000001", processGroupId: 4242))])
        // The "kill" removes the socket, so the next poll proves death.
        let lc = lifecycle(dir, reader: reader, box: box,
                           onSignal: { _, _ in try? FileManager.default.removeItem(at: socket) })
        #expect(await lc.stopIdleDaemon())
        #expect(box.count == 1)
        #expect(box.lastSignal == SIGTERM)
    }
}
