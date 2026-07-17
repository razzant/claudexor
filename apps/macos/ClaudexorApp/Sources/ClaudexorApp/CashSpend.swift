import Foundation

/// THE formatter for the engine's cash fact (W4.3 sol #15): the budget ledger
/// owns "how much real money this run has spent" — subscription-entitled work
/// settles to $0 there, so the UI renders the disclosed number verbatim and
/// never infers billing from route labels (the old "≈$" valuation essay).
/// One owner: TurnCard, BudgetMini, and every future spend surface format
/// through here — no duplicated precision decisions.
enum CashSpend {
    /// "$0.00" while the run stays on subscription routes; real dollars once
    /// a paid API route settles. Sub-cent cash keeps enough precision to not
    /// read as zero.
    static func label(_ usd: Double) -> String {
        usd > 0 && usd < 0.01 ? String(format: "$%.4f", usd) : String(format: "$%.2f", usd)
    }

    /// The one hover explanation of what the number IS.
    static let help =
        "Real money billed to an API key. $0.00 while the run stays entirely on subscription routes."
}
