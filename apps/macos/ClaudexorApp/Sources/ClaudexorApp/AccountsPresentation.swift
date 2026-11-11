import SwiftUI
import ClaudexorKit
import Foundation

// MARK: - Accounts presentation models (INV-135)
//
// The row model + pure assembly behind the accounts surface, extracted from
// AccountsPopover.swift (readability ratchet). The views live in
// AccountsPopover.swift; the SSOT projection lives here.

/// Readiness verdict for one account row (the worst wins for the trigger dot).
enum AccountReadiness: Int, Comparable {
    case unavailable = 0, unknown = 1, ready = 2
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
    /// The readiness DOT fill (trigger dot and row dot), never text.
    var color: Color {
        switch self {
        case .ready: return Theme.statusFill(.positive)
        case .unknown: return Theme.statusFill(.caution)
        case .unavailable: return Theme.statusFill(.negative)
        }
    }
}

/// One row in the accounts popover — a registered account row (unified account
/// model: EVERY account is a named registry row; there is no CLI-login
/// pseudo-row, and a legacy default-store login appears as the ordinary
/// `<harness>-default` row the engine registers).
struct AccountRowModel: Identifiable {
    let id: String
    let displayName: String
    let harnessId: String
    let family: HarnessFamily
    let readiness: AccountReadiness
    let verified: Bool
    /// The account row's registry id — every row has one (unified model).
    let profileId: String
    let detail: String?
    let quotaGroups: [QuotaPresentation.Group]
    /// D25 Enabled: participates in pickers + the auto-rotation pool — the wire
    /// `profile.enabled`, LIVE via the profile PATCH route on EVERY row (the
    /// retired `native_credentials_enabled` settings path died with the
    /// pseudo-row). This is the ONLY routing control.
    let enabled: Bool
    /// Server-computed NEXT-UP (the `accountPools` pool authority): true when
    /// an unpinned run of this harness's configured DEFAULT model would route
    /// to THIS row next. INFORMATIONAL only — rendered as a quiet
    /// "Next up · default model" badge, never a control and never a forecast
    /// for another model. false when the projection is absent (older daemon)
    /// or another row/route is next up.
    let nextUp: Bool
    /// Live pre-progress refusal marks of this row, each scoped to the one
    /// requested model it orders (`GET /v2/accounts/routing-evidence`).
    var refusalMarks: [AccountRefusalMark] = []
    /// The row's latest observed service per requested model: a routing
    /// observation, never a quota or authentication verdict.
    var lastService: [AccountLastService] = []
    /// Live typed refusals of single models on this row (#200): dated evidence
    /// in its refusal line, never its readiness, Enabled state or order.
    var credentialUnusable: [AccountCredentialUnusableMark] = []
    /// Non-secret {email, plan} of this account (INV-067), projected
    /// daemon-side from the owning credential-profile probe. When present it
    /// drives the row's secondary line (`identityLine`); nil when the source
    /// does not disclose identity or an older daemon omits it.
    var identity: AccountIdentity? = nil

