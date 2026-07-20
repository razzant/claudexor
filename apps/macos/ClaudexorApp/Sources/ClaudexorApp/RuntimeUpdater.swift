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

/// The runtime-closure tarball asset name for a version — the SAME convention
/// the release pipeline publishes (`claudexor-runtime-<version>.tar.gz`).
public func runtimeTarballAssetName(version: String) -> String {
    "claudexor-runtime-\(version).tar.gz"
}

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
    private let lifecycle: RuntimeDaemonLifecycle

    private var storedETag: String?
    private var lastDecision: RuntimeUpdateDecision?

    public init(
        transport: RuntimeReleaseTransport,
        installer: RuntimeInstaller = RuntimeInstaller(),
        probe: RuntimeProbe = DefaultRuntimeProbe(),
        handshakeVerifier: RuntimeHandshakeVerifier = DefaultRuntimeHandshakeVerifier(),
        lifecycle: RuntimeDaemonLifecycle = NoopRuntimeDaemonLifecycle()
    ) {
        self.transport = transport
        self.installer = installer
        self.probe = probe
        self.handshakeVerifier = handshakeVerifier
        self.lifecycle = lifecycle
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
        // Whether a rollback target exists BEFORE the swap promotes one — this
        // decides the failure recovery (roll back vs. first-install strand).
        let hadPriorRuntime = installer.readCurrent() != nil
        // 7. Stop the running daemon so the pointer swap is not raced by a live
        // serving process. B4: HONOR the result — an unconfirmed stop (a live or
        // unverifiable daemon; a recycled pid is never signalled) must abort
        // BEFORE the swap, since mutating the pointer under a serving daemon
        // strands a half-updated runtime. Nothing changed → rolledBack:false.
        guard await lifecycle.stopIdleDaemon() else {
            return .failed(
                .daemonStopUnconfirmed("refusing to swap under a daemon that did not confirm it stopped"),
                rolledBack: false)
        }
        // 8. Atomic swap (promotes outgoing current.json to last-known-good).
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
            _ = await lifecycle.relaunch()
            return .failed(asRuntimeError(error), rolledBack: false)
        }
        // 9. Relaunch so the handshake observes the NEW engine (an un-restarted
        // daemon still serves the old closure and would fail identity spuriously).
        _ = await lifecycle.relaunch()
        // 10. Handshake-verify the now-serving engine; recover on any failure.
        guard await handshakeVerifier.verifyServing(expectedVersion: manifest.version) else {
            // B4: STOP and death-prove the failed NEW runtime BEFORE restoring —
            // a still-live bad daemon would race the pointer restore + relaunch,
            // and the rollback would falsely report success while it kept serving.
            let stopped = await lifecycle.stopIdleDaemon()
            if hadPriorRuntime, stopped, (try? installer.rollbackToLastKnownGood()) != nil {
                // Restore the previous runtime, relaunch it, and HANDSHAKE-VERIFY
                // it is actually serving again — so `rolledBack` is a PROVEN claim,
                // never a hopeful one (the old code reported rolledBack:true blind).
                _ = await lifecycle.relaunch()
                var rolledBack = false
                if let restoredVersion = installer.readCurrent()?.version {
                    rolledBack = await handshakeVerifier.verifyServing(expectedVersion: restoredVersion)
                }
                return .failed(
                    .identityMismatch(expected: manifest.version, actual: "serving engine did not confirm handshake"),
                    rolledBack: rolledBack
                )
            }
            // FIRST install with no last-known-good (or the failed runtime could
            // not be confirmed stopped): the fresh pointer would strand the daemon
            // on a closure that failed its handshake. Remove it so DaemonLauncher
            // falls back to the app-bundled runtime, and report honestly (nothing
            // was rolled back — there was nothing to roll back to).
            try? installer.removeCurrent()
            _ = await lifecycle.relaunch()
            return .failed(
                .identityMismatch(expected: manifest.version, actual: "serving engine did not confirm handshake"),
                rolledBack: false
            )
        }
        return .installed(version: manifest.version)
    }

    /// Resolve the runtime tarball asset from the SAME release document as the
    /// manifest (never a caller-supplied URL), then run the full install. This is
    /// the wiring the update chip drives: it re-fetches the latest release, finds
    /// `claudexor-runtime-<version>.tar.gz`, and installs it.
    public func installAvailable(manifest: RuntimeManifest) async -> RuntimeInstallOutcome {
        let fetch: ReleaseFetchResult
        do {
            fetch = try await transport.fetchLatestRelease(etag: nil)
        } catch {
            return .failed(asRuntimeError(error), rolledBack: false)
        }
        guard let body = fetch.data, let release = GitHubRelease.parse(body) else {
            return .failed(.transport("latest-release response was not parseable JSON"), rolledBack: false)
        }
        let assetName = runtimeTarballAssetName(version: manifest.version)
        guard let asset = release.asset(named: assetName),
              let url = URL(string: asset.browserDownloadURL) else {
            return .failed(.transport("release has no \(assetName) asset"), rolledBack: false)
        }
        return await install(manifest: manifest, tarballURL: url)
    }

    private func asRuntimeError(_ error: Error) -> RuntimeUpdateError {
        (error as? RuntimeUpdateError) ?? .io(error.localizedDescription)
    }
}
