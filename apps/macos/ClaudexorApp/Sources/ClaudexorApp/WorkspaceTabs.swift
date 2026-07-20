import Foundation

// MARK: - Thread workspace tabs (D42)
//
// The right panel is the THREAD WORKSPACE, not a per-run inspector: exactly
// THREE tabs aggregated across the current thread — Changes / Artifacts /
// Evidence. Activity is no longer a tab: a run's live activity is INLINE in its
// chat receipt now (D42). This is the PURE selection logic behind the tab bar so
// the default + no-auto-jump-after-manual-selection guard are unit-testable
// without standing up a SwiftUI View. `ThreadWorkspacePanel` renders these; the
// state machine lives here.

enum WorkspaceTab: String, CaseIterable, Identifiable, Equatable {
    case changes, artifacts, evidence
    var id: String { rawValue }
    var label: String {
        switch self {
        case .changes: return "Changes"
        case .artifacts: return "Artifacts"
        case .evidence: return "Evidence"
        }
    }
    var glyph: String {
        switch self {
        case .changes: return "plusminus.circle"
        case .artifacts: return "photo.on.rectangle.angled"
        case .evidence: return "stethoscope"
        }
    }
}

/// The inputs the default-tab choice depends on — named so the rule reads as
/// English. Only meaningful when a receipt is selected (the filtered state);
/// the whole-thread view always defaults to Changes.
struct WorkspaceTabInputs: Equatable {
    /// A receipt is selected (the panel is filtered to one run).
    let runSelected: Bool
    /// The selected run's lifecycle terminal is failure-shaped and it produced
    /// no primary output — its diagnostics ARE the deliverable, so open Evidence.
    let selectedRunFailedNoOutput: Bool
}

enum WorkspaceTabPolicy {
    /// The default tab for the panel's current state:
    /// - a selected receipt that failed with no output → Evidence (diagnostics
    ///   are the deliverable)
    /// - everything else (whole-thread, or a receipt with output) → Changes,
    ///   because a run's live Activity is now INLINE in its chat receipt (D42),
    ///   so the panel never opens on a live-timeline tab.
    static func defaultTab(_ i: WorkspaceTabInputs) -> WorkspaceTab {
        if i.runSelected, i.selectedRunFailedNoOutput { return .evidence }
        return .changes
    }

    /// The no-auto-jump guard: once the user has manually chosen a tab, a state
    /// change must NOT yank them elsewhere; until then the tab tracks the
    /// computed default. Returns the tab that should be shown after `inputs`.
    static func resolve(current: WorkspaceTab, userSelected: Bool, inputs: WorkspaceTabInputs) -> WorkspaceTab {
        userSelected ? current : defaultTab(inputs)
    }
}
