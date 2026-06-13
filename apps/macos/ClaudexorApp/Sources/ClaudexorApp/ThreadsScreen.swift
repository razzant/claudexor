import SwiftUI
import ClaudexorKit

/// Chat/session-first cockpit (v0.9 variant A): LEFT — threads + needs-me;
/// RIGHT — the conversation with a persistent composer. A thread's turns
/// resume each harness's own native CLI session, so "plan, then continue"
/// is one conversation, not a context reset. Runs stay inspectable via the
/// existing TaskDetail surface (a turn links to its run).
struct ThreadsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var newThreadTitle = ""
    @State private var composerText = ""
    @State private var composerMode: RunMode = .agent

    /// Project-aware intents need a project scope. A selected thread uses its own
    /// repo; in the DRAFT state (no thread selected yet) the first turn will be
    /// created on the Current Project, so the project intents are available too.
    private var threadHasProject: Bool {
        if let id = model.selectedThreadId, let t = model.threads.first(where: { $0.id == id }) {
            return t.repoRoot?.isEmpty == false
        }
        return !model.normalizedProjectRoot.isEmpty
    }

    var body: some View {
        HSplitView {
            threadList
                .frame(minWidth: 240, idealWidth: 280, maxWidth: 360)
            conversation
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await model.refreshThreads() }
    }

    // MARK: Threads pane

    private var threadList: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("Threads").font(.headline)
                Spacer()
                Button {
                    model.startDraftThread()
                } label: {
                    Label("New", systemImage: "square.and.pencil")
                }
                .help("New thread — the first message starts it (on the Current Project)")
            }
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
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(thread.title ?? "Untitled thread").font(.body).lineLimit(1)
                if thread.needsHuman {
                    Image(systemName: "person.fill.questionmark")
                        .foregroundStyle(.orange)
                        .help("This thread is blocked on your decision")
                }
            }
            Text(threadSubtitle(thread)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.vertical, 2)
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

            composer
        }
    }

    private func sessionsFooter(_ sessions: [ThreadSessionInfo]) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "link").foregroundStyle(.secondary)
            ForEach(sessions) { session in
                Text("\(session.harnessId)\(session.nativeSessionId != nil ? " · live session" : "")")
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(.quaternary))
                    .help(session.nativeSessionId.map { "Native session \($0) resumes on the next turn" } ?? "No native session yet")
            }
            Spacer()
        }
    }

    /// The persistent composer: chat is the NORMAL loop, not exception handling.
    private var composer: some View {
        VStack(spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.sm) {
                Picker("Intent", selection: $composerMode) {
                    Label("Ask", systemImage: RunMode.ask.glyph).tag(RunMode.ask)
                    if threadHasProject {
                        Label("Agent", systemImage: RunMode.agent.glyph).tag(RunMode.agent)
                        Label("Plan", systemImage: RunMode.plan.glyph).tag(RunMode.plan)
                        Label("Audit", systemImage: RunMode.readOnlyAudit.glyph).tag(RunMode.readOnlyAudit)
                        Label("Race ×2", systemImage: RunMode.bestOfN.glyph).tag(RunMode.bestOfN)
                        Label("Orchestrate", systemImage: RunMode.orchestrate.glyph).tag(RunMode.orchestrate)
                    }
                }
                .pickerStyle(.menu)
                .frame(width: 170)
                .help(threadHasProject
                      ? "The intent for the next turn; strategies (race width, until-clean) are flags on the same conversation"
                      : "No Current Project — only Ask (read-only) is available. Pick a project in Settings to plan/agent/race.")
                Spacer()
                if model.selectedThreadId == nil {
                    Text(threadHasProject
                         ? "New thread on \(URL(fileURLWithPath: model.normalizedProjectRoot).lastPathComponent)"
                         : "New ask-only thread (no project)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .onAppear { if !threadHasProject { composerMode = .ask } }
            .onChange(of: model.selectedThreadId) { if !threadHasProject { composerMode = .ask } }
            HStack(alignment: .bottom, spacing: Theme.Spacing.sm) {
                TextField("Message… (the first message starts a thread)", text: $composerText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.borderless)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help("Send (⌘↩)")
            }
        }
        .padding(Theme.Spacing.md)
        .background(.bar)
    }

    /// The composer is ALWAYS live: with no thread selected, the first message
    /// materializes one (on the Current Project). No silent no-op (the v0.9 bug).
    /// The text is cleared only after a successful send, restored on failure.
    private func send() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let mode = composerMode
        composerText = ""
        Task {
            let sent = await model.composerSend(prompt: text, mode: mode)
            if !sent { composerText = text } // restore ONLY if the engine rejected it
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
                }
                // Live transcript: the harness's reasoning + tool calls as they
                // happen (folded from SSE), so the chat shows working progress —
                // not just a status pill and a final answer.
                if let runId = turn.runId, let blocks = model.transcripts[runId]?.blocks, !blocks.isEmpty {
                    TranscriptView(blocks: blocks)
                }
                // Honest outcome (the v0.9 "is the game done?" fix): a plan turn
                // says "no files changed" and offers to implement it; a patch shows
                // its diffstat (and whether a race winner was auto-applied).
                if let result = turn.run?.result {
                    outcomeRow(result)
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
                    applyBar(run)
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
        .cardSurface()
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
        HStack(spacing: Theme.Spacing.sm) {
            Button("Apply patch") {
                Task {
                    actionError = await model.applyRun(runId: run.id)
                    if actionError == nil { applied = true }   // hide buttons; no double-apply
                }
            }
            .help("Applies the reviewed patch to the original project (server-gated)")
            Button("Apply as branch") {
                Task {
                    actionError = await model.applyRun(runId: run.id, mode: "branch")
                    if actionError == nil { applied = true }
                }
            }
            .help("Applies onto a new branch")
            Spacer()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
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
                    Text(text)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, 2)
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
