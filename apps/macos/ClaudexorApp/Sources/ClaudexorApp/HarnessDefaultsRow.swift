//
// HarnessDefaultsRow — per-harness engine defaults editor (model/effort/
// fallback) with debounced saves and anti-clobber draft sync. Split from
// OpsScreens.swift to keep the settings screen readable.
//

import SwiftUI
import AppKit
import ClaudexorKit

/// One harness's engine defaults (enabled / model / effort / web), saved as a
/// partial patch so untouched fields keep their stored values.
// @MainActor: this View's helpers (`performSave`, `scheduleSave`, `sync`,
// `flushPendingSave`, `loadModels`) read/mutate `@State`. View methods are NOT
// implicitly main-actor-isolated, so an async/detached Task running one of them
// could mutate SwiftUI `@State` off the main actor (a threading violation under
// strict concurrency). Annotating the struct pins every helper — and the
// `Task { @MainActor in … }` closures that call them — to the main actor.
@MainActor
struct HarnessDefaultsRow: View {
    @Environment(AppModel.self) private var model
    let family: HarnessFamily
    let settings: HarnessSettings?
    @State private var enabled = true
    @State private var modelDraft = ""
    /// Catalog answer for THIS harness; nil = offline/unloaded. The save path
    /// derives modelEditable from it (H2: truth-less rows must not persist).
    @State private var models: HarnessModelsResponse?
    @State private var effort = "__default"
    @State private var web = "auto"
    @State private var maxUsdDraft = ""
    @State private var fallbackDraft = ""
    @State private var toolsAllowDraft = ""
    @State private var toolsDenyDraft = ""
    @State private var saving = false
    /// Anti-clobber: true once the user edits a field, until OUR save settles.
    /// While dirty, `sync()` refuses to re-derive drafts from `settings`, so a
    /// post-save `refreshSettings()` (which republishes `settingsSnapshot` to
    /// EVERY row) can't overwrite an in-progress edit — in this row or any other.
    @State private var dirty = false
    /// Debounce handle: each edit (re)schedules this; it sleeps, then auto-saves.
    /// Cancelled on further edits so typing is one save, not a save per keystroke.
    @State private var debounce: Task<Void, Never>?
    /// Transient per-row save status shown next to the row (Saved ✓ / error).
    @State private var status: SaveStatus = .idle
    /// True while `sync()` is programmatically writing the drafts. The field
    /// `.onChange` handlers check this so a server-driven re-sync does not look
    /// like a user edit and re-trigger an auto-save (which would loop).
    @State private var applyingSync = false
    /// Value snapshot of the drafts as last written by `sync()`. scheduleSave ignores
    /// a `.onChange` whose drafts still equal this (a programmatic sync echo that fires
    /// a cycle after `applyingSync` was cleared), so server refreshes don't auto-save.
    @State private var syncedSnapshot: [String] = []

    /// Per-row save lifecycle for the transient status line.
    private enum SaveStatus: Equatable {
        case idle, editing, saving, saved, failed(String)
    }

    /// Debounce window: long enough that typing a model id is one save, short
    /// enough that a blur/commit feels immediate.
    private static let debounceMs: UInt64 = 600

