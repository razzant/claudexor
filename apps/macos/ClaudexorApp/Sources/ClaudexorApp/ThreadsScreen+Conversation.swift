import SwiftUI
import ClaudexorKit

extension View {
    /// F10: constrain to the conversation's readable measure (~Apple readable
    /// content) and CENTER it, so message/progress cards and the composer read as
    /// one column instead of stretching the full window ("слишком широкие").
    /// Responsive below the cap.
    func conversationMeasure() -> some View {
        frame(maxWidth: Theme.Layout.conversationMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
    }
}

// Conversation-pane view helpers for ThreadsScreen, extracted so the main
// screen stays under the readability ratchet. Same views, same behavior — the
// empty-conversation placeholder and the native-session footer.
extension ThreadsScreen {
    var emptyConversation: some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(.secondary)
            Text("Start a thread")
                .font(.title2.weight(.bold))
                .foregroundStyle(.primary)
            Text("Type below to begin. Turns run in-place so the next turn sees the work — plan, then implement, in one conversation.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 440)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    func sessionsFooter(_ sessions: [ThreadSessionInfo]) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "link").foregroundStyle(.secondary)
            ForEach(sessions) { session in
                Text("\(session.harnessId)\(session.nativeSessionId != nil ? " · live session" : "")")
                    .font(.caption)
                    .padding(.horizontal, Theme.Spacing.sm)
                    .padding(.vertical, Theme.Spacing.xxs)
                    .background(Capsule().fill(.quaternary))
                    .help(session.nativeSessionId.map { "Native session \($0) resumes on the next turn" } ?? "No native session yet")
            }
            Spacer()
        }
    }
}

/// Pure, testable composer input copy (QA-012). The create-vs-continue truth
/// keys ONLY on selected-thread identity — never on turn count, project scope,
/// or detail-load success: a non-nil selected thread ALWAYS continues (posts a
/// follow-up turn), a nil selection starts a new thread. The visible verb is
/// short so it never truncates behind the shortcut suffix, and the accessible
/// name is stable while the HINT carries the honest action.
struct ComposerInputCopy: Equatable {
    let placeholder: String
    let accessibilityName: String
    let accessibilityHint: String

    init(hasSelectedThread: Bool) {
        if hasSelectedThread {
            // Existing thread: Send posts another turn to this conversation —
            // same lane resumes natively, a switched lane hydrates a packet. The
            // stable product word is "conversation", never "same native session".
            placeholder = "Continue this conversation…  (⌘↩ to send)"
            accessibilityName = "Conversation message"
            accessibilityHint = "Sending adds a turn to this conversation."
        } else {
            // Draft: the first message materializes a new thread.
            placeholder = "Message…  (⌘↩ to send · the first message starts a thread)"
            accessibilityName = "New thread message"
            accessibilityHint = "Sending starts a new thread."
        }
    }
}
