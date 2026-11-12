import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@MainActor @Suite(.serialized)
struct ThreadHistoryStoreTests {
    @Test func edgesUseMountedIDsAfterPartialEvictionAndKeepAnchor() async throws {
        let source = try HistoryTestSource()
        let store = try source.store()
        await store.open()
        #expect(source.requests == [nil])
        #expect(store.rows.count == 20 && store.rows.first?.ordinal == 35)
        let anchor = try #require(store.rows.first?.id)
        await store.earlier(retaining: 8)
        #expect(source.requests.last! == .beforeTurnId(anchor))
        #expect(store.rows.count == 20 && store.rows.contains { $0.id == anchor })
        let edge = try #require(store.rows.last?.id)
        await store.later()
        #expect(source.requests.last! == .afterTurnId(edge))
        #expect(store.rows.count == 20 && store.rows.contains { $0.id == edge })
        for _ in 0..<8 { await store.earlier(retaining: 2) }
        #expect(!store.hasOlder && store.rows.first?.ordinal == 0)
        #expect(store.records.count <= 40 && store.retainedPages.count <= 2)
        #expect(store.cacheBytes <= 4 * 1024 * 1024)
        await store.jump()
        #expect(source.requests.last! == nil && store.tailMounted)
    }

    @Test func oldRevisionsCannotRegressRowsOrHeader() async throws {
        let source = try HistoryTestSource(count: 3)
        let store = try source.store(loaded: true)
        source.runs[0].answerText = "fresh"
        source.sequence = 10
        await store.refresh()
        let revision = store.revision
        source.sequence = 0
        source.runs[0].answerText = "stale"
        await store.refresh()
        #expect(store.rows.first?.primaryOutput?.text == "fresh")
        #expect(store.revision == revision)
    }

    @Test func replayConsumesEverySegmentWithoutLosingMembership() async throws {
        let source = try HistoryTestSource(count: 20)
        var selectors: [ThreadHistorySelector?] = []
        var replay = false
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, _, _ in
            selectors.append(selector)
            source.transform = { json in
                guard replay else { return }
                let rows = json["turns"] as! [[String: Any]]
                json["turns"] = selector == .cursor("segment-2") ? Array(rows.suffix(10)) : Array(rows.prefix(10))
                json["replayCursor"] = "replay:0:20"
                json["replayNextCursor"] = selector == .cursor("segment-2") ? NSNull() : "segment-2" as Any
            }
            return try source.page(nil)
        }
        await store.open()
        let ids = store.mountedIDs
        source.runs = source.runs.map { var run = $0; run.answerText = "settled \(run.id)"; return run }
        replay = true
        await store.refresh()
        #expect(Array(selectors.suffix(2)) == [.cursor("replay:0:20"), .cursor("segment-2")])
        #expect(store.mountedIDs == ids)
        #expect(store.rows.allSatisfy { $0.primaryOutput?.text?.hasPrefix("settled") == true })
    }

    @Test(arguments: [false, true]) func epochAndStaleCursorRecoverAroundReaderWithNewerRefill(stale: Bool) async throws {
        let source = try HistoryTestSource(count: 55)
        var reset = false
        var calls: [ThreadHistorySelector?] = []
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            calls.append(selector)
            if reset, stale, case .cursor(let value) = selector, value.hasPrefix("replay:") {
                reset = false
                throw GatewayError.http(status: 409, body: #"{"error":{"code":"thread_history_cursor_stale"}}"#)
            }
            if reset { source.epoch = "new-owner" }
            return try source.page(selector, limit: limit)
        }
        await store.open()
        await store.earlier(retaining: 8)
        let anchor = try #require(store.rows.dropFirst(8).first?.id)
        store.following = false; store.readingAnchor = anchor
        reset = true
        await store.refresh()
        #expect(calls.contains(.aroundTurnId(anchor)))
        #expect(calls.contains { if case .cursor(let s) = $0 { return s.hasPrefix("newer:") }; return false })
        #expect(store.rows.count == 20 && store.rows.contains { $0.id == anchor })
        #expect(store.navigationTarget == anchor)
        #expect(store.errorMessage == nil)
    }

    @Test func loadingEmptyFailureAndPaintedRefreshAreDistinct() async throws {
        let source = try HistoryTestSource(count: 0)
        let store = try source.store()
        #expect(store.state == .loading && store.header == nil)
        source.fail = true
        await store.open()
        if case .failed = store.state {} else { Issue.record("Expected a failed initial read") }
        source.fail = false
        await store.open()
        #expect(store.state == .ready && store.rows.isEmpty && store.header != nil)
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 10, short: true)
        await store.jump()
        let ids = store.mountedIDs
        source.fail = true
        await store.refresh()
        #expect(store.mountedIDs == ids && store.state == .ready && store.errorMessage != nil)
    }

    @Test func draftsAndExpansionsSurviveEvictionWithoutPinningRows() async throws {
        let source = try HistoryTestSource(count: 80)
        let store = try source.store(loaded: true)
        store.presentation.planText["mock-run-79"] = ["answer": "unfinished"]
        store.presentation.expanded["answer:mock-turn-79"] = true
        for _ in 0..<5 { await store.earlier(retaining: 2) }
        #expect(store.records["mock-turn-79"] == nil && store.rows.count <= 20)
        await store.jump()
        #expect(store.presentation.planText["mock-run-79"]?["answer"] == "unfinished")
        #expect(store.presentation.expanded["answer:mock-turn-79"] == true)
    }

    @Test func boundaryPageRetainsRowsAndReverseTravelUsesTheirEdges() async throws {
        let source = try HistoryTestSource(count: 4)
        let store = try source.store(loaded: true)
        let ids = store.mountedIDs
        await store.earlier(retaining: 2)
        #expect(store.mountedIDs == ids && !store.hasOlder)
        await store.later()
        #expect(source.requests.last! == .afterTurnId(ids.last!))
        #expect(store.mountedIDs == ids && !store.hasNewer)
    }

    @Test func byteLimitedTravelShrinksTheIslandAndRetainsItsAnchor() async throws {
        let source = try HistoryTestSource(count: 12)
        source.transform = { json in
            var rows = json["turns"] as! [[String: Any]]
            for index in rows.indices {
                var turn = rows[index]
                // Keep the cache-bound test grounded in retained user content,
                // rather than the optional receipt field that the history model
                // deliberately ignores.
                turn["prompt"] = String(repeating: "x", count: 700_000)
                rows[index] = turn
            }
            json["turns"] = rows
        }
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            try source.page(selector, limit: min(limit, 2))
        }
        await store.open()
        for _ in 0..<4 {
            let anchor = try #require(store.rows.first?.id)
            await store.earlier(retaining: 2)
            #expect(store.rows.contains { $0.id == anchor })
            #expect(store.cacheBytes <= 4 * 1024 * 1024 && store.records.count <= 40)
        }
        #expect(store.rows.count < 20 && store.rows.first?.ordinal == 2)
        #expect(store.earlierState == .ready)
    }
}
