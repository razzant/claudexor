import SwiftUI
import ClaudexorKit

// MARK: - Conversation turn cards (D42 receipt card)
//
// One turn of the conversation: the user's message, the final answer, and ONE
// persistent RECEIPT row (status glyph · harness · duration · spend · tool/file
// counts · outcome chip). The WHOLE receipt is the click target — it toggles the
// inline activity transcript (auto-expanded while the run is active, collapsed
// after unless the user pins it: progress never disappears, it becomes the log).
// Detailed changes/artifacts/evidence live in the THREAD WORKSPACE (a small
// "workspace" affordance opens it filtered to this run). Decision + apply render
// ONCE: the receipt carries them only when the run needs a decision; everything
// else is in the workspace (D42).

struct TurnCard: View {
    @Environment(AppModel.self) private var model
    /// D-12: Reduce Transparency restores fully SOLID bubble fills (the
    /// calibrated translucency is a visual affordance, never a legibility cost).
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let turn: ThreadTurnInfo
    @State private var actionError: String?
    /// Set after a successful accept-risk decision so the apply affordance appears
    /// immediately; the SERVER gate still owns whether apply succeeds.
    @State private var riskAccepted = false
    /// Set after a successful apply so the apply buttons can't be clicked twice.
    @State private var applied = false
    /// nil => follow the run state (expanded while active, collapsed when done);
    /// a user toggle pins it.
    @State private var transcriptExpanded: Bool?
    /// True while an "Implement plan" turn is being sent.
    @State private var implementingPlan = false
    /// W22: a LONG final answer starts height-collapsed with a Show more toggle.
    @State private var answerExpanded = false

    private var run: TaskRun? { turn.runId.flatMap { model.task($0) } }

