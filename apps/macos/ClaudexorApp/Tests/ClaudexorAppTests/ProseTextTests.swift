import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct ProseTextTests {
    private func document(_ source: String) throws -> ProseDocument {
        let segments = ProseBuilder.segments(source, style: .init())
        return try #require(segments.compactMap { segment in
            if case .prose(let value) = segment.content { return value }
            return nil
        }.first)
    }

    @Test func wrappedCodeStaysInOneSelectionAndCopiesExactSourceLines() throws {
        let source = HistoryMockupFixtures.selectionAnswer
        let segments = ProseBuilder.segments(source, style: .init())
        #expect(segments.count == 1)
        let doc = try document(source)
        let text = ProseTextView.make()
        text.textStorage?.setAttributedString(doc.text)
        text.frame.size = CGSize(width: 420, height: ProseMeasurer.shared.height(doc, width: 420))
        let range = (text.string as NSString).range(of: HistoryMockupFixtures.code)
        #expect(range.location != NSNotFound)
        let app = NSApplication.shared
        let previousPolicy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: text.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = text
        window.makeFirstResponder(text)
        defer { window.close(); app.setActivationPolicy(previousPolicy) }
        text.setSelectedRange(range)
        #expect(text.selectedRange() == range)
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.declareTypes([.string], owner: nil)
        #expect(text.writeSelection(to: board, types: [.string]))
        #expect(board.string(forType: .string) == HistoryMockupFixtures.code)
        #expect(!text.string.contains("\u{2028}"))
        let p = try #require(doc.text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle)
        #expect(p.headIndent > p.firstLineHeadIndent && p.textBlocks.count == 1)
    }

    @Test func tablesSplitProseAtTheirBoundaries() {
        let table = ProseBuilder.segments("Before\n\n| A | B |\n|---|---|\n| x | y |\n\nAfter", style: .init())
        #expect(table.count == 3)
    }

    @Test func wrappedCodeKeepsWordsWholeAndPreviewEndsOnALine() throws {
        let doc = try document(HistoryMockupFixtures.selectionAnswer)
        for width: CGFloat in [420, 680] {
            let view = ProseTextView.make()
            view.textStorage?.setAttributedString(doc.text)
            view.setFrameSize(CGSize(width: width, height: ProseMeasurer.shared.height(doc, width: width)))
            let manager = try #require(view.layoutManager)
            let container = try #require(view.textContainer)
            manager.ensureLayout(for: container)
            var lines: [NSRange] = []
            manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { _, _, _, glyphs, _ in
                lines.append(manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil))
            }
            for word in ["ConversationHistoryWindow", "verified"] {
                let range = (doc.text.string as NSString).range(of: word)
                #expect(lines.contains { NSIntersectionRange($0, range).length == range.length })
            }
            let prompt = ProseBuilder.plain(HistoryMockupFixtures.prompt(0))
            let clipped = ProseMeasurer.shared.wholeLineHeight(prompt, width: width, limit: 260)
            let rects = ProseMeasurer.shared.lines(prompt, width: width)
            #expect(clipped <= 260 && clipped > 230)
            #expect(rects.contains { ceil($0.maxY) == clipped })
            #expect(!rects.contains { $0.minY < clipped && ceil($0.maxY) > clipped })
        }
    }

    @Test func exactFractionalWidthsHaveSeparateCacheEntriesAndMatchDisplay() throws {
        let docs = try [document(HistoryMockupFixtures.selectionAnswer),
                        ProseBuilder.plain(HistoryMockupFixtures.prompt(0)),
                        ProseBuilder.plain(String(repeating: "путь/日本語/🙂/", count: 120))]
        let measurer = ProseMeasurer()
        for doc in docs {
            for width: CGFloat in [420, 420.125, 420.25, 680] {
                let before = measurer.layoutCount
                let height = measurer.height(doc, width: width)
                #expect(measurer.height(doc, width: width) == height)
                #expect(measurer.layoutCount == before + 1)
                let view = ProseTextView.make()
                view.textStorage?.setAttributedString(doc.text)
                view.setFrameSize(CGSize(width: width, height: height))
                let container = try #require(view.textContainer)
                let manager = try #require(view.layoutManager)
                manager.ensureLayout(for: container)
                #expect(ceil(manager.usedRect(for: container).maxY) == height)
            }
        }
    }

    @Test func identityFontsAndNativeHostContract() throws {
        let first = try document("**Strong**, *emphasis*, `code` and [a link](https://example.org).")
        let rebuilt = ProseDocument(identity: "plain:same", text: NSAttributedString(string: "same"), style: .init())
        let other = ProseDocument(identity: "plain:same", text: NSAttributedString(string: "same"), style: .init())
        #expect(rebuilt.id == other.id)
        let changed = ProseDocument(identity: "plain:same", text: other.text, style: .init(bodySize: 20))
        #expect(changed.id != other.id)
        let font = try #require(first.text.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        #expect(NSFontManager.shared.traits(of: font).contains(.boldFontMask))
        let link = (first.text.string as NSString).range(of: "a link").location
        #expect(first.text.attribute(.link, at: link, effectiveRange: nil) as? URL == URL(string: "https://example.org"))
        let view = ProseTextView.make()
        #expect(view.textLayoutManager == nil && view.layoutManager != nil)
        #expect(!view.isEditable && view.isSelectable && !view.canBecomeKeyView)
        #expect(!view.drawsBackground && !view.isVerticallyResizable)
        #expect(view.textContainerInset == .zero && view.textContainer?.lineFragmentPadding == 0)
        #expect(view.textContainer?.widthTracksTextView == true)
    }

    @Test func nativeDelegateConsumesFileLinksBeforeAnySystemOpen() {
        var opened: [URL] = []
        var notices: [String] = []
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        let coordinator = ProseText.Coordinator()
        coordinator.gate = ProseLinkGate(model: model, roots: [], notice: { if let text = $0 { notices.append(text) } },
            openSystem: { opened.append($0) })
        let view = ProseTextView.make()
        #expect(coordinator.textView(view, clickedOnLink: URL(fileURLWithPath: "/outside-scope.txt"), at: 0))
        #expect(opened.isEmpty && notices.count == 1)
        #expect(coordinator.textView(view, clickedOnLink: URL(string: "https://example.org")!, at: 0))
        #expect(opened.count == 1)
    }

    @Test func promptPreviewHasNoEightThousandCharacterCutAndRespectsUTF8() {
        let prompt = HistoryMockupFixtures.prompt(0) + " preserved after character 8000"
        #expect(PromptBubble.preview(prompt) == prompt)
        let large = String(repeating: "🙂я", count: 10_000)
        let bounded = PromptBubble.preview(large)
        #expect(bounded.utf8.count <= 32 * 1024 && large.hasPrefix(bounded))
    }

    @Test func historyWindowIsAnchoredBoundedAndIgnoresArrivalsWhileReading() async throws {
        let source = try HistoryTestSource(count: 45)
        let history = try source.store()
        await history.open()
        let anchor = try #require(history.mountedIDs.first)
        await history.earlier(retaining: 8)
        #expect(history.mountedIDs.count == 20 && history.mountedIDs.contains(anchor))
        let ids = history.mountedIDs
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 46, short: true)
        await history.refresh()
        #expect(history.mountedIDs == ids && history.newCount == 1)
        #expect(history.presentation.expanded["prompt:mock-turn-44"] == true)
        #expect(history.presentation.expanded["answer:mock-turn-44"] == true)
        history.presentation.planText["plan"] = ["question": "Keep this draft"]
        await history.jump()
        #expect(history.mountedIDs.count == 20 && history.mountedIDs.last == "mock-turn-45")
        #expect(history.following && history.newCount == 0)
        #expect(history.presentation.planText["plan"]?["question"] == "Keep this draft")
        let state = ConversationFeedState()
        // Placement short of the bottom (macOS 26.6), growth before the anchor, anchor lag
        // with new growth and a shorter viewport are not the reader: following holds.
        let rest = FeedEdge(offset: 400, content: 1_000, container: 600)
        var old = rest
        for edge in [FeedEdge(offset: 396, content: 1_000, container: 600), FeedEdge(offset: 396, content: 1_020, container: 600),
                     FeedEdge(offset: 416, content: 1_050, container: 600), FeedEdge(offset: 416, content: 1_050, container: 560),
                     FeedEdge(offset: 490, content: 1_050, container: 560)] {
            #expect(!state.geometry(edge, after: old, tailMounted: true))
            old = edge
        }
        #expect(state.follows && state.atBottom)
        // A 40pt wheel move up hidden by 50pt of anchored growth in the same frame leaves the tail.
        let wheel = ConversationFeedState()
        wheel.readingPosition.readerMovedUp()
        let masked = FeedEdge(offset: 500, content: 1_100, container: 560)
        #expect(wheel.geometry(masked, after: old, tailMounted: true))
        #expect(!wheel.follows && !wheel.atBottom)
        let back = FeedEdge(offset: 540, content: 1_100, container: 560)
        #expect(wheel.geometry(back, after: masked, tailMounted: true))
        #expect(wheel.follows)
        // Reaching the tail ends that input: a later placement short of the bottom keeps following.
        #expect(!wheel.geometry(FeedEdge(offset: 536, content: 1_100, container: 560), after: back, tailMounted: true))
        #expect(wheel.follows)
        // A scroller drag down while content grows keeps the tail; a drag up leaves it.
        let drag = ConversationFeedState()
        drag.readingPosition.liveScrolling = true
        let down = FeedEdge(offset: 500, content: 1_100, container: 560)
        #expect(!drag.geometry(down, after: old, tailMounted: true))
        #expect(drag.follows)
        #expect(drag.geometry(FeedEdge(offset: 450, content: 1_100, container: 560), after: down, tailMounted: true))
        #expect(!drag.follows)
        state.geometry(bottom: true, tailMounted: true)
        #expect(state.follows)
        state.geometry(bottom: false, tailMounted: true)
        #expect(!state.follows)
        state.geometry(bottom: true, tailMounted: true)
        #expect(state.follows)
        // Growth in consecutive frames: a sample carries the anchor for the previous one,
        // or the anchor lands two samples late.
        let chain = ConversationFeedState()
        let s0 = FeedEdge(offset: 400, content: 1_000, container: 600)
        let s1 = FeedEdge(offset: 400, content: 1_020, container: 600)
        let s2 = FeedEdge(offset: 420, content: 1_050, container: 600)
        let s3 = FeedEdge(offset: 420, content: 1_080, container: 600)
        let s4 = FeedEdge(offset: 480, content: 1_080, container: 600)
        #expect(!chain.geometry(s1, after: s0, tailMounted: true))
        #expect(!chain.geometry(s2, after: s1, tailMounted: true))
        #expect(!chain.geometry(s3, after: s2, tailMounted: true))
        #expect(!chain.geometry(s4, after: s3, tailMounted: true))
        #expect(chain.follows && chain.atBottom)
    }

    /// Upward input the feed cannot carry out, because its content fits and it already shows its
    /// top, is not the reader leaving: content that then overflows keeps following, with or without
    /// an unchanged bottom sample first. With room to move, the same input still leaves the tail.
    @Test(arguments: [false, true]) func upwardInputAtTheTopOfAShortFeedKeepsFollowingThroughGrowth(bottomSample: Bool) throws {
        let app = NSApplication.shared
        let previousPolicy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
        scroll.hasVerticalScroller = true
        let document = FlippedDocument(frame: NSRect(x: 0, y: 0, width: 400, height: 580))
        scroll.documentView = document
        let text = ProseTextView.make()
        text.frame = NSRect(x: 0, y: 0, width: 400, height: 80)
        document.addSubview(text)
        let window = NSWindow(contentRect: scroll.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = scroll
        defer { window.close(); app.setActivationPolicy(previousPolicy) }
        let state = ConversationFeedState()
        text.readingPosition = state.readingPosition
        state.readingPosition.register(text)
        let pageUp = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, characters: "\u{F72C}", charactersIgnoringModifiers: "\u{F72C}",
            isARepeat: false, keyCode: 116))
        // The wheel monitor's report, then Page Up from message text, with the whole chat in view.
        state.readingPosition.readerMovedUp()
        text.keyDown(with: pageUp)
        #expect(scroll.contentView.bounds.minY == 0)
        #expect(!state.readingPosition.readerIsMovingUp)
        var old = FeedEdge(offset: 0, content: 580, container: 600)
        if bottomSample {
            let fits = FeedEdge(offset: 0, content: 590, container: 600)
            #expect(!state.geometry(fits, after: old, tailMounted: true))
            old = fits
        }
        // The content overflows one sample before the bottom anchor follows it.
        let grown = FeedEdge(offset: 0, content: 640, container: 600)
        #expect(!state.geometry(grown, after: old, tailMounted: true))
        let anchored = FeedEdge(offset: 40, content: 640, container: 600)
        #expect(!state.geometry(anchored, after: grown, tailMounted: true))
        #expect(state.follows && state.atBottom)
        // At the bottom of overflowing content Page Up can move the feed; masked by growth, it leaves.
        document.setFrameSize(NSSize(width: 400, height: 640))
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 40))
        scroll.reflectScrolledClipView(scroll.contentView)
        text.keyDown(with: pageUp)
        #expect(state.readingPosition.readerIsMovingUp)
        let masked = FeedEdge(offset: 50, content: 690, container: 600)
        #expect(state.geometry(masked, after: anchored, tailMounted: true))
        #expect(!state.follows && !state.atBottom)
        #expect(state.geometry(FeedEdge(offset: 90, content: 690, container: 600), after: masked, tailMounted: true))
        #expect(state.follows)
    }

    /// A resized NSTextView keeps its selection in view by scrolling the feed; on the macOS 26.6
    /// runner a growing answer moved a followed feed to the answer's first line that way (offset 80).
    /// The test asks for that reveal from inside the frame change, where AppKit asks for it, and
    /// checks that the same reveal outside a frame change still scrolls the feed.
    @Test func aResizedMessageNeverScrollsTheFeedToItsSelection() throws {
        let app = NSApplication.shared
        let previousPolicy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
        scroll.hasVerticalScroller = true
        let document = FlippedDocument(frame: NSRect(x: 0, y: 0, width: 400, height: 2000))
        scroll.documentView = document
        let text = ProseTextView.make()
        text.frame = NSRect(x: 0, y: 80, width: 400, height: 1200)
        text.string = "A growing answer"
        document.addSubview(text)
        let window = NSWindow(contentRect: scroll.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = scroll
        nonisolated(unsafe) let resized = text
        let reveal = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification,
            object: text, queue: nil) { _ in
            MainActor.assumeIsolated { resized.scrollRangeToVisible(NSRange(location: 0, length: 0)) }
        }
        defer { NotificationCenter.default.removeObserver(reveal); window.close(); app.setActivationPolicy(previousPolicy) }
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 1400))
        scroll.reflectScrolledClipView(scroll.contentView)
        text.setFrameSize(NSSize(width: 400, height: 1800))
        #expect(text.frame.height == 1800)
        #expect(scroll.contentView.bounds.minY == 1400)
        text.scrollRangeToVisible(NSRange(location: 0, length: 0))
        #expect(scroll.contentView.bounds.minY <= 80)
    }
}

}

/// SwiftUI's scroll document is flipped: its top is the smallest y.
private final class FlippedDocument: NSView {
    override var isFlipped: Bool { true }
}
