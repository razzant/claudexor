import SwiftUI

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
enum Theme {

    // MARK: Surfaces (graphite dark signature; light mirrors with inverted luminance).

    static let surfaceBase = Color(dark: (0.082, 0.087, 0.098), light: (0.953, 0.955, 0.962))
    /// Content cards — clearly lighter than base for Dark-Mode elevation/contrast (HIG).
    static let surfaceRaised = Color(dark: (0.205, 0.216, 0.240), light: (1.0, 1.0, 1.0))
    static let surfaceRaisedHi = Color(dark: (0.250, 0.264, 0.294), light: (0.965, 0.967, 0.974))
    static let surfaceCode = Color(dark: (0.060, 0.064, 0.076), light: (0.968, 0.969, 0.976))
    static let separator = Color(dark: (1, 1, 1), light: (0, 0, 0)).opacity(0.14)
    static let hairline = Color(dark: (1, 1, 1), light: (0, 0, 0)).opacity(0.08)
    /// Card border — a touch stronger than separator for crisp card edges on the glow.
    static let cardStroke = Color(dark: (1, 1, 1), light: (0, 0, 0)).opacity(0.18)

    // MARK: Brand (ONE identity hue — a cool, slightly desaturated steel-blue so the app's
    // own chrome stays neutral and the harness identity colors pop). Everything that is
    // "the app itself" (selection, primary actions, links, section icons, the aurora) uses
    // this + neutral graphite. Strong non-brand hues are reserved for harness + status.

    static let accent = Color(dark: (0.45, 0.57, 0.82), light: (0.26, 0.40, 0.72))
    /// Cool tonal companions for the brand aurora ONLY (not semantic, never on controls).
    static let brandGlowHi = Color(dark: (0.52, 0.68, 0.92), light: (0.40, 0.56, 0.86))
    static let brandGlowLo = Color(dark: (0.30, 0.34, 0.58), light: (0.26, 0.30, 0.52))

    // MARK: Per-harness family colors — used ONLY in harness UI (candidate chips, dots,
    // race lanes, per-harness budget, route proof). Aligned to each brand's identity color
    // and tuned to differ from each other AND from the status palette below.

    static func harness(_ id: String) -> Color {
        switch HarnessFamily(rawValue: id) ?? .raw {
        case .codex: return Color(dark: (0.22, 0.72, 0.60), light: (0.05, 0.55, 0.45))   // OpenAI teal-green
        case .claude: return Color(dark: (0.87, 0.49, 0.36), light: (0.78, 0.40, 0.26))  // Anthropic coral
        case .cursor: return Color(dark: (0.74, 0.58, 0.98), light: (0.52, 0.38, 0.88))  // violet
        case .opencode: return Color(dark: (0.70, 0.84, 0.38), light: (0.43, 0.62, 0.18))// lime
        case .raw: return Color(dark: (0.86, 0.46, 0.78), light: (0.64, 0.30, 0.58))     // magenta
        case .fake: return Color.secondary
        }
    }

    // MARK: Status semantics (always paired with a glyph + label in views).

    static func status(_ state: RunStatus) -> Color {
        switch state {
        case .running: return Color(dark: (0.36, 0.67, 0.95), light: (0.14, 0.47, 0.86))
        case .succeeded: return Color(dark: (0.34, 0.81, 0.53), light: (0.11, 0.61, 0.35))
        case .noOp: return Color.secondary
        case .needsReview: return Color(dark: (0.64, 0.74, 0.99), light: (0.28, 0.45, 0.88))
        case .blocked: return Color(dark: (0.97, 0.74, 0.33), light: (0.80, 0.56, 0.10))
        case .ungated, .reviewNotRun: return Color(dark: (0.97, 0.74, 0.33), light: (0.80, 0.56, 0.10))
        case .failed: return Color(dark: (0.94, 0.44, 0.44), light: (0.80, 0.22, 0.22))
        case .cancelled: return Color.secondary
        case .interrupted: return Color(dark: (0.80, 0.66, 0.42), light: (0.60, 0.46, 0.20))
        case .exhausted: return Color(dark: (0.97, 0.60, 0.30), light: (0.82, 0.38, 0.12))
        case .notConverged: return Color(dark: (0.97, 0.74, 0.33), light: (0.80, 0.56, 0.10))
        case .unknown: return Color.secondary
        case .queued: return Color.secondary.opacity(0.85)
        }
    }
    static func status(_ raw: String) -> Color { status(RunStatus(api: raw)) }

    // MARK: Spacing scale (pt).

    enum Spacing {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
        static let xxxl: CGFloat = 48
    }

    // MARK: Content measure (one set of widths so every screen aligns its column).

    enum Layout {
        /// Dashboards / lists / wide content.
        static let contentMaxWidth: CGFloat = 1040
        /// Reading & forms (interview, settings) — a narrower, more legible measure.
        static let readableMaxWidth: CGFloat = 860
    }

    // MARK: Corner-radius scale (one ladder; nested controls < cards < heroes).

    enum Radius {
        static let control: CGFloat = 8     // chips, segmented selection, small code wells
        static let card: CGFloat = 8        // content cards
        static let hero: CGFloat = 22       // floating composer / hero glass
    }

    // MARK: Layout metrics derived from icon/avatar columns (not magic numbers).

