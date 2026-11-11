import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct RemoteSetupLoginRoutingTests {
    @Test func currentEngineFactSelectsExactTransport() {
        #expect(RemoteSetupLoginRouting.decision(harness: .claude, capability: .inApp)
            == .transport(.daemon))
        #expect(RemoteSetupLoginRouting.decision(harness: .codex, capability: .externalTerminal)
            == .transport(.clientPty))
    }

    @Test func decodedLegacyRowKeepsOldFallback() {
        #expect(RemoteSetupLoginRouting.decision(harness: .codex, capability: .legacyAbsent)
            == .transport(.daemon))
        #expect(RemoteSetupLoginRouting.decision(harness: .cursor, capability: .legacyAbsent)
            == .transport(.clientPty))
    }

    @Test func explicitNullAndMissingCurrentProjectionRefuseLoudly() {
        guard case .unavailable(let message) = RemoteSetupLoginRouting.decision(
            harness: .agy, capability: .unavailable)
        else { Issue.record("explicit null must refuse"); return }
        #expect(message.contains("no managed login"))

        for projection: [HarnessInfo]? in [nil, []] {
            guard case .unavailable(let gap) = RemoteSetupLoginRouting.decision(
                harness: .claude, in: projection)
            else { Issue.record("missing current row must refuse"); continue }
            #expect(gap.contains("current managed-login capability"))
        }
    }

    @MainActor @Test func coldRoutingAwaitsTheCurrentProjectionBeforeSelectingTransport() async {
        for family in [HarnessFamily.claude, .cursor] {
            var loadCompleted = false
            let decision = await RemoteSetupLoginRouting
                .decisionAfterLoadingCurrentProjection(
                    harness: SetupHarness(rawValue: family.rawValue)!) {
                        await Task.yield()
                        loadCompleted = true
                        return [HarnessInfo(
                            family: family, health: .ok, version: "current", auth: "ready",
                            intents: ["implement"], setupLogin: .inApp)]
                    }
            #expect(loadCompleted)
            #expect(decision == .transport(.daemon))
        }

        let oldEngineDecision = await RemoteSetupLoginRouting
            .decisionAfterLoadingCurrentProjection(harness: .codex) {
                [HarnessInfo(
                    family: .codex, health: .ok, version: "old", auth: "ready",
                    intents: ["implement"], setupLogin: .legacyAbsent)]
            }
        #expect(oldEngineDecision == .transport(.daemon))
    }

    @MainActor @Test func attemptedProjectionLoadThatReturnsNothingIsALoudGap() async {
        var loadAttempts = 0
        let decision = await RemoteSetupLoginRouting
            .decisionAfterLoadingCurrentProjection(harness: .claude) {
                loadAttempts += 1
                await Task.yield()
                return nil
            }
        #expect(loadAttempts == 1)
        guard case .unavailable(let message) = decision else {
            Issue.record("an attempted load with no current row must refuse")
            return
        }
        #expect(message.contains("current managed-login capability"))
    }
}

@Suite struct RemoteRoutingTests {
    private func task(id: String, phase: RunPhase) -> TaskRun {
        TaskRun(
            id: id, title: id, prompt: "", mode: .agent, phase: phase,
            project: "Project", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
    }

    @MainActor
    @Test func duplicateDaemonRunIdsRemainLocationScoped() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let locationID = ExecutionLocationID.remote(UUID())
        model.liveTasks = [task(id: "same-run", phase: .running)]
        model.remoteTasks[locationID] = [task(id: "same-run", phase: .succeeded)]

        #expect(model.task("same-run", at: .local)?.phase == .running)
        #expect(model.task("same-run", at: locationID)?.phase == .succeeded)

        model.mutateTask("same-run", at: locationID) { $0.phase = .cancelled }
        #expect(model.task("same-run", at: .local)?.phase == .running)
        #expect(model.task("same-run", at: locationID)?.phase == .cancelled)
    }

