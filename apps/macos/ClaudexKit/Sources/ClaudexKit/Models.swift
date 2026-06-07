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

/// Command to start a run (POST /runs). Mirrors the orchestrator RunInput subset a client
/// supplies; the server fills the rest. Policy fields (maxUsd/access/tests/repoRoot) flow
/// through `daemon.enqueue` to `orchestrator.run` so the composer's controls are actually
/// applied (not just displayed).
public struct StartRunRequest: Codable, Sendable {
    public var prompt: String
    public var mode: String?
    public var harnesses: [String]?
    public var primaryHarness: String?
    public var portfolio: String?
    public var model: String?
    public var n: Int?
    public var maxUsd: Double?
    public var access: String?
    public var tests: [String]?
    public var repoRoot: String?

    public init(prompt: String, mode: String? = nil, harnesses: [String]? = nil,
                primaryHarness: String? = nil, portfolio: String? = nil, model: String? = nil,
                n: Int? = nil, maxUsd: Double? = nil, access: String? = nil,
                tests: [String]? = nil, repoRoot: String? = nil) {
        self.prompt = prompt
        self.mode = mode
        self.harnesses = harnesses
        self.primaryHarness = primaryHarness
        self.portfolio = portfolio
        self.model = model
        self.n = n
        self.maxUsd = maxUsd
        self.access = access
        self.tests = tests
        self.repoRoot = repoRoot
    }
}

/// Response from POST /runs once the run id is known (returned early by the server).
public struct RunStartInfo: Codable, Sendable, Equatable {
    public let runId: String
    public let taskId: String
    public let runDir: String
}

public struct RunSummary: Codable, Sendable, Identifiable, Equatable {
    public let jobId: String?
    public let runId: String
    public let taskId: String?
    public let state: String
    public let runDir: String?
    public let error: String?
    public let mode: String?
    public let prompt: String?
    public let harnesses: [String]?
    public let primaryHarness: String?
    public let portfolio: String?
    public let model: String?
    public let n: Int?
    public let maxUsd: Double?
    public let access: String?
    public let tests: [String]?
    public let createdAt: String?
    public let startedAt: String?
    public let finishedAt: String?
    public var id: String { runId }
}

public struct RunListResponse: Codable, Sendable {
    public let runs: [RunSummary]
}

public struct ArtifactInfo: Codable, Sendable, Identifiable, Equatable {
    public let path: String
    public let kind: String
    public let bytes: Int?
    public var id: String { path }
}

public struct RunDetail: Codable, Sendable, Equatable {
    public let summary: RunSummary
    public let artifacts: [ArtifactInfo]
    public let finalSummary: String?
    public let decision: JSONValue?
    public let workProduct: JSONValue?
}

public struct HarnessStatus: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let status: String
    public let reasons: [String]?
}

public struct HarnessListResponse: Codable, Sendable {
    public let harnesses: [HarnessStatus]
}

public struct ApplyCheckResult: Codable, Sendable, Equatable {
    public let ok: Bool
    public let code: Int?
    public let stderr: String
}

public struct SecretSetRequest: Codable, Sendable, Equatable {
    public let name: String
    public let value: String
    public init(name: String, value: String) {
        self.name = name
        self.value = value
    }
}

public enum GatewayError: Error, Sendable, Equatable {
    case http(status: Int, body: String)
    case decoding(String)
    case transport(String)
}
