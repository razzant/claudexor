import Foundation
import CryptoKit
import Testing
import ClaudexorKit
@testable import ClaudexorApp

// Install readiness through the composed AppModel consumer: engine answers go
// through a real GatewayClient handshake and the production lifecycle
// reduction, the real coordinator decides, and AppModel publishes the status.
// Only process effects (probe, stop, start) are offline stubs.
//
// The recovery-only bodies are the handshakes real 4.2.0 and 4.1.1 engines
// answered after a failure injected after the schema migration (entry paths
// neutralized): health and protocol pass and the exact identity matches, but
// product admission is closed.

private let newEngine = RuntimeClosureIdentity(
    version: "4.2.0", buildSha: "fe3d4d244d11924ea96d4588084109d5fcedcfe7")
private let oldEngine = RuntimeClosureIdentity(
    version: "4.1.1", buildSha: "f82926c24f23b124197fc710a8aa9eb71aa9b0d9")
private let wrongNewEngine = RuntimeClosureIdentity(
    version: "4.2.0", buildSha: String(repeating: "3", count: 40))

private let recordedNewRecoveryOnly = #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"4.2.0","sha":"fe3d4d244d11924ea96d4588084109d5fcedcfe7","entry":"/runtime/versions/4.2.0/claudexord.bundle.cjs"},"servingMode":"recovery_only"}"#
private let recordedOldRecoveryOnly = #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"4.1.1","sha":"f82926c24f23b124197fc710a8aa9eb71aa9b0d9","entry":"/runtime/versions/4.1.1/claudexord.bundle.cjs"},"servingMode":"recovery_only"}"#

