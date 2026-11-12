import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

// A thread switch reconciles the global run list (it reclaims the previous
// selection's off-page rows), but that list never gates the new thread's
// history page. Promoted from the e5e19b44 H2 order probe: the real AppModel
// and GatewayClient over the HistoryURLProtocol stub, with /runs held open by a
// gate instead of a sleep, so ordering is proven without wall-clock limits.

@MainActor private final class RunListGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var open = false
    func wait() async {
        if open { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        open = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

private func runSummaries(_ ids: [String], state: String = "succeeded") -> Data {
    let rows = ids.map { #"{"runId":"\#($0)","state":"\#(state)","mode":"agent"}"# }
    return Data(#"{"runs":[\#(rows.joined(separator: ","))]}"#.utf8)
}

private func fixtureRun(_ id: String, phase: RunPhase) -> TaskRun {
    TaskRun(id: id, title: id, prompt: id, mode: .agent, phase: phase,
        project: "Other", harnesses: [], n: 1,
        createdAt: Date(timeIntervalSince1970: 1_793_008_800), updatedAt: Date(timeIntervalSince1970: 1_793_008_860),
        spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false, routeProof: .unverified,
        attentionNote: nil, plan: [], activity: [], candidates: [], findings: [], diff: [])
}

/// A running run that belongs to some other thread (the "many chats" case).
func liveRunInAnotherThread(_ id: String) -> TaskRun {
    var run = fixtureRun(id, phase: .running)
    run.isLive = true
    return run
}

/// A second thread with its own id and run ids (the mockup factory has one id).
@MainActor func distinctHistorySource(thread id: String, runPrefix: String, count: Int) throws -> HistoryTestSource {
    let (detail, runs) = try HistoryMockupFixtures.make(count: count, short: true)
    var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(detail.thread)) as! [String: Any]
    json["id"] = id
    json["runIds"] = runs.indices.map { "\(runPrefix)-\($0)" }
    json["headRunId"] = count > 0 ? "\(runPrefix)-\(count - 1)" : ""
    let thread = try JSONDecoder().decode(ThreadSummary.self, from: JSONSerialization.data(withJSONObject: json))
    let turns = detail.turns.enumerated().map { index, turn in
        ThreadTurnInfo(id: "\(id)-turn-\(index)", threadId: id, runId: "\(runPrefix)-\(index)",
            parentRunId: nil, planRunId: nil, kind: nil, prompt: turn.prompt, run: nil, createdAt: turn.createdAt)
    }
    let renamed = runs.indices.map { index -> TaskRun in
        var run = fixtureRun("\(runPrefix)-\(index)", phase: .succeeded)
        run.answerText = runs[index].answerText
        return run
    }
    return HistoryTestSource(detail: ThreadDetailResponse(thread: thread, sessions: [], turns: turns), runs: renamed)
}

extension HistoryGatewayTests {
@MainActor @Suite(.serialized)
struct ThreadSwitchReconciliationTests {
    private func selectPreviousThread(_ model: AppModel) {
        model.selectedThreadId = "thread-previous"
        model.selectedHistory = model.makeHistoryStore(locationID: .local, id: "thread-previous")
    }

    private func until(_ predicate: () -> Bool) async throws {
        try await ThreadHistoryIntegrationTests().until(predicate)
    }

    /// Release every fixture gate and join its requests before the shared
    /// URLProtocol handler is cleared, including a throwing assertion path.
    private func withReleasedGates(
        _ gates: [RunListGate],
        tasks: () -> [Task<Void, Never>],
        body: () async throws -> Void
    ) async throws {
        let result: Result<Void, Error>
        do {
            try await body()
            result = .success(())
        } catch {
            result = .failure(error)
        }
        gates.forEach { $0.release() }
        for task in tasks() { await task.value }
        try result.get()
    }

    @Test(arguments: [false, true])
    func historyIsInstalledBeforeAnUnrelatedRunListAnswers(secondTrigger: Bool) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 3)
        let threadB = source.detail.thread.id
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        model.liveTasks = [liveRunInAnotherThread("run-other-thread")]
        selectPreviousThread(model)
        let gate = RunListGate()
        var runLists = 0
        var runListsAnswered = 0
        HistoryURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs":
                runLists += 1
                await gate.wait()
                runListsAnswered += 1
                return (200, runSummaries(["run-other-thread"]))
            case "/v2/threads/\(threadB)/history":
                return (200, try JSONEncoder().encode(source.page(nil)))
            default:
                return (404, Data(#"{"error":"not found"}"#.utf8))
            }
        }
        let open = Task { await model.openThread(threadB) }
        // A second trigger while the lead pass is held (e.g. a global event for
        // an off-page run) arms the trailing pass; neither pass gates history.
        var trigger: Task<Void, Never>?
        try await withReleasedGates([gate], tasks: { [open] + (trigger.map { [$0] } ?? []) }) {
            if secondTrigger {
                try await until { runLists == 1 }
                trigger = Task { await model.refreshRuns() }
            }
            // Installed while the reconciliation's /runs is issued and still held.
            try await until {
                model.selectedHistory?.threadID == threadB && model.selectedHistory?.state == .ready && runLists == 1
            }
            #expect(runListsAnswered == 0)
            #expect(model.selectedHistory?.rows.count == 3)
            #expect(model.runListReconciliationNeeded) // still due until /runs answers
        }
        #expect(runLists == (secondTrigger ? 2 : 1))
        #expect(!model.runListReconciliationNeeded)
        #expect(model.selectedThreadId == threadB)
        #expect(model.liveTasks.map(\.id) == ["run-other-thread"])
        #expect(model.liveTasks.first?.phase == .succeeded)
    }

    @Test func failedRunListLeavesHistoryReadyAndReconciliationDue() async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 3)
        let threadB = source.detail.thread.id
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        model.liveTasks = [liveRunInAnotherThread("run-other-thread")]
        selectPreviousThread(model)
        let gate = RunListGate()
        var runLists = 0
        HistoryURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs":
                runLists += 1
                await gate.wait()
                return (500, Data(#"{"error":"probe"}"#.utf8))
            case "/v2/threads/\(threadB)/history":
                return (200, try JSONEncoder().encode(source.page(nil)))
            default:
                return (404, Data(#"{"error":"not found"}"#.utf8))
            }
        }
        let open = Task { await model.openThread(threadB) }
        try await withReleasedGates([gate], tasks: { [open] }) {
            try await until { model.selectedHistory?.state == .ready }
        }
        #expect(runLists == 1)
        #expect(model.runListReconciliationNeeded)
        #expect(model.liveTasks.map(\.id) == ["run-other-thread"]) // last-known rows kept
        await model.refreshOpenThread(locationID: .local, id: threadB)
        #expect(runLists == 2 && model.runListReconciliationNeeded) // still failing: still due
    }

    @Test(arguments: ["no-live-runs", "same-thread-refresh"])
    func controlsIssueNoRunListRead(variant: String) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 3)
        let threadB = source.detail.thread.id
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        var runLists = 0
        var historyReads = 0
        HistoryURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs":
                runLists += 1
                return (200, runSummaries([]))
            case "/v2/threads/\(threadB)/history":
                historyReads += 1
                return (200, try JSONEncoder().encode(source.page(nil)))
            default:
                return (404, Data(#"{"error":"not found"}"#.utf8))
            }
        }
        if variant == "same-thread-refresh" {
            model.liveTasks = [liveRunInAnotherThread("run-other-thread")]
            model.selectedThreadId = threadB
            let loaded = model.makeHistoryStore(locationID: .local, id: threadB)
            let page = try source.page(nil)
            loaded.install([page], ids: page.turns.map(\.id), reset: true, serial: 0)
            model.selectedHistory = loaded
            await model.refreshOpenThread(locationID: .local, id: threadB)
        } else {
            selectPreviousThread(model)
            await model.openThread(threadB)
        }
        #expect(runLists == 0 && historyReads == 1)
        #expect(model.selectedHistory?.state == .ready && model.selectedHistory?.rows.count == 3)
        #expect(!model.runListReconciliationNeeded)
    }

    /// Astra council case: a refresh that started for the previous selection
    /// and answers after the switch must not keep that selection's off-page
    /// family. The family is the one selected when /runs answers.
    @Test(arguments: [false, true])
    func lateRunListAppliesTheFamilyOfTheSelectionCurrentWhenItAnswers(newFamilyLoaded: Bool) async throws {
        defer { HistoryURLProtocol.handler = nil }
        let previous = try distinctHistorySource(thread: "thread-A", runPrefix: "run-A", count: 2)
        let next = try distinctHistorySource(thread: "thread-B", runPrefix: "run-B", count: 2)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        var child = liveRunInAnotherThread("run-A-child")
        child.delegatedFromRunId = "run-A-1"
        // Off-page rows: both threads' runs are restored detail, absent from /runs.
        model.liveTasks = previous.runs + [child] + next.runs
        model.selectedThreadId = "thread-A"
        let loadedA = model.makeHistoryStore(locationID: .local, id: "thread-A")
        let pageA = try previous.page(nil)
        loadedA.install([pageA], ids: pageA.turns.map(\.id), reset: true, serial: 0)
        model.selectedHistory = loadedA
        let runListGate = RunListGate(), historyGate = RunListGate()
        var runLists = 0
        var historyReads = 0
        HistoryURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs":
                runLists += 1
                await runListGate.wait()
                return (200, runSummaries([]))
            case "/v2/threads/thread-B/history":
                historyReads += 1
                if !newFamilyLoaded { await historyGate.wait() }
                return (200, try JSONEncoder().encode(next.page(nil)))
            default:
                return (404, Data(#"{"error":"not found"}"#.utf8))
            }
        }
        let late = Task { await model.refreshRuns() } // issued while thread A is selected
        var open: Task<Void, Never>?
        try await withReleasedGates([runListGate, historyGate], tasks: { [late] + (open.map { [$0] } ?? []) }) {
            try await until { runLists == 1 }
            open = Task { await model.openThread("thread-B") }
            // The switch has happened: B is selected and its page is either
            // installed or still held when the late /runs answer lands.
            try await until {
                model.selectedHistory?.threadID == "thread-B" && historyReads == 1
                    && (!newFamilyLoaded || model.selectedHistory?.state == .ready)
            }
            runListGate.release()
            await late.value
            let kept = Set(model.liveTasks.map(\.id))
            #expect(kept.isDisjoint(with: ["run-A-0", "run-A-1", "run-A-child"]))
            #expect(kept == (newFamilyLoaded ? ["run-B-0", "run-B-1"] : []))
        }
        #expect(model.selectedThreadId == "thread-B" && model.selectedHistory?.rows.count == 2)
        #expect(Set(model.liveTasks.map(\.id)).isDisjoint(with: ["run-A-0", "run-A-1", "run-A-child"]))
    }

    @Test func throwingBodyDrainsItsRequestBeforeReturning() async throws {
        enum ProbeFailure: Error { case expected }
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 1)
        let thread = source.detail.thread.id
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        model.liveTasks = [liveRunInAnotherThread("run-other-thread")]
        selectPreviousThread(model)
        let gate = RunListGate()
        var started = 0, answered = 0
        HistoryURLProtocol.handler = { request in
            if request.url?.path == "/v2/runs" {
                started += 1
                await gate.wait()
                answered += 1
                return (200, runSummaries([]))
            }
            if request.url?.path == "/v2/threads/\(thread)/history" {
                return (200, try JSONEncoder().encode(source.page(nil)))
            }
            return (404, Data())
        }
        let open = Task { await model.openThread(thread) }
        do {
            try await withReleasedGates([gate], tasks: { [open] }) {
                try await until { started == 1 }
                throw ProbeFailure.expected
            }
            Issue.record("The assertion error must survive cleanup")
        } catch ProbeFailure.expected {}
        #expect(answered == 1)
        #expect(model.selectedHistory?.state == .ready)
        #expect(!model.runListReconciliationNeeded)
    }

    /// Local run ids and a remote engine's run ids are separate namespaces: a
    /// selected remote thread contributes no family to the local run list.
    @Test func remoteSelectionPreservesNoLocalRows() async throws {
        defer { HistoryURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 2)
        let (model, _) = ThreadHistoryIntegrationTests().makeModel(.local)
        model.liveTasks = source.runs // local rows whose ids equal the remote rows' ids
        let remote = ExecutionLocationID.remote(UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!)
        model.selectedExecutionLocation = remote
        model.selectedThreadId = source.detail.thread.id
        model.selectedHistory = try source.store(location: remote, loaded: true)
        HistoryURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs" else { return (404, Data(#"{"error":"not found"}"#.utf8)) }
            return (200, runSummaries([]))
        }
        await model.refreshRuns()
        #expect(model.liveTasks.isEmpty)
    }
}
}
