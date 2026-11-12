import Foundation
import Testing
@testable import ClaudexorKit

/// #118/#413: the additive web scope and route controls decode from a current
/// engine, and a summary from an older engine (no such fields) still decodes
/// with them absent rather than invented.
@Suite struct RouteControlWireTests {
    @Test func currentEngineSummaryCarriesScopeAndRouteControls() throws {
        let json = #"""
        {"runId":"run-1","state":"succeeded",
         "webEvidence":{"required":false,"mode":"off","effectiveMode":"off","attempted":false,
           "satisfied":false,"status":"none","verification":"none",
           "observation":{"evidence":"tool_calls","network":"not_measured"},"available":true},
         "routeControls":[{"harnessId":"cursor","webMode":"auto","webMechanism":"uncontrolled",
           "browser":false,"access":"readonly","nativeAccess":"--force --sandbox enabled --trust --mode ask",
           "accessMechanism":"tool_allowlist","nativeSessionStarted":true,"homeScoped":false},
          {"harnessId":"claude","webMode":"off","webMechanism":"tools","browser":false,
           "access":"readonly","nativeAccess":null,"accessMechanism":"tool_allowlist","nativeSessionStarted":false,"homeScoped":null}]}
        """#
        let summary = try JSONDecoder().decode(RunSummary.self, from: Data(json.utf8))
        #expect(summary.webEvidence?.verification == "none")
        #expect(summary.webEvidence?.observation == WebObservation(evidence: "tool_calls", network: "not_measured"))
        let routes = try #require(summary.routeControls)
        #expect(routes.count == 2)
        #expect(routes[0].nativeAccess == "--force --sandbox enabled --trust --mode ask")
        #expect(routes[0].nativeSessionStarted == true)
        #expect(routes[0].homeScoped == false)
        #expect(routes[1].nativeAccess == nil)
        #expect(routes[1].nativeSessionStarted == false)
        #expect(routes[1].homeScoped == nil)
    }

    @Test func olderEngineSummaryDecodesWithTheFactsAbsent() throws {
        let json = #"""
        {"runId":"run-old","state":"succeeded",
         "webEvidence":{"required":false,"mode":"auto","attempted":true,"satisfied":true,"status":"satisfied"}}
        """#
        let summary = try JSONDecoder().decode(RunSummary.self, from: Data(json.utf8))
        #expect(summary.webEvidence?.status == "satisfied")
        #expect(summary.webEvidence?.verification == nil)
        #expect(summary.webEvidence?.observation == nil)
        #expect(summary.routeControls == nil)
    }
}
