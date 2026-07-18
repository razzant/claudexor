import ClaudexorKit
import SwiftUI

/// The SPEC-FLOW interview surface (the chat-side twin of InteractionCard). The
/// server ran the grounding plan and returned an open-questions interview; this
/// card collects the answers and freezes the SpecPack. Structurally it mirrors
/// InteractionCard (FlowLayout chip grid + free-text + submit/hasAnyAnswer), but
/// it binds to `[SpecQuestion]` and emits `[SpecAnswer]` keyed on option.id (NOT
/// label). On an unresolved-clarifications 400 the card STAYS open (the model
/// re-derives the asking state) and the reason is shown in the error slot — the
/// interview never silently guesses.
@MainActor
struct SpecQuestionCard: View {
    @Environment(AppModel.self) private var model
    /// The OWNING thread this interview belongs to (captured at render time) so a
    /// thread switch during the async freeze can't re-point the answers.
    let threadId: String
    let questions: [SpecQuestion]
    let planDir: String
    let planRunId: String
    /// Prior answers to RESTORE into the card (non-empty after an unresolved-
    /// clarifications 400 re-opens this card) — so the user fixes only the missing
    /// fields instead of re-answering from scratch.
    let initialAnswers: [SpecAnswer]
    /// A server reason to surface inline (e.g. the unresolved-clarifications 400).
    let errorMessage: String?

    /// Selected OPTION IDs per question (single keeps one; multi keeps a set).
    @State private var selections: [String: Set<String>]
    @State private var freeText: [String: String]
    @State private var sending = false

    init(threadId: String, questions: [SpecQuestion], planDir: String, planRunId: String,
         initialAnswers: [SpecAnswer] = [], errorMessage: String?) {
        self.threadId = threadId
        self.questions = questions
        self.planDir = planDir
        self.planRunId = planRunId
        self.initialAnswers = initialAnswers
        self.errorMessage = errorMessage
        // Seed @State from any restored answers (SpecAnswer.optionIds -> selections
        // set, SpecAnswer.text -> freeText), keyed by question id. The `.id(...)` on
        // this view (driven by the answer set) forces a fresh init when the answers
        // change, so the seed never goes stale.
        let seed = Self.seed(from: initialAnswers)
        _selections = State(initialValue: seed.selections)
        _freeText = State(initialValue: seed.freeText)
    }

    /// Pure mapping: prior `[SpecAnswer]` -> the card's @State (selections set keyed
    /// by question id + free text keyed by question id). Lives here so the restore is
    /// the exact inverse of `submit()`'s answer assembly.
    static func seed(from answers: [SpecAnswer]) -> (selections: [String: Set<String>], freeText: [String: String]) {
        var selections: [String: Set<String>] = [:]
        var freeText: [String: String] = [:]
        for answer in answers {
            if !answer.optionIds.isEmpty { selections[answer.questionId] = Set(answer.optionIds) }
            if let text = answer.text, !text.isEmpty { freeText[answer.questionId] = text }
        }
        return (selections, freeText)
    }

