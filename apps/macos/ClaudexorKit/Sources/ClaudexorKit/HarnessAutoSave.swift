import Foundation

/// Pure core of the per-harness auto-save row (HarnessDefaultsRow). Extracted from
/// the SwiftUI view so the two pieces that actually carry logic — the staged-field
/// patch mapping and the anti-clobber settle decision — are unit-tested without a
/// running app (the field-revert bug recurred under visual-QA-only coverage).

/// Build the partial `HarnessSettingsPatch` from the row's raw draft strings.
///
/// Staged-field rule: an empty/whitespace draft encodes an EXPLICIT clear
/// (`.some(nil)` → JSON null = "drop the override"), a non-empty draft sets the
/// value, and `.none` (never produced here) would mean "leave unchanged". CSV,
/// number and the effort "use default" sentinel are parsed here so the mapping is
/// fixed and testable.
public func buildHarnessPatch(
    enabled: Bool,
    modelDraft: String,
    effort: String,
    web: String,
    maxUsdDraft: String,
    toolsAllowDraft: String,
    toolsDenyDraft: String,
    fallbackDraft: String,
    effortSentinel: String = "__default"
) -> HarnessSettingsPatch {
    func trimmedOrNil(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
    func csv(_ s: String) -> [String] {
        s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    let capText = maxUsdDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    return HarnessSettingsPatch(
        enabled: enabled,
        defaultModel: .some(trimmedOrNil(modelDraft)),
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
