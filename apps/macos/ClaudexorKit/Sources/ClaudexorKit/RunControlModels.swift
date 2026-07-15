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
