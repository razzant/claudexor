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
        // Cheap cached read of the last decision (no network); then one
        // ETag-cached foreground check per session. The menu command
        // (Check for Updates…) forces a re-check.
        .onAppear {
            model.refreshUpdateAvailability()
            Task { await model.checkForRuntimeUpdate(force: false) }
        }
    }
}

/// The bottom-left update chip (M7). Renders a pending-version chip when the
/// real, manifest-backed updater reports a runnable `.available` closure. When
/// there is no advertised update it renders NOTHING except an honest status line
/// for the app-update-required / failure cases (never a fake "up to date"). Tap
/// to re-check.
struct UpdateChip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let update = model.updateAvailability {
            Button {
                Task { await model.checkForRuntimeUpdate() }
            } label: {
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
            }
            .buttonStyle(.plain)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help(update.url.map { "Update to v\(update.version) — \($0)" }
                  ?? "Update to v\(update.version) is available. Click to re-check.")
        } else if let status = model.runtimeUpdateStatus, status != "Up to date" {
            // App-update-required / failure / unknown: a quiet, verbatim line.
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "exclamationmark.circle")
                    .font(.caption2).foregroundStyle(.tertiary)
                Text(status)
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help(status)
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
        .frame(width: 400)
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

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
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

    /// The Active marker (M9-UX item 2): the GLOBAL routing default per harness —
    /// the account a new run picks. V11b: the SERVER computes the Active identity
    /// from `active_profile_id`, so the marker binds to that projection verbatim.
    /// The popover is the global surface; the per-thread override lives on the
    /// composer's Harness+Account chip. A pre-V11b daemon (no projection) shows no
    /// Active marker rather than faking one.
    private func isActive(_ row: AccountRowModel) -> Bool { row.serverActive ?? false }

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

    /// The "Make active" action for a row, or nil when it is already active /
    /// cannot become the routing default (M9-UX item 2). Sets the harness's
    /// GLOBAL `active_profile_id` via the settings PATCH — a verified+enabled
    /// profile becomes Active; the CLI login clears the Active profile back to the
    /// native login. This is the global level; per-thread pinning is the
    /// composer's job. No V11b projection ⇒ no affordance (nothing to target).
    private func makeActiveAction(_ row: AccountRowModel) -> (() -> Void)? {
        guard row.serverActive != nil, !isActive(row) else { return nil }
        if row.isProfile {
            // Only a verified, enabled profile can be the routing default.
            guard row.verified, row.enabled else { return nil }
            return {
                Task { await model.setHarnessActiveProfile(harnessId: row.harnessId, profileId: row.profileId) }
            }
        }
        // CLI-login row: clear the Active profile → the native login is Active.
        return { Task { await model.setHarnessActiveProfile(harnessId: row.harnessId, profileId: nil) } }
    }

    private var accountsList: some View {
        // ONE shared Grid (owner F8): every AccountRowView is a GridRow, so the
        // trailing controls are real columns whose edges are shared across ALL
        // rows — the Enabled toggle is collinear regardless of per-row content
        // (Manage+Active vs Manage+Make active+trash). A per-row fixed-width HStack
        // could still drift if any cell overflowed; the Grid can't.
        Grid(alignment: .top, horizontalSpacing: Theme.Spacing.sm, verticalSpacing: Theme.Spacing.sm) {
            if rows.isEmpty {
                Label("No accounts yet — add one below.", systemImage: "person.crop.circle.badge.plus")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .gridCellColumns(5)
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
                        // "Make active" sets the harness's GLOBAL routing default
                        // (wire-backed settings PATCH of active_profile_id). Offered
                        // for a verified+enabled profile, and for the CLI login (clear
                        // the Active profile back to the native login).
                        makeActive: makeActiveAction(row),
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
