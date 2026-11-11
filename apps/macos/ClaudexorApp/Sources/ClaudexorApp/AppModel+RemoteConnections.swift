import ClaudexorKit
import Foundation

extension AppModel {
    func refreshSSHHosts() {
        sshHostScan = SSHHostScanState.scan()
    }

    /// "Create & Add" in ONE step: append the `Host` block through the Kit
    /// writer, rescan, and immediately create the `RemoteConnection`. Typed
    /// writer refusals propagate to the sheet (mapped to their owning field);
    /// a write-succeeded-but-add-failed partial outcome is carried on the
    /// receipt explicitly — never silently lost.
    func createSSHHostConnection(_ draft: SSHHostDraft) throws -> SSHHostCreationReceipt {
        let receipt = try SSHConfigWriter().appendHost(draft)
        refreshSSHHosts()
        let failure = addRemoteConnection(alias: receipt.alias)
        return SSHHostCreationReceipt(
            alias: receipt.alias,
            configPath: receipt.configPath,
            backupPath: receipt.backupPath,
            createdConfig: receipt.createdConfig,
            appendedBlock: receipt.appendedBlock,
            connectionFailure: failure)
    }

    /// Add an execution location for a config alias. Returns nil on success or
    /// the user-facing refusal reason — callers surface it (the old Void
    /// signature parked the OpenSSH resolve failure under a random UUID key
    /// that no view ever read).
    @discardableResult
    func addRemoteConnection(alias: String) -> String? {
        guard SSHConfigScanner.isConcreteAlias(alias) else {
            return "“\(alias)” is not a concrete Host alias."
        }
        guard !remoteConnections.contains(where: { $0.sshAlias == alias }) else {
            return "“\(alias)” is already added as a connection."
        }
        // Resolve with OpenSSH before persisting. This catches misspelled aliases
        // while preserving all key/agent/ProxyJump semantics in ssh itself.
        guard (try? OpenSSHResolver().resolve(alias: alias)) != nil else {
            return "OpenSSH could not resolve “\(alias)”."
        }
        remoteConnections.append(RemoteConnection(sshAlias: alias))
        persistRemoteConnections()
        return nil
    }

    func removeRemoteConnection(_ id: UUID) async {
        await disconnectRemote(id)
        remoteConnections.removeAll { $0.id == id }
        remoteThreadCache.removeAll { $0.locationID.remoteConnectionID == id }
        persistRemoteConnections()
        persistRemoteThreadCache()
    }

    func setRemoteNickname(_ id: UUID, nickname: String) {
        mutateRemoteConnection(id) {
            $0.nickname = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    func setRemoteEnabled(_ id: UUID, enabled: Bool) {
        mutateRemoteConnection(id) { $0.enabled = enabled }
    }

    func setRemoteState(
        _ id: UUID,
        _ state: RemoteConnectionState,
        message: String
    ) {
        mutateRemoteConnection(id) { $0.status = state }
        remoteConnectionMessages[id] = message
    }

    func mutateRemoteConnection(
        _ id: UUID,
        mutation: (inout RemoteConnection) -> Void
    ) {
        guard let index = remoteConnections.firstIndex(where: { $0.id == id }) else { return }
        mutation(&remoteConnections[index])
        persistRemoteConnections()
    }

    private func persistRemoteConnections() {
        try? persistence.remoteConnections?().save(remoteConnections)
    }

    func userMessageForRemote(_ error: Error) -> String {
        if isRecoverableRemoteTransportFailure(error) {
            return "The SSH tunnel is unavailable. Reconnect the host."
        }
        if let localized = error as? LocalizedError,
           let detail = localized.errorDescription, !detail.isEmpty
        {
            return detail
        }
        return userMessage(for: error)
    }
}
