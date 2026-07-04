import ClaudexorKit
import SwiftUI

/// Live harness question (waiting_on_user). The run is parked until the user
/// answers or the engine's timeout declines benignly; this card is the answer
/// surface. One card per pending interaction, shown on every tab of the run.
struct InteractionCard: View {
    @Environment(AppModel.self) private var model
    let runId: String
    let interaction: PendingInteraction

    @State private var selections: [String: Set<String>] = [:]
    @State private var freeText: [String: String] = [:]
    @State private var sending = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(Theme.status(.needsReview))
                Text("Needs your answer")
                    .font(.subheadline.weight(.semibold))
                if let harness = interaction.harnessId.flatMap({ HarnessFamily(rawValue: $0) }) {
                    HarnessChip(family: harness)
                }
                Spacer()
                if let timeout = timeoutLabel {
                    Label(timeout, systemImage: "clock")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help("Unanswered questions decline automatically; the model continues with stated assumptions.")
                }
            }

            ForEach(interaction.questions) { question in
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack(spacing: Theme.Spacing.sm) {
                        if let header = question.header, !header.isEmpty {
                            Text(header)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, Theme.Spacing.sm)
                                .padding(.vertical, Theme.Spacing.xxs)
                                .background(Theme.accent.opacity(0.14), in: Capsule())
                                .foregroundStyle(Theme.accent)
                        }
                        Text(question.question).font(.callout.weight(.medium))
                    }
                    FlowLayout(spacing: Theme.Spacing.sm) {
                        ForEach(question.options, id: \.label) { option in
                            Button {
                                toggle(question: question, label: option.label)
                            } label: {
                                Text(option.label)
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, Theme.Spacing.md)
                                    .padding(.vertical, Theme.Spacing.xs)
                            }
                            .buttonStyle(.plain)
                            .selectedChip(active: selections[question.id, default: []].contains(option.label))
                            .help(option.description ?? option.label)
                        }
                    }
                    TextField("Or answer in your own words…", text: binding(for: question.id))
                        .textFieldStyle(.roundedBorder)
                        .font(.callout)
                }
            }

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
                    Text(errorMessage).font(.caption).foregroundStyle(Theme.status(.failed))
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .cardSurface(stroke: true, strokeColor: Theme.status(.needsReview).opacity(0.5))
    }

    private var hasAnyAnswer: Bool {
        interaction.questions.contains { q in
            !selections[q.id, default: []].isEmpty || !(freeText[q.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private var timeoutLabel: String? {
        guard let timeoutAt = interaction.timeoutAt else { return nil }
        // Shared static formatters (AppModel.parseEventDate): ISO8601DateFormatter
        // allocation is expensive and this label re-evaluates on every card render.
        guard let date = AppModel.parseEventDate(timeoutAt) else { return nil }
        let remaining = date.timeIntervalSinceNow
        guard remaining > 0 else { return "expiring" }
        let minutes = Int(remaining / 60)
        return minutes > 0 ? "auto-declines in \(minutes) min" : "auto-declines soon"
    }

    private func binding(for questionId: String) -> Binding<String> {
        Binding(get: { freeText[questionId] ?? "" }, set: { freeText[questionId] = $0 })
    }

    private func toggle(question: InteractionQuestion, label: String) {
        var set = selections[question.id, default: []]
        if set.contains(label) {
            set.remove(label)
        } else {
            if !question.multiSelect { set.removeAll() }
            set.insert(label)
        }
        selections[question.id] = set
    }

    private func submit() {
        let answers = interaction.questions.compactMap { q -> InteractionAnswerPayload? in
            let labels = Array(selections[q.id, default: []])
            let text = (freeText[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !labels.isEmpty || !text.isEmpty else { return nil }
            return InteractionAnswerPayload(questionId: q.id, selectedLabels: labels, freeText: text.isEmpty ? nil : text)
        }
        guard !answers.isEmpty else { return }
        sending = true
        errorMessage = nil
        Task {
            let failure = await model.answerInteraction(runId: runId, interactionId: interaction.interactionId, answers: answers)
            sending = false
            errorMessage = failure
        }
    }
}
