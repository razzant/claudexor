import Foundation
import ClaudexorKit

/// Thread lifecycle actions (rename / archive / reopen) — server-owned via
/// the one PATCH /threads/:id endpoint; the app never invents thread state.
extension AppModel {
    /// Rename a thread: server-owned title via the existing PATCH.
    func renameThread(_ id: String, title: String) async {
        guard let client else { threadStatus = "Engine offline — reconnect to rename."; return }
        do {
            let updated = try await client.updateThread(id: id, body: UpdateThreadRequest(title: title))
            applyThreadUpdate(updated)
            await refreshThreads()
        } catch { threadStatus = userMessage(for: error) }
    }

    /// Archive (close) a thread; it stays inspectable, out of the active list.
    func archiveThread(_ id: String) async {
        await setThreadState(id, state: "closed")
    }

    /// Reopen a previously archived thread. The server ThreadState enum is
    /// `active | closed` — "open" is NOT a member and 400s.
    func reopenThread(_ id: String) async {
        await setThreadState(id, state: "active")
    }

    private func setThreadState(_ id: String, state: String) async {
        guard let client else { threadStatus = "Engine offline — reconnect to change thread state."; return }
        do {
            let updated = try await client.updateThread(id: id, body: UpdateThreadRequest(state: state))
            applyThreadUpdate(updated)
            await refreshThreads()
        } catch { threadStatus = userMessage(for: error) }
    }
}
