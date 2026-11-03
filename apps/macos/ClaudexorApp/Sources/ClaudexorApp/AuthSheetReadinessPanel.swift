import ClaudexorKit
import SwiftUI

/// The shared readiness card for the default store or one exact profile.
/// Profile sheets render their own doctor projection; default readiness must
/// never be attributed to a named account.
struct AuthSheetReadinessPanel: View {
    let family: HarnessFamily
    let profileId: String?
    let targetVerified: Bool
    let profileStatus: CredentialProfileEntry.Status?
    let isReady: Bool
    let info: HarnessInfo?

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if let profileId {
                    SectionLabel(
                        "Account readiness",
                        systemImage: targetVerified
                            ? "checkmark.seal.fill" : "exclamationmark.triangle")
                    HStack(spacing: Theme.Spacing.sm) {
                        Circle()
                            .fill(Theme.statusFill(targetVerified ? .positive
                                : profileStatus?.availability == "unknown" ? .caution : .negative))
                            .frame(width: 8, height: 8)
                        Text(profileStatus.map {
                            "\($0.availability) · verification \($0.verification)"
                        } ?? "No doctor probe yet for \(profileId)")
                            .font(.caption)
                        Spacer()
                    }
                    if let detail = profileStatus?.detail {
                        Text(detail)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                } else {
                    SectionLabel(
                        "Readiness",
                        systemImage: isReady
                            ? "checkmark.seal.fill" : "exclamationmark.triangle")
                    HarnessReadinessCard(presentation: .from(family: family, info: info)) {
                        EmptyView()
                    }
                }
            }
        }
    }
}
