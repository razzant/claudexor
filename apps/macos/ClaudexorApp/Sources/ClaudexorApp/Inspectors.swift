import SwiftUI

/// The inspector panel itself is system Liquid Glass (via `.inspector`). Content inside is
/// SOLID (no glass-on-glass): subtle cards over the glass.

struct TaskInspectorView: View {
    @Environment(AppModel.self) private var model
    let task: TaskRun

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if let note = task.attentionNote {
                    HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                        Image(systemName: "bell.badge.fill").foregroundStyle(Theme.status(.needsReview))
                        Text(note).font(.caption).foregroundStyle(.primary)
                        Spacer(minLength: 0)
                    }
                    .padding(Theme.Spacing.md)
                    .background(Theme.status(.needsReview).opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                }

                section("Honesty", "checkmark.shield") {
                    HStack { Text("Route proof").font(.caption).foregroundStyle(.secondary); Spacer(); RouteProofBadge(proof: task.routeProof) }
                    KeyValueRow(key: "Spend", value: task.budgetLabel, mono: true)
                    let gp = task.candidates.map(\.gatesPassed).max() ?? 0
                    let gt = task.candidates.map(\.gatesTotal).max() ?? 0
                    KeyValueRow(key: "Gates", value: gt > 0 ? "\(gp)/\(gt) passed" : "—",
                                valueColor: gt > 0 && gp == gt ? Theme.status(.succeeded) : .primary)
                }

                section("Run", "info.circle") {
                    KeyValueRow(key: "Id", value: task.id, mono: true)
                    KeyValueRow(key: "Mode", value: task.mode.label)
                    HStack { Text("Status").font(.caption).foregroundStyle(.secondary); Spacer(); StatusPill(status: task.status, compact: true) }
                    KeyValueRow(key: "Project", value: task.project)
                    if let spec = task.specTitle { KeyValueRow(key: "Spec", value: spec) }
                    KeyValueRow(key: "Phase", value: task.activePhase.label)
                }

                if !task.harnesses.isEmpty {
                    section("Harnesses", "cpu") {
                        FlowLayout(spacing: Theme.Spacing.xs) { ForEach(task.harnesses) { HarnessChip(family: $0) } }
                    }
                }

                if !task.findings.isEmpty {
                    section("Top findings", "exclamationmark.bubble") {
                        ForEach(task.findings.prefix(3)) { f in
                            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                                Image(systemName: f.severity.glyph).imageScale(.small).foregroundStyle(f.severity.color)
                                Text(f.title).font(.caption).lineLimit(2)
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }

                section("Actions", "bolt") {
                    if task.isLive && task.status.isActive {
                        Button(role: .destructive) { Task { await model.cancel(task.id) } } label: {
                            Label("Cancel run", systemImage: "stop.circle").frame(maxWidth: .infinity)
                        }.buttonStyle(.bordered)
                    }
                    Button { model.composerPresented = true } label: {
                        Label("New similar task", systemImage: "plus.square.on.square").frame(maxWidth: .infinity)
                    }.buttonStyle(.bordered)
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .scrollContentBackground(.hidden)
    }
}

struct ContextInspectorView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                section("Engine", model.health.glyph) {
                    HStack {
                        Text("Status").font(.caption).foregroundStyle(.secondary); Spacer()
                        Text(model.health.label).font(.caption.weight(.medium))
                            .foregroundStyle(model.health == .connected ? Theme.status(.succeeded) : .secondary)
                    }
                    KeyValueRow(key: "Control API", value: model.endpoint.isEmpty ? "—" : model.endpoint, mono: true)
                }
                section("At a glance", "rectangle.3.group") {
                    KeyValueRow(key: "Runs", value: "\(model.tasks.count)")
                    KeyValueRow(key: "Active", value: "\(model.activeTasks.count)")
                    KeyValueRow(key: "Need you", value: "\(model.attentionTasks.count)")
                    // Sum across currently listed runs — not a calendar-day ledger.
                    KeyValueRow(key: "Spend (listed runs)", value: model.budget.spendLabel, mono: true)
                }
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Label("Tip", systemImage: "lightbulb").font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                    Text("Select a run to see its honesty badges, evidence, and metadata here. Press ⌘N to compose a new task.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(Theme.Spacing.md)
                .background(Theme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
            }
            .padding(Theme.Spacing.lg)
        }
        .scrollContentBackground(.hidden)
    }
}

// Solid inspector section card (over the system-glass inspector).
@MainActor @ViewBuilder
private func section<Content: View>(_ title: String, _ glyph: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
        Label(title, systemImage: glyph).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        content()
    }
    .padding(Theme.Spacing.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.surfaceRaised.opacity(0.7), in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).stroke(Theme.separator, lineWidth: 1))
}
