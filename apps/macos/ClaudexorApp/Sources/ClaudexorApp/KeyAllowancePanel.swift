import ClaudexorKit
import SwiftUI

/// Vocabulary for an API key's own spending limit as the engine reports it.
/// It is never the account balance, an admission verdict or a routing input.
enum KeyAllowancePresentation {
    struct Entry: Identifiable, Equatable {
        let id: AccountTarget
        let caption: String?
        let title: String
        let value: String
        let current: Bool
        /// Share of the cap already spent; nil means no bar (no cap or unknown).
        let fraction: Double?
        let detail: String?
        let notice: String?
        let capped: Bool
    }

    /// The engine's API-key rows for one harness, default key first.
    static func rows(_ resources: [AccountResourceSnapshot], harness: String) -> [AccountResourceSnapshot] {
        resources.filter { $0.target.harness == harness && $0.credentialFingerprint != nil }
            .sorted { ($0.target.profileId ?? "") < ($1.target.profileId ?? "") }
    }

    /// Every row names its key except a lone default key, the one the key field
    /// manages. A lone registered key keeps its name so it is not read as
    /// the default key.
    static func showsCaption(_ target: AccountTarget, rowCount: Int) -> Bool {
        rowCount > 1 || target.profileId != nil
    }

    static func entry(
        _ snapshot: AccountResourceSnapshot, caption: String?, refreshError: String?, now: Date = Date()
    ) -> Entry {
        let facet = snapshot.spending
        let failure = refreshError.map { "Refresh failed: \($0)" }
        guard let row = facet.value?.first else {
            let never = facet.lastError == nil
            return Entry(id: snapshot.target, caption: caption, title: "Key limit",
                         value: never ? "Not read yet" : "Not available", current: false, fraction: nil,
                         detail: "Refresh reads this key's limit and usage. No paid request is made.",
                         notice: failure ?? facet.lastError.map { "Latest refresh failed: \(reason($0))" },
                         capped: true)
        }
        let current = facet.freshness == .fresh
        let capped = row.capped ?? (row.limit != nil)
        let amount = { (value: String) in usd(value, unit: row.unit, currency: row.currency) }
        var value = "No limit set"
        if capped, let limit = row.limit {
            if let remaining = row.remaining {
                value = remaining.hasPrefix("-")
                    ? "\(amount(String(remaining.dropFirst()))) over \(amount(limit))"
                    : "\(amount(remaining)) left of \(amount(limit))"
            } else {
                value = "Limit \(amount(limit))"
            }
        } else if capped {
            value = "Limit not reported"
        }
        var parts: [String] = []
        if let used = row.used { parts.append("\(amount(used)) used\(windowPhrase(row.window))") }
        if capped, let reset = resetPhrase(row, now: now) { parts.append(reset) }
        let read = facet.observedAt.map { "read \(AccountsPresentation.age($0, now: now))" }
        var notice = failure
        if let error = facet.lastError, notice == nil {
            let age = facet.observedAt.map { "Read \(AccountsPresentation.age($0, now: now)) · " } ?? ""
            notice = "\(age)latest refresh failed: \(reason(error))"
        } else if let read { parts.append(read) }
        return Entry(id: snapshot.target, caption: caption,
                     title: capped ? limitTitle(row.window) : "Key limit",
                     value: current ? value : "Last known: \(value)", current: current,
                     fraction: capped ? spentFraction(limit: row.limit, remaining: row.remaining) : nil,
                     detail: parts.isEmpty ? nil : parts.joined(separator: " · "), notice: notice, capped: capped)
    }

    static func scope(provider: String, entries: [Entry]) -> String {
        if entries.count > 1 { return "Each key's own limit, not your account balance. Doesn't affect routing." }
        if entries.first?.capped == false { return "Your \(provider) account balance still applies. Doesn't affect routing." }
        return "This key's limit, not your account balance. Doesn't affect routing."
    }

    static func help(provider: String) -> String {
        "This key's own limit on \(provider), read from the key endpoint. It isn't your account balance: other \(provider) budgets can still stop requests. It never changes routing."
    }

