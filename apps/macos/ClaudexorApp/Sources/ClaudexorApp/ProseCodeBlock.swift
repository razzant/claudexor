import AppKit
import SwiftUI

/// The same solid well as codeSurface, without splitting native selection.
final class ProseCodeBlock: NSTextBlock {
    override func drawBackground(withFrame frameRect: NSRect, in controlView: NSView,
                                 characterRange charRange: NSRange, layoutManager: NSLayoutManager) {
        // TextKit passes the outer bounds, including the vertical margins.
        // Those are the inter-block gap, not part of the filled code well.
        let surface = frameRect.insetBy(dx: 0, dy: Theme.Spacing.md)
        let path = NSBezierPath(roundedRect: surface.insetBy(dx: 0.5, dy: 0.5),
            xRadius: Theme.Radius.control, yRadius: Theme.Radius.control)
        NSColor(Theme.surfaceCode).setFill()
        path.fill()
        NSColor(Theme.separator).setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}
