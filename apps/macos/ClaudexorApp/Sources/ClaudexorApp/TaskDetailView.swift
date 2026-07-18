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
    @State private var tab: Tab = .answer
    @State private var verbosity: Verbosity = .normal
    @State private var userSelectedTab = false
    @State private var detailsExpanded = false
    /// True while a Revert request is in flight; the server owns the outcome.
    @State private var reverting = false
    /// Honest revert refusal (e.g. the tree diverged since the turn). nil => none.
    @State private var revertError: String?
    @State private var actionError: String?
    @State private var retrying = false
    @State private var runAgainDraft: RunAgainDraft?
    @State private var runAgainPrompt = ""
    @State private var showRunAgain = false
    @State private var runningAgain = false
    @State private var diffLoading = false
    @State private var diffLoadError: String?

    enum Tab: String, CaseIterable, Identifiable {
        case answer, plan, activity, candidates, diff, review, artifacts, diagnostics
        var id: String { rawValue }
        var label: String {
            switch self {
            case .answer: return "Outcome"
            case .plan: return "Plan"
            case .activity: return "Timeline"
            case .candidates: return "Candidates"
            case .diff: return "Diff"
            case .review: return "Review"
            case .artifacts: return "Artifacts"
            case .diagnostics: return "Diagnostics"
            }
        }
        var glyph: String {
            switch self {
            case .answer: return "text.bubble"
            case .plan: return "checklist"
            case .activity: return "waveform"
            case .candidates: return "flag.checkered.2.crossed"
            case .diff: return "plusminus.circle"
            case .review: return "person.2.badge.gearshape"
            case .artifacts: return "photo.on.rectangle.angled"
            case .diagnostics: return "stethoscope"
            }
        }
    }

    private var task: TaskRun? { model.task(taskId) }

    private func defaultTab(for task: TaskRun) -> Tab {
        if task.status.isActive {
            return .activity
        }
        // A blocked run's deliverable IS the findings that need a human.
        if task.status == .blocked {
            return task.findings.isEmpty ? .diagnostics : .review
        }
        if task.status == .failed || task.status == .unknown || task.status == .costUnverifiable || task.status == .exhaustedOvershoot || task.status == .notConverged || task.status == .stuckNoProgress || task.status == .exhausted {
            return task.answerText == nil ? .diagnostics : .answer
        }
        return .answer
    }

    private func autoSelectDefaultTab(for task: TaskRun) {
        guard !userSelectedTab else { return }
        tab = defaultTab(for: task)
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
                }
                .scrollContentBackground(.hidden)
            }
            .onAppear {
                tab = defaultTab(for: task)
                userSelectedTab = false
            }
            .onChange(of: task.status) { _, _ in autoSelectDefaultTab(for: task) }
            .onChange(of: task.engineError ?? "") { _, _ in autoSelectDefaultTab(for: task) }
            .onChange(of: task.answerText ?? "") { _, _ in autoSelectDefaultTab(for: task) }
            // Reload on open for every live-sourced run (terminal included):
            // P3 eviction drops off-screen terminal feeds, and this is the
            // reload that restores them from the server timeline.
            .task(id: task.id) { if task.isLive { await model.loadRunDetail(task.id) } }
            .task(id: "\(task.id):\(tab.rawValue):\(task.hasPatchArtifact)") {
                if tab == .diff && task.hasPatchArtifact { await loadDiff(task.id) }
            }
            .sheet(isPresented: $showRunAgain) { runAgainSheet }
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
                             if task.isFinalizing { FinalizingPill() } else { StatusPill(status: task.status) }
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
                if task.isLive && task.status.isActive {
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
            SegmentedTabs(items: Tab.allCases.map { ($0, $0.label, $0.glyph) },
                          selection: Binding(get: { tab }, set: { newValue in
                              userSelectedTab = true
                              tab = newValue
                          }),
                          badge: { badge(for: $0, task: task) })
                .padding(.horizontal, Theme.Spacing.xxl)
                .padding(.vertical, Theme.Spacing.sm)
        }
    }

    private func badge(for t: Tab, task: TaskRun) -> Int? {
        switch t {
        case .answer: return task.answerText == nil ? nil : 1
        case .plan: return task.plan.isEmpty ? nil : task.plan.count
        case .candidates: return task.candidates.isEmpty ? nil : task.candidates.count
        case .diff: return task.diff.isEmpty ? nil : task.diff.count
        case .review: return task.findings.isEmpty ? nil : task.findings.count
        case .diagnostics: return task.engineError == nil && task.diagnosticText == nil ? nil : 1
        case .activity, .artifacts: return nil
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ task: TaskRun) -> some View {
        switch tab {
        case .answer:
            answerContent(task)
        case .plan:
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Plan", systemImage: "checklist",
                             accessory: AnyView(Text("\(task.planDone)/\(task.plan.count) done").font(.caption).foregroundStyle(.secondary)))
                Panel { PlanListView(items: task.plan) }
            }
        case .activity:
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Timeline", systemImage: "waveform", accessory: AnyView(verbosityMenu))
                // Live-first feed: the run's streaming box while live (only
                // this tab re-renders per batch), the folded task history after.
                Panel {
                    ActivityFeedView(events: model.activityFor(task),
                                     droppedOlder: model.liveBox(task.id)?.activityDropped ?? 0,
                                     verbosity: verbosity)
                }
            }
        case .candidates:
            candidatesContent(task)
        case .diff:
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
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
                if task.diff.isEmpty, task.hasPatchArtifact {
                    if let diffLoadError {
                        Panel {
                            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                                Label(diffLoadError, systemImage: "exclamationmark.triangle.fill")
                                    .foregroundStyle(Theme.status(.blocked))
                                    .textSelection(.enabled)
                                Text("Full patch: final/patch.diff")
                                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                                Button("Retry") { Task { await loadDiff(task.id) } }
                                    .buttonStyle(.bordered).controlSize(.small)
                            }
                        }
                    } else if diffLoading {
                        ProgressView("Loading diff…").controlSize(.small)
                    }
                } else if task.hasPatchArtifact {
                    DiffView(files: task.diff)
                } else {
                    EmptyStateView(
                        title: "No diff",
                        message: "This run did not produce a patch.",
                        systemImage: "plusminus.circle")
                }
            }
        case .review:
            reviewContent(task)
        case .artifacts:
            ArtifactGalleryView(runId: task.id)
        case .diagnostics:
            diagnosticsContent(task)
        }
    }

    private func loadDiff(_ runId: String) async {
        diffLoading = true
        diffLoadError = nil
        switch await model.loadRunDiff(runId) {
        case .loaded, .unavailable:
            break
        case .failed(let message):
            diffLoadError = message
        }
        diffLoading = false
    }

    private func answerContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(task.mode == .ask ? "Answer" : "Outcome", systemImage: "text.bubble")
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
                            .foregroundStyle(receipt.applied ? Theme.status(.succeeded) : Theme.status(.failed))
                        Text("Target \(String(receipt.targetPreimageSha.prefix(12))) · verifier \(receipt.finalVerify.attempted ? "ran" : "not run") · gates \(receipt.finalVerify.gatesPassed == true ? "passed" : "not passed")")
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                        Button {
                            tab = .diff
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
            SectionLabel("Candidates", systemImage: "flag.checkered.2.crossed")
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
                (task.status == .blocked || task.status == .needsReview
                    || task.applyState == "applied_review_blocked")
                && task.operatorDecisionAction == nil
            if decidable {
                DecisionBar(runId: task.id) {
                    await model.loadRunDetail(task.id)
                }
            } else if let action = task.operatorDecisionAction {
                Label("Operator decision recorded: \(action)", systemImage: "checkmark.seal")
                    .font(.caption).foregroundStyle(.secondary)
            } else if task.status == .ungated {
                Text("No blocking findings — apply this run from its chat card.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !task.findings.isEmpty {
                ForEach(task.findings) { FindingCard(finding: $0) }
            }
        }
    }

    private func diagnosticsContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Diagnostics summary", systemImage: "stethoscope")
            HStack(spacing: Theme.Spacing.sm) {
                Button {
                    copyDiagnostics(task)
                } label: {
                    Label("Copy Summary", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .help("Copy the bounded diagnostics summary and run metadata.")
                Button {
                    if let runDir = task.runDir { NSWorkspace.shared.open(URL(fileURLWithPath: runDir)) }
                } label: {
                    Label("Open Run Folder", systemImage: "folder")
                }
                .buttonStyle(.bordered)
                .disabled(task.runDir == nil)
                .help(task.runDir ?? "Run folder is not available yet.")
                Button {
                    NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claudexor/v2/daemon/claudexord.log"))
                } label: {
                    Label("Open Daemon Log", systemImage: "terminal")
                }
                .buttonStyle(.bordered)
                .help("Open ~/.claudexor/v2/daemon/claudexord.log.")
                Button {
                    retrying = true
                    Task {
                        actionError = await model.retryRunExact(task.id)
                        retrying = false
                    }
                } label: { Label(retrying ? "Retrying…" : "Retry Exact", systemImage: "arrow.clockwise") }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(retrying)
                .help("Create a new attempt from the immutable original request and run a fresh preflight.")
                Button {
                    Task {
                        guard let draft = await model.loadRunAgainDraft(task.id) else {
                            actionError = "Could not load the editable run draft."
                            return
                        }
                        runAgainDraft = draft
                        runAgainPrompt = draft.request["prompt"]?.stringValue ?? task.prompt
                        showRunAgain = true
                    }
                } label: { Label("Run Again…", systemImage: "square.and.pencil") }
                .buttonStyle(.bordered)
                .help("Open a new editable draft; this is not an exact retry.")
            }
            if let actionError {
                Text(actionError).font(.caption).foregroundStyle(Theme.status(.failed)).textSelection(.enabled)
            }
            if let error = task.engineError, !error.isEmpty {
                Panel(padding: Theme.Spacing.md) {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(Theme.status(.failed))
                        .textSelection(.enabled)
                }
            }
            Panel {
                Text(task.diagnosticText ?? "Diagnostics are not loaded yet. Refresh this run or reconnect the engine.")
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !task.artifactPaths.isEmpty {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        SectionLabel("Artifacts", systemImage: "folder")
                        ForEach(task.artifactPaths, id: \.self) { path in
                            Text(path)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        }
    }

    private var runAgainSheet: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Run Again").font(.title2.bold())
            Text("This creates a new editable run. Exact Retry is the immutable replay action.")
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: $runAgainPrompt)
                .font(.body)
                .frame(minHeight: 180)
                .padding(Theme.Spacing.sm)
                .background(Theme.surfaceRaisedHi, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            if let draft = runAgainDraft, !draft.differences.isEmpty {
                ForEach(Array(draft.differences.enumerated()), id: \.offset) { _, difference in
                    Text("\(difference.field): \(difference.change) — \(difference.reason)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { showRunAgain = false }
                Button(runningAgain ? "Starting…" : "Start New Run") {
                    guard let draft = runAgainDraft else { return }
                    runningAgain = true
                    Task {
                        actionError = await model.startRunAgain(draft, prompt: runAgainPrompt)
                        runningAgain = false
                        if actionError == nil { showRunAgain = false }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(runningAgain || runAgainPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(Theme.Spacing.xl)
        .frame(width: 560)
    }

    private func copyDiagnostics(_ task: TaskRun) {
        var text = [
            "run: \(task.id)",
            "mode: \(task.mode.apiValue)",
            "status: \(task.status.label)",
            "project: \(task.project)",
        ].joined(separator: "\n")
        if let runDir = task.runDir { text += "\nrunDir: \(runDir)" }
        if let engineError = task.engineError { text += "\n\n# Engine Error\n\(engineError)" }
        if let diagnostics = task.diagnosticText { text += "\n\n# Diagnostics\n\(diagnostics)" }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
