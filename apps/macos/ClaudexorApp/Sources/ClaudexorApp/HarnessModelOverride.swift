import SwiftUI
import ClaudexorKit

/// Model override control for one harness row (ADP4). A Picker over the
/// harness's model list (live inventory or manifest known-good hints); there
/// is no free-text entry — a harness with no list runs its default only. What
/// an id outside the list means is the harness's own declaration (INV-104):
/// refused by an authoritative harness, forwarded and disclosed by an advisory
/// one. The view owns catalog loading so a
/// transport failure is distinguishable from an ANSWERED "no truth source".
@MainActor
struct HarnessModelOverrideField: View {
    let family: HarnessFamily
    @Binding var modelDraft: String
    /// One-shot enumeration; thin consumer of the control-api DTO. nil =
    /// offline/failed, so the neutral catalog-unavailable state renders.
    let fetch: (HarnessFamily) async -> HarnessModelsResponse?
    /// Owned by the row (the save path derives modelEditable from it); the
    /// subview only loads and renders through this binding.
    @Binding var models: HarnessModelsResponse?

    @State private var loadingModels = false
    /// True when the LAST fetch returned nil (offline/failed) — distinct from
    /// "not yet loaded" and from an answered source:"none".
    @State private var loadFailed = false

    var body: some View {
        content.task { await loadModels() }
    }

    @ViewBuilder private var content: some View {
        switch modelFieldState(models: models, modelDraft: modelDraft, loadFailed: loadFailed) {
        case .picker:
            picker
        case .refusedLegacy:
            refusedLegacy
        case .unavailableWithDraft:
            unavailableWithDraft
        case .unavailable:
            unavailableNoDraft
        case .defaultOnly:
            LabeledContent("Model") {
                Text("Harness default only")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .help(modelFallbackHelp)
        case .loading:
            // Catalog not answered yet: a transient state, not a truth claim.
            LabeledContent("Model") {
                Text("Loading model catalog…")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .help("Loading the \(family.label) model catalog…")
        }
    }

    /// Same `LabeledContent("Model")` shell as every sibling state above, so
    /// the row does not re-layout when the catalog resolves; the control obeys
    /// the shared catalog-picker contract (fixed token width + capped menu
    /// titles) exactly like the composer surface.
    @ViewBuilder private var picker: some View {
        if let models {
            LabeledContent("Model") {
                Picker("Model override", selection: $modelDraft) {
                    Text("Harness default").tag("")
                    // A stored override the truth source no longer lists (legacy
                    // value) stays visible so the user can SEE and clear it — run
                    // preflight judges it by the harness's own declaration (refused
                    // on an authoritative list, forwarded with a note on an advisory
                    // one). Shared cap: a long stored id cannot widen the open menu.
                    if !modelDraft.isEmpty, !models.models.contains(where: { $0.id == modelDraft }) {
                        Text("\(HarnessModelPresentation.menuTitle(label: nil, id: modelDraft)) (not in \(models.source) list)")
                            .tag(modelDraft)
                    }
                    ForEach(models.models) { m in
                        Text(HarnessModelPresentation.menuTitle(label: m.label, id: m.id)).tag(m.id)
                    }
                }
                .catalogModelPicker()
            }
            .help(modelPickerHelp(models))
        }
    }

    /// The harness ANSWERED with no truth source while a legacy override is
    /// stored: an authoritative harness refuses it at preflight, an advisory
    /// one sends it to the vendor as-is and says so (INV-104). Either way the
    /// picker cannot offer it, so SHOW it with the one meaningful action —
    /// clearing it (explicit null on save).
    private var refusedLegacy: some View {
        LabeledContent("Model") {
                HStack(spacing: Theme.Spacing.xs) {
                    Text("\(modelDraft) — not in this harness's model list")
                        .font(.caption).foregroundStyle(.orange)
                    Button("Clear") { modelDraft = "" }
                        .controlSize(.small)
                        .help("Removes the stored override so this harness runs its default model.")
                }
            }
            .help(modelFallbackHelp)
    }

    /// Catalog request failed (engine offline / transient): do NOT claim the
    /// override is refused — we could not check it. Retry refetches.
    private var unavailableWithDraft: some View {
        LabeledContent("Model") {
                HStack(spacing: Theme.Spacing.xs) {
                    Text("\(modelDraft) — model catalog unavailable")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Retry") { Task { await loadModels(force: true) } }
                        .controlSize(.small)
                        .help("Reload the \(family.label) model catalog to verify this override.")
                }
            }
            // The engine decides per read (#393, decision A); the copy states the rule.
            .help(models?.problem.map {
                "\(family.label): \($0.message). The override stays as-is; a run sends it unverified unless the API key is missing or rejected."
            }
                ?? "Could not load the \(family.label) model catalog; the override stays as-is. Retry after reconnecting to verify it.")
    }

    /// Catalog fetch failed with no stored override: offer Retry and do NOT
    /// claim the harness has no truth source — we don't know yet.
    private var unavailableNoDraft: some View {
        LabeledContent("Model") {
                HStack(spacing: Theme.Spacing.xs) {
                    Text("Model catalog unavailable")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Retry") { Task { await loadModels(force: true) } }
                        .controlSize(.small)
                        .help("Reload the \(family.label) model catalog.")
                }
            }
            .help(models?.problem.map { "\(family.label): \($0.message)." }
                ?? "Could not load the \(family.label) model catalog. Retry after reconnecting.")
    }

    private func modelPickerHelp(_ models: HarnessModelsResponse) -> String {
        let freshness = models.verifiedAgainst.map { " (verified against CLI \($0))" } ?? ""
        return "Model forwarded to \(family.label); source: \(models.source)\(freshness). Harness default keeps the engine choice."
    }

    private var modelFallbackHelp: String {
        if loadingModels { return "Loading \(family.label) models…" }
        return "\(family.label) exposes no model list, so runs use its default model; an explicit override is judged at run time by the harness's own declaration (refused where its lists are authoritative, forwarded and disclosed where they are advisory)."
    }

    private func loadModels(force: Bool = false) async {
        if force { models = nil }
        // A failed live read (#393) is shown, never kept as truth: read it again.
        guard models == nil || models?.problem != nil, !loadingModels else { return }
        loadingModels = true
        loadFailed = false
        defer { loadingModels = false }
        models = await fetch(family)
        loadFailed = models == nil
    }
}
