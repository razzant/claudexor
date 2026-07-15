public struct JournalRecoveryState: Codable, Sendable, Equatable {
    public let status: String
    public let discardedTailBytes: Int
    public let reason: String?
}

public struct JournalInspection: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let partition: String
    public let generation: Int
    public let status: String
    public let recovery: JournalRecoveryState
    public let fingerprint: String
    public let observedAt: String
    public let evidenceRefs: [String]
}

public struct JournalProjectionStatus: Codable, Sendable, Equatable {
    public let name: String
    public let status: String
    public let detail: String?
}

public struct JournalValidation: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let partition: String
    public let generation: Int
    public let status: String
    public let recovery: JournalRecoveryState
    public let fingerprint: String
    public let observedAt: String
    public let evidenceRefs: [String]
    public let projectionStatus: [JournalProjectionStatus]
}

public struct JournalExportReceipt: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let exportId: String
    public let partition: String
    public let fingerprint: String
    public let bundlePath: String
    public let manifestSha256: String
    public let createdAt: String
}

public struct JournalQuarantineRequest: Codable, Sendable, Equatable {
    public let expectedFingerprint: String
    public let confirmation: String

    public init(expectedFingerprint: String) {
        self.expectedFingerprint = expectedFingerprint
        confirmation = "quarantine_and_start_fresh"
    }
}

public struct JournalQuarantineReceipt: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let operationId: String
    public let partition: String
    public let previousFingerprint: String
    public let quarantineArtifactId: String
    public let quarantinePath: String
    public let newEpoch: String
    public let completedAt: String
}
