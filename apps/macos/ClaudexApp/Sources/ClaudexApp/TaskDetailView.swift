import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let taskId: String
    @State private var tab: Tab = .plan
    @State private var verbosity: Verbosity = .normal

    enum Tab: String, CaseIterable, Identifiable {
        case plan, activity, candidates, diff, review
        var id: String { rawValue }
        var label: String {
            switch self {
            case .plan: return "Plan"
            case .activity: return "Activity"
            case .candidates: return "Candidates"
            case .diff: return "Diff"
            case .review: return "Review"
            }
        }
        var glyph: String {
            switch self {
            case .plan: return "checklist"
            case .activity: return "waveform"
            case .candidates: return "flag.checkered.2.crossed"
            case .diff: return "plusminus.circle"
            case .review: return "person.2.badge.gearshape"
            }
        }
    }

    private var task: TaskRun? { model.task(taskId) }

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
                BudgetMini(spend: task.spendUsd, cap: task.capUsd)
                if task.isLive && task.status.isActive {
                    Button(role: .destructive) { Task { await model.cancel(task.id) } } label: {
                        Label("Cancel", systemImage: "stop.circle")
                    }
                    .buttonStyle(.bordered)
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
                          selection: $tab,
                          badge: { badge(for: $0, task: task) })
                .padding(.horizontal, Theme.Spacing.xxl)
                .padding(.vertical, Theme.Spacing.sm)
        }
    }

    private func badge(for t: Tab, task: TaskRun) -> Int? {
        switch t {
        case .plan: return task.plan.isEmpty ? nil : task.plan.count
        case .candidates: return task.candidates.isEmpty ? nil : task.candidates.count
        case .diff: return task.diff.isEmpty ? nil : task.diff.count
        case .review: return task.findings.isEmpty ? nil : task.findings.count
        case .activity: return nil
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ task: TaskRun) -> some View {
        switch tab {
        case .plan:
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Plan", systemImage: "checklist",
                             accessory: AnyView(Text("\(task.planDone)/\(task.plan.count) done").font(.caption).foregroundStyle(.secondary)))
                Panel { PlanListView(items: task.plan) }
            }
        case .activity:
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Activity", systemImage: "waveform", accessory: AnyView(verbosityMenu))
                Panel { ActivityFeedView(events: task.activity.reversed(), verbosity: verbosity) }
            }
        case .candidates:
            candidatesContent(task)
        case .diff:
            DiffView(files: task.diff)
        case .review:
            reviewContent(task)
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
}
