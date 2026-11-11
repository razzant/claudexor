import ClaudexorKit
import SwiftUI

struct HistoryEvidenceNotice: View {
    let row: ThreadHistoryTurn
    let locationID: ExecutionLocationID

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if row.primaryOutputStatus == "not_retained" {
                Text("The saved answer is no longer retained.")
                    .help("Run retention no longer provides the saved answer or its artifact address.")
            } else if let output = row.primaryOutput, output.truncated || output.text == nil,
                      let runID = row.runId {
                Text("Answer preview is limited. Open the saved output for the full text.")
                HistoryArtifactButton(title: "Open saved output", runID: runID,
                    path: output.path, locationID: locationID)
            }
            if let run = row.run {
                if let decision = run.unverifiedOperatorDecision, run.operatorDecisionCoverage == "unavailable" {
                    Text("Recorded decision: \(decision.action.replacingOccurrences(of: "_", with: " ")) — not verified.")
                        .help("The retained evidence cannot verify this decision. It does not waive the required actions or enable Apply.")
                } else if run.operatorDecisionCoverage == "unavailable" {
                    Text("Operator decision evidence is unavailable.")
                }
                ForEach(run.requiredActions, id: \.id) { action in Text(action.detail) }
                if run.failureMessageInfo?.truncated == true, let path = run.failure?.rawDetailRef,
                   let runID = row.runId {
                    HistoryArtifactButton(title: "Open full failure detail", runID: runID,
                        path: path, locationID: locationID)
                        .help("The failure message is a bounded preview. Read the recorded full detail.")
                }
            }
        }.font(.caption).foregroundStyle(.secondary)
    }
}

/// Uses the existing artifact plane, only in response to an explicit action.
struct HistoryArtifactButton: View {
    @Environment(AppModel.self) private var model
    let title: String
    let runID: String
    let path: String
    let locationID: ExecutionLocationID
    @State private var showing = false
    @State private var preview: LoadState<SafeFilePreviewRequest> = .idle

    var body: some View {
        Button(title) { showing = true; Task { await load() } }
            .buttonStyle(.link)
            .sheet(isPresented: $showing) {
                ArtifactPreviewSheet(state: preview, path: path) { Task { await load() } }
            }
    }

    private func load() async {
        preview = .loading
        do {
            preview = .loaded(try await stagedArtifactPreview(model: model, locationID: locationID,
                runId: runID, path: path, produced: false))
        } catch {
            preview = .failed(error as? PayloadError ?? .notRenderable("\(path): \(error.localizedDescription)"))
        }
    }
}
