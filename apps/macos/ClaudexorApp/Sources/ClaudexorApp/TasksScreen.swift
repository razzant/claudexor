import SwiftUI

struct TasksScreen: View {
    @Environment(AppModel.self) private var model
    @State private var filter: TaskFilter = .all
    private var query: String { model.searchQuery }

    enum TaskFilter: String, CaseIterable, Identifiable {
        case all, active, needsYou, done
        var id: String { rawValue }
        var label: String {
            switch self {
            case .all: return "All"
            case .active: return "Active"
            case .needsYou: return "Needs you"
            case .done: return "Done"
            }
        }
        var glyph: String {
            switch self {
            case .all: return "tray.full"
            case .active: return "dot.radiowaves.up.forward"
            case .needsYou: return "bell.badge"
            case .done: return "checkmark.circle"
            }
        }
    }

    var body: some View {
        ListScreen(title: "Tasks") {
            filterBar
        } content: {
            if filtered.isEmpty {
                EmptyStateView(title: "No tasks here", message: "Start a run with ⌘N, or change the filter.", systemImage: "checklist", actionTitle: "New Task") { model.composerPresented = true }
            } else {
                ScrollView {
                    // Floating row-cards: same recipe as Home (one design language).
                    VStack(spacing: Theme.Spacing.sm) {
                        ForEach(filtered) { task in
                            Button { model.route = .task(task.id) } label: {
                                TaskRowView(task: task).padding(.horizontal, Theme.Spacing.md)
                            }
                            .buttonStyle(.plain)
                            .cardSurface(hover: true)
                        }
                    }
                    .padding(Theme.Spacing.xxl)
                    .frame(maxWidth: Theme.Layout.contentMaxWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .scrollContentBackground(.hidden)
            }
        }
    }

    private var filterBar: some View {
        FilterBar {
            ForEach(TaskFilter.allCases) { f in
                FilterChip(label: f.label, systemImage: f.glyph, count: count(f), isActive: f == filter) {
                    withAnimation(.snappy) { filter = f }
                }
            }
        }
    }

    private func count(_ f: TaskFilter) -> Int { tasks(for: f).count }

    private func tasks(for f: TaskFilter) -> [TaskRun] {
        switch f {
        case .all: return model.tasks
        case .active: return model.tasks.filter { $0.status.isActive }
        // Same definition as Home's attentionTasks: a running run parked on an
        // interactive question needs the user even though its status is active.
        case .needsYou: return model.tasks.filter { $0.status.needsAttention || $0.waitingOnUser }
        // "Done" = every terminal outcome (incl. failed/interrupted/no-op): runs
        // must never vanish from all filters.
        case .done: return model.tasks.filter { !$0.status.isActive }
        }
    }

    private var filtered: [TaskRun] {
        let base = tasks(for: filter)
        guard !query.isEmpty else { return base }
        return base.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.project.localizedCaseInsensitiveContains(query) }
    }
}
