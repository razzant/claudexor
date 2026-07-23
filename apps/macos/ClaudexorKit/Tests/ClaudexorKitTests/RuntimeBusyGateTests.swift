import Foundation
import Testing
@testable import ClaudexorKit

// D-2 audit 5: the install busy-gate must fail-closed count ALL active work —
// every queued/running run (INCLUDING runs older than the default 200-row page,
// via state-filtered queries) AND any active setup/login job. These drive
// GatewayClient.engineHasActiveWork through a stubbed URLSession.

/// A URLProtocol stub that answers /v2 GETs from an injected route table and
/// records the paths+queries it was asked for.
final class BusyStubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Route { let match: String; let status: Int; let json: String }
    nonisolated(unsafe) static var routes: [Route] = []
    nonisolated(unsafe) static var requested: [String] = []
    private static let lock = NSLock()

    static func reset(_ routes: [Route]) {
        lock.lock(); defer { lock.unlock() }
        self.routes = routes
        requested = []
    }
    static func seen(_ substring: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return requested.contains { $0.contains(substring) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let full = (request.url?.path ?? "") + "?" + (request.url?.query ?? "")
        Self.lock.lock()
        Self.requested.append(full)
        let route = Self.routes.first { full.contains($0.match) }
        Self.lock.unlock()
        let status = route?.status ?? 404
        let body = Data((route?.json ?? "{}").utf8)
        let resp = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite(.serialized) struct RuntimeBusyGateTests {
    private func client() -> GatewayClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [BusyStubURLProtocol.self]
        return GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:59999/")!, token: "t",
            session: URLSession(configuration: config))
    }

    private func runs(_ ids: [(String, String)]) -> String {
        let rows = ids.map { #"{"runId":"\#($0.0)","state":"\#($0.1)"}"# }.joined(separator: ",")
        return #"{"runs":[\#(rows)]}"#
    }
    /// A one-active-setup-job response. SetupJob decodes strictly (a `login` job
    /// requires capability evidence), so encode a REAL instance — a running login
    /// with a `.disclosed` capability — rather than hand-crafting JSON.
    private func activeSetupJobJSON() -> String {
        let digest = String(repeating: "a", count: 64)
        let capability = AuthCapabilityLifecycle(
            attemptId: "attempt-test", challengeDigest: digest, requestDigest: digest,
            disclosure: AuthSmokeDisclosure(harness: "claude", generatedAt: "2026-07-23T00:00:00Z"),
            state: .disclosed)
        let job = SetupJob(
            jobId: "j1", harness: .claude, action: .login, state: .running, phase: .launching,
            deadlineAt: nil, outcome: nil, message: "in flight", createdAt: "2026-07-23T00:00:00Z",
            startedAt: "2026-07-23T00:00:01Z", finishedAt: nil, authCapability: capability,
            terminationReconciliation: nil)
        let data = try! JSONEncoder().encode(SetupJobListResponse(jobs: [job]))
        return String(decoding: data, as: UTF8.self)
    }

    @Test func busyWhenAnActiveRunExistsOlderThanTheDefaultPage() async throws {
        // The UNFILTERED page (newest 200) shows only terminal runs; the OLD
        // running run is returned ONLY by the state-filtered query — exactly the
        // case a bare listRuns() would miss.
        let terminal = runs((1...200).map { ("r\($0)", "succeeded") })
        BusyStubURLProtocol.reset([
            .init(match: "state=running", status: 200, json: runs([("r-old", "running")])),
            .init(match: "state=queued", status: 200, json: runs([])),
            .init(match: "/v2/runs?", status: 200, json: terminal),  // unfiltered fallback
        ])
        let c = client()
        // The bare page has NO active run…
        let bare = try await c.listRuns()
        #expect(!bare.contains { $0.state == "running" || $0.state == "queued" })
        // …but the busy-gate still finds it via the state filter.
        #expect(try await c.engineHasActiveWork() == true)
        #expect(BusyStubURLProtocol.seen("state=running"))
    }

    @Test func busyWhenASetupJobIsActiveWithZeroActiveRuns() async throws {
        BusyStubURLProtocol.reset([
            .init(match: "state=running", status: 200, json: runs([])),
            .init(match: "state=queued", status: 200, json: runs([])),
            .init(match: "/v2/setup/jobs", status: 200, json: activeSetupJobJSON()),
        ])
        #expect(try await client().engineHasActiveWork() == true)
        #expect(BusyStubURLProtocol.seen("/v2/setup/jobs"))
        #expect(BusyStubURLProtocol.seen("active=true"))
    }

    @Test func idleWhenNoActiveRunsAndNoActiveSetupJobs() async throws {
        BusyStubURLProtocol.reset([
            .init(match: "state=running", status: 200, json: runs([])),
            .init(match: "state=queued", status: 200, json: runs([])),
            .init(match: "/v2/setup/jobs", status: 200, json: #"{"jobs":[]}"#),
        ])
        #expect(try await client().engineHasActiveWork() == false)
    }
}
