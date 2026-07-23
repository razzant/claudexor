import Foundation

enum RunDiffLoadOutcome {
    case loaded
    /// No patch path exists for this run (non-patch result / never produced one).
    case unavailable
    /// A SUCCESSFUL load that produced no changes — a terminal no-change outcome
    /// or a fetched zero-byte canonical patch. Distinct from `.failed`: Retry can
    /// never make an immutable empty terminal artifact non-empty (QA-008).
    case empty
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
        // Row-missing or already-hydrated is an honest `.loaded` — but do NOT fold
        // the OFFLINE case in here (round-3 #9): the client==nil branch below stays
        // separate so an offline terminal run with a patch artifact renders an honest
        // failure+Retry, not an empty Changes tab masquerading as loaded.
        guard let task = liveTasks.first(where: { $0.id == runId }), task.diff.isEmpty
        else { return .loaded }
        // QA-008: honor the terminal server truth. A no-change outcome is a
        // legitimate EMPTY, never a fetch/parse failure — its canonical zero-byte
        // final/patch.diff is valid run evidence, not a promise of content. Short-
        // circuit before any GET so a dead Retry is never offered.
        if task.outcomeFacts?.noChanges == true { return .empty }
        guard task.hasPatchArtifact else { return .unavailable }
        // A patch exists but is not hydrated AND the engine is offline: the honest
        // outcome is a named failure with Retry, not `.loaded` over an empty diff
        // (round-3 #9). Row-missing / hydrated / no-patch already returned above.
        guard let client else {
            return .failed("final/patch.diff: Engine offline — reconnect to load this diff.")
        }
        let patch: String
        do {
            patch = try await client.artifactText(runId: runId, path: "final/patch.diff")
        } catch {
            return .failed("final/patch.diff: \(userMessage(for: error))")
        }
        // A successfully fetched EMPTY patch is an honest no-change result, not a
        // failure: the engine intentionally writes an empty winner diff for an
        // answer-with-no-changes, and no repeated GET can make it non-empty
        // (QA-008). The no-change fact above already covers the typed case; a
        // zero-byte body with no non-empty claim is benign empty.
        guard !patch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .empty
        }
        guard let index = liveTasks.firstIndex(where: { $0.id == runId }),
              liveTasks[index].diff.isEmpty
        else { return .loaded }
        liveTasks[index].diff = Self.parseUnifiedDiff(patch)
        return liveTasks[index].diff.isEmpty
            ? .failed("final/patch.diff is not a renderable text diff. Open the run folder for the full artifact.")
            : .loaded
    }
}
