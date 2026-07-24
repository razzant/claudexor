import Foundation
import ClaudexorKit

// MARK: - Engine-runtime auto-INSTALL coordinator (D-2, 3.1)
//
// Orchestrates the one-click in-place engine update the whole feature is about:
//
//   verify monotonic → download → sha256-verify against the SIGNED manifest →
//   full unpack to versions/<v> → re-verify → strip quarantine → probe-start the
//   unpacked daemon (--version handshake) → idle-gate (refuse while jobs run) →
//   identity-proven daemon stop → ATOMIC current.json swap (single rename inside
//   a whole-critical-section lock) → relaunch → handshake-verify → rollback to
//   last-known-good on ANY failure. The bundled runtime stays the final fallback
//   (the launcher already falls back on an invalid/absent pointer).
//
// The daemon-lifecycle side effects (busy signal, identity-proven stop, relaunch,
// probe, handshake) are injected through `RuntimeDaemonControl`, so the entire
// sequence — including rollback — is exercised OFFLINE against a locally-served
// fixture closure with no network and no real daemon.

/// The daemon-lifecycle port the installer drives. Every method is the seam a
/// test stubs; production wires them to the existing daemon machinery.
public protocol RuntimeDaemonControl: Sendable {
    /// Are jobs running right now? `true` = busy (refuse), `false` = idle,
    /// `nil` = the daemon could not be asked (treated as busy — fail-closed, we
    /// never stop a daemon whose state we cannot confirm).
    func isBusy() async -> Bool?
    /// Stop the running daemon, identity-proven (existing machinery). Throws if
    /// the stop could not be confirmed.
    func stop() async throws
    /// Relaunch the daemon (DaemonLauncher) against the ACTIVE pointer.
    func start() throws
    /// Probe-start the UNPACKED daemon in `--version` mode using the app-bundled
    /// Node and return its reported engine version (nil on any failure). No
    /// pointer is swapped — this is a dry-run handshake before we commit.
    func probeVersion(scriptURL: URL) async -> String?
    /// The running engine version from a live handshake after relaunch (nil when
    /// unreachable).
    func handshakeVersion() async -> String?
}

/// Progress states surfaced to the update chip (honest, per DESIGN_SYSTEM).
public enum RuntimeInstallPhase: Sendable, Equatable {
    case downloading
    case verifying
    case unpacking
    case probing
    case awaitingIdle
    case swapping
    case relaunching
    case done(version: String)
    case rolledBack(reason: String)
    case failed(reason: String)
}