    @Test func terminalSetupAndInstallAreOneShotBlockingOperations() {
        let id = UUID()
        let setupLease = RemoteActionLease(
            lane: .setupLogin, connectionID: id, generation: 1, token: UUID())
        let installLease = RemoteActionLease(
            lane: .harnessInstall, connectionID: id, generation: 1, token: UUID())
        #expect(RemoteTerminalPurpose.authentication(id, 1).blocksDismissalWhileRunning)
        #expect(RemoteTerminalPurpose.setup(setupLease, "setup-job").blocksDismissalWhileRunning)
        #expect(RemoteTerminalPurpose.install(installLease, "cursor").blocksDismissalWhileRunning)
        #expect(!RemoteTerminalPurpose.shell.blocksDismissalWhileRunning)
        #expect(!RemoteTerminalPurpose.log.blocksDismissalWhileRunning)
    }

    @Test func installDisclosureUsesPreparedCommandsAndTheSameRuntime() throws {
        let lease = RemoteActionLease(lane: .harnessInstall, connectionID: UUID(), generation: 3, token: UUID())
        for version in [nil, "1.2.3"] as [String?] {
            let payload = installDisclosureFixture(version: version)
            let prompt = try #require(AppModel.parseHarnessInstallDisclosure(
                try JSONSerialization.data(withJSONObject: payload), lease: lease,
                harness: "codex", runtimeTarget: "versions/test"))
            #expect(prompt.installationHome == "/fixture/home")
            #expect(prompt.commands[0].script?.url == "https://vendor.example/install.sh")
            #expect(prompt.requestedVersion == version)
            #expect(prompt.confirmedInstallCommand ==
                "~/.claudexor/remote/'versions/test'/bin/claudexor harness install 'codex'"
                + (version.map { " --vendor-version '\($0)'" } ?? "") + " --yes --json")
        }
    }

    @Test func incompleteOrContradictoryDisclosureNeverOffersConfirmation() throws {
        let lease = RemoteActionLease(lane: .harnessInstall, connectionID: UUID(), generation: 1, token: UUID())
        let valid = installDisclosureFixture()
        for field in valid.keys {
            var payload = valid; payload.removeValue(forKey: field)
            #expect(AppModel.parseHarnessInstallDisclosure(
                try JSONSerialization.data(withJSONObject: payload), lease: lease,
                harness: "codex", runtimeTarget: "versions/test") == nil)
        }
        for (field, value) in [("ok", false), ("dryRun", false), ("harness", "claude"),
            ("installationHome", ""), ("commands", []),
            ("target", ["kind": "latest", "version": "1.2.3"]),
            ("target", ["kind": "unrecognized"])] as [(String, Any)] {
            var payload = valid; payload[field] = value
            #expect(AppModel.parseHarnessInstallDisclosure(
                try JSONSerialization.data(withJSONObject: payload), lease: lease,
                harness: "codex", runtimeTarget: "versions/test") == nil)
        }
    }

    @Test func refusedInstallPreparationShowsTheRemoteRefusal() {
        let refusal = "The vendor installer could not be read; nothing was executed."
        #expect(AppModel.harnessInstallPreparationFailure(
            SSHConnectionError.commandFailed(refusal), harness: "codex") == "Codex was not installed: " + refusal)
        #expect(AppModel.harnessInstallPreparationFailure(
            SSHConnectionError.commandFailed(""), harness: "codex") == "Codex was not installed: the host reported no reason.")
        #expect(AppModel.harnessInstallPreparationFailure(
            SSHConnectionError.unavailable("connect first"), harness: "codex") == nil)
    }

    /// The installer and the harness install share ONE pointer owner: only a
    /// single immutable `versions/<id>` closure may name the CLI that runs.
    @Test func runtimePointerTargetAcceptsOnlyOneImmutableVersionDirectory() throws {
        #expect(try RemoteRuntimeInstaller.currentPointerTarget(
            fromProbe: Data("versions/4.3.1-0123abcd\n".utf8)) == "versions/4.3.1-0123abcd")
        #expect(try RemoteRuntimeInstaller.currentPointerTarget(fromProbe: Data()) == nil)
        for unsafe in ["current", "versions/a/b", "versions/../x", "/abs/versions/x"] {
            #expect(throws: SSHConnectionError.self) {
                try RemoteRuntimeInstaller.currentPointerTarget(fromProbe: Data(unsafe.utf8))
            }
        }
    }

    /// The install guards refuse on a surface that does not need the
    /// connection's own row: a connection deleted between the disclosure
    /// dialog and the confirmation has no ForEach row left to render a
    /// per-connection message, so the refusal goes to threadStatus.
    @MainActor @Test func installGuardRefusalsAndStaleConfirmationAreDistinct() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let vanished = UUID()
        let staleLease = RemoteActionLease(
            lane: .harnessInstall, connectionID: vanished, generation: 0, token: UUID())

        await model.confirmRemoteHarnessInstall(
            remoteInstallTestPrompt(lease: staleLease, harness: "codex"))
        // A completion retired by explicit removal is inert. The direct start
        // guard below remains loud because it is a new user action.
        #expect(model.threadStatus == nil)
        #expect(model.remoteConnectionMessages[vanished] == nil)

        model.threadStatus = nil
        await model.startRemoteHarnessInstall(connectionID: vanished, harness: "codex")
        #expect(model.threadStatus == "That connection no longer exists; nothing was installed.")

        model.threadStatus = nil
        await model.startRemoteHarnessInstall(connectionID: vanished, harness: "not-a-harness")
        #expect(
            model.threadStatus
                == "That connection no longer exists; nothing was installed.")
    }

    @Test func onlyConnectionFailuresTriggerRemoteReadReconnect() {
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.cannotConnectToHost)))
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.networkConnectionLost)))
        #expect(isRecoverableRemoteTransportFailure(
            URLError(.timedOut)))

        #expect(!isRecoverableRemoteTransportFailure(
            URLError(.cancelled)))
        #expect(!isRecoverableRemoteTransportFailure(
            GatewayError.http(status: 404, body: "")))
        #expect(!isRecoverableRemoteTransportFailure(
            GatewayError.decoding("bad payload")))
    }

    @Test func deviceLoginReconcilesOnlyTheKnownProtocolFalseNegative() {
        #expect(remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true))

        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .routeMismatch,
            effectiveRoute: .managedAPIKey,
            effectiveSource: .apiKeyEnvironment,
            nativeSessionVerified: true,
            harnessRoutable: true))
        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: false,
            harnessRoutable: true))
        #expect(!remoteDeviceLoginRecoveredFromProtocolMismatch(
            jobState: .cancelled,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true))

        let recovered = RemoteDeviceLoginTerminalPresentation(
            jobState: .failed,
            selectionReason: .protocolViolation,
            effectiveRoute: .vendorNative,
            effectiveSource: .nativeSession,
            nativeSessionVerified: true,
            harnessRoutable: true)
        #expect(recovered == .readyWithWarning)
        #expect(recovered.label == "Signed in; setup check failed")
        #expect(recovered.label != "Login verified")

        #expect(RemoteDeviceLoginTerminalPresentation(
            jobState: .succeeded,
            selectionReason: nil,
            effectiveRoute: nil,
            effectiveSource: nil,
            nativeSessionVerified: false,
            harnessRoutable: false
        ) == .verified)
    }

    @Test func profileReadinessUsesTheExactProfile() throws {
        let entry = try JSONDecoder().decode(
            CredentialProfileEntry.self,
            from: Data(#"{"profile":{"profile_id":"work","harness_id":"codex","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}"#.utf8))
        #expect(RemoteNativeLoginReadiness.profile(entry) == .init(
            nativeSessionVerified: true, harnessRoutable: true))

        let failed = try JSONDecoder().decode(
            CredentialProfileEntry.self,
            from: Data(#"{"profile":{"profile_id":"work","harness_id":"codex","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"failed","detail":"wrong account","last_verified_at":null}}"#.utf8))
        #expect(RemoteNativeLoginReadiness.profile(failed) == .init(
            nativeSessionVerified: false, harnessRoutable: false))

    }
}
