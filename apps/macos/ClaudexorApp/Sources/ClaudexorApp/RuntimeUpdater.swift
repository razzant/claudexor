import Foundation
import ClaudexorKit

// MARK: - Runtime updater orchestrator (M7)
//
// Wires the seams (transport / installer / probe / handshake) into the two
// user-invokable operations: CHECK (foreground / Check-for-Updates) and INSTALL
// (download → sha-verify → unpack → probe → atomic swap → handshake → rollback).
// No background timer. Every side-effect goes through an injected port so the
// whole flow is tested offline with stubs.

public let runtimeManifestAssetName = "runtime-manifest.json"

/// The real, manifest-backed availability provider. `current()` is a cheap,
/// non-blocking read of the LAST decision computed by an async check — no
/// network on the read path — so the footer chip binds to it while the actual
/// fetch happens only on foreground / Check-for-Updates. Mirrors the honest
/// shell contract: it advertises a version ONLY for a runnable `.available`
/// closure, never a fake state.
public final class RuntimeUpdateProvider: UpdateAvailabilityProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var decision: RuntimeUpdateDecision?

    public init() {}

    /// Cache the newest decision from an async check (nil clears it).
    public func store(_ decision: RuntimeUpdateDecision?) {
        lock.lock(); defer { lock.unlock() }
        self.decision = decision
    }

    public func current() -> UpdateAvailability? {
        lock.lock(); defer { lock.unlock() }
        return decision?.chipAvailability
    }
}

/// Outcome of a runtime-update CHECK.
public enum RuntimeCheckOutcome: Sendable, Equatable {
    /// The ETag cache hit (HTTP 304): nothing changed since the last check, so
    /// the manifest was NOT re-downloaded.
    case notModified
    /// A fresh decision computed from the latest manifest.
    case decided(RuntimeUpdateDecision)
}

/// The result of a full INSTALL attempt.
public enum RuntimeInstallOutcome: Sendable, Equatable {
    /// Installed and verified serving at the target version.
    case installed(version: String)
    /// A step failed; if a swap had occurred it was rolled back. `rolledBack`
    /// says whether current.json was restored from last-known-good.
    case failed(RuntimeUpdateError, rolledBack: Bool)
}

/// Coordinates a runtime update. An actor so the stored ETag / last decision are
/// mutated safely from the check path without a lock.
public actor RuntimeUpdater {
    private let transport: RuntimeReleaseTransport
    private let installer: RuntimeInstaller
    private let probe: RuntimeProbe
    private let handshakeVerifier: RuntimeHandshakeVerifier

    private var storedETag: String?
    private var lastDecision: RuntimeUpdateDecision?

    public init(
        transport: RuntimeReleaseTransport,
        installer: RuntimeInstaller = RuntimeInstaller(),
        probe: RuntimeProbe = DefaultRuntimeProbe(),
        handshakeVerifier: RuntimeHandshakeVerifier = DefaultRuntimeHandshakeVerifier()
    ) {
        self.transport = transport
        self.installer = installer
        self.probe = probe
        self.handshakeVerifier = handshakeVerifier
    }

    /// The most recent decision (nil before the first successful check). Lets a
    /// 304 reuse the prior verdict and lets a cheap chip read without a fetch.
    public var cachedDecision: RuntimeUpdateDecision? { lastDecision }

    /// CHECK for an update. Sends `If-None-Match` with the stored ETag; a 304
    /// short-circuits to `.notModified` (no manifest download). Otherwise finds
    /// the `runtime-manifest.json` asset, downloads + parses it, and decides.
    public func check(runningEngineVersion: String, appVersion: String) async throws -> RuntimeCheckOutcome {
        let fetch = try await transport.fetchLatestRelease(etag: storedETag)
        if fetch.status == 304 {
            return .notModified
        }
        // Adopt the fresh ETag for the next conditional request.
        storedETag = fetch.etag
        guard let body = fetch.data, let release = GitHubRelease.parse(body) else {
            throw RuntimeUpdateError.transport("latest-release response was not parseable JSON")
        }
        guard let asset = release.asset(named: runtimeManifestAssetName) else {
            throw RuntimeUpdateError.manifestMissing
        }
        guard let assetURL = URL(string: asset.browserDownloadURL) else {
            throw RuntimeUpdateError.transport("manifest asset has an invalid download URL")
        }
        let manifestData = try await transport.downloadAsset(from: assetURL)
        guard let manifest = RuntimeManifest.parse(manifestData) else {
            throw RuntimeUpdateError.manifestMalformed
        }
        let decision = decideRuntimeUpdate(
            runningEngineVersion: runningEngineVersion,
            appVersion: appVersion,
            manifest: manifest
        )
        lastDecision = decision
        return .decided(decision)
    }

    /// INSTALL a runnable manifest. The URL of the runtime tarball is derived
    /// from the same release document; callers pass the resolved asset URL so
    /// this method is a pure ordered sequence over the ports.
    ///
    /// Sequence: download → sha-verify (abort before any unpack on mismatch) →
    /// unpack → probe-start → atomic swap (promotes old current.json to
    /// last-known-good first) → handshake-verify serving. Any failure at or
    /// after the swap rolls current.json back to last-known-good.
    public func install(manifest: RuntimeManifest, tarballURL: URL) async -> RuntimeInstallOutcome {
        // 3. Download.
        let bytes: Data
        do {
            bytes = try await transport.downloadAsset(from: tarballURL)
        } catch {
            return .failed(asRuntimeError(error), rolledBack: false)
        }
        // 4. sha256-verify BEFORE any unpack or swap.
        do {
            try RuntimeInstaller.verifySHA256(bytes, expected: manifest.sha256)
        } catch {
            return .failed(asRuntimeError(error), rolledBack: false)
        }
        // 5. Unpack to a temp file then into versions/<v>/.
        let tarball = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-runtime-\(manifest.version)-\(UUID().uuidString).tar.gz")
        defer { try? FileManager.default.removeItem(at: tarball) }
        do {
            try bytes.write(to: tarball, options: .atomic)
            try installer.unpack(tarball: tarball, version: manifest.version)
        } catch {
            return .failed(asRuntimeError(error), rolledBack: false)
        }
        let versionDir = installer.versionDir(manifest.version)
        // 6. Probe-start the new closure against a throwaway config dir.
        guard await probe.verify(versionDir: versionDir, expectedVersion: manifest.version) else {
            return .failed(.probeFailed("probe daemon did not confirm version \(manifest.version)"), rolledBack: false)
        }
        // 7. Atomic swap (promotes outgoing current.json to last-known-good).
        let pointer = RuntimeCurrent(
            version: manifest.version,
            path: RuntimeCurrent.versionPath(manifest.version),
            sha256: manifest.sha256,
            installedAt: ISO8601DateFormatter().string(from: Date()),
            engineSha: nil
        )
        do {
            try installer.swapCurrent(to: pointer)
        } catch {
            return .failed(asRuntimeError(error), rolledBack: false)
        }
        // 8. Handshake-verify the now-serving engine; roll back on any failure.
        guard await handshakeVerifier.verifyServing(expectedVersion: manifest.version) else {
            let rolledBack = (try? installer.rollbackToLastKnownGood()) != nil
            return .failed(
                .identityMismatch(expected: manifest.version, actual: "serving engine did not confirm handshake"),
                rolledBack: rolledBack
            )
        }
        return .installed(version: manifest.version)
    }

    private func asRuntimeError(_ error: Error) -> RuntimeUpdateError {
        (error as? RuntimeUpdateError) ?? .io(error.localizedDescription)
    }
}
