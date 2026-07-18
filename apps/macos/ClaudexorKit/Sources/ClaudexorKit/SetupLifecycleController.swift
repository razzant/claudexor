import Foundation

/// Narrow transport boundary used by the setup lifecycle state machine. The
/// production GatewayClient conforms below; tests provide an in-memory actor.
public protocol SetupJobGateway: Sendable {
    func createSetupJob(_ body: SetupJobCreateRequest) async throws -> SetupJob
    func listSetupJobs(filter: SetupJobListFilter) async throws -> [SetupJob]
    func setupJobSnapshot(jobId: String) async throws -> SetupJobSnapshot
    func cancelSetupJob(jobId: String) async throws -> SetupJob
    func reconcileSetupJob(jobId: String) async throws -> SetupJob
    func extendSetupJob(jobId: String) async throws -> SetupJob
    func setupJobEvents(jobId: String, lastEventId: String) -> AsyncThrowingStream<SetupJobEvent, Error>
}

extension GatewayClient: SetupJobGateway {}

public enum SetupLifecycleConnection: String, Sendable, Equatable {
    case idle
    case recovering
    case connected
    case reconnecting
    case streamLost
    case terminal
    case detached
}

public struct SetupLifecycleSnapshot: Sendable, Equatable {
    public let job: SetupJob?
    public let connection: SetupLifecycleConnection
    public let reconnectAttempt: Int
    public let lastError: String?

    public init(job: SetupJob? = nil, connection: SetupLifecycleConnection = .idle,
                reconnectAttempt: Int = 0, lastError: String? = nil) {
        self.job = job
        self.connection = connection
        self.reconnectAttempt = reconnectAttempt
        self.lastError = lastError
    }
}