    private var effortLevels: [String] {
        var levels = model.harnessInfo(for: family)?.effortLevels ?? []
        if effort != "__default", !levels.contains(effort) { levels.insert(effort, at: 0) }
        return levels
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                HarnessChip(family: family, selected: enabled, available: true)
                Spacer(minLength: Theme.Spacing.md)
                statusLabel
                Toggle("Enabled", isOn: $enabled)
                    .toggleStyle(.switch).tint(Theme.accent)
                    .labelsHidden()
                    .help("Disabled harnesses are excluded from routing and pools.")
                    // A toggle commits immediately — no need to debounce a discrete flip.
                    .onChange(of: enabled) { _, _ in scheduleSave(immediate: true) }
            }
            HStack(spacing: Theme.Spacing.sm) {
                // Settings default-model enumeration stays UNfiltered: the
                // global truth source, not a per-turn route (W11 — strictness
                // lives at run preflight, not settings-write).
                HarnessModelOverrideField(family: family, modelDraft: $modelDraft,
                                          fetch: { await model.harnessModels(for: $0) }, models: $models)
                if !effortLevels.isEmpty {
                    Picker("Effort", selection: $effort) {
                        Text("Default").tag("__default")
                        ForEach(effortLevels, id: \.self) { Text($0).tag($0) }
                    }
                    .fixedSize()
                    .help("Adapter-declared reasoning effort for \(family.label).")
                    .onChange(of: effort) { _, _ in scheduleSave(immediate: true) }
                }
                Picker("Web", selection: $web) {
                    Text("Auto").tag("auto")
                    Text("Off").tag("off")
                    Text("Cached").tag("cached")
                    Text("Live").tag("live")
                }
                .fixedSize()
                .help("Default external web/search policy for this harness.")
                .onChange(of: web) { _, _ in scheduleSave(immediate: true) }
            }
            HStack(spacing: Theme.Spacing.sm) {
                HStack(spacing: 4) {
                    Text("$").foregroundStyle(.secondary)
                    TextField("max/run", text: $maxUsdDraft)
                        .frame(width: 64)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .onChange(of: maxUsdDraft) { _, _ in scheduleSave() }
                        .onSubmit { scheduleSave(immediate: true) }
                }
                .help("Per-harness USD cap per run. Empty keeps the engine default.")
                TextField("fallback model", text: $fallbackDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .help("Model used if the primary model is unavailable. Empty = none.")
                    .onChange(of: fallbackDraft) { _, _ in scheduleSave() }
                    .onSubmit { scheduleSave(immediate: true) }
            }
            HStack(spacing: Theme.Spacing.sm) {
                TextField("tools allow (comma-separated)", text: $toolsAllowDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .help("Allow-list of tool ids for \(family.label). Empty = harness default.")
                    .onChange(of: toolsAllowDraft) { _, _ in scheduleSave() }
                    .onSubmit { scheduleSave(immediate: true) }
                TextField("tools deny (comma-separated)", text: $toolsDenyDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .help("Deny-list of tool ids for \(family.label).")
                    .onChange(of: toolsDenyDraft) { _, _ in scheduleSave() }
                    .onSubmit { scheduleSave(immediate: true) }
            }
            if !maxUsdValid {
                Label("Budget cap must be a non-negative number, or empty.", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2).foregroundStyle(Theme.status(.failed))
            }
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.surfaceRaisedHi.opacity(0.5), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        // The model override Picker mutates modelDraft via its binding, not via
        // free-text typing, so debounce-save its commits here (discrete choice).
        .onChange(of: modelDraft) { _, _ in scheduleSave() }
        .onAppear { sync() }
        // Re-sync from the server snapshot ONLY when this row is not mid-edit.
        // `sync()` is guarded by `dirty`, so a post-save refresh that republishes
        // `settingsSnapshot` to every row never clobbers a value being typed.
        .onChange(of: settings) { _, _ in sync() }
        // Lazily enumerate this harness's models when the row first appears.
        // FLUSH on disappear (Finding 1): if Settings closes / the row navigates
        // away within the ~600ms debounce window, a typed-but-unsaved value would
        // be lost if we only cancelled. Cancel the pending debounce SLEEP, then
        // persist immediately if there's a valid unsaved edit. We pass the current
        // `saveGen` so the flush settles the latest edit (clears `dirty`, flashes
        // "Saved ✓") unless a brand-new edit raced in after the flush fired.
        .onDisappear { flushPendingSave() }
    }

    /// Persist any pending debounced edit before the row goes away. Called from
    /// `.onDisappear`; safe to call when there's nothing to save (no-ops unless
    /// `dirty`). Skips when the budget cap is invalid so we never POST a bad value.
    private func flushPendingSave() {
        debounce?.cancel()
        guard dirty, maxUsdValid else { return }
        // Single-flight performSave: if a loop is already running it persists the
        // latest drafts; otherwise this starts one.
        Task { @MainActor in await performSave() }
    }

    /// Transient per-row save status — replaces the old "Save" button the user
    /// could not find. Shows "Saving…", "Saved ✓", or a clear error.
    @ViewBuilder private var statusLabel: some View {
        switch status {
        case .idle:
            EmptyView()
        case .editing:
            Text("Editing…").font(.caption2).foregroundStyle(.secondary)
        case .saving:
            Label("Saving…", systemImage: "arrow.triangle.2.circlepath")
                .font(.caption2).foregroundStyle(.secondary).labelStyle(.titleAndIcon)
        case .saved:
            Label("Saved", systemImage: "checkmark.circle.fill")
                .font(.caption2).foregroundStyle(Theme.status(.succeeded)).labelStyle(.titleAndIcon)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption2).foregroundStyle(Theme.status(.failed)).labelStyle(.titleAndIcon)
                .lineLimit(2).help(message)
        }
    }

    private var maxUsdValid: Bool {
        let t = maxUsdDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return true }
        return (Double(t) ?? -1) >= 0
    }

