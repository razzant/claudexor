import ClaudexorKit
import Foundation

// MARK: - Run decisions, interaction answers, and operator-facing failures

extension AppModel {
    /// Human-readable message for a gateway error (never a raw Swift dump in the UI).
    /// For HTTP failures it surfaces the SERVER's own error body (fail-loud — a bare
    /// "HTTP 400" hid the real reason during the v0.10 polish).
    func userMessage(for error: Error) -> String {
        switch error {
        case let gateway as GatewayError where gateway.controlProblem != nil:
            guard case GatewayError.http(let status, _) = gateway,
                  let problem = gateway.controlProblem else { return "Request failed." }
            let action = problem.requiredActions.first.map { " Required action: \($0)." } ?? ""
            return "Request failed (HTTP \(status), \(problem.code)): \(problem.message)\(action)"
        case GatewayError.http(let status, let body):
            if status == 501 { return "This engine build does not support threads. Update Claudexor." }
            if status == 404 { return "The engine is out of date — restart the daemon." }
            if let detail = serverErrorMessage(from: body) { return "Request failed (HTTP \(status)): \(detail)" }
            return "Request failed (HTTP \(status))."
        case is URLError:
            return "Cannot reach the engine — is the daemon running?"
        default:
            return "Something went wrong. Try again."
        }
    }

    /// Pull the engine's reason out of a failed HTTP body. Transport/gate errors use
    /// `{ "error": "..." }`; a refused decision (e.g. the 409 revert-refusal path)
    /// instead carries `ControlRunDecisionResponse.message` — so honor BOTH, else a
    /// rejection's concrete reason (the divergence message) is swallowed.
    private func serverErrorMessage(from body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let error = obj["error"] as? String, !error.isEmpty { return error }
        if let message = obj["message"] as? String, !message.isEmpty { return message }
        return nil
    }

    /// The revert guard's refusal carries raw (locale-translated) git stderr —
    /// honest but unreadable. Map the known divergence refusal to plain
    /// language; anything else passes through untouched (never invent).
    static func humanRevertRefusal(_ message: String?) -> String? {
        guard let message, message.contains("postimage no longer matches") else { return nil }
        return "The files changed after this turn (a later run or a manual edit) — "
            + "revert is no longer available. Restore via git if you need the old state."
    }

    /// Typed operator decision on a blocked run (review queue actions).
    func decide(runId: String, action: String, feedback: String? = nil, acceptedRisks: [String]? = nil) async -> String? {
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else { return "Engine offline." }
        do {
            let res = try await requestClient.decide(
                runId: runId,
                body: RunDecisionRequest(
                    action: action, feedback: feedback,
                    acceptedRisks: acceptedRisks ?? []))
            if locationID == .local {
                await refreshRuns()
            } else if let threadId = selectedThreadId {
                await refreshRemoteThreads(locationID)
                await openThread(locationID: locationID, id: threadId)
            }
            return res.accepted ? nil : (res.message ?? "Decision was not accepted (\(res.status)).")
        } catch {
            return "Decision failed: \(error)"
        }
    }

    /// Apply PRE-FLIGHT: dry-run the apply gate BEFORE the user presses Apply, so the
    /// UI shows WHY apply would be refused (the gate reason) up front instead of only
    /// on press. Returns nil when apply would proceed cleanly, or the server's honest
    /// refusal reason (the gate error body, or the patch's non-applying stderr).
    func applyCheck(runId: String) async -> String? {
        guard let requestClient = gateway(for: selectedExecutionLocation) else {
            return "Engine offline."
        }
        do {
            let res = try await requestClient.applyCheck(runId: runId)
            return res.ok ? nil : (res.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "The patch would not apply cleanly."
                : res.stderr)
        } catch {
            // The gate refusal (e.g. blocked/needs-human, secret-like token) comes
            // back as an HTTP error whose body carries the real reason — surface it.
            return userMessage(for: error)
        }
    }

    /// Outcome of a revert attempt. `.diverged` is the PERMANENT refusal (the
    /// working tree changed since the turn) the server signals with HTTP 409 —
    /// the caller retires the Revert affordance. `.error` is any other failure
    /// (offline / transport / a non-accepted decision) where the button stays.
    enum RevertOutcome: Equatable {
        case reverted
        case diverged(String)
        case error(String)
    }

