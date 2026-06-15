import SwiftUI
import AppKit
import ClaudexorKit

// MARK: - Settings

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var defaultPortfolio = "subscription-first"
    @State private var routingPolicy = "auto"
    @State private var primaryHarness = "__none"
    @State private var authPreference = "auto"
    @State private var defaultModel = ""
    @State private var envInheritance = "mirror_native"
    @State private var eligibleHarnesses: Set<HarnessFamily> = []
    @State private var maxUsdPerRun = ""
    @State private var interactionTimeoutMinutes = ""
    private var runCapValid: Bool { parseOptionalDouble(maxUsdPerRun) != nil || maxUsdPerRun.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var interactionTimeoutValid: Bool {
        let trimmed = interactionTimeoutMinutes.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        return (Int(trimmed) ?? 0) > 0
    }

    var body: some View {
        TabView {
            settingsTab { generalGroup; advancedGroup }
                .tabItem { Label("General", systemImage: "gearshape") }
            settingsTab { routingGroup }
                .tabItem { Label("Routing", systemImage: "point.3.connected.trianglepath.dotted") }
            settingsTab { harnessDoctorGroup; perHarnessGroup }
                .tabItem { Label("Harnesses", systemImage: "cpu") }
            settingsTab { budgetGroup; interactiveGroup }
                .tabItem { Label("Budget", systemImage: "dollarsign.circle") }
            settingsTab { secretsGroup }
                .tabItem { Label("Secrets", systemImage: "key") }
            settingsTab { appearanceGroup }
                .tabItem { Label("Appearance", systemImage: "paintpalette") }
        }
        .frame(minWidth: 720, minHeight: 600)
        .task { await refreshAll() }
        .onAppear { syncFromModel() }
        .onChange(of: model.settingsSnapshot) { _, _ in syncFromModel() }
    }

    /// Standard scrolling container for one settings tab (matte glass backdrop,
    /// readable column). Each tab supplies its `settingsGroup(...)` sections.
    private func settingsTab<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                content()
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.vertical, Theme.Spacing.xl)
            .frame(maxWidth: Theme.Layout.readableMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.surfaceBase)
    }

    @ViewBuilder private var generalGroup: some View {
        @Bindable var model = model
        settingsGroup("General", "gearshape") {
                    Toggle(isOn: $model.demoMode) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Show sample data").font(.callout)
                            Text("Preview empty surfaces without mixing mock rows into live state unless this is on.")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.switch).tint(Theme.accent)
                    KeyValueRow(key: "Engine status", value: model.health.label, valueColor: model.health == .connected ? Theme.status(.succeeded) : .secondary)
                    HStack {
                        Button { Task { await model.connect() } } label: { Label("Reconnect", systemImage: "arrow.clockwise") }.buttonStyle(.bordered)
                        Button { Task { await refreshAll() } } label: { Label("Refresh metadata", systemImage: "arrow.triangle.2.circlepath") }.buttonStyle(.bordered)
                    }
                }
    }

    @ViewBuilder private var appearanceGroup: some View {
        @Bindable var model = model
        settingsGroup("Appearance", "paintpalette") {
                    Picker("Theme", selection: $model.appearance) {
                        ForEach(AppearanceMode.allCases) { Label($0.label, systemImage: $0.glyph).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Text("The window is matte glass — the desktop shows faintly through it. Code and diffs stay on a solid surface for contrast. Reduce Transparency falls back to a solid backdrop.")
                        .font(.caption).foregroundStyle(.secondary)
                }
    }

    @ViewBuilder private var routingGroup: some View {
        settingsGroup("Agent & Routing", "point.3.connected.trianglepath.dotted") {
                    Picker("Default portfolio", selection: $defaultPortfolio) {
                        Text("Subscription-first").tag("subscription-first")
                        Text("Balanced").tag("balanced")
                        Text("Cheapest").tag("cheapest")
                        Text("Strongest").tag("strongest")
                        Text("API overflow").tag("api-overflow")
                    }
                    .help("Portfolio is a routing/budget policy, not a mode.")
                    Picker("Routing policy", selection: $routingPolicy) {
                        Text("Auto").tag("auto")
                        Text("Primary").tag("primary")
                        Text("Portfolio").tag("portfolio")
                    }
                    .help("Auto lets the route selector choose from the eligible pool. Primary biases a single harness.")
                    Picker("Primary harness", selection: $primaryHarness) {
                        Text("None").tag("__none")
                        ForEach(HarnessFamily.allCases.filter { $0 != .fake && $0 != .raw }) { family in
                            Label(family.label, systemImage: family.glyph).tag(family.rawValue)
                        }
                    }
                    .help("Primary is a bias, not a hardcoded semantic role.")
                    TextField("Default model hint", text: $defaultModel)
                        .textFieldStyle(.roundedBorder)
                        .help("Optional model hint forwarded to compatible harnesses. Leave empty for each harness default.")
                    Picker("Env inheritance", selection: $envInheritance) {
                        Text("Mirror native").tag("mirror_native")
                        Text("Clean").tag("clean")
                    }
                    .help("mirror_native reuses native CLI auth/session context by default.")
                    Picker("Auth route", selection: $authPreference) {
                        Text("Auto (subscription first)").tag("auto")
                        Text("Subscription").tag("subscription")
                        Text("API key").tag("api_key")
                    }
                    .help("Which credential route harness runs prefer. Auto seeds the native subscription session and falls back to a stored API key; an explicit route discloses any fallback in the run events.")
                    FlowLayout(spacing: Theme.Spacing.sm) {
                        ForEach(HarnessFamily.allCases.filter { $0 != .fake && $0 != .raw }) { family in
                            FilterChip(label: family.label, systemImage: family.glyph,
                                       isActive: eligibleHarnesses.contains(family), tint: family.color) {
                                if eligibleHarnesses.contains(family) { eligibleHarnesses.remove(family) }
                                else { eligibleHarnesses.insert(family) }
                            }
                            .help("Default eligible pool. Empty means auto-discover available harnesses.")
                        }
                    }
                    HStack {
                        Button { Task { await saveEngineDefaults() } } label: { Label("Save engine defaults", systemImage: "checkmark.circle") }
                            .buttonStyle(.borderedProminent).tint(Theme.accent)
                        if let status = model.settingsStatus {
                            Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
    }

    @ViewBuilder private var harnessDoctorGroup: some View {
        settingsGroup("Harness Doctor & Auth", "cpu") {
                    Text("Claudexor mirrors native harness auth first, with API-key fallback through stored secret refs.")
                        .font(.caption).foregroundStyle(.secondary)
                    KeyValueRow(key: "Control API", value: model.endpoint.isEmpty ? "—" : "http://\(model.endpoint)", mono: true)
                    ForEach(HarnessFamily.allCases.filter { $0 != .fake && $0 != .raw }) { family in
                        nativeAuthRow(family)
                    }
                }
    }

    @ViewBuilder private var secretsGroup: some View {
        settingsGroup("Secrets", "key") {
                    Text("Secret values live in Keychain or a 0600 store. Run params and artifacts store refs/metadata only.")
                        .font(.caption).foregroundStyle(.secondary)
                    KeyValueRow(key: "Secret backend", value: model.secretBackend)
                    if !model.storedSecrets.isEmpty {
                        FlowLayout(spacing: Theme.Spacing.xs) {
                            ForEach(model.storedSecrets) { secret in
                                Text("\(secret.name) · \(secret.backend)")
                                    .font(.caption2)
                                    .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, 2)
                                    .background(Theme.surfaceRaisedHi, in: Capsule())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    FlowLayout(spacing: Theme.Spacing.sm) {
                        ForEach(HarnessFamily.allCases.filter { $0 != .fake }) { family in
                            Button { model.authSheetHarness = family } label: {
                                Label("Open \(family.label) Auth", systemImage: family.glyph)
                            }
                            .buttonStyle(.bordered)
                            .help("Store fallback refs and run setup jobs in the shared \(family.label) Auth sheet.")
                        }
                    }
                }
    }

    @ViewBuilder private var perHarnessGroup: some View {
        settingsGroup("Per-Harness Defaults", "slider.horizontal.3") {
                    Text("Engine-level defaults per harness: enable/disable, model override, effort, and web policy. Stored in ~/.claudexor/config.yaml.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(HarnessFamily.allCases.filter { $0 != .fake && $0 != .raw }) { family in
                        HarnessDefaultsRow(family: family,
                                           settings: model.settingsSnapshot?.harnesses?[family.rawValue])
                    }
                }
    }

    @ViewBuilder private var budgetGroup: some View {
        settingsGroup("Budget", "dollarsign.circle") {
                    HStack(spacing: Theme.Spacing.md) {
                        TextField("Max USD per run", text: $maxUsdPerRun)
                            .textFieldStyle(.roundedBorder)
                            .help("Default cap for runs. Composer per-run cap can still override it.")
                    }
                    if !runCapValid {
                        Label("Use a non-negative USD number, or leave the field empty.", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.status(.failed))
                    }
                    Button { Task { await saveEngineDefaults() } } label: { Label("Save budget defaults", systemImage: "checkmark.circle") }
                        .buttonStyle(.bordered)
                        .disabled(!runCapValid)
                        .help("Save validated budget defaults. Empty fields clear the corresponding cap.")
                    KeyValueRow(key: "Circuit breaker", value: "Per-run cap above")
                }
    }

    @ViewBuilder private var interactiveGroup: some View {
        settingsGroup("Interactive questions", "questionmark.bubble") {
                    HStack(spacing: Theme.Spacing.md) {
                        TextField("Answer timeout (minutes)", text: $interactionTimeoutMinutes)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 220)
                            .help("How long a run waits for your answer to a harness question before continuing with assumptions. Empty keeps the engine default (15 minutes).")
                        Button { Task { await saveInteractionTimeout() } } label: { Label("Save", systemImage: "checkmark.circle") }
                            .buttonStyle(.bordered)
                            .disabled(!interactionTimeoutValid)
                    }
                    if !interactionTimeoutValid {
                        Label("Use a positive whole number of minutes, or leave the field empty.", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.status(.failed))
                    }
                }
    }

    @ViewBuilder private var advancedGroup: some View {
        settingsGroup("Advanced & About", "info.circle") {
                    KeyValueRow(key: "App", value: "Claudexor for macOS")
                    // Single source: the bundle version stamped at packaging time
                    // (a hardcoded string here shipped stale in the past).
                    KeyValueRow(key: "Version", value: "v\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev") beta")
                    KeyValueRow(key: "Engine", value: "@claudexor/control-api (loopback HTTP+SSE)")
                    KeyValueRow(key: "Review protocol", value: "Inline per-turn review; server-owned decision/apply endpoints")
                    KeyValueRow(key: "Delivery protocol", value: "Inspect artifacts, dry-run before mutation")
                    KeyValueRow(key: "Public architecture", value: "CLAUDEXOR_BIBLE.md + docs/ARCHITECTURE.md", mono: true)
                }
    }

    private func settingsGroup<Content: View>(_ title: String, _ systemImage: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(title, systemImage: systemImage)
            content()
        }
        .padding(Theme.Spacing.lg)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.separator, lineWidth: 1))
    }

    private func nativeAuthRow(_ family: HarnessFamily) -> some View {
        let info = model.harnessInfo(for: family)
        let health = info?.health ?? .unavailable
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                HarnessChip(family: family, selected: true, available: info?.health == .ok)
                Text(info?.auth ?? "Harness Doctor has not loaded this harness.")
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: Theme.Spacing.md)
                Label(health.rawValue.capitalized, systemImage: health.glyph)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(health.color)
                    .padding(.horizontal, Theme.Spacing.sm)
                    .padding(.vertical, Theme.Spacing.xxs)
                    .background(health.color.opacity(0.14), in: Capsule())
            }
            FlowLayout(spacing: Theme.Spacing.sm) {
                Button { model.authSheetHarness = family } label: {
                    Label(health == .ok ? "Manage" : "Setup", systemImage: health == .ok ? "slider.horizontal.3" : "person.crop.circle.badge.checkmark")
                }
                .buttonStyle(.bordered).tint(Theme.accent)
                .help(health == .ok ? "Open \(family.label) auth details and fallback key management." : "Open setup/auth actions for \(family.label).")
                Button { Task { await model.refreshHarnesses() } } label: {
                    Label("Recheck", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help("Refresh install/auth/capability status after setup.")
            }
        }
    }

    private func refreshAll() async {
        await model.refreshSettings()
        await model.refreshSecrets()
        await model.refreshHarnesses()
        syncFromModel()
    }

    private func syncFromModel() {
        guard let s = model.settingsSnapshot else { return }
        defaultPortfolio = s.defaultPortfolio
        routingPolicy = s.routing.defaultPolicy
        primaryHarness = s.routing.primaryHarness ?? "__none"
        authPreference = s.routing.authPreference ?? "auto"
        defaultModel = s.routing.defaultModel ?? ""
        envInheritance = s.routing.envInheritance
        eligibleHarnesses = Set(s.routing.eligibleHarnesses.compactMap { HarnessFamily(rawValue: $0) })
        maxUsdPerRun = s.budget.maxUsdPerRun.map { String(format: "%.2f", $0) } ?? ""
        interactionTimeoutMinutes = s.interactionTimeoutMs.map { String(max(1, $0 / 60_000)) } ?? ""
    }

    private func saveInteractionTimeout() async {
        let trimmed = interactionTimeoutMinutes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard interactionTimeoutValid, !trimmed.isEmpty, let minutes = Int(trimmed) else { return }
        _ = await model.saveSettings(SettingsUpdateRequest(interactionTimeoutMs: minutes * 60_000))
    }

    private func saveEngineDefaults() async {
        guard runCapValid else {
            model.settingsStatus = "Budget defaults were not saved: enter non-negative USD numbers or leave fields empty."
            return
        }
        let runCap = parseOptionalDouble(maxUsdPerRun)
        let clearRunCap = maxUsdPerRun.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let patch = SettingsUpdateRequest(
            defaultPortfolio: defaultPortfolio,
            routingPolicy: routingPolicy,
            primaryHarness: primaryHarness,
            defaultModel: defaultModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "__none" : defaultModel,
            eligibleHarnesses: eligibleHarnesses.map(\.rawValue).sorted(),
            envInheritance: envInheritance,
            authPreference: authPreference,
            maxUsdPerRun: runCap,
            clearMaxUsdPerRun: clearRunCap
        )
        _ = await model.saveSettings(patch)
    }

    private func parseOptionalDouble(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "$", with: "")
        if trimmed.isEmpty { return nil }
        guard let value = Double(trimmed), value >= 0 else { return nil }
        return value
    }
}

