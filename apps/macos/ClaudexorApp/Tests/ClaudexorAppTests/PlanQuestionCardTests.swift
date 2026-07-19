import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// D17: the plan question card's answer collection is a PURE composer —
/// completeness (which questions still need an answer) and the follow-up
/// plan-turn prompt encoding are unit-tested here; the view is only collection.
@Suite struct PlanQuestionCardTests {
    private func single(_ id: String, _ prompt: String, _ opts: [(String, String)]) -> PlanQuestion {
        PlanQuestion(id: id, kind: "single", prompt: prompt,
                     options: opts.map { PlanQuestionOption(id: $0.0, label: $0.1) }, allowText: false)
    }
    private func multi(_ id: String, _ prompt: String, _ opts: [(String, String)]) -> PlanQuestion {
        PlanQuestion(id: id, kind: "multi", prompt: prompt,
                     options: opts.map { PlanQuestionOption(id: $0.0, label: $0.1) }, allowText: false)
    }
    private func text(_ id: String, _ prompt: String) -> PlanQuestion {
        PlanQuestion(id: id, kind: "text", prompt: prompt, options: [], allowText: true)
    }

    @Test func completenessRequiresEveryQuestionAnswered() {
        let qs = [single("q1", "Store?", [("a", "SQLite"), ("b", "Postgres")]), text("q2", "Constraints?")]
        // Nothing answered yet.
        #expect(!PlanAnswerComposer.isComplete(qs, selections: [:], freeText: [:]))
        // Only the single answered — the text question still blocks.
        #expect(!PlanAnswerComposer.isComplete(qs, selections: ["q1": ["a"]], freeText: [:]))
        // Both answered.
        #expect(PlanAnswerComposer.isComplete(
            qs, selections: ["q1": ["a"]], freeText: ["q2": "must stay offline"]))
        // A blank/whitespace text answer does not count.
        #expect(!PlanAnswerComposer.isComplete(
            qs, selections: ["q1": ["a"]], freeText: ["q2": "   "]))
    }

    @Test func emptyQuestionSetIsNeverComplete() {
        #expect(!PlanAnswerComposer.isComplete([], selections: [:], freeText: [:]))
    }

    @Test func encodeUsesOptionLabelsAndAppendsFreeText() {
        let qs = [
            single("q1", "Which store?", [("a", "SQLite"), ("b", "Postgres")]),
            multi("q2", "Which targets?", [("x", "macOS"), ("y", "iOS"), ("z", "Linux")]),
            text("q3", "Any constraints?"),
        ]
        let prompt = PlanAnswerComposer.encode(
            qs,
            selections: ["q1": ["b"], "q2": ["x", "z"]],
            freeText: ["q3": "no external network"])
        // Labels, not raw ids; the leading line names the intent.
        #expect(prompt.hasPrefix("Answers to your plan questions:\n"))
        #expect(prompt.contains("Which store? → Postgres"))
        // Multi answers join with commas (order follows the option list).
        #expect(prompt.contains("Which targets? → macOS, Linux"))
        #expect(prompt.contains("Any constraints? → no external network"))
        // Raw option ids never leak into the prompt.
        #expect(!prompt.contains("→ b"))
    }

    @Test func encodeMarksUnansweredQuestionsHonestly() {
        let qs = [single("q1", "Store?", [("a", "SQLite")])]
        let prompt = PlanAnswerComposer.encode(qs, selections: [:], freeText: [:])
        #expect(prompt.contains("Store? → (no answer)"))
    }

    /// The gate that drives the card's presence and the destructive override:
    /// only a `needs_answers` plan run with parsed questions raises the card.
    @Test func needsAnswersGateMatchesPlanReadiness() {
        let qs = [single("q1", "Store?", [("a", "SQLite")])]
        var task = TaskRun(
            id: "r1", title: "t", prompt: "", mode: .plan, phase: .succeeded,
            project: "p", harnesses: [.claude], n: 1, createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, routeProof: .verified, attentionNote: nil,
            plan: [], activity: [], candidates: [], findings: [], diff: [])
        task.planQuestions = qs
        task.planReadiness = PlanReadiness(state: "needs_answers", questionCount: 1)
        let raises = { (t: TaskRun) in
            t.mode == .plan && t.planReadiness?.state == "needs_answers" && !t.planQuestions.isEmpty
        }
        #expect(raises(task))
        // A ready plan never raises the card (implement is not overridden).
        task.planReadiness = PlanReadiness(state: "ready", questionCount: 0)
        #expect(!raises(task))
    }
}
