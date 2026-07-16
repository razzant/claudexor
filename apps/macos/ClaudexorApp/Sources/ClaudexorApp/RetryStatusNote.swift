import Foundation

/// A typed transient status from the harness (Ф2.5 W-C2): today only claude's
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
            parts.append(retryDelayMs >= 1000 ? "in \(retryDelayMs / 1000)s" : "in \(retryDelayMs)ms")
        }
        return parts.joined(separator: " · ")
    }
}
