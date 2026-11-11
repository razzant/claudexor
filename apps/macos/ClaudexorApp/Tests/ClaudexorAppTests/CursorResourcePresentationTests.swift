import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

struct CursorResourcePresentationTests {
    /// The TS test re-derives these complete wire bytes from the synthetic-amount
    /// dashboard through parseCursorResources, mergeResources and quotaControlServices.
    @Test func producerMoneyRendersAsUSDNotScaledCents() throws {
        let url = try #require(Bundle.module.url(forResource: "cursor-resources-freshness", withExtension: "json"))
        let response = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(contentsOf: url))
        let row = try #require(response.resources?.first)
        let team = try #require(row.balances.value?.first(where: { $0.scope == "team" }))
        #expect(team.label == "Team pool on-demand remaining")
        #expect(AccountResourcePresentation.summary(row, attempts: []) == "Personal included remaining: 0.00 USD")
        #expect(team.amount == "65433" && team.unit == "minor" && team.currency == "USD" && team.decimalPlaces == 2)
        #expect(AccountResourcePresentation.balance(team) == "654.33 USD")
        let included = try #require(row.spending.value?.first(where: { $0.usageKind == "included" }))
        #expect(AccountResourcePresentation.amount(included.used, unit: included.unit,
            currency: included.currency, decimalPlaces: included.decimalPlaces) == "25.00 USD")
        #expect(response.snapshots.isEmpty)
    }

    @Test func scopedSummaryPreservesUnknownAndStaleWithoutAddingPools() throws {
        let url = try #require(Bundle.module.url(forResource: "cursor-resources-freshness", withExtension: "json"))
        let payload = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var row = try #require((payload["resources"] as? [[String: Any]])?.first)
        var facet = try #require(row["balances"] as? [String: Any])
        let balances = try #require(facet["value"] as? [[String: Any]])
        facet["value"] = [try #require(balances.first(where: { $0["scope"] as? String == "team" }))]
        facet["freshness"] = "stale"
        row["balances"] = facet
        var snapshot = try JSONDecoder().decode(AccountResourceSnapshot.self, from: JSONSerialization.data(withJSONObject: row))
        #expect(AccountResourcePresentation.summary(snapshot, attempts: []) == "Last known: Team pool on-demand remaining: 654.33 USD")
        facet["value"] = [try #require(balances.first(where: { $0["id"] as? String == "cursor_personal_on_demand" }))]
        facet["freshness"] = "fresh"
        row["balances"] = facet
        snapshot = try JSONDecoder().decode(AccountResourceSnapshot.self, from: JSONSerialization.data(withJSONObject: row))
        #expect(AccountResourcePresentation.summary(snapshot, attempts: []) == "Personal on-demand remaining: Unknown")
        #expect(AccountResourcePresentation.quotaAbsenceReason("no_source").contains("No quota-window source"))
        #expect(AccountResourcePresentation.quotaAbsenceReason("not_logged_in") == "not_logged_in")
    }
}
