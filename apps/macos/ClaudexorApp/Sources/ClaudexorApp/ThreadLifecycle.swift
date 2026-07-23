import Foundation
import ClaudexorKit

/// Thread lifecycle actions (rename / archive / reopen) — server-owned via
/// the one PATCH /threads/:id endpoint; the app never invents thread state.
extension AppModel {
    func openThread(_ id: String) async {
        guard let client else { return }
        threadLoadGeneration += 1
        let generation = threadLoadGeneration
        selectedThreadId = id
        selectedThreadDetail = nil
        threadStatus = nil
        do {
            let detail = try await client.threadDetail(id: id)
            guard selectedThreadId == id, threadLoadGeneration == generation else { return }
            selectedThreadDetail = detail
            guard selectedThreadId == id, threadLoadGeneration == generation else { return }
            evictBackgroundRunData()
            for turn in detail.turns.suffix(5) {
                guard selectedThreadId == id, threadLoadGeneration == generation else { return }
                if let runId = turn.runId, liveTasks.contains(where: { $0.id == runId }) {
                    await loadRunDetail(runId)
                }
            }
        } catch {
            guard selectedThreadId == id, threadLoadGeneration == generation else { return }
            threadStatus = "Could not load thread: \(userMessage(for: error))"
        }
    }

    func startDraftThread() {
        threadLoadGeneration += 1
        selectedThreadId = nil
        selectedThreadDetail = nil
        threadStatus = nil
        if case .task = route { route = .threads }
        draftPrimaryHarness = nil
        draftEligiblePool = []
        draftCredentialProfileId = nil
        draftIsolatedWorkspace = false
        // QA-007: the sticky write scope must NOT leak from an earlier draft into
        // a fresh one. nil => the new target repo's own trust default is the
        // baseline; a stale Full is never carried into an unrelated project draft.
        draftThreadAccess = nil
    }

    /// Composer project chip — "No project (Ask only)" (QA-006). Returns the draft
    /// to no-project scope so a general read-only Ask is reachable again after any
    /// project has been used. A bound thread is immutable: start a NEW draft first,
    /// then clear its project (never mutate the bound thread). The empty choice
    /// persists (projectRoot didSet) so relaunch does not silently restore the
    /// former project; the MRU is preserved — "no project" is a scope choice, not
    /// an MRU deletion.
    func clearProject() {
        if selectedThreadId != nil { startDraftThread() }
        projectRoot = ""
    }

    /// Apply a run's reviewed patch through the server-owned delivery gate.
    func applyRun(runId: String, mode: String = "apply") async -> String? {
        guard let client else { return "Engine offline." }
        do {
            let result = try await client.apply(runId: runId, body: ApplyRunRequest(mode: mode))
            if let index = liveTasks.firstIndex(where: { $0.id == runId }) {
                liveTasks[index].deliveryReceipt = result
            }
            guard result.applied else { return result.detail ?? "Apply was refused." }
            await loadRunDetail(runId)
            route = .task(runId)
            return nil
        } catch { return "Apply failed: \(error)" }
    }

    func retryRunExact(_ runId: String) async -> String? {
        guard let client else { return "Engine offline." }
        do {
            let retry = try await client.retryRun(runId: runId)
            await refreshRuns()
            if let id = retry.runId {
                route = .task(id)
                stream(runId: id)
            }
            if let threadId = selectedThreadId { await openThread(threadId) }
            return nil
        } catch { return "Retry failed: \(userMessage(for: error))" }
    }

    func loadRunAgainDraft(_ runId: String) async -> RunAgainDraft? {
        guard let client else { return nil }
        return try? await client.runAgainDraft(runId: runId)
    }

    func startRunAgain(_ draft: RunAgainDraft, prompt: String) async -> String? {
        guard let client else { return "Engine offline." }
        do {
            let result = try await client.startRunAgain(request: draft.request, prompt: prompt)
            await refreshRuns()
            if case .started(let info) = result {
                route = .task(info.runId)
                stream(runId: info.runId)
            }
            return nil
        } catch { return "Run Again failed: \(userMessage(for: error))" }
    }

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
