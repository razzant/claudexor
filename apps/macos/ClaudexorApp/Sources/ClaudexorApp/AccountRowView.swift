import SwiftUI
import ClaudexorKit

/// One account row inside the popover, built on the shared `AlignedListRow`
/// component (UI cut 3 §1). The identity block (status dot + name + SINGLE-LINE
/// quota/detail) and the shared-Grid trailing columns are owned by the
/// component, so this row cannot reintroduce the owner-round-3 wrap/drift bug.
/// The F1 engine cut deleted user-settable Active: the Enabled toggle is the
/// only routing control, and the row routing would pick next carries a quiet
/// informational "Next up" badge (never a control); per-thread pinning lives on
/// the composer chip.
struct AccountRowView: View {
    let row: AccountRowModel
    let login: () -> Void
    var loginDisabled = false
    /// V11b: live Enabled toggle action — PATCHes the profile / native setting.
    /// nil renders a read-only toggle (defensive; the surface always supplies it).
    var setEnabled: ((Bool) -> Void)? = nil
    /// Present when the account can be removed (registered profiles only —
    /// default vendor logins are not Claudexor's to delete).
    var delete: (() -> Void)? = nil

    /// Per-cell width FLOORS for the trailing control columns (owner F8). The
    /// shared Grid in `AlignedList` pins the true collinear edge; these only stop
    /// a cell collapsing narrower than its siblings. The column SET is stable
    /// across row kinds (`AccountsPresentation.columns`), so the toggle and
    /// Manage button never shift between a CLI-login row and a profile row.
    private enum Col {
        static let enabled: CGFloat = 30
        static let manage: CGFloat = 64
        static let delete: CGFloat = 18
    }

    var body: some View {
        AlignedListRow(identity: identity) {
            // Column 0 (enabled): the collinear anchor across every row.
            enabledToggle.alignedControlColumn(minWidth: Col.enabled)
            // Column 1 (manage / log in).
            manageButton.alignedControlColumn(minWidth: Col.manage)
            // Column 2 (delete): a clear spacer reserves the column when absent.
            deleteCell.alignedControlColumn(minWidth: Col.delete)
        }
    }

    /// The identity block: readiness dot + name (+ harness/CLI badge + optional
    /// "Next up") + the ONE single-line quota line + optional single-line detail.
    private var identity: AlignedRowIdentity {
        var badges: [AlignedRowBadge] = [
            // The native vendor login is a symmetric "CLI login" row, not "the default".
            AlignedRowBadge(row.isProfile ? row.harnessId : "CLI login", emphasis: .secondary)
        ]
        if row.nextUp {
            // F1 informational hint: this is who an unpinned run routes to next.
            badges.append(AlignedRowBadge("Next up", systemImage: "arrow.turn.down.right", emphasis: .accent))
        }
        var details: [AlignedRowDetail] = [quotaDetail]
        if let detail = row.detail {
            details.append(AlignedRowDetail(1, detail, emphasis: .secondary))
        }
        return AlignedRowIdentity(
            dotColor: row.readiness.color,
            dotHelp: row.verified ? "Verified" : "Not verified — log in",
            title: row.displayName,
            badges: badges,
            details: details)
    }

    /// ONE compact quota detail: the worst window's used-% and its reset, as a
    /// single-line string (the component enforces single-line + tail truncation).
    private var quotaDetail: AlignedRowDetail {
        guard let window = row.worstWindow, let pct = row.worstPercent else {
            return AlignedRowDetail(0, "Quota unknown", emphasis: .secondary)
        }
        var text = "\(pct)% used"
        if let reset = formattedDate(window.resetsAt) { text += " · resets \(reset)" }
        return AlignedRowDetail(0, text, emphasis: pct >= 90 ? .warning : .secondary, monospacedDigit: true)
    }

    /// D25 Enabled: symmetric on every row and LIVE (V11b). A profile row PATCHes
    /// its own `enabled`; the CLI-login row drives the harness's
    /// `native_credentials_enabled`. Reads wire truth; the set fires the PATCH
    /// (reload-after-PATCH — no faked client state).
    private var enabledToggle: some View {
        Toggle("", isOn: Binding(get: { row.enabled }, set: { setEnabled?($0) }))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
            .tint(Theme.accent)
            .disabled(setEnabled == nil)
            .help(row.isCliLogin
                ? (row.enabled
                    ? "Enabled — the native/CLI login participates in this harness's credential ladder. Turn off to exclude it."
                    : "Disabled — the native/CLI login is excluded from this harness's credential ladder.")
                : (row.enabled
                    ? "Enabled — participates in account pickers and the auto-rotation pool. Turn off to exclude it."
                    : "Disabled — excluded from account pickers and the auto-rotation pool."))
    }

    private var manageButton: some View {
        Button(row.verified ? "Manage" : "Log in", action: login)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(loginDisabled)
            .fixedSize()
            .help(row.verified
                ? "Manage this account's native login"
                : "Start the official CLI login for this account — a Terminal window opens automatically")
    }

    /// The delete control, or a clear spacer that still holds the column (so the
    /// toggle/Manage columns to its left never shift between rows that have a
    /// trash and rows that don't).
    @ViewBuilder private var deleteCell: some View {
        if let delete {
            Button(role: .destructive, action: delete) { Image(systemName: "trash") }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Remove this account: its registration and its own login/key. The default \(row.family.label) login is untouched.")
        } else {
            AlignedColumnSpacer(width: Col.delete)
        }
    }
}
