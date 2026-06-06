import Foundation

/// One sequence-numbered envelope from the control-api SSE stream. `seq` is the
/// SSE id used for Last-Event-ID resume; `kind` discriminates the payload
/// ("run" = RunEvent, "harness" = HarnessEvent, "gap"/"error"/"end" = control).
public struct BusEnvelope: Sendable, Equatable {
    public let seq: Int
    public let kind: String
    public let event: JSONValue

    public init(seq: Int, kind: String, event: JSONValue) {
        self.seq = seq
        self.kind = kind
        self.event = event
    }
}

/// Command to start a run (POST /runs). Mirrors the orchestrator RunInput subset
/// a client supplies; the server fills the rest.
public struct StartRunRequest: Codable, Sendable {
    public var prompt: String
    public var mode: String?
    public var harnesses: [String]?
    public var n: Int?

    public init(prompt: String, mode: String? = nil, harnesses: [String]? = nil, n: Int? = nil) {
        self.prompt = prompt
        self.mode = mode
        self.harnesses = harnesses
        self.n = n
    }
}

/// Response from POST /runs once the run id is known (returned early by the server).
public struct RunStartInfo: Codable, Sendable, Equatable {
    public let runId: String
    public let taskId: String
    public let runDir: String
}

public struct RunSummary: Codable, Sendable, Identifiable, Equatable {
    public let runId: String
    public let state: String
    public let runDir: String?
    public var id: String { runId }
}

public struct RunListResponse: Codable, Sendable {
    public let runs: [RunSummary]
}

public enum GatewayError: Error, Sendable, Equatable {
    case http(status: Int, body: String)
    case decoding(String)
    case transport(String)
}
