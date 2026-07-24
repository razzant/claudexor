import Foundation
import CryptoKit
import ClaudexorKit

// MARK: - Runtime pointer reader + install FS ops (M7 / D-2)
//
// Owns the on-disk `~/.claudexor/runtime/` layout. The READ side resolves the
// ACTIVE runtime pointer (`current.json`) through the QA-073 containment guard so
// DaemonLauncher launches only a contained installed closure, else the
// app-bundled runtime. The WRITE side (sha-verify, full unpack, quarantine
// strip, atomic pointer swap, last-known-good rollback) backs
// RuntimeInstallCoordinator's in-place install (D-2). When `current.json` is
// absent or fails containment, callers fall back to the bundled runtime.

/// Errors surfaced by the runtime update CHECK. Messages are honest and
/// user-facing.
public enum RuntimeUpdateError: Error, LocalizedError, Equatable {
    case transport(String)
    case manifestMissing
    case manifestMalformed

    public var errorDescription: String? {
        switch self {
        case let .transport(m): return "Update check failed: \(m)"
        case .manifestMissing: return "The latest release has no runtime-manifest.json asset."
        case .manifestMalformed: return "The runtime manifest could not be parsed."
        }
    }
}

/// Reads the on-disk `~/.claudexor/runtime/` layout. `root` is injectable so
/// tests point it at a temp dir. For 3.0 this exposes only the pointer READ used
/// by `DaemonLauncher` (resolve the active closure) and the update check
/// (resolve the running engine version).
public struct RuntimeInstaller: Sendable {
    /// The `runtime/` data root: `versions/<v>/`, `current.json`.
    public let root: URL
    /// FileManager.default is used for all IO. A computed accessor (not a stored
    /// non-Sendable property) keeps `RuntimeInstaller` Sendable so it can live
    /// inside the `RuntimeUpdater` actor.
    private var fileManager: FileManager { .default }

    public init(root: URL? = nil) {
        self.root = root ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claudexor/runtime", isDirectory: true)
    }

    public var currentPointerURL: URL { root.appendingPathComponent("current.json") }
    /// The ONLY directory an installed runtime may live under.
    public var versionsDir: URL { root.appendingPathComponent("versions", isDirectory: true) }

    // MARK: current.json read

    /// Read + parse the active-runtime pointer, or nil when absent/corrupt. A
    /// corrupt or missing pointer resolves to the bundled runtime, never a crash
    /// or a bogus dir.
    public func readCurrent() -> RuntimeCurrent? {
        guard let data = try? Data(contentsOf: currentPointerURL) else { return nil }
        return RuntimeCurrent.parse(data)
    }

    /// QA-073 containment: resolve a pointer's version dir to a SAFE absolute
    /// path, or nil. Fail-closed unless ALL hold:
    ///  - `path` is exactly `versions/<name>` (one segment under versions/, no
    ///    empty/`.`/`..` segments), matching the version it names,
    ///  - after resolving symlinks the real path is STILL inside the real
    ///    versions/ dir (no symlink escape),
    ///  - the target is a real directory.
    /// A pointer that fails any check resolves to the bundled runtime, never a
    /// path outside runtime/versions/<v>.
    public func containedVersionDir(_ current: RuntimeCurrent) -> URL? {
        let expected = RuntimeCurrent.versionPath(current.version)  // "versions/<v>"
        guard current.path == expected else { return nil }
        let name = current.version
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else { return nil }

        let candidate = versionsDir.appendingPathComponent(name, isDirectory: true)
        // Reject any traversal that standardization would collapse out of place.
        guard candidate.standardizedFileURL.path == candidate.path else { return nil }

        let fm = fileManager
        // The version dir must be a real directory that is not itself a symlink.
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: candidate.path, isDirectory: &isDir), isDir.boolValue else {
            return nil
        }
        if let attrs = try? fm.attributesOfItem(atPath: candidate.path),
            (attrs[.type] as? FileAttributeType) == .typeSymbolicLink
        {
            return nil
        }
        // Symlink-escape guard: the fully-resolved real path must still sit
        // inside the fully-resolved versions/ dir.
        let realVersions = versionsDir.resolvingSymlinksInPath().standardizedFileURL.path
        let realCandidate = candidate.resolvingSymlinksInPath().standardizedFileURL.path
        guard realCandidate == realVersions + "/" + name || realCandidate.hasPrefix(realVersions + "/")
        else { return nil }
        // Belt: the resolved candidate must be exactly one segment below versions.
        guard realCandidate.deletingPathPrefix(realVersions) == "/" + name else { return nil }
        return candidate
    }

    /// The containment-checked daemon script for a pointer, or nil. The script
    /// itself must be a REGULAR file (never a symlink) inside the contained
    /// version dir (QA-073 read-side fix).
    public func containedDaemonScript(_ current: RuntimeCurrent) -> URL? {
        guard let dir = containedVersionDir(current) else { return nil }
        let script = dir.appendingPathComponent("claudexord.bundle.cjs")
        let fm = fileManager
        guard let attrs = try? fm.attributesOfItem(atPath: script.path),
            (attrs[.type] as? FileAttributeType) == .typeRegular
        else { return nil }
        return script
    }
}

private extension String {
    /// Drop `prefix` from the front (empty string if not a prefix).
    func deletingPathPrefix(_ prefix: String) -> String {
        hasPrefix(prefix) ? String(dropFirst(prefix.count)) : ""
    }
}