    enum Metrics {
        /// Leading inset for inter-row dividers so they start past the row's icon column.
        static let rowDividerInset: CGFloat = 56
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
        let contactColor = Color.black.opacity(dark ? 0.35 : 0.10)
        let base = content
            .background {
                if reduceTransparency {
                    shape.fill(Theme.surfaceRaised)
                        .shadow(color: contactColor, radius: 3, x: 0, y: 1)
                        .shadow(color: shadowColor, radius: shadowRadius, x: 0, y: shadowY)
                } else {
                    // The shadow is cast by the card SHAPE (not the composite
                    // view) so translucent fills never double-shadow the text.
                    shape.fill(.regularMaterial)
                        .shadow(color: contactColor, radius: 3, x: 0, y: 1)
                        .shadow(color: shadowColor, radius: shadowRadius, x: 0, y: shadowY)
                    // Raised dark veil (0.40 -> 0.60): cards must read as solid
                    // floating surfaces over the glow, not melt into the mesh.
                    shape.fill(Theme.surfaceRaised.opacity(dark ? (lifted ? 0.50 : 0.60) : 0.55))
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

// MARK: - Glass helper (CHROME ONLY: floating composer / floating actions)

extension View {
    /// Genuine Liquid Glass for the navigation/chrome layer only (a floating composer or
    /// action). System-provided glass (sidebar/toolbar/inspector/sheets) needs no helper.
    func chromeGlass(_ shape: some Shape = RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous), interactive: Bool = true) -> some View {
        self.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    }
}

// MARK: - Glow backdrop (app-wide ambient light the glass refracts)

/// A calm, muted, always-moving "command center" backdrop. It is mounted once at
/// the RootView level so the content area has one continuous glow instead of
/// competing per-screen background-extension layers.
/// Honors Reduce Motion (static) and Reduce Transparency (solid graphite).
/// Brand-only hues (steel-blue / sky / indigo) — never harness/status.
struct GlowBackground: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var scheme
    @AppStorage("claudexor.reducedVisualEffects") private var reducedVisualEffects = false

    var body: some View {
        if reduceTransparency {
            Theme.surfaceBase
        } else if reduceMotion || reducedVisualEffects {
            ZStack { Theme.surfaceBase; mesh(0).opacity(reducedVisualEffects ? 0.55 : 1) }
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { ctx in
                ZStack { Theme.surfaceBase; mesh(ctx.date.timeIntervalSinceReferenceDate) }
            }
        }
    }

    /// One animated MeshGradient over graphite: a gentle brand glow up top that melts
    /// smoothly into the base at the bottom (the falloff is in the mesh itself, so there's
    /// no harsh overlay band). Edge/center control points drift for visible, calm motion;
    /// corners stay pinned. Muted enough to preserve content contrast everywhere.
    private func mesh(_ t: TimeInterval) -> some View {
        // MeshGradient expects stable edge geometry. Letting boundary points drift outside
        // 0...1 produces the hard diagonal cutouts seen near hidden titlebars/split views.
        // Keep edges on their edges; only the center moves in two dimensions.
        func clamp(_ v: Float) -> Float { min(0.96, max(0.04, v)) }
        func top(_ x: Float, _ ax: Double, _ ph: Double) -> SIMD2<Float> {
            SIMD2(clamp(x + Float(sin(t * 0.40 + ph) * ax)), 0)
        }
        func left(_ y: Float, _ ay: Double, _ ph: Double) -> SIMD2<Float> {
            SIMD2(0, clamp(y + Float(cos(t * 0.34 + ph) * ay)))
        }
        func right(_ y: Float, _ ay: Double, _ ph: Double) -> SIMD2<Float> {
            SIMD2(1, clamp(y + Float(cos(t * 0.34 + ph) * ay)))
        }
        func bottom(_ x: Float, _ ax: Double, _ ph: Double) -> SIMD2<Float> {
            SIMD2(clamp(x + Float(sin(t * 0.40 + ph) * ax)), 1)
        }
        func center(_ x: Float, _ y: Float, _ ax: Double, _ ay: Double, _ ph: Double) -> SIMD2<Float> {
            SIMD2(clamp(x + Float(sin(t * 0.40 + ph) * ax)), clamp(y + Float(cos(t * 0.34 + ph) * ay)))
        }
        let dark = scheme == .dark
        func c(_ color: Color, _ o: Double) -> Color { color.opacity(dark ? o : o * 0.7) }
        let a = Theme.accent, hi = Theme.brandGlowHi, lo = Theme.brandGlowLo, clear = Color.clear
        return MeshGradient(
            width: 3, height: 3,
            points: [
                SIMD2(0, 0), top(0.5, 0.16, 1.0), SIMD2(1, 0),
                left(0.5, 0.16, 2.0), center(0.5, 0.5, 0.20, 0.14, 3.0), right(0.5, 0.16, 4.0),
                SIMD2(0, 1), bottom(0.5, 0.16, 5.0), SIMD2(1, 1),
            ],
            colors: [
                c(a, 0.30), c(hi, 0.34), c(a, 0.24),
                c(a, 0.11), c(lo, 0.13), c(hi, 0.11),
                clear, clear, clear,
            ]
        )
    }
}

extension View {
    /// Deprecated screen-level glow hook. The actual ambient layer now lives once
    /// in `RootView`; keeping this helper as identity avoids multiple
    /// `backgroundExtensionEffect()` layers that caused hard side cutouts.
    func glowBackdrop() -> some View {
        self
    }
}
