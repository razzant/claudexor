import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// #253 and the rest of the engine's `RunReason` vocabulary, and the D-16
/// `work_state` veto, read the way a surface receives them: terminal frames
/// folded by `AppModel.apply`, and history rows decoded by `ThreadHistoryPage`
/// and mapped by `HistoryRunPresentation`. The facts come from the generated
/// producer fixtures (`ProducerWire`); pixels are in `RunStateRenderTests`.
@MainActor @Suite struct RunReasonPresentationTests {
    // MARK: Vocabulary parity with the generated wire schema

    /// The generated JSON Schema of the run-list DTO is the reason vocabulary's
    /// source of truth; a reason the engine can send must have words here.
    @Test func everyEngineRunReasonHasADisplayLabel() throws {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // ClaudexorAppTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // ClaudexorApp
            .deletingLastPathComponent()  // macos
            .deletingLastPathComponent()  // apps
            .deletingLastPathComponent()  // repo root
        let data = try Data(contentsOf: repoRoot.appendingPathComponent(
            "packages/schema/generated/ControlRunSummary.schema.json"))
        func object(_ value: Any?) throws -> [String: Any] { try #require(value as? [String: Any]) }
        func first(_ value: Any?) throws -> [String: Any] { try #require((value as? [Any])?.first as? [String: Any]) }
        let schema = try object(try JSONSerialization.jsonObject(with: data))
        let summary = try object(try object(schema["definitions"])["ControlRunSummary"])
        let facts = try first(try object(try object(summary["properties"])["outcomeFacts"])["anyOf"])
        let reason = try object(try object(facts["properties"])["reason"])
        let reasons = try #require(try first(reason["anyOf"])["enum"] as? [String])
        #expect(reasons.contains("user_cancelled"))
        let unlabeled = reasons.filter { RunReasonLabel.known($0) == nil }
        #expect(unlabeled.isEmpty, "engine reasons without a macOS label: \(unlabeled)")
        // The unfinished-work states the card names come from the same schema.
        let workState = try object(try object(facts["properties"])["work_state"])
        let states = try #require(try object(try object(workState["properties"])["state"])["enum"] as? [String])
        #expect(Set(states) == ["completed", "needs_input", "incomplete", "unverified"])
        #expect(states.filter { RunReasonLabel.workStateLabel($0) != nil }.sorted() == ["incomplete", "needs_input"])
    }

    // MARK: Fixtures

    private static let runId = "run-253"

    private static func liveRun(phase: RunPhase) -> TaskRun {
        TaskRun(id: runId, title: "Run", prompt: "", mode: .agent, phase: phase,
                project: "Project", harnesses: [.codex], n: 1,
                createdAt: .now, updatedAt: .now,
                spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
                routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
                candidates: [], findings: [], diff: [])
    }

    /// One terminal frame as the engine journals it (`log.emit(type, { lifecycle, facts, … })`).
    private static func frame(_ type: String, _ facts: JSONValue) -> BusEnvelope {
        BusEnvelope(seq: 9, kind: type, event: .object([
            "seq": .number(9), "ts": .string("2026-11-01T00:00:09.000Z"),
            "run_id": .string(runId), "task_id": .string("task-253"),
            "type": .string(type),
            "payload": .object([
                "lifecycle": facts["lifecycle"] ?? .null,
                "facts": facts,
                "reason": facts["reason"] ?? .null,
            ]),
        ]))
    }

    /// Fold a frame into a live row already at its lifecycle: a phase transition
    /// would post a system notification from the test process, and the flip is
    /// not what these tests pin.
    private static func fold(_ type: String, _ facts: JSONValue) -> TaskRun {
        let model = AppModel(requestNotificationAuthorization: false, loadPersistedState: false)
        model.liveTasks = [liveRun(phase: RunPhase(api: facts["lifecycle"]?.stringValue ?? ""))]
        model.apply(frame(type, facts), to: runId)
        return model.liveTasks[0]
    }

    private static func editing(_ value: JSONValue, _ edit: (inout [String: JSONValue]) -> Void) throws -> JSONValue {
        guard case .object(var object) = value else { throw CocoaError(.coderReadCorrupt) }
        edit(&object)
        return .object(object)
    }

    /// The receipt row's own line and chip (`TurnReceiptRow` calls the same owners).
    private static func card(_ run: TaskRun) -> (line: TurnPresentation.StatusLine, chip: TurnPresentation.Attention?) {
        (TurnPresentation.statusLine(for: run), TurnPresentation.attention(for: run))
    }

    private static func historyRun(_ turnID: String, page: ThreadHistoryPage? = nil) throws -> TaskRun {
        let page = try page ?? ProducerWire.page()
        let run = HistoryRunPresentation.task(try ProducerWire.row(page, turnID), thread: page.header.thread)
        return try #require(run)
    }

    // MARK: The terminal frame and the DTO read the same facts

    /// The frame goes through the one wire decoder, so `review_requested` and
    /// the whole `work_state` survive exactly as a detail read has them.
    @Test(arguments: ["outcome-facts-work-veto", "outcome-facts-work-veto-review-blocked",
                      "outcome-facts-clean", "outcome-facts-needs-decision", "outcome-facts-failed"])
    func aTerminalFrameCarriesExactlyTheDTOsFacts(_ name: String) throws {
        let value = try ProducerWire.value(name)
        let decoded = try ProducerWire.decode(RunOutcomeFacts.self, value)
        let framed = AppModel.terminalOutcomeFacts(
            from: .object(["facts": value]), expectedLifecycle: value["lifecycle"]?.stringValue)
        #expect(framed == decoded)
        #expect(framed?.reviewRequested == decoded.reviewRequested)
    }

    /// A repeated terminal frame cannot rewrite the facts a detail read hydrated.
    @Test func aRepeatedTerminalFrameLeavesHydratedFactsAlone() throws {
        let value = try ProducerWire.value("outcome-facts-work-veto")
        let model = AppModel(requestNotificationAuthorization: false, loadPersistedState: false)
        var row = Self.liveRun(phase: .succeeded)
        let stamp = Date(timeIntervalSince1970: 1_000)
        row.outcomeFacts = try ProducerWire.decode(RunOutcomeFacts.self, value)
        row.updatedAt = stamp
        model.liveTasks = [row]
        model.apply(Self.frame("run.blocked", value), to: Self.runId)
        #expect(model.liveTasks[0].outcomeFacts?.reviewRequested == false)
        #expect(model.liveTasks[0].updatedAt == stamp)
    }

    /// `work_state.state` is a plain string through both readers: a state a newer
    /// engine adds decodes the same way and vetoes nothing.
    @Test func aFutureWorkStateDecodesThroughBothReadersAndVetoesNothing() throws {
        let value = try Self.editing(try ProducerWire.value("outcome-facts-work-veto")) { facts in
            facts["reason"] = .null
            if case .object(var work)? = facts["work_state"] {
                work["state"] = .string("paused_for_audit")
                facts["work_state"] = .object(work)
            }
        }
        let decoded = try ProducerWire.decode(RunOutcomeFacts.self, value)
        #expect(decoded.workState?.state == "paused_for_audit")
        #expect(AppModel.terminalOutcomeFacts(from: .object(["facts": value]), expectedLifecycle: "succeeded") == decoded)
        let run = Self.fold("run.completed", value)
        #expect(run.unfinishedWorkLabel == nil)
        #expect(Self.card(run).chip == nil)
    }

    @Test func aMalformedWorkStateRejectsTheFrameFactsInsteadOfGuessing() throws {
        let value = try Self.editing(try ProducerWire.value("outcome-facts-work-veto")) { facts in
            facts["work_state"] = .string("needs_input")
        }
        #expect(AppModel.terminalOutcomeFacts(from: .object(["facts": value]), expectedLifecycle: "succeeded") == nil)
    }

    // MARK: Reasons in their own words

    @Test func hostStopsKeepTheirProvenanceFromTheWireToTheCard() throws {
        let run = try Self.historyRun("turn-host-stopped")
        #expect(run.phase == .cancelled)
        let card = Self.card(run)
        // Cancelled stays a quiet terminal: no loud chip, its own state word.
        #expect(card.chip == nil)
        #expect(card.line.stateWord == "Stopped by host")
        #expect(run.terminalWord == "Stopped by host")
        #expect(RunOutcomeSection.bannerTone(for: run) == .neutral)
    }

    /// A reason this build has no words for still qualifies the terminal: it is
    /// spelled from its code, in the neutral quiet slot, and never reads "Done".
    @Test func anUnknownReasonIsShownInItsOwnWordsAndNeverAsDone() throws {
        let future = "future_reason_code"
        let clean = try ProducerWire.value("outcome-facts-clean")
        let succeeded = Self.fold("run.completed", try Self.editing(clean) { $0["reason"] = .string(future) })
        #expect(Self.card(succeeded).chip == nil)
        #expect(Self.card(succeeded).line.stateWord == "Future reason code")
        #expect(succeeded.terminalWord == "Future reason code")
        #expect(succeeded.terminalTone == .neutral)
        #expect(RunOutcomeSection.bannerTone(for: succeeded) == .neutral)

        let history = try Self.historyRun("turn-clean", page: try ProducerWire.page(editingFactsOf: "turn-clean") {
            $0["reason"] = .string(future)
        })
        #expect(Self.card(history).line.stateWord == "Future reason code")

        let failed = Self.fold("run.failed", try Self.editing(try ProducerWire.value("outcome-facts-failed")) {
            $0["reason"] = .string(future)
        })
        #expect(Self.card(failed).chip == TurnPresentation.Attention(text: "Future reason code", tone: .failure))
        #expect(TurnFailureCard(run: failed, reason: "reason", openRun: {}).title == "Future reason code")
        #expect(RunOutcomeSection.bannerTone(for: failed) == .negative)

        // No reason at all is a clean success, and stays one.
        let done = Self.fold("run.completed", clean)
        #expect(Self.card(done).line.stateWord == RunPhase.succeeded.label)
        #expect(done.terminalTone == .positive)
    }

    // MARK: Unfinished work leads review and checks, as on the server

    /// The server refuses a risk decision on unfinished work before it looks at
    /// review or checks (`acceptRiskDecision`), so the chip names the work even
    /// when arbitration gave the reason to review or checks.
    @Test func unfinishedWorkLeadsTheCardWhateverTheReason() throws {
        let cases: [(turn: String, word: String, decision: Bool)] = [
            ("turn-needs-input", "Needs input", false),
            ("turn-incomplete-review-blocked", "Incomplete", true),
            ("turn-needs-input-checks-failed", "Needs input", true),
        ]
        for item in cases {
            let run = try Self.historyRun(item.turn)
            #expect(run.phase == .succeeded, Comment(rawValue: item.turn))
            // The risk-overridable axis stays its own fact.
            #expect(run.reviewNeedsDecision == item.decision, Comment(rawValue: item.turn))
            #expect(run.unfinishedWorkLabel == item.word, Comment(rawValue: item.turn))
            let card = Self.card(run)
            #expect(card.chip == TurnPresentation.Attention(text: item.word, tone: .warning), Comment(rawValue: item.turn))
            #expect(card.line.stateWord == nil, Comment(rawValue: item.turn))
            // The bar stays where review or checks gate it, without the two
            // decisions the server would refuse with 409.
            #expect(DecisionApplyPresentation.showsDecisionBar(run, riskAccepted: false) == item.decision, Comment(rawValue: item.turn))
            #expect(!DecisionApplyPresentation.offersRiskDecisions(run), Comment(rawValue: item.turn))
            #expect(run.terminalWord == item.word, Comment(rawValue: item.turn))
            #expect(run.terminalTone == .caution, Comment(rawValue: item.turn))
            #expect(RunOutcomeSection.bannerTone(for: run) == .caution, Comment(rawValue: item.turn))
        }
        // The two controls: a plain review gate and a clean success.
        let gateRun = try Self.historyRun("turn-review-gate")
        #expect(Self.card(gateRun).chip == TurnPresentation.Attention(text: "Needs you", tone: .warning))
        #expect(DecisionApplyPresentation.showsDecisionBar(gateRun, riskAccepted: false))
        #expect(DecisionApplyPresentation.offersRiskDecisions(gateRun))
        let cleanRun = try Self.historyRun("turn-clean")
        #expect(Self.card(cleanRun).chip == nil)
        #expect(Self.card(cleanRun).line.stateWord == RunPhase.succeeded.label)
        #expect(!DecisionApplyPresentation.showsDecisionBar(cleanRun, riskAccepted: false))
        #expect(cleanRun.terminalTone == .positive)
        #expect(RunOutcomeSection.bannerTone(for: cleanRun) == .positive)
    }

    /// A blocked review or failed checks is a caution on the compact rows' dot as on
    /// the banner, before and after a recorded risk decision; only a lifecycle that
    /// is not a success keeps its own tone.
    @Test func aQualifyingReasonNeverGetsAGreenDot() throws {
        var gate = try Self.historyRun("turn-review-gate")
        #expect(gate.reviewNeedsDecision)
        #expect(gate.terminalTone == .caution)
        #expect(RunOutcomeSection.bannerTone(for: gate) == .caution)
        gate.operatorDecisionAction = "accept_risk"
        #expect(!gate.reviewNeedsDecision)
        #expect(gate.terminalTone == .caution, "the review stays blocked after the decision")

        let clean = try ProducerWire.value("outcome-facts-clean")
        var checks = Self.fold("run.completed", try Self.editing(clean) {
            $0["checks"] = .string("failed")
            $0["reason"] = .string("checks_failed")
        })
        #expect(checks.terminalWord == "Checks failed")
        #expect(checks.terminalTone == .caution)
        checks.operatorDecisionAction = "accept_risk"
        #expect(checks.terminalTone == .caution)
        #expect(RunOutcomeSection.bannerTone(for: checks) == .caution)

        let noChanges = Self.fold("run.completed", try Self.editing(clean) { $0["reason"] = .string("no_changes") })
        #expect(noChanges.terminalWord == "No changes")
        #expect(noChanges.terminalTone == .positive, "no changes qualifies nothing")
    }

    @Test func interruptedAndFailedReasonsNameTheirCause() throws {
        let context = Self.fold("run.failed", try Self.editing(try ProducerWire.value("outcome-facts-failed")) {
            $0["lifecycle"] = .string("interrupted")
            $0["reason"] = .string("context_capacity_exhausted")
        })
        #expect(Self.card(context).chip == TurnPresentation.Attention(text: "Context capacity exhausted", tone: .failure))
        #expect(Self.card(context).line.stateWord == nil)
        let contract = Self.fold("run.failed", try Self.editing(try ProducerWire.value("outcome-facts-failed")) {
            $0["reason"] = .string("work_report_contract")
        })
        #expect(Self.card(contract).chip == TurnPresentation.Attention(text: "No valid work report", tone: .failure))
        #expect(TurnFailureCard(run: contract, reason: "reason", openRun: {}).title == "No valid work report")
    }
}
