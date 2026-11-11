import SwiftUI

/// The bounded answer body and its explicit expansion control. Source copying
/// keeps the complete primary output even while only its prefix is laid out.
struct ConversationAnswerText: View {
    let answer: String
    @Binding var expanded: Bool
    var fileScopeRoots: [String] = []
    var remoteFileScope: RemoteFileScope? = nil

    var body: some View {
        let long = TurnCard.isLongAnswer(answer)
        let collapsed = long && !expanded
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            MarkdownOutputView(markdown: collapsed ? ConversationPreviewText.prefix(answer) : answer,
                fileScopeRoots: fileScopeRoots, remoteFileScope: remoteFileScope,
                bodyFont: .body, previewHeight: collapsed ? 260 : nil)
                .clipped()
                .modifier(ProseFoldFade(collapsed: collapsed))
                .environment(\.proseMessageSource, answer)
            if long {
                Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                    .buttonStyle(.borderless).font(.caption).foregroundStyle(Theme.accent)
                    .help(expanded ? "Show only the start of this message." : "Show the rest of this message.")
                    .accessibilityLabel(expanded ? "Show less of answer" : "Show more of answer")
            }
        }
    }
}