    /// Re-derive the @State drafts from the server `settings`. ANTI-CLOBBER: this
    /// is a no-op while the row is `dirty` (the user has unsaved edits or a save in
    /// flight), so a post-save `refreshSettings()` — which republishes
    /// `settingsSnapshot` to EVERY row — can never overwrite a value being typed,
    /// in this row or any other. `dirty` is cleared authoritatively by the save's
    /// success path (`performSave`), after which the drafts already hold the saved
    /// value, so the row reflects the save instead of reverting. Before the first
    /// edit (`dirty == false`) it always syncs, so the row hydrates normally.
    private func sync() {
        if dirty { return }
        applyingSync = true
        defer { applyingSync = false }
        enabled = settings?.enabled ?? true
        modelDraft = settings?.defaultModel ?? ""
        effort = settings?.effort ?? "__default"
        web = settings?.web ?? "auto"
        maxUsdDraft = settings?.maxUsd.map { String(format: "%g", $0) } ?? ""
        fallbackDraft = settings?.fallbackModel ?? ""
        toolsAllowDraft = (settings?.toolsAllow ?? []).joined(separator: ", ")
        toolsDenyDraft = (settings?.toolsDeny ?? []).joined(separator: ", ")
        // Record the just-synced values. `applyingSync` alone is timing-fragile — the
        // field `.onChange` handlers fire on a LATER SwiftUI update, after this defer
        // has already cleared it — so a server-driven sync would otherwise schedule a
        // spurious save. scheduleSave compares against this snapshot to ignore the
        // programmatic echo (a real user edit makes the drafts differ from it).
        syncedSnapshot = draftSnapshot()
    }

    /// A value snapshot of the editable drafts, for distinguishing a programmatic
    /// `sync()` echo from a genuine user edit (see `syncedSnapshot`).
    private func draftSnapshot() -> [String] {
        [String(enabled), modelDraft, effort, web, maxUsdDraft, fallbackDraft, toolsAllowDraft, toolsDenyDraft]
    }

