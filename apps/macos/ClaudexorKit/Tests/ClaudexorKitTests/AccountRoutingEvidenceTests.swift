import Foundation
import Testing
@testable import ClaudexorKit

/// One request path → (status, body) table for this suite's client.
private final class EvidenceProtocol: URLProtocol {
    nonisolated(unsafe) static var routes: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var requested: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.requested.append(path)
        let (status, body) = Self.routes[path] ?? (404, #"{"code":"not_found","message":"no route"}"#)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func client() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Self.self]
        return GatewayClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture",
                             session: URLSession(configuration: configuration))
    }
}

/// Records each request's path WITH its query, and answers an opt-in query with
/// `queryStatus`: 200 for a current engine, 400 for one whose strict route
/// predates the query.
private final class OptInEvidenceProtocol: URLProtocol {
    nonisolated(unsafe) static var queryStatus = 200
    nonisolated(unsafe) static var requested: [String] = []
    nonisolated(unsafe) static var body = ""
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.requested.append(url.path + (url.query.map { "?\($0)" } ?? ""))
        let (status, body) = url.query == nil
            ? (200, Self.body)
            : (Self.queryStatus, Self.queryStatus == 200
                ? Self.body : #"{"code":"invalid_request","message":"unsupported query parameter"}"#)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status,
            httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func client() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Self.self]
        return GatewayClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture",
                             session: URLSession(configuration: configuration))
    }
}

@Suite(.serialized)
struct AccountRoutingEvidenceTests {
    @Test func asksForModelScopedRefusalsAndReadsAnOlderEngineAgainWithoutTheQuery() async throws {
        defer { OptInEvidenceProtocol.requested = []; OptInEvidenceProtocol.queryStatus = 200 }
        OptInEvidenceProtocol.body = Self.evidence
        let client = OptInEvidenceProtocol.client()
        // A current engine answers the opt-in read directly.
        _ = try await client.accountRoutingEvidence()
        #expect(OptInEvidenceProtocol.requested
            == ["/v2/accounts/routing-evidence?includeCredentialUnusable=true"])
        // An engine whose strict route predates the query answers 400; the
        // client reads again without it, as the CLI does, and keeps the evidence.
        OptInEvidenceProtocol.requested = []
        OptInEvidenceProtocol.queryStatus = 400
        let older = try await client.accountRoutingEvidence()
        #expect(OptInEvidenceProtocol.requested == [
            "/v2/accounts/routing-evidence?includeCredentialUnusable=true",
            "/v2/accounts/routing-evidence",
        ])
        #expect(older.refusals.count == 1 && older.lastService.count == 1)
        // Any other failure stays the caller's to disclose, with no second read.
        OptInEvidenceProtocol.requested = []
        OptInEvidenceProtocol.queryStatus = 500
        await #expect(throws: GatewayError.self) { try await client.accountRoutingEvidence() }
        #expect(OptInEvidenceProtocol.requested.count == 1)
    }

    static let evidence = """
    {"refusals":[{"harness_id":"claude","profile_id":"work","requested_model":null,
      "observed_at":"2026-10-13T08:00:00.000Z","expires_at":"2026-10-13T09:00:00.000Z"}],
     "lastService":[{"harness_id":"claude","profile_id":"work","requested_model":"claude-opus-5-5",
      "observed_at":"2026-10-13T07:00:00.000Z"}]}
    """

    @Test func theCatalogNegotiatesTheAdditiveRead() throws {
        let current = #"{"operations":[{"id":"get:credential-profiles"},{"id":"get:accounts.routing-evidence"}]}"#
        let older = #"{"operations":[{"id":"get:credential-profiles"},{"id":"get:quota"}]}"#
        let decode = { (json: String) in
            try JSONDecoder().decode(AccountResourceOperationCatalog.self, from: Data(json.utf8)).capabilities
        }
        #expect(try decode(current).routingEvidence == true)
        #expect(try decode(older).routingEvidence == false)
    }

    @Test func decodesModelScopedEvidenceAndJudgesExpiry() throws {
        let value = try JSONDecoder().decode(AccountRoutingEvidence.self, from: Data(Self.evidence.utf8))
        let mark = try #require(value.refusals.first)
        #expect(mark.requestedModel == nil)
        #expect(value.lastService.first?.requestedModel == "claude-opus-5-5")
        let before = try #require(ISO8601DateFormatter().date(from: "2026-10-13T08:30:00Z"))
        let after = try #require(ISO8601DateFormatter().date(from: "2026-10-13T09:00:01Z"))
        #expect(mark.isLive(at: before))
        #expect(!mark.isLive(at: after))
        let unreadable = AccountRefusalMark(
            harnessId: "claude", profileId: "work", requestedModel: nil,
            observedAt: "now", expiresAt: "later")
        #expect(!unreadable.isLive(at: before))
    }

    @Test func decodesModelScopedCredentialRefusalsOnlyAsModelScoped() throws {
        let current = """
        {"refusals":[],"lastService":[],"credentialUnusable":[{"harness_id":"claude","profile_id":"work",
          "model":"claude-opus-5-5","code":"capability_refused","detail":"model_not_found",
          "observed_at":"2026-10-13T08:00:00.000Z","expires_at":"2026-10-13T09:00:00.000Z"},
          {"harness_id":"claude","profile_id":"work","model":"claude-fable-5-1","code":"capability_refused",
          "detail":null,"observed_at":"2026-10-13T08:10:00.000Z","expires_at":"2026-10-13T09:10:00.000Z"}]}
        """
        let value = try JSONDecoder().decode(AccountRoutingEvidence.self, from: Data(current.utf8))
        let mark = try #require(value.credentialUnusable.first)
        // A hard refusal always names its model: it can never read as "default model".
        let model: String = mark.model
        #expect(model == "claude-opus-5-5")
        #expect(mark.code == "capability_refused" && mark.detail == "model_not_found")
        #expect(value.credentialUnusable.last?.detail == nil)
        let before = try #require(ISO8601DateFormatter().date(from: "2026-10-13T08:30:00Z"))
        let after = try #require(ISO8601DateFormatter().date(from: "2026-10-13T09:00:01Z"))
        #expect(mark.isLive(at: before) && !mark.isLive(at: after))
        // An engine that predates the field, or a client that did not ask: nothing new.
        let older = try JSONDecoder().decode(AccountRoutingEvidence.self, from: Data(Self.evidence.utf8))
        #expect(older.credentialUnusable.isEmpty)
        // A credential-wide refusal (model null) is the row's status, never this list.
        let wide = current.replacingOccurrences(of: #""model":"claude-opus-5-5""#, with: #""model":null"#)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(AccountRoutingEvidence.self, from: Data(wide.utf8))
        }
    }

    @Test func readsTheAdditivePathAndReportsItsOwnFailure() async throws {
        defer { EvidenceProtocol.routes = [:]; EvidenceProtocol.requested = [] }
        EvidenceProtocol.routes = ["/v2/accounts/routing-evidence": (200, Self.evidence)]
        let client = EvidenceProtocol.client()
        let value = try await client.accountRoutingEvidence()
        #expect(value.lastService.count == 1)
        #expect(EvidenceProtocol.requested == ["/v2/accounts/routing-evidence"])
        EvidenceProtocol.routes = ["/v2/accounts/routing-evidence": (500, #"{"code":"internal"}"#)]
        await #expect(throws: GatewayError.self) { try await client.accountRoutingEvidence() }
    }
}
