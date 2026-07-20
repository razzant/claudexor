import Foundation
import ClaudexorKit

// MARK: - Runtime pointer reader (M7 — 3.0 READ side only)
//
// Owns the on-disk `~/.claudexor/runtime/` layout, but for 3.0 only the READ
// side ships: resolving the ACTIVE runtime pointer (`current.json`) so
// DaemonLauncher can launch an installed closure and the update check can name
// the running engine version. The WRITE side of an install (sha-verify, unpack,
// atomic pointer swap, last-known-good rollback) and the daemon-lifecycle
// process signalling are DEFERRED to 3.1 per owner-locked D1 — that
// security-sensitive install machinery is out of 3.0 entirely, not half-wired.
// Nothing in 3.0 writes `current.json`; when absent (the 3.0 norm) callers fall
// back to the app-bundled runtime.

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

    // MARK: current.json read

    /// Read + parse the active-runtime pointer, or nil when absent/corrupt. A
    /// corrupt or missing pointer resolves to the bundled runtime, never a crash
    /// or a bogus dir.
    public func readCurrent() -> RuntimeCurrent? {
        guard let data = try? Data(contentsOf: currentPointerURL) else { return nil }
        return RuntimeCurrent.parse(data)
    }
}
