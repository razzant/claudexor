import SwiftUI

/// Standard, labeled Auth sheet navigation chrome: profile drill-in gets Back;
/// every level gets an always-visible Done. Active login state disables Back
/// so the existing keep-running/cancel confirmation cannot be bypassed.
struct AuthSheetHeader: View {
    let family: HarnessFamily
    let profileDisplayName: String?
    let backDisabled: Bool
    let back: () -> Void
    let done: () -> Void

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            if profileDisplayName != nil {
                Button(action: back) { Label("Accounts", systemImage: "chevron.left") }
                    .buttonStyle(.borderless)
                    .disabled(backDisabled)
                    .help(backDisabled
                          ? "Finish or cancel the active login before going back"
                          : "Back to \(family.label) accounts")
            }
            HarnessLogo(family: family, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(profileDisplayName.map { "\(family.label) · \($0)" } ?? "\(family.label) Auth")
                    .font(.title3.weight(.semibold))
                Text(profileDisplayName == nil
                     ? "Native session first; API-key fallback only through the local secret store."
                     : "Native login for this account. The default login stays untouched.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Done", action: done)
                .buttonStyle(.bordered)
                .keyboardShortcut(.cancelAction)
                .help("Close \(family.label) Auth. An active setup job asks whether to keep running or cancel.")
        }
    }
}
