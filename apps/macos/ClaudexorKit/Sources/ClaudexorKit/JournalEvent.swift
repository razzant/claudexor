/// One durable global/project journal event. Its cursor is opaque and may only
/// be returned to the same partition through Last-Event-ID.
public struct JournalEvent: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let cursor: String
    public let partition: String
    public let type: String
    public let observedAt: String
    public let payload: JSONValue

    public init(schemaVersion: Int = 1, cursor: String, partition: String, type: String,
                observedAt: String, payload: JSONValue) {
        self.schemaVersion = schemaVersion
        self.cursor = cursor
        self.partition = partition
        self.type = type
        self.observedAt = observedAt
        self.payload = payload
    }
}
