import ClaudexorKit
import SwiftUI

/// One optional inspection surface keeps technical provenance out of normal
/// resource copy. Raw times/codes stay selectable, complete and untruncated.
struct AccountResourceSourceDetails: View {
    let groups: [QuotaPresentation.Group]
    let snapshot: AccountResourceSnapshot?
    var absences: [QuotaAbsence] = []
    @State var expanded = false

    var body: some View {
        DisclosureGroup("Source details", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(groups) { group in
                    ForEach(group.sources) { source in
                        entry("Included usage", "Source: \(source.source)\nFreshness: \(source.freshness)\nObserved: \(source.observedAt)")
                    }
                }
                ForEach(absences) { absence in
                    entry("Quota check", "Reason: \(AccountResourcePresentation.quotaAbsenceReason(absence.reason))\nChecked: \(absence.observedAt)")
                }
                if let snapshot {
                    entry("Balance", AccountResourcePresentation.sourceDetails(snapshot.balances))
                    entry("Spending", AccountResourcePresentation.sourceDetails(snapshot.spending))
                    entry("Reset offers", AccountResourcePresentation.sourceDetails(snapshot.resets))
                    entry("Provider and routing details", AccountResourcePresentation.sourceDetails(snapshot.diagnostics))
                    ForEach(Array((snapshot.diagnostics.value ?? []).enumerated()), id: \.offset) { _, value in
                        Text("Code: \(value.code)")
                    }
                } else {
                    Text("Resource sources have not been reported.")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(.top, Theme.Spacing.xs)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }

    private func entry(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Text(title).fontWeight(.medium)
            Text(detail)
        }
    }
}
