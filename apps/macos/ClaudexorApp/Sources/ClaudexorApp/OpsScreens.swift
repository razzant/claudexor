import SwiftUI
import AppKit
import ClaudexorKit

// MARK: - Settings

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var projectRootDraft = ""
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
            settingsTab { generalGroup; currentProjectGroup; advancedGroup }
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

    @ViewBuilder private var currentProjectGroup: some View {
        @Bindable var model = model
        settingsGroup("Current Project", "folder") {
                    Text("Project-aware modes require this repo root. Ask can run without a project and stores artifacts in the user-level Claudexor store.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: Theme.Spacing.sm) {
                        TextField("Project root", text: $projectRootDraft)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                            .help("Stored in macOS app preferences. Engine config remains in ~/.claudexor/config.yaml and .claudexor/config.yaml.")
                        Button { chooseProjectRoot() } label: { Label("Choose / Create", systemImage: "folder.badge.plus") }
                            .buttonStyle(.bordered)
                            .help("Choose an existing project folder or create a new empty folder.")
                        Button {
                            // Route through selectProject so the choice also lands in the
                            // composer's recent-projects MRU (not just projectRoot).
                            model.selectProject(projectRootDraft)
                        } label: { Label("Use", systemImage: "checkmark") }
                            .buttonStyle(.borderedProminent).tint(Theme.accent)
                            .help("Use this path as the Current Project for project-aware modes.")
                    }
                    Picker("Project context", selection: $model.projectContextMode) {
                        Text("Auto").tag("auto")
                        Text("Deep").tag("deep")
                    }
                    .help("Controls how much repository context the engine should package when a project is selected.")
                    KeyValueRow(key: "Effective project", value: model.projectRoot.isEmpty ? "No project selected" : model.projectRoot, mono: true)
                    KeyValueRow(key: "Project config", value: ".claudexor/config.yaml", mono: true)
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

    private func chooseProjectRoot() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use Project"
        if panel.runModal() == .OK, let url = panel.url {
            projectRootDraft = url.path
            model.selectProject(url.path)   // also records the MRU for the composer chip
        }
    }

    private func refreshAll() async {
        await model.refreshSettings()
        await model.refreshSecrets()
        await model.refreshHarnesses()
        syncFromModel()
    }

    private func syncFromModel() {
        projectRootDraft = model.projectRoot
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
                Toggle("Enabled", isOn: $enabled)
                    .toggleStyle(.switch).tint(Theme.accent)
                    .labelsHidden()
                    .help("Disabled harnesses are excluded from routing and pools.")
            }
            HStack(spacing: Theme.Spacing.sm) {
                modelOverrideField
                Picker("Effort", selection: $effort) {
                    Text("Default").tag("__default")
                    ForEach(Self.efforts.dropFirst(), id: \.self) { Text($0).tag($0) }
                }
                .fixedSize()
                .help("Reasoning effort hint, where the harness supports one.")
                Picker("Web", selection: $web) {
                    Text("Auto").tag("auto")
                    Text("Off").tag("off")
                    Text("Cached").tag("cached")
                    Text("Live").tag("live")
                }
                .fixedSize()
                .help("Default external web/search policy for this harness.")
            }
            HStack(spacing: Theme.Spacing.sm) {
                HStack(spacing: 4) {
                    Text("$").foregroundStyle(.secondary)
                    TextField("max/run", text: $maxUsdDraft)
                        .frame(width: 64)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                }
                .help("Per-harness USD cap per run. Empty keeps the engine default.")
                TextField("fallback model", text: $fallbackDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .help("Model used if the primary model is unavailable. Empty = none.")
                Button {
                    Task { await save() }
                } label: {
                    Label("Save", systemImage: "checkmark.circle")
                }
                .buttonStyle(.bordered)
                .disabled(saving || !maxUsdValid)
                .help("Save \(family.label) defaults to the engine config.")
            }
            HStack(spacing: Theme.Spacing.sm) {
                TextField("tools allow (comma-separated)", text: $toolsAllowDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .help("Allow-list of tool ids for \(family.label). Empty = harness default.")
                TextField("tools deny (comma-separated)", text: $toolsDenyDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .help("Deny-list of tool ids for \(family.label).")
            }
            if !maxUsdValid {
                Label("Budget cap must be a non-negative number, or empty.", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2).foregroundStyle(Theme.status(.failed))
            }
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.surfaceRaisedHi.opacity(0.5), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .onAppear { sync() }
        .onChange(of: settings) { _, _ in sync() }
        // Lazily enumerate this harness's models when the row first appears.
        .task { await loadModels() }
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

    private func sync() {
        enabled = settings?.enabled ?? true
        modelDraft = settings?.defaultModel ?? ""
        effort = settings?.effort ?? "__default"
        web = settings?.web ?? "auto"
        maxUsdDraft = settings?.maxUsd.map { String(format: "%g", $0) } ?? ""
        fallbackDraft = settings?.fallbackModel ?? ""
        toolsAllowDraft = (settings?.toolsAllow ?? []).joined(separator: ", ")
        toolsDenyDraft = (settings?.toolsDeny ?? []).joined(separator: ", ")
    }

    private func csv(_ s: String) -> [String] {
        s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private func save() async {
        guard maxUsdValid else { return }
        saving = true
        defer { saving = false }
        let trimmedModel = modelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedFallback = fallbackDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let capText = maxUsdDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let patch = HarnessSettingsPatch(
            enabled: enabled,
            defaultModel: .some(trimmedModel.isEmpty ? nil : trimmedModel),
            effort: .some(effort == "__default" ? nil : effort),
            web: web,
            maxUsd: .some(capText.isEmpty ? nil : Double(capText)),
            toolsAllow: csv(toolsAllowDraft),
            toolsDeny: csv(toolsDenyDraft),
            fallbackModel: .some(trimmedFallback.isEmpty ? nil : trimmedFallback)
        )
        _ = await model.saveSettings(SettingsUpdateRequest(harnesses: [family.rawValue: patch]))
    }
}
