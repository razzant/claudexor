import SwiftUI

// MARK: - ChipMenu (M5c) — ONE composer-chip menu component
//
// Every composer chip (harness / access / intent / project) was an independent
// `Menu` + `.menuStyle(.borderlessButton)` that BOTH drew a manual trailing
// `chevron.down` AND let the borderless-button style draw its own native menu
// indicator — the owner-reported "chevrons on both sides" bug. ChipMenu is the
// single owner of chip-menu chrome: `.menuIndicator(.hidden)` suppresses the
// native indicator so there is exactly ONE trailing chevron, with consistent
// padding, capsule metrics, and fixedSize across every chip.
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
                // The ONE chevron. The native menu indicator is hidden below, so
                // this is the single trailing disclosure the whole app shows.
                Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(.secondary)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Controls.chipVPadding)
            .modifier(ChipFillModifier(fill: fill))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
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
