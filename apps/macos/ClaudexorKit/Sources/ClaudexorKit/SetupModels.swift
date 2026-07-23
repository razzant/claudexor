public enum SetupHarness: String, Codable, Sendable, CaseIterable {
    case codex
    case claude
    case cursor
}

public enum SetupJobAction: String, Codable, Sendable, CaseIterable {
    case login
}

public enum AuthRequest: String, Codable, Sendable {
    case subscription
    case apiKey = "api_key"
    case auto
}

/// Request body for creating a daemon-owned setup job.
public struct SetupJobCreateRequest: Codable, Sendable, Equatable {
    public let harness: SetupHarness
    public let action: SetupJobAction
    public let authRequest: AuthRequest
    /// Target credential profile (INV-135). nil = the engine-default store; the
    /// key is emitted ONLY when set so a default login keeps the exact legacy body.
    public let profileId: String?
    /// D-17 codex-only login flow selection. Emitted ONLY when set so a default
    /// login keeps the exact legacy body (absent = app-server device-code).
    public let loginFlow: SetupCodexLoginFlow?

    public init(harness: SetupHarness, action: SetupJobAction, profileId: String? = nil,
                loginFlow: SetupCodexLoginFlow? = nil) {
        self.harness = harness
        self.action = action
        self.authRequest = .subscription
        self.profileId = profileId
        self.loginFlow = loginFlow
    }

    enum CodingKeys: String, CodingKey { case harness, action, authRequest, profileId, loginFlow }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(harness, forKey: .harness)
        try container.encode(action, forKey: .action)
        try container.encode(authRequest, forKey: .authRequest)
        try container.encodeIfPresent(profileId, forKey: .profileId)
        try container.encodeIfPresent(loginFlow, forKey: .loginFlow)
    }
}

/// D-17 codex login flow selection (request-side). Absent = the app-server
/// device-code default; `browserCallback` = the app-server browser-callback
/// opt-in; `browserRedirect` = the legacy Terminal localhost-callback fallback.
public enum SetupCodexLoginFlow: String, Codable, Sendable, CaseIterable {
    case deviceAuth = "device_auth"
    case browserCallback = "browser_callback"
    case browserRedirect = "browser_redirect"
}

/// The two app-server device-code flows surfaced on a disclosure.
public enum SetupAppServerLoginFlow: String, Codable, Sendable, CaseIterable {
    case chatgptDeviceCode
    case chatgpt
}

/// TRANSIENT device-code disclosure overlaid on a setup-job snapshot / SSE frame
/// at read time (D-17). Never part of the journaled `SetupJob`; the one-time
/// `userCode` is empty for the browser-callback flow.
public struct SetupDeviceCodeDisclosure: Codable, Sendable, Equatable {
    public let flow: SetupAppServerLoginFlow
    public let verificationUrl: String
    public let userCode: String

    public init(flow: SetupAppServerLoginFlow, verificationUrl: String, userCode: String) {
        self.flow = flow
        self.verificationUrl = verificationUrl
        self.userCode = userCode
    }

    /// Whether this disclosure carries a one-time code (device-code flow) vs a
    /// URL-only browser-callback flow.
    public var hasUserCode: Bool { !userCode.isEmpty }
}

public enum SetupJobState: String, Codable, Sendable, CaseIterable {
    case queued
    case running
    case waitingForInput = "waiting_for_input"
    case succeeded
    case failed
    case cancelled
    case timedOut = "timed_out"
    case interruptedUnknown = "interrupted_unknown"
    case notSupported = "not_supported"
}

public enum SetupJobPhase: String, Codable, Sendable, CaseIterable {
    case preparing
    case launching
    case awaitingUser = "awaiting_user"
    case verifying
    case cancelling
    case completed
}

public enum SetupJobOutcomeReason: String, Codable, Sendable, CaseIterable {
    case completed
    case notSupported = "not_supported"
    case launchFailed = "launch_failed"
    case commandFailed = "command_failed"
    case authNotReady = "auth_not_ready"
    case capabilityVerificationFailed = "capability_verification_failed"
    case credentialRouteMismatch = "credential_route_mismatch"
    case timedOut = "timed_out"
    case cancelledByUser = "cancelled_by_user"
    case cancelledOnRestart = "cancelled_on_restart"
    case interrupted
    case interruptedUnknown = "interrupted_unknown"
    case terminationUnconfirmed = "termination_unconfirmed"
}

public struct SetupJobOutcome: Codable, Sendable, Equatable {
    public let reason: SetupJobOutcomeReason
    public let exitCode: Int?
    public let signal: String?

    public init(reason: SetupJobOutcomeReason, exitCode: Int? = nil, signal: String? = nil) {
        self.reason = reason
        self.exitCode = exitCode
        self.signal = signal
    }
}

