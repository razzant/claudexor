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
    /// Bounded-poll cadence for the post-relaunch handshake. A relaunched daemon
    /// spawns DETACHED and needs seconds to bind its socket + rewrite
    /// control-api.json, so the handshake is polled, never single-shot. Injectable
    /// so tests run the poll fast.
    private let handshakePollInterval: TimeInterval
    private let handshakePollTimeout: TimeInterval

    public init(
        installer: RuntimeInstaller,
        transport: RuntimeReleaseTransport,
        daemon: RuntimeDaemonControl,
        handshakePollInterval: TimeInterval = 0.5,
        handshakePollTimeout: TimeInterval = 30,
        onPhase: @escaping @Sendable (RuntimeInstallPhase) -> Void = { _ in }
    ) {
        self.installer = installer
        self.transport = transport
        self.daemon = daemon
        self.handshakePollInterval = handshakePollInterval
        self.handshakePollTimeout = handshakePollTimeout
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
            // The new pointer never landed. The daemon was stopped for the swap,
            // so recover the OLD runtime and PROVE it (restart + expected-version
            // handshake) before reporting — never claim safety over a dead engine.
            throw await rollbackAndClassify(
                to: previous, reason: "pointer write failed",
                recoveredError: .io("could not write current.json: \(error.localizedDescription)"))
        }

        // 9. Relaunch against the new pointer. If the relaunch THROWS (audit 6),
        // the swap already happened — roll back to the previous pointer and leave
        // a working engine (bundled fallback if there was no previous) rather
        // than stranding a broken pointer.
        onPhase(.relaunching)
        do {
            try daemon.start()
        } catch {
            throw await rollbackAndClassify(
                to: previous, reason: "engine relaunch failed after swap",
                recoveredError: .io(
                    "engine relaunch failed after swap; rolled back to the previous runtime: \(error.localizedDescription)"))
        }

        // 10. Handshake-verify the new engine with a BOUNDED poll: the relaunched
        // daemon boots detached and needs seconds to serve, so a single-shot probe
        // reads nil on essentially every real install. Rollback ONLY on a genuine
        // wrong-version handshake or a boot-window timeout — never on a not-yet-
        // ready nil.
        switch await pollHandshake(expected: manifest.version) {
        case .matched:
            onPhase(.done(version: manifest.version))
            return manifest.version
        case let .mismatch(got):
            throw await rollbackAndClassify(
                to: previous, reason: "post-relaunch handshake mismatch",
                recoveredError: .handshakeMismatch(expected: manifest.version, got: got))
        case .unreachable:
            throw await rollbackAndClassify(
                to: previous, reason: "post-relaunch handshake timed out",
                recoveredError: .handshakeMismatch(expected: manifest.version, got: nil))
        }
    }

    // MARK: - Handshake poll

    private enum HandshakeProbe: Sendable {
        case matched(String)
        case mismatch(String)
        case unreachable
    }

    /// Bounded poll of the live handshake after a relaunch. Retries every
    /// `handshakePollInterval` up to `handshakePollTimeout`, reloading discovery
    /// each try (the production probe re-reads ControlApiDiscovery per call). A
    /// `nil` handshake is "not serving YET" and keeps polling; a mismatch is
    /// concluded ONLY on a non-nil WRONG version or a timeout. `expected == nil`
    /// accepts ANY reachable version — the bundled-fallback rollback case, whose
    /// version is not known here.
    private func pollHandshake(expected: String?) async -> HandshakeProbe {
        let deadline = Date().addingTimeInterval(handshakePollTimeout)
        while true {
            if let running = await daemon.handshakeVersion() {
                guard let expected else { return .matched(running) }
                return running == expected ? .matched(running) : .mismatch(running)
            }
            if Date() >= deadline { return .unreachable }
            try? await Task.sleep(nanoseconds: UInt64(max(0, handshakePollInterval) * 1_000_000_000))
        }
    }

    // MARK: - Rollback

    private enum RollbackOutcome: Sendable {
        case recovered
        case failed(step: String, remediation: String)
    }

    /// Run the rollback and map its outcome to the error to throw: a PROVEN
    /// recovery throws the caller's original failure (`recoveredError`); a failed
    /// recovery throws `.recoveryFailed` with the exact step + remediation, so the
    /// thrown error never claims a clean rollback over a broken engine.
    private func rollbackAndClassify(
        to previous: RuntimeCurrent?, reason: String, recoveredError: RuntimeInstallError
    ) async -> RuntimeInstallError {
        switch await rollback(to: previous, reason: reason) {
        case .recovered:
            return recoveredError
        case let .failed(step, remediation):
            return .recoveryFailed(step: step, remediation: remediation)
        }
    }

    /// Restore the previous pointer (or delete it so the launcher falls back to
    /// the bundled runtime), relaunch, and PROVE the recovery with the same
    /// bounded handshake poll — the restored pointer wrote, the daemon relaunched,
    /// and it reports the expected version (the previous version when we had one,
    /// else any reachable engine). Only then is `.rolledBack` emitted. If any step
    /// fails, `.failed` carries the exact step + remediation — never a green
    /// "rolled back" over a dead daemon or a broken pointer.
    private func rollback(to previous: RuntimeCurrent?, reason: String) async -> RollbackOutcome {
        // Stop the wrong/broken daemon. A stop failure alone is not decisive — the
        // restore + relaunch + handshake below is the real proof — so it is not
        // treated as a recovery failure on its own.
        try? await daemon.stop()

        // 1. Restore (or clear) the active pointer.
        if let previous {
            do {
                try installer.writeCurrentAtomic(previous)
            } catch {
                return rollbackFailed(
                    reason, step: "restore the previous runtime pointer",
                    remediation: "Quit and reopen Claudexor; if it does not recover, reinstall the app.")
            }
        } else {
            installer.removeCurrentPointer()
        }

        // 2. Relaunch on the restored pointer.
        do {
            try daemon.start()
        } catch {
            return rollbackFailed(
                reason, step: "relaunch the engine on the previous runtime",
                remediation: "Quit and reopen Claudexor to restart the engine.")
        }

        // 3. Prove the restored engine is actually serving, with the SAME bounded
        // poll used after a forward relaunch.
        switch await pollHandshake(expected: previous?.version) {
        case .matched:
            onPhase(.rolledBack(reason: reason))
            return .recovered
        case let .mismatch(got):
            return rollbackFailed(
                reason, step: "confirm the previous runtime is serving (engine reported \(got))",
                remediation: "Quit and reopen Claudexor; if the wrong engine keeps serving, reinstall the app.")
        case .unreachable:
            return rollbackFailed(
                reason, step: "reach the engine after relaunch",
                remediation: "Quit and reopen Claudexor to restart the engine.")
        }
    }

    private func rollbackFailed(_ reason: String, step: String, remediation: String) -> RollbackOutcome {
        onPhase(.failed(reason: "\(reason); recovery failed: could not \(step). \(remediation)"))
        return .failed(step: step, remediation: remediation)
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
