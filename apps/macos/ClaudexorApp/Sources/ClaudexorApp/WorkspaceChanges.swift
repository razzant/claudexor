import SwiftUI
import ClaudexorKit

// MARK: - Thread workspace · Changes tab (D42)
//
// The thread-cumulative change surface: the isolated-thread apply-thread action
// (the whole thread's diff → project) plus the per-run diffs listed beneath.
// Selecting a receipt scopes this to that one run and adds its server-eligibility
// gated Apply / Revert. Apply BUTTONS are HIDDEN unless the server says the run
// is eligible (batch-6 item f); a decision-flow run applies from its chat receipt
// instead, never twice (D42).

struct WorkspaceChangesView: View {
    let threadId: String
    let isolated: Bool
    let runIds: [String]
    /// True when scoped to a single selected receipt (adds that run's apply/revert).
    let filtered: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            // The thread-cumulative apply (isolated threads) rides the whole-thread
            // view; when filtered to one run its own apply/revert takes over.
            if isolated && !filtered {
                Panel(padding: 0) { ApplyThreadBar(threadId: threadId) }
            }
            if runIds.isEmpty {
                EmptyStateView(
                    title: "No project output in this thread",
                    message: "No run in this thread produced a patch.",
                    systemImage: "plusminus.circle")
            } else {
                ForEach(runIds, id: \.self) { runId in
                    RunDiffSection(runId: runId, showActions: filtered)
                }
            }
        }
    }
}

/// One run's diff section inside the Changes tab. Loads the run's patch into an
/// identity-keyed slot (D15 — a run switch never paints another run's diff) and,
/// when the panel is scoped to this run, renders its server-eligibility gated
/// Apply / Revert (item f).
struct RunDiffSection: View {
    @Environment(AppModel.self) private var model
    let runId: String
    /// True when this is the single selected receipt (show apply/revert).
    let showActions: Bool

    @State private var diffSlot = PayloadSlot<[DiffFile]>()
    @State private var actionError: String?
    @State private var applied = false
    @State private var reverting = false

    private var run: TaskRun? { model.task(runId) }

    /// A decision-flow run applies from its CHAT RECEIPT (decide → apply inline),
    /// never here — so the workspace never duplicates its apply (D42).
    private var isDecisionFlow: Bool {
        guard let run else { return false }
        return run.reviewNeedsDecision || run.operatorDecisionAction != nil
    }

    /// Item f: Apply is shown ONLY when the server-owned eligibility says the run
    /// can be applied now, and it is not a decision-flow run (that applies inline).
    private var canApply: Bool {
        !isDecisionFlow && run?.applyEligibility?.eligible == true && !applied
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            header
            diffBody
            if showActions { actions }
        }
        .task(id: "\(runId):\(run?.hasPatchArtifact == true)") { await loadDiff() }
        // A scoped run needs its detail (eligibility/revertable) to gate apply.
        .task(id: showActions ? runId : "") {
            if showActions, let run, run.applyEligibility == nil || run.isLive { await model.loadRunDetail(runId) }
        }
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.sm) {
            SectionLabel("Run \(String(runId.suffix(6)))", systemImage: "plusminus.circle")
            if case .loaded(let files) = diffSlot.state, !files.isEmpty {
                let adds = files.reduce(0) { $0 + $1.added }
                let dels = files.reduce(0) { $0 + $1.removed }
                Text("\(files.count) file\(files.count == 1 ? "" : "s") · +\(adds) −\(dels)")
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Spacer()
        }
    }

    @ViewBuilder private var diffBody: some View {
        switch diffSlot.state {
        case .loaded(let files):
            DiffView(files: files)
        case .failed(let error):
            Panel {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Label(error.message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.status(.caution))
                    Button("Retry") { Task { await loadDiff() } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
        case .empty:
            Text("No changes in this run.")
                .font(.caption).foregroundStyle(.secondary)
        case .idle, .loading:
            ProgressView().controlSize(.small)
        }
    }

    @ViewBuilder private var actions: some View {
        if let run {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                if applied {
                    Label("Applied to project", systemImage: "checkmark.seal.fill")
                        .font(.caption).foregroundStyle(Theme.status(.positive))
                } else if canApply {
                    HStack(spacing: Theme.Spacing.sm) {
                        Button("Apply patch") { apply(mode: "apply") }
                        Button("Apply as branch") { apply(mode: "branch") }
                        Spacer()
                    }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                }
                if run.revertable && !applied {
                    Button(reverting ? "Reverting…" : "Revert") { revert() }
                        .buttonStyle(.bordered).controlSize(.small).disabled(reverting)
                        .help("Restore the project to this run's pre-turn state (server refuses if you've edited since).")
                }
                if let actionError {
                    Text(actionError).font(.caption).foregroundStyle(Theme.status(.negative))
                }
            }
        }
    }

    private func apply(mode: String) {
        Task {
            actionError = await model.applyRun(runId: runId, mode: mode)
            if actionError == nil { applied = true }
        }
    }

    private func revert() {
        reverting = true
        Task {
            let outcome = await model.revertRun(runId: runId)
            reverting = false
            switch outcome {
            case .reverted: actionError = nil; applied = false
            case .diverged(let m), .error(let m): actionError = m
            }
        }
    }

    private func loadDiff() async {
        let id = PayloadIdentity(runId: runId, plane: .diff)
        diffSlot.begin(id)
        guard let run = model.task(runId), run.hasPatchArtifact else {
            diffSlot.commit(.empty, for: id)
            return
        }
        if !run.diff.isEmpty { diffSlot.commit(.loaded(run.diff), for: id); return }
        switch await model.loadRunDiff(runId) {
        case .loaded: diffSlot.commit(.loaded(model.task(runId)?.diff ?? []), for: id)
        case .unavailable: diffSlot.commit(.empty, for: id)
        case .failed(let message): diffSlot.commit(.failed(.transport(message)), for: id)
        }
    }
}
