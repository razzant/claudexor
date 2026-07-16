import Foundation
import ClaudexorKit

// MARK: - Live SSE streams (per-run + global journal)
//
// Extracted from `AppModel.swift` (INV-124 readability ratchet): per-run event
// streams with Last-Event-ID resume, adaptive flush coalescing, the global
// journal stream, and the event->UI-state translation. Pure move — zero
// behavior change (stored stream-state properties stay declared on the class;
// their `private` became module-internal because this extension now lives in
// its own file).

/// Durable sidebar-list invalidation (sol review #3): `dirty` holds from "a
/// ping invalidated the list" until a refetch SUCCEEDS — the global cursor
/// consumed the ping, so nothing else would replay it. `delay` is the next
/// attempt's pacing: the coalescing window while healthy, doubling per failure
/// (capped) while the daemon is unreachable — a heartbeat, never a hot loop.
struct ThreadsRefreshState {
    /// Coalescing window while healthy; the backoff cap bounds the retry
    /// heartbeat while the daemon is unreachable (one cheap GET per beat).
    static let coalesce: TimeInterval = 0.2
    static let maxBackoff: TimeInterval = 5.0
    var dirty = false
    var delay: TimeInterval = Self.coalesce
}

extension AppModel {
    // MARK: Live SSE stream

    /// Attach (idempotently) a live stream for a run. Reconnects with
    /// Last-Event-ID after transient drops instead of dying silently, and only
    /// stops on the server's terminal `end` frame or repeated failures.
    func stream(runId: String) {
        guard client != nil else { return }
        guard streamTasks[runId] == nil else { return } // already attached; never restart a live stream
        streamTasks[runId] = Task { [weak self] in
            var attempt = 0
            var lostStream = false
            while !Task.isCancelled {
                guard let self, let client = self.client else { break }
                let resumeFrom = self.lastEventIds[runId]
                if resumeFrom == nil {
                    // Full replay rebuilds spend from budget.observation
                    // increments: seed from replay OR summary, never
                    // both — a mid-run first attach used to double the money.
                    let box = self.ensureLiveBox(runId)
                    box.spendUsd = 0
                    box.spendKnown = false
                }
                do {
                    for try await env in client.events(runId: runId, lastEventId: resumeFrom) {
                        // A delivering stream is a HEALTHY stream: reset the
                        // reconnect budget so a long run with occasional
                        // transient drops never falsely reports a lost stream.
                        attempt = 0
                        self.ingestStreamEnvelope(env, to: runId)
                    }
                    self.drainBuffer(runId) // flush the tail before terminal reconciliation
                    break // clean end frame: the run is terminal
                } catch {
                    if Task.isCancelled { break }
                    attempt += 1
                    if attempt > 5 {
                        lostStream = true
                        break
                    }
                    try? await Task.sleep(for: .seconds(min(Double(attempt) * 2.0, 10.0)))
                }
            }
            // One reducer path for terminal reconciliation: re-snapshot the FULL
            // detail (status + content together). A status-only patch is exactly
            // the "Succeeded with no answer" bug class this replaced.
            await self?.finalizeStream(runId: runId, lostStream: lostStream)
            self?.streamTasks[runId] = nil
            self?.lastEventIds[runId] = nil
        }
    }

    /// Advance the resume cursor and enqueue one delivered SSE envelope. Kept
    /// internal so the delayed snapshot/event ordering has a deterministic test.
    func ingestStreamEnvelope(_ env: BusEnvelope, to runId: String) {
        if env.seq > 0, env.seq <= (lastEventIds[runId] ?? 0) { return }
        if env.seq > 0 { lastEventIds[runId] = env.seq }
        eventBuffers[runId, default: []].append(env)
        scheduleFlush(runId)
    }

    /// Schedule a coalesced flush of this run's buffered SSE events. The window
    /// ADAPTS to the event rate: 64ms when calm (snappy live feel), stretching
    /// toward 250ms under sustained bursts (a racing multi-harness run emits
    /// 20+ events/sec; four renders per second read the same as fifteen but
    /// cost a quarter of the compositing). The batch applies synchronously, so
    /// SwiftUI renders the whole batch once.
    /// Adaptive-coalescing tuning: the flush window starts snappy
    /// and widens exponentially under sustained bursts, capped so the feed
    /// still repaints ~4x/second at worst.
    private static let flushWindowCalm: TimeInterval = 0.064
    private static let flushWindowMax: TimeInterval = 0.25
    /// Arrivals closer than this are a burst (widen); gaps beyond the reset
    /// threshold mean the storm passed (snap back to calm).
    private static let flushBurstGap: TimeInterval = 0.05
    private static let flushCalmGap: TimeInterval = 0.3
    private static let flushWidenFactor = 1.25

