import SwiftUI

/// A bounded preview ends on a text line, not an arbitrary clipping rectangle.
/// Each text-bearing child supplies boundaries from its own layout geometry.
struct ProsePreviewBoundary: LayoutValueKey {
    static let defaultValue: (@MainActor (CGFloat, CGFloat) -> CGFloat)? = nil
}

/// Nested previews measure their controls before finding a text boundary.
struct ProsePreviewUsesProposal: LayoutValueKey {
    static let defaultValue = false
}

@MainActor struct ProsePreviewLayout: @preconcurrency Layout {
    var heightLimit: CGFloat? = nil
    var usesProposedHeight = false
    var spacing = Theme.Spacing.md

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? Theme.Layout.conversationMaxWidth
        let heightLimit = heightLimit ?? (usesProposedHeight ? proposal.height : nil)
        var height: CGFloat = 0
        for (index, view) in subviews.enumerated() {
            let gap = index == 0 ? 0 : spacing
            let size = view.sizeThatFits(.init(width: width, height: nil))
            if let heightLimit, height + gap + size.height > heightLimit {
                let room = max(0, heightLimit - height - gap)
                let partial = view[ProsePreviewUsesProposal.self]
                    ? view.sizeThatFits(.init(width: width, height: room)).height
                    : view[ProsePreviewBoundary.self]?(width, room) ?? 0
                if partial > 0 { height += gap + partial }
                break
            }
            height += gap + size.height
        }
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for view in subviews {
            let proposal = ProposedViewSize(width: bounds.width, height: nil)
            let size = view.sizeThatFits(proposal)
            view.place(at: CGPoint(x: bounds.minX, y: y), anchor: .topLeading, proposal: proposal)
            y += size.height + spacing
        }
    }
}
