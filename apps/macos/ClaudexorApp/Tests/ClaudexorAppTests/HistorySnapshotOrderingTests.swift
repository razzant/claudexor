import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

extension HistoryGatewayTests {
@MainActor @Suite(.serialized)
struct HistorySnapshotOrderingTests {
    @Test(arguments: ["interaction.answered", "interaction.withdrawn", "interaction.timeout"])
    func resolutionCoveredByDetailFenceMustRetireTheQuestion(type: String) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        let question = HistoryGatewayTests.HistoryInteractionTests.question(runID: "mock-run-0")
        source.runs[0].pendingInteractions = [question]
        source.runs[0].waitingOnUser = true
        let history = try source.store(loaded: true)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        model.selectedThreadId = source.detail.thread.id
        model.selectedHistory = history
        model.liveTasks = source.runs
        model.publishHistoryLive(source.runs[0], locationID: .local)
        history.presentation.interactionDraft(runID: question.runId, interactionID: question.id).wrappedValue.freeText["q"] = "My draft"
        let gate = HistoryTestGate()
        HistoryURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/mock-run-0" else { return (404, Data()) }
            await gate.wait()
            // The authoritative snapshot includes resolution seq 7: no pending question.
            return (200, Data(#"{"summary":{"runId":"mock-run-0","state":"running","mode":"agent","waitingOnUser":false,"outputReadyState":"pending"},"pendingInteractions":[],"lastSeq":7}"#.utf8))
        }
        let read = Task { await model.loadRunDetail(question.runId, locationID: .local) }
        try await gate.entered()
        model.apply(BusEnvelope(seq: 7, kind: type, event: .object([
            "type": .string(type), "payload": .object(["interaction_id": .string(question.id)])
        ])), to: question.runId)
        #expect(model.deferredEnvelopes[question.runId]?.map(\.seq) == [7])
        gate.release()
        #expect(await read.value)
        #expect(model.deferredEnvelopes[question.runId] == nil)
        #expect(model.task(question.runId)?.pendingInteractions.isEmpty == true)
        #expect(model.task(question.runId)?.waitingOnUser == false)
        #expect(history.renderedRun(for: history.rows[0], live: nil)?.pendingInteractions.isEmpty == true)
        #expect(history.presentation.interactionDrafts[question.runId] == nil)
    }

    @Test func anOlderTailReadMustNotUndoAnAcceptedJump() async throws {
        let source = try HistoryTestSource(count: 45)
        let gate = HistoryTestGate()
        var blockTail = false
        let history = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            let snapshot = try source.page(selector, limit: limit)
            if selector == nil && blockTail { blockTail = false; await gate.wait() }
            return snapshot
        }
        await history.open()
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 46, short: true)
        blockTail = true
        let refresh = Task { await history.refresh() }
        try await gate.entered()
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 47, short: true)
        await history.jump()
        #expect(history.mountedIDs.last == "mock-turn-46")
        let accepted = history.mountedIDs
        gate.release()
        await refresh.value
        #expect(history.header?.latestTurnId == "mock-turn-46")
        #expect(history.mountedIDs == accepted)
        #expect(history.tailMounted && !history.hasNewer)
    }

    @Test func followerRecoveryMustHonorTextFocusAcquiredDuringTheRead() async throws {
        let source = try HistoryTestSource(count: 45)
        let gate = HistoryTestGate()
        var blockRecovery = false
        let history = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            let snapshot = try source.page(selector, limit: limit)
            if selector == nil && blockRecovery { blockRecovery = false; await gate.wait() }
            return snapshot
        }
        await history.open()
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 85, short: true)
        source.epoch = "new-serving-epoch"
        blockRecovery = true
        let refresh = Task { await history.refresh() }
        try await gate.entered()
        // ConversationFeed.textFocusChanged -> synchronizeReading does this,
        // without cancelNavigation (a text click is not scroll interaction).
        history.presentation.focusedMessages.insert("mock-turn-44")
        history.following = false
        history.readingAnchor = "mock-turn-44"
        gate.release()
        await refresh.value
        #expect(!history.following)
        #expect(history.mountedIDs.contains("mock-turn-44"))
        #expect(history.readingAnchor == "mock-turn-44")
    }
}

}
