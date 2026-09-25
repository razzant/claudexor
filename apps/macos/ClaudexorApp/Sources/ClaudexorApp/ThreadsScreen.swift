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
    @State var composerText = ""
    /// Files/images staged for upload before the next turn. Images are gated by
    /// each selected harness's finite attachment-input declaration.
    @State var composerAttachments: [PendingAttachment] = []
    @State var composerAttachmentStagingMessage: String?
    @State var composerAttachmentOperations = ComposerAttachmentOperationCoordinator()
    @State var composerMode: RunMode = .agent
    // "⋯" per-turn options (collapsed by default).
    @State var showOptions = false
    @State var capUsdText = ""
    @State var threadAccessSelection: ComposerThreadAccessSelection = .active(.workspaceWrite)
    @State var selectedWebPolicy = "auto"
    /// Per-turn auth route REQUEST (W18): auto | subscription | api_key. Not sticky.
    @State var authRoutePreference = ""  // "" = Thread default; see authRouteRequest (sol #1)
    /// Per-turn reasoning effort ("" = harness default). Not sticky.
    @State var effortPreference = ""
    @State var maxAttempts = TurnOptions.singleDefaultAttempts
    /// Agent STRATEGY knob (D24): Single / Best-of / Until-clean / Create. Was a
    /// set of distinct intents; now a per-turn knob inside Agent. Not sticky.
    @State var agentStrategy: AgentStrategy = .single
    /// Agent delegation belt (D32): inject the Claudexor MCP belt so the harness
    /// can spawn bounded isolated sub-runs. Agent-only, default OFF. Not sticky.
    @State var delegate = false
    /// Plan strategy (D31): Council draft-and-merge across N harnesses. Plan-only.
    @State var councilEnabled = false
    @State var councilMembers = 2
    /// Arm the agent-driven browser (Playwright MCP) for this turn. Access stays
    /// independent; the daemon applies the selected harness's native MCP preflight.
    /// Not sticky across threads.
    @State var browser = false
    /// Parent-owned complete Advanced draft. Incomplete rows remain visible to
    /// Send validity and survive popover dismissal; only valid rows serialize.
    @State var reviewDraft = ComposerReviewDraft()
    @State var reviewChanges = false
    /// QA-010: optional Create-turn deterministic test command (argv text). Shown
    /// only for the Create agent strategy; parsed into the run's typed `tests`
    /// gate. Not sticky across threads.
    @State var testCommandText = ""
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
    @State var stopping = false
    /// One generation-fenced owner for async sends and the exact thread created
    /// by first-turn materialization. Explicit switches invalidate completions.
    @State var composerSubmissions = ComposerSubmissionCoordinator()
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

    var runControlApplicability: ComposerRunControlApplicability {
        .resolve(mode: composerMode)
    }
    /// Per-turn options the "⋯" panel collects, mapped onto engine run-start fields.
    var currentOptions: TurnOptions {
        let browserRequest = browserPolicy.requestProjection
        return TurnOptions(
            maxUsd: ComposerOptionParser.parseNonnegativeFiniteDouble(capUsdText),
            access: browserRequest.access,
            web: browserRequest.web,
            // untilClean / delegate / council are overlaid in send() from the
            // resolved Agent/Plan strategy (resolveComposerStrategy). Delegate
            // is additionally masked there by requestedForWire so a stale ON
            // value cannot cross a known-unavailable route.
            maxAttempts: maxAttempts,
            browser: browserRequest.browser,
            models: composerModels,
            review: reviewChanges,
            reviewerPanel: runControlApplicability.reviewers.applicable && !reviewerPanelEntries.isEmpty
                ? reviewerPanelEntries : nil,
            protectedPathApprovals:
                runControlApplicability.protectedPathApprovals.applicable && !protectedPathApprovals.isEmpty
                ? protectedPathApprovals : nil,
            // QA-010: the typed test-command gate rides ONLY on a Create turn (the
            // one surface the field is offered on) — a stale command from a hidden
            // field never leaks onto a non-Create turn.
            tests: testCommandForCreate.map { [$0] } ?? [],
            authRoute: Self.authRouteRequest(authRoutePreference),
            effort: effortPreference.isEmpty ? nil : effortPreference
        )
    }

    /// The parsed Create-turn test command, or nil when the field is empty / not
    /// a Create turn. `send()` reads this so the gate is authorized only when the
    /// Create surface actually shows the field.
    var testCommandForCreate: TestCommandInvocation? {
        guard composerMode == .agent, agentStrategy == .create else { return nil }
        return (try? ComposerOptionParser.parseTestCommandStrict(testCommandText)) ?? nil  // strict: malformed never sends
    }

    /// The Create Test-command field's typed reason (nil = blank/valid); an unterminated quote is a SURFACED parse error, not a silent close (QA-010).
    var testCommandErrorMessage: String? {
        guard composerMode == .agent, agentStrategy == .create,
              !testCommandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        do { return try ComposerOptionParser.parseTestCommandStrict(testCommandText) == nil ? "Test command needs a program name (in ⋯)" : nil }
        catch { return (error as? ComposerOptionParser.CommandArgvError) == .danglingEscape ? "Test command ends with a dangling backslash (in ⋯)" : "Test command has an unterminated quote (in ⋯)" }
    }
    var testCommandInvalid: Bool { testCommandErrorMessage != nil }

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
    var reviewerPanelInvalid: Bool {
        guard runControlApplicability.reviewers.applicable else { return false }
        if reviewerPanelStructuredInvalid { return true }
        if reviewDraft.hasValidReviewerJSON { return false }
        let tokens = reviewerPanelTokens
        return reviewDraft.reviewerPickerIncomplete
            || (!tokens.isEmpty && tokens.count != reviewerPanelEntries.count)
    }
    var protectedApprovalsInvalid: Bool {
        guard runControlApplicability.protectedPathApprovals.applicable else { return false }
        let tokens = protectedApprovalTokens
        return reviewDraft.approvalRowsInvalid
            || (!tokens.isEmpty && tokens.count != protectedPathApprovals.count)
    }

    var composerAttachmentsInvalid: Bool {
        !composerAttachments.isEmpty && !composerAttachmentAdmission.canSend
    }

    var composerSendAvailability: ComposerSendAvailability {
        var blockers: [ComposerSendBlocker] = []
        if let migrationBlocker = threadAccessSelection.migrationBlocker {
            blockers.append(.access(migrationBlocker))
        }
        if capUsdInvalid {
            blockers.append(.budget("Fix the budget cap in More options to send"))
        }
        if reviewerPanelInvalid {
            blockers.append(.reviewer("Fix the reviewer panel in More options to send"))
        }
        if protectedApprovalsInvalid {
            blockers.append(.approvals("Fix protected path approvals in More options to send"))
        }
        if let message = testCommandErrorMessage {
            blockers.append(.testCommand(message))
        }
        if composerAttachmentsInvalid {
            blockers.append(.attachments(
                composerAttachmentAdmission.message
                    ?? "Change the harness pool or remove incompatible attachments"
            ))
        }
        if composerAttachmentOperations.inFlightCount > 0 {
            blockers.append(.attachments(
                "Wait for attachment preparation to finish or cancel it"
            ))
        }
        if let composerApplicabilityBlocker {
            blockers.append(.applicability(composerApplicabilityBlocker))
        }
        return .resolve(message: composerText, blockers: blockers)
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
                .frame(minWidth: ThreadWorkspaceLayout.conversationMinimumWidth(inspectorPresented: model.inspectorPresented), maxWidth: .infinity, maxHeight: .infinity)
                .padding(.leading, sidebarGap)
        }
        .task {
            await model.refreshThreads()
            await model.refreshTrust()
            for connection in model.remoteConnections where connection.enabled {
                await model.connectRemote(connection.id, allowInteraction: false)
            }
        }
        .task(id: model.runApplicabilityRefreshKey) {
            await model.refreshRunApplicability()
        }
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

            projectProblemsBanner

            if model.locatedThreads.isEmpty {
                ContentUnavailableView(
                    "No threads yet",
                    systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("Start a thread to work conversationally: plan, continue, race, review, apply — one conversation.")
                )
                .frame(maxHeight: .infinity)
            } else {
                List(model.locatedThreads, selection: Binding(
                    get: { model.selectedLocatedThreadID },
                    set: { locatedID in
                        guard let locatedID,
                              let located = model.locatedThreads.first(where: {
                                  $0.id == locatedID
                              })
                        else { return }
                        Task {
                            await model.openThread(
                                locationID: located.locationID,
                                id: located.thread.id)
                        }
                    }
                )) { located in
                    threadRow(located).tag(located.id)
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)   // let the Liquid Glass panel show through
            }

            SidebarFooter()
        }
        .padding(.top, Theme.Spacing.xs)
        .sheet(isPresented: Binding(
            get: { renameTargetId != nil },
            set: {
                if !$0 {
                    renameTargetId = nil
                    renameTargetLocation = nil
                }
            }
        )) { renameSheet }
        .confirmationDialog(
            "Delete thread permanently?",
            isPresented: Binding(
                get: { deleteTargetId != nil },
                set: {
                    if !$0 {
                        deleteTargetId = nil
                        deleteTargetLocation = nil
                    }
                }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Permanently", role: .destructive) { confirmPermanentDelete() }
            Button("Cancel", role: .cancel) {
                deleteTargetId = nil
                deleteTargetLocation = nil
            }
        } message: {
            Text("This removes the conversation and its thread workspace. This action cannot be undone.")
        }
    }

    @State var renameDraft = ""
    @State var renameTargetId: String?
    @State var renameTargetLocation: ExecutionLocationID?
    @State var deleteTargetId: String?
    @State var deleteTargetLocation: ExecutionLocationID?
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
                                TurnCard(
                                    turn: turn,
                                    target: model.turnStartTarget(
                                        locationID: model.selectedExecutionLocation,
                                        thread: detail.thread),
                                    routingOptions: resolvedComposerOptions.routingOverridesOnly)
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
                        remoteConnections: model.remoteConnections,
                        onPick: { model.pickProject($0) },
                        onBrowse: { model.browseProject() },
                        onPickRemote: {
                            model.selectRemoteProject(connectionID: $0, path: $1)
                        },
                        onBrowseRemote: {
                            model.showRemoteDirectoryBrowser(connectionID: $0)
                        },
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
                AccessChip(
                    access: threadAccessSelection.activeAccess,
                    browserArmed: effectiveBrowserArmed,
                    writeDisabled: composerMode.isReadOnly && threadAccessSelection.activeAccess != nil,
                    onPick: selectComposerAccess
                )
            }
            // The "⋯" options button is ALWAYS available — a no-project Ask is
            // still entitled to a per-turn model / web / budget. `composerOptions`
            // itself hides the project-only controls (Context, Workspace, repair).
            Button {
                showOptions.toggle()
            } label: {
                Label("More options", systemImage: "slider.horizontal.3")
                    .labelStyle(.iconOnly)
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
            // QA-003: name the icon-only options control (else the AX name is the
            // localized `slider.horizontal.3` description, `Изменить`). `.help`
            // stays the separate hint enumerating what the popover holds.
            .productControlAccessibility("More options")
            .help("More options: harness pool, model, budget, access, web, repair strategies")
            // Native dismissible popover — no inline glass-on-glass panel.
            .popover(isPresented: $showOptions, arrowEdge: .bottom) {
                composerOptions
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            if !threadHasProject { composerMode = .ask }
            reconcileComposerAccess(model.effectiveThreadAccess)
        }
        .onChange(of: composerSelectionContext) { oldContext, newContext in
            let selectionTransition = composerSubmissions.classifySelection(
                from: oldContext, to: newContext
            )
            if selectionTransition != .explicitSelection {
                return
            }
            composerAttachmentOperations.invalidateSelection()
            composerAttachments = ComposerAttachmentSelectionPolicy.retained(
                composerAttachments, after: selectionTransition
            )
            composerAttachmentStagingMessage = nil
            // QA-007: a FRESH draft seeds intent from the project default — Agent
            // for a project, Ask for none — so a stale Ask/Plan from the previous
            // thread never leaks onto a new project draft. Selecting an EXISTING
            // thread keeps the current intent (only clamping no-project to Ask).
            if model.selectedThreadId == nil {
                composerMode = threadHasProject ? .agent : .ask
            } else if !threadHasProject {
                composerMode = .ask
            }
            resetPerTurnComposerOptions()
        }
        // Server-confirmed thread access is the producer. In particular, a
        // migration-required historical wire remains distinct until its explicit
        // PATCH returns the new active value.
        .onChange(of: model.effectiveThreadAccess) { _, recordedWire in
            reconcileComposerAccess(recordedWire)
        }
        // The no-project gate also fires when the project changes under a draft
        // (clearing it from Settings, etc.) — fall back to read-only Ask.
        .onChange(of: threadHasProject) { _, has in
            if !has { composerMode = .ask; showOptions = false }
        }
        // An armed Browser cannot ride a read-only intent: the toggle hides in
        // ⋯ for read-only modes, so disarm here — never send browser:true on Ask.
        .onChange(of: composerMode) { _, mode in
            browser = ComposerBrowserPolicy.browserArmed(browser, afterSelecting: mode)
        }
        // A pool/readiness change can remove the last browser-capable lane while
        // the popover is closed. Effective policy above fails closed immediately;
        // this also reconciles the stored toggle so reopening shows honest state.
        .onChange(of: browserAvailableForCurrentTurn) { _, available in
            browser = ComposerBrowserPolicy.browserArmed(
                browser, afterAvailability: available
            )
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
                composerNestingHint
                composerAccessHint
                composerGrantCTA
                if !composerAttachments.isEmpty { attachmentChips }
                composerAttachmentNotice
                composerSendReason
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
                            .productControlAccessibility("Starting")
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(true)
                            .help("The turn is starting — Stop becomes available once it binds")
                    } else if model.selectedThreadBusy {
                        Button(stopping ? "Stopping…" : "Stop", action: stop)
                            .buttonStyle(AccentButtonStyle())
                            .productControlAccessibility(stopping ? "Stopping" : "Stop")
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(stopping)
                            .help("Cancel the running turn (server-owned)")
                    } else {
                        let availability = composerSendAvailability
                        Button("Send", action: send)
                            .buttonStyle(AccentButtonStyle())
                            .productControlAccessibility(
                                availability.name,
                                value: availability.enabled ? "Available" : "Unavailable"
                            )
                            .accessibilityHint(availability.help)
                            .keyboardShortcut(.return, modifiers: .command)
                            // Blocked on empty text OR invalid option fields — never send a
                            // turn whose typed controls would be silently dropped.
                            .disabled(!availability.enabled)
                            .help(availability.help)
                    }
                }
            }
            .padding(Theme.Spacing.md)
            .composerGlass()
            .conversationMeasure()   // F10: composer shares the feed's readable column
            .padding(Theme.Spacing.md)
        }
    }

}
