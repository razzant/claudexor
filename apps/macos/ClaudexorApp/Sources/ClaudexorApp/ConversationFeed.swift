import SwiftUI
import ClaudexorKit

/// Viewport state only. The located history store owns all mounted DTOs.
@MainActor @Observable final class ConversationFeedState {
    struct NavigationAnchor: Hashable, Sendable { let turnID: String; let request: Int; var bottom = false }
    enum Viewport: Equatable { case followingTail, reading(anchor: String?) }
    var viewport: Viewport = .followingTail
    var mountedIDs: [String] = []
    var position = ScrollPosition(idType: NavigationAnchor.self)
    var newCount: Int? = 0
    var atBottom = true
    var viewportHeight: CGFloat = 600
    var width: CGFloat = 680
    var earlierState: HistoryControlState = .ready
    var laterState: HistoryControlState = .ready
    var presentation = ConversationPresentation()
    var navigationRevision = 0
    var navigationTarget: String?
    var navigationAnchor: UnitPoint = .top
    var navigationY: CGFloat?
    @ObservationIgnored let readingPosition = ConversationReadingPosition()
    /// Observes each scroll sample before the following rule applies (diagnostics and tests).
    @ObservationIgnored var onGeometrySample: ((FeedEdge, FeedEdge) -> Void)?
    var visibleTurnID: String?
    static let limit = 20
    static let topID = "history:top"
    static let bottomID = "history:bottom"

    var follows: Bool { if case .followingTail = viewport { true } else { false } }
    var positionedTurnID: String? { position.viewID(type: NavigationAnchor.self)?.turnID }

    func markerID(for turnID: String, bottom: Bool = false) -> NavigationAnchor {
        NavigationAnchor(turnID: turnID, request: navigationRevision, bottom: bottom)
    }

    func synchronize(_ history: ThreadHistoryStore) {
        mountedIDs = history.mountedIDs
        if let visibleTurnID, !mountedIDs.contains(visibleTurnID) { self.visibleTurnID = nil }
        newCount = history.newCount
        presentation = history.presentation
    }

    func navigate(_ history: ThreadHistoryStore) {
        synchronize(history)
        viewport = history.navigationFollows ? .followingTail : .reading(anchor: history.navigationTarget)
        navigate(to: history.navigationTarget ?? Self.bottomID,
            anchor: history.navigationFollows || history.navigationBottom ? .bottom : .top)
    }

    func navigate(to id: String, anchor: UnitPoint) {
        navigationY = nil
        navigationTarget = id
        navigationAnchor = anchor
        navigationRevision += 1
    }

    func navigate(toY y: CGFloat) {
        navigationTarget = nil
        navigationY = y
        navigationRevision += 1
    }

    func commitNavigation() {
        if let navigationY { position.scrollTo(y: navigationY); return }
        guard let navigationTarget else { return }
        // ScrollPosition coalesces repeated requests for the same target. Only
        // the zero-height marker changes identity; retained TurnCards and their
        // native selections keep their stable turn IDs through the reveal.
        let endOfCard = navigationAnchor == .bottom && mountedIDs.contains(navigationTarget)
        position.scrollTo(id: markerID(for: navigationTarget, bottom: endOfCard), anchor: navigationAnchor)
    }

    func geometry(bottom: Bool, tailMounted: Bool) {
        atBottom = bottom
        if bottom && tailMounted {
            viewport = .followingTail
            newCount = 0
            readingPosition.readerIntentEnded()
        } else if follows && !readingPosition.isFollowingResize {
            viewport = .reading(anchor: positionedTurnID)
        }
    }

    /// Applies one scroll sample and reports whether bottom or viewport state changed.
    /// Only the reader leaves the tail: an upward wheel, trackpad or key scroll, or a
    /// scroller drag that moved up. Placement, anchoring and growth keep following; macOS
    /// 26.6 places a newly opened feed a few points short of its bottom, and the bottom
    /// anchor can lag content growth by a frame.
    func geometry(_ edge: FeedEdge, after old: FeedEdge, tailMounted: Bool) -> Bool {
        if follows && !edge.bottom {
            let reader = readingPosition.readerIsMovingUp || (readingPosition.liveScrolling && edge.offset < old.offset - 0.5)
            guard reader, !readingPosition.isFollowingResize else { return false }
        } else if edge.bottom == atBottom { return false }
        geometry(bottom: edge.bottom, tailMounted: tailMounted)
        return true
    }
}

/// One scroll-geometry sample of the feed.
struct FeedEdge: Equatable {
    var offset: CGFloat = 0
    var content: CGFloat = 0
    var container: CGFloat = 0
    var inset: CGFloat = 0
    /// How far the viewport ends above the bottom of the content.
    var deficit: CGFloat { content + inset - offset - container }
    var bottom: Bool { deficit <= 1 }
}

struct ConversationFeed: View {
    @Environment(AppModel.self) private var model
    @Bindable var state: ConversationFeedState
    @Bindable var history: ThreadHistoryStore
    let routingOptions: TurnOptions
    var sessions: AnyView = AnyView(EmptyView())

    private var turns: [ThreadHistoryTurn] { history.rows }
    private var tailMounted: Bool { history.tailMounted }

