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

/// The sidebar footer (bottom-left): a quiet update chip (M5c shell), the
/// in-effect credential-profile line, and the accounts trigger. Composed so the footer is
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

/// The bottom-left update chip (M7 / D-2). When the signature-VERIFIED CHECK
/// reports a runnable `.available` closure, the chip offers a one-click in-place
/// **Install** (download → verify → unpack → probe → idle-gate → stop → atomic
/// swap → relaunch → handshake → rollback) with honest per-phase progress, plus
/// a "View release" escape hatch for a manual download. While installing it
/// shows the live RuntimeInstallPhase status and a spinner. When there is no
/// advertised update it renders NOTHING except an honest status line for the
/// app-update-required / failure / dev-build cases (never a fake "up to date").
struct UpdateChip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    /// The GitHub release page the chip links to for a manual download.
    /// `releases/latest` always resolves to the release whose runtime manifest
    /// the CHECK just read, so the linked page carries the advertised version.
    static let releaseURL = URL(
        string: "https://github.com/\(GitHubRuntimeReleaseTransport.repoSlug)/releases/latest")!

    var body: some View {
        if model.runtimeInstalling {
            // Live install progress — honest per-phase text, no fake success.
            HStack(spacing: Theme.Spacing.xs) {
                ProgressView().controlSize(.mini)
                Text(model.runtimeInstallStatus ?? "Updating…")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help(model.runtimeInstallStatus ?? "Installing the engine update…")
        } else if let update = model.updateAvailability {
            // A newer, signature-verified runtime exists (D-2): the primary
            // action installs it in place; "View release" stays as a manual
            // escape hatch; a trailing control re-checks.
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
                Button("Install") { Task { await model.installRuntimeUpdate() } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                    .help("Download, verify, and install engine v\(update.version) in place")
                Button("View release") { openURL(update.url.flatMap(URL.init) ?? Self.releaseURL) }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .help("Open the GitHub release to download the update manually")
                Button {
                    Task { await model.checkForRuntimeUpdate() }
                } label: {
                    Image(systemName: "arrow.clockwise").font(.caption2)
                }
                .buttonStyle(.plain)
                .help("Re-check for updates")
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help("Update to v\(update.version) is available — install in place or download manually.")
        } else if let status = model.runtimeInstallStatus, !status.isEmpty {
            // A finished/failed install (rolled back, failed, or done): quiet,
            // verbatim line until the next check clears it.
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "info.circle")
                    .font(.caption2).foregroundStyle(.tertiary)
                Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .help(status)
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

/// The in-effect credential-profile line: which account the next turn will use
/// (the thread/draft pin, else the harness default), shown next to its harness.
/// Truth from the wire (thread/draft sticky); hidden
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
        // Root-level text selection for the popover (batch-6 item c / §2.9).
        .textSelection(.enabled)
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

    @ViewBuilder private var autoBalanceToggle: some View {
        let state = model.autoBalanceState
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Theme.Spacing.sm) {
                Toggle(isOn: Binding(
                    get: { state == .on },
                    set: { on in Task { await model.setAutoBalance(on) } }
                )) {
                    Text("Auto-switch accounts at quota limit").font(.callout)
                }
                .toggleStyle(.switch)
                .tint(Theme.accent)
                // Per-harness rotate flags disagree → the aggregate is indeterminate:
                // show "—" rather than misreporting the mixed state as off.
                .disabled(state == .unavailable)
                if state == .mixed {
                    Text("—")
                        .font(.callout.weight(.semibold)).foregroundStyle(Theme.status(.caution))
                        .help("Harnesses disagree — turning this on sets them all to rotate.")
                }
            }
            Text(autoBalanceCaption(state))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func autoBalanceCaption(_ state: AccountsAutoBalance.State) -> String {
        switch state {
        case .unavailable:
            return "Add a second account to a harness to enable auto-switch at its quota limit."
        case .mixed:
            return "Harnesses disagree (—) — turning this on sets them all to rotate among enabled accounts."
        case .on, .off:
            return "When one account hits its quota, runs continue on another enabled account of the same harness."
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
    /// The accounts load state (batch-6 item h): a config/load ERROR is a typed
    /// state with the reason + retry — never the empty "No accounts yet".
    @State private var loadState: AccountsLoadState = .idle

    /// Typed load state for the accounts registry (error ≠ empty).
    enum AccountsLoadState: Equatable { case idle, loading, loaded, failed(String) }

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
        .task { await loadAccounts() }
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
                } else if row.isApiKeyHost {
                    // Meta-host (raw-api/openrouter): Enabled is the harness setting.
                    await model.setHarnessEnabled(harnessId: row.harnessId, enabled: enabled)
                } else {
                    await model.setNativeCredentialsEnabled(
                        harnessId: row.harnessId, enabled: enabled)
                }
            }
        }
    }

    private var accountsList: some View {
        // ONE shared Grid, owned by AlignedList (owner F8 / §2.8): every
        // AccountRowView is an AlignedListRow (a GridRow), so the trailing
        // controls are real columns whose edges are shared across ALL rows — the
        // Enabled toggle stays collinear regardless of per-row content (a profile
        // carries a trash where the CLI-login row reserves a clear spacer). The
        // identity cell's single-line discipline lives in the component, so a long
        // quota/detail line can never wrap into fragments that flow around the
        // trailing columns (the owner-round-3 bug).
        AlignedList {
            if case .failed(let message) = loadState, rows.isEmpty {
                // A config/load ERROR is NOT an empty registry (item h): render the
                // typed reason + retry, never the "No accounts yet" empty copy.
                GridRow {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Label("Could not load accounts", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.medium)).foregroundStyle(Theme.status(.negative))
                        Text(message).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                        Button("Retry") { Task { await loadAccounts() } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .gridCellColumns(AccountsPresentation.AccountRowColumn.allCases.count + 1)
                }
            } else if rows.isEmpty {
                GridRow {
                    Label(loadState == .loading ? "Loading accounts…" : "No accounts yet — add one below.",
                          systemImage: "person.crop.circle.badge.plus")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .gridCellColumns(AccountsPresentation.AccountRowColumn.allCases.count + 1)
                }
            } else {
                ForEach(rows) { row in
                    AccountRowView(
                        row: row,
                        login: { login(row) },
                        loginDisabled: loginDisabled(row),
                        // V11b: the Enabled toggle is the ONLY routing control — a
                        // profile row PATCHes its own `enabled`; the CLI-login row
                        // drives the harness's `native_credentials_enabled`.
                        setEnabled: enabledAction(row),
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

    /// Load accounts into the typed load state (item h): a failure renders the
    /// reason + retry, not the empty "No accounts yet".
    private func loadAccounts() async {
        if loadState != .loaded { loadState = .loading }
        if let error = await model.loadCredentialProfiles() {
            loadState = .failed(error)
        } else {
            loadState = .loaded
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
            nextUp: false
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