/// One harness's engine defaults (enabled / model / effort / web), saved as a
/// partial patch so untouched fields keep their stored values.
// @MainActor: this View's helpers (`performSave`, `scheduleSave`, `sync`,
// `flushPendingSave`, `loadModels`) read/mutate `@State`. View methods are NOT
// implicitly main-actor-isolated, so an async/detached Task running one of them
// could mutate SwiftUI `@State` off the main actor (a threading violation under
// strict concurrency). Annotating the struct pins every helper — and the
// `Task { @MainActor in … }` closures that call them — to the main actor.
@MainActor
private struct HarnessDefaultsRow: View {
    @Environment(AppModel.self) private var model
    let family: HarnessFamily
    let settings: HarnessSettings?
    @State private var enabled = true
    @State private var modelDraft = ""
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

    /// Enumerated models for this harness (ADP4). nil = not yet loaded; an empty
    /// list or a response that cannot enumerate falls back to the free-text field.
    @State private var models: HarnessModelsResponse?
    @State private var loadingModels = false

    private static let efforts = ["__default", "low", "medium", "high", "xhigh", "max"]

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
                modelOverrideField
                Picker("Effort", selection: $effort) {
                    Text("Default").tag("__default")
                    ForEach(Self.efforts.dropFirst(), id: \.self) { Text($0).tag($0) }
                }
                .fixedSize()
                .help("Reasoning effort hint, where the harness supports one.")
                .onChange(of: effort) { _, _ in scheduleSave(immediate: true) }
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
        .task { await loadModels() }
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

