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
    @State var authRoutePreference = "auto"
    @State var untilClean = false
    @State var maxAttempts = 3
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
    private var threadHasProject: Bool {
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
    /// Per-turn options the "⋯" panel collects, mapped onto engine run-start fields.
    private var currentOptions: TurnOptions {
        TurnOptions(
            maxUsd: ComposerOptionParser.parseNonnegativeFiniteDouble(capUsdText),
            access: access == .workspaceWrite ? nil : access.wire,  // workspace_write is the engine default
            web: webPolicy == "auto" ? nil : webPolicy,
            untilClean: untilClean,
            maxAttempts: maxAttempts == 3 ? nil : maxAttempts,
            // Preserve the user's request even if the cached capability view
            // changed after the toggle was armed. The engine owns the typed
            // per-lane resolution/refusal; silently clearing it here would erase
            // requested/effective evidence.
            browser: browser,
            models: composerModels,
            reviewerPanel: reviewerPanelEntries.isEmpty ? nil : reviewerPanelEntries,
            protectedPathApprovals: protectedPathApprovals.isEmpty ? nil : protectedPathApprovals,
            authRoute: authRoutePreference == "auto" ? nil : authRoutePreference
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
    private let sidebarInset: CGFloat = Theme.Metrics.floatingSidebarInset
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

            QuotaFooterView()
        }
        .padding(.top, Theme.Spacing.xs)
        .sheet(isPresented: Binding(
            get: { renameTargetId != nil },
            set: { if !$0 { renameTargetId = nil } }
        )) { renameSheet }
    }

    @State private var renameDraft = ""
    @State private var renameTargetId: String?

    private var renameSheet: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Rename thread").font(.headline)
            TextField("Thread title", text: $renameDraft)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submitRename() }
            HStack {
                Spacer()
                Button("Cancel") { renameTargetId = nil }
                Button("Rename") { submitRename() }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: 360)
    }

    private func submitRename() {
        guard let id = renameTargetId else { return }
        let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        renameTargetId = nil
        Task { await model.renameThread(id, title: title) }
    }

    private func threadRow(_ thread: ThreadSummary) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(thread.title ?? "Untitled thread").font(.body).lineLimit(1)
                if thread.needsHuman {
                    Image(systemName: "person.fill.questionmark")
                        .foregroundStyle(Theme.status(.blocked))
                        .help("This thread is blocked on your decision")
                }
            }
            Text(threadSubtitle(thread)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        // rename/archive ride the existing PATCH /threads/:id (server-owned
        // title/state); the row finally exposes the affordance.
        .contextMenu {
            Button("Rename…") {
                renameDraft = thread.title ?? ""
                renameTargetId = thread.id
            }
            // ThreadState is active|closed (server enum) — "closed" is the
            // archived state; Reopen PATCHes back to "active".
            if thread.state != "closed" {
                Button("Archive") { Task { await model.archiveThread(thread.id) } }
            } else {
                Button("Reopen") { Task { await model.reopenThread(thread.id) } }
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    private func threadSubtitle(_ thread: ThreadSummary) -> String {
        let project = thread.repoRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No project"
        return "\(project) · \(thread.runIds.count) turn\(thread.runIds.count == 1 ? "" : "s")"
    }

    // MARK: Conversation pane

    private var conversation: some View {
        VStack(spacing: 0) {
            if let detail = model.selectedThreadDetail {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                            ForEach(detail.turns) { turn in
                                TurnCard(turn: turn)
                                    .id(turn.id)
                            }
                            if !detail.sessions.isEmpty {
                                sessionsFooter(detail.sessions)
                            }
                        }
                        .padding(Theme.Spacing.lg)
                    }
                    .onChange(of: detail.turns.count) {
                        if let last = detail.turns.last { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            } else {
                emptyConversation
            }

            if let status = model.threadStatus {
                Text(status)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.xs)
            }

            // SPEC-FLOW: the interview / frozen-spec card sits just above the
            // composer (same placement as the pending-interaction answer surface),
            // so the parked-on-user question is always visible.
            specFlowSection

            // Isolated threads accumulate in a worktree; deliver the diff to the
            // project on demand. In-place threads write the live tree directly and
            // never need this bar.
            if let t = model.currentThread, t.workspaceMode == "isolated", !t.runIds.isEmpty {
                ApplyThreadBar(threadId: t.id)
            }

            composer
        }
    }

    private var emptyConversation: some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(.secondary)
            Text("Start a thread")
                .font(.title2.weight(.bold))
                .foregroundStyle(.primary)
            Text("Type below to begin. Turns run in-place so the next turn sees the work — plan, then implement, in one conversation.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 440)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The SPEC-FLOW card(s) for the current thread: the question interview while
    /// asking, a working spinner while freezing, and a "Spec frozen" card with an
    /// Implement button once frozen. Driven entirely off `model.specFlow`.
    @ViewBuilder private var specFlowSection: some View {
        // `specFlow` is non-nil only for the selected thread, so `tid` is the OWNING
        // thread — captured here and passed into the cards so their actions bind to
        // it (not to whatever is selected when the async submit/implement resolves).
        if let tid = model.selectedThreadId, let flow = model.specFlow {
        switch flow {
        case .askingQuestions(_, let questions, let planDir, let planRunId, let answers, let error):
            // Seed the card from `answers` so an unresolved-clarifications 400
            // re-opens with the user's prior picks intact (they fix only the missing
            // fields, never re-answer everything). `id:` keys the @State to the
            // current answer set so a re-derived card re-seeds instead of reusing
            // stale @State from the previous render.
            SpecQuestionCard(threadId: tid, questions: questions, planDir: planDir, planRunId: planRunId,
                             initialAnswers: answers, errorMessage: error)
                .id(SpecQuestionCard.seedIdentity(answers))
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.sm)
        case .grounding:
            // Pre-questions: the grounding plan is reading the repo to derive the
            // interview. Nothing is frozen yet — don't claim it is.
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView().controlSize(.small)
                Text("Running the grounding plan…")
                    .font(.callout).foregroundStyle(.secondary)
                    .help("Reading the project to prepare the spec interview — this can take a few minutes.")
                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        case .freezing:
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView().controlSize(.small)
                Text("Freezing the spec…")
                    .font(.callout).foregroundStyle(.secondary)
                    .help("Assembling and freezing the SpecPack from your answers — this can take a few minutes.")
                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        case .frozen(let specId, let specPath, let specHash, let changes):
            SpecFrozenCard(threadId: tid, specId: specId, specPath: specPath, specHash: specHash, changes: changes)
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.sm)
        case .error(let message):
            HStack(spacing: Theme.Spacing.sm) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout).foregroundStyle(.orange)
                    .textSelection(.enabled)
                Spacer()
                Button("Dismiss") { model.cancelSpec(threadId: tid) }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.sm)
        }
        }
    }

    /// The conversation's window title/subtitle — the thread title lives in the
    /// ONE system toolbar (no second custom header strip). Empty in the draft state.
    var navTitle: String { model.currentThread?.title ?? "Claudexor" }
    var navSubtitle: String {
        guard let t = model.currentThread else { return "" }
        return threadSubtitle(t) + " · " + (t.workspaceMode == "isolated" ? "isolated" : "in-place")
    }

    private func sessionsFooter(_ sessions: [ThreadSessionInfo]) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "link").foregroundStyle(.secondary)
            ForEach(sessions) { session in
                Text("\(session.harnessId)\(session.nativeSessionId != nil ? " · live session" : "")")
                    .font(.caption)
                    .padding(.horizontal, Theme.Spacing.sm)
                    .padding(.vertical, Theme.Spacing.xxs)
                    .background(Capsule().fill(.quaternary))
                    .help(session.nativeSessionId.map { "Native session \($0) resumes on the next turn" } ?? "No native session yet")
            }
            Spacer()
        }
    }

    /// The persistent composer — ONE floating Liquid-Glass panel (pointer-driven
    /// lensing; solid fallback under Reduce Transparency). Its contents stay SOLID
    /// (no glass-on-glass): a controls row (intent + primary + "⋯"), a Messages-style
    /// field on a solid inset, a prominent Send, and an inline advanced panel that
    /// morphs in via the GlassEffectContainer. Chat is the NORMAL loop.
    private var composer: some View {
        GlassEffectContainer(spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.sm) {
                    IntentMenu(selection: $composerMode, projectScoped: threadHasProject)
                    ProjectChip(name: projectChipName,
                                bound: model.selectedThreadId != nil,
                                hasProject: threadHasProject,
                                recent: model.recentProjects,
                                onPick: { model.pickProject($0) },
                                onBrowse: { model.browseProject() })
                    if threadHasProject {
                        PrimaryHarnessChip(current: primaryFamily, pool: resolvedPoolFamilies) { picked in
                            Task { await model.setPrimaryHarness(picked?.rawValue) }
                        }
                        // W19: the per-turn write scope is a first-class chip
                        // (moved out of "⋯"); " · Browser" appends while armed.
                        AccessChip(access: $access, browserArmed: browser,
                                   writeDisabled: composerMode.isReadOnly && composerMode != .spec)
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
                    .popover(isPresented: $showOptions, arrowEdge: .bottom) { composerOptions }
                    Spacer(minLength: Theme.Spacing.sm)
                    composerHint
                }
                .onAppear { if !threadHasProject { composerMode = .ask } }
                .onChange(of: model.selectedThreadId) {
                    if !threadHasProject { composerMode = .ask }
                    // Per-turn knobs are not sticky — don't carry one thread's budget
                    // cap / access / web / repair flags / model into the next thread.
                    capUsdText = ""; access = .workspaceWrite; webPolicy = "auto"; authRoutePreference = "auto"
                    untilClean = false; maxAttempts = 3; showOptions = false; browser = false
                    reviewerPanelText = ""; protectedApprovalsText = ""
                    composerModels = [:]; poolModelCatalogs = [:]  // route-scoped (W20)
                }
                // The no-project gate also fires when the project changes under a draft
                // (clearing it from Settings, etc.) — fall back to read-only Ask.
                .onChange(of: threadHasProject) { _, has in
                    if !has { composerMode = .ask; showOptions = false }
                }
                // An armed Browser cannot ride a read-only intent (Spec keeps it
                // for its Implement turn): the toggle hides in ⋯ for read-only
                // modes, so disarm here — never send browser:true on an Ask.
                .onChange(of: composerMode) { _, mode in
                    if mode.isReadOnly && mode != .spec { browser = false }
                }
                // Models are harness-scoped now: a primary switch keeps each
                // harness's own selection valid. Only prune entries for harnesses
                // that LEFT the pool, so a dropped chip can't smuggle a model in.
                .onChange(of: resolvedPoolFamilies) { _, families in
                    let ids = Set(families.map(\.rawValue))
                    composerModels = composerModels.filter { ids.contains($0.key) }
                }

                composerGrantCTA
                if !composerAttachments.isEmpty { attachmentChips }
                HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                    attachButton
                    captureButton
                    GlassField(text: $composerText,
                               placeholder: "Message…  (⌘↩ to send · the first message starts a thread)",
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
        let mode = composerMode
        let options = currentOptions
        let chosenModel = primaryFamily.flatMap { composerModels[$0.rawValue] } ?? ""
        let atts = composerAttachments
        composerText = ""
        composerAttachments = []
        // Spec is NOT a normal turn: it drives a durable server-owned session
        // (create → answers → freeze). The flow renders
        // its own cards above the composer once accepted. But startSpec can fail HARD
        // before any durable card exists (engine offline / no project / transport
        // error) — restore the prompt in that case, mirroring composerSend below
        // (and only when the user hasn't typed a replacement in the meantime).
        if mode == .spec {
            // Spec drives the server-owned interview — there is no turn to carry
            // attachment bytes, so they'd be silently dropped here. Be honest:
            // restore the staged chips + prompt and surface a visible status
            // instead of pretending the attachment went along for the ride.
            if !atts.isEmpty {
                composerAttachments = atts
                composerText = text
                model.threadStatus = "Spec interview can't take attachments — remove them or switch out of Spec mode."
                return
            }
            Task {
                // Carry the per-turn model + options so the eventual Implement turn
                // honors the visible composer controls (not silently dropped).
                let accepted = await model.startSpec(prompt: text, model: chosenModel, options: options)
                if !accepted && composerText.isEmpty { composerText = text }
            }
            return
        }
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

