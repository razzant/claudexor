import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct ClaudexorKitTests {
    @Test func jsonValueDecodesNestedPayload() throws {
        let json = #"{"type":"harness.event","payload":{"path":"a.ts","exit_code":0},"ok":true,"n":3}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        #expect(value["type"]?.stringValue == "harness.event")
        #expect(value["payload"]?["path"]?.stringValue == "a.ts")
        #expect(value["payload"]?["exit_code"]?.doubleValue == 0)
        #expect(value["ok"]?.boolValue == true)
        #expect(value["n"]?.doubleValue == 3)
    }

    @Test func jsonValueRoundTrips() throws {
        let json = #"{"a":[1,2,3],"b":null,"c":{"d":"x"}}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let reencoded = try JSONEncoder().encode(value)
        let again = try JSONDecoder().decode(JSONValue.self, from: reencoded)
        #expect(value == again)
    }

    @Test func startRunRequestEncodesPromptAndMode() throws {
        let req = StartRunRequest(
            prompt: "fix bug",
            mode: "agent",
            scope: .project(root: "/tmp/repo"),
            harnesses: ["codex", "claude"],
            reviewerModels: ["openai": "gpt-5.5"],
            reviewerEfforts: ["openai": "xhigh", "anthropic": "high"],
            n: 2
        )
        let data = try JSONEncoder().encode(req)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded["prompt"]?.stringValue == "fix bug")
        #expect(decoded["mode"]?.stringValue == "agent")
        #expect(decoded["scope"]?["kind"]?.stringValue == "project")
        #expect(decoded["scope"]?["root"]?.stringValue == "/tmp/repo")
        #expect(decoded["execution"]?["isolation"]?.stringValue == "envelope")
        #expect(decoded["reviewerModels"]?["openai"]?.stringValue == "gpt-5.5")
        #expect(decoded["reviewerEfforts"]?["openai"]?.stringValue == "xhigh")
        #expect(decoded["reviewerEfforts"]?["anthropic"]?.stringValue == "high")
        #expect(decoded["n"]?.doubleValue == 2)
    }

    @Test func settingsUpdateCanClearBudgetCaps() throws {
        let req = SettingsUpdateRequest(defaultPortfolio: "subscription-first", clearMaxUsdPerRun: true, clearMaxUsdPerDay: true)
        let data = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(obj?["defaultPortfolio"] as? String == "subscription-first")
        #expect(obj?["maxUsdPerRun"] == nil)
        #expect(obj?["maxUsdPerDay"] == nil)
        #expect(obj?["clearMaxUsdPerRun"] as? Bool == true)
        #expect(obj?["clearMaxUsdPerDay"] as? Bool == true)
    }

    @Test func settingsUpdateEncodesInteractionTimeout() throws {
        // The custom encode(to:) must actually serialize the field — a missing
        // CodingKeys entry once made the Settings UI POST an empty body.
        let req = SettingsUpdateRequest(interactionTimeoutMs: 300_000)
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]
        #expect(obj?["interactionTimeoutMs"] as? Int == 300_000)
        let empty = SettingsUpdateRequest()
        let emptyObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(empty)) as? [String: Any]
        #expect(emptyObj?["interactionTimeoutMs"] == nil)
    }

    @Test func harnessStatusDecodesChecksAndDefaultsMissingIntentArrays() throws {
        let rich = """
        {
          "id": "codex",
          "status": "degraded",
          "manifest": null,
          "enabledIntents": [],
          "disabledIntents": ["review"],
          "checks": [{"id":"isolated_api_smoke","status":"fail","detail":"401"}],
          "reasons": ["isolated smoke failed"]
        }
        """
        let status = try JSONDecoder().decode(HarnessStatus.self, from: Data(rich.utf8))
        #expect(status.id == "codex")
        #expect(status.enabledIntents.isEmpty)
        #expect(status.disabledIntents == ["review"])
        #expect(status.checks == [HarnessCheck(id: "isolated_api_smoke", status: "fail", detail: "401")])

        let legacy = #"{"id":"claude","status":"ok","manifest":null}"#
        let legacyStatus = try JSONDecoder().decode(HarnessStatus.self, from: Data(legacy.utf8))
        #expect(legacyStatus.enabledIntents.isEmpty)
        #expect(legacyStatus.disabledIntents.isEmpty)
        #expect(legacyStatus.checks.isEmpty)
    }

    @Test func runDetailDecodesNewProjectionFieldsAndOldPayloadDefaults() throws {
        let rich = """
        {
          "summary": {"runId":"run-1","state":"succeeded","spendUsd":0.12,"spendEstimated":true},
          "primaryOutput": {"kind":"answer","path":"final/answer.md","text":"4","bytes":1},
          "timeline": [{"type":"harness.event","title":"Codex answered","detail":"done","rawRef":"events.jsonl"}],
          "budget": {"maxUsd":0.50,"spendUsd":0.12,"remainingUsd":0.38,"estimated":true,"source":"events","nativeQuota":[]},
          "reviewFindings": []
        }
        """
        let detail = try JSONDecoder().decode(RunDetail.self, from: Data(rich.utf8))
        #expect(detail.summary.runId == "run-1")
        #expect(detail.summary.spendUsd == 0.12)
        #expect(detail.primaryOutput?.text == "4")
        #expect(detail.timeline.first?.type == "harness.event")
        #expect(detail.budget?.source == "events")

        let legacy = #"{"summary":{"runId":"run-old","state":"succeeded"}}"#
        let old = try JSONDecoder().decode(RunDetail.self, from: Data(legacy.utf8))
        #expect(old.artifacts.isEmpty)
        #expect(old.timeline.isEmpty)
        #expect(old.reviewFindings.isEmpty)
        #expect(old.primaryOutput == nil)
        #expect(old.budget == nil)
    }

    @Test func controlApiDiscoveryLoadsEndpointAndToken() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let token = dir.appendingPathComponent("token")
        try "secret-token\n".write(to: token, atomically: true, encoding: .utf8)
        let doc = dir.appendingPathComponent("control-api.json")
        try #"{"host":"127.0.0.1","port":12345,"tokenPath":"\#(token.path)"}"#.write(to: doc, atomically: true, encoding: .utf8)

        let discovery = try ControlApiDiscovery.load(from: doc)
        #expect(discovery.baseURL.absoluteString == "http://127.0.0.1:12345")
        #expect(try discovery.readToken() == "secret-token")
    }

    // MARK: SSE parser (the bytes.lines pitfall regression suite)

    @Test func sseParserDispatchesFramesOnEmptyLines() {
        var parser = SSEParser()
        let wire = "id: 7\nevent: run.created\ndata: {\"a\":1}\n\nid: 8\nevent: output.ready\ndata: {\"b\":2}\n\n"
        let frames = parser.feed(Array(wire.utf8))
        #expect(frames.count == 2)
        #expect(frames[0] == SSEFrame(id: 7, event: "run.created", data: "{\"a\":1}"))
        #expect(frames[1] == SSEFrame(id: 8, event: "output.ready", data: "{\"b\":2}"))
    }

    @Test func sseParserHandlesChunkBoundariesMidLine() {
        var parser = SSEParser()
        var frames: [SSEFrame] = []
        // Split a single frame across pathological chunk boundaries.
        for chunk in ["id: 4", "2\nev", "ent: harness.event\nda", "ta: {\"x\":", "true}\n", "\n"] {
            frames.append(contentsOf: parser.feed(Array(chunk.utf8)))
        }
        #expect(frames == [SSEFrame(id: 42, event: "harness.event", data: "{\"x\":true}")])
    }

    @Test func sseParserHandlesCRLFAndComments() {
        var parser = SSEParser()
        let wire = ": ping 123\r\nid: 1\r\nevent: end\r\ndata: {}\r\n\r\n"
        let frames = parser.feed(Array(wire.utf8))
        #expect(frames == [SSEFrame(id: 1, event: "end", data: "{}")])
    }

    @Test func sseParserJoinsMultiLineDataAndSkipsEmptyEvents() {
        var parser = SSEParser()
        // A comment-only block dispatches nothing; multi-line data joins with \n.
        let frames = parser.feed(Array(": heartbeat\n\ndata: line1\ndata: line2\n\n".utf8))
        #expect(frames.count == 1)
        #expect(frames[0].data == "line1\nline2")
        #expect(frames[0].event == "message")
    }

    @Test func sseParserCarriesLastSeenIdForward() {
        var parser = SSEParser()
        let frames = parser.feed(Array("id: 5\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\n".utf8))
        #expect(frames.count == 2)
        #expect(frames[0].id == 5)
        // Per WHATWG, the last seen id persists for subsequent frames.
        #expect(frames[1].id == 5)
    }

    // MARK: Interactive DTOs

    @Test func runDetailDecodesLastSeqAndPendingInteractions() throws {
        let json = """
        {"summary":{"runId":"run-1","state":"running","waitingOnUser":true,
          "route":{"requestedModel":null,"observedModel":"claude-opus-4-8","harnessId":"claude","verified":true}},
         "lastSeq":17,
         "pendingInteractions":[{"interactionId":"int-1","runId":"run-1","attemptId":"a01","harnessId":"claude",
           "sourceTool":"AskUserQuestion","requestedAt":"t","timeoutAt":null,
           "questions":[{"id":"q1","question":"Which?","header":"Pick","multi_select":true,
             "options":[{"label":"A","description":"first"},{"label":"B","description":null}]}]}]}
        """
        let detail = try JSONDecoder().decode(RunDetail.self, from: Data(json.utf8))
        #expect(detail.lastSeq == 17)
        #expect(detail.summary.waitingOnUser == true)
        #expect(detail.summary.route?.observedModel == "claude-opus-4-8")
        #expect(detail.summary.route?.verified == true)
        #expect(detail.pendingInteractions.count == 1)
        let interaction = try #require(detail.pendingInteractions.first)
        #expect(interaction.questions.first?.multiSelect == true)
        #expect(interaction.questions.first?.options.map(\.label) == ["A", "B"])
        // Legacy detail without the new fields stays decodable.
        let legacy = #"{"summary":{"runId":"run-old","state":"succeeded"}}"#
        let old = try JSONDecoder().decode(RunDetail.self, from: Data(legacy.utf8))
        #expect(old.lastSeq == 0)
        #expect(old.pendingInteractions.isEmpty)
    }
}
