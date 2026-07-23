import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

// Deterministic OFFLINE install + rollback drill (D-2, item 6): a fixture closure
// is served from local disk (no network, no real daemon). The whole sequence —
// download → sha-verify → unpack → probe → idle-gate → stop → atomic swap →
// relaunch → handshake → rollback — runs against injected ports.

// MARK: - Stubs

private final class LocalTransport: RuntimeReleaseTransport, @unchecked Sendable {
    let payload: Data
    init(_ payload: Data) { self.payload = payload }
    func fetchLatestRelease(etag: String?) async throws -> ReleaseFetchResult {
        ReleaseFetchResult(status: 200, etag: nil, data: Data())
    }
    func downloadAsset(from url: URL) async throws -> Data { payload }
}

private final class PhaseRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var phases: [RuntimeInstallPhase] = []
    func record(_ p: RuntimeInstallPhase) { lock.withLock { phases.append(p) } }
    func contains(_ p: RuntimeInstallPhase) -> Bool { lock.withLock { phases.contains(p) } }
}

private final class StubDaemon: RuntimeDaemonControl, @unchecked Sendable {
    private let lock = NSLock()
    var busy: Bool? = false
    var probeReturns: String?
    var handshakeReturns: String?
    var stops = 0
    var starts = 0

    func isBusy() async -> Bool? { lock.withLock { busy } }
    func stop() async throws { lock.withLock { stops += 1 } }
    func start() throws { lock.withLock { starts += 1 } }
    func probeVersion(scriptURL: URL) async -> String? { lock.withLock { probeReturns } }
    func handshakeVersion() async -> String? { lock.withLock { handshakeReturns } }
}

@Suite(.serialized) struct RuntimeInstallCoordinatorTests {
    private func tempRoot() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-install-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Build a real closure tar.gz whose only entry is claudexord.bundle.cjs, and
    /// return (bytes, sha256hex).
    private func fixtureClosure(_ body: String = "// daemon\n") throws -> (Data, String) {
        let stage = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-stage-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stage) }
        try Data(body.utf8).write(to: stage.appendingPathComponent("claudexord.bundle.cjs"))
        let tar = stage.appendingPathComponent("closure.tar.gz")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        p.arguments = ["-czf", tar.path, "-C", stage.path, "claudexord.bundle.cjs"]
        try p.run()
        p.waitUntilExit()
        let bytes = try Data(contentsOf: tar)
        let sha = RuntimeInstaller(root: stage).sha256Hex(bytes)
        return (bytes, sha)
    }

    private func manifest(version: String, sha: String) -> RuntimeManifest {
        RuntimeManifest(
            version: version, sha256: sha, minAppVersion: "2.1.0",
            buildSha: String(repeating: "1", count: 40))
    }

    private let assetURL = URL(string: "https://example/closure.tar.gz")!

    // MARK: - Happy path

    @Test func installsUnpacksAndSwapsAtomically() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"
        daemon.handshakeReturns = "3.4.0"

        let recorder = PhaseRecorder()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon,
            onPhase: { recorder.record($0) })

        let version = try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        #expect(version == "3.4.0")

        // current.json now points at versions/3.4.0 with the build sha stamped.
        let current = try #require(installer.readCurrent())
        #expect(current.version == "3.4.0")
        #expect(current.path == "versions/3.4.0")
        #expect(current.engineSha == String(repeating: "1", count: 40))
        // The closure is unpacked and resolvable by the launcher.
        #expect(installer.containedDaemonScript(current) != nil)
        // Stop-before-swap, relaunch-after.
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
        #expect(recorder.contains(.done(version: "3.4.0")))
    }

    // MARK: - Failure paths

    @Test func refusesADigestMismatchWithoutSwapping() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, _) = try fixtureClosure()
        let daemon = StubDaemon()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon)
        // A manifest whose sha does NOT match the served bytes.
        let bad = manifest(version: "3.4.0", sha: String(repeating: "e", count: 64))
        await #expect(throws: RuntimeInstallError.self) {
            try await coord.install(manifest: bad, assetURL: assetURL)
        }
        #expect(installer.readCurrent() == nil)  // never swapped
        #expect(daemon.stops == 0)
    }

    @Test func refusesWhileTheDaemonIsBusy() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.busy = true
        daemon.probeReturns = "3.4.0"
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon)
        await #expect(throws: RuntimeInstallError.daemonBusy) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(installer.readCurrent() == nil)
        #expect(daemon.stops == 0)  // never stopped an active daemon
    }

    @Test func refusesWhenTheProbeVersionMismatches() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "9.9.9"  // wrong
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon)
        await #expect(throws: RuntimeInstallError.self) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(installer.readCurrent() == nil)
        #expect(daemon.stops == 0)
    }

    @Test func refusesAVersionRegression() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Seed a NEWER current pointer.
        try installer.writeCurrentAtomic(
            RuntimeCurrent(
                version: "3.9.0", path: "versions/3.9.0",
                sha256: String(repeating: "a", count: 64), installedAt: "x", engineSha: nil))
        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon)
        await #expect(throws: RuntimeInstallError.notMonotonic(target: "3.4.0")) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        #expect(installer.readCurrent()?.version == "3.9.0")  // unchanged
    }

    // MARK: - Rollback drill

    @Test func rollsBackToLastKnownGoodOnHandshakeFailure() async throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Pre-existing installed runtime 3.2.0 (the rollback target).
        let previous = RuntimeCurrent(
            version: "3.2.0", path: "versions/3.2.0",
            sha256: String(repeating: "a", count: 64), installedAt: "old", engineSha: "prevsha")
        let prevDir = root.appendingPathComponent("versions/3.2.0", isDirectory: true)
        try FileManager.default.createDirectory(at: prevDir, withIntermediateDirectories: true)
        try Data("// prev".utf8).write(to: prevDir.appendingPathComponent("claudexord.bundle.cjs"))
        try installer.writeCurrentAtomic(previous)

        let (bytes, sha) = try fixtureClosure()
        let daemon = StubDaemon()
        daemon.probeReturns = "3.4.0"  // probe OK
        daemon.handshakeReturns = "3.2.0"  // but the relaunched engine is NOT 3.4.0
        let coord = RuntimeInstallCoordinator(
            installer: installer, transport: LocalTransport(bytes), daemon: daemon)

        await #expect(throws: RuntimeInstallError.self) {
            try await coord.install(manifest: manifest(version: "3.4.0", sha: sha), assetURL: assetURL)
        }
        // Rolled BACK: the active pointer is the previous 3.2.0 again.
        let current = try #require(installer.readCurrent())
        #expect(current.version == "3.2.0")
        #expect(current.engineSha == "prevsha")
        // The previous runtime was promoted to last-known-good during the swap.
        #expect(installer.readLastKnownGood()?.version == "3.2.0")
        // Stopped for the swap AND again for the rollback; relaunched twice.
        #expect(daemon.stops == 2)
        #expect(daemon.starts == 2)
    }
}
