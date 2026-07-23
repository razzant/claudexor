import SwiftUI
import ClaudexorKit

// MARK: - Turn-adjacent action bars
//
// Extracted from TurnCard.swift (INV-124 readability ratchet): the isolated-
// thread apply bar and the turn RECEIPT row are self-contained sibling views of
// the turn card.

/// The D42 persistent RECEIPT row: status glyph · harness · state · duration ·
/// spend · tool/file counts · outcome chip. The whole row is the click target —
/// it toggles the inline activity transcript (`onToggle`); a trailing "workspace"
/// affordance opens the thread workspace filtered to this run (`onOpenWorkspace`,
/// replacing the old ⧉ inspector button). Progress never disappears: while live
/// the activity is expanded and this row is its persistent header.
struct TurnReceiptRow: View {
    @Environment(AppModel.self) private var model
    let run: TaskRun
    let runId: String
    let expanded: Bool
    let onToggle: () -> Void
    let onOpenWorkspace: () -> Void

    private var line: TurnPresentation.StatusLine {
        TurnPresentation.statusLine(
            phase: run.phase, reason: run.outcomeFacts?.reason,
            harnesses: run.harnesses, n: run.n,
            retryLabel: run.phase.isActive ? run.retryStatus?.label : nil,
            reviewNeedsDecision: run.reviewNeedsDecision,
            waitingOnUser: run.waitingOnUser)
    }

    private var hasActivity: Bool { !model.transcriptBlocks(runId).isEmpty }

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Button(action: onToggle) { receipt }
                .buttonStyle(.plain)
            // The "workspace" affordance (replaces ⧉): open this run's changes /
            // artifacts / evidence in the thread workspace.
            Button(action: onOpenWorkspace) {
                Image(systemName: "sidebar.trailing")
            }
            .buttonStyle(.borderless)
            // QA-003: name the icon-only workspace affordance (else the AX name is
            // the localized `sidebar.trailing` description).
            .accessibilityLabel("Open in workspace")
            .help("Open this run in the thread workspace — changes, artifacts, evidence")
        }
    }

    private var receipt: some View {
        HStack(spacing: Theme.Spacing.sm) {
            statusGlyph
            if let identity = line.identity {
                Label {
                    // Chip meta-rule (round-3 item 4): identity capsule never wraps.
                    Text(identity).lineLimit(1).fixedSize(horizontal: true, vertical: false)
                } icon: {
                    if let family = line.family { HarnessIcon(family: family, size: 12) }
                    else { Image(systemName: "flag.checkered.2.crossed") }
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(line.family?.color ?? .secondary)
                .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, 3)
                .background((line.family?.color ?? Theme.separator).opacity(0.13), in: Capsule())
                .overlay(Capsule().stroke((line.family?.color ?? Theme.separator).opacity(0.35), lineWidth: 1))
            }
            if let word = line.stateWord {
                Text(word).font(.caption).foregroundStyle(.secondary)
            }
            // Live activity inline while ACTIVE and COLLAPSED: the current tool
            // line (e.g. «bash python3 -m http.server 4173») so progress is
            // visible without expanding the transcript. When expanded, the
            // inlineActivity transcript below already shows it — so suppress the
            // one-liner to avoid duplication.
            if run.phase.isActive, !expanded,
               let activity = TurnPresentation.lastActivityLine(blocks: model.transcriptBlocks(runId)) {
                Text("· \(activity)")
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                    .layoutPriority(-1)
                    .help("Current activity — the running step. Click the row to expand the full transcript.")
            }
            // The outcome banner CHIP when present: the loud attention state
            // (needs decision / failed / waiting) — the quiet states stay text.
            if let chip = TurnPresentation.attention(
                phase: run.phase, reason: run.outcomeFacts?.reason,
                reviewNeedsDecision: run.reviewNeedsDecision, waitingOnUser: run.waitingOnUser) {
                Text(chip.text)
                    .font(.caption.weight(.semibold))
                    // Chip meta-rule (round-3 item 4): attention chip never wraps.
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, Theme.Spacing.xs).padding(.vertical, 1)
                    .background(chip.tone.color.opacity(0.14), in: Capsule())
                    .foregroundStyle(chip.tone.color)
            }
            Spacer()
            elapsed
            let spend = model.spendDisplay(run)
            if spend.known {
                Text(CashSpend.label(spend.usd, estimated: spend.estimated))
                    .font(.caption).foregroundStyle(.secondary)
                    .help(CashSpend.help(estimated: spend.estimated))
            }
            // QA-023c: the subscription VALUATION beside cash — a $0-cash native
            // run still shows what the work was worth. Shown ONLY when known
            // (unknown valuation stays absent, never rendered as $0).
            if let valuation = run.valuationUsd {
                Text("≈ \(String(format: "$%.4f", valuation)) sub")
                    .font(.caption).foregroundStyle(.tertiary).monospacedDigit()
                    .help("Subscription valuation — the token-valued cost of this run's native-subscription work, separate from billed cash.")
            }
            // Tool / file counts from the transcript — "9 tools · 3 files".
            if let summary = TurnPresentation.activitySummary(blocks: model.transcriptBlocks(runId)) {
                Text(summary).font(.caption).foregroundStyle(.secondary)
            }
            if hasActivity {
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .imageScale(.small).foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder private var statusGlyph: some View {
        if run.phase.isActive {
            ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 12, height: 12)
        } else {
            Circle().fill(run.phase.color).frame(width: 8, height: 8)
        }
    }

    @ViewBuilder private var elapsed: some View {
        if run.phase.isActive {
            Text(run.createdAt, style: .relative).font(.caption).foregroundStyle(.secondary)
                .help("Time since the run started")
        } else {
            let seconds = Int(run.updatedAt.timeIntervalSince(run.createdAt))
            if seconds >= 1 {
                Text(TurnCard.durationLabel(seconds: seconds)).font(.caption).foregroundStyle(.secondary)
                    .help("How long the run took")
            }
        }
    }
}

