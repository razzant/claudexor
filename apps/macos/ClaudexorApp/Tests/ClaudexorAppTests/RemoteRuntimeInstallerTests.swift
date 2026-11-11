import ClaudexorKit
import CryptoKit
import Foundation
import Testing
@testable import ClaudexorApp

private actor RemoteRuntimeTransportStub: RemoteRuntimeSSHTransport {
    enum Step: Sendable {
        case output(Data)
        case failure(String)
    }

    private var steps: [Step]
    private(set) var commands: [String] = []

    init(steps: [Step]) { self.steps = steps }

    func execute(
        _ connection: RemoteConnection,
        remoteCommand: String,
        stdin: Data?
    ) async throws -> SSHProcessOutput {
        commands.append(remoteCommand)
        guard !steps.isEmpty else {
            throw SSHConnectionError.unavailable("unexpected test transport call")
        }
        switch steps.removeFirst() {
        case .output(let data):
            return SSHProcessOutput(
                stdout: data, stderr: Data(), status: 0, stdinWriteError: nil)
        case .failure(let message):
            throw SSHConnectionError.unavailable(message)
        }
    }
}

private final class RemoteRuntimeArchiveURLProtocol: URLProtocol {
    nonisolated(unsafe) static var bytes = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/gzip"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized) struct RemoteRuntimeInstallerTests {
    @Test func publicationRequiresHandshakeAndExactActivationCommit() {
        let runtime = RemoteRuntimeProbe(
            target: .darwinArm64, version: "3.4.0",
            buildSha: String(repeating: "b", count: 40), protocolMajor: 3)
        let engine = EngineBuildIdentity(
            version: runtime.version, sha: runtime.buildSha, entry: "/runtime/daemon.js")
        var activated = RemoteRuntimePublicationGate(
            expectedRuntime: runtime, requiresActivationCommit: true)
        #expect(!activated.mayPublish)
        let prematureCommit = activated.acceptActivationCommit()
        #expect(!prematureCommit)
        let acceptedHandshake = activated.acceptHandshake(engine)
        #expect(acceptedHandshake)
        #expect(!activated.mayPublish)
        let committed = activated.acceptActivationCommit()
        #expect(committed)
        let acceptedCurrent = activated.acceptCurrentRuntime(runtime)
        #expect(acceptedCurrent)
        #expect(activated.mayPublish)

        var ordinary = RemoteRuntimePublicationGate(
            expectedRuntime: runtime, requiresActivationCommit: false)
        #expect(!ordinary.mayPublish)
        let ordinaryHandshake = ordinary.acceptHandshake(engine)
        let ordinaryCurrent = ordinary.acceptCurrentRuntime(runtime)
        #expect(ordinaryHandshake)
        #expect(ordinaryCurrent)
        #expect(ordinary.mayPublish)

        var staleHandshakeGate = RemoteRuntimePublicationGate(
            expectedRuntime: runtime, requiresActivationCommit: false)
        let staleEngine = EngineBuildIdentity(
            version: runtime.version, sha: String(repeating: "a", count: 40),
            entry: "/old/daemon.js")
        let mismatchedHandshake = staleHandshakeGate.acceptHandshake(staleEngine)
        #expect(!mismatchedHandshake)
        #expect(!staleHandshakeGate.mayPublish)

        var finalMismatchGate = RemoteRuntimePublicationGate(
            expectedRuntime: runtime, requiresActivationCommit: false)
        let matchingHandshake = finalMismatchGate.acceptHandshake(engine)
        let mismatchedCurrent = finalMismatchGate.acceptCurrentRuntime(RemoteRuntimeProbe(
            target: runtime.target, version: "3.5.0", buildSha: runtime.buildSha,
            protocolMajor: runtime.protocolMajor))
        #expect(matchingHandshake)
        #expect(!mismatchedCurrent)
        #expect(!finalMismatchGate.mayPublish)
    }
    private let oldBuild = String(repeating: "a", count: 40)
    private let newBuild = String(repeating: "b", count: 40)

