import Foundation
import Testing
@testable import ClaudexorKit

/// #571: an explicit reviewer-panel entry may carry the engine's optional
/// `processingPreference` (packages/schema/src/control.ts
/// `ControlReviewerPanelEntry`, values from packages/schema/src/processing.ts
/// `ProcessingPreference`: standard | fast | economy). Decoding stays strict:
/// unknown keys and values outside that enum still fail, and the failure names
/// the field instead of being swallowed.
@Suite struct ReviewerPanelProcessingTests {
    static let allowed = ["standard", "fast", "economy"]

    @Test(arguments: allowed)
    func composerPanelRoundTripsEachProcessingPreference(_ value: String) throws {
        // Keys already in the encoder's sorted order, so the canonical form is the input.
        let raw = #"[{"harness":"codex","model":"gpt-5.5","processingPreference":"\#(value)"}]"#
        let entries = try #require(ComposerOptionParser.parseReviewerPanelJSON(raw))
        let canonical = try #require(ComposerOptionParser.reviewerPanelJSON(entries))
        #expect(canonical == raw)
        #expect(ComposerOptionParser.parseReviewerPanelJSON(canonical) == entries)
    }

    @Test func omittedProcessingPreferenceStaysAbsentOnTheWire() throws {
        let raw = #"[{"credentialProfileId":"review-codex","harness":"codex"}]"#
        let entries = try #require(ComposerOptionParser.parseReviewerPanelJSON(raw))
        #expect(ComposerOptionParser.reviewerPanelJSON(entries) == raw)
    }

    @Test func valuesOutsideTheEngineEnumAndUnknownKeysStillFail() throws {
        for bad in [#""turbo""#, #""Fast""#, #""""#, "1", "true", "{}", "[]"] {
            #expect(ComposerOptionParser.parseReviewerPanelJSON(
                #"[{"harness":"codex","processingPreference":\#(bad)}]"#) == nil, Comment(rawValue: bad))
        }
        // Spelling variants are unknown keys, and an unknown sibling still fails
        // the entry even beside a valid preference.
        #expect(ComposerOptionParser.parseReviewerPanelJSON(
            #"[{"harness":"codex","processing_preference":"fast"}]"#) == nil)
        #expect(ComposerOptionParser.parseReviewerPanelJSON(
            #"[{"harness":"codex","processingPreference":"fast","serviceTier":"priority"}]"#) == nil)
        // The decoding error is reported with the offending field.
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode([ReviewerPanelEntry].self,
                                         from: Data(#"[{"harness":"codex","processingPreference":"turbo"}]"#.utf8))
        }
        do {
            _ = try JSONDecoder().decode([ReviewerPanelEntry].self,
                                         from: Data(#"[{"harness":"codex","processingPreference":"turbo"}]"#.utf8))
        } catch {
            #expect(String(describing: error).contains("processingPreference"))
        }
    }

    /// The run list (GET /v2/runs) and run detail carry the frozen panel; one
    /// entry with a preference must not make the whole page undecodable.
    @Test func runListAndDetailDecodeAPanelCarryingProcessingPreference() throws {
        let panel = #"[{"harness":"codex","processingPreference":"economy"},{"effort":"high","harness":"claude"}]"#
        let summary = #"{"runId":"run-571","state":"succeeded","mode":"agent","review":true,"reviewerPanel":\#(panel)}"#
        let list = try JSONDecoder().decode(RunListResponse.self, from: Data(#"{"runs":[\#(summary)]}"#.utf8))
        let listed = try #require(list.runs.first?.reviewerPanel)
        #expect(ComposerOptionParser.reviewerPanelJSON(listed) == panel)

        let detail = try JSONDecoder().decode(RunDetail.self, from: Data(#"{"summary":\#(summary)}"#.utf8))
        #expect(detail.summary.reviewerPanel == listed)
    }

    /// The typed field rides both send paths (POST /v2/runs and thread turns);
    /// an entry without a preference sends no key, keeping native defaults.
    @Test func theTypedPreferenceTravelsInRunAndTurnRequests() throws {
        #expect(ProcessingPreference.allCases.map(\.rawValue) == Self.allowed)
        let entry = ReviewerPanelEntry(harness: "codex", model: "gpt-5.5", processingPreference: .fast)
        #expect(entry.processingPreference == .fast)
        #expect(ReviewerPanelEntry(harness: "codex").processingPreference == nil)
        func panel(_ body: Data) throws -> [[String: Any]] {
            let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
            return try #require(json["reviewerPanel"] as? [[String: Any]])
        }
        let run = try panel(JSONEncoder().encode(StartRunRequest(prompt: "p", reviewerPanel: [entry])))
        #expect(run.first?["processingPreference"] as? String == "fast")
        let turn = try panel(JSONEncoder().encode(ThreadTurnRequest(prompt: "p", reviewerPanel: [entry])))
        #expect(turn.first?["processingPreference"] as? String == "fast")
        let bare = try panel(JSONEncoder().encode(
            StartRunRequest(prompt: "p", reviewerPanel: [ReviewerPanelEntry(harness: "codex")])))
        #expect(bare.first.map { $0.keys.sorted() } == ["harness"])
    }

    @Test func aRunWithAnInvalidPanelPreferenceIsStillRefusedWithTheField() {
        let summary = #"{"runId":"run-571","state":"succeeded","reviewerPanel":[{"harness":"codex","processingPreference":"priority"}]}"#
        do {
            _ = try JSONDecoder().decode(RunListResponse.self, from: Data(#"{"runs":[\#(summary)]}"#.utf8))
            Issue.record("an out-of-contract processing preference decoded")
        } catch {
            let message = String(describing: error)
            #expect(message.contains("reviewerPanel"))
            #expect(message.contains("processingPreference"))
        }
    }
}
