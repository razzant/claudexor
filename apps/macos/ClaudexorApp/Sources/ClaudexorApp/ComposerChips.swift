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
        ChipMenu(
            tint: tint,
            fill: .tinted(tint),
            help: "Primary harness — answers in chat. A change applies from the next turn; switch from the eligible pool."
        ) {
            if let current { HarnessLogo(family: current, size: 13) } else { Image(systemName: "wand.and.stars").imageScale(.small) }
            if !compact { Text(current?.label ?? "Auto") }
        } menu: {
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
        }
    }
}

/// Composite Access chip (W19/R14): the per-turn write scope lives in the
/// composer's MAIN controls row — no longer buried in the "⋯" popover — and
/// appends " · Browser" while the agent browser is armed. Arming Browser
/// derives Full access (codex's sandbox cancels navigation otherwise), so an
/// access downgrade while armed is UNREPRESENTABLE: the menu disables instead
/// of offering a contradiction.
struct AccessChip: View {
    @Binding var access: AccessProfile
    let browserArmed: Bool
    /// Read-only intents never write — the chip disables, and the visible
    /// reason rides composerAccessHint below the row (not a hover-only tooltip).
    let writeDisabled: Bool

    private var tint: Color { access == .full ? .orange : Theme.accent }

    // The chip is JUST the menu — its disable/armed reason rides a separate
    // full-width caption line below the controls row (composerAccessHint), so
    // a narrow window can never crush the reason into a one-character-per-line
    // column inside the fixed-size chips row (owner QA, 2.1.0).
    var body: some View { chipMenu }

    private var chipMenu: some View {
        ChipMenu(
            tint: tint,
            fill: .tinted(tint),
            disabled: writeDisabled || browserArmed,
            help: chipHelp
        ) {
            Image(systemName: access.glyph).imageScale(.small)
            Text(browserArmed ? "\(access.label) · Browser" : access.label)
        } menu: {
            ForEach(AccessProfile.composerCases) { profile in
                Button { access = profile } label: {
                    Label(profile.label, systemImage: profile.glyph)
                    if access == profile { Image(systemName: "checkmark") }
                }
            }
        }
    }

    private var chipHelp: String {
        if browserArmed {
            return "Browser is armed, which requires Full access — disarm Browser (in ⋯) to change the write scope."
        }
        if writeDisabled { return "Read-only intents never write" }
        return "How much this turn may touch"
    }
}

extension ThreadsScreen {
    /// The repo the NEXT turn will execute against: the selected thread's
    /// bound repo, or the Current Project for a draft.
    var composerRepoRoot: String? {
        if let id = model.selectedThreadId { return model.threadRepoRoot(id) }
        return model.normalizedProjectRoot.isEmpty ? nil : model.normalizedProjectRoot
    }

    /// The Access chip's disable/armed reason on its OWN full-width line under
    /// the controls row (never inline in the fixed-size chips HStack, where a
    /// narrow window crushed it to a vertical one-char-per-line column). Only
    /// shown for project threads (the chip itself only appears there).
    @ViewBuilder var composerAccessHint: some View {
        if threadHasProject {
            if composerMode.isReadOnly {
                Text("\(composerMode.label) never writes — switch to Agent to change access")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if browser {
                Text("Browser armed → Full (disarm in ⋯)")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Inline one-time-grant disclosure (W19/Quiz-14): choosing Full access
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

/// The intent picker (D24): exactly Ask / Plan / Agent. Best-of / Create /
/// until-clean stopped being intents — they are Agent STRATEGY knobs in the
/// "⋯" popover; Council is a Plan knob. Deep-scan / Spec are likewise gone.
struct IntentMenu: View {
    @Binding var selection: RunMode
    let projectScoped: Bool

    private var options: [RunMode] {
        projectScoped ? [.ask, .plan, .agent] : [.ask]
    }

    var body: some View {
        ChipMenu(
            tint: Theme.accent,
            fill: .selected(active: true, tint: Theme.accent),
            help: projectScoped
                ? "Intent for the next turn — Agent strategy (Best-of / until-clean / create / delegate) and Plan council live in ⋯"
                : "No Current Project — only Ask (read-only) is available."
        ) {
            Image(systemName: selection.glyph).imageScale(.small)
            Text(selection.label).fontWeight(.medium)
        } menu: {
            ForEach(options) { m in
                Button {
                    selection = m
                } label: {
                    Label(m.label, systemImage: m.glyph)
                    if m == selection { Image(systemName: "checkmark") }
                }
            }
        }
    }
}
