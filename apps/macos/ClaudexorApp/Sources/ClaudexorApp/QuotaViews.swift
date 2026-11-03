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
    @State private var quotaSubscription: AccountsQuotaSubscription?

    private var groups: [QuotaPresentation.Group] {
        QuotaPresentation.groups(from: model.activeQuotaResponse?.snapshots ?? [])
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack {
                    Text("Quota").font(.headline)
                    Spacer()
                    Button { Task { _ = await model.refreshAccounts() } } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.activeAccountsLoadState == .loading)
                }
                displayNotice
                if !groups.isEmpty {
                    ForEach(groups) { group in
                        groupSection(group)
                    }
                } else if model.gateway(for: model.activeExecutionLocation) == nil {
                    ContentUnavailableView("Engine offline", systemImage: "wifi.slash")
                } else if case .failed(let message) = model.activeAccountsLoadState {
                    failedWithoutGroups(message)
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
        .onAppear {
            guard quotaSubscription == nil else { return }
            quotaSubscription = model.beginAccountsQuotaSubscription()
        }
        .onDisappear {
            if let quotaSubscription { model.endAccountsQuotaSubscription(quotaSubscription) }
            quotaSubscription = nil
        }
        .onChange(of: model.activeExecutionLocation) { _, locationID in
            if let quotaSubscription { model.endAccountsQuotaSubscription(quotaSubscription) }
            quotaSubscription = model.beginAccountsQuotaSubscription(locationID: locationID)
        }
    }

    @ViewBuilder private var displayNotice: some View {
        if model.activeAccountsLoadState == .loading, model.activeQuotaResponse != nil {
            Label("Refreshing · last-known quota remains visible", systemImage: "arrow.clockwise")
                .font(.caption).foregroundStyle(.secondary)
        }
        switch model.activeAccountsQuotaDisplayState {
        case .idle:
            EmptyView()
        case .loading:
            Label("Loading quota…", systemImage: "arrow.clockwise")
                .font(.caption).foregroundStyle(.secondary)
        case .current:
            EmptyView()
        case .stale(let reason, let observedAt):
            Label(
                "Stale\(observedAt.flatMap(formattedDate).map { " · observed \($0)" } ?? "") · \(reason)",
                systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                .font(.caption).foregroundStyle(Theme.status(.caution))
        case .failedWithoutData(let reason):
            Label(reason, systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(Theme.status(.negative))
        }
        if case .failed(let message) = model.activeAccountsLoadState,
           model.activeQuotaResponse != nil
        {
            HStack {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(Theme.status(.negative))
                Spacer()
                Button("Retry") { Task { _ = await model.refreshAccounts() } }
                    .buttonStyle(.bordered).controlSize(.small)
            }
        }
    }

    private func failedWithoutGroups(_ message: String) -> some View {
        VStack(spacing: Theme.Spacing.sm) {
            ContentUnavailableView(
                "Could not refresh quota",
                systemImage: "exclamationmark.triangle.fill",
                description: Text(message)
            )
            Button("Retry") { Task { _ = await model.refreshAccounts() } }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accentSolid)
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
            if let availability = group.availability, availability.state != "available" {
                Label(
                    availability.state == "exhausted" ? "Account quota exhausted" : "Account cooling down",
                    systemImage: availability.state == "exhausted" ? "gauge.with.dots.needle.100percent" : "hourglass")
                    .font(.caption)
                    .foregroundStyle(Theme.status(.caution))
            }
            ForEach(group.scopedExhaustions) { scoped in
                Label("\(scoped.scopeLabel) exhausted", systemImage: "scope")
                    .font(.caption)
                    .foregroundStyle(Theme.status(.caution))
            }
            if let cooldown = formattedDate(group.cooldownUntil) {
                Label("Cooling down until \(cooldown)", systemImage: "hourglass")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            ForEach(group.windows) { window in
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    HStack {
                        Text(windowLabel(window))
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

    private func windowLabel(_ window: QuotaPresentation.Window) -> String {
        guard let models = window.appliesToModels, !models.isEmpty else { return window.label }
        return "\(window.label) · \(QuotaPresentation.modelScopeLabel(models))"
    }
}

private func usageText(_ ratio: Double?) -> String {
    guard let ratio else { return "Unknown" }
    return "\(Int((ratio * 100).rounded()))% used"
}

private func freshnessColor(_ freshness: String) -> Color {
    switch freshness {
    case "fresh": return Theme.status(.positive)
    case "stale": return Theme.status(.caution)
    default: return .secondary
    }
}

func formattedDate(_ value: String?) -> String? {
    guard let value else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    guard let date = fractional.date(from: value) ?? plain.date(from: value) else { return value }
    return date.formatted(
        Date.FormatStyle(date: .abbreviated, time: .shortened)
            .locale(Locale(identifier: "en_US_POSIX")))
}
