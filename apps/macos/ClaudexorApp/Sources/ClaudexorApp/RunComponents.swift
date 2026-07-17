import SwiftUI

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
    /// OLDEST-FIRST storage (append-only ring). Rendered newest-first through a
    /// lazy ReversedCollection — no materialized reversed copy per render — in
    /// a LazyVStack, so a thousand-row feed only builds the visible rows.
    let events: [ActivityEvent]
    /// Older events dropped by the live ring cap (honest truncation marker,
    /// mirrors the server's capped-timeline "omitted" note).
    var droppedOlder: Int = 0
    var verbosity: Verbosity = .normal
    var body: some View {
        if events.isEmpty {
            Text("No activity yet.").font(.callout).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let visible = filtered
            LazyVStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                ForEach(visible.reversed()) { ActivityRow(event: $0) }
                if droppedOlder > 0 {
                    Text("\(droppedOlder) older events collapsed — the live feed keeps the newest 1000; the full log lives in the run's events.jsonl artifact.")
                        .font(.caption).foregroundStyle(.tertiary)
                        .padding(.top, Theme.Spacing.sm)
                }
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
        .cardSurface(strokeColor: candidate.reviewState == .winner ? Theme.accent.opacity(0.7) : nil,
                     lineWidth: candidate.reviewState == .winner ? 1.5 : 1)
    }
}

// MARK: - Budget mini meter

struct BudgetMini: View {
    let spend: Double
    let cap: Double
    var spendKnown: Bool = true
    var capKnown: Bool = true
    var capUnlimited: Bool = false
    var spendEstimated: Bool = false
    var tint: Color = Theme.accent
    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            HStack(spacing: 3) {
                Text(spendKnown ? "\(spendEstimated ? "~" : "")\(CashSpend.label(spend))" : "Unknown").font(.system(.caption, design: .monospaced))
                Text("/").foregroundStyle(.tertiary)
                Text(capUnlimited ? "Unlimited" : capKnown ? String(format: "$%.2f", cap) : "Unknown").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            }
            MeterBar(fraction: spendKnown && capKnown && cap > 0 ? spend / cap : 0, tint: tint).frame(width: 130)
        }
        .help(helpText)
    }

    private var helpText: String {
        let spendText = spendKnown ? "\(spendEstimated ? "Estimated " : "")spend \(CashSpend.label(spend))" : "Spend is not verified yet"
        let capText = capUnlimited ? "paid budget is unlimited" : capKnown ? "cap \(String(format: "$%.2f", cap))" : "cap is unknown"
        return "\(spendText); \(capText). Native provider quota is shown only when verified."
    }
}
