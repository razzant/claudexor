import SwiftUI
import ClaudexorKit

// MARK: - Accounts presentation models (INV-135)
//
// The row model + pure assembly behind the accounts surface, extracted from
// AccountsPopover.swift (readability ratchet). The views live in
// AccountsPopover.swift; the SSOT projection lives here.

/// Readiness verdict for one account row (the worst wins for the trigger dot).
enum AccountReadiness: Int, Comparable {
    case unavailable = 0, unknown = 1, ready = 2
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
    var color: Color {
        switch self {
        case .ready: return Theme.status(.positive)
        case .unknown: return Theme.status(.caution)
        case .unavailable: return Theme.status(.negative)
        }
    }
}

/// One row in the accounts popover — a registered profile or a default login.
struct AccountRowModel: Identifiable {
    let id: String
    let displayName: String
    let harnessId: String
    let family: HarnessFamily
    let readiness: AccountReadiness
    let verified: Bool
    /// nil => the engine-default login for `family` (the "CLI login" row); else
    /// the credential profile.
    let profileId: String?
    let detail: String?
    let quotaGroups: [QuotaPresentation.Group]
    /// D25 Enabled: participates in pickers + the auto-rotation pool. For a
    /// profile row this is the wire `profile.enabled`; for the CLI-login row it
    /// is the harness's `native_credentials_enabled` (V11b). LIVE — the toggle
    /// PATCHes the owning surface (profile route / harness settings). This is the
    /// ONLY routing control (the F1 engine cut deleted user-settable Active).
    let enabled: Bool
    /// Server-computed NEXT-UP (F1 engine `next_up`): true when an unpinned run of
    /// this harness would route to THIS row next. INFORMATIONAL only — rendered
    /// as a quiet "Next up" badge, never a control. false when the projection is
    /// absent (older daemon) or another row is next up.
    let nextUp: Bool

    var isProfile: Bool { profileId != nil }
    /// The native vendor login row (not one of Claudexor's credential profiles).
    var isCliLogin: Bool { profileId == nil }

    /// The single worst usage window across the account's quota groups; drives
    /// the ONE compact quota line the popover shows per account.
    var worstWindow: QuotaPresentation.Window? {
        quotaGroups.flatMap(\.windows).max { ($0.usedRatio ?? -1) < ($1.usedRatio ?? -1) }
    }
    var worstPercent: Int? {
        worstWindow?.usedRatio.map { Int(($0 * 100).rounded()) }
    }
}

/// Pure assembly of account rows from the model's profile + readiness + quota
/// state, plus the trigger's worst-of aggregates.
enum AccountsPresentation {
    @MainActor
    static func rows(model: AppModel) -> [AccountRowModel] {
        let groups = QuotaPresentation.groups(from: model.quotaResponse?.snapshots ?? [])
        var rows: [AccountRowModel] = []

        // Default logins: one per native-login family the doctor knows.
        for info in model.liveHarnesses
        where info.family.defaultAuthReadinessRequest?.source == .nativeSession {
            let family = info.family
            let source = model.authSource(for: family, source: .nativeSession)
            // V11b per-harness accounts authority for the native/CLI-login row.
            let accounts = model.harnessAccounts(for: family.rawValue)
            rows.append(AccountRowModel(
                id: "default/\(family.rawValue)",
                displayName: family.label,
                harnessId: family.rawValue,
                family: family,
                readiness: readiness(
                    availability: source?.availability, verification: source?.verification),
                verified: source?.isVerifiedNativeSession == true,
                profileId: nil,
                detail: source?.detail,
                quotaGroups: groups.filter { $0.subjectId == nil && $0.harness == family.rawValue },
                // The native/CLI login's "Enabled" is the harness setting
                // `native_credentials_enabled` (V11b) — LIVE via the settings
                // PATCH surface. Absent projection => symmetrically enabled.
                enabled: accounts?.nativeCredentialsEnabled ?? true,
                nextUp: accounts?.nextUp.isNative ?? false
            ))
        }

        // Registered profiles (additive; the default login is never touched).
        for entry in model.credentialProfiles {
            let availability = entry.status.availability
            let verification = entry.status.verification
            let accounts = model.harnessAccounts(for: entry.profile.harnessId)
            rows.append(AccountRowModel(
                id: "profile/\(entry.profile.harnessId)/\(entry.profile.profileId)",
                displayName: entry.profile.displayName,
                harnessId: entry.profile.harnessId,
                family: HarnessFamily(rawValue: entry.profile.harnessId),
                readiness: readiness(availability: availability, verification: verification),
                verified: availability == "available" && verification == "passed",
                profileId: entry.profile.profileId,
                detail: entry.status.detail,
                quotaGroups: groups.filter {
                    $0.subjectId == entry.profile.profileId && $0.harness == entry.profile.harnessId
                },
                enabled: entry.profile.enabled,
                nextUp: accounts?.nextUp.isProfile(entry.profile.profileId) ?? false
            ))
        }
        return rows
    }

    private static func readiness(
        availability: String?, verification: String?
    ) -> AccountReadiness {
        if availability == "available" && verification == "passed" { return .ready }
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
    /// A pin overrides; otherwise the segment follows the harness's GLOBAL Active
    /// default (server-computed). Pure so it is unit-tested.
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
            model.credentialProfiles.first {
                $0.profile.profileId == id && $0.profile.harnessId == harnessId
            }?.profile.displayName ?? id
        }
        if let pinned = pinnedProfileId {
            return AccountSegment(pinned: true, label: profileName(pinned), systemImage: "pin.fill")
        }
        // No pin → follow the harness's next-up identity from the server
        // projection (what routing would pick — informational).
        guard let identity = model.harnessAccounts(for: harnessId)?.nextUp else {
            return AccountSegment(pinned: false, label: "Default", systemImage: "person.crop.circle")
        }
        switch identity {
        case .profile(let id): return AccountSegment(pinned: false, label: profileName(id), systemImage: "person.crop.circle")
        case .native: return AccountSegment(pinned: false, label: "CLI login", systemImage: "person.crop.circle")
        case .none: return AccountSegment(pinned: false, label: "No account", systemImage: "exclamationmark.circle")
        }
    }

    /// Highest used-% across every account — the trigger's quota summary.
    static func worstPercent(_ rows: [AccountRowModel]) -> Int? {
        rows.compactMap(\.worstPercent).max()
    }

    /// The trailing control columns EVERY account row emits, in order. The set is
    /// STABLE across row kinds (CLI-login vs profile) — a profile carries a real
    /// trash control where the CLI-login row reserves a clear spacer of the same
    /// width — so the Enabled toggle and Manage button stay collinear regardless
    /// of which controls a given row actually renders (owner F8 / §2.8). Pure so
    /// column-set stability is unit-tested rather than eyeballed.
    enum AccountRowColumn: String, CaseIterable, Equatable {
        case enabled, manage, delete
    }

    /// The ordered column set for a row — identical for every row kind, which is
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
