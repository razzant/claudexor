import SwiftUI
import ClaudexorKit

/// Sidebar quota footer (W17, Р15/Квиз-6a): a VERTICAL stack of route groups —
/// one chip per (harness, credential route) with every primary window preserved
/// as its own row, the route + freshness + nearest reset on the chip, and an
/// active cooldown as an overlay badge (never a standalone card). Grouping /
/// dedupe / expiry semantics live in `QuotaPresentation` (Kit, unit-tested).
struct QuotaFooterView: View {
    @Environment(AppModel.self) private var model
    @State private var showDetails = false

    private var groups: [QuotaPresentation.Group] {
        QuotaPresentation.groups(from: model.quotaResponse?.snapshots ?? [])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Divider().opacity(0.45)
            if model.health != .connected {
                Label("Quota unavailable offline", systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if groups.isEmpty {
                HStack {
                    Label("Quota unknown", systemImage: "gauge.with.dots.needle.0percent")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    refreshButton
                }
            } else {
                HStack {
                    Text("Quota").font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    refreshButton
                }
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    ForEach(groups) { group in
                        Button { showDetails = true } label: { groupChip(group) }
                            .buttonStyle(.plain)
                            .help("Show all quota windows and provenance")
                    }
                }
            }
            if let status = model.quotaStatus {
                Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.bottom, Theme.Spacing.sm)
        .popover(isPresented: $showDetails, arrowEdge: .trailing) {
            QuotaDetailView()
                .frame(width: 420, height: 420)
        }
    }

    private var refreshButton: some View {
        Button { Task { await model.refreshQuota(force: true) } } label: {
            Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.borderless)
        .help("Refresh quota from official provider sources")
    }

    /// One route group: harness + humanized route + freshness dot + nearest
    /// reset on the header line; every usage window keeps its own row.
    private func groupChip(_ group: QuotaPresentation.Group) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.xxs) {
                Circle()
                    .fill(freshnessColor(group.freshness))
                    .frame(width: 6, height: 6)
                Text(group.harness).fontWeight(.medium)
                Text(group.routeLabel).foregroundStyle(.secondary)
                Spacer()
                if let reset = formattedDate(group.nextResetAt) {
                    Text("resets \(reset)").foregroundStyle(.secondary)
                }
            }
            ForEach(group.windows) { window in
                HStack(spacing: Theme.Spacing.xs) {
                    Text(window.label).foregroundStyle(.secondary)
                    Spacer()
                    Text(usageText(window.usedRatio)).monospacedDigit()
                }
            }
            if group.windows.isEmpty {
                Text("No usage windows reported")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption2)
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, Theme.Spacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        // Cooldown is an OVERLAY BADGE on the group chip — never its own card;
        // expired cooldowns are already dropped by the projection.
        .overlay(alignment: .topTrailing) {
            if let cooldown = formattedDate(group.cooldownUntil) {
                Label("Cooldown · \(cooldown)", systemImage: "hourglass")
                    .font(.caption2)
                    .padding(.horizontal, Theme.Spacing.xs)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.18), in: Capsule())
                    .foregroundStyle(.orange)
                    .offset(x: -Theme.Spacing.xxs, y: -Theme.Spacing.xxs)
                    .help("This route is cooling down until \(cooldown); other windows stay visible.")
            }
        }
    }
}

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
