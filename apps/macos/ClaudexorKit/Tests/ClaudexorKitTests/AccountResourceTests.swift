import Foundation
import Testing
@testable import ClaudexorKit

@Suite(.serialized)
struct AccountResourceTests {
    static let facet = #"{"value":null,"source":null,"observed_at":null,"freshness":"unknown","last_attempt_at":null,"last_error":null}"#
    static let snapshot = """
    {"target":{"harness":"future-provider","profile_id":"future-default"},
     "balances":{"value":[
       {"id":"zero","label":"Credits","amount":"0","unit":"credits","currency":null,"decimal_places":null,"has_balance":false,"unlimited":false},
       {"id":"missing","label":"Balance","amount":null,"unit":"USD","currency":"USD","decimal_places":null,"has_balance":null,"unlimited":null}],
       "source":"provider","observed_at":"2026-10-09T11:00:00Z","freshness":"stale","last_attempt_at":"2026-10-09T12:00:00Z","last_error":"unavailable"},
     "spending":{"value":[{"id":"spend","label":"Monthly spend","enabled":false,"used":"12.3400","limit":"100.00","unit":"USD","currency":"USD","decimal_places":null,"resets_at":null,"reason":null}],
       "source":"provider","observed_at":"2026-10-09T12:00:00Z","freshness":"fresh","last_attempt_at":"2026-10-09T12:00:00Z","last_error":null},
     "resets":{"value":[{"id":"offer-verbatim","kind":"granted_reset","label":"Reset","description":null,"available_count":7,"eligible":null,"usable_now":null,"reason":null,"resets_at":null,"weekly_limit_applies":false,"grants":null}],
       "source":"provider","observed_at":"2026-10-09T12:00:00Z","freshness":"fresh","last_attempt_at":"2026-10-09T12:00:00Z","last_error":null},
     "diagnostics":\(facet)}
    """
    static let rich = #"{"snapshots":[],"absences":[],"refreshed_at":null,"resources":["# + snapshot + "]}"
    static let catalog = #"{"operations":[{"id":"get:quota","parameters":[{"name":"view","location":"query","enum":["resources"]}]},{"id":"post:quota","parameters":[{"name":"view","location":"query","enum":["resources"]}]},{"id":"get:credential-profiles","parameters":[{"name":"view","location":"query","enum":["resources"]}]},{"id":"post:account-resets","parameters":[]},{"id":"get:account-resets.id","parameters":[]}]}"#
    static let request = ControlAccountResetRequest(target: AccountTarget(harness: "future-provider", profileId: "future-default"), offerId: "offer-verbatim", grantId: "grant-specific")
    static func receipt(_ outcome: String) throws -> Data {
        let body = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
        return Data("""
        {"id":"reset-123","request":\(body),"state":"completed","created_at":"2026-10-09T12:00:00Z","completed_at":"2026-10-09T12:00:01Z","outcome":"\(outcome)","detail":null,"readback":{"state":"failed","attempted_at":"2026-10-09T12:00:01Z","detail":"provider unavailable"},"resources":\(rich)}
        """.utf8)
    }

    @Test func codecKeepsZeroUnknownDecimalsCountOnlyAndIndependentFreshness() throws {
        let response = try JSONDecoder().decode(ControlAccountResourcesResponse.self, from: Data(Self.rich.utf8))
        let snapshot = try #require(response.resources.first)
        #expect(snapshot.balances.value?[0].amount == "0")
        #expect(snapshot.balances.value?[1].amount == nil)
        #expect(snapshot.balances.freshness == .stale)
        #expect(snapshot.spending.freshness == .fresh)
        #expect(snapshot.spending.value?.first?.used == "12.3400")
        #expect(snapshot.spending.value?.first?.unit == "USD")
        #expect(snapshot.resets.value?.first?.availableCount == 7)
        #expect(snapshot.resets.value?.first?.grants == nil)
        #expect(try JSONDecoder().decode(ControlAccountResourcesResponse.self, from: JSONEncoder().encode(response)) == response)
    }

