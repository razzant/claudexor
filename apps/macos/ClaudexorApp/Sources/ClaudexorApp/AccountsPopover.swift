import SwiftUI
import ClaudexorKit

// MARK: - Accounts (bottom-left compact control, INV-135)
//
// Replaces the always-expanded sidebar quota footer with ONE Claude-Code-style
// control: a compact trigger row (worst readiness dot + account name/count +
// worst quota % + chevron) that expands into a popover to add + log in accounts
// in-app (no commands to copy), read compact per-account quotas, and toggle
// auto-balance. EVERY row comes from GET /v2/credential-profiles (unified
// account model — no client-synthesized "CLI login" pseudo-row); the next-up
// badge comes from the response's `accountPools` pool authority.

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

/// The in-effect credential-profile line: which account the next turn will use
/// (a thread/draft pin names its account; unpinned threads follow the
/// quota-aware pool of enabled accounts and render the stable "Automatic"),
/// shown next to its harness. Truth from the wire (thread/draft sticky);
/// hidden when there is no resolved harness.
struct FooterProfileRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let footer = model.activeAccountFooter {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "person.crop.circle")
                    .font(.caption).foregroundStyle(.secondary)
                Text(footer.harnessLabel)
                    .font(.caption.weight(.medium)).foregroundStyle(.primary)
                Text("·").font(.caption).foregroundStyle(.tertiary)
                Text(footer.accountLabel)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.top, Theme.Spacing.xs)
            .help("Next turn authenticates as \(footer.harnessLabel) · \(footer.accountLabel).")
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
                .productControlAccessibility("Accounts and quota")
                .help("Manage accounts — add, log in, view quota, auto-switch")
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.sm)
        }
        .task { await model.ensureCredentialProfilesLoaded() }
        .popover(isPresented: $showPopover, arrowEdge: .trailing) {
            AccountsPopover(isPresented: $showPopover).environment(model)
        }
    }

    /// One READABLE line (owner dogfood: the first cut was too small): a dot,
    /// the account name/count, the worst quota %, and a chevron. Still a single
    /// quiet row — it must not compete with the thread list.
    private var trigger: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if !AccountsPresentation.isAvailable(model: model) {
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

    @State private var showQuotaDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.top, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.md)
            Divider().opacity(0.55)
            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    if !AccountsPresentation.isAvailable(model: model) {
                        Label("Accounts and quota are unavailable while the engine is offline.",
                              systemImage: "wifi.slash")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        // Every row is a registry row (unified account model), so
                        // every login targets that exact account.
                        AccountsSurface(family: nil) { row in
                            if let connectionID = model.activeExecutionLocation.remoteConnectionID,
                               let harness = SetupHarness(rawValue: row.family.setupHarnessId)
                            {
                                Task {
                                    await model.startRemoteLogin(
                                        connectionID: connectionID,
                                        harness: harness,
                                        profileID: row.profileId)
                                }
                            } else {
                                // Routed model-level so the AuthSheet survives this
                                // popover dismissing.
                                model.authSheetTarget = AuthSheetTarget(
                                    family: row.family, profileId: row.profileId,
                                    autoStartLogin: true)
                            }
                            isPresented = false
                        }
                        AccountsAutoBalanceControl()
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .scrollIndicators(.visible)
        }
        .frame(width: 400)
        .frame(maxHeight: PopoverLayout.currentMaximumHeight)
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
                Task { _ = await model.refreshAccounts() }
            } label: {
                if model.activeAccountsLoadState == .loading {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .buttonStyle(.borderless)
            .disabled(model.activeAccountsLoadState == .loading)
            .help("Refresh quota and account readiness from official provider sources")
        }
    }

}

/// One inline owner for row-level account actions. A new action clears the old
/// message immediately, and a late completion cannot replace a newer result.
struct AccountsActionNotice: Equatable {
    private(set) var generation: UInt64 = 0
    private(set) var message: String?
    private(set) var isError = false

    mutating func begin() -> UInt64 {
        generation &+= 1
        message = nil
        isError = false
        return generation
    }