    private func bootstrapJSON(
        version: String,
        buildSha: String,
        engineVersion: String? = nil,
        engineBuildSha: String? = nil
    ) -> Data {
        Data(#"""
        {"ok":true,"target":"darwin-arm64","version":"\#(version)","buildSha":"\#(buildSha)","protocolMajor":3,"engineVersion":"\#(engineVersion ?? version)","engineBuildSha":"\#(engineBuildSha ?? buildSha)","endpoint":{"host":"127.0.0.1","port":43123,"token":"memory-only"}}
        """#.utf8)
    }

    private func pendingActivation(
        followedBy steps: [RemoteRuntimeTransportStub.Step]
    ) async throws -> (
        installer: RemoteRuntimeInstaller,
        transport: RemoteRuntimeTransportStub,
        connection: RemoteConnection,
        lease: RemoteRuntimeActivationLease,
        candidate: RemoteRuntimeProbe,
        candidateTarget: String
    ) {
        let archive = Data("identity-bound candidate".utf8)
        let digest = SHA256.hash(data: archive)
            .map { String(format: "%02x", $0) }.joined()
        let archiveName = RemoteRuntimeManifestV1.archiveName(
            version: "3.4.0", target: .darwinArm64)
        let manifest = try JSONDecoder().decode(
            RemoteRuntimeManifestV1.self,
            from: Data(#"""
            {
              "schemaVersion":1,"kind":"claudexor-remote-runtime",
              "version":"3.4.0","buildSha":"\#(newBuild)","protocolMajor":3,
              "minAppVersion":"2.1.0","notes":"identity settlement test",
              "assets":[{
                "target":"darwin-arm64","platform":"darwin","arch":"arm64",
                "nodeVersion":"24.16.0","archiveName":"\#(archiveName)",
                "archiveUrl":"https://runtime.test/\#(archiveName)","sha256":"\#(digest)"
              }],"keyId":"test","algorithm":"Ed25519","signature":"test"
            }
            """#.utf8))
        RemoteRuntimeArchiveURLProtocol.bytes = archive
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RemoteRuntimeArchiveURLProtocol.self]
        let transport = RemoteRuntimeTransportStub(steps: [
            .output(Data()), // pointer before snapshot
            .output(Data()), // pointer after snapshot
            .output(Data()), // archive upload
            .output(Data()), // atomic install/activate
            .output(bootstrapJSON(version: "3.4.0", buildSha: newBuild)),
        ] + steps)
        let installer = RemoteRuntimeInstaller(
            ssh: transport, session: URLSession(configuration: configuration),
            developmentDirectory: nil)
        let connection = RemoteConnection(sshAlias: "identity-settlement")
        let lease = try await installer.install(
            manifest, target: .darwinArm64, on: connection, appVersion: "3.4.0")
        let candidate = RemoteRuntimeProbe(
            target: .darwinArm64, version: "3.4.0", buildSha: newBuild,
            protocolMajor: 3)
        return (
            installer, transport, connection, lease, candidate,
            "versions/3.4.0-\(digest)")
    }

    private func activationPayload() -> RemoteRuntimeActivationState.Payload {
        RemoteRuntimeActivationState.Payload(
            candidateTarget: "versions/3.4.0-candidate",
            candidate: RemoteRuntimeProbe(
                target: .darwinArm64, version: "3.4.0", buildSha: newBuild,
                protocolMajor: 3),
            previousTarget: "versions/3.3.0-previous",
            previous: RemoteRuntimeProbe(
                target: .darwinArm64, version: "3.3.0", buildSha: oldBuild,
                protocolMajor: 3))
    }

    @Test func bootstrapRejectsAStaleEngineBehindTheCurrentRuntime() async throws {
        let transport = RemoteRuntimeTransportStub(steps: [
            .output(bootstrapJSON(
                version: "3.4.0", buildSha: newBuild,
                engineVersion: "3.3.0", engineBuildSha: oldBuild)),
        ])
        let installer = RemoteRuntimeInstaller(ssh: transport, developmentDirectory: nil)
        let connection = RemoteConnection(sshAlias: "stale-bootstrap")

        await #expect(throws: SSHConnectionError.self) {
            _ = try await installer.bootstrap(on: connection)
        }
        #expect(await transport.commands.count == 1)
    }

    @Test func bootstrapAcceptsAnExactNewerInstalledRuntime() async throws {
        let newerBuild = String(repeating: "c", count: 40)
        let transport = RemoteRuntimeTransportStub(steps: [
            .output(bootstrapJSON(version: "3.5.0", buildSha: newerBuild)),
        ])
        let installer = RemoteRuntimeInstaller(ssh: transport, developmentDirectory: nil)
        let connection = RemoteConnection(sshAlias: "newer-bootstrap")

        let bootstrap = try await installer.bootstrap(on: connection)
        #expect(bootstrap.runtime == RemoteRuntimeProbe(
            target: .darwinArm64, version: "3.5.0", buildSha: newerBuild,
            protocolMajor: 3))
    }

    @Test func commitRequiresTheLeaseCandidateAndExactPointer() async throws {
        let fixture = try await pendingActivation(followedBy: [
            .output(Data("versions/other-runtime\n".utf8)),
            .failure("rollback CAS refused the raced pointer"),
        ])

        await #expect(throws: SSHConnectionError.self) {
            try await fixture.installer.commitActivation(
                fixture.lease, serving: fixture.candidate, on: fixture.connection)
        }
        do {
            try await fixture.installer.recoverPendingActivation(on: fixture.connection)
            Issue.record("a pointer race must remain a visible, retryable recovery failure")
        } catch {
            #expect(error.localizedDescription.contains("rollback CAS refused"))
        }
        #expect(await fixture.transport.commands.count == 7)
    }

    @Test func commitRefusesAnotherServingRuntimeAndKeepsRollbackOwnership() async throws {
        let fixture = try await pendingActivation(followedBy: [
            .output(Data(#"{"ok":true,"deactivated":true}"#.utf8)),
        ])
        let stale = RemoteRuntimeProbe(
            target: fixture.candidate.target, version: "3.3.0", buildSha: oldBuild,
            protocolMajor: fixture.candidate.protocolMajor)

        await #expect(throws: SSHConnectionError.self) {
            try await fixture.installer.commitActivation(
                fixture.lease, serving: stale, on: fixture.connection)
        }
        try await fixture.installer.recoverPendingActivation(on: fixture.connection)
        #expect(await fixture.transport.commands.count == 6)
    }

    @Test func exactCandidateAndPointerCommitOnce() async throws {
        let digest = SHA256.hash(data: Data("identity-bound candidate".utf8))
            .map { String(format: "%02x", $0) }.joined()
        let candidateTarget = "versions/3.4.0-\(digest)"
        let fixture = try await pendingActivation(followedBy: [
            .output(Data("\(candidateTarget)\n".utf8)),
        ])
        #expect(fixture.candidateTarget == candidateTarget)

        try await fixture.installer.commitActivation(
            fixture.lease, serving: fixture.candidate, on: fixture.connection)
        await #expect(throws: SSHConnectionError.self) {
            try await fixture.installer.commitActivation(
                fixture.lease, serving: fixture.candidate, on: fixture.connection)
        }
        #expect(await fixture.transport.commands.count == 6)
    }

    @Test func activationStateIsSingleFlightBeforeAnyAwait() throws {
        var state = RemoteRuntimeActivationState()
        let connectionID = UUID()
        let lease = try state.claim(connectionID: connectionID)
        #expect(state.phase(for: lease) == .installing)
        #expect(state.lease(connectionID: connectionID) == lease)
        #expect(state.recoverableLease(connectionID: connectionID) == nil)
        #expect(throws: SSHConnectionError.self) {
            _ = try state.claim(connectionID: connectionID)
        }

        try state.prepareMutation(activationPayload(), for: lease)
        try state.confirmMutation(lease)
        #expect(state.phase(for: lease) == .pending)
        #expect(state.recoverableLease(connectionID: connectionID) == lease)
        #expect(throws: SSHConnectionError.self) {
            _ = try state.claim(connectionID: connectionID)
        }
    }

    @Test func candidateMismatchNeverConsumesThePendingLease() throws {
        var state = RemoteRuntimeActivationState()
        let connectionID = UUID()
        let lease = try state.claim(connectionID: connectionID)
        try state.prepareMutation(activationPayload(), for: lease)
        try state.confirmMutation(lease)
        let other = RemoteRuntimeProbe(
            target: .darwinArm64, version: "3.5.0",
            buildSha: String(repeating: "c", count: 40), protocolMajor: 3)

        #expect(throws: SSHConnectionError.self) {
            _ = try state.beginCommit(lease, serving: other)
        }
        #expect(state.phase(for: lease) == .pending)
        #expect(state.recoverableLease(connectionID: connectionID) == lease)
    }

    @Test func staleLeaseCannotSettleANewerActivation() throws {
        var state = RemoteRuntimeActivationState()
        let connectionID = UUID()
        let oldLease = try state.claim(connectionID: connectionID)
        try state.prepareMutation(activationPayload(), for: oldLease)
        try state.confirmMutation(oldLease)
        _ = try state.beginCommit(oldLease, serving: activationPayload().candidate)
        try state.finishSettlement(oldLease)

        let currentLease = try state.claim(connectionID: connectionID)
        try state.prepareMutation(activationPayload(), for: currentLease)
        try state.confirmMutation(currentLease)
        #expect(throws: SSHConnectionError.self) {
            _ = try state.beginCommit(oldLease, serving: activationPayload().candidate)
        }
        #expect(state.phase(for: currentLease) == .pending)
    }

    @Test func settlementOwnsTheLeaseAndFailureLeavesOnlyThatLeaseRetryable() throws {
        var state = RemoteRuntimeActivationState()
        let connectionID = UUID()
        let lease = try state.claim(connectionID: connectionID)
        try state.prepareMutation(activationPayload(), for: lease)
        try state.confirmMutation(lease)

        let payload = try state.beginSettlement(lease)
        #expect(payload.candidate.version == "3.4.0")
        #expect(state.phase(for: lease) == .settling)
        #expect(throws: SSHConnectionError.self) {
            _ = try state.beginCommit(lease, serving: activationPayload().candidate)
        }
        #expect(throws: SSHConnectionError.self) {
            _ = try state.claim(connectionID: connectionID)
        }

        state.settlementFailed(lease)
        #expect(state.phase(for: lease) == .pending)
        _ = try state.beginSettlement(lease)
        try state.finishSettlement(lease)
        #expect(state.phase(for: lease) == nil)
    }

    @Test func installPropagatesAndRetainsTheExactLeaseWhenRollbackFails() async throws {
        let archive = Data("candidate archive".utf8)
        let digest = SHA256.hash(data: archive)
            .map { String(format: "%02x", $0) }.joined()
        let archiveName = RemoteRuntimeManifestV1.archiveName(
            version: "3.4.0", target: .darwinArm64)
        let manifest = try JSONDecoder().decode(
            RemoteRuntimeManifestV1.self,
            from: Data(#"""
            {
              "schemaVersion":1,
              "kind":"claudexor-remote-runtime",
              "version":"3.4.0",
              "buildSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "protocolMajor":3,
              "minAppVersion":"2.1.0",
              "notes":"actor recovery test",
              "assets":[{
                "target":"darwin-arm64","platform":"darwin","arch":"arm64",
                "nodeVersion":"24.16.0","archiveName":"\#(archiveName)",
                "archiveUrl":"https://runtime.test/\#(archiveName)",
                "sha256":"\#(digest)"
              }],
              "keyId":"test","algorithm":"Ed25519","signature":"test"
            }
            """#.utf8))
        RemoteRuntimeArchiveURLProtocol.bytes = archive
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RemoteRuntimeArchiveURLProtocol.self]
        let transport = RemoteRuntimeTransportStub(steps: [
            .output(Data()), // pointer before snapshot
            .output(Data()), // pointer after snapshot
            .output(Data()), // archive upload
            .output(Data()), // atomic install/activate
            .failure("candidate bootstrap failed"),
            .failure("first rollback failed"),
            .output(Data()), // retry of the exact pending rollback
        ])
        let installer = RemoteRuntimeInstaller(
            ssh: transport,
            session: URLSession(configuration: configuration),
            developmentDirectory: nil)
        let connection = RemoteConnection(sshAlias: "recovery-test")

        let recovery: RemoteRuntimeRecoveryRequired
        do {
            _ = try await installer.install(
                manifest, target: .darwinArm64, on: connection, appVersion: "3.4.0")
            Issue.record("failed rollback must return its exact recovery lease")
            return
        } catch let error as RemoteRuntimeRecoveryRequired {
            recovery = error
        }
        #expect(recovery.lease.connectionID == connection.id)
        #expect(recovery.primaryMessage.contains("candidate bootstrap failed"))
        #expect(recovery.recoveryMessage.contains("first rollback failed"))

        // Production recovery, not just the pure state helper: the retained
        // lease drives the exact rollback on the next attempt and then becomes
        // stale, proving it was neither abandoned nor replaced.
        try await installer.recoverPendingActivation(on: connection)
        do {
            try await installer.commitActivation(
                recovery.lease, serving: activationPayload().candidate, on: connection)
            Issue.record("a recovered lease must already be settled")
        } catch {
            // Expected exact stale-lease refusal.
        }
        #expect(await transport.commands.count == 7)
    }

    @Test func lostInstallResponseAndUnreadablePointerRetainAnUncertainLease() async throws {
        let archive = Data("uncertain candidate".utf8)
        let digest = SHA256.hash(data: archive)
            .map { String(format: "%02x", $0) }.joined()
        let archiveName = RemoteRuntimeManifestV1.archiveName(
            version: "3.4.0", target: .darwinArm64)
        let manifest = try JSONDecoder().decode(
            RemoteRuntimeManifestV1.self,
            from: Data(#"""
            {
              "schemaVersion":1,
              "kind":"claudexor-remote-runtime",
              "version":"3.4.0",
              "buildSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "protocolMajor":3,
              "minAppVersion":"2.1.0",
              "notes":"uncertain activation test",
              "assets":[{
                "target":"darwin-arm64","platform":"darwin","arch":"arm64",
                "nodeVersion":"24.16.0","archiveName":"\#(archiveName)",
                "archiveUrl":"https://runtime.test/\#(archiveName)",
                "sha256":"\#(digest)"
              }],
              "keyId":"test","algorithm":"Ed25519","signature":"test"
            }
            """#.utf8))
        RemoteRuntimeArchiveURLProtocol.bytes = archive
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RemoteRuntimeArchiveURLProtocol.self]
        let candidateTarget = "versions/3.4.0-\(digest)"
        let transport = RemoteRuntimeTransportStub(steps: [
            .output(Data()), // pointer before snapshot
            .output(Data()), // pointer after snapshot
            .output(Data()), // archive upload
            .failure("install response lost"),
            .failure("readlink temporarily unavailable"),
            .output(Data("\(candidateTarget)\n".utf8)), // later recovery observation
            .output(Data(#"{"ok":true,"deactivated":true}"#.utf8)), // exact rollback
        ])
        let installer = RemoteRuntimeInstaller(
            ssh: transport,
            session: URLSession(configuration: configuration),
            developmentDirectory: nil)
        let connection = RemoteConnection(sshAlias: "uncertain-recovery")

        let recovery: RemoteRuntimeRecoveryRequired
        do {
            _ = try await installer.install(
                manifest, target: .darwinArm64, on: connection, appVersion: "3.4.0")
            Issue.record("an unreadable post-error pointer must retain recovery ownership")
            return
        } catch let error as RemoteRuntimeRecoveryRequired {
            recovery = error
        }
        #expect(recovery.primaryMessage.contains("install response lost"))
        #expect(recovery.recoveryMessage.contains("readlink temporarily unavailable"))

        try await installer.recoverPendingActivation(on: connection)
        #expect(await transport.commands.count == 7)
        do {
            try await installer.commitActivation(
                recovery.lease, serving: activationPayload().candidate, on: connection)
            Issue.record("the recovered uncertain lease must already be settled")
        } catch {
            // Exact stale-lease refusal proves recovery removed this owner.
        }
    }

    @Test func lostInstallResponseWithUnchangedPreviousPointerRestartsAndSettlesPrevious() async throws {
        let archive = Data("unchanged previous".utf8)
        let digest = SHA256.hash(data: archive)
            .map { String(format: "%02x", $0) }.joined()
        let archiveName = RemoteRuntimeManifestV1.archiveName(
            version: "3.4.0", target: .darwinArm64)
        let manifest = try JSONDecoder().decode(
            RemoteRuntimeManifestV1.self,
            from: Data(#"""
            {
              "schemaVersion":1,
              "kind":"claudexor-remote-runtime",
              "version":"3.4.0",
              "buildSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "protocolMajor":3,
              "minAppVersion":"2.1.0",
              "notes":"unchanged activation test",
              "assets":[{
                "target":"darwin-arm64","platform":"darwin","arch":"arm64",
                "nodeVersion":"24.16.0","archiveName":"\#(archiveName)",
                "archiveUrl":"https://runtime.test/\#(archiveName)",
                "sha256":"\#(digest)"
              }],
              "keyId":"test","algorithm":"Ed25519","signature":"test"
            }
            """#.utf8))
        RemoteRuntimeArchiveURLProtocol.bytes = archive
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RemoteRuntimeArchiveURLProtocol.self]
        let previousTarget = "versions/3.3.0-previous"
        let previousProbe = #"{"target":"darwin-arm64","version":"3.3.0","buildSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolMajor":3}"#
        let previousBootstrap = #"{"ok":true,"target":"darwin-arm64","version":"3.3.0","buildSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolMajor":3,"engineVersion":"3.3.0","engineBuildSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","endpoint":{"host":"127.0.0.1","port":43123,"token":"memory-only"}}"#
        let transport = RemoteRuntimeTransportStub(steps: [
            .output(Data("\(previousTarget)\n".utf8)),
            .output(Data(previousProbe.utf8)),
            .output(Data("\(previousTarget)\n".utf8)),
            .output(Data()), // archive upload
            .failure("install response lost before activation"),
            .output(Data("\(previousTarget)\n".utf8)),
            .output(Data(previousBootstrap.utf8)),
        ])
        let installer = RemoteRuntimeInstaller(
            ssh: transport,
            session: URLSession(configuration: configuration),
            developmentDirectory: nil)
        let connection = RemoteConnection(sshAlias: "unchanged-recovery")

        do {
            _ = try await installer.install(
                manifest, target: .darwinArm64, on: connection, appVersion: "3.4.0")
            Issue.record("a lost install response must still report the primary failure")
        } catch is RemoteRuntimeRecoveryRequired {
            Issue.record("a proven previous pointer and daemon should settle recovery")
        } catch {
            #expect(error.localizedDescription.contains("install response lost"))
        }

        try await installer.recoverPendingActivation(on: connection)
        #expect(await transport.commands.count == 7)
    }

    private func temporaryHome() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-remote-install-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func bundledDevelopmentRuntime() throws -> URL {
        let root = try temporaryHome()
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(
                "ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/remote-runtime-update")
        try FileManager.default.copyItem(
            at: fixture.appendingPathComponent("authority.json"),
            to: root.appendingPathComponent("authority.json"))
        let manifestURL = root.appendingPathComponent("remote-runtime-manifest.json")
        try FileManager.default.copyItem(
            at: fixture.appendingPathComponent("valid-manifest.json"),
            to: manifestURL)
        let manifest = try JSONDecoder().decode(
            RemoteRuntimeManifestV1.self, from: Data(contentsOf: manifestURL))
        let assets = root.appendingPathComponent("assets")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: false)
        for asset in manifest.assets {
            try Data("fixture-\(asset.target.rawValue)".utf8)
                .write(to: assets.appendingPathComponent(asset.archiveName))
        }
        return root
    }

    @Test func bundledDevelopmentManifestIsVerifiedWithoutReleaseNetwork() async throws {
        let directory = try bundledDevelopmentRuntime()
        defer { try? FileManager.default.removeItem(at: directory) }
        let ssh = SSHConnectionManager()
        let installer = RemoteRuntimeInstaller(
            ssh: ssh, developmentDirectory: directory)
        let manifest = try await installer.loadManifest()
        #expect(manifest.version == "3.4.0")
        #expect(manifest.assets.map(\.target) == RemoteRuntimeTarget.allCases)
        await ssh.shutdown()
    }

    @Test func bundledDevelopmentManifestFailsClosedOnTampering() async throws {
        let directory = try bundledDevelopmentRuntime()
        defer { try? FileManager.default.removeItem(at: directory) }
        let manifestURL = directory.appendingPathComponent("remote-runtime-manifest.json")
        var manifest = String(decoding: try Data(contentsOf: manifestURL), as: UTF8.self)
        manifest = manifest.replacingOccurrences(
            of: "remote-runtime cross-language test vector — never shipped",
            with: "tampered development runtime")
        try Data(manifest.utf8).write(to: manifestURL)

        let ssh = SSHConnectionManager()
        let installer = RemoteRuntimeInstaller(
            ssh: ssh, developmentDirectory: directory)
        do {
            _ = try await installer.loadManifest()
            Issue.record("a tampered bundled development manifest must be refused")
        } catch let error as SSHConnectionError {
            #expect(error.localizedDescription.contains("signature or shape is invalid"))
        }
        await ssh.shutdown()
    }

    @Test func bundledDevelopmentManifestRequiresEverySignedAsset() async throws {
        let directory = try bundledDevelopmentRuntime()
        defer { try? FileManager.default.removeItem(at: directory) }
        let manifest = try JSONDecoder().decode(
            RemoteRuntimeManifestV1.self,
            from: Data(contentsOf:
                directory.appendingPathComponent("remote-runtime-manifest.json")))
        let missing = try #require(manifest.assets.first)
        try FileManager.default.removeItem(
            at: directory.appendingPathComponent("assets")
                .appendingPathComponent(missing.archiveName))

        let ssh = SSHConnectionManager()
        let installer = RemoteRuntimeInstaller(
            ssh: ssh, developmentDirectory: directory)
        await #expect(throws: Error.self) {
            _ = try await installer.loadManifest()
        }
        await ssh.shutdown()
    }

    private func runtimeArchive(
        home: URL,
        marker: String,
        buildSha: String
    ) throws -> (url: URL, digest: String) {
        let payload = home.appendingPathComponent("payload-\(UUID().uuidString)")
        let bin = payload.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let cli = bin.appendingPathComponent("claudexor")
        let script = """
            #!/bin/sh
            set -eu
            case "${1:-} ${2:-}" in
              "remote probe")
                printf '%s\\n' '{"ok":true,"target":"darwin-arm64","version":"3.4.0","buildSha":"\(buildSha)","protocolMajor":3}'
                ;;
              "remote stop")
                test "$3" = "3.4.0"
                test "$4" = "\(buildSha)"
                if test -f "$HOME/refuse-stop-\(marker)"; then
                  printf '%s\\n' '{"ok":false,"code":"runtime_replacement_busy","retryable":true}'
                  exit 1
                fi
                printf '%s\\n' "\(marker)" >> "$HOME/stops"
                printf '%s\\n' '{"ok":true,"stopped":true}'
                ;;
              "remote bootstrap")
                printf '%s\\n' '{"ok":true,"target":"darwin-arm64","version":"3.4.0","buildSha":"\(buildSha)","protocolMajor":3,"engineVersion":"3.4.0","engineBuildSha":"\(buildSha)","endpoint":{"host":"127.0.0.1","port":43123,"token":"memory-only"}}'
                ;;
              "remote activate")
                root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
                if test "$3" = "-"; then test ! -e "$root/current"; else
                  test "$(readlink "$root/current")" = "$3"
                  rm -f "$root/last-known-good"
                  ln -s "$3" "$root/last-known-good"
                fi
                rm -f "$root/current"
                ln -s "$4" "$root/current"
                printf '%s\\n' '{"ok":true}'
                ;;
              "remote rollback")
                root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
                test "$(readlink "$root/current")" = "$3"
                rm -f "$root/current"
                if test "$4" != "-"; then ln -s "$4" "$root/current"; fi
                printf '%s\\n' '{"ok":true}'
                ;;
              *) exit 64;;
            esac
            """
        try Data(script.utf8).write(to: cli)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: cli.path)
        try Data(marker.utf8).write(to: payload.appendingPathComponent("marker"))
        let archive = home.appendingPathComponent("\(UUID().uuidString).tar.gz")
        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-czf", archive.path, "-C", payload.path, "."]
        try tar.run()
        tar.waitUntilExit()
        #expect(tar.terminationStatus == 0)
        let bytes = try Data(contentsOf: archive)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return (archive, digest)
    }

    private func run(
        script: String,
        arguments: [String],
        home: URL
    ) throws -> (status: Int32, stdout: Data, stderr: Data) {
        let scriptURL = home.appendingPathComponent("script-\(UUID().uuidString).sh")
        try Data(script.utf8).write(to: scriptURL)
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [scriptURL.path] + arguments
        process.environment = ProcessInfo.processInfo.environment.merging(["HOME": home.path]) {
            _, replacement in replacement
        }
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        return (
            process.terminationStatus,
            output.fileHandleForReading.readDataToEndOfFile(),
            errors.fileHandleForReading.readDataToEndOfFile())
    }

    private func stageArchive(
        _ archive: URL,
        digest: String,
        home: URL
    ) throws {
        let incoming = home.appendingPathComponent(".claudexor/remote/incoming")
        try FileManager.default.createDirectory(at: incoming, withIntermediateDirectories: true)
        try FileManager.default.copyItem(
            at: archive,
            to: incoming.appendingPathComponent("\(digest).tar.gz"))
    }

    @Test func sameVersionRepairKeepsOldClosureUntilCASActivationAndRollsBackPrecisely() throws {
        let home = try temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let first = try runtimeArchive(home: home, marker: "old", buildSha: oldBuild)
        try stageArchive(first.url, digest: first.digest, home: home)
        let initial = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", first.digest, "-", "-", "-"],
            home: home)
        #expect(initial.status == 0)
        let root = home.appendingPathComponent(".claudexor/remote")
        let oldTarget = "versions/3.4.0-\(first.digest)"
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: root.appendingPathComponent("current").path) == oldTarget)

        let second = try runtimeArchive(home: home, marker: "new", buildSha: newBuild)
        try stageArchive(second.url, digest: second.digest, home: home)
        let repair = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", second.digest, oldTarget, "3.4.0", oldBuild],
            home: home)
        #expect(repair.status == 0)
        let candidateTarget = "versions/3.4.0-\(second.digest)"
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: root.appendingPathComponent("current").path) == candidateTarget)
        #expect(
            String(decoding: try Data(
                contentsOf: root.appendingPathComponent(oldTarget).appendingPathComponent("marker")),
                as: UTF8.self) == "old")
        #expect(String(decoding: try Data(contentsOf: home.appendingPathComponent("stops")),
                       as: UTF8.self) == "old\n")

        let rollback = try run(
            script: RemoteRuntimeInstaller.rollbackScript,
            arguments: [
                candidateTarget, oldTarget, "3.4.0", newBuild, "3.4.0", oldBuild,
            ],
            home: home)
        #expect(rollback.status == 0)
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: root.appendingPathComponent("current").path) == oldTarget)
        let bootstrap = try JSONSerialization.jsonObject(with: rollback.stdout) as? [String: Any]
        #expect(bootstrap?["engineBuildSha"] as? String == oldBuild)
        #expect(String(decoding: try Data(contentsOf: home.appendingPathComponent("stops")),
                       as: UTF8.self) == "old\nnew\n")
    }

    /// A `current` that is not the runtime symlink exits 73. The SSH manager
    /// surfaces only stderr for a failed probe, so the probe names it there.
    @Test func pointerProbeNamesANonSymlinkCurrentOnStderr() throws {
        let home = try temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let current = home.appendingPathComponent(".claudexor/remote/current")
        try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
        let probe = try run(
            script: RemoteRuntimeInstaller.currentPointerProbeCommand, arguments: [], home: home)
        #expect(probe.status == 73)
        #expect(probe.stdout.isEmpty)
        let reason = String(decoding: probe.stderr, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(reason.contains(current.path))
        #expect(reason.contains("not a symlink"))
        #expect(AppModel.harnessInstallPreparationFailure(
            SSHConnectionError.commandFailed(reason), harness: "codex")
            == "Codex was not installed: " + reason)

        try FileManager.default.removeItem(at: current)
        try FileManager.default.createSymbolicLink(
            atPath: current.path, withDestinationPath: "versions/4.3.1-0123abcd")
        let linked = try run(
            script: RemoteRuntimeInstaller.currentPointerProbeCommand, arguments: [], home: home)
        #expect(linked.status == 0)
        #expect(try RemoteRuntimeInstaller.currentPointerTarget(fromProbe: linked.stdout)
            == "versions/4.3.1-0123abcd")
    }

    @Test func installLockAndCurrentCASRefuseConcurrentMutation() throws {
        let home = try temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let archive = try runtimeArchive(home: home, marker: "candidate", buildSha: newBuild)
        try stageArchive(archive.url, digest: archive.digest, home: home)
        let lock = home.appendingPathComponent(".claudexor/remote/.install-lock")
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: true)
        let locked = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", archive.digest, "-", "-", "-"],
            home: home)
        #expect(locked.status == 75)
        try FileManager.default.removeItem(at: lock)

        let raced = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: [
                "3.4.0", archive.digest, "versions/not-current", "3.3.0",
                String(repeating: "c", count: 40),
            ],
            home: home)
        #expect(raced.status == 75)
        #expect(!FileManager.default.fileExists(
            atPath: home.appendingPathComponent(".claudexor/remote/current").path))
    }

    @Test func installStopRefusalLeavesThePreviousPointerUntouched() throws {
        let home = try temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let first = try runtimeArchive(home: home, marker: "old", buildSha: oldBuild)
        try stageArchive(first.url, digest: first.digest, home: home)
        #expect(try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", first.digest, "-", "-", "-"],
            home: home).status == 0)
        let root = home.appendingPathComponent(".claudexor/remote")
        let oldTarget = "versions/3.4.0-\(first.digest)"
        try Data().write(to: home.appendingPathComponent("refuse-stop-old"))

        let second = try runtimeArchive(home: home, marker: "new", buildSha: newBuild)
        try stageArchive(second.url, digest: second.digest, home: home)
        let refused = try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", second.digest, oldTarget, "3.4.0", oldBuild],
            home: home)

        #expect(refused.status != 0)
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: root.appendingPathComponent("current").path) == oldTarget)
    }

    @Test func rollbackStopRefusalLeavesTheWorkingCandidatePointerUntouched() throws {
        let home = try temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let first = try runtimeArchive(home: home, marker: "old", buildSha: oldBuild)
        try stageArchive(first.url, digest: first.digest, home: home)
        #expect(try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", first.digest, "-", "-", "-"],
            home: home).status == 0)
        let oldTarget = "versions/3.4.0-\(first.digest)"
        let second = try runtimeArchive(home: home, marker: "new", buildSha: newBuild)
        try stageArchive(second.url, digest: second.digest, home: home)
        #expect(try run(
            script: RemoteRuntimeInstaller.installScript,
            arguments: ["3.4.0", second.digest, oldTarget, "3.4.0", oldBuild],
            home: home).status == 0)
        let candidateTarget = "versions/3.4.0-\(second.digest)"
        try Data().write(to: home.appendingPathComponent("refuse-stop-new"))

        let refused = try run(
            script: RemoteRuntimeInstaller.rollbackScript,
            arguments: [
                candidateTarget, oldTarget, "3.4.0", newBuild, "3.4.0", oldBuild,
            ],
            home: home)

        #expect(refused.status != 0)
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: home.appendingPathComponent(".claudexor/remote/current").path)
            == candidateTarget)
    }
}
