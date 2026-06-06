import SwiftUI

/// New-task composer presented as a system Sheet (Liquid Glass background provided by the
/// system). Content inside uses solid surfaces and standard controls — no glass-on-glass.
struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var prompt = ""
    @State private var mode: RunMode = .race
    @State private var selectedHarnesses: Set<HarnessFamily> = [.codex, .claude]
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

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.separator)
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    promptSection
                    modeSection
                    harnessSection
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
        .frame(width: 660, height: 740)
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
                    Text("Describe what you want done — e.g. \"Fix the failing budget lease test and add a regression.\"")
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
    }

    private var harnessSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Harnesses", systemImage: "cpu")
            FlowLayout(spacing: Theme.Spacing.sm) {
                ForEach(HarnessFamily.allCases.filter { $0 != .fake }) { family in
                    Button {
                        if selectedHarnesses.contains(family) { selectedHarnesses.remove(family) } else { selectedHarnesses.insert(family) }
                    } label: { HarnessChip(family: family, selected: selectedHarnesses.contains(family)) }
                    .buttonStyle(.plain)
                }
            }
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
            .padding(Theme.Spacing.md).cardSurface()
        }
    }

    private var budgetSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionLabel("Budget cap", systemImage: "dollarsign.circle",
                         accessory: AnyView(Text(String(format: "$%.2f", capUsd)).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.accent)))
            Slider(value: $capUsd, in: 0.10...5.0, step: 0.10).tint(Theme.accent)
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
            .padding(Theme.Spacing.md).cardSurface()
        }
    }

    private var footer: some View {
        HStack(spacing: Theme.Spacing.md) {
            if model.health != .connected {
                Label("Engine offline — run will queue when connected", systemImage: "bolt.slash")
                    .font(.caption).foregroundStyle(Theme.status(.blocked))
            }
            Spacer()
            Button("Cancel") { dismiss() }.buttonStyle(.bordered)
            Button {
                Task { await model.startRun(prompt: prompt, mode: mode, harnesses: Array(selectedHarnesses), n: n,
                                            capUsd: capUsd, access: access.wire, tests: gateCommands) }
            } label: {
                Label("Launch", systemImage: "paperplane.fill")
            }
            .buttonStyle(.borderedProminent).tint(Theme.accent)
            .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedHarnesses.isEmpty)
        }
        .padding(Theme.Spacing.lg)
    }
}
