import SwiftUI
import AppKit
import ClaudexorKit

// MARK: - Settings

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var routingGoal = "auto"
    @State private var paidFallback = "when_unavailable"
    @State private var primaryHarness = "__none"
    @State private var authPreference = "auto"
    @State private var envInheritance = "mirror_native"
    @State private var eligibleHarnesses: Set<HarnessFamily> = []
    @State private var maxUsdPerRun = ""
    @State private var budgetUnlimited = true
    @State private var interactionTimeoutMinutes = ""
    @State private var engineDraftsDirty = false
    @State private var syncedSnapshot: [String] = []
    private var runCapValid: Bool { budgetUnlimited || ComposerOptionParser.parseNonnegativeFiniteDouble(maxUsdPerRun) != nil }
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
            settingsTab { secretsGroup; TrustSettingsSection() }
                .tabItem { Label("Secrets", systemImage: "key") }
            settingsTab { appearanceGroup }
                .tabItem { Label("Appearance", systemImage: "paintpalette") }
        }
        .frame(minWidth: 720, minHeight: 600)
        .task { await refreshAll() }
        .onAppear { syncFromModel() }
        .onChange(of: model.settingsSnapshot) { _, _ in syncFromModel() }
        .onChange(of: routingGoal) { _, _ in markEngineDraftsEdited() }
        .onChange(of: paidFallback) { _, _ in markEngineDraftsEdited() }
        .onChange(of: primaryHarness) { _, _ in markEngineDraftsEdited() }
        .onChange(of: authPreference) { _, _ in markEngineDraftsEdited() }
        .onChange(of: envInheritance) { _, _ in markEngineDraftsEdited() }
        .onChange(of: eligibleHarnesses) { _, _ in markEngineDraftsEdited() }
        .onChange(of: maxUsdPerRun) { _, _ in markEngineDraftsEdited() }
        .onChange(of: budgetUnlimited) { _, _ in markEngineDraftsEdited() }
        .onChange(of: interactionTimeoutMinutes) { _, _ in markEngineDraftsEdited() }
    }

    private var draftSnapshot: [String] {
        [routingGoal, paidFallback, primaryHarness, authPreference, envInheritance,
         eligibleHarnesses.map(\.rawValue).sorted().joined(separator: ","),
         budgetUnlimited ? "unlimited" : "finite", maxUsdPerRun, interactionTimeoutMinutes]
    }

    private func markEngineDraftsEdited() {
        if draftSnapshot != syncedSnapshot { engineDraftsDirty = true }
    }

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
                    KeyValueRow(key: "Engine status", value: model.health.label, valueColor: model.health == .connected ? Theme.status(.positive) : .secondary)
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
                    Picker("Routing goal", selection: $routingGoal) {
                        Text("Auto").tag("auto")
                        Text("Quality").tag("quality")
                        Text("Economy").tag("economy")
                    }
                    .help("Auto paces expiring quota, Quality uses your highest comparable tier, and Economy minimizes incremental paid spend.")
                    Picker("Paid fallback", selection: $paidFallback) {
                        Text("Never").tag("never")
                        Text("When unavailable").tag("when_unavailable")
                        Text("Allowed within cap").tag("allowed_within_cap")
                    }
                    .help("Controls whether routing may leave subscription or proven-zero routes.")
                    KeyValueRow(
                        key: "Quality tiers",
                        value: "\(model.settingsSnapshot?.routing.qualityTiers.values.reduce(0) { $0 + $1.count } ?? 0) configured"
                    )
                    Picker("Primary harness", selection: $primaryHarness) {
                        Text("None").tag("__none")
                        ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
                            Label(family.label, systemImage: family.glyph).tag(family.rawValue)
                        }
                    }
                    .help("Primary is a bias, not a hardcoded semantic role.")
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
                        ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
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
                    ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
                        nativeAuthRow(family)
                    }
                }
    }

    @ViewBuilder private var secretsGroup: some View {
        settingsGroup("Secrets", "key") {
                    Text("Secret values live in the v2 0600 file store. Run params and artifacts store refs/metadata only.")
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
                        ForEach(model.selectableHarnesses) { family in
                            Button { model.authSheetTarget = AuthSheetTarget(family: family) } label: {
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
                    Text("Engine-level defaults per harness: enable/disable, model override, effort, and web policy. Stored in ~/.claudexor/v2/config.yaml.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
                        HarnessDefaultsRow(family: family,
                                           settings: model.settingsSnapshot?.harnesses?[family.rawValue])
                    }
                }
    }

    @ViewBuilder private var budgetGroup: some View {
        settingsGroup("Budget", "dollarsign.circle") {
                    Toggle("Unlimited paid budget", isOn: $budgetUnlimited)
                        .toggleStyle(.switch)
                        .tint(Theme.accent)
                        .help("Unlimited still records exact or estimated spend; it removes only the paid cap.")
                    HStack(spacing: Theme.Spacing.md) {
                        TextField("Max USD per run", text: $maxUsdPerRun)
                            .textFieldStyle(.roundedBorder)
                            .disabled(budgetUnlimited)
                            .help("Finite paid cap. Zero admits only proven-zero or subscription-entitlement routes.")
                    }
                    if !runCapValid {
                        Label("Use a non-negative USD number for a finite budget.", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.status(.negative))
                    }
                    Button { Task { await saveEngineDefaults() } } label: { Label("Save budget defaults", systemImage: "checkmark.circle") }
                        .buttonStyle(.bordered)
                        .disabled(!runCapValid)
                        .help("Save the explicit unlimited or finite paid-budget contract.")
                    QuotaDetailView()
                        .frame(minHeight: 260)
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
                            .foregroundStyle(Theme.status(.negative))
                    }
                }
    }

    @ViewBuilder private var advancedGroup: some View {
        settingsGroup("Advanced & About", "info.circle") {
                    KeyValueRow(key: "App", value: "Claudexor for macOS")
                    // Single source: the bundle version stamped at packaging time
                    // (a hardcoded string here shipped stale in the past).
                    KeyValueRow(key: "Version", value: "v\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")")
                    KeyValueRow(key: "Engine", value: "@claudexor/control-api (loopback HTTP+SSE)")
                    KeyValueRow(key: "Review protocol", value: "Inline per-turn review; server-owned decision/apply endpoints")
                    if let runtime = model.settingsSnapshot?.runtime {
                        KeyValueRow(key: "Reviewer timeout", value: "\(max(1, runtime.reviewerTimeoutMs / 60_000)) min")
                        KeyValueRow(key: "Reviewer retries", value: "\(runtime.transientRetry.maxRetries)")
                    }
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

    /// W4.7-UI: the ONE readiness card; Settings passes ITS actions as a slot.
    private func nativeAuthRow(_ family: HarnessFamily) -> some View {
        let presentation = HarnessReadinessPresentation.from(
            family: family, info: model.harnessInfo(for: family))
        return HarnessReadinessCard(presentation: presentation) {
            Button { model.authSheetTarget = AuthSheetTarget(family: family) } label: {
                Label(presentation.available ? "Manage" : "Setup",
                      systemImage: presentation.available ? "slider.horizontal.3" : "person.crop.circle.badge.checkmark")
            }
            .buttonStyle(.bordered).tint(Theme.accent)
            .help(presentation.available ? "Open \(family.label) auth details and fallback key management." : "Open setup/auth actions for \(family.label).")
            Button { Task { await model.refreshHarnesses(fresh: true) } } label: {
                Label("Recheck", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .help("Refresh install/auth/capability status after setup.")
        }
    }

    private func refreshAll() async {
        await model.refreshSettings()
        await model.refreshQuota()
        await model.refreshSecrets()
        await model.refreshHarnesses()
        await model.refreshTrust()
        syncFromModel()
    }

    private func syncFromModel() {
        guard let s = model.settingsSnapshot, !engineDraftsDirty else { return }
        routingGoal = s.routing.goal
        paidFallback = s.routing.paidFallback
        primaryHarness = s.routing.primaryHarness ?? "__none"
        authPreference = s.routing.authPreference ?? "auto"
        envInheritance = s.routing.envInheritance
        eligibleHarnesses = Set(s.routing.eligibleHarnesses.map { HarnessFamily(rawValue: $0) })
        budgetUnlimited = s.budget.paidBudgetPerRun == .unlimited
        maxUsdPerRun = s.budget.paidBudgetPerRun.finiteMaxUsd.map { String(format: "%.2f", $0) } ?? ""
        interactionTimeoutMinutes = s.interactionTimeoutMs.map { String(max(1, $0 / 60_000)) } ?? ""
        syncedSnapshot = draftSnapshot
    }

    private func saveInteractionTimeout() async {
        let trimmed = interactionTimeoutMinutes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard interactionTimeoutValid, !trimmed.isEmpty, let minutes = Int(trimmed) else { return }
        if await model.saveSettings(SettingsUpdateRequest(interactionTimeoutMs: minutes * 60_000)) {
            // PARTIAL save: only the timeout reached the server. Mark just that
            // field as synced and re-derive dirtiness — unsaved routing/budget
            // drafts must survive (a full release here would resync every
            // field from the snapshot and silently discard them).
            if syncedSnapshot.count == draftSnapshot.count, !syncedSnapshot.isEmpty {
                syncedSnapshot[syncedSnapshot.count - 1] = interactionTimeoutMinutes
            }
            engineDraftsDirty = draftSnapshot != syncedSnapshot
            if !engineDraftsDirty { syncFromModel() }
        }
    }

    /// Our settled save releases the drafts back to server sync; a failed save
    /// keeps them dirty so edits survive the next snapshot republish.
    private func releaseDraftsToSync() {
        engineDraftsDirty = false
        syncFromModel()
    }

    private func saveEngineDefaults() async {
        guard runCapValid else {
            model.settingsStatus = "Budget defaults were not saved: enter non-negative USD numbers or leave fields empty."
            return
        }
        let paidBudget: PaidBudget = budgetUnlimited
            ? .unlimited
            : .finite(maxUsd: ComposerOptionParser.parseNonnegativeFiniteDouble(maxUsdPerRun) ?? 0)
        let patch = SettingsUpdateRequest(
            routingGoal: routingGoal,
            paidFallback: paidFallback,
            // Explicit null clears the primary (no "__none" magic string —
            // the server validates ids against the real registry).
            primaryHarness: primaryHarness == "__none" ? .some(nil) : .some(primaryHarness),
            eligibleHarnesses: eligibleHarnesses.map(\.rawValue).sorted(),
            envInheritance: envInheritance,
            authPreference: authPreference,
            paidBudgetPerRun: paidBudget
        )
        if await model.saveSettings(patch) { releaseDraftsToSync() }
    }

}
