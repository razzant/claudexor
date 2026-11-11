import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct RemoteActionLeaseTests {
    @MainActor
    @Test func newestActionWinsAndDisconnectRetiresEveryLaneForThatHost() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let first = RemoteConnection(id: UUID(), sshAlias: "first-host")
        let second = RemoteConnection(id: UUID(), sshAlias: "second-host")
        model.remoteConnections = [first, second]
        model.remoteConnectionGenerations[first.id] = 4
        model.remoteConnectionGenerations[second.id] = 9

        let old = model.beginRemoteAction(.harnessInstall, connectionID: first.id)
        let current = model.beginRemoteAction(.harnessInstall, connectionID: second.id)
        let sibling = model.beginRemoteAction(.preview, connectionID: first.id)

        #expect(old != nil)
        #expect(current != nil)
        #expect(sibling != nil)
        #expect(model.remoteActionIsCurrent(old!) == false)
        #expect(model.remoteActionIsCurrent(current!) == true)
        #expect(model.remoteActionIsCurrent(sibling!) == true)

        model.retireRemoteActions(for: first.id)

        #expect(model.remoteActionIsCurrent(sibling!) == false)
        #expect(model.remoteActionIsCurrent(current!) == true)
    }

    @MainActor
    @Test func projectRegistrationIsConnectionScopedWhilePresentationsStayGlobal() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let first = RemoteConnection(id: UUID(), sshAlias: "project-a")
        let second = RemoteConnection(id: UUID(), sshAlias: "project-b")
        model.remoteConnections = [first, second]

        let projectA = model.beginRemoteAction(
            .projectRegistration, connectionID: first.id)!
        let projectB = model.beginRemoteAction(
            .projectRegistration, connectionID: second.id)!
        let browserA = model.beginRemoteAction(.directoryBrowser, connectionID: first.id)!
        let browserB = model.beginRemoteAction(.directoryBrowser, connectionID: second.id)!

        #expect(model.remoteActionIsCurrent(projectA))
        #expect(model.remoteActionIsCurrent(projectB))
        #expect(model.remoteActionIsCurrent(browserA) == false)
        #expect(model.remoteActionIsCurrent(browserB))
    }

    @MainActor
    @Test func reverseProjectRegistrationCompletionsBothPublishPerConnection() async throws {
        defer { RemoteActionURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RemoteActionURLProtocol.self]
        let session = URLSession(configuration: config)
        let first = RemoteConnection(id: UUID(), sshAlias: "registration-a")
        let second = RemoteConnection(id: UUID(), sshAlias: "registration-b")
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.remoteConnections = [first, second]
        model.remoteClients[first.locationID] = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:42001")!, token: "a", session: session)
        model.remoteClients[second.locationID] = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:42002")!, token: "b", session: session)
        let firstArrived = RemoteActionCounter()
        let releaseFirst = DispatchSemaphore(value: 0)
        RemoteActionURLProtocol.handler = { request in
            let body = try #require(remoteActionRequestBody(request))
            let root = try #require(
                (JSONSerialization.jsonObject(with: body) as? [String: String])?["root"])
            if root == "/project-a" {
                firstArrived.increment()
                _ = releaseFirst.wait(timeout: .now() + 5)
            }
            let id = root == "/project-a" ? "project-a" : "project-b"
            let data = Data("""
            {"schemaVersion":2,"id":"\(id)","root":"\(root)",
             "createdAt":"2026-07-29T00:00:00Z","updatedAt":"2026-07-29T00:00:00Z",
             "nesting":[]}
            """.utf8)
            return (RemoteActionURLProtocol.response(for: request), data)
        }

        let firstTask = try #require(model.selectRemoteProject(
            connectionID: first.id, path: "/project-a"))
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while firstArrived.value == 0 {
            try #require(ContinuousClock.now <= deadline, "first registration never arrived")
            await Task.yield()
        }
        let secondTask = try #require(model.selectRemoteProject(
            connectionID: second.id, path: "/project-b"))
        await secondTask.value
        releaseFirst.signal()
        await firstTask.value

        #expect(model.remoteProjects[first.locationID]?.map(\.root) == ["/project-a"])
        #expect(model.remoteProjects[second.locationID]?.map(\.root) == ["/project-b"])
    }

    @MainActor
    @Test func generationChangeMakesAnOtherwiseMatchingActionStale() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "generation-host")
        model.remoteConnections = [connection]
        model.remoteConnectionGenerations[connection.id] = 6
        let lease = model.beginRemoteAction(.projectRegistration, connectionID: connection.id)

        #expect(lease != nil)
        #expect(model.remoteActionIsCurrent(lease!) == true)

        model.remoteConnectionGenerations[connection.id] = 7

        #expect(model.remoteActionIsCurrent(lease!) == false)
    }

    @MainActor
    @Test func onlyTheNewestTokenCanRebindAfterReconnect() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "rebind-host")
        model.remoteConnections = [connection]
        model.remoteConnectionGenerations[connection.id] = 2
        let old = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!
        let newest = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!

        model.remoteConnectionGenerations[connection.id] = 3
        let oldRebound = model.rebindRemoteActionToCurrentGeneration(old)
        let newestRebound = model.rebindRemoteActionToCurrentGeneration(newest)

        #expect(oldRebound == nil)
        #expect(newestRebound?.generation == 3)
        #expect(newestRebound?.token == newest.token)
        #expect(model.remoteActionIsCurrent(newestRebound!))
    }

    @MainActor
    @Test func stalePromptDismissalCannotRetireTheReplacement() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "prompt-host")
        model.remoteConnections = [connection]
        let oldLease = model.beginRemoteAction(.harnessInstall, connectionID: connection.id)!
        let oldPrompt = remoteInstallTestPrompt(lease: oldLease, harness: "codex", command: "old")
        let newLease = model.beginRemoteAction(.harnessInstall, connectionID: connection.id)!
        let newPrompt = remoteInstallTestPrompt(lease: newLease, harness: "codex", command: "new")
        model.remoteHarnessInstallPrompt = newPrompt

        model.dismissRemoteHarnessInstallPrompt(oldPrompt)

        #expect(model.remoteHarnessInstallPrompt == newPrompt)
        #expect(model.remoteActionIsCurrent(newLease))
    }

    @MainActor
    @Test func acceptingPromptTransfersLeasePastAutomaticDialogDismissal() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "accept-host")
        model.remoteConnections = [connection]
        let lease = model.beginRemoteAction(.harnessInstall, connectionID: connection.id)!
        let prompt = remoteInstallTestPrompt(lease: lease, harness: "codex", command: "install")
        model.remoteHarnessInstallPrompt = prompt

        #expect(model.acceptRemoteHarnessInstallPrompt(prompt))
        #expect(model.remoteHarnessInstallPrompt == nil)
        #expect(model.remoteActionIsCurrent(lease))

        // SwiftUI's following binding write observes no prompt and therefore
        // cannot turn acceptance into cancellation.
        model.dismissRemoteHarnessInstallPrompt(prompt)
        #expect(model.remoteActionIsCurrent(lease))
    }

    @MainActor
    @Test func remoteInstallDisclosureNamesCommandsHomeAndCurrentOrExactTarget() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "disclosure-host")
        model.remoteConnections = [connection]
        let lease = model.beginRemoteAction(.harnessInstall, connectionID: connection.id)!
        for harness in ["agy", "cursor", "future-vendor"] {
            let current = RemoteHarnessInstallSection.disclosureText(
                remoteInstallTestPrompt(lease: lease, harness: harness), model: model)
            #expect(current.contains(HarnessFamily(rawValue: harness).label))
            #expect(current.contains("Vendor's current version at execution"))
            #expect(current.contains("Installation HOME: /fixture/home"))
            let exact = RemoteHarnessInstallSection.disclosureText(
                remoteInstallTestPrompt(lease: lease, harness: harness, version: "1.2.3"), model: model)
            #expect(exact.contains("Exact vendor version: 1.2.3"))
        }
    }

    @MainActor
    @Test func staleDeviceDismissalCannotCloseTheReplacement() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "login-host")
        model.remoteConnections = [connection]
        let oldLease = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!
        let oldRequest = RemoteDeviceLoginRequest(lease: oldLease, jobID: "old")
        let newLease = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!
        let newRequest = RemoteDeviceLoginRequest(lease: newLease, jobID: "new")
        model.remoteDeviceLogin = newRequest

        model.dismissRemoteDeviceLogin(oldRequest)

        #expect(model.remoteDeviceLogin == newRequest)
        #expect(model.remoteActionIsCurrent(newLease))
    }

    @MainActor
    @Test func sameTargetSetupJobCleanupTransfersToTheNewerWaiter() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "setup-owner")
        model.remoteConnections = [connection]
        let target = RemoteSetupLoginTarget(
            connectionID: connection.id, harness: "claude", profileID: "work",
            transport: "client_pty", loginFlow: nil)
        let older = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!
        model.beginRemoteSetupJobOwnership(lease: older, target: target)
        model.recordRemoteSetupJob("job-J", lease: older, target: target)

        let newer = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!
        model.beginRemoteSetupJobOwnership(lease: newer, target: target)

        #expect(model.finishRemoteSetupJobOwnership(
            lease: older, target: target, createdJobID: "job-J", handedOff: false) == nil)
        #expect(model.finishRemoteSetupJobOwnership(
            lease: newer, target: target, createdJobID: nil, handedOff: false) == "job-J")
    }

    @MainActor
    @Test func staleSetupResponseCannotCancelTheJobPresentedByItsReplacement() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "setup-presented")
        model.remoteConnections = [connection]
        let target = RemoteSetupLoginTarget(
            connectionID: connection.id, harness: "codex", profileID: nil,
            transport: "daemon", loginFlow: "device_auth")
        let older = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!
        model.beginRemoteSetupJobOwnership(lease: older, target: target)
        let newer = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!
        model.beginRemoteSetupJobOwnership(lease: newer, target: target)
        model.recordRemoteSetupJob("job-J", lease: older, target: target)
        model.remoteDeviceLogin = RemoteDeviceLoginRequest(lease: newer, jobID: "job-J")

        #expect(model.finishRemoteSetupJobOwnership(
            lease: newer, target: target, createdJobID: "job-J", handedOff: true) == nil)
        #expect(model.finishRemoteSetupJobOwnership(
            lease: older, target: target, createdJobID: "job-J", handedOff: false) == nil)
    }

    @MainActor
    @Test func deviceDismissalRetiresLeaseAfterSwiftUIClearsTheBindingFirst() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "dismiss-host")
        model.remoteConnections = [connection]
        let lease = model.beginRemoteAction(.setupLogin, connectionID: connection.id)!
        let request = RemoteDeviceLoginRequest(lease: lease, jobID: "job")
        model.remoteDeviceLogin = request

        model.remoteDeviceLogin = nil
        model.dismissRemoteDeviceLogin(request)

        #expect(model.remoteActionIsCurrent(lease) == false)
    }

    @MainActor
    @Test func stalePreviewCloseCannotRemoveTheReplacementForward() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "preview-host")
        model.remoteConnections = [connection]
        let oldLease = model.beginRemoteAction(.preview, connectionID: connection.id)!
        let oldRequest = RemotePreviewRequest(
            lease: oldLease, localPort: 41_001, remotePort: 3_000)
        let newLease = model.beginRemoteAction(.preview, connectionID: connection.id)!
        let newForward = SSHForward(
            connectionID: connection.id, localPort: 41_002, remotePort: 3_001)
        let newRequest = RemotePreviewRequest(
            lease: newLease, localPort: newForward.localPort, remotePort: newForward.remotePort)
        model.remotePreview = newRequest
        model.remotePreviewForwards[connection.id] = RemotePreviewForwardLease(
            action: newLease, forward: newForward)

        await model.closeRemotePreview(oldRequest)

        #expect(model.remotePreview == newRequest)
        #expect(model.remotePreviewForwards[connection.id]?.action == newLease)
        #expect(model.remoteActionIsCurrent(newLease))
    }

    @MainActor
    @Test func olderTerminalWriterAndDismissalCannotReplaceOrCloseNewestSheet() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "terminal-host")
        model.remoteConnections = [connection]
        let old = model.beginRemoteTerminalPresentation(connectionID: connection.id)!
        let newest = model.beginRemoteTerminalPresentation(connectionID: connection.id)!
        let invocation = SSHInvocation(executable: "/usr/bin/true", arguments: [])

        #expect(model.presentRemoteTerminal(
            newest, title: "new", invocation: invocation, purpose: .shell))
        let newestRequest = model.remoteTerminalSheet!
        #expect(model.presentRemoteTerminal(
            old, title: "old", invocation: invocation, purpose: .log) == false)
        #expect(model.remoteTerminalSheet == newestRequest)

        let staleRequest = RemoteTerminalSheetRequest(
            title: "old", invocation: invocation, purpose: .log,
            presentationLease: old)
        model.dismissRemoteTerminal(staleRequest)

        #expect(model.remoteTerminalSheet == newestRequest)
        #expect(model.remoteTerminalPresentationIsCurrent(newest))
    }

    @MainActor
    @Test func terminalDismissalRetiresTokenAfterSwiftUIClearsBindingFirst() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "terminal-dismiss-host")
        model.remoteConnections = [connection]
        let lease = model.beginRemoteTerminalPresentation(connectionID: connection.id)!
        let invocation = SSHInvocation(executable: "/usr/bin/true", arguments: [])
        #expect(model.presentRemoteTerminal(
            lease, title: "shell", invocation: invocation, purpose: .shell))
        let request = model.remoteTerminalSheet!

        model.remoteTerminalSheet = nil
        model.dismissRemoteTerminal(request)

        #expect(model.remoteTerminalPresentationIsCurrent(lease) == false)
    }

    @MainActor
    @Test func supersededAuthenticationPresentationLeavesReconnectableState() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "auth-race-host")
        model.remoteConnections = [connection]
        model.remoteConnectionGenerations[connection.id] = 8
        let auth = model.beginRemoteTerminalPresentation(connectionID: connection.id)!
        let newerShell = model.beginRemoteTerminalPresentation(connectionID: connection.id)!

        model.recordSupersededRemoteAuthentication(
            connectionID: connection.id, generation: 8, presentation: auth)

        #expect(model.remoteConnections.first?.status == .needsInteraction)
        #expect(model.remoteConnectionMessages[connection.id]?.contains("click Connect") == true)
        #expect(model.remoteTerminalPresentationIsCurrent(newerShell))
    }

    @MainActor
    @Test func directoryLoadsAcceptOnlyLatestRequestFromExactClientEpoch() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "directory-host")
        let location = connection.locationID
        let oldClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:41001")!, token: "old")
        let newClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:41002")!, token: "new")
        model.remoteConnections = [connection]
        model.remoteClients[location] = oldClient
        let action = model.beginRemoteAction(.directoryBrowser, connectionID: connection.id)!
        let lane = RemoteDirectoryLoadLane()

        let delayed = lane.begin(action: action, client: oldClient)
        let fast = lane.begin(action: action, client: oldClient)

        #expect(lane.accepts(delayed, in: model) == false)
        #expect(lane.accepts(fast, in: model))

        model.remoteClients[location] = newClient
        #expect(lane.accepts(fast, in: model) == false)
    }

    @MainActor
    @Test func manualRuntimeInstallRefusesBeforeIOWhenConnectOwnsTheHost() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "busy-runtime-host")
        model.remoteConnections = [connection]
        model.remoteConnectTasks[connection.id] = Task { @MainActor in }

        await model.installRemoteRuntime(connectionID: connection.id)

        #expect(
            model.remoteConnectionMessages[connection.id]
                == "A connection or runtime installation is already in progress.")
        #expect(model.remoteConnections.first?.status == .offline)
    }
}

private enum RemoteActionTestError: Error { case badRequest }

private func remoteActionRequestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { return nil }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

private final class RemoteActionCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}

private final class RemoteActionURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler:
        ((URLRequest) throws -> (HTTPURLResponse, Data))?

    static func response(for request: URLRequest) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let request = request
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            do {
                guard let handler = Self.handler else {
                    throw RemoteActionTestError.badRequest
                }
                let (response, data) = try handler(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }
    override func stopLoading() {}
}
