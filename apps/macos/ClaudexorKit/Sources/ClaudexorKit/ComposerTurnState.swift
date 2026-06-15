import Foundation

/// The composer's Send / Stop affordance for the selected thread's HEAD turn.
///
/// This is the pure decision core behind `AppModel.selectedThreadBusy` /
/// `selectedThreadStarting` / the Stop gate. It lives in Kit (over primitive
/// inputs, no App types) precisely because the busy-gate has been a repeat
/// source of regressions — extracting it makes every window unit-testable
/// without a running app.
///
/// - `idle`     — no active head turn; the composer shows **Send**.
/// - `starting` — a turn is live but has NOT bound a runId yet (the 202 window),
///                so there is no cancel target; the composer shows a disabled
///                **Starting…** and a second turn cannot be queued over it.
/// - `busy`     — a turn is live AND has a runId (even if its live row has not
///                hydrated yet), so it is cancellable; the composer shows **Stop**.
public enum ComposerTurnState: Equatable, Sendable {
    case idle
    case starting
    case busy
}

/// Resolve the composer turn state from the head turn's signals.
///
/// PRECEDENCE (this is FINAL — do not regress):
///  1. Liveness: once the head turn is BOUND (has a runId) AND its live row has
///     hydrated, the live row is authoritative (`hydratedRowActive`) — it
///     reflects cancel/completion, so a successful Stop flips busy→false and the
///     composer returns to Send. The embedded card state is a STALE snapshot and
///     must only be the FALLBACK (`hydratedRowActive == nil`), covering the
///     202-queued window and the bound-but-not-yet-hydrated window.
///  2. Cancellability: a live turn with a runId is `.busy` (Stop is actionable
///     even before the live row hydrates — `headRunId` is the cancel target); a
///     live turn with NO runId is `.starting` (nothing to cancel yet).
///
/// - Parameters:
///   - headRunId: the head turn's runId, or nil during the 202-queued window.
///   - hydratedRowActive: the live `TaskRun` row's `isActive`, or nil when no
///     hydrated row exists yet (runId nil, or runId present but not merged).
///   - embeddedStateActive: whether the head turn's embedded run-card state is
///     active (the fallback used while no live row has hydrated).
public func resolveComposerTurnState(
    headRunId: String?,
    hydratedRowActive: Bool?,
    embeddedStateActive: Bool
) -> ComposerTurnState {
    // Live row wins when present; otherwise fall back to the embedded card state.
    let busy = hydratedRowActive ?? embeddedStateActive
    guard busy else { return .idle }
    // Busy with a runId → cancellable (Stop); busy without one → still starting.
    return headRunId == nil ? .starting : .busy
}
