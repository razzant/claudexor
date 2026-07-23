import SwiftUI
import AppKit
import ClaudexorKit
import UniformTypeIdentifiers

/// Chat/session-first cockpit (v0.9 variant A): LEFT — threads + needs-me;
/// RIGHT — the conversation with a persistent composer. A thread's turns
/// resume each harness's own native CLI session, so "plan, then continue"
/// is one conversation, not a context reset. Runs stay inspectable via the
/// existing TaskDetail surface (a turn links to its run).
struct ThreadsScreen: View {
    @Environment(AppModel.self) var model
    @State private var composerText = ""
    /// Files/images staged for upload before the next turn. Images are gated by
    /// each selected harness's finite attachment-input declaration.
    @State var composerAttachments: [PendingAttachment] = []
    @State var composerMode: RunMode = .agent
    // "⋯" per-turn options (collapsed by default).
    @State private var showOptions = false
    @State var capUsdText = ""
    @State var access: AccessProfile = .workspaceWrite
    @State var webPolicy = "auto"
    /// Per-turn auth route REQUEST (W18): auto | subscription | api_key. Not sticky.
    @State var authRoutePreference = ""  // "" = Thread default; see authRouteRequest (sol #1)
    /// Per-turn reasoning effort ("" = harness default). Not sticky.
    @State var effortPreference = ""
    @State var maxAttempts = 3
    /// Agent STRATEGY knob (D24): Single / Best-of / Until-clean / Create. Was a
    /// set of distinct intents; now a per-turn knob inside Agent. Not sticky.
    @State var agentStrategy: AgentStrategy = .single
    /// Agent delegation belt (D32): inject the Claudexor MCP belt so the harness
    /// can spawn bounded isolated sub-runs. Agent-only, default OFF. Not sticky.
    @State var delegate = false
    /// Plan strategy (D31): Council draft-and-merge across N harnesses. Plan-only.
    @State var councilEnabled = false
    @State var councilMembers = 2
    /// Arm the agent-driven browser (Playwright MCP) for this turn. Requires full
    /// access (codex's sandbox cancels navigation otherwise); turning it on forces
    /// access to full + is disclosed in the options panel. Not sticky across threads.
    @State var browser = false
    @State var reviewerPanelText = ""
    @State var protectedApprovalsText = ""
    /// Per-turn model override for the primary harness. Empty = harness default
    /// (the global default stays in Settings → Harnesses). Not sticky across threads.
    /// Harness-scoped per-turn models (harness id -> model id); built by the
    /// per-harness pickers in the "⋯" popover (no run-global model).
    @State var composerModels: [String: String] = [:]
    /// Enumerated models for the current primary harness (ADP4). nil until loaded;
    /// an empty / non-enumerable response falls back to a free-text field.
    /// Cached model truth sources per pooled harness (id -> catalog).
    @State var poolModelCatalogs: [String: HarnessModelsResponse] = [:]
    /// True while a Stop request is in flight for the head run (server owns the cancel).
    @State private var stopping = false
    /// Width of the LEFT thread list, driven by an explicit drag handle (item 6).
    /// HSplitView dragged from the "wrong side" (the right pane grew when you dragged
    /// the divider) — an explicit width + Divider makes the drag track the cursor:
    /// drag right widens the list, left narrows it, clamped to [minThreadW, maxThreadW].
    @State private var threadListWidth: CGFloat = 280
    /// Width captured at the start of a divider drag; nil when not dragging. The drag
    /// translation is added to THIS (not the live width) so the divider can't run away.
    @State private var dragStartWidth: CGFloat?
    private let minThreadW: CGFloat = 240
    private let maxThreadW: CGFloat = 360

    var poolFamilies: [HarnessFamily] { model.selectableHarnesses.filter { $0 != .fake && $0 != .raw } }

    /// Project-aware intents need a project scope. A selected thread uses its own
    /// repo; in the DRAFT state (no thread selected yet) the first turn will be
    /// created on the Current Project, so the project intents are available too.
    var threadHasProject: Bool {
        if let id = model.selectedThreadId, let t = model.threads.first(where: { $0.id == id }) {
            return t.repoRoot?.isEmpty == false
        }
        return !model.normalizedProjectRoot.isEmpty
    }

