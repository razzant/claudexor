import Foundation
import CryptoKit
import ClaudexorKit

// MARK: - Runtime installer: file ops (M7)
//
// The honest, fully-testable core: sha256 verify, unpack (via /usr/bin/tar in a
// Process — the App layer is allowed to spawn), current.json read/write/atomic
// swap, and rollback from last-known-good.json. Everything runs against a real
// directory, so tests use a temp `runtime/` root and a hand-built .tar.gz.

/// Errors surfaced by the runtime updater. Messages are honest and user-facing.
public enum RuntimeUpdateError: Error, LocalizedError, Equatable {
    case transport(String)
    case manifestMissing
    case manifestMalformed
    case shaMismatch(expected: String, actual: String)
    case unpackFailed(String)
    case probeFailed(String)
    case handshakeFailed(String)
    case identityMismatch(expected: String, actual: String)
    case io(String)

    public var errorDescription: String? {
        switch self {
        case let .transport(m): return "Update check failed: \(m)"
        case .manifestMissing: return "The latest release has no runtime-manifest.json asset."
        case .manifestMalformed: return "The runtime manifest could not be parsed."
        case let .shaMismatch(expected, actual):
            return "Downloaded runtime failed integrity check (expected \(expected), got \(actual))."
        case let .unpackFailed(m): return "Unpacking the runtime failed: \(m)"
        case let .probeFailed(m): return "The new runtime failed to boot: \(m)"
        case let .handshakeFailed(m): return "The new runtime did not serve correctly: \(m)"
        case let .identityMismatch(expected, actual):
            return "The serving engine reported version \(actual), expected \(expected)."
        case let .io(m): return "Runtime update file error: \(m)"
        }
    }
}

/// Owns the on-disk `~/.claudexor/runtime/` layout and the pure file operations
/// of an install/rollback. `root` is injectable so tests point it at a temp dir.
public struct RuntimeInstaller: Sendable {
    /// The `runtime/` data root: `versions/<v>/`, `current.json`,
    /// `last-known-good.json`.
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
    public var lastKnownGoodURL: URL { root.appendingPathComponent("last-known-good.json") }
    public func versionDir(_ version: String) -> URL {
        root.appendingPathComponent("versions/\(version)", isDirectory: true)
    }

    // MARK: sha256

    /// Lowercase hex sha256 of the given bytes.
    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Verify downloaded bytes against a manifest's expected lowercase-hex
    /// digest. Throws `.shaMismatch` on any difference — the caller MUST NOT
    /// unpack or swap on a mismatch.
    public static func verifySHA256(_ data: Data, expected: String) throws {
        let actual = sha256Hex(data)
        guard actual == expected.lowercased() else {
            throw RuntimeUpdateError.shaMismatch(expected: expected.lowercased(), actual: actual)
        }
    }

    // MARK: unpack

    /// Unpack a runtime .tar.gz into `versions/<version>/`. The tarball's files
    /// sit at its ROOT, so unpacking into the version dir yields
    /// `versions/<v>/claudexord.bundle.cjs` etc. A pre-existing version dir is
    /// removed first so a partial prior attempt never contaminates the closure.
    public func unpack(tarball: URL, version: String) throws {
        let dir = versionDir(version)
        if fileManager.fileExists(atPath: dir.path) {
            try fileManager.removeItem(at: dir)
        }
        try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-xzf", tarball.path, "-C", dir.path]
        let errPipe = Pipe()
        process.standardError = errPipe
        process.standardOutput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw RuntimeUpdateError.unpackFailed("could not launch tar: \(error.localizedDescription)")
        }
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let msg = String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw RuntimeUpdateError.unpackFailed(msg.isEmpty ? "tar exited \(process.terminationStatus)" : msg)
        }
        // Honest smoke check: the daemon script must exist at the version root.
        guard fileManager.fileExists(atPath: dir.appendingPathComponent("claudexord.bundle.cjs").path) else {
            throw RuntimeUpdateError.unpackFailed("unpacked closure is missing claudexord.bundle.cjs")
        }
    }

    // MARK: current.json read/write/swap

    /// Read + parse the active-runtime pointer, or nil when absent/corrupt.
    public func readCurrent() -> RuntimeCurrent? {
        guard let data = try? Data(contentsOf: currentPointerURL) else { return nil }
        return RuntimeCurrent.parse(data)
    }

    public func readLastKnownGood() -> RuntimeCurrent? {
        guard let data = try? Data(contentsOf: lastKnownGoodURL) else { return nil }
        return RuntimeCurrent.parse(data)
    }

    /// Write the pointer atomically (temp file + rename) so a crash mid-write
    /// never leaves a half-written pointer that would strand the daemon.
    public func writeCurrent(_ pointer: RuntimeCurrent) throws {
        try ensureRoot()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data: Data
        do { data = try encoder.encode(pointer) }
        catch { throw RuntimeUpdateError.io("encode current.json: \(error.localizedDescription)") }
        do {
            try data.write(to: currentPointerURL, options: .atomic)
        } catch {
            throw RuntimeUpdateError.io("write current.json: \(error.localizedDescription)")
        }
    }

    /// Atomic swap to a new active runtime: copy the OUTGOING current.json to
    /// last-known-good.json first (the rollback target), then point current.json
    /// at the new version. When there is no outgoing pointer (first install)
    /// nothing is promoted — a first install has no rollback target.
    public func swapCurrent(to pointer: RuntimeCurrent) throws {
        try ensureRoot()
        if let outgoing = readCurrent() {
            try writeLastKnownGood(outgoing)
        }
        try writeCurrent(pointer)
    }

    public func writeLastKnownGood(_ pointer: RuntimeCurrent) throws {
        try ensureRoot()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try encoder.encode(pointer)
            try data.write(to: lastKnownGoodURL, options: .atomic)
        } catch {
            throw RuntimeUpdateError.io("write last-known-good.json: \(error.localizedDescription)")
        }
    }

    /// Rollback: restore current.json from last-known-good.json. Version dirs are
    /// whole closures and the sidecars version together, so restoring the pointer
    /// IS the rollback. Throws when there is no rollback target.
    public func rollbackToLastKnownGood() throws {
        guard let good = readLastKnownGood() else {
            throw RuntimeUpdateError.io("no last-known-good.json to roll back to")
        }
        try writeCurrent(good)
    }

    private func ensureRoot() throws {
        guard !fileManager.fileExists(atPath: root.path) else { return }
        do {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            throw RuntimeUpdateError.io("create runtime root: \(error.localizedDescription)")
        }
    }
}
