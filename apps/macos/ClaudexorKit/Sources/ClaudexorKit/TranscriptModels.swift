import Foundation

/// Pure fold of SSE envelopes into transcript blocks. No UI, no I/O — unit
/// tested. Idempotent by `seq` (a replayed event never duplicates a block);
/// consecutive `thinking` blocks merge; a `tool_result` updates its own try's `tool_call`
/// of that `use_id` (id-less: its try's one open id-less call of that name), else stands alone.
public struct TranscriptReducer: Sendable {
    public private(set) var blocks: [TranscriptBlock] = []
    /// Number of oldest blocks dropped to stay under `cap` (shown as "N earlier…").
    public private(set) var trimmed: Int = 0
    /// Characters cut from OVERLONG single blocks (the per-block byte bound) —
    /// disclosed alongside `trimmed`, never a silent truncation (W23).
    public private(set) var truncatedChars: Int = 0
    /// Live text characters currently held across EVERY retained string —
    /// thinking/message text AND tool name/kind/target/detail — the MEASURABLE
    /// W23 invariant: never exceeds `totalCharBudget`.
    public private(set) var textChars: Int = 0

    /// Highest seq already folded — idempotent replay without an unbounded Set.
    private var lastSeq: Int = -1
    /// Tool cards by their try's stream: open calls by `use_id`, id-less calls by bounded name,
    /// and settled background handoffs a `command_outcome_refined` row may update once (#546).
    private struct ToolKey: Hashable, Sendable { let stream: StreamKey; let id: String }
    private var openToolByUseId: [ToolKey: Int] = [:]
    private var openIdlessToolsByName: [ToolKey: [Int]] = [:]
    private var handoffToolIndexByUseId: [ToolKey: Int] = [:]
    /// Wall-clock start of the OPEN thinking segment (from the events' own
    /// `ts`), so the merged block can disclose how long the reasoning ran.
    private var openThinkingStart: Date?
    /// The stream whose fragment the open reasoning segment ended on. Only its
    /// next fragment continues the words; anything else starts a new line.
    private var openThinkingStream: StreamKey?
    /// One assistant text stream: the journal's identity of a physical try
    /// (`attempt_id`, `harness_id`, `session_id`), so an earlier try's final never
    /// seals a later try and concurrent candidates never join. Events without
    /// them (older engines, other producers) share one legacy stream.
    private struct StreamKey: Hashable, Sendable {
        let attempt: String?
        let harness: String?
        let session: String?

        init(_ payload: JSONValue) {
            attempt = payload["attempt_id"]?.stringValue
            harness = payload["harness_id"]?.stringValue
            session = payload["session_id"]?.stringValue
        }
    }

    /// The message state of ONE stream.
    private struct StreamState: Sendable {
        /// Block id of the currently-APPENDABLE delta block: a delta continues it
        /// only while it is still last; a tool/thinking block clears it so the
        /// next delta starts fresh (correct feed order).
        var streamingMessageId: String?
        /// Block id awaiting its authoritative full flush (W-C4): survives an
        /// intervening tool block so the complete message reconciles by id instead
        /// of appending a duplicate (confirm #1). Cleared on reconcile / final.
        var pendingFlushId: String?
        /// Set once a TYPED final message arrives: seals the delta stream so a
        /// late stray delta never appends after the answer is final (sol #9),
        /// until a typed native turn boundary of the same stream reopens it.
        var finalized = false
        /// Block id of the most recent assistant MESSAGE block — the twin the
        /// harness emits as ordinary narration immediately before repeating it as
        /// the typed final (Codex last agent message; Claude/Cursor result). A
        /// non-empty typed final removes THIS block so Activity never duplicates the
        /// answer bubble (QA-009). Tracked by id — no prose comparison — and it
        /// survives an intervening tool/thinking block. Cleared on final.
        var messageCandidateId: String?
        /// Adapter-issued speech keys (`speech.key`) whose fragments the pending
        /// block holds: a keyed complete replaces it only when it holds exactly
        /// that key, so a completion never erases another speech's text.
        var speechKeys: Set<String> = []

        /// The harness stated that `key`'s text will never be completed: the
        /// block holding it keeps its text as emitted and takes no later
        /// fragment, flush or twin removal.
        mutating func abandon(_ key: String) {
            guard speechKeys.contains(key) else { return }
            if messageCandidateId == pendingFlushId { messageCandidateId = nil }
            streamingMessageId = nil
            pendingFlushId = nil
            speechKeys = []
        }
    }

