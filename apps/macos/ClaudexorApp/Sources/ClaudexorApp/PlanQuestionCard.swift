import ClaudexorKit
import SwiftUI

/// D17 plan lifecycle: when a plan run comes back `needs_answers`, its open
/// questions (single / multi / free-text) surface as an ANSWER CARD on the plan
/// turn. Answering submits a follow-up PLAN turn (the same conversation
/// continues), which lets the planner revise toward `ready`. Implement stays
/// server-refused while questions remain — the explicit "Implement anyway"
/// override lives on the plan outcome row, not here.
///
/// The answer encoding + completeness live in `PlanAnswerComposer` (pure,
/// unit-tested); this view is only collection + submit.
enum PlanAnswerComposer {
    /// Every question is answered: `text` needs non-empty free text; single/multi
    /// need at least one selected option (or free text when the question allows it).
    static func isComplete(
        _ questions: [PlanQuestion],
        selections: [String: Set<String>],
        freeText: [String: String]
    ) -> Bool {
        guard !questions.isEmpty else { return false }
        return questions.allSatisfy { q in
            let picked = !(selections[q.id]?.isEmpty ?? true)
            let typed = !(freeText[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            switch q.kind {
            case "text": return typed
            default: return picked || (q.allowText && typed)
            }
        }
    }

    /// A follow-up plan-turn prompt encoding the operator's answers — one line
    /// per question, selected option LABELS (not raw ids) plus any free text.
    static func encode(
        _ questions: [PlanQuestion],
        selections: [String: Set<String>],
        freeText: [String: String]
    ) -> String {
        var lines = ["Answers to your plan questions:"]
        for q in questions {
            let labels = q.options
                .filter { selections[q.id]?.contains($0.id) == true }
                .map(\.label)
            let text = (freeText[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            var parts = labels
            if !text.isEmpty { parts.append(text) }
            let answer = parts.isEmpty ? "(no answer)" : parts.joined(separator: ", ")
            lines.append("- \(q.prompt) → \(answer)")
        }
        return lines.joined(separator: "\n")
    }
}

struct PlanQuestionCard: View {
    @Environment(AppModel.self) private var model
    let questions: [PlanQuestion]
    /// The plan turn's owning thread — answers bind here, not to live selection.
    let threadId: String?

    @State private var selections: [String: Set<String>] = [:]
    @State private var freeText: [String: String] = [:]
    @State private var sending = false
    @State private var errorMessage: String?

    private var complete: Bool {
        PlanAnswerComposer.isComplete(questions, selections: selections, freeText: freeText)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "list.bullet.clipboard.fill")
                    .foregroundStyle(Theme.status(.attention))
                Text("The plan needs your answers")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(questions.count) question\(questions.count == 1 ? "" : "s")")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(questions) { question in
                questionRow(question)
            }
            if let errorMessage {
                Text(errorMessage).font(.caption).foregroundStyle(Theme.status(.negative)).textSelection(.enabled)
                    .textSelection(.enabled)
            }
            HStack {
                Spacer()
                Button(sending ? "Sending…" : "Submit answers") { submit() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!complete || sending || model.selectedThreadBusy)
                    .help(complete
                        ? "Send your answers as a follow-up plan turn"
                        : "Answer every question first")
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(strokeColor: Theme.status(.attention).opacity(0.45))
    }

    @ViewBuilder
    private func questionRow(_ question: PlanQuestion) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(question.prompt).font(.callout.weight(.medium))
                if question.kind == "multi" {
                    Text("pick one or more").font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !question.options.isEmpty {
                FlowLayout(spacing: Theme.Spacing.sm) {
                    ForEach(question.options) { option in
                        Button {
                            toggle(question: question, optionId: option.id)
                        } label: {
                            Text(option.label).font(.caption.weight(.medium))
                                .padding(.horizontal, Theme.Spacing.md)
                                .padding(.vertical, Theme.Spacing.xs)
                        }
                        .buttonStyle(.plain)
                        .selectedChip(active: selections[question.id, default: []].contains(option.id))
                    }
                }
            }
            // Free-text field for `text` questions and any option question that
            // also accepts a typed answer (allow_text).
            if question.kind == "text" || question.allowText {
                TextField(
                    question.kind == "text" ? "Your answer" : "Add detail (optional)",
                    text: Binding(
                        get: { freeText[question.id] ?? "" },
                        set: { freeText[question.id] = $0 }),
                    axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
            }
        }
    }

    private func toggle(question: PlanQuestion, optionId: String) {
        var set = selections[question.id] ?? []
        if question.kind == "multi" {
            if set.contains(optionId) { set.remove(optionId) } else { set.insert(optionId) }
        } else {
            // single: exactly one — a re-tap clears, another option replaces.
            set = set.contains(optionId) ? [] : [optionId]
        }
        selections[question.id] = set
    }

    private func submit() {
        guard complete else { return }
        let prompt = PlanAnswerComposer.encode(questions, selections: selections, freeText: freeText)
        sending = true
        errorMessage = nil
        Task {
            let ok = await model.composerSend(prompt: prompt, mode: .plan, onThread: threadId)
            sending = false
            if !ok { errorMessage = model.threadStatus ?? "The plan turn was not accepted." }
        }
    }
}
