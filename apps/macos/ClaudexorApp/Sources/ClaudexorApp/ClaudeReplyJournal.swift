import ClaudexorKit
import SwiftUI

/// Read an addressed event. Page navigation keeps just one page on screen.
struct ClaudeReplyJournal: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let runID: String
    let location: ExecutionLocationID
    let reply: ClaudeTurnReplies.Reply
    let copyOnOpen: Bool

    private enum Action { case first, next, copy }
    @State private var action = Action.first
    @State private var request = UUID()
    @State private var client: GatewayClient?
    @State private var firstPart: ClaudeReplyJournalEvent.Part?
    @State private var event: ClaudeReplyJournalEvent?
    @State private var loading = true
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(reply.isTurnReply ? "Claude turn reply" : "Journal evidence · Stop timing unknown").font(.headline)
            Text("\(runID) · Event #\(reply.seq)").font(.caption.monospaced()).textSelection(.enabled)
            if let event {
                if event.isRawPage {
                    Text(event.complete ? "Raw JSON page · Whole-event checksum verified." :
                        "Raw JSON page. The last page verifies the whole event.").font(.caption)
                }
                if let source = event.source { Text(source.attribution).font(.caption).textSelection(.enabled) }
                ScrollView {
                    Text(verbatim: event.text).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.id(event.offset)
                HStack {
                    Text("Bytes \(event.offset + 1)–\(event.nextOffset) of \(event.totalBytes)").font(.caption)
                    if event.offset > 0 { Button("First page") { start(.first) } }
                    if !event.complete { Button("Next page") { start(.next) } }
                    Button(reply.isTurnReply ? "Copy full reply" : "Copy recorded text") { start(.copy) }
                }.disabled(loading)
            }
            if loading { ProgressView("Reading journal…").controlSize(.small) }
            if let note {
                Text(note).foregroundStyle(.secondary).textSelection(.enabled)
                if event == nil { Button("Retry") { start(.first) } }
            }
            Spacer(minLength: 0)
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.cancelAction) }
        }
        .padding().frame(width: 580, height: 440)
        .task(id: request) { await load() }
    }

    private func start(_ action: Action) {
        self.action = action
        note = nil
        loading = true
        request = UUID()
    }

    private func load() async {
        defer { if !Task.isCancelled { loading = false } }
        if client == nil { client = model.gateway(for: location) }
        guard let client else { note = "Engine unavailable."; return }
        func stillSelected() -> Bool {
            model.selectedExecutionLocation == location && model.isCurrentGateway(client, at: location)
        }
        guard stillSelected() else { note = "Engine unavailable."; return }
        do {
            let copy = action == .copy || (firstPart == nil && copyOnOpen)
            if action != .copy {
                var read = (action == .next ? event : nil) ?? ClaudeReplyJournalEvent(runID: runID, seq: reply.seq, expected: reply)
                let part = try await client.claudeReplyJournalPart(runId: runID, seq: reply.seq, offset: read.nextOffset)
                try Task.checkCancellation()
                guard stillSelected() else { throw URLError(.cancelled) }
                try read.accept(part)
                if read.offset == 0 { firstPart = part }
                event = read
            }
            if copy, let firstPart {
                let text = try await client.fullClaudeReply(runID: runID, reply: reply, firstPart: firstPart)
                try Task.checkCancellation()
                guard stillSelected() else { throw URLError(.cancelled) }
                note = ProseCodeActions.write(text) ? "Copied the complete text." : "Could not copy the text."
            }
        } catch {
            guard !Task.isCancelled else { return }
            switch error {
            case GatewayError.decoding(let detail): note = detail
            case GatewayError.http(let status, _) where status == 404: note = "Event #\(reply.seq) is unavailable."
            case GatewayError.http(let status, _) where status == 422: note = "Event #\(reply.seq) is unreadable."
            case GatewayError.http(let status, _) where status == 410: note = "Retention reclaimed this run’s journal."
            default: note = "Could not read event #\(reply.seq). \(error.localizedDescription)"
            }
        }
    }
}