public struct SetupTerminationReconciliation: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable { case empty }

    public let status: Status
    public let observedAt: String

    public init(status: Status, observedAt: String) {
        self.status = status
        self.observedAt = observedAt
    }
}

public struct SetupJob: Codable, Sendable, Equatable {
    public let jobId: String
    public let harness: SetupHarness
    public let action: SetupJobAction
    /// Target credential profile (INV-135). The server always reports it — null
    /// for a default-store login, the profile id for a profile login.
    public let profileId: String?
    public let state: SetupJobState
    public let phase: SetupJobPhase
    public let deadlineAt: String?
    public let outcome: SetupJobOutcome?
    public let command: String?
    public let guideUrl: String?
    public let message: String
    public let createdAt: String
    public let startedAt: String?
    public let finishedAt: String?
    public let authCapability: AuthCapabilityLifecycle?
    public let execution: SetupExecutionEvidence?
    public let authorization: SetupCommandAuthorization?
    public let nativeCommand: SetupNativeCommandReceipt?
    public let terminationReconciliation: SetupTerminationReconciliation?

    enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case jobId, harness, action, profileId, state, phase, deadlineAt, outcome, command, guideUrl
        case message, createdAt, startedAt, finishedAt, authCapability, execution, authorization, nativeCommand
        case terminationReconciliation
    }

    public init(jobId: String, harness: SetupHarness, action: SetupJobAction, state: SetupJobState,
                phase: SetupJobPhase, deadlineAt: String? = nil, outcome: SetupJobOutcome? = nil,
                command: String? = nil, guideUrl: String? = nil, message: String,
                createdAt: String, startedAt: String? = nil, finishedAt: String? = nil,
                authCapability: AuthCapabilityLifecycle? = nil,
                execution: SetupExecutionEvidence? = nil,
                authorization: SetupCommandAuthorization? = nil,
                nativeCommand: SetupNativeCommandReceipt? = nil,
                terminationReconciliation: SetupTerminationReconciliation? = nil,
                profileId: String? = nil) {
        self.jobId = jobId
        self.harness = harness
        self.action = action
        self.profileId = profileId
        self.state = state
        self.phase = phase
        self.deadlineAt = deadlineAt
        self.outcome = outcome
        self.command = command
        self.guideUrl = guideUrl
        self.message = message
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.authCapability = authCapability
        self.execution = execution
        self.authorization = authorization
        self.nativeCommand = nativeCommand
        self.terminationReconciliation = terminationReconciliation
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try container.decode(String.self, forKey: .jobId)
        harness = try container.decode(SetupHarness.self, forKey: .harness)
        action = try container.decode(SetupJobAction.self, forKey: .action)
        // Present + nullable on the wire (null = default store); tolerate its
        // absence so an older daemon's job still decodes as the default account.
        profileId = container.contains(.profileId)
            ? try container.decodeIfPresent(String.self, forKey: .profileId)
            : nil
        state = try container.decode(SetupJobState.self, forKey: .state)
        phase = try container.decode(SetupJobPhase.self, forKey: .phase)
        deadlineAt = try container.decodeIfPresent(String.self, forKey: .deadlineAt)
        outcome = try container.decodeIfPresent(SetupJobOutcome.self, forKey: .outcome)
        command = try Self.decodeRequiredNullable(String.self, from: container, forKey: .command)
        guideUrl = try Self.decodeRequiredNullable(String.self, from: container, forKey: .guideUrl)
        message = try container.decode(String.self, forKey: .message)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        startedAt = try Self.decodeRequiredNullable(String.self, from: container, forKey: .startedAt)
        finishedAt = try Self.decodeRequiredNullable(String.self, from: container, forKey: .finishedAt)
        authCapability = try Self.decodeOptionalNonNull(AuthCapabilityLifecycle.self, from: container, forKey: .authCapability)
        execution = try Self.decodeOptionalNonNull(SetupExecutionEvidence.self, from: container, forKey: .execution)
        authorization = try Self.decodeOptionalNonNull(SetupCommandAuthorization.self, from: container, forKey: .authorization)
        nativeCommand = try Self.decodeOptionalNonNull(SetupNativeCommandReceipt.self, from: container, forKey: .nativeCommand)
        terminationReconciliation = try Self.decodeOptionalNonNull(SetupTerminationReconciliation.self, from: container, forKey: .terminationReconciliation)
        try validateEvidence(decoder: decoder)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(jobId, forKey: .jobId)
        try container.encode(harness, forKey: .harness)
        try container.encode(action, forKey: .action)
        try container.encodeIfPresent(profileId, forKey: .profileId)
        try container.encode(state, forKey: .state)
        try container.encode(phase, forKey: .phase)
        try container.encodeIfPresent(deadlineAt, forKey: .deadlineAt)
        try container.encodeIfPresent(outcome, forKey: .outcome)
        if let command { try container.encode(command, forKey: .command) } else { try container.encodeNil(forKey: .command) }
        if let guideUrl { try container.encode(guideUrl, forKey: .guideUrl) } else { try container.encodeNil(forKey: .guideUrl) }
        try container.encode(message, forKey: .message)
        try container.encode(createdAt, forKey: .createdAt)
        if let startedAt { try container.encode(startedAt, forKey: .startedAt) } else { try container.encodeNil(forKey: .startedAt) }
        if let finishedAt { try container.encode(finishedAt, forKey: .finishedAt) } else { try container.encodeNil(forKey: .finishedAt) }
        try container.encodeIfPresent(authCapability, forKey: .authCapability)
        try container.encodeIfPresent(execution, forKey: .execution)
        try container.encodeIfPresent(authorization, forKey: .authorization)
        try container.encodeIfPresent(nativeCommand, forKey: .nativeCommand)
        try container.encodeIfPresent(terminationReconciliation, forKey: .terminationReconciliation)
    }

    private func validateEvidence(decoder: Decoder) throws {
        func invalid(_ message: String) -> DecodingError {
            .dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: message))
        }
        guard let disclosure = authCapability?.disclosure,
              disclosure.harness == harness.rawValue,
              disclosure.requested == .subscription,
              disclosure.requiredRoute == .vendorNative,
              disclosure.requiredSource == .nativeSession else {
            throw invalid("Login setup requires exact native-subscription capability evidence")
        }
        if let receipt = authCapability?.receipt,
           receipt.harness != harness.rawValue || receipt.requested != disclosure.requested
            || receipt.requiredRoute != disclosure.requiredRoute
            || receipt.requiredSource != disclosure.requiredSource {
            throw invalid("Capability receipt contradicts its login job")
        }
        if let nativeCommand {
            guard let authorization,
                  nativeCommand.executionId == authorization.executionId,
                  nativeCommand.commandDigest == authorization.commandDigest,
                  nativeCommand.manifestDigest == authorization.manifestDigest else {
                throw invalid("Native command evidence does not match command authorization")
            }
            if let permit = nativeCommand.permitIssuedAt {
                guard let execution,
                      execution.permitIssuedAt == permit,
                      execution.executionId == nativeCommand.executionId,
                      execution.commandDigest == nativeCommand.commandDigest,
                      execution.manifestDigest == nativeCommand.manifestDigest else {
                    throw invalid("Native command permit does not match execution evidence")
                }
            }
        }
        // DEFAULT-store logins prove success with the exact-route capability
        // receipt. PROFILE jobs (INV-135) succeed on the profile's own doctor
        // probe with the smoke honestly skipped (authCapability stays
        // "disclosed") — mirrors the engine schema's profileId-scoped invariant.
        if state == .succeeded && profileId == nil {
            guard let receipt = authCapability?.receipt,
                  receipt.verification == .passed,
                  receipt.effective == .vendorNative,
                  receipt.effectiveSource == .nativeSession else {
                throw invalid("Successful login lacks a passed native-session receipt")
            }
        }
        if state == .interruptedUnknown
            && authCapability?.state != .interruptedUnknown {
            throw invalid("Interrupted login lacks interrupted capability evidence")
        }
        if terminationReconciliation != nil
            && (outcome?.reason != .terminationUnconfirmed || execution == nil) {
            throw invalid("Termination reconciliation lacks the original process evidence")
        }
    }

    private static func decodeRequiredNullable<T: Decodable>(
        _ type: T.Type,
        from container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) throws -> T? {
        guard container.contains(key) else {
            throw DecodingError.keyNotFound(key, .init(codingPath: container.codingPath,
                                                       debugDescription: "Required nullable setup field is missing"))
        }
        return try container.decodeIfPresent(type, forKey: key)
    }

    private static func decodeOptionalNonNull<T: Decodable>(
        _ type: T.Type,
        from container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) throws -> T? {
        guard container.contains(key) else { return nil }
        return try container.decode(type, forKey: key)
    }

    public var isTerminal: Bool {
        switch state {
        case .succeeded, .failed, .cancelled, .timedOut, .interruptedUnknown, .notSupported: true
        case .queued, .running, .waitingForInput: false
        }
    }

    public var isActive: Bool { !isTerminal }

    public var canCancel: Bool { isActive && phase != .cancelling }
    public var canExtend: Bool {
        isActive && deadlineAt != nil && (phase == .launching || phase == .awaitingUser)
    }
    /// An unproven termination may still have a vendor process alive. Treating
    /// that record like an ordinary terminal failure would let Retry open a
    /// second Terminal window while the first login is still running.
    public var blocksReplacement: Bool {
        outcome?.reason == .terminationUnconfirmed && terminationReconciliation == nil
    }

    public var canRetry: Bool { hasConfirmedTermination }

    /// Terminal state normally proves the daemon process ended. The explicit
    /// termination_unconfirmed outcome is the sole exception and must keep a
    /// cancel-and-close surface open for operator recovery.
    public var hasConfirmedTermination: Bool {
        isTerminal && !blocksReplacement
    }
}