    @Test func richRequiresResourcesAndLegacyKeepsAbsentFieldAbsent() throws {
        let data = Data(#"{"snapshots":[],"refreshed_at":null}"#.utf8)
        let legacy = try JSONDecoder().decode(ControlQuotaResponse.self, from: data)
        #expect(legacy.resources == nil)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(ControlAccountResourcesResponse.self, from: data) }
        let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as? [String: Any])
        #expect(encoded["resources"] == nil)
    }

    @Test func receiptKeepsResetOutcomeSeparateFromReadback() throws {
        for outcome in ["pending", "reset", "already_redeemed", "already_used", "nothing_to_reset", "no_credit", "not_eligible", "cooldown", "unavailable", "unknown"] {
            let value = try JSONDecoder().decode(ControlAccountResetResponse.self, from: Self.receipt(outcome))
            #expect(value.outcome.confirmsReset == (outcome == "reset" || outcome == "already_redeemed"))
            #expect(value.readback.state == .failed)
            #expect(value.resources?.resources.first?.resets.value?.first?.availableCount == 7)
        }
    }

    @Test func targetedProjectionPreservesOtherAccountFacts() throws {
        let response = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(Self.rich.utf8))
        let otherData = Self.rich.replacingOccurrences(of: "future-default", with: "other-disabled")
        let other = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(otherData.utf8))
        let merged = response.replacingAccount(Self.request.target, in: other,
            reboundSinceRequest: false)
        #expect(merged.resources?.count == 2)
        #expect(merged.resources?.first == other.resources?.first)
        #expect(merged.resources?.last == response.resources?.first)
    }

    @Test func targetMergeOrdersEachFacetIncludingFailedAttemptsIndependently() throws {
        let priorJSON = Self.rich.replacingOccurrences(of: "12:00:00Z", with: "12:10:00Z")
        let prior = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(priorJSON.utf8))
        var document = try #require(JSONSerialization.jsonObject(with: Data(Self.rich.utf8)) as? [String: Any])
        var resources = try #require(document["resources"] as? [[String: Any]])
        var resets = try #require(resources[0]["resets"] as? [String: Any])
        resets["observed_at"] = "2026-10-09T15:20:00+03:00"
        resets["last_attempt_at"] = "2026-10-09T15:20:00+03:00"
        resources[0]["resets"] = resets
        document["resources"] = resources
        let incoming = try JSONDecoder().decode(ControlQuotaResponse.self, from: JSONSerialization.data(withJSONObject: document))
        let merged = incoming.replacingAccount(Self.request.target, in: prior,
            reboundSinceRequest: false, preferPreviousOnTie: true)
        #expect(merged.resources?.first?.balances == prior.resources?.first?.balances)
        #expect(merged.resources?.first?.balances.lastAttemptAt == "2026-10-09T12:10:00Z")
        #expect(merged.resources?.first?.spending == prior.resources?.first?.spending)
        #expect(merged.resources?.first?.resets == incoming.resources?.first?.resets)
    }

    @Test func generationProtectsUndatedFactsWhileNewerAbsenceReplacesOldQuota() throws {
        let subject = #"{"harness":"future-provider","credential_route":"local_session","subject_id":"future-default"}"#
        let older = #"{"snapshots":[{"subject":\#(subject),"constraints":[],"source":"provider","observed_at":"2026-10-09T12:00:00Z","freshness":"fresh"}],"resources":[\#(Self.snapshot)]}"#
        let newer = #"{"snapshots":[],"absences":[{"subject":\#(subject),"reason":"refresh_failed","detail":"Unavailable","observed_at":"2026-10-09T12:01:00Z"}],"resources":[\#(Self.snapshot)]}"#
            .replacingOccurrences(of: "\"value\":null,\"source\":null", with: "\"value\":[{\"code\":\"newer\",\"detail\":\"Recent diagnostic\"}],\"source\":null")
        let incoming = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(older.utf8))
        let prior = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(newer.utf8))
        let merged = incoming.replacingAccount(Self.request.target, in: prior,
            reboundSinceRequest: false, preferPreviousOnTie: true)
        #expect(merged.snapshots.isEmpty && merged.absences == prior.absences)
        #expect(merged.resources?.first?.diagnostics.value?.first?.code == "newer")
    }

    @Test func catalogAndGatewayUseDeclaredOperationsExactTargetMethodAndKey() async throws {
        defer { ResourceKitProtocol.handler = nil }
        let recorder = ResourceKitRecorder()
        ResourceKitProtocol.handler = { request in
            recorder.record(request)
            let path = request.url!.path
            if path == "/v2/operations" { return (200, Data(Self.catalog.utf8)) }
            if path == "/v2/credential-profiles" {
                return (200, Data(#"{"profiles":[],"quota":\#(Self.rich)}"#.utf8))
            }
            if path == "/v2/quota" { return (200, Data(Self.rich.utf8)) }
            return (200, try Self.receipt("already_redeemed"))
        }
        let client = Self.client()
        let capabilities = try await client.accountResourceCapabilities()
        #expect(capabilities.read && capabilities.refresh && capabilities.accountsSnapshot && capabilities.reset && capabilities.resetStatus)
        _ = try await client.accountResourceCapabilities()
        _ = try await client.quota(refresh: true, resources: true, target: Self.request.target)
        _ = try await client.credentialProfilesSnapshot(resources: true)
        _ = try await client.resetAccount(Self.request, idempotencyKey: "original-key")
        _ = try await client.resetAccount(Self.request, idempotencyKey: "original-key")
        _ = try await client.accountReset(id: "id/with?delimiters")
        let requests = recorder.requests
        #expect(requests.filter { $0.url?.path == "/v2/operations" }.count == 1)
        let refresh = try #require(requests.first { $0.url?.path == "/v2/quota" })
        #expect(refresh.httpMethod == "POST")
        #expect(refresh.url?.query == "view=resources")
        let body = try #require(JSONSerialization.jsonObject(with: ResourceKitProtocol.body(refresh)) as? [String: Any])
        #expect((body["target"] as? [String: String]) == ["harness": "future-provider", "profile_id": "future-default"])
        let atomic = try #require(requests.first { $0.url?.path == "/v2/credential-profiles" })
        #expect(atomic.url?.query == "snapshot=true&view=resources")
        let posts = requests.filter { $0.url?.path == "/v2/account-resets" }
        #expect(posts.count == 2)
        for request in posts {
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "original-key")
            #expect(try JSONDecoder().decode(ControlAccountResetRequest.self, from: ResourceKitProtocol.body(request)) == Self.request)
        }
        #expect(requests.last?.httpMethod == "GET")
        #expect(requests.last?.url?.absoluteString.hasSuffix("/id%2Fwith%3Fdelimiters") == true)
    }

    @Test func oldCatalogDoesNotOptInFromOperationNameAlone() async throws {
        defer { ResourceKitProtocol.handler = nil }
        ResourceKitProtocol.handler = { _ in (200, Data(#"{"operations":[{"id":"get:quota","parameters":[]}]}"#.utf8)) }
        let caps = try await Self.client().accountResourceCapabilities()
        #expect(!caps.read && !caps.refresh && !caps.reset && !caps.accountsSnapshot)
    }

    static func client() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResourceKitProtocol.self]
        return GatewayClient(baseURL: URL(string: "https://engine.invalid")!, token: "fixture", session: URLSession(configuration: configuration))
    }
}

private final class ResourceKitRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []

    func record(_ request: URLRequest) { lock.withLock { recorded.append(request) } }
    var requests: [URLRequest] { lock.withLock { recorded } }
}

private final class ResourceKitProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        // Match the other Kit URLProtocol fixtures: URLSession remains async,
        // while its protocol instance never crosses a Swift task boundary.
        do {
            let (status, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            result.append(buffer, count: count)
        }
        return result
    }
}