    /// The row's identity line: "email · plan", or whichever single field the
    /// daemon disclosed. nil falls back to the readiness detail.
    var identityLine: String? {
        let parts = [identity?.email, identity?.plan]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    var secondaryLines: [String] {
        let visibleDetail = identityLine == nil || !verified ? detail : nil
        return [identityLine, visibleDetail]
            .compactMap { $0 }
            .reduce(into: []) { lines, value in
                if !value.isEmpty, !lines.contains(value) { lines.append(value) }
            }
    }
    /// A healthy row with identity stays compact, while its independent
    /// readiness fact remains reachable from the status marker's help text.
    var hiddenReadinessDetail: String? {
        guard verified, identityLine != nil, let detail, detail != identityLine else { return nil }
        return detail
    }

    /// The single worst account-wide text window across the account's quota
    /// groups. It alone feeds the trigger's quota percent (`worstPercent`) and,
    /// when present, the row's compact quota line. Image and model-scoped
    /// windows never become this account-wide value.
    var worstWindow: QuotaPresentation.Window? {
        quotaGroups
            .flatMap(\.windows)
            .filter { $0.appliesToText && ($0.appliesToModels ?? []).isEmpty }
            .max { ($0.usedRatio ?? -1) < ($1.usedRatio ?? -1) }
    }
    var worstPercent: Int? {
        worstWindow?.usedRatio.map { Int(($0 * 100).rounded()) }
    }

    /// The window behind the row's one compact quota line. An account-wide text
    /// window always wins, even when its ratio is unknown. Only when the account
    /// has no account-wide text window does the row expose its worst measured
    /// model-scoped text window. This is row presentation only: the trigger,
    /// readiness and routing continue to use the account-wide projection above.
    var compactWindow: QuotaPresentation.Window? {
        if let worstWindow { return worstWindow }
        return quotaGroups
            .flatMap(\.windows)
            .filter {
                $0.appliesToText
                    && !($0.appliesToModels ?? []).isEmpty
                    && $0.usedRatio != nil
            }
            .max { ($0.usedRatio ?? -1) < ($1.usedRatio ?? -1) }
    }

    /// Server-authored account-wide availability folded by QuotaPresentation.
    /// Ratios never create this state.
    var quotaAvailabilityState: String? {
        let states = quotaGroups.compactMap(\.availability?.state)
        if states.contains("exhausted") { return "exhausted" }
        if states.contains("cooldown") { return "cooldown" }
        return states.isEmpty ? nil : "available"
    }

    var quotaAvailabilityResetAt: String? {
        AccountsPresentation.earliestReset(
            quotaGroups.compactMap(\.availability?.resetsAt))
    }

    var scopedQuotaLabel: String? {
        let labels = Set(quotaGroups.flatMap(\.scopedExhaustions).map(\.scopeLabel))
        if labels.count == 1 { return labels.first }
        if !labels.isEmpty {
            return "Scoped limits"
        }
        return nil
    }
}

/// Pure assembly of account rows from the model's profile + readiness + quota
/// state, plus the trigger's worst-of aggregates.
enum AccountsPresentation {
    /// Harnesses whose vendor subscription login lives in an isolated
    /// config-dir/HOME account row (the engine's config_dir_login set). Under
    /// the unified account model every one of their accounts — including a
    /// migrated legacy default-store login — is a named registry row.
    static let configDirLoginHarnessIds = ["agy", "claude", "codex", "cursor", "grok"]

    /// The families the add-account flow may register, DERIVED from the set
    /// above so a fifth family is one entry there and nothing else. The picker
    /// and its caption both read this; hand-listing the vendors is what left
    /// Antigravity addable by the daemon and unreachable in the popover.
    static let addableFamilies: [HarnessFamily] =
        configDirLoginHarnessIds.map(HarnessFamily.init(rawValue:))

    /// The add form's initial vendor. Claude stays the common case, but the
    /// value must be a MEMBER of the derived list — a hardcoded id that leaves
    /// the set would select a row the picker no longer offers.
    static var defaultAddHarnessId: String {
        configDirLoginHarnessIds.contains(HarnessFamily.claude.rawValue)
            ? HarnessFamily.claude.rawValue
            : configDirLoginHarnessIds.first ?? ""
    }

    /// The add form's caption. Family-scoped hosts (the Harness Doctor's Manage
    /// sheet) name their one vendor; the global popover lists every addable
    /// one in the SSOT's own order, so the sentence cannot go stale.
    static func addAccountCaption(family: HarnessFamily?) -> String {
        let subject = family?.label ?? listed(addableFamilies.map(\.label))
        return "A second \(subject) subscription — one click opens the official CLI login."
    }

