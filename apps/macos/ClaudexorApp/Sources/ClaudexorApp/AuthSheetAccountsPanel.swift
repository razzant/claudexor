import SwiftUI

/// AuthSheet host for the ONE shared AccountsSurface. The implicit default
/// login is the first account row; profiles follow; there is no parallel
/// Native-setup-vs-Additional-accounts surface.
struct AuthSheetAccountsPanel: View {
    let family: HarnessFamily
    let actionInFlight: Bool
    let defaultLoginDisabled: Bool
    let login: (AccountRowModel) -> Void
    let recheck: () -> Void

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack {
                    SectionLabel("Accounts", systemImage: "person.2")
                    Spacer()
                    Button(action: recheck) {
                        Label("Recheck", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .disabled(actionInFlight)
                    .help("Refresh default and named-account readiness")
                }
                AccountsSurface(
                    family: family,
                    includeDefaults: true,
                    login: login,
                    loginDisabled: { row in
                        row.profileId == nil && defaultLoginDisabled
                    }
                )
            }
        }
    }
}
