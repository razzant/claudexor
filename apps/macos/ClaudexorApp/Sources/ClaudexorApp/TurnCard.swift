import SwiftUI
import ClaudexorKit

// MARK: - Conversation turn cards
//
// Extracted from `ThreadsScreen.swift` (INV-124 readability ratchet): the turn
// card, the isolated-thread apply bar, the live transcript, and the frozen-spec
// card. Pure move — zero behavior change (top-level `private` became
// module-internal because the owner view now lives in another file).

/// One turn of the conversation: the prompt, its run state, and run actions
/// (open detail / decide / apply) — review actions live on the turn, not in a
/// separate dead-end queue.
struct TurnCard: View {
    @Environment(AppModel.self) private var model
    let turn: ThreadTurnInfo
    @State private var actionError: String?
    /// Set after a successful accept-risk decision so the apply affordance
    /// appears immediately; the SERVER gate still owns whether apply succeeds.
    @State private var riskAccepted = false
    /// Set after a successful apply so the apply buttons can't be clicked twice
    /// (the SERVER gate is still the source of truth; this is a local guard).
    @State private var applied = false
    /// Set after a successful revert so the affordance collapses immediately; the
    /// SERVER (work_product apply_state) is the source of truth on the next refresh.
    @State private var reverted = false
    /// True while a Revert request is in flight (the server owns the outcome).
    @State private var reverting = false
    /// The apply gate reason from the pre-flight check (why apply would be refused),
    /// shown up front so the user isn't surprised on press. nil => not checked / OK.
    @State private var applyBlockReason: String?
    /// nil => follow the run state (expanded while running, collapsed when done);
    /// a user toggle pins it.
    @State private var transcriptExpanded: Bool?
    /// True while an "Implement plan" turn is being sent, so the button shows a
    /// working state and can't be double-clicked (mirrors ApplyThreadBar.applying).
    @State private var implementingPlan = false