    /// Model override: a Picker over enumerated model ids+labels when the harness
    /// can honestly enumerate, with an HONEST fallback to free text otherwise
    /// (empty list / source "none" / engine offline) so the user can still type.
    @ViewBuilder private var modelOverrideField: some View {
        if let models, models.canEnumerate {
            Picker("Model override", selection: $modelDraft) {
                Text("Harness default").tag("")
                // Preserve a stored override that the enumeration doesn't list
                // (custom/legacy model) instead of silently dropping it on save.
                if !modelDraft.isEmpty, !models.models.contains(where: { $0.id == modelDraft }) {
                    Text("\(modelDraft) (custom)").tag(modelDraft)
                }
                ForEach(models.models) { m in
                    Text(modelMenuLabel(m)).tag(m.id)
                }
            }
            .labelsHidden()
            .help("Model forwarded to \(family.label) (source: \(models.source)). Harness default keeps the engine choice.")
        } else {
            TextField("Model override", text: $modelDraft)
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
                .help(modelFallbackHelp)
        }
    }

    private func modelMenuLabel(_ m: HarnessModel) -> String {
        let name = (m.label.map { $0.isEmpty ? m.id : $0 } ?? m.id)
        let suffix = name == m.id ? "" : " (\(m.id))"
        return name + suffix
    }

    private var modelFallbackHelp: String {
        if loadingModels { return "Loading \(family.label) models…" }
        if models?.source == "none" {
            return "\(family.label) cannot enumerate models — type a model id, or leave empty for the harness default."
        }
        return "Optional model forwarded to \(family.label). Empty keeps the harness default."
    }

    /// One-shot enumeration; thin consumer of the control-api DTO. A nil result
    /// (offline/failed) leaves `models` nil so the free-text fallback renders.
    private func loadModels() async {
        guard models == nil, !loadingModels else { return }
        loadingModels = true
        defer { loadingModels = false }
        models = await model.harnessModels(for: family)
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
                fallbackDraft: fallbackDraft
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
