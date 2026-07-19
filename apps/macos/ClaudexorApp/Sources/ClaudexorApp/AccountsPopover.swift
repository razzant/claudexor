import SwiftUI
import ClaudexorKit

// MARK: - Accounts (bottom-left compact control, INV-135)
//
// Replaces the always-expanded sidebar quota footer with ONE Claude-Code-style
// control: a compact trigger row (worst readiness dot + account name/count +
// worst quota % + chevron) that expands into a popover to add + log in accounts
// in-app (no commands to copy; the native login still auto-opens the official
// vendor CLI in Terminal), read compact per-account quotas, and toggle
// auto-balance. Registered profiles come from GET /v2/credential-profiles;
// default logins from the same doctor/quota models the old footer used.

/// The sidebar footer (bottom-left): a quiet update chip (M5c shell), the active
/// credential-profile line, and the accounts trigger. Composed so the footer is
/// ONE ordered stack rather than three ad-hoc rows scattered in the thread list.
struct SidebarFooter: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            UpdateChip()
            FooterProfileRow()
            AccountsTriggerRow()
        }
        // Read the local override on appear; the real updater (M7) will drive
        // the same field. Cheap file read — no network, no fake state.
        .onAppear { model.refreshUpdateAvailability() }
    }
}

/// The bottom-left update chip (M5c shell). Renders NOTHING until the (future
/// M7) updater — via the local override for now — reports a pending version.
struct UpdateChip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let update = model.updateAvailability {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.caption).foregroundStyle(Theme.accent)
                Text("Update available")
                    .font(.caption).foregroundStyle(.secondary)
                Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.tertiary)
                Text("v\(update.version)")
                    .font(.caption.weight(.medium)).foregroundStyle(Theme.accent)
                    .monospacedDigit()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help(update.url.map { "Update to v\(update.version) — \($0)" }
                  ?? "Update to v\(update.version) is available.")
        }
    }
}

/// The active credential-profile line: which account the next turn will use,
/// shown next to its harness. Truth from the wire (thread/draft sticky); hidden
/// when there is no resolved harness.
struct FooterProfileRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let footer = model.activeAccountFooter {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "person.crop.circle")
                    .font(.caption).foregroundStyle(.secondary)
                Text(footer.harnessLabel)
                    .font(.caption.weight(.medium)).foregroundStyle(.primary)
                if let name = footer.profileName {
                    Text("·").font(.caption).foregroundStyle(.tertiary)
                    Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    Text("· auto routing").font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.top, Theme.Spacing.xs)
            .help(footer.profileName.map { "Next turn authenticates as \(footer.harnessLabel) · \($0)." }
                  ?? "Next turn uses automatic account routing for \(footer.harnessLabel).")
        }
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
                .padding(.vertical, Theme.Spacing.sm)
        }
        .task { await model.refreshCredentialProfiles() }
        .popover(isPresented: $showPopover, arrowEdge: .trailing) {
            AccountsPopover(isPresented: $showPopover).environment(model)
        }
    }

    /// One READABLE line (owner dogfood: the first cut was too small): a dot,
    /// the account name/count, the worst quota %, and a chevron. Still a single
    /// quiet row — it must not compete with the thread list.
    private var trigger: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if model.health != .connected {
                Image(systemName: "wifi.slash").font(.callout).foregroundStyle(.secondary)
            } else {
                Circle()
                    .fill((AccountsPresentation.worstReadiness(rows) ?? .unknown).color)
                    .frame(width: 9, height: 9)
            }
            Text(AccountsPresentation.triggerTitle(rows))
                .font(.callout.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
            Spacer(minLength: Theme.Spacing.xs)
            if let pct = AccountsPresentation.worstPercent(rows) {
                Text("\(pct)%")
                    .font(.callout).monospacedDigit()
                    .foregroundStyle(pct >= 90 ? Theme.status(.caution) : .secondary)
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }
}

