/// Result of POST /runs/:id/apply (delivery DeliverResult projection).
public struct DeliveryGateResult: Codable, Sendable, Equatable, Hashable {
    public let id: String
    public let status: String
}

public struct DeliveryFinalVerify: Codable, Sendable, Equatable, Hashable {
    public let attempted: Bool
    public let baseSha: String?
    public let appliedCleanly: Bool?
    public let gatesPassed: Bool?
    public let gates: [DeliveryGateResult]
    public let durationMs: Double?
    public let reason: String?

    enum CodingKeys: String, CodingKey {
        case attempted, gates, reason
        case baseSha = "base_sha"
        case appliedCleanly = "applied_cleanly"
        case gatesPassed = "gates_passed"
        case durationMs = "duration_ms"
    }
}

public struct ApplyResultInfo: Codable, Sendable, Equatable, Hashable {
    public let mode: String
    public let applied: Bool
    public let branch: String?
    public let commit: String?
    public let prUrl: String?
    public let detail: String?
    public let treeMutated: Bool?
    public let refused: Bool?
    public let finalVerify: DeliveryFinalVerify
    public let targetPreimageSha: String
}

public struct ReviewerPanelEntry: Codable, Sendable, Equatable, Hashable {
    public var harness: String
    public var model: String?
    public var effort: String?

    public init(harness: String, model: String? = nil, effort: String? = nil) {
        self.harness = harness
        self.model = model
        self.effort = effort
    }
}

public struct ProtectedPathApproval: Codable, Sendable, Equatable, Hashable {
    public var path: String
    public var reason: String?

    public init(path: String, reason: String? = nil) {
        self.path = path
        self.reason = reason
    }
}

public struct TestCommandInvocation: Codable, Sendable, Equatable, Hashable {
    public var program: String
    public var args: [String]
    public var cwd: String?
    public var envAllowlist: [String]

    public init(program: String, args: [String] = [], cwd: String? = nil,
                envAllowlist: [String] = []) {
        self.program = program
        self.args = args
        self.cwd = cwd
        self.envAllowlist = envAllowlist
    }
}
