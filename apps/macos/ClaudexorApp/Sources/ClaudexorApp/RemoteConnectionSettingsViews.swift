import AppKit
import ClaudexorKit
import SwiftUI

struct ConnectionsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedAlias = ""
    @State private var showNewHostSheet = false
    @State private var addFailure: String?
    @State private var creationReceipt: SSHHostCreationReceipt?

    private var picker: SSHHostPickerPresentation {
        SSHHostPickerPresentation.present(
            scan: model.sshHostScan,
            addedAliases: Set(model.remoteConnections.map(\.sshAlias)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            // The same shell every other Settings section uses (SettingsGroup):
            // this pane used to hand-copy the recipe and read as a different app.
            SettingsGroup("SSH Connections", systemImage: "network") {
                Text(
                    "Hosts come from ~/.ssh/config. Claudexor delegates keys, ssh-agent, known_hosts, MFA, ProxyJump, and ProxyCommand to /usr/bin/ssh.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // Wrap instead of clipping: this sentence is longer than the
                    // Settings column, and clipped text is a visual-QA blocker.
                    .fixedSize(horizontal: false, vertical: true)
                // Two paths, one mental model: add an EXISTING alias directly
                // (app-local, immediate), or create a NEW host in a sheet (a
                // five-field ~/.ssh/config mutation). Never one behind the other.
                OptionRow(label: "From config", labelWidth: 84) {
                    Picker("SSH host", selection: $selectedAlias) {
                        Text(picker.placeholder).tag("")
                        ForEach(picker.addable) { host in
                            Text(host.alias).tag(host.alias)
                        }
                    }
                    .labelsHidden()
                    .frame(width: Theme.Layout.modelPickerWidth, alignment: .leading)
                    .disabled(picker.addable.isEmpty)
                    .help(picker.help)
                    Button {
                        addFailure = model.addRemoteConnection(alias: selectedAlias)
                        if addFailure == nil { selectedAlias = "" }
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                    .buttonStyle(.bordered)
                    .disabled(selectedAlias.isEmpty)
                    // A disabled control must say why it is disabled — and the
                    // reason must be the REAL scan state, not a guess.
                    .help(picker.addable.isEmpty ? picker.help
                        : "Choose an alias first, then add it as an execution location.")
                    Button {
                        model.refreshSSHHosts()
                    } label: {
                        Label("Rescan", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .help("Re-read ~/.ssh/config.")
                }
                OptionRow(label: "New host", labelWidth: 84) {
                    Button("New SSH Host…") { showNewHostSheet = true }
                        .buttonStyle(.bordered)
                        .help(
                            "Create a Host entry in ~/.ssh/config and add it as a connection in one step.")
                }
                if let failure = picker.inlineFailure ?? addFailure {
                    // A failed scan or a refused add is a visible error, never
                    // a silently quieter picker.
                    Text(failure)
                        .font(.caption)
                        .foregroundStyle(Theme.status(.negative))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let creationReceipt {
                SSHHostReceiptCard(receipt: creationReceipt) {
                    self.creationReceipt = nil
                }
            }

            if model.remoteConnections.isEmpty {
                // Empty states name the ACTION: the same primary CTA as above,
                // so the first useful step is never visually remote.
                ContentUnavailableView {
                    Label("No remote connections", systemImage: "network.slash")
                } description: {
                    Text(
                        "Create one here, or add a Host block to ~/.ssh/config yourself and press Rescan. Pattern hosts (wildcards) stay hidden — only concrete aliases can become connections.")
                } actions: {
                    Button("New SSH Host…") { showNewHostSheet = true }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accentSolid)
                }
            } else {
                ForEach(model.remoteConnections) { connection in
                    RemoteConnectionSettingsRow(connectionID: connection.id)
                }
            }
        }
        .sheet(isPresented: $showNewHostSheet) {
            NewSSHHostSheet { receipt in
                creationReceipt = receipt
                addFailure = nil
            }
        }
    }
}

/// The dismissible post-creation receipt: exactly which file was written,
/// whether a backup existed (never claimed when the config was just created),
/// and — explicitly — a written-but-not-added partial outcome.
private struct SSHHostReceiptCard: View {
    let receipt: SSHHostCreationReceipt
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(
                    systemName: receipt.connectionFailure == nil
                        ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(
                        receipt.connectionFailure == nil
                            ? Theme.status(.positive) : Theme.status(.caution))
                Text(receipt.headline).font(.callout.weight(.medium))
                Spacer()
                Button {
                    copyBlock()
                } label: {
                    Label("Copy Block", systemImage: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy the exact appended Host block.")
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("Dismiss this receipt.")
            }
            ForEach(receipt.detailLines, id: \.self) { line in
                Text(line)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Theme.Spacing.lg)
        .background(
            Theme.surfaceRaised,
            in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                .stroke(Theme.separator, lineWidth: 1))
    }

    private func copyBlock() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(receipt.appendedBlock, forType: .string)
    }
}

private struct RemoteConnectionSettingsRow: View {
    @Environment(AppModel.self) private var model
    let connectionID: UUID
    @State private var nickname = ""
    @State private var confirmRemoval = false
    @State private var confirmInstall = false

    private var connection: RemoteConnection? {
        model.remoteConnections.first { $0.id == connectionID }
    }

    var body: some View {
        if let connection {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                // The identity+status+control header is the row class the SSOT
                // assigns to AlignedListRow (§2.8) — dot + title + single-line
                // details, controls on a shared trailing edge, no Spacer() push.
                AlignedList {
                    AlignedListRow(
                        identity: AlignedRowIdentity(
                            dotColor: statusColor(connection.status),
                            dotHelp: statusLabel(connection.status),
                            title: connection.displayName,
                            badges: [
                                AlignedRowBadge(statusLabel(connection.status)),
                            ],
                            details: [AlignedRowDetail(0, connection.sshAlias)])
                    ) {
                        if connection.status == .connected {
                            Button("Disconnect") {
                                Task { await model.disconnectRemote(connectionID) }
                            }
                            .alignedControlColumn(minWidth: 96, alignment: .trailing)
                        } else {
                            Button("Connect") {
                                Task { await model.connectRemote(connectionID) }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.accentSolid)
                            .disabled(
                                connection.status == .connecting
                                    || connection.status == .installing)
                            .alignedControlColumn(minWidth: 96, alignment: .trailing)
                        }
                    }
                }
                HStack {
                    TextField("Nickname", text: $nickname)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            model.setRemoteNickname(connectionID, nickname: nickname)
                        }
                    Button("Save name") {
                        model.setRemoteNickname(connectionID, nickname: nickname)
                    }
                }
                Toggle(
                    "Connect automatically when the app opens",
                    isOn: Binding(
                        get: { connection.enabled },
                        set: { model.setRemoteEnabled(connectionID, enabled: $0) }))
                    .toggleStyle(.switch)
                HStack {
                    Button("Harness Doctor") {
                        Task { await model.runRemoteHarnessDoctor(connectionID: connectionID) }
                    }
                    Button("Install runtime…") { confirmInstall = true }
                        .disabled(
                            connection.status == .connecting
                                || connection.status == .installing)
                    Menu("Login") {
                        Button("Claude") {
                            Task {
                                await model.startRemoteLogin(
                                    connectionID: connectionID, harness: .claude)
                            }
                        }
                        Button("Codex (device code)") {
                            Task {
                                await model.startRemoteLogin(
                                    connectionID: connectionID, harness: .codex)
                            }
                        }
                        Button("Cursor") {
                            Task {
                                await model.startRemoteLogin(
                                    connectionID: connectionID, harness: .cursor)
                            }
                        }
                    }
                    Spacer()
                    Button("Remove…", role: .destructive) { confirmRemoval = true }
                }
                if let runtime = connection.runtimeVersion {
                    Text("Remote runtime \(runtime)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if !connection.savedProjects.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text("Saved projects").font(.caption.weight(.semibold))
                        ForEach(connection.savedProjects, id: \.self) { path in
                            Text(path)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                if let message = model.remoteConnectionMessages[connectionID] {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(
                            connection.status == .failed
                                ? Theme.status(.negative) : Color.secondary)
                        .textSelection(.enabled)
                        // ssh failure text is server-influenced and arbitrarily
                        // long; wrap it rather than clipping the one line that
                        // explains why a connection failed.
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding()
            .background(
                Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
            .onAppear { nickname = connection.nickname ?? "" }
            .confirmationDialog(
                "Install the signed Claudexor runtime on \(connection.displayName)?",
                isPresented: $confirmInstall
            ) {
                Button("Install") {
                    Task { await model.installRemoteRuntime(connectionID: connectionID) }
                }
                .disabled(
                    connection.status == .connecting
                        || connection.status == .installing)
            } message: {
                Text(
                    "It installs without sudo under ~/.claudexor/remote/versions and atomically updates the current pointer.")
            }
            .confirmationDialog(
                "Remove \(connection.displayName)?",
                isPresented: $confirmRemoval
            ) {
                Button("Remove connection", role: .destructive) {
                    Task { await model.removeRemoteConnection(connectionID) }
                }
            } message: {
                Text(
                    "This removes local connection metadata and cached thread titles. Nothing is deleted from the server.")
            }
        }
    }

    private func statusLabel(_ state: RemoteConnectionState) -> String {
        switch state {
        case .offline: "Offline"
        case .connecting: "Connecting"
        case .needsInteraction: "Needs authentication"
        case .installing: "Installing"
        case .connected: "Connected"
        case .failed: "Failed"
        }
    }

    /// The documented Connections status ladder (DESIGN_SYSTEM §5): muted for
    /// Offline, accent while Connecting/Installing, warning for Needs
    /// authentication, success for Connected, danger for Failed — always a dot
    /// PLUS its label, never a bare color. A dot fill, so status tones use
    /// `statusFill`.
    private func statusColor(_ state: RemoteConnectionState) -> SwiftUI.Color {
        switch state {
        case .offline: Color.secondary
        case .connecting, .installing: Theme.accent
        case .needsInteraction: Theme.statusFill(.caution)
        case .connected: Theme.statusFill(.positive)
        case .failed: Theme.statusFill(.negative)
        }
    }
}