public struct SetupJobListResponse: Codable, Sendable, Equatable {
    public let jobs: [SetupJob]
    public init(jobs: [SetupJob]) { self.jobs = jobs }
}

public struct SetupJobSnapshot: Codable, Sendable, Equatable {
    public let job: SetupJob
    public let cursor: String
    public let sequence: Int
    /// D-17 transient device-code disclosure overlaid at read time; never part
    /// of the journaled `job`.
    public let deviceCode: SetupDeviceCodeDisclosure?

    public init(job: SetupJob, cursor: String, sequence: Int,
                deviceCode: SetupDeviceCodeDisclosure? = nil) {
        self.job = job
        self.cursor = cursor
        self.sequence = sequence
        self.deviceCode = deviceCode
    }
}

public struct SetupJobListFilter: Sendable, Equatable {
    public var harness: String?
    public var action: String?
    public var active: Bool?
    public var limit: Int?

    public init(harness: String? = nil, action: String? = nil, active: Bool? = nil, limit: Int? = nil) {
        self.harness = harness
        self.action = action
        self.active = active
        self.limit = limit
    }
}

public enum SetupJobEventKind: String, Codable, Sendable {
    case status
}

public struct SetupJobEvent: Codable, Sendable, Equatable {
    public let jobId: String
    public let cursor: String
    public let previousCursor: String?
    public let sequence: Int
    public let time: String
    public let kind: SetupJobEventKind
    public let state: SetupJobState
    public let message: String
    public let job: SetupJob
    /// D-17 transient device-code disclosure overlaid at read time; never part
    /// of the journaled `job`.
    public let deviceCode: SetupDeviceCodeDisclosure?

