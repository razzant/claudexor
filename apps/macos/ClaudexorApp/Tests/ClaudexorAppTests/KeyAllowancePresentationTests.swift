import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

/// Engine-shaped API-key rows (GET /v2/quota?view=resources&includeApiKeys=true).
enum KeyAllowanceFixtures {
    static let now = ISO8601DateFormatter().date(from: "2026-10-29T08:02:00Z")!
    static let empty = #"{"value":null,"source":null,"observed_at":null,"freshness":"unknown","last_attempt_at":null,"last_error":null}"#

    static func row(
        profileId: String? = nil, fingerprint: String = "aaaaaaaaaaaaaaaa",
        capped: Bool = true, limit: String? = "50", remaining: String? = "37.66", used: String? = "12.34",
        window: String? = "month", resetsAt: String? = nil, freshness: String = "fresh",
        observedAt: String? = "2026-10-29T08:00:00Z", lastError: String? = nil, read: Bool = true
    ) -> AccountResourceSnapshot {
        func json(_ value: String?) -> String { value.map { "\"\($0)\"" } ?? "null" }
        let spending = read
            ? #"{"value":[{"id":"openrouter_key_limit","label":"Key limit","enabled":null,"used":\#(json(used)),"limit":\#(json(limit)),"unit":"USD","currency":"USD","decimal_places":null,"fee_included":null,"resets_at":\#(json(resetsAt)),"reason":"Display only","capped":\#(capped),"remaining":\#(json(remaining)),"window":\#(json(window))}],"source":"openrouter_key","observed_at":\#(json(observedAt)),"freshness":"\#(freshness)","last_attempt_at":\#(json(observedAt)),"last_error":\#(json(lastError))}"#
            : #"{"value":null,"source":null,"observed_at":null,"freshness":"unknown","last_attempt_at":\#(json(lastError == nil ? nil : "2026-10-29T08:01:00Z")),"last_error":\#(json(lastError))}"#
        let document = #"{"target":{"harness":"openrouter","profile_id":\#(json(profileId))},"credential_fingerprint":"\#(fingerprint)","balances":\#(empty),"spending":\#(spending),"resets":\#(empty),"diagnostics":\#(empty)}"#
        return try! JSONDecoder().decode(AccountResourceSnapshot.self, from: Data(document.utf8))
    }

    static func entry(_ row: AccountResourceSnapshot, caption: String? = nil, error: String? = nil) -> KeyAllowancePresentation.Entry {
        KeyAllowancePresentation.entry(row, caption: caption, refreshError: error, now: now)
    }
}

struct KeyAllowancePresentationTests {
    typealias F = KeyAllowanceFixtures

