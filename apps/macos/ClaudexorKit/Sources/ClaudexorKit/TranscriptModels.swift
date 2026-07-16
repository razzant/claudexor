import Foundation

/// One rendered unit of a turn's live transcript. The reducer folds the raw
/// `harness.event` SSE stream into these so the chat shows working progress
/// (reasoning + tools) as it happens, not just the final answer.
public enum TranscriptBlock: Identifiable, Sendable, Equatable {
    /// One merged reasoning SEGMENT (consecutive thinking between other
    /// blocks); `seconds` is the segment's observed wall-clock span from the
    /// events' own timestamps (0 while unknown — the UI hides the timer).
    case thinking(id: String, text: String, seconds: Double = 0)
    case message(id: String, text: String)
    case tool(id: String, ToolBlock)

    public var id: String {
        switch self {
        case .thinking(let id, _, _): return id
        case .message(let id, _): return id
        case .tool(let id, _): return id
        }
    }
}

public struct ToolBlock: Sendable, Equatable {
    public enum Status: String, Sendable { case running, ok, error }
    public var name: String
    public var kind: String?
    public var target: String?
    public var status: Status
    public var detail: String?      // content_summary / error_summary
    public var exitCode: Int?

    public init(name: String, kind: String? = nil, target: String? = nil,
                status: Status, detail: String? = nil, exitCode: Int? = nil) {
        self.name = name
        self.kind = kind
        self.target = target
        self.status = status
        self.detail = detail
        self.exitCode = exitCode
    }
}

/// Pure fold of SSE envelopes into transcript blocks. No UI, no I/O — unit
/// tested. Idempotent by `seq` (a replayed event never duplicates a block);
/// consecutive `thinking` blocks merge; a `tool_result` updates the matching
/// `tool_call` by `use_id` (fallback: the last open tool of the same name).
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
    private var toolIndexByUseId: [String: Int] = [:]
    private var lastOpenToolByName: [String: Int] = [:]
    /// Wall-clock start of the OPEN thinking segment (from the events' own
    /// `ts`), so the merged block can disclose how long the reasoning ran.
    private var openThinkingStart: Date?
    /// True while the last block is a delta-built streaming message (W-C4):
    /// deltas append into it; the complete message REPLACES it (no doubling).
    private var openStreamingMessage = false
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

    /// Apply one envelope. Only `harness.event` run events contribute; everything
    /// else is ignored. Returns true if the transcript changed.
    ///
    /// The per-run SSE sets `BusEnvelope.kind` to the event NAME (e.g.
    /// "harness.event"), not the literal "run" — so we discriminate on the RunEvent
    /// `type` field inside `event`, never on `kind` (review #11). Idempotency is by
    /// monotonic `seq` (SSE replays in order), so there is no unbounded seen-set.
    @discardableResult
    public mutating func apply(_ env: BusEnvelope) -> Bool {
        if env.seq <= lastSeq { return false }   // already folded (replay)
        guard env.event["type"]?.stringValue == "harness.event" else {
            lastSeq = max(lastSeq, env.seq)
            return false
        }
        lastSeq = env.seq
        guard let payload = env.event["payload"] else { return false }
        let evType = payload["type"]?.stringValue
        let seqKey = String(env.seq)
        switch evType {
        case "thinking":
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return false }
            let eventAt = Self.isoDate(payload["ts"]?.stringValue)
            if case .thinking(let id, let prev, _) = blocks.last {
                // Keep the TAIL of an overlong merge: the live feed shows the
                // newest reasoning; the cut is counted, never silent.
                let bounded = boundTail(prev + "\n" + text)
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
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return false }
            // A TYPED final message (claude/cursor result, codex finalized
            // last agent message) IS the answer bubble — repeating it in the
            // live transcript would double the text the user just read.
            if payload["final"]?.boolValue == true { return false }
            // Live deltas (W-C4) grow ONE streaming block; the complete
            // message then REPLACES it (authoritative text, no doubling).
            if payload["delta"]?.boolValue == true {
                if openStreamingMessage, case .message(let id, let prev) = blocks.last {
                    let bounded = boundHead(prev + text)
                    textChars += bounded.count - prev.count
                    blocks[blocks.count - 1] = .message(id: id, text: bounded)
                    enforceBudget()
                } else {
                    append(.message(id: "msg-\(seqKey)", text: boundHead(text)))
                    openStreamingMessage = true
                }
                return true
            }
            if openStreamingMessage, case .message(let id, let prev) = blocks.last {
                let bounded = boundHead(text)
                textChars += bounded.count - prev.count
                blocks[blocks.count - 1] = .message(id: id, text: bounded)
                openStreamingMessage = false
                enforceBudget()
                return true
            }
            // A message is a one-shot: keep the HEAD (the answer's beginning);
            // the full text lives in the run's artifacts.
            append(.message(id: "msg-\(seqKey)", text: boundHead(text)))
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
            let idx = blocks.count - 1
            if let useId = tool?["use_id"]?.stringValue { toolIndexByUseId[useId] = idx }
            lastOpenToolByName[block.name] = idx
            return true
        case "tool_result":
            let tool = payload["tool"]
            let useId = tool?["use_id"]?.stringValue
            let name = tool?["name"]?.stringValue
            let idx = (useId.flatMap { toolIndexByUseId[$0] }) ?? (name.flatMap { lastOpenToolByName[$0] })
            let statusStr = tool?["status"]?.stringValue
            let status: ToolBlock.Status = statusStr == "error" ? .error : .ok
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
                blocks[i] = .tool(id: id, b)
                if let useId { toolIndexByUseId.removeValue(forKey: useId) }
                if let name { lastOpenToolByName.removeValue(forKey: name) }
                enforceBudget()
            } else {
                // A result with no matching call (e.g. reconnect mid-tool): show it standalone.
                append(.tool(id: "tool-\(seqKey)", boundedTool(name: name ?? "tool", kind: tool?["kind"]?.stringValue, target: tool?["target"]?.stringValue, status: status, detail: detail, exitCode: exit)))
            }
            return true
        default:
            return false
        }
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
        guard text.count > cap else { return text }
        truncatedChars += text.count - cap
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

    /// Counted text of a block — every retained string, tool fields included
    /// (the invariant must cover ALL unbounded inputs, review sol #2).
    private func chars(of block: TranscriptBlock) -> Int {
        switch block {
        case .thinking(_, let text, _): return text.count
        case .message(_, let text): return text.count
        case .tool(_, let b):
            return b.name.count + (b.kind?.count ?? 0) + (b.target?.count ?? 0) + (b.detail?.count ?? 0)
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
        blocks.removeFirst(drop)
        textChars = remaining
        trimmed += drop
        // Surviving blocks shifted down by `drop`: SHIFT the open-tool indices
        // to match (clearing them would orphan still-open tools so their
        // tool_result lands as a duplicate block — review r2 #5). Entries that
        // fell out of the window are dropped.
        toolIndexByUseId = toolIndexByUseId.compactMapValues { $0 - drop >= 0 ? $0 - drop : nil }
        lastOpenToolByName = lastOpenToolByName.compactMapValues { $0 - drop >= 0 ? $0 - drop : nil }
    }

    private mutating func append(_ block: TranscriptBlock) {
        // Anything but a thinking-merge CLOSES the open reasoning segment: the
        // next thinking event starts a new segment (and a new timer). Any
        // non-message block likewise closes the open streaming message.
        if case .thinking = block {} else { openThinkingStart = nil }
        if case .message = block {} else { openStreamingMessage = false }
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
