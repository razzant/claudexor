import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

extension HistoryGatewayTests {
@MainActor @Suite(.serialized)
struct HistorySnapshotOrderingTests {
    @Test(arguments: HistoryInteractionTests.locations, [true, false])
    func stopReceiptReleasesComposerWhileTheEngineOwnsTheCard(location: ExecutionLocationID, hydrated: Bool) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        let id = source.runs[0].id
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(location)
        let thread = source.detail.thread.id
        model.selectedThreadId = thread
        model.selectedHistory = try source.store(location: location, loaded: true)
        func installRunningRow() {
            if location == .local { model.liveTasks = source.runs }
            else { model.remoteTasks[location] = source.runs }
        }
        if hydrated { installRunningRow() }
        var controlStatus = 409, engineState = "running"
        HistoryURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v2/runs/\(id)/control"):
                return (controlStatus, Data(#"{"error":"run is failed; cancel has nothing to stop"}"#.utf8))
            case ("GET", "/v2/runs/\(id)"):
                return (200, Data(#"{"summary":{"runId":"\#(id)","state":"\#(engineState)","mode":"ask","spendUsd":7,"outputReadyState":"diagnostic"},"lastSeq":9}"#.utf8))
            default: return (404, Data())
            }
        }
        #expect(model.selectedHeadRunId == id && model.composerTurnState == .busy)
        await model.cancel(id, at: location, threadId: thread)
        #expect(model.threadStatus?.contains("cancel has nothing to stop") == true)
        #expect(model.composerTurnState == .busy)
        #expect(model.selectedHistory?.stopHoldRetry == nil)
        controlStatus = 200
        await model.cancel(id, at: location, threadId: thread)
        #expect(model.composerTurnState == .idle)
        #expect(model.task(id, at: location)?.phase == (hydrated ? .running : nil))
        let other = try #require(HistoryInteractionTests.locations.first { $0 != location })
        #expect(!model.wasRunCancelled(id, at: other))
        if !hydrated { installRunningRow() }
        await model.loadRunDetail(id, locationID: location)
        #expect(model.task(id, at: location)?.phase == .running)
        #expect(model.task(id, at: location)?.spendUsd == 7)
        engineState = "cancelled"
        await model.loadRunDetail(id, locationID: location)
        #expect(model.task(id, at: location)?.phase == .cancelled)
    }

    @Test(arguments: HistoryInteractionTests.locations)
    func holdFailureAllowsExplicitStopOnTheSamePredecessorAfterItEnds(location: ExecutionLocationID) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        let id = source.runs[0].id, thread = source.detail.thread.id
        let (model, client) = ThreadHistoryIntegrationTests().makeModel(location)
        model.selectedThreadId = thread
        let history = try source.store(location: location, loaded: true)
        model.selectedHistory = history
        if location == .local { model.liveTasks = source.runs } else { model.remoteTasks[location] = source.runs }
        var posts = 0
        HistoryURLProtocol.handler = { request in
            guard request.httpMethod == "POST", request.url?.path == "/v2/runs/\(id)/control" else { return (404, Data()) }
            posts += 1
            let partial = #"{"code":"next_message_hold_failed","message":"cancel requested; Stop could not save the hold.","retryable":true,"requiredActions":["Retry the Stop to record the hold."],"context":{"cascadeRunIds":[]}}"#
            return posts == 1 ? (503, Data(partial.utf8)) : (200, Data("{}".utf8))
        }
        await model.cancel(id, at: location, threadId: thread)
        let retry = try #require(history.stopHoldRetry)
        #expect(retry.message == "cancel requested; Stop could not save the hold. Retry the Stop to record the hold.")
        #expect(retry.client === client && retry.runID == id && posts == 1)
        #expect(model.task(id, at: location)?.phase == .running && model.composerTurnState == .idle)
        model.mutateTask(id, at: location) { $0.phase = .cancelled }
        await model.cancel(retry.runID, at: history.locationID, threadId: history.threadID)
        #expect(posts == 2 && history.stopHoldRetry == nil && model.task(id, at: location)?.phase == .cancelled)
    }

