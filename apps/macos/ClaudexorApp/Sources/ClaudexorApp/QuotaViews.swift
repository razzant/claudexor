import SwiftUI
import ClaudexorKit

private struct QuotaWindowRow: Identifiable {
    let snapshot: QuotaSnapshot
    let constraint: QuotaConstraint
    var id: String { "\(snapshot.id):\(constraint.id)" }
}

struct QuotaFooterView: View {
    @Environment(AppModel.self) private var model
    @State private var showDetails = false

    private var rows: [QuotaWindowRow] {
        (model.quotaResponse?.snapshots ?? []).flatMap { snapshot in
            snapshot.constraints.map { QuotaWindowRow(snapshot: snapshot, constraint: $0) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Divider().opacity(0.45)
            if model.health != .connected {
                Label("Quota unavailable offline", systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if rows.isEmpty {
                HStack {
                    Label("Quota unknown", systemImage: "gauge.with.dots.needle.0percent")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    refreshButton
                }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.Spacing.xs) {
                        ForEach(rows) { row in
                            Button { showDetails = true } label: { capsule(row) }
                                .buttonStyle(.plain)
                                .help("Show all quota windows and provenance")
                        }
                        refreshButton
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

    private func capsule(_ row: QuotaWindowRow) -> some View {
        HStack(spacing: Theme.Spacing.xxs) {
            Circle()
                .fill(freshnessColor(row.snapshot.freshness))
                .frame(width: 6, height: 6)
            Text(row.snapshot.subject.harness).fontWeight(.medium)
            Text(row.constraint.label).foregroundStyle(.secondary)
            Text(usageText(row.constraint.usedRatio)).monospacedDigit()
        }
        .font(.caption2)
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, Theme.Spacing.xs)
        .background(Theme.surfaceRaised, in: Capsule())
    }
}

struct QuotaDetailView: View {
    @Environment(AppModel.self) private var model

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
                } else if let snapshots = model.quotaResponse?.snapshots, !snapshots.isEmpty {
                    ForEach(snapshots) { snapshot in
                        snapshotSection(snapshot)
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

    private func snapshotSection(_ snapshot: QuotaSnapshot) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text(snapshot.subject.harness).font(.headline)
                if let plan = snapshot.subject.planLabel { Text(plan).foregroundStyle(.secondary) }
                Spacer()
                Text(snapshot.freshness.capitalized)
                    .font(.caption)
                    .foregroundStyle(freshnessColor(snapshot.freshness))
            }
            Text("\(snapshot.subject.credentialRoute.replacingOccurrences(of: "_", with: " ")) · \(snapshot.source.replacingOccurrences(of: "_", with: " "))")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(snapshot.constraints) { constraint in
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    HStack {
                        Text(constraint.label)
                        Spacer()
                        Text(usageText(constraint.usedRatio)).monospacedDigit()
                    }
                    if let ratio = constraint.usedRatio {
                        ProgressView(value: ratio, total: 1).tint(ratio >= 0.9 ? .orange : Theme.accent)
                    } else {
                        Text("Provider did not report usage for this window.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    HStack {
                        if let reset = formattedDate(constraint.resetsAt) { Text("Resets \(reset)") }
                        if let cooldown = formattedDate(constraint.cooldownUntil) { Text("Cooldown until \(cooldown)") }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                .padding(Theme.Spacing.sm)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            }
            Text("Observed \(formattedDate(snapshot.observedAt) ?? snapshot.observedAt)")
                .font(.caption2).foregroundStyle(.secondary)
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
