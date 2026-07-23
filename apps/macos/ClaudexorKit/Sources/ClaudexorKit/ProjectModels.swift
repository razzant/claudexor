import Foundation

/// A disclosed (never refused) nesting relation with another registered project
/// (F3, QA-072): `inside` = this project's root lives under `root`; `contains` =
/// `root` lives under this one. Legit monorepos nest, so this is DISCLOSURE only
/// — surfaces show "Nested inside <root>" / "Contains <root>".
public struct ProjectNesting: Codable, Sendable, Equatable, Identifiable {
    public var id: String { "\(relation):\(projectId)" }
    /// How this project overlaps the other: `inside` | `contains`.
    public let relation: String
    /// The other registered project's root.
    public let root: String
    /// The other registered project's id.
    public let projectId: String

    public init(relation: String, root: String, projectId: String) {
        self.relation = relation
        self.root = root
        self.projectId = projectId
    }
}

public struct RegisteredProject: Codable, Sendable, Identifiable, Equatable {
    public let schemaVersion: Int
    public let id: String
    public let root: String
    public let createdAt: String
    public let updatedAt: String
    /// Disclosed nesting relations with other registered projects (QA-072);
    /// informational, never a refusal. Optional/defaulted so an older daemon
    /// that omits the key decodes to empty.
    public var nesting: [ProjectNesting] = []

    public init(schemaVersion: Int, id: String, root: String, createdAt: String,
                updatedAt: String, nesting: [ProjectNesting] = []) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.root = root
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.nesting = nesting
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, id, root, createdAt, updatedAt, nesting
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decode(Int.self, forKey: .schemaVersion)
        id = try c.decode(String.self, forKey: .id)
        root = try c.decode(String.self, forKey: .root)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        nesting = try c.decodeIfPresent([ProjectNesting].self, forKey: .nesting) ?? []
    }
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
