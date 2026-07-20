import SwiftUI
import ClaudexorKit

// MARK: - Review verdict mappers (no raw wire strings in the UI)
//
// Pure label/glyph/color mappers for the review verdict, module-internal free
// functions so the thread workspace (RunOutcomeSection) and any other surface
// map the verdict the same way. Formerly `extension TaskDetailView` methods;
// TaskDetailView was retired with the per-run inspector (D42).

func reviewVerdictText(_ verdict: ReviewVerdict) -> String {
    switch verdict {
    case .clean: return "Verified final review clean."
    case .findings: return "Review produced findings."
    case .running: return "Review is running."
    case .failed: return "Review failed."
    case .error: return "Review ended with an error."
    case .notRun: return "Final review was not run."
    }
}

func reviewVerdictGlyph(_ verdict: ReviewVerdict) -> String {
    switch verdict {
    case .clean: return "checkmark.seal.fill"
    case .findings: return "exclamationmark.bubble.fill"
    case .running: return "circle.dotted"
    case .failed, .error: return "xmark.octagon.fill"
    case .notRun: return "person.2.slash"
    }
}

func reviewVerdictColor(_ verdict: ReviewVerdict) -> Color {
    switch verdict {
    case .clean: return Theme.status(.positive)
    case .findings: return Theme.status(.caution)
    case .running: return Theme.status(.info)
    case .failed, .error: return Theme.status(.negative)
    case .notRun: return .secondary
    }
}
