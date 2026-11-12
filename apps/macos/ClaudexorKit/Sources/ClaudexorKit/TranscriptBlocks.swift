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
    /// An engine-authored receipt (e.g. what an isolated copy was prepared with).
    case notice(id: String, TranscriptNotice)

    public var id: String {
        switch self {
        case .thinking(let id, _, _): return id
        case .message(let id, _): return id
        case .tool(let id, _): return id
        case .notice(let id, _): return id
        }
    }
}

public struct ToolBlock: Sendable, Equatable {
    /// `unconfirmed`: the result did not establish that the command finished (moved to a
    /// background shell, timed out, or an unrecognized outcome, #450). It is never shown as
    /// success; a later `command_outcome_refined` row may refine a handoff's facts (#546: a
    /// completion reported without an exit code), which keeps it unconfirmed.
    public enum Status: String, Sendable { case running, ok, error, unconfirmed }

    /// The typed `command_outcome` facts of a result (#450), as far as the
    /// transcript shows them.
    public struct CommandOutcome: Sendable, Equatable {
        public enum State: String, Sendable {
            case exited, timedOut = "timed_out", backgrounded, completionReported = "completion_reported", unknown
        }
        public enum BackgroundReason: String, Sendable { case timeout, requested }
        /// The vendor's report of how a background command ended (#546), as far
        /// as a protocol source defines it; never an exit code.
        public enum CompletionStatus: String, Sendable { case success, error, aborted }
        public var state: State
        public var timeoutMs: Int?
        public var backgroundReason: BackgroundReason?
        public var shellId: String?
        public var pid: Int?
        public var completionStatus: CompletionStatus?

        public init(state: State, timeoutMs: Int? = nil, backgroundReason: BackgroundReason? = nil,
                    shellId: String? = nil, pid: Int? = nil, completionStatus: CompletionStatus? = nil) {
            self.state = state
            self.timeoutMs = timeoutMs
            self.backgroundReason = backgroundReason
            self.shellId = shellId
            self.pid = pid
            self.completionStatus = completionStatus
        }

        /// Present facts; an unrecognized state is `unknown`, never an exit
        /// (mirrors the schema's `commandOutcomeUnconfirmed`).
        init?(_ value: JSONValue?) {
            guard let value, value != .null else { return nil }
            func integer(_ key: String, minimum: Double) -> Int? {
                guard let number = value[key]?.doubleValue, number >= minimum,
                      number == number.rounded(), number <= 9_007_199_254_740_991 else { return nil }
                return Int(number)
            }
            state = value["state"]?.stringValue.flatMap(State.init(rawValue:)) ?? .unknown
            timeoutMs = integer("timeout_ms", minimum: 0)
            backgroundReason = value["background_reason"]?.stringValue.flatMap(BackgroundReason.init(rawValue:))
            shellId = value["shell_id"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            pid = integer("pid", minimum: 1)
            completionStatus = value["completion_status"]?.stringValue.flatMap(CompletionStatus.init(rawValue:))
        }

        public var unconfirmed: Bool { state != .exited }
    }

    public var name: String
    public var kind: String?
    public var target: String?
    public var status: Status
    public var detail: String?      // content_summary / error_summary
    public var exitCode: Int?
    public var commandOutcome: CommandOutcome?

    public init(name: String, kind: String? = nil, target: String? = nil,
                status: Status, detail: String? = nil, exitCode: Int? = nil,
                commandOutcome: CommandOutcome? = nil) {
        self.name = name
        self.kind = kind
        self.target = target
        self.status = status
        self.detail = detail
        self.exitCode = exitCode
        self.commandOutcome = commandOutcome
    }
}
