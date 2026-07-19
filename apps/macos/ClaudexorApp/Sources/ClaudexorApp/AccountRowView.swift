import SwiftUI
import ClaudexorKit

/// One account row inside the popover. A separate view so the popover's body
/// stays small for the Swift type-checker (composerControlsRow precedent).
struct AccountRowView: View {
    let row: AccountRowModel
    let login: () -> Void
    var loginDisabled = false
    /// The active account for the current thread/draft (the D25 Active marker).
    var active = false
    /// V11b: live Enabled toggle action — PATCHes the profile / native setting.
    /// nil renders a read-only toggle (defensive; the surface always supplies it).
    var setEnabled: ((Bool) -> Void)? = nil
    /// "Make active" (M9-UX item 2): set this row as the harness's GLOBAL routing
    /// default. nil when it is already active or cannot become active.
    var makeActive: (() -> Void)? = nil
    /// Present when the account can be removed (registered profiles only —
    /// default vendor logins are not Claudexor's to delete).
    var delete: (() -> Void)? = nil

    /// The row is ONE `GridRow` in the accounts `Grid` (owner F8). The trailing
    /// controls are real Grid COLUMNS shared across every sibling row, so the
    /// Enabled toggle (and every other control) lands on the exact same x in ALL
    /// rows regardless of the identity width or which other controls a row carries
    /// (Manage+Active vs Manage+Make active+trash). Absent controls render a
    /// clear spacer that still reserves the column. See docs/DESIGN_SYSTEM.md
    /// "Row alignment". The fixed widths here are only per-cell FLOORS — the Grid
    /// pins the actual shared column edge.
    private enum Col {
        static let enabled: CGFloat = 30
        static let login: CGFloat = 64
        static let active: CGFloat = 100
        static let delete: CGFloat = 18
    }

    var body: some View {
        GridRow(alignment: .top) {
            // Column 0: identity (readiness dot + name/quota/detail) — absorbs the
            // slack so the trailing columns share a fixed edge.
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Circle()
                    .fill(row.readiness.color)
                    .frame(width: 8, height: 8)
                    .padding(.top, 4)
                    .help(row.verified ? "Verified" : "Not verified — log in")
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Theme.Spacing.xs) {
                        Text(row.displayName).font(.callout.weight(.medium)).lineLimit(1)
                        // D25: the native vendor login is a symmetric "CLI login"
                        // row, no longer visually "the default".
                        Text(row.isProfile ? row.harnessId : "CLI login")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    quotaLine
                    if let detail = row.detail {
                        Text(detail).font(.caption2).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.tail).help(detail)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .gridColumnAlignment(.leading)

            // Column 1: Enabled toggle — the collinear anchor across every row.
            enabledToggle
                .frame(minWidth: Col.enabled)
                .gridColumnAlignment(.center)

            // Column 2: Manage / Log in.
            manageButton
                .frame(minWidth: Col.login)
                .gridColumnAlignment(.center)

            // Column 3: status / "Make active" (or an empty reserved cell).
            activeControl
                .frame(minWidth: Col.active, alignment: .trailing)
                .gridColumnAlignment(.trailing)

            // Column 4: delete — a clear spacer keeps the column when absent.
            deleteCell
                .frame(minWidth: Col.delete)
                .gridColumnAlignment(.center)
        }
    }

    /// D25 Enabled: symmetric on every row and LIVE (V11b). A profile row PATCHes
    /// its own `enabled`; the CLI-login row drives the harness's
    /// `native_credentials_enabled`. The toggle reads wire truth and the set fires
    /// the PATCH (reload-after-PATCH — no faked client state).
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
            Color.clear.frame(width: Col.delete, height: 1)
        }
    }

    /// The Active column (M9-UX items 1 + 2): the routing-default marker or the
    /// "Make active" affordance. Item 1: when the Active identity is not ready its
    /// marker DEGRADES — dimmed + verbally qualified ("Active · unverified" /
    /// "Active · not logged in") — so it never reads as operational.
    @ViewBuilder private var activeControl: some View {
        if active {
            if row.readiness == .ready {
                Label("Active", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.accent)
                    .lineLimit(1)
                    .help("The routing default — new runs of this harness use this account.")
            } else {
                Label(AccountsPresentation.activeMarkerLabel(readiness: row.readiness),
                      systemImage: "exclamationmark.circle")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .opacity(0.7)
                    .lineLimit(1)
                    .help("This is the routing default, but it is NOT ready. Until you log in / verify it, a run will fail or fall back to another account.")
            }
        } else if let makeActive {
            // Item 5: kept WORKING (the wire still has Active) but deliberately
            // secondary — a concurrent engine cut removes the Active concept, so
            // this is a quiet text button, not a prominent affordance.
            Button("Make active", action: makeActive)
                .buttonStyle(.borderless)
                .controlSize(.small)
                .font(.caption)
                .foregroundStyle(.secondary)
                .help("Make this the harness's active account — the global default new runs use.")
        }
    }

    /// ONE compact quota line: the worst window's used-% and its reset.
    @ViewBuilder private var quotaLine: some View {
        if let window = row.worstWindow, let pct = row.worstPercent {
            HStack(spacing: Theme.Spacing.xs) {
                Text("\(pct)% used")
                    .font(.caption2).monospacedDigit()
                    .foregroundStyle(pct >= 90 ? Theme.status(.caution) : .secondary)
                if let reset = formattedDate(window.resetsAt) {
                    Text("· resets \(reset)").font(.caption2).foregroundStyle(.secondary)
                }
            }
        } else {
            Text("Quota unknown").font(.caption2).foregroundStyle(.secondary)
        }
    }
}
