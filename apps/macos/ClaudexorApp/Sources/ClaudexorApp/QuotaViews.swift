import SwiftUI
import ClaudexorKit

// The always-expanded sidebar quota footer (`QuotaFooterView`) was replaced by
// the compact bottom-left accounts popover (see `AccountsPopover.swift`, INV-135).
// The full per-window quota detail lives on in `QuotaDetailView`, reached from
// that popover's "All quota windows" affordance.

/// The detail popover mirrors the SAME grouped projection (one section per
/// route group — a cooldown never duplicates the subject into a second card),
/// plus per-snapshot provenance the footer has no room for.
struct QuotaDetailView: View {
    @Environment(AppModel.self) private var model

    private var groups: [QuotaPresentation.Group] {
        QuotaPresentation.groups(from: model.quotaResponse?.snapshots ?? [])
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack {
                    Text("Quota").font(.headline)
                    Spacer()
                    Button { Task { await model.refreshQuota(force: true) } } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }
                if model.health != .connected {
                    ContentUnavailableView("Engine offline", systemImage: "wifi.slash")
                } else if !groups.isEmpty {
                    ForEach(groups) { group in
                        groupSection(group)
                    }
                } else {
                    ContentUnavailableView(
                        "Quota unknown",
                        systemImage: "gauge.with.dots.needle.0percent",
                        description: Text("No official quota snapshot is available yet. Unknown is not shown as full headroom.")
                    )
                }
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private func groupSection(_ group: QuotaPresentation.Group) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text(group.harness).font(.headline)
                if let subject = group.subjectId { Text(subject).foregroundStyle(Theme.accent) }
                Text(group.routeLabel).foregroundStyle(.secondary)
                if let plan = group.planLabel { Text(plan).foregroundStyle(.secondary) }
                Spacer()
                Text(group.freshness.capitalized)
                    .font(.caption)
                    .foregroundStyle(freshnessColor(group.freshness))
            }
            if let cooldown = formattedDate(group.cooldownUntil) {
                Label("Cooling down until \(cooldown)", systemImage: "hourglass")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            ForEach(group.windows) { window in
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    HStack {
                        Text(window.label)
                        Spacer()
                        Text(usageText(window.usedRatio)).monospacedDigit()
                    }
                    if let ratio = window.usedRatio {
                        ProgressView(value: ratio, total: 1).tint(ratio >= 0.9 ? .orange : Theme.accent)
                    } else {
                        Text("Provider did not report usage for this window.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if let reset = formattedDate(window.resetsAt) {
                        Text("Resets \(reset)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(Theme.Spacing.sm)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            }
            ForEach(group.sources) { source in
                Text("\(source.source.replacingOccurrences(of: "_", with: " ")) · observed \(formattedDate(source.observedAt) ?? source.observedAt)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private func usageText(_ ratio: Double?) -> String {
    guard let ratio else { return "Unknown" }
    return "\(Int((ratio * 100).rounded()))% used"
}

private func freshnessColor(_ freshness: String) -> Color {
    switch freshness {
    case "fresh": return Theme.status(.succeeded)
    case "stale": return Theme.status(.blocked)
    default: return .secondary
    }
}

func formattedDate(_ value: String?) -> String? {
    guard let value else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    guard let date = fractional.date(from: value) ?? plain.date(from: value) else { return value }
    return date.formatted(date: .abbreviated, time: .shortened)
}
