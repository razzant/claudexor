import AppKit
import ClaudexorKit
import SwiftUI
import Testing
import Vision
@testable import ClaudexorApp

@MainActor struct ClaudeTurnReplyCardTests {
    @Test func onlyALaterReplyFromTheSameKnownAttemptAndSessionGetsAnEarlierLabel() throws {
        let replies = try JSONDecoder().decode(ClaudeTurnReplies.self, from: Data(#"""
          {"rows":[
            {"seq":2,"source":{"attemptId":"a","sessionId":"s","afterStop":false},"text":"First","truncated":false},
            {"seq":3,"source":{"attemptId":"b","sessionId":"s","afterStop":false},"text":"First","truncated":false},
            {"seq":4,"source":{"attemptId":"a","sessionId":null,"afterStop":false},"text":"First","truncated":false},
            {"seq":5,"source":{"attemptId":"a","sessionId":"s","afterStop":false},"text":"Correction","truncated":false}
          ],"partial":false}
          """#.utf8))
        let titles = replies.rows.map { ClaudeTurnRepliesView.title(for: $0, in: replies, active: false) }
        #expect(titles == ["Earlier Claude turn reply", "Claude turn reply", "Claude turn reply", "Claude turn reply"])
        #expect(replies.rows[2].source?.attribution == "Attempt a · Session unknown")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_CLAUDE_TURN_RENDER_QA"] == "1"))
    func liveCorrectionAndReloadedOutcome() async throws {
        let app = NSApplication.shared
        let policy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        defer { app.setActivationPolicy(policy) }

        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        source.runs[0].answerText = nil
        func model() -> AppModel {
            HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        }
        let live = model()
        let runID = source.runs[0].id
        let first = "The north entrance opens at eight."
        let correction = "Correction: the north entrance opens at nine."
        let output = "Updated the opening hours in the guide."
        func message(_ seq: Int, _ text: String, final: Bool) {
            let event = BusEnvelope(seq: seq, kind: "harness.event", event: .object([
                "run_id": .string(runID), "seq": .number(Double(seq)),
                "type": .string("harness.event"), "payload": .object([
                    "type": .string("message"), "harness_id": .string("claude"),
                    "attempt_id": .string("a01"), "session_id": .string("s1"),
                    "after_stop": .bool(false), "text": .string(text), "final": .bool(final)
                ])
            ]))
            live.apply(event, to: runID)
        }
        func capture(_ name: String, _ model: AppModel, showing: [String], absent: [String], repeated: String? = nil) async throws {
            let target = TurnStartTarget.existing(locationID: .local, threadID: source.detail.thread.id,
                repoRoot: nil, workspaceMode: "isolated", eligibleHarnesses: ["claude"])
            let card = TurnCard(turn: source.detail.turns[0], target: target, routingOptions: TurnOptions(),
                executionRoot: nil, historyRow: model.selectedHistory?.rows.first)
            let host = NSHostingView(rootView: card.padding().frame(width: 660).background(Theme.surfaceBase)
                .environment(model).environment(model.selectedHistory!.presentation).environment(\.colorScheme, .light))
            host.appearance = NSAppearance(named: .aqua)
            host.frame.size = NSSize(width: 660, height: 480)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            host.frame.size.height = host.fittingSize.height.rounded(.up)
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
            #expect(host.window == nil && !app.isActive)
            if let repeated {
                func prose(in view: NSView) -> [ProseTextView] {
                    (view as? ProseTextView).map { [$0] } ?? view.subviews.flatMap { prose(in: $0) }
                }
                let copies = prose(in: host).filter { $0.string.contains(repeated) }
                // Width restoration resolves (turn, shownID). The same words
                // in the terminal output must not resolve to the reply above.
                #expect(copies.count == 2 && Set(copies.compactMap(\.shownID)).count == 2)
                #expect(Set(copies.compactMap(\.messageID)) == [source.detail.turns[0].id])
            }
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            if let path = ProcessInfo.processInfo.environment["CX_CLAUDE_TURN_RENDER_OUTPUT"] {
                let dir = URL(fileURLWithPath: path, isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try png.write(to: dir.appendingPathComponent("\(name).png"))
            }
            let request = VNRecognizeTextRequest()
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(data: png).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: " ").lowercased()
            for phrase in showing { #expect(text.contains(phrase.lowercased()), "\(name): \(text)") }
            for phrase in absent { #expect(!text.contains(phrase.lowercased()), "\(name): \(text)") }
            for phrase in [first, correction] where showing.contains(phrase) {
                #expect(text.components(separatedBy: phrase.lowercased()).count == (phrase == repeated ? 3 : 2), "\(name): \(text)")
            }
        }
        message(1, first, final: false)
        message(2, first, final: true)
        try await capture("first-active", live, showing: [first, "Run still active"], absent: [correction])
        message(3, correction, final: false)
        message(4, correction, final: true)
        try await capture("corrected-active", live, showing: [first, correction, "Earlier Claude turn reply"], absent: [output])
        message(5, String(repeating: "Long reply. ", count: 850), final: true)
        try await capture("clipped-live", live, showing: ["Reply preview", "Read full reply"],
                          absent: ["Show more", "Find next reply"])

        let origin: [String: Any] = ["attemptId": "a01", "sessionId": "s1", "afterStop": false]
        var laterSource = origin
        source.transform = { page in
            var turns = page["turns"] as! [[String: Any]]
            var run = turns[0]["run"] as! [String: Any]
            run["claudeTurnReplies"] = ["rows": [
                ["seq": 2, "source": origin, "text": first, "truncated": false],
                ["seq": 4, "source": laterSource, "text": correction, "truncated": false]], "partial": false] as [String: Any]
            turns[0]["run"] = run
            page["turns"] = turns
        }
        try await capture("reloaded-active", model(), showing: [first, correction, "Run still active"], absent: [output])
        source.runs[0].phase = .succeeded
        source.runs[0].answerText = output
        try await capture("reloaded-done", model(), showing: [first, correction, "Run output", output, "Done"],
                          absent: ["Run still active"])
        // The terminal artifact shares its words with another candidate's reply
        // and carries no source event. The two attempts are independent.
        laterSource = ["attemptId": "b02", "sessionId": "s2", "afterStop": false]
        source.runs[0].answerText = correction
        try await capture("matching-terminal-output", model(), showing: [first, correction, "Run output", "Done"],
                          absent: ["Run still active", "Earlier Claude turn reply"], repeated: correction)
        source.runs[0].phase = .cancelled
        source.runs[0].answerText = nil
        try await capture("reloaded-cancelled", model(), showing: [first, correction, "Cancelled"],
                          absent: ["Run still active", output])
    }
}
