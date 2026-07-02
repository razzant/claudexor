import SwiftUI
import ClaudexorKit

/// Model override control for one harness row (ADP4). A Picker over the
/// harness's model TRUTH SOURCE (live inventory or manifest known-good
/// hints). STRICT (D3): there is no free-text entry — a harness with no
/// truth source runs its default only, and a model outside the source would
/// be refused by the engine anyway. The view owns catalog loading so a
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
        }
    }

    @ViewBuilder private var picker: some View {
        if let models {
            Picker("Model override", selection: $modelDraft) {
                Text("Harness default").tag("")
                // A stored override the truth source no longer lists (legacy value)
                // stays visible so the user can SEE and clear it — the engine
                // refuses it at run preflight either way.
                if !modelDraft.isEmpty, !models.models.contains(where: { $0.id == modelDraft }) {
                    Text("\(modelDraft) (not in \(models.source) list)").tag(modelDraft)
                }
                ForEach(models.models) { m in
                    Text(modelMenuLabel(m)).tag(m.id)
                }
            }
            .labelsHidden()
            .help(modelPickerHelp(models))
        }
    }

    /// The harness ANSWERED with no truth source: a stored legacy override
    /// will be refused at preflight, so SHOW it and offer the only
    /// meaningful action — clearing it (explicit null on save).
    private var refusedLegacy: some View {
        LabeledContent("Model") {
                HStack(spacing: Theme.Spacing.xs) {
                    Text("\(modelDraft) — refused (no truth source)")
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
            .help("Could not load the \(family.label) model catalog; the override stays as-is. Retry after reconnecting to verify it.")
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
            .help("Could not load the \(family.label) model catalog. Retry after reconnecting.")
    }

    private func modelMenuLabel(_ m: HarnessModel) -> String {
        let name = (m.label.map { $0.isEmpty ? m.id : $0 } ?? m.id)
        let suffix = name == m.id ? "" : " (\(m.id))"
        return name + suffix
    }

    private func modelPickerHelp(_ models: HarnessModelsResponse) -> String {
        let freshness = models.verifiedAgainst.map { " (verified against CLI \($0))" } ?? ""
        return "Model forwarded to \(family.label); source: \(models.source)\(freshness). Harness default keeps the engine choice."
    }

    private var modelFallbackHelp: String {
        if loadingModels { return "Loading \(family.label) models…" }
        return "\(family.label) exposes no model truth source, so runs use its default model; an explicit model would be refused (strict model governance)."
    }

    private func loadModels(force: Bool = false) async {
        if force { models = nil }
        guard models == nil, !loadingModels else { return }
        loadingModels = true
        loadFailed = false
        defer { loadingModels = false }
        models = await fetch(family)
        loadFailed = models == nil
    }
}