    /// The harness that will answer in chat (sticky thread primary > global default).
    var primaryFamily: HarnessFamily? {
        model.effectivePrimaryHarness.flatMap { HarnessFamily(rawValue: $0) }
    }
    /// The eligible pool (Best-of runs this); resolved from thread sticky > global.
    var resolvedPoolFamilies: [HarnessFamily] {
        model.effectiveEligiblePool.map { HarnessFamily(rawValue: $0) }
    }
    /// The families the popover PRESENTS as included in the pool (QA-011): the
    /// Auto sentinel EXPANDED to the currently available/routable families for
    /// this intent (matching the highlighted chips), or the explicit subset when
    /// pinned. The per-harness model rows and the selection pruning both consume
    /// THIS — so the two Auto projections (chips vs rows) can never disagree. The
    /// wire pool stays the empty Auto sentinel; Auto is never materialized into an
    /// explicit harness list merely to render.
    var effectiveIncludedFamilies: [HarnessFamily] {
        let available = poolFamilies.filter { model.availability(for: $0, mode: composerMode).available }
        return HarnessPoolPresentation
            .includedFamilies(pool: model.effectiveEligiblePool, available: available.map(\.rawValue))
            .map { HarnessFamily(rawValue: $0) }
    }
    /// The thread/draft's pinned credential profile (M9-UX item 2): the composer
    /// Harness+Account chip's per-thread override. nil = follow the harness default.
    var composerPinnedProfileId: String? {
        model.selectedThreadId == nil
            ? model.draftCredentialProfileId
            : model.currentThread?.credentialProfileId
    }
    /// Per-turn options the "⋯" panel collects, mapped onto engine run-start fields.
    private var currentOptions: TurnOptions {
        TurnOptions(
            maxUsd: ComposerOptionParser.parseNonnegativeFiniteDouble(capUsdText),
            access: access == .workspaceWrite ? nil : access.wire,  // workspace_write is the engine default
            web: webPolicy == "auto" ? nil : webPolicy,
            // untilClean / delegate / council are overlaid in send() from the
            // resolved Agent/Plan strategy (resolveComposerStrategy).
            maxAttempts: maxAttempts == 3 ? nil : maxAttempts,
            // Preserve the user's request even if the cached capability view
            // changed after the toggle was armed. The engine owns the typed
            // per-lane resolution/refusal; silently clearing it here would erase
            // requested/effective evidence.
            browser: browser,
            models: composerModels,
            reviewerPanel: reviewerPanelEntries.isEmpty ? nil : reviewerPanelEntries,
            protectedPathApprovals: protectedPathApprovals.isEmpty ? nil : protectedPathApprovals,
            authRoute: Self.authRouteRequest(authRoutePreference),
            effort: effortPreference.isEmpty ? nil : effortPreference
        )
    }

    /// Any harness in the pool can take the agent-driven browser (manifest
    /// `browser_tool`). Gates the composer toggle so we never offer browsing where
    /// no adapter can inject Playwright MCP.
    var browserAvailableForCurrentTurn: Bool {
        guard !composerMode.isReadOnly else { return false }
        let eligible = Set(model.effectiveEligiblePool)
        let candidates = eligible.isEmpty
            ? poolFamilies
            : poolFamilies.filter { eligible.contains($0.rawValue) }
        return candidates.contains { family in
            model.availability(for: family, mode: composerMode).available &&
                model.harnessInfo(for: family)?.acceptsBrowser == true
        }
    }

