import ClaudexorKit

extension AppModel {
    /// Only a mounted parent whose page names missing children authorizes a
    /// cold read. At most one parent snapshot per mounted residence; ordinary
    /// receipt/apply facts already ride on the page and never cause a read.
    func loadHistoryDelegates(_ history: ThreadHistoryStore) async {
        if let task = history.delegateTask { await task.value; return }
        let request = Task { @MainActor in
            while self.selectedHistory === history, let row = history.rows.first(where: { row in
                guard let parent = row.runId, !history.delegateReads.contains(parent) else { return false }
                return row.run?.delegatedChildRunIds.prefix(8).contains {
                    self.task($0, at: history.locationID) == nil
                } == true
            }), let parent = row.runId {
                history.delegateReads.insert(parent)
                if history.locationID == .local {
                    if let load = self.runDetailLoads[parent] { await load.value }
                    else { await self.loadRunDetail(parent, insertingIfMissing: true) }
                } else {
                    await self.loadRunDetail(parent, locationID: history.locationID)
                }
            }
        }
        history.delegateTask = request
        await request.value
        history.delegateTask = nil
    }

    /// A fresh addressed receipt is selectable before the legacy roster catches
    /// up. Membership still comes from this thread's page, never the global list.
    var workspaceRunIDs: [String] {
        var parents = selectedThreadDetail.map(ThreadWorkspacePanel.threadRunIds) ?? []
        if let history = selectedHistory {
            parents += history.rows.compactMap(\.runId)
            parents += [history.header?.headRun?.runId, history.header?.latestAdmission?.runId].compactMap { $0 }
        }
        let locatedTasks = selectedExecutionLocation == .local ? tasks : remoteTasks[selectedExecutionLocation] ?? []
        return ThreadWorkspacePanel.workspaceRunIds(parentRunIds: parents, tasks: locatedTasks)
    }

    func invalidateWorkspaceHistory() {
        guard workspaceHistoryVisible else { return }
        Task { await loadWorkspaceHistory() }
    }
}
