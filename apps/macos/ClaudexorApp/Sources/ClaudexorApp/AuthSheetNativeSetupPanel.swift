import SwiftUI
import ClaudexorKit

// MARK: - Native-setup panel (pure rendering; split from AuthSheet.swift for
// the complexity ratchet — AuthSheet stays the one owner of lifecycle
// mutations and passes actions in as closures, mirroring AuthSheetJobPanel).
struct AuthSheetNativeSetupPanel: View {
    let targetVerified: Bool
    let newSetupDisabled: Bool
    let actionInFlight: Bool
    /// Nil = the harness's default store target; non-nil = an account row's own store.
    let profileId: String?
    let family: HarnessFamily
    let setupLogin: HarnessSetupLoginCapability
    @Binding var showTerminalCaveat: Bool
    let runLogin: () -> Void
    let recheck: () -> Void

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Native setup", systemImage: "person.crop.circle")
                // M9-UX item 4: Log in is THE filled primary; Recheck the quiet secondary.
                HStack(spacing: Theme.Spacing.sm) {
                    Button(action: runLogin) {
                        Label(targetVerified ? "Manage Login" : "Log in", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .controlSize(.large)
                    .disabled(newSetupDisabled)
                    .help(AuthSheetPresentation.nativeLoginHelp(
                        family: family, verified: targetVerified, setupLogin: setupLogin))

                    Button(action: recheck) {
                        Label("Recheck", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .disabled(actionInFlight)
                    .help("Run a fresh, non-cached Harness Doctor probe for installed/authenticated/routable status.")
                    Spacer(minLength: 0)
                }
                DisclosureRow("Advanced — login transport", isExpanded: $showTerminalCaveat) {
                    Text(profileId == nil
                        ? "The engine declares whether managed login runs in-app or needs an attached terminal. Completion is not readiness: only the exact native probe and same-harness smoke mark the session ready."
                        : "The engine owns the login transport and scopes the job to this account. Its doctor probe is the verification truth; the default-route capability smoke does not apply.")
                        .font(.caption2).foregroundStyle(.secondary).padding(.top, Theme.Spacing.xs)
                }
                .font(.caption)
            }
        }
    }
}

// MARK: - API-key fallback panel (same split; the sheet owns the store action).
struct AuthSheetApiKeyPanel: View {
    let name: String
    @Binding var secretValue: String
    let enabled: Bool
    let panelHelp: String
    let storeKey: () -> Void

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("API-key fallback", systemImage: "key")
                SecureField("\(name) key", text: $secretValue).textFieldStyle(.roundedBorder)
                    // Return stores the typed key, the same action as Store Key.
                    .onSubmit { if enabled { storeKey() } }
                Button(action: storeKey) { Label("Store Key", systemImage: "key.fill") }
                    .buttonStyle(.bordered)
                    .disabled(!enabled)
                    .help(panelHelp)
            }
        }
    }
}
