import ClaudexorKit
import Foundation
import Testing

/// The producer's wire fixtures live with the Kit tests: scripts/lib/wire-fixtures.mjs
/// builds them through the real Zod schema and the engine's projection owners, and
/// `pnpm fixtures:swift:check` fails when they drift. The app's tests read those bytes.
enum ProducerWire {
    static let historyPage = "thread-history-work-veto"

    static func url(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // ClaudexorAppTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // ClaudexorApp
            .deletingLastPathComponent()  // macos
            .appendingPathComponent("ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire/\(name).json")
    }

    static func value(_ name: String) throws -> JSONValue {
        let wrapper = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url(name)))
        return try #require(wrapper["value"])
    }

    static func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }

    /// The generated page, optionally with one row's facts edited. Only a value
    /// the current schema cannot produce (a newer engine's code) is written by hand.
    static func page(editingFactsOf turnID: String? = nil,
                     _ edit: (inout [String: JSONValue]) -> Void = { _ in }) throws -> ThreadHistoryPage {
        guard let turnID else { return try decode(ThreadHistoryPage.self, try value(historyPage)) }
        guard case .object(var page) = try value(historyPage), case .array(var turns)? = page["turns"] else {
            throw CocoaError(.coderReadCorrupt)
        }
        let index = try #require(turns.firstIndex { $0["id"]?.stringValue == turnID })
        guard case .object(var turn) = turns[index], case .object(var run)? = turn["run"],
              case .object(var facts)? = run["outcomeFacts"] else {
            throw CocoaError(.coderReadCorrupt)
        }
        edit(&facts)
        run["outcomeFacts"] = .object(facts)
        turn["run"] = .object(run)
        turns[index] = .object(turn)
        page["turns"] = .array(turns)
        return try decode(ThreadHistoryPage.self, .object(page))
    }

    static func row(_ page: ThreadHistoryPage, _ turnID: String) throws -> ThreadHistoryTurn {
        let found = page.turns.first { $0.id == turnID }
        return try #require(found)
    }
}