/// Authoritative setup observer: GET snapshot first, then full-snapshot SSE,
/// with exactly five bounded reconnects. Cancelling observation never cancels
/// the daemon-owned job; that requires the explicit cancel endpoint.
public actor SetupLifecycleController {
    public static let maximumReconnects = 5

    private let gateway: any SetupJobGateway
    private let reconnectDelays: [Duration]
    private var current = SetupLifecycleSnapshot()
    private var generation = 0
    private var observationTask: Task<Void, Never>?
    private var subscribers: [UUID: AsyncStream<SetupLifecycleSnapshot>.Continuation] = [:]

    public init(gateway: any SetupJobGateway,
                reconnectDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(10)]) {
        self.gateway = gateway
        self.reconnectDelays = reconnectDelays
    }

    deinit {
        observationTask?.cancel()
        for continuation in subscribers.values { continuation.finish() }
    }

    public func updates() -> AsyncStream<SetupLifecycleSnapshot> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<SetupLifecycleSnapshot>.makeStream()
        subscribers[id] = continuation
        continuation.yield(current)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeSubscriber(id) }
        }
        return stream
    }

    public func snapshot() -> SetupLifecycleSnapshot { current }

    /// Recover the harness's one daemon-owned native-login job. Reopening the
    /// sheet must not make it invisible or permit a duplicate start.
    public func recoverActiveJob(harness: String) async {
        stopObservation(markDetached: false)
        let requestGeneration = generation
        publish(job: nil, connection: .recovering, reconnectAttempt: 0, error: nil)
        do {
            let jobs = try await gateway.listSetupJobs(
                filter: SetupJobListFilter(harness: harness, active: true, limit: 1)
            )
            guard generation == requestGeneration, !Task.isCancelled else { return }
            guard jobs.allSatisfy({ $0.harness.rawValue == harness && $0.isActive }) else {
                throw GatewayError.decoding("setup list contradicted its requested harness/active filter")
            }
            if let job = jobs.last {
                adoptAndObserve(job)
                return
            }

            // `termination_unconfirmed` is terminal for transport purposes but
            // is not safe to replace: the vendor process may still be alive.
            // Preserve that recovery surface across sheet/app reopen instead of
            // enabling a second native-login Terminal. The required active=true
            // lookup above remains the first and authoritative duplicate check.
            let terminal = try await gateway.listSetupJobs(
                filter: SetupJobListFilter(harness: harness, active: false, limit: 1)
            )
            guard generation == requestGeneration, !Task.isCancelled else { return }
            guard terminal.allSatisfy({ $0.harness.rawValue == harness && $0.isTerminal }) else {
                throw GatewayError.decoding("setup list contradicted its requested harness/terminal filter")
            }
            if let unsafe = terminal.last(where: { $0.blocksReplacement }) {
                adoptAndObserve(unsafe)
            } else {
                publish(job: nil, connection: .idle, reconnectAttempt: 0, error: nil)
            }
        } catch {
            guard generation == requestGeneration, !Task.isCancelled else { return }
            publish(job: nil, connection: .streamLost, reconnectAttempt: 0, error: String(describing: error))
        }
    }

    public func start(harness: String, action: String, profileId: String? = nil) async {
        guard let typedHarness = SetupHarness(rawValue: harness),
              let typedAction = SetupJobAction(rawValue: action) else {
            publish(job: current.job, connection: .streamLost, reconnectAttempt: 0,
                    error: "Unsupported setup harness/action contract: \(harness)/\(action)")
            return
        }
        let previous = current
        stopObservation(markDetached: false)
        let requestGeneration = generation
        publish(job: previous.job, connection: .recovering, reconnectAttempt: 0, error: nil)
        do {
            let job = try await gateway.createSetupJob(
                SetupJobCreateRequest(harness: typedHarness, action: typedAction, profileId: profileId))
            guard generation == requestGeneration, !Task.isCancelled else { return }
            adoptAndObserve(job)
        } catch let GatewayError.http(status, body) where status == 409 {
            guard generation == requestGeneration, !Task.isCancelled else { return }
            // A DEFINITIVE conflict (not a transport-unknown): another login for
            // this harness already targets a different store. Server state is
            // KNOWN — no job was created — so surface the daemon's reason without
            // the reconcile-unknown flow that `.streamLost` would trigger.
            publish(job: previous.job, connection: .idle, reconnectAttempt: 0,
                    error: Self.conflictMessage(body))
        } catch {
            guard generation == requestGeneration, !Task.isCancelled else { return }
            // A transport error cannot prove whether the create reached the daemon.
            // Mark server state unknown and require reconciliation instead of
            // enabling a duplicate create.
            publish(job: previous.job, connection: .streamLost, reconnectAttempt: 0,
                    error: String(describing: error))
        }
    }

    /// Pull the daemon's human reason out of a 409 body (RFC-9457 `detail`, or
    /// the legacy `error`/`message` shapes) so a login conflict is never swallowed.
    static func conflictMessage(_ body: String) -> String {
        if let data = body.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in ["detail", "error", "message"] {
                if let value = obj[key] as? String, !value.isEmpty { return value }
            }
        }
        return body.isEmpty
            ? "Another login for this harness is already active for a different account."
            : body
    }

    public func extendDeadline() async {
        guard let job = current.job else { return }
        await performAction { try await gateway.extendSetupJob(jobId: job.jobId) }
    }

    /// Cancellation is asynchronously confirmed by the server. A `cancelling`
    /// response remains active and observed until a terminal snapshot arrives.
    public func cancel() async {
        guard let job = current.job else { return }
        await performAction { try await gateway.cancelSetupJob(jobId: job.jobId) }
    }

    /// Retry creates a distinct login job after a proven termination. An
    /// unconfirmed termination may still own a live vendor process and cannot
    /// be replaced; history remains immutable.
    public func retry() async {
        guard let job = current.job, job.canRetry else { return }
        await start(harness: job.harness.rawValue, action: job.action.rawValue, profileId: job.profileId)
    }

    /// User-requested reconnect starts a fresh bounded observation for a known
    /// active job. If no active job is known (for example a create response was
    /// lost), it performs the server-filtered active lookup before allowing a
    /// new start.
    public func reconnect(harness: String) async {
        if let job = current.job, job.blocksReplacement {
            await performAction { try await gateway.reconcileSetupJob(jobId: job.jobId) }
        } else if let job = current.job, job.isActive {
            adoptAndObserve(job)
        } else {
            await recoverActiveJob(harness: harness)
        }
    }

    /// Stop only the local observer. The daemon job deliberately keeps running.
    public func detach() {
        stopObservation(markDetached: true)
    }

    private func performAction(_ action: () async throws -> SetupJob) async {
        let previous = current
        stopObservation(markDetached: false)
        let requestGeneration = generation
        publish(job: previous.job, connection: .recovering,
                reconnectAttempt: 0, error: nil)
        do {
            let job = try await action()
            guard generation == requestGeneration, !Task.isCancelled else { return }
            adoptAndObserve(job)
        } catch {
            guard generation == requestGeneration, !Task.isCancelled else { return }
            // A transport error cannot prove whether a mutating request reached
            // the daemon. Mark server state unknown and require reconciliation
            // instead of enabling a duplicate create/retry.
            publish(job: previous.job, connection: .streamLost,
                    reconnectAttempt: 0, error: String(describing: error))
        }
    }

    private func adoptAndObserve(_ job: SetupJob) {
        stopObservation(markDetached: false)
        if job.isTerminal {
            publish(job: job, connection: .terminal, reconnectAttempt: 0, error: nil)
            return
        }
        let observedGeneration = generation
        publish(job: job, connection: .connected, reconnectAttempt: 0, error: nil)
        observationTask = Task { [weak self] in
            await self?.observe(jobId: job.jobId, generation: observedGeneration)
        }
    }

    private func observe(jobId: String, generation observedGeneration: Int) async {
        var reconnects = 0
        while !Task.isCancelled, generation == observedGeneration {
            do {
                // Snapshot fence on EVERY attachment/re-attachment. Setup SSE is
                // live status delivery; GET repairs anything missed while down.
                let fenced = try await gateway.setupJobSnapshot(jobId: jobId)
                let snapshot = fenced.job
                var cursor = fenced.cursor
                var sequence = fenced.sequence
                guard snapshot.jobId == jobId, !cursor.isEmpty, sequence >= 0 else {
                    throw GatewayError.decoding("setup snapshot identity/cursor mismatch")
                }
                guard generation == observedGeneration, !Task.isCancelled else { return }
                publish(job: snapshot,
                        connection: snapshot.isTerminal ? .terminal : (reconnects == 0 ? .connected : .reconnecting),
                        reconnectAttempt: reconnects, error: nil)
                if snapshot.isTerminal { return }

                for try await event in gateway.setupJobEvents(jobId: jobId, lastEventId: cursor) {
                    guard generation == observedGeneration, !Task.isCancelled else { return }
                    guard
                        event.jobId == jobId,
                        event.previousCursor == cursor,
                        event.cursor != cursor,
                        event.sequence > sequence
                    else {
                        throw GatewayError.decoding("setup event identity/cursor mismatch")
                    }
                    cursor = event.cursor
                    sequence = event.sequence
                    let next = event.job
                    guard generation == observedGeneration, !Task.isCancelled else { return }
                    publish(job: next, connection: next.isTerminal ? .terminal : .connected,
                            reconnectAttempt: reconnects, error: nil)
                    if next.isTerminal { return }
                }
            } catch {
                if Task.isCancelled || generation != observedGeneration { return }
                if reconnects >= Self.maximumReconnects {
                    publish(job: current.job, connection: .streamLost,
                            reconnectAttempt: reconnects, error: String(describing: error))
                    return
                }
                reconnects += 1
                publish(job: current.job, connection: .reconnecting,
                        reconnectAttempt: reconnects, error: String(describing: error))
                await waitBeforeReconnect(reconnects)
                continue
            }

            // A normal end before a terminal snapshot is also a lost live
            // connection. The next loop begins with an authoritative GET.
            guard generation == observedGeneration, !Task.isCancelled else { return }
            if reconnects >= Self.maximumReconnects {
                publish(job: current.job, connection: .streamLost,
                        reconnectAttempt: reconnects, error: "Setup stream ended before a terminal snapshot.")
                return
            }
            reconnects += 1
            publish(job: current.job, connection: .reconnecting,
                    reconnectAttempt: reconnects, error: nil)
            await waitBeforeReconnect(reconnects)
        }
    }

    private func waitBeforeReconnect(_ attempt: Int) async {
        guard !reconnectDelays.isEmpty else { return }
        let index = min(max(attempt - 1, 0), reconnectDelays.count - 1)
        try? await Task.sleep(for: reconnectDelays[index])
    }

    private func stopObservation(markDetached: Bool) {
        generation += 1
        observationTask?.cancel()
        observationTask = nil
        if markDetached {
            publish(job: current.job, connection: .detached,
                    reconnectAttempt: current.reconnectAttempt, error: nil)
        }
    }

    private func publish(job: SetupJob?, connection: SetupLifecycleConnection,
                         reconnectAttempt: Int, error: String?) {
        current = SetupLifecycleSnapshot(job: job, connection: connection,
                                         reconnectAttempt: reconnectAttempt, lastError: error)
        for continuation in subscribers.values { continuation.yield(current) }
    }

    private func removeSubscriber(_ id: UUID) {
        subscribers.removeValue(forKey: id)
    }
}
