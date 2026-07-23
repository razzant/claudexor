import Foundation
import ClaudexorKit

/// PURE state mapping for the AuthSheet (W4.8 V21a): ONE primary CTA derived
/// from the cause, and ONE merged human status line per setup job — never
/// contradictory combos like "Failed + Completed + exit 0". Unit-tested.
enum AuthSheetPresentation {
    static func showsGlobalApiKeyPanel(profileId: String?, secretName: String?) -> Bool {
        profileId == nil && secretName != nil
    }

    /// D-17 audit point 8: the codex device-code `not_supported` terminal state
    /// is NOT a dead-end message. It offers a first-class native action.
    enum DeviceAuthFallback: Equatable {
        /// Start the legacy Terminal localhost-callback (browser_redirect) login.
        case terminalLogin
    }

    /// When a codex device-code login terminalizes as `not_supported` because the
    /// installed app-server lacks the typed auth methods, the daemon carries the
    /// consistent typed code `device_auth_unsupported` on the native-command
    /// receipt (the SAME code the runner result, journal, control DTO, and Swift
    /// surface all use). That state exposes a real transition — start the legacy
    /// Terminal (browser_redirect) sign-in — never merely a CLI instruction.
    static func deviceAuthFallback(job: SetupJob) -> DeviceAuthFallback? {
        guard job.harness == .codex,
              job.state == .notSupported,
              job.nativeCommand?.errorCode == .deviceAuthUnsupported else { return nil }
        return .terminalLogin
    }

    enum PrimaryCTA: Equatable {
        /// Start the native login flow (no verified session yet).
        case login
        /// Re-run the doctor probe/smoke (credentials present but unproven).
        case retryProbe
        /// Store an API key (no native support path and no key yet).
        case storeKey
        /// Re-establish setup truth (stream lost / unconfirmed termination).
        case reconnect
        /// Nothing to fix — the sheet's only primary act is closing it.
        case done

        var label: String {
            switch self {
            case .login: return "Log in"
            case .retryProbe: return "Retry check"
            case .storeKey: return "Store key"
            case .reconnect: return "Reconnect"
            case .done: return "Done"
            }
        }
    }

    /// The one primary action, by cause. Order is severity: unknown process
    /// state must resolve first; an ACTIVE job means we are already doing the
    /// primary thing (observe it — closing is the only primary act); then the
    /// readiness ladder.
    static func primaryCTA(
        healthOk: Bool,
        nativeSupported: Bool,
        nativeReady: Bool,
        keyStored: Bool,
        streamLost: Bool,
        jobActive: Bool,
        blocksReplacement: Bool
    ) -> PrimaryCTA {
        if streamLost || blocksReplacement { return .reconnect }
        if jobActive { return .done }
        if healthOk { return .done }
        // Native path: the cause is the session — log in, or re-probe a
        // verified-but-degraded one. Storing a key belongs to the NON-native
        // path only: a missing fallback key is normalized as `skip`, never
        // evidence that the key caused the degraded state (F4 triad sol #1).
        if nativeSupported { return nativeReady ? .retryProbe : .login }
        return keyStored ? .retryProbe : .storeKey
    }

    /// ONE human status for a setup job: the phase while it lives, a single
    /// reconciled phrase once terminal (state and outcome never both shout).
    static func jobStatusLine(
        state: SetupJobState,
        phase: SetupJobPhase,
        outcomeReason: String?,
        exitCode: Int?
    ) -> String {
        switch state {
        case .queued: return "Queued"
        case .running, .waitingForInput:
            switch phase {
            case .launching: return "Launching the native login…"
            case .awaitingUser: return "Waiting for you to finish the login"
            case .verifying: return "Verifying the session…"
            case .cancelling: return "Cancelling…"
            default: return "Working…"
            }
        case .succeeded:
            return "Login verified"
        case .cancelled:
            return "Cancelled"
        case .timedOut:
            return "Timed out waiting for the login"
        case .notSupported:
            return "Not supported for this harness"
        case .failed, .interruptedUnknown:
            // The single honest failure phrase: the typed reason when it says
            // more than "error"; the exit code only when it IS the evidence.
            if let reason = outcomeReason, reason == "termination_unconfirmed" {
                return "Process termination is unconfirmed"
            }
            if let code = exitCode, code != 0 { return "Failed (exit \(code))" }
            if let reason = outcomeReason, !reason.isEmpty, reason != "completed" {
                return "Failed (\(reason.replacingOccurrences(of: "_", with: " ")))"
            }
            return state == .failed ? "Failed" : "Interrupted — state unknown"
        }
    }
}

extension AuthSheetPresentation.PrimaryCTA {
    /// INV-134: a disabled control explains why — the DISABLING cause wins
    /// over the plain action description.
    func help(family: String, busy: Bool = false, loginBlocked: Bool = false) -> String {
        if busy { return "Wait for the current action to finish." }
        if loginBlocked, self == .login {
            return "Login is unavailable until setup state resolves (an active job, recovery, or an unconfirmed prior process)."
        }
        return help(family: family)
    }

    func help(family: String) -> String {
        switch self {
        case .login: return "Start the native \(family) login flow."
        case .retryProbe: return "Run a fresh, non-cached Harness Doctor probe."
        case .storeKey: return "Store the API key entered in the fallback field below."
        case .reconnect: return "Re-establish setup truth (re-snapshot the job / prove the process gone)."
        case .done: return "Close this auth sheet."
        }
    }
}
