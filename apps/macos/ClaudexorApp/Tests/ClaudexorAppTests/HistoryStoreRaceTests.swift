import ClaudexorKit
import Foundation
import SwiftUI
import Testing
@testable import ClaudexorApp

@MainActor @Suite(.serialized)
struct HistoryStoreRaceTests {
    @Test func metadataAcknowledgementWinsOverAnOlderRead() async throws {
        let source = try HistoryTestSource(count: 1)
        let gate = HistoryTestGate()
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            let page = try source.page(selector, limit: limit)
            if selector != nil { await gate.wait() }
            return page
        }
        await store.open()
        let read = Task { await store.refresh() }
        try await gate.entered()
        var json = try source.object(source.detail.thread)
        json["title"] = "Acknowledged title"
        let acknowledged = try JSONDecoder().decode(ThreadSummary.self, from: JSONSerialization.data(withJSONObject: json))
        store.acknowledgeMetadata(acknowledged)
        gate.release()
        await read.value
        #expect(store.header?.thread.title == "Acknowledged title")
        // A genuinely later observation is authoritative again.
        await store.jump()
        #expect(store.header?.thread.title == source.detail.thread.title)
    }

    @Test(arguments: [0, 45]) func missingOrdinalDisclosesUnnumberedArrivals(count: Int) async throws {
        let source = try HistoryTestSource(count: count)
        source.transform = { json in
            var header = json["header"] as! [String: Any]
            header.removeValue(forKey: "latestOrdinal")
            json["header"] = header
        }
        let store = try source.store(loaded: true)
        store.following = false
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 48, short: true)
        await store.refresh()
        #expect(store.newCount == nil)
        #expect(JumpToLatestControl.arrivalLabel(store.newCount) == "new")
        await store.jump()
        #expect(store.newCount == 0 && store.readingAnchor == nil)
    }

    @Test func cacheEncodesEachRetainedRevisionOnce() async throws {
        let source = try HistoryTestSource(count: 55)
        let store = try source.store()
        var encoded: [ThreadHistoryStore.RowSizeKey: Int] = [:]
        store.measureRow = { row in
            encoded[.init(row), default: 0] += 1
            return (try? JSONEncoder().encode(row).count) ?? 0
        }
        await store.open()
        for _ in 0..<3 {
            await store.earlier(retaining: 1)
            for _ in 0..<5 { #expect(store.cacheBytes > 0) }
            #expect(store.rowSizes.count == store.records.count)
        }
        #expect(encoded.values.allSatisfy { $0 == 1 })
    }

    @Test(arguments: [false, true], [0, 45])
    func followerRecoveryUsesTheNewestPage(stale: Bool, count: Int) async throws {
        let source = try HistoryTestSource(count: count)
        var reject = false
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            if reject, case .cursor = selector {
                reject = false
                throw GatewayError.http(status: 409, body: "thread_history_cursor_stale")
            }
            return try source.page(selector, limit: limit)
        }
        await store.open()
        store.readingAnchor = store.mountedIDs.first
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 85, short: true)
        if stale { reject = true } else { source.epoch = "replacement-epoch" }
        await store.refresh()
        #expect(store.mountedIDs.last == "mock-turn-84")
        #expect(store.following && store.navigationFollows && store.readingAnchor == nil)
    }

    @Test func aGestureDoesNotDiscardBackgroundFacts() async throws {
        let source = try HistoryTestSource(count: 45)
        let gate = HistoryTestGate()
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            let page = try source.page(selector, limit: limit)
            if selector != nil { await gate.wait() }
            return page
        }
        await store.open()
        source.runs[44].answerText = "new settled answer"
        let task = Task { await store.refresh() }
        try await gate.entered()
        store.cancelNavigation()
        gate.release()
        await task.value
        #expect(store.rows.last?.primaryOutput?.text == "new settled answer")
    }

    @Test func travelCommittedDuringTailReadKeepsItsIsland() async throws {
        let source = try HistoryTestSource(count: 45)
        let older = HistoryTestGate(), tail = HistoryTestGate()
        var blockTail = false
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            let page = try source.page(selector, limit: limit)
            if case .beforeTurnId = selector { await older.wait() }
            if selector == nil && blockTail { await tail.wait() }
            return page
        }
        await store.open()
        let travel = Task { await store.earlier(retaining: 8) }
        try await older.entered()
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 46, short: true)
        blockTail = true
        let refresh = Task { await store.refresh() }
        try await tail.entered()
        older.release()
        await travel.value
        let island = store.mountedIDs
        tail.release()
        await refresh.value
        #expect(store.mountedIDs == island && !store.following)
    }

    @Test func reorderedJumpRetriesNewestOnce() async throws {
        let source = try HistoryTestSource(count: 45)
        let gate = HistoryTestGate()
        var block = false
        var newestReads = 0
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            let page = try source.page(selector, limit: limit)
            if selector == nil {
                newestReads += 1
                if block { block = false; await gate.wait() }
            }
            return page
        }
        await store.open()
        block = true
        let jump = Task { await store.jump() }
        try await gate.entered()
        await store.refresh()
        gate.release()
        await jump.value
        #expect(store.jumpState == .ready)
        #expect(newestReads == 3) // open, rejected jump, one retry
    }

    @Test func laterKeepsTheFormerLastTurnAtTheBottom() async throws {
        let store = try HistoryTestSource(count: 85).store(loaded: true)
        await store.earlier(retaining: 1)
        await store.earlier(retaining: 1)
        let last = store.mountedIDs.last
        await store.later()
        let viewport = ConversationFeedState()
        viewport.navigate(store)
        #expect(viewport.navigationTarget == last)
        #expect(viewport.navigationAnchor == .bottom)
        #expect(!store.following)
    }
}

@MainActor final class HistoryTestGate {
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { continuation = $0 } }
    func release() { continuation?.resume(); continuation = nil }
    func entered() async throws {
        for _ in 0..<2_000 {
            if continuation != nil { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        throw URLError(.timedOut)
    }
}