    @Test(arguments: HistoryInteractionTests.locations)
    func replyNeedsTheBoundRunAndTheDeliveredSequence(location: ExecutionLocationID) throws {
        let source = try HistoryTestSource(count: 1)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(location)
        let alias = source.runs[0].id
        let canonical = "fixture-bound-run"
        let queued = try JSONDecoder().decode(RunSummary.self, from: Data(
            #"{"jobId":"\#(alias)","runId":"\#(alias)","state":"queued"}"#.utf8))
        source.runs[0] = AppModel.liveTask(from: queued)
        #expect(source.runs[0].resolvedRunId == nil)
        if location == .local { model.liveTasks = source.runs }
        else {
            model.remoteTasks[location] = source.runs
            model.liveTasks = source.runs
            model.mutateTask(alias, at: .local) { $0.resolvedRunId = "local-collision" }
        }
        func deliver(_ seq: Int, owner: String?, inner: JSONValue?) {
            var raw: [String: JSONValue] = ["type": .string("harness.event"), "payload": .object([
                "harness_id": .string("claude"), "type": .string("message"), "final": .bool(true),
                "after_stop": .bool(false), "text": .string("Reply \(seq)")
            ])]
            raw["run_id"] = owner.map(JSONValue.string)
            raw["seq"] = inner
            let frame = BusEnvelope(seq: seq, kind: "harness.event", event: .object(raw))
            if location == .local { model.apply(frame, to: alias) }
            else { model.applyRemoteHistoryCardEvent(frame, runID: alias, at: location) }
        }
        deliver(1, owner: canonical, inner: .number(1))
        deliver(2, owner: alias, inner: .number(2))
        model.mutateTask(alias, at: location) { $0.resolvedRunId = canonical }
        deliver(3, owner: "local-collision", inner: .number(3))
        deliver(4, owner: nil, inner: .number(4))
        deliver(5, owner: alias, inner: .number(5))
        deliver(6, owner: canonical, inner: .number(7))
        deliver(7, owner: canonical, inner: .null)
        deliver(8, owner: canonical, inner: nil)
        deliver(9, owner: canonical, inner: .number(9))
        #expect(model.transcript(alias, at: location)?.claudeTurnReplies.rows.map(\.text) == ["Reply 8", "Reply 9"])
    }

    @Test func terminalDetailWithNoReadableJournalKeepsOutputAndBothCursors() async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        source.runs[0].phase = .running
        model.liveTasks = source.runs
        let id = source.runs[0].id
        var state = "running", seq = 9, output = "Working"
        HistoryURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/\(id)" else { return (404, Data()) }
            return (200, Data(#"{"summary":{"runId":"\#(id)","state":"\#(state)","mode":"ask","spendUsd":7},"lastSeq":\#(seq),"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"\#(output)","truncated":false}}"#.utf8))
        }
        model.lastEventIds[id] = 3
        _ = model.ensureLiveBox(id)
        await model.loadRunDetail(id)
        state = "failed"; seq = 4; output = "Stale"
        await model.loadRunDetail(id)
        #expect(model.task(id)?.phase == .running)
        state = "succeeded"; seq = 0; output = "Final result"
        await model.loadRunDetail(id)
        #expect(model.task(id)?.phase == .succeeded)
        #expect(model.snapshotReplayFences[id] == 9 && model.lastEventIds[id] == 3)
        model.apply(BusEnvelope(seq: 8, kind: "budget.cash", event: .object([
            "type": .string("budget.cash"), "payload": .object(["cash_spend_usd": .number(99)])
        ])), to: id)
        model.apply(BusEnvelope(seq: 10, kind: "run.created", event: .object([
            "type": .string("run.created"), "payload": .object(["lifecycle": .string("running")])
        ])), to: id)
        state = "running"; seq = 10; output = "Late running snapshot"
        await model.loadRunDetail(id)
        #expect(model.task(id)?.phase == .succeeded && model.task(id)?.answerText == "Final result")
        #expect(model.liveBox(id)?.spendUsd == 7 && model.snapshotReplayFences[id] == 9)
    }

    @Test func reconnectReadsAnUndeliveredReplyBelowTheSnapshotFence() async throws {
        defer { HistoryURLProtocol.handler = nil }
        let fixture = try HistoryTestSource(count: 1)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        fixture.runs[0].phase = .running
        model.liveTasks = fixture.runs
        let id = fixture.runs[0].id
        let reconciliation = HistoryTestGate()
        var detailReads = 0
        var requestedCursor: Int?
        HistoryURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs/\(id)":
                detailReads += 1
                if detailReads == 2 { await reconciliation.wait() }
                return (200, Data(#"{"summary":{"runId":"\#(id)","state":"running","mode":"ask","spendUsd":7,"outputReadyState":"pending"},"lastSeq":9}"#.utf8))
            case "/v2/runs/\(id)/events":
                requestedCursor = request.value(forHTTPHeaderField: "Last-Event-ID").flatMap(Int.init)
                // This stub replays ONLY events newer than the client's real HTTP cursor.
                let rows = [
                    (5, "budget.cash", #"{"cash_spend_usd":99}"#),
                    (6, "run.created", #"{"lifecycle":"queued"}"#),
                    (7, "harness.event", #"{"harness_id":"claude","type":"message","final":true,"after_stop":false,"attempt_id":"a","session_id":"s","text":"Missed while disconnected"}"#),
                ]
                let frames = rows.filter { $0.0 > (requestedCursor ?? 0) }.map { seq, type, payload in
                    "id: \(seq)\nevent: \(type)\ndata: {\"run_id\":\"\(id)\",\"seq\":\(seq),\"type\":\"\(type)\",\"payload\":\(payload)}\n\n"
                }.joined()
                return (200, Data((frames + "event: end\ndata: {}\n\n").utf8))
            default: return (404, Data())
            }
        }
        model.ingestStreamEnvelope(BusEnvelope(seq: 3, kind: "budget.observation",
            event: .object(["type": .string("budget.observation")])), to: id)
        await model.loadRunDetail(id)
        #expect(model.snapshotReplayFences[id] == 9)
        #expect(model.lastEventIds[id] == 3)
        #expect((model.liveBox(id)?.transcript.claudeTurnReplies.rows ?? []).isEmpty)
        model.stream(runId: id)
        let stream = try #require(model.streamTasks[id])
        try await reconciliation.entered()
        #expect(requestedCursor == 3)
        #expect(model.liveBox(id)?.transcript.claudeTurnReplies.rows.map(\.text) == ["Missed while disconnected"])
        #expect(model.liveBox(id)?.spendUsd == 7)
        #expect(model.task(id)?.phase == .running)
        reconciliation.release()
        await stream.value
    }

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
