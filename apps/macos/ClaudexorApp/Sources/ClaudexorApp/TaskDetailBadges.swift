import SwiftUI
import ClaudexorKit

// MARK: - Run-detail badge & verdict mappers (no raw wire strings in the UI)
//
// Extracted from `TaskDetailView.swift` (INV-124 new-file cap): pure
// label/glyph/color mappers for the header badges and the review verdict.
// Zero behavior — `private` on the verdict mappers became module-internal
// because their user now lives in another file.

extension TaskDetailView {
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