/// Deliver an ISOLATED thread's accumulated worktree diff to its project. Renders
/// the ControlThreadApplyResponse honestly (applied/branched/empty/conflict/rejected
/// + a HEAD-moved warning) — the server owns whether the apply lands.
struct ApplyThreadBar: View {
    @Environment(AppModel.self) private var model
    let threadId: String
    @State private var applying = false
    /// Honest outcome of the apply, distinguishing the three states unambiguously
    /// (the old `String?` conflated "applied OK" and "no attempt" as empty-ish and
    /// left the buttons live after success: repeat-click re-applied the thread).
    private enum Outcome {
        case idle              // no attempt yet — offer Apply / As branch
        case applied           // a completed apply SUCCEEDED — lock the buttons
        case failed(String)    // a completed apply returned an honest message
    }
    @State private var outcome: Outcome = .idle

    private var isApplied: Bool { if case .applied = outcome { return true }; return false }

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: isApplied ? "checkmark.seal.fill" : "arrow.up.doc.on.clipboard")
                .foregroundStyle(isApplied ? Theme.status(.positive) : Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Isolated workspace").font(.caption.weight(.medium))
                switch outcome {
                case .applied:
                    Text("Applied to the project — this thread's worktree has been delivered.")
                        .font(.caption).foregroundStyle(Theme.status(.positive))
                case .failed(let message):
                    Text(message).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                case .idle:
                    Text("Turns are kept in a thread worktree — apply them to the project when ready.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            // After a successful apply the thread is delivered — HIDE the apply actions
            // so it can't be re-applied by mistake; show an explicit "Applied" state.
            if isApplied {
                Label("Applied", systemImage: "checkmark.seal.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.status(.positive))
            } else {
                Button(applying ? "Applying…" : "Apply thread") {
                    applying = true
                    Task {
                        let err = await model.applyThread(id: threadId)
                        applying = false
                        outcome = err.map(Outcome.failed) ?? .applied
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(applying)
                .help("Deliver the thread's accumulated diff to the project (server-gated)")
                Button("As branch") {
                    applying = true
                    Task {
                        let err = await model.applyThread(id: threadId, mode: "branch")
                        applying = false
                        outcome = err.map(Outcome.failed) ?? .applied
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(applying)
                .help("Deliver onto a new branch instead of the working tree")
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
    }
}
