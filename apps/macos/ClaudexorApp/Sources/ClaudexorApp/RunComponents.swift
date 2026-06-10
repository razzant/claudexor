import SwiftUI

// MARK: - Phase pipeline (adaptive: full timeline when it fits, else a compact summary)

struct PhasePipelineView: View {
    let active: Phase
    var status: RunStatus = .running
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // ViewThatFits picks the full timeline when the column is wide enough, and a
        // compact summary when it isn't — so the pipeline never pins a large minimum
        // width on the detail column (which previously clipped the sidebar).
        ViewThatFits(in: .horizontal) {
            full
            compact
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var full: some View {
        HStack(spacing: 0) {
            ForEach(Phase.allCases) { phase in
                node(phase)
                if phase != Phase.allCases.last {
                    Rectangle()
                        .fill(phase.rawValue < active.rawValue || status == .succeeded ? Theme.status(.succeeded).opacity(0.6) : Theme.separator)
                        .frame(height: 1.5)
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }

    private var compact: some View {
        let done = status == .succeeded
        let idx = done ? Phase.allCases.count : active.rawValue + 1
        return HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: done ? "checkmark.circle.fill" : active.glyph)
                .symbolEffect(.pulse, options: .repeating, isActive: !done && !reduceMotion)
                .foregroundStyle(done ? Theme.status(.succeeded) : Theme.accent)
            Text(done ? "Complete" : active.label).font(.caption.weight(.medium))
            Spacer(minLength: Theme.Spacing.sm)
            Text("Phase \(idx)/\(Phase.allCases.count)")
                .font(.caption2).foregroundStyle(.secondary).monospacedDigit()
            MeterBar(fraction: Double(idx) / Double(Phase.allCases.count),
                     tint: done ? Theme.status(.succeeded) : Theme.accent)
                .frame(width: 80)
        }
    }

    @ViewBuilder
    private func node(_ phase: Phase) -> some View {
        let done = phase.rawValue < active.rawValue || status == .succeeded
        let current = phase == active && status != .succeeded
        VStack(spacing: Theme.Spacing.xs) {
            ZStack {
                Circle()
                    .fill(current ? Theme.accent.opacity(0.18) : (done ? Theme.status(.succeeded).opacity(0.16) : Theme.surfaceRaisedHi))
                    .frame(width: 26, height: 26)
                Image(systemName: done ? "checkmark" : phase.glyph)
                    .font(.caption2.weight(.semibold))
                    .symbolEffect(.pulse, options: .repeating, isActive: current && !reduceMotion)
                    .foregroundStyle(current ? Theme.accent : (done ? Theme.status(.succeeded) : .secondary))
            }
            Text(phase.label)
                .font(.caption2)
                .lineLimit(1).minimumScaleFactor(0.75)
                .foregroundStyle(current ? .primary : .secondary)
        }
        .frame(width: 56)
        .accessibilityLabel("\(phase.label)\(current ? ", current" : done ? ", done" : "")")
    }
}

// MARK: - Plan / todo list (the live agent task list)

struct PlanListView: View {
    let items: [PlanItem]
    var body: some View {
        if items.isEmpty {
            Text("No plan yet — the agent posts its steps here as the run starts.")
                .font(.callout).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { idx, item in
                    PlanRow(item: item)
                    if idx < items.count - 1 { Divider().overlay(Theme.hairline).padding(.leading, 30) }
                }
            }
        }
    }
}

private struct PlanRow: View {
    let item: PlanItem
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: item.state.glyph)
                .foregroundStyle(item.state.color)
                .symbolEffect(.pulse, options: .repeating, isActive: item.state == .active && !reduceMotion)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.callout)
                    .strikethrough(item.state == .done, color: .secondary)
                    .foregroundStyle(item.state == .done ? .secondary : .primary)
                if let note = item.note {
                    Text(note).font(.caption).foregroundStyle(item.state == .blocked ? Theme.status(.blocked) : .secondary)
                }
            }
            Spacer(minLength: Theme.Spacing.sm)
            if item.state == .active {
                Text("In progress").font(.caption2.weight(.medium)).foregroundStyle(Theme.status(.running))
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
    }
}

// MARK: - Activity feed

enum Verbosity: String, CaseIterable, Identifiable { case summary, normal, verbose; var id: String { rawValue }; var label: String { rawValue.capitalized } }

struct ActivityFeedView: View {
    let events: [ActivityEvent]
    var verbosity: Verbosity = .normal
    var body: some View {
        if events.isEmpty {
            Text("No activity yet.").font(.callout).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                ForEach(filtered) { ActivityRow(event: $0) }
            }
        }
    }
    private var filtered: [ActivityEvent] {
        switch verbosity {
        case .verbose, .normal: return events
        case .summary: return events.filter { [.gate, .review, .system].contains($0.kind) }
        }
    }
}

private struct ActivityRow: View {
    let event: ActivityEvent
    @State private var expanded = false

    private var canExpand: Bool {
        (event.detail?.isEmpty == false) || (event.code?.isEmpty == false)
    }

