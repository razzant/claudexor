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

/// A delivery's typed refusal: its code and the paths it concerns (for a directory
/// delivery out of room, the path it stopped at).
public struct DeliveryRefusalInfo: Codable, Sendable, Equatable, Hashable {
    public let code: String
    public let message: String?
    public let paths: [String]?
}

public struct ApplyResultInfo: Codable, Sendable, Equatable, Hashable {
    public let mode: String
    public let applied: Bool
    /// Paths this delivery completed (written before it stopped when it did not apply).
    public let appliedPaths: [String]?
    public let branch: String?
    public let commit: String?
    public let prUrl: String?
    public let detail: String?
    public let treeMutated: Bool?
    public let refused: Bool?
    public let refusal: DeliveryRefusalInfo?
    public let finalVerify: DeliveryFinalVerify
    public let targetPreimageSha: String

    /// What a delivery that did not apply did, worded as the engine's
    /// `deliveryEffectsStatement`: its detail, typed refusal and stopped path, the
    /// paths it completed and whether the target changed with none completed.
    public var effectsStatement: String? {
        if applied { return detail }
        let stopped = refusal?.paths ?? []
        let completed = appliedPaths ?? []
        func listed(_ paths: [String]) -> String {
            let head = paths.prefix(20).joined(separator: ", ")
            return paths.count > 20 ? "\(head) and \(paths.count - 20) more" : head
        }
        var parts: [String] = []
        if let detail { parts.append(detail) }
        if let refusal {
            parts.append("Refusal: \(refusal.code)\(stopped.isEmpty ? "" : " at \(listed(stopped))").")
        }
        if !completed.isEmpty { parts.append("Completed before it stopped: \(listed(completed)).") }
        if treeMutated == true {
            if completed.isEmpty {
                parts.append("No path completed, but the target changed\(stopped.isEmpty ? "" : " at \(listed(stopped))"): inspect it.")
            } else if !stopped.isEmpty {
                parts.append("Where it stopped, the target may already be changed.")
            }
        } else if refusal != nil {
            parts.append("Nothing was written.")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}

/// Advisory service preference for the selected model (schema `ProcessingPreference`).
/// A value outside this set fails decoding instead of being dropped.
public enum ProcessingPreference: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case standard, fast, ultrafast, economy
}

public struct ReviewerPanelEntry: Codable, Sendable, Equatable, Hashable {
    public var harness: String
    public var model: String?
    public var effort: String?
    public var credentialProfileId: String?
    /// This reviewer's own processing preference; nil sends no field.
    public var processingPreference: ProcessingPreference?

    private enum CodingKeys: String, CodingKey, StrictCodingKey {
        case harness, model, effort, credentialProfileId, processingPreference
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        harness = try container.decode(String.self, forKey: .harness)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        effort = try container.decodeIfPresent(String.self, forKey: .effort)
        credentialProfileId = try container.decodeIfPresent(String.self, forKey: .credentialProfileId)
        processingPreference = try container.decodeIfPresent(ProcessingPreference.self, forKey: .processingPreference)
    }

    public init(harness: String, model: String? = nil, effort: String? = nil,
                credentialProfileId: String? = nil, processingPreference: ProcessingPreference? = nil) {
        self.harness = harness
        self.model = model
        self.effort = effort
        self.credentialProfileId = credentialProfileId
        self.processingPreference = processingPreference
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
