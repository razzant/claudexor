import Foundation

/// Pure core of the per-harness auto-save row (HarnessDefaultsRow). Extracted from
/// the SwiftUI view so the two pieces that actually carry logic — the staged-field
/// patch mapping and the anti-clobber settle decision — are unit-tested without a
/// running app (the field-revert bug recurred under visual-QA-only coverage).

/// Build the partial `HarnessSettingsPatch` from the row's raw draft strings.
///
/// Staged-field rule: an empty/whitespace draft encodes an EXPLICIT clear
/// (`.some(nil)` → JSON null = "drop the override"), a non-empty draft sets the
/// value, and `.none` means "leave unchanged". CSV, number and the effort
/// "use default" sentinel are parsed here so the mapping is fixed and testable.
///
/// `modelEditable`: when the row's model field is NOT an editable control
/// (truth-less harness — strict governance shows "default only"), the patch
/// OMITS `defaultModel` unless the draft is an explicit clear (empty). Without
/// this, a stored legacy model that the truth source refuses would ride along
/// with EVERY other field's save and 400 the whole patch — a dead-end row.
public func buildHarnessPatch(
    enabled: Bool,
    modelDraft: String,
    effort: String,
    web: String,
    maxUsdDraft: String,
    toolsAllowDraft: String,
    toolsDenyDraft: String,
    fallbackDraft: String,
    effortSentinel: String = "__default",
    modelEditable: Bool = true
) -> HarnessSettingsPatch {
    func trimmedOrNil(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
    func csv(_ s: String) -> [String] {
        s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    let capText = maxUsdDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    let model = trimmedOrNil(modelDraft)
    let modelField: String?? = modelEditable || model == nil ? .some(model) : .none
    return HarnessSettingsPatch(
        enabled: enabled,
        defaultModel: modelField,
        effort: .some(effort == effortSentinel ? nil : effort),
        web: web,
        maxUsd: .some(capText.isEmpty ? nil : Double(capText)),
        toolsAllow: csv(toolsAllowDraft),
        toolsDeny: csv(toolsDenyDraft),
        fallbackModel: .some(trimmedOrNil(fallbackDraft))
    )
}

/// Auto-save anti-clobber predicate. A save captures the edit generation when it is
/// scheduled; on completion it may only SETTLE (clear `dirty`, flash "Saved ✓") if
/// no newer edit bumped the generation while it was in flight. If a newer edit
/// raced in, the just-saved value is already stale, so `dirty` must stay set to
/// guard the newer typed value against the post-save server re-sync until its OWN
/// debounced save settles it. This is the fix for the field-revert bug.
public func harnessSaveShouldSettle(capturedGen: Int, currentGen: Int) -> Bool {
    capturedGen == currentGen
}

/// Which rendering the harness model-override control shows. Pure so the
/// branch selection is unit-testable (the SwiftUI body just switches on it).
public enum ModelFieldState: Equatable {
    /// Truth source answered and enumerates: show the strict Picker.
    case picker
    /// Truth source ANSWERED "none" and a legacy override is stored: it will
    /// be refused at preflight — show it with the only useful action (Clear).
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
    // Same normalization as buildHarnessPatch: a whitespace-only draft IS an
    // empty draft (the save path encodes it as an explicit clear).
    let hasDraft = !modelDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    if hasDraft, models != nil { return .refusedLegacy }
    if hasDraft, loadFailed { return .unavailableWithDraft }
    if models == nil, !loadFailed { return .loading }
    if loadFailed { return .unavailable }
    return .defaultOnly
}
