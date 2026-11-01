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
    /// Where the run executes: its transcript is read for that location only.
    let locationID: ExecutionLocationID
    let expanded: Bool
    let onToggle: () -> Void
    let onOpenWorkspace: () -> Void
    var historyRun: ThreadHistoryRun? = nil

    private var line: TurnPresentation.StatusLine {
        TurnPresentation.statusLine(
            phase: run.phase, reason: run.outcomeFacts?.reason,
            harnesses: run.harnesses, n: run.n,
            isRace: run.mode == .bestOfN,
            retryLabel: run.phase.isActive ? run.retryStatus?.label : nil,
            reviewNeedsDecision: run.reviewNeedsDecision,
            waitingOnUser: run.waitingOnUser)
    }

    private var countSummary: String? {
        if let historyRun {
            let warning = TurnPresentation.noticeSummary(blocks: blocks)
            let parts = [HistoryRunPresentation.counts(historyRun), warning].compactMap { $0 }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
        return TurnPresentation.activitySummary(blocks: blocks)
    }

    private var blocks: [TranscriptBlock] { model.transcript(runId, at: locationID)?.blocks ?? [] }

    private var hasActivity: Bool { !blocks.isEmpty }

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
               let activity = TurnPresentation.lastActivityLine(blocks: blocks) {
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
                reviewNeedsDecision: run.reviewNeedsDecision, waitingOnUser: run.waitingOnUser,
                refusal: RunFacts.refusal(run)?.chip) {
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
            if let cash = CashSpend.receipt(
                total: spend.known ? spend.usd : nil, estimated: spend.estimated,
                controllable: spend.controllableUsd, cap: run.finiteCapUsd) {
                Text(cash.text)
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help(cash.help)
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
            if let summary = countSummary {
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
        if let historyRun, historyRun.startedAt == nil && historyRun.createdAt == nil {
            EmptyView()
        } else if run.phase.isActive {
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

/// The inline card for a terminal-failed turn with nothing else to show, and
/// for a request the engine refused before sending (#147/#393). The reason is
/// the engine's own text, selectable and complete. Pure: values in, one action out.
struct TurnFailureCard: View {
    struct Route: Equatable {
        let label: String
        let help: String
    }

    let title: String
    /// The engine refused before sending: nothing ran, so a raised hand instead
    /// of the failure triangle.
    let refused: Bool
    let category: String?
    let route: Route?
    /// The engine's message, complete. With `shortfall` it is the summary's
    /// hover help; otherwise it is the card's body.
    let reason: String
    /// #147: typed over-window sizes, shown as a summary and a file table.
    var shortfall: RunFacts.Shortfall? = nil
    /// The failure record's typed next actions.
    var nextActions: [String] = []
    let openRun: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: refused ? "hand.raised.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.status(.negative))
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                HStack(spacing: Theme.Spacing.xs) {
                    Text(title)
                        .font(.caption.weight(.semibold)).foregroundStyle(Theme.status(.negative))
                    if let category {
                        Text(category.replacingOccurrences(of: "_", with: " "))
                            .font(.caption2)
                            .padding(.horizontal, Theme.Spacing.xs)
                            .background(Theme.status(.negative).opacity(0.12), in: Capsule())
                            .foregroundStyle(Theme.status(.negative))
                    }
                    if let route {
                        Text(route.label)
                            .font(.caption2).foregroundStyle(.secondary)
                            .help(route.help)
                    }
                }
                if let shortfall {
                    Text(shortfall.summary)
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        .help(reason)
                    shortfallTable(shortfall.rows)
                } else {
                    Text(reason)
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                ForEach(Array(nextActions.prefix(3).enumerated()), id: \.offset) { _, action in
                    Label(action, systemImage: "arrow.right.circle")
                        .font(.caption2).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            Spacer()
            Button("Open run", action: openRun)
                .buttonStyle(.link)
                .help("Open this run in the thread workspace — failure detail, evidence, logs")
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.status(.negative).opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
    }

    /// Largest mandatory files first, paths in the code face, estimates on one
    /// right edge; the closing "N more files" row keeps the total honest.
    private func shortfallTable(_ rows: [RunFacts.Shortfall.Row]) -> some View {
        Grid(alignment: .leading, horizontalSpacing: Theme.Spacing.md, verticalSpacing: Theme.Spacing.xxs) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    Text(row.label)
                        .font(row.isPath ? .caption.monospaced() : .caption)
                        .foregroundStyle(row.isPath ? .primary : .secondary)
                        .lineLimit(1).truncationMode(.middle)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(row.size)
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        .gridColumnAlignment(.trailing)
                }
            }
        }
        .padding(Theme.Spacing.xs)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
    }
}

extension TurnFailureCard {
    /// Every input from the run's typed facts, so the card is composed here and
    /// nowhere else (the turn card passes only the reason and the action).
    init(run: TaskRun, reason: String, openRun: @escaping () -> Void) {
        let refusal = RunFacts.refusal(run)
        let record = run.failureRecord
        let shortfall = refusal == nil ? nil : record?.rawContextShortfall.map {
            RunFacts.shortfall($0, earlierFailedTries: record?.poolAttempts.count ?? 0)
        }
        self.init(
            title: refusal?.title ?? RunReasonLabel.label(run.outcomeFacts?.reason) ?? run.phase.label,
            refused: refusal != nil,
            category: run.failureCategory.flatMap { $0 == "unknown" ? nil : $0 },
            route: run.authRoute.flatMap { route -> Route? in
                guard let effective = route.effective, effective != "unknown" else { return nil }
                return Route(label: "route: \(RunFacts.authModeLabel(effective))",
                             help: "Auth route this turn ran under — requested: \(route.requested), reason: \(route.reason).")
            },
            reason: reason,
            shortfall: shortfall,
            nextActions: shortfall == nil ? [] : record?.nextActions ?? [],
            openRun: openRun)
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
