import ClaudexorKit
import SwiftUI

/// AuthSheet connector for the Key allowance panel. While the sheet is open it
/// holds a quota-display subscription for the active location and shows the
/// API-key rows the engine publishes for this harness (default key first, then
/// registered keys). Key management precedes the growing list so keyboard focus
/// stays visible without automatic scrolling. Only this view
/// knows AppModel; `KeyAllowancePanel` stays a service-free leaf.
struct AuthSheetKeyAllowanceSection<KeyManagement: View>: View {
    @Environment(AppModel.self) private var model
    let family: HarnessFamily
    @ViewBuilder let keyManagement: () -> KeyManagement
    @State private var subscription: AccountsQuotaSubscription?

    private var location: ExecutionLocationID { model.activeExecutionLocation }
    private var rows: [AccountResourceSnapshot] {
        KeyAllowancePresentation.rows(model.activeQuotaResponse?.resources ?? [], harness: family.setupHarnessId)
    }
    private var refreshes: [AccountTarget: AccountResourceRefresh] {
        model.accountResourceActions.refreshes[location] ?? [:]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            keyManagement()
            if !rows.isEmpty {
                Panel {
                    KeyAllowancePanel(
                        provider: family.label,
                        entries: rows.map { row in
                            KeyAllowancePresentation.entry(
                                row,
                                caption: KeyAllowancePresentation.showsCaption(row.target, rowCount: rows.count)
                                    ? name(row.target) : nil,
                                refreshError: refreshes[row.target]?.error)
                        },
                        refreshing: rows.contains { refreshes[$0.target]?.inFlight == true },
                        refreshUnavailable: refreshUnavailable,
                        refresh: refresh)
                }
            }
        }
        .onAppear {
            guard subscription == nil else { return }
            subscription = model.beginAccountsQuotaSubscription()
        }
        .onDisappear {
            if let subscription { model.endAccountsQuotaSubscription(subscription) }
            subscription = nil
        }
        .onChange(of: location) { _, locationID in
            if let subscription { model.endAccountsQuotaSubscription(subscription) }
            subscription = model.beginAccountsQuotaSubscription(locationID: locationID)
        }
    }

    private func name(_ target: AccountTarget) -> String {
        guard let profileId = target.profileId else { return "Default key" }
        return model.activeCredentialProfiles.first {
            $0.profile.harnessId == target.harness && $0.profile.profileId == profileId
        }?.profile.displayName ?? profileId
    }

    private var refreshUnavailable: String? {
        guard model.gateway(for: location) != nil else { return "Engine offline: reconnect to refresh." }
        let capabilities = model.accountResourceActions.capabilities(at: location, client: model.gateway(for: location))
        return capabilities?.refresh == false ? "This engine does not support refreshing one key." : nil
    }

    private func refresh() {
        guard let connection = model.accountResourceConnection(at: location) else { return }
        let targets = rows.map(\.target)
        Task {
            for target in targets { await model.accountResourceActions.refresh(target, using: connection) }
        }
    }
}
