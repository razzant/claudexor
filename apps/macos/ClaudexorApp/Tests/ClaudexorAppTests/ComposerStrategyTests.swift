import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// Composer mode/strategy mapping (D24/D31/D32, M5b item 8): the pure resolver
/// that turns the composer's intent + knobs into the wire-shaped strategy facts
/// a thread turn carries — Agent Delegate/strategy, Plan Council + member count.
@Suite struct ComposerStrategyTests {
    private func resolve(
        _ intent: RunMode, strategy: AgentStrategy = .single, delegate: Bool = false,
        council: Bool = false, members: Int = 2
    ) -> ComposerStrategyResolution {
        resolveComposerStrategy(intent: intent, agentStrategy: strategy, delegate: delegate,
                                councilEnabled: council, councilMembers: members)
    }

    @Test func askCarriesNoStrategy() {
        let r = resolve(.ask, delegate: true, council: true, members: 4)
        #expect(r.mode == .ask)
        #expect(!r.delegate)   // delegate is dropped off a non-agent intent
        #expect(!r.council)    // council is dropped off a non-plan intent
        #expect(r.councilN == nil)
        #expect(!r.untilClean)
    }

    @Test func planSoloIsNotCouncil() {
        let r = resolve(.plan, council: false)
        #expect(r.mode == .plan)
        #expect(!r.council)
        #expect(r.councilN == nil)
    }

    @Test func planCouncilCarriesClampedMemberCount() {
        #expect(resolve(.plan, council: true, members: 3).councilN == 3)
        // wire clamps membership to 2..4
        #expect(resolve(.plan, council: true, members: 1).councilN == 2)
        #expect(resolve(.plan, council: true, members: 9).councilN == 4)
        let r = resolve(.plan, council: true, members: 3)
        #expect(r.mode == .plan)
        #expect(r.council)
        #expect(!r.delegate)
    }

    @Test func agentSingleMapsDelegate() {
        let on = resolve(.agent, strategy: .single, delegate: true)
        #expect(on.mode == .agent)
        #expect(on.delegate)
        #expect(!on.untilClean)
        #expect(!resolve(.agent, strategy: .single, delegate: false).delegate)
    }

    @Test func agentStrategiesMapToEffectiveModes() {
        #expect(resolve(.agent, strategy: .bestOf).mode == .bestOfN)
        #expect(resolve(.agent, strategy: .create).mode == .create)
        let uc = resolve(.agent, strategy: .untilClean, delegate: true)
        #expect(uc.mode == .agent)
        #expect(uc.untilClean)
        #expect(uc.delegate)          // delegate rides any agent strategy
        #expect(!uc.council)
    }

    /// The turn body actually encodes delegate/council when set (D32/D31 fields).
    @Test func turnRequestEncodesDelegateAndCouncil() throws {
        let body = ThreadTurnRequest(prompt: "hi", mode: "plan", n: 3, council: true)
        let json = try JSONEncoder().encode(body)
        let obj = try #require(try JSONSerialization.jsonObject(with: json) as? [String: Any])
        #expect(obj["council"] as? Bool == true)
        #expect(obj["n"] as? Int == 3)
        #expect(obj["delegate"] == nil)   // encodeIfPresent omits nil

        let agent = ThreadTurnRequest(prompt: "go", mode: "agent", delegate: true)
        let aObj = try #require(try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(agent)) as? [String: Any])
        #expect(aObj["delegate"] as? Bool == true)
        #expect(aObj["council"] == nil)
    }
}
