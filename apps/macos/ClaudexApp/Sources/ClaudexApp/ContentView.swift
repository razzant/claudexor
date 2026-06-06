import SwiftUI
import ClaudexKit

/// Codex-style shell: sidebar (Projects -> Specs -> Runs) -> content (mission-control
/// dashboard) -> inspector. NavigationSplitView gives the floating Liquid Glass sidebar
/// for free on macOS 26.
struct ContentView: View {
    @State private var selectedRun: RunRef?
    @State private var inspectorPresented = true

    var body: some View {
        NavigationSplitView {
            SidebarView(selectedRun: $selectedRun)
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 340)
        } detail: {
            DashboardView(run: selectedRun)
                .inspector(isPresented: $inspectorPresented) {
                    RunInspectorView(run: selectedRun)
                        .inspectorColumnWidth(min: 260, ideal: 300, max: 380)
                }
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            inspectorPresented.toggle()
                        } label: {
                            Label("Inspector", systemImage: "sidebar.trailing")
                        }
                    }
                }
        }
    }
}

struct SidebarView: View {
    @Binding var selectedRun: RunRef?

    var body: some View {
        List(selection: $selectedRun) {
            Section("Portfolio") {
                Label("All runs", systemImage: "square.grid.2x2")
                Label("Needs review", systemImage: "checkmark.seal")
            }
            ForEach(SampleData.projects) { project in
                Section(project.name) {
                    ForEach(project.specs) { spec in
                        DisclosureGroup {
                            ForEach(spec.runs) { run in
                                NavigationLink(value: run) {
                                    Label {
                                        Text(run.title).lineLimit(1)
                                    } icon: {
                                        Image(systemName: "circle.fill")
                                            .foregroundStyle(Theme.status(run.state))
                                            .font(.system(size: 7))
                                    }
                                }
                            }
                        } label: {
                            Label(spec.title, systemImage: spec.frozen ? "doc.text.fill" : "doc.text")
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }
}

struct DashboardView: View {
    let run: RunRef?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                header
                PhasePipelineView(activePhase: .review)
                candidates
            }
            .padding(Theme.Spacing.xl)
        }
        .navigationTitle(run?.title ?? "Mission Control")
        .background(Theme.surfaceBase)
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: "bolt.horizontal.circle.fill")
                .font(.title)
                .foregroundStyle(Theme.accent)
            VStack(alignment: .leading) {
                Text(run?.title ?? "Select a run")
                    .font(.title2).bold()
                Text(run.map { "Run \($0.id)" } ?? "Pick a run from the sidebar")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            BudgetMeterView(spend: 0.0374, cap: 0.50)
        }
    }

    private var candidates: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Candidates").font(.headline)
            HStack(spacing: Theme.Spacing.md) {
                ForEach(SampleData.candidates) { candidate in
                    CandidateChip(candidate: candidate)
                }
            }
        }
    }
}

struct PhasePipelineView: View {
    let activePhase: RunPhase

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Pipeline").font(.headline)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.sm) {
                    ForEach(RunPhase.allCases) { phase in
                        let done = phase.rawValue < activePhase.rawValue
                        HStack(spacing: Theme.Spacing.xs) {
                            Image(systemName: phase == activePhase ? "circle.dotted" : (done ? "checkmark.circle.fill" : "circle"))
                                .foregroundStyle(phase == activePhase ? Theme.status("running") : (done ? Theme.status("success") : Color.secondary))
                            Text(phase.label).font(.caption)
                        }
                        .padding(.horizontal, Theme.Spacing.sm)
                        .padding(.vertical, Theme.Spacing.xs)
                        .claudexGlass(Capsule())
                    }
                }
            }
        }
    }
}

struct CandidateChip: View {
    let candidate: CandidateVM

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.xs) {
                Circle().fill(Theme.harness(candidate.harnessId)).frame(width: 9, height: 9)
                Text(candidate.harnessId).font(.subheadline).bold()
                Spacer()
                Text(candidate.id).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "circle.fill").font(.system(size: 7)).foregroundStyle(Theme.status(candidate.state))
                Text(candidate.state).font(.caption)
            }
            Text(String(format: "$%.4f%@", candidate.costUsd, candidate.estimated ? " est" : ""))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(candidate.estimated ? Color.orange : .secondary)
        }
        .padding(Theme.Spacing.md)
        .frame(width: 150, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                .stroke(Theme.harness(candidate.harnessId).opacity(0.4), lineWidth: 1)
        )
    }
}

struct BudgetMeterView: View {
    let spend: Double
    let cap: Double

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(String(format: "$%.4f / $%.2f", spend, cap))
                .font(.system(.caption, design: .monospaced))
            ProgressView(value: min(spend / cap, 1.0))
                .frame(width: 120)
                .tint(Theme.accent)
        }
    }
}

struct RunInspectorView: View {
    let run: RunRef?

    var body: some View {
        Form {
            Section("Run") {
                LabeledContent("Id", value: run?.id ?? "—")
                LabeledContent("State", value: run?.state ?? "—")
            }
            Section("Honesty") {
                LabeledContent("Route proof", value: "verified")
                LabeledContent("Spend", value: "$0.0374 (1 est)")
                LabeledContent("Gates", value: "2/2 passed")
            }
            Section("Apply policy") {
                Text("ask").foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}
