import ClaudexorKit
import Foundation

struct RemoteNativeLoginReadiness: Equatable {
    let nativeSessionVerified: Bool
    let harnessRoutable: Bool

    static func profile(_ entry: CredentialProfileEntry) -> Self {
        let available = entry.status.availability == "available"
        let verified = available && entry.status.verification == "passed"
        return Self(
            nativeSessionVerified: verified,
            harnessRoutable: entry.profile.enabled && verified)
    }
}

/// The step a remote install names when Harness Doctor finds the harness but
/// it is not ready. A family without a native login flow (no `SetupHarness`
/// case: opencode, copilot) can only get ready through stored credentials, so
/// it is never sent to the Login menu.
func remoteInstallNextStep(harness: String, displayName: String) -> String {
    SetupHarness(rawValue: harness) == nil
        ? "Configure its provider credentials."
        : "Use Login → \(displayName)."
}

extension AppModel {
    func startRemoteLogin(
        connectionID: UUID,
        harness: SetupHarness,
        profileID: String? = nil
    ) async {
        let location = ExecutionLocationID.remote(connectionID)
        guard remoteConnections.contains(where: { $0.id == connectionID }) else { return }
        guard let admittedLease = beginRemoteAction(.setupLogin, connectionID: connectionID)
        else { return }
        // Admit before the first suspension so invocation order, rather than
        // reconnect scheduling order, defines which login is newest.
        remoteDeviceLogin = nil
        if let request = remoteTerminalSheet,
           case .setup = request.purpose
        {
            dismissRemoteTerminal(request)
        }
        let routingDecision = await RemoteSetupLoginRouting
            .decisionAfterLoadingCurrentProjection(harness: harness) {
                if remoteClients[location] == nil { await connectRemote(connectionID) }
                guard remoteClients[location] != nil else { return nil }
                if remoteHarnessReadinessFresh[location] != true {
                    _ = await refreshHarnesses(
                        fresh: true, locationID: location, markStaleOnFailure: true)
                }
                guard remoteHarnessReadinessFresh[location] == true else { return nil }
                return remoteHarnesses[location]
            }
        guard let reboundLease = rebindRemoteActionToCurrentGeneration(admittedLease) else {
            finishRemoteAction(admittedLease)
            return
        }
        guard let connection = remoteConnections.first(where: { $0.id == connectionID }),
              let client = remoteClients[location]
        else {
            finishRemoteAction(reboundLease)
            return
        }
        let lease = reboundLease
        let transport: SetupJobTransport
        switch routingDecision {
        case .unavailable(let message):
            remoteConnectionMessages[connectionID] = message
            finishRemoteAction(lease)
            return
        case .transport(let selected):
            transport = selected
        }
        let codexLoginFlow: SetupCodexLoginFlow? = harness == .codex
            ? (transport == .daemon ? .deviceAuth : .browserRedirect)
            : nil
        let terminalPresentation =
            transport == .clientPty
            ? beginRemoteTerminalPresentation(connectionID: connectionID)
            : nil
        // Selection consumed the current daemon projection. Retire it only
        // after that decision so a cold reconnect cannot be mistaken for a
        // legacy engine whose decoded row genuinely omitted setupLogin.
        retireHarnessProjection(at: location)
        let setupTarget = RemoteSetupLoginTarget(
            connectionID: connectionID,
            harness: harness.rawValue,
            profileID: profileID,
            transport: transport.rawValue,
            loginFlow: codexLoginFlow?.rawValue)
        beginRemoteSetupJobOwnership(lease: lease, target: setupTarget)
        var createdJobID: String?
        var handedOff = false
        defer {
            if let jobID = finishRemoteSetupJobOwnership(
                lease: lease,
                target: setupTarget,
                createdJobID: createdJobID,
                handedOff: handedOff)
            {
                Task { _ = try? await client.cancelSetupJob(jobId: jobID) }
            }
            if !handedOff, let terminalPresentation {
                finishRemoteTerminalPresentation(terminalPresentation)
            }
        }
        do {
            let job = try await client.createSetupJob(SetupJobCreateRequest(
                harness: harness,
                action: .login,
                profileId: profileID,
                loginFlow: codexLoginFlow,
                transport: transport))
            createdJobID = job.jobId
            recordRemoteSetupJob(job.jobId, lease: lease, target: setupTarget)
            guard remoteActionIsCurrent(lease, client: client) else { return }
            if transport == .clientPty {
                guard let terminalPresentation,
                      remoteTerminalPresentationIsCurrent(terminalPresentation)
                else {
                    finishRemoteAction(lease)
                    return
                }
                let invocation = try await sshConnectionManager.setupAttachInvocation(
                    connection, jobID: job.jobId)
                guard remoteActionIsCurrent(lease, client: client),
                      remoteTerminalPresentationIsCurrent(terminalPresentation)
                else {
                    finishRemoteAction(lease)
                    return
                }
                guard presentRemoteTerminal(
                    terminalPresentation,
                    title: "\(HarnessFamily(rawValue: harness.rawValue).label) login — \(connection.displayName)",
                    invocation: invocation,
                    purpose: .setup(lease, job.jobId))
                else {
                    finishRemoteAction(lease)
                    return
                }
                handedOff = true
            } else {
                remoteConnectionMessages[connectionID] =
                    "\(HarnessFamily(rawValue: harness.rawValue).label) sign-in started."
                remoteDeviceLogin = RemoteDeviceLoginRequest(
                    lease: lease, jobID: job.jobId, initialJob: job)
                handedOff = true
            }
        } catch {
            guard remoteActionIsCurrent(lease, client: client) else { return }
            if let terminalPresentation {
                guard remoteTerminalPresentationIsCurrent(terminalPresentation) else {
                    finishRemoteAction(lease)
                    return
                }
                finishRemoteTerminalPresentation(terminalPresentation)
            }
            remoteConnectionMessages[connectionID] = userMessageForRemote(error)
            finishRemoteAction(lease)
        }
    }

