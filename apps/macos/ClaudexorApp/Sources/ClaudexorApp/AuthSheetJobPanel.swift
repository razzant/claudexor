import SwiftUI
import AppKit
import ClaudexorKit

// MARK: - AuthSheet setup-job panels
//
// The job-observation half of the AuthSheet: the live setup-job panel (status
// line, deadline, actions) and the connection-recovery panel. Pure rendering —
// every action is a caller-supplied closure, so AuthSheet stays the one owner
// of lifecycle mutations.

struct AuthSheetJobPanel: View {
    let job: SetupJob
    let lifecycle: SetupLifecycleSnapshot
    let familyLabel: String
    let actionInFlight: Bool
    let activeStateUnknown: Bool
    let extendDeadline: () -> Void
    let cancelJob: () -> Void
    let retryJob: () -> Void
    let reconnect: () -> Void

    /// M9-UX item 4: the terminal command + Guide/Retry are secondary detail,
    /// collapsed by default so the live-login controls stay the clear focus.
    @State private var showAdvanced = false

    var body: some View {
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
                    ), systemImage: Self.glyph(job.state))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Self.color(job.state))
                }

                Text(job.message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)

                if let deadline = Self.parseDate(job.deadlineAt), job.isActive {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Label(Self.deadlineText(deadline, now: context.date), systemImage: "timer")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(deadline <= context.date ? Theme.status(.caution) : .secondary)
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
                        .foregroundStyle(Theme.status(.caution))
                        .textSelection(.enabled)
                }

                primaryActionsRow
                if job.command != nil || job.canRetry || job.guideUrl != nil {
                    DisclosureGroup("Advanced — terminal command & guide", isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            if let command = job.command {
                                Text(command)
                                    .font(.system(.caption, design: .monospaced))
                                    .padding(Theme.Spacing.sm)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Theme.surfaceCode, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
                                    .textSelection(.enabled)
                            }
                            advancedActionsRow
                        }
                        .padding(.top, Theme.Spacing.xs)
                    }
                    .font(.caption)
                }
                if lifecycle.connection == .reconnecting {
                    Text("Reconnecting setup stream (\(lifecycle.reconnectAttempt)/\(SetupLifecycleController.maximumReconnects))…")
                        .font(.caption2).foregroundStyle(.secondary)
                } else if lifecycle.connection == .streamLost {
                    Text("Setup stream lost after bounded reconnects. The job was not marked failed; reconnect to fetch its current server state.")
                        .font(.caption2).foregroundStyle(Theme.status(.caution))
                }
                if let error = lifecycle.lastError, !error.isEmpty {
                    Text(error).font(.caption2).foregroundStyle(Theme.status(.negative)).textSelection(.enabled)
                }
            }
        }
    }

    /// The live-login controls the user acts on directly (extend / cancel /
    /// reconcile) — always visible. Retry + Guide are secondary detail and live
    /// in the Advanced disclosure (item 4).
    @ViewBuilder private var primaryActionsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            // W4.8: named for what it extends (canExtend gates to a live login).
            if job.canExtend {
                Button("Extend login wait (15 min)", action: extendDeadline)
                    .buttonStyle(.bordered)
                    .disabled(actionInFlight || activeStateUnknown)
                    .help("Extend the wait for the native login you are completing by 15 minutes.")
            }
            if job.canCancel {
                Button("Cancel Login", role: .destructive, action: cancelJob)
                    .buttonStyle(.bordered)
                    .disabled(actionInFlight)
                    .help("Request cancellation and keep observing until the engine confirms termination.")
            }
            if lifecycle.connection == .streamLost || job.blocksReplacement {
                Button(job.blocksReplacement ? "Reconcile" : "Reconnect", action: reconnect)
                    .buttonStyle(.bordered)
                    .help(job.isActive
                          ? "Re-snapshot this job and start a fresh bounded stream observation."
                          : job.blocksReplacement
                            ? "Ask the daemon to prove the recorded process group empty before allowing replacement."
                            : "Re-snapshot setup state and refresh native readiness without starting another process.")
            }
        }
    }

    @ViewBuilder private var advancedActionsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if job.canRetry {
                Button("Retry", action: retryJob)
                    .buttonStyle(.bordered)
                    .disabled(actionInFlight || activeStateUnknown)
                    .help("Create a new \(familyLabel) \(Self.humanize(job.action.rawValue)) setup job.")
            }
            if let raw = job.guideUrl, let url = URL(string: raw) {
                Button("Guide") { NSWorkspace.shared.open(url) }
                    .buttonStyle(.bordered)
                    .help("Open the official \(familyLabel) setup guide.")
            }
        }
    }

    // MARK: Display helpers

    static func parseDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        return isoFractional.date(from: raw) ?? iso.date(from: raw)
    }

    static func deadlineText(_ deadline: Date, now: Date) -> String {
        let seconds = max(0, Int(deadline.timeIntervalSince(now)))
        if seconds == 0 { return "Deadline reached — waiting for the engine's terminal result" }
        return String(format: "Native login deadline in %02d:%02d", seconds / 60, seconds % 60)
    }

    static func humanize(_ raw: String) -> String {
        raw.replacingOccurrences(of: "_", with: " ").capitalized
    }

    static func glyph(_ state: SetupJobState) -> String {
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

    static func color(_ state: SetupJobState) -> Color {
        switch state {
        case .succeeded: return Theme.status(.positive)
        case .failed, .timedOut, .interruptedUnknown: return Theme.status(.negative)
        case .waitingForInput: return Theme.status(.caution)
        case .running: return Theme.status(.info)
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

/// Shown when no job is known but the lifecycle stream is recovering/lost.
struct AuthSheetConnectionPanel: View {
    let connection: SetupLifecycleConnection
    let lastError: String?
    let reconnect: () -> Void

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                SectionLabel("Setup state", systemImage: connection == .streamLost ? "wifi.exclamationmark" : "magnifyingglass")
                if connection == .streamLost {
                    Text("The active setup state is unknown. A request may have reached the daemon even though its response was lost; reconnect before starting another job.")
                        .font(.caption)
                        .foregroundStyle(Theme.status(.caution))
                    if let error = lastError, !error.isEmpty {
                        Text(error)
                            .font(.caption2)
                            .foregroundStyle(Theme.status(.negative))
                            .textSelection(.enabled)
                    }
                    Button("Reconnect", action: reconnect)
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
}
