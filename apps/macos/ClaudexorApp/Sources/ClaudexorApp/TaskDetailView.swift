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
    /// True while a Revert request is in flight; the server owns the outcome.
    @State private var reverting = false
    /// Honest revert refusal (e.g. the tree diverged since the turn). nil => none.
    @State private var revertError: String?

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
        if task.status == .failed || task.status == .unknown || task.status == .notConverged || task.status == .stuckNoProgress || task.status == .exhausted {
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

            FlowLayout(spacing: Theme.Spacing.md) {
                ProvenanceTag(isLive: task.isLive)
                Label(task.mode.label, systemImage: task.mode.glyph).font(.caption).foregroundStyle(.secondary)
                if let spec = task.specTitle {
                    Label(spec, systemImage: "doc.text.fill").font(.caption).foregroundStyle(Theme.accent)
                }
                RouteProofBadge(proof: task.routeProof)
                    .help(task.observedModel.map { "Observed model: \($0)" } ?? "No model identity was disclosed by the harness stream.")
                if task.waitingOnUser {
                    Label("Needs your answer", systemImage: "questionmark.bubble.fill")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.status(.needsReview))
                        .help("The harness asked a question; the run is waiting for you (it declines benignly on timeout).")
                }
                if let access = task.accessLabel {
                    Label(access, systemImage: "lock.shield")
                        .font(.caption).foregroundStyle(.secondary)
                        .help("Access profile the engine enforced (requested vs effective).")
                }
                // Honest apply-state: applied / applied · review blocked / reverted.
                // Never a green "Succeeded" next to a review-blocked apply.
                if let (text, glyph, tint) = Self.applyStateBadge(task.applyState) {
                    Label(text, systemImage: glyph)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(tint)
                        .help("Honest application state of this turn's in-place change.")
                }
                if let outputReady = task.outputReadyState, outputReady != "ready" {
                    // Honest output state; the "ready" case is the norm and stays quiet.
                    Label(Self.outputReadyLabel(outputReady), systemImage: outputReady == "diagnostic" ? "exclamationmark.triangle" : "clock")
                        .font(.caption)
                        .foregroundStyle(outputReady == "diagnostic" ? Theme.status(.failed) : .secondary)
                        .help("Output ready state from Control API.")
                }
                if let web = task.webEvidenceStatus, web != "none" {
                    Label(Self.webEvidenceLabel(web), systemImage: Self.webEvidenceGlyph(web))
                        .font(.caption)
                        .foregroundStyle(Self.webEvidenceColor(web))
                        .help(task.webEvidenceDetail ?? "Web evidence status.")
                }
                if let browser = task.browserRequirementDetail {
                    Label(browser, systemImage: "globe")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .help(browser)
                }
                ForEach(task.harnesses) { HarnessChip(family: $0) }
                // Live-first spend: the streaming box while the run is live
                // (per-run invalidation), the task snapshot once terminal.
                let spend = model.spendDisplay(task)
                BudgetMini(spend: spend.usd, cap: task.capUsd, spendKnown: spend.known, capKnown: task.capKnown, spendEstimated: spend.estimated)
                if task.isLive && task.status.isActive {
                    Button(role: .destructive) { Task { await model.cancel(task.id) } } label: {
                        Label("Cancel", systemImage: "stop.circle")
                    }
                    .buttonStyle(.bordered)
                    .help("Request cancel for the active harness process.")
                }
            }

            Panel(padding: Theme.Spacing.md) { PhasePipelineView(active: task.activePhase, status: task.status) }
        }
        .padding(.horizontal, Theme.Spacing.xxl)
        .padding(.top, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.md)
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
                                    let err = await model.revertRun(runId: task.id)
                                    reverting = false
                                    revertError = err
                                }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(reverting)
                            .help("Restore the project to this turn's pre-turn state (server refuses if you've edited since).")
                        }
                    }
                }
                DiffView(files: task.diff)
            }
        case .review:
            reviewContent(task)
        case .artifacts:
            ArtifactGalleryView(runId: task.id)
        case .diagnostics:
            diagnosticsContent(task)
        }
    }

    private func answerContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(task.mode == .ask ? "Answer" : "Outcome", systemImage: "text.bubble")
            Panel {
                if let answer = task.answerText, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownOutputView(markdown: answer)
                } else {
                    Text(task.outputReadyState == "finalizing" ? "Run is terminal; output is still finalizing. Open Diagnostics for events and artifact paths." : "No answer artifact yet. Open Diagnostics for engine state, events, and artifact paths.")
                        .font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    // MARK: Badge label/glyph mappers (no raw wire strings in the UI)

    static func outputReadyLabel(_ state: String) -> String {
        switch state {
        case "pending": return "Output pending"
        case "finalizing": return "Output finalizing"
        case "diagnostic": return "Diagnostic output"
        case "ready": return "Output ready"
        default: return state
        }
    }

    /// Honest apply-state badge mapping (shared shape across detail + chat surfaces).
    /// nil => not_applied/unknown: render nothing (envelope-only, plan/answer, no change).
    static func applyStateBadge(_ state: String) -> (String, String, Color)? {
        switch state {
        case "applied": return ("Applied", "checkmark.seal.fill", Theme.status(.succeeded))
        case "applied_review_blocked": return ("Applied · review blocked", "exclamationmark.triangle.fill", Theme.status(.blocked))
        case "reverted": return ("Reverted", "arrow.uturn.backward.circle", .secondary)
        default: return nil
        }
    }

    static func webEvidenceLabel(_ status: String) -> String {
        switch status {
        case "satisfied": return "Web verified"
        case "failed": return "Web failed"
        case "attempted": return "Web attempted"
        case "unverified": return "Web unverified"
        default: return status
        }
    }

    static func webEvidenceGlyph(_ status: String) -> String {
        switch status {
        case "satisfied": return "network"
        case "failed": return "exclamationmark.icloud"
        case "unverified": return "questionmark.diamond" // a policy gap, not a benign attempt
        default: return "icloud"
        }
    }

    static func webEvidenceColor(_ status: String) -> Color {
        switch status {
        case "satisfied": return Theme.status(.succeeded)
        case "failed": return Theme.status(.failed)
        case "unverified": return Theme.status(.blocked)
        default: return .secondary
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
                            Text("Arbitration: \(winner.family.label) (\(winner.id)) selected on evidence — gates \(winner.gatesPassed)/\(winner.gatesTotal), clean final review.")
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
            if task.findings.isEmpty {
                Panel { Label("No findings — final review clean.", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.status(.succeeded)) }
            } else {
                ForEach(task.findings) { FindingCard(finding: $0) }
            }
        }
    }

    private func diagnosticsContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Diagnostics", systemImage: "stethoscope")
            HStack(spacing: Theme.Spacing.sm) {
                Button {
                    copyDiagnostics(task)
                } label: {
                    Label("Copy Diagnostics", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .help("Copy the visible diagnostics text and run metadata.")
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
                    Task {
                        // Retry preserves the ORIGINAL run's policy contract
                        // (access + web); silently resetting to defaults would
                        // change privacy/safety semantics between attempts.
                        await model.startRun(
                            prompt: task.prompt,
                            mode: task.mode,
                            harnesses: task.harnesses,
                            primary: task.harnesses.first,
                            portfolio: model.defaultPortfolio,
                            model: nil,
                            n: task.n,
                            capUsd: task.capKnown ? task.capUsd : model.defaultMaxUsdPerRun,
                            access: task.requestedAccess ?? (task.mode.isReadOnly ? "readonly" : "workspace_write"),
                            web: task.externalContextPolicy ?? "auto",
                            tests: task.tests,
                            reviewerPanel: task.reviewerPanel,
                            protectedPathApprovals: task.protectedPathApprovals,
                            repoRootOverride: task.repoRoot
                        )
                    }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .help("Start a new run with the same prompt, mode, harness pool, budget, tests, reviewer panel, protected-path approvals, access, and web policy.")
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
