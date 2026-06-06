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

// MARK: - Harnesses / Doctor

struct HarnessesScreen: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if model.harnesses.isEmpty {
            EmptyStateView(title: "Harness status not wired yet",
                           message: "Live harness discovery (claudex doctor) isn't exposed over the control-api yet. Enable Sample data in Settings to preview this screen.",
                           systemImage: "cpu")
                .glowBackdrop()
        } else {
            ScreenScaffold(title: "Harnesses", subtitle: "No privileged harness. Roles are intents; a degraded adapter is gated out of roles it can't play.") {
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
    var body: some View {
        @Bindable var model = model
        ScreenScaffold(title: "Settings", maxWidth: Theme.Layout.readableMaxWidth) {
            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Appearance", systemImage: "paintpalette")
                    Picker("Theme", selection: $model.appearance) {
                        ForEach(AppearanceMode.allCases) { Label($0.label, systemImage: $0.glyph).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Text("Signature default is graphite Dark. Light and System are fully supported.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Data", systemImage: "rectangle.on.rectangle")
                    Toggle(isOn: $model.demoMode) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Show sample data").font(.callout)
                            Text("Populate screens with illustrative runs/specs/harnesses. Off by default so live state is never mixed with mock content.")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.switch).tint(Theme.accent)
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Engine connection", systemImage: "bolt.horizontal.circle")
                    KeyValueRow(key: "Status", value: model.health.label, valueColor: model.health == .connected ? Theme.status(.succeeded) : .secondary)
                    KeyValueRow(key: "Control API", value: model.endpoint.isEmpty ? "—" : "http://\(model.endpoint)", mono: true)
                    KeyValueRow(key: "Discovery", value: "~/.claudex/daemon/control-api.json", mono: true)
                    Button { Task { await model.connect() } } label: { Label("Reconnect", systemImage: "arrow.clockwise") }.buttonStyle(.bordered)
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Trust & secrets", systemImage: "lock.shield")
                    Text("Claudex mirrors each harness's own auth. Secrets live in the OS Keychain or 0600 files, scoped per envelope — never printed, logged, or shown here.")
                        .font(.caption).foregroundStyle(.secondary)
                    KeyValueRow(key: "Token", value: "•••••••• (loopback bearer)", mono: true)
                    KeyValueRow(key: "Access default", value: "workspace_write")
                    KeyValueRow(key: "Repo config", value: "cannot self-grant sensitive powers")
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    SectionLabel("About", systemImage: "info.circle")
                    KeyValueRow(key: "App", value: "Claudex for macOS")
                    KeyValueRow(key: "Design", value: "Liquid Glass · macOS 26 Tahoe")
                    KeyValueRow(key: "Engine", value: "@claudex/control-api (loopback HTTP+SSE)")
                }
            }
        }
    }
}