    enum CodingKeys: String, CodingKey {
        case jobId, cursor, previousCursor, sequence, time, kind, state, message, job, deviceCode
    }

    public init(jobId: String, cursor: String, previousCursor: String?, sequence: Int, time: String,
                kind: SetupJobEventKind = .status, state: SetupJobState, message: String, job: SetupJob,
                deviceCode: SetupDeviceCodeDisclosure? = nil) {
        self.jobId = jobId
        self.cursor = cursor
        self.previousCursor = previousCursor
        self.sequence = sequence
        self.time = time
        self.kind = kind
        self.state = state
        self.message = message
        self.job = job
        self.deviceCode = deviceCode
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try container.decode(String.self, forKey: .jobId)
        cursor = try container.decode(String.self, forKey: .cursor)
        guard container.contains(.previousCursor) else {
            throw DecodingError.keyNotFound(CodingKeys.previousCursor, .init(codingPath: container.codingPath,
                                                                              debugDescription: "previousCursor is required and may be explicit null"))
        }
        previousCursor = try container.decodeIfPresent(String.self, forKey: .previousCursor)
        sequence = try container.decode(Int.self, forKey: .sequence)
        time = try container.decode(String.self, forKey: .time)
        kind = try container.decode(SetupJobEventKind.self, forKey: .kind)
        state = try container.decode(SetupJobState.self, forKey: .state)
        message = try container.decode(String.self, forKey: .message)
        job = try container.decode(SetupJob.self, forKey: .job)
        deviceCode = try container.decodeIfPresent(SetupDeviceCodeDisclosure.self, forKey: .deviceCode)
        guard !jobId.isEmpty, !cursor.isEmpty, sequence > 0, previousCursor != cursor,
              job.jobId == jobId, job.state == state, job.message == message else {
            throw DecodingError.dataCorrupted(.init(codingPath: container.codingPath,
                                                    debugDescription: "Setup event identity, cursor, or snapshot invariant failed"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(jobId, forKey: .jobId)
        try container.encode(cursor, forKey: .cursor)
        if let previousCursor {
            try container.encode(previousCursor, forKey: .previousCursor)
        } else {
            try container.encodeNil(forKey: .previousCursor)
        }
        try container.encode(sequence, forKey: .sequence)
        try container.encode(time, forKey: .time)
        try container.encode(kind, forKey: .kind)
        try container.encode(state, forKey: .state)
        try container.encode(message, forKey: .message)
        try container.encode(job, forKey: .job)
        try container.encodeIfPresent(deviceCode, forKey: .deviceCode)
    }
}
