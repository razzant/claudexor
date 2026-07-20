import Foundation

/// THE formatter for the engine's cash fact (W4.3 sol #15): the budget ledger
/// owns "how much real money this run has spent" — subscription-entitled work
/// settles to $0 there, so the UI renders the disclosed number verbatim and
/// never infers billing from route labels (the old "≈$" valuation essay).
/// One owner: the turn receipt row and every future spend surface format
/// through here — no duplicated precision decisions.
enum CashSpend {
    /// "$0.00" while the run stays on subscription routes; real dollars once
    /// a paid API route settles. Sub-cent cash keeps enough precision to not
    /// read as zero. `estimated` (legacy runs predating the ledger's
    /// budget.cash disclosure) prefixes "~" — every surface shows the same
    /// hedging, never plain dollars for an estimate (INV-134).
    static func label(_ usd: Double, estimated: Bool = false) -> String {
        let base = usd > 0 && usd < 0.01 ? String(format: "$%.4f", usd) : String(format: "$%.2f", usd)
        return estimated ? "~" + base : base
    }

    /// The one hover explanation of what the number IS.
    static func help(estimated: Bool = false) -> String {
        estimated
            ? "Estimated spend from vendor usage (a run predating the settled cash ledger) — not settled billing truth."
            : "Real money billed to an API key. $0.00 while the run stays entirely on subscription routes."
    }
}
