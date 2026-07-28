import Foundation
import Testing
@testable import ClaudexorKit

/// M5b3 foundation: the App-consumed composites (`RunSummary` / `RunDetail`)
/// now decode the v3 terminal-truth axes the projection presentation depends
/// on — `outcomeFacts` (lifecycle/checks/review/reason), the server-owned
/// `outcomeBanner`, the single-producer `applyEligibility`, plan `planReadiness`
/// / `planQuestions`, and the `council` receipt. These pin the decode so a wire
/// change surfaces as a failing Swift test rather than a silently dropped field.
@Suite struct RunDetailCompositeTests {
    @Test func harnessStatusDecodesDelegationCapabilityAndLegacyFailsClosed() throws {
        let current = try JSONDecoder().decode(HarnessStatus.self, from: Data(#"""
        {"id":"claude","status":"ok","delegation":{"available":false,
         "reason":"runtime_unavailable","remediation":"Update the runtime and reconnect.",
         "requiresFullAccess":true}}
        """#.utf8))
        #expect(current.delegation == HarnessDelegationCapability(
            available: false,
            reason: "runtime_unavailable",
            remediation: "Update the runtime and reconnect.",
            requiresFullAccess: true
        ))
        let legacy = try JSONDecoder().decode(
            HarnessStatus.self, from: Data(#"{"id":"claude","status":"ok"}"#.utf8))
        #expect(legacy.delegation == nil)
    }

    @Test func runSummaryDecodesOutcomeFacts() throws {
        let json = #"""
        {"runId":"r1","state":"succeeded",
         "outcomeFacts":{"lifecycle":"succeeded","noChanges":false,
                         "checks":"passed","review":"blocked","reason":"review_blocked"}}
        """#
        let s = try JSONDecoder().decode(RunSummary.self, from: Data(json.utf8))
        let facts = try #require(s.outcomeFacts)
        #expect(facts.lifecycle == "succeeded")
        #expect(facts.noChanges == false)
        #expect(facts.checks == "passed")
        #expect(facts.review == "blocked")
        #expect(facts.reason == "review_blocked")
    }

    @Test func runSummaryWithoutOutcomeFactsIsNil() throws {
        // A live (non-terminal) run has no outcome yet; absence must decode as nil.
        let s = try JSONDecoder().decode(
            RunSummary.self, from: Data(#"{"runId":"r1","state":"running"}"#.utf8))
        #expect(s.outcomeFacts == nil)
    }

    @Test func runSummaryDecodesDelegateOutcomeAndNarrowChildLineage() throws {
        let json = #"""
        {"runId":"child","state":"running","parentRunId":"parent",
         "delegatedFromRunId":"parent",
         "delegation":{"requested":true,"effective":true,"used":true,"reason":"used","remediation":null}}
        """#
        let summary = try JSONDecoder().decode(RunSummary.self, from: Data(json.utf8))
        #expect(summary.parentRunId == "parent")
        #expect(summary.delegatedFromRunId == "parent")
        #expect(summary.delegation == RunDelegationInfo(
            requested: true, effective: true, used: true, reason: "used"))
    }

    @Test func runDetailDecodesBoundedDelegateChildrenAndDefaultsLegacyEmpty() throws {
        let current = try detail(#", "children":[{"runId":"child","state":"succeeded","parentRunId":"r1","delegatedFromRunId":"r1"}]"#)
        #expect(current.children.map(\.runId) == ["child"])
        #expect(current.children[0].delegatedFromRunId == "r1")
        #expect(try detail("").children.isEmpty)
    }

    private func detail(_ extra: String) throws -> RunDetail {
        let json = "{\"summary\":{\"jobId\":\"j\",\"runId\":\"r1\",\"state\":\"succeeded\"}\(extra)}"
        return try JSONDecoder().decode(RunDetail.self, from: Data(json.utf8))
    }

    @Test func runDetailDecodesServerOwnedOutcomeBannerVerbatim() throws {
        let d = try detail(#","outcomeBanner":"Candidate ready — NOT APPLIED""#)
        #expect(d.outcomeBanner == "Candidate ready — NOT APPLIED")
    }

    @Test func runDetailDecodesApplyEligibility() throws {
        let d = try detail(#","applyEligibility":{"eligible":false,"state":"needs_review","reason":"Blocking findings await your decision.","requiredAction":"Resolve the review findings, then apply."}"#)
        let a = try #require(d.applyEligibility)
        #expect(a.eligible == false)
        #expect(a.state == "needs_review")
        #expect(a.reason == "Blocking findings await your decision.")
        #expect(a.requiredAction == "Resolve the review findings, then apply.")
    }

    @Test func runDetailToleratesUndecodedServerRunFacts() throws {
        // D11: the wire detail carries the immutable runFacts receipt, but the
        // app deliberately does not decode it until a typed Swift model ships
        // with a real UI consumer. Its presence must never break decoding.
        let d = try detail(#","runFacts":{"schema_version":"3.1","run_id":"r1","mode":"plan","deliverable":{"present":true}}"#)
        #expect(d.summary.runId == "r1")
    }

    @Test func runDetailDecodesPlanReadinessAndQuestions() throws {
        let d = try detail(#","planReadiness":{"state":"needs_answers","questionCount":2},"planQuestions":[{"id":"q1","kind":"single","prompt":"Which store?","options":[{"id":"a","label":"SQLite"},{"id":"b","label":"Postgres"}]},{"id":"q2","kind":"text","prompt":"Any constraints?","allow_text":true}]"#)
        let readiness = try #require(d.planReadiness)
        #expect(readiness.state == "needs_answers")
        #expect(readiness.questionCount == 2)
        #expect(d.planQuestions.count == 2)
        #expect(d.planQuestions[0].kind == "single")
        #expect(d.planQuestions[0].options.map(\.id) == ["a", "b"])
        #expect(d.planQuestions[1].allowText == true)
    }

    @Test func runDetailDecodesCouncilRoster() throws {
        let d = try detail(#","council":{"requested":3,"drafted":2,"degraded":true,"mergedBy":"claude","members":[{"harnessId":"claude","role":"primary","status":"merged","error":null},{"harnessId":"codex","role":"member","status":"drafted","error":null},{"harnessId":"cursor","role":"member","status":"failed","error":"draft timed out"}]}"#)
        let c = try #require(d.council)
        #expect(c.requested == 3)
        #expect(c.drafted == 2)
        #expect(c.degraded == true)
        #expect(c.mergedBy == "claude")
        #expect(c.members.count == 3)
        #expect(c.members[0].status == "merged")
        #expect(c.members[2].error == "draft timed out")
    }

    @Test func runDetailWithoutV3AxesDefaultsCleanly() throws {
        // A minimal detail (non-plan, non-council, non-terminal) must decode with
        // the new fields absent — nil satellites, empty question list.
        let d = try detail("")
        #expect(d.outcomeBanner == nil)
        #expect(d.applyEligibility == nil)
        #expect(d.planReadiness == nil)
        #expect(d.planQuestions.isEmpty)
        #expect(d.council == nil)
        #expect(d.children.isEmpty)
    }
}
