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
    /// Cap-governed cash from the latest disclosure; nil until one says it is known.
    var controllableSpendUsd: Double?
    /// True once cash evidence reached this box: a settle event, a seed from a task that
    /// knew its cash, or a budget snapshot stating the total or disclosing it unknown.
    /// From then on the box is the latest word, even when it says "unknown"; before it,
    /// the box has no evidence and the task snapshot is what renders.
    var cashDisclosed = false

    init(id: String) {
        self.id = id
    }

    /// Mirror a fresh run-detail budget snapshot (authoritative up to its last event;
    /// later disclosures apply on top). A total it states, or discloses as unknown,
    /// replaces the box's earlier cash, and its cap-governed part replaces the old
    /// one (nil included). A snapshot that says nothing about cash (no total, no
    /// unknown disclosure) is no evidence and leaves the box alone.
    func adopt(_ budget: BudgetSnapshot) {
        let totalKnown = budget.spendUsd != nil
        let disclosedUnknown = budget.cashKnowledge == "unknown"
            || (!totalKnown && budget.controllableSpendUsd != nil)
        guard totalKnown || disclosedUnknown else { return }
        spendKnown = totalKnown
        if let usd = budget.spendUsd { spendUsd = usd }
        spendEstimated = budget.estimated
        controllableSpendUsd = budget.controllableSpendUsd
        cashDisclosed = true
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
            box.controllableSpendUsd = task.controllableSpendUsd
            box.cashDisclosed = task.spendKnown || task.controllableSpendUsd != nil
        }
        if let folded = transcripts[runId] {
            box.transcript = folded
        }
        liveBoxes[runId] = box
        return box
    }

    /// The snapshot's engine receipts (`workspace.prepared`) into the visible
    /// transcript: a restored or re-attached run resumes its stream after the
    /// snapshot's last seq, so the SSE fold never sees them. Same block id as
    /// the live fold, so a receipt seen both ways shows once; a generic row
    /// (the server could not read the payload) adds nothing.
    /// A remote run folds into its own location-keyed reducer, never the local maps.
    func foldTimelineNotices(_ runId: String, _ timeline: [TimelineEvent], at location: ExecutionLocationID = .local) {
        let notices = timeline.compactMap { row -> (id: String, notice: TranscriptNotice)? in
            guard row.type == "workspace.prepared", row.title == TranscriptNotice.preparedTitle,
                  let attempt = row.attemptId, let detail = row.detail else { return nil }
            return (TranscriptNotice.preparedId(attemptId: attempt),
                    TranscriptNotice(title: row.title, text: detail, warning: row.severity == "warning"))
        }
        guard !notices.isEmpty else { return }
        let key = RunDetailLoadKey(locationID: location, runId: runId)
        var transcript = location != .local ? remoteTranscripts[key] ?? TranscriptReducer()
            : liveBoxes[runId]?.transcript ?? transcripts[runId] ?? TranscriptReducer()
        for item in notices.reversed() { transcript.applyNotice(id: item.id, item.notice, atStart: true) }
        if location != .local { remoteTranscripts[key] = transcript }
        else if let box = liveBoxes[runId] { box.transcript = transcript } else { transcripts[runId] = transcript }
    }

    /// The transcript a turn card at `location` shows: a local run's live box or
    /// folded store, a remote run's receipts only. A same-id run elsewhere never answers.
    func transcript(_ runId: String, at location: ExecutionLocationID) -> TranscriptReducer? {
        location == .local ? liveBoxes[runId]?.transcript ?? transcripts[runId]
            : remoteTranscripts[RunDetailLoadKey(locationID: location, runId: runId)]
    }

    /// Live-first LOCAL transcript blocks (box while streaming, folded store after).
    func transcriptBlocks(_ runId: String) -> [TranscriptBlock] {
        transcript(runId, at: .local)?.blocks ?? []
    }

    /// Live-first spend for meters/cards: the box once cash evidence reached it,
    /// the task snapshot otherwise. A disclosed box wins even when it says
    /// "unknown": an older exact task value must not answer for a newer disclosure.
    func spendDisplay(_ task: TaskRun)
        -> (usd: Double, known: Bool, estimated: Bool, controllableUsd: Double?) {
        guard let box = liveBoxes[task.id], box.cashDisclosed else {
            return (task.spendUsd, task.spendKnown, task.spendEstimated, task.controllableSpendUsd)
        }
        return (box.spendUsd, box.spendKnown, box.spendEstimated, box.controllableSpendUsd)
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
        for turn in selectedHistory?.rows ?? [] {
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
            // The box mirrored the terminal snapshot's budget (`adopt`) and then
            // took every later disclosure, so a disclosed box is the latest word
            // on cash, an unknown total included. A box that never heard cash
            // evidence leaves the snapshot's values alone.
            if box.cashDisclosed {
                t.spendKnown = box.spendKnown
                if box.spendKnown {
                    t.spendUsd = box.spendUsd
                    t.spendEstimated = box.spendEstimated
                }
                t.controllableSpendUsd = box.controllableSpendUsd
            }
            liveTasks[idx] = t
        }
        if !box.transcript.blocks.isEmpty {
            transcripts[runId] = box.transcript
        }
        liveBoxes[runId] = nil
    }
}
