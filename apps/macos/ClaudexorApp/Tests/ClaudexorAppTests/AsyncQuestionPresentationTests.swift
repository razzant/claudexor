import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

/// #628: an async question (Codex `request_user_input_async`) is attention while
/// the agent keeps working; a blocking question holds the agent. These pin every
/// macOS reader of that difference, from the streamed event to the receipt chip,
/// state word, workspace fact, card copy and resolution lines. A mixed set is
/// blocking, and an absent `delivery` (older engines) keeps the blocking meaning.
@MainActor @Suite struct AsyncQuestionPresentationTests {
    private static func requested(_ id: String, delivery: String?, seq: Int) -> BusEnvelope {
        var payload: [String: JSONValue] = [
            "interaction_id": .string(id), "harness_id": .string("codex"),
            "source_tool": .string("request_user_input_async"),
            "requested_at": .string("2026-11-09T00:00:00.000Z"), "timeout_at": .null,
            "questions": .array([.object([
                "id": .string("q"), "question": .string("Which store?"), "multi_select": .bool(false),
                "options": .array([.object(["label": .string("SQLite")])]),
            ])]),
        ]
        if let delivery { payload["delivery"] = .string(delivery) }
        return BusEnvelope(seq: seq, kind: "interaction.requested", event: .object([
            "type": .string("interaction.requested"), "payload": .object(payload),
        ]))
    }

