import SwiftUI
import ClaudexorKit

// MARK: - Accounts (bottom-left compact control, INV-135)
//
// Replaces the always-expanded sidebar quota footer with ONE Claude-Code-style
// control: a compact trigger row (worst readiness dot + account name/count +
// worst quota % + chevron) that expands into a popover to add + log in accounts
// in-app (NO terminal), read compact per-account quotas, and toggle
// auto-balance. Registered profiles come from GET /v2/credential-profiles;
// default logins from the same doctor/quota models the old footer used.

/// Readiness verdict for one account row (the worst wins for the trigger dot).
enum AccountReadiness: Int, Comparable {
    case unavailable = 0, unknown = 1, ready = 2
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
    var color: Color {
        switch self {
        case .ready: return Theme.status(.succeeded)
        case .unknown: return .orange
        case .unavailable: return Theme.status(.failed)
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
    /// nil => the engine-default login for `family`; else the credential profile.
    let profileId: String?
    let detail: String?
    let quotaGroups: [QuotaPresentation.Group]

    var isProfile: Bool { profileId != nil }

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
            let readiness: AccountReadiness = switch info.health {
            case .ok: .ready
            case .degraded: .unknown
            case .unavailable: .unavailable
            }
            rows.append(AccountRowModel(
                id: "default/\(family.rawValue)",
                displayName: family.label,
                harnessId: family.rawValue,
                family: family,
                readiness: readiness,
                verified: info.nativeSessionReady,
                profileId: nil,
                detail: nil,
                quotaGroups: groups.filter { $0.subjectId == nil && $0.harness == family.rawValue }
            ))
        }

        // Registered profiles (additive; the default login is never touched).
        for entry in model.credentialProfiles {
            let availability = entry.status.availability
            let readiness: AccountReadiness = availability == "available" ? .ready
                : availability == "unknown" ? .unknown : .unavailable
            rows.append(AccountRowModel(
                id: "profile/\(entry.profile.harnessId)/\(entry.profile.profileId)",
                displayName: entry.profile.displayName,
                harnessId: entry.profile.harnessId,
                family: HarnessFamily(rawValue: entry.profile.harnessId),
                readiness: readiness,
                verified: availability == "available",
                profileId: entry.profile.profileId,
                detail: entry.status.detail,
                quotaGroups: groups.filter { $0.subjectId == entry.profile.profileId }
            ))
        }
        return rows
    }

    /// Worst readiness across every account — the trigger dot.
    static func worstReadiness(_ rows: [AccountRowModel]) -> AccountReadiness? {
        rows.map(\.readiness).min()
    }

    /// Highest used-% across every account — the trigger's quota summary.
    static func worstPercent(_ rows: [AccountRowModel]) -> Int? {
        rows.compactMap(\.worstPercent).max()
    }

