/**
 * Trust & refused-turn remediation (INV-093 honesty + INV-122 user-level trust):
 * the AppModel surface for the narrow /trust API and turn retry, the Settings
 * trust section (list + revoke), and the inline refused-turn card with the
 * one-click "Allow full access & Retry" remedy.
 */
import SwiftUI
import ClaudexorKit

// MARK: - AppModel: trust + refused-turn retry

extension AppModel {
    /// Load the per-repo user-level trust files (Settings trust section).
    func refreshTrust() async {
        guard let client else { return }
        do {
            trustEntries = try await client.trustList().entries
            trustStatus = nil
        } catch {
            trustStatus = userMessage(for: error)
        }
    }

    /// True when the repo already carries the persistent full-access grant —
    /// drives the composer's up-front grant CTA (W19).
    func fullAccessGranted(repoRoot: String) -> Bool {
        trustEntries.first { $0.repoRoot == repoRoot }?.allowFullAccess == true
    }

    /// The composer's write-scope BASELINE for a thread with no sticky access
    /// (A8): a nil sticky access follows the repo's trust `access_default`, so
    /// the composer SEEDS + treats THAT default (not a hardcoded Workspace write)
    /// as the no-pin value — otherwise a repo whose trust default is Read-only
    /// showed "Workspace write" while the engine actually applied Read-only.
    /// Falls back to Workspace write when the repo has no trust entry (the
    /// engine's own default), preserving prior behavior for untrusted repos.
    /// The engine still owns the trust gate at run time; this is display+seed
    /// fidelity only.
    var composerAccessDefault: AccessProfile {
        let root = selectedThreadId.flatMap(threadRepoRoot) ?? projectRoot
        guard !root.isEmpty,
              let wire = trustEntries.first(where: { $0.repoRoot == root })?.accessDefault,
              let profile = AccessProfile(wire: wire)
        else { return .workspaceWrite }
        return profile
    }

    /// Grant/revoke full access for one repo (the narrow user-level trust
    /// write). Returns true on success; the entries list is refreshed either way.
    @discardableResult
    func setTrust(repoRoot: String, allowFullAccess: Bool) async -> Bool {
        guard let client else {
            trustStatus = "Engine offline — reconnect before changing trust."
            return false
        }
        do {
            _ = try await client.updateTrust(repoRoot: repoRoot, allowFullAccess: allowFullAccess)
            await refreshTrust()
            return true
        } catch {
            // Refresh the list, then RESTORE the failure message: refreshTrust
            // clears trustStatus on success, which would silently swallow the
            // grant/revoke error the user needs to see.
            let message = userMessage(for: error)
            await refreshTrust()
            trustStatus = message
            return false
        }
    }

    /// Re-enqueue a REFUSED turn (server replays the recorded job params onto
    /// the SAME turn — no duplicate bubble). Mirrors sendTurn's post-accept
    /// wiring: refresh, reload the thread, and stream the started run.
    @discardableResult
    func retryTurn(threadId: String, turnId: String) async -> Bool {
        guard !isThreadBusy(threadId) else {
            threadStatus = "Wait for the running turn to finish, or Stop it, before retrying."
            return false
        }
        return await withTurnSubmission {
            await retryTurnCore(threadId: threadId, turnId: turnId)
        }
    }

    /// The retry body WITHOUT the busy guard/bracket — composed by retryTurn
    /// and grantFullAccessAndRetry, which own their own busy bracketing.
    private func retryTurnCore(threadId: String, turnId: String) async -> Bool {
        guard let client else {
            threadStatus = "Engine offline — reconnect before retrying."
            return false
        }
        let result: RunStartResult
        do {
            result = try await client.retryTurn(threadId: threadId, turnId: turnId)
        } catch {
            threadStatus = userMessage(for: error)
            // The retry itself may have been refused AGAIN (fresh enqueue_error
            // persisted server-side) — reload so the card shows the new reason.
            await openThread(threadId)
            return false
        }
        threadStatus = nil
        await refreshRuns()
        await openThread(threadId)
        if case .started(let info) = result {
            stream(runId: info.runId)
        }
        return true
    }

    /// One-click remedy for the trust refusal: persist the user-level full-access
    /// allow for this repo (the same file `claudexor trust --allow-full-access`
    /// writes), then auto-retry the refused turn. No confirmation sheet by
    /// design — the button labels the persistent grant it performs. The WHOLE
    /// grant+retry runs inside ONE busy bracket: a concurrent send during the
    /// trust write would advance the thread tail and 409 the promised retry.
    @discardableResult
    func grantFullAccessAndRetry(threadId: String, turnId: String, repoRoot: String) async -> Bool {
        guard let client else {
            threadStatus = "Engine offline — reconnect before granting access."
            return false
        }
        guard !isThreadBusy(threadId) else {
            threadStatus = "Wait for the running turn to finish, or Stop it, before retrying."
            return false
        }
        return await withTurnSubmission {
            do {
                _ = try await client.updateTrust(repoRoot: repoRoot, allowFullAccess: true)
            } catch {
                threadStatus = userMessage(for: error)
                return false
            }
            // Keep the Settings trust list truthful if it is already open: the
            // one-click grant is the same write the Settings section audits.
            await refreshTrust()
            return await retryTurnCore(threadId: threadId, turnId: turnId)
        }
    }
}

