import SwiftUI
import AppKit
import ClaudexorKit

struct AuthSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let family: HarnessFamily

    @State private var secretValue = ""
    @State private var status = ""
    @State private var actionInFlight = false
    @State private var controller: SetupLifecycleController?
    @State private var lifecycle = SetupLifecycleSnapshot()
    @State private var showCloseConfirmation = false
    @State private var closeAfterCancellation = false
    @State private var lastRefreshedTerminalJobId: String?

    private var secretName: String? {
        if family == .codex { return "openai" }
        if family == .claude { return "anthropic" }
        if family == .cursor { return "cursor" }
        if family == .opencode { return "opencode" }
        if family == .raw { return "raw" }
        return nil
    }

    private var currentInfo: HarnessInfo? { model.harnessInfo(for: family) }
    private var isReady: Bool { currentInfo?.health == .ok }
    private var nativeSource: HarnessAuthSource? {
        model.authSource(for: family, source: .nativeSession)
    }
    private var nativeReady: Bool { nativeSource?.isVerifiedNativeSession == true }
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
                    if nativeHarness != nil { nativeSetupPanel }
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
                        .help(cta.help(family: family.label))
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

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            HarnessLogo(family: family, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(family.label) Auth")
                    .font(.title3.weight(.semibold))
                Text("Native session first; API-key fallback only through the local secret store.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button { requestClose() } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .help("Close \(family.label) Auth. An active setup job asks whether to keep running or cancel.")
        }
    }

    /// W4.7-UI: the shared readiness card (typed rows + "copy raw").
    private var readinessPanel: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Readiness", systemImage: isReady ? "checkmark.seal.fill" : "exclamationmark.triangle")
                HarnessReadinessCard(
                    presentation: .from(family: family, info: currentInfo)
                ) { EmptyView() }
            }
        }
    }

    private var nativeSetupPanel: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Native setup", systemImage: "terminal")
                HStack(spacing: Theme.Spacing.sm) {
                    Button { Task { await runLogin() } } label: {
                        Label(nativeReady ? "Manage Login" : "Login", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .buttonStyle(.bordered)
                    .disabled(newSetupDisabled)
                    .help(nativeReady ? "Open the native \(family.label) login flow to manage the verified session." : "Start the native \(family.label) login flow.")

                    Button { Task { await recheck() } } label: {
                        Label("Recheck", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .disabled(actionInFlight)
                    .help("Run a fresh, non-cached Harness Doctor probe for installed/authenticated/routable status.")
                }
                Text("Native login is daemon-owned. Completing its Terminal command is not readiness: only the exact native probe and same-harness smoke mark the session ready.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func setupJobPanel(_ job: SetupJob) -> some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack {
                    SectionLabel("Setup job", systemImage: "list.bullet.rectangle")
                    Spacer()
                    // W4.8: state + phase + outcome sewn into ONE human status
                    // — never "Failed" beside "Completed" beside "exit 0".
                    Label(AuthSheetPresentation.jobStatusLine(
                        state: job.state, phase: job.phase,
                        outcomeReason: job.outcome?.reason.rawValue,
                        exitCode: job.outcome?.exitCode
                    ), systemImage: setupJobGlyph(job.state))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(setupJobColor(job.state))
                }

                Text(job.message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)

                if let deadline = parseDate(job.deadlineAt), job.isActive {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Label(deadlineText(deadline, now: context.date), systemImage: "timer")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(deadline <= context.date ? Theme.status(.blocked) : .secondary)
                    }
                }

                // The status line owns reason+exit; a SIGNAL is extra diagnostics.
                if let signal = job.outcome?.signal {
                    Text("Signal: \(signal)")
                        .font(.caption2.weight(.medium))
                        .textSelection(.enabled)
                }

                if job.blocksReplacement {
                    Label("A previous process may still be alive. New Login and Retry stay disabled until the daemon can prove a safe replacement. API-key storage remains a separate operation.",
                          systemImage: "exclamationmark.shield.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.status(.blocked))
                        .textSelection(.enabled)
                }

                if let command = job.command {
                    Text(command)
                        .font(.system(.caption, design: .monospaced))
                        .padding(Theme.Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.surfaceCode, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
                        .textSelection(.enabled)
                }
                HStack(spacing: Theme.Spacing.sm) {
                    // W4.8: named for what it extends (canExtend gates to a live login).
                    if job.canExtend {
                        Button("Extend login wait (15 min)") { Task { await extendDeadline() } }
                            .buttonStyle(.bordered)
                            .disabled(actionInFlight || activeStateUnknown)
                            .help("Extend the wait for the native login you are completing by 15 minutes.")
                    }
                    if job.canCancel {
                        Button("Cancel Login", role: .destructive) {
                            Task { await cancelJob() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(actionInFlight)
                        .help("Request cancellation and keep observing until the engine confirms termination.")
                    }
                    if job.canRetry {
                        Button("Retry") { Task { await retryJob() } }
                            .buttonStyle(.bordered)
                            .disabled(actionInFlight || activeStateUnknown)
                            .help("Create a new \(family.label) \(humanize(job.action.rawValue)) setup job.")
                    }
                    if lifecycle.connection == .streamLost || job.blocksReplacement {
                        Button(job.blocksReplacement ? "Reconcile" : "Reconnect") { Task { await reconnectSetupState() } }
                            .buttonStyle(.bordered)
                            .help(job.isActive
                                  ? "Re-snapshot this job and start a fresh bounded stream observation."
                                  : job.blocksReplacement
                                    ? "Ask the daemon to prove the recorded process group empty before allowing replacement."
                                    : "Re-snapshot setup state and refresh native readiness without starting another process.")
                    }
                    if let raw = job.guideUrl, let url = URL(string: raw) {
                        Button("Guide") { NSWorkspace.shared.open(url) }
                            .buttonStyle(.bordered)
                            .help("Open the official \(family.label) setup guide.")
                    }
                }

                if lifecycle.connection == .reconnecting {
                    Text("Reconnecting setup stream (\(lifecycle.reconnectAttempt)/\(SetupLifecycleController.maximumReconnects))…")
                        .font(.caption2).foregroundStyle(.secondary)
                } else if lifecycle.connection == .streamLost {
                    Text("Setup stream lost after bounded reconnects. The job was not marked failed; reconnect to fetch its current server state.")
                        .font(.caption2).foregroundStyle(Theme.status(.blocked))
                }
                if let error = lifecycle.lastError, !error.isEmpty {
                    Text(error).font(.caption2).foregroundStyle(Theme.status(.failed)).textSelection(.enabled)
                }
            }
        }
    }

    private var setupConnectionPanel: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                SectionLabel("Setup state", systemImage: lifecycle.connection == .streamLost ? "wifi.exclamationmark" : "magnifyingglass")
                if lifecycle.connection == .streamLost {
                    Text("The active setup state is unknown. A request may have reached the daemon even though its response was lost; reconnect before starting another job.")
                        .font(.caption)
                        .foregroundStyle(Theme.status(.blocked))
                    if let error = lifecycle.lastError, !error.isEmpty {
                        Text(error)
                            .font(.caption2)
                            .foregroundStyle(Theme.status(.failed))
                            .textSelection(.enabled)
                    }
                    Button("Reconnect") { Task { await reconnectSetupState() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accentSolid)
                        .help("Look up this harness's active setup job before enabling a new start.")
                } else {
                    ProgressView("Checking for an active setup job…")
                        .controlSize(.small)
                    Text("New setup actions stay disabled until the daemon confirms whether a job is already active.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
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
        AuthSheetPresentation.primaryCTA(
            healthOk: isReady,
            nativeSupported: nativeHarness != nil,
            nativeReady: nativeReady,
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
            if let job = next.job, job.isTerminal, lastRefreshedTerminalJobId != job.jobId {
                lastRefreshedTerminalJobId = job.jobId
                let refreshed = await model.refreshAuthReadinessAfterSetupLifecycle(
                    for: family,
                    job: job
                )
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
        await controller.start(harness: family.setupHarnessId, action: "login")
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
        if await model.refreshAuthReadinessAfterSetupLifecycle(for: family, job: job) {
            status = "Exact auth-readiness check completed for \(family.label)."
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

    private func parseDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        return Self.isoFractional.date(from: raw) ?? Self.iso.date(from: raw)
    }

    private func deadlineText(_ deadline: Date, now: Date) -> String {
        let seconds = max(0, Int(deadline.timeIntervalSince(now)))
        if seconds == 0 { return "Deadline reached — waiting for the engine's terminal result" }
        return String(format: "Native login deadline in %02d:%02d", seconds / 60, seconds % 60)
    }

    private func phaseLabel(_ phase: SetupJobPhase) -> String {
        return humanize(phase.rawValue)
    }

    private func humanize(_ raw: String) -> String {
        raw.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func setupJobGlyph(_ state: SetupJobState) -> String {
        switch state {
        case .queued: return "clock"
        case .running: return "play.circle"
        case .waitingForInput: return "person.crop.circle.badge.questionmark"
        case .succeeded: return "checkmark.circle.fill"
        case .failed, .timedOut, .interruptedUnknown: return "xmark.octagon.fill"
        case .cancelled: return "stop.circle"
        case .notSupported: return "nosign"
        }
    }

    private func setupJobColor(_ state: SetupJobState) -> Color {
        switch state {
        case .succeeded: return Theme.status(.succeeded)
        case .failed, .timedOut, .interruptedUnknown: return Theme.status(.failed)
        case .waitingForInput: return Theme.status(.blocked)
        case .running: return Theme.status(.running)
        default: return .secondary
        }
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let iso = ISO8601DateFormatter()
}

enum AuthSheetClosePolicy {
    static func requiresConfirmation(job: SetupJob?, connection: SetupLifecycleConnection,
                                     actionInFlight: Bool) -> Bool {
        if actionInFlight { return true }
        if job?.isActive == true || job?.blocksReplacement == true { return true }
        return connection == .recovering || connection == .reconnecting || connection == .streamLost
    }
}
