import ClaudexorKit

extension AppModel {
    static func interactionResolutionActivityTitle(type: String, reason: String?) -> String {
        if type == "interaction.answered" { return "Answer delivered" }
        if type == "interaction.withdrawn" { return "Question withdrawn by the agent — no answer needed" }
        if reason == "cancelled" { return "Question closed — run cancelled" }
        return "Question timed out — continuing with assumptions"
    }

    func resolveHistoryInteraction(runID: String, interactionID: String, at location: ExecutionLocationID) {
        guard let history = selectedHistory, history.locationID == location else { return }
        history.resolvedInteractions[runID, default: []].insert(interactionID)
        history.interactionRequestSequences[runID]?[interactionID] = nil
        history.presentation.resolveInteraction(runID: runID, interactionID: interactionID)
    }

    func recordHistoryInteractionRequest(runID: String, interactionID: String, seq: Int, at location: ExecutionLocationID) {
        guard let history = selectedHistory, history.locationID == location else { return }
        history.resolvedInteractions[runID]?.remove(interactionID)
        history.interactionRequestSequences[runID, default: [:]][interactionID] = seq
    }

    /// Snapshot lastSeq owns questions through that sequence. Only a newer
    /// request may override its pending list; an acknowledged answer still wins
    /// over a delayed snapshot. Covered resolutions clean presentation state
    /// without replaying covered spend/timeline events from the snapshot fence.
    func reconcileHistoryInteractions(_ task: inout TaskRun, lastSeq: Int, at location: ExecutionLocationID) {
        let current = self.task(task.id, at: location)
        let history = selectedHistory?.locationID == location ? selectedHistory : nil
        let requests = history?.interactionRequestSequences[task.id] ?? [:]
        if location == .local {
            for event in deferredEnvelopes[task.id] ?? [] where event.seq > 0 && event.seq <= lastSeq {
                let type = event.event["type"]?.stringValue ?? event.kind
                let payload = event.event["payload"] ?? event.event
                if ["interaction.answered", "interaction.withdrawn", "interaction.timeout"].contains(type),
                   let id = payload["interaction_id"]?.stringValue, (requests[id] ?? 0) <= lastSeq {
                    resolveHistoryInteraction(runID: task.id, interactionID: id, at: location)
                }
            }
        }
        let resolved = history?.resolvedInteractions[task.id] ?? []
        let previous = current?.pendingInteractions ?? []
        let candidates = previous + task.pendingInteractions
        let newer = previous.filter { (requests[$0.interactionId] ?? 0) > lastSeq }
        var seen = Set<String>()
        task.pendingInteractions = (newer + task.pendingInteractions).filter {
            !resolved.contains($0.interactionId) && seen.insert($0.interactionId).inserted
        }
        if task.phase.isTerminal { task.pendingInteractions = [] }
        let pending = Set(task.pendingInteractions.map(\.interactionId))
        for question in candidates where !pending.contains(question.interactionId) {
            resolveHistoryInteraction(runID: task.id, interactionID: question.interactionId, at: location)
        }
        if !task.pendingInteractions.isEmpty { task.waitingOnUser = true }
        else if !resolved.isEmpty || task.phase.isTerminal { task.waitingOnUser = false }
        task.attentionNote = current?.attentionNote ?? task.attentionNote
    }

    /// Remote card-visible events must not wait behind a throttled detail read.
    func applyRemoteHistoryCardEvent(_ event: BusEnvelope, runID: String, at location: ExecutionLocationID) {
        // The engine's preparation receipt (#563) reaches the remote turn card
        // through the same bounded reducer, keyed by location and run id.
        if location != .local, (event.event["type"]?.stringValue ?? event.kind) == "workspace.prepared" {
            remoteTranscripts[RunDetailLoadKey(locationID: location, runId: runID), default: TranscriptReducer()]
                .apply(event)
            return
        }
        guard var task = task(runID, at: location) else { return }
        let type = event.event["type"]?.stringValue ?? event.kind
        let payload = event.event["payload"] ?? event.event
        if type == "interaction.requested", let question = Self.pendingInteraction(from: payload, runId: runID) {
            recordHistoryInteractionRequest(runID: runID, interactionID: question.interactionId, seq: event.seq, at: location)
            task.pendingInteractions.removeAll { $0.interactionId == question.interactionId }
            task.pendingInteractions.append(question)
            task.waitingOnUser = true
        } else if ["interaction.answered", "interaction.timeout", "interaction.withdrawn"].contains(type),
                  let id = payload["interaction_id"]?.stringValue {
            resolveHistoryInteraction(runID: runID, interactionID: id, at: location)
            task.pendingInteractions.removeAll { $0.interactionId == id }
            task.waitingOnUser = !task.pendingInteractions.isEmpty
        } else if type == "route.profile.rotated" {
            let harness = payload["harness_id"]?.stringValue ?? ""
            let account = payload["to_profile_id"]?.stringValue ?? "default account"
            task.attentionNote = "Switched to account \(account)\(harness.isEmpty ? "" : " (\(harness))") — quota limit"
        } else if type == "route.profile.rotation_exhausted" {
            let harness = payload["harness_id"]?.stringValue ?? ""
            task.attentionNote = "No eligible account has quota headroom\(harness.isEmpty ? "" : " (\(harness))")"
        } else { return }
        mutateTask(runID, at: location) { $0 = task }
        publishHistoryLive(task, locationID: location)
    }
}
