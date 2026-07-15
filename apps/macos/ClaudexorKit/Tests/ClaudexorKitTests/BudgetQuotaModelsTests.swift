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

    @Test func quotaDecodesTheExactDaemonWireGolden() throws {
        let url = try #require(Bundle.module.url(
            forResource: "control-quota-response", withExtension: "json", subdirectory: "Fixtures"
        ))
        let response = try JSONDecoder().decode(
            ControlQuotaResponse.self,
            from: Data(contentsOf: url)
        )
        #expect(response.snapshots.first?.constraints.count == 2)
        #expect(response.snapshots.first?.constraints.last?.usedRatio == nil)
        #expect(response.snapshots.first?.subject.credentialRoute == "vendor_native")
        #expect(response.refreshedAt == "2026-07-15T10:00:01.000Z")
    }
}