/// The expanded accounts popover: the shared accounts surface plus the
/// popover-only chrome (header with quota detail/refresh, auto-balance toggle).
struct AccountsPopover: View {
    @Environment(AppModel.self) private var model
    @Binding var isPresented: Bool

    @State private var refreshing = false
    @State private var showQuotaDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            header
            if model.health != .connected {
                Label("Accounts and quota are unavailable while the engine is offline.",
                      systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                AccountsSurface(family: nil) { row in
                    // Routed model-level so the AuthSheet survives this popover
                    // dismissing.
                    model.authSheetTarget = AuthSheetTarget(family: row.family, profileId: row.profileId)
                    isPresented = false
                }
                autoBalanceToggle
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: 340)
        .task { await model.refreshSettings() }   // profiles refresh lives in AccountsSurface
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
}

/// The ONE accounts control surface (SSOT, owner directive): account rows with
/// in-app log in + remove, and the no-ids-to-invent add flow. Hosted by the
/// bottom-left popover (all families) AND the AuthSheet the Settings doctor's
/// "Manage" opens (scoped to its family) — never forked per surface.
struct AccountsSurface: View {
    @Environment(AppModel.self) private var model
    /// nil = every family (popover); set = only that family's accounts.
    let family: HarnessFamily?
    /// False when the host already IS the default login surface (AuthSheet) —
    /// only registered profiles are listed there.
    var includeDefaults = true
    /// Present the login UI for a row's account; the host owns presentation.
    let login: (AccountRowModel) -> Void
    /// Host-owned lifecycle gate (the AuthSheet disables its current target
    /// while setup recovery/action state is unresolved).
    var loginDisabled: (AccountRowModel) -> Bool = { _ in false }

    @State private var addDisplayName = ""
    @State private var addHarnessChoice = "claude"
    @State private var addError: String?
    @State private var adding = false
    @State private var pendingDelete: AccountRowModel?
    @State private var deleting = false
    @State private var deleteNotice: String?

    /// The add form registers config_dir_login profiles (claude|codex only —
    /// the same rule the daemon enforces).
    private var addHarness: String? {
        guard let family else { return addHarnessChoice }
        let id = family.setupHarnessId
        return id == "claude" || id == "codex" ? id : nil
    }

    private var rows: [AccountRowModel] {
        AccountsPresentation.rows(model: model).filter { row in
            (includeDefaults || row.isProfile)
                && (family == nil || row.harnessId == family?.setupHarnessId)
        }
    }

    private var selectedProfileId: String? {
        model.selectedThreadId == nil
            ? model.draftCredentialProfileId
            : model.currentThread?.credentialProfileId
    }

    private var selectedHarnessId: String? {
        model.selectedThreadId == nil
            ? model.draftPrimaryHarness
            : model.currentThread?.primaryHarness
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if selectedProfileId != nil {
                Button {
                    Task { await model.setThreadCredentialProfile(nil) }
                } label: {
                    Label("Use automatic account routing", systemImage: "arrow.triangle.branch")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Clear the thread's manual account choice and return to the engine-default ladder")
            }
            accountsList
            if let notice = deleteNotice {
                Text(notice).font(.caption2).foregroundStyle(Theme.status(.negative))
                    .textSelection(.enabled)
            }
            if addHarness != nil {
                Divider()
                addSection
            }
        }
        .task { await model.refreshCredentialProfiles() }
        .confirmationDialog(
            "Remove \(pendingDelete?.displayName ?? "account")?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove Account", role: .destructive) {
                if let row = pendingDelete { Task { await deleteAccount(row) } }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("Deletes this account's registration and its own login/key from Claudexor. The default \(pendingDelete?.family.label ?? "vendor") login is untouched.")
        }
    }

