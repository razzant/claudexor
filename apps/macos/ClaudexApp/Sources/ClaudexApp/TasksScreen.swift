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
                    Panel(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(Array(filtered.enumerated()), id: \.element.id) { idx, task in
                                Button { model.route = .task(task.id) } label: {
                                    TaskRowView(task: task).padding(.horizontal, Theme.Spacing.md)
                                }
                                .buttonStyle(.plain)
                                if idx < filtered.count - 1 { Divider().overlay(Theme.hairline).padding(.leading, Theme.Metrics.rowDividerInset) }
                            }
                        }
                        .padding(.vertical, Theme.Spacing.xs)
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
        case .needsYou: return model.tasks.filter { $0.status.needsAttention }
        case .done: return model.tasks.filter { [.succeeded, .failed, .cancelled].contains($0.status) }
        }
    }

    private var filtered: [TaskRun] {
        let base = tasks(for: filter)
        guard !query.isEmpty else { return base }
        return base.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.project.localizedCaseInsensitiveContains(query) }
    }
}
