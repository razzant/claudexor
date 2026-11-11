import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

extension HistoryGatewayTests {
@MainActor @Suite(.serialized)
struct HistoryWorkspaceRegressionTests {
    @Test(arguments: HistoryInteractionTests.locations)
    func projectedDelegateChildrenRestoreInlineWithOneParentRead(location: ExecutionLocationID) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 3)
        source.transform = { json in
            var rows = json["turns"] as! [[String: Any]]
            var run = rows[0]["run"] as! [String: Any]
            run["delegatedChildRunIds"] = ["child"]
            rows[0]["run"] = run
            json["turns"] = rows
        }
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(location)
        model.selectedThreadId = source.detail.thread.id
        let history = model.makeHistoryStore(locationID: location, id: source.detail.thread.id)
        model.selectedHistory = history
        var parentReads = 0
        HistoryURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/history") == true {
                return (200, try JSONEncoder().encode(source.page(nil)))
            }
            #expect(request.url?.path == "/v2/runs/mock-run-0")
            parentReads += 1
            return (200, Data(#"{"summary":{"runId":"mock-run-0","state":"succeeded","mode":"agent","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"recorded parent answer","truncated":false},"children":[{"runId":"child","state":"succeeded","mode":"ask","parentRunId":"mock-run-0","delegatedFromRunId":"mock-run-0"}],"lastSeq":9}"#.utf8))
        }
        await history.open()
        await model.loadHistoryDelegates(history)
        if location != .local {
            var collision = try #require(model.task("child", at: location))
            collision.title = "Wrong local child"
            model.liveTasks = [collision]
        }
        #expect(!model.workspaceHistoryVisible && model.selectedThreadDetail == nil)
        #expect(model.delegatedChildren(of: "mock-run-0").map(\.id) == ["child"])
        #expect(model.delegatedChildren(of: "mock-run-0").first?.title != "Wrong local child")
        #expect(model.task("child", at: location)?.delegatedFromRunId == "mock-run-0")
        #expect(model.workspaceRunIDs.contains("child"))
        await history.refresh()
        await model.loadHistoryDelegates(history)
        #expect(parentReads == 1)
    }

    @Test func visibleWorkspaceFollowsMembershipButNotRoutineReplay() async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        model.selectedThreadId = source.detail.thread.id
        let history = model.makeHistoryStore(locationID: .local, id: source.detail.thread.id)
        model.selectedHistory = history
        var detailReads = 0
        let membership = HistoryTestGate()
        HistoryURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/history") {
                return (200, try JSONEncoder().encode(source.page(nil)))
            }
            detailReads += 1
            if detailReads == 2 { await membership.wait() }
            return (200, try JSONEncoder().encode(source.detail))
        }
        await history.open()
        model.workspaceHistoryVisible = true
        await model.loadWorkspaceHistory()
        #expect(detailReads == 1)
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 2, short: true)
        model.liveTasks = source.runs
        await history.jump()
        try await membership.entered()
        #expect(model.selectedThreadDetail?.turns.count == 1)
        #expect(model.workspaceRunIDs.contains("mock-run-1"))
        model.openRun("mock-run-1")
        #expect(model.route == .task("mock-run-1"))
        membership.release()
        try await ThreadHistoryIntegrationTests().until { model.selectedThreadDetail?.turns.count == 2 }
        #expect(detailReads == 2)
        await history.refresh()
        for _ in 0..<10 { await Task.yield() }
        #expect(detailReads == 2)
        model.workspaceHistoryVisible = false
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 3, short: true)
        await history.jump()
        for _ in 0..<10 { await Task.yield() }
        #expect(detailReads == 2)
    }

    @Test func workspaceInvalidationsCoalesceAndKeepTheNewRoster() async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        model.selectedThreadId = source.detail.thread.id
        model.workspaceHistoryVisible = true
        let gate = HistoryTestGate()
        var reads = 0
        HistoryURLProtocol.handler = { _ in
            reads += 1
            let data = try JSONEncoder().encode(source.detail)
            if reads == 1 { await gate.wait() }
            return (200, data)
        }
        let first = Task { await model.loadWorkspaceHistory() }
        try await gate.entered()
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 2, short: true)
        let requests = (0..<6).map { _ in Task { await model.loadWorkspaceHistory() } }
        for _ in 0..<10 { await Task.yield() }
        gate.release()
        await first.value
        for request in requests { await request.value }
        #expect(reads == 2)
        #expect(model.selectedThreadDetail?.turns.count == 2)
    }
}

}
