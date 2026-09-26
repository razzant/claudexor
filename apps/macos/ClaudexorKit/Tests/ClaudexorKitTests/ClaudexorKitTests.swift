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

    @Test func runSummaryDecodesBrowserLaneAsymmetry() throws {
        let json = #"{"runId":"run-browser","state":"succeeded","requestRequirements":[{"capability":"browser","harness_id":"codex","eligible":true,"requested":true,"effective":true,"reason":"effective","evidence_refs":["manifest.capabilities.browser_tool"]},{"capability":"browser","harness_id":"cursor","eligible":false,"requested":true,"effective":false,"reason":"manifest_unsupported","evidence_refs":["manifest.capabilities.browser_tool"]}]}"#
        let summary = try JSONDecoder().decode(RunSummary.self, from: Data(json.utf8))
        #expect(summary.requestRequirements?.count == 2)
        #expect(summary.requestRequirements?.first?.harnessId == "codex")
        #expect(summary.requestRequirements?.last?.effective == false)
        #expect(summary.requestRequirements?.last?.reason == "manifest_unsupported")
    }

    @Test func runAgainDraftPreservesEveryUnknownAndNestedRunField() throws {
        let json = #"{"sourceRunId":"run-1","request":{"prompt":"retry","mode":"agent","attachments":[{"kind":"file","mime":"text/plain","name":"a.txt","data":null,"path":"/tmp/a.txt"}],"effort":"xhigh","synthesis":"always","browser":true,"externalContextPolicy":"live","specId":"spec-1","autonomy":"auto_safe","maxToolCalls":12,"futureControl":{"enabled":true}},"accessChoice":{"required":false},"differences":[]}"#
        let draft = try JSONDecoder().decode(RunAgainDraft.self, from: Data(json.utf8))
        #expect(draft.request["attachments"] != nil)
        #expect(draft.request["effort"]?.stringValue == "xhigh")
        #expect(draft.request["browser"]?.boolValue == true)
        #expect(draft.request["maxToolCalls"]?.doubleValue == 12)
        #expect(draft.request["futureControl"]?["enabled"]?.boolValue == true)
        #expect(draft.accessChoice.required == false)
        let encoded = try JSONEncoder().encode(draft)
        let roundTrip = try JSONDecoder().decode(RunAgainDraft.self, from: encoded)
        #expect(roundTrip.request == draft.request)
    }

    @Test func deliveryResponseKeepsVerifierAndTargetReceipt() throws {
        let json = #"{"mode":"apply","applied":true,"treeMutated":true,"finalVerify":{"attempted":true,"base_sha":"base","applied_cleanly":true,"gates_passed":true,"gates":[{"id":"test","status":"passed"}],"duration_ms":12,"reason":null},"targetPreimageSha":"target"}"#
        let receipt = try JSONDecoder().decode(ApplyResultInfo.self, from: Data(json.utf8))
        #expect(receipt.applied)
        #expect(receipt.finalVerify.gatesPassed == true)
        #expect(receipt.targetPreimageSha == "target")
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
            tests: [TestCommandInvocation(program: "pnpm", args: ["test"])],
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
            #expect(tests[0]["program"]?.stringValue == "pnpm")
            if case .array(let args)? = tests[0]["args"] {
                #expect(args[0].stringValue == "test")
            } else { Issue.record("expected test args") }
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
        let middleEntries = middleEmpty.compactMap { ComposerOptionParser.parseReviewerPanelEntry($0) }
        #expect(middleEntries.count == 2)
        #expect(middleEntries.count != middleEmpty.count)

        let trailingEmpty = ComposerOptionParser.splitOptionTokens("claude,")
        #expect(trailingEmpty == ["claude", ""])
        let trailingEntries = trailingEmpty.compactMap { ComposerOptionParser.parseReviewerPanelEntry($0) }
        #expect(trailingEntries.count == 1)
        #expect(trailingEntries.count != trailingEmpty.count)
    }

    @Test func composerOptionParserPreservesModelColonsAndEffortSuffixes() throws {
        let entry = try #require(
            ComposerOptionParser.parseReviewerPanelEntry(
                "cursor=openai/gpt-5.5:extra-high:deep", effortLevels: ["deep"]
            )
        )
        #expect(entry.harness == "cursor")
        #expect(entry.model == "openai/gpt-5.5:extra-high")
        #expect(entry.effort == "deep")

        let harnessEffort = try #require(ComposerOptionParser.parseReviewerPanelEntry(
            "claude:deep", effortLevels: ["deep"]
        ))
        #expect(harnessEffort.harness == "claude")
        #expect(harnessEffort.model == nil)
        #expect(harnessEffort.effort == "deep")
    }

    // MARK: - Structured-editor → wire-token mapping (UI cut 3, §3)

    @Test func reviewerPickerStateBuildsWireToken() throws {
        // Full grammar: harness=model:effort.
        #expect(ComposerOptionParser.reviewerWireToken(
            harness: "claude", model: "opus", effort: "max") == "claude=opus:max")
        // Model only.
        #expect(ComposerOptionParser.reviewerWireToken(
            harness: "cursor", model: "openai/gpt-5.5", effort: nil) == "cursor=openai/gpt-5.5")
        // Effort only (no model).
        #expect(ComposerOptionParser.reviewerWireToken(
            harness: "claude", model: nil, effort: "high") == "claude:high")
        // Bare harness.
        #expect(ComposerOptionParser.reviewerWireToken(
            harness: "codex", model: "", effort: "") == "codex")
        // Empty harness ⇒ incomplete row contributes nothing.
        #expect(ComposerOptionParser.reviewerWireToken(
            harness: "  ", model: "opus", effort: "max") == nil)
    }

    @Test func reviewerWireTokenRoundTripsThroughParse() throws {
        // Picker → token → parse must reproduce the structured entry, so the raw
        // power field prefilled from the picker parses identically.
        let token = try #require(ComposerOptionParser.reviewerWireToken(
            harness: "claude", model: "opus", effort: "max"))
        let entry = try #require(ComposerOptionParser.parseReviewerPanelEntry(
            token, effortLevels: ["max"]))
        #expect(entry.harness == "claude")
        #expect(entry.model == "opus")
        #expect(entry.effort == "max")
        #expect(ComposerOptionParser.reviewerWireToken(entry) == "claude=opus:max")

        #expect(ComposerOptionParser.joinReviewerTokens([
            ReviewerPanelEntry(harness: "claude", model: "opus", effort: "max"),
            ReviewerPanelEntry(harness: "codex"),
        ]) == "claude=opus:max, codex")
    }

    @Test func structuredReviewerPanelJSONRoundTripsCredentialPins() throws {
        let entries = [
            ReviewerPanelEntry(
                harness: "cursor", model: "grok-4.6", credentialProfileId: "review-cursor"),
            ReviewerPanelEntry(harness: "claude", effort: "high"),
        ]
        let raw = try #require(ComposerOptionParser.reviewerPanelJSON(entries))
        #expect(raw.contains("credentialProfileId"))
        #expect(ComposerOptionParser.parseReviewerPanelJSON(raw) == entries)
        #expect(ComposerOptionParser.parseReviewerPanelJSON("[{bad json") == nil)
        #expect(ComposerOptionParser.parseReviewerPanelJSON(
            "[{\"harness\":\"cursor\",\"credential_profile_id\":\"review-cursor\"}]"
        ) == nil)
        #expect(ComposerOptionParser.parseReviewerPanelJSON(
            "[{\"harness\":\"cursor\",\"unexpected\":true}]"
        ) == nil)
    }

    @Test func approvalListEditorBuildsEntries() throws {
        #expect(ComposerOptionParser.protectedApprovalWireToken(
            path: "test/**", reason: "test update") == "test/**:test update")
        #expect(ComposerOptionParser.protectedApprovalWireToken(
            path: "docs/**", reason: nil) == "docs/**")
        #expect(ComposerOptionParser.protectedApprovalWireToken(
            path: "  ", reason: "x") == nil)

        let token = try #require(ComposerOptionParser.protectedApprovalWireToken(
            path: "test/**", reason: "test update"))
        let approval = try #require(ComposerOptionParser.parseProtectedPathApproval(token))
        #expect(approval.path == "test/**")
        #expect(approval.reason == "test update")

        #expect(ComposerOptionParser.joinApprovalTokens([
            ProtectedPathApproval(path: "test/**", reason: "test update"),
            ProtectedPathApproval(path: "docs/**"),
        ]) == "test/**:test update, docs/**")
    }

    // QA-010: the composer's optional Create test-command field — whitespace-
    // split argv with quoting, parsed into ONE TestCommandInvocation.
    @Test func testCommandArgvHandlesQuotingAndEscapes() throws {
        #expect(ComposerOptionParser.parseCommandArgv("npm test") == ["npm", "test"])
        #expect(ComposerOptionParser.parseCommandArgv("  npm   run   ci  ") == ["npm", "run", "ci"])
        // Double + single quotes group spaces into one argument.
        #expect(ComposerOptionParser.parseCommandArgv(#"pytest -k "slow and net""#) == ["pytest", "-k", "slow and net"])
        #expect(ComposerOptionParser.parseCommandArgv("run 'a b'") == ["run", "a b"])
        // Backslash escapes a literal space / quote.
        #expect(ComposerOptionParser.parseCommandArgv(#"a\ b c"#) == ["a b", "c"])
        // An unbalanced quote is closed at end-of-input (best-effort, no crash).
        #expect(ComposerOptionParser.parseCommandArgv(#"go "test"#) == ["go", "test"])
    }

    @Test func strictArgvRejectsAnUnterminatedQuoteAsATypedError() throws {
        // Balanced input parses identically to the lenient tokenizer.
        #expect(try ComposerOptionParser.parseCommandArgvStrict(#"pytest -k "slow and net""#)
            == ["pytest", "-k", "slow and net"])
        // An unterminated quote is a TYPED error, not a silently-closed `go test`.
        #expect(throws: ComposerOptionParser.CommandArgvError.unterminatedQuote("\"")) {
            _ = try ComposerOptionParser.parseCommandArgvStrict(#"go "test"#)
        }
        #expect(throws: ComposerOptionParser.CommandArgvError.unterminatedQuote("'")) {
            _ = try ComposerOptionParser.parseTestCommandStrict("run 'a b")
        }
        // A blank field is still no gate (nil), never an error; a valid command parses.
        #expect(try ComposerOptionParser.parseTestCommandStrict("   ") == nil)
        #expect(try ComposerOptionParser.parseTestCommandStrict("npm test")?.program == "npm")
    }

    @Test func strictArgvRejectsATrailingDanglingBackslash() throws {
        // Round-3 #4: the lenient tokenizer silently DROPS a terminal backslash, so
        // `run foo\` becomes `["run", "foo"]` with the escape lost — the strict
        // parser must reject it as a typed error, not send a mangled argv.
        #expect(ComposerOptionParser.parseCommandArgv(#"run foo\"#) == ["run", "foo"])
        #expect(throws: ComposerOptionParser.CommandArgvError.danglingEscape) {
            _ = try ComposerOptionParser.parseCommandArgvStrict(#"run foo\"#)
        }
        #expect(throws: ComposerOptionParser.CommandArgvError.danglingEscape) {
            _ = try ComposerOptionParser.parseTestCommandStrict(#"npm test\"#)
        }
        // A backslash INSIDE the input that escapes a real character is NOT dangling.
        #expect(try ComposerOptionParser.parseCommandArgvStrict(#"a\ b c"#) == ["a b", "c"])
        // A backslash inside single quotes is a literal, never an escape → not dangling.
        #expect(try ComposerOptionParser.parseCommandArgvStrict(#"run 'a\'"#) == ["run", #"a\"#])
    }

    @Test func testCommandParsesProgramAndArgs() throws {
        let cmd = try #require(ComposerOptionParser.parseTestCommand("npm run test:ci"))
        #expect(cmd.program == "npm")
        #expect(cmd.args == ["run", "test:ci"])
        // Blank / whitespace-only field is NO gate (nil), never an empty program.
        #expect(ComposerOptionParser.parseTestCommand("") == nil)
        #expect(ComposerOptionParser.parseTestCommand("   \n\t ") == nil)
    }

    @Test func settingsUpdateEncodesRoutingAndTaggedBudget() throws {
        let req = SettingsUpdateRequest(
            routingGoal: "economy",
            paidFallback: "allowed_within_cap",
            paidBudgetPerRun: .finite(maxUsd: 0)
        )
        let data = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(obj?["routingGoal"] as? String == "economy")
        #expect(obj?["paidFallback"] as? String == "allowed_within_cap")
        let budget = try #require(obj?["paidBudgetPerRun"] as? [String: Any])
        #expect(budget["kind"] as? String == "finite")
        #expect(budget["maxUsd"] as? Double == 0)
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
        let disabled = SettingsUpdateRequest(interactionTimeoutMs: .some(nil))
        let disabledRaw = String(data: try JSONEncoder().encode(disabled), encoding: .utf8) ?? ""
        #expect(disabledRaw.contains("\"interactionTimeoutMs\":null"))
    }

    @Test func settingsSnapshotDistinguishesAbsentDisabledAndFiniteTimeout() throws {
        func decode(_ member: String) throws -> SettingsSnapshot {
            try JSONDecoder().decode(SettingsSnapshot.self, from: Data("""
            {"sources":[],"routing":{"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{}\(member)}
            """.utf8))
        }
        let absent = try decode("")
        let disabled = try decode(",\"interactionTimeoutMs\":null")
        #expect(absent.interactionTimeout == .absent)
        #expect(disabled.interactionTimeout == .disabled)
        #expect(try decode(",\"interactionTimeoutMs\":60000").interactionTimeout == .finite(60_000))
        let absentWire = String(data: try JSONEncoder().encode(absent), encoding: .utf8) ?? ""
        let disabledWire = String(data: try JSONEncoder().encode(disabled), encoding: .utf8) ?? ""
        #expect(!absentWire.contains("interactionTimeoutMs"))
        #expect(disabledWire.contains("\"interactionTimeoutMs\":null"))
    }

    @Test func settingsSnapshotDecodesRuntime() throws {
        let data = Data("""
        {
          "sources": [],
          "interactionTimeoutMs": 900000,
          "routing": {
            "goal": "auto",
            "paidFallback": "when_unavailable",
            "qualityTiers": {},
            "primaryHarness": null,
            "eligibleHarnesses": [],
            "defaultModel": null,
            "envInheritance": "mirror_native",
            "authPreference": "auto"
          },
          "budget": { "paidBudgetPerRun": { "kind": "unlimited" } },
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
          "enabledIntents": ["implement"],
          "routableIntents": [],
          "disabledIntents": ["review"],
          "checks": [{"id":"isolated_api_smoke","status":"fail","detail":"401"}],
          "reasons": ["isolated smoke failed"]
        }
        """
        let status = try JSONDecoder().decode(HarnessStatus.self, from: Data(rich.utf8))
        #expect(status.id == "codex")
        #expect(status.enabledIntents == ["implement"])
        // Enabled but NOT routable: the server's doctor-gated verdict decodes
        // as-is — the degraded harness honestly routes nothing (R8/W14).
        #expect(status.routableIntents.isEmpty)
        #expect(status.disabledIntents == ["review"])
        #expect(status.checks == [HarnessCheck(id: "isolated_api_smoke", status: "fail", detail: "401")])

        let legacy = #"{"id":"claude","status":"ok","manifest":null}"#
        let legacyStatus = try JSONDecoder().decode(HarnessStatus.self, from: Data(legacy.utf8))
        #expect(legacyStatus.enabledIntents.isEmpty)
        // Legacy daemon without the field = routes nothing (fail-closed).
        #expect(legacyStatus.routableIntents.isEmpty)
        #expect(legacyStatus.disabledIntents.isEmpty)
        #expect(legacyStatus.checks.isEmpty)
        #expect(legacyStatus.setupLogin == .legacyAbsent)

        let unavailable = try JSONDecoder().decode(
            HarnessStatus.self,
            from: Data(#"{"id":"agy","status":"unavailable","setupLogin":null}"#.utf8))
        #expect(unavailable.setupLogin == .unavailable)
        let inApp = try JSONDecoder().decode(
            HarnessStatus.self,
            from: Data(#"{"id":"claude","status":"ok","setupLogin":{"mode":"in_app"}}"#.utf8))
        #expect(inApp.setupLogin == .inApp)
        let terminal = try JSONDecoder().decode(
            HarnessStatus.self,
            from: Data(#"{"id":"cursor","status":"ok","setupLogin":{"mode":"external_terminal"}}"#.utf8))
        #expect(terminal.setupLogin == .externalTerminal)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(
                HarnessStatus.self,
                from: Data(#"{"id":"x","status":"ok","setupLogin":{"mode":"automatic"}}"#.utf8))
        }
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(
                HarnessStatus.self,
                from: Data(#"{"id":"x","status":"ok","setupLogin":{"mode":"in_app","junk":true}}"#.utf8))
        }
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
          "summary": {"runId":"run-1","state":"succeeded","spendUsd":0.12,"spendEstimated":true,"tests":[{"program":"pnpm","args":["test"],"envAllowlist":[]}]},
          "primaryOutput": {"kind":"answer","path":"final/answer.md","text":"4","bytes":1},
          "timeline": [{"type":"harness.event","title":"Codex answered","detail":"done","rawRef":"events.jsonl"}],
          "budget": {"paidBudget":{"kind":"finite","maxUsd":0.50},"spendUsd":0.12,"remainingUsd":0.38,"estimated":true,"source":"events"},
          "reviewFindings": []
        }
        """
        let detail = try JSONDecoder().decode(RunDetail.self, from: Data(rich.utf8))
        #expect(detail.summary.runId == "run-1")
        #expect(detail.summary.spendUsd == 0.12)
        #expect(detail.summary.tests == [TestCommandInvocation(program: "pnpm", args: ["test"])])
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
         "enqueueError":{"message":"access profile 'full' requires allow_full_access: true","code":"trust_full_access_required","requiredActions":["Grant access"],"context":{"turnId":"tn-3"},"failedAt":"t1"},
         "createdAt":"t"}
        """#
        let turn = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(json.utf8))
        #expect(turn.enqueueError?.message.contains("allow_full_access") == true)
        // The one-click remedy keys on the typed CODE, never the message text.
        #expect(turn.enqueueError?.code == TurnEnqueueErrorInfo.trustFullAccessCode)
        #expect(turn.enqueueError?.failedAt == "t1")
        #expect(turn.enqueueError?.requiredActions == ["Grant access"])
        #expect(turn.enqueueError?.context["turnId"]?.stringValue == "tn-3")
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
        #expect(refusedNoJob.enqueueError?.requiredActions.isEmpty == true)
        #expect(refusedNoJob.enqueueError?.context.isEmpty == true)
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

    /// D26: the sticky write scope rides thread creation and PATCH. Create omits
    /// `access` when nil (engine applies the trust default); PATCH distinguishes
    /// .some(value) (set), .some(nil) (clear to trust default = explicit JSON
    /// null), and .none (leave unchanged) — the same double-optional contract as
    /// primaryHarness/credentialProfileId.
    @Test func threadAccessStickyEncodesForCreateAndPatch() throws {
        let create = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(CreateThreadRequest(scope: .project(root: "/p"), access: "full"))
        ) as? [String: Any]
        #expect(create?["access"] as? String == "full")
        let createDefault = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(CreateThreadRequest(scope: .project(root: "/p")))
        ) as? [String: Any]
        #expect(createDefault?.keys.contains("access") == false)

        let setObj = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(UpdateThreadRequest(access: .some("readonly")))
        ) as? [String: Any]
        #expect(setObj?["access"] as? String == "readonly")

        let clearData = try JSONEncoder().encode(UpdateThreadRequest(access: .some(nil)))
        let clearObj = try JSONSerialization.jsonObject(with: clearData) as? [String: Any]
        #expect(clearObj?.keys.contains("access") == true)
        #expect(clearObj?["access"] is NSNull)

        let untouchedObj = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(UpdateThreadRequest(title: "x"))
        ) as? [String: Any]
        #expect(untouchedObj?.keys.contains("access") == false)
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
        let json = #"{"applied":true,"status":"applied","headMoved":false,"detail":null,"delivery":{"mode":"apply","applied":true,"finalVerify":{"attempted":true,"base_sha":"target-preimage-1","applied_cleanly":true,"gates_passed":true,"gates":[{"id":"thread-gate","status":"pass"}],"duration_ms":7,"reason":null},"targetPreimageSha":"target-preimage-1"}}"#
        let r = try JSONDecoder().decode(ThreadApplyResponse.self, from: Data(json.utf8))
        #expect(r.applied)
        #expect(r.status == "applied")
        #expect(r.delivery?["targetPreimageSha"]?.stringValue == "target-preimage-1")
        #expect(r.delivery?["finalVerify"]?["applied_cleanly"]?.boolValue == true)
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
                                    attempts: 5, untilClean: true, paidBudget: .finite(maxUsd: 0), primaryHarness: "claude",
                                    reviewerPanel: [
                                        ReviewerPanelEntry(harness: "claude", model: "claude-opus-4-8", effort: "max"),
                                        ReviewerPanelEntry(harness: "cursor", model: "gemini-3.1-pro")
                                    ],
                                    reviewerModels: ["openai": "gpt-5.5"],
                                    reviewerEfforts: ["anthropic": "max"],
                                    access: "readonly", web: "off",
                                    tests: [TestCommandInvocation(program: "pnpm", args: ["test", "--", "--runInBand"])],
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
        let paidBudget = try #require(obj?["paidBudget"] as? [String: Any])
        #expect(paidBudget["kind"] as? String == "finite")
        #expect(paidBudget["maxUsd"] as? Double == 0)
        #expect(obj?["maxUsd"] == nil)
        let tests = try #require(obj?["tests"] as? [[String: Any]])
        #expect(tests[0]["program"] as? String == "pnpm")
        #expect(tests[0]["args"] as? [String] == ["test", "--", "--runInBand"])
        let approvals = try #require(obj?["protectedPathApprovals"] as? [[String: Any]])
        #expect(approvals[0]["path"] as? String == "packages/**/*.test.ts")
        #expect(obj?["authPreference"] as? String == "api_key")
    }

    @Test func composerBudgetParserAcceptsZeroAndRejectsNonfiniteValues() {
        #expect(ComposerOptionParser.parseNonnegativeFiniteDouble("0") == 0)
        #expect(ComposerOptionParser.parseNonnegativeFiniteDouble("$0.25") == 0.25)
        #expect(ComposerOptionParser.parseNonnegativeFiniteDouble("-1") == nil)
        #expect(ComposerOptionParser.parseNonnegativeFiniteDouble("nan") == nil)
        #expect(ComposerOptionParser.parseNonnegativeFiniteDouble("inf") == nil)
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

    @Test func threadTurnRequestEncodesOnlyFinalizedResourceReferences() throws {
        let request = ThreadTurnRequest(
            prompt: "inspect",
            attachments: [ResourceAttachmentRef(resourceId: "res-finalized")]
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )
        let attachments = try #require(object["attachments"] as? [[String: Any]])
        #expect(attachments.count == 1)
        #expect(attachments[0].count == 1)
        #expect(attachments[0]["resourceId"] as? String == "res-finalized")
        #expect(attachments[0]["data"] == nil)
        #expect(attachments[0]["path"] == nil)
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

    @Test func threadFolderDecodesAndPatchEncodesClear() throws {
        let rich = #"{"id":"th-folder","title":"t","repoRoot":"/p","mode":"agent","workspaceMode":"in_place","authPreference":"auto","folder":"Research","primaryHarness":null,"eligibleHarnesses":[],"state":"active","runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"t","updatedAt":"t"}"#
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(rich.utf8))
        #expect(thread.folder == "Research")
        let clear = UpdateThreadRequest(folder: .some(nil))
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(clear)) as? [String: Any]
        #expect(object?.keys.contains("folder") == true)
        #expect(object?["folder"] is NSNull)
    }

    @Test func harnessSettingsPatchEncodesFullPerHarnessFields() throws {
        let patch = HarnessSettingsPatch(enabled: true, toolsAllow: ["bash"],
                                         toolsDeny: ["net"], fallbackModel: .some("gpt-5-mini"),
                                         authPreference: "subscription")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any]
        #expect(obj?["enabled"] as? Bool == true)
        #expect(obj?["toolsAllow"] as? [String] == ["bash"])
        #expect(obj?["toolsDeny"] as? [String] == ["net"])
        #expect(obj?["fallbackModel"] as? String == "gpt-5-mini")
        #expect(obj?["authPreference"] as? String == "subscription")
        // .some(nil) clears the field (explicit JSON null); .none omits.
        let clear = HarnessSettingsPatch(fallbackModel: .some(nil))
        let cobj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(clear)) as? [String: Any]
        #expect(cobj?.keys.contains("fallbackModel") == true)
        #expect(cobj?["fallbackModel"] is NSNull)
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

    @Test func threadTurnPlanAnswerProvenanceEncodesAndLegacyDecodeDefaultsNil() throws {
        let request = ThreadTurnRequest(
            prompt: "answers",
            mode: "plan",
            answersPlanRunId: "run-plan")
        let encoded = try JSONEncoder().encode(request)
        let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        #expect(object?["answersPlanRunId"] as? String == "run-plan")

        let legacy = try JSONDecoder().decode(
            ThreadTurnInfo.self,
            from: Data(#"{"id":"tn-1","threadId":"th-1","runId":null,"parentRunId":null,"planRunId":null,"kind":"followup","prompt":"x","run":null,"createdAt":"2026-08-02T00:00:00Z"}"#.utf8))
        #expect(legacy.answersPlanRunId == nil)
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
        let untouched = SettingsUpdateRequest(routingGoal: "auto")
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
        if case .thinking(_, let text, _) = r.blocks[0] { #expect(text == "step one\nstep two") } else { Issue.record("expected thinking") }
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

    // MARK: - Per-harness model field

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
        // Whitespace-only draft normalizes to an explicit-clear candidate.
        #expect(modelFieldState(models: answered("none", []), modelDraft: "  ", loadFailed: false) == .defaultOnly)
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

@Test func setupExecutableEvidenceMirrorsTheSharedAbsolutePathRule() throws {
    // Mirrors ABSOLUTE_PATH_PATTERN in @claudexor/schema: POSIX, drive-rooted
    // and UNC paths decode; drive-relative and root-relative ones do not.
    let digest = String(repeating: "a", count: 64)
    func evidence(_ realpath: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "realpath": realpath, "sha256": digest, "size": 1,
            "mode": 493, "device": "1", "inode": "2",
        ])
    }
    for accepted in ["/usr/bin/true", "C:\\Program Files\\Codex\\codex.exe", "C:/codex/codex.exe",
                     "\\\\server\\share\\jobDir"] {
        let data = try evidence(accepted)
        #expect(throws: Never.self) {
            try JSONDecoder().decode(SetupExecutableEvidence.self, from: data)
        }
    }
    for refused in ["relative/path", "./codex.exe", "C:relative\\codex.exe", "\\Windows\\codex.exe"] {
        let data = try evidence(refused)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupExecutableEvidence.self, from: data)
        }
    }
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

    @Test func setupJobCreateEncodesProfileIdOnlyWhenPresent() throws {
        // A default-store login keeps the EXACT legacy body — no profileId key.
        let dflt = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            SetupJobCreateRequest(harness: .codex, action: .login)
        )) as? [String: String])
        #expect(dflt == ["harness": "codex", "action": "login", "authRequest": "subscription"])
        // A profile login emits the profileId (INV-135).
        let profile = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            SetupJobCreateRequest(harness: .claude, action: .login, profileId: "work")
        )) as? [String: String])
        #expect(profile == ["harness": "claude", "action": "login", "authRequest": "subscription", "profileId": "work"])
    }

    @Test func setupJobDecodesNullableProfileId() throws {
        // The server always reports profileId — a value for a profile job…
        let value = makeSetupJob(id: "p", state: "running", phase: .verifying)
        var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        object["profileId"] = "work"
        let decoded = try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(decoded.profileId == "work")
        // …and explicit null for the default store.
        object["profileId"] = NSNull()
        let defaulted = try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(defaulted.profileId == nil)
        // A profile job round-trips through encode without tripping strict decode.
        #expect(try JSONDecoder().decode(SetupJob.self, from: JSONEncoder().encode(decoded)).profileId == "work")
    }

    @Test func succeededProfileJobDecodesWithoutCapabilityReceipt() throws {
        // PROFILE jobs (INV-135) succeed on the profile's doctor probe with the
        // capability smoke honestly skipped: authCapability stays "disclosed"
        // and there is NO receipt. The success invariant is scoped to DEFAULT
        // jobs (mirrors the engine schema) — a succeeded profile job must
        // decode, or the app renders a successful login as streamLost.
        let succeeded = makeSetupJob(id: "p-ok", state: "succeeded", phase: .completed)
        var object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(succeeded)) as? [String: Any])
        let disclosed = makeSetupJob(id: "d", state: "running", phase: .verifying)
        let disclosedCapability = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(disclosed)) as? [String: Any]
        )["authCapability"]
        object["authCapability"] = disclosedCapability
        object["profileId"] = "work"
        let decoded = try JSONDecoder().decode(
            SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(decoded.state == .succeeded)
        #expect(decoded.profileId == "work")
        #expect(decoded.authCapability?.receipt == nil)
        // The DEFAULT store keeps the strict contract: succeeded without a
        // passed receipt is still an invalid job.
        object["profileId"] = NSNull()
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        }
    }

    @Test func harnessSettingsDecodeAndPatchProfileLimitAction() throws {
        let json = """
        {"enabled":true,"defaultModel":null,"effort":null,"maxTurns":null,"maxRounds":null,
         "toolsAllow":[],"toolsDeny":[],"fallbackModel":null,"web":"auto",
         "authPreference":null,"profileLimitAction":"rotate"}
        """
        #expect(try JSONDecoder().decode(HarnessSettings.self, from: Data(json.utf8)).profileLimitAction == "rotate")
        // Absent field tolerated (pre-INV-135 daemon).
        let legacy = """
        {"enabled":true,"defaultModel":null,"effort":null,"maxTurns":null,"maxRounds":null,
         "toolsAllow":[],"toolsDeny":[],"fallbackModel":null,"web":"auto","authPreference":null}
        """
        #expect(try JSONDecoder().decode(HarnessSettings.self, from: Data(legacy.utf8)).profileLimitAction == nil)
        // The patch emits the key ONLY when set (absent fields keep their stored value).
        let patch = SettingsUpdateRequest(harnesses: ["claude": HarnessSettingsPatch(profileLimitAction: "rotate")])
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        let harnesses = try #require(object["harnesses"] as? [String: Any])
        let claude = try #require(harnesses["claude"] as? [String: Any])
        #expect(claude["profileLimitAction"] as? String == "rotate")
        #expect(claude.keys.contains("enabled") == false)
    }

    @Test func setupConflictMessageExtractsDaemonReason() {
        #expect(SetupLifecycleController.conflictMessage(#"{"detail":"another login is active"}"#) == "another login is active")
        #expect(SetupLifecycleController.conflictMessage(#"{"error":"legacy shape"}"#) == "legacy shape")
        #expect(SetupLifecycleController.conflictMessage("") == "Another login for this harness is already active for a different account.")
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

        // device_auth_unsupported (schema v3.0.x) decodes like the other never-started codes...
        object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        native = try #require(object["nativeCommand"] as? [String: Any])
        native["errorCode"] = "device_auth_unsupported"
        object["nativeCommand"] = native
        let unsupported = try JSONDecoder().decode(
            SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(unsupported.nativeCommand?.errorCode == .deviceAuthUnsupported)
        #expect(try JSONDecoder().decode(SetupJob.self, from: JSONEncoder().encode(unsupported)) == unsupported)

        // ...and, like the schema, cannot claim the vendor command ever started.
        native["commandStarted"] = true
        native["permitIssuedAt"] = "2026-07-14T00:00:01Z"
        object["nativeCommand"] = native
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(SetupJob.self, from: JSONSerialization.data(withJSONObject: object))
        }
    }

    @Test func terminalTransportReceiptCodesMatchCommandStartBoundary() throws {
        let digest = String(repeating: "a", count: 64)
        var receipt: [String: Any] = [
            "executionId": "exec-terminal-1",
            "commandDigest": digest,
            "manifestDigest": String(repeating: "b", count: 64),
            "permitIssuedAt": NSNull(),
            "commandStarted": false,
            "exitCode": NSNull(),
            "signal": NSNull(),
            "finishedAt": "2026-08-19T00:00:00Z"
        ]
        let beforeVendor: [(String, SetupNativeCommandErrorCode)] = [
            ("terminal_transport_unavailable", .terminalTransportUnavailable),
            ("terminal_transport_unsupported", .terminalTransportUnsupported),
            ("terminal_transport_probe_failed", .terminalTransportProbeFailed)
        ]
        for (raw, expected) in beforeVendor {
            receipt["errorCode"] = raw
            let data = try JSONSerialization.data(withJSONObject: receipt)
            let decoded = try JSONDecoder().decode(SetupNativeCommandReceipt.self, from: data)
            #expect(decoded.errorCode == expected)

            var contradicted = receipt
            contradicted["commandStarted"] = true
            contradicted["permitIssuedAt"] = "2026-08-18T23:59:59Z"
            #expect(throws: DecodingError.self) {
                try JSONDecoder().decode(
                    SetupNativeCommandReceipt.self,
                    from: JSONSerialization.data(withJSONObject: contradicted))
            }
        }

        // A relay/control break may occur before or after the helper's validated
        // started frame; only the ordinary started-command permit rule applies.
        receipt["errorCode"] = "terminal_transport_failed"
        let preStart = try JSONDecoder().decode(
            SetupNativeCommandReceipt.self,
            from: JSONSerialization.data(withJSONObject: receipt))
        #expect(preStart.errorCode == .terminalTransportFailed)

        receipt["commandStarted"] = true
        receipt["permitIssuedAt"] = "2026-08-18T23:59:59Z"
        let postStart = try JSONDecoder().decode(
            SetupNativeCommandReceipt.self,
            from: JSONSerialization.data(withJSONObject: receipt))
        #expect(postStart.errorCode == .terminalTransportFailed)
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

    /// A VENDOR-owned sign-in window cannot be extended by anyone: Antigravity
    /// waits exactly 60 s for its pasted code and offers no way to lengthen it,
    /// so the daemon refuses the extend and the client must not offer the
    /// button. Absent (older daemon) still means the engine owns the window.
    @Test func vendorOwnedLoginWindowIsNotExtendable() {
        #expect(!makeSetupJob(id: "agy-wait", state: "waiting_for_input", phase: .awaitingUser,
                              harness: .agy, deadlineFixed: true).canExtend)
        #expect(!makeSetupJob(id: "agy-launch", state: "waiting_for_input", phase: .launching,
                              harness: .agy, deadlineFixed: true).canExtend)
        #expect(makeSetupJob(id: "agy-engine-window", state: "waiting_for_input",
                             phase: .awaitingUser, harness: .agy, deadlineFixed: false).canExtend)
        #expect(makeSetupJob(id: "agy-legacy", state: "waiting_for_input",
                             phase: .awaitingUser, harness: .agy).canExtend)
    }

    /// `SetupJob` decodes STRICTLY (unknown keys are fatal), so the daemon
    /// publishing `deadlineFixed` must be a key this client knows — otherwise
    /// every setup screen stops decoding the moment the field ships.
    @Test func vendorWindowFlagSurvivesTheStrictWire() throws {
        let job = makeSetupJob(id: "agy-wire", state: "waiting_for_input", phase: .awaitingUser,
                               harness: .agy, deadlineFixed: true)
        let data = try JSONEncoder().encode(job)
        let wire = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(wire["deadlineFixed"] as? Bool == true)
        let decoded = try JSONDecoder().decode(SetupJob.self, from: data)
        #expect(decoded.deadlineFixed == true)
        #expect(!decoded.canExtend)
        // Absent stays absent: an older daemon's body must not gain the key.
        let legacy = try JSONEncoder().encode(
            makeSetupJob(id: "legacy", state: "waiting_for_input", phase: .awaitingUser))
        let legacyWire = try #require(JSONSerialization.jsonObject(with: legacy) as? [String: Any])
        #expect(legacyWire["deadlineFixed"] == nil)
        #expect(try JSONDecoder().decode(SetupJob.self, from: legacy).canExtend)
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

    // MARK: - D-17 device-code disclosure

    @Test func createRequestEmitsLoginFlowOnlyWhenSet() throws {
        let encoder = JSONEncoder()
        let plain = try encoder.encode(SetupJobCreateRequest(harness: .codex, action: .login))
        #expect(!(String(data: plain, encoding: .utf8) ?? "").contains("loginFlow"))
        let selected = try encoder.encode(
            SetupJobCreateRequest(harness: .codex, action: .login, loginFlow: .browserCallback))
        let json = try #require(JSONSerialization.jsonObject(with: selected) as? [String: Any])
        #expect(json["loginFlow"] as? String == "browser_callback")
    }

    @Test func snapshotAndEventCarryTheTransientDeviceCode() throws {
        let awaiting = makeSetupJob(
            id: "dc", state: "waiting_for_input", phase: .awaitingUser, harness: .codex)
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .chatgptDeviceCode, verificationUrl: "https://chatgpt.com/device", userCode: "ABCD-1234")
        let snapshot = SetupJobSnapshot(job: awaiting, cursor: "c", sequence: 1, deviceCode: disclosure)
        let event = SetupJobEvent(jobId: "dc", cursor: "c2", previousCursor: "c1", sequence: 2,
                                  time: "t", state: .waitingForInput, message: awaiting.message,
                                  job: awaiting, deviceCode: disclosure)
        let encoder = JSONEncoder(); let decoder = JSONDecoder()
        let roundSnap = try decoder.decode(SetupJobSnapshot.self, from: encoder.encode(snapshot))
        let roundEvent = try decoder.decode(SetupJobEvent.self, from: encoder.encode(event))
        #expect(roundSnap.deviceCode == disclosure)
        #expect(roundEvent.deviceCode == disclosure)
        #expect(roundSnap.deviceCode?.hasUserCode == true)
        // A snapshot without the overlay decodes with a nil disclosure (backward compat).
        let bare = SetupJobSnapshot(job: awaiting, cursor: "c", sequence: 1)
        #expect(try decoder.decode(SetupJobSnapshot.self, from: encoder.encode(bare)).deviceCode == nil)
    }

    /// A terminal-mode claude/cursor login captures its vendor sign-in URL and
    /// discloses it through the SAME overlay, so the whole card must survive
    /// the trip. While the DTO admitted codex alone, the wire payload the
    /// daemon really sends decoded to nothing and the login card stayed blank.
    @Test func terminalLoginOauthUrlDisclosureSurvivesEveryManagedHarness() throws {
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .oauthUrl,
            verificationUrl: "https://claude.ai/oauth/authorize?state=abc", userCode: "")
        let encoder = JSONEncoder(); let decoder = JSONDecoder()
        // `oauth_url` is the wire spelling; a Swift-only case name would decode
        // to nothing regardless of what the envelope admits.
        #expect(SetupLoginDisclosureFlow.oauthUrl.rawValue == "oauth_url")
        for harness in [SetupHarness.claude, .cursor, .codex] {
            let awaiting = makeSetupJob(
                id: "oauth", state: "waiting_for_input", phase: .awaitingUser, harness: harness)
            #expect(awaiting.admitsDeviceCodeDisclosure)
            let snapshot = SetupJobSnapshot(
                job: awaiting, cursor: "c", sequence: 1, deviceCode: disclosure)
            let event = SetupJobEvent(
                jobId: "oauth", cursor: "c2", previousCursor: "c1", sequence: 2, time: "t",
                state: .waitingForInput, message: awaiting.message, job: awaiting,
                deviceCode: disclosure)
            #expect(
                try decoder.decode(SetupJobSnapshot.self, from: encoder.encode(snapshot))
                    .deviceCode == disclosure)
            #expect(
                try decoder.decode(SetupJobEvent.self, from: encoder.encode(event))
                    .deviceCode == disclosure)
            // URL-only, exactly like the browser-callback flow: the card must
            // not promise a one-time code it does not have.
            #expect(!disclosure.hasUserCode)
        }
    }

    @Test func snapshotAndEventRejectDeviceCodeOutsideAnAwaitingLogin() throws {
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .chatgptDeviceCode,
            verificationUrl: "https://chatgpt.com/device", userCode: "ABCD-1234")
        let encoder = JSONEncoder()
        // Lifecycle, not vendor: the phase and the terminal state are what make
        // a disclosure invalid, and they do so for every harness.
        let invalidJobs = [
            makeSetupJob(id: "launching-claude", state: "waiting_for_input", phase: .launching),
            makeSetupJob(
                id: "launching", state: "waiting_for_input", phase: .launching,
                harness: .codex),
            makeSetupJob(
                id: "done", state: "succeeded", phase: .awaitingUser, harness: .codex),
        ]
        for job in invalidJobs {
            let jobObject = try #require(
                JSONSerialization.jsonObject(with: encoder.encode(job)) as? [String: Any])
            let codeObject = try #require(
                JSONSerialization.jsonObject(with: encoder.encode(disclosure)) as? [String: Any])
            let snapshotData = try JSONSerialization.data(withJSONObject: [
                "job": jobObject, "cursor": "cursor", "sequence": 1,
                "deviceCode": codeObject,
            ])
            #expect(throws: DecodingError.self) {
                try JSONDecoder().decode(SetupJobSnapshot.self, from: snapshotData)
            }
            let eventData = try JSONSerialization.data(withJSONObject: [
                "jobId": job.jobId, "cursor": "cursor-2", "previousCursor": "cursor-1",
                "sequence": 2, "time": "t", "kind": "status",
                "state": job.state.rawValue, "message": job.message,
                "job": jobObject, "deviceCode": codeObject,
            ])
            #expect(throws: DecodingError.self) {
                try JSONDecoder().decode(SetupJobEvent.self, from: eventData)
            }
        }
    }

    @Test func browserCallbackDisclosureHasNoUserCode() {
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .chatgpt, verificationUrl: "https://auth.openai.com/cb", userCode: "")
        #expect(!disclosure.hasUserCode)
    }

    @Test func controllerThreadsDeviceCodeWhileAwaitingAndClearsOnTerminal() async {
        let awaiting = makeSetupJob(
            id: "login", state: "waiting_for_input", phase: .awaitingUser, harness: .codex)
        let done = makeSetupJob(
            id: "login", state: "succeeded", phase: .completed,
            outcome: SetupJobOutcome(reason: .completed), harness: .codex)
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .chatgptDeviceCode, verificationUrl: "https://chatgpt.com/device", userCode: "WXYZ-9")
        let gateway = FakeSetupGateway(
            listResult: [awaiting], snapshots: [awaiting],
            streams: [.events([
                SetupJobEvent(jobId: "login", cursor: "cursor-event-1", previousCursor: "cursor-snapshot-1",
                              sequence: 2, time: "t", state: .succeeded, message: done.message, job: done)
            ])],
            deviceCode: disclosure)
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "codex")
        // The awaiting snapshot surfaces the transient code…
        let awaitingSnap = await firstSnapshot(in: updates) { $0.deviceCode != nil }
        #expect(awaitingSnap?.deviceCode == disclosure)
        // …and the terminal transition clears it.
        let terminal = await firstSnapshot(in: updates) { $0.connection == .terminal }
        #expect(terminal?.deviceCode == nil)
    }

    @Test func controllerPreservesDeviceCodeAcrossSameJobActionAndAdoption() async {
        let awaiting = makeSetupJob(
            id: "login-action", state: "waiting_for_input", phase: .awaitingUser, harness: .codex)
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .chatgptDeviceCode, verificationUrl: "https://chatgpt.com/device", userCode: "KEEP-1")
        let gateway = FakeSetupGateway(
            listResult: [awaiting], snapshots: [awaiting, awaiting, awaiting],
            streams: [.pending, .pending], deviceCode: disclosure)
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let initial = await controller.updates()
        await controller.recoverActiveJob(harness: "codex")
        #expect(await firstSnapshot(in: initial) { $0.deviceCode == disclosure } != nil)

        let transitions = await controller.updates()
        await controller.extendDeadline()
        var sawRecovering = false
        var recoveringCode: SetupDeviceCodeDisclosure?
        var adoptedCode: SetupDeviceCodeDisclosure?
        for await snapshot in transitions {
            if snapshot.connection == .recovering {
                sawRecovering = true
                recoveringCode = snapshot.deviceCode
            } else if sawRecovering, snapshot.connection == .connected {
                adoptedCode = snapshot.deviceCode
                break
            }
        }
        #expect(recoveringCode == disclosure)
        #expect(adoptedCode == disclosure)

        let reconnects = await controller.updates()
        var reconnectIterator = reconnects.makeAsyncIterator()
        _ = await reconnectIterator.next() // updates() first yields current.
        await controller.reconnect(harness: "codex")
        let reconnected = await reconnectIterator.next()
        #expect(reconnected?.connection == .connected)
        #expect(reconnected?.deviceCode == disclosure)
    }

    @Test func cancellingClearsDeviceCodeBeforeTheServerSettles() async {
        let awaiting = makeSetupJob(
            id: "login-cancel", state: "waiting_for_input", phase: .awaitingUser, harness: .codex)
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .chatgptDeviceCode, verificationUrl: "https://chatgpt.com/device", userCode: "CANCEL-1")
        let gateway = FakeSetupGateway(
            listResult: [awaiting], snapshots: [awaiting, awaiting, awaiting],
            streams: [.pending, .pending], deviceCode: disclosure)
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let initial = await controller.updates()
        await controller.recoverActiveJob(harness: "codex")
        #expect(await firstSnapshot(in: initial) { $0.deviceCode == disclosure } != nil)

        let transitions = await controller.updates()
        await controller.cancel()
        let cancelling = await firstSnapshot(in: transitions) { $0.connection == .recovering }
        #expect(cancelling?.deviceCode == nil)
    }

    @Test func authoritativeAwaitingEventCanClearAStaleDeviceCode() async {
        let awaiting = makeSetupJob(
            id: "login-clear", state: "waiting_for_input", phase: .awaitingUser, harness: .codex)
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .chatgptDeviceCode, verificationUrl: "https://chatgpt.com/device", userCode: "CLEAR-1")
        let event = SetupJobEvent(
            jobId: awaiting.jobId, cursor: "cursor-event-1", previousCursor: "cursor-snapshot-1",
            sequence: 2, time: "t", state: awaiting.state, message: awaiting.message, job: awaiting)
        let gateway = FakeSetupGateway(
            listResult: [awaiting], snapshots: [awaiting], streams: [.events([event])],
            deviceCode: disclosure)
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "codex")
        var sawDisclosure = false
        var cleared = false
        for await snapshot in updates {
            if snapshot.deviceCode == disclosure { sawDisclosure = true }
            if sawDisclosure, snapshot.job?.jobId == awaiting.jobId,
               snapshot.connection == .connected, snapshot.deviceCode == nil {
                cleared = true
                break
            }
        }
        #expect(cleared)
    }

    @Test func finalStreamLossClearsDeviceCodeAfterBoundedReconnects() async {
        let awaiting = makeSetupJob(
            id: "login-lost", state: "waiting_for_input", phase: .awaitingUser, harness: .codex)
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .chatgptDeviceCode, verificationUrl: "https://chatgpt.com/device", userCode: "LOST-1")
        let gateway = FakeSetupGateway(
            listResult: [awaiting], snapshots: [awaiting],
            streams: Array(repeating: .finish, count: 6), deviceCode: disclosure)
        let controller = SetupLifecycleController(gateway: gateway, reconnectDelays: [.zero])
        let updates = await controller.updates()
        await controller.recoverActiveJob(harness: "codex")
        let lost = await firstSnapshot(in: updates) { $0.connection == .streamLost }
        #expect(lost?.reconnectAttempt == SetupLifecycleController.maximumReconnects)
        #expect(lost?.deviceCode == nil)
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

    @Test func gatewayRejectsSetupPointResponsesForAnotherRequestedJob() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t", session: session)
        defer { RequestStubURLProtocol.handler = nil }

        let wrong = makeSetupJob(id: "other", state: "running", phase: .verifying)
        let jobData = try JSONEncoder().encode(wrong)
        let snapshotData = try JSONEncoder().encode(
            SetupJobSnapshot(job: wrong, cursor: "cursor", sequence: 1))
        RequestStubURLProtocol.handler = { request in
            let data = request.url?.path.hasSuffix("/snapshot") == true
                ? snapshotData : jobData
            return (Self.response(for: request), data)
        }

        await #expect(throws: GatewayError.self) { try await client.setupJob(jobId: "wanted") }
        await #expect(throws: GatewayError.self) {
            try await client.setupJobSnapshot(jobId: "wanted")
        }
        await #expect(throws: GatewayError.self) {
            try await client.cancelSetupJob(jobId: "wanted")
        }
        await #expect(throws: GatewayError.self) {
            try await client.reconcileSetupJob(jobId: "wanted")
        }
        await #expect(throws: GatewayError.self) {
            try await client.extendSetupJob(jobId: "wanted")
        }
    }

    /// The one-shot sign-in input (`POST /v2/setup/jobs/:id/input`) must land on
    /// the job it was typed for, carry the value as the wire body and nothing
    /// else, and refuse a response describing a DIFFERENT job — the same
    /// identity pin every other setup point response gets.
    @Test func gatewaySendsSignInInputToItsOwnJobAndRejectsAForeignResponse() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t", session: session)
        defer { RequestStubURLProtocol.handler = nil }

        let waiting = makeSetupJob(id: "login-1", state: "waiting_for_input", phase: .awaitingUser)
        let waitingData = try JSONEncoder().encode(waiting)
        nonisolated(unsafe) var seen: (path: String?, method: String?, auth: String?, body: Data?)
        RequestStubURLProtocol.handler = { request in
            seen = (request.url?.path, request.httpMethod,
                    request.value(forHTTPHeaderField: "Authorization"), testRequestBody(request))
            return (Self.response(for: request), waitingData)
        }

        #expect(try await client.submitSetupJobInput(jobId: "login-1", value: "PASTE-42") == waiting)
        #expect(seen.path == "/v2/setup/jobs/login-1/input")
        #expect(seen.method == "POST")
        #expect(seen.auth == "Bearer t")
        let body = try #require(seen.body)
        #expect(try JSONDecoder().decode(SetupJobInputRequest.self, from: body).value == "PASTE-42")
        // The body is EXACTLY the one wire field — no job/profile echo riding along.
        #expect(try #require(JSONSerialization.jsonObject(with: body) as? [String: Any]).count == 1)

        await #expect(throws: GatewayError.self) {
            try await client.submitSetupJobInput(jobId: "another", value: "PASTE-42")
        }
    }

    /// A daemon refusal of the pasted code (409: wrong phase, or a value already
    /// delivered) is DEFINITIVE server state: the reason must reach the card and
    /// the observation must keep running, never collapse into streamLost — which
    /// would strand the live login behind a reconnect it does not need.
    @Test func controllerReportsSignInInputRefusalWithoutLosingTheLiveLogin() async {
        let awaiting = makeSetupJob(id: "login", state: "waiting_for_input", phase: .awaitingUser)
        let disclosure = SetupDeviceCodeDisclosure(
            flow: .oauthUrlInput, verificationUrl: "https://accounts.google.com/o/oauth2/auth?x=1",
            userCode: "")

        let accepting = FakeSetupGateway(
            listResult: [awaiting], snapshots: [awaiting, awaiting],
            streams: [.pending, .pending], deviceCode: disclosure)
        let accepted = SetupLifecycleController(gateway: accepting, reconnectDelays: [.zero])
        let disclosed = await accepted.updates()
        await accepted.recoverActiveJob(harness: "claude")
        #expect(await firstSnapshot(in: disclosed) { $0.deviceCode == disclosure } != nil)
        #expect(await accepted.submitInput("PASTE-42") == nil)
        #expect(accepting.inputCount == 1)
        let afterAccept = await accepted.snapshot()
        #expect(afterAccept.connection != .streamLost)
        // The link stays on screen while the vendor finishes with the code.
        #expect(afterAccept.deviceCode == disclosure)

        let refusing = FakeSetupGateway(
            listResult: [awaiting], snapshots: [awaiting, awaiting],
            streams: [.pending, .pending], deviceCode: disclosure,
            inputRefusal: GatewayError.http(
                status: 409, body: #"{"detail":"sign-in input was already submitted for this login"}"#))
        let refused = SetupLifecycleController(gateway: refusing, reconnectDelays: [.zero])
        await refused.recoverActiveJob(harness: "claude")
        #expect(await refused.submitInput("PASTE-42")
                == "sign-in input was already submitted for this login")
        #expect(await refused.snapshot().connection != .streamLost)
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

        let other = makeSetupJob(id: "other", state: "running", phase: .verifying)
        let wrongJobEvent = SetupJobEvent(
            jobId: "other", cursor: "cursor-other", previousCursor: "snapshot",
            sequence: 2, time: "t", state: other.state, message: other.message, job: other)
        let wrongJobJSON = String(decoding: try JSONEncoder().encode(wrongJobEvent), as: UTF8.self)
        install("id: cursor-other\nevent: setup\ndata: \(wrongJobJSON)\n\nevent: end\ndata: {}\n\n")
        let wrongJob = await consume(
            client.setupJobEvents(jobId: "j", lastEventId: "snapshot"))
        #expect(String(describing: wrongJob.1).contains("requested job"))

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

    @Test func gatewayGlobalSSEUsesAndValidatesOpaqueJournalCursor() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t", session: session)
        defer { RequestStubURLProtocol.handler = nil }

        RequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/global/events",
                  request.value(forHTTPHeaderField: "Last-Event-ID") == "epoch-a:41" else {
                throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
            }
            let body = "id: epoch-a:42\nevent: run.event\ndata: {\"schemaVersion\":1,\"cursor\":\"epoch-a:42\",\"partition\":\"global\",\"type\":\"run.event\",\"observedAt\":\"2026-07-15T00:00:00.000Z\",\"payload\":{\"run_id\":\"run-1\",\"type\":\"run.completed\"}}\n\nevent: end\ndata: {}\n\n"
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream; charset=utf-8"]
            )!
            return (response, Data(body.utf8))
        }

        var events: [JournalEvent] = []
        do {
            for try await event in client.globalEvents(lastEventId: "epoch-a:41") { events.append(event) }
        } catch {
            Issue.record("unexpected global SSE error: \(error)")
        }
        #expect(events.count == 1)
        #expect(events.first?.cursor == "epoch-a:42")
        #expect(events.first?.payload["run_id"]?.stringValue == "run-1")
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

    @Test func gatewayHarnessModelsRouteRidesAsAQueryItemNotAPercentEncodedPath() throws {
        // QA-055b: the model-route filter MUST be a real query item. The prior
        // spelling appended "models?route=api_key" as a PATH segment, so
        // `appendingPathComponent` percent-encoded the `?` into `%3F` and the
        // daemon 404'd (per-turn model rows hung on "Loading models…").
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t")

        let unfiltered = client.harnessModelsRequest(harnessId: "claude", route: nil)
        #expect(unfiltered.url?.path == "/v2/harnesses/claude/models")
        #expect(unfiltered.url?.query == nil)

        let filtered = client.harnessModelsRequest(harnessId: "claude", route: "api_key")
        // The `?` and query live in the QUERY, never encoded into the path.
        #expect(filtered.url?.path == "/v2/harnesses/claude/models")
        let items = URLComponents(url: filtered.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items == [URLQueryItem(name: "route", value: "api_key")])
        let absolute = filtered.url?.absoluteString ?? ""
        #expect(!absolute.contains("%3F"))
        #expect(!absolute.contains("models%3F"))
        #expect(absolute.hasSuffix("/v2/harnesses/claude/models?route=api_key"))
    }

    @Test func gatewayHandshakeRetainsEngineBuildIdentity() async throws {
        // QA-002: the handshake helper must RETAIN the typed engine {version,sha}
        // instead of discarding it — the About panel needs it. `ok` still gates
        // connectivity; a missing engine object never demotes the connection.
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config)
        )
        func stub(handshakeBody: String) {
            RequestStubURLProtocol.handler = { request in
                switch (request.httpMethod, request.url?.path) {
                case ("GET", "/healthz"):
                    return (Self.response(for: request), Data(#"{"ok":true}"#.utf8))
                case ("POST", "/v2/handshake"):
                    return (Self.response(for: request), Data(handshakeBody.utf8))
                default:
                    throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
                }
            }
        }

        stub(handshakeBody: #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"3.1.0","sha":"abc123def4567890","entry":"/opt/claudexor/daemon.js"}}"#)
        let withEngine = try await client.handshake()
        #expect(withEngine.ok)
        #expect(withEngine.engine == EngineBuildIdentity(
            version: "3.1.0", sha: "abc123def4567890", entry: "/opt/claudexor/daemon.js"))

        // A daemon that omits `engine` still connects; identity is simply nil.
        stub(handshakeBody: #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations"}"#)
        let noEngine = try await client.handshake()
        #expect(noEngine.ok)
        #expect(noEngine.engine == nil)
    }

    @Test func gatewayHandshakeCarriesServingModeAndRecoveryOnlyFact() async throws {
        // Issue #165 D5: a recovery-only daemon reports servingMode in the
        // handshake so the app can stay in Connecting instead of adopting a
        // client whose product routes are typed-refused. Absent servingMode
        // (older daemons) must keep meaning normal admission.
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config)
        )
        func stub(handshakeBody: String) {
            RequestStubURLProtocol.handler = { request in
                switch (request.httpMethod, request.url?.path) {
                case ("GET", "/healthz"):
                    return (Self.response(for: request), Data(#"{"ok":true}"#.utf8))
                case ("POST", "/v2/handshake"):
                    return (Self.response(for: request), Data(handshakeBody.utf8))
                default:
                    throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
                }
            }
        }

        stub(handshakeBody: #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","servingMode":"recovery_only"}"#)
        let recovering = try await client.handshake()
        #expect(recovering.ok)
        #expect(recovering.servingMode == "recovery_only")
        #expect(recovering.recoveryOnly)

        stub(handshakeBody: #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","servingMode":"normal"}"#)
        let serving = try await client.handshake()
        #expect(serving.servingMode == "normal")
        #expect(!serving.recoveryOnly)

        // Pre-#165 daemons omit the field entirely: normal admission.
        stub(handshakeBody: #"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations"}"#)
        let legacy = try await client.handshake()
        #expect(legacy.servingMode == nil)
        #expect(!legacy.recoveryOnly)
    }

    @Test func gatewayUploadsExactBytesAndFinalizesDigestBeforeReturningReference() async throws {
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config)
        )
        let payload = Data("generic sentinel".utf8)
        var step = 0
        RequestStubURLProtocol.handler = { request in
            defer { step += 1 }
            switch step {
            case 0:
                let body = try #require(testRequestBody(request))
                let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
                guard request.httpMethod == "POST", request.url?.path == "/v2/uploads",
                      object["kind"] as? String == "file",
                      object["mime"] as? String == "text/plain",
                      object["name"] as? String == "note.txt",
                      object["sizeBytes"] as? Int == payload.count else {
                    throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
                }
                return (
                    HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: "HTTP/1.1", headerFields: nil)!,
                    Data(#"{"uploadId":"upl-1","state":"open","receivedBytes":0,"expectedBytes":16}"#.utf8)
                )
            case 1:
                guard request.httpMethod == "PUT", request.url?.path == "/v2/uploads/upl-1/bytes",
                      testRequestBody(request) == payload else {
                    throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
                }
                return (
                    Self.response(for: request),
                    Data(#"{"uploadId":"upl-1","state":"uploaded","receivedBytes":16,"expectedBytes":16}"#.utf8)
                )
            case 2:
                let body = try #require(testRequestBody(request))
                let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
                guard request.httpMethod == "POST", request.url?.path == "/v2/uploads/upl-1/finalize",
                      object["expectedSha256"] == "sha256:82dd674276b6cc38b6c4314020c896b23cd2f2203b1886808951956f51d411fa" else {
                    throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
                }
                return (
                    HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: "HTTP/1.1", headerFields: nil)!,
                    Data(#"{"resourceId":"res-1","kind":"file","mime":"text/plain","name":"note.txt","sha256":"sha256:82dd674276b6cc38b6c4314020c896b23cd2f2203b1886808951956f51d411fa","sizeBytes":16,"createdAt":"2026-07-15T00:00:00Z","deduplicated":false}"#.utf8)
                )
            default:
                throw TestTransportError.badRequest("unexpected request")
            }
        }

        let reference = try await client.uploadResource(
            kind: "file", mime: "text/plain", name: "note.txt", data: payload
        )
        #expect(reference == ResourceAttachmentRef(resourceId: "res-1"))
        #expect(step == 3)
    }

    @Test func gatewayHealthNegotiatesV3BeforeReportingReady() async throws {
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
                // The negotiated major moved to 3 (v3.0.0 broke the contracts);
                // the /v2 URL prefix is a frozen path spelling, not the contract.
                guard request.value(forHTTPHeaderField: "X-Claudexor-Protocol-Major") == "3",
                      let body = testRequestBody(request),
                      String(decoding: body, as: UTF8.self).contains(#""protocolMajor":3"#) else {
                    throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
                }
                return (
                    Self.response(for: request),
                    Data(#"{"protocolMajor":3,"compatible":true,"operationsPath":"/v2/operations","engine":{"version":"3.0.0","sha":"unknown","entry":"/opt/claudexor/daemon.js"}}"#.utf8)
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

    /// Round-4 advisory #3 (INV-021): a malformed 200 on the artifact/produced
    /// LIST endpoints must NOT project as an honest EMPTY gallery — the decode
    /// failure propagates as `.decoding` so the load reads as FAILED (the app layer
    /// then renders error + Retry, never a false "no artifacts" over a real error).
    @Test func listRunArtifactsPropagatesMalformed200InsteadOfEmptyGallery() async throws {
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config)
        )
        RequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/r/artifacts" else {
                throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
            }
            // 200, but the body is not the `{ "artifacts": [...] }` shape.
            return (Self.response(for: request), Data(#"{"unexpected":true}"#.utf8))
        }
        await #expect(throws: GatewayError.self) {
            _ = try await client.listRunArtifacts(runId: "r")
        }
    }

    @Test func listProducedFilesPropagatesMalformed200InsteadOfEmptyGallery() async throws {
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config)
        )
        RequestStubURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/r/produced" else {
                throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
            }
            return (Self.response(for: request), Data(#"{"unexpected":true}"#.utf8))
        }
        await #expect(throws: GatewayError.self) {
            _ = try await client.listProducedFiles(runId: "r")
        }
    }

    /// A well-formed 200 with an EMPTY `artifacts` array remains an honest empty
    /// gallery (never conflated with the malformed-200 failure above).
    @Test func listRunArtifactsWellFormedEmptyStaysEmpty() async throws {
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config)
        )
        RequestStubURLProtocol.handler = { request in
            (Self.response(for: request), Data(#"{"artifacts":[]}"#.utf8))
        }
        let artifacts = try await client.listRunArtifacts(runId: "r")
        #expect(artifacts.isEmpty)
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

    // MARK: - Account-pool authority (unified account model)

    @Test func credentialProfilesResponseDecodesAccountPoolsAndIgnoresLegacyHarnessAccounts() throws {
        // The unified-model engine emits `harnessAccounts: []` for wire compat
        // and carries routing facts in `accountPools`. An OLD engine's populated
        // harnessAccounts (with the retired `native` kind) must be IGNORED, not
        // fail the decode — the pseudo-row class is retired client-side too.
        let json = #"""
        {
          "profiles": [
            {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},
             "status":{"availability":"available","verification":"passed","detail":"ok","last_verified_at":null},
             "identity":{"email":"work@example.test","plan":"claude_max"}},
            {"profile":{"profile_id":"spare","harness_id":"claude","display_name":"Spare","credential_kind":"config_dir_login","enabled":false},
             "status":{"availability":"unknown","verification":"not_run","detail":null,"last_verified_at":null},
             "identity":null}
          ],
          "harnessAccounts": [
            {"harness_id":"cursor","native_credentials_enabled":true,"native_login_detected":true,"next_up":{"kind":"native"}}
          ],
          "accountPools": [
            {"harness_id":"claude","next_up":{"kind":"profile","profileId":"work"}},
            {"harness_id":"codex","next_up":{"kind":"api_key_route"}},
            {"harness_id":"cursor","next_up":{"kind":"none","reason":"no enabled account"}},
            {"harness_id":"agy","next_up":{"kind":"future_kind","futureField":1}}
          ],
          "quotaEventCursor": "global-epoch-1:42",
          "quota": {"snapshots":[],"absences":[],"refreshed_at":"2026-07-28T00:00:00Z"}
        }
        """#
        let response = try JSONDecoder().decode(CredentialProfilesResponse.self, from: Data(json.utf8))
        #expect(response.profiles.count == 2)
        #expect(response.profiles[1].profile.enabled == false)
        #expect(response.accountPools.count == 4)
        #expect(response.quota?.refreshedAt == "2026-07-28T00:00:00Z")
        #expect(response.quotaEventCursor == "global-epoch-1:42")

        // Non-secret identity projection (INV-067): decoded on the profile
        // entry; null/absent → nil.
        #expect(response.profiles[0].identity == AccountIdentity(email: "work@example.test", plan: "claude_max"))
        #expect(response.profiles[1].identity == nil)

        let claude = response.accountPools.first { $0.harnessId == "claude" }
        #expect(claude?.nextUp.isProfile("work") == true)
        #expect(claude?.nextUp.isProfile("spare") == false)
        #expect(claude?.nextUp.isApiKeyRoute == false)

        let codex = response.accountPools.first { $0.harnessId == "codex" }
        #expect(codex?.nextUp.isApiKeyRoute == true)

        let cursor = response.accountPools.first { $0.harnessId == "cursor" }
        if case .some(.none(let reason)) = cursor?.nextUp {
            #expect(reason == "no enabled account")
        } else {
            Issue.record("expected cursor pool next-up to be .none")
        }

        // Forward compatibility: an unknown kind decodes as .unknown instead of
        // failing the whole accounts response (the legacy decoder's throw-on-
        // unknown class is dead).
        let agy = response.accountPools.first { $0.harnessId == "agy" }
        #expect(agy?.nextUp == .unknown(kind: "future_kind"))
        #expect(agy?.nextUp.isProfile("work") == false)
        #expect(agy?.nextUp.isApiKeyRoute == false)
    }

    @Test func credentialProfilesResponseDefaultsAccountPoolsWhenAbsent() throws {
        // An older daemon omits the pool authority entirely — it must still decode.
        let response = try JSONDecoder().decode(
            CredentialProfilesResponse.self, from: Data(#"{"profiles":[]}"#.utf8))
        #expect(response.profiles.isEmpty)
        #expect(response.accountPools.isEmpty)
        #expect(response.quotaEventCursor == nil)
    }

    @Test func credentialProfileEntryToleratesOmittedIdentity() throws {
        // An older daemon omits `identity` on the entry — it must still decode to nil.
        let json = #"""
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},
         "status":{"availability":"available","verification":"passed","detail":"ok","last_verified_at":null}}
        """#
        let entry = try JSONDecoder().decode(CredentialProfileEntry.self, from: Data(json.utf8))
        #expect(entry.identity == nil)
    }

    @Test func gatewayPatchesCredentialProfileEnabled() async throws {
        defer { RequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RequestStubURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config))

        RequestStubURLProtocol.handler = { request in
            guard request.httpMethod == "PATCH",
                  request.url?.path == "/v2/credential-profiles/claude/work" else {
                throw TestTransportError.badRequest(request.url?.absoluteString ?? "nil")
            }
            let body = testRequestBody(request)
                .flatMap { try? JSONDecoder().decode([String: Bool].self, from: $0) }
            guard body?["enabled"] == false else {
                throw TestTransportError.badRequest("unexpected patch body")
            }
            let json = #"{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":false},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}"#
            return (Self.response(for: request), Data(json.utf8))
        }

        let entry = try await client.updateCredentialProfile(
            harnessId: "claude", profileId: "work", enabled: false)
        #expect(entry.profile.enabled == false)
        #expect(entry.id == "claude/work")
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

private func makeSetupCapability(
    state: SetupJobState, harness: SetupHarness = .claude
) -> AuthCapabilityLifecycle {
    let digest = String(repeating: "a", count: 64)
    let disclosure = AuthSmokeDisclosure(
        harness: harness.rawValue, generatedAt: "2026-07-13T00:00:00Z")
    if state == .succeeded {
        let receipt = try! JSONDecoder().decode(AuthCapabilityReceipt.self, from: Data("""
        {"receiptId":"receipt-test","attemptId":"attempt-test","harness":"\(harness.rawValue)",
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
                          terminationReconciliation: SetupTerminationReconciliation? = nil,
                          harness: SetupHarness = .claude,
                          deadlineFixed: Bool? = nil) -> SetupJob {
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
    return SetupJob(jobId: id, harness: harness, action: .login, state: typedState, phase: phase,
             deadlineAt: state == "waiting_for_input" ? "2099-01-01T00:00:00Z" : nil,
             deadlineFixed: deadlineFixed,
             outcome: outcome ?? defaultOutcome, message: state, createdAt: "2026-07-13T00:00:00Z",
             startedAt: typedState == .queued ? nil : "2026-07-13T00:00:01Z",
             finishedAt: terminal ? "2026-07-13T00:00:02Z" : nil,
             authCapability: makeSetupCapability(state: typedState, harness: harness),
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
    case pending
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
    private var inputSubmissionsStorage = 0
    /// D-17: transient device-code disclosure overlaid on every snapshot GET.
    private let deviceCode: SetupDeviceCodeDisclosure?
    /// How the daemon refuses a sign-in input submission, when it should.
    private let inputRefusal: GatewayError?

    init(listResult: [SetupJob], snapshots: [SetupJob], streams: [FakeStreamResult],
         createFailures: Int = 0, listFailures: Int = 0,
         deviceCode: SetupDeviceCodeDisclosure? = nil,
         inputRefusal: GatewayError? = nil) {
        self.listResultStorage = listResult
        self.snapshots = snapshots
        self.streams = streams
        self.createFailuresRemaining = createFailures
        self.listFailuresRemaining = listFailures
        self.deviceCode = deviceCode
        self.inputRefusal = inputRefusal
    }

    var calls: [String] { lock.withLock { callsStorage } }
    var lastFilter: SetupJobListFilter? { lock.withLock { filterStorage } }
    var filters: [SetupJobListFilter] { lock.withLock { filtersStorage } }
    var getCount: Int { calls.filter { $0.hasPrefix("get:") }.count }
    var streamCount: Int { calls.filter { $0.hasPrefix("stream:") }.count }
    var cancelCount: Int { lock.withLock { cancelCountStorage } }
    var inputCount: Int { lock.withLock { inputSubmissionsStorage } }

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
        // The transient disclosure is overlaid only while the login awaits the
        // user — mirrors the daemon's read-time projection (removed once terminal).
        let overlay = job.phase == .awaitingUser ? deviceCode : nil
        return SetupJobSnapshot(job: job, cursor: "cursor-snapshot-\(getCount)", sequence: 1,
                                deviceCode: overlay)
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

    /// Counts submissions only. The pasted VALUE is deliberately never stored —
    /// a double that retains a one-time secret is the same defect in miniature.
    func submitSetupJobInput(jobId: String, value: String) async throws -> SetupJob {
        try lock.withLock {
            callsStorage.append("input:\(jobId)")
            inputSubmissionsStorage += 1
            if let inputRefusal { throw inputRefusal }
        }
        return try nextSetupJob(jobId: jobId)
    }

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
            case .pending:
                break
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
    func submitSetupJobInput(jobId: String, value: String) async throws -> SetupJob { active }

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

extension ClaudexorKitTests {
    @Test func harnessListDecodesGitPrerequisiteAndOlderDaemonOmission() throws {
        let json = #"{"git":{"status":"developer_tools_stub","version":null,"detail":"xcode-select","remediation":"Install Command Line Tools."},"harnesses":[]}"#
        let response = try JSONDecoder().decode(
            HarnessListResponse.self, from: Data(json.utf8))
        let git = try #require(response.git)
        #expect(git.status == "developer_tools_stub")
        #expect(!git.available)
        #expect(git.remediation == "Install Command Line Tools.")
        let legacy = try JSONDecoder().decode(
            HarnessListResponse.self, from: Data(#"{"harnesses":[]}"#.utf8))
        #expect(legacy.git == nil)
    }

    /// DELETE /v2/credential-profiles receipt: camelCase fields decode, the
    /// snake_case `profile` object is deliberately skipped (plain JSONDecoder
    /// ignores unknown keys), and `cleanupWarning` is absent-or-present —
    /// exactly the engine's ControlCredentialProfileDeleteResponse shape.
    @Test func deleteCredentialProfileReceiptDecodes() throws {
        let clean = """
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
         "credential_kind":"config_dir_login","isolation_locator":"/tmp/x","secret_ref":null,
         "enabled":true,"created_at":"2026-07-18T00:00:00Z"},
         "removed":true,"credentialCleanup":"config_dir_removed"}
        """
        let receipt = try JSONDecoder().decode(
            DeleteCredentialProfileReceipt.self, from: Data(clean.utf8))
        #expect(receipt.removed == true)
        #expect(receipt.credentialCleanup == "config_dir_removed")
        #expect(receipt.cleanupWarning == nil)
        #expect(receipt.vendorCredentialDisposition == nil)

        let warned = """
        {"profile":{"profile_id":"w","harness_id":"codex","display_name":"w",
         "credential_kind":"config_dir_login","isolation_locator":"/tmp/y","secret_ref":null,
         "enabled":true,"created_at":"2026-07-18T00:00:00Z"},
         "removed":true,"credentialCleanup":"none",
         "cleanupWarning":"registry entry removed, but credential cleanup failed: refused"}
        """
        let disclosed = try JSONDecoder().decode(
            DeleteCredentialProfileReceipt.self, from: Data(warned.utf8))
        #expect(disclosed.credentialCleanup == "none")
        #expect(disclosed.cleanupWarning?.contains("cleanup failed") == true)

        let external = """
        {"removed":true,"credentialCleanup":"none","vendorCredentialDisposition":{
          "owner":"vendor","scope":"os_user","state":"left_unchanged"}}
        """
        let externalReceipt = try JSONDecoder().decode(
            DeleteCredentialProfileReceipt.self, from: Data(external.utf8))
        #expect(externalReceipt.vendorCredentialDisposition?.owner == .vendor)
        #expect(externalReceipt.vendorCredentialDisposition?.scope == .osUser)
        #expect(externalReceipt.vendorCredentialDisposition?.state == .leftUnchanged)
    }

    /// `verification_source` is what the `verification` verdict is WORTH:
    /// `local_store` says only that credential material is present locally,
    /// which cannot tell a live token from a revoked one. Dropping it on decode
    /// made every `passed` read as vendor-confirmed on this client.
    @Test func credentialProfileStatusCarriesItsVerificationSource() throws {
        let vendor = """
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
         "credential_kind":"config_dir_login","isolation_locator":"/tmp/x","secret_ref":null,
         "enabled":true,"created_at":"2026-07-18T00:00:00Z"},
         "status":{"availability":"available","verification":"passed",
          "verification_source":"vendor","last_verified_at":"2026-07-18T01:00:00Z"}}
        """
        let confirmed = try JSONDecoder().decode(
            CredentialProfileEntry.self, from: Data(vendor.utf8))
        #expect(confirmed.status.verificationSource == "vendor")

        let local = """
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
         "credential_kind":"config_dir_login","isolation_locator":"/tmp/x","secret_ref":null,
         "enabled":true,"created_at":"2026-07-18T00:00:00Z"},
         "status":{"availability":"available","verification":"passed",
          "verification_source":"local_store"}}
        """
        #expect(
            try JSONDecoder().decode(CredentialProfileEntry.self, from: Data(local.utf8))
                .status.verificationSource == "local_store")

        // A daemon that predates the distinction gets the WEAKER claim, never
        // an invented "vendor" — same default the wire schema applies.
        let legacy = """
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
         "credential_kind":"config_dir_login","isolation_locator":"/tmp/x","secret_ref":null,
         "enabled":true,"created_at":"2026-07-18T00:00:00Z"},
         "status":{"availability":"available","verification":"passed"}}
        """
        #expect(
            try JSONDecoder().decode(CredentialProfileEntry.self, from: Data(legacy.utf8))
                .status.verificationSource == "local_store")
    }

    /// A spent subscription window states its reopen time STRUCTURALLY. While
    /// the DTO dropped it, every surface was pushed back to reading "resets …"
    /// out of safeMessage — the prose-parsing the typed field exists to end.
    @Test func runFailureCarriesTheWindowReopenTime() throws {
        let exhausted = """
        {"phase":"routing","category":"budget","code":"subscription_window_exhausted",
         "harnessId":"claude","attemptId":null,
         "safeMessage":"Every candidate's subscription window is spent.",
         "rawDetailRef":null,"logRefs":[],"eventRefs":[],"runDir":null,
         "resetsAt":"2026-07-19T17:00:00.000Z","nextActions":[]}
        """
        let failure = try JSONDecoder().decode(RunFailureInfo.self, from: Data(exhausted.utf8))
        #expect(failure.resetsAt == "2026-07-19T17:00:00.000Z")
        #expect(failure.code == "subscription_window_exhausted")

        // A refusal with no such time says so, and still decodes.
        let drain = """
        {"phase":"terminalization","category":"internal",
         "code":"delegation_child_drain_timeout","safeMessage":"drained","resetsAt":null}
        """
        #expect(try JSONDecoder().decode(RunFailureInfo.self, from: Data(drain.utf8))
            .resetsAt == nil)
    }

    /// W4.7: the daemon-normalized readiness list decodes typed — and a
    /// legacy daemon without the field fails CLOSED to an empty list.
    @Test func harnessStatusDecodesNormalizedReadiness() throws {
        let json = """
        {"id":"claude","status":"ok",
         "readiness":[
           {"kind":"smoke","id":"isolated_smoke","title":"Isolated API-key smoke","status":"pass","detail":null},
           {"kind":"auth","id":"auth_source:native_session","title":"Native session","status":"pass"}
         ]}
        """
        let status = try JSONDecoder().decode(HarnessStatus.self, from: Data(json.utf8))
        #expect(status.readiness.count == 2)
        #expect(status.readiness[0] == ReadinessCheck(
            kind: "smoke", id: "isolated_smoke", title: "Isolated API-key smoke", status: "pass"))
        #expect(status.readiness[1].kind == "auth")

        let legacy = try JSONDecoder().decode(
            HarnessStatus.self, from: Data(#"{"id":"claude","status":"ok"}"#.utf8))
        #expect(legacy.readiness.isEmpty)
    }
}
