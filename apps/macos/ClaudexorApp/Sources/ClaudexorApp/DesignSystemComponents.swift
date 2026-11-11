import SwiftUI
import ClaudexorKit

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
    /// A concise, STABLE accessible name (QA-012): a long punctuation-heavy
    /// placeholder must not become the control's VoiceOver name. Defaults to the
    /// placeholder for callers that don't separate name from hint.
    var accessibilityName: String?
    /// The accessible HINT — the state-honest action description (create vs
    /// continue), kept separate from the name so it is not truncated/false.
    var accessibilityHintText: String?
    var maxLines: Int = 6
    var onSubmit: () -> Void = {}
    var composerInput: ConversationComposerInput? = nil
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
            .background { if let composerInput { ComposerInputRegistration(input: composerInput) } }
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
            .accessibilityLabel(accessibilityName ?? placeholder)
            .accessibilityHint(accessibilityHintText ?? "")
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

/// The composer's project picker (issue #8). Shows the selected project and lets
/// you switch it from an MRU menu or Browse… A thread's repo is bound, so the chip
/// is informational on an open thread and choosing another project starts a NEW
/// draft thread there (the model owns that semantics).
struct ProjectChip: View {
    let context: ComposerSelectionContext
    let metadataKnown: Bool
    /// True when showing an open thread's fixed repo (vs the draft Current Project).
    let bound: Bool
    let hasProject: Bool
    let recent: [String]
    let remoteConnections: [RemoteConnection]
    let onPick: (String) -> Void
    let onBrowse: () -> Void
    let onPickRemote: (UUID, String) -> Void
    let onBrowseRemote: (UUID) -> Void
    /// Explicit transition back to no-project Ask (QA-006). Keeps this the ONE
    /// owner-locked project surface (INV-101); the destination Ask-only state
    /// already works — this is the missing way INTO it after a project was used.
    var onNoProject: () -> Void = {}
    @State private var checkout: (context: ComposerSelectionContext, status: ProjectCheckoutStatus)?
    @State private var checkoutRefresh = 0

    var body: some View {
        let remote = remoteConnections.first { ExecutionLocationID.remote($0.id).rawValue == context.locationID }
        let labelRecents = context.locationID == ExecutionLocationID.local.rawValue ? recent : remote?.savedProjects ?? []
        let probe = ProjectCheckoutProbe(context: context, refresh: checkoutRefresh)
        // Until this selection's probe publishes, a previous selection's result reads as not yet checked.
        let observed = checkout?.context == context ? checkout : nil
        let presentation = ProjectCheckoutPresentation(
            context: context, observedContext: observed?.context, status: observed?.status,
            metadataKnown: metadataKnown, recent: labelRecents, connectionName: remote?.displayName)
        return ChipMenu(
            tint: hasProject ? Color.secondary : Theme.accent,
            fill: .outlined(stroke: hasProject ? Theme.separator : Theme.accent.opacity(0.5)),
            help: presentation.chipHelp
        ) {
            // Constant glyph in the chip's tint: checkout topology lives only in help and the AX value.
            Image(systemName: hasProject ? "folder.fill" : "folder.badge.questionmark")
                .imageScale(.small)
                .frame(width: 14, height: 14)
                .accessibilityHidden(true)
            Text(presentation.name).lineLimit(1)
        } menu: {
            // A stable row (above the MRU) so no-project stays reachable even with
            // no recents; disabled when already scopeless so it never no-ops.
            Button { onNoProject() } label: {
                Label("No project (Ask only)", systemImage: "questionmark.folder")
            }
            .disabled(!hasProject)
            .help("Start a general read-only Ask with no project scope.")
            Divider()
            if !recent.isEmpty {
                Section(bound ? "Switch project — starts a new thread" : "Recent projects") {
                    ForEach(recent, id: \.self) { path in
                        Button { onPick(path) } label: {
                            Label(ProjectPathSelection.recentProjectLabel(path, among: recent), systemImage: "folder")
                        }
                        .help(path)
                    }
                }
                Divider()
            }
            if !remoteConnections.isEmpty {
                Section("Remote") {
                    ForEach(remoteConnections) { connection in
                        Menu(connection.displayName) {
                            ForEach(connection.savedProjects, id: \.self) { path in
                                Button {
                                    onPickRemote(connection.id, path)
                                } label: {
                                    Label(
                                        ProjectPathSelection.recentProjectLabel(path, among: connection.savedProjects),
                                        systemImage: "folder")
                                }
                                .help(path)
                            }
                            if !connection.savedProjects.isEmpty { Divider() }
                            Button {
                                onBrowseRemote(connection.id)
                            } label: {
                                Label(
                                    "Browse on \(connection.displayName)…",
                                    systemImage: "network")
                            }
                        }
                    }
                }
                Divider()
            }
            Button { onBrowse() } label: {
                Label("Browse This Mac…", systemImage: "folder.badge.plus")
            }
        }
        .accessibilityLabel("Project")
        .accessibilityValue(presentation.accessibilityValue)
        .onHover { inside in
            guard inside, probe.localPath != nil else { return }
            // Refresh on inspection, including a folder removed since selection. No lasting cache.
            checkout = nil
            checkoutRefresh &+= 1
        }
        // A new selection restarts only this probe, never the chip, so focus stays on the menu after a pick.
        .task(id: probe) {
            // Cleared for every selection, so a remote or no-project hop cannot resurrect older evidence.
            checkout = nil
            guard let path = probe.localPath else { return }
            let worker = Task.detached(priority: .utility) {
                ProjectPathSelection.checkoutStatus(for: path, isLocal: true)
            }
            let status = await withTaskCancellationHandler {
                await worker.value
            } onCancel: {
                worker.cancel()
            }
            guard !Task.isCancelled else { return }
            checkout = (probe.context, status)
        }
    }
}

