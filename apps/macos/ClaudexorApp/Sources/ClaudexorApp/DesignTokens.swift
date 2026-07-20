import SwiftUI
import AppKit

/// Design tokens — the Swift projection of `docs/DESIGN_SYSTEM.md`, aligned with Apple's
/// Liquid Glass era rules (WWDC25 "Build a SwiftUI app with the new design" + "Adopting
/// Liquid Glass"):
///
/// 1. Liquid Glass (`glassEffect`) lives on the **navigation/chrome layer only**
///    (sidebar, toolbar, inspector, sheets, the floating composer). Never behind code.
/// 2. Content cards are **frosted system materials** with a tuned surface tint
///    (v0.8, user-locked): the ambient glow shows through cards in BOTH themes,
///    one visual language with the floating composer. Reduce Transparency falls
///    back to solid raised fills.
/// 3. Code/diff/transcript surfaces stay SOLID (`codeSurface`) — dense text
///    never sits on translucency.
/// 4. **Never put custom backgrounds on split views / sidebars / toolbars** — that
///    overrides the system glass. Let the system provide it.
/// 5. Make glass feel alive by placing colorful content near native chrome, but do not
///    stretch a custom full-window glow into rounded window chrome with
///    `backgroundExtensionEffect()`; that produced hard side cutouts in dark/light mode.
/// Semantic status color tokens — the app's ONE status palette, decoupled from
/// any particular state enum. Lifecycle (`RunPhase`), review/checks/severity,
/// and plan/activity kinds all map into these; `Theme.status(_:)` resolves the
/// color. Replaces the old `Theme.status(RunStatus)` (the retired presentation
/// enum): the palette lives on, the RunStatus dependency is gone.
enum StatusTone: Equatable, Hashable {
    case info        // active / in-progress (blue)
    case positive    // clean success (green)
    case attention   // needs your review (lavender)
    case caution     // blocked / warning (amber)
    case negative    // failure (red)
    case warn        // budget overshoot / exhausted (orange)
    case interrupted // interrupted terminal (tan)
    case neutral     // inert / cancelled / no-op (secondary)
    case queued      // waiting to start
}

enum Theme {

    // MARK: Surfaces (graphite dark signature; light mirrors with inverted luminance).

    static let surfaceBase = Color(dark: (0.082, 0.087, 0.098), light: (0.953, 0.955, 0.962))
    /// Content cards — clearly lighter than base for Dark-Mode elevation/contrast (HIG).
    static let surfaceRaised = Color(dark: (0.205, 0.216, 0.240), light: (1.0, 1.0, 1.0))
    static let surfaceRaisedHi = Color(dark: (0.250, 0.264, 0.294), light: (0.965, 0.967, 0.974))
    static let surfaceCode = Color(dark: (0.060, 0.064, 0.076), light: (0.968, 0.969, 0.976))
    /// The USER message bubble: a QUIET, faintly accent-tinted raised fill read
    /// with the primary label color — the ChatGPT/Claude-desktop convention for
    /// content-heavy prompts. Identity comes from right-alignment + this fill;
    /// the ASSISTANT's final answer stays the loudest element in the feed
    /// (HIG: accent is for interactive elements, not text slabs).
    static let bubbleUser = Color(dark: (0.235, 0.252, 0.298), light: (0.878, 0.898, 0.938))
    static let separator = Color(dark: (1, 1, 1), light: (0, 0, 0)).opacity(0.14)
    static let hairline = Color(dark: (1, 1, 1), light: (0, 0, 0)).opacity(0.08)
    /// Card border — a touch stronger than separator for crisp card edges on the glow.
    static let cardStroke = Color(dark: (1, 1, 1), light: (0, 0, 0)).opacity(0.18)

    // MARK: Brand (ONE identity hue — a cool, slightly desaturated steel-blue so the app's
    // own chrome stays neutral and the harness identity colors pop). Everything that is
    // "the app itself" (selection, primary actions, links, section icons, the aurora) uses
    // this + neutral graphite. Strong non-brand hues are reserved for harness + status.

    static let accent = Color(dark: (0.45, 0.57, 0.82), light: (0.26, 0.40, 0.72))
    /// Accent tuned as a SOLID fill behind WHITE text (the Send button). The plain
    /// `accent` is calibrated as a tint/stroke/link color and only reaches ~3.1:1
    /// against white in Dark Mode (below WCAG AA 4.5:1); this deeper variant clears
    /// 4.5:1 in BOTH themes for white-on-accent prominent buttons. Never used as a tint.
    static let accentSolid = Color(dark: (0.30, 0.45, 0.78), light: (0.20, 0.36, 0.70))

    // MARK: Per-harness family colors — used ONLY in harness UI (candidate chips, dots,
    // race lanes, per-harness budget, route proof). Aligned to each brand's identity color
    // and tuned to differ from each other AND from the status palette below.