    /// "A", "A or B", "A, B, or C" — an Oxford list, so a two-family future
    /// does not read "A, or B".
    static func listed(_ labels: [String]) -> String {
        switch labels.count {
        case 0: return ""
        case 1: return labels[0]
        case 2: return "\(labels[0]) or \(labels[1])"
        default: return labels.dropLast().joined(separator: ", ") + ", or \(labels[labels.count - 1])"
        }
    }

    /// Whether a PROFILE-LESS login request can succeed for `family` — the
    /// engine's BOOTSTRAP sugar (unified account model, K.4): it resolves the
    /// login onto the `<harness>-default` account row (cursor binds the job to
    /// that row and the job reports the resolved profileId; claude/codex keep
    /// the default-store job the startup migration registers as that row).
    /// Mirrors the engine's `harnessSupportsBootstrapLogin`: claude/codex/
    /// cursor yes; `agy` no — every Antigravity account is a named row and the
    /// daemon refuses a profile-less agy login. A surface that offers a
    /// profile-less login must gate on THIS, never on whether the harness id
    /// happens to decode as a `SetupHarness`.
    static func supportsBootstrapLogin(_ family: HarnessFamily) -> Bool {
        family.defaultAuthReadinessRequest?.source == .nativeSession
    }

    /// The reserved id of the family's BOOTSTRAP account row — the engine's
    /// migration/bootstrap registers a profile-less login as `<harness>-default`
    /// (contract L.3). A family sheet treats a job resolved onto this row as
    /// its own login, never as a foreign account's.
    static func bootstrapProfileId(for family: HarnessFamily) -> String {
        "\(family.setupHarnessId)-default"
    }

    /// Harnesses whose pool verdict is disclosed as the API-key ROUTE line on
    /// an accounts surface (INV-061). Only config-dir-login families qualify:
    /// there the key is a FALLBACK behind the account rows, so an
    /// `api_key_route` verdict discloses a real degradation ("no enabled
    /// account is ready"). For api-key-PRIMARY families (opencode/raw-api/
    /// openrouter) the key IS the ordinary route — a standing line would
    /// present normality as degradation, permanently, on a surface that lists
    /// no rows for them anyway. Pure so the family filter is unit-pinned.
    static func apiKeyRouteDisclosureHarnessIds(
        family: HarnessFamily?,
        poolHarnessIds: [String],
        isApiKeyRouteNextUp: (String) -> Bool
    ) -> [String] {
        let scope = family.map { [$0.setupHarnessId] } ?? poolHarnessIds
        return scope.filter {
            configDirLoginHarnessIds.contains($0) && isApiKeyRouteNextUp($0)
        }
    }

    /// Compare legal offset timestamps by their absolute instant. Equal
    /// instants and malformed future values use raw lexical order so the
    /// projection remains deterministic rather than depending on group order.
    static func earliestReset(_ values: [String]) -> String? {
        values.min { lhs, rhs in
            switch (try? Date(lhs, strategy: .iso8601),
                    try? Date(rhs, strategy: .iso8601)) {
            case let (left?, right?):
                return left == right ? lhs < rhs : left < right
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            case (nil, nil):
                return lhs < rhs
            }
        }
    }

    /// Account controls belong to the active execution location. Local daemon
    /// health is neither necessary nor sufficient while a remote host is active.
    @MainActor
    static func isAvailable(model: AppModel) -> Bool {
        model.gateway(for: model.activeExecutionLocation) != nil
    }

