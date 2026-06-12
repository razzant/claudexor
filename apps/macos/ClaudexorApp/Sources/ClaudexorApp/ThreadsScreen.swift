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
                    Task { await model.newThread(title: nil) }
                } label: {
                    Label("New", systemImage: "plus")
                }
                .help("Start a new thread on the Current Project")
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
                    "Pick a thread",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Or start a new one. Turns resume native harness sessions — plan first, then continue in the same conversation.")
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
                    Label("Agent", systemImage: RunMode.agent.glyph).tag(RunMode.agent)
                    Label("Ask", systemImage: RunMode.ask.glyph).tag(RunMode.ask)
                    Label("Plan", systemImage: RunMode.plan.glyph).tag(RunMode.plan)
                    Label("Audit", systemImage: RunMode.readOnlyAudit.glyph).tag(RunMode.readOnlyAudit)
                    Label("Race ×2", systemImage: RunMode.bestOfN.glyph).tag(RunMode.bestOfN)
                    Label("Orchestrate", systemImage: RunMode.orchestrate.glyph).tag(RunMode.orchestrate)
                }
                .pickerStyle(.menu)
                .frame(width: 170)
                .help("The intent for the next turn; strategies (race width, until-clean) are flags on the same conversation")
                Spacer()
            }
            HStack(alignment: .bottom, spacing: Theme.Spacing.sm) {
                TextField("Message this thread… (plan first, then continue — same native session)", text: $composerText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.borderless)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.selectedThreadId == nil)
                .help("Send the turn (⌘↩)")
            }
        }
        .padding(Theme.Spacing.md)
        .background(.bar)
    }

    private func send() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let threadId = model.selectedThreadId else { return }
        composerText = ""
        Task { await model.sendTurn(threadId: threadId, prompt: text, mode: composerMode) }
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
                if (run.status == .blocked || run.status == .needsReview) && !riskAccepted {
                    decisionBar(run)
                }
                // Apply appears for green runs AND for blocked runs the operator
                // just unblocked (the server gate remains the authority).
                if (run.status == .succeeded && !run.diff.isEmpty) || riskAccepted {
                    applyBar(run)
                }
                if let answer = run.answerText, !answer.isEmpty, run.status.isTerminal {
                    Text(answer)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(8)
                        .textSelection(.enabled)
                }
            } else if let state = turn.state {
                Text(state).font(.caption).foregroundStyle(.secondary)
            }
            if let actionError {
                Text(actionError).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(Theme.Spacing.md)
        .cardSurface()
    }

    /// Review-queue actions ON the turn (the "apply: human_review" fix).
    private func decisionBar(_ run: TaskRun) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Button("Accept risk & unblock") {
                Task {
                    actionError = await model.decide(runId: run.id, action: "accept_risk", acceptedRisks: ["operator accepted via thread"])
                    if actionError == nil { riskAccepted = true }
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
                Task { actionError = await model.applyRun(runId: run.id) }
            }
            .help("Applies the reviewed patch to the original project (server-gated)")
            Button("Apply as branch") {
                Task { actionError = await model.applyRun(runId: run.id, mode: "branch") }
            }
            .help("Applies onto a new branch")
            Spacer()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
    }
}
