import SwiftUI
import ClaudexorKit

// MARK: - Composer controls-row chips
//
// Extracted from `ThreadsScreen.swift` (INV-124 readability ratchet): the
// primary-harness chip and the intent picker. Pure move — zero behavior change.

/// The combined Harness + Account chip (M9-UX item 2): ONE capsule with two
/// menu segments — the harness (logo + name) and, when a concrete harness is
/// chosen, a compact account segment. The account segment shows the thread's
/// pinned account, or the stable "Automatic" (the quota-aware pool of enabled
/// accounts); picking pins the thread via the existing thread PATCH
/// (`setThreadCredentialProfile`). This is the PER-THREAD account override;
/// the popover's Enabled toggles own the global pool membership.
struct HarnessAccountChip: View {
    @Environment(AppModel.self) private var model
    let current: HarnessFamily?
    let pool: [HarnessFamily]
    /// The thread/draft's pinned credential profile (nil = automatic routing).
    let pinnedProfileId: String?
    let onPickHarness: (HarnessFamily?) -> Void
    /// nil = automatic (clear the pin); else pin that profile id.
    let onPickAccount: (String?) -> Void

    /// The colour of both segments' labels. A borderless `Menu` draws its label
    /// in the tint and ignores `foregroundStyle`: in a key window both segments
    /// drew the root accent (3.3:1 dark, 3.8:1 light on the composer glass, #545).
    /// They take the primary label colour, like the monochrome brand mark beside
    /// it; the harness identity rides that mark, the name and the family-fill
    /// capsule, so no harness hue has to be legible as text on the glass.
    static let labelInk = Color.primary

    private var options: [HarnessFamily] {
        pool.isEmpty ? model.selectableHarnesses.filter { $0 != .fake && $0 != .raw } : pool
    }
    private var profiles: [CredentialProfileEntry] {
        guard let current else { return [] }
        return model.activeCredentialProfiles.filter { $0.profile.harnessId == current.rawValue }
    }

    var body: some View {
        HStack(spacing: 0) {
            harnessSegment
            if let current {
                Divider().frame(height: 14).opacity(0.5)
                accountSegment(harness: current)
            }
        }
        .background((current?.fill ?? .secondary).opacity(0.14), in: Capsule())
        .fixedSize()
    }

    private var harnessSegment: some View {
        Menu {
            Button { onPickHarness(nil) } label: {
                Label("Auto", systemImage: "wand.and.stars")
                if current == nil { Image(systemName: "checkmark") }
            }
            Divider()
            ForEach(options) { f in
                Button { onPickHarness(f) } label: {
                    Label { Text(f.label) } icon: { HarnessIconImage.image(for: f) }
                    if current == f { Image(systemName: "checkmark") }
                }
            }
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                if let current { HarnessIcon(family: current, size: 13) }
                else { Image(systemName: "wand.and.stars").imageScale(.small) }
                // Chip meta-rule (round-3 item 4): the harness label NEVER wraps
                // — the owner saw "Code\nx" (Codex broken mid-word) when width-
                // constrained. lineLimit(1) + intrinsic width forbid it.
                Text(current?.label ?? "Auto")
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(Self.labelInk)
            .padding(.leading, Theme.Spacing.md)
            .padding(.trailing, Theme.Spacing.sm)
            .padding(.vertical, Theme.Controls.chipVPadding)
        }
        // Single native chevron (batch-6 item d — no manual glyph / no hidden).
        .menuStyle(.borderlessButton)
        .tint(Self.labelInk)
        .fixedSize()
        .help("Primary harness — answers in chat. A change applies from the next turn; switch from the eligible pool.")
    }

    private func accountSegment(harness: HarnessFamily) -> some View {
        let segment = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: harness.rawValue, pinnedProfileId: pinnedProfileId)
        return Menu {
            Button { onPickAccount(nil) } label: {
                Label("Automatic (account pool)", systemImage: "wand.and.stars")
                if pinnedProfileId == nil { Image(systemName: "checkmark") }
            }
            if !profiles.isEmpty {
                Divider()
                ForEach(profiles) { entry in
                    Button { onPickAccount(entry.profile.profileId) } label: {
                        Label(entry.profile.displayName, systemImage: "person.crop.circle")
                        if pinnedProfileId == entry.profile.profileId { Image(systemName: "checkmark") }
                    }
                }
            }
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: segment.systemImage).imageScale(.small)
                Text(segment.label).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: 90, alignment: .leading)
            }
            // A pin reads semibold beside its pin glyph; "Automatic" stays regular.
            .font(.caption.weight(segment.pinned ? .semibold : .regular))
            .foregroundStyle(Self.labelInk)
            .padding(.leading, Theme.Spacing.sm)
            .padding(.trailing, Theme.Spacing.md)
            .padding(.vertical, Theme.Controls.chipVPadding)
        }
        // Single native chevron (batch-6 item d — no manual glyph / no hidden).
        .menuStyle(.borderlessButton)
        .tint(Self.labelInk)
        .fixedSize()
        .help(segment.pinned
            ? "This thread is pinned to \(segment.label). Pick Automatic to route through the quota-aware pool of enabled accounts instead."
            : "Account for this thread: Automatic routes through the quota-aware pool of enabled accounts and may switch at a quota limit. Pick a specific account to pin it to this thread.")
    }
}

