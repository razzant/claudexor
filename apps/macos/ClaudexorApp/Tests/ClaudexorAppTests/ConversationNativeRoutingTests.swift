import AppKit
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// Suites that move AppKit first responders run one at a time. SwiftUI text
/// fields share one field editor in the process, so focusing a field in one
/// test window ends editing in another test's window.
@Suite(.serialized) struct KeyboardFocusTests {}

extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct ConversationNativeRoutingTests {
    @Test(arguments: [0, 8, 14]) func firstKeyPreservesExistingComposerDraftAndInsertionPoint(cursor: Int) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let (host, window) = window(ThreadsScreen().environment(model))
        defer { window.close() }
        await settle(host)
        let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        let composer = try #require(views(host).compactMap { $0 as? NSTextField }.first { $0.isEditable })
        #expect(window.makeFirstResponder(composer))
        let editor = try #require(composer.currentEditor() as? NSTextView)
        editor.insertText("existing draft", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.setSelectedRange(NSRange(location: cursor, length: 0))
        await settle(host)
        #expect(composer.stringValue == "existing draft")
        #expect(window.makeFirstResponder(message))
        message.setSelectedRange(NSRange(location: 0, length: 0))
        #expect(composer.stringValue == "existing draft")
        window.sendEvent(try key("x", code: 7, window: window))
        await settle(host)
        print("FIRST KEY EXISTING DRAFT: \(composer.stringValue.debugDescription), responder=\(String(describing: window.firstResponder))")
        let expected = ("existing draft" as NSString).replacingCharacters(in: NSRange(location: cursor, length: 0), with: "x")
        #expect(composer.stringValue == expected)
        #expect(window.firstResponder === composer.currentEditor())
    }

    @Test(arguments: [false, true])
    func nativeTabDispatchLeavesMessageForAnEditableField(backward: Bool) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let message = ProseTextView.make()
        message.frame = NSRect(x: 0, y: 80, width: 400, height: 200)
        message.string = "A selectable message"
        let before = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 30))
        let after = NSTextField(frame: NSRect(x: 0, y: 40, width: 200, height: 30))
        for view in [before, message, after] as [NSView] { root.addSubview(view) }
        let (_, window) = window(EmptyView())
        defer { window.close() }
        window.contentView = root
        window.autorecalculatesKeyViewLoop = false
        let native = NSTextView(frame: message.frame)
        native.string = message.string
        native.isEditable = false
        native.isSelectable = true
        root.addSubview(native)
        before.nextKeyView = native
        native.nextKeyView = after
        after.nextKeyView = before
        #expect(window.makeFirstResponder(native))
        window.sendEvent(try key(backward ? "\u{19}" : "\t", code: 48,
            modifiers: backward ? .shift : [], window: window))
        print("NATIVE TAB backward=\(backward), responder=\(String(describing: window.firstResponder))")
        #expect(window.firstResponder !== native)
        #expect((backward ? before : after).currentEditor() != nil)
        native.removeFromSuperview()
        before.nextKeyView = message
        message.nextKeyView = after
        after.nextKeyView = before
        #expect(window.makeFirstResponder(message))
        window.sendEvent(try key(backward ? "\u{19}" : "\t", code: 48,
            modifiers: backward ? .shift : [], window: window))
        print("TAB backward=\(backward), responder=\(String(describing: window.firstResponder))")
        #expect(window.firstResponder !== message)
        #expect((backward ? before : after).currentEditor() != nil)
    }

    @Test(arguments: [false, true])
    func tabDispatchInActualThreadsScreenKeepsTheNativeExit(backward: Bool) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let (host, window) = window(ThreadsScreen().environment(model))
        defer { window.close() }
        await settle(host)
        let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        #expect(window.makeFirstResponder(message))
        window.sendEvent(try key(backward ? "\u{19}" : "\t", code: 48,
            modifiers: backward ? .shift : [], window: window))
        #expect(window.firstResponder !== message)
        // The native key-view route really has a destination in this same screen.
        if backward { window.selectPreviousKeyView(message) }
        else { window.selectNextKeyView(message) }
        #expect(window.firstResponder !== message)
    }

    @Test func truncatedPromptContextMenuReadsFullSourceOnlyWhenClicked() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let facts = try JSONDecoder().decode(ThreadHistoryTextFacts.self, from: Data(#"{"truncated":true,"totalTextBytes":65536,"textBytes":15}"#.utf8))
        var reads = 0
        let (host, window) = window(PromptBubble(prompt: "Bounded preview", turnID: "t", promptInfo: facts, fullPrompt: {
            reads += 1
            throw CocoaError(.fileReadNoSuchFile)
        }))
        defer { window.close() }
        await settle(host)
        let view = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        #expect(reads == 0)
        let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown, location: .zero,
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1))
        let menu = try #require(view.menu(for: event))
        let item = try #require(menu.items.first { $0.title == "Copy message" })
        menu.update()
        #expect(item.isEnabled)
        #expect(reads == 0)
        #expect(NSApp.sendAction(try #require(item.action), to: item.target, from: item))
        await settle(host)
        #expect(reads == 1)
        #expect(view.string == "Bounded preview")
    }

    @Test(arguments: ["gesture", "navigation", "following"])
    func pendingPassageRestoreYieldsToNewerIntent(intent: String) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 3)
        source.runs[1].answerText = (0..<40).map { "Passage \($0): " + HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n")
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let history = try #require(model.selectedHistory)
        history.presentation.expanded["answer:mock-turn-1"] = true
        let state = ConversationFeedState()
        let (host, window) = window(ConversationFeed(state: state, history: history, routingOptions: .init()).environment(model), width: 680)
        host.sizingOptions = []
        defer { window.close() }
        await settle(host, count: 10)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first { $0.string.hasPrefix("Passage 0:") })
        let layout = try #require(prose.layoutManager)
        let container = try #require(prose.textContainer)
        layout.ensureLayout(for: container)
        let range = (prose.string as NSString).range(of: "Passage 20:")
        let line = layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: range.location), effectiveRange: nil)
        var ancestor = prose.superview
        var scroll: NSScrollView?
        while let view = ancestor {
            if let candidate = view as? NSScrollView, candidate.hasVerticalScroller { scroll = candidate }
            ancestor = view.superview
        }
        let feed = try #require(scroll)
        let document = try #require(feed.documentView)
        state.viewport = .reading(anchor: "mock-turn-1")
        state.navigate(toY: prose.convert(line, to: document).minY + 4)
        await settle(host, count: 10)
        #expect(state.readingPosition.passage != nil)
        // Parallel suites can resume this test after a 180 ms restore already ran (#520);
        // hold the restore so the newer intent always meets it pending and must cancel it.
        state.readingPosition.restoreDelay = .seconds(30)
        window.setContentSize(NSSize(width: 420, height: 700))
        host.setFrameSize(NSSize(width: 420, height: 700))
        await settle(host, count: 1)
        #expect(state.readingPosition.isResizing)
        if intent == "gesture" {
            state.readingPosition.gestureBegan() // production scroll-phase receiver
            feed.contentView.scroll(to: NSPoint(x: 0, y: 800))
            feed.reflectScrolledClipView(feed.contentView)
        } else if intent == "navigation" {
            state.navigate(toY: 800)
        } else { await history.jump() }
        await settle(host, count: 2)
        let revision = state.navigationRevision
        await settle(host, count: 10)
        #expect(state.navigationRevision == revision)
        #expect(!state.readingPosition.isResizing)
        if intent == "following" {
            print("FINAL \(intent) bottom=\(state.atBottom) follows=\(state.follows) y=\(feed.contentView.bounds.minY)")
            #expect(state.atBottom && history.following && state.follows)
        } else { #expect(abs(feed.contentView.bounds.minY - 800) <= 1) }
        #expect(!window.isVisible)
    }

    @Test(arguments: [false, true]) func focusingTheTailThenResizingKeepsItsVisiblePassage(captureOnFocus: Bool) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 3)
        source.runs[2].answerText = (0..<40).map { "Tail passage \($0): " + HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n")
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let history = try #require(model.selectedHistory)
        let state = ConversationFeedState()
        // Scroll samples explain a lost tail on another macOS (CI runs a newer one).
        final class Trace { var lines: [String] = [] }
        let trace = Trace()
        state.onGeometrySample = { _, new in
            trace.lines.append("o=\(new.offset) c=\(new.content) h=\(new.container) i=\(new.inset) d=\(new.deficit)")
        }
        let (host, window) = window(ConversationFeed(state: state, history: history, routingOptions: .init()).environment(model), width: 680)
        host.sizingOptions = []
        defer { window.close() }
        await settle(host, count: 10)
        await settle(host) { state.follows && state.atBottom }
        print("TAIL TRACE follows=\(state.follows) bottom=\(state.atBottom)\n" + trace.lines.prefix(80).joined(separator: "\n"))
        #expect(state.follows)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first { $0.string.hasPrefix("Tail passage 0:") })
        var ancestor = prose.superview
        var scroll: NSScrollView?
        while let view = ancestor {
            if let candidate = view as? NSScrollView, candidate.hasVerticalScroller { scroll = candidate }
            ancestor = view.superview
        }
        let feed = try #require(scroll)
        let document = try #require(feed.documentView)
        // The newest text is in view; macOS 26.6 may place the first offset a few points short.
        #expect(document.frame.height - feed.contentView.bounds.maxY <= 8)
        print("TAIL START follows=\(state.follows) bottom=\(state.atBottom) y=\(feed.contentView.bounds.minY) visible=\(feed.contentView.bounds.height) document=\(document.frame.height)")
        let layout = try #require(prose.layoutManager)
        let container = try #require(prose.textContainer)
        layout.ensureLayout(for: container)
        let point = prose.convert(NSPoint(x: 0, y: feed.contentView.bounds.minY), from: document)
        let glyph = layout.glyphIndex(for: NSPoint(x: 0, y: max(0, point.y - prose.textContainerOrigin.y)), in: container)
        let character = layout.characterIndexForGlyph(at: glyph)
        let line = layout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
        let before = prose.convert(line, to: document).minY - feed.contentView.bounds.minY
        #expect(window.makeFirstResponder(prose))
        prose.setSelectedRange(NSRange(location: character, length: 6))
        await settle(host)
        #expect(!state.follows && !history.following)
        if captureOnFocus { state.readingPosition.captureAfterSettling() }
        await settle(host)
        print("FOCUSED TAIL before character=\(character) offset=\(before) passage=\(String(describing: state.readingPosition.passage))")
        window.setContentSize(NSSize(width: 420, height: 700))
        host.setFrameSize(NSSize(width: 420, height: 700))
        await settle(host, count: 10)
        layout.ensureLayout(for: container)
        let afterLine = layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: character), effectiveRange: nil)
        let after = prose.convert(afterLine, to: document).minY - feed.contentView.bounds.minY
        print("FOCUSED TAIL after offset=\(after), difference=\(after-before)")
        #expect(abs(after - before) <= line.height)
    }

    /// The feed's own scroll view. While the whole chat fits, an upward wheel cannot move it and
    /// leaves no reader intent, so growth past the viewport keeps following; once the content
    /// overflows, the same wheel moves the feed and leaves the tail. A never-ordered window gives
    /// the monitor's filters no event location, so the test makes the monitor's report itself.
    /// AppKit animates a line wheel on the window's display link, which such a window does not
    /// always advance (#527), so the overflow scroll moves the clip as the wheel's first frame would.
    @Test func upwardWheelOnAShortFeedKeepsFollowingWhenItGrows() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let history = try #require(model.selectedHistory)
        let state = ConversationFeedState()
        final class Trace { var lines: [String] = [] }
        let trace = Trace()
        state.onGeometrySample = { _, new in
            trace.lines.append("o=\(new.offset) c=\(new.content) h=\(new.container) i=\(new.inset) d=\(new.deficit)")
        }
        let (host, window) = window(ConversationFeed(state: state, history: history, routingOptions: .init()).environment(model), width: 680)
        host.sizingOptions = []
        defer { window.close() }
        await settle(host, count: 10)
        await settle(host) { state.follows && state.atBottom }
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        let feed = try #require(outerScroll(of: prose))
        let document = try #require(feed.documentView)
        // Names the AppKit caller of each clip move, which a newer macOS on CI may add.
        nonisolated(unsafe) let movers = trace
        feed.contentView.postsBoundsChangedNotifications = true
        let mover = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification,
            object: feed.contentView, queue: nil) { _ in
            let methods = Thread.callStackSymbols.compactMap { line in
                line.range(of: "-[").map { String(line[$0.lowerBound...].prefix { $0 != "]" }) + "]" }
            }.filter { !$0.contains("otification") && !$0.contains("Bounds") }
                .reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            movers.lines.append("clip moved via " + methods.prefix(14).joined(separator: " < "))
        }
        defer { NotificationCenter.default.removeObserver(mover) }
        #expect(document.frame.height <= feed.contentView.bounds.height)
        let top = feed.contentView.bounds.minY
        try wheelUp(feed, reading: state.readingPosition)
        #expect(!state.readingPosition.readerIsMovingUp)
        // Growth during the wheel's animated live scroll would let that animation move the grown feed.
        await settle(host) { !state.readingPosition.liveScrolling }
        trace.lines.append("wheel up: y=\(feed.contentView.bounds.minY) moving=\(state.readingPosition.readerIsMovingUp)")
        #expect(feed.contentView.bounds.minY == top)
        source.runs[0].answerText = (0..<20).map { "Grown passage \($0): " + HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n")
        await history.refresh()
        await settle(host) { document.frame.height > feed.contentView.bounds.height + 40 }
        await settle(host)
        print("SHORT FEED follows=\(state.follows) bottom=\(state.atBottom) flipped=\(document.isFlipped) "
            + "document=\(document.frame.height) visible=\(feed.contentView.bounds.height)\n" + trace.lines.joined(separator: "\n"))
        #expect(state.follows && history.following)
        #expect(document.frame.height - feed.contentView.bounds.maxY <= 8)
        let bottom = feed.contentView.bounds.minY
        // A busy main actor can sample the scroll after the 400 ms intent window; hold the
        // intent so the reader's scroll is always recognized.
        state.readingPosition.readerIntentWindow = .seconds(30)
        state.readingPosition.readerMovedUp()
        feed.contentView.scroll(to: NSPoint(x: 0, y: bottom - 50))
        feed.reflectScrolledClipView(feed.contentView)
        #expect(state.readingPosition.readerIsMovingUp)
        await settle(host) { feed.contentView.bounds.minY < bottom - 20 && !state.follows }
        #expect(feed.contentView.bounds.minY < bottom - 20)
        #expect(!state.follows && !history.following)
    }

    private func window<V: View>(_ root: V, width: CGFloat = 1100) -> (NSHostingView<V>, NSWindow) {
        let host = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = window.frame
        return (host, window)
    }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
    private func settle(_ host: NSView, count: Int = 4) async {
        for _ in 0..<count { host.layoutSubtreeIfNeeded(); try? await Task.sleep(for: .milliseconds(60)) }
    }
    // Parallel suites keep the main actor busy, so the first layout passes can arrive late.
    private func settle(_ host: NSView, until ready: () -> Bool) async {
        for _ in 0..<50 where !ready() { await settle(host, count: 1) }
    }
    private func key(_ text: String, code: UInt16, modifiers: NSEvent.ModifierFlags = [], window: NSWindow) throws -> NSEvent {
        try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: text,
            charactersIgnoringModifiers: text, isARepeat: false, keyCode: code))
    }
    private func outerScroll(of view: NSView) -> NSScrollView? {
        var ancestor = view.superview
        var scroll: NSScrollView?
        while let view = ancestor {
            if let candidate = view as? NSScrollView, candidate.hasVerticalScroller { scroll = candidate }
            ancestor = view.superview
        }
        return scroll
    }
    /// Five mouse-wheel lines toward earlier content, reported first, as the monitor does.
    private func wheelUp(_ feed: NSScrollView, reading: ConversationReadingPosition) throws {
        let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: 5, wheel2: 0, wheel3: 0))
        reading.readerMovedUp()
        feed.scrollWheel(with: try #require(NSEvent(cgEvent: event)))
    }
}

}
