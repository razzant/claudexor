import Foundation

/// A typed transient status from the harness (F2.5 W-C2): today only claude's
/// api_retry. Projected from `HarnessEvent.status`; the UI renders «Retrying
/// 2/10 · overloaded · in 2.5s» instead of dropping it into reasoning junk.
struct RetryStatusNote: Hashable {
    var kind: String
    var attempt: Int?
    var maxRetries: Int?
    var retryDelayMs: Int?
    var errorCategory: String?

    /// One-line human summary; nil components are simply omitted.
    var label: String {
        var parts: [String] = []
        if let attempt, let maxRetries { parts.append("Retrying \(attempt)/\(maxRetries)") }
        else { parts.append("Retrying") }
        if let errorCategory, !errorCategory.isEmpty {
            parts.append(errorCategory.replacingOccurrences(of: "_", with: " "))
        }
        if let retryDelayMs, retryDelayMs > 0 {
            parts.append("in \(Self.humanizeDelay(retryDelayMs))")
        }
        return parts.joined(separator: " · ")
    }

    /// «2.5s» / «800ms» — fractional seconds are preserved, not truncated
    /// (confirm #6: integer 2500/1000 rendered a misleading «2s»).
    static func humanizeDelay(_ ms: Int) -> String {
        guard ms >= 1000 else { return "\(ms)ms" }
        if ms % 1000 == 0 { return "\(ms / 1000)s" }
        return String(format: "%.1fs", Double(ms) / 1000.0)
    }
}
