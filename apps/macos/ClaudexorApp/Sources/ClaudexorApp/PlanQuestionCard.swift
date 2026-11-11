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
    static func isAnswered(
        _ question: PlanQuestion,
        selections: [String: Set<String>],
        freeText: [String: String]
    ) -> Bool {
        let picked = !(selections[question.id]?.isEmpty ?? true)
        let typed = !(freeText[question.id] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        switch question.kind {
        case "text": return typed
        // Plan options are suggestions, including for persisted 3.2.0
        // artifacts whose old producer encoded allow_text=false.
        default: return picked || typed
        }
    }

    static func unansweredQuestionIDs(
        _ questions: [PlanQuestion],
        selections: [String: Set<String>],
        freeText: [String: String]
    ) -> Set<String> {
        Set(questions.lazy.filter {
            !isAnswered($0, selections: selections, freeText: freeText)
        }.map(\.id))
    }

    /// Every question is answered: `text` needs non-empty free text; single/multi
    /// need at least one selected option (or free text when the question allows it).
    static func isComplete(
        _ questions: [PlanQuestion],
        selections: [String: Set<String>],
        freeText: [String: String]
    ) -> Bool {
        guard !questions.isEmpty else { return false }
        return unansweredQuestionIDs(
            questions, selections: selections, freeText: freeText).isEmpty
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
            // Own words are an alternative to the offered chips, never a
            // contradictory second answer if stale UI state contains both.
            let parts = text.isEmpty ? labels : [text]
            let answer = parts.isEmpty ? "(no answer)" : parts.joined(separator: ", ")
            lines.append("- \(q.prompt) → \(answer)")
        }
        return lines.joined(separator: "\n")
    }
}

/// Durable submitted-state projection for a plan answer card. A bound/queued
/// answer turn, or a retryable refusal with its own Retry affordance, owns the
/// submission. A non-retryable refusal leaves the original card editable so
/// the operator can send a new turn. Prompt text is display-only after this
/// typed relation has selected the turn; it is never used to infer identity.
enum PlanAnswerSubmission {
    static func acceptedTurn(
        sourcePlanRunId: String,
        turns: [ThreadTurnInfo]
    ) -> ThreadTurnInfo? {
        turns.first { turn in
            guard turn.answersPlanRunId == sourcePlanRunId else { return false }
            if turn.runId != nil { return true }
            guard let refusal = turn.enqueueError else { return true }
            return refusal.retryable != false
        }
    }
}

struct PlanQuestionCard: View {
    @Environment(AppModel.self) private var model
    @Environment(ConversationPresentation.self) private var presentation: ConversationPresentation?
    let questions: [PlanQuestion]
    /// Run whose open questions this card answers; persisted on the follow-up
    /// turn so submitted state survives app reload and remote reconnect.
    let sourcePlanRunId: String
    /// Exact prompt of the durable answer turn, when one already exists.
    let submittedPrompt: String?
    /// The plan turn's owning thread/location/workspace, frozen by its card.
    let target: TurnStartTarget
    /// Current model/auth/effort choices for this card-started turn.
    let routingOptions: TurnOptions

    @State private var localSelections: [String: Set<String>] = [:]
    @State private var localFreeText: [String: String] = [:]
    private var selections: [String: Set<String>] {
        get { presentation?.planSelections[sourcePlanRunId] ?? localSelections }
        nonmutating set {
            if let presentation { presentation.planSelections[sourcePlanRunId] = newValue }
            else { localSelections = newValue }
        }
    }
    private var freeText: [String: String] {
        get { presentation?.planText[sourcePlanRunId] ?? localFreeText }
        nonmutating set {
            if let presentation { presentation.planText[sourcePlanRunId] = newValue }
            else { localFreeText = newValue }
        }
    }
    @State private var sending = false
    @State private var errorMessage: String?
    /// Post-ACK bridge until the refreshed thread projection carries the
    /// durable `answersPlanRunId` relation. Never the reload authority.
    @State private var acceptedPrompt: String?

    private var effectiveSubmittedPrompt: String? { submittedPrompt ?? acceptedPrompt }

    private var complete: Bool {
        PlanAnswerComposer.isComplete(questions, selections: selections, freeText: freeText)
    }

    private var unansweredQuestionIDs: Set<String> {
        PlanAnswerComposer.unansweredQuestionIDs(
            questions, selections: selections, freeText: freeText)
    }

    private var applicabilityBlocker: String? {
        model.turnStartAdmission(
            target: target, mode: .plan, options: .init()).interactionBlocker
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "list.bullet.clipboard.fill")
                    .foregroundStyle(Theme.status(.attention))
                Text("The plan needs your answers")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if effectiveSubmittedPrompt != nil {
                    Label("submitted", systemImage: "checkmark.circle.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.status(.positive))
                } else {
                    Text("\(questions.count) question\(questions.count == 1 ? "" : "s")")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            if let submitted = effectiveSubmittedPrompt {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text("Answers submitted")
                        .font(.callout.weight(.semibold))
                    Text(submitted)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        ForEach(questions) { question in
                            questionRow(question)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 320)
                .fixedSize(horizontal: false, vertical: true)
                .scrollIndicators(.visible)
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(Theme.status(.negative))
                }
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                    if !complete {
                        Label(
                            "\(unansweredQuestionIDs.count) of \(questions.count) questions still need an answer",
                            systemImage: "exclamationmark.circle"
                        )
                        .font(.caption)
                        .foregroundStyle(Theme.status(.caution))
                    } else if let applicabilityBlocker {
                        Label(applicabilityBlocker, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.status(.caution))
                    } else if model.isThreadBusy(target.threadID, at: target.locationID) {
                        Label("Wait for the running turn to finish", systemImage: "clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(sending ? "Sending…" : "Submit answers") { submit() }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accentSolid)
                        .controlSize(.small)
                        .disabled(
                            !complete || sending
                                || model.isThreadBusy(target.threadID, at: target.locationID)
                                || applicabilityBlocker != nil)
                        .help(applicabilityBlocker ?? (complete
                            ? "Send your answers as a follow-up plan turn"
                            : "Answer every question first"))
                }
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(strokeColor: Theme.status(.attention).opacity(0.45))
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func questionRow(_ question: PlanQuestion) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(question.prompt).font(.callout.weight(.medium))
                if question.kind == "multi" {
                    Text("pick one or more").font(.caption2).foregroundStyle(.secondary)
                }
                if unansweredQuestionIDs.contains(question.id) {
                    Text("required")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.status(.caution))
                        .accessibilityLabel("Answer required")
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
            // Free text is a complete alternative to the offered chips whenever
            // `allow_text` is true; the parser enables it for every plan question.
            if question.kind == "text" || !question.options.isEmpty {
                TextField(
                    question.kind == "text" ? "Your answer" : "Or answer in your own words…",
                    text: Binding(
                        get: { freeText[question.id] ?? "" },
                        set: { value in
                            freeText[question.id] = value
                            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                selections[question.id] = []
                            }
                        }),
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
        if !set.isEmpty { freeText[question.id] = "" }
    }

    private func submit() {
        guard complete, effectiveSubmittedPrompt == nil else { return }
        let prompt = PlanAnswerComposer.encode(questions, selections: selections, freeText: freeText)
        sending = true
        errorMessage = nil
        Task {
            let ok = await model.composerSend(
                prompt: prompt,
                mode: .plan,
                answersPlanRunId: sourcePlanRunId,
                options: routingOptions,
                target: target)
            sending = false
            if ok { acceptedPrompt = prompt }
            else { errorMessage = model.threadStatus ?? "The plan turn was not accepted." }
        }
    }
}
