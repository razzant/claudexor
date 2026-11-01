import AppKit
import Foundation
import SwiftUI
import Testing
import Vision
import ClaudexorKit
@testable import ClaudexorApp

/// #563: the engine's `workspace.prepared` receipt reaches the transcript the
/// turn card actually draws, as an engine notice (never the model's words or
/// a tool), live, replayed and restored from a run-detail snapshot. Expected
/// title, text and severity come from the engine (`pnpm fixtures:swift`).
@MainActor @Suite(.serialized)
struct WorkspacePreparedTranscriptTests {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let name: String
            let event: JSONValue
            let row: TimelineEvent
        }
        let cases: [Case]
    }

    private static func fixture() throws -> [Fixture.Case] {
        let url = try #require(
            Bundle.module.url(forResource: "workspace-prepared-parity", withExtension: "json"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).cases
    }

    private static func task(_ id: String, phase: RunPhase = .running) -> TaskRun {
        var run = TaskRun(
            id: id, title: "Run", prompt: "Create the output", mode: .agent, phase: phase,
            project: "Project", harnesses: [], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        run.answerText = phase.isActive ? nil : "Done."
        return run
    }

    private static func model(_ runId: String, phase: RunPhase = .running) -> AppModel {
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        model.liveTasks = [task(runId, phase: phase)]
        return model
    }

    private static func prepared(_ event: JSONValue, seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "workspace.prepared", event: event)
    }

    /// The positive control: an ordinary executor message on the same path.
    private static func message(_ text: String, seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text)]),
        ]))
    }

    private static func notices(_ blocks: [TranscriptBlock]) -> [TranscriptNotice] {
        blocks.compactMap { if case .notice(_, let notice) = $0 { notice } else { nil } }
    }

    private static func expectMatches(_ notice: TranscriptNotice?, _ row: TimelineEvent, _ name: String) {
        #expect(notice?.title == row.title, "\(name)")
        #expect(notice?.text == row.detail, "\(name)")
        #expect(notice?.warning == (row.severity == "warning"), "\(name)")
    }

    @Test func liveAndReplayedEventsReachTheDrawnTranscriptOnce() throws {
        for item in try Self.fixture() {
            let runId = "run-\(item.name)"
            let model = Self.model(runId)
            model.apply(Self.prepared(item.event, seq: 1), to: runId)
            model.apply(Self.message("Live step", seq: 2), to: runId)
            model.apply(Self.prepared(item.event, seq: 1), to: runId) // replayed frame
            let blocks = model.transcriptBlocks(runId)
            #expect(blocks.count == 2, "\(item.name)")
            guard case .notice(let id, let notice)? = blocks.first else {
                Issue.record("\(item.name): first block is not the engine notice")
                continue
            }
            #expect(id == TranscriptNotice.preparedId(attemptId: "a01"))
            Self.expectMatches(notice, item.row, item.name)
            guard case .message(_, let text)? = blocks.last else {
                Issue.record("\(item.name): the executor message is missing")
                continue
            }
            #expect(text == "Live step")
            // The view's own rows: the notice is not narration and not a tool.
            let rows = TranscriptPresentation.rows(blocks)
            #expect(rows.count == 2)
            if case .notice? = rows.first {} else { Issue.record("\(item.name): no notice row") }
        }
    }

    @Test func everyPathAndTheWarningAreKeptForManyAndUnusualPaths() throws {
        let item = try #require(try Self.fixture().first { $0.name == "many-and-unusual-missing" })
        let model = Self.model("run-many")
        model.apply(Self.prepared(item.event, seq: 1), to: "run-many")
        let notice = try #require(Self.notices(model.transcriptBlocks("run-many")).first)
        #expect(notice.warning)
        for index in 1...25 {
            let path = "\"out/new-\(String(format: "%02d", index)).md\""
            #expect(notice.text.components(separatedBy: path).count - 1 == 2, "\(path)")
        }
        #expect(notice.text.contains(#""line\nbreak.txt""#))
        #expect(notice.text.contains(#""bell\u0007.txt""#))
        #expect(notice.text.contains("\"é/ü 日本.txt\""))
        #expect(!notice.text.contains("\n"))
        // Below the chat row bound: drawn whole, no "more characters" pointer.
        #expect(TranscriptPresentation.chatNotice(notice.text) == notice.text)
        #expect(TurnPresentation.noticeSummary(blocks: model.transcriptBlocks("run-many")) == "Input warning")
        let copied = try #require(try Self.fixture().first { $0.name == "copied-file" })
        let quiet = Self.model("run-quiet")
        quiet.apply(Self.prepared(copied.event, seq: 1), to: "run-quiet")
        #expect(TurnPresentation.noticeSummary(blocks: quiet.transcriptBlocks("run-quiet")) == nil)
    }

    @Test func aMalformedPayloadAddsNothing() {
        let model = Self.model("run-bad")
        model.apply(Self.prepared(.object([
            "type": .string("workspace.prepared"),
            "payload": .object(["attempt_id": .string("a01"), "source_root": .string("/work")]),
        ]), seq: 1), to: "run-bad")
        #expect(model.transcriptBlocks("run-bad").isEmpty)
    }

    @Test func aRestoredRunShowsTheSnapshotReceiptOnceBesideTheLiveFold() async throws {
        defer { PreparedDetailStub.handler = nil }
        let item = try #require(try Self.fixture().first { $0.name == "partial" })
        let row = String(decoding: try JSONEncoder().encode(item.row), as: UTF8.self)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PreparedDetailStub.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false, loadPersistedState: false)
        model.liveTasks = [Self.task("run-restored", phase: .succeeded)]
        PreparedDetailStub.handler = { request in
            guard request.url?.path == "/v2/runs/run-restored" else { throw PreparedDetailStub.Refused() }
            return Data(#"{"summary":{"runId":"run-restored","state":"succeeded","mode":"agent"},"timeline":[\#(row)],"lastSeq":9}"#.utf8)
        }

        await model.loadRunDetail("run-restored")

        let restored = model.transcriptBlocks("run-restored")
        #expect(restored.count == 1)
        Self.expectMatches(Self.notices(restored).first, item.row, "restored")
        #expect(TurnPresentation.noticeSummary(blocks: restored) == "Input warning")
        // The same receipt arriving live as well is not shown twice.
        model.apply(Self.prepared(item.event, seq: 3), to: "run-restored")
        #expect(Self.notices(model.transcriptBlocks("run-restored")).count == 1)
    }

    @Test func aSnapshotReceiptGoesBeforeLaterLiveBlocks() throws {
        let item = try #require(try Self.fixture().first { $0.name == "missing-only" })
        let model = Self.model("run-reattached")
        model.apply(Self.message("after the snapshot fence", seq: 12), to: "run-reattached")
        model.foldTimelineNotices("run-reattached", [item.row])
        let blocks = model.transcriptBlocks("run-reattached")
        #expect(blocks.count == 2)
        if case .notice? = blocks.first {} else { Issue.record("the restored receipt is not first") }
    }

    @Test func anEngineNoticeIsNotExecutorActivity() throws {
        let item = try #require(try Self.fixture().first { $0.name == "missing-only" })
        let model = Self.model("run-activity")
        #expect(!TurnPresentation.hasExecutorActivity(blocks: model.transcriptBlocks("run-activity")))
        model.apply(Self.prepared(item.event, seq: 1), to: "run-activity")
        #expect(!TurnPresentation.hasExecutorActivity(blocks: model.transcriptBlocks("run-activity")))
        model.apply(Self.message("Live step", seq: 2), to: "run-activity")
        #expect(TurnPresentation.hasExecutorActivity(blocks: model.transcriptBlocks("run-activity")))
    }

    // MARK: Offscreen pixels of the real turn card (gated QA; no window shown)

    /// The PNG plus what was actually laid out and rasterized (requested width
    /// is not evidence: the card may impose its own minimum).
    struct Shot { let png: Data; let measured: [String: Any] }

    private static func render(model: AppModel, runId: String, appearance: NSAppearance.Name,
                               width: CGFloat, expanded: Bool? = nil) async throws -> Shot {
        // The store a click on the receipt row writes; nil follows the run state.
        let presentation = ConversationPresentation()
        presentation.transcripts["turn-\(runId)"] = expanded
        let turn = ThreadTurnInfo(id: "turn-\(runId)", threadId: "qa-thread", runId: runId, parentRunId: nil,
                                  planRunId: nil, kind: "agent", prompt: "Create the output in the copied folder",
                                  run: nil, createdAt: "2026-11-01T00:00:00Z")
        let target = TurnStartTarget.existing(locationID: .local, threadID: "qa-thread", repoRoot: nil,
                                              workspaceMode: "isolated", eligibleHarnesses: [])
        let host = NSHostingView(rootView: AnyView(
            ScrollView {
                TurnCard(turn: turn, target: target, routingOptions: TurnOptions(), executionRoot: nil).padding(12)
            }
            .environment(model).environment(presentation)
            .background(Color(nsColor: .windowBackgroundColor))))
        host.appearance = NSAppearance(named: appearance)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 640),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        host.frame = NSRect(x: 0, y: 0, width: width, height: 640)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        #expect(!window.isVisible && !window.isKeyWindow)
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        return Shot(png: png, measured: [
            "requested_width_points": Double(width),
            "host_frame_points": [Double(host.frame.width), Double(host.frame.height)],
            "host_fitting_points": [Double(host.fittingSize.width), Double(host.fittingSize.height)],
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
    func theTurnCardDrawsTheReceipt() async throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["CX_PREPARED_RENDER_OUT"]),
                      isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let policy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(policy) }
        var shots: [[String: Any]] = []
        func record(_ name: String, _ shot: Shot, _ extra: [String: Any]) throws -> String {
            let text = try Self.ocr(shot.png)
            try shot.png.write(to: out.appendingPathComponent(name + ".png"))
            try text.write(to: out.appendingPathComponent(name + ".ocr.txt"), atomically: true, encoding: .utf8)
            var row = extra.merging(shot.measured) { a, _ in a }
            row["png"] = name + ".png"
            row["ocr_title"] = text.contains("Isolated workspace copy prepared")
            row["ocr_copy_prepared"] = text.contains("copy prepared")
            row["ocr_live_step"] = text.contains("Live step")
            shots.append(row)
            return text
        }
        let cases = try Self.fixture()
        for name in ["missing-only", "partial", "copied-file", "many-and-unusual-missing"] {
            let item = try #require(cases.first { $0.name == name })
            for (appearanceName, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
                for width in [CGFloat(900), 420] {
                    let runId = "qa-\(name)-\(appearanceName)-\(Int(width))"
                    let model = Self.model(runId)
                    model.apply(Self.prepared(item.event, seq: 1), to: runId)
                    model.apply(Self.message("Live step 1: the executor is working in the copy.", seq: 2), to: runId)
                    let text = try record("turncard-live-\(name)-\(appearanceName)-req\(Int(width))",
                        try await Self.render(model: model, runId: runId, appearance: appearance, width: width),
                        ["case": name, "state": "running", "appearance": appearanceName,
                         "warning": item.row.severity ?? "-"])
                    // OCR of the caution-tinted title is noisy in dark mode; the
                    // title or the body sentence must be read back from pixels.
                    #expect(text.contains("copy prepared"), "\(name) \(appearanceName) \(width)")
                    #expect(text.contains("Live step"), "\(name) positive control")
                }
            }
        }
        // A restored, terminal run: collapsed receipt row says so; expanding shows the receipt.
        let item = try #require(cases.first { $0.name == "missing-only" })
        let model = Self.model("qa-restored", phase: .succeeded)
        model.foldTimelineNotices("qa-restored", [item.row])
        let collapsed = try record("turncard-restored-missing-only-collapsed-light-req900",
            try await Self.render(model: model, runId: "qa-restored", appearance: .aqua, width: 900),
            ["case": "missing-only", "state": "succeeded restored collapsed"])
        #expect(collapsed.contains("Input warning"))
        let opened = try record("turncard-restored-missing-only-expanded-light-req900",
            try await Self.render(model: model, runId: "qa-restored", appearance: .aqua, width: 900, expanded: true),
            ["case": "missing-only", "state": "succeeded restored, receipt row expanded"])
        #expect(opened.contains("copy prepared") && opened.contains("new-output"))
        // Negative control: the same restored card without the snapshot receipt.
        let bare = Self.model("qa-bare", phase: .succeeded)
        let none = try record("turncard-restored-without-receipt-collapsed-light-req900",
            try await Self.render(model: bare, runId: "qa-bare", appearance: .aqua, width: 900),
            ["case": "none", "state": "succeeded, no receipt (negative control)"])
        #expect(!none.contains("Input warning") && !none.contains("copy prepared"))
        let data = try JSONSerialization.data(withJSONObject: [
            "capture": "NSHostingView.cacheDisplay of TurnCard; borderless window never ordered front;"
                + " activationPolicy prohibited; AppModel memoryOnly, no client",
            "shots": shots,
        ], options: [.prettyPrinted, .sortedKeys])
        try data.write(to: out.appendingPathComponent("render-evidence.json"))
    }

    /// A failed or interrupted turn with no executor output keeps its reason
    /// card (exact reason, Open run) beside the engine notice; real executor
    /// output still replaces the card, as before.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_PREPARED_RENDER_OUT"] != nil))
    func theFailureCardSurvivesTheReceipt() async throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["CX_PREPARED_RENDER_OUT"]),
                      isDirectory: true).appendingPathComponent("failure-card")
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let policy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(policy) }
        let item = try #require(try Self.fixture().first { $0.name == "missing-only" })
        let reason = "Vendor CLI is not signed in. Sign in, then retry."
        var shots: [[String: Any]] = []
        for (phaseName, phase) in [("failed", RunPhase.failed), ("interrupted", .interrupted)] {
            for variant in ["no-notice", "live-notice", "restored-notice", "notice-and-output"] {
                let runId = "qa-\(phaseName)-\(variant)"
                let model = Self.model(runId, phase: phase)
                model.liveTasks[0].answerText = nil
                model.liveTasks[0].engineError = reason
                switch variant {
                case "live-notice": model.apply(Self.prepared(item.event, seq: 1), to: runId)
                case "restored-notice": model.foldTimelineNotices(runId, [item.row])
                case "notice-and-output":
                    model.apply(Self.prepared(item.event, seq: 1), to: runId)
                    model.apply(Self.message("Executor output before the failure.", seq: 2), to: runId)
                default: break
                }
                let shot = try await Self.render(model: model, runId: runId, appearance: .aqua, width: 900)
                let text = try Self.ocr(shot.png)
                let name = "turncard-\(phaseName)-\(variant)-light-req900"
                try shot.png.write(to: out.appendingPathComponent(name + ".png"))
                try text.write(to: out.appendingPathComponent(name + ".ocr.txt"), atomically: true, encoding: .utf8)
                let card = text.contains("not signed in") && text.contains("Open run")
                var row = shot.measured
                row["png"] = name + ".png"
                row["failure_card_drawn"] = card
                shots.append(row)
                #expect(card == (variant != "notice-and-output"), "\(phaseName) \(variant)")
            }
        }
        let data = try JSONSerialization.data(withJSONObject: ["shots": shots], options: [.prettyPrinted, .sortedKeys])
        try data.write(to: out.appendingPathComponent("render-evidence.json"))
    }
}

private final class PreparedDetailStub: URLProtocol {
    struct Refused: Error {}
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        DispatchQueue.global().async { [self] in
            do {
                guard let handler = Self.handler else { throw Refused() }
                let data = try handler(request)
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"])!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }
    override func stopLoading() {}
}
