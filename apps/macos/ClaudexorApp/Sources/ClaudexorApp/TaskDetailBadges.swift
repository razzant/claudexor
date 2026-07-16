import SwiftUI
import ClaudexorKit

// MARK: - Run-detail badge & verdict mappers (no raw wire strings in the UI)
//
// Extracted from `TaskDetailView.swift` (INV-124 new-file cap): pure
// label/glyph/color mappers for the header badges and the review verdict.
// Zero behavior — `private` on the verdict mappers became module-internal
// because their user now lives in another file.

extension TaskDetailView {
    static func outputReadyLabel(_ state: String) -> String {
        switch state {
        case "pending": return "Output pending"
        case "finalizing": return "Output finalizing"
        case "diagnostic": return "Diagnostic output"
        case "ready": return "Output ready"
        default: return state
        }
    }

    /// Honest apply-state badge mapping (shared shape across detail + chat surfaces).
    /// nil => not_applied/unknown: render nothing (envelope-only, plan/answer, no change).
    static func applyStateBadge(_ state: String) -> (String, String, Color)? {
        switch state {
        case "applied": return ("Applied", "checkmark.seal.fill", Theme.status(.succeeded))
        case "applied_review_blocked": return ("Applied · review blocked", "exclamationmark.triangle.fill", Theme.status(.blocked))
        case "reverted": return ("Reverted", "arrow.uturn.backward.circle", .secondary)
        default: return nil
        }
    }

    static func webEvidenceLabel(_ status: String) -> String {
        switch status {
        case "satisfied": return "Web verified"
        case "failed": return "Web failed"
        case "attempted": return "Web attempted"
        case "unverified": return "Web unverified"
        default: return status
        }
    }

    static func webEvidenceGlyph(_ status: String) -> String {
        switch status {
        case "satisfied": return "network"
        case "failed": return "exclamationmark.icloud"
        case "unverified": return "questionmark.diamond" // a policy gap, not a benign attempt
        default: return "icloud"
        }
    }

    static func webEvidenceColor(_ status: String) -> Color {
        switch status {
        case "satisfied": return Theme.status(.succeeded)
        case "failed": return Theme.status(.failed)
        case "unverified": return Theme.status(.blocked)
        default: return .secondary
        }
    }

    func reviewVerdictText(_ verdict: ReviewVerdict) -> String {
        switch verdict {
        case .clean: return "Verified final review clean."
        case .findings: return "Review produced findings."
        case .running: return "Review is running."
        case .failed: return "Review failed."
        case .error: return "Review ended with an error."
        case .ungated: return "Run is ungated; no clean-review claim is available."
        case .notRun: return "Final review was not run."
        }
    }

    func reviewVerdictGlyph(_ verdict: ReviewVerdict) -> String {
        switch verdict {
        case .clean: return "checkmark.seal.fill"
        case .findings: return "exclamationmark.bubble.fill"
        case .running: return "circle.dotted"
        case .failed, .error: return "xmark.octagon.fill"
        case .ungated: return "shield.slash"
        case .notRun: return "person.2.slash"
        }
    }

    func reviewVerdictColor(_ verdict: ReviewVerdict) -> Color {
        switch verdict {
        case .clean: return Theme.status(.succeeded)
        case .findings, .ungated: return Theme.status(.blocked)
        case .running: return Theme.status(.running)
        case .failed, .error: return Theme.status(.failed)
        case .notRun: return .secondary
        }
    }
}
