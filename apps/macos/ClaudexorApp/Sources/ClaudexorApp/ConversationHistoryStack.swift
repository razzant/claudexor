import SwiftUI

/// One non-lazy history page. Callers must bound the mounted turn collection
/// to at most 20 turn IDs; all stored turns remain untouched.
///
/// On macOS 26.5, reopening a long selectable history can send LazyVStack's
/// geometry estimation into an AttributeGraph layout/allocation feedback loop.
/// Keep the actual production container shared with the live rendering check.
struct ConversationHistoryStack<Content: View>: View {
    private let content: Content
    private let spacing: CGFloat

    init(spacing: CGFloat = Theme.Spacing.md, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            content
        }
        .scrollTargetLayout()
        .padding(Theme.Spacing.lg)
        // ProseText owns native selection; table cells are the configurable residual.
        .textSelection(.disabled)
    }
}