    private func scheduleFlush(_ runId: String) {
        // Rate estimate OUTSIDE the single-flight guard: every arrival shapes
        // the window, not just the first event of a window.
        let now = Date()
        var rate = flushRates[runId] ?? (window: Self.flushWindowCalm, lastAt: now)
        let gap = now.timeIntervalSince(rate.lastAt)
        if gap < Self.flushBurstGap {
            rate.window = min(rate.window * Self.flushWidenFactor, Self.flushWindowMax)
        } else if gap > Self.flushCalmGap {
            rate.window = Self.flushWindowCalm
        }
        rate.lastAt = now
        flushRates[runId] = rate
        guard flushTasks[runId] == nil else { return }
        let window = rate.window
        flushTasks[runId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(window))
            guard let self else { return }
            self.flushTasks[runId] = nil
            self.drainBuffer(runId)
        }
    }

    /// Apply all buffered envelopes for a run in one synchronous batch.
    private func drainBuffer(_ runId: String) {
        let batch = eventBuffers[runId] ?? []
        guard !batch.isEmpty else { return }
        eventBuffers[runId] = []
        for env in batch { apply(env, to: runId) }
    }

    /// Coalesce ping-driven refetches: schedule ONE authoritative listThreads
    /// call after a short window instead of one per ping (a fresh global
    /// stream replays the journal, so pings arrive in bursts). Single-flight:
    /// while a refetch is pending, further pings fold into it. The
    /// invalidation is DURABLE: `threadsListDirty` holds until a refetch
    /// succeeds, retrying with bounded backoff — the cursor consumed the ping,
    /// so nothing else would replay it (sol review #3).
    func scheduleThreadsRefresh() {
        threadsRefresh.dirty = true
        guard threadsRefreshTask == nil else { return }
        let delay = threadsRefresh.delay
        threadsRefreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.threadsRefreshTask = nil
            if await self.refreshThreads() {
                self.threadsRefresh = ThreadsRefreshState()
            } else {
                // The watermark promises "revisions REFLECTED": a failed
                // refetch must surrender it so a replayed ping retries instead
                // of being dropped against a never-applied revision — and the
                // dirty flag re-arms the refetch itself with backoff.
                self.threadHeadRevisions.removeAll()
                self.threadsRefresh.delay = min(self.threadsRefresh.delay * 2, ThreadsRefreshState.maxBackoff)
                if self.threadsRefresh.dirty { self.scheduleThreadsRefresh() }
            }
        }
    }

    /// A cursor reset means the global partition's epoch may have changed —
    /// e.g. a journal quarantine restarted the emitter's revision counter at 1
    /// while our watermarks still hold the OLD epoch's high marks. Keeping
    /// them would silently drop every new ping (the W16 fix would regress),
    /// so surrender the watermarks and refetch the authoritative list once.
    private func resetGlobalCursorState() {
        globalEventCursor = nil
        threadHeadRevisions.removeAll()
        scheduleThreadsRefresh()
    }

    /// Cancel every live stream (daemon/client about to be replaced).
    func cancelAllStreams() {
        globalStreamTask?.cancel()
        globalStreamTask = nil
        globalEventCursor = nil
        threadsRefreshTask?.cancel()
        threadsRefreshTask = nil
        threadsRefresh = ThreadsRefreshState()   // a fresh client starts with a full snapshot
        threadHeadRevisions.removeAll()
        for task in streamTasks.values { task.cancel() }
        streamTasks.removeAll()
        lastEventIds.removeAll()
        for task in flushTasks.values { task.cancel() }
        flushTasks.removeAll()
        eventBuffers.removeAll()
        flushRates.removeAll()
        // Fold whatever streamed so far into value-type state (transcripts /
        // spend survive the reconnect); fresh streams re-create boxes.
        for runId in Array(liveBoxes.keys) { foldLiveBox(runId) }
    }

    /// Stream ended (terminal end frame or repeated failures): load the full
    /// snapshot so status and content land atomically, fold the live box back
    /// into value-type state, then notify.
    private func finalizeStream(runId: String, lostStream: Bool) async {
        let before = liveTasks.first(where: { $0.id == runId })?.status
        await loadRunDetail(runId)
        // Terminal fold AFTER the snapshot: server timeline/spend from the
        // snapshot stay authoritative; the box fills gaps, then retires.
        foldLiveBox(runId)
        flushRates[runId] = nil
        guard let idx = liveTasks.firstIndex(where: { $0.id == runId }) else { return }
        if lostStream, liveTasks[idx].status.isActive {
            liveTasks[idx].status = .unknown
            liveTasks[idx].activity.append(ActivityEvent(.system, "Lost engine stream before a terminal status. Reconnect to refresh this run."))
        }
        liveTasks[idx].updatedAt = .now
        if let before {
            Self.notifyTransition(from: before, to: liveTasks[idx].status, title: liveTasks[idx].title)
        }
    }

    /// Durable global journal stream: keeps the run LIST alive (new runs from the
    /// CLI, terminal flips for rows without an attached detail stream). Per-run
    /// streams remain the gap-free source for open rows.
    func startGlobalStream() {
        globalStreamTask?.cancel()
        globalStreamTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let client = self.client else { break }
                do {
                    for try await event in client.globalEvents(lastEventId: self.globalEventCursor) {
                        self.globalEventCursor = event.cursor
                        await self.handleGlobalEvent(event)
                    }
                } catch let GatewayError.http(status, _) where status == 400 || status == 409 || status == 410 {
                    // Stale opaque cursor: resnapshot, then restart the partition stream.
                    self.resetGlobalCursorState()
                    await self.refreshRuns()
                } catch is DecodingError {
                    self.resetGlobalCursorState()
                    await self.refreshRuns()
                } catch GatewayError.decoding {
                    self.resetGlobalCursorState()
                    await self.refreshRuns()
                } catch {
                    if Task.isCancelled { break }
                }
                guard !Task.isCancelled else { break }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func handleGlobalEvent(_ event: JournalEvent) async {
        if event.type == "quota.snapshot.upserted" { await refreshQuota(); return }
        // Sidebar staleness (W12+W16): the engine pings the GLOBAL partition on
        // every thread mutation (create/rename/archive/turn-add/run-terminal —
        // any surface, incl. the CLI). Handled BEFORE the run_id guard below
        // (a ping carries no run_id). Content-free contract: never read thread
        // data off the ping — refetch the authoritative summaries; `revision`
        // (monotonic per thread) drops duplicate deliveries.
        if event.type == "thread.head.updated" {
            guard let threadId = event.payload["thread_id"]?.stringValue, !threadId.isEmpty else { return }
            // Exact conversion: the wire is validated by OUR emitter, but a
            // corrupted frame must degrade (revision 0 = refetch, no dedupe),
            // never trap — and never ROUND into a valid future watermark that
            // would swallow the next genuine revision (sol review #6).
            let revision = event.payload["revision"]?.doubleValue.flatMap { Int(exactly: $0) } ?? 0
            if revision > 0 {
                if revision <= (threadHeadRevisions[threadId] ?? 0) { return }
                threadHeadRevisions[threadId] = revision
            }
            scheduleThreadsRefresh()
            return
        }
        guard let runId = event.payload["run_id"]?.stringValue, !runId.isEmpty else { return }
        let type = event.payload["type"]?.stringValue ?? ""
        let isTerminalEvent = type == "run.completed" || type == "run.failed" || type == "run.blocked"
        if let threadId = event.payload["thread_id"]?.stringValue, !threadId.isEmpty {
            if threadId == selectedThreadId, (type == "run.created" || isTerminalEvent) {
                await openThread(threadId)
                if type == "run.created", streamTasks[runId] == nil { stream(runId: runId) }
            }
            if isTerminalEvent { await refreshThreads() }
        }
        if !liveTasks.contains(where: { $0.id == runId }) { await refreshRuns(); return }
        if streamTasks[runId] == nil, isTerminalEvent || type == "interaction.requested" { await loadRunDetail(runId) }
    }

    /// Native notification when a live run reaches a state that wants the user's attention.
    private static func notifyTransition(from: RunStatus, to: RunStatus, title: String) {
        guard from != to else { return }
        switch to {
        case .succeeded: Notifier.post(title: "Run succeeded", body: title)
        case .failed: Notifier.post(title: "Run failed", body: title)
        case .needsReview: Notifier.post(title: "Needs your review", body: title)
        case .blocked: Notifier.post(title: "Run blocked — needs permission", body: title)
        case .ungated: Notifier.post(title: "Run ungated", body: title)
        case .reviewNotRun: Notifier.post(title: "Review not run", body: title)
        case .exhausted: Notifier.post(title: "Run exhausted", body: title)
        case .notConverged: Notifier.post(title: "Run did not converge", body: title)
        case .stuckNoProgress: Notifier.post(title: "Run stuck with no progress", body: title)
        case .unknown: Notifier.post(title: "Run status unknown", body: title)
        default: break
        }
    }

    /// Translate one canonical run event into UI state. The live daemon path names each
    /// SSE event by its RunEvent `type` (`run.created`, `harness.event`, `gate.completed`,
    /// `review.finding.proposed`, `run.completed`, …) and sends the full record as data;
    /// the in-proc bus uses a normalized kind. We classify off the record's own `type`,
    /// falling back to the SSE kind — so it works against both servers.
    /// W23 memory bound for the snapshot-fence buffer: a flooding run during a
    /// slow detail load must not hoard envelopes without limit (part of the
    /// 30GB-hang class). On overflow the buffer resets and the load's defer
    /// fetches a FRESH snapshot instead of replaying an incomplete tail.
    static let deferredEnvelopeCap = 512

    func apply(_ env: BusEnvelope, to runId: String) {
        // Snapshot fence, write side: never interleave with an in-flight
        // detail load; the load's defer re-applies these in arrival order.
        if snapshotLoadDepth[runId] ?? 0 > 0 {
            if (deferredEnvelopes[runId]?.count ?? 0) >= Self.deferredEnvelopeCap {
                deferredEnvelopes[runId] = []
                deferredOverflow.insert(runId)
            }
            deferredEnvelopes[runId, default: []].append(env)
            return
        }
        // HOT fields (transcript, activity, spend ticks) mutate the per-run
        // box: only that box's readers re-render. The tasks ARRAY is written
        // only when a low-frequency truth changes (status, findings,
        // interactions, caps) — its property write invalidates every list.
        let box = ensureLiveBox(runId)
        // Fold the live transcript (the chat shows working progress — reasoning +
        // tools — as it happens, not just the final answer).
        _ = box.transcript.apply(env)
        guard let idx = liveTasks.firstIndex(where: { $0.id == runId }) else { return }
        let type = env.event["type"]?.stringValue ?? env.kind
        let payload = env.event["payload"] ?? env.event
        let before = liveTasks[idx].status
        var t = liveTasks[idx]
        var taskChanged = false
        var shouldLoadDetail = false
        defer {
            if taskChanged {
                t.updatedAt = .now
                liveTasks[idx] = t
                Self.notifyTransition(from: before, to: t.status, title: t.title)
            }
            if shouldLoadDetail {
                Task { await self.loadRunDetail(runId) }
            }
        }

        if type == "end" {
            return
        }
        if type.hasPrefix("run.") {
            if type == "run.completed" {
                if let s = payload["status"]?.stringValue ?? payload["state"]?.stringValue {
                    t.status = RunStatus(api: s)
                } else {
                    t.status = .succeeded
                }
                shouldLoadDetail = true
            } else if type == "run.failed" {
                if let s = payload["status"]?.stringValue ?? payload["state"]?.stringValue {
                    t.status = RunStatus(api: s)
                } else {
                    t.status = .failed
                }
                shouldLoadDetail = true
            }
            else if type == "run.blocked" {
                t.status = RunStatus(api: payload["status"]?.stringValue ?? "blocked")
                shouldLoadDetail = true
            }
            else if let s = payload["status"]?.stringValue ?? payload["state"]?.stringValue { t.status = RunStatus(api: s) }
            else if t.status == .queued { t.status = .running }
            // Only an ACTUAL status change rewrites the tasks array (a
            // repeated same-status run.* frame is a no-op for the lists).
            if t.status != before { taskChanged = true }
        } else if type.hasPrefix("harness.") {
            let detail = payload["type"]?.stringValue ?? payload["kind"]?.stringValue ?? ""
            let kind: ActivityKind = detail.contains("file") ? .file
                : detail.contains("tool") ? .tool
                : detail.contains("think") ? .thinking
                : detail == "status" ? .system   // typed transient status (e.g. api_retry)
                : detail.contains("message") ? .message : .tool
            let h = (payload["harness_id"]?.stringValue ?? payload["harness"]?.stringValue).flatMap { HarnessFamily(rawValue: $0) }
            if let h, !t.harnesses.contains(h) {
                t.harnesses.append(h)
                taskChanged = true
            }
            box.appendActivity(ActivityEvent(kind, harness: h, Self.title(payload) ?? Self.pretty(type), detail: payload["text"]?.stringValue ?? payload["error"]?.stringValue, code: payload["rawRef"]?.stringValue, at: .now))
            if type == "harness.completed" { shouldLoadDetail = true }
        } else if type.hasPrefix("gate.") {
            box.appendActivity(ActivityEvent(.gate, Self.title(payload) ?? Self.pretty(type), at: .now))
            if type == "gate.completed" { shouldLoadDetail = true }
        } else if type == "plan.progress" {
            if let items = Self.planItems(from: payload) {
                t.plan = items
                taskChanged = true
            }
            box.appendActivity(ActivityEvent(.system, "Plan updated", at: .now))
        } else if type.hasPrefix("review.") || type.hasPrefix("reviewer.") || type.hasPrefix("finding.") {
            box.appendActivity(ActivityEvent(.review, Self.title(payload) ?? Self.pretty(type), at: .now))
            if type == "review.started" {
                t.reviewVerdict = .running
                taskChanged = true
            } else if type == "review.finding.proposed", let f = Self.finding(from: payload, taskTitle: t.title) {
                t.findings.append(f)
                t.reviewVerdict = .findings
                taskChanged = true
            } else if type == "reviewer.failed" || type == "reviewer.timed_out" {
                t.reviewVerdict = type == "reviewer.failed" ? .failed : .error
                taskChanged = true
                shouldLoadDetail = true
            } else if type == "reviewer.completed" || type == "finding.revalidated" {
                shouldLoadDetail = true
            }
        } else if type == "arbitration.completed" {
            box.appendActivity(ActivityEvent(.system, Self.pretty(type), at: .now))
            shouldLoadDetail = true
        } else if type.hasPrefix("budget.") {
            if type == "budget.observation", let usd = payload["usd"]?.doubleValue {
                // Observations are per-event INCREMENTS (live spend ticks up mid-run).
                box.spendUsd += usd
                box.spendKnown = true
                if payload["estimated"]?.boolValue == true { box.spendEstimated = true }
            } else if let spend = payload["spend_usd"]?.doubleValue ?? payload["cost_usd"]?.doubleValue {
                box.spendUsd = spend
                box.spendKnown = true
                box.spendEstimated = payload["estimated"]?.boolValue ?? box.spendEstimated
            }
            if let cap = payload["max_usd"]?.doubleValue, cap >= 0, cap != t.capUsd || !t.capKnown {
                t.capUsd = cap
                t.capKnown = true
                taskChanged = true
            }
        } else if type == "output.ready" {
            t.outputReadyState = payload["state"]?.stringValue ?? "ready"
            taskChanged = true
            shouldLoadDetail = true
        } else if type == "interaction.requested" {
            if let pending = Self.pendingInteraction(from: payload, runId: runId) {
                t.pendingInteractions.removeAll { $0.interactionId == pending.interactionId }
                t.pendingInteractions.append(pending)
                t.waitingOnUser = true
                taskChanged = true
                let summary = pending.questions.map(\.question).joined(separator: " | ")
                box.appendActivity(ActivityEvent(.system, "Question: \(String(summary.prefix(200)))", at: .now))
                Notifier.post(title: "Claudexor needs your answer", body: String(summary.prefix(120)))
            }
        } else if type == "interaction.answered" || type == "interaction.timeout" {
            if let interactionId = payload["interaction_id"]?.stringValue {
                t.pendingInteractions.removeAll { $0.interactionId == interactionId }
            }
            t.waitingOnUser = !t.pendingInteractions.isEmpty
            taskChanged = true
            box.appendActivity(ActivityEvent(.system, type == "interaction.answered" ? "Answer delivered" : "Question timed out — continuing with assumptions", at: .now))
        } else {
            box.appendActivity(ActivityEvent(.system, Self.title(payload) ?? Self.pretty(type), at: .now))
        }
    }
}