    /// The D25 Active marker, symmetric across profile rows AND the CLI login.
    /// V11b: the SERVER computes the Active identity per harness (the account a
    /// new run defaults to), so the marker binds to that projection verbatim.
    /// Only when the projection is absent (pre-V11b daemon) does it fall back to
    /// the client-derived thread/draft pin state.
    private func isActive(_ row: AccountRowModel) -> Bool {
        if let serverActive = row.serverActive { return serverActive }
        if row.isProfile {
            return row.profileId == selectedProfileId
                && (selectedHarnessId == nil || selectedHarnessId == row.harnessId)
        }
        // CLI login row: active when its harness is the thread/draft primary and
        // no profile is pinned.
        return selectedProfileId == nil && selectedHarnessId == row.harnessId
    }

    /// The Enabled-toggle action for a row (V11b — LIVE). A profile row PATCHes
    /// its own `enabled`; the CLI-login row drives the harness's
    /// `native_credentials_enabled` via the settings surface. Both reload the
    /// projection after (the popover's reload-after-PATCH pattern).
    private func enabledAction(_ row: AccountRowModel) -> (Bool) -> Void {
        { enabled in
            Task {
                if let profileId = row.profileId {
                    await model.setProfileEnabled(
                        harnessId: row.harnessId, profileId: profileId, enabled: enabled)
                } else {
                    await model.setNativeCredentialsEnabled(
                        harnessId: row.harnessId, enabled: enabled)
                }
            }
        }
    }

    /// The "Use" action for a row, or nil when it is already active / cannot be
    /// made active. Verified profiles pin the thread; the CLI login clears the
    /// pin back to the vendor login. Both are the wire-backed thread PATCH.
    private func useAction(_ row: AccountRowModel) -> (() -> Void)? {
        guard !isActive(row) else { return nil }
        if row.isProfile, row.verified {
            return {
                Task {
                    await model.setThreadCredentialProfile(row.profileId, harnessId: row.harnessId)
                }
            }
        }
        if row.isCliLogin, selectedHarnessId == row.harnessId {
            // Clear the manual pin → the harness falls back to its CLI login.
            return { Task { await model.setThreadCredentialProfile(nil, harnessId: row.harnessId) } }
        }
        return nil
    }

    private var accountsList: some View {
        VStack(spacing: Theme.Spacing.xs) {
            if rows.isEmpty {
                Label("No accounts yet — add one below.", systemImage: "person.crop.circle.badge.plus")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(rows) { row in
                    AccountRowView(
                        row: row,
                        login: { login(row) },
                        loginDisabled: loginDisabled(row),
                        active: isActive(row),
                        // V11b: the Enabled toggle is LIVE — a profile row PATCHes
                        // its own `enabled`; the CLI-login row drives the harness's
                        // `native_credentials_enabled` via the settings surface.
                        setEnabled: enabledAction(row),
                        // "Use" makes a row the thread's active account (wire-backed
                        // PATCH of thread.credentialProfileId). Offered for a verified
                        // profile, and for the CLI login (nil profile = clear the pin
                        // back to the vendor login) — symmetric across row kinds.
                        use: useAction(row),
                        delete: row.isProfile && !deleting ? { pendingDelete = row } : nil
                    )
                }
            }
        }
    }

