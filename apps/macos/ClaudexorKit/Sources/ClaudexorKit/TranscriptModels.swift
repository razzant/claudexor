import Foundation

/// One rendered unit of a turn's live transcript. The reducer folds the raw
/// `harness.event` SSE stream into these so the chat shows working progress
/// (reasoning + tools) as it happens, not just the final answer (v0.10 Р7).
public enum TranscriptBlock: Identifiable, Sendable, Equatable {
    case thinking(id: String, text: String)
    case message(id: String, text: String)
    case tool(id: String, ToolBlock)

    public var id: String {
        switch self {
        case .thinking(let id, _): return id
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
}

/// Pure fold of SSE envelopes into transcript blocks. No UI, no I/O — unit
/// tested. Idempotent by `seq` (a replayed event never duplicates a block);
/// consecutive `thinking` blocks merge; a `tool_result` updates the matching
/// `tool_call` by `use_id` (fallback: the last open tool of the same name).
public struct TranscriptReducer: Sendable {
    public private(set) var blocks: [TranscriptBlock] = []
    /// Number of oldest blocks dropped to stay under `cap` (shown as "N earlier…").
    public private(set) var trimmed: Int = 0

    /// Highest seq already folded — idempotent replay without an unbounded Set.
    private var lastSeq: Int = -1
    private var toolIndexByUseId: [String: Int] = [:]
    private var lastOpenToolByName: [String: Int] = [:]
    private let cap: Int

    public init(cap: Int = 200) { self.cap = cap }

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
            if case .thinking(let id, let prev) = blocks.last {
                blocks[blocks.count - 1] = .thinking(id: id, text: prev + "\n" + text)
            } else {
                append(.thinking(id: "th-\(seqKey)", text: text))
            }
            return true
        case "message":
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return false }
            append(.message(id: "msg-\(seqKey)", text: text))
            return true
        case "tool_call":
            let tool = payload["tool"]
            let block = ToolBlock(
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
                if let detail { b.detail = detail }
                if let exit { b.exitCode = exit }
                blocks[i] = .tool(id: id, b)
                if let useId { toolIndexByUseId.removeValue(forKey: useId) }
                if let name { lastOpenToolByName.removeValue(forKey: name) }
            } else {
                // A result with no matching call (e.g. reconnect mid-tool): show it standalone.
                append(.tool(id: "tool-\(seqKey)", ToolBlock(name: name ?? "tool", kind: tool?["kind"]?.stringValue, target: tool?["target"]?.stringValue, status: status, detail: detail, exitCode: exit)))
            }
            return true
        default:
            return false
        }
    }

    private mutating func append(_ block: TranscriptBlock) {
        blocks.append(block)
        if blocks.count > cap {
            let drop = blocks.count - cap
            blocks.removeFirst(drop)
            trimmed += drop
            // Surviving blocks shifted down by `drop`: SHIFT the open-tool indices
            // to match (clearing them would orphan still-open tools so their
            // tool_result lands as a duplicate block — review r2 #5). Entries that
            // fell out of the window are dropped.
            toolIndexByUseId = toolIndexByUseId.compactMapValues { $0 - drop >= 0 ? $0 - drop : nil }
            lastOpenToolByName = lastOpenToolByName.compactMapValues { $0 - drop >= 0 ? $0 - drop : nil }
        }
    }
}
