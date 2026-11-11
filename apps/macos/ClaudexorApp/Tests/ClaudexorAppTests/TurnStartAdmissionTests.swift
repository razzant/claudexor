import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

@Suite(.serialized)
struct TurnStartAdmissionTests {
    @Test func auxiliaryCardProjectionKeepsRoutingAndDropsHiddenControls() {
        var options = TurnOptions()
        options.maxUsd = 12
        options.access = "full"
        options.web = "live"
        options.untilClean = true
        options.delegate = true
        options.council = true
        options.models = ["codex": "gpt-5.6-terra", "claude": "claude-opus-5"]
        options.authRoute = "subscription"
        options.effort = "high"

        let projected = options.routingOverridesOnly
        #expect(projected.models == options.models)
        #expect(projected.authRoute == "subscription")
        #expect(projected.effort == "high")
        #expect(projected.maxUsd == nil)
        #expect(projected.access == nil)
        #expect(projected.web == nil)
        #expect(!projected.untilClean)
        #expect(!projected.delegate)
        #expect(!projected.council)
    }

    @MainActor
    @Test func blockedDraftAgentPerformsNoCreateUploadOrTurnRequest() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let model = turnStartModel(port: 12_341)
        model.projectRoot = "/tmp/blocked-draft"
        let target = model.composerTurnStartTarget
        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(
                root: target.repoRoot, inPlaceAgentConvergence: false))
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            throw TurnStartTestError.unexpectedRequest
        }

        let sent = await model.composerSend(
            prompt: "Implement",
            mode: .agent,
            attachments: [PendingAttachment(
                kind: "file", mime: "text/plain", name: "proof.txt",
                data: Data("must not upload".utf8))],
            options: TurnOptions(maxAttempts: 3),
            target: target)

        #expect(!sent)
        #expect(requests.count == 0)
    }

    @MainActor
    @Test func readOnlyAgentUsesReadOnlyApplicabilityAndOmitsConvergenceFields() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let model = turnStartModel(port: 12_374)
        let target = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread-readonly",
            repoRoot: "/tmp/readonly-agent",
            workspaceMode: "in_place",
            eligibleHarnesses: [])
        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(
                root: target.repoRoot,
                inPlaceReadOnly: true,
                inPlaceAgentConvergence: false,
                inPlaceAgentOther: false))
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/threads/thread-readonly/turns"):
                return turnStartResponse(request, status: 202,
                    body: #"{"jobId":"job-readonly","state":"queued","error":null}"#)
            case ("GET", "/v2/runs"):
                return turnStartResponse(request, body: #"{"runs":[]}"#)
            default:
                throw TurnStartTestError.unexpectedRequest
            }
        }
        var options = TurnOptions()
        options.access = AccessProfile.readOnly.wire

        #expect(await model.composerSend(
            prompt: "Inspect only",
            mode: .agent,
            options: options,
            target: target))
        let request = try #require(requests.first(
            method: "POST", path: "/v2/threads/thread-readonly/turns"))
        let body = try #require(try turnStartRequestObject(request))
        #expect(body["access"] as? String == "readonly")
        #expect(body["review"] as? Bool == false)
        #expect(body["attempts"] == nil)
        #expect(body["untilClean"] == nil)
    }

    @MainActor
    @Test func blockedImplementPerformsNoTurnPost() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let model = turnStartModel(port: 12_342)
        let target = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread-plan",
            repoRoot: "/tmp/isolated-plan",
            workspaceMode: "isolated",
            eligibleHarnesses: [])
        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(
                root: target.repoRoot, isolatedAgentConvergence: false))
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            throw TurnStartTestError.unexpectedRequest
        }

        let sent = await model.composerSend(
            prompt: "Implement this plan.",
            mode: .agent,
            planRunId: "run-plan",
            target: target)

        #expect(!sent)
        #expect(requests.count == 0)
    }

    @MainActor
    @Test func inPlacePlanAnswerWithoutGitPassesButIsolatedPlanFailsClosed() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let model = turnStartModel(port: 12_343)
        let root = "/tmp/plan-answer"
        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(
                root: root,
                inPlaceReadOnly: true,
                isolatedReadOnly: false))
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/threads/thread-plan/turns"):
                return turnStartResponse(request, status: 202,
                    body: #"{"jobId":"job-plan","state":"queued","error":null}"#)
            case ("GET", "/v2/runs"):
                return turnStartResponse(request, body: #"{"runs":[]}"#)
            default:
                throw TurnStartTestError.unexpectedRequest
            }
        }
        let inPlace = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread-plan",
            repoRoot: root,
            workspaceMode: "in_place",
            eligibleHarnesses: [])
        let isolated = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread-plan",
            repoRoot: root,
            workspaceMode: "isolated",
            eligibleHarnesses: [])

        #expect(await model.composerSend(
            prompt: "Answers", mode: .plan, target: inPlace))
        let afterAllowed = requests.count
        #expect(afterAllowed == 2)
        #expect(!(await model.composerSend(
            prompt: "Answers", mode: .plan, target: isolated)))
        #expect(requests.count == afterAllowed)
    }

    @MainActor
    @Test func loadingFailedAndRootMismatchedApplicabilityAllFailClosed() throws {
        let model = turnStartModel(port: 12_344)
        let target = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread",
            repoRoot: "/tmp/exact-root",
            workspaceMode: "in_place",
            eligibleHarnesses: [])

        model.runApplicabilityProjections[.local] = .loading(repoRoot: target.repoRoot)
        #expect(model.turnStartAdmission(
            target: target, mode: .agent, options: .init()).finalBlocker != nil)

        model.runApplicabilityProjections[.local] = .failed(
            repoRoot: target.repoRoot, message: "probe failed")
        #expect(model.turnStartAdmission(
            target: target, mode: .agent, options: .init()).finalBlocker == "probe failed")

        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(root: "/tmp/another-root"))
        #expect(model.turnStartAdmission(
            target: target, mode: .agent, options: .init()).finalBlocker != nil)

        let noProjectIsolated = TurnStartTarget.draft(
            locationID: .local,
            createRequest: CreateThreadRequest(
                scope: .none, workspace: "isolated"),
            eligibleHarnesses: [])
        #expect(model.turnStartAdmission(
            target: noProjectIsolated, mode: .ask, options: .init()).finalBlocker != nil)
    }

    @MainActor
    @Test func offlineRemoteIsOneClickPreparableButRealBlockerHasOneReason() throws {
        let model = turnStartModel(port: 12_364)
        let remoteTarget = TurnStartTarget.existing(
            locationID: .remote(UUID()),
            threadID: "thread-remote",
            repoRoot: "/remote/project",
            workspaceMode: "in_place",
            eligibleHarnesses: [])
        let preparable = model.turnStartAdmission(
            target: remoteTarget, mode: .agent, options: .init())
        #expect(preparable.interactionBlocker == nil)
        #expect(preparable.finalBlocker != nil)
        #expect(ComposerSendAvailability.resolve(
            message: "Send",
            blockers: preparable.interactionBlocker.map {
                [.applicability($0)]
            } ?? []).enabled)

        let localTarget = TurnStartTarget.existing(
            locationID: .local,
            threadID: "thread-local",
            repoRoot: "/local/project",
            workspaceMode: "in_place",
            eligibleHarnesses: [])
        model.runApplicabilityProjections[.local] = .ready(
            try testRunApplicabilityResponse(
                root: localTarget.repoRoot, inPlaceAgentConvergence: false))
        let blocked = model.turnStartAdmission(
            target: localTarget, mode: .agent, options: .init())
        let reason = try #require(blocked.interactionBlocker)
        #expect(blocked.finalBlocker == reason)
        #expect(ComposerSendAvailability.resolve(
            message: "Send", blockers: [.applicability(reason)]).disabledReason == reason)
    }

    @MainActor
    @Test func draftLocationRootWorkspaceAndPoolStayFrozenAcrossAwait() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let remoteID = UUID()
        let locationID = ExecutionLocationID.remote(remoteID)
        let model = AppModel(requestNotificationAuthorization: false)
        model.remoteClients[locationID] = turnStartClient(port: 12_345)
        model.draftExecutionLocation = locationID
        model.draftRemoteProjectRoot = "/remote/original"
        model.draftIsolatedWorkspace = true
        model.draftEligiblePool = ["claude", "cursor"]
        model.runApplicabilityProjections[locationID] = .ready(
            try testRunApplicabilityResponse(root: "/remote/original"))

        let createStarted = TurnStartRecorder()
        let requests = TurnStartRecorder()
        let releaseCreate = DispatchSemaphore(value: 0)
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/threads"):
                createStarted.record(request)
                _ = releaseCreate.wait(timeout: .now() + 5)
                return turnStartResponse(request, body: testThreadJSON(
                    id: "thread-frozen", root: "/remote/original",
                    workspace: "isolated", eligible: ["claude", "cursor"]))
            case ("GET", "/v2/projects"):
                return turnStartResponse(request, body: #"{"projects":[]}"#)
            case ("POST", "/v2/threads/thread-frozen/turns"):
                return turnStartResponse(request, status: 202,
                    body: #"{"jobId":"job-frozen","state":"queued","error":null}"#)
            default:
                throw TurnStartTestError.unexpectedRequest
            }
        }

        let send = Task { @MainActor in
            await model.composerSend(
                prompt: "Race",
                mode: .bestOfN,
                target: model.composerTurnStartTarget,
                onMaterializedThread: { _ in false })
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while createStarted.count == 0 {
            try #require(ContinuousClock.now <= deadline, "create request never arrived")
            await Task.yield()
        }
        model.draftExecutionLocation = .local
        model.projectRoot = "/local/replacement"
        model.draftRemoteProjectRoot = "/remote/replacement"
        model.draftIsolatedWorkspace = false
        model.draftEligiblePool = ["codex"]
        releaseCreate.signal()

        #expect(await send.value)
        let create = try #require(requests.first(method: "POST", path: "/v2/threads"))
        let decodedCreateBody = try turnStartRequestObject(create)
        let createBody = try #require(decodedCreateBody)
        let scope = try #require(createBody["scope"] as? [String: Any])
        #expect(scope["root"] as? String == "/remote/original")
        #expect(createBody["workspace"] as? String == "isolated")
        #expect(create.url?.port == 12_345)
        let turn = try #require(requests.first(
            method: "POST", path: "/v2/threads/thread-frozen/turns"))
        let decodedTurnBody = try turnStartRequestObject(turn)
        let turnBody = try #require(decodedTurnBody)
        #expect(turnBody["harnesses"] as? [String] == ["claude", "cursor"])
        #expect(turn.url?.port == 12_345)
    }

    @MainActor
    @Test func refusedRetryUsesCapturedLocationAndPerLocationBusyState() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let remoteID = UUID()
        let remote = ExecutionLocationID.remote(remoteID)
        let model = turnStartModel(port: 12_346)
        model.remoteClients[remote] = turnStartClient(port: 12_347)
        model.selectedExecutionLocation = .local
        model.selectedThreadId = "same-id"
        model.threads = [try testThread(
            id: "same-id", root: "/local", workspace: "in_place",
            headRunID: "run-local")]
        model.liveTasks = [turnStartActiveRun(id: "run-local")]
        model.remoteThreadCache = [RemoteThreadCacheEntry(
            locationID: remote,
            thread: try testThread(
                id: "same-id", root: "/remote", workspace: "in_place"),
            syncedAt: .now)]
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_347,
                  request.httpMethod == "POST",
                  request.url?.path == "/v2/threads/same-id/turns/refused/retry"
            else { throw TurnStartTestError.unexpectedRequest }
            return turnStartResponse(request, status: 202,
                body: #"{"jobId":"job-retry","state":"queued","error":null}"#)
        }

        #expect(await model.retryTurn(
            locationID: remote, threadId: "same-id", turnId: "refused"))
        #expect(requests.count == 1)
    }

    @MainActor
    @Test func offlineRemoteDraftReconnectsAndKeepsItsFrozenTarget() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let remoteID = UUID()
        let locationID = ExecutionLocationID.remote(remoteID)
        let remoteClient = turnStartClient(port: 12_352)
        let model = AppModel(requestNotificationAuthorization: false)
        model.draftExecutionLocation = locationID
        model.draftRemoteProjectRoot = "/remote/reconnect"
        model.draftIsolatedWorkspace = true
        let target = model.composerTurnStartTarget
        let connectGate = TurnStartAsyncGate()
        model.remoteConnectTasks[remoteID] = Task { @MainActor in
            await connectGate.wait()
            model.remoteClients[locationID] = remoteClient
        }
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_352 else {
                throw TurnStartTestError.unexpectedRequest
            }
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v2/run-applicability"):
                let response = try testRunApplicabilityResponse(root: "/remote/reconnect")
                return turnStartResponse(
                    request,
                    body: String(decoding: try JSONEncoder().encode(response), as: UTF8.self))
            case ("POST", "/v2/threads"):
                return turnStartResponse(request, body: testThreadJSON(
                    id: "thread-reconnected", root: "/remote/reconnect",
                    workspace: "isolated"))
            case ("GET", "/v2/projects"):
                return turnStartResponse(request, body: #"{"projects":[]}"#)
            case ("POST", "/v2/threads/thread-reconnected/turns"):
                return turnStartResponse(request, status: 202,
                    body: #"{"jobId":"job-reconnected","state":"queued","error":null}"#)
            case ("GET", "/v2/threads"):
                return turnStartResponse(request, body: #"{"threads":[]}"#)
            default:
                throw TurnStartTestError.unexpectedRequest
            }
        }

        let send = Task { @MainActor in
            await model.composerSend(
                prompt: "Reconnect once",
                mode: .agent,
                target: target,
                onMaterializedThread: { _ in false })
        }
        let connectDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !(await connectGate.isWaiting) {
            try #require(ContinuousClock.now <= connectDeadline, "connect never started")
            await Task.yield()
        }
        model.draftExecutionLocation = .local
        model.projectRoot = "/local/replacement"
        model.draftRemoteProjectRoot = "/remote/replacement"
        model.draftIsolatedWorkspace = false
        await connectGate.open()

        #expect(await send.value)
        let applicability = try #require(requests.first(
            method: "GET", path: "/v2/run-applicability"))
        #expect(URLComponents(
            url: applicability.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "repoRoot" })?.value
            == "/remote/reconnect")
        let create = try #require(requests.first(method: "POST", path: "/v2/threads"))
        #expect(create.url?.port == 12_352)
        let body = try #require(try turnStartRequestObject(create))
        #expect((body["scope"] as? [String: Any])?["root"] as? String == "/remote/reconnect")
        #expect(body["workspace"] as? String == "isolated")
    }

    @MainActor
    @Test func clientReplacementDuringCreateCannotRetargetTheTurn() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let locationID = ExecutionLocationID.remote(UUID())
        let model = AppModel(requestNotificationAuthorization: false)
        let firstClient = turnStartClient(port: 12_353)
        let replacementClient = turnStartClient(port: 12_354)
        model.remoteClients[locationID] = firstClient
        let target = TurnStartTarget.draft(
            locationID: locationID,
            createRequest: CreateThreadRequest(
                scope: .project(root: "/remote/create-lease")),
            eligibleHarnesses: [])
        model.runApplicabilityProjections[locationID] = .ready(
            try testRunApplicabilityResponse(root: target.repoRoot))
        let createStarted = TurnStartRecorder()
        let releaseCreate = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_353,
                  request.httpMethod == "POST",
                  request.url?.path == "/v2/threads"
            else { throw TurnStartTestError.unexpectedRequest }
            createStarted.record(request)
            _ = releaseCreate.wait(timeout: .now() + 5)
            return turnStartResponse(request, body: testThreadJSON(
                id: "thread-client-a", root: target.repoRoot,
                workspace: "in_place"))
        }

        let send = Task { @MainActor in
            await model.composerSend(
                prompt: "Do not cross daemons", mode: .agent,
                target: target, onMaterializedThread: { _ in false })
        }
        let createDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while createStarted.count == 0 {
            try #require(ContinuousClock.now <= createDeadline, "create never started")
            await Task.yield()
        }
        model.adoptRemoteClientForReconnect(replacementClient, at: locationID)
        releaseCreate.signal()

        #expect(!(await send.value))
        #expect(requests.count == 1)
        #expect(requests.first(
            method: "POST", path: "/v2/threads/thread-client-a/turns") == nil)
    }

    @MainActor
    @Test func preparedApplicabilityReceiptSurvivesAnotherRootRefresh() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let locationID = ExecutionLocationID.remote(UUID())
        let model = AppModel(requestNotificationAuthorization: false)
        model.remoteClients[locationID] = turnStartClient(port: 12_365)
        let target = TurnStartTarget.draft(
            locationID: locationID,
            createRequest: CreateThreadRequest(
                scope: .project(root: "/remote/root-a")),
            eligibleHarnesses: [])
        let rootAStarted = TurnStartRecorder()
        let releaseRootA = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_365 else {
                throw TurnStartTestError.unexpectedRequest
            }
            let root = TurnStartRequestParsing.queryValue(
                "repoRoot", in: request)
            switch (request.httpMethod, request.url?.path, root) {
            case ("GET", "/v2/run-applicability", "/remote/root-a"):
                rootAStarted.record(request)
                _ = releaseRootA.wait(timeout: .now() + 5)
                let response = try testRunApplicabilityResponse(root: "/remote/root-a")
                return turnStartResponse(request, body: String(
                    decoding: try JSONEncoder().encode(response), as: UTF8.self))
            case ("POST", "/v2/threads", _):
                return turnStartResponse(request, body: testThreadJSON(
                    id: "thread-root-a", root: "/remote/root-a",
                    workspace: "in_place"))
            case ("GET", "/v2/projects", _):
                return turnStartResponse(request, body: #"{"projects":[]}"#)
            case ("POST", "/v2/threads/thread-root-a/turns", _):
                return turnStartResponse(request, status: 202,
                    body: #"{"jobId":"job-root-a","state":"queued","error":null}"#)
            case ("GET", "/v2/threads", _):
                return turnStartResponse(request, body: #"{"threads":[]}"#)
            default:
                throw TurnStartTestError.unexpectedRequest
            }
        }

        let send = Task { @MainActor in
            await model.composerSend(
                prompt: "Keep root A", mode: .agent,
                target: target, onMaterializedThread: { _ in false })
        }
        let rootADeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while rootAStarted.count == 0 {
            try #require(ContinuousClock.now <= rootADeadline, "root A probe never started")
            await Task.yield()
        }
        model.runApplicabilityProjections[locationID] = .ready(
            try testRunApplicabilityResponse(root: "/remote/root-b"))
        #expect(model.runApplicabilityProjections[locationID]?.repoRoot == "/remote/root-b")
        releaseRootA.signal()

        #expect(await send.value)
        let create = try #require(requests.first(method: "POST", path: "/v2/threads"))
        let body = try #require(try turnStartRequestObject(create))
        #expect((body["scope"] as? [String: Any])?["root"] as? String == "/remote/root-a")
    }

    @MainActor
    @Test func clientReplacementDuringUploadCannotRetargetTheTurn() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let locationID = ExecutionLocationID.remote(UUID())
        let model = AppModel(requestNotificationAuthorization: false)
        let firstClient = turnStartClient(port: 12_355)
        let replacementClient = turnStartClient(port: 12_356)
        model.remoteClients[locationID] = firstClient
        let target = TurnStartTarget.existing(
            locationID: locationID,
            threadID: "thread-upload",
            repoRoot: "/remote/upload-lease",
            workspaceMode: "in_place",
            eligibleHarnesses: [])
        model.runApplicabilityProjections[locationID] = .ready(
            try testRunApplicabilityResponse(root: target.repoRoot))
        let finalizeStarted = TurnStartRecorder()
        let releaseFinalize = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_355 else {
                throw TurnStartTestError.unexpectedRequest
            }
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/uploads"):
                return turnStartResponse(request, status: 201,
                    body: #"{"uploadId":"upload-a"}"#)
            case ("PUT", "/v2/uploads/upload-a/bytes"):
                return turnStartResponse(request, body: "{}")
            case ("POST", "/v2/uploads/upload-a/finalize"):
                finalizeStarted.record(request)
                _ = releaseFinalize.wait(timeout: .now() + 5)
                return turnStartResponse(request, status: 201,
                    body: #"{"resourceId":"resource-a"}"#)
            default:
                throw TurnStartTestError.unexpectedRequest
            }
        }

        let send = Task { @MainActor in
            await model.composerSend(
                prompt: "Do not cross daemons",
                mode: .plan,
                attachments: [PendingAttachment(
                    kind: "file", mime: "text/plain", name: "lease.txt",
                    data: Data("lease".utf8))],
                target: target)
        }
        let uploadDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while finalizeStarted.count == 0 {
            try #require(ContinuousClock.now <= uploadDeadline, "upload never finalized")
            await Task.yield()
        }
        model.adoptRemoteClientForReconnect(replacementClient, at: locationID)
        releaseFinalize.signal()

        #expect(!(await send.value))
        #expect(requests.first(
            method: "POST", path: "/v2/threads/thread-upload/turns") == nil)
    }

    @MainActor
    @Test func replacedClientCannotReusePreviousDaemonApplicability() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let locationID = ExecutionLocationID.remote(UUID())
        let model = AppModel(requestNotificationAuthorization: false)
        model.remoteClients[locationID] = turnStartClient(port: 12_368)
        let target = TurnStartTarget.existing(
            locationID: locationID,
            threadID: "thread",
            repoRoot: "/remote/client-b",
            workspaceMode: "in_place",
            eligibleHarnesses: [])
        model.runApplicabilityProjections[locationID] = .ready(
            try testRunApplicabilityResponse(
                root: target.repoRoot, inPlaceAgentConvergence: false))
        let clientB = turnStartClient(port: 12_369)
        model.adoptRemoteClientForReconnect(clientB, at: locationID)
        #expect(model.runApplicabilityProjections[locationID] == nil)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_369,
                  request.httpMethod == "GET",
                  request.url?.path == "/v2/run-applicability"
            else { throw TurnStartTestError.unexpectedRequest }
            let response = try testRunApplicabilityResponse(root: target.repoRoot)
            return turnStartResponse(request, body: String(
                decoding: try JSONEncoder().encode(response), as: UTF8.self))
        }

        switch await model.prepareTurnStart(target) {
        case .ready(let prepared):
            #expect(prepared.client === clientB)
            #expect(prepared.applicability?.repoRoot == target.repoRoot)
        case .blocked(let message):
            Issue.record("Preparation unexpectedly failed: \(message)")
        }
        #expect(requests.count == 1)
    }

    @MainActor
    @Test func exactRetryDoesNotOpenAThreadSelectedDuringTheRequest() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let locationID = ExecutionLocationID.remote(UUID())
        let model = turnStartModel(port: 12_357)
        model.remoteClients[locationID] = turnStartClient(port: 12_358)
        model.selectedExecutionLocation = locationID
        model.selectedThreadId = "thread-original"
        let retryStarted = TurnStartRecorder()
        let releaseRetry = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_358,
                  request.httpMethod == "POST",
                  request.url?.path == "/v2/runs/run-old/retry"
            else { throw TurnStartTestError.unexpectedRequest }
            retryStarted.record(request)
            _ = releaseRetry.wait(timeout: .now() + 5)
            return turnStartResponse(request, status: 202,
                body: #"{"retryOf":"run-old","jobId":"job-new","runId":"run-new","turnId":null,"state":"queued"}"#)
        }

        let retry = Task { @MainActor in
            await model.retryRunExact("run-old", locationID: locationID)
        }
        let retryDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while retryStarted.count == 0 {
            try #require(ContinuousClock.now <= retryDeadline, "retry never started")
            await Task.yield()
        }
        model.selectedExecutionLocation = .local
        model.selectedThreadId = "thread-new-selection"
        releaseRetry.signal()

        #expect(await retry.value == nil)
        #expect(requests.count == 1)
        #expect(model.selectedExecutionLocation == .local)
        #expect(model.selectedThreadId == "thread-new-selection")
    }

    @MainActor
    @Test func staleThreadLoadFailureCannotDisconnectReplacementClient() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let locationID = ExecutionLocationID.remote(UUID())
        let model = AppModel(requestNotificationAuthorization: false)
        model.remoteClients[locationID] = turnStartClient(port: 12_370)
        let clientB = turnStartClient(port: 12_371)
        let detailStarted = TurnStartRecorder()
        let releaseDetail = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_370,
                  request.httpMethod == "GET",
                  request.url?.path == "/v2/threads/thread-a/history"
            else { throw TurnStartTestError.unexpectedRequest }
            detailStarted.record(request)
            _ = releaseDetail.wait(timeout: .now() + 5)
            throw URLError(.networkConnectionLost)
        }

        let load = Task { @MainActor in
            await model.openThread(locationID: locationID, id: "thread-a")
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while detailStarted.count == 0 {
            try #require(ContinuousClock.now <= deadline, "thread detail never started")
            await Task.yield()
        }
        model.adoptRemoteClientForReconnect(clientB, at: locationID)
        releaseDetail.signal()
        await load.value

        #expect(model.gateway(for: locationID) === clientB)
        #expect(requests.count == 1)
    }

    @MainActor
    @Test func clientReplacementDuringLocalRetryRefreshCannotRouteOldRunID() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let firstClient = turnStartClient(port: 12_372)
        let replacementClient = turnStartClient(port: 12_373)
        let model = AppModel(
            client: firstClient, requestNotificationAuthorization: false)
        model.selectedExecutionLocation = .local
        model.selectedThreadId = "thread-original"
        model.route = .threads
        model.streamTasks["run-new"] = Task {}
        let refreshStarted = TurnStartRecorder()
        let releaseRefresh = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_372 else {
                throw TurnStartTestError.unexpectedRequest
            }
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/runs/run-old/retry"):
                return turnStartResponse(request, status: 202,
                    body: #"{"retryOf":"run-old","jobId":"job-new","runId":"run-new","turnId":null,"state":"queued"}"#)
            case ("GET", "/v2/runs"):
                refreshStarted.record(request)
                _ = releaseRefresh.wait(timeout: .now() + 5)
                return turnStartResponse(request, body: #"{"runs":[]}"#)
            default:
                throw TurnStartTestError.unexpectedRequest
            }
        }

        let retry = Task { @MainActor in
            await model.retryRunExact("run-old", locationID: .local)
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while refreshStarted.count == 0 {
            try #require(ContinuousClock.now <= deadline, "runs refresh never started")
            await Task.yield()
        }
        model.adoptClientForReconnect(replacementClient)
        releaseRefresh.signal()

        #expect(await retry.value == nil)
        #expect(model.gateway(for: .local) === replacementClient)
        #expect(model.route == .threads)
        #expect(requests.count == 2)
    }

    @MainActor
    @Test func applyRunDoesNotOpenAThreadSelectedDuringTheRequest() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let locationID = ExecutionLocationID.remote(UUID())
        let model = turnStartModel(port: 12_359)
        model.remoteClients[locationID] = turnStartClient(port: 12_360)
        model.selectedExecutionLocation = locationID
        model.selectedThreadId = "thread-original"
        let applyStarted = TurnStartRecorder()
        let releaseApply = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_360,
                  request.httpMethod == "POST",
                  request.url?.path == "/v2/runs/run-old/apply"
            else { throw TurnStartTestError.unexpectedRequest }
            applyStarted.record(request)
            _ = releaseApply.wait(timeout: .now() + 5)
            return turnStartResponse(request, body: #"""
            {
                "mode":"apply","applied":true,"branch":null,"commit":null,
                "prUrl":null,"detail":null,"treeMutated":true,"refused":false,
                "finalVerify":{"attempted":false,"base_sha":null,
                "applied_cleanly":null,"gates_passed":null,"gates":[],
                "duration_ms":null,"reason":null},
                "targetPreimageSha":"sha256:test"
            }
            """#)
        }

        let apply = Task { @MainActor in
            await model.applyRun(runId: "run-old", locationID: locationID)
        }
        let applyDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while applyStarted.count == 0 {
            try #require(ContinuousClock.now <= applyDeadline, "apply never started")
            await Task.yield()
        }
        model.selectedExecutionLocation = .local
        model.selectedThreadId = "thread-new-selection"
        releaseApply.signal()

        #expect(await apply.value == nil)
        #expect(requests.count == 1)
        #expect(model.selectedExecutionLocation == .local)
        #expect(model.selectedThreadId == "thread-new-selection")
    }

    @MainActor
    @Test func trustRetryUsesCapturedLocationAndRepoRoot() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let remote = ExecutionLocationID.remote(UUID())
        let model = turnStartModel(port: 12_348)
        model.remoteClients[remote] = turnStartClient(port: 12_349)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_349 else {
                throw TurnStartTestError.unexpectedRequest
            }
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/trust"):
                let decodedBody = try turnStartRequestObject(request)
                let body = try #require(decodedBody)
                #expect(body["repoRoot"] as? String == "/remote/captured")
                return turnStartResponse(request, body:
                    #"{"repoRoot":"/remote/captured","path":"/trust/file","allowFullAccess":true,"accessDefault":"workspace_write"}"#)
            case ("GET", "/v2/trust"):
                return turnStartResponse(request, body: #"{"entries":[]}"#)
            case ("POST", "/v2/threads/thread/turns/refused/retry"):
                return turnStartResponse(request, status: 202,
                    body: #"{"jobId":"job-trust-retry","state":"queued","error":null}"#)
            default:
                throw TurnStartTestError.unexpectedRequest
            }
        }

        #expect(await model.grantFullAccessAndRetry(
            locationID: remote,
            threadId: "thread",
            turnId: "refused",
            repoRoot: "/remote/captured"))
        #expect(requests.count == 3)
    }

    @MainActor
    @Test func clientReplacementAfterTrustGrantCannotRetargetRetry() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let locationID = ExecutionLocationID.remote(UUID())
        let model = turnStartModel(port: 12_361)
        let firstClient = turnStartClient(port: 12_362)
        let replacementClient = turnStartClient(port: 12_363)
        model.remoteClients[locationID] = firstClient
        let trustStarted = TurnStartRecorder()
        let releaseTrust = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_362,
                  request.httpMethod == "POST",
                  request.url?.path == "/v2/trust"
            else { throw TurnStartTestError.unexpectedRequest }
            trustStarted.record(request)
            _ = releaseTrust.wait(timeout: .now() + 5)
            return turnStartResponse(request, body:
                #"{"repoRoot":"/remote/trust-lease","path":"/trust/file","allowFullAccess":true,"accessDefault":"workspace_write"}"#)
        }

        let retry = Task { @MainActor in
            await model.grantFullAccessAndRetry(
                locationID: locationID,
                threadId: "thread",
                turnId: "refused",
                repoRoot: "/remote/trust-lease")
        }
        let trustDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while trustStarted.count == 0 {
            try #require(ContinuousClock.now <= trustDeadline, "trust grant never started")
            await Task.yield()
        }
        model.adoptRemoteClientForReconnect(replacementClient, at: locationID)
        releaseTrust.signal()

        #expect(!(await retry.value))
        #expect(requests.count == 1)
        #expect(requests.first(
            method: "POST", path: "/v2/threads/thread/turns/refused/retry") == nil)
    }

    @MainActor
    @Test func runAgainUsesEvidenceCardsCapturedLocation() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let remote = ExecutionLocationID.remote(UUID())
        let model = turnStartModel(port: 12_350)
        model.remoteClients[remote] = turnStartClient(port: 12_351)
        let draft = try JSONDecoder().decode(
            RunAgainDraft.self,
            from: Data(#"{"sourceRunId":"run-old","request":{"prompt":"old","mode":"ask"},"accessChoice":{"required":false},"differences":[]}"#.utf8))
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_351,
                  request.httpMethod == "POST",
                  request.url?.path == "/v2/runs"
            else { throw TurnStartTestError.unexpectedRequest }
            return turnStartResponse(request, status: 202,
                body: #"{"jobId":"job-again","state":"queued","error":null}"#)
        }

        #expect(await model.startRunAgain(
            draft, prompt: "new", locationID: remote) == nil)
        #expect(requests.count == 1)
    }

    @MainActor
    @Test func retiredRunAgainRequiresAndSubmitsExplicitActiveAccess() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let model = turnStartModel(port: 12_365)
        let draft = try JSONDecoder().decode(
            RunAgainDraft.self,
            from: Data(#"{"sourceRunId":"run-old","request":{"prompt":"old","mode":"agent","review":true},"accessChoice":{"required":true},"differences":[]}"#.utf8))
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_365,
                  request.httpMethod == "POST",
                  request.url?.path == "/v2/runs"
            else { throw TurnStartTestError.unexpectedRequest }
            return turnStartResponse(request, status: 202,
                body: #"{"jobId":"job-again","state":"queued","error":null}"#)
        }

        #expect(await model.startRunAgain(
            draft, prompt: "new", locationID: .local)
            == "Run Again requires an explicit access choice.")
        #expect(requests.count == 0)

        #expect(await model.startRunAgain(
            draft, prompt: "new", access: .workspaceWrite, locationID: .local) == nil)
        let request = try #require(requests.first(method: "POST", path: "/v2/runs"))
        let decoded = try turnStartRequestObject(request)
        let object = try #require(decoded)
        #expect(object["prompt"] as? String == "new")
        #expect(object["access"] as? String == "workspace_write")
        #expect(object["review"] as? Bool == true)
    }

    @MainActor
    @Test func clientReplacementAfterRunAgainPostCannotRouteOldRunID() async throws {
        defer { TurnStartStubURLProtocol.handler = nil }
        let firstClient = turnStartClient(port: 12_366)
        let replacementClient = turnStartClient(port: 12_367)
        let model = AppModel(
            client: firstClient, requestNotificationAuthorization: false)
        let draft = try JSONDecoder().decode(
            RunAgainDraft.self,
            from: Data(#"{"sourceRunId":"run-old","request":{"prompt":"old","mode":"ask"},"accessChoice":{"required":false},"differences":[]}"#.utf8))
        let start = TurnStartRecorder()
        let release = DispatchSemaphore(value: 0)
        let requests = TurnStartRecorder()
        TurnStartStubURLProtocol.handler = { request in
            requests.record(request)
            guard request.url?.port == 12_366,
                  request.httpMethod == "POST",
                  request.url?.path == "/v2/runs"
            else { throw TurnStartTestError.unexpectedRequest }
            start.record(request)
            _ = release.wait(timeout: .now() + 5)
            return turnStartResponse(request, status: 202,
                body: #"{"jobId":"job-again-a","state":"queued","error":null}"#)
        }

        let runAgain = Task { @MainActor in
            await model.startRunAgain(
                draft, prompt: "new", locationID: .local)
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while start.count == 0 {
            try #require(ContinuousClock.now <= deadline, "Run Again never started")
            await Task.yield()
        }
        model.adoptClientForReconnect(replacementClient)
        release.signal()

        #expect(await runAgain.value == nil)
        #expect(requests.count == 1)
    }
}

func testRunApplicabilityResponse(
    root: String,
    inPlaceReadOnly: Bool = true,
    inPlaceAgentConvergence: Bool = true,
    inPlaceAgentOther: Bool = true,
    isolatedReadOnly: Bool = true,
    isolatedAgentConvergence: Bool = true,
    isolatedAgentOther: Bool = true
) throws -> ControlRunApplicabilityResponse {
    func cell(_ applicable: Bool) -> [String: Any] {
        [
            "applicable": applicable,
            "requiresGit": !applicable,
            "code": applicable ? NSNull() : "git_unavailable",
            "reason": applicable ? NSNull() : "Git is unavailable.",
            "remediation": applicable ? NSNull() : "Install Git and recheck.",
        ]
    }
    func workspace(
        readOnly: Bool,
        convergence: Bool,
        other: Bool
    ) -> [String: Any] {
        [
            "read_only": cell(readOnly),
            "agent_convergence": cell(convergence),
            "agent_other": cell(other),
        ]
    }
    let object: [String: Any] = [
        "repoRoot": root,
        "git": [
            "status": "unavailable",
            "version": NSNull(),
            "detail": "Git is unavailable.",
            "remediation": "Install Git.",
        ],
        "matrix": [
            "in_place": workspace(
                readOnly: inPlaceReadOnly,
                convergence: inPlaceAgentConvergence,
                other: inPlaceAgentOther),
            "isolated": workspace(
                readOnly: isolatedReadOnly,
                convergence: isolatedAgentConvergence,
                other: isolatedAgentOther),
        ],
    ]
    return try JSONDecoder().decode(
        ControlRunApplicabilityResponse.self,
        from: JSONSerialization.data(withJSONObject: object))
}

private enum TurnStartTestError: Error { case unexpectedRequest }

private func turnStartClient(port: Int) -> GatewayClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [TurnStartStubURLProtocol.self]
    return GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:\(port)")!,
        token: "test",
        session: URLSession(configuration: config))
}

@MainActor
private func turnStartModel(port: Int) -> AppModel {
    AppModel(
        client: turnStartClient(port: port),
        requestNotificationAuthorization: false)
}

private func turnStartResponse(
    _ request: URLRequest,
    status: Int = 200,
    body: String
) -> (HTTPURLResponse, Data) {
    (HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!, Data(body.utf8))
}

private func turnStartRequestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { return count == 0 ? data : nil }
        data.append(buffer, count: count)
    }
}

private func turnStartRequestObject(_ request: URLRequest) throws -> [String: Any]? {
    guard let body = turnStartRequestBody(request) else { return nil }
    return try JSONSerialization.jsonObject(with: body) as? [String: Any]
}

private func testThreadJSON(
    id: String,
    root: String,
    workspace: String,
    eligible: [String] = [],
    headRunID: String? = nil
) -> String {
    let object: [String: Any] = [
        "id": id,
        "title": id,
        "repoRoot": root,
        "mode": NSNull(),
        "workspaceMode": workspace,
        "authPreference": NSNull(),
        "primaryHarness": NSNull(),
        "eligibleHarnesses": eligible,
        "state": "active",
        "trashedAt": NSNull(),
        "purgeAfter": NSNull(),
        "runIds": headRunID.map { [$0] } ?? [],
        "headRunId": headRunID ?? NSNull(),
        "needsHuman": false,
        "createdAt": "2026-07-29T00:00:00Z",
        "updatedAt": "2026-07-29T00:00:00Z",
    ]
    let data = try! JSONSerialization.data(withJSONObject: object)
    return String(decoding: data, as: UTF8.self)
}

private func testThread(
    id: String,
    root: String,
    workspace: String,
    headRunID: String? = nil
) throws -> ThreadSummary {
    try JSONDecoder().decode(
        ThreadSummary.self,
        from: Data(testThreadJSON(
            id: id, root: root, workspace: workspace,
            headRunID: headRunID).utf8))
}

private func turnStartActiveRun(id: String) -> TaskRun {
    TaskRun(
        id: id, title: "Active", prompt: "", mode: .agent, phase: .running,
        project: "Project", harnesses: [], n: 1,
        createdAt: .now, updatedAt: .now,
        spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
        routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
        candidates: [], findings: [], diff: [])
}

private final class TurnStartRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    func record(_ request: URLRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return requests.count
    }

    func first(method: String, path: String) -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return requests.first { $0.httpMethod == method && $0.url?.path == path }
    }
}

private actor TurnStartAsyncGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var waiting = false

    func wait() async {
        waiting = true
        await withCheckedContinuation { continuation = $0 }
    }

    var isWaiting: Bool { waiting }

    func open() {
        continuation?.resume()
        continuation = nil
    }
}

private struct TurnStartUncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
}

private enum TurnStartRequestParsing {
    nonisolated static func queryValue(
        _ name: String,
        in request: URLRequest
    ) -> String? {
        guard let url = request.url,
              let items = URLComponents(
                url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        for item in items where item.name == name { return item.value }
        return nil
    }
}

private final class TurnStartStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler:
        ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let owner = TurnStartUncheckedSendable(value: self)
        DispatchQueue.global().async {
            let protocolInstance = owner.value
            do {
                guard let handler = Self.handler else {
                    throw TurnStartTestError.unexpectedRequest
                }
                let (response, data) = try handler(protocolInstance.request)
                protocolInstance.client?.urlProtocol(
                    protocolInstance,
                    didReceive: response,
                    cacheStoragePolicy: .notAllowed)
                protocolInstance.client?.urlProtocol(protocolInstance, didLoad: data)
                protocolInstance.client?.urlProtocolDidFinishLoading(protocolInstance)
            } catch {
                protocolInstance.client?.urlProtocol(protocolInstance, didFailWithError: error)
            }
        }
    }

    override func stopLoading() {}
}
