import SwiftUI
import AppKit
import ClaudexKit

// MARK: - Budget cockpit

struct BudgetScreen: View {
    @Environment(AppModel.self) private var model
    private var b: BudgetState { model.budget }

    var body: some View {
        ScreenScaffold(title: "Budget", subtitle: "Spend, leases, and the circuit breaker across your portfolio.") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: Theme.Spacing.md)], spacing: Theme.Spacing.md) {
                Panel { MetricTile(title: "Spend", value: String(format: "$%.4f", b.spend), caption: "of $\(String(format: "%.2f", b.cap)) cap", tint: Theme.accent, systemImage: "dollarsign.circle") }
                Panel { MetricTile(title: "Remaining", value: String(format: "$%.4f", max(0, b.cap - b.spend)), tint: Theme.status(.succeeded), systemImage: "creditcard") }
                Panel { MetricTile(title: "Circuit breaker", value: b.breakerLabel, tint: b.breakerColor, systemImage: "bolt.shield") }
            }

            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Portfolio budget", systemImage: "gauge.with.dots.needle.67percent")
                    MeterBar(fraction: b.fraction, tint: b.fraction > 0.85 ? Theme.status(.failed) : Theme.accent, height: 14)
                    HStack {
                        Text("\(Int(b.fraction * 100))% used").font(.caption).foregroundStyle(.secondary)
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
                    ForEach(HarnessFamily.allCases.filter { b.perHarness[$0] != nil }) { family in
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
                    Text("Pre-call lease reservation + prompt-fingerprint loop detection + recursion caps protect against runaway spend. Quota signals are best-effort (honest, not guaranteed).")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
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
                        Button { openInstallGuide(info.family) } label: {
                            Label("Install guide", systemImage: "arrow.down.circle")
                        }
                        .buttonStyle(.bordered)
                        .help("Open the official \(info.family.label) install/login guide. Claudex does not bundle third-party CLIs.")
                        Button { copy(nativeLoginCommand(for: info.family)) } label: {
                            Label("Copy Login", systemImage: "person.crop.circle.badge.checkmark")
                        }
                        .buttonStyle(.bordered)
                        .help("Copy the native login command for \(info.family.label).")
                        Button { model.route = .settings } label: {
                            Label("Use Stored Key", systemImage: "key")
                        }
                        .buttonStyle(.bordered)
                        .help("Open Settings -> Auth & Billing to store or verify API-key fallback refs.")
                        Button { copy("claudex ask \"2+2?\" --harness \(info.family.rawValue)") } label: {
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

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func nativeLoginCommand(for family: HarnessFamily) -> String {
        switch family {
        case .codex: return "codex login && claudex doctor --harness codex"
        case .claude: return "claude /login && claudex doctor --harness claude"
        case .cursor: return "cursor-agent login && claudex doctor --harness cursor"
        case .opencode: return "opencode auth login && claudex doctor --harness opencode"
        case .raw: return "claudex secrets set openai --from-env OPENAI_API_KEY"
        case .fake: return "claudex doctor --all"
        }
    }

    private func openInstallGuide(_ family: HarnessFamily) {
        guard let url = URL(string: installGuideURL(family)) else { return }
        NSWorkspace.shared.open(url)
    }

    private func installGuideURL(_ family: HarnessFamily) -> String {
        switch family {
        case .codex: return "https://developers.openai.com/codex"
        case .claude: return "https://docs.anthropic.com/en/docs/claude-code"
        case .cursor: return "https://docs.cursor.com/cli"
        case .opencode: return "https://opencode.ai/docs"
        case .raw: return "https://platform.openai.com/docs"
        case .fake: return "https://github.com/joi-lab/claudex"
        }
    }
}

// MARK: - Benchmarks

struct BenchmarksScreen: View {
    @Environment(AppModel.self) private var model
    private var suites: [String] { Array(Set(model.benchmarks.map(\.suite))).sorted() }

    var body: some View {
        if suites.isEmpty {
            EmptyStateView(title: "No benchmark runs",
                           message: "Benchmark runs (SWE-bench, Terminal-Bench) aren't streamed over the control-api yet. Enable Sample data in Settings to preview.",
                           systemImage: "chart.bar.xaxis")
                .glowBackdrop()
        } else {
            ScreenScaffold(title: "Benchmarks", subtitle: "SWE-bench Verified first; Terminal-Bench and others scaffolded. Held-out split resists reward hacking.") {
                ForEach(suites, id: \.self) { suite in
                    suiteSection(suite)
                }
            }
        }
    }

    private func suiteSection(_ suite: String) -> some View {
        let runs = model.benchmarks.filter { $0.suite == suite }
        return VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(suite, systemImage: "chart.bar.xaxis", accessory: AnyView(resolvedTag(runs)))
            Panel(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(runs.enumerated()), id: \.element.id) { idx, run in
                        benchRow(run)
                        if idx < runs.count - 1 { Divider().overlay(Theme.hairline).padding(.leading, Theme.Spacing.xl) }
                    }
                }
            }
        }
    }

    private func resolvedTag(_ runs: [BenchmarkRun]) -> some View {
        let resolved = runs.filter { $0.resolved == true }.count
        let total = runs.filter { $0.resolved != nil }.count
        return Text(total > 0 ? "\(resolved)/\(total) resolved" : "running").font(.caption).foregroundStyle(.secondary)
    }

    private func benchRow(_ run: BenchmarkRun) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: run.resolved == true ? "checkmark.circle.fill" : (run.resolved == false ? "xmark.circle" : "circle.dotted"))
                .foregroundStyle(run.resolved == true ? Theme.status(.succeeded) : (run.resolved == false ? Theme.status(.failed) : Theme.status(.running)))
            Text(run.instance).font(.system(.callout, design: .monospaced)).lineLimit(1).truncationMode(.middle)
            Spacer()
            StatusPill(status: run.status, compact: true)
            Text(String(format: "$%.2f", run.costUsd)).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, Theme.Spacing.md).padding(.vertical, Theme.Spacing.sm)
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
    @State private var openAIKey = ""
    @State private var anthropicKey = ""
    @State private var secretStatus: String?
    @State private var copiedCommand: String?
    @AppStorage("claudex.reducedVisualEffects") private var reducedVisualEffects = false

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
                    Text("Project-aware modes require this repo root. Ask can run without a project and stores artifacts in the user-level Claudex store.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: Theme.Spacing.sm) {
                        TextField("Project root", text: $projectRootDraft)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                            .help("Stored in macOS app preferences. Engine config remains in ~/.claudex/config.yaml and .claudex/config.yaml.")
                        Button { chooseProjectRoot() } label: { Label("Choose", systemImage: "folder") }
                            .buttonStyle(.bordered)
                        Button {
                            model.projectRoot = projectRootDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        } label: { Label("Use", systemImage: "checkmark") }
                            .buttonStyle(.borderedProminent).tint(Theme.accent)
                    }
                    Picker("Project context", selection: $model.projectContextMode) {
                        Text("Auto").tag("auto")
                        Text("Deep").tag("deep")
                    }
                    .help("Controls how much repository context the engine should package when a project is selected.")
                    KeyValueRow(key: "Effective project", value: model.projectRoot.isEmpty ? "No project selected" : model.projectRoot, mono: true)
                    KeyValueRow(key: "Project config", value: ".claudex/config.yaml", mono: true)
                }
                settingsGroup("Agent & Routing", "point.3.connected.trianglepath.dotted") {
                    Picker("Default portfolio", selection: $defaultPortfolio) {
                        Text("Subscription-first").tag("subscription-first")
                        Text("Balanced").tag("balanced")
                        Text("Cheapest").tag("cheapest")
                        Text("Strongest").tag("strongest")
                        Text("API overflow").tag("api-overflow")
                        Text("Benchmark").tag("benchmark")
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
                        Button { Task { await saveEngineDefaults() } } label: { Label("Save engine defaults", systemImage: "square.and.arrow.down") }
                            .buttonStyle(.borderedProminent).tint(Theme.accent)
                        if let status = model.settingsStatus {
                            Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                settingsGroup("Harness Doctor & Auth", "cpu") {
                    Text("Claudex mirrors native harness auth first, with API-key fallback through stored secret refs.")
                        .font(.caption).foregroundStyle(.secondary)
                    KeyValueRow(key: "Control API", value: model.endpoint.isEmpty ? "—" : "http://\(model.endpoint)", mono: true)
                    ForEach(HarnessFamily.allCases.filter { $0 != .fake && $0 != .raw }) { family in
                        nativeAuthRow(family)
                    }
                    if let copiedCommand {
                        Text("Copied: \(copiedCommand)").font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
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
                    secretEntry(title: "OpenAI API key", name: "openai", text: $openAIKey)
                    secretEntry(title: "Anthropic API key", name: "anthropic", text: $anthropicKey)
                    if let secretStatus {
                        Text(secretStatus).font(.caption2).foregroundStyle(.secondary)
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
                    Button { Task { await saveEngineDefaults() } } label: { Label("Save budget defaults", systemImage: "square.and.arrow.down") }
                        .buttonStyle(.bordered)
                    KeyValueRow(key: "Circuit breaker", value: "Operations -> Budget")
                }
                settingsGroup("Advanced & About", "info.circle") {
                    KeyValueRow(key: "App", value: "Claudex for macOS")
                    KeyValueRow(key: "Version", value: "v0.4.0 beta")
                    KeyValueRow(key: "Engine", value: "@claudex/control-api (loopback HTTP+SSE)")
                    KeyValueRow(key: "Review protocol", value: "Table-first queue; apply/check server endpoints only")
                    KeyValueRow(key: "Delivery protocol", value: "Inspect artifacts, dry-run before mutation")
                    KeyValueRow(key: "Public architecture", value: "CLAUDEX_BIBLE.md + docs/ARCHITECTURE.md", mono: true)
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

    private func secretEntry(title: String, name: String, text: Binding<String>) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(title)
                .frame(width: 126, alignment: .leading)
                .font(.callout)
            SecureField(title, text: text)
                .textFieldStyle(.roundedBorder)
                .help("Stored as secret ref: \(name). The value is never written into run params or artifacts.")
            Button {
                let value = text.wrappedValue
                Task {
                    let ok = await model.storeSecret(name: name, value: value)
                    await MainActor.run {
                        if ok {
                            text.wrappedValue = ""
                            secretStatus = "Stored secret ref: \(name)"
                        } else {
                            secretStatus = "Could not store \(name); reconnect the local engine and try again."
                        }
                    }
                }
            } label: {
                Label("Store \(title.replacingOccurrences(of: " API key", with: ""))", systemImage: "key.fill")
            }
            .buttonStyle(.bordered)
            .disabled(text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .help("Send this value to the local secret store.")
        }
    }

    private func nativeAuthRow(_ family: HarnessFamily) -> some View {
        let info = model.harnessInfo(for: family)
        let command = nativeLoginCommand(family)
        return HStack(alignment: .center, spacing: Theme.Spacing.sm) {
            HarnessChip(family: family, selected: true, available: info?.health == .ok)
            Text(info?.auth ?? "Harness Doctor has not loaded this harness.")
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer()
            Button { openInstallGuide(family) } label: {
                Label("Install guide", systemImage: "arrow.down.circle")
            }
            .buttonStyle(.bordered)
            .help("Open the official \(family.label) install/login guide.")
            Button {
                copy(command)
            } label: {
                Label("Copy Login", systemImage: "person.crop.circle.badge.checkmark")
            }
            .buttonStyle(.bordered)
            .help("Copy the native login command. Claudex does not broker SaaS OAuth; it reuses each CLI's native login.")
        }
    }

    private func nativeLoginCommand(_ family: HarnessFamily) -> String {
        switch family {
        case .codex: return "codex login && claudex doctor --harness codex"
        case .claude: return "claude /login && claudex doctor --harness claude"
        case .cursor: return "cursor-agent login && claudex doctor --harness cursor"
        case .opencode: return "opencode auth login && claudex doctor --harness opencode"
        case .raw: return "claudex secrets set openai --from-env OPENAI_API_KEY"
        case .fake: return "claudex doctor --all"
        }
    }

    private func openInstallGuide(_ family: HarnessFamily) {
        guard let url = URL(string: installGuideURL(family)) else { return }
        NSWorkspace.shared.open(url)
    }

    private func installGuideURL(_ family: HarnessFamily) -> String {
        switch family {
        case .codex: return "https://developers.openai.com/codex"
        case .claude: return "https://docs.anthropic.com/en/docs/claude-code"
        case .cursor: return "https://docs.cursor.com/cli"
        case .opencode: return "https://opencode.ai/docs"
        case .raw: return "https://platform.openai.com/docs"
        case .fake: return "https://github.com/joi-lab/claudex"
        }
    }

    private func chooseProjectRoot() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use Project"
        if panel.runModal() == .OK, let url = panel.url {
            projectRootDraft = url.path
            model.projectRoot = url.path
        }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copiedCommand = text
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
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        return Double(trimmed)
    }
}
