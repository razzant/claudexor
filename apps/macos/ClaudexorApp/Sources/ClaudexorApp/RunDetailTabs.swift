import Foundation

// MARK: - Run Detail tabs (D15)
//
// Exactly FOUR tabs, plus the PURE selection logic behind the tab bar so the
// defaults + no-auto-jump-after-manual-selection guard are unit-testable
// without standing up a SwiftUI View. `TaskDetailView` renders these; the
// state machine lives here.

enum RunDetailTab: String, CaseIterable, Identifiable, Equatable {
    case outcome, activity, changes, evidence
    var id: String { rawValue }
    var label: String {
        switch self {
        case .outcome: return "Outcome"
        case .activity: return "Activity"
        case .changes: return "Changes"
        case .evidence: return "Evidence"
        }
    }
    var glyph: String {
        switch self {
        case .outcome: return "text.bubble"
        case .activity: return "waveform"
        case .changes: return "plusminus.circle"
        case .evidence: return "stethoscope"
        }
    }
}

/// The lifecycle inputs the default-tab choice depends on — the only run facts
/// the tab picker reads, named so the rule reads as English.
struct RunDetailTabInputs: Equatable {
    /// The run is still active (queued/running).
    let isActive: Bool
    /// The lifecycle terminal is failure-shaped (failed/blocked/exhausted/no-op).
    let isFailureShaped: Bool
    /// A real answer artifact is present.
    let hasAnswer: Bool
}

enum RunDetailTabPolicy {
    /// The default tab for a run's current state:
    /// - running → Activity (the live timeline)
    /// - failure-shaped terminal with NO answer → Evidence (diagnostics ARE the
    ///   deliverable)
    /// - everything else (incl. review-blocked, whose decision controls live in
    ///   Outcome) → Outcome
    static func defaultTab(_ i: RunDetailTabInputs) -> RunDetailTab {
        if i.isActive { return .activity }
        if i.isFailureShaped, !i.hasAnswer { return .evidence }
        return .outcome
    }

    /// The no-auto-jump guard: once the user has manually chosen a tab, a state
    /// change must NOT yank them elsewhere; until then the tab tracks the
    /// computed default. Returns the tab that should be shown after `inputs`.
    static func resolve(current: RunDetailTab, userSelected: Bool, inputs: RunDetailTabInputs) -> RunDetailTab {
        userSelected ? current : defaultTab(inputs)
    }
}