    func runRemoteHarnessDoctor(
        connectionID: UUID,
        actionLease: RemoteActionLease? = nil
    ) async {
        let location = ExecutionLocationID.remote(connectionID)
        if remoteClients[location] == nil { await connectRemote(connectionID) }
        guard let client = remoteClients[location] else { return }
        if let actionLease {
            guard remoteActionIsCurrent(actionLease, client: client) else { return }
        }
        guard await refreshHarnesses(
            fresh: true, locationID: location, markStaleOnFailure: true),
            isCurrentGateway(client, at: location)
        else {
            if isCurrentGateway(client, at: location),
               actionLease.map({ remoteActionIsCurrent($0, client: client) }) ?? true
            {
                remoteConnectionMessages[connectionID] = "Harness Doctor could not refresh. Retry."
            }
            return
        }
        if let actionLease {
            guard remoteActionIsCurrent(actionLease, client: client) else { return }
        }
        let harnesses = remoteHarnesses[location] ?? []
        let ready = harnesses.filter { !$0.routableIntents.isEmpty }.count
        remoteConnectionMessages[connectionID] =
            "Harness Doctor: \(ready) of \(harnesses.count) harnesses ready."
    }

    func finishRemoteSetup(_ lease: RemoteActionLease) async {
        guard remoteActionIsCurrent(lease) else { return }
        await runRemoteHarnessDoctor(
            connectionID: lease.connectionID,
            actionLease: lease)
        finishRemoteAction(lease)
    }

