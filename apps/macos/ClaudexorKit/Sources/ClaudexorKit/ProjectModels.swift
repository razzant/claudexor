import Foundation

public struct RegisteredProject: Codable, Sendable, Identifiable, Equatable {
    public let schemaVersion: Int
    public let id: String
    public let root: String
    public let createdAt: String
    public let updatedAt: String
}

public struct ProjectListResponse: Codable, Sendable, Equatable {
    public let projects: [RegisteredProject]
}

public struct ProjectRootRequest: Codable, Sendable, Equatable {
    public let root: String

    public init(root: String) {
        self.root = root
    }
}
