import SwiftUI

struct HistoryPromptActions: View {
    let read: () async throws -> String
    @State private var loading = false
    @State private var failure: String?
    @State private var fullPrompt: String?
    @State private var showing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Prompt preview — the first 32 KiB are shown.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Copy full prompt") { load(copy: true) }
                Button("Show full prompt") { load(copy: false) }
            }.buttonStyle(.borderless).font(.caption).disabled(loading)
                .help(loading ? "Loading the full saved prompt." : "Read the complete saved prompt from the engine.")
            if loading { Text("Loading full prompt…").font(.caption) }
            if let failure { Text(failure).font(.caption).foregroundStyle(.secondary) }
        }
        .sheet(isPresented: $showing, onDismiss: { fullPrompt = nil }) {
            HistoryFullPromptSheet(prompt: fullPrompt ?? "", done: { showing = false })
        }
    }

    private func load(copy: Bool) {
        loading = true; failure = nil
        Task {
            do {
                let text = try await read()
                if copy {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                } else { fullPrompt = text; showing = true }
            } catch { failure = "Could not load full prompt: \(error.localizedDescription)" }
            loading = false
        }
    }
}

/// The full-prompt sheet's content, independent of the mounted feed surface.
struct HistoryFullPromptSheet: View {
    let prompt: String
    var done: () -> Void = {}
    var body: some View {
        VStack(alignment: .leading) {
            Text("Full prompt").font(.headline)
            ScrollView { ProseText(document: ProseBuilder.plain(prompt), accessibilityName: "Full user message") }
            Button("Done", action: done).keyboardShortcut(.cancelAction)
        }.padding().frame(width: 680, height: 600)
            .environment(\.conversationReadingPosition, nil)
            .environment(\.proseMessageID, nil)
            .environment(\.conversationComposerInput, nil)
            .environment(\.proseMessageCopyAction, nil)
            .environment(\.proseMessageSource, prompt)
    }
}