    /// Every row renders from the profiles list — the unified account model's
    /// single account kind. The client synthesizes NOTHING: the engine's
    /// startup migration/bootstrap registers a legacy default-store login as
    /// the ordinary `<harness>-default` row, and `next_up` comes only from the
    /// server-computed `accountPools` pool authority.
    @MainActor
    static func rows(model: AppModel) -> [AccountRowModel] {
        let groups = QuotaPresentation.groups(from: model.activeQuotaResponse?.snapshots ?? [])
        let accountsReadinessFresh = model.activeAccountsReadinessFresh
        return model.activeCredentialProfiles.map { entry in
            let availability = accountsReadinessFresh ? entry.status.availability : "unknown"
            let verification = accountsReadinessFresh ? entry.status.verification : "not_run"
            return AccountRowModel(
                id: "profile/\(entry.profile.harnessId)/\(entry.profile.profileId)",
                displayName: entry.profile.displayName,
                harnessId: entry.profile.harnessId,
                family: HarnessFamily(rawValue: entry.profile.harnessId),
                readiness: readiness(availability: availability, verification: verification),
                verified: availability == "available" && verification == "passed",
                profileId: entry.profile.profileId,
                detail: accountsReadinessFresh
                    ? entry.status.detail
                    : "Readiness is stale; refresh Accounts.",
                quotaGroups: groups.filter {
                    $0.subjectId == entry.profile.profileId && $0.harness == entry.profile.harnessId
                },
                enabled: entry.profile.enabled,
                nextUp: model.authoritativeNextUp(for: entry.profile.harnessId)?
                    .isProfile(entry.profile.profileId) ?? false,
                // Joined by account id from separate state: a PATCHed row keeps it.
                refusalMarks: model.accountsRoutingEvidence.marks(
                    harnessId: entry.profile.harnessId, profileId: entry.profile.profileId,
                    at: model.activeExecutionLocation),
                lastService: model.accountsRoutingEvidence.lastService(
                    harnessId: entry.profile.harnessId, profileId: entry.profile.profileId,
                    at: model.activeExecutionLocation),
                credentialUnusable: model.accountsRoutingEvidence.credentialUnusable(
                    harnessId: entry.profile.harnessId, profileId: entry.profile.profileId,
                    at: model.activeExecutionLocation),
                identity: entry.identity
            )
        }
    }

    /// The next-up badge copy: `next_up` is the configured default model's verdict.
    static let nextUpLabel = "Next up · default model"

    /// "Recent refusal · <model> (<reason>, <age>), <model>, …": first the
    /// row's live typed refusals of single models, each with the vendor's
    /// typed evidence (or the engine's code) and when it was observed, then the
    /// requested models it refused before progress; a pre-progress mark of a
    /// model already named folds into it. A typed refusal makes routing refuse
    /// this row for that model; a pre-progress mark only orders the pool for
    /// it. Both are observations of one model, never the row's readiness.
    static func refusalLine(
        _ marks: [AccountRefusalMark],
        credentialUnusable: [AccountCredentialUnusableMark] = [],
        now: Date = Date()
    ) -> String? {
        var entries: [String] = []
        var named: Set<String> = []
        for refusal in credentialUnusable where named.insert(refusal.model).inserted {
            let reason = refusal.detail.flatMap { $0.isEmpty ? nil : $0 } ?? refusal.code
            entries.append("\(refusal.model) (\(reason), \(age(refusal.observedAt, now: now)))")
        }
        var models: [String] = []
        for mark in marks where !(mark.requestedModel.map(named.contains) ?? false)
            && !models.contains(modelLabel(mark.requestedModel)) {
            models.append(modelLabel(mark.requestedModel))
        }
        entries += models
        guard !entries.isEmpty else { return nil }
        return "Recent refusal · \(entries.joined(separator: ", "))"
    }

    /// "Last served · <model> · <age>; …", most recent first.
    static func lastServedLine(_ services: [AccountLastService], now: Date = Date()) -> String? {
        guard !services.isEmpty else { return nil }
        let parts = services.map { "\(modelLabel($0.requestedModel)) · \(age($0.observedAt, now: now))" }
        return "Last served · \(parts.joined(separator: "; "))"
    }

    static func modelLabel(_ requestedModel: String?) -> String {
        requestedModel ?? "default model"
    }

    /// English, locale-independent age of a past instant (INV-141).
    static func age(_ value: String, now: Date = Date()) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        else { return value }
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        if minutes < 1440 { return "\(minutes / 60)h ago" }
        return "\(minutes / 1440)d ago"
    }