    static func harness(_ id: String) -> Color {
        switch HarnessFamily(rawValue: id) {
        case .codex: return Color(dark: (0.22, 0.72, 0.60), light: (0.05, 0.55, 0.45))   // OpenAI teal-green
        case .claude: return Color(dark: (0.87, 0.49, 0.36), light: (0.78, 0.40, 0.26))  // Anthropic coral
        case .cursor: return Color(dark: (0.74, 0.58, 0.98), light: (0.52, 0.38, 0.88))  // violet
        case .opencode: return Color(dark: (0.70, 0.84, 0.38), light: (0.43, 0.62, 0.18))// lime
        case .raw: return Color(dark: (0.86, 0.46, 0.78), light: (0.64, 0.30, 0.58))     // magenta
        case .fake: return Color.secondary
        default: return accentSolid
        }
    }

    // MARK: Status semantics — a SEMANTIC-TOKEN palette (always paired with a
    // glyph + label in views). This is the app's status color language; the
    // retired `RunStatus` presentation enum no longer owns it. Lifecycle
    // (`RunPhase`), review/checks/severity states, and the plan/activity kinds
    // all MAP INTO these tones, so the palette survives one central switch.

    static func status(_ tone: StatusTone) -> Color {
        switch tone {
        case .info: return Color(dark: (0.36, 0.67, 0.95), light: (0.14, 0.47, 0.86))       // active blue
        case .positive: return Color(dark: (0.34, 0.81, 0.53), light: (0.11, 0.61, 0.35))   // success green
        case .attention: return Color(dark: (0.64, 0.74, 0.99), light: (0.28, 0.45, 0.88))  // review lavender
        case .caution: return Color(dark: (0.97, 0.74, 0.33), light: (0.80, 0.56, 0.10))    // blocked amber
        case .negative: return Color(dark: (0.94, 0.44, 0.44), light: (0.80, 0.22, 0.22))   // failure red
        case .warn: return Color(dark: (0.97, 0.60, 0.30), light: (0.82, 0.38, 0.12))       // overshoot orange
        case .interrupted: return Color(dark: (0.80, 0.66, 0.42), light: (0.60, 0.46, 0.20))// interrupted tan
        case .neutral: return Color.secondary
        case .queued: return Color.secondary.opacity(0.85)
        }
    }

    // MARK: Spacing scale (pt).

    enum Spacing {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }

    // MARK: Content measure (one set of widths so every screen aligns its column).

    enum Layout {
        /// Dashboards / lists / wide content.
        static let contentMaxWidth: CGFloat = 1040
        /// Reading & forms (interview, settings) — a narrower, more legible measure.
        static let readableMaxWidth: CGFloat = 860
        /// Conversation prose measure (owner F10 "слишком широкие"). Apple's
        /// readable-content guide is ~672pt at the default text size (UIKit
        /// `readableContentGuide`, iPad landscape; it scales 560–896pt with Dynamic
        /// Type), which holds the line length to a comfortable ~70–90 characters
        /// instead of a full-window wall of text. Message bubbles and progress /
        /// assistant cards cap here; genuinely wide content (diff / tables) stays
        /// full-width with its own internal scroll (those live in the run inspector,
        /// not the chat feed). The column stays responsive BELOW the cap.
        static let conversationMaxWidth: CGFloat = 680
        /// The composer "⋯" options popover — a readable column for the option rows.
        static let composerOptionsWidth: CGFloat = 380
    }

    /// Vertical padding for capsule chips (intent / primary / project). Between
    /// `Spacing.xs` (4) and `Spacing.sm` (8): the scale has no 5–7 step, and a
    /// caption-height pill reads cramped at 4 and loose at 8. One named token so the
    /// chips stay identical and there are no off-scale literals scattered in views.
    enum Controls {
        static let chipVPadding: CGFloat = 5
    }

    // MARK: Corner-radius scale (one ladder; nested controls < cards < heroes).

    enum Radius {
        static let control: CGFloat = 8     // chips, segmented selection, small code wells
        static let card: CGFloat = 12       // content cards (softened per owner visual QA, 2.1.0)
        static let bubble: CGFloat = 16     // sent-message bubbles (solid accent fill, 3.0)
        static let hero: CGFloat = 22       // floating composer / hero glass
    }

    // MARK: Layout metrics derived from icon/avatar columns (not magic numbers).

    enum Metrics {
        /// Inset of the floating threads sidebar from the window edges. Between
        /// `Spacing.sm` (8) and `Spacing.md` (12): this is a chrome composition
        /// metric, not generic content spacing.
        static let floatingSidebarInset: CGFloat = 10
        /// Invisible resize affordance width for the floating threads sidebar.
        /// Kept named so the hit target and offset derive from the same value.
        static let sidebarResizeHandleWidth: CGFloat = 10
    }