/// The chip's checkout-probe identity: the complete selection plus an explicit refresh.
struct ProjectCheckoutProbe: Equatable {
    let context: ComposerSelectionContext
    let refresh: Int

    /// Only a local selected folder is observed; remote hosts and no-project selections never are.
    var localPath: String? {
        context.locationID == ExecutionLocationID.local.rawValue && !context.repoRoot.isEmpty
            ? context.repoRoot : nil
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

// MARK: - Settings group (the ONE flat settings-section shell)

/// The flat, solid, shadowless Settings section shell (DESIGN_SYSTEM §5):
/// `SectionLabel` over the content on a raised surface with a hairline. Every
/// Settings tab composes THIS — the recipe was previously a private helper in
/// OpsScreens and Connections hand-copied it, which is exactly how shells drift.
struct SettingsGroup<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder var content: () -> Content

    init(_ title: String, systemImage: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(title, systemImage: systemImage)
            content()
        }
        .padding(Theme.Spacing.lg)
        .background(
            Theme.surfaceRaised,
            in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                .stroke(Theme.separator, lineWidth: 1))
    }
}

// MARK: - DisclosureRow — the ONE disclosure header (whole-row click target)

/// The app's disclosure control. The platform `DisclosureGroup` makes ONLY the
/// ~12px chevron the toggle target on macOS (its label is inert) — correct per
/// HIG for a bare disclosure triangle, wrong for every labeled "Advanced …" row
/// we ship (the owner clicked the label and nothing happened). This component
/// wraps `DisclosureGroup` in a custom `DisclosureGroupStyle` whose header is
/// one full-width native `Button`:
///
/// - the WHOLE header — chevron, label, trailing whitespace — is clickable
///   (`contentShape(Rectangle())` inside the button label);
/// - row height comes from token padding (≥28pt), never a fixed frame;
/// - the chevron points right collapsed, rotates down expanded; ONLY the
///   chevron animates, and Reduce Motion snaps it;
/// - hover/pressed states on the header; keyboard focus uses the native
///   button ring (no extra `.focusable()`);
/// - Space/Return toggle; Right Arrow expands, Left Arrow collapses; focus
///   stays on the header so the next Tab enters the revealed content;
/// - VoiceOver gets ONE button named `accessibilityName` with value
///   Collapsed/Expanded; the chevron is hidden from accessibility;
/// - collapsed content is REMOVED from layout/focus/accessibility (never
///   hidden with opacity);
/// - the label must not contain nested buttons, links, menus, or toggles.
struct DisclosureRow<Label: View, Content: View>: View {
    let accessibilityName: String
    @Binding var isExpanded: Bool
    /// Full-bleed header fill (the diff file header keeps its raised strip);
    /// nil = transparent, hover highlight only.
    var headerBackground: Color?
    @ViewBuilder var label: () -> Label
    @ViewBuilder var content: () -> Content

