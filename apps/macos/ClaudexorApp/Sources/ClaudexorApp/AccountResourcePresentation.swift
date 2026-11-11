import ClaudexorKit
import Foundation

/// Vocabulary for the compact row, details and the one reset confirmation.
/// This projects engine facts; it never decides admission or provider policy.
enum AccountResourcePresentation {
    static func amount(_ value: String?, unit: String, currency: String?, decimalPlaces: Int? = nil) -> String {
        guard let value else { return "Unknown" }
        let scaled = decimalPlaces.flatMap { scaledDecimal(value, places: $0) }
        if unit == "minor" {
            if let scaled {
                return "\(scaled) \(currency ?? "units · currency unknown")"
            }
            return "\(value) minor units · \(currency ?? "currency unknown") · \(decimalPlaces == nil ? "scale unknown" : "scale \(decimalPlaces!)")"
        }
        let displayUnit = unit.replacingOccurrences(of: "_", with: " ")
        let suffix = currency.map { $0 == unit ? displayUnit : "\(displayUnit) (\($0))" } ?? displayUnit
        return "\(scaled ?? value) \(suffix)"
    }

    /// Decimal-point movement on strings preserves digits beyond Double/Decimal
    /// precision. An unrenderable scale stays an explicitly raw provider amount.
    static func scaledDecimal(_ value: String, places: Int) -> String? {
        guard (0...1024).contains(places) else { return nil }
        var value = value
        let sign = value.hasPrefix("-") ? "-" : ""
        if value.hasPrefix("-") || value.hasPrefix("+") { value.removeFirst() }
        let scientific = value.lowercased().split(separator: "e", omittingEmptySubsequences: false)
        guard (1...2).contains(scientific.count) else { return nil }
        let exponent = scientific.count == 2 ? Int(scientific[1]) : 0
        guard let exponent, (-1024...1024).contains(exponent) else { return nil }
        let components = scientific[0].split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(components.count) else { return nil }
        let digits = components.joined()
        guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        let point = components[0].count + exponent - places
        if point <= 0 { return sign + "0." + String(repeating: "0", count: -point) + digits }
        if point >= digits.count { return sign + digits + String(repeating: "0", count: point - digits.count) }
        let index = digits.index(digits.startIndex, offsetBy: point)
        return sign + digits[..<index] + "." + digits[index...]
    }

    static func balance(_ value: AccountBalance) -> String {
        if value.unlimited == true { return "Unlimited" }
        if value.amount != nil { return amount(value.amount, unit: value.unit, currency: value.currency, decimalPlaces: value.decimalPlaces) }
        if value.hasBalance == true { return "Available · amount unknown" }
        if value.hasBalance == false { return "No balance · amount not reported" }
        return "Unknown"
    }

    static func summary(_ snapshot: AccountResourceSnapshot?, attempts: [AccountResetAttempt]) -> String {
        guard let snapshot else { return "Not reported" }
        var parts: [String] = []
        if let balance = snapshot.balances.value?.first {
            // One source-ordered, scoped fact — never an aggregate/account-wide
            // balance or a dynamically selected "best" personal/team amount.
            let prefix = snapshot.balances.freshness == .fresh ? "" : "Last known: "
            parts.append(prefix + balance.label + ": " + Self.balance(balance))
        }
        if let offer = snapshot.resets.value?.first {
            let kind = offer.kind == .sessionRefill ? "Refill" : "Reset"
            let count = offer.availableCount.map { "\($0) resets" }
                ?? "\(kind): \(inventory(nil, usableNow: offer.usableNow, freshness: .fresh))"
            parts.append(snapshot.resets.freshness == .fresh && !attempts.contains(where: \.usageNeedsRefresh)
                         ? count : "Last reported: \(count)")
        }
        return parts.isEmpty ? "Details" : parts.joined(separator: " · ")
    }

    static func inventory(_ count: Int?, usableNow: Bool?, freshness: ResourceFreshness) -> String {
        if freshness != .fresh {
            let reported = count.map(String.init) ?? usableNow.map { $0 ? "available" : "unavailable" }
            return reported.map { "Last reported: \($0) · current availability unknown" } ?? "Availability unknown"
        }
        // A positive count alone cannot prove usability; zero is known empty.
        // An uncounted refill still keeps its explicit usable_now evidence.
        let availability = count == 0 ? "Unavailable now"
            : usableNow.map { $0 ? "Available now" : "Unavailable now" } ?? "Availability unknown"
        return count.map { "\(availability) · \($0) remaining" } ?? availability
    }

