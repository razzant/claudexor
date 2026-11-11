import Foundation

/// THE formatter for the engine's cash fact (W4.3 sol #15): the budget ledger
/// owns "how much real money this run has spent" — it discloses an exact (or
/// estimated) number, or an unknown total (an included subscription that reports
/// no debit), so the UI renders the disclosure verbatim and never infers billing
/// from route labels (the old "≈$" valuation essay).
/// One owner: the turn receipt row and every future spend surface format
/// through here — no duplicated precision decisions.
enum CashSpend {
    /// The disclosed settled amount ("$0.00" only when the ledger reports exact
    /// zero). Sub-cent cash keeps enough precision to not read as zero.
    /// `estimated` describes CASH certainty only (for example, vendor-estimated
    /// API-key usage) and prefixes "~" — every surface shows the same hedging,
    /// never plain dollars for an estimate (INV-134).
    static func label(_ usd: Double, estimated: Bool = false) -> String {
        let base = usd > 0 && usd < 0.01 ? String(format: "$%.4f", usd) : String(format: "$%.2f", usd)
        return estimated ? "~" + base : base
    }

    /// The one hover explanation of what the number IS.
    static func help(estimated: Bool = false) -> String {
        estimated
            ? "Estimated cash billed to an API key from vendor usage. Subscription valuation is tracked separately."
            : "Real money the engine's budget ledger has settled for this run, for example API-key usage. Subscription valuation is tracked separately; a total the engine cannot verify reads as unknown, not as zero."
    }

    /// The receipt's cash element: visible text plus its hover explanation.
    struct Receipt: Equatable {
        var text: String
        var help: String
    }

    /// `total` is the engine's reported cash (nil when unknown); `controllable` is the
    /// part the finite cap governs (nil when unknown); `cap` is the finite cap, if any.
    /// A known total renders as before. An unknown total (an included subscription
    /// reports no actual debit) is NEVER a number: beside a known cap-governed part it
    /// reads "Cash unknown" and states that part and the cap separately, so a bounded
    /// amount is not mistaken for the run's total. Nothing known renders nothing.
    static func receipt(
        total: Double?, estimated: Bool, controllable: Double?, cap: Double?
    ) -> Receipt? {
        if let total {
            return Receipt(text: label(total, estimated: estimated), help: help(estimated: estimated))
        }
        guard let controllable else { return nil }
        var why = "The total cash cannot be verified (for example an included subscription "
            + "that reports no actual debit receipt), so none is shown. "
        let governed = label(controllable)
        guard let cap else {
            return Receipt(
                text: "Cash unknown",
                help: why + "\(governed) of API cash has settled; the budget has no cap.")
        }
        why += "The cap governs only the cash Claudexor can settle: \(governed) so far, "
            + "\(label(max(0, cap - controllable))) of \(label(cap)) remaining."
        return Receipt(text: "Cash unknown · \(governed) of \(label(cap)) cap", help: why)
    }
}
