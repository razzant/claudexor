import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

@Suite(.serialized)
struct AppModelRefreshTests {
    @MainActor
    @Test func runlessGlobalQuotaEventRefreshesQuotaProjection() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        model.health = .connected
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/quota" else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), Data(#"{"snapshots":[],"refreshed_at":null}"#.utf8))
        }

        await model.handleGlobalEvent(JournalEvent(
            cursor: "epoch:2",
            partition: "global",
            type: "quota.snapshot.upserted",
            observedAt: "2026-07-15T00:00:00Z",
            payload: .object([:])
        ))

        #expect(model.quotaResponse?.snapshots.isEmpty == true)
        #expect(model.quotaStatus == nil)
    }

    @Test func taggedUnlimitedBudgetRendersUnlimitedInsteadOfUnknown() {
        var task = TaskRun(
            id: "run", title: "Run", prompt: "", mode: .agent, status: .running,
            project: "Project", specTitle: nil, harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )
        task.applyPaidBudget(.unlimited)

        #expect(task.budgetUnlimited)
        #expect(task.budgetLabel == "Unknown / Unlimited")
    }

    @MainActor
    @Test func budgetEventAcceptsAnExplicitFiniteZeroCap() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [TaskRun(
            id: "run-zero", title: "Run", prompt: "", mode: .agent, status: .running,
            project: "Project", specTitle: nil, harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 1, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: []
        )]

        model.apply(BusEnvelope(seq: 1, kind: "budget", event: .object([
            "type": .string("budget.lease.created"),
            "payload": .object(["max_usd": .number(0)])
        ])), to: "run-zero")

        #expect(model.liveTasks[0].capUsd == 0)
        #expect(model.liveTasks[0].capKnown)
    }

    @Test func quotaDatesParseFractionalIsoBeforePlainIso() {
        let fractional = "2026-07-15T10:00:01.123Z"
        let plain = "2026-07-15T10:00:01Z"
        #expect(formattedDate(fractional) != fractional)
        #expect(formattedDate(plain) != plain)
        #expect(formattedDate("not-a-date") == "not-a-date")
    }

    @MainActor
    @Test func freshHarnessRefreshReportsFailureAndKeepsLastKnownRows() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)

        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses", request.url?.query == "fresh=true" else {
                throw AppRefreshTestError.badRequest
            }
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"harnesses":[{"id":"claude","status":"ok","manifest":null}]}"#.utf8)
            )
        }
        #expect(await model.refreshHarnesses(fresh: true))
        #expect(model.liveHarnesses.map(\.family) == [.claude])

        AppRequestStubURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"error":"doctor unavailable"}"#.utf8)
            )
        }
        #expect(!(await model.refreshHarnesses(fresh: true)))
        #expect(model.liveHarnesses.map(\.family) == [.claude])
    }

    @MainActor
    @Test func imageSupportComesFromFiniteAttachmentInputManifest() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses" else { throw AppRefreshTestError.badRequest }
            return (appResponse(for: request), Data(#"{"harnesses":[{"id":"claude","status":"ok","manifest":{"capability_profile":{"attachment_inputs":[{"kind":"image","mime_types":["image/png"],"max_bytes":1048576,"max_count":2,"transport":"file_path"}]}}}]}"#.utf8))
        }

        #expect(await model.refreshHarnesses())
        #expect(model.harnessInfo(for: .claude)?.acceptsImages == true)
    }

    @MainActor
    @Test func lifecycleRefreshTargetsOneExactSourceAndPreservesCatalogState() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)

        AppRequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses", request.url?.query == nil else {
                throw AppRefreshTestError.badRequest
            }
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"harnesses":[{"id":"claude","status":"degraded","manifest":{"version":"1.2.3"},"enabledIntents":["review"],"authSources":[{"source":"native_session","availability":"unknown","verification":"not_run"}]}]}"#.utf8)
            )
        }
        #expect(await model.refreshHarnesses())
        let aggregateSummary = model.harnessInfo(for: .claude)?.auth

        AppRequestStubURLProtocol.handler = { request in
            guard request.httpMethod == "POST",
                  request.url?.path == "/v2/harnesses/claude/auth-readiness",
                  request.url?.query == nil,
                  let body = appTestRequestBody(request),
                  let object = try JSONSerialization.jsonObject(with: body) as? [String: String],
                  object == ["authRequest":"subscription", "source":"native_session"] else {
                throw AppRefreshTestError.badRequest
            }
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data(#"{"harnessId":"claude","authRequest":"subscription","requestedSource":"native_session","observedAt":"2026-07-14T00:00:00Z","readiness":{"source":"native_session","availability":"available","verification":"passed","detail":"Native session verified"}}"#.utf8)
            )
        }

        #expect(await model.refreshAuthReadinessAfterSetupLifecycle(for: .claude, job: nil))
        #expect(model.harnessInfo(for: .claude)?.nativeSessionReady == true)
        #expect(model.harnessInfo(for: .claude)?.health == .degraded)
        #expect(model.harnessInfo(for: .claude)?.version == "1.2.3")
        #expect(model.harnessInfo(for: .claude)?.intents == ["review"])
        #expect(model.harnessInfo(for: .claude)?.auth == aggregateSummary)
        #expect(model.authSource(for: .claude, source: .nativeSession)?.detail == "Native session verified")
    }

    @MainActor
    @Test func rawAPISetupAndAPIKeyReadinessNeverUseRetiredRawHarnessId() async throws {
        #expect(HarnessFamily.raw.setupHarnessId == "raw-api")
        #expect(HarnessFamily.raw.apiKeyAuthReadinessRequest == AuthReadinessRefreshRequest(
            authRequest: .apiKey,
            source: .apiKeyEnvironment
        ))
    }

    @MainActor
    @Test func successfulSecretWriteIsNotReportedAsFailedWhenExactProbeFails() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!,
            token: "test",
            session: URLSession(configuration: config)
        )
        let model = AppModel(client: client, requestNotificationAuthorization: false)

        AppRequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/secrets"):
                return (appResponse(for: request), Data("{}".utf8))
            case ("GET", "/v2/secrets"):
                return (appResponse(for: request), Data(#"{"backend":"file","secrets":[]}"#.utf8))
            case ("POST", "/v2/harnesses/raw-api/auth-readiness"):
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type":"application/problem+json"]
                )!
                return (response, Data(#"{"code":"probe_failed","message":"offline","retryable":true}"#.utf8))
            default:
                throw AppRefreshTestError.badRequest
            }
        }

        let outcome = await model.storeSecret(name: "raw_api", value: "redacted", for: .raw)
        #expect(outcome.stored)
        #expect(!outcome.readinessRefreshed)
        #expect(model.secretBackend == "file")
    }

    @MainActor
    @Test func typedControlProblemIsUsedForUserFacingGatewayFailure() {
        let model = AppModel(requestNotificationAuthorization: false)
        let error = GatewayError.http(status: 503, body: """
        {"code":"auth_readiness_probe_failed","message":"probe unavailable","retryable":true,
         "fieldErrors":{},"requiredActions":["retry_auth_readiness_refresh"],"evidenceRefs":[]}
        """)
        let message = model.userMessage(for: error)
        #expect(message.contains("auth_readiness_probe_failed"))
        #expect(message.contains("probe unavailable"))
        #expect(message.contains("retry_auth_readiness_refresh"))
    }

    @Test(arguments: [
        (SetupLifecycleConnection.recovering, false),
        (.reconnecting, false),
        (.streamLost, false),
        (.idle, true)
    ])
    func closePolicyGuardsUnknownLifecycleState(
        _ connection: SetupLifecycleConnection,
        _ actionInFlight: Bool
    ) {
        #expect(AuthSheetClosePolicy.requiresConfirmation(
            job: nil,
            connection: connection,
            actionInFlight: actionInFlight
        ))
    }

    @Test func closePolicyGuardsActiveAndUnconfirmedJobsButNotSafeTerminal() {
        let active = appSetupJob(id: "active", state: "running")
        let unsafe = appSetupJob(
            id: "unsafe", state: "cancelled",
            outcome: SetupJobOutcome(reason: .terminationUnconfirmed)
        )
        let safe = appSetupJob(
            id: "safe", state: "cancelled",
            outcome: SetupJobOutcome(reason: .cancelledByUser)
        )

        #expect(AuthSheetClosePolicy.requiresConfirmation(
            job: active, connection: .connected,
            actionInFlight: false
        ))
        #expect(AuthSheetClosePolicy.requiresConfirmation(
            job: unsafe, connection: .terminal,
            actionInFlight: false
        ))
        #expect(!AuthSheetClosePolicy.requiresConfirmation(
            job: safe, connection: .terminal,
            actionInFlight: false
        ))
    }

    @MainActor
    @Test func emptyFindingsNeverBecomeCleanWithoutEngineEvidence() {
        #expect(RunDetailMapping.reviewVerdict(
            decision: nil, candidates: [], findings: [], failure: nil, status: .succeeded
        ) == .notRun)
        let decision = JSONValue.object([
            "outcome": .string("ready"),
            "verification_basis": .string("cross_family_review")
        ])
        #expect(RunDetailMapping.reviewVerdict(
            decision: decision, candidates: [], findings: [], failure: nil, status: .succeeded
        ) == .clean)
    }

    @MainActor
    @Test func doctorAddsUnknownHarnessAndDeclaredEffortLevelsWithoutAppPatch() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            (appResponse(for: request), Data(#"{"harnesses":[{"id":"future-agent","status":"ok","manifest":{"capability_profile":{"effort_levels":["fast","deep"]}}}]}"#.utf8))
        }
        #expect(await model.refreshHarnesses())
        #expect(model.selectableHarnesses.map(\.rawValue) == ["future-agent"])
        #expect(model.harnessInfo(for: HarnessFamily(rawValue: "future-agent"))?.effortLevels == ["fast", "deep"])
    }

    @MainActor
    @Test func delayedThreadAResponseCannotReplaceSelectedThreadB() async throws {
        defer { AppRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppRequestStubURLProtocol.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false)
        AppRequestStubURLProtocol.handler = { request in
            let id = request.url!.lastPathComponent
            if id == "A" { Thread.sleep(forTimeInterval: 0.15) }
            let json = #"{"thread":{"id":"\#(id)","title":"\#(id)","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"},"sessions":[],"turns":[]}"#
            return (appResponse(for: request), Data(json.utf8))
        }
        let first = Task { await model.openThread("A") }
        try await Task.sleep(for: .milliseconds(20))
        await model.openThread("B")
        await first.value
        #expect(model.selectedThreadId == "B")
        #expect(model.selectedThreadDetail?.thread.id == "B")
    }
}

private func appSetupJob(
    id: String,
    state: String,
    outcome: SetupJobOutcome? = nil
) -> SetupJob {
    SetupJob(
        jobId: id,
        harness: .claude,
        action: .login,
        state: SetupJobState(rawValue: state)!,
        phase: state == "running" ? .awaitingUser : .completed,
        outcome: outcome,
        message: state,
        createdAt: "2026-07-14T00:00:00Z"
    )
}

private enum AppRefreshTestError: Error { case badRequest }

private func appResponse(for request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type":"application/json"]
    )!
}

private func appTestRequestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { return nil }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

private final class AppRequestStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw AppRefreshTestError.badRequest }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
