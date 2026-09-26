import SwiftUI
import ClaudexorKit

// MARK: - Thread list rows + rename
//
// Extracted from ThreadsScreen.swift (INV-124 readability ratchet): the
// sidebar row, its subtitle, and the rename sheet/submit. The rename @State
// stays on the owning view; these are its pure render/action helpers.

/// The compact state each thread row reads "at a glance" (D42 item 4): running
/// (a turn is live), needs-decision (blocked on the user), or idle. Pure so the
/// precedence (running outranks needs-decision) is unit-tested.
enum ThreadRowStatus: Equatable {
    case running, needsDecision, idle

    static func of(running: Bool, needsHuman: Bool) -> ThreadRowStatus {
        if running { return .running }
        if needsHuman { return .needsDecision }
        return .idle
    }
}

func formattedRemoteSyncTime(_ date: Date) -> String {
    date.formatted(
        Date.FormatStyle(date: .omitted, time: .shortened)
            .locale(Locale(identifier: "en_US_POSIX")))
}

extension ThreadsScreen {
    /// True when this thread's head run is actively working (per-thread, not the
    /// global submit gate) — drives the running badge.
    func threadRunning(_ located: LocatedThread) -> Bool {
        let tasks = located.locationID == .local
            ? model.liveTasks
            : (model.remoteTasks[located.locationID] ?? [])
        return located.thread.headRunId.flatMap { runID in
            tasks.first { $0.id == runID }?.phase.isActive
        } ?? false
    }

    /// The at-a-glance status badge for a thread row (item 4).
    @ViewBuilder
    func threadStatusBadge(_ located: LocatedThread) -> some View {
        switch ThreadRowStatus.of(
            running: threadRunning(located),
            needsHuman: located.thread.needsHuman)
        {
        case .running:
            ProgressView().controlSize(.small).scaleEffect(0.6).frame(width: 12, height: 12)
                .help("A turn is running in this thread")
        case .needsDecision:
            Image(systemName: "person.fill.questionmark")
                .foregroundStyle(Theme.status(.caution))
                .help("This thread is blocked on your decision")
        case .idle:
            EmptyView()
        }
    }

    /// QA-064: the daemon resiliently SKIPPED some projects whose root is gone
    /// (other projects still load) — surface a non-destructive relink hint so the
    /// hidden threads aren't read as lost. The daemon supplies the exact root; a
    /// shortened name shows inline, the full root is in `.help`.
    @ViewBuilder var projectProblemsBanner: some View {
        if !model.projectListingProblems.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                ForEach(model.projectListingProblems) { problem in
                    Label {
                        Text("Threads from “\(URL(fileURLWithPath: problem.root).lastPathComponent)” are hidden — the project folder is missing. Relink it to restore them.")
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.status(.caution))
                    }
                    .help(problem.message + "\n" + problem.root)
                }
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
        }
    }

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
        guard let id = renameTargetId, let locationID = renameTargetLocation else { return }
        let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        renameTargetId = nil
        renameTargetLocation = nil
        Task { await model.renameThread(locationID: locationID, id: id, title: title) }
    }

    var threadFolderSheet: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(renameFolderTarget == nil ? "New folder" : "Rename folder")
                .font(.headline)
            TextField("Folder name", text: $folderDraft)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submitThreadFolder() }
            HStack {
                Spacer()
                Button("Cancel") {
                    folderThreadTarget = nil
                    renameFolderTarget = nil
                }
                Button(renameFolderTarget == nil ? "Create" : "Rename") {
                    submitThreadFolder()
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(folderDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: 360)
    }

    func submitThreadFolder() {
        let name = folderDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let thread = folderThreadTarget
        let oldName = renameFolderTarget
        folderThreadTarget = nil
        renameFolderTarget = nil
        if let thread {
            Task {
                await model.setThreadFolder(
                    locationID: thread.locationID,
                    id: thread.thread.id,
                    folder: name)
            }
        } else if let oldName {
            Task { await model.renameThreadFolder(oldName, to: name) }
        }
    }

    func threadFolderHeader(_ folder: String) -> some View {
        HStack {
            Label(folder, systemImage: "folder")
            Spacer()
            Menu {
                Button("Rename…") {
                    folderDraft = folder
                    renameFolderTarget = folder
                }
                Button("Remove Folder…", role: .destructive) {
                    removeFolderTarget = folder
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .help("Folder actions")
        }
    }

    func threadRow(_ located: LocatedThread) -> some View {
        let thread = located.thread
        return VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(thread.title ?? "Untitled thread").font(.body).lineLimit(1)
                // Compact status badge so "one card per thread" reads state at a
                // glance: running spinner / needs-decision dot / idle (D42 item 4).
                threadStatusBadge(located)
                if let connection = model.remoteConnection(for: located.locationID) {
                    Text(connection.displayName)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(connection.status == .connected
                            ? Theme.status(.positive) : .secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(
                            (connection.status == .connected
                                ? Theme.status(.positive) : Color.secondary)
                                .opacity(0.12),
                            in: Capsule())
                        .help(connection.status == .connected
                            ? "Connected remote host"
                            : "Remote host is offline; this is a cached summary")
                }
            }
            Text(threadSubtitle(located))
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        // rename/archive ride the existing PATCH /threads/:id (server-owned
        // title/state); the row finally exposes the affordance.
        .contextMenu {
            Button("Rename…") {
                renameDraft = thread.title ?? ""
                renameTargetId = thread.id
                renameTargetLocation = located.locationID
            }
            Menu("Move to Folder") {
                Button("Ungrouped") {
                    Task {
                        await model.setThreadFolder(
                            locationID: located.locationID,
                            id: thread.id,
                            folder: nil)
                    }
                }
                ForEach(model.threadFolderNames, id: \.self) { folder in
                    Button(folder) {
                        Task {
                            await model.setThreadFolder(
                                locationID: located.locationID,
                                id: thread.id,
                                folder: folder)
                        }
                    }
                }
                Divider()
                Button("New Folder…") {
                    folderDraft = ""
                    folderThreadTarget = located
                }
            }
            // ThreadState is active|closed (server enum) — "closed" is the
            // archived state; Reopen PATCHes back to "active".
            if thread.state != "closed" {
                Button("Archive") {
                    Task {
                        await model.archiveThread(
                            locationID: located.locationID, id: thread.id)
                    }
                }
            } else {
                Button("Reopen") {
                    Task {
                        await model.reopenThread(
                            locationID: located.locationID, id: thread.id)
                    }
                }
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    func threadSubtitle(_ thread: ThreadSummary) -> String {
        let project = thread.repoRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No project"
        return "\(project) · \(thread.runIds.count) turn\(thread.runIds.count == 1 ? "" : "s")"
    }

    func threadSubtitle(_ located: LocatedThread) -> String {
        let base = threadSubtitle(located.thread)
        guard located.locationID != .local,
              let cached = model.remoteThreadCache.first(where: { $0.id == located.id })
        else { return base }
        return "\(base) · synced \(formattedRemoteSyncTime(cached.syncedAt))"
    }
}
