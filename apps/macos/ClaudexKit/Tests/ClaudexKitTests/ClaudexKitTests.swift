import XCTest
@testable import ClaudexKit

final class ClaudexKitTests: XCTestCase {
    func testJSONValueDecodesNestedPayload() throws {
        let json = #"{"type":"harness.event","payload":{"path":"a.ts","exit_code":0},"ok":true,"n":3}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        XCTAssertEqual(value["type"]?.stringValue, "harness.event")
        XCTAssertEqual(value["payload"]?["path"]?.stringValue, "a.ts")
        XCTAssertEqual(value["payload"]?["exit_code"]?.doubleValue, 0)
        XCTAssertEqual(value["ok"]?.boolValue, true)
        XCTAssertEqual(value["n"]?.doubleValue, 3)
    }

    func testJSONValueRoundTrips() throws {
        let json = #"{"a":[1,2,3],"b":null,"c":{"d":"x"}}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let reencoded = try JSONEncoder().encode(value)
        let again = try JSONDecoder().decode(JSONValue.self, from: reencoded)
        XCTAssertEqual(value, again)
    }

    func testStartRunRequestEncodesPromptAndMode() throws {
        let req = StartRunRequest(prompt: "fix bug", mode: "best_of_n", harnesses: ["codex", "claude"], n: 2)
        let data = try JSONEncoder().encode(req)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded["prompt"]?.stringValue, "fix bug")
        XCTAssertEqual(decoded["mode"]?.stringValue, "best_of_n")
        XCTAssertEqual(decoded["n"]?.doubleValue, 2)
    }
}
