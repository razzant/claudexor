import SwiftUI
import AppKit
import ClaudexorKit

struct AuthSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let family: HarnessFamily
    /// Target credential profile (INV-135). nil = the engine-default login; a
    /// profile id routes the native login setup job at that profile's store.
    var profileId: String? = nil

    @State private var secretValue = ""
    @State private var status = ""
    @State private var actionInFlight = false
    @State private var controller: SetupLifecycleController?
    @State private var lifecycle = SetupLifecycleSnapshot()
    @State private var showCloseConfirmation = false
    @State private var closeAfterCancellation = false
    @State private var lastRefreshedTerminalJobId: String?

    private var secretName: String? {
        switch family {
        case .codex: "openai"; case .claude: "anthropic"; case .cursor: "cursor"
        case .opencode: "opencode"; case .raw: "raw"; default: nil
        }
    }

    private var currentInfo: HarnessInfo? { model.harnessInfo(for: family) }
    private var isReady: Bool { currentInfo?.health == .ok }
    private var nativeSource: HarnessAuthSource? {
        model.authSource(for: family, source: .nativeSession)
    }
    private var nativeReady: Bool { nativeSource?.isVerifiedNativeSession == true }
    /// The PROFILE's own doctor projection (INV-135) — the verification truth
    /// for a profile-targeted sheet; the default store's readiness is not it.
    private var profileStatus: CredentialProfileEntry.Status? {
        guard let profileId else { return nil }
        return model.credentialProfiles.first {
            $0.profile.harnessId == family.setupHarnessId && $0.profile.profileId == profileId
        }?.status
    }
    /// What "logged in" means for THIS sheet's target store. Mirrors the
    /// engine's verification predicate: available AND a PASSED probe — a
    /// present-but-wrong login (available + failed) is not "verified".
    private var targetVerified: Bool {
        guard let profileId else { return nativeReady }
        _ = profileId
        return profileStatus?.availability == "available" && profileStatus?.verification == "passed"
    }
    private var nativeHarness: SetupHarness? { SetupHarness(rawValue: family.setupHarnessId) }
    private var job: SetupJob? { lifecycle.job }
    private var hasActiveJob: Bool { job?.isActive == true }
    private var activeStateUnknown: Bool {
        lifecycle.connection == .recovering || lifecycle.connection == .streamLost
    }
    private var newSetupDisabled: Bool {
        controller == nil || actionInFlight || hasActiveJob || activeStateUnknown
            || job?.blocksReplacement == true
    }
    private var secretWriteDisabled: Bool {
        model.client == nil || actionInFlight
            || secretValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var closeRequiresConfirmation: Bool {
        AuthSheetClosePolicy.requiresConfirmation(
            job: job,
            connection: lifecycle.connection,
            actionInFlight: actionInFlight
        )
    }
    private var closeConfirmationTitle: String {
        if job?.blocksReplacement == true { return "Process termination is unconfirmed" }
        if activeStateUnknown || actionInFlight { return "Setup state is still resolving" }
        return "Native login is still active"
    }
    private var closeCancellationLabel: String {
        job == nil ? "Reconnect & Cancel" : "Cancel Login"
    }
    private var closeConfirmationMessage: String {
        if job?.blocksReplacement == true {
            return "Keep Running closes this sheet without claiming the process stopped. Cancel asks the daemon again and closes only after termination is confirmed. Stay keeps the recovery details visible."
        }
        if activeStateUnknown || actionInFlight {
            return "Claudexor cannot yet prove whether a setup job is active. Keep Running leaves any accepted job in the background. Cancel first reconciles server state and closes only after confirmed termination."
        }
        return "Keep Running closes this sheet while the daemon job continues. Cancel Login waits for confirmed process termination before closing."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header
                    readinessPanel
                    if nativeHarness != nil, !supportsAccountsPanel { nativeSetupPanel }
                    if supportsAccountsPanel {
                        AuthSheetAccountsPanel(
                            family: family,
                            actionInFlight: actionInFlight,
                            defaultLoginDisabled: newSetupDisabled,
                            login: { row in
                                if row.profileId == nil {
                                    Task { await runLogin() }
                                } else {
                                    model.authSheetTarget = AuthSheetTarget(
                                        family: row.family, profileId: row.profileId)
                                }
                            },
                            recheck: { Task { await recheck() } }
                        )
                    }
                    if let job { setupJobPanel(job) }
                    if job == nil, lifecycle.connection == .recovering || lifecycle.connection == .streamLost {
                        setupConnectionPanel
                    }
                    if let secretName { apiKeyPanel(secretName) }
                    if !status.isEmpty {
                        Text(status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                .padding(Theme.Spacing.xl)
            }

            Divider().overlay(Theme.separator)
            // W4.8: ONE prominent CTA by cause; Done is primary only when
            // there is nothing to fix (healthy) or we're observing a job.
            HStack {
                if let job, job.isActive {
                    Label(AuthSheetPresentation.jobStatusLine(
                        state: job.state, phase: job.phase,
                        outcomeReason: job.outcome?.reason.rawValue,
                        exitCode: job.outcome?.exitCode
                    ), systemImage: "circle.dotted")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                let cta = primaryCTA
                if cta == .done {
                    Button("Done") { requestClose() }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accentSolid)
                        .help("Close this auth sheet. An active setup job asks whether to keep running or cancel.")
                } else {
                    Button(cta.label) { Task { await performPrimary(cta) } }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accentSolid)
                        .disabled(actionInFlight || (cta == .login && newSetupDisabled))
                        .help(cta.help(family: family.label, busy: actionInFlight,
                                       loginBlocked: cta == .login && newSetupDisabled))
                    Button("Done") { requestClose() }
                        .buttonStyle(.bordered)
                        .help("Close this auth sheet. An active setup job asks whether to keep running or cancel.")
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .frame(width: 600, height: 720)
        .interactiveDismissDisabled(closeRequiresConfirmation)
        .confirmationDialog(
            closeConfirmationTitle,
            isPresented: $showCloseConfirmation,
            titleVisibility: .visible
        ) {
            Button("Keep Running") { keepRunningAndClose() }
            Button(closeCancellationLabel, role: .destructive) { cancelJobAndCloseWhenConfirmed() }
            Button("Stay", role: .cancel) {}
        } message: {
            Text(closeConfirmationMessage)
        }
        .task { await observeLifecycle() }
    }

    /// Display name of the target profile (INV-135), or nil for the default login.
    private var profileDisplayName: String? {
        guard let profileId else { return nil }
        let entry = model.credentialProfiles.first {
            $0.profile.profileId == profileId && $0.profile.harnessId == family.setupHarnessId
        }
        return entry?.profile.displayName ?? profileId
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            HarnessLogo(family: family, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(profileDisplayName.map { "\(family.label) · \($0)" } ?? "\(family.label) Auth")
                    .font(.title3.weight(.semibold))
                Text(profileDisplayName == nil
                    ? "Native session first; API-key fallback only through the local secret store."
                    : "Native login for this account. The default login stays untouched.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button { requestClose() } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .help("Close \(family.label) Auth. An active setup job asks whether to keep running or cancel.")
        }
    }

    /// W4.7-UI: the shared readiness card (typed rows + "copy raw") for the
    /// DEFAULT store; a profile target shows ITS doctor projection instead —
    /// the default card would misattribute readiness to the wrong store.
    private var readinessPanel: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if let profileId {
                    SectionLabel("Account readiness",
                                 systemImage: targetVerified ? "checkmark.seal.fill" : "exclamationmark.triangle")
                    HStack(spacing: Theme.Spacing.sm) {
                        Circle()
                            .fill(targetVerified ? Theme.status(.succeeded)
                                : profileStatus?.availability == "unknown" ? Theme.status(.blocked)
                                : Theme.status(.failed))
                            .frame(width: 8, height: 8)
                        Text(profileStatus.map {
                            "\($0.availability) · verification \($0.verification)"
                        } ?? "No doctor probe yet for \(profileId)")
                            .font(.caption)
                        Spacer()
                    }
                    if let detail = profileStatus?.detail {
                        Text(detail).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                } else {
                    SectionLabel("Readiness", systemImage: isReady ? "checkmark.seal.fill" : "exclamationmark.triangle")
                    HarnessReadinessCard(
                        presentation: .from(family: family, info: currentInfo)
                    ) { EmptyView() }
                }
            }
        }
    }

    /// Account-capable default surface: the implicit default login and every
    /// named profile are rendered by ONE AccountsSurface (no parallel Native
    /// setup vs Additional accounts UI).
    private var supportsAccountsPanel: Bool {
        profileId == nil
            && (family.setupHarnessId == "claude" || family.setupHarnessId == "codex")
    }

    private var nativeSetupPanel: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Native setup", systemImage: "terminal")
                HStack(spacing: Theme.Spacing.sm) {
                    Button { Task { await runLogin() } } label: {
                        Label(targetVerified ? "Manage Login" : "Login", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .buttonStyle(.bordered)
                    .disabled(newSetupDisabled)
                    .help(targetVerified ? "Open the native \(family.label) login flow to manage the verified session." : "Start the native \(family.label) login flow.")

                    Button { Task { await recheck() } } label: {
                        Label("Recheck", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .disabled(actionInFlight)
                    .help("Run a fresh, non-cached Harness Doctor probe for installed/authenticated/routable status.")
                }
                Text(profileId == nil
                    ? "Native login is daemon-owned. Completing its Terminal command is not readiness: only the exact native probe and same-harness smoke mark the session ready."
                    : "Native login is daemon-owned and scoped to this account's own store. Its doctor probe is the verification truth; the default-route capability smoke does not apply.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // Job + connection panels live in AuthSheetJobPanel.swift (pure rendering;
    // this sheet stays the one owner of lifecycle mutations).
    private func setupJobPanel(_ job: SetupJob) -> some View {
        AuthSheetJobPanel(
            job: job,
            lifecycle: lifecycle,
            familyLabel: family.label,
            actionInFlight: actionInFlight,
            activeStateUnknown: activeStateUnknown,
            extendDeadline: { Task { await extendDeadline() } },
            cancelJob: { Task { await cancelJob() } },
            retryJob: { Task { await retryJob() } },
            reconnect: { Task { await reconnectSetupState() } }
        )
    }

    private var setupConnectionPanel: some View {
        AuthSheetConnectionPanel(
            connection: lifecycle.connection,
            lastError: lifecycle.lastError,
            reconnect: { Task { await reconnectSetupState() } }
        )
    }

    private func apiKeyPanel(_ name: String) -> some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("API-key fallback", systemImage: "key")
                SecureField("\(name) key", text: $secretValue).textFieldStyle(.roundedBorder)
                Button { Task { await storeKey(name) } } label: { Label("Store Key", systemImage: "key.fill") }
                    .buttonStyle(.bordered)
                    .disabled(secretWriteDisabled)
                    .help("Store this fallback API key, then refresh exactly that credential source.")
            }
        }
    }

    /// W4.8: the one state-derived primary action for the footer.
    private var primaryCTA: AuthSheetPresentation.PrimaryCTA {
        if supportsAccountsPanel { return .done } // account rows own login/manage
        return AuthSheetPresentation.primaryCTA(
            healthOk: isReady,
            nativeSupported: nativeHarness != nil,
            nativeReady: targetVerified,
            keyStored: secretName.map { name in model.storedSecrets.contains { $0.name == name } } ?? false,
            streamLost: lifecycle.connection == .streamLost,
            jobActive: hasActiveJob,
            blocksReplacement: job?.blocksReplacement == true
        )
    }

    private func performPrimary(_ cta: AuthSheetPresentation.PrimaryCTA) async {
        switch cta {
        case .login: await runLogin()
        case .retryProbe: await recheck()
        case .storeKey: if let secretName { await storeKey(secretName) }
        case .reconnect: await reconnectSetupState()
        case .done: requestClose()
        }
    }

    private func observeLifecycle() async {
        guard let client = model.client else {
            status = "Engine offline: reconnect before starting \(family.label) setup."
            return
        }
        guard nativeHarness != nil else {
            return
        }
        let lifecycleController = SetupLifecycleController(gateway: client)
        controller = lifecycleController
        lifecycle = SetupLifecycleSnapshot(connection: .recovering)
        await lifecycleController.recoverActiveJob(harness: family.setupHarnessId)
        lifecycle = await lifecycleController.snapshot()
        // Subscribe after recovery: updates() immediately yields the current
        // snapshot, avoiding replay of the initial idle/recovering states after
        // an active job has already been found.
        let updates = await lifecycleController.updates()
        for await next in updates {
            if Task.isCancelled { break }
            lifecycle = next
            if let job = next.job { status = job.message }
            // No job but a lastError means a DEFINITIVE rejection (e.g. the 409
            // login-conflict) — surface the daemon's reason in the always-visible
            // footer status instead of swallowing it.
            else if let err = next.lastError, !err.isEmpty { status = err }
            if let job = next.job, job.isTerminal, lastRefreshedTerminalJobId != job.jobId {
                lastRefreshedTerminalJobId = job.jobId
                let refreshed = await model.refreshAuthReadinessAfterSetupLifecycle(
                    for: family,
                    job: job
                )
                // A profile job's verification truth is the profile projection,
                // not the default store — refresh it too (INV-135).
                if profileId != nil { await model.refreshCredentialProfiles() }
                if !refreshed {
                    status = "Setup finished, but the exact auth-readiness refresh failed. Use Recheck before trusting readiness."
                }
                if closeAfterCancellation {
                    if job.hasConfirmedTermination {
                        closeAfterCancellation = false
                        dismiss()
                        break
                    }
                    closeAfterCancellation = false
                    status = terminationUnconfirmedMessage
                }
            }
            if closeAfterCancellation, next.lastError != nil, next.job?.phase != .cancelling {
                closeAfterCancellation = false
                status = "Cancellation could not be confirmed: \(next.lastError ?? "unknown error")"
            }
        }
        await lifecycleController.detach()
    }

    private func runLogin() async {
        guard let controller else { return }
        actionInFlight = true
        defer { actionInFlight = false }
        await controller.start(harness: family.setupHarnessId, action: "login", profileId: profileId)
    }

    private func extendDeadline() async {
        actionInFlight = true
        defer { actionInFlight = false }
        await controller?.extendDeadline()
    }

    private func cancelJob() async {
        actionInFlight = true
        defer { actionInFlight = false }
        await controller?.cancel()
    }

    private func retryJob() async {
        actionInFlight = true
        defer { actionInFlight = false }
        await controller?.retry()
    }

    private func recheck() async {
        actionInFlight = true
        defer { actionInFlight = false }
        // A profile target's verification truth is ITS doctor projection —
        // refresh it alongside the default-store probe (round-2 R2-1).
        if profileId != nil { await model.refreshCredentialProfiles() }
        if await model.refreshAuthReadinessAfterSetupLifecycle(for: family, job: job) {
            status = profileId == nil
                ? "Exact auth-readiness check completed for \(family.label)."
                : "Account readiness refreshed for this \(family.label) profile."
        } else {
            status = "Exact auth-readiness check failed for \(family.label). Reconnect the engine and try again."
        }
    }

    private func reconnectSetupState() async {
        guard let controller else { return }
        lifecycle = SetupLifecycleSnapshot(job: job, connection: .recovering)
        await controller.reconnect(harness: family.setupHarnessId)
        lifecycle = await controller.snapshot()
        if !(await model.refreshAuthReadinessAfterSetupLifecycle(for: family, job: lifecycle.job)) {
            status = "Setup state reconnected, but the exact auth-readiness refresh failed. Use Recheck before trusting readiness."
        }
    }

    private func storeKey(_ name: String) async {
        actionInFlight = true
        defer { actionInFlight = false }
        let value = secretValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        let result = await model.storeSecret(name: name, value: value, for: family)
        guard result.stored else {
            status = "Could not store \(name); reconnect the local engine and try again."
            return
        }
        secretValue = ""
        status = result.readinessRefreshed
            ? "Stored \(name) and refreshed its exact credential readiness."
            : "Stored \(name), but its exact readiness refresh failed. Use Recheck before relying on it."
    }

    private func requestClose() {
        if closeRequiresConfirmation { showCloseConfirmation = true } else { dismiss() }
    }

    private func keepRunningAndClose() {
        Task {
            await controller?.detach()
            dismiss()
        }
    }

    private func cancelJobAndCloseWhenConfirmed() {
        closeAfterCancellation = true
        Task { @MainActor in
            while actionInFlight {
                if Task.isCancelled { return }
                try? await Task.sleep(for: .milliseconds(50))
            }
            guard let controller else {
                closeAfterCancellation = false
                status = "Cancellation could not be confirmed because the engine is offline."
                return
            }

            var latest = await controller.snapshot()
            if latest.job == nil || latest.connection == .recovering || latest.connection == .streamLost {
                await controller.reconnect(harness: family.setupHarnessId)
                latest = await controller.snapshot()
                lifecycle = latest
            }

            guard let target = latest.job else {
                if latest.connection == .idle {
                    _ = await model.refreshAuthReadinessAfterSetupLifecycle(for: family, job: nil)
                    closeAfterCancellation = false
                    dismiss()
                } else {
                    closeAfterCancellation = false
                    status = "Cancellation could not be confirmed: \(latest.lastError ?? "setup state remains unknown")"
                }
                return
            }
            if target.hasConfirmedTermination {
                closeAfterCancellation = false
                dismiss()
                return
            }

            await controller.cancel()
            latest = await controller.snapshot()
            if latest.job?.isTerminal == true, latest.job?.hasConfirmedTermination == false {
                closeAfterCancellation = false
                status = terminationUnconfirmedMessage
            } else if latest.lastError != nil, latest.job?.phase != .cancelling {
                closeAfterCancellation = false
                status = "Cancellation could not be confirmed: \(latest.lastError ?? "unknown error")"
            }
        }
    }

    private var terminationUnconfirmedMessage: String {
        "Cancellation reached a terminal result, but process termination was not confirmed. This sheet will stay open; reconnect and run Recheck before starting another login."
    }

}

enum AuthSheetClosePolicy {
    static func requiresConfirmation(job: SetupJob?, connection: SetupLifecycleConnection,
                                     actionInFlight: Bool) -> Bool {
        if actionInFlight { return true }
        if job?.isActive == true || job?.blocksReplacement == true { return true }
        return connection == .recovering || connection == .reconnecting || connection == .streamLost
    }
}
