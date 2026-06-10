import SwiftUI
import AppKit
import ClaudexorKit

struct AuthSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
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
    private var currentInfo: HarnessInfo? { model.harnessInfo(for: family) }
    private var isReady: Bool { currentInfo?.health == .ok }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
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
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("Close \(family.label) Auth.")
            }

            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    HStack {
                        SectionLabel("Readiness", systemImage: isReady ? "checkmark.seal.fill" : "exclamationmark.triangle")
                        Spacer()
                        Label(currentInfo?.health.rawValue.capitalized ?? "Unknown", systemImage: currentInfo?.health.glyph ?? "questionmark.circle")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(currentInfo?.health.color ?? .secondary)
                    }
                    Text(currentInfo?.auth ?? "Harness Doctor has not loaded this harness yet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let reasons = currentInfo?.reasons, !reasons.isEmpty {
                        Text(reasons.joined(separator: "\n"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    if let checks = currentInfo?.checks, !checks.isEmpty {
                        Text("Doctor checks: \(checks.joined(separator: ", "))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }

            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    SectionLabel("Native setup", systemImage: "terminal")
                    HStack(spacing: Theme.Spacing.sm) {
                        Button { Task { await runLogin() } } label: {
                            Label(isReady ? "Manage Login" : "Login", systemImage: "person.crop.circle.badge.checkmark")
                        }
                        .buttonStyle(.bordered)
                        .disabled(running)
                        .help(isReady ? "Open the native \(family.label) login/setup flow for account management." : "Start the native \(family.label) login flow.")

                        Button { Task { await runInstall() } } label: {
                            Label(installReadyToConfirm ? "Confirm Install" : "Install", systemImage: installReadyToConfirm ? "checkmark.shield" : "arrow.down.circle")
                        }
                        .buttonStyle(.bordered)
                        .disabled(running)
                        .help(installReadyToConfirm ? "Confirm the allowlisted install job after reviewing risk flags." : "Prepare an allowlisted \(family.label) install job.")

                        Button { Task { await recheck() } } label: {
                            Label("Recheck", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accent)
                        .disabled(running)
                        .help("Refresh installed/authenticated/ready status with the harness doctor.")
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
                        Label(job.state, systemImage: setupJobGlyph(job.state))
                            .font(.caption)
                            .foregroundStyle(setupJobColor(job.state))
                        Text(job.message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                            Text("Created: \(job.createdAt)")
                            if let started = job.startedAt { Text("Started: \(started)") }
                            if let first = job.firstOutputAt { Text("First output: \(first)") }
                            if let latest = job.lastOutputAt { Text("Latest output: \(latest)") }
                            if let finished = job.finishedAt { Text("Finished: \(finished)") }
                            if let retry = job.retryCount, retry > 0 { Text("Retries: \(retry)") }
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
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
                        .help("Store this fallback API key in the local secret store, then run the harness doctor.")
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

            Divider().overlay(Theme.separator)
            HStack {
                if running {
                    Label(lastSetupJob.map { "Setup job \($0.state)" } ?? "Setup job running", systemImage: "circle.dotted")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .help("Close this auth sheet.")
            }
            .padding(Theme.Spacing.lg)
        }
        .frame(width: 560)
    }

    private static let terminalJobStates: Set<String> = ["succeeded", "failed", "cancelled", "timed_out", "not_supported"]

    private func runLogin() async {
        running = true
        defer { running = false }
        guard let job = await model.startSetupJob(family: family, action: "login") else {
            status = model.settingsStatus ?? "Could not start login setup job."
            return
        }
        lastSetupJob = job
        status = job.message
        await pollSetupJob(job)
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
        await pollSetupJob(job)
    }

    /// Track the daemon-owned job to its terminal state so the sheet reflects
    /// reality (a job stuck on "running" forever was a UX lie), then recheck doctor.
    private func pollSetupJob(_ initial: SetupJob) async {
        var current = initial
        while !Self.terminalJobStates.contains(current.state) && current.state != "waiting_for_input" {
            try? await Task.sleep(for: .seconds(1.5))
            guard let next = await model.setupJobStatus(current.jobId) else { break }
            current = next
            lastSetupJob = next
            status = next.message
        }
        if Self.terminalJobStates.contains(current.state) {
            await model.refreshHarnesses()
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
                await pollSetupJob(job)
            } else {
                status = "Stored secret ref: \(name). Reconnect the engine to recheck \(family.label)."
            }
        } else {
            status = "Could not store \(name); reconnect the local engine and try again."
        }
    }

    private func setupJobGlyph(_ state: String) -> String {
        switch state {
        case "running": return "play.circle"
        case "waiting_for_input": return "person.crop.circle.badge.questionmark"
        case "succeeded": return "checkmark.circle.fill"
        case "failed": return "xmark.octagon.fill"
        case "cancelled": return "stop.circle"
        default: return "circle"
        }
    }

    private func setupJobColor(_ state: String) -> Color {
        switch state {
        case "succeeded": return Theme.status(.succeeded)
        case "failed": return Theme.status(.failed)
        case "waiting_for_input": return Theme.status(.blocked)
        case "running": return Theme.status(.running)
        default: return .secondary
        }
    }
}
