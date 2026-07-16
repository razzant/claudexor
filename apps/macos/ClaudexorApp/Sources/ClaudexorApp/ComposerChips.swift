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

/// Composite Access chip (W19/Р14): the per-turn write scope lives in the
/// composer's MAIN controls row — no longer buried in the "⋯" popover — and
/// appends " · Browser" while the agent browser is armed. Arming Browser
/// derives Full access (codex's sandbox cancels navigation otherwise), so an
/// access downgrade while armed is UNREPRESENTABLE: the menu disables instead
/// of offering a contradiction.
struct AccessChip: View {
    @Binding var access: AccessProfile
    let browserArmed: Bool
    /// Read-only intents never write (Spec keeps the control for its
    /// eventual Implement turn) — the chip disables with an honest reason.
    let writeDisabled: Bool

    private var tint: Color { access == .full ? .orange : Theme.accent }

    var body: some View {
        Menu {
            ForEach(AccessProfile.composerCases) { profile in
                Button { access = profile } label: {
                    Label(profile.label, systemImage: profile.glyph)
                    if access == profile { Image(systemName: "checkmark") }
                }
            }
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: access.glyph).imageScale(.small)
                Text(browserArmed ? "\(access.label) · Browser" : access.label)
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
        .disabled(writeDisabled || browserArmed)
        .help(chipHelp)
    }

    private var chipHelp: String {
        if browserArmed {
            return "Browser is armed, which requires Full access — disarm Browser (in ⋯) to change the write scope."
        }
        if writeDisabled { return "Read-only intents never write" }
        return "How much this turn may touch (Spec: applies to the Implement turn)"
    }
}

extension ThreadsScreen {
    /// The repo the NEXT turn will execute against: the selected thread's
    /// bound repo, or the Current Project for a draft.
    var composerRepoRoot: String? {
        if let id = model.selectedThreadId { return model.threadRepoRoot(id) }
        return model.normalizedProjectRoot.isEmpty ? nil : model.normalizedProjectRoot
    }

    /// Inline one-time-grant disclosure (W19/Квиз-14): choosing Full access
    /// without a persistent grant surfaces the requirement UP FRONT with the
    /// grant action right here — not only as a post-send refusal card. The
    /// security boundary is unchanged: choosing Full is a REQUEST; the grant
    /// stays a separate explicit act (INV-122).
    @ViewBuilder var composerGrantCTA: some View {
        if access == .full, let repoRoot = composerRepoRoot,
           !model.fullAccessGranted(repoRoot: repoRoot) {
            HStack(spacing: Theme.Spacing.sm) {
                Label("Full access requires a one-time grant for \(URL(fileURLWithPath: repoRoot).lastPathComponent)",
                      systemImage: "lock.shield")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Button("Grant full access") {
                    Task { await model.setTrust(repoRoot: repoRoot, allowFullAccess: true) }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Writes a per-repo user-level trust grant; revoke any time in Settings → Trust.")
                Spacer()
            }
        }
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