    /// A decision-flow run applies from its CHAT RECEIPT (decide → apply inline);
    /// a clean run applies from the thread workspace. Split so apply renders once.
    private func isDecisionFlow(_ run: TaskRun) -> Bool {
        DecisionApplyPresentation.isDecisionFlow(run)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            // W-C5: the user's message is a right-aligned BUBBLE above the
            // assistant card — the feed reads as a conversation.
            HStack(alignment: .top) {
                Spacer(minLength: 48)
                // Bounded before layout (sol #16): a pasted megabyte prompt must
                // not lay out unbounded on the main thread.
                Text(turn.prompt.count > 8_000 ? String(turn.prompt.prefix(8_000)) + "…" : turn.prompt)
                    .font(.body)
                    // Owner-tuned bubble (round 4): the solid-accent version out-
                    // shouted the assistant's answer, so the user bubble is a QUIET
                    // faintly-tinted fill with PRIMARY text (ChatGPT/Claude-desktop
                    // convention; HIG reserves accent for interactive elements).
                    // No stroke; identity = right alignment + fill. The final
                    // answer bubble stays the loudest element in the feed.
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.sm)
                    // D-12: calibrated translucency over the ambient backdrop — solid
                    // under Reduce Transparency.
                    .background(
                        Theme.bubbleUser.opacity(reduceTransparency ? 1 : Theme.bubbleTranslucency),
                        in: RoundedRectangle(cornerRadius: Theme.Radius.bubble, style: .continuous))
            }
            assistantSection
        }
    }

    /// The assistant side of the turn — its own card surface under the user
    /// bubble (W-C5: the feed reads as a conversation, not uniform cards).
    @ViewBuilder
    private var assistantSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            // Continuity disclosure (INV-137/D21): one quiet line when this turn's
            // lane was hydrated with a continuation packet.
            if let note = turn.continuity?.disclosure {
                Label(note, systemImage: "arrow.triangle.branch")
                    .font(.caption2).foregroundStyle(.tertiary).textSelection(.enabled)
            }
            // QA-046: an Implement turn that froze an approved plan carries a
            // provenance receipt — the plan run + a short SHA of the exact frozen
            // bytes — and, when the operator implemented over open questions, a
            // persistent readiness-override warning that survives reload.
            if let planRunId = turn.planRunId {
                planImplementedReceipt(planRunId: planRunId,
                                       planHash: turn.planHash,
                                       overridden: turn.planReadinessOverridden)
            }
            if let run, let runId = turn.runId {
                // The FINAL answer is the loudest element — its own accent-edged
                // bubble above the quiet receipt (W22 Show-more clamp preserved).
                answerBubble(run)
                // ONE persistent receipt row: the whole row toggles inline activity.
                TurnReceiptRow(
                    run: run, runId: runId,
                    expanded: transcriptExpanded ?? run.phase.isActive,
                    onToggle: {
                        if model.transcriptBlocks(runId).isEmpty { model.openRun(run.id) }
                        else { transcriptExpanded = !(transcriptExpanded ?? run.phase.isActive) }
                    },
                    onOpenWorkspace: { model.openRun(run.id) })
                inlineActivity(run, runId: runId)
                // Non-blocking account-rotation note (INV-135), inline + transient.
                if let note = run.attentionNote {
                    Label(note, systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption).foregroundStyle(Theme.status(.caution))
                        .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, Theme.Spacing.xxs)
                        .background(Theme.status(.caution).opacity(0.12), in: Capsule())
                        .textSelection(.enabled)
                }
                // B2 (D42 regression fix): a mid-run harness question
                // (waiting_on_user) is answered INLINE on the turn, mirroring the
                // PlanQuestionCard placement below. D42 retired TaskDetailView, the
                // pinned InteractionCard's only surface, leaving AppModel
                // .answerInteraction with no UI caller — this restores it so a
                // pending interaction is always answerable in default config.
                ForEach(run.pendingInteractions) { pending in
                    InteractionCard(runId: runId, interaction: pending)
                }
                // D17: a plan that came back needs_answers surfaces its open
                // questions inline; answering submits a follow-up plan turn.
                if run.mode == .plan, run.planReadiness?.state == "needs_answers", !run.planQuestions.isEmpty {
                    PlanQuestionCard(questions: run.planQuestions, threadId: turn.threadId)
                }
                // The interactive "Implement plan" affordance stays inline (owner).
                if let result = turn.run?.result, result.kind == "plan" {
                    planImplementRow(result)
                }
                decisionAndApply(run)
                // A4: the honest DELIVERY-state line — a terminal run whose patch
                // was applied under a BLOCKED review ("Applied · review blocked"),
                // reverted, or adopted must voice it INLINE on the turn. The
                // receipt shows lifecycle ("Succeeded") and never the delivery
                // state, so D42 must not leave a project mutation visible only in
                // the workspace Outcome facts (INV-093 honest outcome).
                applyStateLine(run)
                // Inline failure card: a terminal-FAILED turn with nothing to show.
                if isSilentFailure(run) { failureCard(run) }
            } else if let refusal = turn.enqueueError {
                TurnRefusalCard(turn: turn, refusal: refusal)
            } else if let state = turn.run?.state {
                Text(state).font(.caption).foregroundStyle(.secondary)
            }
            if let actionError {
                Text(actionError).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The assistant remains a neutral content card with one quiet accent
        // hairline — same design family as the user bubble, distinct hierarchy.
        .cardSurface(strokeColor: Theme.accent.opacity(0.22), hover: run != nil)
        // A decision-flow run needs its detail loaded so the receipt can gate apply
        // on the server eligibility (item f) — the DecisionBar path also loads it,
        // this covers an already-decided run reopened cold.
        .task(id: applyLoadKey) {
            if let run, isDecisionFlow(run), run.applyEligibility == nil, model.task(run.id) != nil {
                await model.loadRunDetail(run.id)
            }
        }
    }

    /// Re-key the eligibility load on the run's decision-flow signals AND on the
    /// local risk-accept (B6): accepting risk makes the run eligible server-side,
    /// so the reload must re-fire to pull the fresh eligibility — the stale
    /// `run.applyEligibility` (blocked) would otherwise hide Apply until an
    /// unrelated refresh.
    private var applyLoadKey: String {
        DecisionApplyPresentation.applyLoadKey(run, riskAccepted: riskAccepted)
    }

    // MARK: Answer bubble

    @ViewBuilder
    private func answerBubble(_ run: TaskRun) -> some View {
        if let answer = run.answerText, !answer.isEmpty, run.phase.isTerminal {
            let long = Self.isLongAnswer(answer)
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                // Collapsed = a bounded PREFIX (the W23 hang class): frame+clip
                // alone still lays out the full text on the main thread.
                MarkdownOutputView(markdown: long && !answerExpanded ? String(answer.prefix(4_000)) : answer,
                                   fileScopeRoots: [run.repoRoot, run.runDir].compactMap { $0 },
                                   bodyFont: .body)
                    .frame(maxHeight: long && !answerExpanded ? 260 : nil, alignment: .top)
                    .clipped()
                if long {
                    Button(answerExpanded ? "Show less" : "Show more") { answerExpanded.toggle() }
                        .buttonStyle(.borderless).font(.caption)
                }
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            // D-12: the loudest element in the feed carries the same calibrated
            // translucency over the frosted card material — solid under Reduce
            // Transparency so the answer's contrast is never traded away.
            .background(
                Theme.surfaceRaisedHi.opacity(reduceTransparency ? 1 : Theme.bubbleTranslucency),
                in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(alignment: .leading) {
                UnevenRoundedRectangle(
                    cornerRadii: .init(topLeading: Theme.Radius.control, bottomLeading: Theme.Radius.control))
                    .fill(Theme.accent.opacity(0.45))
                    .frame(width: 2)
            }
        }
    }

    // MARK: Inline activity transcript

    @ViewBuilder
    private func inlineActivity(_ run: TaskRun, runId: String) -> some View {
        let blocks = model.transcriptBlocks(runId)
        if !blocks.isEmpty, (transcriptExpanded ?? run.phase.isActive) {
            TranscriptView(blocks: blocks,
                           trimmedOlder: model.transcriptTrimmedCount(runId),
                           truncatedChars: model.transcriptTruncatedChars(runId),
                           fileScopeRoots: [run.repoRoot, run.runDir].compactMap { $0 })
                // D-13 E: skip the up-to-200-row transcript re-layout when an
                // unrelated AppModel write re-ran this card's body but the blocks
                // are byte-identical (EquatableView compares before re-evaluating).
                .equatable()
        }
    }

    // MARK: Plan Implement (interactive, inline)

    @ViewBuilder
    private func planImplementRow(_ result: RunResult) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Label("Plan — no files changed", systemImage: "list.bullet.rectangle")
                .font(.caption).foregroundStyle(.secondary)
            if result.blockers > 0 {
                Label("\(result.blockers) blocker\(result.blockers == 1 ? "" : "s")", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            Spacer()
            // D17: Implement follows the server plan-readiness gate. Open questions
            // ⇒ the primary path is the answer card; the only way past is the
            // explicit, destructive "Implement anyway" override.
            if run?.planReadiness?.state == "needs_answers" {
                Button(implementingPlan ? "Implementing…" : "Implement anyway") { implementPlan(override: true) }
                    .buttonStyle(.bordered).controlSize(.small).tint(.red)
                    .disabled(implementingPlan || model.selectedThreadBusy)
                    .help("Override the plan-readiness gate and implement with questions still open")
            } else {
                Button(implementingPlan ? "Implementing…" : "Implement plan") { implementPlan(override: false) }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                    .disabled(implementingPlan || model.selectedThreadBusy)
                    .help("Run an agent turn that implements this plan")
            }
        }
    }

    /// A4: the inline honest apply-DELIVERY line via the single-owner mapper
    /// (`RunFacts.applyFact`). Read-only — the decision/apply/revert CONTROLS are
    /// owned by the DecisionBar (receipt) and the workspace, never duplicated
    /// here; this line only voices what already happened. The transient local
    /// "Applied to project" confirmation (`applied`) owns the just-applied case,
    /// so this yields to it.
    @ViewBuilder
    private func applyStateLine(_ run: TaskRun) -> some View {
        if !applied, run.phase.isTerminal,
           let fact = RunFacts.applyFact(state: run.applyState, adopted: run.adopted) {
            Label(fact.text, systemImage: fact.glyph)
                .font(.caption.weight(.medium))
                .foregroundStyle(fact.tone.color)
                .textSelection(.enabled)
                .help("Honest application state of this turn's in-place change.")
        }
    }

    // MARK: Decision + apply (rendered ONCE — receipt only for decision-flow runs)

    @ViewBuilder
    private func decisionAndApply(_ run: TaskRun) -> some View {
        // The review gate needs a human: the decision controls live HERE, inline.
        if DecisionApplyPresentation.showsDecisionBar(run, riskAccepted: riskAccepted) {
            DecisionBar(runId: run.id) {
                riskAccepted = true
                // B6: pull the SERVER apply-eligibility right after accept-risk so
                // Apply renders from the refreshed (now-eligible) gate — not the
                // stale blocked eligibility. isDecisionFlow stays true (the
                // operator decision is recorded), so Apply renders on THIS receipt.
                await model.loadRunDetail(run.id)
            }
        }
        if applied {
            Label("Applied to project", systemImage: "checkmark.seal.fill")
                .font(.caption).foregroundStyle(Theme.status(.positive))
        } else if DecisionApplyPresentation.showsApply(run) {
            // Item f: Apply is HIDDEN unless the server eligibility says eligible.
            // Only decision-flow runs apply here; clean runs apply in the workspace.
            HStack(spacing: Theme.Spacing.sm) {
                Button("Apply patch") { apply(run, mode: "apply") }
                Button("Apply as branch") { apply(run, mode: "branch") }
                Spacer()
            }
            .buttonStyle(.borderedProminent).controlSize(.small)
        }
    }

    private func apply(_ run: TaskRun, mode: String) {
        Task {
            actionError = await model.applyRun(runId: run.id, mode: mode)
            if actionError == nil { applied = true }
        }
    }

    // MARK: Live elapsed / duration (shared with the receipt row)

    /// «41s» / «2m 05s» — the terminal turn's frozen duration (unit-tested).
    static func durationLabel(seconds: Int) -> String {
        seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(String(format: "%02d", seconds % 60))s"
    }

    /// A final answer long enough to start collapsed (chat stays scannable).
    static func isLongAnswer(_ answer: String) -> Bool {
        answer.count > 1200 || answer.filter { $0 == "\n" }.count > 14
    }

    /// The Implement-turn plan-provenance receipt (QA-046): the frozen plan run +
    /// a short SHA of the exact plan bytes, plus a persistent warning when the
    /// operator implemented a not-ready plan over open questions.
    @ViewBuilder
    private func planImplementedReceipt(planRunId: String, planHash: String?, overridden: Bool) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Label {
                Text("Implemented plan \(String(planRunId.suffix(6)))"
                     + (planHash.map { " · sha256 \(String($0.prefix(12)))" } ?? ""))
                    .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
            } icon: {
                Image(systemName: "checkmark.seal").foregroundStyle(.secondary)
            }
            if overridden {
                Label("Implemented over open plan questions — plan readiness was overridden.",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2).foregroundStyle(Theme.status(.caution)).textSelection(.enabled)
            }
        }
    }

    // MARK: Silent-failure card (honest inline failure)

    /// A turn that finished in a genuinely FAILURE-shaped terminal state but
    /// produced no visible content (no answer, no transcript, no diff).
    private func isSilentFailure(_ run: TaskRun) -> Bool {
        guard run.phase.isFailureShaped else { return false }
        let hasAnswer = !(run.answerText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasTranscript = !(turn.runId.map { model.transcriptBlocks($0) } ?? []).isEmpty
        return !hasAnswer && !hasTranscript && !run.hasPatchArtifact
    }

    private func failureCard(_ run: TaskRun) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.status(.negative))
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                HStack(spacing: Theme.Spacing.xs) {
                    Text(RunReasonLabel.label(run.outcomeFacts?.reason) ?? run.phase.label)
                        .font(.caption.weight(.semibold)).foregroundStyle(Theme.status(.negative))
                    if let category = run.failureCategory, category != "unknown" {
                        Text(category.replacingOccurrences(of: "_", with: " "))
                            .font(.caption2)
                            .padding(.horizontal, Theme.Spacing.xs)
                            .background(Theme.status(.negative).opacity(0.12), in: Capsule())
                            .foregroundStyle(Theme.status(.negative))
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
                .help("Open this run in the thread workspace — failure detail, evidence, logs")
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.status(.negative).opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
    }

    private func failureReason(_ run: TaskRun) -> String {
        let reason = (run.engineError ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return reason.isEmpty
            ? "This turn ended without producing an answer, diff, or transcript."
            : reason
    }

    // MARK: Implement plan action

    /// Start an agent turn implementing this plan, bound to the plan turn's
    /// OWNING thread. `override` sets `overridePlanReadiness` for the destructive
    /// path when open questions remain (the engine otherwise 409s).
    private func implementPlan(override: Bool) {
        guard let runId = turn.runId else { return }
        implementingPlan = true
        var options = TurnOptions()
        options.overridePlanReadiness = override
        Task {
            await model.composerSend(prompt: "Implement this plan.", mode: .agent,
                                     planRunId: runId, options: options, onThread: turn.threadId)
            implementingPlan = false
        }
    }
}

/// Pure decision/apply presentation for a decision-flow turn's receipt (B6):
/// whether the DecisionBar and the Apply affordance render, and the reload key
/// that re-pulls SERVER eligibility after accept-risk. Extracted so the
/// blocked → accept-risk → eligible Apply transition is unit-tested
/// (TurnCardDecisionApplyTests) and cannot silently regress into an
/// apply-less accepted-risk run.
enum DecisionApplyPresentation {
    /// A decision-flow run (needs a human, or already carries an operator
    /// decision) applies from its chat receipt — never duplicated in the
    /// workspace (D42).
    static func isDecisionFlow(_ run: TaskRun) -> Bool {
        run.reviewNeedsDecision || run.operatorDecisionAction != nil
    }

    /// The DecisionBar shows while the run still needs a decision and the user
    /// has not just accepted risk locally.
    static func showsDecisionBar(_ run: TaskRun, riskAccepted: Bool) -> Bool {
        run.reviewNeedsDecision && !riskAccepted
    }

    /// Apply renders on the receipt for a decision-flow run ONCE the SERVER
    /// eligibility says eligible (item f) — hidden, not disabled, otherwise.
    static func showsApply(_ run: TaskRun) -> Bool {
        isDecisionFlow(run) && run.applyEligibility?.eligible == true
    }

    /// The eligibility-reload identity: keyed on the decision signals AND the
    /// local risk-accept, so accepting risk RE-FIRES the load and the stale
    /// blocked eligibility is replaced before Apply is gated (B6).
    static func applyLoadKey(_ run: TaskRun?, riskAccepted: Bool) -> String {
        guard let run else { return "none" }
        return "\(run.id):\(run.reviewNeedsDecision):\(run.operatorDecisionAction ?? ""):\(riskAccepted)"
    }
}