    private static func readiness(
        availability: String?, verification: String?
    ) -> AccountReadiness {
        if availability == "available" && verification == "passed" { return .ready }
        // `unavailable + not_run` is the canonical absent/logged-out source,
        // while `available + not_run` is a presence-only probe and stays unknown.
        if availability == "unavailable" { return .unavailable }
        if availability == nil || availability == "unknown"
            || verification == nil || verification == "not_run" || verification == "unknown" {
            return .unknown
        }
        return .unavailable
    }

    /// Worst readiness across every account — the trigger dot.
    static func worstReadiness(_ rows: [AccountRowModel]) -> AccountReadiness? {
        rows.map(\.readiness).min()
    }

    /// The composer Harness+Account chip's account segment (M9-UX item 2): what
    /// the segment shows for `harnessId` given the thread/draft's pinned profile.
    /// A pin shows one named account; otherwise the stable `Automatic` label
    /// discloses that server routing may rotate. Pure so it is unit-tested.
    struct AccountSegment: Equatable {
        /// True when the thread pins a specific account (vs. following the default).
        let pinned: Bool
        let label: String
        let systemImage: String
    }

    @MainActor
    static func composerAccountSegment(
        model: AppModel, harnessId: String, pinnedProfileId: String?
    ) -> AccountSegment {
        func profileName(_ id: String) -> String {
            model.activeCredentialProfiles.first {
                $0.profile.profileId == id && $0.profile.harnessId == harnessId
            }?.profile.displayName ?? id
        }
        if let pinned = pinnedProfileId {
            return AccountSegment(pinned: true, label: profileName(pinned), systemImage: "pin.fill")
        }
        // No pin means routing may change as quota/readiness changes. Naming the
        // transient next-up route made this one stable choice oscillate between
        // "Default", "CLI login", and "API key" during projection refreshes.
        return AccountSegment(pinned: false, label: "Automatic", systemImage: "wand.and.stars")
    }

    /// Highest used-% across every account — the trigger's quota summary.
    static func worstPercent(_ rows: [AccountRowModel]) -> Int? {
        rows.compactMap(\.worstPercent).max()
    }

    /// The trailing control columns EVERY account row emits, in order. The set
    /// is STABLE across rows — under the unified model every row is a registry
    /// row carrying the same Enabled toggle, Manage/Log in action, and Delete —
    /// so the controls stay collinear (owner F8 / §2.8). Pure so column-set
    /// stability is unit-tested rather than eyeballed.
    enum AccountRowColumn: String, CaseIterable, Equatable {
        case enabled, manage, delete
    }

    /// The ordered column set for a row — identical for every row, which is
    /// exactly what keeps the trailing controls on a shared edge.
    static func columns(for row: AccountRowModel) -> [AccountRowColumn] {
        AccountRowColumn.allCases
    }

    /// The trigger's label: a single account's name, else "N accounts".
    static func triggerTitle(_ rows: [AccountRowModel]) -> String {
        switch rows.count {
        case 0: return "Accounts"
        case 1: return rows[0].displayName
        default: return "\(rows.count) accounts"
        }
    }

    /// Derive the internal profile id the user never types (owner dogfood):
    /// slugified display name when it survives the slug rules, else "acct";
    /// numeric suffixes guarantee uniqueness against the harness's registry.
    static func generatedProfileId(displayName: String, existing: Set<String>) -> String {
        var slug = ""
        for ch in displayName.lowercased() {
            if ch == " " || ch == "." { slug.append("-") }
            else if ch.isASCII && (ch.isLowercase || ch.isNumber || ch == "-" || ch == "_") {
                slug.append(ch)
            }
        }
        while let first = slug.first, first == "-" || first == "_" { slug.removeFirst() }
        slug = String(slug.prefix(60))
        let base = isValidSlug(slug) ? slug : "acct"
        if !existing.contains(base), isValidSlug(base) { return base }
        for n in 2...999 {
            let candidate = "\(base)-\(n)"
            if !existing.contains(candidate) { return candidate }
        }
        return "\(base)-\(existing.count + 1)"
    }

