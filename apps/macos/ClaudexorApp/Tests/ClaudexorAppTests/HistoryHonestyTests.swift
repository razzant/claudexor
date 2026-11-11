import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@MainActor @Suite(.serialized)
struct HistoryHonestyTests {
    @Test func anOlderEngineWithoutTheHistoryReadAsksForTheUpdate() async throws {
        let store = ThreadHistoryStore(locationID: .local, threadID: "th-older") { _, _, _ in
            throw GatewayError.http(status: 404, body: #"{"error":"not found"}"#)
        }
        await store.open()
        #expect(store.state == .failed(ThreadHistoryStore.olderEngineMessage))
        #expect(store.errorMessage == ThreadHistoryStore.olderEngineMessage && store.rows.isEmpty)
        let typed = ThreadHistoryStore(locationID: .local, threadID: "th-gone") { _, _, _ in
            throw GatewayError.http(status: 404, body: #"{"code":"thread_not_found","message":"gone"}"#)
        }
        await typed.open()
        #expect(typed.errorMessage != ThreadHistoryStore.olderEngineMessage)
    }

    @Test func prunedRunsNeverReuseAnUnrelatedCachedReceipt() async throws {
        let page = try fixture("thread-history-not-retained")
        let store = ThreadHistoryStore(locationID: .local, threadID: page.threadId) { _, _, _ in page }
        await store.open()
        let row = try #require(store.rows.first { $0.runStatus == "not_retained" })
        #expect(!row.prompt.isEmpty && row.runId != nil && row.run == nil)
        let retained = try fixture("thread-history-receipts")
        let cached = try #require(HistoryRunPresentation.task(retained.turns[1], thread: retained.header.thread))
        #expect(cached.id == row.runId)
        store.liveFacts[cached.id] = ThreadHistoryStore.LiveFact(task: cached, throughRead: store.readSerial)
        #expect(store.renderedRun(for: row, live: cached) == nil)
        #expect(row.primaryOutputStatus == "not_retained")
        #expect(store.header?.headRunStatus == "not_retained")
    }

    @Test func unverifiableDecisionsDoNotEnableApplyAndFailureKeepsItsFullReference() throws {
        let page = try fixture("thread-history-unavailable-evidence")
        let row = try #require(page.turns.first { $0.run?.applyEligibilityCoverage == "unavailable" })
        let task = try #require(HistoryRunPresentation.task(row, thread: page.header.thread))
        #expect(task.operatorDecisionAction == nil && task.applyEligibility == nil)
        #expect(!DecisionApplyPresentation.showsApply(task))
        #expect(row.run?.unverifiedOperatorDecision?.action == "accept_risk")
        #expect(row.run?.failureMessageInfo?.truncated == true)
        #expect(row.run?.failure?.rawDetailRef != nil)
        #expect(HistoryRunPresentation.counts(row.run!)?.contains("2+") == true)
    }

    @Test func unavailableCoverageOverridesAnOtherwiseApplyableReceipt() throws {
        let page = try fixture("thread-history-unavailable-evidence")
        let source = try HistoryTestSource(count: 1)
        var json = try source.object(page.turns[1])
        var run = json["run"] as! [String: Any]
        // Deliberately conflicting cached DTO evidence tests the consumer guard,
        // beyond the producer schema which already rejects this combination.
        run["applyEligibility"] = ["eligible": true, "state": "ok"]
        run["operatorDecision"] = ["action": "accept_risk"]
        run["operatorDecisionCoverage"] = "complete"
        run["unverifiedOperatorDecision"] = NSNull()
        json["run"] = run
        let row = try JSONDecoder().decode(ThreadHistoryTurn.self, from: JSONSerialization.data(withJSONObject: json))
        let task = try #require(HistoryRunPresentation.task(row, thread: page.header.thread))
        #expect(task.applyEligibility == nil)
        #expect(!DecisionApplyPresentation.showsApply(task))
        var competing = task
        competing.applyEligibility = row.run?.applyEligibility
        #expect(DecisionApplyPresentation.showsApply(competing))
    }

    @Test func reopenedHistoryRetainsRunDirectoryAndAuthRoute() throws {
        let page = try fixture("thread-history-receipts")
        let task = try #require(HistoryRunPresentation.task(page.turns[1], thread: page.header.thread))
        #expect(task.runDir == "/fixtures/runs/run-history")
        #expect(TurnCard.fileScopeRoots(executionRoot: nil, runDir: task.runDir) == ["/fixtures/runs/run-history"])
        #expect(task.authRoute?.profileId == "profile-history")
    }

    @Test func aLaterGestureCancelsPendingNavigationAndKeepsThePaintedIsland() async throws {
        let source = try HistoryTestSource(count: 45)
        var release: CheckedContinuation<Void, Never>?
        let store = ThreadHistoryStore(locationID: .local, threadID: source.detail.thread.id) { selector, limit, _ in
            if selector != nil { await withCheckedContinuation { release = $0 } }
            return try source.page(selector, limit: limit)
        }
        await store.open()
        let ids = store.mountedIDs
        let pending = Task { await store.earlier(retaining: 2) }
        while release == nil { await Task.yield() }
        store.cancelNavigation()
        release?.resume()
        await pending.value
        #expect(store.mountedIDs == ids && store.earlierState == .ready)
    }

    private func fixture(_ name: String) throws -> ThreadHistoryPage {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent(name + ".json"))) as! [String: Any]
        return try JSONDecoder().decode(ThreadHistoryPage.self, from: JSONSerialization.data(withJSONObject: json["value"]!))
    }
}
