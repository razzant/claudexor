import ClaudexorKit
import SwiftUI

/// Live harness question (waiting_on_user). The run is parked until the user
/// answers or a finite expiry/lifecycle release ends the wait; automatic expiry
/// may be disabled. One answer card is shown on every tab of the run.
struct InteractionCard: View {
    @Environment(AppModel.self) private var model
    @Environment(ConversationPresentation.self) private var presentation: ConversationPresentation?
    let interaction: PendingInteraction

    @State private var standaloneDraft = InteractionDraft()
    private var draft: Binding<InteractionDraft> {
        presentation?.interactionDraft(runID: interaction.runId, interactionID: interaction.interactionId) ?? $standaloneDraft
    }
    @State private var sending = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(Theme.status(.attention))
                Text("Needs your answer")
                    .font(.subheadline.weight(.semibold))
                if let harness = interaction.harnessId.flatMap({ HarnessFamily(rawValue: $0) }) {
                    HarnessChip(family: harness)
                }
                Spacer()
                Label(
                    InteractionExpiryPresentation.label(timeoutAt: interaction.timeoutAt),
                    systemImage: "clock"
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
                .help(InteractionExpiryPresentation.help(timeoutAt: interaction.timeoutAt))
            }

            // The harness's questions arrive exactly as asked, however long. The
            // header and Send stay fixed; the questions scroll inside the same
            // bounded area as plan question cards, so a long question never
            // grows the card past it and nothing is cut off.
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(interaction.questions) { question in
                        questionRow(question)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // Room for the text fields' bezels, drawn 1pt outside their frames.
                .padding(1)
            }
            .frame(maxHeight: 320)
            .fixedSize(horizontal: false, vertical: true)
            .scrollIndicators(.visible)

            HStack(spacing: Theme.Spacing.md) {
                Button {
                    submit()
                } label: {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Send answer", systemImage: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(sending || !hasAnyAnswer)
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(Theme.status(.negative)).textSelection(.enabled)
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .cardSurface(stroke: true, strokeColor: Theme.status(.attention).opacity(0.5))
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func questionRow(_ question: InteractionQuestion) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            // Header beside the question when both fit on one line; otherwise
            // above it, so neither squeezes the other and both wrap in full.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                    headerChip(question.header)
                    questionText(question.question)
                }
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    headerChip(question.header)
                    questionText(question.question)
                }
            }
            FlowLayout(spacing: Theme.Spacing.sm, wrapsWideSubviews: true) {
                ForEach(question.options, id: \.label) { option in
                    Button {
                        toggle(question: question, label: option.label)
                    } label: {
                        // Model-authored labels wrap inside the row, an
                        // exception to the one-line chip rule (DESIGN_SYSTEM §1
                        // rule 5); the chip-radius rectangle keeps wrapped
                        // lines inside the fill, where a capsule would not.
                        Text(option.label)
                            .font(.caption.weight(.medium))
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, Theme.Spacing.md)
                            .padding(.vertical, Theme.Spacing.xs)
                    }
                    .buttonStyle(.plain)
                    .selectedChip(active: draft.wrappedValue.selections[question.id, default: []].contains(option.label),
                                  shape: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                    .help(option.description ?? option.label)
                }
            }
            TextField("Or answer in your own words…", text: binding(for: question.id))
                .textFieldStyle(.roundedBorder)
                .font(.callout)
        }
    }

    @ViewBuilder
    private func headerChip(_ header: String?) -> some View {
        if let header, !header.isEmpty {
            Text(header)
                .font(.caption2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, Theme.Spacing.xxs)
                .background(Theme.accent.opacity(0.14),
                            in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                .foregroundStyle(Theme.accent)
        }
    }

    private func questionText(_ text: String) -> some View {
        Text(text).font(.callout.weight(.medium)).fixedSize(horizontal: false, vertical: true)
    }

    private var hasAnyAnswer: Bool {
        InteractionAnswerComposer.hasAnyAnswer(interaction, selections: draft.wrappedValue.selections, freeText: draft.wrappedValue.freeText)
    }

    private func binding(for questionId: String) -> Binding<String> {
        Binding(get: { draft.wrappedValue.freeText[questionId] ?? "" }, set: { draft.wrappedValue.freeText[questionId] = $0 })
    }

    private func toggle(question: InteractionQuestion, label: String) {
        var set = draft.wrappedValue.selections[question.id, default: []]
        if set.contains(label) {
            set.remove(label)
        } else {
            if !question.multiSelect { set.removeAll() }
            set.insert(label)
        }
        draft.wrappedValue.selections[question.id] = set
    }

    private func submit() {
        let answers = InteractionAnswerComposer.payloads(interaction, selections: draft.wrappedValue.selections, freeText: draft.wrappedValue.freeText)
        guard !answers.isEmpty else { return }
        sending = true
        errorMessage = nil
        Task {
            let failure = await model.answerInteraction(
                runId: interaction.runId,
                interactionId: interaction.interactionId,
                answers: answers)
            sending = false
            errorMessage = failure
        }
    }
}

/// Visible expiry truth for the card. A nil deadline is a deliberate disabled
/// policy, not missing data, so it must remain explicit on every UI surface.
@MainActor
enum InteractionExpiryPresentation {
    static func label(timeoutAt: String?, now: Date = .now) -> String {
        guard let timeoutAt else { return "No automatic expiry" }
        // Shared static formatters (AppModel.parseEventDate): formatter
        // allocation is expensive and this label re-evaluates on every render.
        guard let date = AppModel.parseEventDate(timeoutAt) else { return "Expiry unavailable" }
        let remaining = date.timeIntervalSince(now)
        guard remaining > 0 else { return "expiring" }
        let minutes = Int(remaining / 60)
        return minutes > 0 ? "auto-declines in \(minutes) min" : "auto-declines soon"
    }

    static func help(timeoutAt: String?) -> String {
        timeoutAt == nil
            ? "This question waits until it is answered, cancelled, or released by run termination or restart."
            : "Unanswered questions decline automatically; the model continues with stated assumptions."
    }
}

/// Pure answer composer for a live interaction — the affordance's completeness
/// gate (`hasAnyAnswer`) and the typed answer payloads are extracted so they are
/// unit-tested (InteractionCardTests); the InteractionCard view only collects
/// selections/free text and calls `AppModel.answerInteraction`.
enum InteractionAnswerComposer {
    static func hasAnyAnswer(_ interaction: PendingInteraction,
                             selections: [String: Set<String>],
                             freeText: [String: String]) -> Bool {
        interaction.questions.contains { q in
            !selections[q.id, default: []].isEmpty || answerText(freeText[q.id]) != nil
        }
    }

    static func payloads(_ interaction: PendingInteraction,
                         selections: [String: Set<String>],
                         freeText: [String: String]) -> [InteractionAnswerPayload] {
        interaction.questions.compactMap { q -> InteractionAnswerPayload? in
            let labels = Array(selections[q.id, default: []])
            let text = answerText(freeText[q.id])
            guard !labels.isEmpty || text != nil else { return nil }
            return InteractionAnswerPayload(questionId: q.id, selectedLabels: labels, freeText: text)
        }
    }

    /// The typed text exactly as entered, or nil when it is blank: whitespace
    /// alone answers nothing, but surrounding spaces of a real answer are kept.
    private static func answerText(_ typed: String?) -> String? {
        guard let typed, !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return typed
    }
}
