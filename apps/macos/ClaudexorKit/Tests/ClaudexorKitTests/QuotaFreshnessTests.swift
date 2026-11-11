import Foundation
import Testing
@testable import ClaudexorKit

struct QuotaFreshnessTests {
    @Test func completeProjectionKeepsScopeResourceMetadataAndIndependentFreshness() throws {
        let body = #"{"snapshots":[{"subject":{"harness":"cursor","credential_route":"vendor_native","subject_id":"fixture"},"constraints":[{"id":"limit","label":"Limit","used_ratio":null,"window_seconds":null,"resets_at":null,"cooldown_until":null,"freshness":"unknown"}],"source":"cursor_rate_limit","observed_at":"2026-10-15T12:00:00Z","freshness":"stale"}],"resources":[],"availability_scope":{"basis":"quota_block","model":null,"requestKind":"text"},"refreshed_at":null}"#
        let value = try JSONDecoder().decode(ControlAccountResourcesFreshnessResponse.self, from: Data(body.utf8))
        #expect(value.quota.snapshots.first?.freshness == "stale")
        #expect(value.quota.snapshots.first?.constraints.first?.freshness == "unknown")
        #expect(value.availabilityScope.model == nil)
        #expect(value.availabilityScope.requestKind == "text")
        #expect(try JSONDecoder().decode(ControlAccountResourcesFreshnessResponse.self, from: JSONEncoder().encode(value)) == value)
        var invalid = try #require(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
        invalid.removeValue(forKey: "availability_scope")
        let invalidData = try JSONSerialization.data(withJSONObject: invalid)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(ControlAccountResourcesFreshnessResponse.self, from: invalidData) }
        let spending = #"{"id":"included","label":"Personal included","enabled":true,"used":"0","limit":"2000","unit":"cents","currency":"USD","decimal_places":2,"resets_at":null,"reason":null,"scope":"personal","usage_kind":"included","fee_included":null,"period":{"starts_at":"2026-10-01T00:00:00Z","ends_at":"2026-11-01T00:00:00Z"}}"#
        let resource = try JSONDecoder().decode(AccountSpending.self, from: Data(spending.utf8))
        #expect(resource.scope == "personal" && resource.usageKind == "included")
        #expect(resource.feeIncluded == nil && resource.used == "0")
        #expect(resource.period?.endsAt == "2026-11-01T00:00:00Z")
    }
}
