import ClaudexorKit
import SwiftUI

/// Actual native leaf shared by product and isolated rendering fixtures.
struct AccountResourceDetails: View {
    let row: AccountRowModel
    let snapshot: AccountResourceSnapshot?
    let capabilities: AccountResourceCapabilities?
    var capabilityError: String? = nil
    var recoveryNotice: String? = nil
    var absences: [QuotaAbsence] = []
    var attempts: [AccountResetAttempt] = []
    var refreshState: AccountResourceRefresh? = nil
    let refresh: () -> Void
    let recover: (String) -> Void
    let reset: (AccountResetOffer, AccountResetGrant?) -> Void

    private var busy: Bool { refreshState?.inFlight == true || attempts.contains(where: \.inFlight) }
    private var historicalUsage: Bool {
        attempts.contains(where: \.usageNeedsRefresh) || refreshState?.error != nil
    }
    private var resetFreshness: ResourceFreshness {
        attempts.contains(where: \.usageNeedsRefresh) ? .stale : snapshot?.resets.freshness ?? .unknown
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            header
            if let recoveryNotice { Text(recoveryNotice).font(.caption2).foregroundStyle(.primary) }
            if !row.enabled {
                Text("Excluded from routing. Resources and reset actions remain available.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if let error = refreshState?.error {
                Text("Resources stale · refresh failed. \(error)")
                    .font(.caption).foregroundStyle(.primary)
            }
            if let capabilityError {
                Text("Could not check resource support. \(capabilityError)")
                    .font(.caption2).foregroundStyle(.primary)
            } else if capabilities?.read == false {
                Text("This engine does not report account resources. Included quota remains available.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(attempts) { attempt in outcome(attempt) }
            ForEach(absences) { absence in
                Text(absence.reason == "no_source" ? AccountResourcePresentation.quotaAbsenceReason(absence.reason)
                    : (absence.detail ?? absence.reason.replacingOccurrences(of: "_", with: " ")))
                    .font(.caption2).foregroundStyle(.primary)
            }
            AccountResourceQuotaWindows(groups: row.quotaGroups, historical: historicalUsage)
            if let snapshot {
                balanceSection(snapshot.balances)
                spendingSection(snapshot.spending)
                resetSection(snapshot.resets)
                diagnosticSection(snapshot.diagnostics)
            } else {
                Text("Balances, spending and reset offers have not been reported.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            AccountResourceSourceDetails(groups: row.quotaGroups, snapshot: snapshot, absences: absences)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(Theme.Spacing.sm)
        .background(Theme.surfaceBase, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control).stroke(Theme.hairline, lineWidth: 1))
    }

    private var header: some View {
        HStack {
            Text("Resources").font(.subheadline.weight(.semibold))
            Spacer()
            Button(action: refresh) {
                Label(refreshState?.inFlight == true ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderless).controlSize(.small)
            .disabled(busy || capabilities?.refresh == false)
            .help(busy ? "A request for this account is in progress."
                  : capabilities?.refresh == false ? "This engine does not support exact-account refresh."
                  : "Refresh only this account from its provider.")
        }
    }

    private func outcome(_ attempt: AccountResetAttempt) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(attempt.label).font(.caption2).foregroundStyle(.secondary)
            Label(AccountResourcePresentation.status(attempt),
                  systemImage: attempt.receipt?.outcome.confirmsReset == true ? "checkmark.circle.fill" : "clock")
                .font(.caption.weight(.medium))
                .foregroundStyle(attempt.receipt?.outcome.confirmsReset == true ? Theme.status(.positive) : Color.primary)
            if let error = attempt.error { Text(error).font(.caption2).foregroundStyle(.primary) }
            if let detail = attempt.receipt?.detail { Text(detail).font(.caption2).foregroundStyle(.secondary) }
            if attempt.usageNeedsRefresh {
                Text("Usage and reset availability have not been fully refreshed. Each resource keeps its own observation status.")
                    .font(.caption2).foregroundStyle(.primary)
            }
            if let readback = attempt.receipt?.readback {
                if readback.state == .failed && !attempt.refreshedAfterAttempt {
                    Text("Resource refresh failed. \(readback.detail ?? "")")
                        .font(.caption2).foregroundStyle(.primary)
                    Button("Retry refresh", action: refresh)
                        .buttonStyle(.bordered).controlSize(.small).disabled(busy)
                        .help("Refresh this account's resources without repeating the reset.")
                } else if readback.state == .fresh {
                    Text("Resources read after the request.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            if attempt.unconfirmed {
                Text("Checking this request keeps its original identity. A separate reset requires another confirmation.")
                    .font(.caption2).foregroundStyle(.secondary)
                Button("Check result") { recover(attempt.id) }
                    .buttonStyle(.bordered).controlSize(.small).disabled(attempt.inFlight)
                    .help(attempt.inFlight ? "Waiting for the engine response." : "Recover the original reset request and its result.")
            }
        }
    }

    private func balanceSection(_ facet: ResourceFacet<[AccountBalance]>) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Divider()
            Text("Balance and spending").font(.caption.weight(.semibold))
            ForEach(facet.value ?? []) { value in
                fact(value.label, AccountResourcePresentation.balance(value))
            }
            if facet.value?.isEmpty != false { fact("Balance", "Not reported") }
            freshness(facet)
        }
    }

    private func spendingSection(_ facet: ResourceFacet<[AccountSpending]>) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            ForEach(facet.value ?? []) { value in
                Text(value.label).font(.caption.weight(.medium))
                fact("Enabled", value.enabled.map { $0 ? "Yes" : "No" } ?? "Unknown")
                fact("Spent", AccountResourcePresentation.amount(value.used, unit: value.unit, currency: value.currency, decimalPlaces: value.decimalPlaces))
                fact("Limit", AccountResourcePresentation.amount(value.limit, unit: value.unit, currency: value.currency, decimalPlaces: value.decimalPlaces))
                if let date = formattedDate(value.resetsAt) { fact("Renews", date) }
                if let reason = value.reason { Text(reason).font(.caption2).foregroundStyle(.secondary) }
            }
            if facet.value?.isEmpty != false { fact("Spending", "Not reported") }
            freshness(facet)
        }
    }

    private func resetSection(_ facet: ResourceFacet<[AccountResetOffer]>) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Divider()
            Text("Reset options").font(.caption.weight(.semibold))
            ForEach(facet.value ?? []) { offer in
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(offer.label).font(.caption.weight(.medium))
                    if let description = offer.description { Text(description).font(.caption2).foregroundStyle(.secondary) }
                    Text(AccountResourcePresentation.inventory(offer.availableCount, usableNow: offer.usableNow,
                                                               freshness: resetFreshness))
                        .font(.caption2).foregroundStyle(.secondary)
                    if let reason = offer.reason { Text(reason).font(.caption2).foregroundStyle(.primary) }
                    if let date = formattedDate(offer.resetsAt) { fact("Available after", date) }
                    if offer.weeklyLimitApplies {
                        Text("Refills the session. Weekly quota still applies and is not replenished.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if let grants = offer.grants, !grants.isEmpty {
                        ForEach(grants) { grant in grantRow(grant, offer: offer) }
                    } else {
                        resetButton(offer, grant: nil)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
            if facet.value?.isEmpty != false { Text("Reset offers not reported.").font(.caption2).foregroundStyle(.secondary) }
            freshness(facet, override: resetFreshness)
        }
    }

    private func grantRow(_ grant: AccountResetGrant, offer: AccountResetOffer) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(grant.label).font(.caption)
                    Text(AccountResourcePresentation.inventory(grant.availableCount, usableNow: grant.usableNow,
                                                               freshness: resetFreshness))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: Theme.Spacing.xs)
                resetButton(offer, grant: grant)
            }
            if let count = grant.totalCount { fact("Granted", String(count)) }
            if let description = grant.description {
                Text(description)
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if let date = formattedDate(grant.startsAt) { fact("Starts", date) }
            if let date = formattedDate(grant.expiresAt) { fact("Expires", date) }
        }
    }

    private func resetButton(_ offer: AccountResetOffer, grant: AccountResetGrant?) -> some View {
        let reason = AccountResourcePresentation.disabledReason(
            offer: offer, grant: grant, freshness: resetFreshness,
            supported: capabilities?.reset == true, busy: busy)
        return Button(AccountResourcePresentation.action(offer, another: !attempts.isEmpty) + "…") { reset(offer, grant) }
            .buttonStyle(.bordered).controlSize(.small)
            .disabled(reason != nil)
            .help(reason ?? "Review and confirm \(offer.label) for \(row.displayName).")
    }

    private func diagnosticSection(_ facet: ResourceFacet<[AccountResourceDiagnostic]>) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Divider()
            Text("Provider and routing details").font(.caption.weight(.semibold))
            ForEach(Array((facet.value ?? []).enumerated()), id: \.offset) { _, value in
                Text(value.detail ?? "Provider reported additional details.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if facet.value?.isEmpty != false { Text("No details reported.").font(.caption2).foregroundStyle(.secondary) }
            freshness(facet)
        }
    }

    private func fact(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
            Text(name).font(.caption)
            Spacer(minLength: 0)
            Text(value).font(.caption.weight(.medium)).monospacedDigit().multilineTextAlignment(.trailing)
        }
    }
    private func freshness<Value>(_ facet: ResourceFacet<Value>, override: ResourceFreshness? = nil) -> some View {
        Text(AccountResourcePresentation.freshness(facet, override: override))
            .font(.caption2).foregroundStyle(.secondary)
    }
}