    /// Links / inline references — brand, not a separate blue (keeps the palette tight).
    static let link = accent
}

// MARK: - Appearance-adaptive color helper

extension Color {
    init(dark: (Double, Double, Double), light: (Double, Double, Double)) {
        let ns = NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let c = isDark ? dark : light
            return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
        }
        self = Color(nsColor: ns)
    }
}

// MARK: - Surface helpers (content layer: frosted materials; code stays solid)

/// The ONE elevated-content-card recipe (v0.8 "frosted floating card", user-locked):
///
/// - fill: a SYSTEM material + a tuned surface tint, so the ambient glow shows
///   through content cards in both themes (one visual language with the
///   floating glass composer) without hurting text contrast;
/// - edge: a top-lit gradient hairline (light falls from above) instead of the
///   old flat white border that read as a cheap outline in Dark Mode;
/// - depth: a scheme-aware separation shadow cast by the card SHAPE (visible
///   in Dark Mode too — the old black 14% shadow was invisible on graphite);
/// - hover: an opt-in lift (deeper shadow + brighter veil) for clickable rows;
/// - accessibility: Reduce Transparency falls back to the solid raised fill.
///
/// Liquid Glass itself stays chrome-only (composer/actions); code/diff/dense
/// text stays on `codeSurface` (solid, maximum legibility).
private struct CardSurfaceModifier: ViewModifier {
    let radius: CGFloat
    let stroke: Bool
    /// nil = the standard top-lit hairline; non-nil = emphasis stroke
    /// (winner candidate, pending question) in the caller's color.
    let strokeColor: Color?
    let lineWidth: CGFloat
    let clip: Bool
    let hover: Bool

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        let dark = scheme == .dark
        let lifted = hover && hovering
        let shadowColor = Color.black.opacity(dark ? (lifted ? 0.55 : 0.40) : (lifted ? 0.22 : 0.13))
        let shadowRadius: CGFloat = dark ? (lifted ? 18 : 13) : (lifted ? 12 : 8)
        let shadowY: CGFloat = dark ? (lifted ? 8 : 5) : (lifted ? 5 : 3)

        // A second TIGHT contact shadow gives dark cards an ambient-occlusion
        // "lift" on the moving glow mesh (the soft shadow alone washed out and
        // the cards read flat/dated in Dark Mode).
        // v0.10: ONE soft shadow per card (the contact shadow was dropped — over a
        // STATIC backdrop the second shadow only cost frames, it didn't read).
        let base = content
            .background {
                if reduceTransparency {
                    shape.fill(Theme.surfaceRaised)
                        .shadow(color: shadowColor, radius: shadowRadius, x: 0, y: shadowY)
                } else {
                    // The shadow is cast by the card SHAPE (not the composite view)
                    // so the translucent fill never double-shadows the text.
                    // DESIGN_SYSTEM §2.4 specifies .regularMaterial — the earlier
                    // .thinMaterial let the behind-window glow bleed through and
                    // muddy the card color (owner visual QA, 2.1.0).
                    shape.fill(.regularMaterial)
                        .shadow(color: shadowColor, radius: shadowRadius, x: 0, y: shadowY)
                    // Light raised veil so cards read as surfaces over the glass.
                    shape.fill(Theme.surfaceRaised.opacity(dark ? (lifted ? 0.45 : 0.55) : 0.50))
                }
            }

        return Group {
            if clip { base.clipShape(shape) } else { base }
        }
        .overlay(stroke ? AnyView(edge(shape, dark: dark)) : AnyView(EmptyView()))
        .onHover { inside in
            guard hover else { return }
            hovering = inside
        }
        .animation(.easeOut(duration: 0.16), value: hovering)
    }

    @ViewBuilder
    private func edge(_ shape: RoundedRectangle, dark: Bool) -> some View {
        if let strokeColor {
            shape.strokeBorder(strokeColor, lineWidth: lineWidth)
        } else {
            shape.strokeBorder(
                LinearGradient(
                    stops: [
                        // Brighter top-lit lip in dark mode so the edge reads as a
                        // raised surface catching light, not a cheap flat outline.
                        .init(color: dark ? .white.opacity(0.30) : .black.opacity(0.10), location: 0),
                        .init(color: dark ? .white.opacity(0.08) : .black.opacity(0.04), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom,
                ),
                lineWidth: lineWidth,
            )
        }
    }
}

extension View {
    /// See `CardSurfaceModifier` — the single content-card recipe. `clip`
    /// rounds inner content (e.g. a leading accent bar); `strokeColor`
    /// switches the hairline to an emphasis stroke; `hover` opts a clickable
    /// row into the lift effect.
    func cardSurface(_ radius: CGFloat = Theme.Radius.card,
                     stroke: Bool = true,
                     strokeColor: Color? = nil,
                     lineWidth: CGFloat = 1,
                     clip: Bool = false,
                     hover: Bool = false) -> some View {
        modifier(CardSurfaceModifier(radius: radius, stroke: stroke, strokeColor: strokeColor,
                                     lineWidth: lineWidth, clip: clip, hover: hover))
    }

    /// A solid code/diff/transcript surface — maximum legibility, never glass behind it.
    func codeSurface(_ radius: CGFloat = Theme.Radius.card) -> some View {
        self
            .background(Theme.surfaceCode, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Theme.separator, lineWidth: 1))
    }

    /// A solid tinted "selected" fill for segmented controls / filter chips (NOT glass —
    /// these live in the content layer, and glass-on-glass is forbidden).
    @ViewBuilder
    func selectedChip(active: Bool, tint: Color = Theme.accent, shape: some Shape = Capsule()) -> some View {
        if active {
            self.background(tint.opacity(0.18), in: shape)
                .overlay(shape.stroke(tint.opacity(0.45), lineWidth: 1))
        } else {
            self.background(Theme.surfaceRaisedHi, in: shape)
                .overlay(shape.stroke(Theme.separator, lineWidth: 1))
        }
    }
}

