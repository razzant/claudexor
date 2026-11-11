import Foundation
import Testing
@testable import ClaudexorKit

private final class StreamSessionMarkerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { false }
}

/// Records every request it serves; event-stream requests get one run frame
/// and the terminal `end`, everything else an empty runs page.
private final class StreamSessionStubProtocol: URLProtocol {
    nonisolated(unsafe) static var seen: [URLRequest] = []
    static let lock = NSLock()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.withLock { Self.seen.append(request) }
        let stream = request.value(forHTTPHeaderField: "Accept") == "text/event-stream"
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": stream ? "text/event-stream" : "application/json"])!
        let body = stream ? "id: 8\nevent: test.frame\ndata: {\"n\":8}\n\nevent: end\ndata: {}\n\n" : #"{"runs":[]}"#
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Long-lived SSE use a connection pool of their own, created by the client
/// from the request session's exact configuration: the same protocol stubs,
/// timeouts and platform per-host limit (no new number), while the caller's
/// session stays the one every ordinary request uses.
@Suite(.serialized) struct GatewayStreamSessionTests {
    @Test func streamPoolIsSeparateButConfiguredLikeTheRequestSession() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StreamSessionMarkerProtocol.self]
        config.timeoutIntervalForRequest = 42
        let session = URLSession(configuration: config)
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:9")!, token: "t", session: session)
        #expect(client.session === session)
        #expect(client.streamSession !== session)
        let stream = client.streamSession.configuration
        #expect(stream.httpMaximumConnectionsPerHost == session.configuration.httpMaximumConnectionsPerHost)
        #expect(stream.timeoutIntervalForRequest == 42)
        #expect(stream.timeoutIntervalForResource == session.configuration.timeoutIntervalForResource)
        #expect(stream.protocolClasses?.contains { $0 == StreamSessionMarkerProtocol.self } == true)
    }

    /// Every construction path goes through the one initializer: discovery's
    /// `makeClient` (local engine) and the remote forward's default-session form.
    @Test func everyConstructorGetsItsOwnStreamPool() throws {
        let remoteForm = GatewayClient(baseURL: URL(string: "http://127.0.0.1:9")!, token: "t")
        #expect(remoteForm.session === URLSession.shared)
        #expect(remoteForm.streamSession !== URLSession.shared)
        #expect(remoteForm.streamSession.configuration.httpMaximumConnectionsPerHost
            == URLSession.shared.configuration.httpMaximumConnectionsPerHost)

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("cx-stream-pool-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let token = directory.appendingPathComponent("token")
        let discovery = directory.appendingPathComponent("control-api.json")
        FileManager.default.createFile(atPath: token.path, contents: Data("tok".utf8), attributes: [.posixPermissions: 0o600])
        FileManager.default.createFile(atPath: discovery.path,
            contents: Data(#"{"host":"127.0.0.1","port":9,"tokenPath":"\#(token.path)"}"#.utf8),
            attributes: [.posixPermissions: 0o600])
        let loaded = try ControlApiDiscovery.load(from: discovery)
        let local = try loaded.makeClient()
        #expect(local.session === URLSession.shared && local.streamSession !== URLSession.shared)
        let injected = URLSession(configuration: .ephemeral)
        let injectedClient = try loaded.makeClient(session: injected)
        #expect(injectedClient.session === injected && injectedClient.streamSession !== injected)
        #expect(injectedClient.streamSession !== local.streamSession)
    }

    /// An injected URLProtocol still serves both pools, and a stream request
    /// carries the same bearer and protocol headers as an ordinary request.
    @Test func injectedProtocolServesStreamsAndRequestsWithTheSameAuth() async throws {
        StreamSessionStubProtocol.lock.withLock { StreamSessionStubProtocol.seen = [] }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StreamSessionStubProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:9")!, token: "secret",
                                   session: URLSession(configuration: config))
        var envelopes: [BusEnvelope] = []
        for try await envelope in client.events(runId: "run-1", lastEventId: 7) { envelopes.append(envelope) }
        #expect(envelopes.map(\.seq) == [8] && envelopes.map(\.kind) == ["test.frame"])
        #expect(try await client.listRuns().isEmpty)
        let seen = StreamSessionStubProtocol.lock.withLock { StreamSessionStubProtocol.seen }
        let stream = try #require(seen.first { $0.url?.path == "/v2/runs/run-1/events" })
        let list = try #require(seen.first { $0.url?.path == "/v2/runs" })
        for request in [stream, list] {
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
            #expect(request.value(forHTTPHeaderField: "X-Claudexor-Protocol-Major") == "3")
        }
        #expect(stream.value(forHTTPHeaderField: "Last-Event-ID") == "7")
        #expect(list.value(forHTTPHeaderField: "Accept") != "text/event-stream")
    }
}
