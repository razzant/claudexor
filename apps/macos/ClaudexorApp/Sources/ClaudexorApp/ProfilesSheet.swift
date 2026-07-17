import SwiftUI
import ClaudexorKit

// MARK: - Accounts (credential profiles, INV-135)
//
// The registry + doctor readiness for every registered credential profile,
// with a GUIDED add flow. Registration itself is deliberately server-owned
// config + an interactive vendor login in the operator's terminal
// (ARCHITECTURE Design constraints): vendor OAuth needs the user's
// TTY/browser, so the sheet produces the exact copy-paste steps instead of
// faking an in-app login it cannot honestly drive.

struct ProfilesSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var addHarness = "claude"
    @State private var addId = "work"
    @State private var refreshing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            HStack {
                Text("Accounts").font(.title3.weight(.semibold))
                Spacer()
                Button {
                    refreshing = true
                    Task { await model.refreshCredentialProfiles(); refreshing = false }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(refreshing)
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            Text("Each account is an isolated login (a second Claude/Codex subscription or a stored key). The default vendor login is never touched — accounts are additive.")
                .font(.caption).foregroundStyle(.secondary)

            if model.credentialProfiles.isEmpty {
                Panel {
                    Label("No accounts registered yet — add one below.", systemImage: "person.crop.circle.badge.plus")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(model.credentialProfiles) { entry in
                        profileRow(entry)
                    }
                }
            }

            Divider()
            addSection
        }
        .padding(Theme.Spacing.xl)
        .frame(minWidth: 560, maxWidth: 640)
        .task { await model.refreshCredentialProfiles() }
    }

    private func profileRow(_ entry: CredentialProfileEntry) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Circle()
                .fill(entry.status.availability == "available"
                    ? Theme.status(.succeeded)
                    : entry.status.availability == "unknown" ? Color.orange : Color.red)
                .frame(width: 8, height: 8)
                .help("Readiness: \(entry.status.availability) (\(entry.status.verification))")
            Text(entry.profile.displayName).font(.callout.weight(.medium))
            Text("\(entry.profile.harnessId) · \(humanKind(entry.profile.credentialKind))")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            if let detail = entry.status.detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                    .help(detail)
            }
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.surfaceRaised.opacity(0.35), in: RoundedRectangle(cornerRadius: Theme.Radius.control))
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Add a subscription").font(.headline)
            Text("Two steps in Terminal — the vendor's own login opens your browser; the default login stays untouched.")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: Theme.Spacing.sm) {
                Picker("Harness", selection: $addHarness) {
                    Text("Claude Code").tag("claude")
                    Text("Codex").tag("codex")
                }
                .fixedSize()
                TextField("account id (e.g. work)", text: $addId)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 180)
                    .font(.system(.caption, design: .monospaced))
            }
            stepRow(1, "Register the account (appends to ~/.claudexor/v2/config.yaml):",
                    registerCommand)
            stepRow(2, "Log the account in (interactive vendor login):",
                    "claudexor profiles login \(addHarness) \(sanitizedId)")
            Text("Then press Refresh above — the account appears with a green dot once its login verifies, and shows up in the composer's Account picker.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func stepRow(_ n: Int, _ title: String, _ command: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("\(n). \(title)").font(.caption)
            HStack(spacing: Theme.Spacing.xs) {
                Text(command)
                    .font(.system(.caption2, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(Theme.Spacing.xs)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surfaceRaised.opacity(0.5),
                                in: RoundedRectangle(cornerRadius: Theme.Radius.control))
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy the command")
            }
        }
    }

    private var sanitizedId: String {
        let trimmed = addId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? "work" : trimmed
    }

    private var registerCommand: String {
        let home = "$HOME/.claudexor/profiles/\(addHarness)-\(sanitizedId)"
        return """
        mkdir -p \(home) && cat >> ~/.claudexor/v2/config.yaml <<'EOF'
        credential_profiles:
          - profile_id: \(sanitizedId)
            harness_id: \(addHarness)
            display_name: \(sanitizedId)
            credential_kind: config_dir_login
            isolation_locator: \(home)
        EOF
        """
    }

    private func humanKind(_ kind: String) -> String {
        switch kind {
        case "config_dir_login": return "subscription login"
        case "oauth_token": return "stored OAuth token"
        case "api_key": return "stored API key"
        default: return kind
        }
    }
}
