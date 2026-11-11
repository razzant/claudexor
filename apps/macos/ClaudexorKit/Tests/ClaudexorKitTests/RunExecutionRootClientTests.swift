import Foundation
import Testing
@testable import ClaudexorKit

/// A run's execution root rides the run summary beside its project identity,
/// and a remote image fetch names the run whose recorded workspace it reads.
/// Own stub protocol and a serialized suite (the stub handler is a static).
@Suite(.serialized)
struct RunExecutionRootClientTests {
    @Test func summaryDecodesTheExecutionRootBesideTheProject() throws {
        let delegated = try JSONDecoder().decode(RunSummary.self, from: Data(#"""
            {"runId":"run-del","state":"succeeded","executionRoot":"/copy",
             "project":{"kind":"project","root":"/author","projectName":"author","context":"auto"}}
            """#.utf8))
        #expect(delegated.executionRoot == "/copy")
        #expect(delegated.project?.root == "/author")
        // An engine that predates the field reports no execution root at all.
        let older = try JSONDecoder().decode(
            RunSummary.self, from: Data(#"{"runId":"run-old","state":"succeeded"}"#.utf8))
        #expect(older.executionRoot == nil)
    }

    @Test func runExecutionOmitsAuxiliaryRootsUnlessACallerSetsThem() throws {
        let legacy = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(RunExecution())) as? [String: Any]
        #expect(legacy?.keys.sorted() == ["isolation"])
        let granted = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(
                RunExecution(isolation: "envelope", auxiliaryWritableRoots: ["/srv/cache"])))
            as? [String: Any]
        #expect(granted?["auxiliaryWritableRoots"] as? [String] == ["/srv/cache"])
    }

    @Test func projectFileFetchCarriesTheRunOnlyWhenGiven() async throws {
        let recorder = ProjectFileRequestRecorder()
        ProjectFileStubURLProtocol.handler = { request in
            recorder.append(request.url?.query ?? "")
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "image/png"])!
            return (response, Data([0x89, 0x50, 0x4e, 0x47]))
        }
        defer { ProjectFileStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProjectFileStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config))

        let bound = try await client.fetchProjectFile(
            projectID: "prj-1", relativePath: "shots/action.png", runID: "run-del")
        #expect(bound.contentType == "image/png")
        _ = try await client.fetchProjectFile(projectID: "prj-1", relativePath: "shots/action.png")
        #expect(recorder.entries == [
            "path=shots/action.png&runId=run-del",
            "path=shots/action.png",
        ])
    }
}

private final class ProjectFileRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    func append(_ entry: String) { lock.withLock { recorded.append(entry) } }
    var entries: [String] { lock.withLock { recorded } }
}

private final class ProjectFileStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
