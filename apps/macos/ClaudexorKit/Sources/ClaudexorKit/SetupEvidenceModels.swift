public struct SetupProcessIdentityKnown: Codable, Sendable, Equatable {
    public let status: String
    public let pid: Int
    public let platform: String
    public let source: String
    public let startToken: String
    public let processGroupId: Int

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case status, pid, platform, source, startToken, processGroupId
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        pid = try container.decode(Int.self, forKey: .pid)
        platform = try container.decode(String.self, forKey: .platform)
        source = try container.decode(String.self, forKey: .source)
        startToken = try container.decode(String.self, forKey: .startToken)
        processGroupId = try container.decode(Int.self, forKey: .processGroupId)
        try require(status == "known" && pid > 0 && ["linux", "darwin"].contains(platform)
                    && ["procfs_stat", "proc_pidinfo"].contains(source) && !startToken.isEmpty
                    && processGroupId > 0, decoder: decoder, "Invalid known process identity")
    }
}

public struct SetupProcessGroupHandle: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let pgid: Int
    public let leader: SetupProcessIdentityKnown

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case schemaVersion, pgid, leader
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        pgid = try container.decode(Int.self, forKey: .pgid)
        leader = try container.decode(SetupProcessIdentityKnown.self, forKey: .leader)
        try require(schemaVersion == 1 && pgid > 0 && leader.pid == pgid
                    && leader.processGroupId == pgid, decoder: decoder,
                    "Process group leader must own the recorded pgid")
    }
}

public struct SetupExecutionEvidence: Codable, Sendable, Equatable {
    public let executionId: String
    public let commandDigest: String
    public let manifestDigest: String
    public let processGroup: SetupProcessGroupHandle
    public let observedAt: String
    public let permitIssuedAt: String?

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case executionId, commandDigest, manifestDigest, processGroup, observedAt, permitIssuedAt
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        executionId = try container.decode(String.self, forKey: .executionId)
        commandDigest = try container.decode(String.self, forKey: .commandDigest)
        manifestDigest = try container.decode(String.self, forKey: .manifestDigest)
        processGroup = try container.decode(SetupProcessGroupHandle.self, forKey: .processGroup)
        observedAt = try container.decode(String.self, forKey: .observedAt)
        permitIssuedAt = try decodeOptionalNonNull(String.self, from: container, forKey: .permitIssuedAt)
        try require(isSetupExecutionID(executionId) && isSHA256(commandDigest)
                    && isSHA256(manifestDigest) && parseOffsetTimestamp(observedAt) != nil
                    && (permitIssuedAt == nil || parseOffsetTimestamp(permitIssuedAt!) != nil),
                    decoder: decoder, "Invalid setup execution evidence")
    }
}

public struct SetupExecutableEvidence: Codable, Sendable, Equatable {
    public let realpath: String
    public let sha256: String
    public let size: Int
    public let mode: Int
    public let device: String
    public let inode: String

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case realpath, sha256, size, mode, device, inode
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        realpath = try container.decode(String.self, forKey: .realpath)
        sha256 = try container.decode(String.self, forKey: .sha256)
        size = try container.decode(Int.self, forKey: .size)
        mode = try container.decode(Int.self, forKey: .mode)
        device = try container.decode(String.self, forKey: .device)
        inode = try container.decode(String.self, forKey: .inode)
        try require(realpath.hasPrefix("/") && isSHA256(sha256) && size >= 0 && mode >= 0
                    && isUnsignedDecimal(device) && isUnsignedDecimal(inode), decoder: decoder,
                    "Invalid setup executable evidence")
    }
}

public struct SetupCommandAuthorization: Codable, Sendable, Equatable {
    public let executionId: String
    public let executable: SetupExecutableEvidence
    public let args: [String]
    public let commandDigest: String
    public let manifestDigest: String

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case executionId, executable, args, commandDigest, manifestDigest
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        executionId = try container.decode(String.self, forKey: .executionId)
        executable = try container.decode(SetupExecutableEvidence.self, forKey: .executable)
        args = try container.decode([String].self, forKey: .args)
        commandDigest = try container.decode(String.self, forKey: .commandDigest)
        manifestDigest = try container.decode(String.self, forKey: .manifestDigest)
        try require(isSetupExecutionID(executionId) && isSHA256(commandDigest)
                    && isSHA256(manifestDigest), decoder: decoder,
                    "Invalid setup command authorization")
    }
}

