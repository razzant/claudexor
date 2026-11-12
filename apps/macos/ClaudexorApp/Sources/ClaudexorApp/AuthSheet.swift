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
    /// D-17 one-action flow: start the native login as soon as the sheet opens
    /// (the "Add & log in" / account-row single click). Consumed once.
    var autoStartLogin: Bool = false

    @State private var secretValue = ""
    @State private var status = ""
    @State private var actionInFlight = false
    @State private var controller: SetupLifecycleController?
    @State private var lifecycle = SetupLifecycleSnapshot()
    @State private var showCloseConfirmation = false
    @State private var closeAfterCancellation = false
    @State private var lastRefreshedTerminalJobId: String?
    @State private var didAutoStartLogin = false
    @State private var showTerminalCaveat = false
    /// Jobs THIS sheet created (fresh logins and their restarts). A family
    /// sheet adopting one of these never shows the ownership disclosure — the
    /// user chose the login here; an adopted foreign named-row job keeps it.
    @State private var sheetStartedJobIds: Set<String> = []
    /// Bounded automatic sign-in-link replacements (see `ReissueBudget`).
    @State private var reissues = AuthSheetPresentation.ReissueBudget()

    private var secretName: String? { AuthSheetPresentation.managedSecretSlot(for: family) }

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
        return model.activeCredentialProfiles.first {
            $0.profile.harnessId == family.setupHarnessId && $0.profile.profileId == profileId
        }?.status
    }
    /// What "logged in" means for THIS sheet's target store. Mirrors the
    /// engine's verification predicate: available AND a PASSED probe — a
    /// present-but-wrong login (available + failed) is not "verified".
    private var targetVerified: Bool {
        guard profileId != nil else { return nativeReady }
        return profileStatus?.availability == "available" && profileStatus?.verification == "passed"
    }
    private var nativeHarness: SetupHarness? { SetupHarness(rawValue: family.setupHarnessId) }
    private var job: SetupJob? { lifecycle.job }
    private var setupTarget: AuthSheetPresentation.SetupTarget {
        AuthSheetPresentation.setupTarget(
            requestedProfileId: profileId,
            job: job,
            bootstrapProfileId: AccountsPresentation.bootstrapProfileId(for: family),
            sheetCreatedJob: job.map { sheetStartedJobIds.contains($0.jobId) } ?? false)
    }
    /// A family-level sheet (nil target) follows ANY job it hosts — including a
    /// bootstrap login the engine resolved onto the `<harness>-default` row; an
    /// explicit account target matches only its own job.
    private var activeJobMatchesTarget: Bool {
        job.map { profileId == nil || $0.profileId == profileId } ?? true
    }
    private var hasActiveJob: Bool { job?.isActive == true }
    private var activeStateUnknown: Bool {
        lifecycle.connection == .recovering || lifecycle.connection == .streamLost
    }
    private var newSetupDisabled: Bool {
        controller == nil || actionInFlight || hasActiveJob || activeStateUnknown
            || job?.blocksReplacement == true || currentInfo?.setupLogin == .unavailable
    }
    private var storeKeyAvailability: AuthSheetPresentation.StoreKeyAvailability {
        .init(gatewayAvailable: model.gateway(for: model.activeExecutionLocation) != nil,
              actionInFlight: actionInFlight, keyField: secretValue)
    }
    private var closeRequiresConfirmation: Bool {
        AuthSheetClosePolicy.requiresConfirmation(
            job: job,
            connection: lifecycle.connection,
            actionInFlight: actionInFlight
        )
    }
    // Close-confirmation copy is pure presentation (AuthSheetClosePolicy).
    private var closeConfirmationTitle: String {
        AuthSheetClosePolicy.confirmationTitle(
            job: job, stateUnresolved: activeStateUnknown || actionInFlight)
    }
    private var closeCancellationLabel: String { AuthSheetClosePolicy.cancellationLabel(job: job) }
    private var closeConfirmationMessage: String {
        AuthSheetClosePolicy.confirmationMessage(
            job: job, stateUnresolved: activeStateUnknown || actionInFlight)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    AuthSheetHeader(
                        family: family,
                        profileDisplayName: profileDisplayName,
                        backDisabled: closeRequiresConfirmation && activeJobMatchesTarget,
                        back: {
                            model.authSheetTarget = AuthSheetTarget(family: family)
                        },
                        done: requestClose)
                    AuthSheetReadinessPanel(
                        family: family,
                        profileId: profileId,
                        targetVerified: targetVerified,
                        profileStatus: profileStatus,
                        isReady: isReady,
                        info: currentInfo)
                    if nativeHarness != nil, !supportsAccountsPanel { nativeSetupPanel }
                    if supportsAccountsPanel {
                        AuthSheetAccountsPanel(
                            family: family,
                            actionInFlight: actionInFlight,
                            loginDisabled: newSetupDisabled,
                            // Every row is a registry row (unified account
                            // model) — drill into that exact account's login.
                            login: { row in
                                model.authSheetTarget = AuthSheetTarget(
                                    family: row.family, profileId: row.profileId, autoStartLogin: true)
                            },
                            // The empty-family bootstrap sign-in: a profile-less
                            // login the engine resolves onto the
                            // `<harness>-default` row (K.4).
                            bootstrapLogin: AccountsPresentation.supportsBootstrapLogin(family)
                                ? { Task { await runLogin() } } : nil,
                            recheck: { Task { await recheck() } }
                        )
                    }
                    if let disclosure = lifecycle.deviceCode, let job, job.phase == .awaitingUser {
                        // Keyed on the JOB's harness/deadline, not this target.
                        AuthSheetDeviceCodeCard(
                            disclosure: disclosure, job: job, waiting: true,
                            actionInFlight: actionInFlight,
                            cancel: { Task { await cancelJob() } },
                            useBrowserCallback: { Task { await restartLogin(loginFlow: .browserCallback) } },
                            submitCode: { await submitLoginCode($0) },
                            autoReissueArmed: reissues.armed,
                            reissue: { automatic in
                                reissues.spend(automatic: automatic)
                                Task { await restartLogin() }
                            }
                        )
                    }
                    if let job { setupJobPanel(job) }
                    if job == nil, lifecycle.connection == .recovering || lifecycle.connection == .streamLost {
                        setupConnectionPanel
                    }
                    if AuthSheetPresentation.showsGlobalApiKeyPanel(profileId: profileId, secretName: secretName),
                       let secretName { AuthSheetKeyAllowanceSection(family: family) { apiKeyPanel(secretName) } }
                    if !status.isEmpty {
                        Text(status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(Theme.Spacing.xl)
            }

            if showsActionFooter {
                Divider().overlay(Theme.separator)
                // ONE prominent CTA by cause; a quiet/healthy sheet closes through
                // the always-visible header Done, not a duplicated footer Done.
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
                    if cta != .done {
                        Button(cta.label) { Task { await performPrimary(cta) } }
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.accentSolid)
                            .disabled(actionInFlight || (cta == .login && newSetupDisabled)
                                || (cta == .storeKey && !storeKeyAvailability.enabled))
                            .help(cta.help(family: family.label, busy: actionInFlight,
                                           loginBlocked: cta == .login && newSetupDisabled,
                                           storeKeyBlocked: storeKeyAvailability.blockedReason))
                        Button("Done") { requestClose() }.buttonStyle(.bordered)
                    }
                }
                .padding(Theme.Spacing.lg)
            }
        }
        .frame(width: 600, height: 720)
        .textSelection(.enabled)   // root-level selection (item c / §2.9)
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
        let entry = model.activeCredentialProfiles.first {
            $0.profile.profileId == profileId && $0.profile.harnessId == family.setupHarnessId
        }
        return entry?.profile.displayName ?? profileId
    }

    private var setupTargetMismatchMessage: String? {
        guard setupTarget.differsFromRequested else { return nil }
        let owner: String
        if let jobProfileId = setupTarget.profileId {
            let entry = model.activeCredentialProfiles.first {
                $0.profile.profileId == jobProfileId
                    && $0.profile.harnessId == family.setupHarnessId
            }
            owner = entry?.profile.displayName ?? jobProfileId
        } else {
            owner = "the default account"
        }
        return "This setup job belongs to \(owner). Its controls continue that exact login; your selected account is unchanged."
    }

    /// Account-capable default surface: the implicit default login and every named
    /// profile render through ONE AccountsSurface (no parallel setup-vs-accounts UI).
    private var supportsAccountsPanel: Bool {
        profileId == nil
            && AccountsPresentation.configDirLoginHarnessIds.contains(family.setupHarnessId)
    }

    // The native-setup panel is pure rendering in AuthSheetNativeSetupPanel.swift.
    private var nativeSetupPanel: some View {
        AuthSheetNativeSetupPanel(
            targetVerified: targetVerified,
            newSetupDisabled: newSetupDisabled,
            actionInFlight: actionInFlight,
            profileId: profileId, family: family,
            setupLogin: currentInfo?.setupLogin ?? .legacyAbsent,
            showTerminalCaveat: $showTerminalCaveat,
            runLogin: { Task { await runLogin() } },
            recheck: { Task { await recheck() } }
        )
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
            reconnect: { Task { await reconnectSetupState() } },
            deviceAuthFallback: AuthSheetPresentation.deviceAuthFallback(job: job),
            startTerminalFallback: { Task { await startTerminalFallback() } },
            targetMismatchMessage: setupTargetMismatchMessage
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
        AuthSheetApiKeyPanel(
            name: name,
            secretValue: $secretValue,
            enabled: storeKeyAvailability.enabled,
            panelHelp: storeKeyAvailability.panelHelp,
            storeKey: { Task { await storeKey(name) } }
        )
    }

    /// W4.8: the one state-derived primary action for the footer.
    private var primaryCTA: AuthSheetPresentation.PrimaryCTA {
        if supportsAccountsPanel { return .done } // account rows own login/manage
        return AuthSheetPresentation.primaryCTA(
            healthOk: isReady,
            nativeSupported: nativeHarness != nil,
            nativeReady: targetVerified,
            keyStored: secretName.map { name in model.activeStoredSecrets.contains { $0.name == name } } ?? false,
            streamLost: lifecycle.connection == .streamLost,
            jobActive: hasActiveJob,
            blocksReplacement: job?.blocksReplacement == true
        )
    }

    private var showsActionFooter: Bool { primaryCTA != .done || hasActiveJob || actionInFlight || activeStateUnknown }

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
        guard let client = model.gateway(for: model.activeExecutionLocation) else {
            status = "Engine offline: reconnect before starting \(family.label) setup."
            return
        }
        guard nativeHarness != nil else { return }
        let lifecycleController = SetupLifecycleController(gateway: client)
        controller = lifecycleController
        lifecycle = SetupLifecycleSnapshot(connection: .recovering)
        await lifecycleController.recoverActiveJob(harness: family.setupHarnessId)
        lifecycle = await lifecycleController.snapshot()
        // D-17 one-action flow: if the sheet was opened with autoStartLogin and
        // there is no active job to adopt (and the target is not already
        // verified), start the login now — so "Add & log in" / an account-row
        // click is a single action. Consumed once.
        if AuthSheetPresentation.shouldAutoStartLogin(
            requested: autoStartLogin,
            consumed: didAutoStartLogin,
            lifecycle: lifecycle,
            targetVerified: targetVerified)
        {
            didAutoStartLogin = true
            await runLogin()
        }
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
                let refreshed = await model.refreshCredentialReadiness(
                    for: family, profileId: job.profileId, after: job)
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
        let previousJobId = job?.jobId
        await controller.start(harness: family.setupHarnessId, action: "login", profileId: profileId)
        await recordSheetStartedJob(previousJobId: previousJobId)
    }

    /// Remember a job this sheet just created (`setupTarget` suppresses the
    /// ownership disclosure only for these and the bootstrap resolution). A
    /// refused start keeps the prior job in the snapshot — comparing against
    /// the pre-start id keeps a foreign adopted job from being claimed.
    private func recordSheetStartedJob(previousJobId: String?) async {
        guard let started = await controller?.snapshot().job,
              started.jobId != previousJobId else { return }
        sheetStartedJobIds.insert(started.jobId)
    }

    /// D-17 audit point 8: the first-class Terminal fallback for the codex
    /// device-code `not_supported` (device_auth_unsupported) state. A real
    /// transition — starts a fresh browser_redirect login — not a text hint. The
    /// prior job is terminal, so no cancel is needed.
    private func startTerminalFallback() async {
        guard let controller, let job else { return }
        actionInFlight = true
        defer { actionInFlight = false }
        await controller.start(harness: family.setupHarnessId, action: "login",
                               profileId: job.profileId, loginFlow: .browserRedirect)
        await recordSheetStartedJob(previousJobId: job.jobId)
    }

    /// Replace the live login: the D-17 browser-callback opt-in (codex orgs that
    /// disable device-code), and the re-issue after a sign-in window lapsed
    /// (`loginFlow` nil). Both share the app-server conflict bucket, so the
    /// current job is cancelled first — never a silent fallback.
    private func restartLogin(loginFlow: SetupCodexLoginFlow? = nil) async {
        guard let controller, let job else { return }
        actionInFlight = true
        defer { actionInFlight = false }
        if job.isActive {
            await controller.cancel()
            // Wait (bounded) for the cancellation to terminalize so the new
            // create is not refused by the active-job guard.
            for _ in 0..<40 {
                if await controller.snapshot().job?.isActive != true { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        await controller.start(harness: family.setupHarnessId, action: "login",
                               profileId: job.profileId, loginFlow: loginFlow)
        await recordSheetStartedJob(previousJobId: job.jobId)
    }

    /// Hand the pasted one-time code to the waiting login job: straight to the
    /// daemon, never stored here or logged. Returns the refusal reason, if any.
    private func submitLoginCode(_ code: String) async -> String? {
        guard let controller else { return "Engine offline: reconnect and try again." }
        actionInFlight = true
        defer { actionInFlight = false }
        return await controller.submitInput(code)
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
        let matchingJob = activeJobMatchesTarget ? job : nil
        // Follow the job's RESOLVED account: a bootstrap login the engine bound
        // to the `<harness>-default` row rechecks that exact row, not the
        // default store the request left unnamed.
        let targetProfileId = matchingJob != nil ? setupTarget.profileId : profileId
        let refreshed = await model.refreshCredentialReadiness(
            for: family, profileId: targetProfileId, after: matchingJob)
        status = AuthSheetPresentation.recheckStatus(
            family: family, profileId: targetProfileId, job: matchingJob, succeeded: refreshed)
    }

    private func reconnectSetupState() async {
        guard let controller else { return }
        lifecycle = SetupLifecycleSnapshot(job: job, connection: .recovering)
        await controller.reconnect(harness: family.setupHarnessId)
        lifecycle = await controller.snapshot()
        if !(await model.refreshCredentialReadiness(
            for: family, profileId: setupTarget.profileId, after: lifecycle.job))
        {
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
                    _ = await model.refreshCredentialReadiness(
                        for: family, profileId: profileId, after: nil)
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
