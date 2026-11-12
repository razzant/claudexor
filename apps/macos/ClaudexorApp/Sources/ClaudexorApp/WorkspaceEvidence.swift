import SwiftUI
import ClaudexorKit

// MARK: - Thread workspace · Evidence tab (D42)
//
// Per-run diagnostics/receipts across the thread. Reuses RunEvidenceView (the
// demoted Run Detail Evidence content) per run: a single selected receipt renders
// its evidence directly; the whole-thread view lists each run in a disclosure
// section (collapsed → the heavy artifact/diagnostics content is lazy).

struct WorkspaceEvidenceView: View {
    let locationID: ExecutionLocationID
    let runIds: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if runIds.count == 1, let runId = runIds.first {
                RunEvidenceSection(
                    locationID: locationID,
                    runId: runId,
                    expandedByDefault: true)
            } else {
                ForEach(runIds, id: \.self) { runId in
                    RunEvidenceSection(
                        locationID: locationID,
                        runId: runId,
                        expandedByDefault: false)
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
    let locationID: ExecutionLocationID
    let runId: String
    let expandedByDefault: Bool
    @State private var expanded = false
    @State private var loadedRunKey: RunDetailLoadKey?

    private var run: TaskRun? { model.task(runId, at: locationID) }

    var body: some View {
        if expandedByDefault {
            content
                .task(id: "\(locationID.rawValue)|\(runId)") {
                    await loadDetailOnce()
                }
        } else {
            DisclosureRow(
                accessibilityName: "Run \(String(runId.suffix(6))) evidence",
                isExpanded: $expanded
            ) {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "stethoscope").foregroundStyle(.secondary)
                    Text("Run \(String(runId.suffix(6)))").font(.callout.weight(.medium))
                    if let run {
                        Circle().fill(Theme.statusFill(run.terminalTone)).frame(width: 7, height: 7)
                        Text(run.terminalWord).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            } content: {
                content
            }
            .task(id: expanded) { if expanded { await loadDetailOnce() } }
        }
    }

    @ViewBuilder private var content: some View {
        if let run {
            RunEvidenceView(locationID: locationID, task: run)
        } else {
            Text("This run is no longer available.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func loadDetailOnce() async {
        let loadKey = RunDetailLoadKey(locationID: locationID, runId: runId)
        if locationID != .local {
            guard loadedRunKey != loadKey,
                  model.task(runId, at: locationID) != nil
            else { return }
            loadedRunKey = await model.loadRunDetail(runId, locationID: locationID)
                ? loadKey : nil
            return
        }
        guard Self.needsDetailLoad(
            loadKey: loadKey,
            loadedRunKey: loadedRunKey,
            hydrated: model.hydratedRunDetails.contains(runId)
        ) else { return }
        await model.ensureRunDetail(
            runId, insertingIfMissing: model.task(runId) == nil)
        // A list-summary row is not proof that detail loaded. Commit only the
        // hydration owner's success bit so a failed GET remains retryable.
        loadedRunKey = model.hydratedRunDetails.contains(runId) ? loadKey : nil
    }

    nonisolated static func needsDetailLoad(
        loadKey: RunDetailLoadKey,
        loadedRunKey: RunDetailLoadKey?,
        hydrated: Bool
    ) -> Bool {
        loadedRunKey != loadKey || !hydrated
    }
}
