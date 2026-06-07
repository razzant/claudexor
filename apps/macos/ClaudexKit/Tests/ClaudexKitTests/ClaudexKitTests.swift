import Foundation
import Testing
@testable import ClaudexKit

@Suite struct ClaudexKitTests {
    @Test func jsonValueDecodesNestedPayload() throws {
        let json = #"{"type":"harness.event","payload":{"path":"a.ts","exit_code":0},"ok":true,"n":3}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        #expect(value["type"]?.stringValue == "harness.event")
        #expect(value["payload"]?["path"]?.stringValue == "a.ts")
        #expect(value["payload"]?["exit_code"]?.doubleValue == 0)
        #expect(value["ok"]?.boolValue == true)
        #expect(value["n"]?.doubleValue == 3)
    }

    @Test func jsonValueRoundTrips() throws {
        let json = #"{"a":[1,2,3],"b":null,"c":{"d":"x"}}"#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let reencoded = try JSONEncoder().encode(value)
        let again = try JSONDecoder().decode(JSONValue.self, from: reencoded)
        #expect(value == again)
    }

    @Test func startRunRequestEncodesPromptAndMode() throws {
        let req = StartRunRequest(prompt: "fix bug", mode: "best_of_n", harnesses: ["codex", "claude"], n: 2)
        let data = try JSONEncoder().encode(req)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(decoded["prompt"]?.stringValue == "fix bug")
        #expect(decoded["mode"]?.stringValue == "best_of_n")
        #expect(decoded["n"]?.doubleValue == 2)
    }

    @Test func settingsUpdateCanClearBudgetCaps() throws {
        let req = SettingsUpdateRequest(defaultPortfolio: "subscription-first", clearMaxUsdPerRun: true, clearMaxUsdPerDay: true)
        let data = try JSONEncoder().encode(req)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(obj?["defaultPortfolio"] as? String == "subscription-first")
        #expect(obj?["maxUsdPerRun"] == nil)
        #expect(obj?["maxUsdPerDay"] == nil)
        #expect(obj?["clearMaxUsdPerRun"] as? Bool == true)
        #expect(obj?["clearMaxUsdPerDay"] as? Bool == true)
    }

    @Test func controlApiDiscoveryLoadsEndpointAndToken() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let token = dir.appendingPathComponent("token")
        try "secret-token\n".write(to: token, atomically: true, encoding: .utf8)
        let doc = dir.appendingPathComponent("control-api.json")
        try #"{"host":"127.0.0.1","port":12345,"tokenPath":"\#(token.path)"}"#.write(to: doc, atomically: true, encoding: .utf8)

        let discovery = try ControlApiDiscovery.load(from: doc)
        #expect(discovery.baseURL.absoluteString == "http://127.0.0.1:12345")
        #expect(try discovery.readToken() == "secret-token")
    }
}
