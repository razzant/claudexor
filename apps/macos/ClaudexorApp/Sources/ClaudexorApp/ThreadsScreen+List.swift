import SwiftUI
import ClaudexorKit

// MARK: - Thread list rows + rename
//
// Extracted from ThreadsScreen.swift (INV-124 readability ratchet): the
// sidebar row, its subtitle, and the rename sheet/submit. The rename @State
// stays on the owning view; these are its pure render/action helpers.

extension ThreadsScreen {
    var renameSheet: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Rename thread").font(.headline)
            TextField("Thread title", text: $renameDraft)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submitRename() }
            HStack {
                Spacer()
                Button("Cancel") { renameTargetId = nil }
                Button("Rename") { submitRename() }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: 360)
    }

    func submitRename() {
        guard let id = renameTargetId else { return }
        let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        renameTargetId = nil
        Task { await model.renameThread(id, title: title) }
    }

    func threadRow(_ thread: ThreadSummary) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(thread.title ?? "Untitled thread").font(.body).lineLimit(1)
                if thread.needsHuman {
                    Image(systemName: "person.fill.questionmark")
                        .foregroundStyle(Theme.status(.caution))
                        .help("This thread is blocked on your decision")
                }
            }
            Text(threadSubtitle(thread)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        // rename/archive ride the existing PATCH /threads/:id (server-owned
        // title/state); the row finally exposes the affordance.
        .contextMenu {
            Button("Rename…") {
                renameDraft = thread.title ?? ""
                renameTargetId = thread.id
            }
            // ThreadState is active|closed (server enum) — "closed" is the
            // archived state; Reopen PATCHes back to "active".
            if thread.state != "closed" {
                Button("Archive") { Task { await model.archiveThread(thread.id) } }
            } else {
                Button("Reopen") { Task { await model.reopenThread(thread.id) } }
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    func threadSubtitle(_ thread: ThreadSummary) -> String {
        let project = thread.repoRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No project"
        return "\(project) · \(thread.runIds.count) turn\(thread.runIds.count == 1 ? "" : "s")"
    }
}