public enum SetupNativeCommandErrorCode: String, Codable, Sendable {
    case permitTimeout = "permit_timeout"
    case spawnFailed = "spawn_failed"
    case deviceAuthUnsupported = "device_auth_unsupported"
}

public struct SetupNativeCommandReceipt: Codable, Sendable, Equatable {
    public let executionId: String
    public let commandDigest: String
    public let manifestDigest: String
    public let permitIssuedAt: String?
    public let commandStarted: Bool
    public let exitCode: Int?
    public let signal: String?
    public let errorCode: SetupNativeCommandErrorCode?
    public let finishedAt: String

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case executionId, commandDigest, manifestDigest, permitIssuedAt, commandStarted
        case exitCode, signal, errorCode, finishedAt
    }

    public init(executionId: String, commandDigest: String, manifestDigest: String,
                permitIssuedAt: String?, commandStarted: Bool, exitCode: Int?, signal: String?,
                errorCode: SetupNativeCommandErrorCode? = nil, finishedAt: String) {
        self.executionId = executionId
        self.commandDigest = commandDigest
        self.manifestDigest = manifestDigest
        self.permitIssuedAt = permitIssuedAt
        self.commandStarted = commandStarted
        self.exitCode = exitCode
        self.signal = signal
        self.errorCode = errorCode
        self.finishedAt = finishedAt
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        executionId = try container.decode(String.self, forKey: .executionId)
        commandDigest = try container.decode(String.self, forKey: .commandDigest)
        manifestDigest = try container.decode(String.self, forKey: .manifestDigest)
        permitIssuedAt = try requireNullable(String.self, from: container, forKey: .permitIssuedAt)
        commandStarted = try container.decode(Bool.self, forKey: .commandStarted)
        exitCode = try requireNullable(Int.self, from: container, forKey: .exitCode)
        signal = try requireNullable(String.self, from: container, forKey: .signal)
        errorCode = try decodeOptionalNonNull(SetupNativeCommandErrorCode.self, from: container, forKey: .errorCode)
        finishedAt = try container.decode(String.self, forKey: .finishedAt)
        try require(isSetupExecutionID(executionId) && isSHA256(commandDigest) && isSHA256(manifestDigest)
                    && (permitIssuedAt == nil || parseOffsetTimestamp(permitIssuedAt!) != nil)
                    && parseOffsetTimestamp(finishedAt) != nil,
                    decoder: decoder, "Invalid native command binding")
        try require(exitCode == nil || exitCode! >= 0, decoder: decoder, "Negative native command exit code")
        if commandStarted {
            try require(permitIssuedAt != nil, decoder: decoder, "Started command requires a permit")
        }
        if errorCode == .permitTimeout {
            try require(!commandStarted && permitIssuedAt == nil, decoder: decoder,
                        "Permit timeout cannot claim a command or permit")
        }
        if errorCode == .spawnFailed {
            try require(!commandStarted, decoder: decoder, "Spawn failure cannot claim command start")
        }
        if errorCode == .deviceAuthUnsupported {
            try require(!commandStarted, decoder: decoder,
                        "Device auth unsupported means the vendor command was never started")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(executionId, forKey: .executionId)
        try container.encode(commandDigest, forKey: .commandDigest)
        try container.encode(manifestDigest, forKey: .manifestDigest)
        if let permitIssuedAt { try container.encode(permitIssuedAt, forKey: .permitIssuedAt) }
        else { try container.encodeNil(forKey: .permitIssuedAt) }
        try container.encode(commandStarted, forKey: .commandStarted)
        if let exitCode { try container.encode(exitCode, forKey: .exitCode) }
        else { try container.encodeNil(forKey: .exitCode) }
        if let signal { try container.encode(signal, forKey: .signal) }
        else { try container.encodeNil(forKey: .signal) }
        try container.encodeIfPresent(errorCode, forKey: .errorCode)
        try container.encode(finishedAt, forKey: .finishedAt)
    }
}
