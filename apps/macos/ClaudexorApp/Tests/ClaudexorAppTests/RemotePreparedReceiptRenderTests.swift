import AppKit
import Foundation
import SwiftUI
import Testing
import Vision
import ClaudexorKit
@testable import ClaudexorApp

/// #563 SSH: offscreen pixels of the real turn card for a local run and two
/// remote runs that share one daemon run id. Each card draws only its own
/// location's receipt; a remote failed turn keeps its reason card although the
/// LOCAL run with the same id has executor output. Gated QA: no window shown,
/// activation prohibited, in-memory model, stub client, no remote machine.
@MainActor @Suite(.serialized)
struct RemotePreparedReceiptRenderTests {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let name: String
            let event: JSONValue
            let row: TimelineEvent
        }
        let cases: [Case]
    }

    private static func fixture(_ name: String) throws -> Fixture.Case {
        let url = try #require(
            Bundle.module.url(forResource: "workspace-prepared-parity", withExtension: "json"))
        let cases = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).cases
        return try #require(cases.first { $0.name == name })
    }

    private static let runId = "run-same"

    private static func task(phase: RunPhase, project: String) -> TaskRun {
        var run = TaskRun(
            id: runId, title: project, prompt: "Create the output", mode: .agent, phase: phase,
            project: project, harnesses: [], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        run.answerText = nil
        return run
    }

    private static func model(phase: RunPhase) -> (AppModel, ExecutionLocationID, ExecutionLocationID) {
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        let first = ExecutionLocationID.remote(UUID())
        let second = ExecutionLocationID.remote(UUID())
        model.liveTasks = [task(phase: phase, project: "Local")]
        model.remoteTasks[first] = [task(phase: phase, project: "Remote one")]
        model.remoteTasks[second] = [task(phase: phase, project: "Remote two")]
        return (model, first, second)
    }

    private static func prepared(_ event: JSONValue, seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "workspace.prepared", event: event)
    }

    private static func message(_ text: String, seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text)]),
        ]))
    }

    /// Restore remote two through the real remote run-detail load.
    private static func restore(_ model: AppModel, _ location: ExecutionLocationID, row: TimelineEvent) async throws {
        let json = String(decoding: try JSONEncoder().encode(row), as: UTF8.self)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RemotePreparedRenderStub.self]
        model.remoteClients[location] = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:43125")!, token: "test",
            session: URLSession(configuration: config))
        model.selectedExecutionLocation = location
        RemotePreparedRenderStub.body = Data(
            #"{"summary":{"runId":"run-same","state":"running","mode":"agent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"","truncated":false},"timeline":[\#(json)],"lastSeq":9}"#.utf8)
        defer { RemotePreparedRenderStub.body = nil }
        #expect(await model.loadRunDetail(runId, locationID: location))
    }

    struct Shot { let png: Data; let measured: [String: Any] }

    private static func render(model: AppModel, location: ExecutionLocationID, width: CGFloat = 900)
        async throws -> Shot
    {
        let turn = ThreadTurnInfo(id: "turn-\(location.rawValue)", threadId: "qa-thread", runId: runId,
                                  parentRunId: nil, planRunId: nil, kind: "agent",
                                  prompt: "Create the output in the copied folder", run: nil,
                                  createdAt: "2026-11-01T00:00:00Z")
        let target = TurnStartTarget.existing(locationID: location, threadID: "qa-thread", repoRoot: nil,
                                              workspaceMode: "isolated", eligibleHarnesses: [])
        let host = NSHostingView(rootView: AnyView(
            ScrollView {
                TurnCard(turn: turn, target: target, routingOptions: TurnOptions(), executionRoot: nil).padding(12)
            }
            .environment(model).background(Color(nsColor: .windowBackgroundColor))))
        host.appearance = NSAppearance(named: .aqua)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 480),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        host.frame = NSRect(x: 0, y: 0, width: width, height: 480)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        #expect(!window.isVisible && !window.isKeyWindow)
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        return Shot(png: try #require(bitmap.representation(using: .png, properties: [:])), measured: [
            "requested_width_points": Double(width),
            "host_frame_points": [Double(host.frame.width), Double(host.frame.height)],
            "bitmap_pixels": [bitmap.pixelsWide, bitmap.pixelsHigh],
        ])
    }

    private static func ocr(_ png: Data) throws -> String {
        let image = try #require(NSBitmapImageRep(data: png)?.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_PREPARED_RENDER_OUT"] != nil))
    func eachLocationsTurnCardDrawsOnlyItsOwnReceipt() async throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["CX_PREPARED_RENDER_OUT"]),
                      isDirectory: true).appendingPathComponent("remote")
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let policy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(policy) }
        let missing = try Self.fixture("missing-only")
        let copied = try Self.fixture("copied-file")
        var shots: [[String: Any]] = []
        func record(_ name: String, _ shot: Shot, _ expectations: [String: Bool]) throws {
            let text = try Self.ocr(shot.png)
            try shot.png.write(to: out.appendingPathComponent(name + ".png"))
            try text.write(to: out.appendingPathComponent(name + ".ocr.txt"), atomically: true, encoding: .utf8)
            var row = shot.measured
            row["png"] = name + ".png"
            for (needle, expected) in expectations {
                let found = text.contains(needle)
                row["ocr: \(needle)"] = found
                #expect(found == expected, "\(name): \(needle)")
            }
            shots.append(row)
        }

        // Running: local has an executor step only; remote one a live warning
        // receipt (remote stream handler); remote two an info receipt restored by
        // the remote run-detail load. Same run id everywhere.
        let (model, first, second) = Self.model(phase: .running)
        model.apply(Self.message("Local executor step", seq: 1), to: Self.runId)
        model.applyRemoteHistoryCardEvent(Self.prepared(missing.event, seq: 1), runID: Self.runId, at: first)
        try await Self.restore(model, second, row: copied.row)
        try record("running-local", try await Self.render(model: model, location: .local),
                   ["Local executor step": true, "copy prepared": false])
        try record("running-remote-one-live", try await Self.render(model: model, location: first),
                   ["copy prepared": true, "new-output.txt": true, "Local executor step": false])
        try record("running-remote-two-restored", try await Self.render(model: model, location: second),
                   ["1 file copied": true, "new-output.txt": false, "Local executor step": false])
        try record("running-remote-one-req420", try await Self.render(model: model, location: first, width: 420),
                   ["copy prepared": true, "Local executor step": false])

        // Failed and interrupted: the remote card keeps its reason card beside its
        // receipt even though the LOCAL run with the same id has executor output.
        for (phaseName, phase) in [("failed", RunPhase.failed), ("interrupted", .interrupted)] {
            let (failedModel, remote, _) = Self.model(phase: phase)
            failedModel.remoteTasks[remote]?[0].engineError = "Remote vendor CLI is not signed in."
            failedModel.apply(Self.message("Local executor step", seq: 1), to: Self.runId)
            failedModel.applyRemoteHistoryCardEvent(Self.prepared(missing.event, seq: 1), runID: Self.runId, at: remote)
            try record("\(phaseName)-remote-with-receipt",
                       try await Self.render(model: failedModel, location: remote),
                       ["not signed in": true, "Open run": true, "Local executor step": false])
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "capture": "NSHostingView.cacheDisplay of TurnCard; borderless window never shown;"
                + " activationPolicy prohibited; AppModel memoryOnly; stub remote client only",
            "shots": shots,
        ], options: [.prettyPrinted, .sortedKeys])
        try data.write(to: out.appendingPathComponent("render-evidence.json"))
    }
}

private final class RemotePreparedRenderStub: URLProtocol {
    struct Refused: Error {}
    nonisolated(unsafe) static var body: Data?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.path == "/v2/runs/run-same", let body = Self.body else {
            client?.urlProtocol(self, didFailWithError: Refused())
            return
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
