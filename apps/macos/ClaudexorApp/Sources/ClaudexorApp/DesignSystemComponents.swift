import SwiftUI

/// Reusable design-system components (v0.10 UI redesign). Screens compose these
/// instead of re-implementing inline — so spacing, focus, glass, and accessibility
/// are consistent and tokenized (no magic numbers). Liquid Glass lives on the
/// chrome layer only; dense/input content sits on SOLID insets (never glass-on-glass).

// MARK: - Composer text field (Messages-style: solid inset + focus ring + auto-grow)

/// The composer's input. A `TextField(axis: .vertical)` on a SOLID raised inset
/// (never the glass surface itself) with a real focus ring and 1→`maxLines` growth.
/// Send is owned by the caller (⌘↩); `onSubmit` covers the single-line Return case.
struct GlassField: View {
    @Binding var text: String
    var placeholder: String
    var maxLines: Int = 6
    var onSubmit: () -> Void = {}
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // The focus ring needs more weight on a WHITE light-mode field than on a
        // dark one (light-mode audit): a 0.6-alpha hairline that reads fine on
        // graphite nearly vanishes on white. Bump alpha + width in light.
        let ringAlpha = scheme == .light ? 0.85 : 0.6
        let ringWidth: CGFloat = scheme == .light ? 1.75 : 1.5
        return TextField(placeholder, text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.body)
            .lineLimit(1...maxLines)
            .focused($focused)
            .onSubmit(onSubmit)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(
                // The animation is scoped to the stroke overlay, so focus does NOT
                // animate (and re-composite) the whole glass-backed field.
                RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                    .strokeBorder(focused ? Theme.accent.opacity(ringAlpha) : Theme.separator, lineWidth: focused ? ringWidth : 1)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: focused)
            )
            .accessibilityLabel(placeholder)
    }
}

// MARK: - Send button (accent solid — visible in BOTH light and dark)

/// The composer's Send. A SOLID accent capsule with white text, so it stays
/// visible in light mode (the system `.glassProminent` could render near-white on
/// the light glass — issue #5: "Send button invisible in the light theme"). Dims
/// when disabled (empty field). Uses `Theme.accentSolid` (NOT the plain `accent`,
/// which only reaches ~3.1:1 white contrast in Dark Mode) so white-on-fill clears
/// WCAG AA 4.5:1 in BOTH schemes.
struct AccentButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
            .background(
                Theme.accentSolid.opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1.0) : 0.35),
                in: Capsule()
            )
            .contentShape(Capsule())
            .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

// MARK: - Project chip (composer: choose the working directory / project)

/// The composer's project picker (issue #8). Shows the working directory and lets
/// you switch it from an MRU menu or Browse… A thread's repo is bound, so the chip
/// is informational on an open thread and choosing another project starts a NEW
/// draft thread there (the model owns that semantics).
struct ProjectChip: View {
    /// Display name (project folder, or a "Choose project" call-to-action).
    let name: String
    /// True when showing an open thread's fixed repo (vs the draft Current Project).
    let bound: Bool
    let hasProject: Bool
    let recent: [String]
    let onPick: (String) -> Void
    let onBrowse: () -> Void

    var body: some View {
        Menu {
            if !recent.isEmpty {
                Section(bound ? "Switch project — starts a new thread" : "Recent projects") {
                    ForEach(recent, id: \.self) { path in
                        Button { onPick(path) } label: {
                            Label(URL(fileURLWithPath: path).lastPathComponent, systemImage: "folder")
                        }
                    }
                }
                Divider()
            }
            Button { onBrowse() } label: { Label("Browse…", systemImage: "folder.badge.plus") }
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: hasProject ? "folder.fill" : "folder.badge.questionmark").imageScale(.small)
                Text(name).lineLimit(1)
                Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(.secondary)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(hasProject ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.accent))
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Controls.chipVPadding)
            .background(Theme.surfaceRaisedHi, in: Capsule())
            .overlay(Capsule().strokeBorder(hasProject ? Theme.separator : Theme.accent.opacity(0.5), lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(bound
              ? "Project for this thread (bound). Pick another to start a new thread there."
              : "Working directory for the new thread — pick a recent project or Browse…")
    }
}

// MARK: - Option section / row (the "⋯" advanced panel: clean SOLID sections)

/// A titled section in the composer's advanced panel — a caption label over its
/// content, on the solid panel surface (NOT a frosted card inside glass).
struct OptionSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            content()
        }
    }
}

/// A label + control row with one consistent leading-label column, so every
/// option lines up (replaces the ad-hoc `.fixedSize()`/magic-width pickers).
struct OptionRow<Content: View>: View {
    let label: String
    var labelWidth: CGFloat = 64
    @ViewBuilder var content: () -> Content
    var body: some View {
        // Compact cluster (layout B): a fixed label column + the control, no trailing
        // Spacer — the control sizes to its content and the row ends naturally (the
        // old Spacer left a big awkward gap on the right).
        HStack(alignment: .center, spacing: Theme.Spacing.md) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: labelWidth, alignment: .leading)
            content()
        }
    }
}

// MARK: - Chrome glass (floating panel) with a Reduce-Transparency solid fallback

extension View {
    /// Floating chrome panel: genuine Liquid Glass, degrading to a SOLID raised
    /// fill under Reduce Transparency. Use for the composer; contents stay solid
    /// (no glass-on-glass). NOTE: static `.regular` (NOT `.interactive()`) — pointer
    /// lensing re-composites on every mouse move AND every re-render, which tanked
    /// scroll/idle FPS; Apple reserves `.interactive()` for elements that physically
    /// move under the cursor, not a static composer.
    func composerGlass(_ shape: RoundedRectangle = RoundedRectangle(cornerRadius: Theme.Radius.hero, style: .continuous)) -> some View {
        modifier(ComposerGlassModifier(shape: shape))
    }

    /// Floating Liquid Glass for the NAVIGATION layer (the threads sidebar): a
    /// weightless rounded panel that floats over the behind-window backdrop, per
    /// Apple's macOS 26 guidance (Liquid Glass belongs on the nav layer, not on
    /// content). The panel content (List) must hide its own scroll background so the
    /// glass shows through. Degrades to a SOLID raised panel + hairline + soft shadow
    /// under Reduce Transparency so it still reads as a distinct floating panel.
    func sidebarGlass(_ shape: RoundedRectangle = RoundedRectangle(cornerRadius: Theme.Radius.hero, style: .continuous)) -> some View {
        modifier(SidebarGlassModifier(shape: shape))
    }
}

private struct ComposerGlassModifier: ViewModifier {
    let shape: RoundedRectangle
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(Theme.surfaceRaised, in: shape)
                .overlay(shape.strokeBorder(Theme.separator, lineWidth: 1))
        } else {
            content.glassEffect(.regular, in: shape)
        }
    }
}

private struct SidebarGlassModifier: ViewModifier {
    let shape: RoundedRectangle
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(Theme.surfaceRaised, in: shape)
                .overlay(shape.strokeBorder(Theme.separator, lineWidth: 1))
                .clipShape(shape)
                // Reduce-Transparency has no Liquid-Glass depth, so a soft shadow
                // keeps the solid panel reading as FLOATING over the backdrop.
                .shadow(color: .black.opacity(0.12), radius: 14, x: 0, y: 6)
        } else {
            // Liquid Glass provides its own ambient depth/edge — wrap in a
            // GlassEffectContainer (Apple's coordinator for glass surfaces) and let
            // the material float; no extra fill/stroke (that would be glass-on-fill).
            GlassEffectContainer {
                content.glassEffect(.regular, in: shape)
            }
        }
    }
}
