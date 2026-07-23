import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// D-12 (owner dogfood, round 2): the conversation bubbles must DIFFER
/// (accent-tinted user vs neutral assistant answer) and read as GENUINELY
/// translucent — a real frosted `.ultraThinMaterial` fill with a tint wash, not
/// the earlier flat-alpha color that showed no frost over the app's
/// low-frequency / opaque backdrops. Reduce Transparency collapses the fill to a
/// fully SOLID tint. These pins guard the calibration so it can't silently
/// regress back to the "almost identical" or "imperceptibly translucent" state
/// the owner rejected.
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
    /// BOTH themes — the pre-D-12 tokens read "almost identical". The material
    /// carries the same tint on both, so the tint tokens themselves must keep the
    /// hue gap that survives the wash.
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

    /// Normal (transparency ON): the fill is a MATERIAL with a tint wash — this is
    /// the frosted translucency the owner asked for, not a flat opaque color.
    @Test func normalFillIsATintedMaterial() {
        let fill = Theme.bubbleFill(reduceTransparency: false)
        #expect(fill == .material(tintOpacity: Theme.bubbleTintVeil))
        guard case .material(let veil) = fill else { Issue.record("expected material fill"); return }
        // The tint is a WASH, not an opaque cover: low enough that the material's
        // frost reads through, high enough to carry the hue + reinforce AA.
        #expect(veil >= 0.35)
        #expect(veil <= 0.6)
    }

    /// Reduce Transparency restores a fully SOLID tint fill (opacity 1, no
    /// material) — the same gate as `CardSurfaceModifier`. ONE owner of the
    /// fallback rule for both bubble call sites.
    @Test func reduceTransparencyFallbackIsSolid() {
        #expect(Theme.bubbleFill(reduceTransparency: true) == .solid(tintOpacity: 1))
    }

    /// WCAG AA guarantee for the PRIMARY label over the tinted-material fill,
    /// modelled over the ACTUAL toned backdrop (not the unreachable pure-white /
    /// pure-black desktop corner): the behind-window frost is a DARK HUD material
    /// in dark mode and a LIGHT material in light mode, and the answer bubble sits
    /// over the equally-toned opaque card. The effective background is
    /// `veil·tint + (1 - veil)·M`, with `M` a conservative reachable backdrop
    /// tone. The primary label (≈ white in dark, ≈ black in light) must clear AA
    /// 4.5:1; here it clears it comfortably. This mirrors the numbers stated in
    /// DESIGN_SYSTEM §4.
    @Test func primaryLabelClearsAAOverTheTintedMaterial() {
        // Conservative reachable backdrop tone under each bubble/appearance.
        struct Case { let tint: Color; let appearance: NSAppearance.Name; let backdrop: (Double, Double, Double); let text: Double }
        let cases: [Case] = [
            // Dark: text ≈ white; backdrop = a bright-desktop-through-HUD dark tone
            // (user) / the dark opaque card (answer). Lightest reachable ≈ 0.30 gray.
            Case(tint: Theme.bubbleUser,      appearance: .darkAqua, backdrop: (0.30, 0.30, 0.32), text: 1.0),
            Case(tint: Theme.surfaceRaisedHi, appearance: .darkAqua, backdrop: (0.24, 0.25, 0.27), text: 1.0),
            // Light: text ≈ black; backdrop = a dark-desktop-through-material light
            // tone (user) / the near-white opaque card (answer). Darkest ≈ 0.60.
            Case(tint: Theme.bubbleUser,      appearance: .aqua,     backdrop: (0.60, 0.60, 0.62), text: 0.0),
            Case(tint: Theme.surfaceRaisedHi, appearance: .aqua,     backdrop: (0.88, 0.88, 0.89), text: 0.0),
        ]
        let veil = Theme.bubbleTintVeil
        for c in cases {
            let t = srgb(c.tint, c.appearance)
            let bg = (r: veil * t.r + (1 - veil) * c.backdrop.0,
                      g: veil * t.g + (1 - veil) * c.backdrop.1,
                      b: veil * t.b + (1 - veil) * c.backdrop.2)
            let ratio = contrast(bg, gray: c.text)
            #expect(ratio >= 4.5, "AA floor breached: \(ratio) for \(c.appearance)")
        }
    }

    // MARK: WCAG helpers

    private func linearize(_ c: Double) -> Double {
        c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    private func luminance(_ rgb: (r: Double, g: Double, b: Double)) -> Double {
        0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b)
    }

    private func contrast(_ bg: (r: Double, g: Double, b: Double), gray textLevel: Double) -> Double {
        let l1 = luminance(bg)
        let l2 = luminance((textLevel, textLevel, textLevel))
        let hi = max(l1, l2), lo = min(l1, l2)
        return (hi + 0.05) / (lo + 0.05)
    }
}
