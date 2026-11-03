import SwiftUI
import ClaudexorKit

// MARK: - Thread folders in the sidebar
//
// Kept out of ThreadsScreen.swift (INV-124 readability ratchet): the list rows
// with their optional folder sections, the folder header, the Move to Folder
// submenu, and the New/Rename folder sheet with the Remove Folder dialog. The
// labels themselves are daemon-owned (AppModel+ThreadFolders.swift).

/// The folder sheet and dialog state of the thread list (one @State).
struct ThreadFolderEditor {
    var draft = ""
    /// New Folder… files this thread into the folder it names.
    var filing: LocatedThread?
    /// Rename… renames this folder.
    var renaming: String?
    /// Remove Folder… asks to confirm for this folder.
    var removing: String?
}

extension ThreadsScreen {
    /// The rows of the active threads (the collapsed Archived and Trash
    /// sections follow them, ThreadsScreen+Lifecycle). Without folders among
    /// them this is the plain list, exactly as before folders existed (no
    /// section header); with at least one folder, one section per folder, then
    /// "Ungrouped".
    @ViewBuilder func threadListRows(_ active: [LocatedThread]) -> some View {
        let sections = ThreadFolderSection.sections(for: active)
        if sections.isEmpty {
            ForEach(active) { located in
                threadRow(located).tag(located.id)
            }
        } else {
            ForEach(sections) { section in
                Section {
                    ForEach(section.threads) { located in
                        threadRow(located).tag(located.id)
                    }
                } header: {
                    if let folder = section.folder {
                        threadFolderHeader(folder)
                    } else {
                        Text("Ungrouped")
                    }
                }
            }
        }
    }

    func threadFolderHeader(_ folder: String) -> some View {
        HStack {
            Label(folder, systemImage: "folder")
            Spacer()
            Menu {
                Button("Rename…") {
                    folderEditor = ThreadFolderEditor(draft: folder, renaming: folder)
                }
                Button("Remove Folder…", role: .destructive) {
                    folderEditor = ThreadFolderEditor(removing: folder)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .help("Folder actions")
            .accessibilityLabel("Actions for folder \(folder)")
        }
    }

    /// The row context menu's Move to Folder submenu.
    func threadFolderMenu(_ located: LocatedThread) -> some View {
        Menu("Move to Folder") {
            Button("Ungrouped") { moveThread(located, toFolder: nil) }
            ForEach(model.threadFolderNames, id: \.self) { folder in
                Button(folder) { moveThread(located, toFolder: folder) }
            }
            Divider()
            Button("New Folder…") {
                folderEditor = ThreadFolderEditor(filing: located)
            }
        }
    }

    private func moveThread(_ located: LocatedThread, toFolder folder: String?) {
        Task {
            await model.setThreadFolder(
                locationID: located.locationID,
                id: located.thread.id,
                folder: folder)
        }
    }
}

/// The New/Rename folder sheet and the Remove Folder confirmation, driven by
/// the thread list's `ThreadFolderEditor`.
struct ThreadFolderDialogs: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var editor: ThreadFolderEditor

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: Binding(
                get: { editor.filing != nil || editor.renaming != nil },
                set: {
                    if !$0 {
                        editor.filing = nil
                        editor.renaming = nil
                    }
                }
            )) { sheet }
            .confirmationDialog(
                "Remove folder “\(editor.removing ?? "")”?",
                isPresented: Binding(
                    get: { editor.removing != nil },
                    set: { if !$0 { editor.removing = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove Folder", role: .destructive) {
                    guard let folder = editor.removing else { return }
                    editor.removing = nil
                    Task { await model.removeThreadFolder(folder) }
                }
                Button("Cancel", role: .cancel) { editor.removing = nil }
            } message: {
                Text("Threads will move to Ungrouped. No threads or files will be deleted.")
            }
    }

    /// The name the engine will store, or nil while the draft is empty or too long.
    private var name: String? { ThreadFolderName.normalized(editor.draft) }

    private var sheet: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(editor.renaming == nil ? "New folder" : "Rename folder")
                .font(.headline)
            TextField("Folder name", text: $editor.draft)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submit() }
            // Says why Create/Rename is disabled; the row is always laid out so
            // the buttons never move while typing (INV-134).
            let explains = name == nil && !editor.draft.isEmpty
            Text("A folder name has 1 to \(ThreadFolderName.maxLength) characters.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .opacity(explains ? 1 : 0)
                .accessibilityHidden(!explains)
            HStack {
                Spacer()
                Button("Cancel") {
                    editor.filing = nil
                    editor.renaming = nil
                }
                Button(editor.renaming == nil ? "Create" : "Rename") { submit() }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accentSolid)
                    .disabled(name == nil)
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: 360)
    }

    private func submit() {
        guard let name else { return }
        let filing = editor.filing
        let renaming = editor.renaming
        editor.filing = nil
        editor.renaming = nil
        if let filing {
            Task {
                await model.setThreadFolder(
                    locationID: filing.locationID,
                    id: filing.thread.id,
                    folder: name)
            }
        } else if let renaming {
            Task { await model.renameThreadFolder(renaming, to: name) }
        }
    }
}