    /// The trigger's label: a single account's name, else "N accounts".
    static func triggerTitle(_ rows: [AccountRowModel]) -> String {
        switch rows.count {
        case 0: return "Accounts"
        case 1: return rows[0].displayName
        default: return "\(rows.count) accounts"
        }
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

/// The compact bottom-left trigger row that opens the accounts popover.
struct AccountsTriggerRow: View {
    @Environment(AppModel.self) private var model
    @State private var showPopover = false

    private var rows: [AccountRowModel] { AccountsPresentation.rows(model: model) }

    var body: some View {
        VStack(spacing: 0) {
            Divider().opacity(0.45)
            Button { showPopover = true } label: { trigger }
                .buttonStyle(.plain)
                .help("Manage accounts — add, log in, view quota, auto-switch")
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.xs)
        }
        .task { await model.refreshCredentialProfiles() }
        .popover(isPresented: $showPopover, arrowEdge: .trailing) {
            AccountsPopover(isPresented: $showPopover).environment(model)
        }
    }

    /// Deliberately QUIET (one small line): a dot, the account name/count, the
    /// worst quota %, and a chevron — it must not compete with the thread list.
    private var trigger: some View {
        HStack(spacing: Theme.Spacing.xs) {
            if model.health != .connected {
                Image(systemName: "wifi.slash").font(.caption2).foregroundStyle(.secondary)
            } else {
                Circle()
                    .fill((AccountsPresentation.worstReadiness(rows) ?? .unknown).color)
                    .frame(width: 8, height: 8)
            }
            Text(AccountsPresentation.triggerTitle(rows))
                .font(.caption).foregroundStyle(.primary).lineLimit(1)
            Spacer(minLength: Theme.Spacing.xs)
            if let pct = AccountsPresentation.worstPercent(rows) {
                Text("\(pct)%")
                    .font(.caption2).monospacedDigit()
                    .foregroundStyle(pct >= 90 ? .orange : .secondary)
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }
}

/// The expanded accounts popover: per-account rows (readiness + one quota line +
/// in-app Log in), the auto-balance toggle, quota refresh, and a guided add flow.
struct AccountsPopover: View {
    @Environment(AppModel.self) private var model
    @Binding var isPresented: Bool

    @State private var addHarness = "claude"
    @State private var addId = ""
    @State private var addDisplayName = ""
    @State private var addError: String?
    @State private var adding = false
    @State private var refreshing = false
    @State private var showQuotaDetail = false

    private var rows: [AccountRowModel] { AccountsPresentation.rows(model: model) }
    private var trimmedAddId: String { addId.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            header
            if model.health != .connected {
                Label("Accounts and quota are unavailable while the engine is offline.",
                      systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                accountsList
                autoBalanceToggle
                Divider()
                addSection
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: 340)
        .task { await model.refreshCredentialProfiles(); await model.refreshSettings() }
        .popover(isPresented: $showQuotaDetail, arrowEdge: .trailing) {
            QuotaDetailView().environment(model).frame(width: 420, height: 460)
        }
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text("Accounts").font(.headline)
            Spacer()
            Button { showQuotaDetail = true } label: {
                Image(systemName: "gauge.with.dots.needle.67percent")
            }
            .buttonStyle(.borderless)
            .help("All quota windows and provenance")
            Button {
                refreshing = true
                Task {
                    await model.refreshQuota(force: true)
                    await model.refreshCredentialProfiles()
                    refreshing = false
                }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .disabled(refreshing)
            .help("Refresh quota and account readiness from official provider sources")
        }
    }

    private var accountsList: some View {
        VStack(spacing: Theme.Spacing.xs) {
            if rows.isEmpty {
                Label("No accounts yet — add one below.", systemImage: "person.crop.circle.badge.plus")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(rows) { row in
                    AccountRowView(row: row) { startLogin(row) }
                }
            }
        }
    }

    private var autoBalanceToggle: some View {
        VStack(alignment: .leading, spacing: 2) {
            Toggle(isOn: Binding(
                get: { model.autoBalanceState == .on },
                set: { on in Task { await model.setAutoBalance(on) } }
            )) {
                Text("Auto-switch accounts at quota limit").font(.callout)
            }
            .toggleStyle(.switch)
            .tint(Theme.accent)
            Text(model.autoBalanceState == .mixed
                ? "Claude and Codex disagree — turning this on sets both to rotate."
                : "When one account hits its quota, runs continue on another registered account.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Add account").font(.subheadline.weight(.semibold))
            HStack(spacing: Theme.Spacing.sm) {
                Picker("", selection: $addHarness) {
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
                }
                .labelsHidden()
                .fixedSize()
                TextField("account id (e.g. work)", text: $addId)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
            }
            TextField("display name (optional)", text: $addDisplayName)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
            addValidationText
            HStack {
                Text("A second Claude/Codex subscription — logs in in-app, no terminal.")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button(adding ? "Adding…" : "Add & log in") { Task { await addAccount() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .controlSize(.small)
                    .disabled(adding || !AccountsPresentation.isValidSlug(trimmedAddId))
            }
        }
    }

    /// Inline slug/server error line — server error wins; otherwise a live
    /// client-side hint while the typed id is not yet a valid slug.
    @ViewBuilder private var addValidationText: some View {
        if let err = addError {
            Text(err).font(.caption2).foregroundStyle(Theme.status(.failed)).textSelection(.enabled)
        } else if !trimmedAddId.isEmpty && !AccountsPresentation.isValidSlug(trimmedAddId) {
            Text("Use lowercase letters, digits, - or _ (must start with a letter or digit; max 64).")
                .font(.caption2).foregroundStyle(.orange)
        }
    }

    /// Open the shared AuthSheet for this account's login. Routed model-level so
    /// the sheet survives this popover dismissing.
    private func startLogin(_ row: AccountRowModel) {
        model.authSheetTarget = AuthSheetTarget(family: row.family, profileId: row.profileId)
        isPresented = false
    }

    private func addAccount() async {
        let id = trimmedAddId
        guard AccountsPresentation.isValidSlug(id) else {
            addError = "Use lowercase letters, digits, - or _ (must start with a letter or digit; max 64)."
            return
        }
        adding = true
        addError = nil
        defer { adding = false }
        let display = addDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = await model.createCredentialProfile(
            harnessId: addHarness, profileId: id, displayName: display.isEmpty ? nil : display)
        if let error = result.error {
            addError = error   // 409 duplicate id / 400 invalid slug or harness — server text.
            return
        }
        // Success: clear the form and immediately offer the new account's login.
        addId = ""
        addDisplayName = ""
        model.authSheetTarget = AuthSheetTarget(family: HarnessFamily(rawValue: addHarness), profileId: id)
        isPresented = false
    }
}

/// One account row inside the popover. A separate view so the popover's body
/// stays small for the Swift type-checker (composerControlsRow precedent).
private struct AccountRowView: View {
    let row: AccountRowModel
    let login: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Circle()
                .fill(row.readiness.color)
                .frame(width: 8, height: 8)
                .padding(.top, 4)
                .help(row.verified ? "Verified" : "Not verified — log in")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Spacing.xs) {
                    Text(row.displayName).font(.callout.weight(.medium))
                    Text(row.isProfile ? row.harnessId : "default")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                quotaLine
                if let detail = row.detail {
                    Text(detail).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail).help(detail)
                }
            }
            Spacer()
            if !row.verified {
                Button("Log in", action: login)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Start the native login for this account (in-app, no terminal)")
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    /// ONE compact quota line: the worst window's used-% and its reset.
    @ViewBuilder private var quotaLine: some View {
        if let window = row.worstWindow, let pct = row.worstPercent {
            HStack(spacing: Theme.Spacing.xs) {
                Text("\(pct)% used")
                    .font(.caption2).monospacedDigit()
                    .foregroundStyle(pct >= 90 ? .orange : .secondary)
                if let reset = formattedDate(window.resetsAt) {
                    Text("· resets \(reset)").font(.caption2).foregroundStyle(.secondary)
                }
            }
        } else {
            Text("Quota unknown").font(.caption2).foregroundStyle(.secondary)
        }
    }
}
