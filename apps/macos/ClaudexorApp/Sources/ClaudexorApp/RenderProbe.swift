import Foundation

/// Debug-only render-count instrumentation (D-13 E).
///
/// SwiftUI body re-evaluation FREQUENCY (not glass/transparency) is the
/// live-stream performance lever (DESIGN_SYSTEM §3.2). This counter lets
/// Instruments / manual QA — and the focused observation test — observe how
/// often a heavy view body actually re-evaluates, so the effect of the
/// `.equatable()` containment guards is measurable rather than asserted by feel.
///
/// It is OFF unless `CLAUDEXOR_RENDER_PROBE` is set in the environment (a test
/// flips `enabled` directly), so normal runs and release builds pay nothing: a
/// disabled `record(_:)` is a single bool check and returns.
@MainActor
enum RenderProbe {
    /// Gate: no counting unless explicitly enabled. Reading the env once keeps
    /// the hot path branch-only.
    static var enabled = ProcessInfo.processInfo.environment["CLAUDEXOR_RENDER_PROBE"] != nil

    private static var counts: [String: Int] = [:]

    /// Record one body evaluation for `key`. A no-op while disabled.
    static func record(_ key: String) {
        guard enabled else { return }
        counts[key, default: 0] += 1
    }

    /// Body evaluations recorded for `key` since the last `reset()`.
    static func count(_ key: String) -> Int { counts[key] ?? 0 }

    /// Clear all counters (test setup / a fresh measurement window).
    static func reset() { counts.removeAll() }
}