    mutating func settle(_ message: String?, isError: Bool = true, generation: UInt64) {
        guard generation == self.generation else { return }
        self.message = message
        self.isError = isError
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
    /// Present the login UI for a row's account; the host owns presentation.
    let login: (AccountRowModel) -> Void
    /// Host-owned lifecycle gate (the AuthSheet disables its current target
    /// while setup recovery/action state is unresolved).
    var loginDisabled: (AccountRowModel) -> Bool = { _ in false }
    /// Family-scoped hosts (the AuthSheet) supply the profile-less BOOTSTRAP
    /// sign-in shown when the family has no rows yet: the engine ensures the
    /// `<harness>-default` row and binds the login to it (the job reports the
    /// resolved profileId). nil hides the affordance (the global popover's
    /// add flow covers the empty state instead).
    var bootstrapLogin: (() -> Void)? = nil
    /// Host-owned gate for the bootstrap sign-in (mirrors `loginDisabled`).
    var bootstrapLoginDisabled = false

    @State private var addDisplayName = ""
    @State private var addHarnessChoice = AccountsPresentation.defaultAddHarnessId
    @State private var addError: String?
    @State private var adding = false
    @State private var pendingDelete: AccountRowModel?
    @State private var deleting = false
    @State private var actionNotice = AccountsActionNotice()
    @State private var quotaSubscription: AccountsQuotaSubscription?
    @State private var accountContentWidth: CGFloat = 400 - 2 * Theme.Spacing.lg
    /// The add form registers agy/claude/codex/cursor/grok config_dir_login
    /// profiles using the same harness set the daemon supports.
    private var addHarness: String? {
        guard let family else { return addHarnessChoice }
        let id = family.setupHarnessId
        return AccountsPresentation.configDirLoginHarnessIds.contains(id) ? id : nil
    }

    private var rows: [AccountRowModel] {
        AccountsPresentation.rows(model: model).filter { row in
            family == nil || row.harnessId == family?.setupHarnessId
        }
    }

    private var loadFailed: Bool {
        if case .failed = model.activeAccountsRegistryLoadState { return true }
        return false
    }

    /// Harnesses whose pool verdict says the next UNPINNED run rides the policy
    /// API-key ROUTE (INV-061) — a route, never an account row, so it cannot be
    /// a "Next up" badge and is disclosed as its own quiet line instead. The
    /// pure helper limits this to config-dir-login families: for api-key-primary
    /// ones the key is the ordinary route, not a degradation to announce.
    private var apiKeyRouteDisclosures: [String] {
        AccountsPresentation.apiKeyRouteDisclosureHarnessIds(
            family: family,
            poolHarnessIds: model.activeAccountPools.map(\.harnessId),
            isApiKeyRouteNextUp: { model.authoritativeNextUp(for: $0)?.isApiKeyRoute == true })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            accountsList
            ForEach(apiKeyRouteDisclosures, id: \.self) { harness in
                Label(
                    "\(HarnessFamily(rawValue: harness).label): the next unpinned default-model run uses the API-key route (no enabled account is ready).",
                    systemImage: "key")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            // The additive evidence read failed: one notice; the rows stay current.
            if let problem = model.accountsRoutingEvidence.problems[model.activeExecutionLocation] {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if let notice = actionNotice.message {
                Text(notice).font(.caption2).foregroundStyle(
                    actionNotice.isError ? Theme.status(.negative) : Color.secondary)
                    .textSelection(.enabled)
            }
            if addHarness != nil {
                Divider()
                addSection
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            if width > 0 { accountContentWidth = width }
        }
        .task { await model.ensureCredentialProfilesLoaded() }
        .onAppear {
            guard quotaSubscription == nil else { return }
            quotaSubscription = model.beginAccountsQuotaSubscription()
        }
        .onDisappear {
            if let quotaSubscription { model.endAccountsQuotaSubscription(quotaSubscription) }
            quotaSubscription = nil
        }
        .onChange(of: model.activeExecutionLocation) { _, locationID in
            _ = actionNotice.begin()
            if let quotaSubscription { model.endAccountsQuotaSubscription(quotaSubscription) }
            quotaSubscription = model.beginAccountsQuotaSubscription(locationID: locationID)
            Task { await model.ensureCredentialProfilesLoaded(locationID: locationID) }
        }
        .confirmationDialog(
            "Remove \(pendingDelete?.displayName ?? "account") from Claudexor?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove from Claudexor", role: .destructive) {
                if let row = pendingDelete { Task { await deleteAccount(row) } }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("Claudexor removes this binding and any Claudexor-owned state or managed secret. A vendor credential for this OS user may be left unchanged.")
        }
    }

    /// The Enabled-toggle action for a row — the profile PATCH route,
    /// uniformly on EVERY row (unified account model: the retired
    /// `native_credentials_enabled` settings path died with the pseudo-row).
    /// Reloads the projection after (the popover's reload-after-PATCH pattern).
    private func enabledAction(_ row: AccountRowModel) -> (Bool) -> Void {
        { enabled in
            let generation = actionNotice.begin()
            Task {
                let error = await Self.setEnabled(row, to: enabled, model: model)
                actionNotice.settle(error, generation: generation)
            }
        }
    }

    /// One mapping for the uniform Enabled toggle. The caller owns presenting
    /// the returned bounded user message instead of silently discarding it.
    @MainActor
    static func setEnabled(
        _ row: AccountRowModel,
        to enabled: Bool,
        model: AppModel
    ) async -> String? {
        await model.setProfileEnabled(
            harnessId: row.harnessId, profileId: row.profileId, enabled: enabled)
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
            switch model.activeAccountsQuotaDisplayState {
            case .stale(let reason, let observedAt):
                GridRow {
                    Label(
                        "Quota stale\(formattedDate(observedAt).map { " · observed \($0)" } ?? "") · \(reason)",
                        systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                        .font(.caption2)
                        .foregroundStyle(Theme.status(.caution))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .gridCellColumns(AccountsPresentation.AccountRowColumn.allCases.count + 1)
                }
            case .failedWithoutData(let reason):
                GridRow {
                    Label(reason, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.status(.negative))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .gridCellColumns(AccountsPresentation.AccountRowColumn.allCases.count + 1)
                }
            case .idle, .loading, .current:
                EmptyView()
            }
            if case .failed(let message) = model.activeAccountsRegistryLoadState {
                GridRow {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Label("Could not load accounts", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.medium)).foregroundStyle(Theme.status(.negative))
                        Text(message).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                        Button("Retry") { Task { _ = await model.loadCredentialProfiles() } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .gridCellColumns(AccountsPresentation.AccountRowColumn.allCases.count + 1)
                }
            }
            if case .failed(let message) = model.activeAccountsLoadState,
               !loadFailed
            {
                GridRow {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Label("Could not refresh readiness and quota",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Theme.status(.negative))
                        Text(message).font(.caption2).foregroundStyle(.secondary)
                        Button("Reload accounts") {
                            Task { _ = await model.loadCredentialProfiles() }
                        }
                        .buttonStyle(.bordered).controlSize(.small)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .gridCellColumns(AccountsPresentation.AccountRowColumn.allCases.count + 1)
                }
            }
            if rows.isEmpty, !loadFailed {
                GridRow {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Label(model.activeAccountsRegistryLoadState == .loading
                              ? "Loading accounts…"
                              : bootstrapLogin != nil
                                  ? "No accounts yet — sign in, or add one below."
                                  : "No accounts yet — add one below.",
                              systemImage: "person.crop.circle.badge.plus")
                            .font(.caption).foregroundStyle(.secondary)
                        // The bootstrap sign-in (unified account model, K.4):
                        // a profile-less login the engine resolves onto the
                        // `<harness>-default` row — a cancelled/failed login
                        // keeps that row cold with its own Sign in affordance.
                        if let bootstrapLogin,
                           model.activeAccountsRegistryLoadState != .loading {
                            Button("Sign in", action: bootstrapLogin)
                                .buttonStyle(.borderedProminent)
                                .tint(Theme.accentSolid)
                                .controlSize(.small)
                                .disabled(bootstrapLoginDisabled)
                                .help(bootstrapLoginDisabled
                                      ? "Login is unavailable until setup state resolves."
                                      : "Start the official CLI sign-in — the account appears here as its own row.")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .gridCellColumns(AccountsPresentation.AccountRowColumn.allCases.count + 1)
                }
            } else if !rows.isEmpty {
                ForEach(rows) { row in
                    AccountResourcesRow(
                        row: row,
                        contentWidth: accountContentWidth,
                        login: { login(row) },
                        loginDisabled: loginDisabled(row),
                        // The Enabled toggle is the ONLY routing control — the
                        // profile PATCH route, uniformly on every row.
                        setEnabled: enabledAction(row),
                        // Unified account model: Delete on EVERY row.
                        delete: deleting ? nil : { pendingDelete = row }
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
                        ForEach(AccountsPresentation.addableFamilies) { addable in
                            Text(addable.label).tag(addable.rawValue)
                        }
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
                Text(AccountsPresentation.addAccountCaption(family: family))
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button(adding ? "Adding…" : "Add & log in") { Task { await addAccount() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .controlSize(.small)
                    .disabled(adding)
                    .help(adding
                          ? "Registering the account — wait for it to finish."
                          : "Register this account and open its official CLI login.")
            }
        }
    }

    private func addAccount() async {
        guard !adding, let harness = addHarness else { return }
        adding = true
        addError = nil
        defer { adding = false }
        let display = addDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let existing = Set(model.activeCredentialProfiles
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
        guard !deleting else { return }
        deleting = true
        let generation = actionNotice.begin()
        defer { deleting = false; pendingDelete = nil }
        // nil = the binding and any Claudexor-owned state or managed secret
        // were removed (D-U4); a vendor OS-user credential may remain
        // unchanged. Otherwise the daemon refused — a 409 while a login job is
        // active, or the typed RETRYABLE 503 `credential_cleanup_failed` that kept the row
        // registered so Remove can simply be pressed again.
        let notice = await model.deleteCredentialProfile(
            harnessId: row.harnessId, profileId: row.profileId)
        actionNotice.settle(notice.message, isError: notice.isError, generation: generation)
    }
}
