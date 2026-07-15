import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct BudgetQuotaModelsTests {
    @Test func paidBudgetUsesAnExplicitTaggedWireShape() throws {
        let finite = PaidBudget.finite(maxUsd: 0)
        let data = try JSONEncoder().encode(finite)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["kind"] as? String == "finite")
        #expect(object["maxUsd"] as? Double == 0)
        #expect(try JSONDecoder().decode(PaidBudget.self, from: Data(#"{"kind":"unlimited"}"#.utf8)) == .unlimited)
    }

    @Test func quotaKeepsEveryWindowAndUnknownUsage() throws {
        let json = #"{"snapshots":[{"subject":{"harness":"codex","credentialRoute":"vendor_native","planLabel":"Pro","subjectId":null},"constraints":[{"id":"five-hour","label":"5 hour","usedRatio":0.4,"windowSeconds":18000,"resetsAt":"2026-07-15T12:00:00Z","cooldownUntil":null},{"id":"weekly","label":"Weekly","usedRatio":null,"windowSeconds":604800,"resetsAt":null,"cooldownUntil":null}],"source":"codex_app_server","observedAt":"2026-07-15T10:00:00Z","freshness":"fresh"}],"refreshedAt":"2026-07-15T10:00:01Z"}"#
        let response = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(json.utf8))
        #expect(response.snapshots.first?.constraints.count == 2)
        #expect(response.snapshots.first?.constraints.last?.usedRatio == nil)
        #expect(response.snapshots.first?.subject.credentialRoute == "vendor_native")
    }
}
