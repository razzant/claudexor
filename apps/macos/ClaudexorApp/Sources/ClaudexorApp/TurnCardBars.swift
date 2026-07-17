import SwiftUI
import ClaudexorKit

// MARK: - Turn-adjacent action bars
//
// Extracted from TurnCard.swift (INV-124 readability ratchet): the isolated-
// thread apply bar and the frozen-spec card are self-contained sibling views
// of the turn card. Pure move — zero behavior change.

/// Deliver an ISOLATED thread's accumulated worktree diff to its project. Renders
/// the ControlThreadApplyResponse honestly (applied/branched/empty/conflict/rejected
/// + a HEAD-moved warning) — the server owns whether the apply lands.
struct ApplyThreadBar: View {
    @Environment(AppModel.self) private var model
    let threadId: String
    @State private var applying = false
    /// Honest outcome of the apply, distinguishing the three states unambiguously
    /// (the old `String?` conflated "applied OK" and "no attempt" as empty-ish and
    /// left the buttons live after success: repeat-click re-applied the thread).
    private enum Outcome {
        case idle              // no attempt yet — offer Apply / As branch
        case applied           // a completed apply SUCCEEDED — lock the buttons
        case failed(String)    // a completed apply returned an honest message
    }
    @State private var outcome: Outcome = .idle

    private var isApplied: Bool { if case .applied = outcome { return true }; return false }

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: isApplied ? "checkmark.seal.fill" : "arrow.up.doc.on.clipboard")
                .foregroundStyle(isApplied ? Theme.status(.succeeded) : Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Isolated workspace").font(.caption.weight(.medium))
                switch outcome {
                case .applied:
                    Text("Applied to the project — this thread's worktree has been delivered.")
                        .font(.caption).foregroundStyle(Theme.status(.succeeded))
                case .failed(let message):
                    Text(message).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                case .idle:
                    Text("Turns are kept in a thread worktree — apply them to the project when ready.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            // After a successful apply the thread is delivered — HIDE the apply actions
            // so it can't be re-applied by mistake; show an explicit "Applied" state.
            if isApplied {
                Label("Applied", systemImage: "checkmark.seal.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.status(.succeeded))
            } else {
                Button(applying ? "Applying…" : "Apply thread") {
                    applying = true
                    Task {
                        let err = await model.applyThread(id: threadId)
                        applying = false
                        outcome = err.map(Outcome.failed) ?? .applied
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(applying)
                .help("Deliver the thread's accumulated diff to the project (server-gated)")
                Button("As branch") {
                    applying = true
                    Task {
                        let err = await model.applyThread(id: threadId, mode: "branch")
                        applying = false
                        outcome = err.map(Outcome.failed) ?? .applied
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(applying)
                .help("Deliver onto a new branch instead of the working tree")
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
    }
}

/// Renders a turn's live transcript: reasoning (collapsible), tool calls (compact
/// mono rows with a status glyph), and assistant messages. Built from the
/// `TranscriptReducer` fold of the SSE stream.
/// The frozen-spec card: the SpecPack is sealed (id + hash + change count) and an
/// Implement button (styled like "Implement plan") sends an agent turn that reads
/// the spec FILE. The path is server-returned (never composed in Swift).
struct SpecFrozenCard: View {
    @Environment(AppModel.self) private var model
    /// The OWNING thread (captured at render) so Implement targets it, not selection.
    let threadId: String
    let specId: String
    let specPath: String
    let specHash: String
    let changes: Int
    @State private var implementing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "snowflake").foregroundStyle(Theme.accent)
                Text("Spec frozen").font(.subheadline.weight(.semibold))
                Spacer()
                // Dismiss the frozen card without implementing (otherwise the card is
                // a dead-end — the user froze a spec but chose not to run it).
                Button("Dismiss") { model.cancelSpec(threadId: threadId) }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(implementing)
                    .help("Clear this frozen spec without implementing it")
                Button(implementing ? "Implementing…" : "Implement") {
                    implementing = true
                    Task {
                        await model.implementSpec(threadId: threadId, specPath: specPath)
                        implementing = false
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                // Can't start an Implement turn over a live head run (composerSend
                // also rejects it; the button reflects the invariant).
                .disabled(implementing || model.selectedThreadBusy)
                .help("Run an agent turn that implements this frozen spec")
            }
            HStack(spacing: Theme.Spacing.md) {
                Label(specId, systemImage: "doc.badge.gearshape")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Label(String(specHash.prefix(12)), systemImage: "number")
                    .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    .help("Spec hash \(specHash)")
                Label("\(changes) change\(changes == 1 ? "" : "s")", systemImage: "plusminus")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(Theme.Spacing.lg)
        .cardSurface(stroke: true, strokeColor: Theme.accent.opacity(0.5))
    }
}
