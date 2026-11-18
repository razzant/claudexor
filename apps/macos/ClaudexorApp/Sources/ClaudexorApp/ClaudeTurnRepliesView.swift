import AppKit
import ClaudexorKit
import SwiftUI

struct ClaudeTurnRepliesView: View {
    @Environment(AppModel.self) private var model
    let replies: ClaudeTurnReplies
    let run: TaskRun
    let runID: String
    let location: ExecutionLocationID
    let executionRoot: String?
    private struct JournalTarget: Identifiable {
        let reply: ClaudeTurnReplies.Reply
        let copy: Bool
        var id: Int { reply.seq }
    }
    @State private var target: JournalTarget?

    var body: some View {
        if !replies.rows.isEmpty || replies.partial {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(replies.rows) { reply in
                    if reply.isTurnReply {
                        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                            Text(Self.title(for: reply, in: replies, active: run.phase == .running))
                                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text(reply.source?.attribution ?? "Attempt unknown · Session unknown")
                                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                            ClaudeReplyText(reply: reply, run: run, executionRoot: executionRoot,
                                open: { copy in target = JournalTarget(reply: reply, copy: copy) })
                                .environment(\.proseReplySequence, reply.seq)
                        }
                    } else if reply.source?.afterStop == nil {
                        Button("Read journal event #\(reply.seq) · Stop timing unknown") { target = JournalTarget(reply: reply, copy: false) }
                            .buttonStyle(.link)
                    }
                }
                if replies.partial {
                    Text("Reply history may be incomplete.").font(.caption).foregroundStyle(.secondary)
                    if let directory = run.runDir {
                        let path = URL(fileURLWithPath: directory).appendingPathComponent("events.jsonl")
                        Button(location == .local ? "Show journal in Finder" : "Open journal folder in SSH") {
                            if location == .local {
                                NSWorkspace.shared.activateFileViewerSelecting([path])
                            } else if model.selectedExecutionLocation == location {
                                Task { @MainActor in
                                    guard model.selectedExecutionLocation == location else { return }
                                    await model.openRemoteTerminal(directory: directory, title: "Run journal")
                                }
                            }
                        }.buttonStyle(.link)
                        Text(verbatim: path.path).font(.caption.monospaced()).textSelection(.enabled)
                    } else {
                        Text("Run folder unavailable.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .sheet(item: $target) { selected in
                ClaudeReplyJournal(runID: runID, location: location, reply: selected.reply, copyOnOpen: selected.copy)
            }
        }
    }

    static func title(for reply: ClaudeTurnReplies.Reply, in replies: ClaudeTurnReplies, active: Bool) -> String {
        if let source = reply.source, source.attemptId != nil, source.sessionId != nil,
           replies.rows.contains(where: { $0.isTurnReply && $0.seq > reply.seq && $0.source == source }) {
            return "Earlier Claude turn reply"
        }
        return active ? "Claude turn reply · Run still active" : "Claude turn reply"
    }
}

private struct ClaudeReplyText: View {
    let reply: ClaudeTurnReplies.Reply
    let run: TaskRun
    let executionRoot: String?
    let open: (Bool) -> Void
    @State private var expanded = false

    var body: some View {
        if reply.truncated {
            Text("Reply preview").font(.caption).foregroundStyle(.secondary)
            MarkdownOutputView(markdown: ConversationPreviewText.prefix(reply.text),
                fileScopeRoots: TurnCard.fileScopeRoots(executionRoot: executionRoot, runDir: run.runDir),
                remoteFileScope: TurnCard.remoteFileScope(run, executionRoot: executionRoot),
                bodyFont: .body, previewHeight: 260)
                .clipped()
                .modifier(ProseFoldFade(collapsed: true))
                .environment(\.proseMessageCopyAction, { open(true) })
            Button("Read full reply · Event #\(reply.seq)") { open(false) }.buttonStyle(.link)
        } else {
            ConversationAnswerText(answer: reply.text, expanded: $expanded,
                fileScopeRoots: TurnCard.fileScopeRoots(executionRoot: executionRoot, runDir: run.runDir),
                remoteFileScope: TurnCard.remoteFileScope(run, executionRoot: executionRoot))
        }
    }
}
