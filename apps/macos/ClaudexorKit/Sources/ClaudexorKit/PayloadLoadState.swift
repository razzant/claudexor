import Foundation

// MARK: - Payload load state (D15)
//
// A typed load-state machine for the Run Detail PAYLOAD surfaces only — the
// heavy, tab-only fetches (artifact list/text/image, the diff, project
// outputs). It exists to make one invariant mechanical and testable: stale
// bytes must NEVER render under a new identity. Every payload is keyed by its
// `(runId, plane, path)` identity; when the identity changes the slot resets
// to `.loading` immediately, and a late result for a superseded identity is
// dropped rather than painted over the new run's surface.

/// The plane a payload is fetched from. A run's own orchestration tree vs. the
/// project's produced outputs are DIFFERENT bytes for the same path, so the
/// plane is part of the identity.
public enum PayloadPlane: String, Sendable, Equatable {
    case run
    case produced
    case diff
}

/// The identity of one payload fetch. Two fetches are the same content iff all
/// three components match; anything else is a distinct identity and may not
/// share rendered bytes.
public struct PayloadIdentity: Sendable, Equatable, Hashable {
    public let runId: String
    public let plane: PayloadPlane
    /// nil for whole-list / whole-run payloads (e.g. the artifact list or diff);
    /// set for a single file's bytes/text.
    public let path: String?

    public init(runId: String, plane: PayloadPlane, path: String? = nil) {
        self.runId = runId
        self.plane = plane
        self.path = path
    }
}

/// Typed failure reasons for a payload fetch — never a bare string, so the UI
/// renders a consistent, honest cause + retry affordance.
public enum PayloadError: Error, Sendable, Equatable {
    /// The engine was offline or the request never reached it.
    case offline
    /// The request reached the engine but failed; carries the server's message.
    case transport(String)
    /// The bytes arrived but are not renderable in this surface (e.g. a patch
    /// that is not a text diff, an oversize/undecodable image).
    case notRenderable(String)

    public var message: String {
        switch self {
        case .offline:
            return "The engine is offline or the request failed. Re-open this tab to retry."
        case .transport(let m): return m
        case .notRenderable(let m): return m
        }
    }
}

/// The load state of one payload surface. `.loaded` carries the value; `.empty`
/// is a SUCCESSFUL load that produced nothing (distinct from a failure).
public enum LoadState<Value: Equatable & Sendable>: Sendable, Equatable {
    case idle
    case loading
    case loaded(Value)
    case empty
    case failed(PayloadError)

    public var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }
    public var isTerminal: Bool {
        switch self {
        case .loaded, .empty, .failed: return true
        case .idle, .loading: return false
        }
    }
}

/// An identity-keyed load slot. The slot owns the invariant that a value may
/// only be shown under the identity it was fetched for.
///
/// Lifecycle:
///   1. `begin(id)` when a surface appears / the identity changes — resets to
///      `.loading` the instant the identity differs, so the previous run's
///      bytes stop rendering before the new fetch has even started.
///   2. `commit(_:for:)` when a fetch returns — applied ONLY if `id` still
///      matches the slot's current identity; a late result for a superseded
///      identity is dropped.
public struct PayloadSlot<Value: Equatable & Sendable>: Sendable, Equatable {
    public private(set) var identity: PayloadIdentity?
    public private(set) var state: LoadState<Value>

    public init() {
        identity = nil
        state = .idle
    }

    /// Point the slot at `id`. If it differs from the current identity the slot
    /// resets to `.loading` and drops any previously loaded value (the core
    /// no-stale-bytes guarantee). Re-`begin`-ing the SAME identity is a no-op so
    /// a view that re-appears keeps its already-loaded content.
    public mutating func begin(_ id: PayloadIdentity) {
        guard identity != id else { return }
        identity = id
        state = .loading
    }

    /// Commit a fetch result for `id`. Ignored unless `id` is still the slot's
    /// current identity — a result that raced a newer `begin` never paints.
    /// Returns true when the result was applied.
    @discardableResult
    public mutating func commit(_ result: LoadState<Value>, for id: PayloadIdentity) -> Bool {
        guard identity == id else { return false }
        state = result
        return true
    }
}
