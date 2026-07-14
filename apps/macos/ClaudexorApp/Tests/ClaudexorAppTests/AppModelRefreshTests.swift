import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

@Suite(.serialized)
struct AppModelRefreshTests {
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
