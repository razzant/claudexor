import Foundation

/// Which rendering the harness model-override control shows. Pure so the
/// branch selection is unit-testable (the SwiftUI body just switches on it).
public enum ModelFieldState: Equatable {
    /// Truth source answered and enumerates: show the strict Picker.
    case picker
    /// Truth source ANSWERED "none" and a legacy override is stored: the
    /// picker cannot offer it (an authoritative harness refuses it at
    /// preflight; an advisory one forwards it and says so) — show it with the
    /// only useful action (Clear).
    case refusedLegacy
    /// Catalog fetch failed (offline/transient) with a stored override: we
    /// could NOT check it — neutral copy + Retry, never a refusal claim.
    case unavailableWithDraft
    /// Catalog fetch failed with no stored override: Retry, no truth claim.
    case unavailable
    /// Truth source answered "none" and nothing is stored: default only.
    case defaultOnly
    /// Catalog not answered yet (initial load or active retry): transient.
    case loading
}

public func modelFieldState(
    models: HarnessModelsResponse?,
    modelDraft: String,
    loadFailed: Bool
) -> ModelFieldState {
    if let models, models.canEnumerate { return .picker }
    // Same normalization as the field-owned settings patch: whitespace-only
    // is an empty draft, which the save path encodes as an explicit clear.
    let hasDraft = !modelDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    // A failed live read (#393) answered with a typed problem proves nothing:
    // it is "unavailable", never an empty list or an absent stored model.
    let readFailed = loadFailed || models?.problem != nil
    if hasDraft, models != nil, !readFailed { return .refusedLegacy }
    if hasDraft, readFailed { return .unavailableWithDraft }
    if models == nil, !loadFailed { return .loading }
    if readFailed { return .unavailable }
    return .defaultOnly
}
