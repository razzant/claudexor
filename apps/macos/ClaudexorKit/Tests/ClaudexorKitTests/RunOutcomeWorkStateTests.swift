import Foundation
import Testing
@testable import ClaudexorKit

/// The engine's outcome facts carry an optional D-16 `work_state`. The fixtures
/// are generated through the real Zod schema (scripts/lib/wire-fixtures.mjs);
/// `everyWireFixtureRoundTrips` proves the DTO re-encodes them whole.
@Suite struct RunOutcomeWorkStateTests {
    private static func wire(_ name: String) throws -> JSONValue {
        let url = try #require(Bundle.module.url(
            forResource: name, withExtension: "json", subdirectory: "Fixtures/wire"))
        let wrapper = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        return try #require(wrapper["value"])
    }

    private static func facts(_ value: JSONValue) throws -> RunOutcomeFacts {
        try JSONDecoder().decode(RunOutcomeFacts.self, from: JSONEncoder().encode(value))
    }

    /// `value` with its `work_state.state` (and optionally `lifecycle`) replaced.
    private static func replacing(_ value: JSONValue, state: String, lifecycle: String? = nil) throws -> JSONValue {
        guard case .object(var outer) = value, case .object(var work)? = outer["work_state"] else {
            throw CocoaError(.coderReadCorrupt)
        }
        work["state"] = .string(state)
        outer["work_state"] = .object(work)
        if let lifecycle { outer["lifecycle"] = .string(lifecycle) }
        return .object(outer)
    }

    @Test func theVetoReadsFromWorkStateWhateverReasonArbitrationGave() throws {
        let veto = try Self.facts(try Self.wire("outcome-facts-work-veto"))
        #expect(veto.reason == "input_required")
        #expect(veto.workState?.state == "needs_input")
        #expect(veto.reviewRequested == false)
        #expect(veto.needsOperatorInput)

        let competing = try Self.facts(try Self.wire("outcome-facts-work-veto-review-blocked"))
        #expect(competing.reason == "review_blocked")
        #expect(competing.workState?.state == "incomplete")
        #expect(competing.reviewRequested == true)
        #expect(competing.needsOperatorInput)

        // Facts from a run with no work report, or an older engine.
        let plain = try Self.facts(try Self.wire("outcome-facts-needs-decision"))
        #expect(plain.workState == nil)
        #expect(!plain.needsOperatorInput)
    }

    /// `state` is a plain string: a state a newer engine adds still decodes,
    /// vetoes nothing, and keeps every member through a re-encode.
    @Test func aFutureWorkStateDecodesVetoesNothingAndRoundTrips() throws {
        let future = try Self.replacing(try Self.wire("outcome-facts-work-veto"), state: "paused_for_audit")
        let facts = try Self.facts(future)
        #expect(facts.workState?.state == "paused_for_audit")
        #expect(!facts.needsOperatorInput)
        let reencoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(facts))
        #expect(reencoded["work_state"] == future["work_state"])
    }

    /// Mirrors the server's `runWorkStateVeto`: only a succeeded lifecycle.
    @Test func theVetoOnlyHoldsOnASucceededLifecycle() throws {
        let veto = try Self.wire("outcome-facts-work-veto")
        for state in ["needs_input", "incomplete"] {
            let succeeded = try Self.facts(try Self.replacing(veto, state: state))
            #expect(succeeded.needsOperatorInput)
            for lifecycle in ["failed", "cancelled", "interrupted"] {
                let stopped = try Self.facts(try Self.replacing(veto, state: state, lifecycle: lifecycle))
                #expect(!stopped.needsOperatorInput)
            }
        }
        for state in ["completed", "unverified"] {
            let finished = try Self.facts(try Self.replacing(veto, state: state))
            #expect(!finished.needsOperatorInput)
        }
    }

    @Test func aWorkStateWithoutAStringStateFailsLoudly() throws {
        guard case .object(let veto) = try Self.wire("outcome-facts-work-veto") else {
            throw CocoaError(.coderReadCorrupt)
        }
        for workState: JSONValue in [.string("needs_input"), .object(["source": .string("constrained")])] {
            var malformed = veto
            malformed["work_state"] = workState
            let value = JSONValue.object(malformed)
            #expect(throws: DecodingError.self) { _ = try Self.facts(value) }
        }
    }
}
