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
    @State private var revertRefused = false
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
    /// W22: a LONG final answer starts height-collapsed with a Show more toggle
    /// (never the old hard 8-line cut); short answers render in full.
    @State private var answerExpanded = false

    private var run: TaskRun? { turn.runId.flatMap { model.task($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            // W-C5: the user's message is a right-aligned BUBBLE above the
            // assistant card — the feed reads as a conversation, not a stack
            // of uniform cards with a person icon.
            HStack(alignment: .top) {
                Spacer(minLength: 48)
                // Bounded before layout (sol #16): a pasted megabyte prompt
                // must not lay out unbounded on the main thread.
                Text(turn.prompt.count > 8_000 ? String(turn.prompt.prefix(8_000)) + "…" : turn.prompt)
                    .font(.body)
                    .textSelection(.enabled)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.sm)
                    .background(Theme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            }
            assistantSection
        }
    }

    /// The assistant side of the turn — its own card surface under the user
    /// bubble (W-C5: the feed reads as a conversation, not uniform cards).
    @ViewBuilder
    private var assistantSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let run {
                // W4.1 «Messenger»: ONE status line — two anchored clusters
                // (identity+state left, time+cash right) + the explicit ⧉
                // inspector affordance. The pill is dissolved (W4.2): quiet
                // facts are quiet text; attention states raise ONE loud chip.
                let line = TurnPresentation.statusLine(
                    status: run.status, harnesses: run.harnesses, n: run.n,
                    retryLabel: run.status.isActive ? run.retryStatus?.label : nil,
                    waitingOnUser: run.waitingOnUser)
                HStack(spacing: Theme.Spacing.sm) {
                    if let identity = line.identity {
                        // The identity renders with the designed chip finish
                        // (capsule fill + border), not a bare colored glyph —
                        // a raw Label read as an unfinished stray control
                        // (owner visual QA, 2.1.0).
                        Label(identity, systemImage: line.family?.glyph ?? "flag.checkered.2.crossed")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(line.family?.color ?? .secondary)
                            .padding(.horizontal, Theme.Spacing.sm)
                            .padding(.vertical, 3)
                            .background(
                                (line.family?.color ?? Theme.separator).opacity(0.13), in: Capsule())
                            .overlay(
                                Capsule().stroke(
                                    (line.family?.color ?? Theme.separator).opacity(0.35),
                                    lineWidth: 1))
                    }
                    if let word = line.stateWord {
                        Text(word).font(.caption).foregroundStyle(.secondary)
                    }
                    if let chip = TurnPresentation.attention(status: run.status,
                                                             waitingOnUser: run.waitingOnUser) {
                        Text(chip.text)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, Theme.Spacing.xs)
                            .padding(.vertical, 1)
                            .background(chip.tone.color.opacity(0.14), in: Capsule())
                            .foregroundStyle(chip.tone.color)
                    }
                    Spacer()
                    elapsedText(run)
                    // The engine's CASH fact (W4.3): $0.00 while the run stays
                    // on subscription routes, real dollars once a paid API
                    // route settles. No route inference, no valuation essay.
                    let spend = model.spendDisplay(run)
                    if spend.known {
                        Text(CashSpend.label(spend.usd, estimated: spend.estimated))
                            .font(.caption).foregroundStyle(.secondary)
                            .help(CashSpend.help(estimated: spend.estimated))
                    }
                    Button {
                        model.openRun(run.id)
                    } label: {
                        Image(systemName: "arrow.up.forward.square")
                    }
                    .buttonStyle(.borderless)
                    .help("Open this run in the inspector — diff, timeline, review")
                }
                // Non-blocking account-rotation note (INV-135): the engine
                // switched this run to another account at a quota limit. Surfaced
                // inline, never a modal; transient (cleared on the next snapshot).
                if let note = run.attentionNote {
                    Label(note, systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption)
                        .foregroundStyle(Theme.status(.blocked))
                        .padding(.horizontal, Theme.Spacing.sm)
                        .padding(.vertical, Theme.Spacing.xxs)
                        .background(Theme.status(.blocked).opacity(0.12), in: Capsule())
                        .textSelection(.enabled)
                }
                // ONE labeled Activity strip (W4.1): «Thinking 40s · 9 tools ·
                // 3 files». Clicking the CARD toggles it (V16a); expanded while
                // live by default, a user toggle pins it. Read through the
                // live-box overlay: while streaming only THIS card re-renders.
                if let runId = turn.runId {
                    let blocks = model.transcriptBlocks(runId)
                    if !blocks.isEmpty, let summary = TurnPresentation.activitySummary(blocks: blocks) {
                        let live = run.status.isActive
                        DisclosureGroup(isExpanded: Binding(
                            get: { transcriptExpanded ?? live },
                            set: { transcriptExpanded = $0 }
                        )) {
                            TranscriptView(blocks: blocks, trimmedOlder: model.transcriptTrimmedCount(runId),
                                           truncatedChars: model.transcriptTruncatedChars(runId),
                                           fileScopeRoots: [run.repoRoot, run.runDir].compactMap { $0 })
                        } label: {
                            Label(live ? "Working… · \(summary)" : summary, systemImage: "waveform")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                // The FINAL answer is the loudest element (W4.1 order: answer
                // bubble right under the activity strip; quiet outcome rows and
                // the action footer follow). W22: markdown, long answers start
                // height-collapsed with an explicit toggle.
                if let answer = run.answerText, !answer.isEmpty, run.status.isTerminal {
                    let long = Self.isLongAnswer(answer)
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        // Collapsed = a bounded PREFIX: frame+clipped alone still
                        // lays out the full text on the main thread (the W23
                        // hang class); the whole answer renders on Show more.
                        MarkdownOutputView(markdown: long && !answerExpanded ? String(answer.prefix(4_000)) : answer,
                                           fileScopeRoots: [run.repoRoot, run.runDir].compactMap { $0 })
                            .frame(maxHeight: long && !answerExpanded ? 260 : nil, alignment: .top)
                            .clipped()
                        if long {
                            Button(answerExpanded ? "Show less" : "Show more") {
                                answerExpanded.toggle()
                            }
                            .buttonStyle(.borderless)
                            .font(.caption)
                            .help(answerExpanded ? "Collapse the final answer" : "Show the whole final answer")
                        }
                    }
                    // W-C5: the FINAL answer is the loudest element of the turn
                    // — its own leading bubble, visually distinct from the
                    // dimmed narration in the transcript disclosure above.
                    .padding(Theme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.accent.opacity(0.05), in: RoundedRectangle(cornerRadius: Theme.Radius.control))
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(Theme.accent.opacity(0.5))
                            .frame(width: 2)
                            .padding(.vertical, Theme.Spacing.xs)
                    }
                }
                // QUIET outcome rows (W4.1 order: after the answer): what the
                // turn actually did — plan/diffstat, then the reconciled W21
                // line. Never a green "succeeded" next to a blocked review.
                if let result = turn.run?.result {
                    outcomeRow(result)
                }
                applyStateRow(turn.run?.result, run: run)
                // ACTION FOOTER (fixed position, last): decision, apply
                // pre-flight, apply. Server-derived: a persisted operator
                // decision (from ANY surface) unblocks apply; `riskAccepted`
                // bridges the moment between decide() and the refreshed detail.
                let unblocked = run.operatorDecisionAction != nil || riskAccepted
                if (run.status == .blocked || run.status == .needsReview) && !unblocked {
                    DecisionBar(runId: run.id) {
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
                // Inline failure card: a terminal-FAILED turn with nothing to show
                // (no answer, no transcript, no diff — e.g. an unauthed harness wrote
                // only failure.yaml) otherwise reads as idle-looking.
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(hover: run != nil)
        .contentShape(Rectangle())
        // Clicking the card toggles its Activity strip (V16a) — the inspector
        // opens ONLY via the explicit ⧉ affordance in the status line. Buttons
        // inside the card take the tap first (SwiftUI priority), so
        // decide/apply/Implement-plan are unaffected. When the run streamed NO
        // transcript blocks the toggle would be an invisible no-op and the
        // card felt dead — that case falls back to opening the inspector
        // (owner QA, 2.1.0).
        .onTapGesture {
            guard let run, let runId = turn.runId else { return }
            if model.transcriptBlocks(runId).isEmpty {
                model.openRun(run.id)
            } else {
                transcriptExpanded = !(transcriptExpanded ?? run.status.isActive)
            }
        }
    }

    /// Live elapsed clock while the run works («2 min»); the frozen duration
    /// once terminal. Auto-updating via Text(_:style:) — no timer plumbing.
    @ViewBuilder
    private func elapsedText(_ run: TaskRun) -> some View {
        if run.status.isActive {
            Text(run.createdAt, style: .relative)
                .font(.caption).foregroundStyle(.secondary)
                .help("Time since the run started")
        } else {
            let seconds = Int(run.updatedAt.timeIntervalSince(run.createdAt))
            if seconds >= 1 {
                Text(Self.durationLabel(seconds: seconds))
                    .font(.caption).foregroundStyle(.secondary)
                    .help("How long the run took")
            }
        }
    }

    /// «41s» / «2m 05s» — the terminal turn's frozen duration (unit-tested).
    static func durationLabel(seconds: Int) -> String {
        seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(String(format: "%02d", seconds % 60))s"
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
                        Text("route: \(RunFacts.authModeLabel(effective))")
                            .font(.caption2).foregroundStyle(.secondary)
                            .help("Auth route this turn ran under — requested: \(route.requested), reason: \(route.reason).")
                    }
                }
                Text(failureReason(run))
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Spacer()
            Button("Open run") { model.openRun(run.id) }
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

    /// Honest RECONCILED outcome of the turn (W21, Quiz-7a): one composed line
    /// from the three orthogonal axes (execution terminal / delivery-apply /
    /// review gate) — at most two facts in the headline, the rest as chips.
    /// "Applied · review blocked" is an honest amber composition, NEVER a green
    /// "succeeded". While the mutation is still safely revertable, offers
    /// Revert (server-owned; refuses on tree divergence, surfaced verbatim).
    @ViewBuilder
    private func applyStateRow(_ result: RunResult?, run: TaskRun) -> some View {
        // Local revert wins immediately; otherwise read the honest server
        // state. nil result = status-only outcome (the mapper handles it).
        let effective = reverted
            ? result.map { RunResult(kind: $0.kind, diffStat: $0.diffStat, blockers: $0.blockers,
                                     adopted: $0.adopted, applyState: "reverted") }
            : result
        if let line = OutcomePresentation.line(status: run.status, result: effective,
                                               reviewVerdict: run.reviewVerdict) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(line.headline)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(line.tone.color)
                    .textSelection(.enabled)
                ForEach(Array(line.chips.enumerated()), id: \.offset) { _, chip in
                    Text(chip.text)
                        .font(.caption2)
                        .padding(.horizontal, Theme.Spacing.xs)
                        .background(chip.tone.color.opacity(0.12), in: Capsule())
                        .foregroundStyle(chip.tone.color)
                }
                // An ungated / review-blocked outcome must offer its NEXT STEP
                // right in the chat — the findings and decisions live in the
                // run's Review tab, not behind a dead end.
                if run.status == .ungated || effective?.applyState == "applied_review_blocked" {
                    Button("Review & decide") { model.openRun(run.id) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .help("Open the run's review findings and decision actions")
                }
                Spacer()
                // Offer Revert only while the server still says it's safe (tree
                // unchanged since) and we haven't already reverted this turn.
                // After a divergence refusal the button DISAPPEARS for good —
                // an enabled control that 409s on every press violates the
                // "disabled control explains why" doctrine (INV-134); the
                // explanation stays visible as the action error text.
                if result?.revertable == true && !reverted && !revertRefused {
                    Button(reverting ? "Reverting…" : "Revert") {
                        guard let runId = turn.runId else { return }
                        reverting = true
                        Task {
                            let outcome = await model.revertRun(runId: runId)
                            reverting = false
                            switch outcome {
                            case .reverted:
                                reverted = true; actionError = nil
                            case .diverged(let message):
                                // Structural 409 refusal (tree diverged): retire the
                                // affordance; the reason stays as the action error.
                                actionError = message; revertRefused = true
                            case .error(let message):
                                actionError = message
                            }
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

    /// A final answer long enough to start collapsed (chat stays scannable).
    static func isLongAnswer(_ answer: String) -> Bool {
        answer.count > 1200 || answer.filter { $0 == "\n" }.count > 14
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