    /// AUTO-SAVE entry point fired by every field's `.onChange`/`.onSubmit`. Marks
    /// the row dirty (so server re-syncs can't clobber the edit) and schedules a
    /// debounced save. `immediate` (discrete controls: toggle/picker, or Enter)
    /// shortens the wait to ~0 so the change feels instant. A programmatic draft
    /// write from `sync()` (applyingSync) is ignored — it is not a user edit.
    private func scheduleSave(immediate: Bool = false) {
        if applyingSync { return }
        // A `.onChange` whose drafts still equal the last server sync is a programmatic
        // echo (sync()'s writes firing onChange a cycle late), not a user edit — don't
        // POST it. A genuine edit makes at least one draft differ from the snapshot.
        if draftSnapshot() == syncedSnapshot { return }
        dirty = true
        status = .editing
        // Bump the edit generation so an IN-FLIGHT save loop knows newer drafts
        // exist and must re-POST them (and must not settle on the stale ones).
        saveGen &+= 1
        debounce?.cancel()
        debounce = Task { @MainActor in
            if !immediate {
                try? await Task.sleep(nanoseconds: Self.debounceMs * 1_000_000)
            }
            if Task.isCancelled { return }
            await performSave()
        }
    }

    /// Persist the current drafts, SERIALIZED: at most one POST is ever in flight for
    /// this row. If a save loop is already running, return — it will pick up the
    /// latest drafts when its current POST returns. This prevents two overlapping
    /// POSTs from landing out of order and writing a STALE patch to config.yaml
    /// (Finding: gen guard protected the UI dirty state but not the HTTP write order).
    ///
    /// The loop re-POSTs whenever `saveGen` advanced during a POST (a newer edit
    /// arrived), so the LAST write always carries the newest drafts. It settles
    /// (clears `dirty`, flashes "Saved ✓") only when no newer edit raced in — the
    /// post-save server re-sync (`sync()`) is a no-op while dirty, so nothing reverts.
    private func performSave() async {
        if saving { return }            // single-flight: a loop is already persisting
        saving = true
        status = .saving
        defer { saving = false }
        while true {
            guard maxUsdValid else { status = .editing; return }   // bad cap: don't POST
            let gen = saveGen
            // Staged-field patch mapping lives in Kit (buildHarnessPatch) so it's tested.
            let patch = buildHarnessPatch(
                enabled: enabled,
                modelDraft: modelDraft,
                effort: effort,
                web: web,
                maxUsdDraft: maxUsdDraft,
                toolsAllowDraft: toolsAllowDraft,
                toolsDenyDraft: toolsDenyDraft,
                fallbackDraft: fallbackDraft,
                // Truth-less harness: the model field is read-only ("default
                // only"), so a stored legacy value must not ride along with
                // other saves (it would 400 the whole patch); clears still go.
                modelEditable: models?.canEnumerate == true
            )
            let ok = await model.saveSettings(SettingsUpdateRequest(harnesses: [family.rawValue: patch]))
            if !ok {
                // Surface the failure only if it's still the latest edit (else a newer
                // edit is pending and its own iteration will report). Keep `dirty`.
                if harnessSaveShouldSettle(capturedGen: gen, currentGen: saveGen) {
                    status = .failed(model.settingsStatus ?? "Save failed.")
                }
                return
            }
            if harnessSaveShouldSettle(capturedGen: gen, currentGen: saveGen) {
                // No newer edit landed during the POST → settle.
                dirty = false
                status = .saved
                let stamp = UUID()
                savedStamp = stamp
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if savedStamp == stamp, status == .saved { status = .idle }
                }
                return
            }
            // A newer edit arrived DURING the POST. Loop and persist the LATEST drafts
            // in this SAME single-flight save — never a concurrent POST.
        }
    }

    /// Identifies the latest successful save so a stale auto-clear timer doesn't
    /// wipe a newer "Saved ✓".
    @State private var savedStamp = UUID()
    /// Monotonic edit generation. `scheduleSave` bumps it and captures the value;
    /// `performSave` only clears `dirty`/flashes "Saved ✓" if its captured token is
    /// still the latest — so an edit that lands DURING an in-flight save (which
    /// re-sets `dirty`) is not silently un-guarded by the older save's success
    /// path. The newer edit's own debounced save settles it. Mirrors `savedStamp`.
    @State private var saveGen = 0
}
