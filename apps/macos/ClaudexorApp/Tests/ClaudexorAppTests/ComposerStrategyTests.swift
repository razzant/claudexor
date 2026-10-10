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
        council: Bool = false, members: Int = 2, maxMembers: Int = composerCouncilMemberLimit(nil)
    ) -> ComposerStrategyResolution {
        resolveComposerStrategy(intent: intent, agentStrategy: strategy, delegate: delegate,
                                councilEnabled: council, councilMembers: members,
                                maxCouncilMembers: maxMembers)
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
        // An older daemon without a cap projection keeps the historical range.
        #expect(resolve(.plan, council: true, members: 1).councilN == 2)
        #expect(resolve(.plan, council: true, members: 9).councilN == 4)
        let r = resolve(.plan, council: true, members: 3)
        #expect(r.mode == .plan)
        #expect(r.council)
        #expect(!r.delegate)
    }

    private func settings(councilConfigured: Int, councilEffective: Int) throws -> SettingsSnapshot {
        try JSONDecoder().decode(SettingsSnapshot.self, from: Data("""
        {
          "sources": [],
          "routing": { "goal": "auto", "paidFallback": "when_unavailable", "qualityTiers": {}, "primaryHarness": null, "eligibleHarnesses": [], "envInheritance": "mirror_native" },
          "budget": { "paidBudgetPerRun": { "kind": "unlimited" } },
          "runtime": {
            "reviewerTimeoutMs": 600000,
            "transientRetry": { "maxRetries": 2, "initialDelayMs": 1000, "maxDelayMs": 10000 },
            "concurrency": {
              "configured": { "maxConcurrent": 24, "maxParallelCandidates": 4, "maxDeepScanWidth": 8, "maxCouncilMembers": \(councilConfigured) },
              "effective": { "maxConcurrent": 24, "maxParallelCandidates": 4, "maxDeepScanWidth": 8, "maxCouncilMembers": \(councilEffective) },
              "restartRequired": \(councilConfigured != councilEffective)
            }
          }
        }
        """.utf8))
    }

    @Test func planCouncilAboveFourReachesTheWireWithEffectiveCapSix() throws {
        let maxMembers = composerCouncilMemberLimit(try settings(councilConfigured: 6, councilEffective: 6))
        let r = resolve(.plan, council: true, members: 6, maxMembers: maxMembers)
        #expect(r.councilN == 6)
        #expect(resolve(.plan, council: true, members: 9, maxMembers: maxMembers).councilN == 6)
        #expect(resolve(.plan, council: true, members: 1, maxMembers: maxMembers).councilN == 2)
        #expect(resolve(.plan, council: true, members: 3, maxMembers: maxMembers).councilN == 3)
        let body = ThreadTurnRequest(prompt: "plan it", mode: r.mode.apiValue, n: r.councilN, council: r.council)
        let wire = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(wire["n"] as? Int == 6)
        #expect(wire["council"] as? Bool == true)
    }

    @Test func pendingCouncilConfigDoesNotExpandTheEffectiveComposerRange() throws {
        let maxMembers = composerCouncilMemberLimit(try settings(councilConfigured: 24, councilEffective: 4))
        #expect(maxMembers == 4)
        #expect(resolve(.plan, council: true, members: 6, maxMembers: maxMembers).councilN == 4)
    }

    @Test func unlimitedAdmissionPreservesEightMemberCouncilOnTheWire() throws {
        let current = try settings(councilConfigured: 8, councilEffective: 8)
        var wire = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(current)) as? [String: Any])
        var runtime = try #require(wire["runtime"] as? [String: Any])
        var concurrency = try #require(runtime["concurrency"] as? [String: Any])
        for key in ["configured", "effective"] {
            var caps = try #require(concurrency[key] as? [String: Any])
            caps["maxConcurrent"] = "unlimited"
            concurrency[key] = caps
        }
        runtime["concurrency"] = concurrency
        wire["runtime"] = runtime
        let updated = try JSONDecoder().decode(SettingsSnapshot.self, from: JSONSerialization.data(withJSONObject: wire))
        let r = resolve(.plan, council: true, members: 8, maxMembers: composerCouncilMemberLimit(updated))
        let body = ThreadTurnRequest(prompt: "plan it", mode: r.mode.apiValue, n: r.councilN, council: r.council)
        let request = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(request["n"] as? Int == 8)
    }

    @Test func legacySettingsOmissionKeepsFourMemberRange() throws {
        let current = try settings(councilConfigured: 6, councilEffective: 6)
        var wire = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(current)) as? [String: Any])
        var runtime = try #require(wire["runtime"] as? [String: Any])
        runtime.removeValue(forKey: "concurrency")
        wire["runtime"] = runtime
        let legacy = try JSONDecoder().decode(SettingsSnapshot.self, from: JSONSerialization.data(withJSONObject: wire))
        #expect(legacy.runtime?.concurrency == nil)
        #expect(composerCouncilMemberLimit(legacy) == 4)
        #expect(composerCouncilMemberLimit(nil) == 4)
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

    @Test func singleDefaultCarriesThreeActualRepairAttempts() {
        let options = TurnOptions()
        #expect(options.maxAttempts == 3)
        #expect(composerRepairWire(
            mode: .agent,
            access: .workspaceWrite,
            requestedAttempts: options.maxAttempts,
            requestedUntilClean: false
        ).attempts == 3)
        #expect(composerRepairWire(
            mode: .bestOfN,
            access: .workspaceWrite,
            requestedAttempts: options.maxAttempts,
            requestedUntilClean: false
        ).attempts == nil)
        #expect(composerRepairWire(
            mode: .agent,
            access: .workspaceWrite,
            requestedAttempts: options.maxAttempts,
            requestedUntilClean: true
        ).attempts == nil)
    }

    @Test func ordinaryAgentKeepsRepairCapWithoutModelReview() throws {
        let options = TurnOptions()
        let review = composerReviewWire(mode: .agent, requestedReview: options.review,
                                       hasExplicitPanel: false, untilClean: false)
        #expect(review == false)
        let repair = composerRepairWire(mode: .agent, access: .workspaceWrite,
                                        requestedAttempts: options.maxAttempts, requestedUntilClean: false)
        #expect(repair.attempts == 3)
        #expect(composerRunApplicabilityShape(mode: .agent, access: .workspaceWrite,
                                              repair: repair) == .agentConvergence)
        let body = ThreadTurnRequest(prompt: "go", mode: "agent", attempts: repair.attempts, review: review)
        let obj = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(obj["review"] as? Bool == false)
        #expect(obj["attempts"] as? Int == 3)
        let start = StartRunRequest(prompt: "go", mode: "agent", review: false)
        let startObj = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(start)) as? [String: Any])
        #expect(startObj["review"] as? Bool == false)
    }

    @Test func explicitReviewChoicesAndStrategiesOverrideOrdinaryDefault() {
        #expect(composerReviewWire(mode: .agent, requestedReview: true, hasExplicitPanel: false, untilClean: false) == true)
        #expect(composerReviewWire(mode: .agent, requestedReview: false, hasExplicitPanel: true, untilClean: false) == true)
        #expect(composerReviewWire(mode: .bestOfN, requestedReview: false, hasExplicitPanel: false, untilClean: false) == true)
        #expect(composerReviewWire(mode: .agent, requestedReview: false, hasExplicitPanel: false, untilClean: true) == true)
        #expect(composerReviewWire(mode: .plan, requestedReview: true, hasExplicitPanel: true, untilClean: true) == nil)
        #expect(composerReviewWire(mode: .ask, requestedReview: true, hasExplicitPanel: true, untilClean: true) == nil)
    }

    @Test func readOnlyAgentDropsConvergenceControlsAndReconcilesUntilClean() {
        let single = composerRepairWire(
            mode: .agent,
            access: .readOnly,
            requestedAttempts: TurnOptions.singleDefaultAttempts,
            requestedUntilClean: false)
        #expect(single == .init(attempts: nil, untilClean: nil))

        let staleUntilClean = composerRepairWire(
            mode: .agent,
            access: .readOnly,
            requestedAttempts: TurnOptions.singleDefaultAttempts,
            requestedUntilClean: true)
        #expect(staleUntilClean == .init(attempts: nil, untilClean: nil))
        #expect(!AgentStrategy.composerCases(access: .readOnly).contains(.untilClean))
        #expect(AgentStrategy.composerCases(access: .full).contains(.untilClean))
        #expect(AgentStrategy.untilClean.reconciling(access: .readOnly) == .single)
        #expect(AgentStrategy.bestOf.reconciling(access: .readOnly) == .bestOf)
        #expect(composerRunApplicabilityShape(
            mode: .agent,
            access: .readOnly,
            repair: staleUntilClean) == .readOnly)
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