    var body: some View {
        ScrollView {
            ConversationHistoryStack(spacing: 0) {
                if !turns.isEmpty && (history.hasOlder || !tailMounted) {
                    EarlierTurnsControl(hasEarlier: history.hasOlder,
                        state: history.earlierState, action: showEarlier)
                        .frame(maxWidth: .infinity).padding(.bottom, Theme.Spacing.md)
                        .id(state.markerID(for: ConversationFeedState.topID))
                }
                ForEach(turns) { turn in
                    Color.clear.frame(height: 0).id(state.markerID(for: turn.id))
                    if let thread = history.header?.thread.summary {
                        TurnCard(turn: turn.turnInfo, target: model.turnStartTarget(
                            locationID: history.locationID, thread: thread),
                            routingOptions: routingOptions,
                            executionRoot: ThreadWorkspacePanel.executionRoot(for: thread), historyRow: turn)
                            .conversationMeasure().padding(.bottom, Theme.Spacing.md).id(turn.id)
                    }
                    Color.clear.frame(height: 0).id(state.markerID(for: turn.id, bottom: true))
                }
                if !tailMounted {
                    LaterTurnsControl(state: history.laterState, showJump: state.atBottom,
                        newCount: history.newCount, jumpState: history.jumpState,
                        later: { Task { await history.later() } }, latest: jump)
                        .frame(maxWidth: .infinity).padding(.bottom, Theme.Spacing.md)
                } else if history.header?.sessions.isEmpty == false { sessions }
                Color.clear.frame(height: 1).id(state.markerID(for: ConversationFeedState.bottomID))
            }
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(state.follows ? .bottom : .top, for: .sizeChanges)
        .defaultScrollAnchor(.top, for: .alignment)
        .scrollPosition($state.position, anchor: .top)
        .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.000_001) { visible in
            // Only cards use String IDs; navigation markers use NavigationAnchor.
            // A positive threshold excludes offscreen targets at zero visibility,
            // while including slivers of even very tall cards. Use feed order.
            state.visibleTurnID = history.mountedIDs.first { visible.contains($0) }
        }
        .onChange(of: state.navigationRevision) { state.commitNavigation(); state.readingPosition.navigated() }
        .onChange(of: history.navigationRevision) { state.navigate(history) }
        .onChange(of: history.mountedIDs) { state.synchronize(history) }
        .onChange(of: history.newCount) { state.newCount = history.newCount }
        .onChange(of: state.viewport) { synchronizeReading() }
        .onChange(of: state.positionedTurnID) { synchronizeReading() }
        .onChange(of: state.visibleTurnID) { synchronizeReading(); state.readingPosition.captureAfterSettling() }
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { history.cancelNavigation(); state.readingPosition.gestureBegan() }
            if phase == .idle { state.readingPosition.captureAfterSettling() }
        }
        .onScrollGeometryChange(for: FeedEdge.self) { geometry in
            FeedEdge(offset: geometry.contentOffset.y, content: geometry.contentSize.height,
                     container: geometry.containerSize.height, inset: geometry.contentInsets.bottom)
        } action: { old, new in
            state.onGeometrySample?(old, new)
            if state.geometry(new, after: old, tailMounted: tailMounted) { synchronizeReading() }
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
            state.readingPosition.widthChanged(size.width)
            state.viewportHeight = size.height
            state.width = min(680, max(1, size.width - 2 * Theme.Spacing.lg))
        }
        .modifier(ConversationJumpInset(isPresented: !state.follows && !state.atBottom,
            newCount: history.newCount, state: history.jumpState,
            latest: jump))
        .environment(history.presentation)
        .environment(\.conversationReadingPosition, state.readingPosition)
        .onAppear {
            state.readingPosition.attach(state)
            state.synchronize(history)
            history.prepare = { rows in for row in rows { _ = prepare(row) } }
        }
        .onDisappear { history.prepare = nil; state.readingPosition.stop(); state.readingPosition.detach() }
        .onChange(of: history.presentation.selectedMessages) { textFocusChanged() }
        .onChange(of: history.presentation.focusedMessages) { textFocusChanged() }
    }

    private func textFocusChanged() {
        if !history.presentation.selectedMessages.isEmpty || !history.presentation.focusedMessages.isEmpty {
            let wasFollowing = state.follows
            state.viewport = .reading(anchor: state.visibleTurnID ?? state.positionedTurnID)
            if wasFollowing { state.readingPosition.captureWhenReadingBegins() }
            else { state.readingPosition.captureAfterSettling() }
        } else if state.atBottom && tailMounted { state.viewport = .followingTail }
        synchronizeReading()
    }

    private func synchronizeReading() {
        history.following = state.follows
        if !state.follows {
            history.readingAnchor = (state.visibleTurnID ?? state.positionedTurnID).flatMap { history.mountedIDs.contains($0) ? $0 : nil }
                ?? history.readingAnchor ?? history.mountedIDs.first
        } else { history.newCountReset() }
    }

    private func jump() { Task { await history.jump() } }

    private func showEarlier() {
        var retained = 0
        var height: CGFloat = 0
        for turn in turns {
            retained += 1
            height += prepare(turn)
            if height >= state.viewportHeight { break }
        }
        Task {
            await history.earlier(retaining: retained)
        }
    }

    private func prepare(_ turn: ThreadHistoryTurn) -> CGFloat {
        let prompt = PromptBubble.preview(turn.prompt)
        let expanded = history.presentation.expanded["prompt:" + turn.id] ?? (history.header?.latestTurnId == turn.id)
        let text = !expanded ? ConversationPreviewText.prefix(prompt) : prompt
        let promptHeight = ProseMeasurer.shared.height(ProseBuilder.plain(text), width: max(1, state.width - 72))
        if let answer = turn.primaryOutput?.text {
            let shown = history.presentation.expanded["answer:" + turn.id] == true ? answer : ConversationPreviewText.prefix(answer)
            for segment in ProseBuilder.segments(shown, style: .init()) {
                if case .prose(let doc) = segment.content {
                    _ = ProseMeasurer.shared.height(doc, width: max(1, state.width - 48))
                }
            }
        }
        return min(260, promptHeight) + 64
    }
}