    /// Fetch the remote runtime's own install disclosure and surface it for
    /// confirmation. Nothing executes here: the actual installer starts only
    /// from `confirmRemoteHarnessInstall`. A missing runtime or an
    /// unparseable disclosure is a loud typed message, never a silent no-op.
    func startRemoteHarnessInstall(connectionID: UUID, harness: String) async {
        // Both refusals go to threadStatus, the connection-INDEPENDENT
        // surface: a message keyed to a vanished connection would render
        // under a ForEach row that no longer exists — silently.
        guard remoteConnections.contains(where: { $0.id == connectionID }) else {
            threadStatus = "That connection no longer exists; nothing was installed."
            return
        }
        guard let admittedLease = beginRemoteAction(
            .harnessInstall, connectionID: connectionID)
        else { return }
        // Admit before reconnect so two rapid install requests retain the
        // user's invocation order across suspension.
        remoteHarnessInstallPrompt = nil
        if let purpose = settingsRemoteTerminalSheet?.purpose,
           case .install = purpose
        {
            settingsRemoteTerminalSheet = nil
        }
        retireHarnessProjection(at: .remote(connectionID))
        if remoteClients[.remote(connectionID)] == nil {
            await connectRemote(connectionID)
        }
        guard let reboundLease = rebindRemoteActionToCurrentGeneration(admittedLease) else {
            finishRemoteAction(admittedLease)
            return
        }
        guard let connection = remoteConnections.first(where: { $0.id == connectionID }) else {
            finishRemoteAction(reboundLease)
            return
        }
        let lease = reboundLease
        do {
            let pointer = try await sshConnectionManager.execute(
                connection, remoteCommand: RemoteRuntimeInstaller.currentPointerProbeCommand)
            guard remoteActionIsCurrent(lease) else { return }
            guard let runtimeTarget = try RemoteRuntimeInstaller.currentPointerTarget(
                fromProbe: pointer.stdout)
            else {
                remoteConnectionMessages[connectionID] =
                    "No Claudexor runtime is installed on this host; nothing was installed."
                finishRemoteAction(lease)
                return
            }
            let dryRun = remoteRuntimeCLI(runtimeTarget) + " harness install "
                + SSHCommandFactory.posixQuote(harness) + " --dry-run --json"
            let output = try await sshConnectionManager.execute(
                connection, remoteCommand: dryRun)
            guard remoteActionIsCurrent(lease) else { return }
            guard let prompt = Self.parseHarnessInstallDisclosure(
                output.stdout, lease: lease, harness: harness, runtimeTarget: runtimeTarget)
            else {
                remoteConnectionMessages[connectionID] =
                    "The remote runtime did not return an install disclosure for "
                    + "\(harness); nothing was installed."
                finishRemoteAction(lease)
                return
            }
            remoteHarnessInstallPrompt = prompt
        } catch {
            guard remoteActionIsCurrent(lease) else { return }
            remoteConnectionMessages[connectionID] =
                Self.harnessInstallPreparationFailure(error, harness: harness)
                ?? userMessageForRemote(error)
            finishRemoteAction(lease)
        }
    }

    /// Run the CONFIRMED install in the visible embedded PTY. `--yes` is
    /// authorized here: the user approved the remote CLI's vendor-current or
    /// exact-version operation. Its receipt prints in the terminal.
    func confirmRemoteHarnessInstall(_ prompt: RemoteHarnessInstallPrompt) async {
        guard remoteActionIsCurrent(prompt.lease) else { return }
        if remoteHarnessInstallPrompt?.lease == prompt.lease {
            remoteHarnessInstallPrompt = nil
        }
        guard let connection = remoteConnections.first(where: {
            $0.id == prompt.connectionID
        }) else {
            // threadStatus, not remoteConnectionMessages: the row that would
            // render a per-connection message is exactly what vanished.
            threadStatus = "That connection no longer exists; nothing was installed."
            return
        }
        do {
            let factory = try await sshConnectionManager.factory(for: connection)
            guard remoteActionIsCurrent(prompt.lease) else { return }
            settingsRemoteTerminalSheet = RemoteTerminalSheetRequest(
                title: "Install \(HarnessFamily(rawValue: prompt.harness).label) — \(connection.displayName)",
                invocation: factory.remoteCommand(prompt.confirmedInstallCommand, requestTTY: true),
                purpose: .install(prompt.lease, prompt.harness))
        } catch {
            guard remoteActionIsCurrent(prompt.lease) else { return }
            remoteConnectionMessages[prompt.connectionID] = userMessageForRemote(error)
            finishRemoteAction(prompt.lease)
        }
    }

