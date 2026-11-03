import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

/// #133/#146/#147/#393 consumers: the composer pool lanes and the request bytes
/// they emit, the diverged-primary receipt, the image-input note, the failed
/// catalog read and the refused-request facts. Pure presentation plus one
/// stubbed GatewayClient: no AppModel instance, window, network or saved state.
@Suite(.serialized)
struct RoutingConsumerTests {
    private static let degradedReason = "key present but route unproven (no isolated smoke)"

    /// Doctor facts per harness, shaped like the engine's projection: ok harnesses
    /// route what they enable; the degraded raw API keeps enabledIntents only.
    private static func entries(intent: String, projectScoped: Bool) -> [HarnessPoolSection.Entry] {
        let ok = ["implement", "plan", "explain"]
        let rows: [(HarnessFamily, [String], [String], Bool?, [String], Bool, String)] = [
            (.codex, ok, ok, true, [], true, "Ready by doctor."),
            (.agy, ok, ok, true, [], true, "Ready by doctor."),
            (.copilot, [], [], true, ["installed: GitHub Copilot binary is not installed"], false, "Not ready: unavailable."),
            (.claude, ok, ok, true, [], true, "Ready by doctor."),
            (.cursor, ok, ok, true, [], true, "Ready by doctor."),
            (.openrouter, [], ["implement", "plan", "spec", "review", "synthesize", "explain"], false,
             [degradedReason], false, "Not ready: doctor degraded."),
        ]
        return rows.map { family, routable, enabled, readsFiles, reasons, healthOk, auth in
            .init(family: family, lane: HarnessPoolPresentation.lane(
                label: family.label, intent: intent, routableIntents: routable, enabledIntents: enabled,
                readsFiles: readsFiles, projectScoped: projectScoped, reasons: reasons,
                healthOk: healthOk, auth: auth))
        }
    }

    private static func lane(_ family: HarnessFamily, _ entries: [HarnessPoolSection.Entry]) -> HarnessPoolPresentation.Lane? {
        entries.first { $0.family == family }?.lane
    }

    @Test func degradedHarnessIsManualOnlyAndJoinsTheEmittedPool() async throws {
        let entries = Self.entries(intent: "implement", projectScoped: true)
        #expect(Self.lane(.openrouter, entries) == .manualOnly(reason: Self.degradedReason))
        #expect(Self.lane(.codex, entries) == .auto)
        #expect(Self.lane(.copilot, entries) == .unavailable(reason: "installed: GitHub Copilot binary is not installed"))
        let available = HarnessPoolSection.autoAvailable(entries)
        #expect(available == ["codex", "agy", "claude", "cursor"])

        // Selecting the manual lane from Auto keeps it: Auto's set plus the pick.
        let next = HarnessPoolPresentation.toggling("openrouter", pool: [], available: available)
        #expect(next == ["codex", "agy", "claude", "cursor", "openrouter"])
        #expect(HarnessPoolPresentation.includedFamilies(pool: next, available: available).contains("openrouter"))

        // The bytes the app PATCHes for the thread's sticky pool: exactly that
        // explicit subset and nothing about the primary.
        let body = try await Self.capturedBody { client in
            _ = try await client.updateThread(id: "th-1", body: UpdateThreadRequest(eligibleHarnesses: next))
        }
        #expect(body.method == "PATCH" && body.path == "/v2/threads/th-1")
        #expect(body.json["eligibleHarnesses"] as? [String] == next)
        #expect(Set(body.json.keys) == ["eligibleHarnesses"])

        // Deselecting it returns to Auto's members, still explicit.
        #expect(HarnessPoolPresentation.toggling("openrouter", pool: next, available: available) == available)
        // Best-of sends the same explicit lanes per turn.
        let turn = try Self.json(ThreadTurnRequest(prompt: "Fix the retry", mode: "agent", harnesses: next, n: next.count))
        #expect(turn["harnesses"] as? [String] == next)
    }