/// Composite Access chip (W19/R14): the per-turn write scope lives in the
/// composer's MAIN controls row — no longer buried in the "⋯" popover — and
/// appends " · Browser" while the agent browser is armed. Browser never widens
/// the selected filesystem access; the daemon validates native MCP support for
/// the selected harness before launch.
struct AccessChip: View {
    /// Active sticky value. nil is the deliberate historical-migration state,
    /// never an instruction to display the repository default as already chosen.
    let access: AccessProfile?
    let browserArmed: Bool
    /// Read-only intents never write — the chip disables, and the visible
    /// reason rides composerAccessHint below the row (not a hover-only tooltip).
    let writeDisabled: Bool
    let onPick: (AccessProfile) -> Void

    private var tint: Color {
        guard let access else { return Theme.status(.caution) }
        return access == .full ? .orange : Theme.accent
    }

    // The chip is JUST the menu — its disable/armed reason rides a separate
    // full-width caption line below the controls row (composerAccessHint), so
    // a narrow window can never crush the reason into a one-character-per-line
    // column inside the fixed-size chips row (owner QA, 2.1.0).
    var body: some View { chipMenu }

    private var chipMenu: some View {
        ChipMenu(
            tint: tint,
            fill: .tinted(tint),
            disabled: writeDisabled,
            help: chipHelp
        ) {
            Image(systemName: access?.glyph ?? "exclamationmark.triangle.fill").imageScale(.small)
            if let access {
                Text(browserArmed ? "\(access.label) · Browser" : access.label)
            } else {
                Text(browserArmed ? "Choose access · Browser" : "Choose access")
            }
        } menu: {
            ForEach(AccessProfile.composerCases) { profile in
                Button { onPick(profile) } label: {
                    Label(profile.label, systemImage: profile.glyph)
                    if access == profile { Image(systemName: "checkmark") }
                }
            }
        }
    }

    private var chipHelp: String {
        if access == nil {
            return "This historical thread used a retired access profile. Choose an active profile to continue."
        }
        if browserArmed {
            return "Browser keeps this access scope; unsupported harness combinations are refused before launch."
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
            if let blocker = threadAccessSelection.migrationBlocker {
                Label(blocker, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2).foregroundStyle(Theme.status(.caution))
                    .fixedSize(horizontal: false, vertical: true)
            } else if composerMode.isReadOnly {
                Text("\(composerMode.label) never writes — switch to Agent to change access")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if effectiveBrowserArmed {
                Text("Browser keeps \(effectiveAccess.label); native support is checked per harness")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// QA-072: disclose a nesting overlap for the chosen project ("Nested inside
    /// …" / "Contains …") so an owner is not confused by two registered roots
    /// whose files overlap. Informational only — never a block; quiet when the
    /// project is disjoint or unregistered.
    @ViewBuilder var composerNestingHint: some View {
        if let repoRoot = composerRepoRoot {
            let relations = model.projectNesting(forRoot: repoRoot)
            if !relations.isEmpty {
                ForEach(relations) { relation in
                    let verb = relation.relation == "inside" ? "Nested inside" : "Contains"
                    Label("\(verb) \(URL(fileURLWithPath: relation.root).lastPathComponent)",
                          systemImage: "square.stack.3d.up")
                        .font(.caption2).foregroundStyle(.tertiary)
                        .help("\(verb) the registered project at \(relation.root). Overlapping roots have separate thread/artifact/trust identities.")
                }
            }
        }
    }

    /// Inline one-time-grant disclosure (W19/Quiz-14): choosing Full access
    /// without a persistent grant surfaces the requirement UP FRONT with the
    /// grant action right here — not only as a post-send refusal card. The
    /// security boundary is unchanged: choosing Full is a REQUEST; the grant
    /// stays a separate explicit act (INV-122).
    @ViewBuilder var composerGrantCTA: some View {
        // QA-007: the persistent trust grant is offered ONLY when the CURRENT
        // intent can actually write. Ask/Plan are engine-clamped to Read-only, so
        // a sticky/stale Full beside them needs no grant — offering it invites a
        // durable unsandboxed authorization the read-only turn will never use.
        if threadAccessSelection.activeAccess != nil,
           effectiveAccess == .full, !composerMode.isReadOnly,
           let repoRoot = composerRepoRoot,
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
