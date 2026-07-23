import Foundation
import ClaudexorKit

// MARK: - Runtime updater orchestrator (M7 — 3.0 CHECK-only)
//
// Wires the release transport into the single user-invokable operation 3.0
// ships: CHECK (foreground / Check-for-Updates). It fetches the latest release
// manifest, compares versions, and decides — no download, no unpack, no daemon
// signalling, no pointer swap. The one-click in-app auto-INSTALL (download →
// sha-verify → unpack → probe → swap → handshake → rollback) is deferred to 3.1
// per owner-locked D1: process-killing install code stays out of 3.0 entirely
// rather than shipping half-wired. Every side-effect goes through an injected
// port so the check flow is tested offline with a stub transport.

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

/// Coordinates a runtime-update CHECK. An actor so the stored ETag / last
/// decision are mutated safely from the check path without a lock.
public actor RuntimeUpdater {
    private let transport: RuntimeReleaseTransport
    /// The pinned runtime-update authority the CHECK verifies against. Production
    /// uses `.pinned`; tests inject a fixture authority for the signed vectors.
    private let authority: RuntimeUpdateAuthority

    private var storedETag: String?
    private var lastDecision: RuntimeUpdateDecision?

    public init(transport: RuntimeReleaseTransport, authority: RuntimeUpdateAuthority = .pinned) {
        self.transport = transport
        self.authority = authority
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
        // FAIL-CLOSED (D-2): the CHECK trusts a manifest only when its Ed25519
        // signature verifies against the pinned runtime-update authority. An
        // unsigned / unknown-key / tampered manifest is refused, never surfaced
        // as an available update.
        guard let manifest = RuntimeManifest.verified(manifestData, authority: authority) else {
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
}