    private static func resolved(_ type: String, _ id: String, delivery: String, seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: type, event: .object([
            "type": .string(type),
            "payload": .object(["interaction_id": .string(id), "delivery": .string(delivery)]),
        ]))
    }

    private static func runningTask(_ id: String) -> TaskRun {
        TaskRun(
            id: id, title: "Run", prompt: "", mode: .agent, phase: .running,
            project: "Project", harnesses: [.codex], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
    }

    @Test func eventDecodingReadsDeliveryAndAnythingElseStaysBlocking() throws {
        func delivery(_ raw: String?) throws -> InteractionDelivery? {
            let payload = try #require(Self.requested("i", delivery: raw, seq: 1).event["payload"])
            return AppModel.pendingInteraction(from: payload, runId: "run-1")?.delivery
        }
        #expect(try delivery("async") == .async)
        #expect(try delivery("blocking") == .blocking)
        // Older engines omit the field: the agent waits, as it always did.
        #expect(try delivery(nil) == .blocking)
        // Only an explicit async softens a question.
        #expect(try delivery("later") == .blocking)
        #expect(AppModel.interactionDelivery(from: .object(["delivery": .string("async")])) == .async)
        #expect(AppModel.interactionDelivery(from: .object([:])) == .blocking)
    }

    /// The streamed reducer end to end: an async question leaves the run working;
    /// a blocking one beside it takes the loud state; answering it hands the state
    /// back; an async expiry ends the attention and says nothing was sent.
    @Test func streamedAsyncQuestionLeavesTheRunWorkingAndABlockingOneTakesOver() {
        let model = AppModel(requestNotificationAuthorization: false)
        model.liveTasks = [Self.runningTask("run-async")]

        model.apply(Self.requested("int-async", delivery: "async", seq: 1), to: "run-async")
        var task = model.liveTasks[0]
        #expect(task.waitingOnUser)
        #expect(task.pendingInteractions.map(\.delivery) == [.async])
        #expect(task.asyncQuestionsOnly && !task.blockingQuestionPending)
        #expect(TurnPresentation.attention(for: task) == nil)
        #expect(TurnPresentation.statusLine(for: task).stateWord == "Working…")
        let asyncFacts = RunFacts.headerPrimary(task)
        #expect(asyncFacts.map(\.id) == ["async_question"])
        #expect(asyncFacts.first?.tone == .neutral)

        model.apply(Self.requested("int-block", delivery: "blocking", seq: 2), to: "run-async")
        task = model.liveTasks[0]
        #expect(!task.asyncQuestionsOnly && task.blockingQuestionPending)
        #expect(TurnPresentation.attention(for: task)
            == TurnPresentation.Attention(text: "Needs your answer", tone: .warning))
        #expect(TurnPresentation.statusLine(for: task).stateWord == nil)
        #expect(RunFacts.headerPrimary(task).map(\.id) == ["needs_answer"])

        model.apply(Self.resolved("interaction.answered", "int-block", delivery: "blocking", seq: 3), to: "run-async")
        task = model.liveTasks[0]
        #expect(task.asyncQuestionsOnly)
        #expect(TurnPresentation.statusLine(for: task).stateWord == "Working…")
        #expect(model.liveBoxes["run-async"]?.activity.last?.title == "Answer delivered")

        model.apply(Self.resolved("interaction.timeout", "int-async", delivery: "async", seq: 4), to: "run-async")
        task = model.liveTasks[0]
        #expect(!task.waitingOnUser && !task.asyncQuestionsOnly && !task.blockingQuestionPending)
        #expect(model.liveBoxes["run-async"]?.activity.last?.title
            == "Question expired — nothing was sent to the agent")
        #expect(RunFacts.headerPrimary(task).isEmpty)
    }

    /// Without loaded questions (a summary or history row) the engine's flag
    /// decides; a run waiting on nobody is never async-only, whatever the flag.
    @Test func summaryFlagStandsOnlyWhileNoQuestionIsLoaded() {
        var task = Self.runningTask("run-summary")
        task.waitingOnUser = true
        task.serverAsyncQuestionsOnly = true
        #expect(task.asyncQuestionsOnly && !task.blockingQuestionPending)
        #expect(TurnPresentation.statusLine(for: task).stateWord == "Working…")
        task.serverAsyncQuestionsOnly = false
        #expect(task.blockingQuestionPending)
        #expect(TurnPresentation.attention(for: task)?.text == "Needs your answer")
        task.waitingOnUser = false
        task.serverAsyncQuestionsOnly = true
        #expect(!task.asyncQuestionsOnly && !task.blockingQuestionPending)
        #expect(RunFacts.headerPrimary(task).isEmpty)
    }

    /// Async-only questions raise no chip of their own, but they never hide a
    /// louder fact: a failure-shaped terminal or unfinished work keeps its chip.
    @Test func asyncQuestionsNeverHideAnotherAttentionState() {
        #expect(TurnPresentation.attention(
            phase: .running, reason: nil, reviewNeedsDecision: false, waitingOnUser: true,
            asyncQuestionsOnly: true, unfinishedWork: nil) == nil)
        #expect(TurnPresentation.attention(
            phase: .running, reason: nil, reviewNeedsDecision: false, waitingOnUser: true,
            asyncQuestionsOnly: true, unfinishedWork: "Incomplete")?.text == "Incomplete")
        #expect(TurnPresentation.attention(
            phase: .failed, reason: nil, reviewNeedsDecision: false, waitingOnUser: true,
            asyncQuestionsOnly: true, unfinishedWork: nil)?.tone == .failure)
    }

    @Test func cardCopySaysTheAgentKeepsWorkingAndNothingIsSentOnExpiry() throws {
        #expect(InteractionCard.title(delivery: .blocking) == "Needs your answer")
        #expect(InteractionCard.title(delivery: .async) == "The agent keeps working while you answer")

        let now = try #require(AppModel.parseEventDate("2026-11-09T12:00:00.000Z"))
        let inFive = "2026-11-09T12:05:30.000Z"
        let soon = "2026-11-09T12:00:30.000Z"
        #expect(InteractionExpiryPresentation.label(timeoutAt: inFive, delivery: .async, now: now) == "closes in 5 min")
        #expect(InteractionExpiryPresentation.label(timeoutAt: soon, delivery: .async, now: now) == "closes soon")
        #expect(InteractionExpiryPresentation.label(timeoutAt: inFive, now: now) == "auto-declines in 5 min")
        #expect(InteractionExpiryPresentation.label(timeoutAt: nil, delivery: .async) == "No automatic expiry")

        let asyncDeadline = InteractionExpiryPresentation.help(timeoutAt: inFive, delivery: .async)
        #expect(asyncDeadline.contains("nothing is sent to the agent"))
        let asyncOpen = InteractionExpiryPresentation.help(timeoutAt: nil, delivery: .async)
        #expect(asyncOpen.contains("keeps working"))
        for text in [asyncDeadline, asyncOpen, InteractionCard.title(delivery: .async)] {
            for claim in ["paused", "resume", "waiting for you", "Needs your answer", "assumptions"] {
                #expect(!text.localizedCaseInsensitiveContains(claim), "\(text) claims \(claim)")
            }
        }
        // Blocking keeps today's meaning, word for word.
        #expect(InteractionExpiryPresentation.help(timeoutAt: inFive)
            == "Unanswered questions decline automatically; the model continues with stated assumptions.")
        #expect(InteractionExpiryPresentation.help(timeoutAt: nil)
            == "This question waits until it is answered, cancelled, or released by run termination or restart.")
    }

    /// An async answer is only handed to the running session; nothing claims
    /// the model read or followed it. Withdrawal and cancellation keep their words.
    @Test func resolutionLinesNeverClaimTheModelComplied() {
        let handed = AppModel.interactionResolutionActivityTitle(
            type: "interaction.answered", reason: nil, delivery: .async)
        #expect(handed == "Answer handed to the running session")
        #expect(AppModel.interactionResolutionActivityTitle(type: "interaction.answered", reason: nil)
            == "Answer delivered")
        #expect(AppModel.interactionResolutionActivityTitle(type: "interaction.timeout", reason: nil)
            == "Question timed out — continuing with assumptions")
        #expect(AppModel.interactionResolutionActivityTitle(
            type: "interaction.timeout", reason: "cancelled", delivery: .async) == "Question closed — run cancelled")
        #expect(AppModel.interactionResolutionActivityTitle(
            type: "interaction.withdrawn", reason: nil, delivery: .async)
            == "Question withdrawn by the agent — no answer needed")
    }

    private static func completed(_ lifecycle: String, seq: Int) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "run.completed", event: .object([
            "type": .string("run.completed"), "payload": .object(["lifecycle": .string(lifecycle)]),
        ]))
    }

    private static func questionFacts(_ task: TaskRun) -> [String] {
        RunFacts.headerPrimary(task).map(\.id).filter { ["async_question", "needs_answer"].contains($0) }
    }

    /// The terminal frame lands before the snapshot that releases the questions
    /// (the daemon drops them after `run.completed`). From that frame on nothing
    /// offers an answer or says the agent is working, async or blocking; the
    /// received questions stay as they arrived and nothing answers or expires them.
    @Test func aTerminalRunOffersNoQuestionWhileItsSnapshotIsPending() {
        for delivery in ["async", "blocking"] {
            let model = AppModel(requestNotificationAuthorization: false)
            model.liveTasks = [Self.runningTask("run-end")]
            model.apply(Self.requested("int-1", delivery: delivery, seq: 1), to: "run-end")
            var task = model.liveTasks[0]
            // Control: while the run is live the question is open.
            #expect(task.openQuestions.count == 1 && task.awaitingAnswer)
            #expect(Self.questionFacts(task).count == 1)

            model.apply(Self.completed("succeeded", seq: 2), to: "run-end")
            task = model.liveTasks[0]
            #expect(task.phase == .succeeded)
            #expect(task.pendingInteractions.map(\.interactionId) == ["int-1"])
            #expect(task.openQuestions.isEmpty && !task.awaitingAnswer)
            #expect(!task.asyncQuestionsOnly && !task.blockingQuestionPending)
            #expect(TurnPresentation.attention(for: task) == nil)
            #expect(TurnPresentation.statusLine(for: task).stateWord == RunPhase.succeeded.label)
            #expect(Self.questionFacts(task).isEmpty)
            let titles = model.liveBoxes["run-end"]?.activity.map(\.title) ?? []
            #expect(!titles.contains { $0.hasPrefix("Answer") || $0.hasPrefix("Question expired") })
        }
    }

    /// A summary or history row of a finished run may still carry the question
    /// flags; the terminal outranks them. Unknown is not terminal: a lost stream
    /// may still hold its question.
    @Test func finishedRowFlagsRaiseNoQuestionState() {
        var task = Self.runningTask("run-row")
        task.waitingOnUser = true
        for (phase, flag) in [(RunPhase.succeeded, true), (.succeeded, false), (.failed, false), (.cancelled, false)] {
            task.phase = phase
            task.serverAsyncQuestionsOnly = flag
            #expect(!task.awaitingAnswer && !task.asyncQuestionsOnly && !task.blockingQuestionPending)
            #expect(TurnPresentation.attention(for: task)?.text != "Needs your answer")
            #expect(Self.questionFacts(task).isEmpty)
        }
        task.phase = .unknown
        task.serverAsyncQuestionsOnly = false
        #expect(task.blockingQuestionPending)
    }

    /// The expiry label changes words at each minute boundary and at the deadline.
    /// The schedule opens at its own start and closes one step past the deadline,
    /// which SwiftUI's handling of a schedule's first and last entries needs; no
    /// deadline or a passed one, no updates.
    @Test func expiryScheduleUpdatesOnlyWhereTheWordsChange() throws {
        let now = try #require(AppModel.parseEventDate("2026-11-09T12:00:00.000Z"))
        let deadline = "2026-11-09T12:02:05.000Z"
        let due = try #require(AppModel.parseEventDate(deadline))
        let ticks = Array(InteractionExpirySchedule(deadline: due).entries(from: now, mode: .normal).prefix(10))
        #expect(ticks.first == now)
        #expect(ticks.map { InteractionExpiryPresentation.label(timeoutAt: deadline, delivery: .async, now: $0) }
            == ["closes in 2 min", "closes in 1 min", "closes soon", "expiring", "expiring"])
        #expect(zip(ticks, ticks.dropFirst()).allSatisfy { $0 < $1 })
        // The deadline's own entry is not the last, so SwiftUI draws it.
        let crossing = due.addingTimeInterval(InteractionExpirySchedule.slack)
        let closing = try #require(ticks.last)
        #expect(ticks.dropLast().last == crossing && closing > crossing)

        #expect(Array(InteractionExpirySchedule(deadline: nil).entries(from: now, mode: .normal)).isEmpty)
        #expect(Array(InteractionExpirySchedule(deadline: now.addingTimeInterval(-5))
            .entries(from: now, mode: .normal)).isEmpty)
        // Started inside the deadline's slack: the words are already final, and the list still ends.
        let inSlack = Array(InteractionExpirySchedule(deadline: now.addingTimeInterval(-0.1))
            .entries(from: now, mode: .normal).prefix(10))
        #expect(inSlack.count == 3 && inSlack.first == now)
    }

    /// A real daemon refusal: every HTTP error is a `ControlProblem`, and a refused
    /// answer's typed status rides in `context`. `control-api.test.ts` pins these
    /// exact bodies from the server.
    private static func problem(_ status: Int, _ message: String, context: String) -> String {
        #"{"code":"http_\#(status)","message":"\#(message)","retryable":false,"fieldErrors":{},"requiredActions":[],"evidenceRefs":[],"context":\#(context)}"#
    }

    /// The engine refuses a late answer with a problem on HTTP 409/404 and the
    /// card says so in plain words; a missing reply is not a success. One
    /// request per answer: nothing is resent.
    @Test func answerRefusalsReadAsPlainWords() async throws {
        defer { RefusingAnswerURLProtocol.reply = nil }
        let model = AppModel(requestNotificationAuthorization: false)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RefusingAnswerURLProtocol.self]
        let client = GatewayClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "test",
            session: URLSession(configuration: config))
        let cases: [(Int, String, String)] = [
            (409, Self.problem(409, "request failed with status 409", context: #"{"accepted":false,"status":"already_resolved"}"#),
             "This question is already closed, so your answer was not sent."),
            (404, Self.problem(404, "missing", context: #"{"accepted":false,"status":"not_found"}"#),
             "This question is no longer open, so your answer was not sent."),
            (409, Self.problem(409, "question q needs an answer", context: #"{"accepted":false,"status":"rejected"}"#),
             "question q needs an answer"),
            (404, Self.problem(404, "no such run", context: "{}"),
             "The engine did not accept this answer (HTTP 404): no such run"),
            (404, #"{"error":"no such run"}"#, "The engine did not accept this answer (HTTP 404): no such run"),
            // A flat reply is not what the daemon sends: no typed status is read from it.
            (409, #"{"accepted":false,"status":"already_resolved"}"#, "The engine did not accept this answer (HTTP 409)."),
        ]
        for (status, body, expected) in cases {
            RefusingAnswerURLProtocol.reply = (status, Data(body.utf8))
            RefusingAnswerURLProtocol.requests = 0
            do {
                _ = try await client.answerInteraction(runId: "r1", interactionId: "i1", answers: [])
                Issue.record("HTTP \(status) must not read as delivered")
            } catch {
                #expect(model.answerFailureMessage(error) == expected)
            }
            #expect(RefusingAnswerURLProtocol.requests == 1)
        }
        #expect(model.answerFailureMessage(URLError(.networkConnectionLost)).hasPrefix("Delivery is unconfirmed"))
        #expect(model.answerFailureMessage(GatewayError.decoding("bad body")).hasPrefix("Delivery is unconfirmed"))
        #expect(model.answerFailureMessage(URLError(.cannotConnectToHost))
            == "Cannot reach the engine, so your answer was not sent.")
    }
}

/// Answers every request with the configured status and body.
private final class RefusingAnswerURLProtocol: URLProtocol {
    nonisolated(unsafe) static var reply: (Int, Data)?
    nonisolated(unsafe) static var requests = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests += 1
        let (status, body) = Self.reply ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
