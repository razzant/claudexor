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
    @Environment(AppModel.self) private var model
    @State private var composerText = ""
    /// Files/images attached to the next turn (base64-inline; the daemon resolves
    /// them to scoped paths). Gated by the primary harness's image_input.
    @State private var composerAttachments: [AttachmentInput] = []
    @State private var composerMode: RunMode = .agent
    // "⋯" per-turn options (collapsed by default).
    @State private var showOptions = false
    @State private var capUsdText = ""
    @State private var access: AccessProfile = .workspaceWrite
    @State private var webPolicy = "auto"
    @State private var untilClean = false
    @State private var maxAttempts = 3
    /// Arm the agent-driven browser (Playwright MCP) for this turn. Requires full
    /// access (codex's sandbox cancels navigation otherwise); turning it on forces
    /// access to full + is disclosed in the options panel. Not sticky across threads.
    @State private var browser = false
    @State private var reviewerPanelText = ""
    @State private var protectedApprovalsText = ""
    /// Per-turn model override for the primary harness. Empty = harness default
    /// (the global default stays in Settings → Harnesses). Not sticky across threads.
    @State private var composerModel = ""
    /// Enumerated models for the current primary harness (ADP4). nil until loaded;
    /// an empty / non-enumerable response falls back to a free-text field.
    @State private var primaryModels: HarnessModelsResponse?
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

    /// The harness families offered as a per-thread pool / primary (raw + fake are
    /// never user-routable in chat — they stay CLI-only, mirroring Settings).
    static let poolFamilies: [HarnessFamily] = [.codex, .claude, .cursor, .opencode]

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
    private var primaryFamily: HarnessFamily? {
        model.effectivePrimaryHarness.flatMap { HarnessFamily(rawValue: $0) }
    }
    /// The eligible pool (Race runs this); resolved from thread sticky > global.
    private var poolFamilies: [HarnessFamily] {
        model.effectiveEligiblePool.compactMap { HarnessFamily(rawValue: $0) }
    }
    /// Per-turn options the "⋯" panel collects, mapped onto engine run-start fields.
    private var currentOptions: TurnOptions {
        TurnOptions(
            maxUsd: Double(capUsdText.trimmingCharacters(in: .whitespaces)),
            access: access == .workspaceWrite ? nil : access.wire,  // workspace_write is the engine default
            web: webPolicy == "auto" ? nil : webPolicy,
            untilClean: untilClean,
            maxAttempts: maxAttempts == 3 ? nil : maxAttempts,
            browser: browser,
            reviewerPanel: reviewerPanelEntries.isEmpty ? nil : reviewerPanelEntries,
            protectedPathApprovals: protectedPathApprovals.isEmpty ? nil : protectedPathApprovals
        )
    }

    /// Any harness in the pool can take the agent-driven browser (manifest
    /// `browser_tool`). Gates the composer toggle so we never offer browsing where
    /// no adapter can inject Playwright MCP.
    private var anyHarnessAcceptsBrowser: Bool {
        model.harnesses.contains { $0.acceptsBrowser }
    }

    /// The per-turn budget field is INVALID when it's non-empty but not a positive
    /// number. A typo must NOT silently drop the user's cap (the typed-money contract)
    /// — Send is blocked while invalid, with an inline reason. Empty = no cap (valid).
    private var capUsdInvalid: Bool {
        let t = capUsdText.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return false }
        guard let v = Double(t) else { return true }
        return v <= 0
    }

    private var reviewerPanelTokens: [String] {
        splitOptionTokens(reviewerPanelText)
    }

    private var reviewerPanelEntries: [ReviewerPanelEntry] {
        reviewerPanelTokens.compactMap(parseReviewerPanelEntry)
    }

    private var reviewerPanelInvalid: Bool {
        let tokens = reviewerPanelTokens
        return !tokens.isEmpty && tokens.count != reviewerPanelEntries.count
    }

    private var protectedApprovalTokens: [String] {
        splitOptionTokens(protectedApprovalsText)
    }

    private var protectedPathApprovals: [ProtectedPathApproval] {
        protectedApprovalTokens.compactMap(parseProtectedPathApproval)
    }

    private var protectedApprovalsInvalid: Bool {
        let tokens = protectedApprovalTokens
        return !tokens.isEmpty && tokens.count != protectedPathApprovals.count
    }

    private var composerOptionsInvalid: Bool {
        capUsdInvalid || reviewerPanelInvalid || protectedApprovalsInvalid
    }

    private var composerBlockHelp: String {
        if capUsdInvalid { return "Fix the budget cap in ⋯ options to send" }
        if reviewerPanelInvalid { return "Fix the reviewer panel in ⋯ options to send" }
        if protectedApprovalsInvalid { return "Fix protected path approvals in ⋯ options to send" }
        return "Send (⌘↩)"
    }

    private func splitOptionTokens(_ text: String) -> [String] {
        text
            .split { $0 == "," || $0 == "\n" }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func parseReviewerPanelEntry(_ raw: String) -> ReviewerPanelEntry? {
        let efforts = ["low", "medium", "high", "xhigh", "max"]
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let eq = trimmed.firstIndex(of: "=")
        var effort: String?
        var harness = (eq == nil ? trimmed : String(trimmed[..<eq!]))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var rest = ""
        if let eq {
            rest = String(trimmed[trimmed.index(after: eq)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rest.isEmpty else { return nil }
        } else if let colon = harness.lastIndex(of: ":") {
            let suffix = String(harness[harness.index(after: colon)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard efforts.contains(suffix) else { return nil }
            effort = suffix
            harness = String(harness[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !harness.isEmpty else { return nil }

        var model = rest.isEmpty ? nil : rest
        if let currentModel = model, let colon = currentModel.lastIndex(of: ":") {
            let suffix = String(currentModel[currentModel.index(after: colon)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if efforts.contains(suffix) {
                effort = suffix
                let stripped = String(currentModel[..<colon])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !stripped.isEmpty else { return nil }
                model = stripped
            }
        }
        return ReviewerPanelEntry(harness: harness, model: model, effort: effort)
    }

    private func parseProtectedPathApproval(_ raw: String) -> ProtectedPathApproval? {
        let parts = raw
            .split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let path = parts.first, !path.isEmpty else { return nil }
        let reason = parts.count == 2 && !parts[1].isEmpty ? parts[1] : nil
        return ProtectedPathApproval(path: path, reason: reason)
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
        .task { await model.refreshThreads() }
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
            // No "New" button here — it lives in the toolbar (square.and.pencil); a
            // second one in the sidebar was a duplicate (В12). The header is just the
            // section title.
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
        }
        .padding(.top, Theme.Spacing.xs)
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
                        PrimaryHarnessChip(current: primaryFamily, pool: poolFamilies) { picked in
                            Task { await model.setPrimaryHarness(picked?.rawValue) }
                        }
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
                            // controls — not the one prominent filled button (В: it
                            // looked like the only clickable thing). No glass fill.
                            .foregroundStyle(showOptions ? Theme.accent : .secondary)
                            .padding(.horizontal, Theme.Spacing.xs)
                            .padding(.vertical, Theme.Controls.chipVPadding)
                            .background(showOptions ? Theme.accent.opacity(0.14) : .clear, in: Capsule())
                    }
                    .buttonStyle(.borderless)
                    .help("More options: harness pool, model, budget, access, web, repair strategies")
                    // Native dismissible popover (В5) — no inline glass-on-glass panel.
                    .popover(isPresented: $showOptions, arrowEdge: .bottom) { composerOptions }
                    Spacer(minLength: Theme.Spacing.sm)
                    composerHint
                }
                .onAppear { if !threadHasProject { composerMode = .ask } }
                .onChange(of: model.selectedThreadId) {
                    if !threadHasProject { composerMode = .ask }
                    // Per-turn knobs are not sticky — don't carry one thread's budget
                    // cap / access / web / repair flags / model into the next thread.
                    capUsdText = ""; access = .workspaceWrite; webPolicy = "auto"
                    untilClean = false; maxAttempts = 3; showOptions = false; browser = false
                    reviewerPanelText = ""; protectedApprovalsText = ""
                    composerModel = ""
                }
                // The no-project gate also fires when the project changes under a draft
                // (clearing it from Settings, etc.) — fall back to read-only Ask.
                .onChange(of: threadHasProject) { _, has in
                    if !has { composerMode = .ask; showOptions = false }
                }
                // A per-turn model is harness-specific: when the primary harness
                // changes, a model chosen for the OLD harness would route-fail on the
                // new one. Clear the selection AND the cached enumeration so the picker
                // can't briefly show the stale list or send a stale id.
                .onChange(of: primaryFamily) { _, _ in
                    composerModel = ""
                    primaryModels = nil
                }

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
                            .disabled(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || composerOptionsInvalid)
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
    /// without a project — В8) or, in the draft state, where the new thread lands.
    @ViewBuilder private var composerHint: some View {
        if capUsdInvalid {
            // Highest priority: a bad budget cap blocks Send — say so even with the
            // "⋯" popover closed, so the disabled Send isn't a mystery.
            Label("Budget cap must be a positive number (in ⋯)", systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange).lineLimit(1)
        } else if !threadHasProject {
            Text("Pick a project to use Agent · Plan · Race")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                .help("Without a project, only Ask (read-only) is available")
        } else if model.selectedThreadId == nil {
            Text("New thread on \(URL(fileURLWithPath: model.normalizedProjectRoot).lastPathComponent)")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    /// The advanced options popover ("⋯", В5): clean SOLID sections on the popover's
    /// own material — harness pool, per-turn budget/access/web, agent repair strategies.
    private var composerOptions: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            OptionSection(title: "Harness pool — Race runs these; the primary answers in chat") {
                FlowLayout(spacing: Theme.Spacing.sm) {
                    ForEach(Self.poolFamilies) { family in
                        let avail = model.availability(for: family, mode: composerMode)
                        FilterChip(label: family.label,
                                   systemImage: avail.available ? family.glyph : "\(family.glyph).slash",
                                   isActive: poolFamilies.contains(family), tint: family.color) {
                            togglePool(family)
                        }
                        .disabled(!avail.available)
                        .help(avail.available ? "In the eligible pool" : avail.reason)
                    }
                }
            }
            OptionRow(label: "Model") { modelControl }
            OptionRow(label: "Budget") {
                HStack(spacing: Theme.Spacing.xs) {
                    Text("$").foregroundStyle(.secondary)
                    TextField("default", text: $capUsdText)
                        .frame(maxWidth: 90)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                    if capUsdInvalid {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange).font(.caption)
                            .help("Must be a positive number, or empty for the default")
                    }
                }
                .help("Per-turn budget cap (USD). Empty = engine / thread default.")
            }
            OptionRow(label: "Access") {
                Picker("", selection: $access) {
                    ForEach(AccessProfile.allCases) { Label($0.label, systemImage: $0.glyph).tag($0) }
                }
                .labelsHidden()
                .fixedSize()
                // Spec is a read-only GROUNDING intent but collects options for its
                // eventual WRITE (Implement) turn — so access stays settable for it.
                .disabled(composerMode.isReadOnly && composerMode != .spec)
                .help(composerMode.isReadOnly && composerMode != .spec
                      ? "Read-only intents never write"
                      : "How much this turn may touch (Spec: applies to the Implement turn)")
            }
            OptionRow(label: "Web") {
                Picker("", selection: $webPolicy) {
                    Text("Auto").tag("auto"); Text("Off").tag("off")
                    Text("Cached").tag("cached"); Text("Live").tag("live")
                }
                .labelsHidden()
                .fixedSize()
                .help("External-context policy for this turn")
            }
            OptionSection(title: "Review controls") {
                OptionRow(label: "Reviewers") {
                    HStack(spacing: Theme.Spacing.xs) {
                        TextField("claude=opus:max", text: $reviewerPanelText)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            .help("Comma or newline entries: harness[=model[:effort]] or harness[:effort]")
                        if reviewerPanelInvalid {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange).font(.caption)
                                .help("Reviewer entries need harness[=model[:effort]] or harness[:effort], effort low|medium|high|xhigh|max")
                        }
                    }
                }
                OptionRow(label: "Approvals") {
                    HStack(spacing: Theme.Spacing.xs) {
                        TextField("test/**:test update", text: $protectedApprovalsText)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                            .help("Comma or newline entries: path[:reason]")
                        if protectedApprovalsInvalid {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange).font(.caption)
                                .help("Protected path approvals need a non-empty path")
                        }
                    }
                }
            }
            // Agent-driven browser (Playwright MCP). Offered only where a pooled
            // harness can inject it. Arming it forces Full access (codex's sandbox
            // cancels the navigation otherwise) and is disclosed below — never a
            // silent escalation.
            if anyHarnessAcceptsBrowser {
                OptionRow(label: "Browser") {
                    Toggle("", isOn: Binding(
                        get: { browser },
                        set: { on in
                            browser = on
                            if on { access = .elevated }
                            if on { webPolicy = webPolicy == "off" ? "auto" : webPolicy }
                        }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(Theme.accent)
                    .help("Let the agent drive a real browser (navigate / screenshot / read). Runs headed so you watch the real window live; navigation snapshots are recorded in the run.")
                }
                if browser {
                    Text("Agent browses in a real window · runs at Full access")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 2)
                }
            }
            // Context depth for PROJECT-SCOPED turns (RunScope.project picks deep|auto
            // off `projectContextMode`). The owner removed project SELECTION from
            // Settings but kept this preference — give it a reachable in-chat control.
            // Hidden when the turn has no project (then the scope is `.none`, no depth).
            if threadHasProject {
                OptionRow(label: "Context") {
                    Picker("", selection: Binding(
                        get: { model.projectContextMode },
                        set: { model.projectContextMode = $0 }
                    )) {
                        Text("Auto").tag("auto"); Text("Deep").tag("deep")
                    }
                    .labelsHidden()
                    .fixedSize()
                    .help("Auto = grounded as needed · Deep = always read the repo deeply (slower, more thorough)")
                }
            }
            // Workspace mode is FIXED at thread creation, so it's only editable while
            // drafting the first turn (no thread selected yet). Isolated keeps a thread
            // worktree; in_place (default) mutates the live tree so the next turn sees it.
            if model.selectedThreadId == nil {
                OptionSection(title: "Workspace") {
                    Toggle("Isolated workspace", isOn: Binding(
                        get: { model.draftIsolatedWorkspace },
                        set: { model.draftIsolatedWorkspace = $0 }
                    ))
                    .toggleStyle(.switch).tint(Theme.accent)
                    .help("Turns accumulate in a separate worktree; apply them to the project later with “Apply thread”. Off = in-place (the next turn sees prior edits).")
                }
            }
            // Repair strategies are single-candidate (the engine routes them to
            // convergence, NOT a race) — offer them for a plain Agent turn, and for
            // Spec (they carry through to its Implement agent turn).
            if composerMode == .agent || composerMode == .spec {
                OptionSection(title: "Repair strategies") {
                    HStack(spacing: Theme.Spacing.xl) {
                        Toggle("Until clean", isOn: $untilClean).toggleStyle(.switch).tint(Theme.accent)
                            .help("Keep repairing one candidate until gates/review pass")
                        // Mutually exclusive: "Until clean" has no fixed cap, so the
                        // Max-attempts stepper is disabled (and not sent) while it's on
                        // — the two repair strategies must never be combined ambiguously.
                        Stepper("Max attempts: \(maxAttempts)", value: $maxAttempts, in: 1...8)
                            .disabled(untilClean)
                            .help(untilClean ? "Disabled while Until clean is on (no fixed cap)" : "Hard cap on repair attempts")
                    }
                }
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(width: Theme.Layout.composerOptionsWidth, alignment: .leading)
        // Enumerate the chosen primary harness's models when the panel opens (and
        // re-enumerate when the primary changes). nil-keyed when Auto: a "free text"
        // fallback covers the no-known-primary case so the field always works.
        .task(id: primaryFamily) { await loadPrimaryModels() }
    }

    /// Per-turn model override for the primary harness. A Picker over enumerated
    /// model ids when the harness can honestly enumerate (mirrors HarnessDefaultsRow),
    /// else an HONEST free-text field. Empty = harness default (the key is dropped).
    /// The GLOBAL default still lives in Settings → Harnesses (this is per-turn only).
    ///
    /// In practice the chat-routable harnesses (codex/claude/cursor/opencode) report
    /// no enumerable models today, so this resolves to free text; the only adapter
    /// with a `models()` producer is raw-api, which is CLI-routable (not in the chat
    /// pool). The Picker path stays so any chat harness that gains enumeration lights
    /// it up automatically — the control is honest either way, never a false dropdown.
    @ViewBuilder private var modelControl: some View {
        if let models = primaryModels, models.canEnumerate {
            Picker("", selection: $composerModel) {
                Text("Harness default").tag("")
                // Preserve a typed/legacy id the enumeration doesn't list instead of
                // silently dropping it (same guard as the Settings model picker).
                if !composerModel.isEmpty, !models.models.contains(where: { $0.id == composerModel }) {
                    Text("\(composerModel) (custom)").tag(composerModel)
                }
                ForEach(models.models) { m in
                    Text(modelMenuLabel(m)).tag(m.id)
                }
            }
            .labelsHidden()
            .fixedSize()
            .help("Model for THIS turn's primary harness (source: \(models.source)). Default keeps the harness/global choice.")
        } else {
            TextField("harness default", text: $composerModel)
                .frame(maxWidth: 160)
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
                .help(primaryFamily == nil
                      ? "Pick a primary harness to choose its model, or type a model id for this turn. Empty = harness default."
                      : "Optional model for this turn. Empty = harness default.")
        }
    }

    private func modelMenuLabel(_ m: HarnessModel) -> String {
        let name = m.label.map { $0.isEmpty ? m.id : $0 } ?? m.id
        return name == m.id ? name : "\(name) (\(m.id))"
    }

    /// One-shot enumeration of the chosen primary harness's models (thin consumer of
    /// the control-api DTO). Auto/no-primary leaves it nil so the free-text field shows.
    private func loadPrimaryModels() async {
        guard let family = primaryFamily else { primaryModels = nil; return }
        let fetched = await model.harnessModels(for: family)
        // The primary harness may have changed during the await (the chip switched
        // or a thread switch re-resolved it). Don't assign models fetched for a now-
        // stale family — that would offer the wrong harness's models for this turn.
        guard primaryFamily == family else { return }
        primaryModels = fetched
    }

    private func togglePool(_ family: HarnessFamily) {
        var pool = model.effectiveEligiblePool
        if let idx = pool.firstIndex(of: family.rawValue) { pool.remove(at: idx) } else { pool.append(family.rawValue) }
        Task { await model.setEligiblePool(pool) }
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
        guard !composerOptionsInvalid else { return }
        let mode = composerMode
        let options = currentOptions
        let chosenModel = composerModel
        let atts = composerAttachments
        composerText = ""
        composerAttachments = []
        // Spec is NOT a normal turn: it drives the server-owned interview
        // (/spec/questions → answers → /spec/freeze) client-side. The flow renders
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

    // MARK: - Composer attachments (D)

    /// True when the chat primary harness declares it can take images — honest
    /// gating so we never offer attach to a harness that would silently ignore it.
    private var primaryAcceptsImages: Bool {
        if let primary = model.effectivePrimaryHarness,
           let info = model.harnesses.first(where: { $0.id == primary }) {
            return info.acceptsImages
        }
        // No resolved primary: the engine auto-pools and may route to ANY harness
        // in the effective eligible pool, so only offer attach when EVERY routable
        // harness can take images — otherwise the image would be silently dropped
        // on whichever non-vision harness the pool picks.
        let pool = model.effectiveEligiblePool
        let routable = pool.isEmpty ? model.harnesses : model.harnesses.filter { pool.contains($0.id) }
        guard !routable.isEmpty else { return false }
        return routable.allSatisfy { $0.acceptsImages }
    }

    /// Spec mode runs the server-owned interview, which has no turn to carry bytes —
    /// gate attach/capture off in Spec so we never let the user stage an attachment
    /// the send path would silently drop.
    private var attachmentsAllowed: Bool { primaryAcceptsImages && composerMode != .spec }

    private var attachButton: some View {
        Button { pickAttachments() } label: {
            Image(systemName: "paperclip")
                .imageScale(.medium)
                .foregroundStyle(attachmentsAllowed ? Color.secondary : Color.secondary.opacity(0.4))
                .padding(.horizontal, Theme.Spacing.xs)
                .padding(.vertical, Theme.Controls.chipVPadding)
        }
        .buttonStyle(.borderless)
        .disabled(!attachmentsAllowed)
        .help(attachButtonHelp)
    }

    private var attachButtonHelp: String {
        if composerMode == .spec { return "Spec interview can't take attachments" }
        return primaryAcceptsImages
            ? "Attach images for the primary harness"
            : "The primary harness can't take attachments — switch it in the composer"
    }

    private var attachmentChips: some View {
        HStack(spacing: Theme.Spacing.xs) {
            ForEach(composerAttachments) { att in
                HStack(spacing: 4) {
                    Image(systemName: att.kind == "image" ? "photo" : "doc")
                    Text(att.name).lineLimit(1).truncationMode(.middle)
                    Button { composerAttachments.removeAll { $0.id == att.id } } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .help("Remove attachment")
                }
                .font(.caption)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, 4)
                .background(Color.primary.opacity(0.08), in: Capsule())
            }
        }
    }

    /// Pick files via NSOpenPanel, read each into a base64 AttachmentInput. Bytes
    /// ride inline to the loopback control API; the daemon writes them to a scoped
    /// dir and the chosen harness gets them in its native shape.
    private func pickAttachments() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        // Only images can ride the harness path today — restrict the picker so the
        // UI never promises file support it can't honor, and defensively skip any
        // non-image that slips through.
        panel.allowedContentTypes = [.image]
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            guard let data = try? Data(contentsOf: url) else { continue }
            let mime = Self.mimeType(for: url)
            guard mime.hasPrefix("image/") else { continue }
            composerAttachments.append(AttachmentInput(
                kind: "image", mime: mime, name: url.lastPathComponent,
                data: data.base64EncodedString()))
        }
    }

    private static func mimeType(for url: URL) -> String {
        if let t = UTType(filenameExtension: url.pathExtension), let m = t.preferredMIMEType { return m }
        return "application/octet-stream"
    }

    private var captureButton: some View {
        Button { captureScreenshot() } label: {
            Image(systemName: "camera.viewfinder")
                .imageScale(.medium)
                .foregroundStyle(attachmentsAllowed ? Color.secondary : Color.secondary.opacity(0.4))
                .padding(.horizontal, Theme.Spacing.xs)
                .padding(.vertical, Theme.Controls.chipVPadding)
        }
        .buttonStyle(.borderless)
        .disabled(!attachmentsAllowed)
        .help(captureButtonHelp)
    }

    private var captureButtonHelp: String {
        if composerMode == .spec { return "Spec interview can't take attachments" }
        return primaryAcceptsImages
            ? "Capture a screen region to attach (you pick the area)"
            : "The primary harness can't take attachments — switch it in the composer"
    }

    /// Grab a screen region via the system `screencapture` (interactive crosshair),
    /// off the main thread so the UI doesn't freeze during selection. macOS gates
    /// this behind Screen Recording permission; a denied/cancelled grab yields no
    /// attachment (honest — never a blank/fake image).
    private func captureScreenshot() {
        Task { @MainActor in
            if let att = await Self.runScreencapture() {
                composerAttachments.append(att)
            }
        }
    }

    private static func runScreencapture() async -> AttachmentInput? {
        await withCheckedContinuation { (cont: CheckedContinuation<AttachmentInput?, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("claudexor-shot-\(UUID().uuidString).png")
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                proc.arguments = ["-i", "-x", tmp.path] // interactive region select, silent
                do { try proc.run(); proc.waitUntilExit() }
                catch { cont.resume(returning: nil); return }
                guard let data = try? Data(contentsOf: tmp), !data.isEmpty else {
                    cont.resume(returning: nil); return // cancelled or permission denied
                }
                try? FileManager.default.removeItem(at: tmp)
                cont.resume(returning: AttachmentInput(
                    kind: "image", mime: "image/png", name: "screenshot.png",
                    data: data.base64EncodedString()))
            }
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
            await model.cancel(runId)
            stopping = false
        }
    }
}

/// One turn of the conversation: the prompt, its run state, and run actions
/// (open detail / decide / apply) — review actions live on the turn, not in a
/// separate dead-end queue.
private struct TurnCard: View {
    @Environment(AppModel.self) private var model
    let turn: ThreadTurnInfo
    @State private var actionError: String?
    /// Set after a successful accept-risk decision so the apply affordance
    /// appears immediately; the SERVER gate still owns whether apply succeeds.
    @State private var riskAccepted = false
    /// Set after a successful apply so the apply buttons can't be clicked twice
    /// (the SERVER gate is still the source of truth; this is a local guard).
    @State private var applied = false
    /// Set after a successful revert so the affordance collapses immediately; the
    /// SERVER (work_product apply_state) is the source of truth on the next refresh.
    @State private var reverted = false
    /// True while a Revert request is in flight (the server owns the outcome).
    @State private var reverting = false
    /// The apply gate reason from the pre-flight check (why apply would be refused),
    /// shown up front so the user isn't surprised on press. nil => not checked / OK.
    @State private var applyBlockReason: String?
    /// nil => follow the run state (expanded while running, collapsed when done);
    /// a user toggle pins it.
    @State private var transcriptExpanded: Bool?
    /// True while an "Implement plan" turn is being sent, so the button shows a
    /// working state and can't be double-clicked (mirrors ApplyThreadBar.applying).
    @State private var implementingPlan = false

    private var run: TaskRun? { turn.runId.flatMap { model.task($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .top) {
                Image(systemName: "person.circle.fill").foregroundStyle(.secondary)
                Text(turn.prompt).font(.body).textSelection(.enabled)
                Spacer()
            }
            if let run {
                Divider()
                HStack(spacing: Theme.Spacing.sm) {
                    StatusPill(status: run.status)
                    Text(run.mode.label).font(.caption).foregroundStyle(.secondary)
                    if run.spendKnown {
                        Text(String(format: "$%.2f", run.spendUsd)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Open run") {
                        model.route = .task(run.id)
                    }
                    .buttonStyle(.link)
                    .help("Open this run in the inspector — diff, timeline, review")
                }
                // Live transcript: the harness's reasoning + tool calls as they
                // happen (folded from SSE), so the chat shows working progress —
                // not just a status pill and a final answer. Collapsible: expanded
                // while the run is live, folds away when it finishes (a user toggle pins it).
                if let runId = turn.runId, let blocks = model.transcripts[runId]?.blocks, !blocks.isEmpty {
                    let live = run.status.isActive
                    DisclosureGroup(isExpanded: Binding(
                        get: { transcriptExpanded ?? live },
                        set: { transcriptExpanded = $0 }
                    )) {
                        TranscriptView(blocks: blocks)
                    } label: {
                        Label(live ? "Working…" : "Transcript (\(blocks.count))", systemImage: "waveform")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                // Honest outcome (the v0.9 "is the game done?" fix): a plan turn
                // says "no files changed" and offers to implement it; a patch shows
                // its diffstat (and whether a race winner was auto-applied).
                if let result = turn.run?.result {
                    outcomeRow(result)
                    // Honest apply-state label: never a green "succeeded" next to an
                    // applied-but-review-blocked turn. Offers Revert while revertable.
                    applyStateRow(result, run: run)
                }
                // Server-derived: a persisted operator decision (from ANY surface,
                // surviving reloads) unblocks apply; `riskAccepted` only bridges
                // the moment between decide() and the refreshed run detail.
                let unblocked = run.operatorDecisionAction != nil || riskAccepted
                if (run.status == .blocked || run.status == .needsReview) && !unblocked {
                    decisionBar(run)
                }
                if applied {
                    Label("Applied to project", systemImage: "checkmark.seal.fill")
                        .font(.caption).foregroundStyle(Theme.status(.succeeded))
                } else if (run.status == .succeeded && !run.diff.isEmpty) || unblocked {
                    // Apply PRE-FLIGHT: dry-run the gate when the apply bar appears so
                    // a refusal reason is shown UP FRONT, not only on press.
                    if let reason = applyBlockReason {
                        Label(reason, systemImage: "hand.raised.fill")
                            .font(.caption).foregroundStyle(.orange)
                            .textSelection(.enabled)
                            .help("Apply would be refused for this reason (apply pre-flight).")
                    }
                    applyBar(run)
                        .task(id: run.id) { applyBlockReason = await model.applyCheck(runId: run.id) }
                }
                if let answer = run.answerText, !answer.isEmpty, run.status.isTerminal {
                    Text(answer)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(8)
                        .textSelection(.enabled)
                }
                // Inline failure card: a terminal-FAILED turn with nothing to show
                // (no answer, no transcript, no diff — e.g. an unauthed harness wrote
                // only failure.yaml) otherwise reads as idle next to a red status pill.
                // Make it honest in the chat: surface the reason + an Open-run link.
                if isSilentFailure(run) { failureCard(run) }
            } else if let state = turn.run?.state {
                Text(state).font(.caption).foregroundStyle(.secondary)
            }
            if let actionError {
                Text(actionError).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(Theme.Spacing.md)
        .cardSurface(hover: run != nil)
        .contentShape(Rectangle())
        // Click the card to open the run inspector (the "Open run" link does the
        // same). Buttons inside the card take the tap first (SwiftUI priority), so
        // decide/apply/Implement-plan are unaffected.
        .onTapGesture { if let run { model.route = .task(run.id) } }
    }

    /// A turn that finished in a genuinely FAILURE-shaped terminal state but
    /// produced no visible content (no answer, no transcript, no diff). Without
    /// this the card shows only a status pill — silently idle-looking.
    ///
    /// ALLOW-LIST (not an exclude-list): only real failures get the red card.
    /// Benign/neutral terminals are NOT failures and must keep their own status —
    /// `noOp` (legitimately nothing to do), `ungated`/`reviewNotRun` (delivery/
    /// review policy states), `cancelled` (user-stopped), `needsReview`/`blocked`
    /// (carry their own decision/apply affordances). Rendering any of those as a
    /// red "failed" card would be dishonest.
    private func isSilentFailure(_ run: TaskRun) -> Bool {
        let failureShaped: Set<RunStatus> = [.failed, .interrupted, .exhausted, .notConverged]
        guard failureShaped.contains(run.status) else { return false }
        let hasAnswer = !(run.answerText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasTranscript = !(turn.runId.flatMap { model.transcripts[$0]?.blocks } ?? []).isEmpty
        return !hasAnswer && !hasTranscript && run.diff.isEmpty
    }

    /// Inline error card for a silent terminal failure (item 5): the engine's honest
    /// reason (engineError ← RunFailure.safeMessage) + an Open-run link. Never silent.
    private func failureCard(_ run: TaskRun) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.status(.failed))
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(run.status.label).font(.caption.weight(.semibold)).foregroundStyle(Theme.status(.failed))
                Text(failureReason(run))
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Spacer()
            Button("Open run") { model.route = .task(run.id) }
                .buttonStyle(.link)
                .help("Open this run in the inspector — failure detail, timeline, logs")
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.status(.failed).opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
    }

    /// The engine's honest reason for a silent failure, or a neutral fallback when
    /// the failure record carried no message (still better than a bare status pill).
    private func failureReason(_ run: TaskRun) -> String {
        let reason = (run.engineError ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return reason.isEmpty
            ? "This turn ended without producing an answer, diff, or transcript."
            : reason
    }

    /// The honest terminal outcome of this turn (what it actually did).
    @ViewBuilder
    private func outcomeRow(_ result: RunResult) -> some View {
        switch result.kind {
        case "plan":
            HStack(spacing: Theme.Spacing.sm) {
                Label("Plan — no files changed", systemImage: "list.bullet.rectangle")
                    .font(.caption).foregroundStyle(.secondary)
                if result.blockers > 0 {
                    Label("\(result.blockers) blocker\(result.blockers == 1 ? "" : "s")", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(.orange)
                }
                Spacer()
                Button(implementingPlan ? "Implementing…" : "Implement plan") {
                    guard let runId = turn.runId else { return }
                    implementingPlan = true
                    Task {
                        // Bind to the plan turn's OWNING thread, not live selection.
                        await model.composerSend(prompt: "Implement this plan.", mode: .agent,
                                                 planRunId: runId, onThread: turn.threadId)
                        implementingPlan = false
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                // Can't start an Implement turn over a live head run (the composer's
                // busy gate also rejects it, but the button must reflect the invariant).
                .disabled(implementingPlan || model.selectedThreadBusy)
                .help("Run an agent turn that implements this plan")
            }
        case "patch":
            if let d = result.diffStat {
                Label("\(d.files) file\(d.files == 1 ? "" : "s") · +\(d.additions) −\(d.deletions)\(result.adopted == true ? " · applied" : "")",
                      systemImage: "plusminus")
                    .font(.caption).foregroundStyle(.secondary)
            }
        default:
            EmptyView()
        }
    }

    /// Honest application state of an in-place turn (decoupled from a clean terminal):
    /// `applied` is green, `applied_review_blocked` is an honest amber (NOT a green
    /// "succeeded"), `reverted` is neutral, `not_applied` shows nothing. While the
    /// mutation is still safely revertable, offers Revert (server-owned; refuses on
    /// tree divergence and the refusal is surfaced verbatim).
    @ViewBuilder
    private func applyStateRow(_ result: RunResult, run: TaskRun) -> some View {
        // Local revert wins immediately; otherwise read the honest server state.
        let state = reverted ? "reverted" : result.applyState
        if let (text, glyph, tint) = Self.applyStateBadge(state) {
            HStack(spacing: Theme.Spacing.sm) {
                Label(text, systemImage: glyph)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(tint)
                Spacer()
                // Offer Revert only while the server still says it's safe (tree
                // unchanged since) and we haven't already reverted this turn.
                if result.revertable && !reverted {
                    Button(reverting ? "Reverting…" : "Revert") {
                        guard let runId = turn.runId else { return }
                        reverting = true
                        Task {
                            let err = await model.revertRun(runId: runId)
                            reverting = false
                            if err == nil { reverted = true; actionError = nil }
                            else { actionError = err }
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(reverting)
                    .help("Restore the project to this turn's pre-turn state (server refuses if you've edited since)")
                }
            }
        }
    }

    /// Map the honest apply-state to a label/glyph/tint. nil => render nothing
    /// (not_applied / unknown — envelope-only, plan/answer, or nothing produced).
    private static func applyStateBadge(_ state: String) -> (String, String, Color)? {
        switch state {
        case "applied": return ("Applied", "checkmark.seal.fill", Theme.status(.succeeded))
        case "applied_review_blocked": return ("Applied · review blocked", "exclamationmark.triangle.fill", Theme.status(.blocked))
        case "reverted": return ("Reverted", "arrow.uturn.backward.circle", .secondary)
        default: return nil
        }
    }

    /// Review-queue actions ON the turn (the "apply: human_review" fix).
    private func decisionBar(_ run: TaskRun) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Button("Accept risk & unblock") {
                Task {
                    actionError = await model.decide(runId: run.id, action: "accept_risk", acceptedRisks: ["operator accepted via thread"])
                    if actionError == nil {
                        riskAccepted = true
                        // Pull the server-persisted decision so the affordance survives reloads.
                        await model.loadRunDetail(run.id)
                    }
                }
            }
            .help("Records an auditable operator decision bound to this exact patch, then allows apply")
            Button("Rerun with feedback…") {
                Task { actionError = await model.decide(runId: run.id, action: "rerun_with_feedback", feedback: "Address the blocking review findings.") }
            }
            .help("Enqueues a follow-up run seeded with reviewer feedback")
            Spacer()
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private func applyBar(_ run: TaskRun) -> some View {
        // The pre-flight reason gates EVERY apply mode, not just in-place: the server
        // runs applyGateError(...) before deliver(...) for all modes (daemon-server.ts
        // /runs/:id/apply), and deliver() also refuses a dirty worktree before the
        // branch/pr checkout (delivery index.ts). A "branch" apply the gate refuses
        // would be rejected with the identical error — so disable BOTH buttons rather
        // than offer a doomed action.
        let blocked = applyBlockReason != nil
        return HStack(spacing: Theme.Spacing.sm) {
            Button("Apply patch") {
                Task {
                    actionError = await model.applyRun(runId: run.id)
                    if actionError == nil { applied = true }   // hide buttons; no double-apply
                }
            }
            .disabled(blocked)
            .help(blocked ? (applyBlockReason ?? "Apply is currently refused")
                          : "Applies the reviewed patch to the original project (server-gated)")
            Button("Apply as branch") {
                Task {
                    actionError = await model.applyRun(runId: run.id, mode: "branch")
                    if actionError == nil { applied = true }
                }
            }
            .disabled(blocked)
            .help(blocked ? (applyBlockReason ?? "Apply is currently refused")
                          : "Applies onto a new branch")
            Spacer()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
    }
}

/// Deliver an ISOLATED thread's accumulated worktree diff to its project. Renders
/// the ControlThreadApplyResponse honestly (applied/branched/empty/conflict/rejected
/// + a HEAD-moved warning) — the server owns whether the apply lands.
private struct ApplyThreadBar: View {
    @Environment(AppModel.self) private var model
    let threadId: String
    @State private var applying = false
    /// Honest outcome of the apply, distinguishing the three states unambiguously
    /// (the old `String?` conflated "applied OK" and "no attempt" as empty-ish and
    /// left the buttons live after success — В: repeat-click re-applied the thread).
    private enum Outcome {
        case idle              // no attempt yet — offer Apply / As branch
        case applied           // a completed apply SUCCEEDED — lock the buttons
        case failed(String)    // a completed apply returned an honest message
    }
    @State private var outcome: Outcome = .idle

    private var isApplied: Bool { if case .applied = outcome { return true }; return false }

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: isApplied ? "checkmark.seal.fill" : "arrow.up.doc.on.clipboard")
                .foregroundStyle(isApplied ? Theme.status(.succeeded) : Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Isolated workspace").font(.caption.weight(.medium))
                switch outcome {
                case .applied:
                    Text("Applied to the project — this thread's worktree has been delivered.")
                        .font(.caption).foregroundStyle(Theme.status(.succeeded))
                case .failed(let message):
                    Text(message).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                case .idle:
                    Text("Turns are kept in a thread worktree — apply them to the project when ready.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            // After a successful apply the thread is delivered — HIDE the apply actions
            // so it can't be re-applied by mistake; show an explicit "Applied" state.
            if isApplied {
                Label("Applied", systemImage: "checkmark.seal.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.status(.succeeded))
            } else {
                Button(applying ? "Applying…" : "Apply thread") {
                    applying = true
                    Task {
                        let err = await model.applyThread(id: threadId)
                        applying = false
                        outcome = err.map(Outcome.failed) ?? .applied
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(applying)
                .help("Deliver the thread's accumulated diff to the project (server-gated)")
                Button("As branch") {
                    applying = true
                    Task {
                        let err = await model.applyThread(id: threadId, mode: "branch")
                        applying = false
                        outcome = err.map(Outcome.failed) ?? .applied
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(applying)
                .help("Deliver onto a new branch instead of the working tree")
            }
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.sm)
    }
}

/// Renders a turn's live transcript: reasoning (collapsible), tool calls (compact
/// mono rows with a status glyph), and assistant messages. Built from the
/// `TranscriptReducer` fold of the SSE stream (v0.10 Р7).
private struct TranscriptView: View {
    let blocks: [TranscriptBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            ForEach(blocks) { block in
                switch block {
                case .thinking(_, let text):
                    DisclosureGroup {
                        Text(text)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        Label("Thinking", systemImage: "brain")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                case .tool(_, let tool):
                    HStack(spacing: 6) {
                        Image(systemName: glyph(tool.status))
                            .foregroundStyle(color(tool.status))
                            .font(.caption2)
                        Text(tool.name).font(.caption.monospaced().weight(.medium))
                        if let target = tool.target, !target.isEmpty {
                            Text(target).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if let code = tool.exitCode, code != 0 {
                            Text("exit \(code)").font(.caption2).foregroundStyle(Theme.status(.failed))
                        }
                    }
                case .message(_, let text):
                    // Render markdown (headings/lists/code), not flat text — the
                    // v0.10 chat regression fix (reuses the run-detail renderer).
                    MarkdownOutputView(markdown: text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    private func glyph(_ s: ToolBlock.Status) -> String {
        switch s {
        case .running: return "circle.dotted"
        case .ok: return "checkmark.circle.fill"
        case .error: return "xmark.circle.fill"
        }
    }
    private func color(_ s: ToolBlock.Status) -> Color {
        switch s {
        case .running: return .secondary
        case .ok: return Theme.status(.succeeded)
        case .error: return Theme.status(.failed)
        }
    }
}

/// The PRIMARY harness chip: shows which harness answers in chat (logo + name)
/// and switches it from the eligible pool. "Auto" lets the engine pick. A bias
/// hint only — the engine owns routing (orderPool pins primary first).
struct PrimaryHarnessChip: View {
    let current: HarnessFamily?
    let pool: [HarnessFamily]
    var compact: Bool = false
    let onPick: (HarnessFamily?) -> Void

    private var tint: Color { current?.color ?? .secondary }
    private var options: [HarnessFamily] { pool.isEmpty ? ThreadsScreen.poolFamilies : pool }

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
/// "Spec" starts the grounding flow; "Race" runs the eligible pool (engine
/// `agent` + race strategy).
/// Strategies (until-clean, max-attempts) live in the composer's "⋯" panel.
struct IntentMenu: View {
    @Binding var selection: RunMode
    let projectScoped: Bool

    private var options: [RunMode] {
        projectScoped ? [.ask, .agent, .plan, .spec, .readOnlyAudit, .bestOfN] : [.ask]
    }
    private func label(_ m: RunMode) -> String { m == .bestOfN ? "Race" : m.label }

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
              ? "Intent for the next turn — Race runs the eligible pool; until-clean / attempts are in ⋯"
              : "No Current Project — only Ask (read-only) is available.")
    }
}

/// The frozen-spec card: the SpecPack is sealed (id + hash + change count) and an
/// Implement button (styled like "Implement plan") sends an agent turn that reads
/// the spec FILE. The path is server-returned (never composed in Swift).
private struct SpecFrozenCard: View {
    @Environment(AppModel.self) private var model
    /// The OWNING thread (captured at render) so Implement targets it, not selection.
    let threadId: String
    let specId: String
    let specPath: String
    let specHash: String
    let changes: Int
    @State private var implementing = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "snowflake").foregroundStyle(Theme.accent)
                Text("Spec frozen").font(.subheadline.weight(.semibold))
                Spacer()
                // Dismiss the frozen card without implementing (otherwise the card is
                // a dead-end — the user froze a spec but chose not to run it).
                Button("Dismiss") { model.cancelSpec(threadId: threadId) }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(implementing)
                    .help("Clear this frozen spec without implementing it")
                Button(implementing ? "Implementing…" : "Implement") {
                    implementing = true
                    Task {
                        await model.implementSpec(threadId: threadId, specPath: specPath)
                        implementing = false
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                // Can't start an Implement turn over a live head run (composerSend
                // also rejects it; the button reflects the invariant).
                .disabled(implementing || model.selectedThreadBusy)
                .help("Run an agent turn that implements this frozen spec")
            }
            HStack(spacing: Theme.Spacing.md) {
                Label(specId, systemImage: "doc.badge.gearshape")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Label(String(specHash.prefix(12)), systemImage: "number")
                    .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    .help("Spec hash \(specHash)")
                Label("\(changes) change\(changes == 1 ? "" : "s")", systemImage: "plusminus")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(Theme.Spacing.lg)
        .cardSurface(stroke: true, strokeColor: Theme.accent.opacity(0.5))
    }
}
