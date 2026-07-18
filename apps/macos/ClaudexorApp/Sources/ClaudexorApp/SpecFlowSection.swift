import SwiftUI

struct SpecFlowSection: View {
    @Environment(AppModel.self) private var model

    @ViewBuilder var body: some View {
        // `specFlow` is non-nil only for the selected thread, so `tid` is the OWNING
        // thread — captured here and passed into the cards so their actions bind to
        // it (not to whatever is selected when the async submit/implement resolves).
        if let tid = model.selectedThreadId, let flow = model.specFlow {
        switch flow {
        case .askingQuestions(_, let questions, let planDir, let planRunId, let answers, let error):
            // Seed the card from `answers` so an unresolved-clarifications 400
            // re-opens with the user's prior picks intact (they fix only the missing
            // fields, never re-answer everything). `id:` keys the @State to the
            // current answer set so a re-derived card re-seeds instead of reusing
            // stale @State from the previous render.
            SpecQuestionCard(threadId: tid, questions: questions, planDir: planDir, planRunId: planRunId,
                             initialAnswers: answers, errorMessage: error)
                .id(SpecQuestionCard.seedIdentity(answers))
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.sm)
        case .grounding:
            // Pre-questions: the grounding plan is reading the repo to derive the
            // interview. Nothing is frozen yet — don't claim it is.
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView().controlSize(.small)
                Text("Running the grounding plan…")
                    .font(.callout).foregroundStyle(.secondary)
                    .help("Reading the project to prepare the spec interview — this can take a few minutes.")
                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        case .freezing:
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView().controlSize(.small)
                Text("Freezing the spec…")
                    .font(.callout).foregroundStyle(.secondary)
                    .help("Assembling and freezing the SpecPack from your answers — this can take a few minutes.")
                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        case .recovering(let sessionId, let phase):
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView().controlSize(.small)
                Text(phase == "freezing" ? "Finishing the recovered spec…" : "Recovering the grounding plan…")
                    .font(.callout).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { model.cancelSpec(threadId: tid) }
                    .buttonStyle(.bordered).controlSize(.small)
                    .help("Cancel this durable Spec session")
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
            .id(sessionId)
        case .interrupted(let sessionId, let message):
            HStack(spacing: Theme.Spacing.sm) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                Spacer()
                Button("Resume") {
                    Task { await model.resumeSpecSession(threadId: tid, sessionId: sessionId) }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                Button("Dismiss") { model.cancelSpec(threadId: tid) }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        case .frozen(let sessionId, let specId, let specPath, let specHash,
                     let changes, let recovered):
            SpecFrozenCard(threadId: tid, sessionId: sessionId, specId: specId,
                           specPath: specPath, specHash: specHash, changes: changes,
                           recovered: recovered)
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.sm)
        case .error(let message):
            HStack(spacing: Theme.Spacing.sm) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout).foregroundStyle(.orange)
                    .textSelection(.enabled)
                Spacer()
                Button("Dismiss") { model.cancelSpec(threadId: tid) }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        }
        }
    }
}
