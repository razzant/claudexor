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
    /// Effective per-turn credential route (W20): the server filters
    /// manifest-annotated models by it; api-sourced per-model annotations are
    /// filtered here with an honest hidden-count note. nil = unfiltered.
    var route: String? = nil
    @Binding var selections: [String: String]
    /// Keyed by `catalogKey(family, route:)` — a catalog is only valid for the
    /// ROUTE it was fetched under, and caching per (family, route) means
    /// reopening an unchanged popover refetches NOTHING (model enumeration can
    /// invoke adapter CLIs — sol review #7).
    @Binding var catalogs: [String: HarnessModelsResponse]
    let fetch: (HarnessFamily) async -> HarnessModelsResponse?

    /// Composite cache key: the same harness under another auth route is a
    /// DIFFERENT truth source, never a cache hit.
    static func catalogKey(_ family: HarnessFamily, route: String?) -> String {
        family.rawValue + "|" + (route ?? "any")
    }

    /// Which families actually need a fetch: only those with no catalog cached
    /// under the CURRENT route. Pure — unit-tested (reopen = no fetches; a
    /// route change or a newly pooled family fetches exactly the missing ones).
    static func familiesToFetch(_ families: [HarnessFamily], route: String?,
                                cached: some Collection<String>) -> [HarnessFamily] {
        families.filter { !cached.contains(catalogKey($0, route: route)) }
    }

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
                            .help("This harness answers in chat; the others race when you pick Best-of.")
                    }
                }
            }
        }
        // Fetch when the pool OR the effective route changes — but ONLY the
        // (family, route) pairs not already cached: reopening an unchanged
        // popover is zero requests, a route flip fetches fresh truth (a stale
        // same-key hit would keep offering models the new route refuses), and
        // a failed fetch leaves the key missing so the next open retries.
        .task(id: families.map(\.rawValue).joined(separator: ",") + ":" + (route ?? "any")) {
            for family in Self.familiesToFetch(families, route: route, cached: catalogs.keys) {
                if let fetched = await fetch(family) {
                    catalogs[Self.catalogKey(family, route: route)] = fetched
                }
            }
        }
    }

    /// Models offerable on the effective route: an annotated model whose
    /// routes exclude it is HIDDEN (the engine's strict preflight would refuse
    /// it anyway); unannotated models ride every route. Pure — unit-tested.
    static func visibleModels(_ models: [HarnessModel], route: String?) -> [HarnessModel] {
        guard let route else { return models }
        return models.filter { $0.routes == nil || $0.routes?.contains(route) == true }
    }

    @ViewBuilder private func modelPicker(for family: HarnessFamily) -> some View {
        let id = family.rawValue
        let key = Self.catalogKey(family, route: route)
        if let catalog = catalogs[key], catalog.canEnumerate {
            let visible = Self.visibleModels(catalog.models, route: route)
            Picker("", selection: bindingFor(id)) {
                Text("Harness default").tag("")
                // A previously-chosen id the truth source no longer lists (or
                // the current route hides) stays visible so the user can SEE
                // and clear it (the engine refuses it at preflight either way
                // — never silently dropped).
                if let current = selections[id], !current.isEmpty,
                   !visible.contains(where: { $0.id == current }) {
                    Text("\(current) (not offered here)").tag(current)
                }
                ForEach(visible) { m in
                    Text(menuLabel(m)).tag(m.id)
                }
            }
            .labelsHidden()
            .fixedSize()
            .help(pickerHelp(family, catalog, hiddenOnRoute: catalog.models.count - visible.count))
        } else if catalogs[key] != nil {
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

    private func pickerHelp(_ family: HarnessFamily, _ catalog: HarnessModelsResponse, hiddenOnRoute: Int) -> String {
        let freshness = catalog.verifiedAgainst.map { " (verified against CLI \($0))" } ?? ""
        let hidden = hiddenOnRoute > 0
            ? " \(hiddenOnRoute) model\(hiddenOnRoute == 1 ? " is" : "s are") hidden on the current auth route."
            : ""
        return "Model for \(family.label) on THIS turn; source: \(catalog.source)\(freshness).\(hidden) Default keeps the harness/settings choice."
    }
}
