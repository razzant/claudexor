import SwiftUI
import ClaudexorKit

// MARK: - Thread workspace · Evidence tab (D42)
//
// Per-run diagnostics/receipts across the thread. Reuses RunEvidenceView (the
// demoted Run Detail Evidence content) per run: a single selected receipt renders
// its evidence directly; the whole-thread view lists each run in a disclosure
// section (collapsed → the heavy artifact/diagnostics content is lazy).

struct WorkspaceEvidenceView: View {
    let runIds: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if runIds.count == 1, let runId = runIds.first {
                RunEvidenceSection(runId: runId, expandedByDefault: true)
            } else {
                ForEach(runIds, id: \.self) { runId in
                    RunEvidenceSection(runId: runId, expandedByDefault: false)
                }
            }
        }
    }
}

/// One run's evidence, either inline (single filtered run) or in a lazy
/// disclosure (whole-thread list). Loads the run's detail when it first opens so
/// the diagnostics blob is present (RunEvidenceView reads `diagnosticText`).
struct RunEvidenceSection: View {
    @Environment(AppModel.self) private var model
    let runId: String
    let expandedByDefault: Bool
    @State private var expanded = false
    @State private var loaded = false

    private var run: TaskRun? { model.task(runId) }

    var body: some View {
        if expandedByDefault {
            content
                .task(id: runId) { await loadDetailOnce() }
        } else {
            DisclosureGroup(isExpanded: $expanded) {
                if expanded { content }
            } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "stethoscope").foregroundStyle(.secondary)
                    Text("Run \(String(runId.suffix(6)))").font(.callout.weight(.medium))
                    if let phase = run?.phase {
                        Circle().fill(phase.color).frame(width: 7, height: 7)
                        Text(phase.label).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
            }
            .task(id: expanded) { if expanded { await loadDetailOnce() } }
        }
    }

    @ViewBuilder private var content: some View {
        if let run {
            RunEvidenceView(task: run)
        } else {
            Text("This run is no longer available.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func loadDetailOnce() async {
        guard !loaded, model.task(runId) != nil else { return }
        loaded = true
        await model.loadRunDetail(runId)
    }
}