    /// USD keeps the provider's digits: whole cents are padded, extra precision
    /// is shown as reported, never rounded to a misleading zero.
    static func usd(_ value: String, unit: String, currency: String?) -> String {
        guard currency == "USD", unit == "USD",
              value.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }),
              value.filter({ $0 == "." }).count <= 1, value.first?.isNumber == true
        else { return AccountResourcePresentation.amount(value, unit: unit, currency: currency) }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        let fraction = parts.count == 2 ? String(parts[1]) : ""
        return "$\(parts[0]).\(fraction.count >= 2 ? fraction : fraction.padding(toLength: 2, withPad: "0", startingAt: 0))"
    }

    private static func spentFraction(limit: String?, remaining: String?) -> Double? {
        guard let limit = limit.flatMap(Double.init), let remaining = remaining.flatMap(Double.init) else { return nil }
        guard limit > 0 else { return 1 }
        return min(max((limit - remaining) / limit, 0), 1)
    }

    private static func limitTitle(_ window: String?) -> String {
        switch window {
        case "day": "Daily key limit"
        case "week": "Weekly key limit"
        case "month": "Monthly key limit"
        default: "Key limit"
        }
    }

    private static func windowPhrase(_ window: String?) -> String {
        switch window {
        case "day": " today"
        case "week": " this week"
        case "month": " this month"
        case "lifetime": " in total"
        default: ""
        }
    }

    private static func resetPhrase(_ row: AccountSpending, now: Date) -> String? {
        if let instant = AccountResourcePresentation.compactResetDate(row.resetsAt, now: now) { return instant }
        switch row.window {
        case "day": return "resets daily"
        case "week": return "resets weekly"
        case "month": return "resets monthly"
        case "lifetime": return "never resets"
        default: return nil
        }
    }

    /// Engine read-failure codes in plain words; Source details keep the code.
    static func reason(_ code: String) -> String {
        if code == "timeout" { return "no answer in time" }
        if code == "network" { return "network error" }
        if code.hasPrefix("auth_rejected") { return "the provider rejected this key" }
        if code.hasPrefix("rate_limited") { return "rate limited" }
        if code.hasPrefix("http_status_") { return "HTTP \(code.dropFirst("http_status_".count))" }
        if code == "unrecognized_key_response" || code == "invalid_key_amount" { return "unrecognized answer" }
        return code.replacingOccurrences(of: "_", with: " ")
    }
}

/// Service-free leaf shared by the product connector and rendering fixtures.
struct KeyAllowancePanel: View {
    let provider: String
    let entries: [KeyAllowancePresentation.Entry]
    var refreshing = false
    /// Why Refresh is unavailable (offline engine, no exact refresh); nil = enabled.
    var refreshUnavailable: String? = nil
    let refresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Key allowance", systemImage: "gauge.with.dots.needle.33percent", accessory: AnyView(
                Button(action: refresh) {
                    Label(refreshing ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless).controlSize(.small)
                .disabled(refreshing || refreshUnavailable != nil)
                .help(refreshUnavailable ?? (refreshing ? "A refresh of this key is in progress."
                    : "Read the key's limit and usage from \(provider). No paid request is made."))))
            ForEach(entries) { entry in block(entry) }
            Text(KeyAllowancePresentation.scope(provider: provider, entries: entries))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .help(KeyAllowancePresentation.help(provider: provider))
    }

    private func block(_ entry: KeyAllowancePresentation.Entry) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            if let caption = entry.caption {
                Text(caption).font(.caption.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            }
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Text(entry.title)
                Spacer(minLength: Theme.Spacing.sm)
                Text(entry.value).monospacedDigit().multilineTextAlignment(.trailing)
                    .foregroundStyle(entry.current ? .primary : .secondary)
            }
            .font(.caption)
            .fixedSize(horizontal: false, vertical: true)
            if let fraction = entry.fraction {
                ProgressView(value: fraction, total: 1)
                    .tint(entry.current ? Theme.accent : Color.secondary)
                    .accessibilityLabel("Share of the key limit spent")
            }
            if let detail = entry.detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let notice = entry.notice {
                // The caution colour stays on the glyph; the words keep text contrast.
                Label {
                    Text(notice).foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.status(.caution))
                }
                .font(.caption2)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.sm)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
    }
}
