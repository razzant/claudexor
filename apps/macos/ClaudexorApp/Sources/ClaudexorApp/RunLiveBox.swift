/**
 * Per-run live streaming state (P1 render granularity).
 *
 * The HIGH-FREQUENCY SSE fields (activity feed, transcript, spend ticks) live
 * in this per-run @Observable box while the run streams. Mutating a box field
 * only invalidates the views that read THAT box — one run card / one open
 * timeline — instead of rewriting an element of `liveTasks`, whose array-
 * property write invalidated every list/screen reading any task projection
 * (the whole-app-repaints-during-races bug this refactor removed).
 *
 * `liveTasks` (TaskRun) keeps the LOW-FREQUENCY truths: status flips,
 * findings, interactions, caps, harnesses — a handful of writes per run.
 * At terminal the box folds back into the task snapshot and is retired
 * (`foldLiveBox`), so terminal runs render exactly as before from TaskRun.
 */
import Foundation
import Observation
import ClaudexorKit

@Observable
@MainActor
final class RunLiveBox: Identifiable {
    /// Live-feed ring: keep the newest N events; older ones collapse into an
    /// honest counter (mirrors the server's capped timeline + omitted note).
    static let activityCap = 1000
    /// Trim in CHUNKS so the O(n) removeFirst amortizes to ~once per 100
    /// events at the cap instead of every append.
    private static let activityTrimChunk = 100

    let id: String
    /// Live activity feed (SSE-folded, oldest-first). Server timeline
    /// snapshots replace it wholesale at loadRunDetail; between snapshots
    /// events append via appendActivity (ring-capped).
    var activity: [ActivityEvent] = []
    /// Older events dropped by the ring (rendered as a truncation marker).
    var activityDropped = 0
    /// Live chat transcript (thinking/tools/messages; self-capped at 200 blocks).
    var transcript = TranscriptReducer()
    /// Live spend rebuilt from budget.observation increments (or seeded by the
    /// latest snapshot). `spendKnown=false` until any spend evidence arrives.
    var spendUsd: Double = 0
    var spendKnown = false
    var spendEstimated = false

    init(id: String) {
        self.id = id
    }

    /// Append one live event, honestly collapsing the oldest past the cap.
    /// The feed NEVER exceeds the documented cap: crossing it trims down to
    /// cap - chunk in one go, so the O(n) removeFirst amortizes to ~once per
    /// `activityTrimChunk` appends instead of every event at the cap.
    func appendActivity(_ event: ActivityEvent) {
        activity.append(event)
        if activity.count > Self.activityCap {
            let drop = min(activity.count - Self.activityCap + Self.activityTrimChunk, activity.count)
            activity.removeFirst(drop)
            activityDropped += drop
        }
    }
}

// MARK: - AppModel: box lifecycle + live-first read overlays

extension AppModel {
    /// The live box for a streaming run; nil once the run folded to terminal.
    func liveBox(_ runId: String) -> RunLiveBox? {
        liveBoxes[runId]
    }

    /// Get-or-create the box (stream attach / first live event). A NEW box is
    /// seeded from the run's CURRENT TaskRun snapshot — a box created after a
    /// detail load (e.g. attaching to a mid-flight run the app already
    /// hydrated) must not shadow the populated task state with emptiness:
    /// views prefer the box the moment it exists.
    func ensureLiveBox(_ runId: String) -> RunLiveBox {
        if let box = liveBoxes[runId] { return box }
        let box = RunLiveBox(id: runId)
        if let task = liveTasks.first(where: { $0.id == runId }) {
            box.activity = task.activity
            if task.spendKnown {
                box.spendUsd = task.spendUsd
                box.spendKnown = true
                box.spendEstimated = task.spendEstimated
            }
        }
        if let folded = transcripts[runId] {
            box.transcript = folded
        }
        liveBoxes[runId] = box
        return box
    }