    func revertRun(
        runId: String,
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) async -> RevertOutcome {
        let locationID = requestedLocationID ?? selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            return .error("Engine offline.")
        }
        do {
            let res = try await requestClient.revertRun(runId: runId)
            guard res.accepted else {
                return .error(res.message ?? "Revert was refused (\(res.status)).")
            }
            if locationID == .local {
                await refreshRuns()
                await loadRunDetail(runId)
            } else {
                await refreshRemoteThreads(locationID)
            }
            if let tid = selectedThreadId {
                await openThread(locationID: locationID, id: tid)
            }
            return .reverted
        } catch GatewayError.http(let status, let body) where status == 409 {
            // 409 == the divergence guard refused (postimage no longer matches):
            // a structural, permanent signal — retrying would 409 forever.
            return .diverged(Self.humanRevertRefusal(body)
                ?? serverErrorMessage(from: body)
                ?? "Revert is no longer available — the files changed after this turn.")
        } catch {
            return .error(userMessage(for: error))
        }
    }

    /// Deliver the user's answers for a pending interactive question. Returns
    /// an error message on failure (the question card surfaces it verbatim).
    func answerInteraction(runId: String, interactionId: String, answers: [InteractionAnswerPayload]) async -> String? {
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            return "Engine offline: reconnect before answering."
        }
        do {
            let response = try await requestClient.answerInteraction(
                runId: runId, interactionId: interactionId, answers: answers)
            guard response.accepted else { return Self.answerRefusalMessage(response) }
            resolveHistoryInteraction(runID: runId, interactionID: interactionId, at: locationID)
            mutateTask(runId, at: locationID) {
                $0.pendingInteractions.removeAll { $0.interactionId == interactionId }
                $0.waitingOnUser = !$0.pendingInteractions.isEmpty
                $0.updatedAt = .now
            }
            if let task = task(runId, at: locationID) { publishHistoryLive(task, locationID: locationID) }
            if locationID != .local, let threadId = selectedThreadId {
                await refreshOpenThread(locationID: locationID, id: threadId)
            }
            return nil
        } catch {
            return answerFailureMessage(error)
        }
    }

    /// Why an answer did not land, in plain words. The engine refuses with a
    /// `ControlProblem` on HTTP 404/409 that carries its typed answer status
    /// (`GatewayError.interactionAnswerRefusal`): nothing was sent, and the
    /// question's own events or the next snapshot settle its card. Without a
    /// readable reply delivery is unconfirmed, never a success; nothing is resent.
    func answerFailureMessage(_ error: Error) -> String {
        if let url = error as? URLError, [.cannotConnectToHost, .cannotFindHost].contains(url.code) {
            return "Cannot reach the engine, so your answer was not sent."
        }
        guard let gateway = error as? GatewayError, case .http(let status, let body) = gateway else {
            return "Delivery is unconfirmed: the engine's reply was missing or unreadable. Check the run before answering again."
        }
        if let refusal = gateway.interactionAnswerRefusal {
            return Self.answerRefusalMessage(refusal)
        }
        let detail = serverErrorMessage(from: body).map { ": \($0)" } ?? "."
        return "The engine did not accept this answer (HTTP \(status))\(detail)"
    }

    /// The engine's typed refusal. `rejected` keeps the engine's own reason (which
    /// answers are missing or invalid); the question stays open then.
    static func answerRefusalMessage(_ refusal: InteractionAnswerResponse) -> String {
        switch refusal.status {
        case "already_resolved": "This question is already closed, so your answer was not sent."
        case "not_found": "This question is no longer open, so your answer was not sent."
        default: refusal.message ?? "The engine did not accept this answer (\(refusal.status))."
        }
    }

    func storeSecret(name: String, value: String, for family: HarnessFamily) async -> (stored: Bool, readinessRefreshed: Bool) {
        let locationID = activeExecutionLocation
        guard let requestClient = gateway(for: locationID) else { return (false, false) }
        do {
            try await requestClient.setSecret(name: name, value: value)
            noteAccountResourceBindingWrite(AccountTarget(harness: family.setupHarnessId, profileId: nil), at: locationID)
            await refreshSecrets(locationID: locationID)
            // API-key resource rows are bound to the stored key: a replaced key reads as unread.
            scheduleAccountsQuotaDisplayHydration(at: locationID)
            guard let request = family.apiKeyAuthReadinessRequest else { return (true, false) }
            let refreshed = await refreshAuthReadiness(for: family, request: request)
            // The harness CARD renders daemon-NORMALIZED rows, which only a
            // fresh harness-list refresh rebuilds — the same location-bound
            // aggregate refresh Recheck runs (#132 R1: without it a stored key
            // left the card frozen on "Unavailable" until a manual refresh).
            _ = await refreshHarnesses(
                fresh: true, locationID: locationID, markStaleOnFailure: true)
            return (true, refreshed)
        } catch {
            return (false, false)
        }
    }
}
