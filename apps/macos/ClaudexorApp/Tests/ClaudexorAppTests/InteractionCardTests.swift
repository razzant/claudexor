import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// B2 (D42 interaction-answer regression): a run parked on a live harness
/// question (waiting_on_user) must expose an INLINE answer affordance on its
/// turn. D42 retired TaskDetailView — the pinned InteractionCard's only
/// surface — so `AppModel.answerInteraction` lost its UI caller; TurnCard now
/// renders one InteractionCard per pending interaction. These lock the gate
/// that drives the card's presence AND the pure answer composer behind Send, so
/// the affordance is both present and actually answerable in default config.
@Suite struct InteractionCardTests {
    @MainActor
    @Test func disabledInteractionShowsExplicitNoExpiryTruth() {
        #expect(InteractionExpiryPresentation.label(timeoutAt: nil) == "No automatic expiry")
    }

    private func question(_ id: String, multi: Bool = false) -> InteractionQuestion {
        InteractionQuestion(
            id: id, question: "Which store?", header: nil,
            options: [InteractionOption(label: "SQLite", description: nil),
                      InteractionOption(label: "Postgres", description: nil)],
            multiSelect: multi)
    }

    private func pending(_ questions: [InteractionQuestion]) -> PendingInteraction {
        PendingInteraction(
            interactionId: "i1", runId: "r1", attemptId: nil, harnessId: "codex",
            sourceTool: nil, questions: questions,
            requestedAt: "2026-07-20T00:00:00Z", timeoutAt: nil)
    }

    private func run(pending interactions: [PendingInteraction]) -> TaskRun {
        var task = TaskRun(
            id: "r1", title: "t", prompt: "", mode: .agent, phase: .running,
            project: "p", harnesses: [.codex], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, routeProof: .verified, attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [])
        task.pendingInteractions = interactions
        task.waitingOnUser = !interactions.isEmpty
        return task
    }

    /// The gate TurnCard.assistantSection uses to render the answer surface:
    /// `ForEach(run.openQuestions)` shows one InteractionCard per pending
    /// question set of a live run, so a parked run ALWAYS exposes an answer
    /// affordance and an idle run shows none.
    @Test func runWithPendingInteractionExposesAnswerAffordance() {
        let parked = run(pending: [pending([question("q1")])])
        #expect(!parked.pendingInteractions.isEmpty)
        #expect(parked.waitingOnUser)
        // Every pending interaction is answerable — the ForEach renders each.
        #expect(parked.pendingInteractions.allSatisfy { !$0.questions.isEmpty })

        let idle = run(pending: [])
        #expect(idle.pendingInteractions.isEmpty)
        #expect(!idle.waitingOnUser)
    }

    /// The affordance is actually answerable: a selection composes a typed,
    /// non-empty payload for `AppModel.answerInteraction`; no input composes none.
    @Test func answerComposerTurnsSelectionIntoPayload() {
        let interaction = pending([question("q1")])
        #expect(!InteractionAnswerComposer.hasAnyAnswer(interaction, selections: [:], freeText: [:]))
        #expect(InteractionAnswerComposer.payloads(interaction, selections: [:], freeText: [:]).isEmpty)

        let selections = ["q1": Set(["Postgres"])]
        #expect(InteractionAnswerComposer.hasAnyAnswer(interaction, selections: selections, freeText: [:]))
        let payloads = InteractionAnswerComposer.payloads(interaction, selections: selections, freeText: [:])
        #expect(payloads.count == 1)
        #expect(payloads.first?.questionId == "q1")
        #expect(payloads.first?.selectedLabels == ["Postgres"])
        #expect(payloads.first?.freeText == nil)
    }

    /// A free-text-only answer is a valid payload (no option picked) and keeps
    /// exactly what was typed; a whitespace-only entry is not an answer.
    @Test func freeTextOnlyComposesPayloadAndWhitespaceDoesNot() {
        let interaction = pending([question("q1")])
        let payloads = InteractionAnswerComposer.payloads(
            interaction, selections: [:], freeText: ["q1": "  Neither — use a flat file  "])
        #expect(payloads.count == 1)
        #expect(payloads.first?.selectedLabels.isEmpty == true)
        #expect(payloads.first?.freeText == "  Neither — use a flat file  ")

        for blank in ["   ", "\n", " \t\n "] {
            #expect(!InteractionAnswerComposer.hasAnyAnswer(
                interaction, selections: [:], freeText: ["q1": blank]))
            #expect(InteractionAnswerComposer.payloads(
                interaction, selections: [:], freeText: ["q1": blank]).isEmpty)
        }
    }

    /// The typed text reaches the answer request body unchanged: the card's
    /// composer feeds `GatewayClient.answerInteraction`, whose JSON is what the
    /// daemon hands to the harness bridge.
    @Test func typedAnswerReachesTheRequestBodyExactly() async throws {
        defer { AnswerBodyURLProtocol.captured = nil }
        let interaction = pending([question("q1")])
        let payloads = InteractionAnswerComposer.payloads(
            interaction, selections: [:], freeText: ["q1": "  keep both spaces  "])
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AnswerBodyURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1")!, token: "test",
            session: URLSession(configuration: config))
        let response = try await client.answerInteraction(
            runId: "r1", interactionId: "i1", answers: payloads)
        #expect(response.status == "delivered")
        let body = try #require(AnswerBodyURLProtocol.captured)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let answers = try #require(json["answers"] as? [[String: Any]])
        #expect(answers.count == 1)
        #expect(answers.first?["questionId"] as? String == "q1")
        #expect(answers.first?["freeText"] as? String == "  keep both spaces  ")
    }
}

/// Captures the answer request body. Private to this file so it cannot race
/// the shared history URL protocol used by other suites.
private final class AnswerBodyURLProtocol: URLProtocol {
    nonisolated(unsafe) static var captured: Data?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.captured = answerRequestBody(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"accepted":true,"status":"delivered"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// URLSession moves a request body into `httpBodyStream`.
func answerRequestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { return nil }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}
