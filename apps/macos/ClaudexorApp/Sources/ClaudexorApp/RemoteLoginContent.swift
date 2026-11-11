import ClaudexorKit
import SwiftUI

/// Used unchanged by the remote sheet and credential-free visual fixtures.
struct RemoteLoginContent: View {
    let session: RemoteLoginSession
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            HStack {
                Label(title, systemImage: "person.badge.key")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button("Close", action: close)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    if let job = session.lifecycle.job {
                        if let disclosure = session.lifecycle.deviceCode, session.current {
                            AuthSheetDeviceCodeCard(
                                disclosure: disclosure, job: job, waiting: job.isActive,
                                actionInFlight: session.actionInFlight,
                                cancel: nil,
                                useBrowserCallback: nil,
                                submitCode: { await session.submitInput($0) },
                                autoReissueArmed: false, reissue: nil)
                        }
                        Text(job.message).font(.callout).textSelection(.enabled)
                        if job.isTerminal {
                            let presentation = RemoteDeviceLoginTerminalPresentation(
                                jobState: job.state,
                                selectionReason: job.authCapability?.receipt?.selectionReason,
                                effectiveRoute: job.authCapability?.receipt?.effective,
                                effectiveSource: job.authCapability?.receipt?.effectiveSource,
                                nativeSessionVerified: session.readiness?.nativeSessionVerified == true,
                                harnessRoutable: session.readiness?.harnessRoutable == true)
                            Label(presentation.label, systemImage: presentation.systemImage)
                                .foregroundStyle(presentation.color)
                            if presentation == .readyWithWarning {
                                Text("The account is signed in and ready. An extra setup check failed.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } else {
                        ProgressView("Waiting for the remote sign-in…")
                    }
                    if let status = session.status {
                        Text(status).font(.caption).foregroundStyle(Theme.status(.caution))
                    }
                    if !session.current {
                        Text("The remote connection changed. Close this view and reconnect before continuing.")
                            .font(.caption).foregroundStyle(Theme.status(.caution))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                if session.lifecycle.connection == .streamLost, session.current {
                    Button("Reconnect") { Task { await session.reconnect() } }
                        .disabled(session.actionInFlight)
                }
                if session.lifecycle.job?.canCancel == true, session.current {
                    Button("Cancel login", role: .destructive) { Task { await session.cancel() } }
                        .disabled(session.actionInFlight)
                }
                Spacer()
                Button(session.lifecycle.job?.isTerminal == true ? "Done" : "Keep running", action: close)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
            }
        }
        .padding(Theme.Spacing.xl)
    }

    private var title: String {
        guard let job = session.lifecycle.job else { return "Remote sign-in" }
        return "\(HarnessFamily(rawValue: job.harness.rawValue).label) sign-in"
    }
}