/// Same native window presentation as Quota detail, with an explicit historical
/// treatment while reset readback is unavailable. No fake zero progress bars.
struct AccountResourceQuotaWindows: View {
    let groups: [QuotaPresentation.Group]
    var historical = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(historical ? "Last-known included usage" : "Included usage")
                .font(.caption.weight(.medium))
            if groups.isEmpty { Text("Quota not reported.").font(.caption2).foregroundStyle(.secondary) }
            ForEach(groups) { group in
                ForEach(group.windows) { window in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        HStack {
                            Text(window.label)
                            Spacer()
                            Text(window.usedRatio.map { "\(Int(($0 * 100).rounded()))% used" } ?? "Unknown").monospacedDigit()
                        }.font(.caption)
                        if let ratio = window.usedRatio {
                            ProgressView(value: ratio, total: 1)
                                .tint(historical || window.freshness != "fresh" ? Color.secondary : Theme.accent)
                        }
                        if window.freshness != "fresh" { Text("Last known").font(.caption2).foregroundStyle(.secondary) }
                        if let models = window.appliesToModels, !models.isEmpty {
                            Text(QuotaPresentation.modelScopeLabel(models)).font(.caption2).foregroundStyle(.secondary)
                        }
                        if let reset = formattedDate(window.resetsAt) { Text("Resets \(reset)").font(.caption2).foregroundStyle(.secondary) }
                    }
                    .padding(Theme.Spacing.sm)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
                }
            }
        }
    }
}
