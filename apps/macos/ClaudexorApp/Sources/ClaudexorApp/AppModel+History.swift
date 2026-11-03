import ClaudexorKit
import Foundation
import CryptoKit

extension AppModel {
    func makeHistoryStore(locationID: ExecutionLocationID, id: String) -> ThreadHistoryStore {
        let history = ThreadHistoryStore(locationID: locationID, threadID: id) { [weak self] selector, limit, store in
            guard let self, let client = self.gateway(for: locationID) else { throw URLError(.notConnectedToInternet) }
            let page = try await client.threadHistory(id: id, limit: limit, selector: selector, expectedStoreId: store)
            guard self.isCurrentGateway(client, at: locationID) else { throw CancellationError() }
            return page
        }
        var latestTurnID: String?
        history.didReadHeader = { [weak self, weak history] header in
            guard let self, let history, self.selectedHistory === history else { return }
            if latestTurnID != header.latestTurnId {
                latestTurnID = header.latestTurnId
                self.invalidateWorkspaceHistory()
            }
            self.followHistoryHead(header, at: locationID)
            Task { await self.loadHistoryDelegates(history) }
        }
        return history
    }

    func followHistoryHead(_ header: ThreadHistoryHeader, at locationID: ExecutionLocationID) {
        guard let head = header.headRun, RunPhase(api: head.run.state).isActive else { return }
        if task(head.runId, at: locationID) == nil {
            let seed = HistoryRunPresentation.head(head, thread: header.thread)
            if locationID == .local { liveTasks.append(seed) }
            else { remoteTasks[locationID, default: []].append(seed) }
        }
        if locationID == .local {
            if streamTasks[head.runId] == nil {
                stream(runId: head.runId)
            }
            if !hydratedRunDetails.contains(head.runId) {
                Task { await ensureRunDetail(head.runId) }
            }
        } else if remoteRunStreamTasks["\(locationID.rawValue)|\(head.runId)"] == nil {
            streamRemoteRun(locationID: locationID, runID: head.runId, threadID: header.thread.id)
            Task { await loadRunDetail(head.runId, locationID: locationID) }
        }
    }

    func publishHistoryLive(_ task: TaskRun, locationID: ExecutionLocationID) {
        guard selectedHistory?.locationID == locationID else { return }
        selectedHistory?.publishLive(task)
    }

    var selectedHeadRunId: String? {
        if let header = selectedHistory?.header {
            // An admitted but unbound latest turn has no cancel target.
            if let admission = header.latestAdmission { return admission.runId }
            return header.headRun?.runId
        }
        guard let selectedThreadId else { return nil }
        return threadSummary(selectedThreadId, at: selectedExecutionLocation)?.headRunId
    }

    var composerTurnState: ComposerTurnState {
        guard let header = selectedHistory?.header else { return .idle }
        if let admission = header.latestAdmission, admission.runId == nil {
            // The admission's command lifecycle has the bound run's meaning:
            // only queued/running holds the composer (#576).
            return resolveComposerTurnState(headRunId: nil, hydratedRowActive: nil,
                embeddedStateActive: admission.enqueueError == nil
                    && admission.state.map { RunPhase(api: $0).isActive } == true)
        }
        guard header.headRunStatus == "available", let head = header.headRun else { return .idle }
        let active = wasRunCancelled(head.runId, at: selectedExecutionLocation) ? false
            : task(head.runId, at: selectedExecutionLocation)?.phase.isActive
        return resolveComposerTurnState(headRunId: head.runId, hydratedRowActive: active,
            embeddedStateActive: RunPhase(api: head.run.state).isActive)
    }

    /// The full legacy aggregate belongs exclusively to the visible workspace.
    /// A feed replay never invalidates or reissues this request.
    func loadWorkspaceHistory() async {
        guard workspaceHistoryVisible, let id = selectedThreadId,
              let client = gateway(for: selectedExecutionLocation) else { return }
        let key = "\(selectedExecutionLocation.rawValue)|\(id)|\(ObjectIdentifier(client))"
        await workspaceHistoryLoader.load(key: key) { [weak self] in await self?.readWorkspaceHistory() }
    }

    private func readWorkspaceHistory() async {
        guard workspaceHistoryVisible, let id = selectedThreadId,
              let client = gateway(for: selectedExecutionLocation) else { return }
        let location = selectedExecutionLocation
        workspaceHistoryError = nil
        do {
            let detail = try await client.threadDetail(id: id)
            guard !Task.isCancelled, workspaceHistoryVisible, selectedThreadId == id,
                  selectedExecutionLocation == location, isCurrentGateway(client, at: location) else { return }
            selectedThreadDetail = detail
        } catch {
            guard !Task.isCancelled, workspaceHistoryVisible, selectedThreadId == id,
                  selectedExecutionLocation == location else { return }
            workspaceHistoryError = "Could not load workspace: \(error.localizedDescription)"
        }
    }

    /// Explicit prompt action only. Immutable part identity and byte progress
    /// are checked across every chunk; normal history reads never call this.
    func fullHistoryPrompt(turnID: String, locationID: ExecutionLocationID, threadID: String) async throws -> String {
        guard let client = gateway(for: locationID) else { throw URLError(.notConnectedToInternet) }
        let store = selectedHistory?.storeID
        var offset = 0
        var text = ""
        var identity: (hash: String, bytes: Int)?
        while true {
            let part = try await client.threadPromptPart(id: threadID, turnId: turnID,
                offset: offset, expectedStoreId: store)
            try Task.checkCancellation()
            guard isCurrentGateway(client, at: locationID),
                  identity == nil || (identity?.hash == part.sha256 && identity?.bytes == part.totalBytes),
                  part.nextOffset > offset || part.nextOffset == part.totalBytes else {
                throw GatewayError.decoding("The saved prompt changed while it was being read.")
            }
            identity = (part.sha256, part.totalBytes)
            text += part.text; offset = part.nextOffset
            if offset == part.totalBytes {
                let digest = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
                guard digest == part.sha256 else { throw GatewayError.decoding("Saved prompt checksum did not match.") }
                return text
            }
        }
    }
}
