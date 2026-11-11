import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

enum AccountResourcesFixtures {
    static let target = AccountTarget(harness: "claude", profileId: "claude-default")
    static let request = ControlAccountResetRequest(target: target, offerId: "granted", grantId: "grant-1")
    static let catalog = #"{"operations":[{"id":"get:quota","parameters":[{"name":"view","location":"query","enum":["resources"]}]},{"id":"post:quota","parameters":[{"name":"view","location":"query","enum":["resources"]}]},{"id":"get:credential-profiles","parameters":[{"name":"view","location":"query","enum":["resources"]}]},{"id":"post:account-resets","parameters":[]},{"id":"get:account-resets.id","parameters":[]}]}"#
    static let resources = #"""
    {"snapshots":[{"subject":{"harness":"claude","credential_route":"local_session","plan_label":"Max","subject_id":"claude-default"},"constraints":[{"id":"five_hour","label":"5-hour session","used_ratio":1,"resets_at":"2026-10-09T18:00:00+03:00"},{"id":"seven_day","label":"Weekly","used_ratio":0.42,"resets_at":"2026-10-13T00:00:00+03:00"}],"source":"provider","observed_at":"2026-10-09T14:32:00+03:00","freshness":"fresh"}],"absences":[],"refreshed_at":null,"resources":[
      {"target":{"harness":"claude","profile_id":"claude-default"},
       "balances":{"value":[{"id":"balance","label":"Prepaid balance","amount":null,"unit":"USD","currency":"USD","decimal_places":null,"has_balance":null,"unlimited":null}],"source":"provider","observed_at":"2026-10-09T14:28:00+03:00","freshness":"stale","last_attempt_at":"2026-10-09T14:32:00+03:00","last_error":"not_reported"},
       "spending":{"value":[{"id":"monthly","label":"Monthly usage","enabled":false,"used":"12.3400","limit":"100.00","unit":"USD","currency":"USD","decimal_places":null,"resets_at":"2026-11-01T00:00:00Z","reason":"Extra usage is off"}],"source":"provider","observed_at":"2026-10-09T14:32:00+03:00","freshness":"fresh","last_attempt_at":"2026-10-09T14:32:00+03:00","last_error":null},
       "resets":{"value":[{"id":"granted","kind":"granted_reset","label":"Granted reset","description":"Use one granted reset.","available_count":2,"eligible":true,"usable_now":true,"reason":null,"resets_at":null,"weekly_limit_applies":false,"grants":[{"id":"grant-1","label":"October grant","description":"Restores the 5-hour and weekly included limits.","available_count":1,"total_count":1,"usable_now":true,"starts_at":null,"expires_at":"2026-10-31T23:59:00Z","clears":["five_hour","seven_day"]}]},{"id":"refill","kind":"session_refill","label":"5-hour session refill","description":"Restore the current session limit.","available_count":null,"eligible":true,"usable_now":true,"reason":null,"resets_at":null,"weekly_limit_applies":true,"grants":null}],"source":"provider","observed_at":"2026-10-09T14:32:00+03:00","freshness":"fresh","last_attempt_at":"2026-10-09T14:32:00+03:00","last_error":null},
       "diagnostics":{"value":[{"code":"local_reserve","detail":"Provider quota and the configured local reserve are separate."}],"source":"engine","observed_at":"2026-10-09T14:32:00+03:00","freshness":"fresh","last_attempt_at":"2026-10-09T14:32:00+03:00","last_error":null}}
    ]}
    """#

    static func quota() throws -> ControlQuotaResponse {
        try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(resources.utf8))
    }
    static func receipt(
        outcome: String = "reset", readback: String = "failed", state: String = "completed",
        request: ControlAccountResetRequest = request
    ) throws -> Data {
        let requestJSON = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
        return Data("""
        {"id":"reset-fixture","request":\(requestJSON),"state":"\(state)","created_at":"2026-10-09T11:34:00Z","completed_at":\(state == "running" ? "null" : "\"2026-10-09T11:34:01Z\""),"outcome":"\(outcome)","detail":null,"readback":{"state":"\(readback)","attempted_at":"2026-10-09T11:34:01Z","detail":\(readback == "failed" ? "\"Provider unavailable\"" : "null")},"resources":\(resources)}
        """.utf8)
    }
    static func attempt(_ outcome: String = "unknown", readback: String = "failed") throws -> AccountResetAttempt {
        var value = AccountResetAttempt(id: "original-key", request: request, label: "Granted reset")
        value.receipt = try JSONDecoder().decode(ControlAccountResetResponse.self, from: receipt(outcome: outcome, readback: readback))
        return value
    }
    @MainActor
    static func row(_ index: Int = 0) throws -> AccountRowModel {
        AccountRowModel(id: "fixture-\(index)", displayName: index == 0 ? "Claude Work" : "Account \(index + 1)",
            harnessId: "claude", family: .claude, readiness: .ready, verified: true,
            profileId: index == 0 ? "claude-default" : "account-\(index + 1)",
            detail: "Verified", quotaGroups: QuotaPresentation.groups(from: try quota().snapshots),
            enabled: index % 4 != 3, nextUp: index == 1,
            identity: try JSONDecoder().decode(AccountIdentity.self, from: Data("{\"email\":\"account\(index + 1)@example.test\",\"plan\":\"Max\"}".utf8)))
    }
}

struct ResourceRecordedRequest: Sendable {
    let url: URL
    let method: String
    let key: String?
    let body: Data
    init(_ request: URLRequest) {
        url = request.url!
        method = request.httpMethod!
        key = request.value(forHTTPHeaderField: "Idempotency-Key")
        if let data = request.httpBody { body = data; return }
        guard let stream = request.httpBodyStream else { body = Data(); return }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        body = data
    }
}

actor ResourceAppRecorder {
    var requests: [ResourceRecordedRequest] = []
    func record(_ request: ResourceRecordedRequest) { requests.append(request) }
}

actor ResourceResponseGate {
    private var started = false
    private var waiting: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    func pause() async {
        started = true
        waiting?.resume()
        waiting = nil
        await withCheckedContinuation { release = $0 }
    }
    func waitForStart() async {
        if !started { await withCheckedContinuation { waiting = $0 } }
    }
    func finish() { release?.resume(); release = nil }
}

/// Narrow Foundation callback bridge, not a Sendable URLProtocol. The immutable
/// callback belongs to one request task, which invokes it once after its async
/// handler (including a response gate) completes. It retains the protocol until
/// that terminal delivery, exposes no protocol state to the handler, and keeps
/// this fixture's existing stopLoading behavior.
private struct ResourceProtocolCallback: @unchecked Sendable {
    let deliver: (Result<(Int, Data), Error>) -> Void
}

/// Each fixture owns a unique request host. Tests may replace its response for a
/// recovery step without affecting another client's concurrently running suite.
final class ResourceAppFixture {
    let host = "\(UUID().uuidString.lowercased()).engine.invalid"
    var handler: ResourceAppProtocol.Handler? {
        get { ResourceAppProtocol.lock.withLock { ResourceAppProtocol.handlers[host] } }
        set { ResourceAppProtocol.lock.withLock { ResourceAppProtocol.handlers[host] = newValue } }
    }
    deinit { handler = nil }
    func gateway() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ResourceAppProtocol.self]
        return GatewayClient(baseURL: URL(string: "https://\(host)")!, token: "fixture",
                             session: URLSession(configuration: configuration))
    }
}

final class ResourceAppProtocol: URLProtocol {
    typealias Handler = @Sendable (ResourceRecordedRequest) async throws -> (Int, Data)
    fileprivate static let lock = NSLock()
    nonisolated(unsafe) fileprivate static var handlers: [String: Handler] = [:]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let recorded = ResourceRecordedRequest(request)
        let handler = Self.lock.withLock { Self.handlers[recorded.url.host ?? ""] }
        let callback = ResourceProtocolCallback { [self] result in
            switch result {
            case .success(let (status, data)):
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: recorded.url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            case .failure(let error):
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
        Task { [handler, recorded, callback] in
            do {
                guard let handler else { throw URLError(.unsupportedURL) }
                callback.deliver(.success(try await handler(recorded)))
            }
            catch { callback.deliver(.failure(error)) }
        }
    }
    override func stopLoading() {}
}