    /// The per-turn budget field is INVALID when it's non-empty but not a finite non-negative
    /// number. A typo must NOT silently drop the user's cap (the typed-money contract)
    /// — Send is blocked while invalid, with an inline reason. Empty = no cap (valid).
    var capUsdInvalid: Bool {
        let t = capUsdText.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return false }
        return ComposerOptionParser.parseNonnegativeFiniteDouble(t) == nil
    }

    private var reviewerPanelTokens: [String] {
        ComposerOptionParser.splitOptionTokens(reviewerPanelText)
    }

    private var reviewerPanelEntries: [ReviewerPanelEntry] {
        let efforts = Set(model.liveHarnesses.flatMap(\.effortLevels))
        return reviewerPanelTokens.compactMap {
            ComposerOptionParser.parseReviewerPanelEntry($0, effortLevels: efforts)
        }
    }

    var reviewerPanelInvalid: Bool {
        let tokens = reviewerPanelTokens
        return !tokens.isEmpty && tokens.count != reviewerPanelEntries.count
    }

    private var protectedApprovalTokens: [String] {
        ComposerOptionParser.splitOptionTokens(protectedApprovalsText)
    }

    private var protectedPathApprovals: [ProtectedPathApproval] {
        protectedApprovalTokens.compactMap(ComposerOptionParser.parseProtectedPathApproval)
    }

    var protectedApprovalsInvalid: Bool {
        let tokens = protectedApprovalTokens
        return !tokens.isEmpty && tokens.count != protectedPathApprovals.count
    }

    private var composerOptionsInvalid: Bool {
        capUsdInvalid || reviewerPanelInvalid || protectedApprovalsInvalid
    }

    private var composerImageAttachmentsInvalid: Bool {
        composerAttachments.contains { $0.kind == "image" } && !imageAttachmentsAllowed
    }

    private var composerSendInvalid: Bool {
        composerOptionsInvalid || composerImageAttachmentsInvalid
    }

    private var composerBlockHelp: String {
        if capUsdInvalid { return "Fix the budget cap in ⋯ options to send" }
        if reviewerPanelInvalid { return "Fix the reviewer panel in ⋯ options to send" }
        if protectedApprovalsInvalid { return "Fix protected path approvals in ⋯ options to send" }
        if composerImageAttachmentsInvalid { return "Images need an available vision-capable route" }
        return "Send (⌘↩)"
    }

    var body: some View {
        // The threads list is a FLOATING Liquid Glass panel (nav layer) inset from the
        // window edges over the behind-window backdrop — not a flush split pane with a
        // hard divider (which read as flat/dated, esp. in light mode). The conversation
        // is content and stays on its solid/backdrop surface (no glass-on-content). The
        // hard divider is gone; the gap floats the panel and an INVISIBLE trailing hot
        // zone keeps drag-resize (drag right ⇒ wider, clamped to [minThreadW, maxThreadW]).
        HStack(spacing: 0) {
            threadList
                .frame(width: threadListWidth, alignment: .leading)
                .frame(maxHeight: .infinity)
                .sidebarGlass()
                .padding(.leading, sidebarInset)
                .padding(.vertical, sidebarInset)
                .overlay(alignment: .trailing) { sidebarResizeHandle }
            conversation
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
                .padding(.leading, sidebarGap)
        }
        .task { await model.refreshThreads(); await model.refreshQuota(); await model.refreshTrust() }
        .navigationTitle(navTitle)
        .navigationSubtitle(navSubtitle)
    }

    /// Inset of the floating sidebar panel from the window edges (leading + vertical).
    /// Collapses to 0 in native full screen (M9-UX item 7) so the panel sits
    /// flush — the windowed floating gap otherwise exposed the clear window
    /// background at the rounded corners as a stray artifact.
    private var sidebarInset: CGFloat { model.isFullScreen ? 0 : Theme.Metrics.floatingSidebarInset }
    /// Gap between the floating sidebar and the conversation (replaces the divider).
    private let sidebarGap: CGFloat = Theme.Spacing.sm
    /// Invisible drag strip width for the sidebar resize affordance.
    private let sidebarResizeHandleWidth: CGFloat = Theme.Metrics.sidebarResizeHandleWidth

    /// Invisible drag strip on the panel's trailing edge — keeps the resize affordance
    /// without a visible divider. Offset into the gap so the cursor target sits between
    /// the panel and the conversation. Width AT DRAG START is captured once so the
    /// cumulative translation can't compound each frame and run away.
    private var sidebarResizeHandle: some View {
        Color.clear
            .frame(width: sidebarResizeHandleWidth)
            .contentShape(Rectangle())
            .offset(x: (sidebarGap + sidebarResizeHandleWidth) / 2)
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(coordinateSpace: .global)
                    .onChanged { value in
                        let base = dragStartWidth ?? threadListWidth
                        if dragStartWidth == nil { dragStartWidth = base }
                        threadListWidth = min(maxThreadW, max(minThreadW, base + value.translation.width))
                    }
                    .onEnded { _ in dragStartWidth = nil }
            )
    }

    // MARK: Threads pane

    private var threadList: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Threads")
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding([.horizontal, .top], Theme.Spacing.md)

            if model.threads.isEmpty {
                ContentUnavailableView(
                    "No threads yet",
                    systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("Start a thread to work conversationally: plan, continue, race, review, apply — one conversation.")
                )
                .frame(maxHeight: .infinity)
            } else {
                List(model.threads, selection: Binding(
                    get: { model.selectedThreadId },
                    set: { id in
                        if let id { Task { await model.openThread(id) } }
                    }
                )) { thread in
                    threadRow(thread).tag(thread.id)
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)   // let the Liquid Glass panel show through
            }

            SidebarFooter()
        }
        .padding(.top, Theme.Spacing.xs)
        .sheet(isPresented: Binding(
            get: { renameTargetId != nil },
            set: { if !$0 { renameTargetId = nil } }
        )) { renameSheet }
    }

    @State var renameDraft = ""
    @State var renameTargetId: String?


    // MARK: Conversation pane

    private var conversation: some View {
        VStack(spacing: 0) {
            if let detail = model.selectedThreadDetail {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                            ForEach(detail.turns) { turn in
                                // C (D-13): the readable 680pt measure is applied PER
                                // ROW, not as a double-frame around the whole LazyVStack
                                // — a sidebar drag / width change no longer relayouts the
                                // entire scrolled column as one framed unit; each row
                                // measures independently (scroll position stays anchored).
                                TurnCard(turn: turn)
                                    .conversationMeasure()
                                    .id(turn.id)
                            }
                            if !detail.sessions.isEmpty {
                                sessionsFooter(detail.sessions)
                                    .conversationMeasure()
                            }
                        }
                        .padding(Theme.Spacing.lg)
                        // B (D-13): selection backing is SCOPED to the text nodes users
                        // actually select (message / answer / transcript Text carry their
                        // own `.textSelection(.enabled)`). Overriding the window-root
                        // global (RootView, §2.9) to DISABLED here strips the selectable
                        // NSText backing from the feed's receipts / chips / status
                        // containers, which never needed it; a descendant `.enabled` on
                        // real prose still wins locally.
                        .textSelection(.disabled)
                    }
                    .onChange(of: detail.turns.count) {
                        if let last = detail.turns.last { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            } else {
                emptyConversation
            }

            if let status = model.threadStatus {
                StatusBanner(message: status)
            }

            // The isolated-thread apply-thread action moved into the thread
            // workspace's Changes tab (D42) — the conversation is just the feed +
            // composer now.

            composer
        }
    }

    /// The conversation's window title/subtitle — the thread title lives in the
    /// ONE system toolbar (no second custom header strip). Empty in the draft state.
    var navTitle: String { model.currentThread?.title ?? "Claudexor" }
    var navSubtitle: String {
        guard let t = model.currentThread else { return "" }
        return threadSubtitle(t) + " · " + (t.workspaceMode == "isolated" ? "isolated" : "in-place")
    }

    /// The persistent composer — ONE floating Liquid-Glass panel (pointer-driven
    /// lensing; solid fallback under Reduce Transparency). Its contents stay SOLID
    /// (no glass-on-glass): a controls row (intent + primary + "⋯"), a Messages-style
    /// field on a solid inset, a prominent Send, and an inline advanced panel that
    /// morphs in via the GlassEffectContainer. Chat is the NORMAL loop.
    // The composer's controls row (mode/project/harness/access chips + ⋯),
    // extracted so the composer VStack stays type-checkable (round-19).
    @ViewBuilder private var composerControlsRow: some View {
        // M9-UX item 6: the chips WRAP (FlowLayout) rather than overflowing the
        // conversation column. Fixed-size chips in a plain HStack kept their ideal
        // widths and pushed the composer glass wider than the column at narrow
        // widths / with the inspector open, spilling under the side panels. A
        // wrapping layout bounded to the column width can never overflow.
        FlowLayout(spacing: Theme.Spacing.sm) {
            IntentMenu(selection: $composerMode, projectScoped: threadHasProject)
            ProjectChip(name: projectChipName,
                        bound: model.selectedThreadId != nil,
                        hasProject: threadHasProject,
                        recent: model.recentProjects,
                        onPick: { model.pickProject($0) },
                        onBrowse: { model.browseProject() },
                        onNoProject: { model.clearProject() })
            if threadHasProject {
                HarnessAccountChip(
                    current: primaryFamily,
                    pool: resolvedPoolFamilies,
                    pinnedProfileId: composerPinnedProfileId,
                    onPickHarness: { picked in Task { await model.setPrimaryHarness(picked?.rawValue) } },
                    onPickAccount: { profileId in
                        Task {
                            if let profileId {
                                await model.setThreadCredentialProfile(profileId, harnessId: primaryFamily?.rawValue)
                            } else {
                                await model.setThreadCredentialProfile(nil)
                            }
                        }
                    })
                // D26: the write scope is STICKY per thread — the chip reflects
                // the thread's server-side `access` and a switch PATCHes it
                // (persists across turns/reload). " · Browser" appends while armed.
                AccessChip(access: $access, browserArmed: browser,
                           writeDisabled: composerMode.isReadOnly)
            }
            // The "⋯" options button is ALWAYS available — a no-project Ask is
            // still entitled to a per-turn model / web / budget. `composerOptions`
            // itself hides the project-only controls (Context, Workspace, repair).
            Button {
                showOptions.toggle()
            } label: {
                Image(systemName: "slider.horizontal.3")
                    // Subtle active tint only while the panel is open, so the
                    // options control reads as a PEER of the other composer-row
                    // controls — not the one prominent filled button (it
                    // looked like the only clickable thing). No glass fill.
                    .foregroundStyle(showOptions ? Theme.accent : .secondary)
                    .padding(.horizontal, Theme.Spacing.xs)
                    .padding(.vertical, Theme.Controls.chipVPadding)
                    .background(showOptions ? Theme.accent.opacity(0.14) : .clear, in: Capsule())
            }
            .buttonStyle(.borderless)
            .help("More options: harness pool, model, budget, access, web, repair strategies")
            // Native dismissible popover — no inline glass-on-glass panel.
            .popover(isPresented: $showOptions, arrowEdge: .bottom) {
                composerOptions
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { if !threadHasProject { composerMode = .ask } }
        .onChange(of: model.selectedThreadId) {
            // QA-007: a FRESH draft seeds intent from the project default — Agent
            // for a project, Ask for none — so a stale Ask/Plan from the previous
            // thread never leaks onto a new project draft. Selecting an EXISTING
            // thread keeps the current intent (only clamping no-project to Ask).
            if model.selectedThreadId == nil {
                composerMode = threadHasProject ? .agent : .ask
            } else if !threadHasProject {
                composerMode = .ask
            }
            // Per-turn knobs are not sticky — don't carry one thread's budget
            // cap / web / repair flags / model into the next thread. Access is
            // the exception (D26): it's sticky per thread, so SEED it from the
            // thread's server-side value (nil sticky => the repo trust default,
            // A8: seed the actual default, not a hardcoded Workspace write).
            capUsdText = ""; webPolicy = "auto"; authRoutePreference = ""; effortPreference = ""
            access = model.effectiveThreadAccess.flatMap(AccessProfile.init(wire:)) ?? model.composerAccessDefault
            maxAttempts = 3; showOptions = false; browser = false
            agentStrategy = .single; delegate = false; councilEnabled = false; councilMembers = 2
            reviewerPanelText = ""; protectedApprovalsText = ""
            composerModels = [:]; poolModelCatalogs = [:]  // route-scoped (W20)
        }
        // D26: a write-scope switch is STICKY — PATCH the thread (or the draft
        // value) so it persists. Guarded so re-seeding on thread switch, and
        // picking the value that already equals the trust default (nil sticky),
        // never fire a redundant PATCH.
        .onChange(of: access) { _, picked in
            let stickyOrDefault = model.effectiveThreadAccess ?? model.composerAccessDefault.wire
            guard picked.wire != stickyOrDefault else { return }
            Task { await model.setThreadAccess(picked.wire) }
        }
        // The no-project gate also fires when the project changes under a draft
        // (clearing it from Settings, etc.) — fall back to read-only Ask.
        .onChange(of: threadHasProject) { _, has in
            if !has { composerMode = .ask; showOptions = false }
        }
        // An armed Browser cannot ride a read-only intent: the toggle hides in
        // ⋯ for read-only modes, so disarm here — never send browser:true on Ask.
        .onChange(of: composerMode) { _, mode in
            if mode.isReadOnly { browser = false }
        }
        // Models are harness-scoped now: a primary switch keeps each
        // harness's own selection valid. Prune entries for harnesses NO LONGER
        // in the presented pool — keyed on the effective INCLUDED set (QA-011),
        // NOT the raw Auto sentinel: switching an explicit subset back to Auto
        // then preserves overrides for still-included Auto families instead of
        // wiping every selection, while a genuinely excluded/unavailable
        // harness's stale override is dropped (never silently reactivated).
        .onChange(of: effectiveIncludedFamilies) { _, families in
            let ids = Set(families.map(\.rawValue))
            composerModels = composerModels.filter { ids.contains($0.key) }
        }
    }

    private var composer: some View {
        GlassEffectContainer(spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                composerControlsRow
                composerHint
                composerAccessHint
                composerGrantCTA
                if !composerAttachments.isEmpty { attachmentChips }
                HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                    attachButton
                    captureButton
                    let inputCopy = ComposerInputCopy(hasSelectedThread: model.selectedThreadId != nil)
                    GlassField(text: $composerText,
                               placeholder: inputCopy.placeholder,
                               accessibilityName: inputCopy.accessibilityName,
                               accessibilityHintText: inputCopy.accessibilityHint,
                               onSubmit: send)
                    // While the head turn is still running, a new turn can't start over a
                    // live one (the native session is busy) — swap Send→Stop so the only
                    // action is to cancel the active run, not queue a doomed second turn.
                    if model.selectedThreadStarting {
                        // 202-QUEUED bind window: busy, but no runId yet => no cancel
                        // target. Show a disabled "Starting…" so a second turn can't be
                        // sent over the not-yet-started first; it flips to Stop once the
                        // runId binds.
                        Button("Starting…", action: {})
                            .buttonStyle(AccentButtonStyle())
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(true)
                            .help("The turn is starting — Stop becomes available once it binds")
                    } else if model.selectedThreadBusy {
                        Button(stopping ? "Stopping…" : "Stop", action: stop)
                            .buttonStyle(AccentButtonStyle())
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(stopping)
                            .help("Cancel the running turn (server-owned)")
                    } else {
                        Button("Send", action: send)
                            .buttonStyle(AccentButtonStyle())
                            .keyboardShortcut(.return, modifiers: .command)
                            // Blocked on empty text OR invalid option fields — never send a
                            // turn whose typed controls would be silently dropped.
                            .disabled(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || composerSendInvalid)
                            .help(composerBlockHelp)
                    }
                }
            }
            .padding(Theme.Spacing.md)
            .composerGlass()
            .conversationMeasure()   // F10: composer shares the feed's readable column
            .padding(Theme.Spacing.md)
        }
    }

    /// The composer's project-folder name shown on the chip: an open thread shows
    /// its bound repo; a draft shows the Current Project (or a "Choose project" CTA).
    private var projectChipName: String {
        if model.selectedThreadId != nil, let t = model.currentThread {
            return t.repoRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No project"
        }
        return model.normalizedProjectRoot.isEmpty
            ? "Choose project"
            : URL(fileURLWithPath: model.normalizedProjectRoot).lastPathComponent
    }

    /// Inline guidance on the controls row: the no-project gate (only Ask works
    /// without a project) or, in the draft state, where the new thread lands.
    @ViewBuilder private var composerHint: some View {
        if capUsdInvalid {
            // Highest priority: a bad budget cap blocks Send — say so even with the
            // "⋯" popover closed, so the disabled Send isn't a mystery.
            Label("Budget cap must be a positive number (in ⋯)", systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange).lineLimit(1)
        } else if !threadHasProject {
            Text("Pick a project to use Agent · Plan · Best-of")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                .help("Without a project, only Ask (read-only) is available")
        } else if model.selectedThreadId == nil {
            Text("New thread on \(URL(fileURLWithPath: model.normalizedProjectRoot).lastPathComponent)")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    /// The composer is ALWAYS live: with no thread selected, the first message
    /// materializes one (on the Current Project). No silent no-op (the v0.9 bug).
    /// The text is cleared only after a successful send, restored on failure.
    private func send() {
        // While the head turn is still running, ⌘↩ / Return submits through
        // GlassField.onSubmit must not queue a second turn over a live one — route
        // the keystroke to Stop instead (mirrors the swapped button).
        if model.selectedThreadBusy { stop(); return }
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // Guard options HERE too, not only on the Send button: ⌘↩ / Return submit
        // through GlassField.onSubmit calls send() directly, bypassing the disabled
        // button. Never send a turn whose typed controls would be silently dropped.
        guard !composerSendInvalid else {
            if composerImageAttachmentsInvalid {
                model.threadStatus = "Images need an available vision-capable route."
            }
            return
        }
        // Resolve the composer's intent + strategy knobs (D24/D31/D32) into the
        // effective wire mode + delegate/council/until-clean facts.
        let resolution = resolveComposerStrategy(
            intent: composerMode, agentStrategy: agentStrategy, delegate: delegate,
            councilEnabled: councilEnabled, councilMembers: councilMembers)
        let mode = resolution.mode
        var options = currentOptions
        options.untilClean = resolution.untilClean
        options.delegate = resolution.delegate
        options.council = resolution.council
        options.councilN = resolution.councilN
        let chosenModel = primaryFamily.flatMap { composerModels[$0.rawValue] } ?? ""
        let atts = composerAttachments
        composerText = ""
        composerAttachments = []
        Task {
            let sent = await model.composerSend(prompt: text, mode: mode, model: chosenModel, attachments: atts, options: options)
            // Restore ONLY if the engine rejected it AND the user hasn't started
            // typing the next message in the meantime — never clobber in-flight text.
            if !sent && composerText.isEmpty { composerText = text; composerAttachments = atts }
        }
    }

    /// Cancel the selected thread's active head run (server-owned cancel via
    /// /runs/:id/control). Fires whenever the composer is in the cancellable
    /// `.busy` state — including the bound-but-not-yet-hydrated window, where the
    /// runId (`selectedHeadRunId`) is a valid cancel target even before the live
    /// `TaskRun` row merges. No-op while `.starting` (no runId) or `.idle`.
    private func stop() {
        // Fire whenever the composer is SHOWING Stop (busy and not the no-target
        // "Starting…" state) and a cancel target exists — including the detail-load
        // window, where busy/headRunId come from the thread-summary head run.
        guard !stopping, model.selectedThreadBusy, !model.selectedThreadStarting,
              let runId = model.selectedHeadRunId else { return }
        stopping = true
        Task {
            // defer: the button must re-enable on EVERY exit (incl. task
            // cancellation mid-await), never park as "Stopping...".
            defer { stopping = false }
            await model.cancel(runId)
        }
    }
}