private func handshakeBody(_ identity: RuntimeClosureIdentity, servingMode: String?) -> String {
    let mode = servingMode.map { #","servingMode":"\#($0)""# } ?? ""
    return #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"\#(identity.version)","sha":"\#(identity.buildSha)","entry":"/runtime/claudexord.bundle.cjs"}\#(mode)}"#
}

private func normal(_ identity: RuntimeClosureIdentity) -> String {
    handshakeBody(identity, servingMode: "normal")
}

/// Engine processes in launch order. Each handshake consumes the current
/// process's next answer (the last one repeats); nil means nothing listens.
private final class EngineTimeline: @unchecked Sendable {
    private let lock = NSLock()
    private var processes: [[String?]]
    private var current = 0

    init(_ processes: [[String?]]) { self.processes = processes }

    func launch() { lock.withLock { current += 1 } }

    func answer(consume: Bool) -> String? {
        lock.withLock {
            guard current < processes.count, let next = processes[current].first else { return nil }
            if consume, processes[current].count > 1 { processes[current].removeFirst() }
            return next
        }
    }
}

private final class AdmissionURLProtocol: URLProtocol {
    nonisolated(unsafe) static var timeline: EngineTimeline?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path
        guard let body = Self.timeline?.answer(consume: path == "/v2/handshake") else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let data: Data
        switch path {
        case "/healthz": data = Data(#"{"ok":true}"#.utf8)
        case "/v2/handshake": data = Data(body.utf8)
        default:
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func admissionClient() -> GatewayClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [AdmissionURLProtocol.self]
    return GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:4242")!, token: "fixture",
        session: URLSession(configuration: config))
}

/// The production port's handshake path over the scripted engine; process
/// effects are recorded offline and `start()` launches the next process.
private final class ComposedInstallPort: RuntimeDaemonControl, @unchecked Sendable {
    private let lock = NSLock()
    private let timeline: EngineTimeline
    private let production: AppRuntimeDaemonControl
    private var stopped: [RuntimeClosureIdentity] = []
    private var launched = 0
    private let candidate: RuntimeClosureIdentity

    init(timeline: EngineTimeline, busy: Bool? = false, candidate: RuntimeClosureIdentity = newEngine) {
        self.candidate = candidate
        self.timeline = timeline
        let client = admissionClient()
        production = AppRuntimeDaemonControl(
            isBusyProbe: { busy },
            handshakeProbe: { await AppRuntimeDaemonControl.servingHandshake(using: client) })
    }

    var stoppedIdentities: [RuntimeClosureIdentity] { lock.withLock { stopped } }
    var starts: Int { lock.withLock { launched } }

    func isBusy() async -> Bool? { await production.isBusy() }
    func handshakeIdentity() async -> RuntimeClosureIdentity? { await production.handshakeIdentity() }
    func servingHandshake() async -> RuntimeServingHandshake? { await production.servingHandshake() }
    func stopForRuntimeReplacement(expectedIdentity: RuntimeClosureIdentity) async throws {
        lock.withLock { stopped.append(expectedIdentity) }
    }
    func start() throws {
        lock.withLock { launched += 1 }
        timeline.launch()
    }
    func probeIdentity(scriptURL: URL) async -> RuntimeClosureIdentity? { candidate }
}

private final class ClosureTransport: RuntimeReleaseTransport, @unchecked Sendable {
    let payload: Data
    let beforeDownload: @Sendable () async -> Void
    init(_ payload: Data, beforeDownload: @escaping @Sendable () async -> Void = {}) {
        self.payload = payload
        self.beforeDownload = beforeDownload
    }
    func fetchLatestRelease(etag: String?) async throws -> ReleaseFetchResult {
        ReleaseFetchResult(status: 200, etag: nil, data: Data())
    }
    func downloadAsset(from url: URL) async throws -> Data {
        await beforeDownload()
        return payload
    }
}

private struct InstallRun {
    let model: AppModel
    let port: ComposedInstallPort
    /// Published install status and active runtime pointer once it settled.
    let status: String
    let current: RuntimeCurrent?
}

@Suite(.serialized) struct RuntimeInstallAdmissionTests {
    private static let previousPointer = RuntimeCurrent(
        version: "4.1.1", path: "versions/4.1.1",
        sha256: String(repeating: "a", count: 64), installedAt: "old",
        engineSha: oldEngine.buildSha)

    // MARK: - Production handshake reduction

    @Test func recordedRecoveryOnlyAnswersKeepIdentityAndCarryAdmission() async throws {
        defer { AdmissionURLProtocol.timeline = nil }
        for (body, identity) in [(recordedNewRecoveryOnly, newEngine), (recordedOldRecoveryOnly, oldEngine)] {
            AdmissionURLProtocol.timeline = EngineTimeline([[body]])
            let client = admissionClient()
            // The Gateway verdict stays connectivity/protocol: recovery clients connect.
            let outcome = try await client.handshake()
            #expect(outcome.ok)
            #expect(outcome.recoveryOnly)
            #expect(await AppRuntimeDaemonControl.servingHandshake(using: client)
                == RuntimeServingHandshake(identity: identity, recoveryOnly: true))
            let port = AppRuntimeDaemonControl(
                isBusyProbe: { nil },
                handshakeProbe: { await AppRuntimeDaemonControl.servingHandshake(using: client) })
            // Stop and reconciliation still name a recovery-only engine exactly.
            #expect(await port.handshakeIdentity() == identity)
            #expect(await port.servingHandshake()?.recoveryOnly == true)
        }
    }

    @Test func normalAndPreRecoveryModeAnswersAreNormalAdmission() async throws {
        defer { AdmissionURLProtocol.timeline = nil }
        for body in [normal(newEngine), handshakeBody(newEngine, servingMode: nil)] {
            AdmissionURLProtocol.timeline = EngineTimeline([[body]])
            #expect(await AppRuntimeDaemonControl.servingHandshake(using: admissionClient())
                == RuntimeServingHandshake(identity: newEngine, recoveryOnly: false))
        }
    }

    @Test func unstampedIncompatibleOrAbsentEnginesYieldNoLifecycleAuthority() async throws {
        defer { AdmissionURLProtocol.timeline = nil }
        let unstamped = #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"4.2.0","sha":"unknown","entry":"/x"},"servingMode":"normal"}"#
        let incompatible = #"{"protocolMajor":2,"compatible":false,"operationsPath":"/v2/operations","engine":{"version":"4.2.0","sha":"fe3d4d244d11924ea96d4588084109d5fcedcfe7","entry":"/x"}}"#
        for answer in [unstamped, incompatible, nil] {
            AdmissionURLProtocol.timeline = EngineTimeline([[answer]])
            #expect(await AppRuntimeDaemonControl.servingHandshake(using: admissionClient()) == nil)
        }
    }

    // MARK: - AppModel install consumer

    @MainActor
    @Test func normalInstallReportsUpdated() async throws {
        let run = try await install([[normal(oldEngine)], [normal(newEngine)]])
        #expect(run.status == "Updated to engine v4.2.0.")
        #expect(run.current?.version == "4.2.0")
        #expect(run.port.stoppedIdentities == [oldEngine])
        #expect(run.port.starts == 1)
        #expect(run.model.updateAvailability == nil)
    }

    @MainActor
    @Test func recordedRecoveryOnlyCandidateIsInstalledButNotReportedUpdated() async throws {
        let run = try await install([[normal(oldEngine)], [recordedNewRecoveryOnly]])
        #expect(run.status
            == "Engine v4.2.0 was selected, but answered only in recovery mode during the update check; normal readiness was not confirmed.")
        // Selected and retained: no rollback stop or relaunch beneath it.
        #expect(run.current?.version == "4.2.0")
        #expect(run.port.stoppedIdentities == [oldEngine])
        #expect(run.port.starts == 1)
        // The offer is retired: the version is installed, so Install would be refused.
        #expect(run.model.updateAvailability == nil)
    }

    @MainActor
    @Test func candidateLeavingRecoveryInsideTheBootWindowReportsUpdated() async throws {
        let run = try await install(
            [[normal(oldEngine)],
             [recordedNewRecoveryOnly, recordedNewRecoveryOnly, recordedNewRecoveryOnly, normal(newEngine)]],
            timeout: 5)
        #expect(run.status == "Updated to engine v4.2.0.")
        #expect(run.port.starts == 1)
    }

    @MainActor
    @Test func wrongCandidateRollsBackToANormalPreviousEngine() async throws {
        let run = try await install(
            [[normal(oldEngine)], [normal(wrongNewEngine)], [normal(oldEngine)]])
        #expect([
            "Update rolled back: post-relaunch handshake mismatch.",
            RuntimeInstallError.handshakeMismatch(expected: newEngine, got: wrongNewEngine).errorDescription,
        ].contains(run.status))
        #expect(run.current == Self.previousPointer)
        #expect(run.port.stoppedIdentities == [oldEngine, wrongNewEngine])
        #expect(run.port.starts == 2)
        // A genuine retry stays offered, with the rollback visible above it.
        #expect(UpdateChip.content(for: run.model)
            == .offer(UpdateAvailability(version: "4.2.0"), outcome: run.status))
    }

    /// The candidate never serves; the previous engine relaunched by rollback
    /// answers only in recovery mode (the recorded old-engine handshake).
    @MainActor
    @Test func recordedRecoveryOnlyPreviousIsNotReportedRolledBack() async throws {
        let run = try await install(
            [[normal(oldEngine)], [nil], [recordedOldRecoveryOnly]])
        #expect(run.status.contains("answered only in recovery mode"))
        #expect(!run.status.localizedCaseInsensitiveContains("rolled back"))
        #expect(!run.status.hasPrefix("Updated"))
        #expect(run.current == Self.previousPointer)
        #expect(run.port.stoppedIdentities == [oldEngine, newEngine])
        #expect(run.port.starts == 2)
        #expect(run.model.updateAvailability != nil)
    }

    @MainActor
    @Test func previousLeavingRecoveryInsideTheBootWindowReportsRolledBack() async throws {
        let run = try await install(
            [[normal(oldEngine)], [nil],
             [recordedOldRecoveryOnly, recordedOldRecoveryOnly, normal(oldEngine)]],
            timeout: 0.3)
        #expect([
            "Update rolled back: post-relaunch handshake timed out.",
            RuntimeInstallError.handshakeMismatch(expected: newEngine, got: nil).errorDescription,
        ].contains(run.status))
        #expect(run.current == Self.previousPointer)
    }

    /// Identity precedes admission: an old engine answering in recovery mode
    /// where the candidate should serve is a mismatch, not a recovery-only install.
    @MainActor
    @Test func wrongIdentityInRecoveryModeIsAMismatch() async throws {
        let run = try await install(
            [[normal(oldEngine)], [recordedOldRecoveryOnly], [normal(oldEngine)]])
        #expect([
            "Update rolled back: post-relaunch handshake mismatch.",
            RuntimeInstallError.handshakeMismatch(expected: newEngine, got: oldEngine).errorDescription,
        ].contains(run.status))
        #expect(run.port.stoppedIdentities == [oldEngine, oldEngine])
        #expect(run.current == Self.previousPointer)
    }

    // MARK: - Update chip consumer

    /// A failed recovery keeps the offer, so retry and manual download stay
    /// reachable; the chip shows the failure beside them instead of hiding it
    /// behind Install.
    @MainActor
    @Test func failedRecoveryStaysVisibleBesideTheRetainedOffer() async throws {
        let run = try await install([[normal(oldEngine)], [nil], [recordedOldRecoveryOnly]])
        #expect(run.status.contains("answered only in recovery mode"))
        #expect(UpdateChip.content(for: run.model)
            == .offer(UpdateAvailability(version: "4.2.0"), outcome: run.status))
    }

    /// An installed engine, even one only in recovery mode, retires the offer
    /// and shows its outcome alone.
    @MainActor
    @Test func recoveryOnlyInstallShowsItsOutcomeWithoutAnOffer() async throws {
        let run = try await install([[normal(oldEngine)], [recordedNewRecoveryOnly]])
        #expect(UpdateChip.content(for: run.model) == .installOutcome(run.status))
    }

    @MainActor
    @Test(arguments: [true, nil] as [Bool?])
    func busyOrUnknownRefusalOffersOnlyAnExplicitRetry(busy: Bool?) async throws {
        let run = try await install([[normal(oldEngine)]], busy: busy)
        let expected = "Update not applied: the engine is busy or its activity could not be confirmed. Try Install again when the engine is idle."
        #expect(run.status == expected)
        #expect(UpdateChip.content(for: run.model)
            == .offer(UpdateAvailability(version: "4.2.0"), outcome: expected))
        #expect(run.current == Self.previousPointer)
        #expect(run.port.stoppedIdentities.isEmpty)
        #expect(run.port.starts == 0)
    }

    /// Persistent compatible-engine notices (a newer or alternate build left
    /// running) sit above the update state; they never hide Install, View
    /// release, a historical outcome or a check status.
    @MainActor
    @Test(arguments: [LocalDaemonReconciliationDeferral.targetNotNewer, .explicitBuildSwitchRequired])
    func persistentEngineNoticeNeverHidesTheUpdateState(deferral: LocalDaemonReconciliationDeferral) throws {
        let model = AppModel(requestNotificationAuthorization: false)
        let notice = try #require(compatibleNotice(.deferred(deferral, serving: newEngine, target: oldEngine)))
        model.localDaemonReconciliationNotice = notice
        let offer = UpdateAvailability(version: "4.3.0")
        model.updateAvailability = offer
        #expect(UpdateChip.notice(for: model) == notice)
        #expect(UpdateChip.content(for: model) == .offer(offer, outcome: nil))

        let outcome = "Update rolled back: post-relaunch handshake mismatch."
        model.runtimeInstallStatus = outcome
        #expect(UpdateChip.content(for: model) == .offer(offer, outcome: outcome))
        model.updateAvailability = nil
        #expect(UpdateChip.content(for: model) == .installOutcome(outcome))
        model.runtimeInstallStatus = nil
        model.runtimeUpdateStatus = "Update check failed: offline"
        #expect(UpdateChip.content(for: model) == .checkStatus("Update check failed: offline"))
        #expect(UpdateChip.notice(for: model) == notice)
    }

    /// A refused install keeps its busy outcome and the retry beside the notice;
    /// only an active install, which owns the lifecycle, replaces the notice.
    @MainActor
    @Test func engineNoticeKeepsABusyRefusalAndItsRetryVisible() async throws {
        let run = try await install([[normal(oldEngine)]], busy: true)
        let notice = try #require(compatibleNotice(.deferred(.targetNotNewer, serving: newEngine, target: oldEngine)))
        run.model.localDaemonReconciliationNotice = notice
        #expect(UpdateChip.notice(for: run.model) == notice)
        #expect(UpdateChip.content(for: run.model)
            == .offer(UpdateAvailability(version: "4.2.0"), outcome: run.status))
        run.model.runtimeInstalling = true
        run.model.runtimeInstallStatus = "Downloading engine runtime…"
        #expect(UpdateChip.notice(for: run.model) == nil)
        #expect(UpdateChip.content(for: run.model) == .installing("Downloading engine runtime…"))
    }

    /// The cached offer predates another app copy leaving a newer engine
    /// running. Install refuses before any stop and retires the stale offer.
    @MainActor
    @Test(arguments: ["3.4.0", "3.5.0"])
    func cachedOfferMeetingANewerServingEngineIsRefusedBeforeStopAndRetired(servingVersion: String) async throws {
        let fixture = try RecheckFixture(conditionalRequests: true)
        let candidate = RuntimeClosureIdentity(version: fixture.manifest.version, buildSha: fixture.manifest.buildSha)
        let serving = RuntimeClosureIdentity(version: servingVersion, buildSha: String(repeating: "4", count: 40))
        let previous = RuntimeCurrent(version: "3.1.0", path: "versions/3.1.0",
            sha256: String(repeating: "a", count: 64), installedAt: "old", engineSha: oldEngine.buildSha)
        let run = try await install([[normal(serving)]], candidate: candidate, previous: previous, before: { model in
            model.client = admissionClient()
            model.engineIdentity = EngineBuildIdentity(version: "3.1.0", sha: oldEngine.buildSha, entry: "/fixture/old")
            model.appVersionOverrideForUpdates = "4.2.0"
            model.runtimeUpdater = RuntimeUpdater(transport: fixture, authority: fixture.authority)
            model.makeRuntimeTransport = { fixture }
            await model.checkForRuntimeUpdate()
            #expect(await model.runtimeUpdater?.cachedDecision == .available(fixture.manifest))
            #expect(model.updateAvailability?.version == candidate.version)
        })
        #expect(run.status
            == RuntimeInstallError.notNewerThanServing(target: candidate.version, serving: serving).errorDescription)
        #expect(run.current == previous)
        #expect(run.model.engineIdentity == EngineBuildIdentity(
            version: serving.version, sha: serving.buildSha, entry: "/runtime/claudexord.bundle.cjs"))
        #expect(run.model.updateAvailability == nil)
        #expect(await run.model.runtimeUpdater?.cachedDecision == .upToDate)
        #expect(UpdateChip.content(for: run.model) == .installOutcome(run.status))

        // A cleared ETag means a real HTTP 200, even for the unchanged release.
        // Observing another copy's version is not an install by this app.
        await run.model.checkForRuntimeUpdate()
        #expect(fixture.receivedETags == [nil, nil])
        #expect(await run.model.runtimeUpdater?.cachedDecision == .upToDate)
        #expect(run.model.updateAvailability == nil)
        #expect(run.model.runtimeInstallStatus == run.status)
        #expect(fixture.responseStatuses == [200, 200])
        // The next check is genuinely conditional and preserves the same result.
        await run.model.checkForRuntimeUpdate()
        #expect(fixture.receivedETags == [nil, nil, "fixture"])
        #expect(fixture.responseStatuses == [200, 200, 304])
        #expect(await run.model.runtimeUpdater?.cachedDecision == .upToDate)
        #expect(run.model.updateAvailability == nil)
        #expect(UpdateChip.content(for: run.model) == .installOutcome(run.status))
        // The retired action cannot download or start another coordinator either.
        await run.model.installRuntimeUpdate()
        #expect(run.model.runtimeInstallStatus == "No verified update to install.")
        #expect(fixture.receivedETags.count == 3)
        #expect(run.port.stoppedIdentities.isEmpty)
        #expect(run.port.starts == 0)

        // A genuinely newer signed release still becomes an actionable offer.
        let newer = try fixture.publish(version: "3.6.0")
        await run.model.checkForRuntimeUpdate()
        #expect(fixture.responseStatuses == [200, 200, 304, 200])
        #expect(await run.model.runtimeUpdater?.cachedDecision == .available(newer))
        #expect(run.model.updateAvailability?.version == "3.6.0")
        #expect(run.port.stoppedIdentities.isEmpty)
        #expect(run.port.starts == 0)
    }

    /// An explicit connection change during the download owns its observation.
    @MainActor
    @Test(arguments: ["generation", "client", "identity"])
    func refusedInstallDoesNotOverwriteASuccessorConnection(change: String) async throws {
        let fixture = try RecheckFixture()
        let candidate = RuntimeClosureIdentity(version: fixture.manifest.version, buildSha: fixture.manifest.buildSha)
        let serving = RuntimeClosureIdentity(version: "3.5.0", buildSha: String(repeating: "4", count: 40))
        let previous = RuntimeCurrent(version: "3.1.0", path: "versions/3.1.0",
            sha256: String(repeating: "a", count: 64), installedAt: "old", engineSha: oldEngine.buildSha)
        let initial = EngineBuildIdentity(version: "3.1.0", sha: oldEngine.buildSha, entry: "/fixture/old")
        let successor = EngineBuildIdentity(version: "3.2.0", sha: oldEngine.buildSha, entry: "/fixture/successor")
        let run = try await install([[normal(serving)]], candidate: candidate, previous: previous,
            duringDownload: { model in
                switch change {
                case "generation": model.connectionGeneration += 1
                case "client": model.client = admissionClient()
                default: model.engineIdentity = successor
                }
            }, before: { model in
                model.client = admissionClient()
                model.engineIdentity = initial
            })
        #expect(run.model.engineIdentity == (change == "identity" ? successor : initial))
        #expect(run.status == RuntimeInstallError.notNewerThanServing(target: candidate.version, serving: serving).errorDescription)
        #expect(run.current == previous)
        #expect(run.port.stoppedIdentities.isEmpty)
        #expect(run.port.starts == 0)
    }

    /// The refresh may see a later, legitimately different engine. Its complete
    /// identity wins; the refusal's version is not a persistent version floor.
    @MainActor
    @Test func refusalRefreshUsesTheLatestHandshakeAndAllowsLaterVersionChanges() async throws {
        let fixture = try RecheckFixture()
        let candidate = RuntimeClosureIdentity(version: fixture.manifest.version, buildSha: fixture.manifest.buildSha)
        let serving = RuntimeClosureIdentity(version: "3.5.0", buildSha: String(repeating: "4", count: 40))
        let later = RuntimeClosureIdentity(version: "3.2.0", buildSha: String(repeating: "5", count: 40))
        let previous = RuntimeCurrent(version: "3.1.0", path: "versions/3.1.0",
            sha256: String(repeating: "a", count: 64), installedAt: "old", engineSha: oldEngine.buildSha)
        let run = try await install([[normal(serving), normal(later)]], candidate: candidate, previous: previous,
            before: { model in
                model.client = admissionClient()
                model.engineIdentity = EngineBuildIdentity(version: "3.1.0", sha: oldEngine.buildSha, entry: "/fixture/old")
                model.appVersionOverrideForUpdates = "4.2.0"
                model.runtimeUpdater = RuntimeUpdater(transport: fixture, authority: fixture.authority)
                await model.checkForRuntimeUpdate()
            })
        #expect(run.model.engineIdentity == EngineBuildIdentity(
            version: later.version, sha: later.buildSha, entry: "/runtime/claudexord.bundle.cjs"))
        #expect(run.status == RuntimeInstallError.notNewerThanServing(target: candidate.version, serving: serving).errorDescription)
        await run.model.checkForRuntimeUpdate()
        #expect(fixture.responseStatuses == [200, 200])
        #expect(await run.model.runtimeUpdater?.cachedDecision == .available(fixture.manifest))
        #expect(UpdateChip.content(for: run.model) == .offer(UpdateAvailability(version: "3.4.0"), outcome: run.status))
        #expect(run.current == previous)
        #expect(run.port.stoppedIdentities.isEmpty)
        #expect(run.port.starts == 0)
    }

    @MainActor
    @Test func recoveryObservationFollowedByDisappearanceKeepsHistoricalOutcome() async throws {
        let run = try await install([[normal(oldEngine)], [recordedNewRecoveryOnly, nil]])
        #expect(run.status == "Engine v4.2.0 was selected, but answered only in recovery mode during the update check; normal readiness was not confirmed.")
        #expect(run.current?.version == "4.2.0")
        #expect(run.port.starts == 1)
        #expect(UpdateChip.content(for: run.model) == .installOutcome(run.status))
    }

    @MainActor
    @Test func manualRecheckAfterRecoveryUsesSelectedPointerAndKeepsHistory() async throws {
        try await isolatedRuntimeConsumer("RuntimeInstallAdmissionTests/manualRecheckAfterRecoveryUsesSelectedPointerAndKeepsHistory") {
            let fixture = try RecheckFixture()
            let candidate = RuntimeClosureIdentity(version: fixture.manifest.version, buildSha: fixture.manifest.buildSha)
            let previous = RuntimeCurrent(version: "3.1.0", path: "versions/3.1.0",
                sha256: String(repeating: "a", count: 64), installedAt: "old", engineSha: oldEngine.buildSha)
            let installer = RuntimeInstaller()
            let syntheticHome = try #require(ProcessInfo.processInfo.environment["HOME"])
            try #require(installer.root.resolvingSymlinksInPath().path.hasPrefix(
                URL(fileURLWithPath: syntheticHome).resolvingSymlinksInPath().path + "/"))
            // The engine serving before the swap is this fixture's previous 3.1.0.
            let previousEngine = RuntimeClosureIdentity(version: "3.1.0", buildSha: oldEngine.buildSha)
            let run = try await install(
                [[normal(previousEngine)], [handshakeBody(candidate, servingMode: "recovery_only")]],
                installer: installer, candidate: candidate, previous: previous,
                before: { model in
                    // A same-session connection still holds the pre-install identity.
                    model.engineIdentity = EngineBuildIdentity(version: "3.1.0", sha: oldEngine.buildSha, entry: "/old")
                    model.appVersionOverrideForUpdates = "4.2.0"
                    model.runtimeUpdater = RuntimeUpdater(transport: fixture, authority: fixture.authority)
                    await model.checkForRuntimeUpdate()
                    #expect(model.updateAvailability?.version == candidate.version)
                })
            #expect(run.current?.version == candidate.version)
            #expect(run.model.engineIdentity == nil)
            #expect(run.model.updateAvailability == nil)
            await run.model.checkForRuntimeUpdate()
            #expect(run.model.updateAvailability == nil)
            #expect(UpdateChip.content(for: run.model) == .installOutcome(run.status))
            // Normal adoption must not rewrite the original attempt as success,
            // or erase a current attempt's progress.
            AdmissionURLProtocol.timeline = EngineTimeline([[handshakeBody(candidate, servingMode: "recovery_only")]])
            defer { AdmissionURLProtocol.timeline = nil }
            let client = admissionClient()
            #expect(await run.model.tryConnect(candidate: client, endpoint: "fixture", generation: run.model.connectionGeneration)
                == .retryWithoutLaunch)
            #expect(run.model.engineIdentity == nil)
            #expect(run.model.client == nil)
            AdmissionURLProtocol.timeline = EngineTimeline([[normal(candidate)]])
            run.model.client = client
            run.model.localDaemonReconciler = LocalDaemonReconciler(
                daemon: run.port, lifecycleOwner: run.model.localRuntimeLifecycleOwner,
                targetClosure: { LocalRuntimeClosureSelection(
                    scriptURL: URL(fileURLWithPath: "/fixture/daemon"), authority: .installed(candidate)) })
            #expect(await run.model.pollLocalConnection() == .connected)
            #expect(run.model.engineIdentity?.version == candidate.version)
            #expect(UpdateChip.content(for: run.model) == .installOutcome(run.status))
            run.model.runtimeInstalling = true
            run.model.runtimeInstallStatus = "Downloading engine runtime…"
            #expect(await run.model.pollLocalConnection() == .connected)
            #expect(UpdateChip.content(for: run.model) == .installing("Downloading engine runtime…"))
        }
    }

    // MARK: - Helpers

    /// The production notice text for a reconciliation result.
    private func compatibleNotice(_ result: LocalDaemonReconciliationResult) -> String? {
        if case let .useCompatible(notice) = LocalDaemonReconciliationPolicy(result) { return notice }
        return nil
    }

    @MainActor
    private func install(
        _ processes: [[String?]], timeout: TimeInterval = 0.1, busy: Bool? = false,
        installer suppliedInstaller: RuntimeInstaller? = nil,
        candidate: RuntimeClosureIdentity = newEngine,
        previous: RuntimeCurrent = Self.previousPointer,
        duringDownload: @escaping @MainActor @Sendable (AppModel) -> Void = { _ in },
        before: (AppModel) async throws -> Void = { _ in }
    ) async throws -> InstallRun {
        let root = runtimeTestTemporaryDirectory
            .appendingPathComponent("cx-admission-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = suppliedInstaller ?? RuntimeInstaller(root: root)
        try installer.writeCurrentAtomic(previous)
        let (bytes, sha) = try await fixtureClosure()

        let timeline = EngineTimeline(processes)
        AdmissionURLProtocol.timeline = timeline
        defer { AdmissionURLProtocol.timeline = nil }
        let port = ComposedInstallPort(timeline: timeline, busy: busy, candidate: candidate)
        let model = AppModel(requestNotificationAuthorization: false)
        model.makeDaemonControl = { port }
        model.updateAvailability = UpdateAvailability(version: candidate.version)
        try await before(model)

        await model.runRuntimeInstall(
            manifest: RuntimeManifest(
                version: candidate.version, sha256: sha, minAppVersion: "4.0.0",
                buildSha: candidate.buildSha),
            assetURL: URL(string: "https://example.invalid/claudexor-runtime-4.2.0.tar.gz")!,
            transport: ClosureTransport(bytes, beforeDownload: { await duringDownload(model) }),
            installer: installer,
            rollbackSelection: { nil },
            handshakePollInterval: 0.002,
            handshakePollTimeout: timeout)
        // Phase updates hop to the main actor; let any late one land before
        // the caller reads the published status.
        try await Task.sleep(nanoseconds: 20_000_000)
        for _ in 0..<20 { await Task.yield() }
        return InstallRun(
            model: model, port: port,
            status: model.runtimeInstallStatus ?? "", current: installer.readCurrent())
    }

    /// `install` is main-actor isolated, and `waitUntilExit()` there blocks every
    /// concurrently running @MainActor test for the child's whole lifetime, which
    /// can exceed other tests' deadlines when the child is slow. Await the exit instead.
    private func fixtureClosure() async throws -> (Data, String) {
        let stage = runtimeTestTemporaryDirectory
            .appendingPathComponent("cx-admission-stage-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stage) }
        try Data("// daemon\n".utf8).write(to: stage.appendingPathComponent("claudexord.bundle.cjs"))
        let tar = stage.appendingPathComponent("closure.tar.gz")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-czf", tar.path, "-C", stage.path, "claudexord.bundle.cjs"]
        try await withCheckedThrowingContinuation { (exited: CheckedContinuation<Void, Error>) in
            process.terminationHandler = { _ in exited.resume() }
            do { try process.run() } catch { exited.resume(throwing: error) }
        }
        let bytes = try Data(contentsOf: tar)
        return (bytes, RuntimeInstaller(root: stage).sha256Hex(bytes))
    }
}

/// Reuse the signed cross-language vector; no production keys or release I/O.
private final class RecheckFixture: RuntimeReleaseTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var tags: [String?] = []
    private let conditionalRequests: Bool
    private var statuses: [Int] = []
    var responseStatuses: [Int] { lock.withLock { statuses } }
    var receivedETags: [String?] { lock.withLock { tags } }
    private var data: Data
    private var releaseETag = "fixture"
    let authority: RuntimeUpdateAuthority
    let manifest: RuntimeManifest
    init(conditionalRequests: Bool = false) throws {
        self.conditionalRequests = conditionalRequests
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/runtime-update")
        data = try Data(contentsOf: root.appendingPathComponent("valid-manifest.json"))
        struct Authority: Decodable { let keyId: String; let algorithm: String; let publicKeyPem: String }
        let decoded = try JSONDecoder().decode(Authority.self,
            from: Data(contentsOf: root.appendingPathComponent("authority.json")))
        authority = RuntimeUpdateAuthority(keyId: decoded.keyId, algorithm: decoded.algorithm, publicKeyPem: decoded.publicKeyPem)
        manifest = try #require(RuntimeManifest.verified(data, authority: authority))
    }
    func fetchLatestRelease(etag: String?) async throws -> ReleaseFetchResult {
        let (notModified, currentETag) = lock.withLock {
            tags.append(etag)
            let hit = conditionalRequests && etag == releaseETag
            statuses.append(hit ? 304 : 200)
            return (hit, releaseETag)
        }
        if notModified { return ReleaseFetchResult(status: 304, etag: currentETag, data: nil) }
        return ReleaseFetchResult(status: 200, etag: currentETag,
            data: Data(#"{"assets":[{"name":"runtime-manifest.json","browser_download_url":"https://example.invalid/manifest"}]}"#.utf8))
    }
    func downloadAsset(from url: URL) async throws -> Data { lock.withLock { data } }

    func publish(version: String) throws -> RuntimeManifest {
        var fields = try #require(JSONSerialization.jsonObject(with: lock.withLock { data }) as? [String: Any])
        fields["version"] = version
        fields["archiveName"] = RuntimeManifest.archiveName(for: version)
        fields["archiveUrl"] = RuntimeManifest.archiveUrl(for: version)
        fields["notes"] = ""
        fields.removeValue(forKey: "signature")
        let bytes = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
        // Public TEST key from scripts/gen-runtime-update-fixtures.mjs; never
        // the production authority. The original 3.4 regression uses its exact
        // checked-in signed bytes; only this subsequent release is re-signed.
        let der = try #require(Data(base64Encoded: "MC4CAQAwBQYDK2VwBCIEIJcml9Acg6+XssPo8BxmJyg1dTrW8oxBc7FgWTVsxOji"))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: der.suffix(32))
        fields["signature"] = try key.signature(for: bytes).base64EncodedString()
        let published = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
        let verified = try #require(RuntimeManifest.verified(published, authority: authority))
        lock.withLock {
            data = published
            releaseETag = "fixture-\(version)"
        }
        return verified
    }
}