    func finishRemoteHarnessInstall(
        lease: RemoteActionLease,
        harness: String,
        exitCode: Int32
    ) async {
        guard remoteActionIsCurrent(lease) else { return }
        let connectionID = lease.connectionID
        let displayName = HarnessFamily(rawValue: harness).label
        guard exitCode == 0 else {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installer failed with exit code \(exitCode)."
            finishRemoteAction(lease)
            return
        }
        let location = ExecutionLocationID.remote(connectionID)
        guard let client = remoteClients[location] else {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installed, but the remote connection is unavailable for Harness Doctor."
            finishRemoteAction(lease)
            return
        }
        guard await refreshHarnesses(
            fresh: true, locationID: location, markStaleOnFailure: true),
            remoteActionIsCurrent(lease, client: client)
        else {
            guard remoteActionIsCurrent(lease, client: client) else { return }
            remoteConnectionMessages[connectionID] =
                "\(displayName) installed, but Harness Doctor could not refresh. Retry."
            finishRemoteAction(lease)
            return
        }
        guard let result = remoteHarnesses[location]?.first(where: {
            $0.family.rawValue == harness
        }) else {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installer finished, but Harness Doctor did not return that harness."
            finishRemoteAction(lease)
            return
        }
        let installed = result.readiness.first(where: { $0.id == "installed" })
        if installed?.status != "pass" {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installer finished, but Harness Doctor still cannot find it"
                + (installed.flatMap(\.detail).map { ": \($0)" } ?? "") + "."
        } else if !result.routableIntents.isEmpty {
            remoteConnectionMessages[connectionID] =
                "\(displayName) installed and ready."
        } else {
            let reason = result.reasons.first ?? "authentication is still required"
            let nextStep = remoteInstallNextStep(harness: harness, displayName: displayName)
            remoteConnectionMessages[connectionID] =
                "\(displayName) installed, but is not ready: \(reason). \(nextStep)"
        }
        finishRemoteAction(lease)
    }

    func refreshRemoteNativeLoginReadiness(
        connectionID: UUID,
        harnessID: String,
        profileID: String? = nil,
        actionLease: RemoteActionLease? = nil
    ) async -> RemoteNativeLoginReadiness? {
        let location = ExecutionLocationID.remote(connectionID)
        // The vendor's PRODUCT name (Л-14): `agy.capitalized` reads "Agy",
        // which is the binary nobody recognises.
        let label = HarnessFamily(rawValue: harnessID).label
        if remoteClients[location] == nil { await connectRemote(connectionID) }
        guard let client = remoteClients[location] else { return nil }
        if let actionLease {
            guard remoteActionIsCurrent(actionLease, client: client) else { return nil }
        }
        if let profileID {
            guard let entry = await refreshExactCredentialProfile(
                harnessID: harnessID, profileID: profileID, locationID: location),
                isCurrentGateway(client, at: location)
            else { return nil }
            if let actionLease {
                guard remoteActionIsCurrent(actionLease, client: client) else { return nil }
            }
            let readiness = RemoteNativeLoginReadiness.profile(entry)
            remoteConnectionMessages[connectionID] =
                readiness.nativeSessionVerified && readiness.harnessRoutable
                ? "\(label) account is signed in and ready."
                : (entry.status.detail ?? "\(label) account is not ready yet.")
            return readiness
        }
        guard await refreshHarnesses(
            fresh: true, locationID: location, markStaleOnFailure: true),
            isCurrentGateway(client, at: location)
        else { return nil }
        if let actionLease {
            guard remoteActionIsCurrent(actionLease, client: client) else { return nil }
        }
        guard let harness = remoteHarnesses[location]?.first(where: {
            $0.family.rawValue == harnessID
        }) else {
            remoteConnectionMessages[connectionID] =
                "Harness Doctor did not return \(harnessID)."
            return nil
        }
        let readiness = RemoteNativeLoginReadiness(
            nativeSessionVerified: harness.nativeSessionReady,
            harnessRoutable: !harness.routableIntents.isEmpty)
        if readiness.nativeSessionVerified && readiness.harnessRoutable {
            remoteConnectionMessages[connectionID] =
                "\(label) is signed in and ready."
        } else {
            remoteConnectionMessages[connectionID] =
                harness.reasons.first ?? "\(label) is not ready yet."
        }
        return readiness
    }