    /// Owner dogfood: no ids to invent — pick the vendor (unless the host is
    /// already family-scoped), optionally name it, press one button. The
    /// internal profile id is derived from the name and never asked for.
    private var addSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Add another account").font(.subheadline.weight(.semibold))
            HStack(spacing: Theme.Spacing.sm) {
                if family == nil {
                    Picker("", selection: $addHarnessChoice) {
                        Text("Claude").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                TextField("name (optional, e.g. Work)", text: $addDisplayName)
                    .textFieldStyle(.roundedBorder)
                    .font(.callout)
                    .onSubmit { Task { await addAccount() } }
            }
            if let err = addError {
                Text(err).font(.caption2).foregroundStyle(Theme.status(.negative)).textSelection(.enabled)
            }
            HStack {
                Text("A second \(family?.label ?? "Claude/Codex") subscription — one click opens the official CLI login.")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button(adding ? "Adding…" : "Add & log in") { Task { await addAccount() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .controlSize(.small)
                    .disabled(adding)
            }
        }
    }

    private func addAccount() async {
        guard !adding, let harness = addHarness else { return }
        adding = true
        addError = nil
        defer { adding = false }
        let display = addDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let existing = Set(model.credentialProfiles
            .filter { $0.profile.harnessId == harness }
            .map(\.profile.profileId))
        let id = AccountsPresentation.generatedProfileId(displayName: display, existing: existing)
        let result = await model.createCredentialProfile(
            harnessId: harness, profileId: id, displayName: display.isEmpty ? nil : display)
        if let error = result.error {
            addError = error   // 409 duplicate id / 400 invalid slug or harness — server text.
            return
        }
        // Success: clear the form and immediately offer the new account's login.
        addDisplayName = ""
        login(AccountRowModel(
            id: "profile/\(harness)/\(id)",
            displayName: display.isEmpty ? id : display,
            harnessId: harness,
            family: HarnessFamily(rawValue: harness),
            readiness: .unknown,
            verified: false,
            profileId: id,
            detail: nil,
            quotaGroups: [],
            enabled: true,
            serverActive: nil
        ))
    }

    private func deleteAccount(_ row: AccountRowModel) async {
        guard let profileId = row.profileId, !deleting else { return }
        deleting = true
        deleteNotice = nil
        defer { deleting = false; pendingDelete = nil }
        // nil = removed cleanly; else the daemon's refusal (409 while a login
        // job is active) or a disclosed cleanup warning — shown verbatim.
        deleteNotice = await model.deleteCredentialProfile(
            harnessId: row.harnessId, profileId: profileId)
    }
}

/// One account row inside the popover. A separate view so the popover's body
/// stays small for the Swift type-checker (composerControlsRow precedent).
private struct AccountRowView: View {
    let row: AccountRowModel
    let login: () -> Void
    var loginDisabled = false
    /// The active account for the current thread/draft (the D25 Active marker).
    var active = false
    /// V11b: live Enabled toggle action — PATCHes the profile / native setting.
    /// nil renders a read-only toggle (defensive; the surface always supplies it).
    var setEnabled: ((Bool) -> Void)? = nil
    var use: (() -> Void)? = nil
    /// Present when the account can be removed (registered profiles only —
    /// default vendor logins are not Claudexor's to delete).
    var delete: (() -> Void)? = nil

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
                    // D25: the native vendor login is a symmetric "CLI login" row,
                    // no longer visually "the default".
                    Text(row.isProfile ? row.harnessId : "CLI login")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                quotaLine
                if let detail = row.detail {
                    Text(detail).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail).help(detail)
                }
            }
            Spacer()
            // D25 Enabled: symmetric on every row and LIVE (V11b). A profile row
            // PATCHes its own `enabled`; the CLI-login row drives the harness's
            // `native_credentials_enabled`. The toggle reads wire truth and the
            // set fires the PATCH (reload-after-PATCH — no faked client state).
            Toggle("", isOn: Binding(
                get: { row.enabled },
                set: { setEnabled?($0) }
            ))
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
            Button(row.verified ? "Manage" : "Log in", action: login)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(loginDisabled)
                .help(row.verified
                    ? "Manage this account's native login"
                    : "Start the official CLI login for this account — a Terminal window opens automatically")
            // D25 Active marker: symmetric across profile rows AND the CLI login —
            // the account the current thread/draft authenticates as. No row is
            // visually "the default" beyond THIS marker.
            if active {
                Label("Active", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.accent)
                    .help("New/continued turns of this thread use this account.")
            } else if let use {
                Button("Use", action: use)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(Theme.accentSolid)
                    .help("Make this the active account for the thread")
            }
            if let delete {
                Button(role: .destructive, action: delete) {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Remove this account: its registration and its own login/key. The default \(row.family.label) login is untouched.")
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
