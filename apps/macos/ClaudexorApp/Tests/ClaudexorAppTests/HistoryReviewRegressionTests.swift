import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@MainActor @Suite(.serialized)
struct HistoryReviewRegressionTests {
    @Test(arguments: [ExecutionLocationID.local, ExecutionLocationID.remote(UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!)])
    func aPublishedActiveSnapshotMustNotHideANewerInteraction(location: ExecutionLocationID) async throws {
        let source = try HistoryTestSource(count: 1)
        source.runs[0].phase = .running
        source.runs[0].answerText = nil
        let history = try source.store(location: location, loaded: true)
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        model.selectedThreadId = source.detail.thread.id
        model.selectedHistory = history
        model.selectedExecutionLocation = location
        if location == .local { model.liveTasks = source.runs }
        else { model.remoteTasks[location] = source.runs }
        // The production run-detail loader publishes this snapshot when it finishes.
        model.publishHistoryLive(source.runs[0], locationID: location)
        let event = BusEnvelope(seq: 1, kind: "interaction.requested", event: .object([
            "type": .string("interaction.requested"),
            "payload": .object([
                "interaction_id": .string("question-after-hydration"), "harness_id": .string("codex"),
                "source_tool": .string("request_user_input"),
                "questions": .array([.object([
                    "id": .string("q1"), "question": .string("Which implementation?"),
                    "options": .array([]), "multi_select": .bool(false)
                ])]),
                "requested_at": .string("2026-10-27T00:00:00.000Z"), "timeout_at": .null
            ])
        ]))
        if location == .local { model.apply(event, to: "mock-run-0") }
        else { model.applyRemoteHistoryCardEvent(event, runID: "mock-run-0", at: location) }
        let live = try #require(model.task("mock-run-0", at: location))
        #expect(live.pendingInteractions.count == 1)
        let shown = try #require(history.renderedRun(for: history.rows[0], live: live))
        #expect(shown.pendingInteractions.count == 1)
        // A subsequent history refresh still has no interaction payload, and must not hide it.
        await history.refresh()
        #expect(history.renderedRun(for: history.rows[0], live: live)?.pendingInteractions.count == 1)
    }

    @Test func patchResponseMustUpdateSelectedHistoryMetadata() throws {
        let source = try HistoryTestSource(count: 1)
        let history = try source.store(loaded: true)
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        model.selectedThreadId = source.detail.thread.id
        model.selectedHistory = history
        model.threads = [source.detail.thread]
        var json = try source.object(source.detail.thread)
        json["access"] = "readonly"
        json["primaryHarness"] = "claude"
        json["title"] = "Renamed by PATCH"
        let response = try JSONDecoder().decode(ThreadSummary.self, from: JSONSerialization.data(withJSONObject: json))
        model.applyThreadUpdate(response)
        #expect(model.threads[0].title == "Renamed by PATCH")
        #expect(model.currentThread?.title == "Renamed by PATCH")
        #expect(model.effectiveThreadAccess == "readonly")
        #expect(model.currentThread?.primaryHarness == "claude")
    }

    @Test func remoteRetirementMustDiscardItsHistoryProjection() throws {
        let source = try HistoryTestSource(count: 1)
        let location = ExecutionLocationID.remote(UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!)
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        model.selectedExecutionLocation = location
        model.selectedThreadId = source.detail.thread.id
        model.selectedHistory = try source.store(location: location, loaded: true)
        model.discardRemoteDaemonProjections(at: location)
        #expect(model.selectedHistory == nil)
    }

    @Test func arrivalsCountMustCountTurnsInsteadOfHeaderRefreshes() async throws {
        let source = try HistoryTestSource(count: 45)
        let history = try source.store(loaded: true)
        history.following = false
        let mounted = history.mountedIDs
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 48, short: true)
        await history.refresh()
        #expect(history.mountedIDs == mounted)
        #expect(history.newCount == 3)
    }

    @Test(arguments: [1, 8, 19]) func variableLimitReplayMustHonorTheEngineCursorScope(retaining: Int) async throws {
        let source = try HistoryTestSource(count: 55)
        var cursorLimits: [String: Int] = [:]
        var mismatches: [String] = []
        let history = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            // Exact contract from thread-history-read.ts:113-120.
            if case .cursor(let cursor) = selector, let original = cursorLimits[cursor], original != limit {
                mismatches.append("\(cursor): expected limit \(original), received \(limit)")
                throw GatewayError.http(status: 409, body: #"{"code":"thread_history_cursor_stale","message":"history cursor scope changed; read a fresh page"}"#)
            }
            var json = try source.object(source.page(selector, limit: limit))
            // The serving owner may mint a fresh replay token on every read.
            for key in ["replayCursor", "replayNextCursor", "olderCursor", "newerCursor"] {
                if let cursor = json[key] as? String { json[key] = cursor + ":\(source.sequence)" }
            }
            let page = try JSONDecoder().decode(ThreadHistoryPage.self, from: JSONSerialization.data(withJSONObject: json))
            for cursor in [page.replayCursor, page.replayNextCursor, page.olderCursor, page.newerCursor].compactMap({ $0 }) {
                cursorLimits[cursor] = limit
            }
            return page
        }
        await history.open()
        await history.earlier(retaining: retaining)
        history.following = false
        history.readingAnchor = "mock-turn-30"
        let navigation = history.navigationRevision
        await history.refresh()
        await history.refresh()
        #expect(mismatches.isEmpty)
        #expect(history.navigationRevision == navigation)
        await history.later()
        let afterLater = history.navigationRevision
        let mounted = history.mountedIDs
        await history.refresh()
        await history.refresh()
        #expect(mismatches.isEmpty)
        #expect(history.navigationRevision == afterLater && history.mountedIDs == mounted)
    }

    @Test func remoteReplacementMustNotKeepSendingTheRetiredStoreID() async throws {
        let source = try HistoryTestSource(count: 1)
        let location = ExecutionLocationID.remote(UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!)
        var replaced = false
        var wrongPins = 0
        func makeStore() -> ThreadHistoryStore {
            ThreadHistoryStore(locationID: location, threadID: source.detail.thread.id) { selector, limit, expectedStore in
                if replaced, expectedStore != nil, expectedStore != "replacement-store" {
                    wrongPins += 1
                    throw GatewayError.http(status: 409, body: #"{"code":"store_mismatch","message":"history belongs to another store"}"#)
                }
                source.transform = { json in
                    if replaced { json["storeId"] = "replacement-store" }
                }
                return try source.page(selector, limit: limit)
            }
        }
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        model.selectedExecutionLocation = location
        model.selectedThreadId = source.detail.thread.id
        model.selectedHistory = makeStore()
        await model.selectedHistory?.open()
        model.discardRemoteDaemonProjections(at: location)
        replaced = true
        // loadThread creates a store only if the located selection has changed/missing history.
        if model.selectedHistory == nil { model.selectedHistory = makeStore() }
        await model.selectedHistory?.open()
        await model.selectedHistory?.open()
        #expect(wrongPins == 0)
        #expect(model.selectedHistory?.storeID == "replacement-store")
    }
}