    func dismissRemoteDeviceLogin(_ request: RemoteDeviceLoginRequest) {
        if remoteDeviceLogin?.lease == request.lease {
            remoteDeviceLogin = nil
        }
        // SwiftUI may clear the item binding before onDisappear. Exact finish
        // is still safe: a stale request cannot retire a replacement token.
        finishRemoteAction(request.lease)
    }

    func dismissRemoteHarnessInstallPrompt(_ prompt: RemoteHarnessInstallPrompt) {
        guard remoteHarnessInstallPrompt?.lease == prompt.lease else { return }
        remoteHarnessInstallPrompt = nil
        finishRemoteAction(prompt.lease)
    }

    @discardableResult
    func acceptRemoteHarnessInstallPrompt(_ prompt: RemoteHarnessInstallPrompt) -> Bool {
        guard remoteActionIsCurrent(prompt.lease),
              remoteHarnessInstallPrompt?.lease == prompt.lease
        else { return false }
        // Transfer ownership to the confirm → terminal → Doctor chain before
        // SwiftUI automatically drives the dialog binding to false.
        remoteHarnessInstallPrompt = nil
        return true
    }

    func installRemoteRuntime(connectionID: UUID) async {
        guard let connection = remoteConnections.first(where: {
            $0.id == connectionID
        }) else { return }
        guard remoteConnectTasks[connectionID] == nil,
              connection.status != .connecting,
              connection.status != .installing
        else {
            remoteConnectionMessages[connectionID] =
                "A connection or runtime installation is already in progress."
            return
        }
        let sourceGeneration = remoteConnectionGenerations[connectionID] ?? 0
        var activationLease: RemoteRuntimeActivationLease?
        setRemoteState(
            connectionID, .installing,
            message: "Downloading and verifying the signed runtime…")
        do {
            try await sshConnectionManager.connectBatch(connection)
            try await remoteRuntimeInstaller.recoverPendingActivation(on: connection)
            let target = try await remoteRuntimeInstaller.detectTarget(on: connection)
            let manifest = try await remoteRuntimeInstaller.loadManifest()
            activationLease = try await remoteRuntimeInstaller.install(
                manifest, target: target, on: connection,
                appVersion: Self.appVersionString())
            guard remoteConnectionGenerations[connectionID] == sourceGeneration,
                  remoteConnections.contains(where: { $0.id == connectionID }),
                  remoteConnectTasks[connectionID] == nil
            else { throw CancellationError() }

            guard let lease = activationLease else {
                throw SSHConnectionError.unavailable(
                    "the runtime activation receipt was lost before commit")
            }
            // Ownership transfers before suspension. The exact reconnect now
            // performs handshake → activation commit → client/projection adopt
            // as one publication transaction, and owns rollback on every exit.
            activationLease = nil
            guard await connectRemoteTransferringActivation(
                connection, lease: lease) != nil
            else { return }
        } catch {
            let failure = await remoteActivationFailure(
                error, lease: activationLease, on: connection)
            activationLease = nil
            let currentGeneration = remoteConnectionGenerations[connectionID] ?? 0
            let mayPublish = currentGeneration == sourceGeneration
                || currentGeneration == sourceGeneration + 1
            if mayPublish,
               remoteConnections.contains(where: { $0.id == connectionID })
            {
                setRemoteState(connectionID, .failed, message: failure.message)
            } else if failure.rollbackFailed {
                threadStatus = failure.message
            }
        }
    }

}
