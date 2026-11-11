import ClaudexorKit
import Foundation
@testable import ClaudexorApp

/// A deterministic engine-shaped transport. The rendering harness uses these
/// pages through the production store, not a second production history adapter.
@MainActor final class HistoryTestSource {
    var detail: ThreadDetailResponse
    var runs: [TaskRun]
    var sequence = 0
    var epoch = "history-read-owner"
    var requests: [ThreadHistorySelector?] = []
    var fail = false
    var transform: ((inout [String: Any]) -> Void)?

    init(detail: ThreadDetailResponse, runs: [TaskRun]) {
        self.detail = detail; self.runs = runs
    }

    convenience init(count: Int = 55) throws {
        let (detail, runs) = try HistoryMockupFixtures.make(count: count, short: true)
        self.init(detail: detail, runs: runs)
    }

    func store(location: ExecutionLocationID = .local, loaded: Bool = false) throws -> ThreadHistoryStore {
        let store = ThreadHistoryStore(locationID: location, threadID: detail.thread.id) { [self] selector, limit, _ in
            requests.append(selector)
            if fail { throw URLError(.notConnectedToInternet) }
            return try page(selector, limit: limit)
        }
        if loaded {
            let page = try page(nil)
            store.install([page], ids: page.turns.map(\.id), reset: true, serial: 0)
        }
        return store
    }

    func page(_ selector: ThreadHistorySelector?, limit: Int = 20) throws -> ThreadHistoryPage {
        sequence += 1
        let count = detail.turns.count
        var start = max(0, count - limit)
        var end = count
        func index(_ id: String) -> Int { detail.turns.firstIndex(where: { $0.id == id }) ?? 0 }
        switch selector {
        case .beforeTurnId(let id): end = index(id); start = max(0, end - limit)
        case .afterTurnId(let id): start = min(count, index(id) + 1); end = min(count, start + limit)
        case .aroundTurnId(let id): end = min(count, index(id) + 1); start = max(0, end - limit)
        case .cursor(let cursor):
            let parts = cursor.split(separator: ":")
            start = min(count, Int(parts[1])!)
            end = parts[0] == "replay" ? min(count, Int(parts[2])!) : min(count, start + limit)
        case nil: break
        }
        let revision: [String: Any] = ["epoch": epoch, "sequence": sequence]
        var thread = try object(detail.thread)
        thread["workspaceMode"] = detail.thread.workspaceMode ?? "in_place"
        thread["authPreference"] = detail.thread.authPreference ?? "auto"
        thread["eligibleHarnesses"] = detail.thread.eligibleHarnesses ?? []
        thread["state"] = detail.thread.state ?? "active"
        thread.removeValue(forKey: "runIds")
        let last = detail.turns.last
        let head = last?.runId.flatMap { id in runs.first { $0.id == id } }
        let headRun: Any = head.map { ["runId": $0.id, "run": runJSON($0)] } ?? NSNull()
        let admission: Any = last.map {
            ["id": $0.id, "runId": $0.runId as Any? ?? NSNull(), "state": head?.phase.rawValue ?? "queued"] as [String: Any]
        } ?? NSNull()
        var json: [String: Any] = [
            "storeId": "history-test-store", "threadId": detail.thread.id, "epoch": "partition",
            "revision": revision,
            "header": ["thread": thread, "latestTurnId": last?.id as Any? ?? NSNull(),
                "latestOrdinal": last == nil ? NSNull() : count - 1 as Any,
                "latestAdmission": admission, "headRun": headRun,
                "headRunStatus": head == nil ? "unbound" : "available", "sessions": [], "sessionsComplete": true],
            "turns": try (start..<end).map { try rowJSON($0, revision: revision) },
            "hasOlder": start > 0, "hasNewer": end < count,
            "olderCursor": start > 0 ? "older:\(max(0, start - limit))" as Any : NSNull(),
            "newerCursor": end < count ? "newer:\(end)" as Any : NSNull(),
            "replayCursor": start < end ? "replay:\(start):\(end)" as Any : NSNull(),
            "replayNextCursor": NSNull(), "limitedBy": NSNull()
        ]
        transform?(&json)
        return try JSONDecoder().decode(ThreadHistoryPage.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func rowJSON(_ index: Int, revision: [String: Any]) throws -> [String: Any] {
        let turn = detail.turns[index]
        let run = turn.runId.flatMap { id in runs.first { $0.id == id } }
        var json = try object(turn)
        json["kind"] = turn.kind ?? "followup"
        json["ordinal"] = index
        json["revision"] = revision
        json["promptInfo"] = ["textBytes": turn.prompt.utf8.count, "totalTextBytes": turn.prompt.utf8.count, "truncated": false]
        json["run"] = run.map(runJSON) ?? NSNull()
        json["runStatus"] = run == nil ? "unbound" : "available"
        json["primaryOutputStatus"] = run?.answerText == nil ? "none" : "available"
        if let answer = run?.answerText {
            json["primaryOutput"] = ["kind": "answer", "path": "final/answer.md", "text": answer,
                "textBytes": answer.utf8.count, "totalTextBytes": answer.utf8.count, "truncated": false]
        } else { json["primaryOutput"] = NSNull() }
        json["answeredByTurnId"] = NSNull(); json["answeredByPrompt"] = NSNull()
        json["planAnswerComplete"] = true
        return json
    }

    private func runJSON(_ run: TaskRun) -> [String: Any] {
        var result: [String: Any] = [
            "state": run.phase.rawValue, "mode": run.mode.apiValue, "n": run.n,
            "result": ["kind": run.mode == .plan ? "plan" : "answer", "blockers": 0,
                "applyState": run.applyState, "revertable": false],
            "outputReadyState": "ready", "waitingOnUser": run.waitingOnUser,
            "createdAt": "2026-10-26T10:00:00Z", "startedAt": "2026-10-26T10:00:00Z",
            "finishedAt": run.phase.isActive ? NSNull() : "2026-10-26T10:01:00Z" as Any,
            "delegatedChildRunIds": [],
            "budget": ["paidBudget": ["kind": "unlimited"], "estimated": false, "source": "unknown"],
            "applyEligibilityCoverage": "complete", "operatorDecisionCoverage": "complete",
            "requiredActions": [], "planQuestions": [],
            "toolCount": ["value": NSNull(), "coverage": "unavailable"],
            "fileCount": ["value": NSNull(), "coverage": "unavailable"]
        ]
        if let readiness = run.planReadiness { result["planReadiness"] = try? object(readiness) }
        result["planQuestions"] = try? run.planQuestions.map(object)
        return result
    }

    func object<T: Encodable>(_ value: T) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
    }
}
