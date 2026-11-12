import Foundation

public struct WorkspaceCaptureFailureInfo: Codable, Sendable, Equatable, Hashable {
    public let code: String
    public let message: String
    public let causeCode: String?
    public let bufferBudgetBytes: Int?
    public let stream: String?
    public let drain: String?
    public let cleanup: Cleanup?
    public struct Cleanup: Codable, Sendable, Equatable, Hashable {
        public let code: String?
        public let message: String
    }
}

public struct RunFailureInfo: Codable, Sendable, Equatable, Hashable {
    public let captureFailure: WorkspaceCaptureFailureInfo?
    public let phase: String
    public let category: String
    /// Machine-readable sub-code used for exact remediation. Optional keeps
    /// pre-code runtimes decodable without parsing safeMessage.
    public let code: String?
    public let harnessId: String?
    public let attemptId: String?
    public let safeMessage: String
    public let rawDetailRef: String?
    public let logRefs: [String]
    public let eventRefs: [String]
    public let runDir: String?
    public let nextActions: [String]
    /// STRUCTURAL reopen time of the window this run was refused against (e.g.
    /// `subscription_window_exhausted`); nil when the refusal has none. The
    /// wire always carries the key, so dropping it forced every surface to
    /// parse "resets …" out of `safeMessage` — which is what it exists to end.
    public let resetsAt: String?
    /// Every failed execution try in order, each with its own account and
    /// error text; empty for a record written before the field existed.
    public let poolAttempts: [PoolAttemptFailureInfo]
    /// Typed sizes behind `raw_context_exceeds_window` (#147); never read from `safeMessage`.
    public let rawContextShortfall: RawContextShortfallInfo?

    enum CodingKeys: String, CodingKey {
        case captureFailure, phase, category, code, harnessId, attemptId, safeMessage, rawDetailRef, logRefs, eventRefs, runDir, nextActions, resetsAt, poolAttempts, rawContextShortfall
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        captureFailure = try c.decodeIfPresent(WorkspaceCaptureFailureInfo.self, forKey: .captureFailure)
        phase = try c.decodeIfPresent(String.self, forKey: .phase) ?? "unknown"
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? "unknown"
        code = try c.decodeIfPresent(String.self, forKey: .code)
        harnessId = try c.decodeIfPresent(String.self, forKey: .harnessId)
        attemptId = try c.decodeIfPresent(String.self, forKey: .attemptId)
        safeMessage = try c.decode(String.self, forKey: .safeMessage)
        rawDetailRef = try c.decodeIfPresent(String.self, forKey: .rawDetailRef)
        logRefs = try c.decodeIfPresent([String].self, forKey: .logRefs) ?? []
        eventRefs = try c.decodeIfPresent([String].self, forKey: .eventRefs) ?? []
        runDir = try c.decodeIfPresent(String.self, forKey: .runDir)
        nextActions = try c.decodeIfPresent([String].self, forKey: .nextActions) ?? []
        resetsAt = try c.decodeIfPresent(String.self, forKey: .resetsAt)
        poolAttempts = try c.decodeIfPresent([PoolAttemptFailureInfo].self, forKey: .poolAttempts) ?? []
        rawContextShortfall = try c.decodeIfPresent(RawContextShortfallInfo.self, forKey: .rawContextShortfall)
    }
}

/// One failed execution try attributed to the account it ran on (diagnostic
/// evidence; the engine's retry and routing never read it).
public struct PoolAttemptFailureInfo: Codable, Sendable, Equatable, Hashable {
    public let harnessId: String
    public let profileId: String?
    public let profileDisplayName: String?
    public let requestedModel: String?
    public let attemptId: String
    public let tryIndex: Int
    public let observedAt: String
    /// pre_start | pre_progress | after_progress.
    public let phase: String
    public let category: String
    /// The try's own error text, redacted by the engine.
    public let error: String
    public let vendorFailure: VendorFailureInfo?
}

/// The vendor's own typed failure, verbatim: display it, never branch on it.
public struct VendorFailureInfo: Codable, Sendable, Equatable, Hashable {
    public let code: String?
    public let message: String?
    public let source: String
}
