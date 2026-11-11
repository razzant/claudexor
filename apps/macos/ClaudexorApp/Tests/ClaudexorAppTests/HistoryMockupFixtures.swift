import AppKit
import ClaudexorKit
import SwiftUI
@testable import ClaudexorApp

@MainActor enum HistoryMockupFixtures {
    static let threadID = "mock-history"
    static let longCodeLine = "let artifact = Artifact(path: \"apps/macos/ClaudexorApp/Sources/ClaudexorApp/ConversationHistoryWindow.swift\", sha256: \"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\", verified: true)"
    static let code = "let revision = history.revision\n" + longCodeLine + "\nlet turns = history.turns.suffix(20)\nreturn turns.map(\\.id)"
    static let selectionAnswer = """
    ## Keep the passage in view

    The saved conversation is ready. Select this paragraph, the list, the Swift code and the closing paragraph in one gesture.

    - Keep the current turn as the reading anchor.
    - Prepare the new text before committing the window.
    - Preserve source lines when copying. Проверка репозитория.

    ```swift
    \(code)
    ```

    The next refresh keeps this passage visible. Long paths wrap within the column; copied code still contains the original source lines.
    """

    static func prompt(_ index: Int) -> String {
        var text = "Turn \(index + 1): review the saved-history implementation and preserve the reader’s place.\n\n"
        var section = 0
        while text.count < 8_000 {
            text += "Review note \(section + 1): " + paragraph(index + section) + "\n\n"
            text += "/workspace/claudexor/apps/macos/ClaudexorApp/Sources/ClaudexorApp/ConversationHistoryWindow.swift\n"
            text += "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n\n"
            section += 1
        }
        return String(text.prefix(8_000))
    }

    static func paragraph(_ index: Int) -> String {
        "The review of revision \(index + 1) follows the conversation from its first saved turn to the current reply. "
        + "Keep the project path, evidence and account context visible while checking the history window. "
        + "A reader may compare an earlier decision with the current implementation without losing a draft or a selected passage. "
        + "Проверка: сообщение и репозиторий остаются доступны. "
        + "The final answer records what changed, how it was verified and which questions still need a decision."
    }

    static var table: String {
        var text = "| Area | Status | Evidence |\n|---|---|---|\n"
        let areas = ["History window", "Prompt preview", "Answer selection", "Wrapped code", "Table copy", "Plan draft",
                     "Saved history", "Link scope", "Tail following", "Earlier turns", "Narrow column", "Dark appearance"]
        for (index, area) in areas.enumerated() {
            text += "| \(area) | \(index % 3 == 0 ? "Review" : "Verified") | "
                + "Revision \(index + 1): \(index % 4 == 0 ? paragraph(index) : "The passage and its source evidence remain available after the next refresh.") |\n"
        }
        return text
    }

    static let wideTable = """
    | Area | Evidence | Reviewer | Revision | Source token | Result |
    |---|---|---|---|---|---|
    | Reading passage | Whole words remain together while the column wraps this sentence. | Local review | Saved revision 46 | 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 | Verified |
    | Width change | Narrow the column and retain the same passage at the viewport top. | Remote review | Saved revision 47 | ConversationHistoryWindowWithoutAnySpacesBetweenTheseWords | Verified |
    | Table source | Copy table retains the complete Markdown, including hidden columns. | Owner review | Saved revision 48 | exact-source-lines | Ready |
    """

    static func answer(_ index: Int) -> String {
        "## Review of turn \(index + 1)\n\n" + paragraph(index) + "\n\n" + table + "\n\n"
        + selectionAnswer + "\n\n" + (0..<8).map { paragraph(index + $0) }.joined(separator: "\n\n")
    }

