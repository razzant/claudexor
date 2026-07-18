import Foundation

enum RunDiffLoadOutcome {
    case loaded
    case unavailable
    case failed(String)
}

extension TaskRun {
    var hasPatchArtifact: Bool {
        !diff.isEmpty || artifactPaths.contains("final/patch.diff")
    }
}

extension AppModel {
    /// Diff is a heavy tab-only payload (INV-136); never fetch/parse it during
    /// thread hydration or milestone refreshes.
    func loadRunDiff(_ runId: String) async -> RunDiffLoadOutcome {
        guard let client,
              let task = liveTasks.first(where: { $0.id == runId }),
              task.diff.isEmpty
        else { return .loaded }
        guard task.hasPatchArtifact else { return .unavailable }
        let patch: String
        do {
            patch = try await client.artifactText(runId: runId, path: "final/patch.diff")
        } catch {
            return .failed(userMessage(for: error))
        }
        guard !patch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .failed("The patch artifact is empty.")
        }
        guard let index = liveTasks.firstIndex(where: { $0.id == runId }),
              liveTasks[index].diff.isEmpty
        else { return .loaded }
        liveTasks[index].diff = Self.parseUnifiedDiff(patch)
        return liveTasks[index].diff.isEmpty
            ? .failed("The patch is not a renderable text diff. Open the run folder for the full artifact.")
            : .loaded
    }
}
