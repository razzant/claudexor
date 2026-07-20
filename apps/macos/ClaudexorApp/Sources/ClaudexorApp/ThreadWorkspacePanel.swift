import SwiftUI
import ClaudexorKit

// MARK: - Thread workspace panel (D42)
//
// The right panel's IDENTITY is the CURRENT THREAD's workspace, not a per-run
// inspector. Three tabs — Changes / Artifacts / Evidence — aggregate across the
// whole thread's runs. Selecting a chat receipt FILTERS the panel to that run (a
// "run: <id> ×" chip clears back to whole-thread) and renders that run's Outcome
// facts at the top. Run detail is DEMOTED, not deleted: it is the run-filtered
// state of this panel. A run's live Activity lives INLINE in its chat receipt.

struct ThreadWorkspacePanel: View {
    @Environment(AppModel.self) private var model
    @State private var tab: WorkspaceTab = .changes
    @State private var userSelectedTab = false
    @State private var showPreview = false

    private var detail: ThreadDetailResponse? { model.selectedThreadDetail }

    /// The thread's runs in conversation order, de-duplicated (a run appears once
    /// even if referenced by more than one turn).
    static func threadRunIds(_ detail: ThreadDetailResponse) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for turn in detail.turns {
            if let runId = turn.runId, seen.insert(runId).inserted { ordered.append(runId) }
        }
        return ordered
    }

    private var runIds: [String] { detail.map(Self.threadRunIds) ?? [] }

    /// The receipt filter: the run the panel is scoped/highlighted to, or nil for
    /// the whole-thread view. Reuses the existing `.task(id)` route (openRun) so
    /// no new app state is invented — a run from ANOTHER thread reads as no filter.
    private var filterRunId: String? {
        if case .task(let id) = model.route, runIds.contains(id) { return id }
        return nil
    }

    private var filteredRun: TaskRun? { filterRunId.flatMap { model.task($0) } }

    private func tabInputs() -> WorkspaceTabInputs {
        let failedNoOutput: Bool = filteredRun.map { run in
            run.phase.isFailureShaped && run.answerText == nil && !run.hasPatchArtifact
        } ?? false
        return WorkspaceTabInputs(runSelected: filterRunId != nil, selectedRunFailedNoOutput: failedNoOutput)
    }

    private func autoSelectDefaultTab() {
        tab = WorkspaceTabPolicy.resolve(current: tab, userSelected: userSelectedTab, inputs: tabInputs())
    }

    var body: some View {
        if let detail {
            VStack(alignment: .leading, spacing: 0) {
                header(detail)
                tabBar
                Divider().overlay(Theme.separator)
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        if let run = filteredRun {
                            RunOutcomeSection(task: run)
                        }
                        content(detail)
                    }
                    .padding(Theme.Spacing.xxl)
                    // Reading-surface width cap (Layout.contentMaxWidth) so a wide
                    // inspector never stretches diffs/prose edge-to-edge.
                    .frame(maxWidth: Theme.Layout.contentMaxWidth, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Root-level text selection for the workspace panel (item c).
                    .textSelection(.enabled)
                }
                .scrollContentBackground(.hidden)
            }
            // Filtering to a fresh receipt loads that run's detail (eligibility,
            // review, diagnostics) — the run-filtered view IS the demoted detail.
            .task(id: filterRunId ?? "") {
                if let id = filterRunId, model.task(id)?.isLive == true { await model.loadRunDetail(id) }
            }
            .onChange(of: filterRunId) { _, _ in userSelectedTab = false; autoSelectDefaultTab() }
            .onChange(of: filteredRun?.phase) { _, _ in autoSelectDefaultTab() }
            .onAppear { autoSelectDefaultTab() }
        } else {
            EmptyStateView(
                title: "No thread open",
                message: "Open a thread to see its changes, artifacts, and evidence.",
                systemImage: "sidebar.trailing")
        }
    }

    // MARK: Header (title + filter chip)

    private func header(_ detail: ThreadDetailResponse) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Thread workspace — \(detail.thread.title ?? "Untitled thread")")
                .font(.headline)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let id = filterRunId {
                // The receipt filter chip: shows the scoped run and clears back to
                // the whole thread (× → the `.threads` route).
                HStack(spacing: Theme.Spacing.xs) {
                    Button {
                        model.route = .threads
                    } label: {
                        HStack(spacing: Theme.Spacing.xxs) {
                            Image(systemName: "line.3.horizontal.decrease.circle").imageScale(.small)
                            Text("run: \(String(id.suffix(6)))").font(.caption.weight(.medium))
                            Image(systemName: "xmark").imageScale(.small)
                        }
                        .padding(.horizontal, Theme.Spacing.sm)
                        .padding(.vertical, Theme.Controls.chipVPadding)
                        .background(Theme.accent.opacity(0.14), in: Capsule())
                        .foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                    .help("Filtered to this run — clear to see the whole thread's workspace")
                    Spacer()
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.xxl)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
    }

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            SegmentedTabs(items: WorkspaceTab.allCases.map { ($0, $0.label, $0.glyph) },
                          selection: Binding(get: { tab }, set: { newValue in
                              userSelectedTab = true
                              tab = newValue
                          }),
                          badge: { _ in nil })
                .padding(.horizontal, Theme.Spacing.xxl)
                .padding(.vertical, Theme.Spacing.sm)
        }
    }

    @ViewBuilder
    private func content(_ detail: ThreadDetailResponse) -> some View {
        // A trivial thread (no runs at all) has nothing to show — be honest.
        if runIds.isEmpty {
            EmptyStateView(
                title: "No project output in this thread",
                message: "This thread hasn't produced changes, artifacts, or evidence yet.",
                systemImage: "tray")
        } else {
            // Scope: the selected receipt narrows every tab to that one run.
            let scope = filterRunId.map { [$0] } ?? runIds
            switch tab {
            case .changes:
                WorkspaceChangesView(
                    threadId: detail.thread.id,
                    isolated: detail.thread.workspaceMode == "isolated",
                    runIds: scope,
                    filtered: filterRunId != nil)
            case .artifacts:
                artifactsTab(detail, scope: scope)
            case .evidence:
                WorkspaceEvidenceView(runIds: scope)
            }
        }
    }

    /// Artifacts gallery + the "Open preview" affordance (D42): BrowserView is no
    /// longer a competing Canvas mode — it opens on demand for the thread project's
    /// index.html (rendered-output / localhost preview).
    @ViewBuilder
    private func artifactsTab(_ detail: ThreadDetailResponse, scope: [String]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if let root = detail.thread.repoRoot,
               FileManager.default.fileExists(atPath: (root as NSString).appendingPathComponent("index.html")) {
                HStack {
                    Button { showPreview = true } label: {
                        Label("Open preview", systemImage: "safari")
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .help("Open the project's index.html in a preview browser")
                    Spacer()
                }
                .sheet(isPresented: $showPreview) { PreviewSheet(repoRoot: root) }
            }
            ArtifactGalleryView(runIds: scope, produced: true)
                .frame(minHeight: 200)
        }
    }
}