    private var streams: [StreamKey: StreamState] = [:]
    /// Engine notices that left the window (evicted, or restored into a full
    /// window and never placed): restoring one again neither re-inserts nor
    /// recounts it. One id per prepared copy of the run, never per event.
    private var accountedNoticeIds: Set<String> = []
    private let cap: Int
    /// W23 P0-hang bounds: the block COUNT cap alone let a single merged
    /// thinking block grow to megabytes — SwiftUI then laid out that Text on
    /// the main thread every SSE batch (the sampled hang: 100% in
    /// LayoutEngineBox.sizeThatFits, 30.4 GB footprint). Any single block and
    /// the transcript's total text are now hard-bounded in characters.
    private let blockCharCap: Int
    private let totalCharBudget: Int
    /// Tool strings (name/kind/target/detail) are harness-supplied and NOT
    /// engine-bounded — one multi-megabyte command target rendered by `Text`
    /// reopens the same hang class, so each field gets its own hard cap.
    private let toolFieldCap: Int

    public init(cap: Int = 200, blockCharCap: Int = 100_000, totalCharBudget: Int = 600_000,
                toolFieldCap: Int = 2_048) {
        self.cap = cap
        self.blockCharCap = blockCharCap
        self.totalCharBudget = totalCharBudget
        self.toolFieldCap = toolFieldCap
    }

    /// The adapter's stream-fragment flag on a message or thinking event: the
    /// engine journals it nested (`payload.payload`), older rows carry it flat.
    private static func isFragment(_ payload: JSONValue) -> Bool {
        payload["delta"]?.boolValue == true || payload["payload"]?["delta"]?.boolValue == true
    }

