import ClaudexorKit
import SwiftUI

/// Capabilities come from the remote adapter registry, including future vendors.
struct RemoteInstallInventory: Decodable {
    struct Entry: Decodable, Identifiable {
        struct Actions: Decodable {
            struct Action: Decodable { let available: Bool; let reason: String? }
            let install: Action
        }
        let harness: String
        let actions: Actions
        var id: String { harness }
    }
    let harnesses: [Entry]
}

struct RemoteHarnessInstallMenu: View {
    @Environment(AppModel.self) private var model
    let connection: RemoteConnection
    @State private var entries: [RemoteInstallInventory.Entry] = []
    @State private var problem: String?

    var body: some View {
        Menu("Install…") {
            ForEach(entries) { entry in
                Button(HarnessFamily(rawValue: entry.harness).label) {
                    Task { await model.startRemoteHarnessInstall(
                        connectionID: connection.id, harness: entry.harness) }
                }
                .disabled(!entry.actions.install.available)
                .help(entry.actions.install.reason ?? "Install the vendor's current program")
            }
            if let problem { Text(problem) }
            Divider()
            Button("Refresh programs") { Task { await refresh() } }
        }
        .frame(maxWidth: 140)
        .task(id: model.remoteConnectionGenerations[connection.id]) { await refresh() }
    }

    private func refresh() async {
        let generation = model.remoteConnectionGenerations[connection.id]
        do {
            let pointer = try await model.sshConnectionManager.execute(
                connection, remoteCommand: RemoteRuntimeInstaller.currentPointerProbeCommand)
            guard let runtime = try RemoteRuntimeInstaller.currentPointerTarget(fromProbe: pointer.stdout)
            else { throw SSHConnectionError.unavailable("Install the remote runtime first.") }
            let output = try await model.sshConnectionManager.execute(
                connection, remoteCommand: remoteRuntimeCLI(runtime) + " harness inspect --json")
            let inventory = try JSONDecoder().decode(RemoteInstallInventory.self, from: output.stdout)
            guard model.remoteConnectionGenerations[connection.id] == generation else { return }
            entries = inventory.harnesses
            problem = nil
        } catch {
            guard model.remoteConnectionGenerations[connection.id] == generation else { return }
            entries = []
            problem = "Program inventory unavailable. Refresh or update the remote runtime."
        }
    }
}