    init(
        accessibilityName: String,
        isExpanded: Binding<Bool>,
        headerBackground: Color? = nil,
        @ViewBuilder label: @escaping () -> Label,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.accessibilityName = accessibilityName
        self._isExpanded = isExpanded
        self.headerBackground = headerBackground
        self.label = label
        self.content = content
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            content()
        } label: {
            label()
        }
        .disclosureGroupStyle(
            RowDisclosureGroupStyle(
                accessibilityName: accessibilityName, headerBackground: headerBackground))
    }
}

extension DisclosureRow where Label == Text {
    /// The common titled row: the title is both the visible label and the
    /// accessible name.
    init(
        _ title: String,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            accessibilityName: title, isExpanded: isExpanded,
            label: { Text(title) }, content: content)
    }
}

private struct RowDisclosureGroupStyle: DisclosureGroupStyle {
    let accessibilityName: String
    let headerBackground: Color?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                configuration.isExpanded.toggle()
            } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "chevron.right")
                        .imageScale(.small)
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0))
                        // ONLY the chevron animates; Reduce Motion snaps it.
                        .animation(
                            reduceMotion ? nil : .easeOut(duration: 0.15),
                            value: configuration.isExpanded)
                        .accessibilityHidden(true)
                    configuration.label
                    Spacer(minLength: 0)
                }
                // The whole header, trailing whitespace included, is the target.
                .contentShape(Rectangle())
            }
            .buttonStyle(DisclosureRowHeaderButtonStyle())
            .background(headerBackground ?? Color.clear)
            .accessibilityLabel(accessibilityName)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint(configuration.isExpanded ? "Collapses the section." : "Expands the section.")
            // Right expands, Left collapses. `onKeyPress` (not `onMoveCommand`)
            // so an already-satisfied press and Up/Down PROPAGATE — in-group
            // arrow navigation keeps working.
            .onKeyPress(.rightArrow) {
                guard !configuration.isExpanded else { return .ignored }
                configuration.isExpanded = true
                return .handled
            }
            .onKeyPress(.leftArrow) {
                guard configuration.isExpanded else { return .ignored }
                configuration.isExpanded = false
                return .handled
            }
            // Collapsed content is OUT of layout, focus, and accessibility.
            if configuration.isExpanded { configuration.content }
        }
    }
}

private struct DisclosureRowHeaderButtonStyle: ButtonStyle {
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // Token padding, not a fixed height: text + 2×sm ≈ 28pt+.
            .padding(.vertical, Theme.Spacing.sm)
            .padding(.horizontal, Theme.Spacing.sm)
            .background(
                configuration.isPressed
                    ? Theme.surfaceRaisedHi
                    : hovering ? Theme.surfaceRaisedHi.opacity(0.6) : Color.clear,
                in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .onHover { hovering = $0 }
    }
}

extension View {
    /// The shared CLOSED-control contract for a catalog-fed model picker
    /// (composer models rows + Settings model override). Vendor catalogs are
    /// free text with no length contract, so the closed button pins to the
    /// `Theme.Layout.modelPickerWidth` token and truncates mid-string — the
    /// family prefix and the id tail both stay readable — instead of widening
    /// its row (§1 rule 4; issue #53). The OPEN menu is bounded separately by
    /// `HarnessModelPresentation.menuTitle`: an NSMenu sizes to its widest
    /// ITEM, which no closed-control frame can cap.
    func catalogModelPicker() -> some View {
        labelsHidden()
            .frame(width: Theme.Layout.modelPickerWidth, alignment: .leading)
            .lineLimit(1)
            .truncationMode(.middle)
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