// MARK: - Window backdrop (behind-window matte glass; the desktop shows through)

/// The app-wide backdrop. v0.10 replaced the always-animating 60fps MeshGradient
/// (the real cause of the low frame rate on idle) with a STATIC behind-window
/// material: the desktop shows through the main window like frosted glass, and
/// nothing animates when the app is idle. Honors Reduce Transparency (solid).
/// The window backdrop variant (M9-UX item 7). Pure so the state switch is
/// unit-tested without a live window.
enum WindowBackdrop: Equatable {
    /// Behind-window vibrancy — the desktop shows faintly through the window.
    case vibrant
    /// A solid opaque fill — used when there is no desktop behind the window
    /// (full screen) or Reduce Transparency is on, where vibrancy is wrong.
    case opaque
}

enum BackdropPresentation {
    /// Vibrancy only when the window actually floats over the desktop. Full
    /// screen (no desktop behind) and Reduce Transparency both force the opaque
    /// variant — vibrancy washes out to gray otherwise.
    static func backdrop(isFullScreen: Bool, reduceTransparency: Bool) -> WindowBackdrop {
        (isFullScreen || reduceTransparency) ? .opaque : .vibrant
    }
}

struct GlassBackground: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        switch BackdropPresentation.backdrop(
            isFullScreen: model.isFullScreen, reduceTransparency: reduceTransparency) {
        case .opaque:
            Theme.surfaceBase
        case .vibrant:
            BehindWindowMaterial(colorScheme: colorScheme)
        }
    }
}

/// A behind-window `NSVisualEffectView` so the desktop is faintly visible through
/// the window (within-window SwiftUI materials only blur in-app content).
///
/// Window opacity is owned by `AppDelegate.makeWindowsTranslucent()` (set reliably
/// once the window exists) and the SwiftUI `.containerBackground(.clear, for: .window)`
/// on `RootView` — NOT here. A previous per-update guard in this representable tried
/// to flip `isOpaque` and never reliably fired (the desktop stayed hidden), so this
/// view is now PURE blur with no window side effects.
private struct BehindWindowMaterial: NSViewRepresentable {
    /// Drives the material so it adapts to light/dark — `.hudWindow` is a DARK-leaning
    /// HUD vibrancy: substantial and good in dark mode, but muddy/wrong in light mode.
    let colorScheme: ColorScheme

    /// The window is fully clear (AppDelegate.makeWindowsTranslucent), so this view IS
    /// the visible backdrop — a behind-window frosted vibrancy (matte glass). This is
    /// NOT WWDC25 Liquid Glass (`glassEffect`), which the token doctrine reserves for
    /// navigation/chrome; this is the AppKit behind-window material per Bible §9.
    ///
    /// The frost = the vibrancy MATERIAL's built-in blur + translucency, applied at
    /// FULL alpha. Do NOT lower `alphaValue` to "let more desktop through": that fades
    /// the frost itself and reveals the un-blurred desktop, which reads as a flat,
    /// too-transparent wash rather than frosted glass (the v0.10.1 bug). The material
    /// is APPEARANCE-AWARE: `.hudWindow` (a rich dark frost) in dark mode, and
    /// `.fullScreenUI` (a substantial frost that renders correctly in light) in light
    /// mode — `.hudWindow` in light read as muddy/odd-bordered. Content cards keep
    /// their own surfaces and code/diffs stay solid for legibility.
    private var material: NSVisualEffectView.Material {
        colorScheme == .dark ? .hudWindow : .fullScreenUI
    }

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.blendingMode = .behindWindow
        v.material = material
        v.state = .active
        return v
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
    }
}
