import SwiftUI

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
    @State private var openAIKey = ""
    @State private var anthropicKey = ""
    @State private var secretStatus: String?

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
                    Button { Task { await model.connect() } } label: { Label("Reconnect", systemImage: "arrow.clockwise") }.buttonStyle(.bordered)
                }
                settingsGroup("Appearance", "paintpalette") {
                    Picker("Theme", selection: $model.appearance) {
                        ForEach(AppearanceMode.allCases) { Label($0.label, systemImage: $0.glyph).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Text("Liquid Glass stays on navigation/chrome; dense content uses opaque surfaces for contrast.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                settingsGroup("Projects", "folder") {
                    KeyValueRow(key: "Project config", value: ".claudex/config.yaml", mono: true)
                    KeyValueRow(key: "Public docs", value: "README.md, docs/ARCHITECTURE.md, docs/SPEC.md", mono: true)
                    KeyValueRow(key: "Local operator notes", value: "AGENTS.md is local-only")
                }
                settingsGroup("Agent & Routing", "point.3.connected.trianglepath.dotted") {
                    KeyValueRow(key: "Default mode", value: "Ask")
                    KeyValueRow(key: "Agent mode", value: "Single primary-biased direct edit route")
                    KeyValueRow(key: "Default portfolio", value: "subscription-first")
                    KeyValueRow(key: "Eligible pool", value: "Selected harness chips")
                    KeyValueRow(key: "Primary", value: "Bias, not a hardcoded role")
                }
                settingsGroup("Harness Doctor & Auth", "cpu") {
                    Text("Claudex mirrors native harness auth first, with API-key fallback through stored secret refs.")
                        .font(.caption).foregroundStyle(.secondary)
                    KeyValueRow(key: "Control API", value: model.endpoint.isEmpty ? "—" : "http://\(model.endpoint)", mono: true)
                    KeyValueRow(key: "Doctor", value: "Operations -> Harness Doctor")
                }
                settingsGroup("Secrets", "key") {
                    Text("Secret values live in Keychain or a 0600 store. Run params and artifacts store refs/metadata only.")
                        .font(.caption).foregroundStyle(.secondary)
                    secretEntry(title: "OpenAI API key", name: "openai", text: $openAIKey)
                    secretEntry(title: "Anthropic API key", name: "anthropic", text: $anthropicKey)
                    if let secretStatus {
                        Text(secretStatus).font(.caption2).foregroundStyle(.secondary)
                    }
                    KeyValueRow(key: "Loopback bearer", value: "Stored in the local daemon profile")
                    KeyValueRow(key: "Env inheritance", value: "mirror-native")
                }
                settingsGroup("Budget", "dollarsign.circle") {
                    KeyValueRow(key: "Per-run cap", value: "Composer slider / CLI --max-usd")
                    KeyValueRow(key: "Circuit breaker", value: "Operations -> Budget")
                }
                settingsGroup("Review", "person.2.badge.gearshape") {
                    KeyValueRow(key: "Queue", value: "Table-first Review Queue")
                    KeyValueRow(key: "Apply decisions", value: "Server apply/check endpoints only")
                }
                settingsGroup("Delivery", "shippingbox") {
                    KeyValueRow(key: "Inspect", value: "GET /runs/:id + artifacts")
                    KeyValueRow(key: "Apply", value: "Dry-run check before mutation")
                }
                settingsGroup("Advanced & About", "info.circle") {
                    KeyValueRow(key: "App", value: "Claudex for macOS")
                    KeyValueRow(key: "Version", value: "v0.2.0")
                    KeyValueRow(key: "Engine", value: "@claudex/control-api (loopback HTTP+SSE)")
                }
            }
            .padding(Theme.Spacing.xl)
            .frame(maxWidth: Theme.Layout.readableMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.surfaceBase)
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
}