    @Test func cappedKeyShowsProviderRemainingSpendWindowAndReadAge() {
        let entry = F.entry(F.row())
        #expect(entry.title == "Monthly key limit")
        #expect(entry.value == "$37.66 left of $50.00")
        #expect(entry.current)
        #expect(abs((entry.fraction ?? 0) - 0.2468) < 0.0001)
        #expect(entry.detail == "$12.34 used this month · resets monthly · read 2m ago")
        #expect(entry.notice == nil)
        #expect(KeyAllowancePresentation.scope(provider: "OpenRouter", entries: [entry])
                == "This key's limit, not your account balance. Doesn't affect routing.")
        let anchored = F.entry(F.row(resetsAt: "2026-10-31T10:02:00Z"))
        #expect(anchored.detail == "$12.34 used this month · resets in 2d 2h · read 2m ago")
    }

    @Test func noCapIsNeitherZeroNorUnlimitedMoneyAndHasNoBar() {
        let entry = F.entry(F.row(capped: false, limit: nil, remaining: nil, used: "3.5"))
        #expect(entry.title == "Key limit")
        #expect(entry.value == "No limit set")
        #expect(entry.fraction == nil)
        #expect(entry.detail == "$3.50 used this month · read 2m ago")
        #expect(KeyAllowancePresentation.scope(provider: "OpenRouter", entries: [entry])
                == "Your OpenRouter account balance still applies. Doesn't affect routing.")
    }

    @Test func zeroAndOverdrawnAllowanceStayRealAmounts() {
        let zero = F.entry(F.row(limit: "0", remaining: "0", used: "0"))
        #expect(zero.value == "$0.00 left of $0.00")
        #expect(zero.fraction == 1)
        let spent = F.entry(F.row(remaining: "0"))
        #expect(spent.value == "$0.00 left of $50.00")
        #expect(spent.fraction == 1)
        let over = F.entry(F.row(remaining: "-1.25"))
        #expect(over.value == "$1.25 over $50.00")
        #expect(over.fraction == 1)
    }

    @Test func staleFailureKeepsLastKnownFiguresAndSaysWhy() {
        let entry = F.entry(F.row(freshness: "stale", observedAt: "2026-10-29T05:02:00Z", lastError: "timeout"))
        #expect(entry.value == "Last known: $37.66 left of $50.00")
        #expect(!entry.current)
        #expect(entry.detail == "$12.34 used this month · resets monthly")
        #expect(entry.notice == "Read 3h ago · latest refresh failed: no answer in time")
        let aged = F.entry(F.row(freshness: "stale", observedAt: "2026-10-29T07:40:00Z"))
        #expect(aged.value.hasPrefix("Last known: ") && aged.notice == nil)
        #expect(aged.detail?.hasSuffix("read 22m ago") == true)
    }

    @Test func unreadReplacedFailedAndOfflineStatesNeverInventFigures() {
        // A never-read key and a replaced key (new binding) look the same: unread.
        for row in [F.row(read: false), F.row(fingerprint: "bbbbbbbbbbbbbbbb", read: false)] {
            let entry = F.entry(row)
            #expect(entry.value == "Not read yet" && entry.fraction == nil && entry.notice == nil)
            #expect(entry.detail == "Refresh reads this key's limit and usage. No paid request is made.")
        }
        let refused = F.entry(F.row(lastError: "auth_rejected_401", read: false))
        #expect(refused.value == "Not available")
        #expect(refused.notice == "Latest refresh failed: the provider rejected this key")
        let offline = F.entry(F.row(), error: "Engine connection changed. Retry refresh.")
        #expect(offline.notice == "Refresh failed: Engine connection changed. Retry refresh.")
        #expect(KeyAllowancePresentation.reason("http_status_503") == "HTTP 503")
        #expect(KeyAllowancePresentation.reason("rate_limited_429") == "rate limited")
    }

    @Test func severalKeysListTheDefaultFirstWithTheirNames() {
        let rows = KeyAllowancePresentation.rows(
            [F.row(profileId: "work", fingerprint: "cccccccccccccccc"), F.row()]
                + [try! JSONDecoder().decode(AccountResourceSnapshot.self, from: Data(#"{"target":{"harness":"cursor","profile_id":"c"},"balances":\#(F.empty),"spending":\#(F.empty),"resets":\#(F.empty),"diagnostics":\#(F.empty)}"#.utf8))],
            harness: "openrouter")
        #expect(rows.map(\.target.profileId) == [nil, "work"])
        let entries = rows.map { F.entry($0, caption: $0.target.profileId ?? "Default key") }
        #expect(entries.map(\.caption) == ["Default key", "work"])
        #expect(KeyAllowancePresentation.scope(provider: "OpenRouter", entries: entries)
                == "Each key's own limit, not your account balance. Doesn't affect routing.")
    }

    @Test func onlyALoneDefaultKeyGoesUnnamed() {
        let defaultKey = AccountTarget(harness: "openrouter", profileId: nil)
        let work = AccountTarget(harness: "openrouter", profileId: "work")
        // Alone, the default key is the one the key field manages.
        #expect(!KeyAllowancePresentation.showsCaption(defaultKey, rowCount: 1))
        // A lone registered key keeps its name, or it reads as the default key.
        #expect(KeyAllowancePresentation.showsCaption(work, rowCount: 1))
        #expect(KeyAllowancePresentation.showsCaption(defaultKey, rowCount: 2))
        #expect(KeyAllowancePresentation.showsCaption(work, rowCount: 2))
    }

    @Test func dollarsKeepTheProvidersDigits() {
        #expect(KeyAllowancePresentation.usd("50", unit: "USD", currency: "USD") == "$50.00")
        #expect(KeyAllowancePresentation.usd("37.6", unit: "USD", currency: "USD") == "$37.60")
        #expect(KeyAllowancePresentation.usd("0.0000005", unit: "USD", currency: "USD") == "$0.0000005")
        #expect(KeyAllowancePresentation.usd("12.340000000000003", unit: "USD", currency: "USD") == "$12.340000000000003")
        #expect(KeyAllowancePresentation.usd("5", unit: "credits", currency: nil) == "5 credits")
    }
}
