import Foundation
import Testing
@testable import ClaudexorKit

/// #146/#393: optional model metadata and the typed failed-read problem decode
/// compatibly; absence stays unknown and a failed read is never an empty catalog.
@Suite struct ModelCatalogWireTests {
    @Test func catalogMetadataDecodesVerbatimAndAbsenceStaysUnknown() throws {
        let json = #"""
        {"harnessId":"openrouter","source":"api","verifiedAgainst":null,"models":[
          {"id":"qwen/qwen3-coder","label":"Qwen: Qwen3 Coder","context_window":262144,"input_modalities":["text"],"max_output_tokens":65536},
          {"id":"anthropic/claude-opus-5.5","label":null,"context_window":200000,"input_modalities":["text","image","file"]},
          {"id":"vendor/legacy","context_window":null}
        ]}
        """#
        let response = try JSONDecoder().decode(HarnessModelsResponse.self, from: Data(json.utf8))
        #expect(response.problem == nil && response.canEnumerate)
        let textOnly = try #require(response.models.first)
        #expect(textOnly.inputModalities == ["text"] && textOnly.maxOutputTokens == 65536)
        #expect(textOnly.catalogDeclaresNoImageInput)
        #expect(!response.models[1].catalogDeclaresNoImageInput && response.models[1].maxOutputTokens == nil)
        #expect(response.models[2].inputModalities == nil && !response.models[2].catalogDeclaresNoImageInput)
        // An empty list is not a "no input" claim.
        let empty = try JSONDecoder().decode(HarnessModel.self, from: Data(#"{"id":"m","input_modalities":[]}"#.utf8))
        #expect(empty.inputModalities == nil && !empty.catalogDeclaresNoImageInput)
    }

    @Test func failedLiveReadIsATypedProblemNotAnEmptyCatalog() throws {
        // The exact engine answer for a failed OpenRouter read (raw-api-model-truth.test.ts).
        let json = #"""
        {"harnessId":"openrouter","models":[],"source":"api","verifiedAgainst":null,"problem":{"code":"model_catalog_unavailable","message":"the live model catalog could not be read (http_status; HTTP 503: upstream down)","retryable":true,"fieldErrors":{},"requiredActions":[],"evidenceRefs":[],"context":{"cause":"http_status","httpStatus":503}}}
        """#
        let response = try JSONDecoder().decode(HarnessModelsResponse.self, from: Data(json.utf8))
        let problem = try #require(response.problem)
        #expect(problem.code == "model_catalog_unavailable" && problem.retryable)
        #expect(response.problemCause == "http_status")
        #expect(!response.canEnumerate && response.models.isEmpty && response.source == "api")
        let roundTrip = try JSONDecoder().decode(
            HarnessModelsResponse.self, from: JSONEncoder().encode(response))
        #expect(roundTrip == response)
    }

    @Test func settingsFieldShowsAFailedReadAsUnavailableNeverAsAbsent() throws {
        let failed = HarnessModelsResponse(
            harnessId: "openrouter", models: [], source: "api",
            problem: ControlProblem(code: "model_catalog_unavailable",
                                    message: "the live model catalog could not be read (timeout)",
                                    retryable: true, context: ["cause": .string("timeout")]))
        // A stored override is not "not in this harness's model list": the list was never read.
        #expect(modelFieldState(models: failed, modelDraft: "qwen/qwen3-coder", loadFailed: false) == .unavailableWithDraft)
        #expect(modelFieldState(models: failed, modelDraft: "", loadFailed: false) == .unavailable)
        // An ANSWERED empty truth source keeps its meaning.
        let none = HarnessModelsResponse(harnessId: "openrouter", models: [], source: "none")
        #expect(modelFieldState(models: none, modelDraft: "qwen/qwen3-coder", loadFailed: false) == .refusedLegacy)
        #expect(modelFieldState(models: none, modelDraft: "", loadFailed: false) == .defaultOnly)
    }

    @Test func olderEnginesWithoutTheNewFieldsStillDecode() throws {
        let json = #"{"harnessId":"codex","models":[{"id":"gpt-5.5"}],"source":"manifest","verifiedAgainst":"0.137.0"}"#
        let response = try JSONDecoder().decode(HarnessModelsResponse.self, from: Data(json.utf8))
        #expect(response.problem == nil && response.problemCause == nil && response.canEnumerate)
        #expect(response.models.first?.inputModalities == nil && response.models.first?.maxOutputTokens == nil)
        #expect(response.routingVariants.isEmpty && response.row(forModel: "gpt-5.5:nitro") == nil)
    }

    /// The same cases as core `catalogRowFor` (packages/core/src/model.test.ts).
    @Test func declaredRoutingVariantsResolveToTheirListedRowOnly() throws {
        let json = #"""
        {"harnessId":"openrouter","source":"api","verifiedAgainst":null,
         "routingVariants":[{"suffix":":nitro","billing":"service_tier"},{"suffix":":floor","billing":"service_tier"},{"suffix":":exacto","billing":"base"}],
         "models":[{"id":"openai/gpt-5.2","context_window":400000},{"id":"vendor/laguna:free","context_window":32768}]}
        """#
        let response = try JSONDecoder().decode(HarnessModelsResponse.self, from: Data(json.utf8))
        #expect(response.routingVariants.map(\.suffix) == [":nitro", ":floor", ":exacto"])
        #expect(response.row(forModel: "openai/gpt-5.2")?.id == "openai/gpt-5.2")
        #expect(response.row(forModel: "openai/gpt-5.2:nitro")?.contextWindow == 400000)
        #expect(response.row(forModel: "openai/gpt-5.2:nitro:exacto")?.id == "openai/gpt-5.2")
        #expect(response.row(forModel: "vendor/laguna:free:nitro")?.contextWindow == 32768)
        #expect(response.row(forModel: "vendor/laguna:nitro:free")?.contextWindow == 32768)
        for unresolved in ["openai/gpt-5.2:nitro:free", "openai/gpt-5.2:online", "openai/gpt-9:nitro", ":nitro", ""] {
            #expect(response.row(forModel: unresolved) == nil, "\(unresolved)")
        }
    }

    @Test func rawContextFactsDecodeFromTheSummaryAndTheFailureRecord() throws {
        let failure = #"""
        {"phase":"convergence","category":"validation","code":"raw_context_exceeds_window","safeMessage":"refused",
         "rawContextShortfall":{"model":"vendor/m","context_window":128000,"packet_tokens":314915,"framing_tokens":119,
           "output_allowance_tokens":16384,"mandatory_files":[{"path":"a.ts","estimated_tokens":92975},{"path":"AGENTS.md","estimated_tokens":6108}]}}
        """#
        let record = try JSONDecoder().decode(RunFailureInfo.self, from: Data(failure.utf8))
        let shortfall = try #require(record.rawContextShortfall)
        #expect(shortfall.neededTokens == 314915 + 119 + 16384)
        #expect(shortfall.mandatoryTokens == 92975 + 6108)
        #expect(shortfall.otherRequestTokens == 314915 + 119 - 92975 - 6108)
        let older = try JSONDecoder().decode(RunFailureInfo.self, from: Data(#"{"safeMessage":"x"}"#.utf8))
        #expect(older.rawContextShortfall == nil)

        let summary = #"""
        {"runId":"run-1","state":"succeeded","rawContext":{"model":"vendor/m","estimated_request_tokens":158954,
         "budget":{"estimator":"chars_div_4","basis":"model_context_window","model":"vendor/m","context_window":200000,
           "output_allowance_tokens":16384,"framing_tokens":109,"selection_limit_tokens":183507,
           "estimated_packet_tokens":158846,"omitted_for_budget":3,"mandatory_paths":["AGENTS.md"]}}}
        """#
        let raw = try #require(try JSONDecoder().decode(RunSummary.self, from: Data(summary.utf8)).rawContext)
        #expect(raw.checkedWindow == 200000 && raw.budget.omittedForBudget == 3)
        let unrelated = try JSONDecoder().decode(RunSummary.self, from: Data(#"{"runId":"r","state":"failed"}"#.utf8))
        #expect(unrelated.rawContext == nil)
    }
}
