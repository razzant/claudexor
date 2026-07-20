import SwiftUI

// MARK: - ChipMenu (M5c) — ONE composer-chip menu component
//
// Every composer chip (harness / access / intent / project) was an independent
// `Menu` + `.menuStyle(.borderlessButton)`. The FIRST fix drew a MANUAL trailing
// `chevron.down` and hid the native indicator with `.menuIndicator(.hidden)` —
// but on macOS 26 that combination renders ZERO chevrons (the owner-reported
// batch-6 regression: hiding the native indicator on a borderless menu also
// drops the manual trailing glyph). The robust fix is the plain
// `.menuStyle(.borderlessButton)` pattern with NO `.menuIndicator(.hidden)` and
// NO manual chevron: keep the SINGLE native indicator. Exactly one trailing
// chevron on every chip, on every OS, and it can never double.
//
// SCOPE: ChipMenu owns the chrome of composer CHIPS that drop down a `Menu`.
// The sidebar-footer `AccountsTriggerRow` is deliberately NOT a ChipMenu: it
// presents a rich `.popover` (add account, native login, quota rows,
// auto-balance toggle) that a `Menu` cannot host, and it is a full-width footer
// row, not a fixedSize capsule. Its `chevron.up.chevron.down` is the macOS
// popover-selector affordance (distinct from a dropdown's single `chevron.down`),
// so there is no double-indicator bug to centralize. Keep account PICKING (the
// composer's per-thread override) on ChipMenu; leave the global accounts popover
// trigger as this documented exception.

/// The capsule fill a chip carries.
enum ChipFill {
    /// A tinted translucent capsule (harness / access chips).
    case tinted(Color)
    /// The segmented "selected" fill (intent chip).
    case selected(active: Bool, tint: Color)
    /// A raised surface with a colored hairline (project chip).
    case outlined(stroke: Color)
}

struct ChipMenu<Leading: View, MenuItems: View>: View {
    let tint: Color
    var fill: ChipFill
    var disabled: Bool = false
    var help: String
    /// The chip's leading content WITHOUT the chevron (a logo, a glyph+text…).
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var menu: () -> MenuItems

    var body: some View {
        Menu {
            menu()
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                leading()
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Controls.chipVPadding)
            .modifier(ChipFillModifier(fill: fill))
        }
        // The native borderless-button indicator IS the single trailing chevron
        // (no manual glyph, no `.menuIndicator(.hidden)` — see the note above).
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(disabled)
        .help(help)
    }
}

private struct ChipFillModifier: ViewModifier {
    let fill: ChipFill
    func body(content: Content) -> some View {
        switch fill {
        case .tinted(let color):
            content.background(color.opacity(0.14), in: Capsule())
        case .selected(let active, let tint):
            content.selectedChip(active: active, tint: tint)
        case .outlined(let stroke):
            content
                .background(Theme.surfaceRaisedHi, in: Capsule())
                .overlay(Capsule().strokeBorder(stroke, lineWidth: 1))
        }
    }
}
