import Foundation
import Testing
@testable import ClaudexorKit

/// #450: a command result that left the command running in a background
/// shell, timed out, or reported an unrecognized outcome is not a finished
/// success. The envelopes mirror the `harness.event` rows the engine stores
/// (orchestrator `cursor-command-outcome.integration.test.ts`).
@Suite struct TranscriptCommandOutcomeTests {
    private func env(_ seq: Int, _ json: String) -> BusEnvelope {
        let value = try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return BusEnvelope(seq: seq, kind: value["type"]?.stringValue ?? "message", event: value)
    }

    private func fold(_ tool: String, reducer: inout TranscriptReducer) -> ToolBlock? {
        reducer.apply(env(1, #"{"type":"harness.event","payload":{"type":"tool_call","tool":{"name":"shell","kind":"command","use_id":"c1","target":"find /repo -name '*.log'"}}}"#))
        reducer.apply(env(2, #"{"type":"harness.event","payload":{"type":"tool_result","tool":"# + tool + "}}"))
        guard reducer.blocks.count == 1, case .tool(_, let block) = reducer.blocks[0] else { return nil }
        return block
    }

    private func fold(_ tool: String) -> ToolBlock? {
        var reducer = TranscriptReducer()
        return fold(tool, reducer: &reducer)
    }

    @Test func unconfirmedCommandOutcomesAreNeverShownAsSuccess() {
        let outcomes = [
            #"{"state":"backgrounded","background_reason":"timeout","timeout_ms":30000,"shell_id":"3","pid":4242}"#,
            #"{"state":"timed_out","timeout_ms":30000}"#,
            #"{"state":"unknown"}"#,
            #"{"state":"suspended"}"#,
        ]
        for outcome in outcomes {
            let block = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","command_outcome":"# + outcome + "}")
            #expect(block?.status.rawValue == "unconfirmed", "\(outcome)")
            #expect(block?.status == .unconfirmed, "\(outcome)")
            #expect(block?.exitCode == nil)
        }
    }

    @Test func theTypedFactsSurviveForPresentation() {
        let handoff = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","command_outcome":{"state":"backgrounded","background_reason":"timeout","timeout_ms":30000,"shell_id":"3","pid":4242}}"#)
        #expect(handoff?.commandOutcome == ToolBlock.CommandOutcome(
            state: .backgrounded, timeoutMs: 30000, backgroundReason: .timeout, shellId: "3", pid: 4242))
        // A state from a newer engine is unknown, never an exit.
        let future = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","command_outcome":{"state":"suspended","pid":0}}"#)
        #expect(future?.commandOutcome == ToolBlock.CommandOutcome(state: .unknown))
    }

    @Test func observedExitsErrorsAndLegacyResultsKeepTheirStatus() {
        let exited = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","exit_code":0,"command_outcome":{"state":"exited"}}"#)
        #expect(exited?.status == .ok)
        #expect(exited?.exitCode == 0)
        #expect(fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok"}"#)?.status == .ok)
        #expect(fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok"}"#)?.commandOutcome == nil)
        let failed = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"error","exit_code":1,"command_outcome":{"state":"timed_out"}}"#)
        #expect(failed?.status == .error)
    }

    @Test func aStandaloneResultAfterReconnectIsStillUnconfirmed() {
        var reducer = TranscriptReducer()
        reducer.apply(env(5, #"{"type":"harness.event","payload":{"type":"tool_result","tool":{"name":"shell","kind":"command","use_id":"late","status":"ok","command_outcome":{"state":"timed_out","timeout_ms":30000}}}}"#))
        guard case .tool(_, let block) = reducer.blocks.first else { Issue.record("expected a tool block"); return }
        #expect(block.status == .unconfirmed)
        #expect(block.commandOutcome?.state == .timedOut)
    }

    @Test func theVendorShellHandleIsBoundedAndCounted() {
        var reducer = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 10_000, toolFieldCap: 16)
        let handle = String(repeating: "h", count: 500)
        let block = fold(#"{"name":"shell","kind":"command","use_id":"c1","status":"ok","command_outcome":{"state":"backgrounded","shell_id":""# + handle + #""}}"#, reducer: &reducer)
        #expect(block?.commandOutcome?.shellId?.count == 16)
        #expect(reducer.truncatedChars >= 500 - 16)
        // name + kind + the 16-character bounded target + the bounded handle.
        #expect(reducer.textChars == "shell".count + "command".count + 16 + 16)
    }
}

/// #546: a later `status` row with `payload.code: command_outcome_refined`
/// names the call it refines by its exact `use_id` and carries the refined
/// command facts (Cursor: the vendor reported the end of a background command,
/// without an exit code). The reducer updates THAT card in place: never a
/// second card, never a neighbour found by name, never a success.
@Suite struct TranscriptCommandOutcomeRefinementTests {
    private func env(_ seq: Int, _ json: String) -> BusEnvelope {
        let value = try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return BusEnvelope(seq: seq, kind: value["type"]?.stringValue ?? "message", event: value)
    }

    private let handoff = #"{"state":"backgrounded","background_reason":"timeout","timeout_ms":30000,"shell_id":"148478","pid":148480}"#
    private let completion = #"{"state":"completion_reported","background_reason":"timeout","timeout_ms":30000,"shell_id":"148478","pid":148480,"completion_status":"success"}"#

    private func call(_ seq: Int, _ id: String, _ target: String, on stream: String = "") -> BusEnvelope {
        env(seq, #"{"type":"harness.event","payload":{"# + stream + #""type":"tool_call","tool":{"name":"shell","kind":"command","use_id":""# + id + #"","target":""# + target + #""}}}"#)
    }

    private func result(_ seq: Int, _ id: String, _ outcome: String, on stream: String = "") -> BusEnvelope {
        env(seq, #"{"type":"harness.event","payload":{"# + stream + #""type":"tool_result","tool":{"name":"shell","kind":"command","use_id":""# + id + #"","status":"ok","command_outcome":"# + outcome + "}}}")
    }

    private func refined(_ seq: Int, _ id: String, code: String = "command_outcome_refined",
                         outcome: String? = nil, extraTool: String = "", on stream: String = "") -> BusEnvelope {
        env(seq, #"{"type":"harness.event","payload":{"# + stream + #""type":"status","text":"Completion reported; exit code unknown","tool":{"name":"shell","kind":"command","use_id":""# + id + #"","target":"sleep 45","command_outcome":"# + (outcome ?? completion) + extraTool + #"},"payload":{"code":""# + code + #""}}}"#)
    }

    private func tool(_ reducer: TranscriptReducer, _ index: Int) -> ToolBlock? {
        guard index < reducer.blocks.count, case .tool(_, let block) = reducer.blocks[index] else { return nil }
        return block
    }

    @Test func aRefinementUpdatesTheSameCardInPlace() {
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45"))
        reducer.apply(result(2, "bg", handoff))
        let before = reducer.blocks.first?.id
        let applied = reducer.apply(refined(3, "bg"))
        #expect(applied)
        #expect(reducer.blocks.count == 1)
        #expect(reducer.blocks.first?.id == before)
        let block = tool(reducer, 0)
        #expect(block?.commandOutcome?.state.rawValue == "completion_reported")
        #expect(block?.commandOutcome?.shellId == "148478")
        #expect(block?.commandOutcome?.backgroundReason == .timeout)
        // An end without an exit code is never a success.
        #expect(block?.status == .unconfirmed)
        #expect(block?.exitCode == nil)
        #expect(block?.target == "sleep 45")
    }

    @Test func aNeighbouringOpenShellOfTheSameNameIsNeverTouched() {
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45"))
        reducer.apply(result(2, "bg", handoff))
        reducer.apply(call(3, "open", "pnpm test"))
        reducer.apply(refined(4, "bg"))
        #expect(reducer.blocks.count == 2)
        #expect(tool(reducer, 0)?.commandOutcome?.state.rawValue == "completion_reported")
        #expect(tool(reducer, 1)?.status == .running)
        #expect(tool(reducer, 1)?.commandOutcome == nil)
        #expect(tool(reducer, 1)?.target == "pnpm test")
        // The neighbour's own result still lands on its card.
        reducer.apply(result(5, "open", #"{"state":"exited"}"#))
        #expect(reducer.blocks.count == 2)
        #expect(tool(reducer, 1)?.status == .ok)
        #expect(tool(reducer, 0)?.commandOutcome?.state.rawValue == "completion_reported")
    }

    @Test func anUnknownIdAnOpenCallAnotherCodeAndADuplicateAddNothing() {
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45"))
        reducer.apply(result(2, "bg", handoff))
        reducer.apply(call(3, "open", "pnpm dev"))
        let settled = reducer.blocks
        let unknown = reducer.apply(refined(4, "unknown"))
        #expect(!unknown)
        // A refinement is never a result: an open call stays open.
        let openCall = reducer.apply(refined(5, "open"))
        #expect(!openCall)
        let otherCode = reducer.apply(refined(6, "bg", code: "live_input_delivered"))
        #expect(!otherCode)
        #expect(reducer.blocks == settled)
        let first = reducer.apply(refined(7, "bg"))
        #expect(first)
        let once = reducer.blocks
        let replayed = reducer.apply(refined(7, "bg"))
        #expect(!replayed)   // replayed seq
        let repeated = reducer.apply(refined(8, "bg"))
        #expect(!repeated)   // a second refinement
        #expect(reducer.blocks == once)
        #expect(reducer.blocks.count == 2)
    }

    @Test func aRefinementAfterTheTypedFinalStillTargetsItsOwnCard() {
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45"))
        reducer.apply(result(2, "bg", handoff))
        reducer.apply(env(3, #"{"type":"harness.event","payload":{"type":"message","text":"Done.","final":true}}"#))
        let applied = reducer.apply(refined(4, "bg"))
        #expect(applied)
        #expect(reducer.blocks.count == 1)
        #expect(tool(reducer, 0)?.commandOutcome?.state.rawValue == "completion_reported")
    }

    @Test func evictionKeepsTheRefinedCardAligned() {
        var reducer = TranscriptReducer(cap: 3)
        reducer.apply(env(1, #"{"type":"harness.event","payload":{"type":"message","text":"one"}}"#))
        reducer.apply(call(2, "bg", "sleep 45"))
        reducer.apply(result(3, "bg", handoff))
        reducer.apply(env(4, #"{"type":"harness.event","payload":{"type":"message","text":"two"}}"#))
        reducer.apply(env(5, #"{"type":"harness.event","payload":{"type":"thinking","text":"three"}}"#))
        // "one" was evicted: the card moved from index 1 to 0.
        #expect(reducer.trimmed == 1)
        let applied = reducer.apply(refined(6, "bg"))
        #expect(applied)
        #expect(tool(reducer, 0)?.commandOutcome?.state.rawValue == "completion_reported")
        #expect(reducer.blocks.count == 3)

        // A card that left the window is not refined, and no neighbour is.
        var small = TranscriptReducer(cap: 2)
        small.apply(call(1, "bg", "sleep 45"))
        small.apply(result(2, "bg", handoff))
        small.apply(call(3, "x", "ls"))
        small.apply(call(4, "y", "pwd"))
        let evicted = small.apply(refined(5, "bg"))
        #expect(!evicted)
        #expect(small.blocks.count == 2)
        #expect(tool(small, 0)?.status == .running)
        #expect(tool(small, 1)?.status == .running)
    }

    @Test func aReceiptRestoredAtTheStartKeepsTheRefinedCardAligned() {
        var reducer = TranscriptReducer()
        reducer.apply(env(1, #"{"type":"harness.event","payload":{"type":"message","text":"one"}}"#))
        reducer.apply(call(2, "bg", "sleep 45"))
        reducer.apply(result(3, "bg", handoff))
        let restored = reducer.applyNotice(id: "prepared-a01",
                                           TranscriptNotice(title: "Copy", text: "prepared", warning: false),
                                           atStart: true)
        #expect(restored)
        // The card moved from index 1 to 2.
        let applied = reducer.apply(refined(4, "bg"))
        #expect(applied)
        #expect(tool(reducer, 2)?.commandOutcome?.state.rawValue == "completion_reported")
        #expect(reducer.blocks.count == 3)
    }

    @Test func removingTheFinalTwinKeepsTheRefinedCardAligned() {
        var reducer = TranscriptReducer()
        reducer.apply(env(1, #"{"type":"harness.event","payload":{"type":"message","text":"Done."}}"#))
        reducer.apply(call(2, "bg", "sleep 45"))
        reducer.apply(result(3, "bg", handoff))
        reducer.apply(env(4, #"{"type":"harness.event","payload":{"type":"message","text":"Done.","final":true}}"#))
        #expect(reducer.blocks.count == 1)
        let applied = reducer.apply(refined(5, "bg"))
        #expect(applied)
        #expect(tool(reducer, 0)?.commandOutcome?.state.rawValue == "completion_reported")
    }

    /// Reachable control: the event schema lets a status row carry this shape,
    /// so the reducer must refuse it. Only a tool result can prove an exit.
    @Test func aStatusRowCanNeverGreenACall() {
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45"))
        reducer.apply(result(2, "bg", handoff))
        let before = reducer.blocks
        let claim = refined(3, "bg", outcome: #"{"state":"exited"}"#, extraTool: #","exit_code":0,"status":"ok""#)
        let applied = reducer.apply(claim)
        #expect(!applied)
        #expect(reducer.blocks == before)
        #expect(tool(reducer, 0)?.status == .unconfirmed)
        #expect(tool(reducer, 0)?.exitCode == nil)
        #expect(tool(reducer, 0)?.commandOutcome?.state == .backgrounded)
    }

    /// Unknown stays unknown: a word no protocol source defines, or none at all,
    /// is no report, and the handoff stays what its result said.
    @Test func anUndefinedReportLeavesTheHandoff() {
        for outcome in [#"{"state":"completion_reported","shell_id":"148478","completion_status":"paused"}"#,
                        #"{"state":"completion_reported","shell_id":"148478","completion_status":""}"#,
                        #"{"state":"completion_reported","shell_id":"148478"}"#,
                        #"{"state":"suspended","shell_id":"148478"}"#,
                        handoff] {
            var reducer = TranscriptReducer()
            reducer.apply(call(1, "bg", "sleep 45"))
            reducer.apply(result(2, "bg", handoff))
            let before = reducer.blocks
            let applied = reducer.apply(refined(3, "bg", outcome: outcome))
            #expect(!applied, "\(outcome)")
            #expect(reducer.blocks == before, "\(outcome)")
        }
    }

    /// A report refines a background handoff and nothing else: a timeout, an
    /// observed exit and an unknown outcome keep what their results said.
    @Test func onlyAHandoffCanBeRefined() {
        for settled in [#"{"state":"timed_out","timeout_ms":30000}"#, #"{"state":"exited"}"#, #"{"state":"unknown"}"#] {
            var reducer = TranscriptReducer()
            reducer.apply(call(1, "c", "sleep 45"))
            reducer.apply(result(2, "c", settled))
            let before = reducer.blocks
            let applied = reducer.apply(refined(3, "c"))
            #expect(!applied, "\(settled)")
            #expect(reducer.blocks == before, "\(settled)")
        }
    }

    /// The first report stands: a later row for the same call changes nothing.
    @Test func theFirstReportWins() {
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45"))
        reducer.apply(result(2, "bg", handoff))
        reducer.apply(refined(3, "bg"))
        let reported = reducer.blocks
        let later = #"{"state":"completion_reported","shell_id":"148478","completion_status":"error"}"#
        let applied = reducer.apply(refined(4, "bg", outcome: later))
        #expect(!applied)
        #expect(reducer.blocks == reported)
    }

    /// One physical try on a stored row: what the reducer's message streams key on.
    private func stream(_ attempt: String, _ session: String) -> String {
        #""attempt_id":""# + attempt + #"","harness_id":"cursor","session_id":""# + session + #"","#
    }

    /// A command outlives the native turn that started it: a typed turn boundary
    /// reopens that stream's messages and leaves its handoff refinable.
    @Test func aCommandThatEndsInALaterTurnStillRefinesItsCard() {
        let own = stream("a01", "s1")
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45", on: own))
        reducer.apply(result(2, "bg", handoff, on: own))
        reducer.apply(env(3, #"{"type":"harness.event","payload":{"# + own + #""type":"status","payload":{"code":"native_turn_started"}}}"#))
        let applied = reducer.apply(refined(4, "bg", on: own))
        #expect(applied)
        #expect(tool(reducer, 0)?.commandOutcome?.state == .completionReported)
    }

    /// Concurrent tries can repeat a vendor call id: a row reaches only a card of
    /// its own try, never another stream's handoff with the same id.
    @Test func aRowOfAnotherTryNeverReachesThisCard() {
        let first = stream("a01", "s1"), second = stream("a02", "s2")
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45", on: first))
        reducer.apply(result(2, "bg", handoff, on: first))
        reducer.apply(call(3, "bg", "sleep 5", on: second))
        reducer.apply(result(4, "bg", handoff, on: second))
        let before = reducer.blocks
        let elsewhere = reducer.apply(refined(5, "bg", on: stream("a03", "s3")))
        #expect(!elsewhere)
        #expect(reducer.blocks == before)
        let fromSecond = reducer.apply(refined(6, "bg", on: second))
        #expect(fromSecond)
        #expect(tool(reducer, 0)?.commandOutcome?.state == .backgrounded)
        #expect(tool(reducer, 1)?.commandOutcome?.state == .completionReported)
        let fromFirst = reducer.apply(refined(7, "bg", on: first))
        #expect(fromFirst)
        #expect(tool(reducer, 0)?.commandOutcome?.state == .completionReported)
    }

    /// C1: two tries open calls with the same native id before either result:
    /// each result, and each later report, reaches its own try's card.
    @Test func overlappingTriesWithOneUseIdKeepTheirOwnCards() {
        let first = stream("a01", "s1"), second = stream("a02", "s2")
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "bg", "sleep 45", on: first))
        reducer.apply(call(2, "bg", "sleep 5", on: second))
        reducer.apply(result(3, "bg", handoff, on: first))
        reducer.apply(result(4, "bg", #"{"state":"backgrounded","shell_id":"4"}"#, on: second))
        #expect(reducer.blocks.count == 2)
        #expect(tool(reducer, 0)?.target == "sleep 45")
        #expect(tool(reducer, 0)?.commandOutcome?.shellId == "148478")
        #expect(tool(reducer, 1)?.target == "sleep 5")
        #expect(tool(reducer, 1)?.commandOutcome?.shellId == "4")
        let applied = reducer.apply(refined(5, "bg", on: first))
        #expect(applied)
        #expect(tool(reducer, 0)?.commandOutcome?.state == .completionReported)
        #expect(tool(reducer, 1)?.commandOutcome?.state == .backgrounded)
    }

    /// C1: a result whose own call never arrived (a reconnect) stands alone. It
    /// never closes another open command, and its report refines only itself.
    @Test func aResultWithoutItsCallNeverTakesAnotherOpenCard() {
        var reducer = TranscriptReducer()
        reducer.apply(call(1, "other-open", "pnpm test"))
        reducer.apply(result(2, "bg", handoff))
        #expect(reducer.blocks.count == 2)
        #expect(tool(reducer, 0)?.status == .running)
        #expect(tool(reducer, 0)?.commandOutcome == nil)
        #expect(tool(reducer, 1)?.commandOutcome?.state == .backgrounded)
        let applied = reducer.apply(refined(3, "bg"))
        #expect(applied)
        #expect(tool(reducer, 0)?.status == .running)
        #expect(tool(reducer, 0)?.commandOutcome == nil)
        #expect(tool(reducer, 1)?.commandOutcome?.state == .completionReported)
        // The open call's own result still lands on it.
        reducer.apply(result(4, "other-open", #"{"state":"exited"}"#))
        #expect(reducer.blocks.count == 2)
        #expect(tool(reducer, 0)?.status == .ok)
    }

    private func idless(_ seq: Int, _ type: String, on stream: String, name: String = "shell") -> BusEnvelope {
        env(seq, #"{"type":"harness.event","payload":{"# + stream + #""type":""# + type + #"","tool":{"name":"\#(name)","kind":"command","status":"ok"}}}"#)
    }

    /// Compatibility for producers without ids: an id-less result closes the one
    /// id-less call of its name that its own try has open, and nothing ambiguous.
    @Test func anIdlessResultClosesOnlyTheOneIdlessCallOfItsTry() {
        let own = stream("a01", "s1")
        var paired = TranscriptReducer(toolFieldCap: 5)
        paired.apply(idless(1, "tool_call", on: own))
        paired.apply(idless(2, "tool_result", on: own))
        #expect(paired.blocks.count == 1)
        #expect(tool(paired, 0)?.status == .ok)

        var ambiguous = TranscriptReducer()
        ambiguous.apply(idless(1, "tool_call", on: own))
        ambiguous.apply(idless(2, "tool_call", on: own))
        ambiguous.apply(idless(3, "tool_result", on: own))
        #expect(ambiguous.blocks.count == 3)
        #expect(tool(ambiguous, 0)?.status == .running)
        #expect(tool(ambiguous, 1)?.status == .running)

        var elsewhere = TranscriptReducer()
        elsewhere.apply(idless(1, "tool_call", on: own))
        elsewhere.apply(idless(2, "tool_result", on: stream("a02", "s2")))
        #expect(elsewhere.blocks.count == 2)
        #expect(tool(elsewhere, 0)?.status == .running)

        // An id-less result never guesses at a call that has an id.
        var named = TranscriptReducer()
        named.apply(call(1, "c1", "pnpm test", on: own))
        named.apply(idless(2, "tool_result", on: own))
        #expect(named.blocks.count == 2)
        #expect(tool(named, 0)?.status == .running)

        // An evicted block before the open call shifts it; the pair still holds.
        var shifted = TranscriptReducer(cap: 2)
        shifted.apply(env(1, #"{"type":"harness.event","payload":{"type":"message","text":"one"}}"#))
        shifted.apply(idless(2, "tool_call", on: own))
        shifted.apply(env(3, #"{"type":"harness.event","payload":{"type":"thinking","text":"two"}}"#))
        shifted.apply(idless(4, "tool_result", on: own))
        #expect(shifted.blocks.count == 2)
        #expect(tool(shifted, 0)?.status == .ok)

        // Oversized names remain visible but are not retained as lookup keys.
        // Neither their clipped prefix nor the original name can close the call.
        var bounded = TranscriptReducer(toolFieldCap: 5)
        let longName = "shell" + String(repeating: "x", count: 20_000)
        bounded.apply(idless(1, "tool_call", on: own, name: longName))
        bounded.apply(idless(2, "tool_result", on: own, name: tool(bounded, 0)?.name ?? ""))
        #expect(bounded.blocks.count == 2)
        #expect(tool(bounded, 0)?.status == .running)
        bounded.apply(idless(3, "tool_result", on: own, name: longName))
        #expect(bounded.blocks.count == 3)
        #expect(tool(bounded, 0)?.status == .running)
        #expect(tool(bounded, 0)?.name.count == 5)
        #expect(bounded.truncatedChars >= 40_000)
    }

    @Test func aRefinedHandleIsBoundedAndCounted() {
        var reducer = TranscriptReducer(cap: 200, blockCharCap: 1_000, totalCharBudget: 10_000, toolFieldCap: 16)
        reducer.apply(call(1, "bg", "sleep"))
        reducer.apply(result(2, "bg", #"{"state":"backgrounded","shell_id":"7"}"#))
        let before = reducer.textChars
        let handle = String(repeating: "h", count: 300)
        let outcome = #"{"state":"completion_reported","completion_status":"success","shell_id":""# + handle + #""}"#
        let applied = reducer.apply(refined(3, "bg", outcome: outcome))
        #expect(applied)
        #expect(tool(reducer, 0)?.commandOutcome?.shellId?.count == 16)
        #expect(reducer.textChars == before - 1 + 16)
        #expect(reducer.truncatedChars >= 300 - 16)
    }
}
