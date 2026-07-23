import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// D-12 (owner dogfood): the conversation bubbles must DIFFER (accent-tinted
/// user vs neutral assistant answer) and carry a PERCEPTIBLE background
/// translucency that collapses to a SOLID fill under Reduce Transparency. These
/// pins guard the calibration so it can't silently regress back to the
/// "almost identical / imperceptible" state the owner rejected.
@MainActor
@Suite struct BubbleTokenTests {

    /// Resolve a (possibly appearance-dynamic) Theme color to sRGB components
    /// under a concrete appearance — the only way to compare token colors
    /// without a live view host.
    private func srgb(_ color: Color, _ appearanceName: NSAppearance.Name) -> (r: Double, g: Double, b: Double) {
        let appearance = NSAppearance(named: appearanceName)!
        var out: (Double, Double, Double) = (0, 0, 0)
        appearance.performAsCurrentDrawingAppearance {
            let ns = NSColor(color).usingColorSpace(.sRGB)!
            out = (Double(ns.redComponent), Double(ns.greenComponent), Double(ns.blueComponent))
        }
        return out
    }

    private func distance(_ a: (r: Double, g: Double, b: Double), _ b: (r: Double, g: Double, b: Double)) -> Double {
        let dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b
        return (dr * dr + dg * dg + db * db).squareRoot()
    }

    /// The user bubble and the assistant answer bubble are visibly DISTINCT in
    /// BOTH themes — the pre-D-12 tokens read "almost identical".
    @Test func userAndAssistantBubblesAreDistinctInBothThemes() {
        for appearance in [NSAppearance.Name.darkAqua, .aqua] {
            let user = srgb(Theme.bubbleUser, appearance)
            let assistant = srgb(Theme.surfaceRaisedHi, appearance)
            // Comfortably separated in sRGB (the old pair sat ~0.02 apart).
            #expect(distance(user, assistant) > 0.10)
            // The differentiator is the user bubble's ACCENT TINT: its blue
            // channel leads its red channel, and by more than the neutral
            // assistant surface does — so the difference is hue, not just level.
            #expect(user.b - user.r > assistant.b - assistant.r + 0.05)
        }
    }

    /// The translucency is real (backdrop shows through) but not a light-theme-
    /// killing wash: 0.75 ≤ t < 1.0.
    @Test func translucencyIsPerceptibleButNotAWash() {
        #expect(Theme.bubbleTranslucency >= 0.75)
        #expect(Theme.bubbleTranslucency < 1.0)
    }

    /// Reduce Transparency restores a fully SOLID fill (opacity 1); otherwise the
    /// fill uses the calibrated translucency. ONE owner of the fallback rule for
    /// both bubble call sites.
    @Test func reduceTransparencyFallbackIsSolid() {
        #expect(Theme.bubbleFillOpacity(reduceTransparency: true) == 1.0)
        #expect(Theme.bubbleFillOpacity(reduceTransparency: false) == Theme.bubbleTranslucency)
    }
}