    static func make(count: Int = 45, short: Bool = false) throws -> (ThreadDetailResponse, [TaskRun]) {
        var turns: [ThreadTurnInfo] = []
        var runs: [TaskRun] = []
        for index in 0..<count {
            let runID = "mock-run-\(index)"
            let text = short ? "Checkpoint \(index + 1): retain the saved passage." : prompt(index)
            turns.append(ThreadTurnInfo(id: "mock-turn-\(index)", threadId: threadID, runId: runID,
                parentRunId: nil, planRunId: nil, kind: nil, prompt: text, run: nil,
                createdAt: "2026-10-26T10:00:00.000Z"))
            var run = TaskRun(id: runID, title: "History review \(index + 1)", prompt: text,
                mode: .agent, phase: .succeeded, project: "History review", harnesses: [], n: 1,
                createdAt: Date(timeIntervalSince1970: 1_793_008_800), updatedAt: Date(timeIntervalSince1970: 1_793_008_860),
                spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false, routeProof: .unverified,
                attentionNote: nil, plan: [], activity: [], candidates: [], findings: [], diff: [])
            run.answerText = short ? "Verified checkpoint \(index + 1)." : answer(index)
            runs.append(run)
        }
        let json: [String: Any] = ["id": threadID, "title": "Saved history · review and implementation",
            "runIds": runs.map(\.id), "headRunId": runs.last?.id ?? "", "needsHuman": false,
            "createdAt": "2026-10-26T10:00:00.000Z", "updatedAt": "2026-10-26T10:01:00.000Z"]
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: JSONSerialization.data(withJSONObject: json))
        return (ThreadDetailResponse(thread: thread, sessions: [], turns: turns), runs)
    }

    static func model(detail: ThreadDetailResponse, runs: [TaskRun], source: HistoryTestSource? = nil) -> AppModel {
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        model.liveTasks = runs
        model.threads = [detail.thread]
        model.selectedThreadId = detail.thread.id
        model.selectedHistory = try! (source ?? HistoryTestSource(detail: detail, runs: runs)).store(loaded: true)
        return model
    }

    static func plan(_ run: inout TaskRun) {
        run.mode = .plan
        run.answerText = "The history design is ready for your decisions. Your draft answers are retained while you read earlier turns."
        run.planReadiness = PlanReadiness(state: "needs_answers", questionCount: 5)
        run.planQuestions = [
            PlanQuestion(id: "code", kind: "text", prompt: "How should long Swift source lines appear?", options: [], allowText: true),
            PlanQuestion(id: "table", kind: "text", prompt: "Which table copy behavior works for your review?", options: [], allowText: true),
            PlanQuestion(id: "prompt", kind: "text", prompt: "Should older prompts start collapsed?", options: [], allowText: true),
            PlanQuestion(id: "typing", kind: "text", prompt: "Where should typing go after selecting message text?", options: [], allowText: true),
            PlanQuestion(id: "travel", kind: "text", prompt: "May explicit history travel end a selection in a turn that leaves the mounted window?", options: [], allowText: true)
        ]
    }
}

/// Focused frames use the chosen production message/table hosts and fills.
struct HistoryProseSurface: View {
    @State private var presentation = ConversationPresentation()
    @State private var expanded = false
    let kind: String
    let width: CGFloat
    var body: some View {
        ScrollView {
            Group {
                if kind == "prompt" || kind == "selected-prompt" {
                    PromptBubble(prompt: HistoryMockupFixtures.prompt(44), turnID: "prose-example")
                } else if kind == "answer" {
                    ConversationAnswerText(answer: (0..<8).map { HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n"), expanded: $expanded)
                        .padding(Theme.Spacing.md)
                        .bubbleFill(tint: Theme.surfaceRaisedHi, radius: Theme.Radius.control)
                } else {
                    MarkdownOutputView(markdown: kind == "table"
                        ? HistoryMockupFixtures.table : kind == "wide-table" ? HistoryMockupFixtures.wideTable : HistoryMockupFixtures.selectionAnswer, bodyFont: .body)
                        .frame(width: width, alignment: .leading)
                        .padding(Theme.Spacing.md)
                        .bubbleFill(tint: Theme.surfaceRaisedHi, radius: Theme.Radius.control)
                }
            }
            .frame(width: kind == "prompt" || kind == "selected-prompt" ? width : width + 24, alignment: .leading)
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity)
        }
        .textSelection(.disabled)
        .environment(presentation)
        .onAppear { if kind == "selected-prompt" { presentation.latestTurnID = "prose-example" } }
        .background(Theme.surfaceBase)
    }
}

/// Deliberately minimal row geometry to expose the physically unavoidable clamp.
/// The other 05b pair uses full production TurnCards with 21 short turns.
struct HistoryClampSurface: View {
    @Bindable var state: ConversationFeedState
    let history: ThreadHistoryStore
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                EarlierTurnsControl(hasEarlier: true) { Task { await history.earlier(retaining: 20) } }
                    .frame(maxWidth: .infinity)
                ForEach(history.rows) { turn in
                    ProseText(document: ProseBuilder.plain("\(turn.id): Keep this checkpoint available."))
                        .id(state.markerID(for: turn.id))
                }
                if !history.tailMounted {
                    LaterTurnsControl(later: { Task { await history.later() } }, latest: { Task { await history.jump() } })
                }
            }.scrollTargetLayout().frame(width: 680).padding(Theme.Spacing.lg)
                .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .defaultScrollAnchor(.top, for: .alignment)
        .scrollPosition($state.position)
        .onChange(of: state.navigationRevision) { state.commitNavigation() }
        .onChange(of: history.navigationRevision) { state.navigate(history) }
        .background(Theme.surfaceBase)
    }
}

@MainActor @Observable final class HistoryInsetCaptureState {
    var show = false
    var buttonHeight: CGFloat = 0
    var position = ScrollPosition(idType: Int.self)
}

/// Exercise the production inset independently of follow-tail mode: forcing
/// following while anchored above the tail is not a valid feed state.
struct HistoryInsetCaptureSurface: View {
    @Bindable var state: HistoryInsetCaptureState
    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                ForEach(0..<8) { index in
                    ProseText(document: ProseBuilder.plain("Checkpoint \(index): " + String(repeating: HistoryMockupFixtures.paragraph(index), count: 4)))
                        .id(index)
                }
            }.frame(width: 680).scrollTargetLayout()
        }
        .defaultScrollAnchor(.top, for: .sizeChanges)
        .scrollPosition($state.position)
        .modifier(ConversationJumpInset(isPresented: state.show, newCount: 0,
            measuredHeight: { state.buttonHeight = $0 }, latest: {}))
    }
}
