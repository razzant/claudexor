import SwiftUI

/// Design tokens — the Swift projection of docs/DESIGN_SYSTEM.md. Semantic, not raw:
/// views reference these, never hardcoded hex. Graphite-dark default, brand accent,
/// per-harness candidate colors, status semantics.
public enum Theme {
    // Surfaces (graphite, not pure black).
    public static let surfaceBase = Color(red: 0.102, green: 0.106, blue: 0.118)
    public static let surfaceRaised = Color(red: 0.129, green: 0.137, blue: 0.153)
    public static let surfaceCode = Color(red: 0.086, green: 0.090, blue: 0.102)

    // Brand accent — warm, slightly desaturated clay ("Claude x Codex").
    public static let accent = Color(red: 0.831, green: 0.486, blue: 0.357)

    /// Per-harness family colors for candidate chips / race lanes / route proof.
    public static func harness(_ id: String) -> Color {
        switch id {
        case "codex": return Color(red: 0.40, green: 0.78, blue: 0.64)
        case "claude": return Color(red: 0.85, green: 0.55, blue: 0.34)
        case "cursor": return Color(red: 0.55, green: 0.62, blue: 0.95)
        case "opencode": return Color(red: 0.62, green: 0.80, blue: 0.42)
        case "raw-api": return Color(red: 0.70, green: 0.66, blue: 0.78)
        default: return Color.secondary
        }
    }

    /// Run/candidate status semantics (always paired with a glyph + label in views).
    public static func status(_ state: String) -> Color {
        switch state {
        case "running": return Color(red: 0.36, green: 0.66, blue: 0.92)
        case "success", "green", "succeeded": return Color(red: 0.36, green: 0.78, blue: 0.50)
        case "blocked", "needs-permission": return Color(red: 0.92, green: 0.71, blue: 0.30)
        case "failed", "red": return Color(red: 0.90, green: 0.40, blue: 0.40)
        case "cancelled", "interrupted": return Color.secondary
        default: return Color.secondary
        }
    }

    public enum Spacing {
        public static let xs: CGFloat = 4
        public static let sm: CGFloat = 8
        public static let md: CGFloat = 12
        public static let lg: CGFloat = 16
        public static let xl: CGFloat = 24
    }

    public static let cardRadius: CGFloat = 14
}

public extension View {
    /// Apply Liquid Glass where the SDK supports it; degrade gracefully otherwise.
    /// Glass belongs to the navigation/chrome layer only — never under code/diffs.
    @ViewBuilder
    func claudexGlass(_ shape: some Shape = RoundedRectangle(cornerRadius: Theme.cardRadius)) -> some View {
        if #available(macOS 26.0, *) {
            self.glassEffect(.regular, in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape)
        }
    }
}