    /// Live-first transcript blocks (box while streaming, folded store after).
    func transcriptBlocks(_ runId: String) -> [TranscriptBlock] {
        liveBoxes[runId]?.transcript.blocks ?? transcripts[runId]?.blocks ?? []
    }

    /// Oldest transcript blocks dropped by the reducer's cap (honest marker).
    func transcriptTrimmedCount(_ runId: String) -> Int {
        liveBoxes[runId]?.transcript.trimmed ?? transcripts[runId]?.trimmed ?? 0
    }

    /// Characters the reducer's per-block byte bound cut (W23 honest marker).
    func transcriptTruncatedChars(_ runId: String) -> Int {
        liveBoxes[runId]?.transcript.truncatedChars ?? transcripts[runId]?.truncatedChars ?? 0
    }

    /// Live-first spend for meters/cards: the box once it has spend evidence,
    /// the task snapshot otherwise.
    func spendDisplay(_ task: TaskRun) -> (usd: Double, known: Bool, estimated: Bool) {
        if let box = liveBoxes[task.id], box.spendKnown {
            return (box.spendUsd, true, box.spendEstimated)
        }
        return (task.spendUsd, task.spendKnown, task.spendEstimated)
    }

    /// Reclaim heavy per-run memory (P3 eviction): TERMINAL runs that are not
    /// on screen drop their activity feed and transcript. Reopening restores
    /// the feed from the server timeline (openThread hydrates recent turns via
    /// loadRunDetail); transcripts are SSE-fold artifacts — they were already
    /// absent after an app restart, so dropping them off-screen matches the
    /// existing terminal experience. Live/streaming runs are never touched.
    func evictBackgroundRunData() {
        var keep = Set<String>()
        if case .task(let id) = route { keep.insert(id) }
        for turn in selectedThreadDetail?.turns ?? [] {
            if let runId = turn.runId { keep.insert(runId) }
        }
        // Streaming runs keep everything (their box IS the live state).
        keep.formUnion(liveBoxes.keys)
        for idx in liveTasks.indices {
            let t = liveTasks[idx]
            // Evict exactly the TERMINAL runs OUTSIDE the keep-set.
            let evictable = !keep.contains(t.id) && t.phase.isTerminal
            if evictable, !t.activity.isEmpty { liveTasks[idx].activity = [] }
        }
        // Snapshot the keys BEFORE mutating: removing entries while iterating
        // the live keys view is an undefined-iteration hazard.
        for runId in Array(transcripts.keys) where !keep.contains(runId) {
            // A transcript without a task row is orphaned bookkeeping; a task
            // row keeps its transcript only while active (mid-run reconnects).
            if let t = task(runId), !t.phase.isTerminal { continue }
            transcripts[runId] = nil
        }
    }

    /// Terminal fold: persist the box's final state into the TaskRun snapshot
    /// (and the terminal transcript store), then retire the box so the run
    /// renders from plain value-type state exactly as pre-box builds did.
    /// Runs AFTER the terminal loadRunDetail: the server timeline/spend in
    /// that snapshot stay authoritative; the box only fills gaps.
    func foldLiveBox(_ runId: String) {
        guard let box = liveBoxes[runId] else { return }
        if let idx = liveTasks.firstIndex(where: { $0.id == runId }) {
            var t = liveTasks[idx]
            // The terminal snapshot rebuilt activity from the server timeline
            // (authoritative, truncation-marked). Only an EMPTY snapshot falls
            // back to the SSE-accumulated feed.
            if t.activity.isEmpty, !box.activity.isEmpty { t.activity = box.activity }
            // Snapshot spend (summary/budget) already landed on the task in
            // loadRunDetail; the box only contributes when the snapshot had
            // no spend truth but live increments did arrive.
            if !t.spendKnown, box.spendKnown {
                t.spendUsd = box.spendUsd
                t.spendKnown = true
                t.spendEstimated = box.spendEstimated
            }
            liveTasks[idx] = t
        }
        if !box.transcript.blocks.isEmpty {
            transcripts[runId] = box.transcript
        }
        liveBoxes[runId] = nil
    }
}