public actor RuntimeInstallCoordinator {
    private let installer: RuntimeInstaller
    private let transport: RuntimeReleaseTransport
    private let daemon: RuntimeDaemonControl
    private let onPhase: @Sendable (RuntimeInstallPhase) -> Void

    public init(
        installer: RuntimeInstaller,
        transport: RuntimeReleaseTransport,
        daemon: RuntimeDaemonControl,
        onPhase: @escaping @Sendable (RuntimeInstallPhase) -> Void = { _ in }
    ) {
        self.installer = installer
        self.transport = transport
        self.daemon = daemon
        self.onPhase = onPhase
    }

    /// Install a VERIFIED signed manifest's closure from `assetURL`. The manifest
    /// MUST already have passed `RuntimeManifest.verified` — this coordinator
    /// trusts its `version`/`sha256`/`archiveName` as the signed contract.
    /// Returns the installed version on success; throws on refusal/failure (a
    /// failure after the swap rolls back before throwing).
    @discardableResult
    public func install(manifest: RuntimeManifest, assetURL: URL) async throws -> String {
        // Whole check-then-swap critical section is guarded by a lock file so two
        // installers can never race the pointer.
        let lock = try acquireLock()
        defer { releaseLock(lock) }

        // 1. Monotonic anti-replay: strictly newer than current + last-known-good.
        let floors =
            [installer.readCurrent()?.version, installer.readLastKnownGood()?.version]
            .compactMap { $0 }
        guard isMonotonicUpgrade(target: manifest.version, floors: floors) else {
            fail(.failed(reason: "not newer than the installed runtime"))
            throw RuntimeInstallError.notMonotonic(target: manifest.version)
        }

        // 2. Download.
        onPhase(.downloading)
        let bytes = try await transport.downloadAsset(from: assetURL)

        // 3. sha256-verify against the SIGNED digest.
        onPhase(.verifying)
        let actual = installer.sha256Hex(bytes)
        guard actual == manifest.sha256 else {
            fail(.failed(reason: "digest mismatch"))
            throw RuntimeInstallError.shaMismatch(expected: manifest.sha256, actual: actual)
        }

        // 4. Full unpack + re-verify, then strip quarantine (post-verification).
        onPhase(.unpacking)
        let versionDir = try installer.unpack(bytes, version: manifest.version)
        installer.stripQuarantine(at: versionDir)
        let unpackedScript = versionDir.appendingPathComponent("claudexord.bundle.cjs")

        // 5. Probe-start the unpacked daemon: it must report the target version.
        onPhase(.probing)
        let probed = await daemon.probeVersion(scriptURL: unpackedScript)
        guard probed == manifest.version else {
            try? installer.removeVersionDir(manifest.version)
            fail(.failed(reason: "probe version mismatch"))
            throw RuntimeInstallError.probeMismatch(expected: manifest.version, got: probed)
        }

        // 6. Idle-gate: refuse while jobs run (nil state = fail-closed busy).
        onPhase(.awaitingIdle)
        let busy = await daemon.isBusy()
        guard busy == false else {
            try? installer.removeVersionDir(manifest.version)
            fail(.failed(reason: "engine busy"))
            throw RuntimeInstallError.daemonBusy
        }

        // Snapshot the pre-swap pointer so we can roll back to it verbatim.
        let previous = installer.readCurrent()

        // 7. Identity-proven daemon stop.
        try await daemon.stop()

        // 8. ATOMIC swap: promote the prior pointer to last-known-good, then a
        // single-rename write of the new current.json.
        onPhase(.swapping)
        if let previous { try? installer.writeLastKnownGood(previous) }
        let next = RuntimeCurrent(
            version: manifest.version,
            path: RuntimeCurrent.versionPath(manifest.version),
            sha256: manifest.sha256,
            installedAt: ISO8601DateFormatter().string(from: Date()),
            engineSha: manifest.buildSha)
        do {
            try installer.writeCurrentAtomic(next)
        } catch {
            // The pointer never changed — restart on the old one and bail.
            try? daemon.start()
            fail(.failed(reason: "pointer write failed"))
            throw RuntimeInstallError.io("could not write current.json: \(error.localizedDescription)")
        }

        // 9. Relaunch against the new pointer. If the relaunch THROWS (audit 6),
        // the swap already happened — roll back to the previous pointer and leave
        // a working engine (bundled fallback if there was no previous) rather
        // than stranding a broken pointer.
        onPhase(.relaunching)
        do {
            try daemon.start()
        } catch {
            await rollback(to: previous, reason: "engine relaunch failed after swap")
            throw RuntimeInstallError.io(
                "engine relaunch failed after swap; rolled back to the previous runtime: \(error.localizedDescription)"
            )
        }

        // 10. Handshake-verify the new engine; rollback on ANY mismatch.
        let running = await daemon.handshakeVersion()
        guard running == manifest.version else {
            await rollback(to: previous, reason: "post-relaunch handshake mismatch")
            throw RuntimeInstallError.handshakeMismatch(expected: manifest.version, got: running)
        }

        onPhase(.done(version: manifest.version))
        return manifest.version
    }

    // MARK: - Rollback

    /// Restore the previous pointer (last-known-good) and relaunch. If there was
    /// no previous pointer, delete current.json so the launcher falls back to the
    /// bundled runtime — the final fallback.
    private func rollback(to previous: RuntimeCurrent?, reason: String) async {
        try? await daemon.stop()
        if let previous {
            try? installer.writeCurrentAtomic(previous)
        } else {
            installer.removeCurrentPointer()
        }
        try? daemon.start()
        // Best-effort confirm; the bundled runtime still serves even if this fails.
        _ = await daemon.handshakeVersion()
        onPhase(.rolledBack(reason: reason))
    }

    // MARK: - Lock file (whole critical section)

    private func acquireLock() throws -> Int32 {
        try? installer.ensureLayout()
        let fd = open(installer.lockURL.path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { throw RuntimeInstallError.io("could not open the install lock") }
        // Non-blocking exclusive lock: a second installer fails fast.
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            throw RuntimeInstallError.lockHeld
        }
        return fd
    }

    private func releaseLock(_ fd: Int32) {
        flock(fd, LOCK_UN)
        close(fd)
    }

    private func fail(_ phase: RuntimeInstallPhase) { onPhase(phase) }
}

/// Swift-side monotonic anti-replay (mirrors @claudexor/util
/// isMonotonicRuntimeUpgrade): the target must be strictly greater than every
/// version the app already trusts.
func isMonotonicUpgrade(target: String, floors: [String]) -> Bool {
    guard let t = SemanticVersion(target) else { return false }
    for floor in floors {
        guard let f = SemanticVersion(floor) else { continue }
        if !(t > f) { return false }
    }
    return true
}
