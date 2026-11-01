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
    @Environment(ConversationPresentation.self) private var presentation: ConversationPresentation?
    let turn: ThreadTurnInfo
    let target: TurnStartTarget
    /// Current per-turn routing choices shared with plan-card actions. Strategy,
    /// access, and review controls are deliberately absent.
    let routingOptions: TurnOptions
    /// The thread's execution tree (`ThreadWorkspacePanel.executionRoot`): answer
    /// and transcript file links resolve there, never in a delegated thread's
    /// project; nil leaves only the run's own directory in scope.
    let executionRoot: String?
    var historyRow: ThreadHistoryTurn? = nil

    /// Roots whose files this turn's answer and transcript may open or render.
    static func fileScopeRoots(executionRoot: String?, runDir: String?) -> [String] {
        [executionRoot, runDir].compactMap { $0 }
    }

    /// The same tree on a remote location, addressed through the run's project.
    static func remoteFileScope(_ run: TaskRun, executionRoot: String?) -> RemoteFileScope {
        RemoteFileScope(
            runID: run.resolvedRunId ?? run.id, projectRoot: run.repoRoot, executionRoot: executionRoot)
    }

    @State private var actionError: String?
    /// Set after a successful accept-risk decision so the apply affordance appears
    /// immediately; the SERVER gate still owns whether apply succeeds.
    @State private var riskAccepted = false
    /// Set after a successful apply so the apply buttons can't be clicked twice.
    @State private var applied = false
    /// nil => follow the run state (expanded while active, collapsed when done);
    /// a user toggle pins it.
    @State private var localTranscriptExpanded: Bool?
    private var transcriptExpanded: Bool? {
        get { presentation?.transcripts[turn.id] ?? localTranscriptExpanded }
        nonmutating set {
            if let presentation { presentation.transcripts[turn.id] = newValue }
            else { localTranscriptExpanded = newValue }
        }
    }
    /// True while an "Implement plan" turn is being sent.
    @State private var implementingPlan = false
    /// W22: a LONG final answer starts height-collapsed with a Show more toggle.
    @State private var localAnswerExpanded = false
    private var answerExpanded: Bool {
        get { presentation?.expanded["answer:" + turn.id] ?? (presentation?.latestTurnID == turn.id || localAnswerExpanded) }
        nonmutating set {
            if let presentation { presentation.expanded["answer:" + turn.id] = newValue }
            else { localAnswerExpanded = newValue }
        }
    }

    private var run: TaskRun? {
        let live = turn.runId.flatMap { model.task($0, at: target.locationID) }
        if let historyRow { return model.selectedHistory?.renderedRun(for: historyRow, live: live) }
        return live
    }

    private var planImplementAccessSelection: ComposerThreadAccessSelection {
        .resolve(
            recordedWire: model.effectiveThreadAccess,
            defaultAccess: model.composerAccessDefault
        )
    }

    private var planImplementAccess: AccessProfile? {
        planImplementAccessSelection.activeAccess
    }

    private var planImplementAccessDescription: String {
        planImplementAccess?.label.lowercased() ?? "an active access profile"
    }

    private var planImplementOptions: TurnOptions {
        var options = routingOptions
        options.access = planImplementAccess?.wire
        return options
    }

    private var planImplementBlocker: String? {
        if let blocker = planImplementAccessSelection.migrationBlocker { return blocker }
        return model.turnStartAdmission(
            target: target, mode: .agent, options: planImplementOptions).interactionBlocker
    }

    /// A decision-flow run applies from its CHAT RECEIPT (decide → apply inline);
    /// a clean run applies from the thread workspace. Split so apply renders once.
    private func isDecisionFlow(_ run: TaskRun) -> Bool {
        DecisionApplyPresentation.isDecisionFlow(run)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            // W-C5: the user's message is a right-aligned BUBBLE above the
            // assistant card — the feed reads as a conversation.
            PromptBubble(prompt: turn.prompt, turnID: turn.id, promptInfo: historyRow?.promptInfo,
                fullPrompt: { try await model.fullHistoryPrompt(turnID: turn.id,
                    locationID: target.locationID, threadID: turn.threadId) })
            assistantSection
        }
        .environment(\.proseMessageID, turn.id)
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
                if run.hasRetainedOutput {
                    RetainedOutputView(task: run, locationID: target.locationID)
                        .padding(Theme.Spacing.md)
                } else {
                    answerBubble(run)
                }
                // ONE persistent receipt row: the whole row toggles inline activity.
                TurnReceiptRow(
                    run: run, runId: runId, locationID: target.locationID,
                    expanded: transcriptExpanded ?? run.phase.isActive,
                    onToggle: {
                        if (model.transcript(runId, at: target.locationID)?.blocks ?? []).isEmpty {
                            model.openRun(run.id)
                        }
                        else { transcriptExpanded = !(transcriptExpanded ?? run.phase.isActive) }
                    },
                    onOpenWorkspace: { model.openRun(run.id) }, historyRun: historyRow?.run)
                if let warning = DelegationPresentation.warning(run.delegation, phase: run.phase) {
                    DelegationWarningRow(warning: warning)
                }
                // Delegate children remain ordinary FLAT run rows. The narrow
                // server-owned `delegatedFromRunId` field is the only admission
                // rule; native vendor subagents never appear in this list.
                ForEach(model.delegatedChildren(
                    of: run,
                    projectedIds: turn.run?.delegatedChildRunIds ?? [], at: target.locationID
                )) { child in
                    DelegatedRunRow(child: child)
                }
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
                    InteractionCard(interaction: pending)
                }
                // D17: a plan that came back needs_answers surfaces its open
                // questions inline; answering submits a follow-up plan turn.
                if run.mode == .plan, run.planReadiness?.state == "needs_answers", !run.planQuestions.isEmpty {
                    let submitted = historyRow?.answeredByTurnId
                    if historyRow?.planAnswerComplete == false {
                        Text("Plan answer status is unavailable.").font(.caption).foregroundStyle(.secondary)
                    } else if submitted != nil || model.selectedHistory?.header?.headRun?.runId == runId {
                        PlanQuestionCard(
                            questions: run.planQuestions,
                            sourcePlanRunId: runId,
                            submittedPrompt: submitted == nil ? nil : historyRow?.answeredByPrompt?.prompt ?? "",
                            target: target,
                            routingOptions: routingOptions)
                    } else {
                        Label(
                            "Questions superseded by a later turn",
                            systemImage: "arrow.turn.down.right"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .help("Answer the questions on the latest Plan turn instead.")
                    }
                }
                // The interactive "Implement plan" affordance stays inline (owner).
                if let result = turn.run?.result, result.kind == "plan" {
                    planImplementRow(result)
                }
                if let historyRow { HistoryEvidenceNotice(row: historyRow, locationID: target.locationID) }
                decisionAndApply(run)
                // A4: the honest DELIVERY-state line — a terminal run whose patch
                // was applied under a BLOCKED review ("Applied · review blocked"),
                // reverted, or adopted must voice it INLINE on the turn. The
                // receipt shows lifecycle ("Succeeded") and never the delivery
                // state, so D42 must not leave a project mutation visible only in
                // the workspace Outcome facts (INV-093 honest outcome).
                applyStateLine(run)
                // Inline failure card: a terminal-FAILED turn with nothing to show,
                // or a request the engine refused before sending (#147/#393) — its
                // collapsed transcript would otherwise hide why nothing ran.
                if isSilentFailure(run) || RunFacts.refusal(run) != nil { failureCard(run) }
            } else if let refusal = turn.enqueueError {
                TurnRefusalCard(turn: turn, refusal: refusal, target: target)
            } else if historyRow?.runStatus == "not_retained" {
                Text("Run details are no longer kept.").font(.caption).foregroundStyle(.secondary)
                    .help("Saved prompts outlive run retention. This run’s receipt and output can no longer be read from its run record.")
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
    }

    // MARK: Answer bubble

    @ViewBuilder
    private func answerBubble(_ run: TaskRun) -> some View {
        if let answer = run.answerText, !answer.isEmpty, run.phase.isTerminal {
            ConversationAnswerText(answer: answer,
                expanded: Binding(get: { answerExpanded }, set: { answerExpanded = $0 }),
                fileScopeRoots: Self.fileScopeRoots(executionRoot: executionRoot, runDir: run.runDir),
                remoteFileScope: Self.remoteFileScope(run, executionRoot: executionRoot))
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            // D-12 round 2: the same tinted-material recipe as the user bubble
            // (one owner, `bubbleFill`). This bubble sits over the opaque
            // assistant `cardSurface`, so the material can only lightly tint it —
            // it stays the loudest, most solid-reading anchor (the honest ceiling
            // of the composition chain), and Reduce Transparency keeps it solid.
            .bubbleFill(tint: Theme.surfaceRaisedHi, radius: Theme.Radius.control)
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
        let transcript = model.transcript(runId, at: target.locationID)
        let blocks = transcript?.blocks ?? []
        if !blocks.isEmpty, (transcriptExpanded ?? run.phase.isActive) {
            TranscriptView(blocks: blocks,
                           trimmedOlder: transcript?.trimmed ?? 0,
                           truncatedChars: transcript?.truncatedChars ?? 0,
                           fileScopeRoots: Self.fileScopeRoots(
                               executionRoot: executionRoot, runDir: run.runDir),
                           remoteFileScope: Self.remoteFileScope(run, executionRoot: executionRoot))
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
            if let planImplementAccess {
                Label("Agent · \(planImplementAccess.label)", systemImage: planImplementAccess.glyph)
                    .font(.caption)
                    .foregroundStyle(Theme.status(.caution))
                    .help("Implement starts a write-capable Agent turn with \(planImplementAccessDescription) access.")
            } else {
                Label("Choose access in composer", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.status(.caution))
                    .help(planImplementBlocker ?? "Choose an active access profile before implementing.")
            }
            Spacer()
            // D17: Implement follows the server plan-readiness gate. Open questions
            // ⇒ the primary path is the answer card; the only way past is the
            // explicit, destructive "Implement anyway" override.
            if run?.planReadiness?.state == "needs_answers" {
                Button(implementingPlan ? "Implementing…" : "Implement anyway") { implementPlan(override: true) }
                    .buttonStyle(.bordered).controlSize(.small).tint(.red)
                    .disabled(
                        implementingPlan
                            || model.isThreadBusy(target.threadID, at: target.locationID)
                            || planImplementBlocker != nil)
                    .help(planImplementBlocker
                        ?? "Start an Agent turn with \(planImplementAccessDescription) access and override the plan-readiness gate although questions remain")
            } else {
                Button(implementingPlan ? "Implementing…" : "Implement plan") { implementPlan(override: false) }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                    .disabled(
                        implementingPlan
                            || model.isThreadBusy(target.threadID, at: target.locationID)
                            || planImplementBlocker != nil)
                    .help(planImplementBlocker
                        ?? "Start an Agent turn with \(planImplementAccessDescription) access to implement this plan")
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
                Task { await model.selectedHistory?.refresh() }
                // DecisionBar owns the one post-mutation detail refresh before
                // invoking this callback. The receipt is therefore current; a
                // second GET here would only duplicate the same snapshot.
            }
        }
        if historyRow?.run?.applyEligibilityCoverage == "unavailable" {
            HStack {
                Button("Apply patch") {}
                Button("Apply as branch") {}
            }.buttonStyle(.bordered).disabled(true)
                .help("Apply eligibility is unavailable because the retained evidence could not be verified. Open the workspace for details.")
        } else if applied {
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
    /// produced no visible content (no answer, no executor transcript, no diff).
    /// An engine notice (e.g. what its copy was prepared with) is not output.
    private func isSilentFailure(_ run: TaskRun) -> Bool {
        guard run.phase.isFailureShaped else { return false }
        let hasAnswer = !(run.answerText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasTranscript = TurnPresentation.hasExecutorActivity(
            blocks: turn.runId.flatMap { model.transcript($0, at: target.locationID)?.blocks } ?? [])
        return !hasAnswer && !hasTranscript && !run.hasPatchArtifact
    }

    private func failureCard(_ run: TaskRun) -> some View {
        TurnFailureCard(run: run, reason: failureReason(run), openRun: { model.openRun(run.id) })
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
        guard let runId = turn.runId, planImplementAccess != nil else { return }
        implementingPlan = true
        // Bind the request to the same write scope disclosed beside the button.
        var options = planImplementOptions
        options.overridePlanReadiness = override
        Task {
            await model.composerSend(prompt: "Implement this plan.", mode: .agent,
                                     planRunId: runId, options: options, target: target)
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
    /// eligibility says eligible (item f) AND the run is still `not_applied`
    /// (INV-093: a CLI apply/revert projected onto the list summary retires the
    /// affordance even when the detail-only eligibility is stale) — hidden, not
    /// disabled, otherwise.
    static func showsApply(_ run: TaskRun) -> Bool {
        isDecisionFlow(run) && run.applyEligibility?.eligible == true
            && run.applyState == "not_applied"
    }

    /// The eligibility-reload identity: keyed on the decision signals AND the
    /// local risk-accept, so accepting risk RE-FIRES the load and the stale
    /// blocked eligibility is replaced before Apply is gated (B6).
    static func applyLoadKey(_ run: TaskRun?, riskAccepted: Bool) -> String {
        guard let run else { return "none" }
        return "\(run.id):\(run.reviewNeedsDecision):\(run.operatorDecisionAction ?? ""):\(riskAccepted)"
    }
}