// MARK: - Settings trust section

/// User-level per-repo trust: which projects may run unsandboxed (`access:
/// full`). Grants come from the chat's one-click remedy or `claudexor trust`;
/// this section is the audit + revoke surface.
struct TrustSettingsSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Trust — full project access", systemImage: "shield.lefthalf.filled")
            Text("Projects allowed to run without a sandbox (access: full). Stored user-level in ~/.claudexor/v3/trust — never inside the repo, so versioned config can't self-grant it.")
                .font(.caption).foregroundStyle(.secondary)
            if let status = model.trustStatus {
                Label(status, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            let fullAccess = model.trustEntries.filter(\.allowFullAccess)
            if fullAccess.isEmpty {
                Text("No projects have full access.")
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(fullAccess) { entry in
                    trustRow(entry)
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.separator, lineWidth: 1))
        .task { await model.refreshTrust() }
    }

    private func trustRow(_ entry: TrustEntry) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: "folder.fill").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.repoRoot ?? "Unknown project (pre-provenance grant)")
                    .font(.callout.monospaced())
                    .lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
                if entry.repoRoot == nil {
                    Text("Granted before project paths were recorded — revoke with `claudexor trust --revoke-full-access` inside that repo.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let root = entry.repoRoot {
                Button(role: .destructive) {
                    Task { await model.setTrust(repoRoot: root, allowFullAccess: false) }
                } label: {
                    Label("Revoke", systemImage: "shield.slash")
                }
                .buttonStyle(.bordered)
                .help("Turn full access back off for this project. Future turns with access: full will be refused until re-granted.")
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }
}

// MARK: - Refused-turn inline card

/// Inline card for a turn whose run was refused before it started (server-
/// persisted `enqueueError`). Shows the engine's honest reason; the trust
/// refusal gets a one-click grant+retry (no confirmation sheet — the button
/// says exactly what it persists), everything else gets a plain Retry (the
/// server replays the same turn).
struct TurnRefusalCard: View {
    @Environment(AppModel.self) private var model
    let turn: ThreadTurnInfo
    let refusal: TurnEnqueueErrorInfo
    /// True while a retry (or grant+retry) is in flight, so the remedy button
    /// can't be double-clicked.
    @State private var retrying = false

    /// True when the refusal is the TRUST gate (access=full without the
    /// user-level allow) — the one refusal with a one-click remedy. Keys on
    /// the typed machine CODE the engine attached to its throw; the human
    /// message is display-only and never parsed.
    private var isTrustRefusal: Bool {
        refusal.code == TurnEnqueueErrorInfo.trustFullAccessCode
    }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(Theme.status(.negative))
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("Not started").font(.caption.weight(.semibold)).foregroundStyle(Theme.status(.negative))
                Text(refusal.message)
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if refusal.retryable == false {
                    // No recorded job to replay (the enqueue itself threw):
                    // Retry would 409 — say so instead of offering it.
                    Text("This turn cannot be retried in place — send a new message instead.")
                        .font(.caption2).foregroundStyle(.tertiary)
                } else if isTrustRefusal, let repoRoot = model.selectedThreadDetail?.thread.repoRoot {
                    remedyButton(
                        label: "Allow full access & Retry",
                        systemImage: "lock.open.fill",
                        prominent: true,
                        help: "Permanently allows unsandboxed full access for \(repoRoot) (stored user-level, outside the repo; revoke any time in Settings → Secrets → Trust or `claudexor trust --revoke-full-access`), then retries this exact turn."
                    ) {
                        await model.grantFullAccessAndRetry(threadId: turn.threadId, turnId: turn.id, repoRoot: repoRoot)
                    }
                } else {
                    remedyButton(
                        label: "Retry",
                        systemImage: "arrow.clockwise",
                        prominent: false,
                        help: "Re-enqueue this same turn (same prompt and options). If the refusal persists, the fresh reason replaces this card."
                    ) {
                        await model.retryTurn(threadId: turn.threadId, turnId: turn.id)
                    }
                }
            }
            Spacer()
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.status(.negative).opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
    }

    @ViewBuilder
    private func remedyButton(label: String, systemImage: String, prominent: Bool, help: String,
                              action: @escaping () async -> Bool) -> some View {
        let button = Button {
            guard !retrying else { return }
            retrying = true
            Task {
                _ = await action()
                retrying = false
            }
        } label: {
            Label(retrying ? "Retrying…" : label, systemImage: systemImage)
        }
        .disabled(retrying)
        .help(help)
        if prominent {
            button.buttonStyle(.borderedProminent).tint(Theme.accent)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}
