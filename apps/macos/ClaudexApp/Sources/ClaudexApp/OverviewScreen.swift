import SwiftUI

/// Home — composer-led, like Codex/Claude Code (no greeting; this is a dev tool). The
/// Home — composer-led, like Codex/Claude Code (no greeting; this is a dev tool). The
/// glow is a contained visual layer, and a single floating Liquid Glass composer is the
/// signature glass moment. Everything below is solid content.
struct HomeScreen: View {
    @Environment(AppModel.self) private var model
    @State private var prompt = ""
    @State private var mode: RunMode = .ask
    @State private var harnesses: Set<HarnessFamily> = [.codex, .claude]
    @State private var modeHelpPresented = false
    @FocusState private var promptFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                hero
                LazyVStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    if model.health == .offline { offlineBanner }
                    if !model.attentionTasks.isEmpty {
                        taskSection("Needs you", "bell.badge", model.attentionTasks, tint: Theme.status(.needsReview))
                    }
                    if !model.activeTasks.isEmpty {
                        taskSection("Active", "dot.radiowaves.up.forward", model.activeTasks, tint: Theme.status(.running))
                    }
                    taskSection("Recent", "clock.arrow.circlepath", recent, tint: .secondary)
                }
                .padding(.horizontal, Theme.Spacing.xxl)
                .padding(.bottom, Theme.Spacing.xxl)
                .frame(maxWidth: Theme.Layout.contentMaxWidth, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .scrollContentBackground(.hidden)
        .glowBackdrop()
    }

    // MARK: Floating glass composer (over the app-wide glow)

    private var hero: some View {
        composer
            .frame(maxWidth: Theme.Layout.contentMaxWidth - Theme.Spacing.xxl * 2, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Spacing.xxl)
            .padding(.top, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.xs)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                Image(systemName: "sparkles")
                    .font(.title3)
                    .foregroundStyle(Theme.accent)
                    .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                    .padding(.top, Theme.Spacing.xxs)
                TextField("Ask a question or describe a task for Claudex...", text: $prompt, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .lineLimit(1...4)
                    .focused($promptFocused)
                    .onSubmit(launch)
                Button { model.composerPresented = true } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .buttonStyle(.borderless)
                .help("More options")
                .accessibilityLabel("More options")
                Button(action: launch) {
                    Image(systemName: "arrow.up").font(.headline).padding(6)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .clipShape(Circle())
                .disabled(!canLaunch)
                .keyboardShortcut(.return, modifiers: .command)
                .help(launchHelp)
                .accessibilityLabel("Launch task")
            }
            // FlowLayout wraps these controls so the composer never forces a wide
            // minimum on the detail column (the cause of the small-window clipping).
            FlowLayout(spacing: Theme.Spacing.sm) {
                modeMenu
                Button { modeHelpPresented.toggle() } label: {
                    Image(systemName: "info.circle")
                        .imageScale(.small)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.accent)
                .popover(isPresented: $modeHelpPresented, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Label(mode.label, systemImage: mode.glyph)
                            .font(.callout.weight(.semibold))
                        Text(mode.blurb)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(Theme.Spacing.md)
                    .frame(width: 260, alignment: .leading)
                }
                .help("\(mode.label): \(mode.blurb)")
                ForEach(HarnessFamily.allCases.filter { $0 != .fake && $0 != .raw }) { family in
                    let availability = model.availability(for: family, mode: mode)
                    Button {
                        guard availability.available else {
                            model.route = .harnesses
                            return
                        }
                        if harnesses.contains(family) { harnesses.remove(family) } else { harnesses.insert(family) }
                    } label: { HarnessChip(family: family, selected: harnesses.contains(family), available: availability.available) }
                    .buttonStyle(.plain)
                    .help(availability.available ? "\(family.label) eligible pool for \(availability.intent)." : "\(availability.reason). Click to open Harness Doctor.")
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .chromeGlass(RoundedRectangle(cornerRadius: Theme.Radius.hero, style: .continuous))
    }

    private var selectedAvailableHarnesses: [HarnessFamily] {
        model.availableHarnesses(for: mode, selected: harnesses)
    }

    private var canLaunch: Bool {
        model.health == .connected &&
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !selectedAvailableHarnesses.isEmpty
    }

    private var launchHelp: String {
        if model.health != .connected { return "Reconnect the local engine before launching." }
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Enter a question or task first." }
        if selectedAvailableHarnesses.isEmpty { return "Select at least one harness that is available for \(mode.requiredIntent)." }
        return "Launch \(mode.label) with \(selectedAvailableHarnesses.map(\.label).joined(separator: ", ")) (⌘↵)"
    }

    private var modeMenu: some View {
        Menu {
            ForEach(RunMode.allCases) { m in
                Button { mode = m } label: { Label(m.label, systemImage: m.glyph) }
                    .help("\(m.label): \(m.blurb)")
            }
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: mode.glyph).imageScale(.small)
                Text(mode.label)
                Image(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(Theme.accent)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("\(mode.label): \(mode.blurb)")
    }

    private func launch() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let selected = selectedAvailableHarnesses
        guard !text.isEmpty, !selected.isEmpty else { return }
        let n = mode.isMultiCandidate ? max(2, selected.count) : 1
        Task { await model.startRun(prompt: text, mode: mode, harnesses: selected,
                                    primary: selected.first, portfolio: "subscription-first",
                                    model: nil, n: n, capUsd: 0.50,
                                    access: mode.isReadOnly ? "readonly" : "workspace_write") }
        prompt = ""
    }

    private var offlineBanner: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: "bolt.slash.fill").foregroundStyle(Theme.status(.blocked))
            VStack(alignment: .leading, spacing: 2) {
                Text("Engine offline").font(.callout.weight(.semibold))
                Text("Start the local engine with `claudexd` to launch and observe live runs. Showing sample data meanwhile.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Button { Task { await model.connect() } } label: { Label("Retry", systemImage: "arrow.clockwise") }
                .buttonStyle(.bordered)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.status(.blocked).opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(Theme.status(.blocked).opacity(0.3), lineWidth: 1))
    }

    // MARK: Task sections (solid)

    private var recent: [TaskRun] {
        model.tasks
            .filter { !$0.status.isActive && !$0.status.needsAttention }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private func taskSection(_ title: String, _ glyph: String, _ tasks: [TaskRun], tint: Color) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: glyph).imageScale(.small).foregroundStyle(tint)
                Text(title).font(.subheadline.weight(.semibold))
                Text("\(tasks.count)").font(.caption2.weight(.semibold)).monospacedDigit().foregroundStyle(.secondary)
                    .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, Theme.Spacing.xxs)
                    .background(Theme.surfaceRaisedHi, in: Capsule())
                Spacer()
                if title == "Recent" {
                    Button("All tasks") { model.route = .tasks }.buttonStyle(.link).font(.caption)
                }
            }
            if tasks.isEmpty {
                Panel { Text("Nothing here yet.").font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            } else {
                Panel(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(tasks.enumerated()), id: \.element.id) { idx, task in
                            Button { model.route = .task(task.id) } label: {
                                TaskRowView(task: task)
                                    .padding(.horizontal, Theme.Spacing.md)
                            }
                            .buttonStyle(.plain)
                            if idx < tasks.count - 1 { Divider().overlay(Theme.hairline).padding(.leading, Theme.Metrics.rowDividerInset) }
                        }
                    }
                    .padding(.vertical, Theme.Spacing.xs)
                }
            }
        }
    }
}
