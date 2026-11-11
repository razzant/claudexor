import SwiftUI
import ClaudexorKit

/// Settings › Harnesses: vendor-current installation through the remote
/// engine's adapter declarations and prepared command receipt.
struct RemoteHarnessInstallSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        if !model.remoteConnections.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Remote Harness Install", systemImage: "arrow.down.circle")
                Text(
                    "Installs the vendor's current program on an SSH host, using that host's engine capabilities. Review the vendor command and installation HOME before confirming. Vendor scripts can change between preview and execution; the final receipt records the bytes and program actually used.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(model.remoteConnections) { connection in
                    HStack {
                        Text(connection.displayName)
                        Spacer()
                        RemoteHarnessInstallMenu(connection: connection)
                    }
                    if let message = model.remoteConnectionMessages[connection.id] {
                        // Unclipped and selectable: a refusal's remedy comes last.
                        Text(message).font(.caption2).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(Theme.Spacing.lg)
            .background(
                Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .stroke(Theme.separator, lineWidth: 1))
            .confirmationDialog(
                "Install \(model.remoteHarnessInstallPrompt.map { HarnessFamily(rawValue: $0.harness).label } ?? "harness")?",
                isPresented: Binding(
                    get: { model.remoteHarnessInstallPrompt != nil },
                    set: { presented in
                        guard !presented, let prompt = model.remoteHarnessInstallPrompt else {
                            return
                        }
                        model.dismissRemoteHarnessInstallPrompt(prompt)
                    })
            ) {
                Button("Run installer") {
                    guard let prompt = model.remoteHarnessInstallPrompt,
                          model.acceptRemoteHarnessInstallPrompt(prompt)
                    else { return }
                    Task { await model.confirmRemoteHarnessInstall(prompt) }
                }
                Button("Cancel", role: .cancel) {
                    guard let prompt = model.remoteHarnessInstallPrompt else { return }
                    model.dismissRemoteHarnessInstallPrompt(prompt)
                }
            } message: {
                if let prompt = model.remoteHarnessInstallPrompt {
                    Text(Self.disclosureText(prompt, model: model))
                }
            }
        }
    }

    static func disclosureText(
        _ prompt: RemoteHarnessInstallPrompt, model: AppModel
    ) -> String {
        let host = model.remoteConnections
            .first(where: { $0.id == prompt.connectionID })?.displayName ?? "the remote host"
        let vendor = HarnessFamily(rawValue: prompt.harness).label
        let target = prompt.requestedVersion.map { "Exact vendor version: \($0)" }
            ?? "Vendor's current version at execution"
        return """
        Install \(vendor) on \(host)
        \(target)
        Installation HOME: \(prompt.installationHome)
        \(prompt.commands.map(\.disclosure).joined(separator: "\n\n"))

        The vendor selects its installation folders. Script hashes describe this preview; the final receipt records what ran. Claudexor runs Harness Doctor afterward.
        """
    }
}
