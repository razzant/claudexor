import Foundation
import ClaudexorKit

// View hydration and event-milestone refresh share one per-run request owner.
// Stored state remains on AppModel because Observation does not permit stored
// extension properties.
extension AppModel {
    /// View-only hydration: one successful snapshot per run until reconnect.
    /// Unlike milestone `loadRunDetail`, overlapping callers do not request a
    /// trailing second snapshot.
    func ensureRunDetail(_ id: String, insertingIfMissing: Bool = false) async {
        if hydratedRunDetails.contains(id) { return }
        if let inFlight = runDetailLoads[id] {
            await inFlight.value
            return
        }
        await loadRunDetail(id, insertingIfMissing: insertingIfMissing)
    }

    /// Milestone refreshes coalesce concurrent triggers into one lead plus at
    /// most one trailing snapshot. A UUID token prevents an old connection's
    /// completion from clearing a new same-run request after reconnect.
    func loadRunDetail(_ id: String, insertingIfMissing: Bool = false) async {
        if let inFlight = runDetailLoads[id] {
            if runDetailAcceptingTrailing.contains(id) { runDetailTrailing.insert(id) }
            await inFlight.value
            return
        }
        runDetailAcceptingTrailing.insert(id)
        let loadToken = UUID()
        let load = Task { @MainActor [weak self] in
            guard let self else { return }
            self.runDetailTrailing.remove(id)
            await self.performRunDetailLoad(
                id, insertingIfMissing: insertingIfMissing,
                loadToken: loadToken)
            guard self.runDetailLoadTokens[id] == loadToken else { return }
            self.runDetailAcceptingTrailing.remove(id)
            if self.runDetailTrailing.remove(id) != nil {
                await self.performRunDetailLoad(
                    id, insertingIfMissing: insertingIfMissing,
                    loadToken: loadToken)
            }
            if self.runDetailLoadTokens[id] == loadToken {
                self.runDetailLoads[id] = nil
                self.runDetailLoadTokens[id] = nil
            }
        }
        runDetailLoadTokens[id] = loadToken
        runDetailLoads[id] = load
        await load.value
    }

    func selectedThreadAuthorizesColdRun(_ runId: String) -> Bool {
        if workspaceHistoryVisible, selectedThreadDetail?.thread.id == selectedThreadId,
           selectedThreadDetail?.turns.contains(where: {
               $0.runId == runId || ($0.run?.delegatedChildRunIds ?? []).contains(runId)
           }) == true { return true }
        guard selectedHistory?.threadID == selectedThreadId else { return false }
        return selectedHistory?.rows.contains {
            $0.runId == runId || ($0.run?.delegatedChildRunIds ?? []).contains(runId)
        } == true
    }

    func firstArtifactText(client: GatewayClient, runId: String, paths: [String]) async -> String? {
        for path in paths {
            if let text = try? await client.artifactText(runId: runId, path: path),
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let limit = 256_000
                return text.utf8.count > limit
                    ? Self.boundedUTF8Prefix(text, maxBytes: limit)
                        + "\n\n_Inline preview bounded; open \(path) for the full artifact._"
                    : text
            }
        }
        return nil
    }

    /// One local/remote answer projection. New runs consume the server-selected
    /// bounded primary output; legacy runs share the same bounded artifact fallback.
    func answerText(
        for detail: RunDetail,
        client: GatewayClient,
        runId: String
    ) async -> String? {
        if let primary = detail.primaryOutput,
           let text = primary.text,
           !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            guard primary.kind != "patch",
                  primary.kind != "diagnostic",
                  detail.summary.outputReadyState != "diagnostic" || primary.kind == "report"
            else { return nil }
            if detail.summary.outputReadyState == "diagnostic" { return text }
            return primary.truncated == true
                ? text + "\n\n_Inline preview bounded; open \(primary.path) for the full output._"
                : text
        }
        guard detail.summary.outputReadyState != "diagnostic" else { return nil }
        return await firstArtifactText(
            client: client,
            runId: runId,
            paths: ["final/answer.md", "final/explore.md", "final/report.md", "final/plan.md"])
    }

    /// Keep a valid String prefix within an exact UTF-8 byte ceiling. Cutting
    /// through a multibyte scalar backs up to its start instead of inserting a
    /// replacement character that could exceed the byte bound.
    nonisolated static func boundedUTF8Prefix(_ text: String, maxBytes: Int) -> String {
        guard maxBytes > 0 else { return "" }
        guard text.utf8.count > maxBytes else { return text }
        var data = Data(text.utf8.prefix(maxBytes))
        while !data.isEmpty {
            if let prefix = String(data: data, encoding: .utf8) { return prefix }
            data.removeLast()
        }
        return ""
    }
}