// MARK: - Install-side filesystem operations (D-2, 3.1)

/// Errors surfaced by the INSTALL write path. Messages are honest and
/// user-facing.
public enum RuntimeInstallError: Error, LocalizedError, Equatable {
    case shaMismatch(expected: String, actual: String)
    case unpackFailed(String)
    case unpackedScriptMissing
    case notMonotonic(target: String)
    case probeMismatch(expected: String, got: String?)
    case daemonBusy
    case handshakeMismatch(expected: String, got: String?)
    case lockHeld
    case io(String)

    public var errorDescription: String? {
        switch self {
        case let .shaMismatch(e, a):
            return "The downloaded runtime did not match its signed digest (expected \(e), got \(a))."
        case let .unpackFailed(m): return "Unpacking the runtime failed: \(m)"
        case .unpackedScriptMissing: return "The unpacked runtime is missing its daemon script."
        case let .notMonotonic(t):
            return "Runtime \(t) is not newer than the installed runtime; refusing a downgrade."
        case let .probeMismatch(e, g):
            return "The unpacked runtime reported version \(g ?? "nil"), expected \(e)."
        case .daemonBusy: return "The engine is busy running jobs; the update will retry when idle."
        case let .handshakeMismatch(e, g):
            return "After relaunch the engine reported \(g ?? "nil"), expected \(e); rolling back."
        case .lockHeld: return "Another runtime update is already in progress."
        case let .io(m): return "Runtime update file error: \(m)"
        }
    }
}

public extension RuntimeInstaller {
    var lastKnownGoodURL: URL { root.appendingPathComponent("last-known-good.json") }
    var lockURL: URL { root.appendingPathComponent("install.lock") }

    func readLastKnownGood() -> RuntimeCurrent? {
        guard let data = try? Data(contentsOf: lastKnownGoodURL) else { return nil }
        return RuntimeCurrent.parse(data)
    }

    /// Ensure the runtime root + versions/ exist.
    func ensureLayout() throws {
        try fileManager.createDirectory(at: versionsDir, withIntermediateDirectories: true)
    }

    /// Verify SHA-256 of raw bytes against the (signed) manifest digest.
    func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// FULL unpack of the closure tarball into a FRESH `versions/<version>/` and
    /// re-verify the daemon script landed. The tar is written to a temp file
    /// first (bsdtar reads a real path); the version dir is replaced atomically-
    /// enough (removed then extracted) — it is not the ACTIVE pointer until the
    /// swap. Returns the version dir.
    func unpack(_ tarball: Data, version: String) throws -> URL {
        try ensureLayout()
        let dir = versionsDir.appendingPathComponent(version, isDirectory: true)
        // Fresh dir every time — never merge over a partial prior unpack.
        try? fileManager.removeItem(at: dir)
        try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmpTar = root.appendingPathComponent("download-\(UUID().uuidString).tar.gz")
        defer { try? fileManager.removeItem(at: tmpTar) }
        do {
            try tarball.write(to: tmpTar, options: .atomic)
        } catch {
            throw RuntimeInstallError.io("could not stage the download: \(error.localizedDescription)")
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        proc.arguments = ["-xzf", tmpTar.path, "-C", dir.path]
        let err = Pipe()
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = err
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            throw RuntimeInstallError.unpackFailed(error.localizedDescription)
        }
        guard proc.terminationStatus == 0 else {
            let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw RuntimeInstallError.unpackFailed("tar exited \(proc.terminationStatus): \(msg)")
        }
        // Re-verify: the daemon script must be a regular file inside the dir.
        let script = dir.appendingPathComponent("claudexord.bundle.cjs")
        guard let attrs = try? fileManager.attributesOfItem(atPath: script.path),
            (attrs[.type] as? FileAttributeType) == .typeRegular
        else {
            throw RuntimeInstallError.unpackedScriptMissing
        }
        return dir
    }

    /// Strip `com.apple.quarantine` from the unpacked tree AFTER hash
    /// verification, so the bundled Node can spawn the unpacked daemon/helper
    /// without a Gatekeeper prompt. Best-effort recursive `xattr -dr`.
    func stripQuarantine(at url: URL) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        proc.arguments = ["-dr", "com.apple.quarantine", url.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
    }

    /// Atomic pointer write: `Data.write(options:.atomic)` writes an aux file
    /// then a single rename(2) over the live pointer — no window with a torn or
    /// partially written current.json.
    func writeCurrentAtomic(_ pointer: RuntimeCurrent) throws {
        try ensureLayout()
        try JSONEncoder().encode(pointer).write(to: currentPointerURL, options: .atomic)
    }

    func writeLastKnownGood(_ pointer: RuntimeCurrent) throws {
        try ensureLayout()
        try JSONEncoder().encode(pointer).write(to: lastKnownGoodURL, options: .atomic)
    }

    /// Remove a version dir (cleanup after a failed probe/verify, before any swap).
    func removeVersionDir(_ version: String) throws {
        let dir = versionsDir.appendingPathComponent(version, isDirectory: true)
        if fileManager.fileExists(atPath: dir.path) {
            try fileManager.removeItem(at: dir)
        }
    }

    /// Delete current.json so the launcher falls back to the bundled runtime
    /// (rollback with no prior installed pointer).
    func removeCurrentPointer() {
        try? fileManager.removeItem(at: currentPointerURL)
    }
}