    private var run: TaskRun? { turn.runId.flatMap { model.task($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .top) {
                Image(systemName: "person.circle.fill").foregroundStyle(.secondary)
                Text(turn.prompt).font(.body).textSelection(.enabled)
                Spacer()
            }
            if let run {
                Divider()
                HStack(spacing: Theme.Spacing.sm) {
                    StatusPill(status: run.status)
                    Text(run.mode.label).font(.caption).foregroundStyle(.secondary)
                    // Live-first spend (the run's streaming box while live).
                    let spend = model.spendDisplay(run)
                    if spend.known {
                        Text(String(format: "$%.2f", spend.usd)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Open run") {
                        model.route = .task(run.id)
                    }
                    .buttonStyle(.link)
                    .help("Open this run in the inspector — diff, timeline, review")
                }
                // Live transcript: the harness's reasoning + tool calls as they
                // happen (folded from SSE), so the chat shows working progress —
                // not just a status pill and a final answer. Collapsible: expanded
                // while the run is live, folds away when it finishes (a user toggle
                // pins it). Read through the live-box overlay: while streaming only
                // THIS card re-renders per batch, not the whole conversation.
                if let runId = turn.runId {
                    let blocks = model.transcriptBlocks(runId)
                    if !blocks.isEmpty {
                        let live = run.status.isActive
                        DisclosureGroup(isExpanded: Binding(
                            get: { transcriptExpanded ?? live },
                            set: { transcriptExpanded = $0 }
                        )) {
                            TranscriptView(blocks: blocks, trimmedOlder: model.transcriptTrimmedCount(runId))
                        } label: {
                            Label(live ? "Working…" : "Transcript (\(blocks.count))", systemImage: "waveform")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                // Honest outcome (the v0.9 "is the game done?" fix): a plan turn
                // says "no files changed" and offers to implement it; a patch shows
                // its diffstat (and whether a race winner was auto-applied).
                if let result = turn.run?.result {
                    outcomeRow(result)
                    // Honest apply-state label: never a green "succeeded" next to an
                    // applied-but-review-blocked turn. Offers Revert while revertable.
                    applyStateRow(result, run: run)
                }
                // Server-derived: a persisted operator decision (from ANY surface,
                // surviving reloads) unblocks apply; `riskAccepted` only bridges
                // the moment between decide() and the refreshed run detail.
                let unblocked = run.operatorDecisionAction != nil || riskAccepted
                if (run.status == .blocked || run.status == .needsReview) && !unblocked {
                    DecisionBar(runId: run.id) {
                        // Bridge the moment between decide() and refreshed detail.
                        riskAccepted = true
                    }
                }
                if applied {
                    Label("Applied to project", systemImage: "checkmark.seal.fill")
                        .font(.caption).foregroundStyle(Theme.status(.succeeded))
                } else if (run.status == .succeeded && !run.diff.isEmpty) || unblocked {
                    // Apply PRE-FLIGHT: dry-run the gate when the apply bar appears so
                    // a refusal reason is shown UP FRONT, not only on press.
                    if let reason = applyBlockReason {
                        Label(reason, systemImage: "hand.raised.fill")
                            .font(.caption).foregroundStyle(.orange)
                            .textSelection(.enabled)
                            .help("Apply would be refused for this reason (apply pre-flight).")
                    }
                    applyBar(run)
                        .task(id: run.id) { applyBlockReason = await model.applyCheck(runId: run.id) }
                }
                if let answer = run.answerText, !answer.isEmpty, run.status.isTerminal {
                    Text(answer)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(8)
                        .textSelection(.enabled)
                }
                // Inline failure card: a terminal-FAILED turn with nothing to show
                // (no answer, no transcript, no diff — e.g. an unauthed harness wrote
                // only failure.yaml) otherwise reads as idle next to a red status pill.
                // Make it honest in the chat: surface the reason + an Open-run link.
                if isSilentFailure(run) { failureCard(run) }
            } else if let refusal = turn.enqueueError {
                // The turn's run was REFUSED before it started (trust gate,
                // preflight): render the persisted reason inline — a refused
                // turn must never look like an idle empty bubble.
                TurnRefusalCard(turn: turn, refusal: refusal)
            } else if let state = turn.run?.state {
                Text(state).font(.caption).foregroundStyle(.secondary)
            }
            if let actionError {
                Text(actionError).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(Theme.Spacing.md)
        .cardSurface(hover: run != nil)
        .contentShape(Rectangle())
        // Click the card to open the run inspector (the "Open run" link does the
        // same). Buttons inside the card take the tap first (SwiftUI priority), so
        // decide/apply/Implement-plan are unaffected.
        .onTapGesture { if let run { model.route = .task(run.id) } }
    }

    /// A turn that finished in a genuinely FAILURE-shaped terminal state but
    /// produced no visible content (no answer, no transcript, no diff). Without
    /// this the card shows only a status pill — silently idle-looking.
    ///
    /// ALLOW-LIST (not an exclude-list): only real failures get the red card.
    /// Benign/neutral terminals are NOT failures and must keep their own status —
    /// `noOp` (legitimately nothing to do), `ungated`/`reviewNotRun` (delivery/
    /// review policy states), `cancelled` (user-stopped), `needsReview`/`blocked`
    /// (carry their own decision/apply affordances). Rendering any of those as a
    /// red "failed" card would be dishonest.
    private func isSilentFailure(_ run: TaskRun) -> Bool {
        let failureShaped: Set<RunStatus> = [.failed, .interrupted, .costUnverifiable, .exhaustedOvershoot, .exhausted, .notConverged, .stuckNoProgress]
        guard failureShaped.contains(run.status) else { return false }
        let hasAnswer = !(run.answerText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasTranscript = !(turn.runId.map { model.transcriptBlocks($0) } ?? []).isEmpty
        return !hasAnswer && !hasTranscript && run.diff.isEmpty
    }

    /// Inline error card for a silent terminal failure (item 5): the engine's honest
    /// reason (engineError ← RunFailure.safeMessage) + an Open-run link. Never silent.
    private func failureCard(_ run: TaskRun) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.status(.failed))
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                HStack(spacing: Theme.Spacing.xs) {
                    Text(run.status.label).font(.caption.weight(.semibold)).foregroundStyle(Theme.status(.failed))
                    // W18: the TYPED failure category + the auth route that was
                    // tried — never inferred from prose.
                    if let category = run.failureCategory, category != "unknown" {
                        Text(category.replacingOccurrences(of: "_", with: " "))
                            .font(.caption2)
                            .padding(.horizontal, Theme.Spacing.xs)
                            .background(Theme.status(.failed).opacity(0.12), in: Capsule())
                            .foregroundStyle(Theme.status(.failed))
                    }
                    if let route = run.authRoute, let effective = route.effective, effective != "unknown" {
                        Text("route: \(TaskDetailView.authModeLabel(effective))")
                            .font(.caption2).foregroundStyle(.secondary)
                            .help("Auth route this turn ran under — requested: \(route.requested), reason: \(route.reason).")
                    }
                }
                Text(failureReason(run))
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Spacer()
            Button("Open run") { model.route = .task(run.id) }
                .buttonStyle(.link)
                .help("Open this run in the inspector — failure detail, timeline, logs")
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.status(.failed).opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
    }

    /// The engine's honest reason for a silent failure, or a neutral fallback when
    /// the failure record carried no message (still better than a bare status pill).
    private func failureReason(_ run: TaskRun) -> String {
        let reason = (run.engineError ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return reason.isEmpty
            ? "This turn ended without producing an answer, diff, or transcript."
            : reason
    }

    /// The honest terminal outcome of this turn (what it actually did).
    @ViewBuilder
    private func outcomeRow(_ result: RunResult) -> some View {
        switch result.kind {
        case "plan":
            HStack(spacing: Theme.Spacing.sm) {
                Label("Plan — no files changed", systemImage: "list.bullet.rectangle")
                    .font(.caption).foregroundStyle(.secondary)
                if result.blockers > 0 {
                    Label("\(result.blockers) blocker\(result.blockers == 1 ? "" : "s")", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(.orange)
                }
                Spacer()
                Button(implementingPlan ? "Implementing…" : "Implement plan") {
                    guard let runId = turn.runId else { return }
                    implementingPlan = true
                    Task {
                        // Bind to the plan turn's OWNING thread, not live selection.
                        await model.composerSend(prompt: "Implement this plan.", mode: .agent,
                                                 planRunId: runId, onThread: turn.threadId)
                        implementingPlan = false
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                // Can't start an Implement turn over a live head run (the composer's
                // busy gate also rejects it, but the button must reflect the invariant).
                .disabled(implementingPlan || model.selectedThreadBusy)
                .help("Run an agent turn that implements this plan")
            }
        case "patch":
            if let d = result.diffStat {
                Label("\(d.files) file\(d.files == 1 ? "" : "s") · +\(d.additions) −\(d.deletions)\(result.adopted == true ? " · applied" : "")",
                      systemImage: "plusminus")
                    .font(.caption).foregroundStyle(.secondary)
            }
        default:
            EmptyView()
        }
    }

    /// Honest RECONCILED outcome of the turn (W21, Квиз-7a): one composed line
    /// from the three orthogonal axes (execution terminal / delivery-apply /
    /// review gate) — at most two facts in the headline, the rest as chips.
    /// "Applied · review blocked" is an honest amber composition, NEVER a green
    /// "succeeded". While the mutation is still safely revertable, offers
    /// Revert (server-owned; refuses on tree divergence, surfaced verbatim).
    @ViewBuilder
    private func applyStateRow(_ result: RunResult, run: TaskRun) -> some View {
        // Local revert wins immediately; otherwise read the honest server state.
        let effective = reverted
            ? RunResult(kind: result.kind, diffStat: result.diffStat, blockers: result.blockers,
                        adopted: result.adopted, applyState: "reverted")
            : result
        if let line = OutcomePresentation.line(status: run.status, result: effective,
                                               reviewVerdict: run.reviewVerdict) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(line.headline)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(line.tone.color)
                ForEach(Array(line.chips.enumerated()), id: \.offset) { _, chip in
                    Text(chip.text)
                        .font(.caption2)
                        .padding(.horizontal, Theme.Spacing.xs)
                        .background(chip.tone.color.opacity(0.12), in: Capsule())
                        .foregroundStyle(chip.tone.color)
                }
                Spacer()
                // Offer Revert only while the server still says it's safe (tree
                // unchanged since) and we haven't already reverted this turn.
                if result.revertable && !reverted {
                    Button(reverting ? "Reverting…" : "Revert") {
                        guard let runId = turn.runId else { return }
                        reverting = true
                        Task {
                            let err = await model.revertRun(runId: runId)
                            reverting = false
                            if err == nil { reverted = true; actionError = nil }
                            else { actionError = err }
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(reverting)
                    .help("Restore the project to this turn's pre-turn state (server refuses if you've edited since)")
                }
            }
        }
    }

    private func applyBar(_ run: TaskRun) -> some View {
        // The pre-flight reason gates EVERY apply mode, not just in-place: the server
        // runs applyGateError(...) before deliver(...) for all modes (daemon-server.ts
        // /runs/:id/apply), and deliver() also refuses a dirty worktree before the
        // branch/pr checkout (delivery index.ts). A "branch" apply the gate refuses
        // would be rejected with the identical error — so disable BOTH buttons rather
        // than offer a doomed action.
        let blocked = applyBlockReason != nil
        return HStack(spacing: Theme.Spacing.sm) {
            Button("Apply patch") {
                Task {
                    actionError = await model.applyRun(runId: run.id)
                    if actionError == nil { applied = true }   // hide buttons; no double-apply
                }
            }
            .disabled(blocked)
            .help(blocked ? (applyBlockReason ?? "Apply is currently refused")
                          : "Applies the reviewed patch to the original project (server-gated)")
            Button("Apply as branch") {
                Task {
                    actionError = await model.applyRun(runId: run.id, mode: "branch")
                    if actionError == nil { applied = true }
                }
            }
            .disabled(blocked)
            .help(blocked ? (applyBlockReason ?? "Apply is currently refused")
                          : "Applies onto a new branch")
            Spacer()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
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
                .foregroundStyle(isApplied ? Theme.status(.succeeded) : Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Isolated workspace").font(.caption.weight(.medium))
                switch outcome {
                case .applied:
                    Text("Applied to the project — this thread's worktree has been delivered.")
                        .font(.caption).foregroundStyle(Theme.status(.succeeded))
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
                    .foregroundStyle(Theme.status(.succeeded))
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

/// Renders a turn's live transcript: reasoning (collapsible), tool calls (compact
/// mono rows with a status glyph), and assistant messages. Built from the
/// `TranscriptReducer` fold of the SSE stream.
private struct TranscriptView: View {
    let blocks: [TranscriptBlock]
    /// Oldest blocks the reducer's cap dropped (honest truncation marker).
    var trimmedOlder: Int = 0

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if trimmedOlder > 0 {
                Text("\(trimmedOlder) earlier transcript blocks collapsed — the full stream lives in the run's events.jsonl artifact.")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            ForEach(blocks) { block in
                switch block {
                case .thinking(_, let text):
                    DisclosureGroup {
                        Text(text)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        Label("Thinking", systemImage: "brain")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                case .tool(_, let tool):
                    HStack(spacing: 6) {
                        Image(systemName: glyph(tool.status))
                            .foregroundStyle(color(tool.status))
                            .font(.caption2)
                        Text(tool.name).font(.caption.monospaced().weight(.medium))
                        if let target = tool.target, !target.isEmpty {
                            Text(target).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if let code = tool.exitCode, code != 0 {
                            Text("exit \(code)").font(.caption2).foregroundStyle(Theme.status(.failed))
                        }
                    }
                case .message(_, let text):
                    // Render markdown (headings/lists/code), not flat text — the
                    // v0.10 chat regression fix (reuses the run-detail renderer).
                    MarkdownOutputView(markdown: text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    private func glyph(_ s: ToolBlock.Status) -> String {
        switch s {
        case .running: return "circle.dotted"
        case .ok: return "checkmark.circle.fill"
        case .error: return "xmark.circle.fill"
        }
    }
    private func color(_ s: ToolBlock.Status) -> Color {
        switch s {
        case .running: return .secondary
        case .ok: return Theme.status(.succeeded)
        case .error: return Theme.status(.failed)
        }
    }
}

/// The frozen-spec card: the SpecPack is sealed (id + hash + change count) and an
/// Implement button (styled like "Implement plan") sends an agent turn that reads
/// the spec FILE. The path is server-returned (never composed in Swift).
struct SpecFrozenCard: View {
    @Environment(AppModel.self) private var model
    /// The OWNING thread (captured at render) so Implement targets it, not selection.
    let threadId: String
    let specId: String
    let specPath: String
    let specHash: String
    let changes: Int
    @State private var implementing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "snowflake").foregroundStyle(Theme.accent)
                Text("Spec frozen").font(.subheadline.weight(.semibold))
                Spacer()
                // Dismiss the frozen card without implementing (otherwise the card is
                // a dead-end — the user froze a spec but chose not to run it).
                Button("Dismiss") { model.cancelSpec(threadId: threadId) }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(implementing)
                    .help("Clear this frozen spec without implementing it")
                Button(implementing ? "Implementing…" : "Implement") {
                    implementing = true
                    Task {
                        await model.implementSpec(threadId: threadId, specPath: specPath)
                        implementing = false
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                // Can't start an Implement turn over a live head run (composerSend
                // also rejects it; the button reflects the invariant).
                .disabled(implementing || model.selectedThreadBusy)
                .help("Run an agent turn that implements this frozen spec")
            }
            HStack(spacing: Theme.Spacing.md) {
                Label(specId, systemImage: "doc.badge.gearshape")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Label(String(specHash.prefix(12)), systemImage: "number")
                    .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    .help("Spec hash \(specHash)")
                Label("\(changes) change\(changes == 1 ? "" : "s")", systemImage: "plusminus")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(Theme.Spacing.lg)
        .cardSurface(stroke: true, strokeColor: Theme.accent.opacity(0.5))
    }
}
