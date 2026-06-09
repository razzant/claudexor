import AppKit
import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let taskId: String
    @State private var tab: Tab = .answer
    @State private var verbosity: Verbosity = .normal
    @State private var userSelectedTab = false

    enum Tab: String, CaseIterable, Identifiable {
        case answer, plan, activity, candidates, diff, review, diagnostics
        var id: String { rawValue }
        var label: String {
            switch self {
            case .answer: return "Outcome"
            case .plan: return "Plan"
            case .activity: return "Timeline"
            case .candidates: return "Candidates"
            case .diff: return "Diff"
            case .review: return "Review"
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
            case .diagnostics: return "stethoscope"
            }
        }
    }

    private var task: TaskRun? { model.task(taskId) }

    private func defaultTab(for task: TaskRun) -> Tab {
        if task.status.isActive {
            return .activity
        }
        if task.status == .failed || task.status == .unknown || task.status == .notConverged || task.status == .exhausted {
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
                    content(task)
                        .padding(Theme.Spacing.xxl)
                        .frame(maxWidth: Theme.Layout.contentMaxWidth, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollContentBackground(.hidden)
            }
            .glowBackdrop()
            .onAppear {
                tab = defaultTab(for: task)
                userSelectedTab = false
            }
            .onChange(of: task.status) { _, _ in autoSelectDefaultTab(for: task) }
            .onChange(of: task.engineError ?? "") { _, _ in autoSelectDefaultTab(for: task) }
            .onChange(of: task.answerText ?? "") { _, _ in autoSelectDefaultTab(for: task) }
            .task(id: task.id) { if task.isLive { await model.loadRunDetail(task.id) } }
        } else {
            EmptyStateView(title: "Run not found", message: "This run is no longer available.", systemImage: "questionmark.folder")
                .glowBackdrop()
        }
    }

    // MARK: Header

    private func header(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ScreenHeader(title: task.title,
                         subtitle: task.prompt.isEmpty ? nil : task.prompt,
                         subtitleLineLimit: 2,
                         accessory: AnyView(StatusPill(status: task.status)))

            FlowLayout(spacing: Theme.Spacing.md) {
                ProvenanceTag(isLive: task.isLive)
                Label(task.mode.label, systemImage: task.mode.glyph).font(.caption).foregroundStyle(.secondary)
                if let spec = task.specTitle {
                    Label(spec, systemImage: "doc.text.fill").font(.caption).foregroundStyle(Theme.accent)
                }
                RouteProofBadge(proof: task.routeProof)
                ForEach(task.harnesses) { HarnessChip(family: $0) }
                BudgetMini(spend: task.spendUsd, cap: task.capUsd, spendKnown: task.spendKnown, capKnown: task.capKnown, spendEstimated: task.spendEstimated)
                if task.isLive && task.status.isActive {
                    Button(role: .destructive) { Task { await model.cancel(task.id) } } label: {
                        Label("Cancel", systemImage: "stop.circle")
                    }
                    .buttonStyle(.bordered)
                    .help("Request cancel/interrupt for the active harness process.")
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
        case .activity: return nil
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
                Panel { ActivityFeedView(events: task.activity.reversed(), verbosity: verbosity) }
            }
        case .candidates:
            candidatesContent(task)
        case .diff:
            DiffView(files: task.diff)
        case .review:
            reviewContent(task)
        case .diagnostics:
            diagnosticsContent(task)
        }
    }

    private func answerContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(task.mode == .ask ? "Answer" : "Outcome", systemImage: "text.bubble")
            Panel {
                if let answer = task.answerText, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(answer)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("No answer artifact yet. Open Diagnostics for engine state, events, and artifact paths.")
                        .font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var verbosityMenu: some View {
        Menu {
            Picker("Verbosity", selection: $verbosity) {
                ForEach(Verbosity.allCases) { Text($0.label).tag($0) }
            }
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
                    NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claudexor/daemon/claudexord.log"))
                } label: {
                    Label("Open Daemon Log", systemImage: "terminal")
                }
                .buttonStyle(.bordered)
                .help("Open ~/.claudexor/daemon/claudexord.log.")
                Button {
                    Task {
                        await model.startRun(
                            prompt: task.prompt,
                            mode: task.mode,
                            harnesses: task.harnesses,
                            primary: task.harnesses.first,
                            portfolio: "subscription-first",
                            model: nil,
                            n: task.n,
                            capUsd: task.capKnown ? task.capUsd : nil,
                            access: task.mode.isReadOnly ? "readonly" : "workspace_write",
                            repoRootOverride: task.repoRoot
                        )
                    }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .help("Start a new run with the same prompt, mode, harness pool, and budget.")
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