    static func compactResetDate(_ value: String?, now: Date = Date()) -> String? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return value }
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return "reset time passed" }
        let minutes = Int(ceil(seconds / 60))
        if minutes < 60 { return "resets in \(minutes)m" }
        if minutes < 1440 { return "resets in \(minutes / 60)h \(minutes % 60)m" }
        return "resets in \(minutes / 1440)d \((minutes % 1440) / 60)h"
    }

    static func status(_ attempt: AccountResetAttempt) -> String {
        if attempt.inFlight { return "Checking reset result…" }
        guard let receipt = attempt.receipt else { return "Reset result unconfirmed" }
        switch receipt.outcome {
        case .pending: return "Reset is in progress"
        case .reset, .alreadyRedeemed: return "Reset applied"
        case .alreadyUsed: return "Reset already used · this request is unconfirmed"
        case .nothingToReset: return "Nothing to reset"
        case .noCredit: return "No reset available"
        case .notEligible: return "Reset is not available for this account"
        case .cooldown: return "Reset is cooling down"
        case .unavailable: return "Reset unavailable"
        case .unknown: return "Reset result unconfirmed"
        }
    }

    static func action(_ offer: AccountResetOffer, another: Bool = false) -> String {
        if offer.kind == .sessionRefill { return another ? "Refill session again" : "Refill session" }
        return another ? "Use another reset" : "Use reset"
    }

    static func disabledReason(
        offer: AccountResetOffer, grant: AccountResetGrant?, freshness: ResourceFreshness,
        supported: Bool, busy: Bool
    ) -> String? {
        if busy { return "A request for this account is in progress." }
        if !supported { return "This engine does not advertise account reset support." }
        // Old or missing facts are disclosed, never a fresh-read requirement.
        if freshness == .fresh && (offer.availableCount == 0 || grant?.availableCount == 0) {
            return "No resets remain for this resource."
        }
        if freshness == .fresh && (offer.usableNow == false || offer.eligible == false || grant?.usableNow == false) {
            return offer.reason ?? "The provider reports this reset is unavailable."
        }
        return nil
    }

    static func confirmation(
        account: String, offer: AccountResetOffer, grant: AccountResetGrant?,
        freshness: ResourceFreshness, previous: AccountResetAttempt?
    ) -> String {
        var parts = ["\(offer.label) for \(account)."]
        if let description = offer.description { parts.append(description) }
        if let grant {
            parts.append("Selected grant: \(grant.label).")
            if let description = grant.description { parts.append(description) }
        }
        if offer.weeklyLimitApplies {
            parts.append("Refills the session. Weekly quota still applies and is not replenished.")
        }
        if freshness != .fresh { parts.append("Availability has not been updated; the provider will check it.") }
        if let previous {
            if previous.unconfirmed {
                parts.append("The previous reset result is unconfirmed. This is a separate request and may use another reset.")
            } else if previous.receipt?.outcome.confirmsReset == true {
                parts.append("The previous reset applied. This is a separate request and may use another reset.")
            }
        }
        return parts.joined(separator: " ")
    }

    static func freshness<Value>(_ facet: ResourceFacet<Value>, override: ResourceFreshness? = nil) -> String {
        let freshness = override ?? facet.freshness
        if facet.lastError != nil {
            return freshness == .stale ? "Last known · Last check failed" : "Last check failed"
        }
        switch freshness {
        case .fresh: return "Updated"
        case .stale: return "Last known"
        case .unknown: return "Not reported"
        }
    }

    static func quotaAbsenceReason(_ reason: String) -> String {
        reason == "no_source" ? "No quota-window source (no_source); account resources may be reported separately" : reason
    }

    static func sourceDetails<Value>(_ facet: ResourceFacet<Value>) -> String {
        var parts = ["Freshness: \(facet.freshness.rawValue)",
                     "Source: \(facet.source ?? "Not reported")",
                     "Observed: \(facet.observedAt ?? "Unknown")",
                     "Last checked: \(facet.lastAttemptAt ?? "Unknown")"]
        if let error = facet.lastError { parts.append("Last error: \(error)") }
        return parts.joined(separator: "\n")
    }
}
