import AppKit
import ClaudexorKit
import SwiftUI

/// The Run Detail "Evidence" tab: artifacts gallery + diagnostics summary +
/// retry / run-again actions. Extracted from `TaskDetailView` (the readability
/// ratchet) into its own view that owns the diagnostics/run-again state — the
/// controls here are only reachable from this tab, so the state, the Run-Again
/// sheet, and the copy/retry helpers live with them, not on the detail shell.
struct RunEvidenceView: View {
    @Environment(AppModel.self) private var model
    let task: TaskRun

    @State private var actionError: String?
    @State private var retrying = false
    @State private var runAgainDraft: RunAgainDraft?
    @State private var runAgainPrompt = ""
    @State private var showRunAgain = false
    @State private var runningAgain = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Artifacts", systemImage: "photo.on.rectangle.angled")
                ArtifactGalleryView(runId: task.id)
                    .frame(minHeight: 160)
            }
            diagnosticsContent(task)
        }
        .sheet(isPresented: $showRunAgain) { runAgainSheet }
    }

    private func diagnosticsContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Diagnostics summary", systemImage: "stethoscope")
            HStack(spacing: Theme.Spacing.sm) {
                Button {
                    copyDiagnostics(task)
                } label: {
                    Label("Copy Summary", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .help("Copy the bounded diagnostics summary and run metadata.")
                Button {
                    if let runDir = task.runDir { NSWorkspace.shared.open(URL(fileURLWithPath: runDir)) }
                } label: {
                    Label("Open Run Folder", systemImage: "folder")
                }
                .buttonStyle(.bordered)
                .disabled(task.runDir == nil)
                .help(task.runDir ?? "Run folder is not available yet.")
                Button {
                    NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claudexor/v3/daemon/claudexord.log"))
                } label: {
                    Label("Open Daemon Log", systemImage: "terminal")
                }
                .buttonStyle(.bordered)
                .help("Open ~/.claudexor/v3/daemon/claudexord.log.")
                Button {
                    retrying = true
                    Task {
                        actionError = await model.retryRunExact(task.id)
                        retrying = false
                    }
                } label: { Label(retrying ? "Retrying…" : "Retry Exact", systemImage: "arrow.clockwise") }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(retrying)
                .help("Create a new attempt from the immutable original request and run a fresh preflight.")
                Button {
                    Task {
                        guard let draft = await model.loadRunAgainDraft(task.id) else {
                            actionError = "Could not load the editable run draft."
                            return
                        }
                        runAgainDraft = draft
                        runAgainPrompt = draft.request["prompt"]?.stringValue ?? task.prompt
                        showRunAgain = true
                    }
                } label: { Label("Run Again…", systemImage: "square.and.pencil") }
                .buttonStyle(.bordered)
                .help("Open a new editable draft; this is not an exact retry.")
            }
            if let actionError {
                Text(actionError).font(.caption).foregroundStyle(Theme.status(.negative)).textSelection(.enabled)
            }
            if let error = task.engineError, !error.isEmpty {
                Panel(padding: Theme.Spacing.md) {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(Theme.status(.negative))
                        .textSelection(.enabled)
                }
            }
            Panel {
                Text(task.diagnosticText ?? "Diagnostics are not loaded yet. Refresh this run or reconnect the engine.")
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !task.artifactPaths.isEmpty {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        SectionLabel("All artifact paths", systemImage: "folder")
                        ForEach(task.artifactPaths, id: \.self) { path in
                            Text(path)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        }
    }

    private var runAgainSheet: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Run Again").font(.title2.bold())
            Text("This creates a new editable run. Exact Retry is the immutable replay action.")
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: $runAgainPrompt)
                .font(.body)
                .frame(minHeight: 180)
                .padding(Theme.Spacing.sm)
                .background(Theme.surfaceRaisedHi, in: RoundedRectangle(cornerRadius: Theme.Radius.control))
            if let draft = runAgainDraft, !draft.differences.isEmpty {
                ForEach(Array(draft.differences.enumerated()), id: \.offset) { _, difference in
                    Text("\(difference.field): \(difference.change) — \(difference.reason)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { showRunAgain = false }
                Button(runningAgain ? "Starting…" : "Start New Run") {
                    guard let draft = runAgainDraft else { return }
                    runningAgain = true
                    Task {
                        actionError = await model.startRunAgain(draft, prompt: runAgainPrompt)
                        runningAgain = false
                        if actionError == nil { showRunAgain = false }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(runningAgain || runAgainPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(Theme.Spacing.xl)
        .frame(width: 560)
    }

    private func copyDiagnostics(_ task: TaskRun) {
        var text = [
            "run: \(task.id)",
            "mode: \(task.mode.apiValue)",
            "phase: \(task.phase.label)",
            "project: \(task.project)",
        ].joined(separator: "\n")
        if let runDir = task.runDir { text += "\nrunDir: \(runDir)" }
        if let engineError = task.engineError { text += "\n\n# Engine Error\n\(engineError)" }
        if let diagnostics = task.diagnosticText { text += "\n\n# Diagnostics\n\(diagnostics)" }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
