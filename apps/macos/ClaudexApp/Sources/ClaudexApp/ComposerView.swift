import SwiftUI

/// New-task composer presented as a system Sheet (Liquid Glass background provided by the
/// system). Content inside uses solid surfaces and standard controls — no glass-on-glass.
struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var prompt = ""
    @State private var mode: RunMode = .ask
    @State private var selectedHarnesses: Set<HarnessFamily> = [.codex, .claude]
    @State private var primaryHarness: HarnessFamily = .codex
    @State private var portfolio = "subscription-first"
    @State private var modelHint = ""
    @State private var n = 2
    @State private var capUsd: Double = 0.50
    @State private var access: AccessProfile = .workspaceWrite
    @State private var gateText = ""

    enum AccessProfile: String, CaseIterable, Identifiable {
        case readOnly, workspaceWrite, elevated
        var id: String { rawValue }
        var label: String {
            switch self {
            case .readOnly: return "Read only"
            case .workspaceWrite: return "Workspace write"
            case .elevated: return "Elevated"
            }
        }
        var glyph: String {
            switch self {
            case .readOnly: return "eye"
            case .workspaceWrite: return "square.and.pencil"
            case .elevated: return "lock.open"
            }
        }
        /// The wire value the orchestrator's AccessProfile expects.
        var wire: String {
            switch self {
            case .readOnly: return "readonly"
            case .workspaceWrite: return "workspace_write"
            case .elevated: return "full"
            }
        }
    }

    private var gateCommands: [String] {
        gateText.split(whereSeparator: { $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    private var orderedSelectedHarnesses: [HarnessFamily] {
        HarnessFamily.allCases.filter { $0 != .fake && selectedHarnesses.contains($0) }
    }
    private var availableSelectedHarnesses: [HarnessFamily] {
        model.availableHarnesses(for: mode, selected: selectedHarnesses)
    }
    private var effectivePrimary: HarnessFamily? {
        availableSelectedHarnesses.contains(primaryHarness) ? primaryHarness : availableSelectedHarnesses.first
    }
    private var canLaunch: Bool {
        model.health == .connected &&
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !availableSelectedHarnesses.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.separator)
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    promptSection
                    modeSection
                    harnessSection
                    routingSection
                    if mode.isMultiCandidate { candidateSection }
                    budgetSection
                    accessSection
                }
                .padding(Theme.Spacing.xl)
            }
            .scrollContentBackground(.hidden)
            Divider().overlay(Theme.separator)
            footer
        }
        .frame(width: 660, height: 700)
        .glowBackdrop()
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: "plus.circle.fill").font(.title2).foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 0) {
                Text("New Task").font(.title3.weight(.semibold))
                Text("Compose a run for the engine-service").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button { dismiss() } label: { Image(systemName: "xmark") }.buttonStyle(.borderless)
        }
        .padding(Theme.Spacing.lg)
    }

    private var promptSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Task", systemImage: "text.alignleft")
            ZStack(alignment: .topLeading) {
                if prompt.isEmpty {
                    Text("Ask a question or describe a task — e.g. \"2+2?\" or \"Fix the failing budget lease test.\"")
                        .foregroundStyle(.tertiary).padding(Theme.Spacing.md)
                }
                TextEditor(text: $prompt)
                    .font(.callout).scrollContentBackground(.hidden)
                    .padding(Theme.Spacing.sm).frame(height: 96)
            }
            .codeSurface()
        }
    }

    private var modeSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Mode", systemImage: "slider.horizontal.3")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 188), spacing: Theme.Spacing.sm)], spacing: Theme.Spacing.sm) {
                ForEach(RunMode.allCases) { modeCard($0) }
            }
        }
    }

    private func modeCard(_ m: RunMode) -> some View {
        let active = m == mode
        return Button { withAnimation(.snappy) { mode = m } } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: m.glyph).foregroundStyle(active ? Theme.accent : .secondary).frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(m.label).font(.callout.weight(.medium)).foregroundStyle(.primary)
                    Text(m.blurb).font(.caption2).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .selectedChip(active: active, shape: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(m.label): \(m.blurb)")
    }

    private var harnessSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Harnesses", systemImage: "cpu")
            FlowLayout(spacing: Theme.Spacing.sm) {
                ForEach(HarnessFamily.allCases.filter { $0 != .fake }) { family in
                    let availability = model.availability(for: family, mode: mode)
                    Button {
                        guard availability.available else {
                            dismiss()
                            model.route = .harnesses
                            return
                        }
                        if selectedHarnesses.contains(family) {
                            selectedHarnesses.remove(family)
                            if primaryHarness == family, let next = availableSelectedHarnesses.first { primaryHarness = next }
                        } else {
                            selectedHarnesses.insert(family)
                            if availableSelectedHarnesses.count == 1 { primaryHarness = family }
                        }
                    } label: { HarnessChip(family: family, selected: selectedHarnesses.contains(family), available: availability.available) }
                    .buttonStyle(.plain)
                    .help(availability.available ? "\(family.label) is in the eligible pool for \(availability.intent) when selected." : "\(availability.reason). Click to open Harness Doctor.")
                }
            }
        }
    }

    private var routingSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Routing", systemImage: "point.3.connected.trianglepath.dotted")
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Picker("Primary", selection: $primaryHarness) {
                    ForEach(availableSelectedHarnesses) { family in
                        Label(family.label, systemImage: family.glyph).tag(family)
                    }
                }
                .help("Primary biases Ask/Agent and the first route. Selected harness chips remain the eligible pool.")

                Picker("Portfolio", selection: $portfolio) {
                    Text("Subscription-first").tag("subscription-first")
                    Text("Balanced").tag("balanced")
                    Text("Cheapest").tag("cheapest")
                    Text("Strongest").tag("strongest")
                    Text("API overflow").tag("api-overflow")
                    Text("Benchmark").tag("benchmark")
                }
                .help("Portfolio is a routing/budget policy, not a mode.")

                TextField("Model hint (optional)", text: $modelHint)
                    .textFieldStyle(.roundedBorder)
                    .help("Optional per-run model hint forwarded to compatible harnesses.")
            }
            .padding(Theme.Spacing.md).cardSurface()
        }
    }

    private var candidateSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Candidates", systemImage: "number")
            Stepper(value: $n, in: 1...8) {
                HStack {
                    Text("\(n) candidate\(n == 1 ? "" : "s")").monospacedDigit()
                    Spacer()
                    Text("per envelope").font(.caption).foregroundStyle(.secondary)
                }
            }
            .help("How many candidate runs to request for multi-candidate modes. Single-route modes still use one route.")
            .padding(Theme.Spacing.md).cardSurface()
        }
    }

    private var budgetSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Budget cap", systemImage: "dollarsign.circle",
                         accessory: AnyView(Text(String(format: "$%.2f", capUsd)).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.accent)))
            Slider(value: $capUsd, in: 0.10...5.0, step: 0.10).tint(Theme.accent)
                .help("Per-run spend cap sent to the engine for this launch.")
                .padding(.horizontal, Theme.Spacing.md).padding(.vertical, Theme.Spacing.sm).cardSurface()
        }
    }

    private var accessSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Access & gates", systemImage: "lock.shield")
            FlowLayout(spacing: Theme.Spacing.sm) {
                ForEach(AccessProfile.allCases) { p in
                    FilterChip(label: p.label, systemImage: p.glyph, isActive: p == access) {
                        withAnimation(.snappy) { access = p }
                    }
                    .help(p == .elevated ? "Elevated maps to full access and should be used only when the harness must operate outside the workspace." : "\(p.label) access profile")
                }
            }
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Label("Gate commands (optional, one per line)", systemImage: "checklist").font(.caption).foregroundStyle(.secondary)
                ZStack(alignment: .topLeading) {
                    if gateText.isEmpty {
                        Text("pnpm -w typecheck\npnpm -w test").foregroundStyle(.tertiary)
                            .font(.system(.caption, design: .monospaced)).padding(Theme.Spacing.sm)
                    }
                    TextEditor(text: $gateText)
                        .font(.system(.caption, design: .monospaced)).scrollContentBackground(.hidden)
                        .padding(.horizontal, Theme.Spacing.xs).frame(height: 54)
                }
                .codeSurface(8)
                Text("Required deterministic gates run before review. Leave empty to use the repo's configured gates.")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .help("One shell command per line. These gates are recorded in the TaskContract and checked before review.")
            .padding(Theme.Spacing.md).cardSurface()
        }
    }

    private var footer: some View {
        HStack(spacing: Theme.Spacing.md) {
            if model.health != .connected {
                Label("Engine offline — reconnect before launching", systemImage: "bolt.slash")
                    .font(.caption).foregroundStyle(Theme.status(.blocked))
            } else if availableSelectedHarnesses.isEmpty {
                Label("No selected harness can handle \(mode.requiredIntent)", systemImage: "slash.circle")
                    .font(.caption).foregroundStyle(Theme.status(.blocked))
            }
            Spacer()
            Button("Cancel") { dismiss() }.buttonStyle(.bordered)
            Button {
                let selected = availableSelectedHarnesses
                Task { await model.startRun(prompt: prompt, mode: mode, harnesses: selected,
                                            primary: effectivePrimary, portfolio: portfolio,
                                            model: modelHint.trimmingCharacters(in: .whitespacesAndNewlines),
                                            n: n, capUsd: capUsd,
                                            access: mode.isReadOnly ? "readonly" : access.wire,
                                            tests: gateCommands) }
            } label: {
                Label("Launch", systemImage: "paperplane.fill")
            }
            .buttonStyle(.borderedProminent).tint(Theme.accent)
            .disabled(!canLaunch)
            .help(canLaunch ? "Launch \(mode.label)" : "Enter a prompt, reconnect the engine, and select an available harness.")
        }
        .padding(Theme.Spacing.lg)
    }
}
