import SwiftUI
import ClaudexorKit

/// Chat/session-first cockpit (v0.9 variant A): LEFT — threads + needs-me;
/// RIGHT — the conversation with a persistent composer. A thread's turns
/// resume each harness's own native CLI session, so "plan, then continue"
/// is one conversation, not a context reset. Runs stay inspectable via the
/// existing TaskDetail surface (a turn links to its run).
struct ThreadsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var composerText = ""
    @State private var composerMode: RunMode = .agent
    // "⋯" per-turn options (collapsed by default).
    @State private var showOptions = false
    @State private var capUsdText = ""
    @State private var access: AccessProfile = .workspaceWrite
    @State private var webPolicy = "auto"
    @State private var untilClean = false
    @State private var maxAttempts = 3

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
            maxAttempts: maxAttempts == 3 ? nil : maxAttempts
        )
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

    var body: some View {
        HSplitView {
            threadList
                .frame(minWidth: 240, idealWidth: 280, maxWidth: 360)
            conversation
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await model.refreshThreads() }
        .navigationTitle(navTitle)
        .navigationSubtitle(navSubtitle)
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
            }
        }
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
                ContentUnavailableView(
                    "Start a thread",
                    systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("Type below to begin. Turns run in-place so the next turn sees the work — plan, then implement, in one conversation.")
                )
                .frame(maxHeight: .infinity)
            }

            if let status = model.threadStatus {
                Text(status)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.xs)
            }

            // Isolated threads accumulate in a worktree; deliver the diff to the
            // project on demand. In-place threads write the live tree directly and
            // never need this bar.
            if let t = model.currentThread, t.workspaceMode == "isolated", !t.runIds.isEmpty {
                ApplyThreadBar(threadId: t.id)
            }

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
                        Button {
                            showOptions.toggle()
                        } label: {
                            Image(systemName: "slider.horizontal.3")
                        }
                        .buttonStyle(.glass)
                        .help("More options: harness pool, budget, access, web, repair strategies")
                        // Native dismissible popover (В5) — no inline glass-on-glass panel.
                        .popover(isPresented: $showOptions, arrowEdge: .bottom) { composerOptions }
                    }
                    Spacer(minLength: Theme.Spacing.sm)
                    composerHint
                }
                .onAppear { if !threadHasProject { composerMode = .ask } }
                .onChange(of: model.selectedThreadId) {
                    if !threadHasProject { composerMode = .ask }
                    // Per-turn knobs are not sticky — don't carry one thread's budget
                    // cap / access / web / repair flags into the next thread.
                    capUsdText = ""; access = .workspaceWrite; webPolicy = "auto"
                    untilClean = false; maxAttempts = 3; showOptions = false
                }
                // The no-project gate also fires when the project changes under a draft
                // (clearing it from Settings, etc.) — fall back to read-only Ask.
                .onChange(of: threadHasProject) { _, has in
                    if !has { composerMode = .ask; showOptions = false }
                }

                HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                    GlassField(text: $composerText,
                               placeholder: "Message…  (⌘↩ to send · the first message starts a thread)",
                               onSubmit: send)
                    Button("Send", action: send)
                        .buttonStyle(AccentButtonStyle())
                        .keyboardShortcut(.return, modifiers: .command)
                        // Blocked on empty text OR an invalid budget cap — never send a
                        // turn whose typed cap was silently dropped (typed-money contract).
                        .disabled(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || capUsdInvalid)
                        .help(capUsdInvalid ? "Fix the budget cap in ⋯ options to send" : "Send (⌘↩)")
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
                .disabled(composerMode.isReadOnly)
                .help(composerMode.isReadOnly ? "Read-only intents never write" : "How much this turn may touch")
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
            // convergence, NOT a race) — offer them for a plain Agent turn only.
            if composerMode == .agent {
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
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // Guard the cap HERE too, not only on the Send button: ⌘↩ / Return submit
        // through GlassField.onSubmit calls send() directly, bypassing the disabled
        // button. Never send a turn whose typed cap was silently dropped to nil.
        guard !capUsdInvalid else { return }
        let mode = composerMode
        let options = currentOptions
        composerText = ""
        Task {
            let sent = await model.composerSend(prompt: text, mode: mode, options: options)
            // Restore ONLY if the engine rejected it AND the user hasn't started
            // typing the next message in the meantime — never clobber in-flight text.
            if !sent && composerText.isEmpty { composerText = text }
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
                Button("Implement plan") {
                    guard let runId = turn.runId else { return }
                    Task { await model.composerSend(prompt: "Implement this plan.", mode: .agent, planRunId: runId) }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
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

/// The intent picker (5 modes), styled to the design system with a visible
/// selection. "Race" runs the eligible pool (engine `agent` + race strategy).
/// Strategies (until-clean, max-attempts) live in the composer's "⋯" panel.
struct IntentMenu: View {
    @Binding var selection: RunMode
    let projectScoped: Bool

    private var options: [RunMode] {
        projectScoped ? [.ask, .agent, .plan, .readOnlyAudit, .bestOfN] : [.ask]
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
