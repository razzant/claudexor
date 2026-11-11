import AppKit
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
    /// The run-filtered facts are a COMPACT COLLAPSIBLE header (not a static
    /// upper floor): collapsed by default so the per-tab content is visible
    /// without scrolling; expanding reveals the full run Outcome section.
    @State private var runFactsExpanded = false

    private var detail: ThreadDetailResponse? { model.selectedThreadDetail }

    /// Project identity is not an execution address for caller-owned workspaces.
    static func executionRoot(for thread: ThreadSummary) -> String? {
        let root = thread.workspaceMode == "delegated" ? thread.workspaceRoot : thread.repoRoot
        return root.flatMap { $0.isEmpty ? nil : $0 }
    }

    enum PreviewAvailability: Equatable {
        case available(root: String)
        case missingWorkspace
        case absent
    }

    static func localPreview(for thread: ThreadSummary) -> PreviewAvailability {
        guard let root = executionRoot(for: thread) else {
            return thread.workspaceMode == "delegated" ? .missingWorkspace : .absent
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            return thread.workspaceMode == "delegated" ? .missingWorkspace : .absent
        }
        return FileManager.default.fileExists(
            atPath: (root as NSString).appendingPathComponent("index.html"))
            ? .available(root: root) : .absent
    }

    private var missingWorkspace: some View {
        EmptyStateView(
            title: "Workspace unavailable",
            message: "This thread's caller-owned workspace is missing or unavailable.",
            systemImage: "folder.badge.questionmark")
    }

    /// The thread's runs in conversation order, de-duplicated (a run appears once
    /// even if referenced by more than one turn).
    static func threadRunIds(_ detail: ThreadDetailResponse) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for turn in detail.turns {
            guard let runId = turn.runId else { continue }
            if seen.insert(runId).inserted { ordered.append(runId) }
            for childRunId in (turn.run?.delegatedChildRunIds ?? []).prefix(8)
                where seen.insert(childRunId).inserted {
                ordered.append(childRunId)
            }
        }
        return ordered
    }

    /// Add real Claudexor Delegate children immediately after their parent.
    /// The result stays a FLAT list; depth is engine-capped at one and the UI
    /// does not create a second run-tree model.
    static func workspaceRunIds(parentRunIds: [String], tasks: [TaskRun]) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        let projectedIds = Set(parentRunIds)
        for parentRunId in parentRunIds {
            if seen.insert(parentRunId).inserted { ordered.append(parentRunId) }
            // Current runtimes already project bounded child ids in canonical
            // server order. Task discovery is only the legacy fallback for a
            // child absent from that projection; it must never reorder c1/c2
            // according to the unrelated global runs page.
            for child in tasks
                where !projectedIds.contains(child.id)
                    && DelegationPresentation.isChild(child, of: parentRunId) {
                if seen.insert(child.id).inserted { ordered.append(child.id) }
            }
        }
        return ordered
    }

    private var runIds: [String] {
        model.workspaceRunIDs
    }

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
        panel
            .task(id: model.selectedLocatedThreadID) {
                model.workspaceHistoryVisible = true
                await model.loadWorkspaceHistory()
            }
            .onDisappear {
                model.workspaceHistoryVisible = false
                model.selectedThreadDetail = nil
            }
    }

    @ViewBuilder private var panel: some View {
        if let detail {
            // WHOLE-PANEL tabs (round-3 item 2): the tab bar sits at the very top
            // (directly under the panel title) and EVERYTHING below it switches
            // per tab. The run-filtered facts are no longer a static upper floor
            // above the tabs — they are a compact collapsible strip inside the
            // scrolling content, so switching a tab changes the whole panel.
            VStack(alignment: .leading, spacing: 0) {
                title(detail)
                tabBar
                Divider().overlay(Theme.separator)
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        if let run = filteredRun {
                            runFilterHeader(run)
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
            .task(id: "\(model.selectedExecutionLocation.rawValue)|\(filterRunId ?? "")") {
                let locationID = model.selectedExecutionLocation
                if let id = filterRunId {
                    if locationID == .local {
                        await model.ensureRunDetail(id, insertingIfMissing: model.task(id, at: locationID) == nil)
                    } else {
                        await model.loadRunDetail(id, locationID: locationID)
                    }
                }
            }
            .onChange(of: filterRunId) { _, _ in userSelectedTab = false; autoSelectDefaultTab() }
            .onChange(of: filteredRun?.phase) { _, _ in autoSelectDefaultTab() }
            .onChange(of: model.selectedLocatedThreadID) { _, _ in
                userSelectedTab = false
                tab = WorkspaceTabPolicy.validated(
                    current: tab,
                    available: availableTabs)
                autoSelectDefaultTab()
            }
            .onAppear { autoSelectDefaultTab() }
        } else if model.selectedThreadId != nil {
            VStack {
                Text(model.workspaceHistoryError ?? "Loading workspace…")
                if model.workspaceHistoryError != nil {
                    Button("Retry loading workspace") { Task { await model.loadWorkspaceHistory() } }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            EmptyStateView(
                title: "No thread open",
                message: "Open a thread to see its changes, artifacts, and evidence.",
                systemImage: "sidebar.trailing")
        }
    }

    // MARK: Panel title (the tab bar sits directly below it)

    private func title(_ detail: ThreadDetailResponse) -> some View {
        Text("Thread workspace — \(detail.thread.title ?? "Untitled thread")")
            .font(.headline)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Spacing.xxl)
            .padding(.top, Theme.Spacing.sm)
            .padding(.bottom, Theme.Spacing.xs)
    }

    // MARK: Run-filtered facts — compact COLLAPSIBLE strip (not a static floor)

    /// The compact strip shown INSIDE the content area when a receipt filters the
    /// panel to one run: the filter chip + a disclosure toggle. Collapsed by
    /// default (the per-tab content stays visible without scrolling); expanding
    /// reveals the full run Outcome facts. Keeps the filter chip (round-3 item 2).
    private func runFilterHeader(_ run: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                filterChip(RunInspectCommand.diagnosticRunID(
                    stableID: run.id, resolvedRunID: run.resolvedRunId))
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { runFactsExpanded.toggle() }
                } label: {
                    HStack(spacing: Theme.Spacing.xxs) {
                        Text(runFactsExpanded ? "Hide run details" : "Run details")
                        Image(systemName: runFactsExpanded ? "chevron.up" : "chevron.down")
                            .imageScale(.small)
                    }
                    .font(.caption)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Show or hide this run's Outcome, answer, plan, candidates, and review")
            }
            if runFactsExpanded {
                RunOutcomeSection(task: run, locationID: model.selectedExecutionLocation)
            }
        }
    }

    /// The receipt filter chip: shows the scoped run and clears back to the whole
    /// thread (× → the `.threads` route). Chip text never wraps (round-3 item 4).
    private func filterChip(_ id: String) -> some View {
        Button {
            model.route = .threads
        } label: {
            HStack(spacing: Theme.Spacing.xxs) {
                Image(systemName: "line.3.horizontal.decrease.circle").imageScale(.small)
                Text("run: \(String(id.suffix(6)))").font(.caption.weight(.medium))
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                Image(systemName: "xmark").imageScale(.small)
            }
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, Theme.Controls.chipVPadding)
            .background(Theme.accent.opacity(0.14), in: Capsule())
            .foregroundStyle(Theme.accent)
        }
        .buttonStyle(.plain)
        .fixedSize()
        // QA-003: the chip's action is to CLEAR the run filter — name it so, so
        // the trailing `xmark` glyph doesn't become the AX name.
        .accessibilityLabel("Clear run filter")
        .help("Filtered to full run id \(id) — clear to see the whole thread's workspace")
        .contextMenu {
            Button("Copy Full Run ID") { copyRunReference(id) }
            if let command = RunInspectCommand.command(
                runID: id, locationID: model.selectedExecutionLocation) {
                Button("Copy Inspect Command") { copyRunReference(command) }
            }
        }
    }

    private func copyRunReference(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            SegmentedTabs(items: availableTabs.map { ($0, $0.label, $0.glyph) },
                          selection: Binding(get: { tab }, set: { newValue in
                              userSelectedTab = true
                              tab = newValue
                          }),
                          badge: { _ in nil })
                .padding(.horizontal, Theme.Spacing.xxl)
                .padding(.vertical, Theme.Spacing.sm)
        }
    }

    private var availableTabs: [WorkspaceTab] {
        model.selectedExecutionLocation == .local
            ? [.changes, .artifacts, .evidence]
            : [.changes, .artifacts, .evidence, .terminal]
    }

    @ViewBuilder
    private func content(_ detail: ThreadDetailResponse) -> some View {
        if tab == .terminal, model.selectedExecutionLocation != .local {
            if let root = Self.executionRoot(for: detail.thread) {
                RemoteThreadTerminalView(repoRoot: root)
            } else if detail.thread.workspaceMode == "delegated" {
                missingWorkspace
            } else {
                EmptyStateView(
                    title: "No project selected",
                    message: "This thread has no project directory for Terminal.",
                    systemImage: "terminal")
            }
        // A trivial thread (no runs at all) has nothing to show — be honest.
        } else if runIds.isEmpty {
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
                    locationID: model.selectedExecutionLocation,
                    threadId: detail.thread.id,
                    isolated: detail.thread.workspaceMode == "isolated",
                    runIds: scope,
                    filtered: filterRunId != nil)
            case .artifacts:
                artifactsTab(detail, scope: scope)
            case .evidence:
                WorkspaceEvidenceView(
                    locationID: model.selectedExecutionLocation,
                    runIds: scope)
            case .terminal:
                EmptyView()
            }
        }
    }

    /// Artifacts gallery + the "Open preview" affordance (D42): BrowserView is no
    /// longer a competing Canvas mode — it opens on demand for the thread project's
    /// index.html (rendered-output / localhost preview).
    @ViewBuilder
    private func artifactsTab(_ detail: ThreadDetailResponse, scope: [String]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if model.selectedExecutionLocation == .local {
                switch Self.localPreview(for: detail.thread) {
                case .available(let root):
                    HStack {
                        Button { showPreview = true } label: {
                            Label("Open preview", systemImage: "safari")
                        }
                        .buttonStyle(.bordered).controlSize(.small)
                        .help("Open the workspace's index.html in a preview browser")
                        Spacer()
                    }
                    .sheet(isPresented: $showPreview) { PreviewSheet(repoRoot: root) }
                case .missingWorkspace:
                    missingWorkspace
                case .absent:
                    EmptyView()
                }
            }
            if model.selectedExecutionLocation != .local {
                Text(
                    "Remote static files are not copied to this Mac. Start a dev server in Terminal, then open its port from the Terminal tab.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ArtifactGalleryView(
                locationID: model.selectedExecutionLocation,
                runIds: scope,
                produced: true,
                executionRoot: Self.executionRoot(for: detail.thread))
                .frame(minHeight: 200)
        }
    }
}