    /// Client-side credential-profile slug check — `^[a-z0-9][a-z0-9_-]{0,63}$`
    /// validated WITHOUT a regex (house no-regex rule). The server re-validates.
    static func isValidSlug(_ s: String) -> Bool {
        guard (1...64).contains(s.count) else { return false }
        let head = Set("abcdefghijklmnopqrstuvwxyz0123456789")
        let tail = head.union("-_")
        guard let first = s.first, head.contains(first) else { return false }
        return s.dropFirst().allSatisfy { tail.contains($0) }
    }
}

// MARK: - Auto-switch-at-quota (batch-6 item b; tri-state since A6)
//
// The accounts-popover control maps to each eligible harness's per-harness
// `profile_limit_action` (On = `rotate`, Auto = the stored kind-aware `auto`
// default, Off = `fail`). Only harnesses that actually have a SECOND account
// can rotate. Under the unified account model every identity is a registry
// row — there is no native login to fall back on — so eligibility is
// uniformly "≥2 registered rows". Pure so the target set and the aggregate
// state are unit-tested rather than eyeballed.
enum AccountsAutoBalance {
    /// Aggregate across the eligible harnesses. `auto` = every harness is on the
    /// stored kind-aware default; `mixed` = they disagree (rendered as "—");
    /// `unavailable` = no harness has a second account yet.
    enum State: Equatable { case on, off, auto, mixed, unavailable }

    /// The user's tri-state pick (A6): Off pins `fail`, Auto restores the stored
    /// kind-aware default (rotate for subscription subjects, fail for metered),
    /// On pins `rotate`. Raw values are the wire `profileLimitAction` strings.
    enum Choice: String, CaseIterable { case fail, auto, rotate }

    /// Harnesses eligible for the toggle: a server-projected pool with enough
    /// identities to rotate BETWEEN. Every account is a registry row (unified
    /// model) and rotation only draws from the ENABLED pool, so that uniformly
    /// means two or more ENABLED rows — a disabled row is not a rotation
    /// target, and counting it offered a toggle with nothing to switch to.
    /// An absent `enabled` (nil) fails open as enabled, the same rule the
    /// rest of the surface applies.
    static func eligibleHarnessIds(
        profiles: [(harnessId: String, enabled: Bool?)],
        serverEligibleHarnessIds: Set<String>
    ) -> [String] {
        var counts: [String: Int] = [:]
        for profile in profiles where profile.enabled != false {
            counts[profile.harnessId, default: 0] += 1
        }
        return counts.keys
            .filter { serverEligibleHarnessIds.contains($0) && (counts[$0] ?? 0) >= 2 }
            .sorted()
    }

    /// Aggregate on/off/auto/mixed/unavailable from each eligible harness's
    /// stored action. A hand-configured `ask` counts toward Off (it is not
    /// auto-switch), matching the setter that never erases it.
    static func state(actions: [String]) -> State {
        guard !actions.isEmpty else { return .unavailable }
        if actions.allSatisfy({ $0 == "rotate" }) { return .on }
        if actions.allSatisfy({ $0 == "auto" }) { return .auto }
        if actions.allSatisfy({ $0 == "fail" || $0 == "ask" }) { return .off }
        return .mixed
    }

    /// The wire value one harness should be patched to for a pick, or nil for
    /// no-op. Off (`fail`) downgrades rotation — explicit `rotate` or the
    /// kind-aware `auto` — but never erases a hand-configured `ask`; Auto and
    /// On set their exact value everywhere (an explicit pick of a mode).
    static func patchValue(current: String, choice: Choice) -> String? {
        if current == choice.rawValue { return nil }
        if choice == .fail, current == "ask" { return nil }
        return choice.rawValue
    }
}
