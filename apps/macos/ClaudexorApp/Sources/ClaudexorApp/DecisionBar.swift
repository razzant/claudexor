import SwiftUI

/// Review-queue actions ON a blocked turn (B4): the three server-owned
/// operator decisions, each producing an auditable, patch-hash-bound record —
/// never client-faked state.
///
/// - Accept risk: an editable risks note (a canned string would fake audit
///   detail the operator never wrote).
/// - Rerun with feedback: a REAL feedback sheet (the old button promised "…"
///   and sent a hardcoded sentence).
/// - Override needs-human: destructive-styled with an explicit confirm — it
///   unblocks apply past a needs-human escalation.
struct DecisionBar: View {
    let runId: String
    let onDecided: () async -> Void
    @Environment(AppModel.self) private var model

    @State private var showFeedbackSheet = false
    @State private var feedbackText = ""
    @State private var showAcceptSheet = false
    @State private var acceptedRisksText = ""
    @State private var confirmOverride = false
    @State private var busy = false

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Button("Accept risk & unblock…") { showAcceptSheet = true }
                .help("Records an auditable operator decision (your risk note, bound to this exact patch), then allows apply")
            Button("Rerun with feedback…") {
                feedbackText = ""
                showFeedbackSheet = true
            }
            .help("Enqueues a follow-up run seeded with YOUR feedback text")
            Button("Override needs-human", role: .destructive) { confirmOverride = true }
                .help("Overrides a needs-human escalation with an auditable decision; a mutated patch invalidates it")
            Spacer()
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(busy)
        .sheet(isPresented: $showAcceptSheet) {
            decisionSheet(
                title: "Accept risk & unblock",
                prompt: "What risk are you accepting? This exact text becomes the audit record.",
                text: $acceptedRisksText,
                submitLabel: "Accept risk",
                submitEnabled: !acceptedRisksText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            ) {
                await decide(action: "accept_risk", acceptedRisks: [acceptedRisksText.trimmingCharacters(in: .whitespacesAndNewlines)])
            }
        }
        .sheet(isPresented: $showFeedbackSheet) {
            decisionSheet(
                title: "Rerun with feedback",
                prompt: "Feedback for the follow-up run (what should change).",
                text: $feedbackText,
                submitLabel: "Rerun",
                submitEnabled: !feedbackText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            ) {
                await decide(action: "rerun_with_feedback", feedback: feedbackText.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
        .confirmationDialog(
            "Override the needs-human block?",
            isPresented: $confirmOverride,
            titleVisibility: .visible,
        ) {
            Button("Override & allow apply", role: .destructive) {
                Task { await decide(action: "override_needs_human") }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This records an auditable override bound to the current patch. Apply becomes available; a mutated patch invalidates the override.")
        }
    }

    @ViewBuilder private func decisionSheet(
        title: String,
        prompt: String,
        text: Binding<String>,
        submitLabel: String,
        submitEnabled: Bool,
        submit: @escaping () async -> Void,
    ) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(title).font(.headline)
            Text(prompt).font(.caption).foregroundStyle(.secondary)
            TextEditor(text: text)
                .font(.body)
                .frame(minHeight: 88)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
            HStack {
                Spacer()
                Button("Cancel") {
                    showAcceptSheet = false
                    showFeedbackSheet = false
                }
                Button(submitLabel) {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(!submitEnabled || busy)
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: 420)
    }

    private func decide(action: String, feedback: String? = nil, acceptedRisks: [String]? = nil) async {
        busy = true
        defer { busy = false }
        let error = await model.decide(runId: runId, action: action, feedback: feedback, acceptedRisks: acceptedRisks)
        showAcceptSheet = false
        showFeedbackSheet = false
        if error == nil {
            await model.loadRunDetail(runId)
            await onDecided()
        } else {
            model.threadStatus = error
        }
    }
}
