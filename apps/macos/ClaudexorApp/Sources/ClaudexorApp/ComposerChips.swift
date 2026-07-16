import SwiftUI

// MARK: - Composer controls-row chips
//
// Extracted from `ThreadsScreen.swift` (INV-124 readability ratchet): the
// primary-harness chip and the intent picker. Pure move — zero behavior change.

/// The PRIMARY harness chip: shows which harness answers in chat (logo + name)
struct PrimaryHarnessChip: View {
    @Environment(AppModel.self) private var model
    let current: HarnessFamily?
    let pool: [HarnessFamily]
    var compact: Bool = false
    let onPick: (HarnessFamily?) -> Void

    private var tint: Color { current?.color ?? .secondary }
    private var options: [HarnessFamily] { pool.isEmpty ? model.selectableHarnesses.filter { $0 != .fake && $0 != .raw } : pool }

    var body: some View {
        Menu {
            Button { onPick(nil) } label: {
                Label("Auto", systemImage: "wand.and.stars")
                if current == nil { Image(systemName: "checkmark") }
            }
            Divider()
            ForEach(options) { f in
                Button { onPick(f) } label: {
                    Label(f.label, systemImage: f.glyph)
                    if current == f { Image(systemName: "checkmark") }
                }
            }
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                if let current { HarnessLogo(family: current, size: 13) } else { Image(systemName: "wand.and.stars").imageScale(.small) }
                if !compact { Text(current?.label ?? "Auto") }
                Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(.secondary)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Controls.chipVPadding)
            .background(tint.opacity(0.14), in: Capsule())
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Primary harness — answers in chat. A change applies from the next turn; switch from the eligible pool.")
    }
}

/// The intent picker, styled to the design system with a visible selection.
/// "Spec" starts the grounding flow; "Best-of" runs the eligible pool (engine
/// `agent` + race strategy).
/// Strategies (until-clean, max-attempts) live in the composer's "⋯" panel.
struct IntentMenu: View {
    @Binding var selection: RunMode
    let projectScoped: Bool

    private var options: [RunMode] {
        projectScoped ? [.ask, .agent, .plan, .spec, .readOnlyAudit, .bestOfN] : [.ask]
    }
    private func label(_ m: RunMode) -> String { m == .bestOfN ? "Best-of" : m.label }

    var body: some View {
        Menu {
            ForEach(options) { m in
                Button {
                    selection = m
                } label: {
                    Label(label(m), systemImage: m.glyph)
                    if m == selection { Image(systemName: "checkmark") }
                }
            }
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: selection.glyph).imageScale(.small)
                Text(label(selection)).fontWeight(.medium)
                Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(.secondary)
            }
            .font(.caption)
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Controls.chipVPadding)
            .selectedChip(active: true, tint: Theme.accent)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(projectScoped
              ? "Intent for the next turn — Best-of runs the eligible pool; until-clean / attempts are in ⋯"
              : "No Current Project — only Ask (read-only) is available.")
    }
}
