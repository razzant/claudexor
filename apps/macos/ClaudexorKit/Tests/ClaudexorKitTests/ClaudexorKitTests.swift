import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
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
            reviewerPanel: [
                ReviewerPanelEntry(harness: "claude", model: "claude-opus-4-8", effort: "max"),
                ReviewerPanelEntry(harness: "cursor", model: "gemini-3.1-pro"),
                ReviewerPanelEntry(harness: "cursor", model: "gpt-5.5-xhigh-1M")
            ],
            reviewerModels: ["openai": "gpt-5.5"],
            reviewerEfforts: ["openai": "xhigh", "anthropic": "high"],
            n: 2,
            tests: ["pnpm test"],
            protectedPathApprovals: [ProtectedPathApproval(path: "packages/**/*.test.ts", reason: "test authoring requested")]
        )
        let data = try JSONEncoder().encode(req)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded["prompt"]?.stringValue == "fix bug")
        #expect(decoded["mode"]?.stringValue == "agent")
        #expect(decoded["scope"]?["kind"]?.stringValue == "project")
        #expect(decoded["scope"]?["root"]?.stringValue == "/tmp/repo")
        #expect(decoded["execution"]?["isolation"]?.stringValue == "envelope")
        let raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let panel = try #require(raw["reviewerPanel"] as? [[String: Any]])
        #expect(panel.count == 3)
        #expect(panel[0]["harness"] as? String == "claude")
        #expect(panel[0]["model"] as? String == "claude-opus-4-8")
        #expect(panel[0]["effort"] as? String == "max")
        #expect(panel[1]["harness"] as? String == "cursor")
        #expect(panel[1]["model"] as? String == "gemini-3.1-pro")
        #expect(panel[2]["harness"] as? String == "cursor")
        #expect(panel[2]["model"] as? String == "gpt-5.5-xhigh-1M")
        #expect(decoded["reviewerModels"]?["openai"]?.stringValue == "gpt-5.5")
        #expect(decoded["reviewerEfforts"]?["openai"]?.stringValue == "xhigh")
        #expect(decoded["reviewerEfforts"]?["anthropic"]?.stringValue == "high")
        if case .array(let tests)? = decoded["tests"] {
            #expect(tests[0].stringValue == "pnpm test")
        } else { Issue.record("expected tests array") }
        if case .array(let approvals)? = decoded["protectedPathApprovals"] {
            #expect(approvals[0]["path"]?.stringValue == "packages/**/*.test.ts")
            #expect(approvals[0]["reason"]?.stringValue == "test authoring requested")
        } else { Issue.record("expected protectedPathApprovals array") }
        #expect(decoded["n"]?.doubleValue == 2)
    }

    @Test func composerOptionParserRejectsEmptyReviewerPanelEntries() throws {
        let middleEmpty = ComposerOptionParser.splitOptionTokens("claude,,cursor=gpt-5.5")
        #expect(middleEmpty == ["claude", "", "cursor=gpt-5.5"])
        let middleEntries = middleEmpty.compactMap(ComposerOptionParser.parseReviewerPanelEntry)
        #expect(middleEntries.count == 2)
        #expect(middleEntries.count != middleEmpty.count)

        let trailingEmpty = ComposerOptionParser.splitOptionTokens("claude,")
        #expect(trailingEmpty == ["claude", ""])
        let trailingEntries = trailingEmpty.compactMap(ComposerOptionParser.parseReviewerPanelEntry)
        #expect(trailingEntries.count == 1)
        #expect(trailingEntries.count != trailingEmpty.count)
    }

    @Test func composerOptionParserPreservesModelColonsAndEffortSuffixes() throws {
        let entry = try #require(
            ComposerOptionParser.parseReviewerPanelEntry("cursor=openai/gpt-5.5:extra-high:max")
        )
        #expect(entry.harness == "cursor")
        #expect(entry.model == "openai/gpt-5.5:extra-high")
        #expect(entry.effort == "max")

        let harnessEffort = try #require(ComposerOptionParser.parseReviewerPanelEntry("claude:max"))
        #expect(harnessEffort.harness == "claude")
        #expect(harnessEffort.model == nil)
        #expect(harnessEffort.effort == "max")
    }

    @Test func settingsUpdateCanClearBudgetCaps() throws {
        let req = SettingsUpdateRequest(defaultPortfolio: "subscription-first", clearMaxUsdPerRun: true)
        let data = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(obj?["defaultPortfolio"] as? String == "subscription-first")
        #expect(obj?["maxUsdPerRun"] == nil)
        #expect(obj?["clearMaxUsdPerRun"] as? Bool == true)
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

    @Test func settingsSnapshotDecodesRuntime() throws {
        let data = Data("""
        {
          "sources": [],
          "defaultPortfolio": "subscription-first",
          "interactionTimeoutMs": 900000,
          "routing": {
            "defaultPolicy": "auto",
            "primaryHarness": null,
            "eligibleHarnesses": [],
            "defaultModel": null,
            "envInheritance": "mirror_native",
            "authPreference": "auto"
          },
          "budget": { "maxUsdPerRun": null },
          "runtime": {
            "reviewerTimeoutMs": 2400000,
            "transientRetry": {
              "maxRetries": 3,
              "initialDelayMs": 2000,
              "maxDelayMs": 20000
            }
          },
          "harnesses": {}
        }
        """.utf8)
        let snapshot = try JSONDecoder().decode(SettingsSnapshot.self, from: data)
        #expect(snapshot.runtime?.reviewerTimeoutMs == 2_400_000)
        #expect(snapshot.runtime?.transientRetry.maxRetries == 3)
        #expect(snapshot.runtime?.transientRetry.initialDelayMs == 2_000)
        #expect(snapshot.runtime?.transientRetry.maxDelayMs == 20_000)
    }

    @Test func harnessSettingsPatchEncodesClearVsSetForModelOverride() throws {
        // The macOS per-harness auto-save builds this patch from its drafts. The
        // revert bug was macOS-side @State handling, but the WIRE contract it
        // relies on must hold: a TYPED model override persists as a real string
        // (not dropped to null), and an EMPTY draft clears the override (explicit
        // JSON null), while web is always sent and untouched server-only fields
        // (maxTurns/maxRounds) are omitted so applyHarnessSettingsPatches keeps them.
        let setPatch = HarnessSettingsPatch(
            enabled: true,
            defaultModel: .some("gpt-5.5"),
            effort: .some("high"),
            web: "live",
            maxUsd: .some(2.5),
            toolsAllow: ["read"],
            toolsDeny: [],
            fallbackModel: .some(nil),
            authPreference: "api_key"
        )
        let setObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(setPatch)) as? [String: Any]
        #expect(setObj?["enabled"] as? Bool == true)
        #expect(setObj?["defaultModel"] as? String == "gpt-5.5")  // typed → real value, never reverted to null
        #expect(setObj?["effort"] as? String == "high")
        #expect(setObj?["web"] as? String == "live")
        #expect(setObj?["maxUsd"] as? Double == 2.5)
        #expect(setObj?["toolsAllow"] as? [String] == ["read"])
        #expect(setObj?["authPreference"] as? String == "api_key")
        // fallback empty → explicit null (clear); untouched fields omitted (kept server-side).
        #expect(setObj?.keys.contains("fallbackModel") == true)
        #expect(setObj?["fallbackModel"] is NSNull)
        #expect(setObj?["maxTurns"] == nil)
        #expect(setObj?["maxRounds"] == nil)

        // An empty model-override draft clears the stored override (explicit null),
        // which is distinct from "omit" (keep). This is the half the revert bug
        // would have broken if an empty field silently kept the old value.
        let clearPatch = HarnessSettingsPatch(enabled: true, defaultModel: .some(nil), web: "auto")
        let clearObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(clearPatch)) as? [String: Any]
        #expect(clearObj?.keys.contains("defaultModel") == true)
        #expect(clearObj?["defaultModel"] is NSNull)
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

    @Test func harnessModelsResponseDecodesEnumerationAndNoneFallback() throws {
        // Real enumeration (raw-api GET /v1/models): snake_case context_window,
        // a model with a null label, and a present-but-null label both tolerated.
        let api = """
        {
          "harnessId": "raw-api",
          "source": "api",
          "models": [
            {"id": "gpt-5.5", "label": "GPT 5.5", "context_window": 400000},
            {"id": "o4-mini", "label": null, "context_window": null},
            {"id": "bare"}
          ]
        }
        """
        let enumerated = try JSONDecoder().decode(HarnessModelsResponse.self, from: Data(api.utf8))
        #expect(enumerated.harnessId == "raw-api")
        #expect(enumerated.source == "api")
        #expect(enumerated.canEnumerate)
        #expect(enumerated.models.count == 3)
        #expect(enumerated.models[0] == HarnessModel(id: "gpt-5.5", label: "GPT 5.5", contextWindow: 400000))
        #expect(enumerated.models[1].label == nil)
        #expect(enumerated.models[1].contextWindow == nil)
        #expect(enumerated.models[2] == HarnessModel(id: "bare"))

        // Harness that cannot enumerate: source "none", models defaulted to [].
        let none = #"{"harnessId":"claude","source":"none"}"#
        let unavailable = try JSONDecoder().decode(HarnessModelsResponse.self, from: Data(none.utf8))
        #expect(unavailable.source == "none")
        #expect(unavailable.models.isEmpty)
        #expect(!unavailable.canEnumerate)
    }

    @Test func runDetailDecodesNewProjectionFieldsAndOldPayloadDefaults() throws {
        let rich = """
        {
          "summary": {"runId":"run-1","state":"succeeded","spendUsd":0.12,"spendEstimated":true,"tests":["pnpm test"]},
          "primaryOutput": {"kind":"answer","path":"final/answer.md","text":"4","bytes":1},
          "timeline": [{"type":"harness.event","title":"Codex answered","detail":"done","rawRef":"events.jsonl"}],
          "budget": {"maxUsd":0.50,"spendUsd":0.12,"remainingUsd":0.38,"estimated":true,"source":"events"},
          "reviewFindings": []
        }
        """
        let detail = try JSONDecoder().decode(RunDetail.self, from: Data(rich.utf8))
        #expect(detail.summary.runId == "run-1")
        #expect(detail.summary.spendUsd == 0.12)
        #expect(detail.summary.tests == ["pnpm test"])
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

    // MARK: SSE parser (the bytes.lines pitfall regression suite)

    @Test func sseParserDispatchesFramesOnEmptyLines() {
        var parser = SSEParser()
        let wire = "id: 7\nevent: run.created\ndata: {\"a\":1}\n\nid: 8\nevent: output.ready\ndata: {\"b\":2}\n\n"
        let frames = parser.feed(Array(wire.utf8))
        #expect(frames.count == 2)
        #expect(frames[0] == SSEFrame(id: "7", event: "run.created", data: "{\"a\":1}"))
        #expect(frames[1] == SSEFrame(id: "8", event: "output.ready", data: "{\"b\":2}"))
    }

    @Test func sseParserHandlesChunkBoundariesMidLine() {
        var parser = SSEParser()
        var frames: [SSEFrame] = []
        // Split a single frame across pathological chunk boundaries.
        for chunk in ["id: 4", "2\nev", "ent: harness.event\nda", "ta: {\"x\":", "true}\n", "\n"] {
            frames.append(contentsOf: parser.feed(Array(chunk.utf8)))
        }
        #expect(frames == [SSEFrame(id: "42", event: "harness.event", data: "{\"x\":true}")])
    }

    @Test func sseParserHandlesCRLFAndComments() {
        var parser = SSEParser()
        let wire = ": ping 123\r\nid: 1\r\nevent: end\r\ndata: {}\r\n\r\n"
        let frames = parser.feed(Array(wire.utf8))
        #expect(frames == [SSEFrame(id: "1", event: "end", data: "{}")])
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
        #expect(frames[0].id == "5")
        // Per WHATWG, the last seen id persists for subsequent frames.
        #expect(frames[1].id == "5")
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

    // MARK: - v0.10 chat-first DTOs

    @Test func threadTurnDecodesEmbeddedRunCardAndOutcome() throws {
        let json = #"""
        {"id":"tn-1","threadId":"th-1","runId":"run-1","planRunId":null,"kind":"initial","prompt":"make a game",
         "run":{"state":"succeeded","mode":"plan","result":{"kind":"plan","diffStat":null,"blockers":1,"adopted":null},
                "outputReadyState":"ready","waitingOnUser":false},
         "createdAt":"t"}
        """#
        let turn = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(json.utf8))
        #expect(turn.run?.result?.kind == "plan")
        #expect(turn.run?.result?.diffStat == nil)       // plan: NO files changed
        #expect(turn.run?.result?.blockers == 1)
        #expect(turn.run?.state == "succeeded")
        // Legacy turn without the run card stays decodable.
        let legacy = #"{"id":"tn-0","threadId":"th-1","prompt":"hi","createdAt":"t"}"#
        let old = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(legacy.utf8))
        #expect(old.run == nil)
    }

    @Test func threadTurnDecodesEnqueueErrorAndTrustDTOs() throws {
        // A REFUSED turn: no run, but the server persisted WHY — the chat
        // renders this as the inline refusal card (never an empty bubble).
        let json = #"""
        {"id":"tn-3","threadId":"th-1","runId":null,"prompt":"risky work",
         "enqueueError":{"message":"access profile 'full' requires allow_full_access: true","code":"trust_full_access_required","failedAt":"t1"},
         "createdAt":"t"}
        """#
        let turn = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(json.utf8))
        #expect(turn.enqueueError?.message.contains("allow_full_access") == true)
        // The one-click remedy keys on the typed CODE, never the message text.
        #expect(turn.enqueueError?.code == TurnEnqueueErrorInfo.trustFullAccessCode)
        #expect(turn.enqueueError?.failedAt == "t1")
        // An untyped, NON-retryable refusal (enqueue threw before any job):
        // code null, retryable false — the card offers "send a new message".
        let untyped = #"""
        {"id":"tn-4","threadId":"th-1","runId":null,"prompt":"x",
         "enqueueError":{"message":"daemon socket is gone","code":null,"retryable":false,"failedAt":"t2"},
         "createdAt":"t"}
        """#
        let refusedNoJob = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(untyped.utf8))
        #expect(refusedNoJob.enqueueError?.code == nil)
        #expect(refusedNoJob.enqueueError?.retryable == false)
        // Legacy refusal without the field reads as retryable (runner-hook path).
        #expect(turn.enqueueError?.retryable == nil)
        // Legacy turn (no field) and a cleared refusal both decode to nil.
        let legacy = #"{"id":"tn-0","threadId":"th-1","prompt":"hi","createdAt":"t"}"#
        #expect(try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(legacy.utf8)).enqueueError == nil)
        // Trust DTOs: legacy entries carry a null repoRoot (path-only identity).
        let list = #"{"entries":[{"repoRoot":"/Users/x/proj","path":"/t/a.yaml","allowFullAccess":true,"accessDefault":"workspace_write"},{"repoRoot":null,"path":"/t/old.yaml","allowFullAccess":true,"accessDefault":"workspace_write"}]}"#
        let trust = try JSONDecoder().decode(TrustListResponse.self, from: Data(list.utf8))
        #expect(trust.entries.count == 2)
        #expect(trust.entries[0].repoRoot == "/Users/x/proj")
        #expect(trust.entries[1].repoRoot == nil)
        let body = try JSONEncoder().encode(TrustUpdateRequest(repoRoot: "/p", allowFullAccess: true))
        let s = String(decoding: body, as: UTF8.self)
        #expect(s.contains("\"allowFullAccess\":true"))
    }

    @Test func threadTurnDecodesQueuedHeadDuringBindWindow() throws {
        // The 202-QUEUED bind window: the head turn has NO runId yet, but its
        // embedded run card already carries an active state. The composer's
        // busy-gate (selectedThreadBusy) reads `run.state` here to keep Send blocked
        // before a runId binds, so this exact shape must decode: runId == nil with a
        // non-nil, active run.state.
        let json = #"""
        {"id":"tn-2","threadId":"th-1","runId":null,"prompt":"build it",
         "run":{"state":"queued","mode":"agent","waitingOnUser":false},
         "createdAt":"t"}
        """#
        let turn = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(json.utf8))
        #expect(turn.runId == nil)            // no cancel target yet
        #expect(turn.run?.state == "queued")  // but the card is already active
    }

    @Test func createThreadRequestEncodesWorkspace() throws {
        let body = CreateThreadRequest(scope: .project(root: "/p"), workspace: "isolated")
        let data = try JSONEncoder().encode(body)
        let s = String(decoding: data, as: UTF8.self)
        #expect(s.contains("\"workspace\":\"isolated\""))
    }

    @Test func projectRegistryDTOsMatchV2WireShape() throws {
        let json = #"{"projects":[{"schemaVersion":2,"id":"prj-1","root":"/p","createdAt":"t","updatedAt":"t"}]}"#
        let list = try JSONDecoder().decode(ProjectListResponse.self, from: Data(json.utf8))
        #expect(list.projects.first?.id == "prj-1")
        let body = try JSONEncoder().encode(ProjectRootRequest(root: "/next"))
        let object = try JSONSerialization.jsonObject(with: body) as? [String: String]
        #expect(object?["root"] == "/next")
    }

    @Test func threadApplyResponseDecodes() throws {
        let json = #"{"applied":true,"status":"applied","headMoved":false,"detail":null}"#
        let r = try JSONDecoder().decode(ThreadApplyResponse.self, from: Data(json.utf8))
        #expect(r.applied)
        #expect(r.status == "applied")
    }

    @Test func createThreadRequestEncodesEligiblePool() throws {
        let body = CreateThreadRequest(scope: .project(root: "/p"), primaryHarness: "codex", eligibleHarnesses: ["codex", "claude"])
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        #expect(obj?["primaryHarness"] as? String == "codex")
        #expect(obj?["eligibleHarnesses"] as? [String] == ["codex", "claude"])
    }

    @Test func threadTurnRequestEncodesRoutingAndStrategyKnobs() throws {
        // Every key must already exist on the engine's run-start request (the turn
        // endpoint .strict()-parses the body) — primary/access/web/n/until-clean/review.
        let req = ThreadTurnRequest(prompt: "go", mode: "agent", harnesses: ["codex", "claude"], n: 2,
                                    attempts: 5, untilClean: true, maxUsd: 0.5, primaryHarness: "claude",
                                    reviewerPanel: [
                                        ReviewerPanelEntry(harness: "claude", model: "claude-opus-4-8", effort: "max"),
                                        ReviewerPanelEntry(harness: "cursor", model: "gemini-3.1-pro")
                                    ],
                                    reviewerModels: ["openai": "gpt-5.5"],
                                    reviewerEfforts: ["anthropic": "max"],
                                    access: "readonly", web: "off",
                                    tests: ["pnpm test -- --runInBand"],
                                    protectedPathApprovals: [ProtectedPathApproval(path: "packages/**/*.test.ts", reason: "test authoring requested")],
                                    authPreference: "api_key")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]
        #expect(obj?["primaryHarness"] as? String == "claude")
        let panel = try #require(obj?["reviewerPanel"] as? [[String: Any]])
        #expect(panel.count == 2)
        #expect(panel[0]["effort"] as? String == "max")
        #expect((obj?["reviewerModels"] as? [String: String])?["openai"] == "gpt-5.5")
        #expect((obj?["reviewerEfforts"] as? [String: String])?["anthropic"] == "max")
        #expect(obj?["access"] as? String == "readonly")
        #expect(obj?["web"] as? String == "off")
        #expect(obj?["n"] as? Int == 2)
        #expect(obj?["untilClean"] as? Bool == true)
        #expect(obj?["maxUsd"] as? Double == 0.5)
        let tests = try #require(obj?["tests"] as? [String])
        #expect(tests == ["pnpm test -- --runInBand"])
        let approvals = try #require(obj?["protectedPathApprovals"] as? [[String: Any]])
        #expect(approvals[0]["path"] as? String == "packages/**/*.test.ts")
        #expect(obj?["authPreference"] as? String == "api_key")
    }

    @Test func threadTurnRequestOmitsAbsentOptionalKeys() throws {
        // The turn endpoint is .strict(): absent optionals must NOT serialize as keys.
        let req = ThreadTurnRequest(prompt: "hi")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]
        #expect(obj?["prompt"] as? String == "hi")
        #expect(obj?["primaryHarness"] == nil)
        #expect(obj?["access"] == nil)
        #expect(obj?["web"] == nil)
        #expect(obj?["reviewerPanel"] == nil)
        #expect(obj?["tests"] == nil)
        #expect(obj?["protectedPathApprovals"] == nil)
        #expect(obj?["authPreference"] == nil)
        #expect(obj?["n"] == nil)
    }

    @Test func updateThreadRequestEncodesPrimaryAndPoolIncludingClear() throws {
        // Switch: explicit primary + pool.
        let switchBody = UpdateThreadRequest(primaryHarness: .some("claude"), eligibleHarnesses: ["claude", "cursor"])
        let s = try JSONSerialization.jsonObject(with: JSONEncoder().encode(switchBody)) as? [String: Any]
        #expect(s?["primaryHarness"] as? String == "claude")
        #expect(s?["eligibleHarnesses"] as? [String] == ["claude", "cursor"])
        // Clear primary to auto: .some(nil) -> explicit JSON null (NSNull), key present.
        let clearBody = UpdateThreadRequest(primaryHarness: .some(nil))
        let c = try JSONSerialization.jsonObject(with: JSONEncoder().encode(clearBody)) as? [String: Any]
        #expect(c?.keys.contains("primaryHarness") == true)
        #expect(c?["primaryHarness"] is NSNull)
        // Untouched: .none omits the key entirely (leave unchanged).
        let renameBody = UpdateThreadRequest(title: "x")
        let r = try JSONSerialization.jsonObject(with: JSONEncoder().encode(renameBody)) as? [String: Any]
        #expect(r?["primaryHarness"] == nil)
    }

    @Test func harnessSettingsPatchEncodesFullPerHarnessFields() throws {
        let patch = HarnessSettingsPatch(enabled: true, maxUsd: .some(1.5), toolsAllow: ["bash"],
                                         toolsDeny: ["net"], fallbackModel: .some("gpt-5-mini"),
                                         authPreference: "subscription")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any]
        #expect(obj?["enabled"] as? Bool == true)
        #expect(obj?["maxUsd"] as? Double == 1.5)
        #expect(obj?["toolsAllow"] as? [String] == ["bash"])
        #expect(obj?["toolsDeny"] as? [String] == ["net"])
        #expect(obj?["fallbackModel"] as? String == "gpt-5-mini")
        #expect(obj?["authPreference"] as? String == "subscription")
        // .some(nil) clears the cap (explicit JSON null); .none omits.
        let clear = HarnessSettingsPatch(maxUsd: .some(nil))
        let cobj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(clear)) as? [String: Any]
        #expect(cobj?.keys.contains("maxUsd") == true)
        #expect(cobj?["maxUsd"] is NSNull)
        #expect(cobj?["toolsAllow"] == nil)
    }

    @Test func threadSummaryDecodesEligiblePoolLegacyTolerant() throws {
        let rich = #"{"id":"th-1","title":"t","repoRoot":"/p","mode":"agent","workspaceMode":"in_place","authPreference":"auto","primaryHarness":"codex","eligibleHarnesses":["codex","claude"],"state":"active","runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"t","updatedAt":"t"}"#
        let t = try JSONDecoder().decode(ThreadSummary.self, from: Data(rich.utf8))
        #expect(t.eligibleHarnesses == ["codex", "claude"])
        // Legacy payload (no eligibleHarnesses key) decodes with nil, not a throw.
        let legacy = #"{"id":"th-0","title":null,"repoRoot":null,"mode":null,"workspaceMode":null,"authPreference":null,"primaryHarness":null,"state":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"t","updatedAt":"t"}"#
        let old = try JSONDecoder().decode(ThreadSummary.self, from: Data(legacy.utf8))
        #expect(old.eligibleHarnesses == nil)
    }

    // MARK: - SPEC-FLOW DTOs

    @Test func specQuestionsResponseDecodesInterview() throws {
        // /spec/questions: tier, snake_case allow_text, options[{id,label}], rationale.
        let json = """
        {
          "planRunId": "run-plan-1",
          "planDir": "/runs/run-plan-1",
          "questions": [
            {"id":"q1","tier":0,"prompt":"Which storage?","kind":"single",
             "options":[{"id":"opt-sqlite","label":"SQLite"},{"id":"opt-pg","label":"Postgres"}],
             "allow_text":true,"rationale":"Surfaced by plan review."},
            {"id":"q2","tier":1,"prompt":"Anything else?","kind":"text","options":[],"allow_text":true},
            {"id":"q3","prompt":"Pick targets","kind":"multi",
             "options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"allow_text":false}
          ]
        }
        """
        let res = try JSONDecoder().decode(SpecQuestionsResponse.self, from: Data(json.utf8))
        #expect(res.planRunId == "run-plan-1")
        #expect(res.planDir == "/runs/run-plan-1")
        #expect(res.questions.count == 3)
        let q1 = res.questions[0]
        #expect(q1.id == "q1")
        #expect(q1.tier == 0)
        #expect(q1.kind == "single")
        #expect(q1.allowText == true)                       // allow_text mapped
        #expect(q1.options == [SpecOption(id: "opt-sqlite", label: "SQLite"),
                               SpecOption(id: "opt-pg", label: "Postgres")])
        #expect(q1.rationale == "Surfaced by plan review.")
        #expect(res.questions[1].kind == "text")
        #expect(res.questions[2].kind == "multi")
        #expect(res.questions[2].allowText == false)
        // Tolerate omitted defaulted fields (tier defaults 0).
        let bare = #"{"planRunId":"r","planDir":"/d","questions":[{"id":"q","prompt":"?"}]}"#
        let leniant = try JSONDecoder().decode(SpecQuestionsResponse.self, from: Data(bare.utf8))
        #expect(leniant.questions.first?.tier == 0)
        #expect(leniant.questions.first?.kind == "single")
        #expect(leniant.questions.first?.allowText == false)
    }

    @Test func specFreezeResponseDecodesSpecPath() throws {
        // /spec/freeze: specPath is the FILE an Implement run reads (must decode).
        let json = """
        {
          "specId": "spec-7f3a",
          "specDir": "/repo/.claudexor/specs/spec-7f3a",
          "specPath": "/repo/.claudexor/specs/spec-7f3a/spec.json",
          "specHash": "sha256:abc123",
          "changes": [{"section":"success_criteria","kind":"added"},{"section":"tests","kind":"added"}]
        }
        """
        let res = try JSONDecoder().decode(SpecFreezeResponse.self, from: Data(json.utf8))
        #expect(res.specId == "spec-7f3a")
        #expect(res.specPath == "/repo/.claudexor/specs/spec-7f3a/spec.json")
        #expect(res.specHash == "sha256:abc123")
        #expect(res.changes.count == 2)
        #expect(res.changes.first?["section"]?.stringValue == "success_criteria")
        // Missing `changes` defaults to [] (not a throw).
        let noChanges = #"{"specId":"s","specDir":"/d","specPath":"/d/spec.json","specHash":"h"}"#
        let lean = try JSONDecoder().decode(SpecFreezeResponse.self, from: Data(noChanges.utf8))
        #expect(lean.changes.isEmpty)
    }

    @Test func specAnswerEncodesSnakeCaseKeysWithOptionIds() throws {
        // An answer carries option IDs (not labels) — snake_case wire keys.
        let answer = SpecAnswer(questionId: "q1", optionIds: ["opt-sqlite"], text: "and a cache")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as? [String: Any]
        #expect(obj?["question_id"] as? String == "q1")
        #expect(obj?["option_ids"] as? [String] == ["opt-sqlite"])
        #expect(obj?["text"] as? String == "and a cache")
    }

    @Test func threadTurnRequestEncodesSpecPath() throws {
        // An Implement-spec turn carries the server-returned spec FILE path.
        let req = ThreadTurnRequest(prompt: "Implement the frozen spec.", mode: "agent",
                                    specPath: "/repo/.claudexor/specs/spec-7f3a/spec.json")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]
        #expect(obj?["specPath"] as? String == "/repo/.claudexor/specs/spec-7f3a/spec.json")
        #expect(obj?["mode"] as? String == "agent")
        // Absent on a normal turn (the endpoint is .strict() — no stray key).
        let plain = ThreadTurnRequest(prompt: "hi")
        let plainObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plain)) as? [String: Any]
        #expect(plainObj?["specPath"] == nil)
    }

    @Test func threadTurnRequestEncodesPerTurnModel() throws {
        // A per-turn model override forwards under the same key the run-start request
        // uses (the turn endpoint .strict()-parses it).
        let req = ThreadTurnRequest(prompt: "go", mode: "agent", model: "gpt-5.5")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]
        #expect(obj?["model"] as? String == "gpt-5.5")
        // Absent when unset (harness default) — no stray key for the strict endpoint.
        let plain = ThreadTurnRequest(prompt: "hi")
        let plainObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plain)) as? [String: Any]
        #expect(plainObj?["model"] == nil)
    }

    @Test func threadTurnRequestEncodesHarnessScopedModels() throws {
        // INV-103: the harness-scoped map rides the turn; the pool is never
        // poisoned by one vendor's model id.
        let req = ThreadTurnRequest(prompt: "go", mode: "agent", models: ["codex": "gpt-5.5", "claude": "opus"])
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]
        let map = obj?["models"] as? [String: String]
        #expect(map?["codex"] == "gpt-5.5")
        #expect(map?["claude"] == "opus")
        // Absent when unset — the strict endpoint rejects stray keys.
        let plain = ThreadTurnRequest(prompt: "hi")
        let plainObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plain)) as? [String: Any]
        #expect(plainObj?["models"] == nil)
    }

    @Test func startRunRequestEncodesHarnessScopedModels() throws {
        let req = StartRunRequest(prompt: "x", models: ["codex": "gpt-5.5"])
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]
        #expect((obj?["models"] as? [String: String])?["codex"] == "gpt-5.5")
    }

    @Test func harnessModelsResponseDecodesManifestFreshness() throws {
        // Manifest-sourced lists carry the CLI version the hints were verified
        // against; the pickers surface it as a freshness note (INV-104).
        let json = """
        {"harnessId":"codex","models":[{"id":"gpt-5.5"}],"source":"manifest","verifiedAgainst":"0.137.0"}
        """.data(using: .utf8)!
        let res = try JSONDecoder().decode(HarnessModelsResponse.self, from: json)
        #expect(res.source == "manifest")
        #expect(res.verifiedAgainst == "0.137.0")
        #expect(res.canEnumerate)
    }

    @Test func settingsUpdateEncodesExplicitNullToClearPrimary() throws {
        // No "__none" magic string: .some(nil) encodes JSON null = clear.
        let clear = SettingsUpdateRequest(primaryHarness: .some(nil))
        let raw = String(data: try JSONEncoder().encode(clear), encoding: .utf8) ?? ""
        #expect(raw.contains("\"primaryHarness\":null"))
        let set = SettingsUpdateRequest(primaryHarness: .some("codex"))
        let setObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(set)) as? [String: Any]
        #expect(setObj?["primaryHarness"] as? String == "codex")
        // Untouched: the key is absent entirely.
        let untouched = SettingsUpdateRequest(defaultPortfolio: "balanced")
        let untouchedObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(untouched)) as? [String: Any]
        #expect(untouchedObj?["primaryHarness"] == nil)
    }

    @Test func threadListDecodeSalvagesRowsAndCountsDrops() throws {
        // ONE malformed row must not blank the whole sidebar: good rows
        // survive, the drop is counted for disclosure.
        let now = "2026-07-02T12:00:00Z"
        let good: [String: Any] = [
            "id": "th-ok", "title": "ok", "repoRoot": "/r", "mode": "agent",
            "workspaceMode": "in_place", "authPreference": "auto",
            "primaryHarness": NSNull(), "eligibleHarnesses": [],
            "state": "active", "runIds": [], "headRunId": NSNull(),
            "needsHuman": false, "createdAt": now, "updatedAt": now,
        ]
        let bad: [String: Any] = ["id": 42, "definitely": "not-a-thread"]
        let body = try JSONSerialization.data(withJSONObject: ["threads": [good, bad]])
        let decoded = try JSONDecoder().decode(ThreadListResponse.self, from: body)
        #expect(decoded.threads.count == 1)
        #expect(decoded.threads.first?.id == "th-ok")
        #expect(decoded.droppedThreads == 1)
    }

    @Test func runScopeProjectAlwaysEncodesAutoContext() throws {
        // The schema RunScopeContext enum has exactly one member; the helper
        // must not be able to produce anything else on the wire.
        let scope = RunScope.project(root: "/repo")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(scope)) as? [String: Any]
        #expect(obj?["kind"] as? String == "project")
        #expect(obj?["root"] as? String == "/repo")
        #expect(obj?["context"] as? String == "auto")
    }

    @Test func updateThreadEncodesArchiveAndReopenStates() throws {
        // The server ThreadState enum is active|closed — reopen must send
        // "active" ("open" 400s against the strict DTO — a live-caught regression).
        let archive = UpdateThreadRequest(state: "closed")
        let archiveObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(archive)) as? [String: Any]
        #expect(archiveObj?["state"] as? String == "closed")
        let reopen = UpdateThreadRequest(state: "active")
        let reopenObj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(reopen)) as? [String: Any]
        #expect(reopenObj?["state"] as? String == "active")
    }

    @Test func harnessStatusDecodesConfiguredModelCheck() throws {
        let json = """
        {"id":"codex","status":"ok","enabledIntents":[],"disabledIntents":[],"checks":[],
         "configuredModel":"gpt-old","configuredModelCheck":{"status":"rejected","message":"not in the manifest list"}}
        """.data(using: .utf8)!
        let status = try JSONDecoder().decode(HarnessStatus.self, from: json)
        #expect(status.configuredModel == "gpt-old")
        #expect(status.configuredModelCheck?.status == "rejected")
    }

    // MARK: - TranscriptReducer

    private func env(_ seq: Int, _ json: String) -> BusEnvelope {
        let value = try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        // The real per-run SSE sets kind to the event NAME, not "run"; the reducer
        // must discriminate on event["type"], so we pass the realistic kind here.
        return BusEnvelope(seq: seq, kind: value["type"]?.stringValue ?? "message", event: value)
    }

    @Test func reducerMatchesToolResultToCallByUseId() {
        var r = TranscriptReducer()
        r.apply(env(1, #"{"type":"harness.event","payload":{"type":"tool_call","tool":{"name":"bash","use_id":"u1","target":"pnpm test"}}}"#))
        r.apply(env(2, #"{"type":"harness.event","payload":{"type":"tool_result","tool":{"name":"bash","use_id":"u1","status":"ok","exit_code":0}}}"#))
        #expect(r.blocks.count == 1)
        if case .tool(_, let b) = r.blocks[0] {
            #expect(b.name == "bash")
            #expect(b.status == .ok)
            #expect(b.exitCode == 0)
        } else { Issue.record("expected a tool block") }
    }

    @Test func reducerMergesThinkingAndIsIdempotent() {
        var r = TranscriptReducer()
        r.apply(env(1, #"{"type":"harness.event","payload":{"type":"thinking","text":"step one"}}"#))
        r.apply(env(2, #"{"type":"harness.event","payload":{"type":"thinking","text":"step two"}}"#))
        r.apply(env(2, #"{"type":"harness.event","payload":{"type":"thinking","text":"step two"}}"#)) // replay
        r.apply(env(3, #"{"type":"harness.event","payload":{"type":"message","text":"the answer"}}"#))
        #expect(r.blocks.count == 2)   // merged thinking + one message (replay ignored)
        if case .thinking(_, let text) = r.blocks[0] { #expect(text == "step one\nstep two") } else { Issue.record("expected thinking") }
        if case .message(_, let text) = r.blocks[1] { #expect(text == "the answer") } else { Issue.record("expected message") }
    }

    @Test func reducerIgnoresNonHarnessEnvelopes() {
        var r = TranscriptReducer()
        r.apply(env(1, #"{"type":"run.completed","payload":{"status":"success"}}"#))
        #expect(r.blocks.isEmpty)
    }

    @Test func reducerSurvivesACapTrimWithAnOpenTool() {
        // Regression r2 #5: after the block window trims, the open-tool index maps
        // must shift (not clear) so a later result doesn't corrupt blocks or crash.
        var r = TranscriptReducer(cap: 4)
        var seq = 1
        r.apply(env(seq, #"{"type":"harness.event","payload":{"type":"tool_call","tool":{"name":"bash","use_id":"u1"}}}"#)); seq += 1
        for _ in 0..<6 { r.apply(env(seq, "{\"type\":\"harness.event\",\"payload\":{\"type\":\"message\",\"text\":\"m\(seq)\"}}")); seq += 1 }
        r.apply(env(seq, #"{"type":"harness.event","payload":{"type":"tool_result","tool":{"name":"bash","use_id":"u1","status":"ok"}}}"#))
        #expect(r.trimmed > 0)
        let toolBlocks = r.blocks.filter { if case .tool = $0 { return true }; return false }
        #expect(toolBlocks.count <= 1)   // no duplicate tool block
    }

    // MARK: - Composer Send/Stop gate (the busy-gate that kept regressing)

    @Test func composerIdleWhenNoActiveTurn() {
        // No runId, no embedded activity, no hydrated row → Send.
        #expect(resolveComposerTurnState(headRunId: nil, hydratedRowActive: nil,
                                         embeddedStateActive: false) == .idle)
    }

    @Test func composerStartingDuringPreBindWindow() {
        // 202 accepted, runId not bound yet, embedded says active → disabled Starting…
        // (busy, but no cancel target).
        #expect(resolveComposerTurnState(headRunId: nil, hydratedRowActive: nil,
                                         embeddedStateActive: true) == .starting)
    }

    @Test func composerBusyWhenRunBoundAndHydratedActive() {
        // runId bound, live row hydrated + active → Stop is actionable.
        #expect(resolveComposerTurnState(headRunId: "r1", hydratedRowActive: true,
                                         embeddedStateActive: true) == .busy)
    }

    @Test func composerBusyWhenRunBoundButRowNotHydrated() {
        // round-4 regression: runId bound, live row NOT hydrated yet, embedded
        // active. Must be .busy (the runId is a valid cancel target), NOT a
        // disabled .starting.
        #expect(resolveComposerTurnState(headRunId: "r1", hydratedRowActive: nil,
                                         embeddedStateActive: true) == .busy)
    }

    @Test func composerIdleAfterCancelEvenIfEmbeddedStale() {
        // round-3 regression: after Stop, the live row reads .cancelled (inactive)
        // while the embedded snapshot still says "running". The live row is
        // authoritative → .idle (composer returns to Send); the stale embedded
        // state must NOT keep it on Stop.
        #expect(resolveComposerTurnState(headRunId: "r1", hydratedRowActive: false,
                                         embeddedStateActive: true) == .idle)
    }

    @Test func composerIdleWhenBoundRowDoneAndNoEmbeddedActivity() {
        // runId bound, no hydrated row, embedded says terminal → not busy → Send
        // (don't show Stop on a finished turn during the bind window).
        #expect(resolveComposerTurnState(headRunId: "r1", hydratedRowActive: nil,
                                         embeddedStateActive: false) == .idle)
    }

    // MARK: - Per-harness auto-save (staged-field patch + anti-clobber)

    @Test func harnessPatchClearsEmptyDraftsWithExplicitNull() throws {
        // Empty/whitespace drafts must encode an EXPLICIT clear (.some(nil) -> JSON
        // null), not be omitted — so the override is dropped server-side.
        let patch = buildHarnessPatch(enabled: false, modelDraft: "  ", effort: "__default",
                                      web: "off", maxUsdDraft: "", toolsAllowDraft: " , ",
                                      toolsDenyDraft: "", fallbackDraft: "")
        #expect(patch.defaultModel == .some(Optional<String>.none))   // cleared
        #expect(patch.effort == .some(Optional<String>.none))         // sentinel -> cleared
        #expect(patch.maxUsd == .some(Optional<Double>.none))         // empty -> cleared
        #expect(patch.fallbackModel == .some(Optional<String>.none))
        #expect(patch.toolsAllow == [])                               // " , " -> no tokens
        #expect(patch.enabled == false)
        let json = String(decoding: try JSONEncoder().encode(patch), as: UTF8.self)
        #expect(json.contains("\"defaultModel\":null"))               // explicit clear on the wire
        #expect(json.contains("\"maxUsd\":null"))
    }

    @Test func harnessPatchSetsTypedValuesAndParses() {
        // Typed values survive into the patch; CSV/number parsing is fixed.
        let patch = buildHarnessPatch(enabled: true, modelDraft: " fable ", effort: "high",
                                      web: "live", maxUsdDraft: "1.5", toolsAllowDraft: "bash, edit ,read",
                                      toolsDenyDraft: "web", fallbackDraft: "opus")
        #expect(patch.defaultModel == .some("fable"))                 // trimmed, set
        #expect(patch.effort == .some("high"))
        #expect(patch.maxUsd == .some(1.5))
        #expect(patch.toolsAllow == ["bash", "edit", "read"])         // trimmed CSV
        #expect(patch.toolsDeny == ["web"])
        #expect(patch.fallbackModel == .some("opus"))
        #expect(patch.web == "live")
    }

    @Test func harnessPatchOmitsStoredModelWhenNotEditable() throws {
        // H2 guard: on a truth-less harness (models catalog cannot enumerate)
        // a stored legacy model must NOT ride along with other saves — the
        // strict engine would 400 the whole patch. Explicit clears still go.
        let stuck = buildHarnessPatch(enabled: true, modelDraft: "legacy-model", effort: "__default",
                                      web: "off", maxUsdDraft: "", toolsAllowDraft: "",
                                      toolsDenyDraft: "", fallbackDraft: "", modelEditable: false)
        #expect(stuck.defaultModel == Optional<String?>.none)         // omitted entirely
        let json = String(decoding: try JSONEncoder().encode(stuck), as: UTF8.self)
        #expect(!json.contains("defaultModel"))                       // absent on the wire
        let clear = buildHarnessPatch(enabled: true, modelDraft: "  ", effort: "__default",
                                      web: "off", maxUsdDraft: "", toolsAllowDraft: "",
                                      toolsDenyDraft: "", fallbackDraft: "", modelEditable: false)
        #expect(clear.defaultModel == .some(Optional<String>.none))   // explicit null clear rides
    }

    @Test func modelFieldStateCoversAllCatalogOutcomes() {
        // Pure branch selection for the model-override control: a transport
        // failure must NEVER produce a truth-source claim (refused/default-only).
        func answered(_ source: String, _ ids: [String]) -> HarnessModelsResponse {
            HarnessModelsResponse(harnessId: "codex",
                                  models: ids.map { HarnessModel(id: $0, label: nil, contextWindow: nil) },
                                  source: source)
        }
        #expect(modelFieldState(models: answered("api", ["m1"]), modelDraft: "", loadFailed: false) == .picker)
        #expect(modelFieldState(models: answered("none", []), modelDraft: "legacy", loadFailed: false) == .refusedLegacy)
        #expect(modelFieldState(models: nil, modelDraft: "legacy", loadFailed: true) == .unavailableWithDraft)
        #expect(modelFieldState(models: nil, modelDraft: "", loadFailed: true) == .unavailable)
        #expect(modelFieldState(models: answered("none", []), modelDraft: "", loadFailed: false) == .defaultOnly)
        // Catalog not answered yet (initial load / mid-retry): transient
        // loading state — NEVER the "default only" truth claim.
        #expect(modelFieldState(models: nil, modelDraft: "", loadFailed: false) == .loading)
        #expect(modelFieldState(models: nil, modelDraft: "legacy", loadFailed: false) == .loading)
        // Whitespace-only draft normalizes to empty (matches buildHarnessPatch).
        #expect(modelFieldState(models: answered("none", []), modelDraft: "  ", loadFailed: false) == .defaultOnly)
    }

    @Test func harnessSaveDoesNotSettleWhenNewerEditRacedIn() {
        // The field-revert bug: a typed value must SURVIVE a settings refresh until
        // its OWN save settles. An older in-flight save (captured an earlier gen)
        // must NOT clear `dirty` when a newer edit has bumped the generation.
        var gen = 0
        gen += 1; let firstEdit = gen      // user types "fable" -> gen 1
        gen += 1; let secondEdit = gen     // user types "fable5" before save lands -> gen 2
        #expect(harnessSaveShouldSettle(capturedGen: firstEdit, currentGen: gen) == false)  // stale, stays dirty
        #expect(harnessSaveShouldSettle(capturedGen: secondEdit, currentGen: gen) == true)  // newest, settles
    }
}

@Test func runDetailDecodesCandidateCards() throws {
    let json = """
    {
      "summary": {"id": "run-1", "runId": "run-1", "state": "succeeded", "mode": "agent"},
      "lastSeq": 5,
      "candidates": [
        {"attemptId": "a01", "harnessId": "claude", "label": "A", "costUsd": 0.42,
         "costEstimated": false, "errored": false, "gatesPassed": 2, "gatesTotal": 2,
         "blockers": 0, "reviewVerified": true, "finalReviewClean": true, "winner": true,
         "diffstat": {"files": 3, "additions": 25, "deletions": 4}},
        {"attemptId": "a02", "harnessId": "codex", "errored": true, "costUsd": 0.1,
         "costEstimated": true, "gatesPassed": 0, "gatesTotal": 1, "blockers": 1,
         "reviewVerified": false, "winner": false}
      ]
    }
    """
    let detail = try JSONDecoder().decode(RunDetail.self, from: Data(json.utf8))
    #expect(detail.candidates.count == 2)
    let a = detail.candidates[0]
    #expect(a.attemptId == "a01")
    #expect(a.winner)
    #expect(a.diffstat?.additions == 25)
    let b = detail.candidates[1]
    #expect(b.errored)
    #expect(b.finalReviewClean == nil)
    #expect(b.diffstat == nil)
}

@Suite(.serialized) struct SetupLifecycleTests {
    @Test func setupJobRejectsDeadFieldsAndUnknownV2Enums() throws {
        let legacy = """
        {"jobId":"old","harness":"claude","action":"login","state":"waiting_for_input",
         "command":"claude auth login","guideUrl":null,"logPath":null,"message":"Waiting",
         "createdAt":"2026-07-13T00:00:00Z"}
        """
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJob.self, from: Data(legacy.utf8))
        }

        let current = makeSetupJob(id: "new", state: "timed_out", phase: .completed,
                                   outcome: SetupJobOutcome(reason: .timedOut, exitCode: 17, signal: "SIGTERM"))
        let data = try JSONEncoder().encode(current)
        let job = try JSONDecoder().decode(SetupJob.self, from: data)
        #expect(job.phase == .completed)
        #expect(job.outcome?.reason == .timedOut)
        #expect(job.outcome?.exitCode == 17)
        #expect(job.isTerminal)
        let encoded = try JSONDecoder().decode(SetupJob.self, from: JSONEncoder().encode(job))
        #expect(encoded == job)

        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for mutation in [
            ("phase", "future_phase"),
            ("action", "future_action"),
        ] {
            var invalid = object
            invalid[mutation.0] = mutation.1
            #expect(throws: DecodingError.self) {
                try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: invalid))
            }
        }
        var obsolete = object
        obsolete["logPath"] = "/tmp/no-longer-public.log"
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: obsolete))
        }
    }

    @Test func setupEventRequiresExplicitPredecessorAndPreservesNullOnTheWire() throws {
        let active = makeSetupJob(id: "j", state: "running", phase: .verifying)
        let event = SetupJobEvent(jobId: active.jobId, cursor: "cursor-1", previousCursor: nil,
                                  sequence: 3, time: "2026-07-13T00:00:00Z",
                                  state: active.state, message: active.message, job: active)
        let encoded = try JSONEncoder().encode(event)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object.keys.contains("previousCursor"))
        #expect(object["previousCursor"] is NSNull)
        #expect(try JSONDecoder().decode(SetupJobEvent.self, from: encoded) == event)

        var missing = object
        missing.removeValue(forKey: "previousCursor")
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJobEvent.self, from: JSONSerialization.data(withJSONObject: missing))
        }

        let chained = SetupJobEvent(jobId: active.jobId, cursor: "cursor-2", previousCursor: "cursor-1",
                                    sequence: 9, time: "2026-07-13T00:00:01Z",
                                    state: active.state, message: active.message, job: active)
        #expect(try JSONDecoder().decode(SetupJobEvent.self, from: JSONEncoder().encode(chained)) == chained)

        var selfLinked = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(chained)) as? [String: Any])
        selfLinked["previousCursor"] = "cursor-2"
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJobEvent.self, from: JSONSerialization.data(withJSONObject: selfLinked))
        }
    }

    @Test func loginCreateEncodesExactSubscription() throws {
        let login = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            SetupJobCreateRequest(harness: .claude, action: .login)
        )) as? [String: String])
        #expect(login == ["harness": "claude", "action": "login", "authRequest": "subscription"])
        let legacyHarness = #"{"id":"claude","status":"ok","manifest":null}"#
        #expect(try JSONDecoder().decode(HarnessStatus.self, from: Data(legacyHarness.utf8)).authSources.isEmpty)
        let currentHarness = """
        {"id":"claude","status":"ok","manifest":null,
         "authSources":[{"source":"native_session","availability":"available","verification":"passed","detail":"OAuth smoke passed"}]}
        """
        let status = try JSONDecoder().decode(HarnessStatus.self, from: Data(currentHarness.utf8))
        #expect(status.authSources.first?.isVerifiedNativeSession == true)
    }

    @Test func setupHarnessRejectsNonNativeLoginHarnesses() throws {
        #expect(try JSONDecoder().decode(SetupHarness.self, from: Data(#""claude""#.utf8)) == .claude)
        for raw in ["raw-api", "raw", "opencode"] {
            #expect(throws: DecodingError.self) {
                try JSONDecoder().decode(SetupHarness.self, from: Data("\"\(raw)\"".utf8))
            }
        }
    }

    @Test func setupJobStrictlyDecodesCapabilityAndNativeCommandEvidence() throws {
        let digest = String(repeating: "a", count: 64)
        let manifest = String(repeating: "b", count: 64)
        let json = """
        {
          "jobId":"job-strict","harness":"claude","action":"login","state":"failed",
          "phase":"completed","outcome":{"reason":"launch_failed"},
          "command":"claude auth login","guideUrl":null,"message":"failed",
          "createdAt":"2026-07-14T00:00:00Z","startedAt":"2026-07-14T00:00:01Z",
          "finishedAt":"2026-07-14T00:00:02Z",
          "authCapability":{
            "attemptId":"attempt-1","challengeDigest":"\(digest)","requestDigest":"\(digest)",
            "disclosure":{"schemaVersion":1,"protocolVersion":1,"harness":"claude",
              "requested":"subscription","requiredRoute":"vendor_native","requiredSource":"native_session",
              "networkScope":"selected_harness_only","billingKnowledge":"unknown",
              "incrementalCostKnowledge":"unknown","mayConsumeQuota":true,
              "generatedAt":"2026-07-14T00:00:00Z"},
            "state":"disclosed"
          },
          "authorization":{"executionId":"exec-1",
            "executable":{"realpath":"/usr/bin/true","sha256":"\(digest)","size":1,"mode":493,"device":"1","inode":"2"},
            "args":[],"commandDigest":"\(digest)","manifestDigest":"\(manifest)"},
          "nativeCommand":{"executionId":"exec-1","commandDigest":"\(digest)","manifestDigest":"\(manifest)",
            "permitIssuedAt":null,"commandStarted":false,"exitCode":null,"signal":null,
            "errorCode":"spawn_failed","finishedAt":"2026-07-14T00:00:02Z"}
        }
        """
        let job = try JSONDecoder().decode(SetupJob.self, from: Data(json.utf8))
        #expect(job.authCapability?.state == .disclosed)
        #expect(job.nativeCommand?.errorCode == .spawnFailed)
        #expect(try JSONDecoder().decode(SetupJob.self, from: JSONEncoder().encode(job)) == job)

        var object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        var capability = try #require(object["authCapability"] as? [String: Any])
        capability["futureField"] = true
        object["authCapability"] = capability
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        }

        object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        var native = try #require(object["nativeCommand"] as? [String: Any])
        native.removeValue(forKey: "permitIssuedAt")
        object["nativeCommand"] = native
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        }

        object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        native = try #require(object["nativeCommand"] as? [String: Any])
        native["manifestDigest"] = digest
        object["nativeCommand"] = native
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        }

        object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        var authorization = try #require(object["authorization"] as? [String: Any])
        authorization["futureField"] = true
        object["authorization"] = authorization
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        }

        object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        native = try #require(object["nativeCommand"] as? [String: Any])
        native["finishedAt"] = "not-a-timestamp"
        object["nativeCommand"] = native
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        }
    }

    @Test func authCapabilityReceiptPreservesRequiredNullableFields() throws {
        let digest = String(repeating: "c", count: 64)
        let json = """
        {"receiptId":"receipt-1","attemptId":"attempt-1","harness":"claude",
         "requested":"subscription","requiredRoute":"vendor_native","requiredSource":"native_session",
         "effective":null,"effectiveSource":null,"selectionReason":"route_missing",
         "availability":"unavailable","verification":"failed","billingKnowledge":"unknown",
         "costKnowledge":"unknown","startedAt":"2026-07-14T00:00:00Z",
         "completedAt":"2026-07-14T00:00:01Z","challengeDigest":"\(digest)",
         "requestDigest":"\(digest)","responseDigest":"\(digest)","streamDigest":"\(digest)",
         "scratchBeforeDigest":"\(digest)","scratchAfterDigest":"\(digest)",
         "stream":{"startedEvents":0,"completedEvents":0,"errorEvents":0,
           "unexpectedToolEvents":0,"interactionEvents":0,"sessionMismatchEvents":0,
           "eventsAfterCompleted":0,"aborted":false},"evidenceRefs":[]}
        """
        let receipt = try JSONDecoder().decode(AuthCapabilityReceipt.self, from: Data(json.utf8))
        let encoded = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt)) as? [String: Any]
        )
        #expect(encoded["effective"] is NSNull)
        #expect(encoded["effectiveSource"] is NSNull)
        #expect(encoded["costUsd"] == nil)
    }

    @Test func safelyTerminatedLoginCanRetry() {
        #expect(makeSetupJob(id: "login", state: "timed_out", phase: .completed).canRetry)
    }

    @Test func loginDeadlineCanBeExtendedDuringLaunchAndUserWait() {
        #expect(makeSetupJob(id: "launching", state: "waiting_for_input", phase: .launching).canExtend)
        #expect(makeSetupJob(id: "waiting", state: "waiting_for_input", phase: .awaitingUser).canExtend)
        #expect(!makeSetupJob(id: "verifying", state: "running", phase: .verifying).canExtend)
    }

    @Test func terminationUnconfirmedIsNotSafeForCancelAndClose() {
        let unconfirmed = makeSetupJob(
            id: "uncertain", state: "failed", phase: .completed,
            outcome: SetupJobOutcome(reason: .terminationUnconfirmed)
        )
        let reconciled = makeSetupJob(
            id: "reconciled", state: "failed", phase: .completed,
            outcome: SetupJobOutcome(reason: .terminationUnconfirmed),
            terminationReconciliation: SetupTerminationReconciliation(
                status: .empty, observedAt: "2026-07-13T00:00:03Z"
            )
        )
        let confirmed = makeSetupJob(
            id: "cancelled", state: "cancelled", phase: .completed,
            outcome: SetupJobOutcome(reason: .cancelledByUser)
        )
        #expect(unconfirmed.isTerminal)
        #expect(unconfirmed.blocksReplacement)
        #expect(!unconfirmed.canRetry)
        #expect(!unconfirmed.hasConfirmedTermination)
        #expect(!confirmed.blocksReplacement)
        #expect(!reconciled.blocksReplacement)
        #expect(reconciled.canRetry)
        #expect(confirmed.canRetry)
        #expect(confirmed.hasConfirmedTermination)
    }

    @Test func controllerRecoversUnsafeTerminalAndDoesNotRetryIt() async {
        let unconfirmed = makeSetupJob(
            id: "uncertain", state: "failed", phase: .completed,
            outcome: SetupJobOutcome(reason: .terminationUnconfirmed)
        )
        let gateway = FakeSetupGateway(
            listResult: [unconfirmed], snapshots: [], streams: []
        )
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])

        await controller.recoverActiveJob(harness: "claude")
        let recovered = await controller.snapshot()
        #expect(recovered.job == unconfirmed)
        #expect(recovered.connection == .terminal)
        #expect(gateway.filters == [
            SetupJobListFilter(harness: "claude", active: true, limit: 1),
            SetupJobListFilter(harness: "claude", active: false, limit: 1)
        ])

        await controller.retry()
        #expect(!gateway.calls.contains("create:login"))
        #expect(await controller.snapshot().job == unconfirmed)
    }

    @Test func controllerReconcilesUnsafeTerminalBeforeEnablingRetry() async {
        let unconfirmed = makeSetupJob(
            id: "uncertain", state: "failed", phase: .completed,
            outcome: SetupJobOutcome(reason: .terminationUnconfirmed)
        )
        let reconciled = makeSetupJob(
            id: "uncertain", state: "failed", phase: .completed,
            outcome: SetupJobOutcome(reason: .terminationUnconfirmed),
            terminationReconciliation: SetupTerminationReconciliation(
                status: .empty, observedAt: "2026-07-13T00:00:03Z"
            )
        )
        let gateway = FakeSetupGateway(
            listResult: [unconfirmed], snapshots: [reconciled], streams: []
        )
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])

        await controller.recoverActiveJob(harness: "claude")
        await controller.reconnect(harness: "claude")

        #expect(await controller.snapshot().job == reconciled)
        #expect(await controller.snapshot().job?.canRetry == true)
        #expect(gateway.calls.contains("reconcile:uncertain"))
    }

    @Test func zeroActiveRecoveryIgnoresOrdinaryTerminalHistory() async {
        let completed = makeSetupJob(
            id: "done", state: "succeeded", phase: .completed,
            outcome: SetupJobOutcome(reason: .completed)
        )
        let gateway = FakeSetupGateway(listResult: [completed], snapshots: [], streams: [])
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])

        await controller.recoverActiveJob(harness: "claude")

        let recovered = await controller.snapshot()
        #expect(recovered.job == nil)
        #expect(recovered.connection == .idle)
    }

    @Test func controllerRecoversLoginWithFullSnapshots() async throws {
        let active = makeSetupJob(id: "login", state: "waiting_for_input", phase: .awaitingUser)
        let done = makeSetupJob(id: "login", state: "succeeded", phase: .completed,
                                outcome: SetupJobOutcome(reason: .completed))
        let gateway = FakeSetupGateway(listResult: [active], snapshots: [active], streams: [.events([
            SetupJobEvent(jobId: active.jobId, cursor: "cursor-event-1", previousCursor: "cursor-snapshot-1",
                          sequence: 2, time: "t", state: .succeeded, message: done.message, job: done)
        ])])
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "claude")
        let terminal = await firstSnapshot(in: updates) { $0.connection == .terminal }
        #expect(terminal?.job == done)
        #expect(gateway.lastFilter == SetupJobListFilter(harness: "claude", active: true, limit: 1))
        #expect(gateway.calls.prefix(3) == ["list", "get:login", "stream:login"])
    }

    @Test func controllerAcceptsSparseSequencesOnlyWhenTheCursorChainIsExact() async {
        let active = makeSetupJob(id: "sparse", state: "running", phase: .verifying)
        let progress = makeSetupJob(id: "sparse", state: "running", phase: .verifying)
        let done = makeSetupJob(id: "sparse", state: "succeeded", phase: .completed)
        let gateway = FakeSetupGateway(listResult: [active], snapshots: [active], streams: [.events([
            SetupJobEvent(jobId: active.jobId, cursor: "cursor-15", previousCursor: "cursor-snapshot-1",
                          sequence: 15, time: "t1", state: progress.state, message: progress.message, job: progress),
            SetupJobEvent(jobId: active.jobId, cursor: "cursor-42", previousCursor: "cursor-15",
                          sequence: 42, time: "t2", state: done.state, message: done.message, job: done),
        ])])
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "claude")
        let terminal = await firstSnapshot(in: updates) { $0.connection == .terminal }
        #expect(terminal?.job == done)
        #expect(gateway.getCount == 1)
    }

    @Test(arguments: ["wrong_predecessor", "duplicate_cursor", "regressive_sequence"])
    func controllerResnapshotsOnBrokenCursorChains(_ defect: String) async {
        let active = makeSetupJob(id: "broken", state: "running", phase: .verifying)
        let first = SetupJobEvent(jobId: active.jobId, cursor: "cursor-15", previousCursor: "cursor-snapshot-1",
                                  sequence: 15, time: "t1", state: active.state, message: active.message, job: active)
        let broken: SetupJobEvent = switch defect {
        case "wrong_predecessor":
            SetupJobEvent(jobId: active.jobId, cursor: "cursor-42", previousCursor: "wrong",
                          sequence: 42, time: "t2", state: active.state, message: active.message, job: active)
        case "duplicate_cursor":
            SetupJobEvent(jobId: active.jobId, cursor: "cursor-15", previousCursor: "cursor-15",
                          sequence: 42, time: "t2", state: active.state, message: active.message, job: active)
        default:
            SetupJobEvent(jobId: active.jobId, cursor: "cursor-42", previousCursor: "cursor-15",
                          sequence: 14, time: "t2", state: active.state, message: active.message, job: active)
        }
        let attempts = Array(repeating: FakeStreamResult.events([first, broken]), count: 6)
        let gateway = FakeSetupGateway(
            listResult: [active], snapshots: Array(repeating: active, count: 6), streams: attempts
        )
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "claude")
        let lost = await firstSnapshot(in: updates) { $0.connection == .streamLost }
        #expect(lost?.reconnectAttempt == 5)
        #expect(lost?.lastError?.contains("mismatch") == true)
        #expect(gateway.getCount == 6)
    }

    @Test func interruptedUnknownEventStopsObservationAsTerminal() async {
        let active = makeSetupJob(id: "unknown", state: "running", phase: .verifying)
        let unknown = makeSetupJob(id: "unknown", state: "interrupted_unknown", phase: .completed)
        let gateway = FakeSetupGateway(listResult: [active], snapshots: [active], streams: [.events([
            SetupJobEvent(jobId: active.jobId, cursor: "cursor-unknown", previousCursor: "cursor-snapshot-1",
                          sequence: 2, time: "t", state: unknown.state, message: unknown.message, job: unknown),
        ])])
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "claude")
        let terminal = await firstSnapshot(in: updates) { $0.connection == .terminal }
        #expect(terminal?.job?.state == .interruptedUnknown)
        #expect(gateway.streamCount == 1)
    }

    @Test func controllerBoundsNormalEndReconnectsAtExactlyFive() async {
        let active = makeSetupJob(id: "live", state: "waiting_for_input", phase: .awaitingUser)
        let gateway = FakeSetupGateway(
            listResult: [active],
            snapshots: Array(repeating: active, count: 8),
            streams: Array(repeating: .finish, count: 8)
        )
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "claude")
        let lost = await firstSnapshot(in: updates) { $0.connection == .streamLost }
        #expect(lost?.reconnectAttempt == 5)
        #expect(gateway.getCount == 6)       // initial attach + five reconnects
        #expect(gateway.streamCount == 6)
    }

    @Test func controllerUsesAuthoritativeEventAndDetachDoesNotCancel() async {
        let active = makeSetupJob(id: "authoritative", state: "waiting_for_input", phase: .awaitingUser)
        let done = makeSetupJob(id: "authoritative", state: "failed", phase: .completed,
                                outcome: SetupJobOutcome(reason: .authNotReady))
        let gateway = FakeSetupGateway(listResult: [active], snapshots: [active], streams: [.events([
            SetupJobEvent(jobId: active.jobId, cursor: "cursor-event-1", previousCursor: "cursor-snapshot-1",
                          sequence: 2, time: "t", state: .failed, message: done.message, job: done)
        ])])
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "claude")
        _ = await firstSnapshot(in: updates) { $0.connection == .terminal }
        await controller.detach()
        #expect(gateway.getCount == 1)
        #expect(gateway.cancelCount == 0)
    }

    @Test func joblessTransportErrorsRequireSuccessfulActiveLookupBeforeRestart() async {
        let active = makeSetupJob(id: "accepted-login", state: "running", phase: .verifying)
        let done = makeSetupJob(id: "accepted-login", state: "succeeded", phase: .completed,
                                outcome: SetupJobOutcome(reason: .completed))
        let startGateway = FakeSetupGateway(
            listResult: [active], snapshots: [active], streams: [.events([
                SetupJobEvent(jobId: active.jobId, cursor: "cursor-event-1", previousCursor: "cursor-snapshot-1",
                              sequence: 2, time: "t", state: done.state,
                              message: done.message, job: done)
            ])], createFailures: 1
        )
        let startController = SetupLifecycleController(gateway: startGateway, reconnectDelays: [.zero])
        await startController.start(harness: "claude", action: "login")
        let unknownAfterStart = await startController.snapshot()
        #expect(unknownAfterStart.job == nil)
        #expect(unknownAfterStart.connection == .streamLost)
        #expect(unknownAfterStart.lastError != nil)

        let updates = await startController.updates()
        await startController.reconnect(harness: "claude")
        let recovered = await firstSnapshot(in: updates) { $0.connection == .terminal }
        #expect(recovered?.job == done)
        #expect(startGateway.lastFilter == SetupJobListFilter(harness: "claude", active: true, limit: 1))

        let recoveryGateway = FakeSetupGateway(
            listResult: [], snapshots: [], streams: [], listFailures: 1
        )
        let recoveryController = SetupLifecycleController(gateway: recoveryGateway, reconnectDelays: [.zero])
        await recoveryController.recoverActiveJob(harness: "claude")
        #expect(await recoveryController.snapshot().connection == .streamLost)
        await recoveryController.reconnect(harness: "claude")
        let reconciled = await recoveryController.snapshot()
        #expect(reconciled.connection == .idle)
        #expect(reconciled.job == nil)
    }

    @Test func staleMutationResponseCannotReplaceReconnectSnapshot() async {
        let cancelGate = AsyncTestGate()
        let active = makeSetupJob(id: "active", state: "waiting_for_input", phase: .awaitingUser)
        let cancelled = makeSetupJob(id: "active", state: "cancelled", phase: .completed,
                                     outcome: SetupJobOutcome(reason: .cancelledByUser))
        let gateway = MutationRaceGateway(active: active, cancelled: cancelled, cancelGate: cancelGate)
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        await controller.recoverActiveJob(harness: "claude")

        let cancellation = Task { await controller.cancel() }
        await cancelGate.waitUntilSuspended()
        await controller.reconnect(harness: "claude")
        await cancelGate.resume()
        await cancellation.value

        let current = await controller.snapshot()
        #expect(current.job == active)
        #expect(current.connection == .connected)
        await controller.detach()
    }

    @Test func gatewaySetupSSEFailsVisiblyOnUnknownMalformedMismatchedEOFAndOverflow() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t", session: session)
        defer { RequestStubURLProtocol.handler = nil }

        func install(_ body: String) {
            RequestStubURLProtocol.handler = { request in
                guard request.url?.path == "/v2/setup/jobs/j/events" else {
                    throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
                }
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "text/event-stream; charset=utf-8"]
                )!
                return (response, Data(body.utf8))
            }
        }

        func consume(_ stream: AsyncThrowingStream<SetupJobEvent, Error>) async -> ([SetupJobEvent], Error?) {
            var events: [SetupJobEvent] = []
            do {
                for try await event in stream { events.append(event) }
                return (events, nil)
            } catch {
                return (events, error)
            }
        }

        let active = makeSetupJob(id: "j", state: "running", phase: .verifying)
        let event = SetupJobEvent(jobId: "j", cursor: "cursor-1", previousCursor: "snapshot",
                                  sequence: 2, time: "t", state: active.state, message: active.message, job: active)
        let eventJSON = String(decoding: try JSONEncoder().encode(event), as: UTF8.self)

        install("id: cursor-1\nevent: setup\ndata: \(eventJSON)\n\nevent: end\ndata: {}\n\n")
        let valid = await consume(client.setupJobEvents(jobId: "j", lastEventId: "snapshot"))
        #expect(valid.0 == [event])
        #expect(valid.1 == nil)

        install("event: mystery\ndata: {}\n\nevent: end\ndata: {}\n\n")
        let unknown = await consume(client.setupJobEvents(jobId: "j", lastEventId: "snapshot"))
        #expect(String(describing: unknown.1).contains("unknown setup SSE event"))

        install("id: cursor-1\nevent: setup\ndata: {\n\nevent: end\ndata: {}\n\n")
        let malformed = await consume(client.setupJobEvents(jobId: "j", lastEventId: "snapshot"))
        #expect(malformed.1 != nil)

        install("id: wrong-id\nevent: setup\ndata: \(eventJSON)\n\nevent: end\ndata: {}\n\n")
        let mismatched = await consume(client.setupJobEvents(jobId: "j", lastEventId: "snapshot"))
        #expect(String(describing: mismatched.1).contains("does not match"))

        install("id: cursor-1\nevent: setup\ndata: \(eventJSON)\n\n")
        let eof = await consume(client.setupJobEvents(jobId: "j", lastEventId: "snapshot"))
        #expect(eof.0 == [event])
        #expect(String(describing: eof.1).contains("without a terminal end event"))

        var frames = ""
        var predecessor = "snapshot"
        for index in 1...96 {
            let cursor = "cursor-overflow-\(index)"
            let item = SetupJobEvent(jobId: "j", cursor: cursor, previousCursor: predecessor,
                                     sequence: index + 2, time: "t", state: active.state,
                                     message: active.message, job: active)
            let json = String(decoding: try JSONEncoder().encode(item), as: UTF8.self)
            frames += "id: \(cursor)\nevent: setup\ndata: \(json)\n\n"
            predecessor = cursor
        }
        frames += "event: end\ndata: {}\n\n"
        install(frames)
        let overflowing = client.setupJobEvents(jobId: "j", lastEventId: "snapshot")
        try await Task.sleep(for: .milliseconds(100))
        let overflow = await consume(overflowing)
        #expect(overflow.0.count <= 64)
        #expect(String(describing: overflow.1).contains("buffer overflow"))
    }

    @Test func gatewayEncodesFreshHarnessAndSetupRecoveryQueries() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t", session: session)

        RequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/harnesses", request.url?.query == "fresh=true" else {
                throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
            }
            return (Self.response(for: request), Data(#"{"harnesses":[]}"#.utf8))
        }
        _ = try await client.listHarnesses(fresh: true)

        RequestStubURLProtocol.handler = { request in
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
            guard request.url?.path == "/v2/setup/jobs",
                  values == ["harness":"claude", "active":"true", "limit":"1"] else {
                throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
            }
            return (Self.response(for: request), Data(#"{"jobs":[]}"#.utf8))
        }
        _ = try await client.listSetupJobs(filter: SetupJobListFilter(harness: "claude", active: true, limit: 1))
        RequestStubURLProtocol.handler = nil
    }

    @Test func gatewayHealthNegotiatesV2BeforeReportingReady() async throws {
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config)
        )
        RequestStubURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/healthz"):
                return (Self.response(for: request), Data(#"{"ok":true}"#.utf8))
            case ("POST", "/v2/handshake"):
                guard request.value(forHTTPHeaderField: "X-Claudexor-Protocol-Major") == "2",
                      let body = testRequestBody(request),
                      String(decoding: body, as: UTF8.self).contains(#""protocolMajor":2"#) else {
                    throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
                }
                return (
                    Self.response(for: request),
                    Data(#"{"protocolMajor":2,"compatible":true,"operationsPath":"/v2/operations"}"#.utf8)
                )
            default:
                throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
            }
        }
        #expect(try await client.health())
    }

    @Test func gatewayRefreshesOneExactAuthSourceAndDecodesControlProblems() async throws {
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config)
        )
        RequestStubURLProtocol.handler = { request in
            let body = try #require(testRequestBody(request))
            let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
            guard request.httpMethod == "POST",
                  request.url?.path == "/v2/harnesses/raw-api/auth-readiness",
                  request.url?.query == nil,
                  object == ["authRequest":"api_key", "source":"api_key_env"] else {
                throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
            }
            return (Self.response(for: request), Data("""
            {"harnessId":"raw-api","authRequest":"api_key","requestedSource":"api_key_env",
             "observedAt":"2026-07-14T00:00:00Z",
             "readiness":{"source":"api_key_env","availability":"available","verification":"passed"}}
            """.utf8))
        }
        let result = try await client.refreshAuthReadiness(
            harnessId: "raw-api",
            request: AuthReadinessRefreshRequest(authRequest: .apiKey, source: .apiKeyEnvironment)
        )
        #expect(result.harnessId == "raw-api")
        #expect(result.readiness.verification == .passed)

        RequestStubURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 503, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type":"application/problem+json"]
            )!
            return (response, Data("""
            {"code":"auth_readiness_probe_failed","message":"probe unavailable","retryable":true,
             "fieldErrors":{},"requiredActions":["retry_auth_readiness_refresh"],"evidenceRefs":[]}
            """.utf8))
        }
        do {
            _ = try await client.refreshAuthReadiness(
                harnessId: "raw-api",
                request: AuthReadinessRefreshRequest(authRequest: .apiKey, source: .apiKeyEnvironment)
            )
            Issue.record("Expected typed auth-readiness failure")
        } catch let error as GatewayError {
            #expect(error.controlProblem?.code == "auth_readiness_probe_failed")
            #expect(error.controlProblem?.requiredActions == ["retry_auth_readiness_refresh"])
        }
    }

    @Test func authReadinessRejectsMismatchedAndUnknownResponseFields() throws {
        let mismatch = """
        {"harnessId":"claude","authRequest":"subscription","requestedSource":"native_session",
         "observedAt":"2026-07-14T00:00:00Z",
         "readiness":{"source":"api_key_env","availability":"available","verification":"passed"}}
        """
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(AuthReadinessRefreshResponse.self, from: Data(mismatch.utf8))
        }
        let unknown = mismatch.replacingOccurrences(
            of: #""verification":"passed""#,
            with: #""verification":"passed","future":true"#
        )
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(AuthReadinessRefreshResponse.self, from: Data(unknown.utf8))
        }

        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(ControlProblem.self, from: Data("""
            {"code":"bad","message":"","retryable":false,
             "fieldErrors":{},"requiredActions":null,"evidenceRefs":[]}
            """.utf8))
        }
    }

    private static func response(for request: URLRequest) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"application/json"])!
    }
}

private func testRequestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { return nil }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

private func makeSetupCapability(state: SetupJobState) -> AuthCapabilityLifecycle {
    let digest = String(repeating: "a", count: 64)
    let disclosure = AuthSmokeDisclosure(harness: "claude", generatedAt: "2026-07-13T00:00:00Z")
    if state == .succeeded {
        let receipt = try! JSONDecoder().decode(AuthCapabilityReceipt.self, from: Data("""
        {"receiptId":"receipt-test","attemptId":"attempt-test","harness":"claude",
         "requested":"subscription","requiredRoute":"vendor_native","requiredSource":"native_session",
         "effective":"vendor_native","effectiveSource":"native_session","selectionReason":"exact_requested_route",
         "availability":"available","verification":"passed","billingKnowledge":"unknown","costKnowledge":"unknown",
         "startedAt":"2026-07-13T00:00:01Z","completedAt":"2026-07-13T00:00:02Z",
         "challengeDigest":"\(digest)","requestDigest":"\(digest)","responseDigest":"\(digest)",
         "streamDigest":"\(digest)","scratchBeforeDigest":"\(digest)","scratchAfterDigest":"\(digest)",
         "stream":{"startedEvents":1,"completedEvents":1,"errorEvents":0,"unexpectedToolEvents":0,
          "interactionEvents":0,"sessionMismatchEvents":0,"eventsAfterCompleted":0,"aborted":false},"evidenceRefs":[]}
        """.utf8))
        return AuthCapabilityLifecycle(
            attemptId: "attempt-test", challengeDigest: digest, requestDigest: digest,
            disclosure: disclosure, state: .completed, startedAt: receipt.startedAt,
            completedAt: receipt.completedAt, receipt: receipt
        )
    }
    if state == .interruptedUnknown {
        return AuthCapabilityLifecycle(
            attemptId: "attempt-test", challengeDigest: digest, requestDigest: digest,
            disclosure: disclosure, state: .interruptedUnknown,
            startedAt: "2026-07-13T00:00:01Z", interruptedAt: "2026-07-13T00:00:02Z"
        )
    }
    return AuthCapabilityLifecycle(
        attemptId: "attempt-test", challengeDigest: digest, requestDigest: digest,
        disclosure: disclosure, state: .disclosed
    )
}

private func makeSetupJob(id: String, state: String,
                          phase: SetupJobPhase, outcome: SetupJobOutcome? = nil,
                          terminationReconciliation: SetupTerminationReconciliation? = nil) -> SetupJob {
    let typedState = SetupJobState(rawValue: state)!
    let terminal = typedState == .succeeded || typedState == .failed || typedState == .cancelled
        || typedState == .timedOut || typedState == .interruptedUnknown || typedState == .notSupported
    let defaultOutcome: SetupJobOutcome? = switch typedState {
    case .succeeded: SetupJobOutcome(reason: .completed)
    case .failed: SetupJobOutcome(reason: .commandFailed)
    case .cancelled: SetupJobOutcome(reason: .cancelledByUser)
    case .timedOut: SetupJobOutcome(reason: .timedOut)
    case .interruptedUnknown: SetupJobOutcome(reason: .interruptedUnknown)
    case .notSupported: SetupJobOutcome(reason: .notSupported)
    case .queued, .running, .waitingForInput: nil
    }
    return SetupJob(jobId: id, harness: .claude, action: .login, state: typedState, phase: phase,
             deadlineAt: state == "waiting_for_input" ? "2099-01-01T00:00:00Z" : nil,
             outcome: outcome ?? defaultOutcome, message: state, createdAt: "2026-07-13T00:00:00Z",
             startedAt: typedState == .queued ? nil : "2026-07-13T00:00:01Z",
             finishedAt: terminal ? "2026-07-13T00:00:02Z" : nil,
             authCapability: makeSetupCapability(state: typedState),
             terminationReconciliation: terminationReconciliation)
}

private func firstSnapshot(
    in stream: AsyncStream<SetupLifecycleSnapshot>,
    where predicate: @escaping @Sendable (SetupLifecycleSnapshot) -> Bool
) async -> SetupLifecycleSnapshot? {
    for await snapshot in stream where predicate(snapshot) { return snapshot }
    return nil
}

private enum FakeStreamResult: Sendable {
    case events([SetupJobEvent])
    case finish
    case failure
}

private struct FakeSetupError: Error, Sendable {}

private final class FakeSetupGateway: SetupJobGateway, @unchecked Sendable {
    private let lock = NSLock()
    private var listResultStorage: [SetupJob]
    private var snapshots: [SetupJob]
    private var streams: [FakeStreamResult]
    private var callsStorage: [String] = []
    private var filterStorage: SetupJobListFilter?
    private var filtersStorage: [SetupJobListFilter] = []
    private var cancelCountStorage = 0
    private var createFailuresRemaining: Int
    private var listFailuresRemaining: Int

    init(listResult: [SetupJob], snapshots: [SetupJob], streams: [FakeStreamResult],
         createFailures: Int = 0, listFailures: Int = 0) {
        self.listResultStorage = listResult
        self.snapshots = snapshots
        self.streams = streams
        self.createFailuresRemaining = createFailures
        self.listFailuresRemaining = listFailures
    }

    var calls: [String] { lock.withLock { callsStorage } }
    var lastFilter: SetupJobListFilter? { lock.withLock { filterStorage } }
    var filters: [SetupJobListFilter] { lock.withLock { filtersStorage } }
    var getCount: Int { calls.filter { $0.hasPrefix("get:") }.count }
    var streamCount: Int { calls.filter { $0.hasPrefix("stream:") }.count }
    var cancelCount: Int { lock.withLock { cancelCountStorage } }

    func createSetupJob(_ body: SetupJobCreateRequest) async throws -> SetupJob {
        try lock.withLock {
            callsStorage.append("create:\(body.action.rawValue)")
            if createFailuresRemaining > 0 {
                createFailuresRemaining -= 1
                throw FakeSetupError()
            }
        }
        return makeSetupJob(id: "created", state: "running", phase: .verifying)
    }

    func listSetupJobs(filter: SetupJobListFilter) async throws -> [SetupJob] {
        try lock.withLock {
            filterStorage = filter
            filtersStorage.append(filter)
            callsStorage.append("list")
            if listFailuresRemaining > 0 {
                listFailuresRemaining -= 1
                throw FakeSetupError()
            }
            return listResultStorage.filter { job in
                (filter.harness == nil || filter.harness == job.harness.rawValue)
                    && (filter.active == nil || filter.active == job.isActive)
            }
        }
    }

    private func nextSetupJob(jobId: String) throws -> SetupJob {
        try lock.withLock {
            callsStorage.append("get:\(jobId)")
            guard let first = snapshots.first else { throw FakeSetupError() }
            if snapshots.count > 1 { snapshots.removeFirst() }
            return first
        }
    }

    func setupJobSnapshot(jobId: String) async throws -> SetupJobSnapshot {
        let job = try nextSetupJob(jobId: jobId)
        return SetupJobSnapshot(job: job, cursor: "cursor-snapshot-\(getCount)", sequence: 1)
    }

    func cancelSetupJob(jobId: String) async throws -> SetupJob {
        lock.withLock { cancelCountStorage += 1 }
        return try nextSetupJob(jobId: jobId)
    }

    func reconcileSetupJob(jobId: String) async throws -> SetupJob {
        lock.withLock { callsStorage.append("reconcile:\(jobId)") }
        return try nextSetupJob(jobId: jobId)
    }

    func extendSetupJob(jobId: String) async throws -> SetupJob { try nextSetupJob(jobId: jobId) }

    func setupJobEvents(jobId: String, lastEventId: String) -> AsyncThrowingStream<SetupJobEvent, Error> {
        let result: FakeStreamResult = lock.withLock {
            callsStorage.append("stream:\(jobId)")
            if streams.isEmpty { return .finish }
            return streams.removeFirst()
        }
        return AsyncThrowingStream { continuation in
            switch result {
            case .events(let events):
                for event in events { continuation.yield(event) }
                continuation.finish()
            case .finish:
                continuation.finish()
            case .failure:
                continuation.finish(throwing: FakeSetupError())
            }
        }
    }
}

private actor AsyncTestGate {
    private var suspended = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        suspended = true
        await withCheckedContinuation { continuation = $0 }
    }

    func waitUntilSuspended() async {
        while !suspended { await Task.yield() }
    }

    func resume() {
        suspended = false
        let pending = continuation
        continuation = nil
        pending?.resume()
    }
}

private struct MutationRaceGateway: SetupJobGateway {
    let active: SetupJob
    let cancelled: SetupJob
    let cancelGate: AsyncTestGate

    func createSetupJob(_ body: SetupJobCreateRequest) async throws -> SetupJob { active }
    func listSetupJobs(filter: SetupJobListFilter) async throws -> [SetupJob] { [active] }
    func setupJobSnapshot(jobId: String) async throws -> SetupJobSnapshot { SetupJobSnapshot(job: active, cursor: "cursor", sequence: 1) }
    func extendSetupJob(jobId: String) async throws -> SetupJob { active }
    func reconcileSetupJob(jobId: String) async throws -> SetupJob { active }

    func cancelSetupJob(jobId: String) async throws -> SetupJob {
        await cancelGate.wait()
        return cancelled
    }

    func setupJobEvents(jobId: String, lastEventId: String) -> AsyncThrowingStream<SetupJobEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                try? await Task.sleep(for: .seconds(60))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private enum TestTransportError: Error { case badRequest(String) }

private final class RequestStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw TestTransportError.badRequest("missing handler") }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
