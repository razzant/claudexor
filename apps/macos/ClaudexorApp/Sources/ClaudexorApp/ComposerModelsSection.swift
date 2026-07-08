import SwiftUI
import ClaudexorKit

/// Per-harness model rows for the composer "⋯" popover (INV-103).
///
/// One row per pooled harness: `[harness chip] [model dropdown]`. The dropdown
/// is fed by that harness's model TRUTH SOURCE (`/harnesses/:id/models` — live
/// inventory `source: api` or manifest known-good hints `source: manifest`).
/// STRICT: there is no free-text entry — a harness with no truth source
/// shows "Harness default only", because an arbitrary id would be refused by
/// the engine's preflight anyway. Selections build the harness-scoped
/// `models` map that rides the turn; the pool is never poisoned by one
/// vendor's model id.
struct ComposerModelsSection: View {
    let families: [HarnessFamily]
    let primary: HarnessFamily?
    @Binding var selections: [String: String]
    @Binding var catalogs: [String: HarnessModelsResponse]
    let fetch: (HarnessFamily) async -> HarnessModelsResponse?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            ForEach(families) { family in
                HStack(spacing: Theme.Spacing.sm) {
                    Label(family.label, systemImage: family.glyph)
                        .font(.caption)
                        .foregroundStyle(family.color)
                        .frame(width: 92, alignment: .leading)
                    modelPicker(for: family)
                    if family == primary {
                        Text("primary")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .help("This harness answers in chat; the others race when you pick Race.")
                    }
                }
            }
        }
        .task(id: families.map(\.rawValue).joined(separator: ",")) {
            for family in families where catalogs[family.rawValue] == nil {
                if let fetched = await fetch(family) {
                    catalogs[family.rawValue] = fetched
                }
            }
        }
    }

    @ViewBuilder private func modelPicker(for family: HarnessFamily) -> some View {
        let id = family.rawValue
        if let catalog = catalogs[id], catalog.canEnumerate {
            Picker("", selection: bindingFor(id)) {
                Text("Harness default").tag("")
                // A previously-chosen id the truth source no longer lists stays
                // visible so the user can SEE and clear it (the engine refuses
                // it at preflight either way — never silently dropped).
                if let current = selections[id], !current.isEmpty,
                   !catalog.models.contains(where: { $0.id == current }) {
                    Text("\(current) (not in \(catalog.source) list)").tag(current)
                }
                ForEach(catalog.models) { m in
                    Text(menuLabel(m)).tag(m.id)
                }
            }
            .labelsHidden()
            .fixedSize()
            .help(pickerHelp(family, catalog))
        } else if catalogs[id] != nil {
            // A LOADED catalog that cannot enumerate (source: none) — the
            // server's answer, honestly rendered.
            Text("Harness default only")
                .font(.caption)
                .foregroundStyle(.secondary)
                .help("\(family.label) exposes no model truth source, so this turn uses its default model; an explicit model would be refused (strict model governance).")
        } else {
            // Not loaded yet (or the fetch failed) — do NOT claim the harness
            // has no truth source; that is the server's call, not a network
            // hiccup's.
            Text("Loading models…")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .help("Fetching \(family.label)'s model truth source; if this persists, the models endpoint is unreachable.")
        }
    }

    private func bindingFor(_ id: String) -> Binding<String> {
        Binding(
            get: { selections[id] ?? "" },
            set: { newValue in
                if newValue.isEmpty { selections.removeValue(forKey: id) }
                else { selections[id] = newValue }
            },
        )
    }

    private func menuLabel(_ m: HarnessModel) -> String {
        let name = m.label.map { $0.isEmpty ? m.id : $0 } ?? m.id
        return name == m.id ? name : "\(name) (\(m.id))"
    }

    private func pickerHelp(_ family: HarnessFamily, _ catalog: HarnessModelsResponse) -> String {
        let freshness = catalog.verifiedAgainst.map { " (verified against CLI \($0))" } ?? ""
        return "Model for \(family.label) on THIS turn; source: \(catalog.source)\(freshness). Default keeps the harness/settings choice."
    }
}
