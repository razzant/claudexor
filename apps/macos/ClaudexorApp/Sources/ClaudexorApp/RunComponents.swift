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
                    Text(note).font(.caption).foregroundStyle(item.state == .blocked ? Theme.status(.caution) : .secondary)
                }
            }
            Spacer(minLength: Theme.Spacing.sm)
            if item.state == .active {
                Text("In progress").font(.caption2.weight(.medium)).foregroundStyle(Theme.status(.info))
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
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
                    .foregroundStyle(candidate.gatesTotal > 0 && candidate.gatesPassed == candidate.gatesTotal ? Theme.status(.positive) : Theme.status(.caution))
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
