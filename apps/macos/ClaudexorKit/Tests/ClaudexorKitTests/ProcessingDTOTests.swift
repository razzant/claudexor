import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct ProcessingDTOTests {
    @Test func unknownCashNeverDisplaysAsZeroValuationRemainsIndependent() throws {
        let value = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(
            #"{"paidBudget":{"kind":"unlimited"},"spendUsd":0,"cashKnowledge":"unknown","valuationUsd":1.25,"valuationKnowledge":"estimated"}"#.utf8))
        #expect(value.cashKnowledge == "unknown")
        #expect(value.spendUsd == nil)
        #expect(value.knownValuationUsd == 1.25)
        let legacy = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(
            #"{"paidBudget":{"kind":"unlimited"},"spendUsd":0}"#.utf8))
        #expect(legacy.spendUsd == 0)
        #expect(legacy.cashKnowledge == nil)
    }

    @Test func capGovernedSpendSurvivesBesideAnUnknownTotal() throws {
        // An included subscription without a debit receipt: the total is unknown,
        // the part the finite cap governs is known and bounds the remaining cap.
        let json = #"{"paidBudget":{"kind":"finite","maxUsd":2},"cashKnowledge":"unknown","spendUsd":null,"controllableSpendUsd":0,"remainingUsd":2,"valuationKnowledge":"unknown"}"#
        let value = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(json.utf8))
        #expect(value.spendUsd == nil)
        #expect(value.controllableSpendUsd == 0)
        #expect(value.remainingUsd == 2)
        let again = try JSONDecoder().decode(
            BudgetSnapshot.self, from: try JSONEncoder().encode(value))
        #expect(again == value)
        #expect(again.controllableSpendUsd == 0)
        // A known total never invents the cap-governed part, and an older engine
        // that omits the key (or sends null) leaves it unknown.
        for legacy in [
            #"{"paidBudget":{"kind":"unlimited"},"spendUsd":1.5}"#,
            #"{"paidBudget":{"kind":"unlimited"},"spendUsd":1.5,"controllableSpendUsd":null}"#,
        ] {
            let old = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(legacy.utf8))
            #expect(old.spendUsd == 1.5)
            #expect(old.controllableSpendUsd == nil)
        }
    }

    @Test func partialDirectObservationRemainsUnknown() throws {
        let facts = try JSONDecoder().decode(RunOutcomeFacts.self, from: Data(
            #"{"lifecycle":"succeeded","noChanges":null,"checks":"not_configured","review":"not_run","review_requested":false}"#.utf8))
        #expect(facts.noChanges == nil)
    }
}