    @Test func autoPreferredPrimaryStaysAPreferenceOnTheWire() async throws {
        // The composer's primary chip inside Auto PATCHes only the preference: no
        // pool is sent, so the engine keeps the Auto pool and may route around it.
        let body = try await Self.capturedBody { client in
            _ = try await client.updateThread(id: "th-1", body: UpdateThreadRequest(primaryHarness: .some("openrouter")))
        }
        #expect(body.json["primaryHarness"] as? String == "openrouter")
        #expect(body.json["eligibleHarnesses"] == nil)
        // A draft's first turn creates the thread the same way.
        let create = try Self.json(CreateThreadRequest(scope: .project(root: "/work/billing-worker"),
                                                       primaryHarness: "openrouter"))
        #expect(create["primaryHarness"] as? String == "openrouter")
        #expect(create["eligibleHarnesses"] == nil)
    }

    @MainActor
    @Test func divergedPrimaryNoteUsesTheEngineDetailForReadinessPreferred() {
        #expect(AppModel.primaryDivergedNote(
            requested: "openrouter", effective: "codex", reason: "readiness_preferred",
            detail: "openrouter is degraded: \(Self.degradedReason)")
            == "preferred openrouter → ran on codex. Auto runs only ready harnesses; openrouter is degraded: \(Self.degradedReason)")
        #expect(AppModel.primaryDivergedNote(
            requested: "openrouter", effective: "codex", reason: "readiness_preferred")
            == "preferred openrouter → ran on codex. Auto runs only ready harnesses; openrouter is not ready")
        // Other reasons keep their wording even when a detail rides along.
        #expect(AppModel.primaryDivergedNote(
            requested: "claude", effective: "codex", reason: "quota_exhausted", detail: "claude is on cooldown")
            == "requested claude → ran on codex (claude quota exhausted)")
    }

    @Test func askLanesFollowTheProjectScope() {
        let plain = Self.entries(intent: "explain", projectScoped: false)
        #expect(Self.lane(.openrouter, plain) == .manualOnly(reason: Self.degradedReason))
        let project = Self.entries(intent: "explain", projectScoped: true)
        #expect(Self.lane(.openrouter, project) == .cannotReadProjectFiles)
        #expect(Self.lane(.openrouter, project)?.unavailableReason == HarnessPoolPresentation.cannotReadProjectFilesReason)
        #expect(Self.lane(.codex, project) == .auto)
        // Not enabled at all stays the doctor's reason, project or not.
        #expect(Self.lane(.copilot, project) == .unavailable(reason: "installed: GitHub Copilot binary is not installed"))
        // A project Plan reads the project too; an Agent turn stays manual only.
        #expect(Self.lane(.openrouter, Self.entries(intent: "plan", projectScoped: true)) == .cannotReadProjectFiles)
        #expect(Self.lane(.openrouter, Self.entries(intent: "implement", projectScoped: true))?.isManualOnly == true)
    }

    @MainActor
    @Test func harnessStatusCarriesTheDeclaredReadFilesCapability() throws {
        let json = #"""
        [{"id":"openrouter","status":"degraded","manifest":{"capabilities":{"read_files":false}},
          "enabledIntents":["implement","explain"],"routableIntents":[],"reasons":["key present but route unproven (no isolated smoke)"]},
         {"id":"codex","status":"ok","enabledIntents":["implement","explain"],"routableIntents":["implement","explain"]}]
        """#
        let infos = AppModel.mapHarnessStatuses(try JSONDecoder().decode([HarnessStatus].self, from: Data(json.utf8)))
        #expect(infos[0].readsFiles == false && infos[0].intents == ["implement", "explain"] && infos[0].routableIntents.isEmpty)
        #expect(infos[1].readsFiles == nil)
    }

    // MARK: #146

    @Test func imageNoteNeedsAnAttachedImageAndAKnownNoImageCatalogRow() throws {
        let catalog = HarnessModelsResponse(harnessId: "openrouter", models: [
            HarnessModel(id: "qwen/qwen3-coder", inputModalities: ["text"]),
            HarnessModel(id: "anthropic/claude-opus-5.5", inputModalities: ["text", "image"]),
            HarnessModel(id: "vendor/unknown"),
        ], source: "api")
        let lane = try #require(ComposerImageInputNote.textOnlyLane(selectedModel: "qwen/qwen3-coder", catalog: catalog))
        #expect(ComposerImageInputNote.message(attachmentKinds: ["image"], lanes: [lane])
            == "The catalog lists no image input for qwen/qwen3-coder (input: text). The image is still sent; the provider decides.")
        #expect(ComposerImageInputNote.message(attachmentKinds: ["file"], lanes: [lane]) == nil)
        #expect(ComposerImageInputNote.textOnlyLane(selectedModel: "anthropic/claude-opus-5.5", catalog: catalog) == nil)
        #expect(ComposerImageInputNote.textOnlyLane(selectedModel: "vendor/unknown", catalog: catalog) == nil)
        #expect(ComposerImageInputNote.textOnlyLane(selectedModel: "not/listed", catalog: catalog) == nil)
        #expect(ComposerImageInputNote.textOnlyLane(selectedModel: nil, catalog: catalog) == nil)
        #expect(ComposerImageInputNote.textOnlyLane(selectedModel: "qwen/qwen3-coder", catalog: nil) == nil)
    }

    @Test func imageNoteReadsADeclaredRoutingVariantFromItsListedRow() throws {
        let rows = [
            HarnessModel(id: "qwen/qwen3-coder", inputModalities: ["text"]),
            HarnessModel(id: "vendor/laguna:free", inputModalities: ["text"]),
        ]
        let declared = [
            ModelRoutingVariantInfo(suffix: ":nitro", billing: "service_tier"),
            ModelRoutingVariantInfo(suffix: ":floor", billing: "service_tier"),
            ModelRoutingVariantInfo(suffix: ":exacto", billing: "base"),
        ]
        let catalog = HarnessModelsResponse(harnessId: "openrouter", models: rows, source: "api", routingVariants: declared)
        for model in ["qwen/qwen3-coder:nitro", "qwen/qwen3-coder:floor:exacto", "vendor/laguna:nitro:free"] {
            let lane = try #require(ComposerImageInputNote.textOnlyLane(selectedModel: model, catalog: catalog))
            // The note names the model as selected, never the row it resolved to.
            #expect(lane == ComposerImageInputNote.Lane(model: model, modalities: ["text"]))
        }
        // Undeclared suffixes, an unlisted catalog variant and a bare suffix find no row.
        for model in ["qwen/qwen3-coder:online", "qwen/qwen3-coder:free:nitro", ":nitro"] {
            #expect(ComposerImageInputNote.textOnlyLane(selectedModel: model, catalog: catalog) == nil)
        }
        // Negative control: the same rows without the declaration resolve nothing.
        let undeclared = HarnessModelsResponse(harnessId: "openrouter", models: rows, source: "api")
        #expect(ComposerImageInputNote.textOnlyLane(selectedModel: "qwen/qwen3-coder:nitro", catalog: undeclared) == nil)
    }

    // MARK: #393

    @MainActor
    @Test func failedCatalogReadIsShownAndReadAgainNeverCachedAsEmpty() throws {
        let failed = try JSONDecoder().decode(HarnessModelsResponse.self, from: Data(#"""
        {"harnessId":"openrouter","models":[],"source":"api","verifiedAgainst":null,"problem":{"code":"model_catalog_unavailable","message":"the live model catalog could not be read (timeout)","retryable":true,"fieldErrors":{},"requiredActions":[],"evidenceRefs":[],"context":{"cause":"timeout"}}}
        """#.utf8))
        let answered = HarnessModelsResponse(harnessId: "codex", models: [HarnessModel(id: "gpt-5.5")], source: "api")
        let failedKey = ComposerModelsSection.catalogKey(.openrouter, route: nil)
        let answeredKey = ComposerModelsSection.catalogKey(.codex, route: nil)
        let settled = ComposerModelsSection.settledKeys([failedKey: failed, answeredKey: answered])
        #expect(settled == [answeredKey])
        #expect(ComposerModelsSection.familiesToFetch([.openrouter, .codex], route: nil, cached: settled) == [.openrouter])
        #expect(!failed.canEnumerate)
        #expect(ComposerModelsSection.catalogProblemHelp(.openrouter, failed)
            == "OpenRouter: the live model catalog could not be read (timeout). This is not an empty catalog.")
    }

    // MARK: #147 / #393 refused requests

    @Test func refusedRequestsGetATypedFactAndTitleWithTheEngineMessage() {
        var run = TaskRun(
            id: "run-1", title: "t", prompt: "p", mode: .agent, phase: .failed, project: "billing-worker",
            harnesses: [.openrouter], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, routeProof: .unverified, attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [])
        let message = #"raw_context_exceeds_window: the raw request for "openai/gpt-4o-mini" cannot fit its 128000-token context window: the packet needs ~310412 tokens with every optional file omitted (mandatory: AGENTS.md (~6120 tokens)), the request framing ~2210 and the output allowance 16384 (estimates, chars/4). Choose a model with a larger window, or reduce context.mandatory_files."#
        run.failureCode = "raw_context_exceeds_window"
        run.engineError = message
        let fact = RunFacts.headerDetails(run).first { $0.id == "request_refused" }
        #expect(fact?.text == "Not sent: over the context window")
        #expect(fact?.help == message && fact?.tone == .failure)
        #expect(RunFacts.refusal(code: "raw_context_mandatory_unavailable")?.title
            == "Not sent: mandatory context files are unavailable")
        // Decision A: only a missing or rejected key still refuses on a failed catalog read.
        #expect(RunFacts.refusal(code: "model_catalog_unavailable")?.fact == "Not sent: API key missing or rejected")
        // The receipt chip says what happened instead of the generic failed reason.
        #expect(TurnPresentation.attention(phase: .failed, reason: "harness_failed", reviewNeedsDecision: false,
                                           waitingOnUser: false, unfinishedWork: nil, refusal: RunFacts.refusal(run)?.chip)
            == TurnPresentation.Attention(text: "Not sent", tone: .failure))
        // An earlier try failed after dispatch: only this retry was refused.
        run.failureRecord = try! JSONDecoder().decode(RunFailureInfo.self, from: Data(#"""
        {"phase":"convergence","category":"validation","code":"raw_context_exceeds_window","safeMessage":"x","poolAttempts":[{"harnessId":"openrouter","profileId":null,"profileDisplayName":null,"requestedModel":"openai/gpt-4o-mini","attemptId":"a01","tryIndex":0,"observedAt":"2026-10-29T10:00:00.000Z","phase":"pre_progress","category":"transient_infrastructure","error":"openrouter HTTP 503","vendorFailure":null}]}
        """#.utf8))
        #expect(RunFacts.refusal(run) == RunFacts.Refusal(
            title: "Retry not sent: the request doesn't fit the model's context window",
            fact: "Retry not sent: over the context window", chip: "Retry not sent"))
        #expect(RunFacts.headerDetails(run).first { $0.id == "request_refused" }?.text
            == "Retry not sent: over the context window")
        run.failureRecord = nil
        run.failureCode = "harness_failed"
        #expect(RunFacts.refusal(code: run.failureCode) == nil)
        #expect(!RunFacts.headerDetails(run).contains { $0.id == "request_refused" })
        #expect(TurnPresentation.attention(phase: .failed, reason: "harness_failed", reviewNeedsDecision: false,
                                           waitingOnUser: false, unfinishedWork: nil)?.text == RunReasonLabel.label("harness_failed"))
    }

    // MARK: #147 typed sizes from a real run

    /// Summaries the built engine projected for a real run against a local fake
    /// OpenRouter (`.review-evidence/cx393a-147`; `unsentRetry` from
    /// `.review-evidence/routing-final-repair`; temp paths neutralized).
    private static func realSummary(_ name: String) throws -> RunSummary {
        let url = try #require(Bundle.module.url(forResource: "raw-context-147-summaries", withExtension: "json"))
        let all = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let one = try JSONSerialization.data(withJSONObject: try #require(all[name]))
        return try JSONDecoder().decode(RunSummary.self, from: one)
    }

    @MainActor
    @Test func aPreparedRawRequestShowsItsEstimateAndOmittedFiles() throws {
        let task = AppModel.liveTask(from: try Self.realSummary("success"))
        let facts = RunFacts.headerDetails(task)
        let context = try #require(facts.first { $0.id == "raw_context" })
        #expect(context.text == "Context ≈159k of 200k tokens · estimated")
        #expect(context.tone == .neutral)
        #expect(context.help?.hasPrefix("The last request prepared for openai/gpt-4o-mini, sized against its 200000-token context window from the model catalog. 16384 more were kept free for the answer.") == true)
        #expect(facts.first { $0.id == "raw_context_omitted" }?.text == "3 optional files left out")
        #expect(!facts.contains { $0.id == "request_refused" })
        // A run without the receipt adds neither fact (other transports, older engines).
        var plain = task
        plain.rawContext = nil
        #expect(!RunFacts.headerDetails(plain).contains { $0.id.hasPrefix("raw_context") })
    }

    @MainActor
    @Test func aRealUnknownWindowRunSaysItsCeilingIsAnAssumption() throws {
        let facts = RunFacts.headerDetails(AppModel.liveTask(from: try Self.realSummary("unknown")))
        #expect(facts.first { $0.id == "raw_context" }?.text == "Context ≈189k tokens · window unknown, assumed 200k")
        #expect(facts.first { $0.id == "raw_context" }?.tone == .warning)
        #expect(facts.first { $0.id == "raw_context_omitted" }?.text == "2 optional files left out")
    }

    @Test func anUnknownWindowSaysItsCeilingIsAnAssumption() {
        let raw = RawContextReceiptInfo(
            model: "vendor/m", estimatedRequestTokens: 150_212,
            budget: RawContextBudgetInfo(basis: "assumed_ceiling", model: "vendor/m", contextWindow: nil,
                                         outputAllowanceTokens: 16_384, selectionLimitTokens: 200_000,
                                         omittedForBudget: 0))
        let facts = RunFacts.rawContextFacts(raw)
        #expect(facts.map(\.text) == ["Context ≈150k tokens · window unknown, assumed 200k"])
        #expect(facts.first?.tone == .warning)
        #expect(RunFacts.tokenCount(950) == "950")
        #expect(RunFacts.tokenCount(1_000) == "1k")
        #expect(RunFacts.tokenCount(1_590) == "1.6k")
        #expect(RunFacts.tokenCount(9_960) == "10k")
        #expect(RunFacts.tokenCount(331_418) == "331k")
        #expect(RunFacts.tokenCount(999_600) == "1M")
        #expect(RunFacts.tokenCount(1_250_000) == "1.2M" || RunFacts.tokenCount(1_250_000) == "1.3M")
    }

    @MainActor
    @Test func aRefusedRawRequestShowsFiguresThatAddUpAndItsLargestFiles() throws {
        let task = AppModel.liveTask(from: try Self.realSummary("refusal"))
        let refusal = try #require(RunFacts.refusal(task))
        #expect(refusal.title == "Not sent: the request doesn't fit the model's context window")
        let record = try #require(task.failureRecord)
        let typed = try #require(record.rawContextShortfall)
        #expect(typed.neededTokens == typed.mandatoryTokens + typed.otherRequestTokens + typed.outputAllowanceTokens)
        #expect(typed.neededTokens > typed.contextWindow)
        let shortfall = RunFacts.shortfall(typed, earlierFailedTries: record.poolAttempts.count)
        #expect(shortfall.summary == "openai/gpt-4o-mini has a 128k-token context window; this request needs about 331k: mandatory files ≈313k, the rest of the request ≈1.6k and 16k kept for the answer. This request was not sent.")
        #expect(shortfall.rows.map(\.label) == [
            "src/billing/ledger/reconciliation.ts", "src/billing/ledger/ledger-store.ts",
            "src/billing/refunds/partial-refunds.ts", "test/billing/ledger/reconciliation.test.ts",
            "src/billing/ledger/part-1.ts", "9 more files",
        ])
        #expect(shortfall.rows.map(\.size) == ["≈93k", "≈72k", "≈49k", "≈35k", "≈6.5k", "≈58k"])
        #expect(record.nextActions == [
            "Choose a model with a larger context window",
            "Reduce context.mandatory_files in the project's .claudexor/config.yaml",
            "Or use a harness that reads project files itself",
        ])
        // The engine's complete sentence is kept, unparsed, as the summary's help.
        #expect(task.engineError?.contains("raw_context_exceeds_window: the raw request for \"openai/gpt-4o-mini\"") == true)
        #expect(RunFacts.shortfall(typed, earlierFailedTries: 2).summary.hasSuffix(
            "This retry was not sent; 2 earlier tries failed."))
        // The chat card is composed from these typed facts alone.
        let card = TurnFailureCard(run: task, reason: task.engineError ?? "", openRun: {})
        #expect(card.title == refusal.title && card.refused && card.category == "validation")
        #expect(card.shortfall == shortfall && card.nextActions == record.nextActions)
        #expect(card.reason == task.engineError)
        // A refusal without typed sizes keeps the engine's sentence as its body.
        var untyped = task
        untyped.failureRecord = nil
        let plain = TurnFailureCard(run: untyped, reason: "engine text", openRun: {})
        #expect(plain.shortfall == nil && plain.nextActions.isEmpty && plain.refused)
    }

    @MainActor
    @Test func aMissingModelIsNotSentAndARefusedPatchSaysNothingAboutSending() {
        // #395: no model chosen is refused before any request.
        #expect(RunFacts.refusal(code: "model_selection_required")
            == RunFacts.Refusal(title: "Not sent: no model is selected for this harness",
                                fact: "Not sent: no model selected", chip: "Not sent"))
        // #551: a refused raw patch is named, but is no "Not sent" refusal: the same
        // code can follow a paid answer.
        var run = TaskRun(
            id: "run-2", title: "t", prompt: "p", mode: .agent, phase: .failed, project: "billing-worker",
            harnesses: [.openrouter], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, routeProof: .unverified, attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [])
        run.failureCode = "raw_patch_apply_failed"
        #expect(RunFacts.refusal(run) == nil)
        let card = TurnFailureCard(run: run, reason: "raw_patch_apply_failed: does not apply", openRun: {})
        #expect(card.title == "Patch refused: it does not apply to the candidate" && !card.refused)
        #expect(RunFacts.patchRefusalTitle(code: "raw_context_exceeds_window") == nil)

        // Every typed patch code is named, on the failed turn's card even when an
        // earlier round left output; none claims anything about sending or paying.
        let titles = [
            "raw_patch_apply_failed": "Patch refused: it does not apply to the candidate",
            "raw_patch_outside_scope": "Patch refused: it touches a path outside its packet",
            "raw_patch_stale_preimage": "Patch refused: it edits a file version its packet did not hold",
            "raw_patch_path_traversal": "Patch refused: it names an invalid path",
            "raw_patch_binary_unsupported": "Patch refused: binary changes are not accepted",
            "raw_patch_truncated": "Patch refused: the answer was not a complete patch",
            "raw_patch_missing_evidence": "Patch refused: its packet or evidence is missing",
            "raw_patch_digest_mismatch": "Patch refused: its bytes do not match their digest",
            "raw_patch_base_mismatch": "Patch refused: the candidate is not the tree its packet described",
            "raw_patch_requires_isolation": "Patch refused: it can only apply in an isolated copy",
        ]
        run.artifactPaths = ["final/patch.diff"]
        #expect(run.hasPatchArtifact)
        for (code, title) in titles {
            #expect(RunFacts.patchRefusalTitle(code: code) == title)
            run.failureCode = code
            #expect(TurnFailureCard.namesRefusal(run), "\(code)")
            #expect(RunFacts.refusal(run) == nil, "\(code)")
        }
        // A refusal the patch labels do not own keeps its card rule; other failures
        // with output, and a run that did not fail, gain no card.
        run.failureCode = "model_selection_required"
        #expect(TurnFailureCard.namesRefusal(run))
        run.failureCode = "harness_failed"
        #expect(!TurnFailureCard.namesRefusal(run))
        run.failureCode = "raw_patch_apply_failed"
        run.phase = .succeeded
        #expect(!TurnFailureCard.namesRefusal(run))
    }

    /// A real run whose first try never reached the endpoint (it was down
    /// before that POST: the fake received no POST at all) and whose retry was
    /// refused over a smaller window. The record lists the first try, which is
    /// no proof it was sent, so no label says it was.
    @MainActor
    @Test func aRetryAfterAnUnsentTryNeverCallsThatTrySent() throws {
        let task = AppModel.liveTask(from: try Self.realSummary("unsentRetry"))
        let record = try #require(task.failureRecord)
        #expect(record.poolAttempts.map(\.error) == ["fetch failed"])
        #expect(RunFacts.refusal(task)?.title == "Retry not sent: the request doesn't fit the model's context window")
        let summary = try #require(TurnFailureCard(run: task, reason: task.engineError ?? "", openRun: {}).shortfall?.summary)
        #expect(summary.hasSuffix("This retry was not sent; 1 earlier try failed."))
        #expect(!summary.contains("was sent") && !summary.contains("were sent"))
    }

    // MARK: Helpers

    private struct Captured {
        let method: String
        let path: String
        let json: [String: Any]
    }

    private static func json<T: Encodable>(_ value: T) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    /// Runs one client call against a stub that records the request and answers
    /// with a thread row, so the captured bytes are what GatewayClient sent.
    private static func capturedBody(_ call: (GatewayClient) async throws -> Void) async throws -> Captured {
        let recorder = RoutingRequestRecorder()
        RoutingRequestStubURLProtocol.handler = { request in
            recorder.record(request)
            let row = #"{"id":"th-1","title":"Retry flaky invoice sync","repoRoot":"/work/billing-worker","mode":"agent","workspaceMode":"in_place","authPreference":"auto","primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-10-29T00:00:00Z","updatedAt":"2026-10-29T00:00:00Z"}"#
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            return (response, Data(row.utf8))
        }
        defer { RoutingRequestStubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RoutingRequestStubURLProtocol.self]
        try await call(GatewayClient(baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
                                     session: URLSession(configuration: config)))
        let request = try #require(recorder.last)
        return Captured(
            method: request.method, path: request.path,
            json: try #require(JSONSerialization.jsonObject(with: request.body) as? [String: Any]))
    }
}

private final class RoutingRequestRecorder: @unchecked Sendable {
    struct Request {
        let method: String
        let path: String
        let body: Data
    }

    private let lock = NSLock()
    private var requests: [Request] = []

    func record(_ request: URLRequest) {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                body.append(buffer, count: count)
            }
        }
        let entry = Request(method: request.httpMethod ?? "", path: request.url?.path ?? "", body: body)
        lock.withLock { requests.append(entry) }
    }

    var last: Request? { lock.withLock { requests.last } }
}

private final class RoutingRequestStubURLProtocol: URLProtocol {
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