    /// A stable identity for a given answer set — used as the card's `.id(...)` so a
    /// re-derived `.askingQuestions` (after a 400) rebuilds the view and re-seeds its
    /// @State from the new answers instead of reusing the prior render's @State.
    static func seedIdentity(_ answers: [SpecAnswer]) -> String {
        answers
            .map { "\($0.questionId)=\($0.optionIds.sorted().joined(separator: ","))|\($0.text ?? "")" }
            .sorted()
            .joined(separator: ";")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "checklist")
                    .foregroundStyle(Theme.accent)
                Text("Spec interview")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("Answer, then deepen or freeze")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            // Interviews can contain many long questions/options. Keep the
            // header/actions stable and virtualize a bounded scrolling middle
            // instead of forcing the whole window to lay out one giant card.
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(questions) { question in
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Text(question.prompt).font(.callout.weight(.medium))
                            if let rationale = question.rationale, !rationale.isEmpty {
                                Text(rationale)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            if !question.options.isEmpty {
                                FlowLayout(spacing: Theme.Spacing.sm) {
                                    ForEach(question.options, id: \.id) { option in
                                        Button {
                                            toggle(question: question, optionId: option.id)
                                        } label: {
                                            Text(option.label)
                                                .font(.caption.weight(.medium))
                                                .padding(.horizontal, Theme.Spacing.md)
                                                .padding(.vertical, Theme.Spacing.xs)
                                        }
                                        .buttonStyle(.plain)
                                        .selectedChip(active: selections[question.id, default: []].contains(option.id))
                                    }
                                }
                            }
                            // Free text only when the server allows it, or for
                            // a pure-text question.
                            if question.allowText || question.options.isEmpty {
                                TextField("Answer in your own words…", text: binding(for: question.id))
                                    .textFieldStyle(.roundedBorder)
                                    .font(.callout)
                            }
                        }
                    }
                }
            }
            .frame(height: min(320, max(160, CGFloat(questions.count) * 64)))

            HStack(spacing: Theme.Spacing.md) {
                Button { askDeeper() } label: {
                    Label("Ask deeper", systemImage: "arrow.down.circle")
                }
                .buttonStyle(.bordered)
                .disabled(sending || !hasAnyAnswer)
                .help("Answer these, then surface the next, deeper layer of decisions")
                Button {
                    submit()
                } label: {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Enough — freeze", systemImage: "snowflake")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(sending || !hasAnyAnswer)
                .help("Stop here and freeze the spec from these decisions")
                Button("Cancel") { model.cancelSpec(threadId: threadId) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(sending)
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(Theme.status(.failed))
                        .textSelection(.enabled)
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .cardSurface(stroke: true, strokeColor: Theme.accent.opacity(0.5))
    }

    private var hasAnyAnswer: Bool {
        questions.contains { q in
            !selections[q.id, default: []].isEmpty
                // Match submit()'s trim (.whitespacesAndNewlines): a newline-only
                // draft must NOT enable the button and then dead-end as a no-op.
                || !(freeText[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func binding(for questionId: String) -> Binding<String> {
        Binding(get: { freeText[questionId] ?? "" }, set: { freeText[questionId] = $0 })
    }

    private func toggle(question: SpecQuestion, optionId: String) {
        var set = selections[question.id, default: []]
        if set.contains(optionId) {
            set.remove(optionId)
        } else {
            // Single-select keeps exactly one; multi accumulates.
            if question.kind != "multi" { set.removeAll() }
            set.insert(optionId)
        }
        selections[question.id] = set
    }

    private func submit() {
        let answers = questions.compactMap { q -> SpecAnswer? in
            // Emit option ids in the question's OPTION order (not Set iteration order):
            // the SpecPack is content-hashed, so identical selections must produce an
            // identical, deterministic option_ids list for reproducible freezes.
            let selected = selections[q.id, default: []]
            let optionIds = q.options.map(\.id).filter { selected.contains($0) }
            let text = (freeText[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !optionIds.isEmpty || !text.isEmpty else { return nil }
            return SpecAnswer(questionId: q.id, optionIds: optionIds, text: text.isEmpty ? nil : text)
        }
        guard !answers.isEmpty else { return }
        sending = true
        Task {
            await model.submitSpecAnswers(threadId: threadId, answers: answers)
            sending = false
        }
    }

    /// Build human-readable decisions (question → chosen option labels / free text)
    /// to carry into the next, deeper interview tier.
    private func currentDecisions() -> [SpecPriorDecision] {
        questions.compactMap { q in
            let selected = selections[q.id, default: []]
            let labels = q.options.filter { selected.contains($0.id) }.map(\.label)
            let text = (freeText[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let answer = (labels + (text.isEmpty ? [] : [text])).joined(separator: ", ")
            guard !answer.isEmpty else { return nil }
            return SpecPriorDecision(question: q.prompt, answer: answer)
        }
    }

    private func askDeeper() {
        let decisions = currentDecisions()
        guard !decisions.isEmpty else { return }
        sending = true
        Task {
            await model.askDeeperSpec(threadId: threadId, decisions: decisions)
            sending = false
        }
    }
}