    /// Engine-typed severity overrides the kind tint: warnings amber, errors red.
    private var tint: Color {
        switch event.severity {
        case "error": return Theme.status(.failed)
        case "warning": return Theme.status(.needsReview)
        default: return event.kind.tint
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            ZStack {
                Circle().fill(tint.opacity(0.16)).frame(width: 28, height: 28)
                Image(systemName: event.kind.glyph).imageScale(.small).foregroundStyle(tint)
            }
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                HStack(spacing: Theme.Spacing.sm) {
                    if let h = event.harness {
                        HarnessDot(family: h)
                        Text(h.label).font(.caption.weight(.medium)).foregroundStyle(h.color)
                    }
                    Text(event.title).font(.callout.weight(.medium))
                    if event.severity == "error" {
                        Text("error").font(.caption2.weight(.semibold)).foregroundStyle(Theme.status(.failed))
                    } else if event.severity == "warning" {
                        Text("warning").font(.caption2.weight(.semibold)).foregroundStyle(Theme.status(.needsReview))
                    }
                    Spacer(minLength: Theme.Spacing.sm)
                    Text(event.timestamp, style: .relative).font(.caption2).foregroundStyle(.tertiary).fixedSize()
                }
                if let detail = event.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(expanded ? nil : 3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if expanded, let code = event.code {
                    Text(code)
                        .font(.system(.caption, design: .monospaced))
                        .padding(Theme.Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .codeSurface(8)
                        .textSelection(.enabled)
                }
                if canExpand {
                    Button {
                        withAnimation(.snappy) { expanded.toggle() }
                    } label: {
                        Label(expanded ? "Hide details" : "Show details", systemImage: expanded ? "chevron.up" : "chevron.down")
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .help(expanded ? "Collapse raw event details." : "Expand raw event details, artifact references, or full output.")
                }
            }
        }
    }
}

// MARK: - Candidate card (solid)

struct CandidateCard: View {
    let candidate: Candidate
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                HarnessDot(family: candidate.family, size: 10)
                Text(candidate.family.label).font(.subheadline.weight(.semibold))
                if candidate.isSynthesis {
                    Image(systemName: "wand.and.stars").imageScale(.small).foregroundStyle(Theme.accent)
                }
                Spacer()
                Text(candidate.id).font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary)
            }
            Text(candidate.summary).font(.caption).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
            HStack(spacing: Theme.Spacing.md) {
                Label("\(candidate.gatesPassed)/\(candidate.gatesTotal)", systemImage: "checklist")
                    .foregroundStyle(candidate.gatesTotal > 0 && candidate.gatesPassed == candidate.gatesTotal ? Theme.status(.succeeded) : Theme.status(.blocked))
                Label("+\(candidate.added) −\(candidate.removed)", systemImage: "plusminus").foregroundStyle(.secondary)
                Spacer()
                EstimatedCostBadge(cost: candidate.costUsd, estimated: candidate.estimated)
            }
            .font(.caption2)
            HStack {
                Text(candidate.reviewState.label)
                    .font(.caption2.weight(.semibold)).foregroundStyle(candidate.reviewState.color)
                    .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, 3)
                    .background(candidate.reviewState.color.opacity(0.14), in: Capsule())
                Spacer()
                StatusPill(status: candidate.status, compact: true)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(width: 240, alignment: .leading)
        .cardSurface(strokeColor: candidate.reviewState == .winner ? Theme.accent.opacity(0.7) : Theme.cardStroke,
                     lineWidth: candidate.reviewState == .winner ? 1.5 : 1)
    }
}

// MARK: - Task row (inbox/list)

struct TaskRowView: View {
    let task: TaskRun
    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            ZStack {
                Circle().fill(Theme.accent.opacity(0.12)).frame(width: 32, height: 32)
                Image(systemName: task.mode.glyph).imageScale(.small).foregroundStyle(Theme.accent)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Theme.Spacing.sm) {
                    Text(task.title).font(.callout.weight(.medium)).lineLimit(1)
                    ProvenanceTag(isLive: task.isLive)
                }
                HStack(spacing: Theme.Spacing.xs) {
                    Text(task.project).font(.caption2).foregroundStyle(.secondary)
                    Text("·").foregroundStyle(.tertiary)
                    Text(task.mode.label).font(.caption2).foregroundStyle(.secondary)
                    ForEach(task.harnesses.prefix(3)) { HarnessDot(family: $0, size: 6) }
                    if !task.diff.isEmpty {
                        Text("· \(task.filesChanged) files").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer(minLength: Theme.Spacing.md)
            VStack(alignment: .trailing, spacing: 4) {
                StatusPill(status: task.status, compact: false)
                Text(task.updatedAt, style: .relative).font(.caption2).foregroundStyle(.tertiary).fixedSize()
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
        .contentShape(Rectangle())
    }
}

// MARK: - Budget mini meter

struct BudgetMini: View {
    let spend: Double
    let cap: Double
    var spendKnown: Bool = true
    var capKnown: Bool = true
    var spendEstimated: Bool = false
    var tint: Color = Theme.accent
    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            HStack(spacing: 3) {
                Text(spendKnown ? "\(spendEstimated ? "~" : "")\(String(format: "$%.4f", spend))" : "Unknown").font(.system(.caption, design: .monospaced))
                Text("/").foregroundStyle(.tertiary)
                Text(capKnown ? String(format: "$%.2f", cap) : "Unknown").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            }
            MeterBar(fraction: spendKnown && capKnown && cap > 0 ? spend / cap : 0, tint: tint).frame(width: 130)
        }
        .help(helpText)
    }

    private var helpText: String {
        let spendText = spendKnown ? "\(spendEstimated ? "Estimated " : "")spend \(String(format: "$%.4f", spend))" : "Spend is not verified yet"
        let capText = capKnown ? "cap \(String(format: "$%.2f", cap))" : "cap is unknown"
        return "\(spendText); \(capText). Native provider quota is shown only when verified."
    }
}
