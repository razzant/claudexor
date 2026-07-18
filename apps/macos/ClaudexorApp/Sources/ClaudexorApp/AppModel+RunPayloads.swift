import Foundation

extension AppModel {
    /// Diff is a heavy tab-only payload (INV-136); never fetch/parse it during
    /// thread hydration or milestone refreshes.
    func loadRunDiff(_ runId: String) async {
        guard let client,
              let task = liveTasks.first(where: { $0.id == runId }),
              task.diff.isEmpty,
              task.artifactPaths.contains("final/patch.diff")
        else { return }
        guard let patch = try? await client.artifactText(
            runId: runId, path: "final/patch.diff"),
            !patch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        guard let index = liveTasks.firstIndex(where: { $0.id == runId }),
              liveTasks[index].diff.isEmpty
        else { return }
        liveTasks[index].diff = Self.parseUnifiedDiff(patch)
    }
}
