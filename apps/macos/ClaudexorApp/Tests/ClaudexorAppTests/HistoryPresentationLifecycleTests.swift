import AppKit
import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

extension HistoryGatewayTests {
@MainActor @Suite(.serialized)
struct HistoryPresentationLifecycleTests {
    @Test(arguments: HistoryInteractionTests.locations, [6, 7])
    func snapshotRetiresOnlyRequestsItCovers(location: ExecutionLocationID, snapshotSeq: Int) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        let history = try source.store(location: location, loaded: true)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(location)
        model.selectedHistory = history
        if location == .local { model.liveTasks = source.runs } else { model.remoteTasks[location] = source.runs }
        let event = HistoryInteractionTests.request(seq: 7)
        if location == .local { model.apply(event, to: "mock-run-0") }
        else { model.applyRemoteHistoryCardEvent(event, runID: "mock-run-0", at: location) }
        let draft = history.presentation.interactionDraft(runID: "mock-run-0", interactionID: "interaction-1")
        draft.wrappedValue.freeText["q"] = "Keep only while pending"
        HistoryURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/mock-run-0" else { return (404, Data()) }
            return (200, Data("{\"summary\":{\"runId\":\"mock-run-0\",\"state\":\"running\",\"waitingOnUser\":false,\"outputReadyState\":\"pending\"},\"pendingInteractions\":[],\"lastSeq\":\(snapshotSeq)}".utf8))
        }
        #expect(await model.loadRunDetail("mock-run-0", locationID: location))
        let retained = snapshotSeq < 7
        #expect(model.task("mock-run-0", at: location)?.waitingOnUser == retained)
        #expect(history.renderedRun(for: history.rows[0], live: nil)?.pendingInteractions.count == (retained ? 1 : 0))
        #expect(draft.wrappedValue.freeText.isEmpty == !retained)
    }

    @Test(arguments: HistoryInteractionTests.locations)
    func anOlderTailReadMustNotUndoAnAcceptedSend(location: ExecutionLocationID) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 45)
        let gate = HistoryTestGate()
        var blockTail = false
        let history = ThreadHistoryStore(locationID: location, threadID: source.detail.thread.id) { selector, limit, _ in
            let snapshot = try source.page(selector, limit: limit)
            if selector == nil && blockTail { blockTail = false; await gate.wait() }
            return snapshot
        }
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(location)
        model.selectedThreadId = source.detail.thread.id
        model.selectedHistory = history
        var posts = 0
        HistoryURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/threads/\(source.detail.thread.id)/turns"):
                posts += 1
                (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 47, short: true)
                return (202, Data(#"{"jobId":"accepted-send","state":"queued"}"#.utf8))
            case ("GET", "/v2/runs"): return (200, Data(#"{"runs":[]}"#.utf8))
            case ("GET", "/v2/threads"): return (200, try JSONSerialization.data(withJSONObject: ["threads": [source.object(source.detail.thread)]]))
            default: return (404, Data())
            }
        }
        await history.open()
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 46, short: true)
        blockTail = true
        let refresh = Task { await history.refresh() }
        try await gate.entered()
        let target = TurnStartTarget.existing(locationID: location, threadID: source.detail.thread.id,
            repoRoot: nil, workspaceMode: "in_place", eligibleHarnesses: [])
        #expect(await model.composerSend(prompt: "Accepted new question", mode: .ask, target: target))
        #expect(posts == 1 && history.mountedIDs.last == "mock-turn-46")
        let accepted = history.mountedIDs
        gate.release()
        await refresh.value
        #expect(history.mountedIDs == accepted)
        #expect(history.tailMounted && !history.hasNewer)
    }

    @Test func aSupersededTailReadStillMergesUsefulFacts() async throws {
        let source = try HistoryTestSource(count: 45)
        let gate = HistoryTestGate()
        var blockTail = false
        let history = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            if selector == nil && blockTail { blockTail = false; await gate.wait() }
            return try source.page(selector, limit: limit)
        }
        await history.open()
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 46, short: true)
        blockTail = true
        let refresh = Task { await history.refresh() }
        try await gate.entered()
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 47, short: true)
        await history.jump()
        let accepted = history.mountedIDs
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 48, short: true)
        source.runs[44].answerText = "Useful fact from the superseded request"
        gate.release()
        await refresh.value
        #expect(history.mountedIDs == accepted)
        #expect(history.records["mock-turn-44"]?.primaryOutput?.text == "Useful fact from the superseded request")
        #expect(history.header?.latestTurnId == "mock-turn-47")
    }

    @Test func resolvedInteractionsAreBoundedToMountedRunsAndTheHead() async throws {
        let source = try HistoryTestSource(count: 55)
        let history = try source.store(loaded: true)
        history.resolvedInteractions = ["mock-run-35": ["old"], "mock-run-54": ["head"]]
        await history.earlier(retaining: 1)
        #expect(history.resolvedInteractions["mock-run-54"] == ["head"])
        await history.earlier(retaining: 1)
        #expect(history.resolvedInteractions["mock-run-35"] == nil)
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 56, short: true)
        await history.refresh()
        #expect(history.resolvedInteractions.isEmpty)
    }

    @Test func laterReachingTheTailPinsToTheBottomAndFollows() async throws {
        let history = try HistoryTestSource(count: 45).store(loaded: true)
        await history.earlier(retaining: 10)
        #expect(!history.tailMounted && !history.following)
        await history.later()
        let viewport = ConversationFeedState()
        viewport.navigate(history)
        #expect(history.tailMounted && history.following && history.readingAnchor == nil)
        #expect(viewport.navigationTarget == ConversationFeedState.bottomID)
        #expect(viewport.navigationAnchor == .bottom && viewport.follows)
    }

    @Test(arguments: [false, true])
    func travelCountsArrivalsFirstObservedWhileLeavingFollowing(recovery: Bool) async throws {
        let source = try HistoryTestSource(count: 45)
        let history = try source.store(loaded: true)
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 48, short: true)
        if recovery { source.epoch = "travel-recovery" }
        await history.earlier(retaining: 8)
        #expect(!history.following && history.newCount == 3)
        await history.refresh()
        #expect(history.newCount == 3)
    }

    @Test func dismantlingProseReportsSelectionAndFocusCleared() {
        let presentation = ConversationPresentation()
        let key = "mock-turn-44:answer-document"
        let coordinator = ProseText.Coordinator()
        let view = ProseTextView.make()
        coordinator.selectionChanged = { selected in
            if selected { presentation.selectedMessages.insert(key) }
            else { presentation.selectedMessages.remove(key) }
        }
        view.focusChanged = { focused in
            if focused { presentation.focusedMessages.insert(key) }
            else { presentation.focusedMessages.remove(key) }
        }
        coordinator.selectionChanged?(true)
        view.focusChanged?(true)
        #expect(presentation.selectedMessages == [key] && presentation.focusedMessages == [key])
        ProseText.dismantleNSView(view, coordinator: coordinator)
        #expect(presentation.selectedMessages.isEmpty && presentation.focusedMessages.isEmpty)
    }
}
}
