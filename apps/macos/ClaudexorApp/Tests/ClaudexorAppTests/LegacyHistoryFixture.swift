import ClaudexorKit
import Foundation

/// Migrates the old lifecycle tests' compact JSON fixtures to the additive
/// history response. Production requests are asserted separately by the history
/// integration suite; only this test transport accepts legacy fixture bodies.
enum LegacyHistoryFixture {
    static func response(_ data: Data, sequence: Int = 2) throws -> Data {
        var old = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        guard var thread = old["thread"] as? [String: Any] else { return data }
        let revision: [String: Any] = ["epoch": "fixture-reader", "sequence": sequence]
        thread["authPreference"] = "auto"
        thread["workspaceMode"] = (thread["workspaceMode"] as? String) ?? "in_place"
        thread["eligibleHarnesses"] = (thread["eligibleHarnesses"] as? [String]) ?? []
        thread["state"] = (thread["state"] as? String) ?? "active"
        let turns = (old["turns"] as? [[String: Any]] ?? []).enumerated().map { index, original in
            var row = original
            row["ordinal"] = index; row["revision"] = revision
            row["kind"] = original["kind"] as? String ?? "followup"
            row["planReadinessOverridden"] = false
            let prompt = original["prompt"] as? String ?? ""
            row["promptInfo"] = ["textBytes": prompt.utf8.count, "totalTextBytes": prompt.utf8.count, "truncated": false]
            if var run = original["run"] as? [String: Any] {
                run["result"] = run["result"] as? [String: Any] ?? ["kind": "none", "blockers": 0, "revertable": false]
                run["outputReadyState"] = "ready"; run["waitingOnUser"] = false
                run["delegatedChildRunIds"] = run["delegatedChildRunIds"] as? [String] ?? []
                run["budget"] = ["paidBudget": ["kind": "unlimited"], "estimated": false, "source": "unknown"]
                run["applyEligibilityCoverage"] = "complete"; run["operatorDecisionCoverage"] = "complete"
                run["requiredActions"] = []; run["planQuestions"] = []
                run["toolCount"] = ["coverage": "unavailable"]; run["fileCount"] = ["coverage": "unavailable"]
                row["run"] = run; row["runStatus"] = "available"
            } else { row["runStatus"] = "unbound" }
            row["primaryOutputStatus"] = "none"; row["planAnswerComplete"] = true
            return row
        }
        let last = turns.last
        let head: Any = last?["run"].map { ["runId": last!["runId"]!, "run": $0] } ?? NSNull()
        old = ["storeId": "fixture-store", "threadId": thread["id"]!, "epoch": "partition", "revision": revision,
            "header": ["thread": thread, "headRun": head,
                "headRunStatus": last?["run"] == nil ? "unbound" : "available",
                "latestTurnId": last?["id"] ?? NSNull(), "latestOrdinal": last?["ordinal"] ?? NSNull(), "sessions": old["sessions"] ?? [], "sessionsComplete": true],
            "turns": turns, "hasOlder": false, "hasNewer": false,
            "replayCursor": turns.isEmpty ? NSNull() : "fixture-replay" as Any]
        return try JSONSerialization.data(withJSONObject: old)
    }
}
