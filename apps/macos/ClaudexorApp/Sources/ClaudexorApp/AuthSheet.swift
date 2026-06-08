import SwiftUI
import AppKit
import ClaudexorKit

struct AuthSheet: View {
    @Environment(AppModel.self) private var model
    let family: HarnessFamily
    @State private var secretValue = ""
    @State private var status = ""
    @State private var running = false
    @State private var installReadyToConfirm = false
    @State private var lastSetupJob: SetupJob?

    private var secretName: String? {
        switch family {
        case .codex: return "openai"
        case .claude: return "anthropic"
        case .cursor: return "cursor"
        case .opencode: return "opencode"
        case .raw: return "raw"
        case .fake: return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            HStack(spacing: Theme.Spacing.md) {
                HarnessLogo(family: family, size: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(family.label) Auth")
                        .font(.title3.weight(.semibold))
                    Text("Native session first; API-key fallback only through the local secret store.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Native setup", systemImage: "terminal")
                    HStack(spacing: Theme.Spacing.sm) {
                        Button { Task { await runLogin() } } label: {
                            Label("Login", systemImage: "person.crop.circle.badge.checkmark")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accent)
                        .disabled(running)

                        Button { Task { await runInstall() } } label: {
                            Label(installReadyToConfirm ? "Confirm Install" : "Install", systemImage: installReadyToConfirm ? "checkmark.shield" : "arrow.down.circle")
                        }
                        .buttonStyle(.bordered)
                        .disabled(running)

                        Button { Task { await recheck() } } label: {
                            Label("Recheck", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.bordered)
                        .disabled(running)
                    }
                    Text("Install and login use daemon-owned allowlisted jobs. Install shows risk flags before execution; Claudexor does not prefix setup commands with sudo.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if let job = lastSetupJob {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        SectionLabel("Setup job", systemImage: "list.bullet.rectangle")
                        Text(job.message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let command = job.command {
                            Text(command)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                        }
                        if !job.riskFlags.isEmpty {
                            Text("Risks: \(job.riskFlags.joined(separator: ", "))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        if let log = job.logPath {
                            Text("Log: \(log)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }

            if let secretName {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        SectionLabel("API-key fallback", systemImage: "key")
                        SecureField("\(secretName) key", text: $secretValue)
                            .textFieldStyle(.roundedBorder)
                        Button { Task { await storeKey(secretName) } } label: {
                            Label("Store Key", systemImage: "key.fill")
                        }
                        .buttonStyle(.bordered)
                        .disabled(secretValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || running)
                    }
                }
            }

            if !status.isEmpty {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(Theme.Spacing.xl)
        .frame(width: 560)
    }

    private func runLogin() async {
        running = true
        defer { running = false }
        guard let job = await model.startSetupJob(family: family, action: "login") else {
            status = model.settingsStatus ?? "Could not start login setup job."
            return
        }
        lastSetupJob = job
        status = job.message
    }

    private func runInstall() async {
        running = true
        defer { running = false }
        let job: SetupJob?
        if installReadyToConfirm, let pending = lastSetupJob, pending.action == "install" {
            job = await model.confirmSetupJob(pending.jobId)
        } else {
            job = await model.startSetupJob(family: family, action: "install")
        }
        guard let job else {
            status = model.settingsStatus ?? "Could not start install setup job."
            return
        }
        lastSetupJob = job
        status = job.message
        installReadyToConfirm = job.requiresConfirmation
        if job.state == "succeeded" || job.state == "running" {
            installReadyToConfirm = false
        }
        if job.state == "not_supported", let raw = job.guideUrl, let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
        }
    }

    private func recheck() async {
        running = true
        defer { running = false }
        await model.refreshHarnesses()
        status = "Rechecked \(family.label)."
    }

    private func storeKey(_ name: String) async {
        running = true
        defer { running = false }
        let value = secretValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        if await model.storeSecret(name: name, value: value) {
            secretValue = ""
            if let job = await model.startSetupJob(family: family, action: "store_key") {
                lastSetupJob = job
                status = job.message
            } else {
                status = "Stored secret ref: \(name). Reconnect the engine to recheck \(family.label)."
            }
        } else {
            status = "Could not store \(name); reconnect the local engine and try again."
        }
    }
}
