import AppKit
import ClaudexorKit
import SwiftUI

func browserRequirementDetail(_ requirements: [RequestRequirementResolution]?) -> String? {
    let browser = (requirements ?? []).filter { $0.capability == "browser" && $0.requested }
    guard !browser.isEmpty else { return nil }
    return browser.map {
        "\($0.harnessId): \($0.effective ? "browser enabled" : "browser unavailable (\($0.reason))")"
    }.joined(separator: " · ")
}

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let taskId: String
    @State private var tab: RunDetailTab = .outcome
    @State private var verbosity: Verbosity = .normal
    @State private var userSelectedTab = false
    @State private var detailsExpanded = false
    /// True while a Revert request is in flight; the server owns the outcome.
    @State private var reverting = false
    /// Honest revert refusal (e.g. the tree diverged since the turn). nil => none.
    @State private var revertError: String?
    /// D15: identity-keyed diff load slot — switching runs shows loading/empty,
    /// never the previous run's diff or a stale error banner.
    @State private var diffSlot = PayloadSlot<[DiffFile]>()

    private var task: TaskRun? { model.task(taskId) }

    private func tabInputs(_ task: TaskRun) -> RunDetailTabInputs {
        RunDetailTabInputs(
            isActive: task.phase.isActive,
            isFailureShaped: task.phase.isFailureShaped,
            hasAnswer: task.answerText != nil)
    }

    private func defaultTab(for task: TaskRun) -> RunDetailTab {
        RunDetailTabPolicy.defaultTab(tabInputs(task))
    }

    /// Re-apply the default ONLY while the user hasn't manually chosen a tab
    /// (the no-auto-jump guard, D15).
    private func autoSelectDefaultTab(for task: TaskRun) {
        tab = RunDetailTabPolicy.resolve(current: tab, userSelected: userSelectedTab, inputs: tabInputs(task))
    }

    var body: some View {
        if let task {
            VStack(alignment: .leading, spacing: 0) {
                header(task)
                tabBar(task)
                Divider().overlay(Theme.separator)
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        // Pending questions outrank every tab: the run is parked
                        // on the user, so the answer surface is always visible.
                        ForEach(task.pendingInteractions) { interaction in
                            InteractionCard(runId: task.id, interaction: interaction)
                        }
                        content(task)
                    }
                    .padding(Theme.Spacing.xxl)
                    .frame(maxWidth: Theme.Layout.contentMaxWidth, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Global text selection (M5c): propagates to all Run Detail
                    // text (banner, facts, diagnostics, artifact paths, findings).
                    .textSelection(.enabled)
                }
                .scrollContentBackground(.hidden)
            }
            .onAppear {
                tab = defaultTab(for: task)
                userSelectedTab = false
            }
            .onChange(of: task.phase) { _, _ in autoSelectDefaultTab(for: task) }
            .onChange(of: task.engineError ?? "") { _, _ in autoSelectDefaultTab(for: task) }
            .onChange(of: task.answerText ?? "") { _, _ in autoSelectDefaultTab(for: task) }
            // Reload on open for every live-sourced run (terminal included):
            // P3 eviction drops off-screen terminal feeds, and this is the
            // reload that restores them from the server timeline.
            .task(id: task.id) { if task.isLive { await model.loadRunDetail(task.id) } }
            .task(id: "\(task.id):\(tab.rawValue):\(task.hasPatchArtifact)") {
                if tab == .changes { await loadDiff(task.id) }
            }
        } else {
            EmptyStateView(title: "Run not found", message: "This run is no longer available.", systemImage: "questionmark.folder")
        }
    }

    // MARK: Header

    private func header(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ScreenHeader(title: task.title,
                         subtitle: task.prompt.isEmpty ? nil : task.prompt,
                         subtitleLineLimit: 2,
                         // Terminal status is only PRESENTED with its content;
                         // until the final snapshot lands the run is Finalizing.
                         accessory: AnyView(Group {
                             if task.isFinalizing { FinalizingPill() } else { StatusPill(status: task.phase) }
                         }))

            // W4.5: a PRIMARY row of 3-4 facts (route / apply / attention +
            // budget), composed from the one facts owner. Everything else
            // lives behind Details — the header no longer retells the card.
            // W4.5 + triad sol #2: the primary row is ONLY the material facts
            // (route / apply / attention) + budget + cancel; provenance and
            // the proof badge are evidence — they live in Details.
            HStack(spacing: Theme.Spacing.md) {
                ForEach(RunFacts.headerPrimary(task)) { fact in
                    factLabel(fact)
                }
                Spacer(minLength: Theme.Spacing.md)
                // Live-first spend: the streaming box while the run is live
                // (per-run invalidation), the task snapshot once terminal.
                let spend = model.spendDisplay(task)
                BudgetMini(spend: spend.usd, cap: task.capUsd, spendKnown: spend.known, capKnown: task.capKnown, capUnlimited: task.budgetUnlimited, spendEstimated: spend.estimated)
                if task.isLive && task.phase.isActive {
                    Button(role: .destructive) { Task { await model.cancel(task.id) } } label: {
                        Label("Cancel", systemImage: "stop.circle")
                    }
                    .buttonStyle(.bordered)
                    .help("Request cancel for the active harness process.")
                }
            }
            DisclosureGroup(isExpanded: $detailsExpanded) {
                FlowLayout(spacing: Theme.Spacing.md) {
                    ProvenanceTag(isLive: task.isLive)
                    RouteProofBadge(proof: task.routeProof)
                        .help(task.observedModel.map { "Observed model: \($0)" } ?? "No model identity was disclosed by the harness stream.")
                    ForEach(RunFacts.headerDetails(task)) { fact in
                        factLabel(fact)
                    }
                    ForEach(task.harnesses) { HarnessChip(family: $0) }
                }
                .padding(.top, Theme.Spacing.sm)
            } label: {
                Text("Details").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, Theme.Spacing.xxl)
        // sm, not xl: the inspector already sits under the reserved (empty)
        // titlebar band + the Workbench picker — a 24pt header inset on top
        // of those read as dead space (owner QA, 2.1.0).
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
    }

    /// ONE renderer for a RunFacts fact (icon+text+tone+help) — layout-free.
    private func factLabel(_ fact: RunFacts.Fact) -> some View {
        Label(fact.text, systemImage: fact.glyph ?? "circle")
            .font(fact.tone == .neutral ? .caption : .caption.weight(.medium))
            .foregroundStyle(fact.tone == .neutral ? AnyShapeStyle(.secondary) : AnyShapeStyle(fact.tone.color))
            .help(fact.help ?? fact.text)
    }

    // MARK: Tab bar (solid segmented; horizontally scrollable so it never forces a min)

    private func tabBar(_ task: TaskRun) -> some View {
        // Canonical segmented control (shared with the rest of the app); kept inside a
        // horizontal ScrollView so a long tab set never forces a wide minimum window.
        ScrollView(.horizontal, showsIndicators: false) {
            SegmentedTabs(items: RunDetailTab.allCases.map { ($0, $0.label, $0.glyph) },
                          selection: Binding(get: { tab }, set: { newValue in
                              userSelectedTab = true
                              tab = newValue
                          }),
                          badge: { badge(for: $0, task: task) })
                .padding(.horizontal, Theme.Spacing.xxl)
                .padding(.vertical, Theme.Spacing.sm)
        }
    }

    private func badge(for t: RunDetailTab, task: TaskRun) -> Int? {
        switch t {
        case .outcome:
            // The findings that need a human are the loudest thing to badge.
            if !task.findings.isEmpty { return task.findings.count }
            return task.answerText == nil ? nil : 1
        case .changes:
            let n = task.diff.count + task.candidates.count
            return n == 0 ? nil : n
        case .evidence:
            return task.engineError == nil && task.diagnosticText == nil ? nil : 1
        case .activity:
            return nil
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ task: TaskRun) -> some View {
        switch tab {
        case .outcome:
            outcomeContent(task)
        case .activity:
            activityContent(task)
        case .changes:
            changesContent(task)
        case .evidence:
            RunEvidenceView(task: task)
        }
    }

    // MARK: Activity (timeline + interactions)

    private func activityContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Timeline", systemImage: "waveform", accessory: AnyView(verbosityMenu))
            // Live-first feed: the run's streaming box while live (only this tab
            // re-renders per batch), the folded task history after. Pending
            // interactions stay pinned above every tab (they park the run on the
            // user); their history is part of the timeline events here.
            Panel {
                ActivityFeedView(events: model.activityFor(task),
                                 droppedOlder: model.liveBox(task.id)?.activityDropped ?? 0,
                                 verbosity: verbosity)
            }
        }
    }

    // MARK: Changes (diff + candidates)

    @ViewBuilder
    private func changesContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            diffSection(task)
            if !task.candidates.isEmpty {
                candidatesContent(task)
            }
        }
    }

    @ViewBuilder
    private func diffSection(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Diff", systemImage: "plusminus.circle")
            // Offer Revert here when the server says this turn's in-place change
            // is still safely revertable (tree unchanged since). Server-owned.
            if task.revertable {
                Panel(padding: Theme.Spacing.md) {
                    HStack(spacing: Theme.Spacing.sm) {
                        VStack(alignment: .leading, spacing: 2) {
                            Label("Applied in place", systemImage: "arrow.uturn.backward.circle")
                                .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                            if let revertError {
                                Text(revertError).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                            }
                        }
                        Spacer()
                        Button(reverting ? "Reverting…" : "Revert") {
                            reverting = true
                            Task {
                                let outcome = await model.revertRun(runId: task.id)
                                reverting = false
                                switch outcome {
                                case .reverted: revertError = nil
                                case .diverged(let message), .error(let message): revertError = message
                                }
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(reverting)
                        .help("Restore the project to this turn's pre-turn state (server refuses if you've edited since).")
                    }
                }
            }
            // D15: the diff renders from its identity-keyed load slot, so a run
            // switch never paints the previous run's patch (or a stale error).
            switch diffSlot.state {
            case .loaded(let files):
                DiffView(files: files)
            case .failed(let error):
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Label(error.message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.status(.caution))
                            .textSelection(.enabled)
                        Text("Full patch: final/patch.diff")
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                        Button("Retry") { Task { await loadDiff(task.id) } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
            case .empty:
                EmptyStateView(
                    title: "No diff",
                    message: "This run did not produce a patch.",
                    systemImage: "plusminus.circle")
            case .idle, .loading:
                ProgressView("Loading diff…").controlSize(.small)
            }
        }
    }

    /// Load the diff into its identity-keyed slot (D15). Reuses the heavy
    /// tab-only fetch (INV-136) and re-reads the model's parsed store on success.
    private func loadDiff(_ runId: String) async {
        let id = PayloadIdentity(runId: runId, plane: .diff)
        diffSlot.begin(id)
        guard let task = model.task(runId), task.hasPatchArtifact else {
            diffSlot.commit(.empty, for: id)
            return
        }
        if !task.diff.isEmpty {
            diffSlot.commit(.loaded(task.diff), for: id)
            return
        }
        switch await model.loadRunDiff(runId) {
        case .loaded:
            diffSlot.commit(.loaded(model.task(runId)?.diff ?? []), for: id)
        case .unavailable:
            diffSlot.commit(.empty, for: id)
        case .failed(let message):
            diffSlot.commit(.failed(.transport(message)), for: id)
        }
    }

    /// Tone for the server-owned outcome banner: a failure-shaped lifecycle or a
    /// review-blocked delivery must never read green.
    private func bannerTone(_ task: TaskRun) -> StatusTone {
        if task.phase.isFailureShaped { return .negative }
        if task.reviewNeedsDecision || task.outcomeFacts?.review == "blocked"
            || task.applyState == "applied_review_blocked" { return .caution }
        return .positive
    }

    // MARK: Outcome (banner + facts + review verdict + plan readiness/questions
    // + apply/decision controls) — the terminal-truth surface.

    @ViewBuilder
    private func outcomeContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            answerBlock(task)
            if task.planReadiness != nil || !task.planQuestions.isEmpty || !task.plan.isEmpty {
                planSection(task)
            }
            if task.reviewVerdict != .notRun || task.reviewNeedsDecision || !task.findings.isEmpty {
                reviewContent(task)
            }
        }
    }

    /// Plan readiness (D17) + open questions + the plan checklist, folded into
    /// Outcome. Interactive answering stays on the chat turn card (thread-bound);
    /// here it is the honest readiness + reference of what's still open.
    @ViewBuilder
    private func planSection(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Plan", systemImage: "checklist",
                         accessory: task.plan.isEmpty ? nil
                            : AnyView(Text("\(task.planDone)/\(task.plan.count) done")
                                .font(.caption).foregroundStyle(.secondary)))
            if let readiness = task.planReadiness {
                let ready = readiness.state == "ready"
                Label(ready ? "Plan is ready to implement"
                            : "Plan needs answers before implementing",
                      systemImage: ready ? "checkmark.seal.fill" : "questionmark.circle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.status(ready ? .positive : .caution))
                    .textSelection(.enabled)
            }
            if !task.planQuestions.isEmpty {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text("Open questions — answer on the plan turn in chat to continue.")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(task.planQuestions) { q in
                            Label(q.prompt, systemImage: "questionmark.circle")
                                .font(.caption).foregroundStyle(.primary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            if !task.plan.isEmpty {
                Panel { PlanListView(items: task.plan) }
            }
        }
    }

    private func answerBlock(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(task.mode == .ask ? "Answer" : "Outcome", systemImage: "text.bubble")
            // D18: the SERVER-OWNED outcome banner is the Outcome headline,
            // rendered VERBATIM — it always outranks model prose and is never
            // composed client-side ("Candidate ready — NOT APPLIED").
            if let banner = task.outcomeBanner,
               !banner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Label(banner, systemImage: "flag.fill")
                    .font(.headline)
                    .foregroundStyle(Theme.status(bannerTone(task)))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // D18: the apply gate is server-owned. When the run carries a patch,
            // its apply eligibility (single producer) states verbatim whether it
            // can be applied now and, if not, the honest next action.
            if let eligibility = task.applyEligibility, !eligibility.eligible,
               let action = eligibility.requiredAction ?? eligibility.reason {
                Label(action, systemImage: "hand.raised.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.status(.caution))
                    .textSelection(.enabled)
                    .help("Apply is server-refused until this is resolved (apply eligibility).")
            }
            Panel {
                if let answer = task.answerText, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownOutputView(markdown: answer,
                                       fileScopeRoots: [task.repoRoot, task.runDir].compactMap { $0 },
                                       bodyFont: .body)
                } else {
                    Text(task.outputReadyState == "finalizing" ? "Run is terminal; output is still finalizing. Open Diagnostics for events and artifact paths." : "No answer artifact yet. Open Diagnostics for engine state, events, and artifact paths.")
                        .font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let receipt = task.deliveryReceipt {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Label("Delivery receipt", systemImage: receipt.applied ? "checkmark.seal.fill" : "xmark.seal")
                            .font(.headline)
                            .foregroundStyle(receipt.applied ? Theme.status(.positive) : Theme.status(.negative))
                        Text("Target \(String(receipt.targetPreimageSha.prefix(12))) · verifier \(receipt.finalVerify.attempted ? "ran" : "not run") · gates \(receipt.finalVerify.gatesPassed == true ? "passed" : "not passed")")
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                        Button {
                            tab = .changes
                            userSelectedTab = true
                        } label: {
                            Label("Open Diff", systemImage: "plusminus.circle")
                        }
                        .buttonStyle(.bordered)
                        .disabled(!task.hasPatchArtifact)
                    }
                }
            }
        }
    }

    private var verbosityMenu: some View {
        Menu {
            // .inline renders the options DIRECTLY in the menu (no nested
            // "Verbosity ›" submenu — one click instead of two).
            Picker("Verbosity", selection: $verbosity) {
                ForEach(Verbosity.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            Label(verbosity.label, systemImage: "slider.horizontal.3").font(.caption)
        }
        .menuStyle(.borderlessButton).fixedSize()
        .help("Choose how much timeline detail to show.")
    }

    private func candidatesContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Candidates", systemImage: "flag.checkered.2.crossed",
                         accessory: RunFacts.bestOfLabel(task).map { bestOf in
                             AnyView(Text(bestOf.text)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(bestOf.degraded ? Theme.status(.caution) : .secondary)
                                .help(bestOf.degraded
                                    ? "Fewer candidates than requested — best-of degraded."
                                    : "Best-of race count."))
                         })
            if task.candidates.isEmpty {
                Panel { Text("No candidates yet — this mode runs a single envelope or hasn't spawned candidates.").font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: Theme.Spacing.md) {
                        ForEach(task.candidates) { CandidateCard(candidate: $0) }
                    }
                    .padding(.bottom, Theme.Spacing.xs)
                }
                if let winner = task.candidates.first(where: { $0.reviewState == .winner }) {
                    Panel(padding: Theme.Spacing.md) {
                        HStack(spacing: Theme.Spacing.sm) {
                            Image(systemName: "trophy.fill").foregroundStyle(Theme.accent)
                            Text(RunDetailMapping.winnerEvidenceText(winner))
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    private func reviewContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Cross-family review", systemImage: "person.2.badge.gearshape")
            Panel {
                Label(reviewVerdictText(task.reviewVerdict), systemImage: reviewVerdictGlyph(task.reviewVerdict))
                    .foregroundStyle(reviewVerdictColor(task.reviewVerdict))
            }
            // "Review & decide" from the chat card lands HERE — so the
            // decision actions must live here too, not only back on the card
            // (the tab used to show findings with no way to act: a dead end,
            // owner QA 2.1.0). Same server-owned decisions, same conditions.
            let decidable =
                (task.reviewNeedsDecision || task.applyState == "applied_review_blocked")
                && task.operatorDecisionAction == nil
            if decidable {
                DecisionBar(runId: task.id) {
                    await model.loadRunDetail(task.id)
                }
            } else if let action = task.operatorDecisionAction {
                Label("Operator decision recorded: \(action)", systemImage: "checkmark.seal")
                    .font(.caption).foregroundStyle(.secondary)
            } else if task.reviewVerdict == .clean {
                Text("No blocking findings — apply this run from its chat card.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !task.findings.isEmpty {
                ForEach(task.findings) { FindingCard(finding: $0) }
            }
        }
    }

}
