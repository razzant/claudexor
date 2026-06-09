import SwiftUI
import AppKit
import ClaudexorKit

// MARK: - Budget cockpit

struct BudgetScreen: View {
    @Environment(AppModel.self) private var model
    @State private var maxUsdPerRun = ""
    @State private var maxUsdPerDay = ""
    private var b: BudgetState { model.budget }
    private var runCapValid: Bool { optionalUsd(maxUsdPerRun) != nil || maxUsdPerRun.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var dayCapValid: Bool { optionalUsd(maxUsdPerDay) != nil || maxUsdPerDay.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        ScreenScaffold(title: "Budget", subtitle: "Spend, leases, and the circuit breaker across your portfolio.") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: Theme.Spacing.md)], spacing: Theme.Spacing.md) {
                Panel { MetricTile(title: "Spend", value: b.spendLabel, caption: "cap \(b.capLabel)", tint: Theme.accent, systemImage: "dollarsign.circle") }
                Panel { MetricTile(title: "Remaining", value: b.remainingLabel, tint: b.spendKnown && b.capKnown ? Theme.status(.succeeded) : .secondary, systemImage: "creditcard") }
                Panel { MetricTile(title: "Circuit breaker", value: b.breakerLabel, tint: b.breakerColor, systemImage: "bolt.shield") }
            }

            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Budget defaults", systemImage: "slider.horizontal.2.square")
                    HStack(spacing: Theme.Spacing.md) {
                        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                            Text("Max USD per run").font(.caption).foregroundStyle(.secondary)
                            TextField("No default", text: $maxUsdPerRun)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.callout, design: .monospaced))
                                .help("Default per-run cap. The New Task composer can override this for a single run.")
                        }
                        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                            Text("Max USD per day").font(.caption).foregroundStyle(.secondary)
                            TextField("No default", text: $maxUsdPerDay)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.callout, design: .monospaced))
                                .help("User-level per-day cap. Empty means no configured day cap.")
                        }
                    }
                    if !runCapValid || !dayCapValid {
                        Label("Use a non-negative USD number, or leave the field empty.", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.status(.failed))
                    }
                    HStack {
                        Button {
                            Task { await saveBudgetDefaults() }
                        } label: {
                            Label("Save budget defaults", systemImage: "checkmark.circle")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accent)
                        .disabled(!runCapValid || !dayCapValid)
                        .help("Save budget defaults to the engine settings.")
                        if let status = model.settingsStatus {
                            Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }

            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Portfolio budget", systemImage: "gauge.with.dots.needle.67percent")
                    MeterBar(fraction: b.fraction, tint: b.fraction > 0.85 ? Theme.status(.failed) : Theme.accent, height: 14)
                    HStack {
                        Text(b.spendKnown && b.capKnown ? "\(Int(b.fraction * 100))% used" : "Usage unknown").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if b.fraction > 0.75 {
                            Label("Approaching cap — leases will throttle", systemImage: "exclamationmark.triangle.fill")
                                .font(.caption).foregroundStyle(Theme.status(.blocked))
                        }
                    }
                }
            }

            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Per-harness spend", systemImage: "chart.pie")
                    let harnesses = HarnessFamily.allCases.filter { b.perHarness[$0] != nil }
                    if harnesses.isEmpty {
                        Text("Per-harness spend is unknown until the engine exposes verified per-harness ledger data.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(harnesses) { family in
                        let v = b.perHarness[family] ?? 0
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                HarnessDot(family: family); Text(family.label).font(.caption.weight(.medium))
                                Spacer()
                                Text(String(format: "$%.4f", v)).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                            }
                            MeterBar(fraction: b.spend > 0 ? v / b.spend : 0, tint: family.color)
                        }
                    }
                }
            }

            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Circuit breaker tiers", systemImage: "bolt.shield")
                    HStack(spacing: Theme.Spacing.sm) { ForEach(0..<4) { breakerTier($0) } }
                    if !b.nativeQuota.isEmpty {
                        ForEach(b.nativeQuota, id: \.self) { quota in
                            Text(quota).font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        Text("Native hourly/weekly quota is unknown until a verified provider signal is available.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text("Pre-call lease reservation + prompt-fingerprint loop detection + recursion caps protect against runaway spend. Quota signals are shown only when verified.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .task {
            await model.refreshSettings()
            syncBudgetDefaults()
        }
        .onChange(of: model.settingsSnapshot) { _, _ in syncBudgetDefaults() }
    }

    private func breakerTier(_ tier: Int) -> some View {
        let labels = ["Healthy", "Watch", "Throttle", "Open"]
        let colors = [Theme.status(.succeeded), Theme.status(.needsReview), Theme.status(.blocked), Theme.status(.failed)]
        let active = tier <= b.breakerTier
        return VStack(spacing: 4) {
            Capsule().fill(active ? colors[tier] : Theme.surfaceRaisedHi).frame(height: 6)
            Text(labels[tier]).font(.caption2).foregroundStyle(active ? colors[tier] : .secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func syncBudgetDefaults() {
        guard let settings = model.settingsSnapshot else { return }
        maxUsdPerRun = settings.budget.maxUsdPerRun.map { String(format: "%.2f", $0) } ?? ""
        maxUsdPerDay = settings.budget.maxUsdPerDay.map { String(format: "%.2f", $0) } ?? ""
    }

    private func saveBudgetDefaults() async {
        guard runCapValid, dayCapValid else { return }
        let clearRun = maxUsdPerRun.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let clearDay = maxUsdPerDay.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let patch = SettingsUpdateRequest(
            maxUsdPerRun: optionalUsd(maxUsdPerRun),
            maxUsdPerDay: optionalUsd(maxUsdPerDay),
            clearMaxUsdPerRun: clearRun,
            clearMaxUsdPerDay: clearDay
        )
        _ = await model.saveSettings(patch)
    }

    private func optionalUsd(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "$", with: "")
        if trimmed.isEmpty { return nil }
        guard let value = Double(trimmed), value >= 0 else { return nil }
        return value
    }
}

// MARK: - Harness Doctor

struct HarnessesScreen: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if model.harnesses.isEmpty {
            EmptyStateView(title: "No harness status yet",
                           message: "Start or reconnect the local engine to load Harness Doctor results.",
                           systemImage: "cpu")
                .glowBackdrop()
        } else {
            ScreenScaffold(title: "Harness Doctor", subtitle: "No privileged harness. Roles are intents; a degraded adapter is gated out of roles it can't play.") {
                ForEach(model.harnesses) { HarnessRow(info: $0) }
            }
        }
    }
}

private struct HarnessRow: View {
    @Environment(AppModel.self) private var model
    let info: HarnessInfo
    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.md) {
                    ZStack {
                        Circle().fill(info.family.color.opacity(0.16)).frame(width: 38, height: 38)
                        HarnessLogo(family: info.family, size: 20)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(info.family.label).font(.callout.weight(.semibold))
                        Text(info.version).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Label(info.health.rawValue.capitalized, systemImage: info.health.glyph)
                        .font(.caption.weight(.medium)).foregroundStyle(info.health.color)
                        .padding(.horizontal, Theme.Spacing.md).padding(.vertical, Theme.Spacing.xs)
                        .background(info.health.color.opacity(0.14), in: Capsule())
                }
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "key").imageScale(.small).foregroundStyle(.secondary)
                    Text(info.auth).font(.caption).foregroundStyle(.secondary)
                }
                if info.health != .ok {
                    FlowLayout(spacing: Theme.Spacing.sm) {
                        Button { model.authSheetHarness = info.family } label: {
                            Label("Setup", systemImage: "person.crop.circle.badge.checkmark")
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.accent)
                        .help("Open setup/auth actions for \(info.family.label).")
                        Button { NativeSetup.copy("claudexor ask \"2+2?\" --harness \(info.family.rawValue)") } label: {
                            Label("Copy Smoke", systemImage: "checkmark.seal")
                        }
                        .buttonStyle(.bordered)
                        .help("Copy a minimal smoke-test command for this harness.")
                        Button { Task { await model.refreshHarnesses() } } label: {
                            Label("Recheck", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.bordered)
                        .help("Refresh install/auth/capability status after setup.")
                    }
                }
                if !info.intents.isEmpty {
                    FlowLayout(spacing: Theme.Spacing.xs) {
                        ForEach(info.intents, id: \.self) { intent in
                            Text(intent).font(.caption2)
                                .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, 2)
                                .background(Theme.surfaceRaisedHi, in: Capsule()).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Settings

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var projectRootDraft = ""
    @State private var defaultPortfolio = "subscription-first"
    @State private var routingPolicy = "auto"
    @State private var primaryHarness = "__none"
    @State private var defaultModel = ""
    @State private var envInheritance = "mirror_native"
    @State private var eligibleHarnesses: Set<HarnessFamily> = []
    @State private var maxUsdPerRun = ""
    @State private var maxUsdPerDay = ""
    @AppStorage("claudexor.reducedVisualEffects") private var reducedVisualEffects = false
    private var runCapValid: Bool { parseOptionalDouble(maxUsdPerRun) != nil || maxUsdPerRun.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var dayCapValid: Bool { parseOptionalDouble(maxUsdPerDay) != nil || maxUsdPerDay.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                ScreenHeader(title: "Settings", subtitle: "Preferences, defaults, auth, secrets, and delivery policy.")
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
                settingsGroup("Appearance", "paintpalette") {
                    Picker("Theme", selection: $model.appearance) {
                        ForEach(AppearanceMode.allCases) { Label($0.label, systemImage: $0.glyph).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Toggle(isOn: $reducedVisualEffects) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Reduce ambient glow motion").font(.callout)
                            Text("Keeps the Liquid Glass/chrome style but freezes and softens the mesh backdrop.")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.switch).tint(Theme.accent)
                    Text("Liquid Glass stays on navigation/chrome; dense content uses opaque surfaces for contrast.")
                        .font(.caption).foregroundStyle(.secondary)
                }
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
                            model.projectRoot = projectRootDraft.trimmingCharacters(in: .whitespacesAndNewlines)
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
                        Text("Profile only").tag("profile_only")
                    }
                    .help("mirror_native reuses native CLI auth/session context by default.")
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
                settingsGroup("Harness Doctor & Auth", "cpu") {
                    Text("Claudexor mirrors native harness auth first, with API-key fallback through stored secret refs.")
                        .font(.caption).foregroundStyle(.secondary)
                    KeyValueRow(key: "Control API", value: model.endpoint.isEmpty ? "—" : "http://\(model.endpoint)", mono: true)
                    ForEach(HarnessFamily.allCases.filter { $0 != .fake && $0 != .raw }) { family in
                        nativeAuthRow(family)
                    }
                }
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
                settingsGroup("Budget", "dollarsign.circle") {
                    HStack(spacing: Theme.Spacing.md) {
                        TextField("Max USD per run", text: $maxUsdPerRun)
                            .textFieldStyle(.roundedBorder)
                            .help("Default cap for runs. Composer per-run cap can still override it.")
                        TextField("Max USD per day", text: $maxUsdPerDay)
                            .textFieldStyle(.roundedBorder)
                            .help("User-level per-day budget cap. Empty means no configured cap.")
                    }
                    if !runCapValid || !dayCapValid {
                        Label("Use a non-negative USD number, or leave the field empty.", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.status(.failed))
                    }
                    Button { Task { await saveEngineDefaults() } } label: { Label("Save budget defaults", systemImage: "checkmark.circle") }
                        .buttonStyle(.bordered)
                        .disabled(!runCapValid || !dayCapValid)
                        .help("Save validated budget defaults. Empty fields clear the corresponding cap.")
                    KeyValueRow(key: "Circuit breaker", value: "Operations -> Budget")
                }
                settingsGroup("Advanced & About", "info.circle") {
                    KeyValueRow(key: "App", value: "Claudexor for macOS")
                    KeyValueRow(key: "Version", value: "v0.6.0 beta")
                    KeyValueRow(key: "Engine", value: "@claudexor/control-api (loopback HTTP+SSE)")
                    KeyValueRow(key: "Review protocol", value: "Solid grid queue; apply/check server endpoints only")
                    KeyValueRow(key: "Delivery protocol", value: "Inspect artifacts, dry-run before mutation")
                    KeyValueRow(key: "Public architecture", value: "CLAUDEXOR_BIBLE.md + docs/ARCHITECTURE.md", mono: true)
                }
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.top, Theme.Spacing.xxxl)
            .padding(.bottom, Theme.Spacing.xl)
            .frame(maxWidth: Theme.Layout.readableMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.surfaceBase)
        .task { await refreshAll() }
        .onAppear { syncFromModel() }
        .onChange(of: model.settingsSnapshot) { _, _ in syncFromModel() }
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
            model.projectRoot = url.path
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
        defaultModel = s.routing.defaultModel ?? ""
        envInheritance = s.routing.envInheritance
        eligibleHarnesses = Set(s.routing.eligibleHarnesses.compactMap { HarnessFamily(rawValue: $0) })
        maxUsdPerRun = s.budget.maxUsdPerRun.map { String(format: "%.2f", $0) } ?? ""
        maxUsdPerDay = s.budget.maxUsdPerDay.map { String(format: "%.2f", $0) } ?? ""
    }

    private func saveEngineDefaults() async {
        guard runCapValid && dayCapValid else {
            model.settingsStatus = "Budget defaults were not saved: enter non-negative USD numbers or leave fields empty."
            return
        }
        let runCap = parseOptionalDouble(maxUsdPerRun)
        let dayCap = parseOptionalDouble(maxUsdPerDay)
        let clearRunCap = maxUsdPerRun.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let clearDayCap = maxUsdPerDay.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let patch = SettingsUpdateRequest(
            defaultPortfolio: defaultPortfolio,
            routingPolicy: routingPolicy,
            primaryHarness: primaryHarness,
            defaultModel: defaultModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "__none" : defaultModel,
            eligibleHarnesses: eligibleHarnesses.map(\.rawValue).sorted(),
            envInheritance: envInheritance,
            maxUsdPerRun: runCap,
            maxUsdPerDay: dayCap,
            clearMaxUsdPerRun: clearRunCap,
            clearMaxUsdPerDay: clearDayCap
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
