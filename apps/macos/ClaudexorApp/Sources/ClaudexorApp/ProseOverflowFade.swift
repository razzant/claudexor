import SwiftUI
import AppKit

/// A visual hint only. The content's character/line rule owns whether it folds;
/// neither this mask nor its painted height feeds back into that decision.
struct ProseFoldFade: ViewModifier {
    let collapsed: Bool
    @Environment(\.dynamicTypeSize) private var size
    func body(content: Content) -> some View {
        let font = ProseStyle.make(body: true, size: size).font
        content.mask(alignment: .bottom) {
            VStack(spacing: 0) {
                Rectangle()
                LinearGradient(colors: [.black, collapsed ? .clear : .black], startPoint: .top, endPoint: .bottom)
                    .frame(height: ceil(font.ascender - font.descender + font.leading))
            }
        }
    }
}

struct TableHiddenColumns: Equatable {
    var leading = false
    var trailing = false
    init(offset: CGFloat = 0, content: CGFloat = 0, viewport: CGFloat = 0) {
        leading = content > viewport + 1 && offset > 1
        trailing = content > viewport + 1 && content - viewport - offset > 1
    }
}

struct TableOverflowFade: ViewModifier {
    let hidden: TableHiddenColumns
    func body(content: Content) -> some View {
        content.mask {
            HStack(spacing: 0) {
                LinearGradient(colors: [hidden.leading ? .clear : .black, .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: Theme.Spacing.lg)
                Rectangle()
                LinearGradient(colors: [.black, hidden.trailing ? .clear : .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: Theme.Spacing.lg)
            }
        }
    }
}
