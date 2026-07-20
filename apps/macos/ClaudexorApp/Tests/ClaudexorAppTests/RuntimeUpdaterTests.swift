import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

// M7 CHECK orchestration (offline, stubbed) + DaemonLauncher pointer resolution.
// 3.0 ships the update CHECK only (owner-locked D1); the in-app auto-INSTALL
// (download → verify → unpack → swap → handshake → rollback) and its
// daemon-lifecycle process signalling are deferred to 3.1, so their tests are
// gone with the code. What remains: the ETag-cached check, and DaemonLauncher
// resolving the daemon script through `current.json` (the read side that stays,
// forward-compatible with the 3.1 installer that will write the pointer).

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

// MARK: - Fixtures

@Suite(.serialized) struct RuntimeUpdaterTests {
    /// A scratch `runtime/` root that is cleaned up.
    private func tempRoot() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-runtime-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Write a `current.json` pointer directly (the 3.1 installer will own this
    /// write; 3.0 only READS it, so the test lays it down by hand).
    private func writePointer(_ pointer: RuntimeCurrent, to installer: RuntimeInstaller) throws {
        let data = try JSONEncoder().encode(pointer)
        try data.write(to: installer.currentPointerURL, options: .atomic)
    }

    // MARK: - ETag caching (the 3.0 CHECK path)

    @Test func secondCheckSendsIfNoneMatchAnd304IsNoChange() async throws {
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
        let updater = RuntimeUpdater(transport: transport)

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

    // MARK: - DaemonLauncher resolution (the pointer READ side that stays)

    @Test func daemonResolvesToVersionDirWhenCurrentValid() throws {
        let root = tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = RuntimeInstaller(root: root)
        // Lay down versions/3.2.0/claudexord.bundle.cjs and point current.json at it.
        let versionDir = root.appendingPathComponent("versions/3.2.0", isDirectory: true)
        try FileManager.default.createDirectory(at: versionDir, withIntermediateDirectories: true)
        try Data("// daemon".utf8).write(to: versionDir.appendingPathComponent("claudexord.bundle.cjs"))
        try writePointer(RuntimeCurrent(
            version: "3.2.0", path: "versions/3.2.0",
            sha256: String(repeating: "a", count: 64), installedAt: "x", engineSha: nil),
            to: installer)

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
        try writePointer(RuntimeCurrent(
            version: "9.9.9", path: "versions/9.9.9",
            sha256: String(repeating: "a", count: 64), installedAt: "x", engineSha: nil),
            to: installer)
        #expect(DaemonLauncher.resolvedDaemon(installer: installer) == DaemonLauncher.bundledDaemon)
    }
}
