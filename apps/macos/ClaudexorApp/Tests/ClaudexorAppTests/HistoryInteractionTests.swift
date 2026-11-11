import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

extension HistoryGatewayTests {
@MainActor @Suite(.serialized)
struct HistoryInteractionTests {
    nonisolated static let locations: [ExecutionLocationID] = [.local, .remote(UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!)]

    static func question(runID: String) -> PendingInteraction {
        PendingInteraction(interactionId: "interaction-1", runId: runID, attemptId: nil,
            harnessId: "codex", sourceTool: "request_user_input", questions: [
                InteractionQuestion(id: "q", question: "Which approach?", header: nil,
                    options: [InteractionOption(label: "Keep", description: nil)], multiSelect: true)
            ], requestedAt: "2026-10-27T00:00:00Z", timeoutAt: nil)
    }

    static func request(seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "interaction.requested", event: .object([
            "type": .string("interaction.requested"), "payload": .object([
                "interaction_id": .string("interaction-1"), "harness_id": .string("codex"),
                "source_tool": .string("request_user_input"), "requested_at": .string("2026-10-27T00:00:00Z"),
                "questions": .array([.object(["id": .string("q"), "question": .string("Which approach?"),
                    "multi_select": .bool(true), "options": .array([.object(["label": .string("Keep")])])])])
            ])
        ]))
    }

    @Test(arguments: locations)
    func interactionDraftSurvivesEvictionAndClearsOnlyAfterAcceptedSubmission(location: ExecutionLocationID) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 55)
        source.runs[54].phase = .running
        let question = Self.question(runID: "mock-run-54")
        source.runs[54].pendingInteractions = [question]
        let history = try source.store(location: location, loaded: true)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(location)
        model.selectedThreadId = source.detail.thread.id
        model.selectedHistory = history
        if location == .local { model.liveTasks = source.runs } else { model.remoteTasks[location] = source.runs }
        model.publishHistoryLive(source.runs[54], locationID: location)
        // These are the same bindings used by InteractionCard's text and option controls.
        let edited = history.presentation.interactionDraft(runID: question.runId, interactionID: question.id)
        edited.wrappedValue.freeText["q"] = "Keep the typed explanation"
        edited.wrappedValue.selections["q"] = ["Keep"]
        await history.earlier(retaining: 1)
        #expect(!history.mountedIDs.contains("mock-turn-54"))
        await history.jump()
        let returned = history.presentation.interactionDraft(runID: question.runId, interactionID: question.id)
        let answers = InteractionAnswerComposer.payloads(question, selections: returned.wrappedValue.selections,
            freeText: returned.wrappedValue.freeText)
        #expect(answers.first?.freeText == "Keep the typed explanation")
        #expect(answers.first?.selectedLabels == ["Keep"])
        var accepted = false
        HistoryURLProtocol.handler = { request in
            #expect(request.url?.path == "/v2/runs/mock-run-54/interactions/interaction-1/answer")
            return (200, Data("{\"accepted\":\(accepted),\"status\":\"answered\"}".utf8))
        }
        #expect(await model.answerInteraction(runId: question.runId, interactionId: question.id, answers: answers) != nil)
        #expect(!returned.wrappedValue.freeText.isEmpty)
        accepted = true
        #expect(await model.answerInteraction(runId: question.runId, interactionId: question.id, answers: answers) == nil)
        #expect(returned.wrappedValue.freeText.isEmpty && returned.wrappedValue.selections.isEmpty)
        #expect(history.renderedRun(for: history.rows.last!, live: model.task(question.runId, at: location))?.pendingInteractions.isEmpty == true)
    }

    @Test(arguments: locations)
    func detailCannotDropALiveQuestionOrResurrectAnAcknowledgedAnswer(location: ExecutionLocationID) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        let question = Self.question(runID: "mock-run-0")
        source.runs[0].pendingInteractions = [question]
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(location)
        model.selectedThreadId = source.detail.thread.id
        let history = try source.store(location: location, loaded: true)
        model.selectedHistory = history
        if location == .local { model.liveTasks = source.runs } else { model.remoteTasks[location] = source.runs }
        model.publishHistoryLive(source.runs[0], locationID: location)
        // The request is newer than the delayed snapshot's lastSeq=1.
        if location == .local { model.apply(Self.request(seq: 2), to: question.runId) }
        else { model.applyRemoteHistoryCardEvent(Self.request(seq: 2), runID: question.runId, at: location) }
        var delayed = false
        let gate = HistoryTestGate()
        HistoryURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/answer") == true {
                return (200, Data(#"{"accepted":true,"status":"answered"}"#.utf8))
            }
            guard request.url?.path == "/v2/runs/mock-run-0" else { return (404, Data()) }
            var snapshot: [String: Any] = ["summary": ["runId": question.runId, "state": "running", "mode": "agent", "outputReadyState": "pending"], "lastSeq": 1]
            if delayed {
                snapshot["pendingInteractions"] = [try source.object(question)]
                await gate.wait()
            }
            return (200, try JSONSerialization.data(withJSONObject: snapshot))
        }
        _ = await model.loadRunDetail(question.runId, locationID: location)
        #expect(model.task(question.runId, at: location)?.pendingInteractions == [question])
        #expect(history.renderedRun(for: history.rows[0], live: nil)?.pendingInteractions == [question])
        delayed = true
        let pending = Task { await model.loadRunDetail(question.runId, locationID: location) }
        try await gate.entered()
        #expect(await model.answerInteraction(runId: question.runId, interactionId: question.id, answers: []) == nil)
        gate.release()
        _ = await pending.value
        #expect(model.task(question.runId, at: location)?.pendingInteractions.isEmpty == true)
        #expect(history.renderedRun(for: history.rows[0], live: nil)?.pendingInteractions.isEmpty == true)
    }

    @Test(arguments: ["interaction.answered", "interaction.withdrawn", "interaction.timeout"], locations)
    func streamResolutionClearsThePublishedQuestion(type: String, location: ExecutionLocationID) throws {
        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        source.runs[0].pendingInteractions = [Self.question(runID: "mock-run-0")]
        let history = try source.store(location: location, loaded: true)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(location)
        model.selectedHistory = history
        if location == .local { model.liveTasks = source.runs } else { model.remoteTasks[location] = source.runs }
        model.publishHistoryLive(source.runs[0], locationID: location)
        func apply(_ event: BusEnvelope) {
            if location == .local { model.apply(event, to: "mock-run-0") }
            else { model.applyRemoteHistoryCardEvent(event, runID: "mock-run-0", at: location) }
        }
        apply(BusEnvelope(seq: 2, kind: type, event: .object([
            "type": .string(type), "payload": .object(["interaction_id": .string("interaction-1")])
        ])))
        #expect(history.renderedRun(for: history.rows[0], live: nil)?.pendingInteractions.isEmpty == true)
        apply(BusEnvelope(seq: 3, kind: "route.profile.rotated", event: .object([
            "type": .string("route.profile.rotated"), "payload": .object(["to_profile_id": .string("account-b")])
        ])))
        #expect(history.renderedRun(for: history.rows[0], live: nil)?.attentionNote?.contains("account-b") == true)
    }
}

}
