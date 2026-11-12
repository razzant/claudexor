import Foundation
import Testing
@testable import ClaudexorKit

/// #628: a pending question says how its asker waits (`delivery`), and run
/// summaries, turn cards and history runs carry `asyncQuestionsOnly`. Absent
/// fields come from older engines and keep the historical meaning: a question
/// holds the agent, and no run is async-only.
@Suite struct PendingInteractionDeliveryTests {
    private static func interactionJSON(delivery: String?) -> String {
        let field = delivery.map { #","delivery":"\#($0)""# } ?? ""
        return #"""
        {"interactionId":"int-1","runId":"run-1","attemptId":"a01","harnessId":"codex",
         "sourceTool":"request_user_input_async","requestedAt":"t","timeoutAt":"2026-11-09T12:00:00.000Z",
         "questions":[{"id":"q1","question":"Which store?","header":null,"multi_select":false,
           "options":[{"label":"SQLite","description":null}]}]\#(field)}
        """#
    }

    private static func pending(_ id: String, _ delivery: InteractionDelivery) -> PendingInteraction {
        PendingInteraction(
            interactionId: id, runId: "run-1", attemptId: nil, harnessId: "codex", sourceTool: nil,
            questions: [InteractionQuestion(id: "q1", question: "Which?", header: nil, options: [], multiSelect: false)],
            requestedAt: "t", timeoutAt: nil, delivery: delivery)
    }

    /// The daemon sends every HTTP error as a `ControlProblem` (the exact bodies are
    /// pinned in control-api.test.ts): a refused answer's reply rides in `context`
    /// and its reason is the problem's `message`.
    @Test func refusedAnswerIsReadFromTheProblemEnvelope() {
        let body = #"{"code":"http_409","message":"question q needs an answer","retryable":false,"fieldErrors":{},"requiredActions":[],"evidenceRefs":[],"context":{"accepted":false,"status":"rejected"}}"#
        #expect(GatewayError.http(status: 409, body: body).interactionAnswerRefusal
            == InteractionAnswerResponse(accepted: false, status: "rejected", message: "question q needs an answer"))
    }

    @Test func otherAnswerFailuresAreNotRefusals() {
        for body in [
            // The flat reply the daemon never puts on the wire.
            #"{"accepted":false,"status":"already_resolved"}"#,
            #"{"code":"http_404","message":"no such run","retryable":false,"context":{}}"#,
            #"{"code":"http_409","message":"x","retryable":false,"context":{"status":"rejected"}}"#,
            #"{"code":"http_409","message":"x","retryable":false,"context":{"accepted":true,"status":"delivered"}}"#,
            #"{"code":"http_409","message":"x","retryable":false,"context":{"accepted":false,"status":""}}"#,
            "not json",
        ] {
            #expect(GatewayError.http(status: 409, body: body).interactionAnswerRefusal == nil, "\(body)")
        }
        #expect(GatewayError.transport("offline").interactionAnswerRefusal == nil)
    }

    @Test func pendingInteractionDecodesAsyncDelivery() throws {
        let interaction = try JSONDecoder().decode(
            PendingInteraction.self, from: Data(Self.interactionJSON(delivery: "async").utf8))
        #expect(interaction.delivery == .async)
        #expect(interaction.timeoutAt == "2026-11-09T12:00:00.000Z")
        #expect(interaction.questions.map(\.question) == ["Which store?"])
        let blocking = try JSONDecoder().decode(
            PendingInteraction.self, from: Data(Self.interactionJSON(delivery: "blocking").utf8))
        #expect(blocking.delivery == .blocking)
    }

    /// Older engines and historical rows omit the field: the agent waits.
    @Test func pendingInteractionWithoutDeliveryIsBlocking() throws {
        let interaction = try JSONDecoder().decode(
            PendingInteraction.self, from: Data(Self.interactionJSON(delivery: nil).utf8))
        #expect(interaction.delivery == .blocking)
        // The run detail carries the same rows; the wire default holds there too.
        let detail = try JSONDecoder().decode(RunDetail.self, from: Data(#"""
        {"summary":{"runId":"run-1","state":"running","waitingOnUser":true},
         "pendingInteractions":[\#(Self.interactionJSON(delivery: nil)),\#(Self.interactionJSON(delivery: "async"))]}
        """#.utf8))
        #expect(detail.pendingInteractions.map(\.delivery) == [.blocking, .async])
        // The memberwise default is the wire default.
        #expect(PendingInteraction(
            interactionId: "i", runId: "r", attemptId: nil, harnessId: nil, sourceTool: nil,
            questions: [], requestedAt: "t", timeoutAt: nil).delivery == .blocking)
    }

    /// A delivery this build does not know fails loudly, like every closed wire enum.
    @Test func unknownDeliveryFailsDecoding() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(
                PendingInteraction.self, from: Data(Self.interactionJSON(delivery: "deferred").utf8))
        }
    }

    @Test func pendingInteractionEncodesItsDelivery() throws {
        let encoded = try JSONEncoder().encode(Self.pending("i1", .async))
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["delivery"] as? String == "async")
        #expect(try JSONDecoder().decode(PendingInteraction.self, from: encoded) == Self.pending("i1", .async))
    }

    @Test func runSummaryDecodesAsyncQuestionsOnlyAndAbsentReadsFalse() throws {
        let current = try JSONDecoder().decode(RunSummary.self, from: Data(#"""
        {"runId":"run-1","state":"running","waitingOnUser":true,"asyncQuestionsOnly":true}
        """#.utf8))
        #expect(current.waitingOnUser == true)
        #expect(current.asyncQuestionsOnly == true)
        let legacy = try JSONDecoder().decode(RunSummary.self, from: Data(#"""
        {"runId":"run-0","state":"running","waitingOnUser":true}
        """#.utf8))
        #expect(legacy.asyncQuestionsOnly == nil)
        #expect((legacy.asyncQuestionsOnly ?? false) == false)
    }

    @Test func turnRunCardDecodesAsyncQuestionsOnlyAndAbsentReadsFalse() throws {
        let current = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(#"""
        {"id":"tn-1","threadId":"th-1","runId":"run-1","prompt":"go","createdAt":"t",
         "run":{"state":"running","waitingOnUser":true,"asyncQuestionsOnly":true}}
        """#.utf8))
        #expect(current.run?.waitingOnUser == true)
        #expect(current.run?.asyncQuestionsOnly == true)
        let legacy = try JSONDecoder().decode(ThreadTurnInfo.self, from: Data(#"""
        {"id":"tn-0","threadId":"th-1","runId":"run-0","prompt":"go","createdAt":"t",
         "run":{"state":"running","waitingOnUser":true}}
        """#.utf8))
        #expect(legacy.run?.asyncQuestionsOnly == nil)
        // A present false re-encodes as false, so the generated fixtures round-trip.
        let encoded = try JSONEncoder().encode(try JSONDecoder().decode(TurnRunCard.self, from: Data(#"""
        {"state":"running","waitingOnUser":false,"asyncQuestionsOnly":false}
        """#.utf8)))
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["asyncQuestionsOnly"] as? Bool == false)
    }

    @Test func historyRunDecodesAsyncQuestionsOnlyAndAbsentReadsFalse() throws {
        let generated = try Self.historyPage(editingRuns: { _ in })
        let run = try #require(generated.turns.compactMap(\.run).first)
        #expect(run.asyncQuestionsOnly == false)
        let asyncOnly = try Self.historyPage(editingRuns: { run in
            run["waitingOnUser"] = true
            run["asyncQuestionsOnly"] = true
        })
        let asyncTurn = try #require(asyncOnly.turns.first { $0.run != nil })
        #expect(asyncTurn.run?.asyncQuestionsOnly == true)
        // The turn card adapter keeps the flag.
        #expect(asyncTurn.turnInfo.run?.asyncQuestionsOnly == true)
        let legacy = try Self.historyPage(editingRuns: { run in run["asyncQuestionsOnly"] = nil })
        let legacyRun = try #require(legacy.turns.compactMap(\.run).first)
        #expect(legacyRun.asyncQuestionsOnly == nil)
        #expect(legacy.turns.first { $0.run != nil }?.turnInfo.run?.asyncQuestionsOnly == nil)
    }

    /// The one derivation: loaded questions decide; with none loaded the engine's
    /// flag stands; a mixed set is blocking; nothing pending is never async-only.
    @Test func derivationPrefersLoadedQuestionsAndFallsBackToTheServerFlag() {
        func asyncOnly(_ pending: [PendingInteraction], waiting: Bool = true, flag: Bool) -> Bool {
            PendingQuestionAttention.asyncQuestionsOnly(pending: pending, waitingOnUser: waiting, serverFlag: flag)
        }
        let asyncOne = Self.pending("a", .async)
        let blockingOne = Self.pending("b", .blocking)
        // The pending list wins over the server flag, in both directions.
        #expect(asyncOnly([asyncOne], flag: false))
        #expect(!asyncOnly([blockingOne], flag: true))
        // A mixed set is blocking: a blocking question never hides behind an async one.
        #expect(!asyncOnly([asyncOne, blockingOne], flag: true))
        #expect(asyncOnly([asyncOne, Self.pending("c", .async)], flag: false))
        // No question loaded: the server flag stands.
        #expect(asyncOnly([], flag: true))
        #expect(!asyncOnly([], flag: false))
        // Not waiting on the user: never async-only, whatever a stale flag says.
        #expect(!asyncOnly([], waiting: false, flag: true))
        #expect(!asyncOnly([asyncOne], waiting: false, flag: true))
    }

    /// The generated history page (`thread-history-receipts`) with every turn's
    /// run object edited.
    private static func historyPage(
        editingRuns edit: (inout [String: Any]) -> Void
    ) throws -> ThreadHistoryPage {
        let url = try #require(Bundle.module.url(
            forResource: "thread-history-receipts", withExtension: "json", subdirectory: "Fixtures/wire"))
        let wrapper = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var page = try #require(wrapper["value"] as? [String: Any])
        var turns = try #require(page["turns"] as? [[String: Any]])
        for index in turns.indices {
            guard var run = turns[index]["run"] as? [String: Any] else { continue }
            edit(&run)
            turns[index]["run"] = run
        }
        page["turns"] = turns
        return try JSONDecoder().decode(
            ThreadHistoryPage.self, from: JSONSerialization.data(withJSONObject: page))
    }
}