    /// Apply one envelope. `harness.event` run events and the engine's
    /// `workspace.prepared` receipt contribute; everything else is ignored.
    /// Returns true if the transcript changed.
    ///
    /// The per-run SSE sets `BusEnvelope.kind` to the event NAME (e.g.
    /// "harness.event"), not the literal "run" — so we discriminate on the RunEvent
    /// `type` field inside `event`, never on `kind` (review #11). Idempotency is by
    /// monotonic `seq` (SSE replays in order), so there is no unbounded seen-set.
    @discardableResult
    public mutating func apply(_ env: BusEnvelope) -> Bool {
        if env.seq <= lastSeq { return false }   // already folded (replay)
        if env.event["type"]?.stringValue == "workspace.prepared" {
            lastSeq = env.seq
            guard let prepared = TranscriptNotice.prepared(env.event["payload"]) else { return false }
            return applyNotice(id: TranscriptNotice.preparedId(attemptId: prepared.attemptId), prepared.notice)
        }
        guard env.event["type"]?.stringValue == "harness.event" else {
            lastSeq = max(lastSeq, env.seq)
            return false
        }
        lastSeq = env.seq
        guard let payload = env.event["payload"] else { return false }
        let evType = payload["type"]?.stringValue
        let seqKey = String(env.seq)
        switch evType {
        case "status":
            // A typed native turn boundary (Claude's `native_turn_started`: a
            // queued live message runs as the next turn of the SAME session)
            // reopens only that stream: its earlier final no longer seals the
            // new turn's text, while a late delta before the boundary was
            // dropped and every other stream keeps its state. Not rendered.
            if payload["payload"]?["code"]?.stringValue == "native_turn_started" {
                streams[StreamKey(payload)] = nil
            } else if payload["speech"]?["op"]?.stringValue == "abandoned",
                      let speech = payload["speech"]?["key"]?.stringValue {
                streams[StreamKey(payload)]?.abandon(speech)
            }
            return applyRefinement(payload)
        case "thinking":
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return false }
            let eventAt = Self.isoDate(payload["ts"]?.stringValue)
            let stream = StreamKey(payload)
            let fragment = Self.isFragment(payload)
            defer { openThinkingStream = fragment ? stream : nil }
            if case .thinking(let id, let prev, _) = blocks.last {
                // Keep the TAIL of an overlong merge: the live feed shows the
                // newest reasoning; the cut is counted, never silent. A fragment
                // of the same stream continues its words: no separator is
                // written inside model prose.
                let bounded = boundTail(fragment && openThinkingStream == stream ? prev + text : prev + "\n" + text)
                textChars += bounded.count - prev.count
                blocks[blocks.count - 1] = .thinking(id: id, text: bounded,
                                                     seconds: segmentSeconds(until: eventAt))
                enforceBudget()
            } else {
                openThinkingStart = eventAt
                append(.thinking(id: "th-\(seqKey)", text: boundTail(text)))
            }
            return true
        case "message":
            // Buffered snapshots remain in the evidence artifact, not a second
            // complete message in the visible transcript (live or replayed).
            if payload["buffered"]?.boolValue == true || payload["payload"]?["buffered"]?.boolValue == true { return false }
            // Delta, flush and finality state belong to this event's own stream.
            let key = StreamKey(payload)
            var stream = streams[key] ?? StreamState()
            defer { streams[key] = stream }
            // A TYPED final message (claude/cursor result, codex finalized last
            // agent message) IS the answer bubble — never rendered here. It
            // SEALS its delta stream so a late stray delta cannot append after
            // the answer is final. Checked BEFORE the non-empty guard so an
            // EMPTY final still seals (review confirm #2).
            if payload["final"]?.boolValue == true {
                stream.streamingMessageId = nil
                stream.pendingFlushId = nil
                stream.speechKeys = []
                stream.finalized = true
                // QA-009: Codex/Claude/Cursor emit the to-be-finalized assistant
                // message as an ordinary block right before repeating it as this
                // typed final, so Activity would otherwise show a dim twin of the
                // answer bubble. Drop that tracked candidate — but ONLY when it IS
                // the final's own text, so a DISTINCT preceding narration
                // ("Looking…" → "Answer") is preserved. This is the final flag
                // driving an EXACT identity check on the correlated block, not the
                // rejected fuzzy row-vs-answer prose heuristic; an EMPTY final has
                // no twin and only seals (acceptance #2/#6).
                if let finalText = payload["text"]?.stringValue, !finalText.isEmpty {
                    removeFinalizedTwin(stream.messageCandidateId, finalText: finalText)
                }
                stream.messageCandidateId = nil
                return true
            }
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return false }
            let speech = payload["speech"]?["key"]?.stringValue
            // Live deltas (W-C4) grow ONE streaming block; after a final the
            // stream is SEALED (a late stray delta is dropped). A delta
            // continues the block only while it is still LAST (out-of-order
            // append would corrupt the feed); otherwise it starts a fresh one.
            // `pendingFlushId` remembers the block awaiting its authoritative
            // full flush EVEN across an intervening tool block (confirm #1).
            if Self.isFragment(payload) {
                if stream.finalized { return false }
                if let sid = stream.streamingMessageId, blocks.last?.id == sid,
                   case .message(let id, let prev) = blocks.last {
                    let bounded = boundHead(prev + text)
                    textChars += bounded.count - prev.count
                    blocks[blocks.count - 1] = .message(id: id, text: bounded)
                    enforceBudget()
                } else {
                    let id = "msg-\(seqKey)"
                    append(.message(id: id, text: boundHead(text)))
                    stream.streamingMessageId = id
                    stream.speechKeys = []
                }
                if let speech { stream.speechKeys.insert(speech) }
                stream.pendingFlushId = stream.streamingMessageId
                stream.messageCandidateId = stream.streamingMessageId
                return true
            }
            // The complete (non-delta) message REPLACES its delta-built block
            // by id — even after an intervening tool block orphaned it from the
            // tail (confirm #1) — instead of appending a duplicate paragraph. A
            // keyed one replaces only a block that holds just its own speech.
            if let pid = stream.pendingFlushId, speech.map({ stream.speechKeys == [$0] }) ?? true,
               let i = blocks.lastIndex(where: { $0.id == pid }),
               case .message(let id, let prev) = blocks[i] {
                let bounded = boundHead(text)
                textChars += bounded.count - prev.count
                blocks[i] = .message(id: id, text: bounded)
                stream.pendingFlushId = nil
                stream.streamingMessageId = nil
                stream.speechKeys = []
                stream.messageCandidateId = id
                enforceBudget()
                return true
            }
            // A message is a one-shot: keep the HEAD (the answer's beginning);
            // the full text lives in the run's artifacts.
            let oneShotId = "msg-\(seqKey)"
            append(.message(id: oneShotId, text: boundHead(text)))
            stream.messageCandidateId = oneShotId
            return true
        case "tool_call":
            let tool = payload["tool"]
            let block = boundedTool(
                name: tool?["name"]?.stringValue ?? "tool",
                kind: tool?["kind"]?.stringValue,
                target: tool?["target"]?.stringValue,
                status: .running,
                detail: tool?["content_summary"]?.stringValue,
                exitCode: tool?["exit_code"]?.doubleValue.map { Int($0) }
            )
            let id = "tool-\(seqKey)"
            append(.tool(id: id, block))
            let idx = blocks.count - 1, stream = StreamKey(payload)
            if let useId = tool?["use_id"]?.stringValue { openToolByUseId[ToolKey(stream: stream, id: useId)] = idx }
            else if let name = tool?["name"]?.stringValue, name.count <= toolFieldCap { openIdlessToolsByName[ToolKey(stream: stream, id: name), default: []].append(idx) }
            return true
        case "tool_result":
            let tool = payload["tool"], stream = StreamKey(payload)
            let useId = tool?["use_id"]?.stringValue
            let name = tool?["name"]?.stringValue
            let idx: Int? = if let useId { openToolByUseId[ToolKey(stream: stream, id: useId)] }
                else { name.flatMap { openIdlessToolsByName[ToolKey(stream: stream, id: $0)] }.flatMap { $0.count == 1 ? $0[0] : nil } }
            let statusStr = tool?["status"]?.stringValue
            // #450: an ok result whose command end is unconfirmed (background
            // handoff, elapsed timeout, unknown outcome) is not a success.
            let outcome = boundedOutcome(ToolBlock.CommandOutcome(tool?["command_outcome"]))
            let status: ToolBlock.Status = statusStr == "error"
                ? .error : outcome?.unconfirmed == true ? .unconfirmed : .ok
            let detail = tool?["error_summary"]?.stringValue ?? tool?["content_summary"]?.stringValue
            let exit = tool?["exit_code"]?.doubleValue.map { Int($0) }
            if let i = idx, i < blocks.count, case .tool(let id, var b) = blocks[i] {
                b.status = status
                if let detail {
                    // The result's detail replaces the call's: re-bound and
                    // re-count the delta so the invariant stays true.
                    let bounded = bound(detail, cap: toolFieldCap, keepTail: false)
                    textChars += bounded.count - (b.detail?.count ?? 0)
                    b.detail = bounded
                }
                if let exit { b.exitCode = exit }
                textChars += (outcome?.shellId?.count ?? 0) - (b.commandOutcome?.shellId?.count ?? 0)
                b.commandOutcome = outcome
                blocks[i] = .tool(id: id, b)
                if let useId { openToolByUseId.removeValue(forKey: ToolKey(stream: stream, id: useId)) }
                else if let name { openIdlessToolsByName.removeValue(forKey: ToolKey(stream: stream, id: name)) }
                if let useId, outcome?.state == .backgrounded { handoffToolIndexByUseId[ToolKey(stream: stream, id: useId)] = i }
                enforceBudget()
            } else {
                // A result with no matching call (e.g. reconnect mid-tool): show it standalone.
                var block = boundedTool(name: name ?? "tool", kind: tool?["kind"]?.stringValue, target: tool?["target"]?.stringValue, status: status, detail: detail, exitCode: exit)
                block.commandOutcome = outcome
                append(.tool(id: "tool-\(seqKey)", block))
                if let useId, outcome?.state == .backgrounded { handoffToolIndexByUseId[ToolKey(stream: stream, id: useId)] = blocks.count - 1 }
            }
            return true
        default:
            return false
        }
    }

    /// #546: a `command_outcome_refined` row replaces the command facts of the card whose result
    /// handed the command to a background shell, found by its own try and exact use id only (never
    /// by name), once, even after a later native turn. It must be a reported completion with a
    /// defined status: a status row cannot prove an exit, so it never changes the card's status,
    /// adds no card and sets no exit code. Anything else leaves the handoff.
    private mutating func applyRefinement(_ payload: JSONValue) -> Bool {
        guard payload["payload"]?["code"]?.stringValue == "command_outcome_refined",
              let key = payload["tool"]?["use_id"]?.stringValue.map({ ToolKey(stream: StreamKey(payload), id: $0) }),
              let i = handoffToolIndexByUseId[key], i < blocks.count,
              case .tool(let id, var b) = blocks[i],
              let reported = ToolBlock.CommandOutcome(payload["tool"]?["command_outcome"]),
              reported.state == .completionReported, reported.completionStatus != nil,
              let outcome = boundedOutcome(reported)
        else { return false }
        handoffToolIndexByUseId.removeValue(forKey: key)
        textChars += (outcome.shellId?.count ?? 0) - (b.commandOutcome?.shellId?.count ?? 0)
        b.commandOutcome = outcome
        blocks[i] = .tool(id: id, b)
        enforceBudget()
        return true
    }

    /// Fold one engine receipt, once per `id` (live, replayed or restored from
    /// a snapshot row). `atStart` places a receipt restored after later blocks
    /// before them: it was emitted before its executor's first event. Its text
    /// keeps the same per-block bound as every other block, disclosed. A
    /// restored receipt with no room before a full window would be the first
    /// block evicted: it is counted once as an earlier block not shown, with no
    /// bound disclosed for text that was never placed.
    @discardableResult
    public mutating func applyNotice(id: String, _ notice: TranscriptNotice, atStart: Bool = false) -> Bool {
        if accountedNoticeIds.contains(id) || blocks.contains(where: { $0.id == id }) { return false }
        if atStart, !blocks.isEmpty {
            let size = clip(notice.title, cap: toolFieldCap, keepTail: false).count
                + clip(notice.text, cap: blockCharCap, keepTail: false).count
            if blocks.count >= cap || textChars + size > totalCharBudget {
                accountedNoticeIds.insert(id)
                trimmed += 1
                return false
            }
        }
        let block = TranscriptBlock.notice(id: id, TranscriptNotice(
            title: bound(notice.title, cap: toolFieldCap, keepTail: false),
            text: boundHead(notice.text), warning: notice.warning))
        guard atStart, !blocks.isEmpty else {
            append(block)
            return true
        }
        blocks.insert(block, at: 0)
        textChars += chars(of: block)
        shiftToolIndices { $0 + 1 }
        enforceBudget()
        return true
    }

    /// Keep the newest `blockCharCap` characters (live-progress semantics).
    private mutating func boundTail(_ text: String) -> String {
        bound(text, cap: blockCharCap, keepTail: true)
    }

    /// Keep the first `blockCharCap` characters (one-shot message semantics).
    private mutating func boundHead(_ text: String) -> String {
        bound(text, cap: blockCharCap, keepTail: false)
    }

    /// One accounting choke-point for every cut: the cost is always disclosed.
    private mutating func bound(_ text: String, cap: Int, keepTail: Bool) -> String {
        let clipped = clip(text, cap: cap, keepTail: keepTail)
        truncatedChars += text.count - clipped.count
        return clipped
    }

    /// The PURE head/tail clip `bound` performs — no `truncatedChars` disclosure
    /// side effect, so an identity check (removeFinalizedTwin) can reproduce
    /// EXACTLY how a block was stored without double-counting a truncation.
    private func clip(_ text: String, cap: Int, keepTail: Bool) -> String {
        guard text.count > cap else { return text }
        return String(keepTail ? text.suffix(cap) : text.prefix(cap))
    }

    /// A tool block with EVERY harness-supplied string hard-bounded (they are
    /// not engine-bounded: a raw command target can be megabytes).
    private mutating func boundedTool(name: String, kind: String?, target: String?,
                                      status: ToolBlock.Status, detail: String?, exitCode: Int?) -> ToolBlock {
        ToolBlock(
            name: bound(name, cap: toolFieldCap, keepTail: false),
            kind: kind.map { bound($0, cap: toolFieldCap, keepTail: false) },
            target: target.map { bound($0, cap: toolFieldCap, keepTail: false) },
            status: status,
            detail: detail.map { bound($0, cap: toolFieldCap, keepTail: false) },
            exitCode: exitCode
        )
    }

    /// The command facts' one free-form string (the vendor shell handle) gets
    /// the same per-field bound as every other harness-supplied tool string.
    private mutating func boundedOutcome(_ outcome: ToolBlock.CommandOutcome?) -> ToolBlock.CommandOutcome? {
        guard var outcome else { return nil }
        outcome.shellId = outcome.shellId.map { bound($0, cap: toolFieldCap, keepTail: false) }
        return outcome
    }

    /// Counted text of a block — every retained string, tool fields included
    /// (the invariant must cover ALL unbounded inputs, review sol #2).
    private func chars(of block: TranscriptBlock) -> Int {
        switch block {
        case .thinking(_, let text, _): return text.count
        case .message(_, let text): return text.count
        case .tool(_, let b):
            return b.name.count + (b.kind?.count ?? 0) + (b.target?.count ?? 0) + (b.detail?.count ?? 0)
                + (b.commandOutcome?.shellId?.count ?? 0)
        case .notice(_, let notice): return notice.title.count + notice.text.count
        }
    }

    /// Evict oldest whole blocks until both bounds hold (count AND text chars).
    private mutating func enforceBudget() {
        var drop = 0
        var remaining = textChars
        while (blocks.count - drop > cap) || (remaining > totalCharBudget && blocks.count - drop > 1) {
            remaining -= chars(of: blocks[drop])
            drop += 1
        }
        guard drop > 0 else { return }
        for case .notice(let id, _) in blocks.prefix(drop) { accountedNoticeIds.insert(id) }
        blocks.removeFirst(drop)
        textChars = remaining
        trimmed += drop
        // Surviving blocks shifted down by `drop`: SHIFT the open-tool indices
        // to match (clearing them would orphan still-open tools so their
        // tool_result lands as a duplicate block — review r2 #5). Entries that
        // fell out of the window are dropped.
        shiftToolIndices { $0 - drop >= 0 ? $0 - drop : nil }
    }

    /// Re-point every tool card index after blocks moved; nil drops one that left the window.
    private mutating func shiftToolIndices(_ move: (Int) -> Int?) {
        openToolByUseId = openToolByUseId.compactMapValues(move)
        openIdlessToolsByName = openIdlessToolsByName.compactMapValues { let kept = $0.compactMap(move); return kept.isEmpty ? nil : kept }
        handoffToolIndexByUseId = handoffToolIndexByUseId.compactMapValues(move)
    }

    /// Remove the finalization TWIN — the candidate message block, but only when
    /// its retained text IS the (head-bounded) final text. The block was stored
    /// via `boundHead`, so the identity check compares against the SAME `clip`
    /// `boundHead` uses (head, `blockCharCap`) — an overlong answer's block equals
    /// the final's head, and reusing that one function keeps the comparison exact
    /// without re-counting a truncation. A distinct narration never matches and stays.
    /// Keeps every reducer invariant: decrement `textChars` exactly and shift the
    /// open-tool indices that sat AFTER the removed block so a still-open tool's
    /// later result still lands on the right row. `trimmed`/`truncatedChars` are
    /// eviction/overlong disclosures and are left untouched (this is neither). A
    /// no-op if the id was already evicted or the text diverged.
    private mutating func removeFinalizedTwin(_ id: String?, finalText: String) {
        guard let id,
              let i = blocks.lastIndex(where: { $0.id == id }),
              case .message(_, let text) = blocks[i],
              text == clip(finalText, cap: blockCharCap, keepTail: false) else { return }
        textChars -= text.count
        blocks.remove(at: i)
        shiftToolIndices { $0 > i ? $0 - 1 : $0 }
    }

    private mutating func append(_ block: TranscriptBlock) {
        // Anything but a thinking-merge CLOSES the open reasoning segment: the
        // next thinking event starts a new segment (and a new timer). Any
        // non-message block likewise closes the open streaming message.
        if case .thinking = block {} else {
            openThinkingStart = nil
            openThinkingStream = nil
        }
        // A non-message block ends every APPENDABLE delta stream (the next delta
        // is a new message), but `pendingFlushId` survives so a later complete
        // flush still reconciles the pre-tool block by id (confirm #1).
        if case .message = block {} else {
            for key in streams.keys { streams[key]?.streamingMessageId = nil }
        }
        blocks.append(block)
        textChars += chars(of: block)
        enforceBudget()
    }

    /// Observed span of the open reasoning segment; 0 while unknown (missing
    /// or unparsable event timestamps) — the UI hides a zero timer.
    private func segmentSeconds(until eventAt: Date?) -> Double {
        guard let start = openThinkingStart, let eventAt else { return 0 }
        return max(0, eventAt.timeIntervalSince(start))
    }

    static func isoDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        // Value-type Sendable parse strategies (ISO8601DateFormatter is not
        // concurrency-safe under Swift 6): fractional first, then plain.
        return (try? Date(raw, strategy: .iso8601.time(includingFractionalSeconds: true)))
            ?? (try? Date(raw, strategy: .iso8601))
    }
}
