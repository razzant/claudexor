import AppKit
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

extension KeyboardFocusTests {
/// #520: outside the feed a width change reflows prose under an unchanged scroll offset, and AppKit
/// asks nothing that would keep a selection on screen (the native run measured Run details narrowing
/// 620 → 340 moving a fully visible selection out of view with no reveal request). A non-empty
/// selection the reader can see now returns to its height in the viewport once the width settles.
/// An insertion point, a selection scrolled out of view and feed prose keep today's offset.
@MainActor @Suite(.serialized)
struct ProseSelectionWidthTests {
    /// The mechanism alone: prose in a scroll view, its frame narrowed as SwiftUI narrows it.
    @Test func aVisibleSelectionKeepsItsHeightWhenItsProseReflows() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let fixture = AppKitFixture()
        defer { fixture.window.close() }
        let (text, scroll) = (fixture.text, fixture.scroll)
        text.selectionRestoreDelay = .zero
        let range = try fixture.select("Passage 8:")
        try fixture.placeLine(of: range, at: 450)
        let before = try #require(placement(text, in: scroll))
        #expect(text.selectionAnchor?.character == range.location)
        fixture.reflow(width: 200)
        // The reflow alone leaves the clip in place and the selection far below it.
        #expect(text.isRestoringSelection)
        let narrowed = try #require(placement(text, in: scroll))
        #expect(narrowed.offset > before.offset + 300)
        for _ in 0..<100 where text.isRestoringSelection { try? await Task.sleep(for: .milliseconds(10)) }
        let after = try #require(placement(text, in: scroll))
        #expect(abs(after.offset - before.offset) <= 1, "\(before) → \(after)")
        #expect(after.visible)
    }

    /// Command-drag adds passages: an earlier one scrolled away must not hide the one on screen
    /// (source review of 789bfb4: the first range alone left no anchor).
    @Test func aVisiblePassageOfAMultipleSelectionKeepsItsHeight() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let fixture = AppKitFixture()
        defer { fixture.window.close() }
        let (text, scroll) = (fixture.text, fixture.scroll)
        text.selectionRestoreDelay = .zero
        let early = try fixture.range(of: "Passage 1:")
        let late = try fixture.range(of: "Passage 8:")
        #expect(fixture.window.makeFirstResponder(text))
        text.setSelectedRanges([NSValue(range: early), NSValue(range: late)], affinity: .downstream, stillSelecting: false)
        try fixture.placeLine(of: late, at: 450)
        let before = try #require(lineOffset(text, at: late.location, in: scroll))
        let earlier = try #require(lineOffset(text, at: early.location, in: scroll))
        #expect(earlier < 0, "the earlier passage is scrolled away")
        #expect(text.selectionAnchor?.character == late.location)
        fixture.reflow(width: 200)
        for _ in 0..<100 where text.isRestoringSelection { try? await Task.sleep(for: .milliseconds(10)) }
        let after = try #require(lineOffset(text, at: late.location, in: scroll))
        #expect(abs(after - before) <= 1, "\(before) → \(after)")
    }

    /// A drag still selecting is a newer intent: it cancels a pending restore at once and leaves no
    /// anchor until it ends (source review of 789bfb4).
    @Test func aSelectionStillBeingDraggedCancelsAPendingRestore() throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let fixture = AppKitFixture()
        defer { fixture.window.close() }
        let text = fixture.text
        let range = try fixture.select("Passage 8:")
        try fixture.placeLine(of: range, at: 450)
        #expect(text.selectionAnchor != nil)
        text.selectionRestoreDelay = .seconds(30)
        fixture.reflow(width: 200)
        #expect(text.isRestoringSelection)
        let drag = NSRange(location: range.location, length: 30)
        text.setSelectedRanges([NSValue(range: drag)], affinity: .downstream, stillSelecting: true)
        #expect(!text.isRestoringSelection && text.selectionAnchor == nil)
        fixture.reflow(width: 300)
        #expect(!text.isRestoringSelection, "no restore is scheduled from inside a drag")
        text.setSelectedRanges([NSValue(range: drag)], affinity: .downstream, stillSelecting: false)
        #expect(!text.isRestoringSelection)
    }

    /// Feed prose has a reading position, which owns the viewport (ConversationReadingPosition).
    @Test func feedProseLeavesTheViewportToItsReadingPosition() throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let fixture = AppKitFixture()
        defer { fixture.window.close() }
        let state = ConversationFeedState()
        fixture.text.readingPosition = state.readingPosition
        let range = try fixture.select("Passage 8:")
        try fixture.placeLine(of: range, at: 450)
        let y = fixture.scroll.contentView.bounds.minY
        fixture.reflow(width: 200)
        #expect(fixture.text.selectionAnchor == nil && !fixture.text.isRestoringSelection)
        #expect(fixture.scroll.contentView.bounds.minY == y)
    }

    /// Run details narrowing, the measured loss: the selection sits low in the 620-point inspector.
    @Test(arguments: [false, true]) func runDetailsKeepAVisibleSelectionWhenNarrowed(legacy: Bool) async throws {
        try await keepsSelection(from: 620, to: 340, selecting: "Passage 30:", at: 0.82, legacy: legacy)
    }

    /// Widening shortens the answer, so the clip is clamped before the prose gets its new frame.
    @Test(arguments: [false, true]) func runDetailsKeepAVisibleSelectionWhenWidened(legacy: Bool) async throws {
        try await keepsSelection(from: 340, to: 620, selecting: "Passage 24:", at: 0.15, legacy: legacy)
    }

    /// Focus moved away; the inactive selection is still drawn and still the reader's place.
    @Test func runDetailsKeepAnInactiveSelection() async throws {
        try await keepsSelection(from: 620, to: 340, selecting: "Passage 30:", at: 0.82, legacy: false) { window in
            _ = window.makeFirstResponder(nil)
        }
    }

    /// An insertion point (a click without a drag) is not a selected passage: the column keeps its
    /// offset through the round trip, as before #520.
    @Test func runDetailsWithoutASelectionKeepTheirOffset() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let (host, window) = try runDetails(Self.split, width: 620)
        defer { window.close() }
        await settle(host, count: 10)
        let reading = try prose(startingWith: "After table 0:", in: host)
        let scroll = try #require(outerScroll(of: reading))
        #expect(window.makeFirstResponder(reading))
        reading.setSelectedRange(NSRange(location: 0, length: 0))
        try read(into: reading, in: scroll, at: 0.6)
        await settle(host)
        let y = scroll.contentView.bounds.minY
        for width in [340.0, 620.0] {
            await resize(host, window, width: width)
            await settle(host, count: 6)
            #expect(abs(scroll.contentView.bounds.minY - y) < 0.5, "offset moved at \(width) pt")
            #expect(proseViews(in: host).allSatisfy { $0.selectionAnchor == nil && !$0.isRestoringSelection })
        }
    }

    /// A selection the reader scrolled away from stays behind; the width change pulls nobody back.
    @Test func runDetailsLeaveASelectionScrolledOutOfView() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let (host, window) = try runDetails(Self.split, width: 620)
        defer { window.close() }
        await settle(host, count: 10)
        let selected = try select("Before table 3:", in: host, window: window)
        #expect(selected.selectionAnchor != nil)
        let reading = try prose(startingWith: "After table 0:", in: host)
        let scroll = try #require(outerScroll(of: reading))
        try read(into: reading, in: scroll, at: 0.6)
        await settle(host)
        #expect(selected.selectionAnchor == nil)
        let y = scroll.contentView.bounds.minY
        await resize(host, window, width: 340)
        await settle(host, count: 6)
        #expect(!selected.isRestoringSelection)
        #expect(abs(scroll.contentView.bounds.minY - y) < 0.5)
    }

    /// While a restore waits for the width to settle, the reader's own scrolling or a new selection wins.
    @Test(arguments: ["gesture", "keys", "selection"])
    func aPendingRestoreYieldsToTheReader(intent: String) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let (host, window) = try runDetails(Self.passages(40, "Passage"), width: 620)
        defer { window.close() }
        await settle(host, count: 10)
        let prose = try select("Passage 30:", in: host, window: window)
        let scroll = try #require(outerScroll(of: prose))
        try place(prose, in: scroll, at: 0.82)
        await settle(host)
        #expect(prose.selectionAnchor != nil)
        // Held, so the newer intent always meets the restore pending (#530).
        prose.selectionRestoreDelay = .seconds(30)
        await resize(host, window, width: 340)
        #expect(prose.isRestoringSelection)
        #expect(placement(prose, in: scroll)?.visible == false)
        switch intent {
        case "gesture":
            NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        case "keys":
            prose.keyDown(with: try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\u{F72D}",
                charactersIgnoringModifiers: "\u{F72D}", isARepeat: false, keyCode: 121)))
        default:
            prose.setSelectedRange(NSRange(location: prose.selectedRange().location, length: 20))
        }
        #expect(!prose.isRestoringSelection)
        await settle(host, count: 6)
        #expect(placement(prose, in: scroll)?.visible == false)
    }

    /// A wheel goes to the view under the pointer, so over neighbouring prose or padding the selected
    /// prose never sees it, yet it scrolls the same column; that scrolling must still replace the
    /// pending restore and leave the reader where the wheel took them. The wheel is a synthetic classic
    /// line wheel dispatched as AppKit dispatches one (`sendWheel`), not hardware input. On macOS 26.4
    /// the column reports it as live scrolling, which the follower's live-scroll observer turns into
    /// the cancel.
    @Test(arguments: ["prose", "padding"])
    func aWheelOverANeighbourCancelsAPendingRestore(over target: String) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.accessory)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let fixture = AppKitFixture()
        defer { fixture.window.close() }
        fixture.window.orderFrontRegardless()
        let (text, scroll) = (fixture.text, fixture.scroll)
        let range = try fixture.select("Passage 8:")
        try fixture.placeLine(of: range, at: 450)
        #expect(text.selectionAnchor != nil)
        text.selectionRestoreDelay = .seconds(2)
        fixture.reflow(width: 200)
        #expect(text.isRestoringSelection)
        let point = try fixture.neighbour(prose: target == "prose")
        let pending = scroll.contentView.bounds.minY
        try sendWheel(lines: -3, at: point, in: fixture.window)
        let scrolled = await settledOffset(of: scroll)
        print("#520 wheel over \(target): \(pending) → \(scrolled) restoring=\(text.isRestoringSelection)")
        #expect(abs(scrolled - pending) >= 1, "the wheel scrolled the column: \(pending) → \(scrolled)")
        #expect(!text.isRestoringSelection, "the reader's wheel replaces the pending restore")
        try? await Task.sleep(for: .milliseconds(2_300))
        #expect(abs(scroll.contentView.bounds.minY - scrolled) < 0.5,
            "a restore moved the reader: \(scrolled) → \(scroll.contentView.bounds.minY)")
    }

    /// A wheel in another window or over another scroll view of the same window scrolls its own
    /// target, and the column's pending restore still brings the selection back to its height.
    @Test(arguments: ["window", "scroll view"])
    func aWheelElsewhereLeavesAPendingRestore(elsewhere: String) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.accessory)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let fixture = AppKitFixture()
        defer { fixture.window.close() }
        fixture.window.orderFrontRegardless()
        let (text, scroll) = (fixture.text, fixture.scroll)
        let range = try fixture.select("Passage 8:")
        try fixture.placeLine(of: range, at: 450)
        let before = try #require(lineOffset(text, at: range.location, in: scroll))
        text.selectionRestoreDelay = .seconds(2)
        fixture.reflow(width: 200)
        #expect(text.isRestoringSelection)
        let other = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300), styleMask: [.borderless],
            backing: .buffered, defer: false)
        other.isReleasedWhenClosed = false
        defer { other.close() }
        let target: NSScrollView
        switch elsewhere {
        case "window":
            let column = tallColumn(NSRect(x: 0, y: 0, width: 300, height: 300))
            other.contentView = column
            other.orderFrontRegardless()
            target = column
            try sendWheel(lines: -3, at: NSPoint(x: 150, y: 150), in: other)
        default:
            let column = tallColumn(NSRect(x: 410, y: 0, width: 180, height: 600))
            fixture.window.contentView?.addSubview(column)
            target = column
            try sendWheel(lines: -3, at: NSPoint(x: 500, y: 300), in: fixture.window)
        }
        let offset = await settledOffset(of: target)
        #expect(abs(offset - 1_000) >= 1, "the wheel scrolled its own target: \(offset)")
        #expect(text.isRestoringSelection, "a wheel outside the column leaves the restore pending")
        for _ in 0..<400 where text.isRestoringSelection { try? await Task.sleep(for: .milliseconds(10)) }
        let after = try #require(lineOffset(text, at: range.location, in: scroll))
        #expect(abs(after - before) <= 1, "the selection is back at its height: \(before) → \(after)")
    }

    /// The hosts of a split answer share one scroll view. With host A's restore pending, a selection
    /// begun, a caret or a scroll key in host B is the reader's new place: A's restore ends at once and
    /// a further reflow does not bring A's selection back. Focus merely moving to B leaves it pending.
    @Test(arguments: ["selecting", "caret", "scroll key"])
    func anotherHostsNewIntentEndsAKeptSelection(intent: String) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let fixture = AppKitFixture()
        defer { fixture.window.close() }
        let a = fixture.text
        let range = try fixture.select("Passage 8:")
        try fixture.placeLine(of: range, at: 450)
        #expect(a.selectionAnchor != nil)
        let b = fixture.host()
        a.selectionRestoreDelay = .seconds(30)
        fixture.reflow(width: 200)
        #expect(a.isRestoringSelection)
        #expect(fixture.window.makeFirstResponder(b))
        #expect(a.isRestoringSelection, "focus moving to B leaves A's restore pending")
        switch intent {
        case "selecting":
            b.setSelectedRanges([NSValue(range: NSRange(location: 0, length: 12))], affinity: .downstream, stillSelecting: true)
        case "caret":
            b.setSelectedRange(NSRange(location: 4, length: 0))
        default:
            b.keyDown(with: try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                timestamp: 0, windowNumber: fixture.window.windowNumber, context: nil, characters: "\u{F72D}",
                charactersIgnoringModifiers: "\u{F72D}", isARepeat: false, keyCode: 121)))
        }
        #expect(!a.isRestoringSelection && a.selectionAnchor == nil, "B's \(intent) ends A's keeping at once")
        a.selectionRestoreDelay = .zero
        fixture.reflow(width: 300)
        try? await Task.sleep(for: .milliseconds(200))
        #expect(!a.isRestoringSelection && a.selectionAnchor == nil, "a further reflow brings A's selection back")
    }

    /// Only a host of the same scroll view in the reader's hands takes over: a caret in prose of
    /// another scroll view or window, or a programmatic caret in an unfocused host, leaves A's restore
    /// to bring its selection back.
    @Test(arguments: ["scroll view", "window", "unfocused host"])
    func aCaretElsewhereLeavesAKeptSelection(elsewhere: String) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let fixture = AppKitFixture()
        defer { fixture.window.close() }
        let (a, scroll) = (fixture.text, fixture.scroll)
        let range = try fixture.select("Passage 8:")
        try fixture.placeLine(of: range, at: 450)
        let before = try #require(lineOffset(a, at: range.location, in: scroll))
        a.selectionRestoreDelay = .seconds(2)
        fixture.reflow(width: 200)
        #expect(a.isRestoringSelection)
        let other = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300), styleMask: [.borderless],
            backing: .buffered, defer: false)
        other.isReleasedWhenClosed = false
        defer { other.close() }
        let b: ProseTextView
        switch elsewhere {
        case "scroll view":
            let column = tallColumn(NSRect(x: 410, y: 0, width: 180, height: 600))
            fixture.window.contentView?.addSubview(column)
            b = proseHost(in: column)
            #expect(fixture.window.makeFirstResponder(b))
        case "window":
            let column = tallColumn(NSRect(x: 0, y: 0, width: 300, height: 300))
            other.contentView = column
            b = proseHost(in: column)
            #expect(other.makeFirstResponder(b))
        default:
            b = fixture.host()
        }
        b.setSelectedRange(NSRange(location: 4, length: 0))
        #expect(a.isRestoringSelection, "A's restore is still pending")
        for _ in 0..<400 where a.isRestoringSelection { try? await Task.sleep(for: .milliseconds(10)) }
        let after = try #require(lineOffset(a, at: range.location, in: scroll))
        #expect(abs(after - before) <= 1, "A's selection is back at its height: \(before) → \(after)")
    }

    // MARK: Run details

    private func keepsSelection(from: CGFloat, to: CGFloat, selecting prefix: String, at fraction: CGFloat,
                                legacy: Bool, before change: ((NSWindow) -> Void)? = nil) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let (host, window) = try runDetails(Self.passages(40, "Passage"), width: from)
        defer { window.close() }
        await settle(host, count: 10)
        if legacy {
            for scroll in views(host).compactMap({ $0 as? NSScrollView }) where scroll.hasVerticalScroller {
                scroll.scrollerStyle = .legacy
                scroll.tile()
            }
            await settle(host)
        }
        let prose = try select(prefix, in: host, window: window)
        let scroll = try #require(outerScroll(of: prose))
        try place(prose, in: scroll, at: fraction)
        await settle(host)
        change?(window)
        await settle(host)
        let before = try #require(placement(prose, in: scroll))
        #expect(before.visible, "the selection must be on screen before the width changes: \(before)")
        #expect(prose.selectionAnchor != nil)
        let size = prose.bounds.size
        for width in [to, from] {
            await resize(host, window, width: width)
            for _ in 0..<100 where prose.isRestoringSelection { await settle(host, count: 1) }
            let after = try #require(placement(prose, in: scroll))
            print("#520 \(from)→\(width) legacy=\(legacy): \(before) → \(after) prose=\(prose.bounds.size)")
            if width == to {
                // The answer really reflowed, not just its window.
                #expect(abs(prose.bounds.width - size.width) > 100 && abs(prose.bounds.height - size.height) > 1_000)
            }
            #expect(after.visible, "selection off screen at \(width) pt: \(after)")
            #expect(abs(after.offset - before.offset) <= after.lineHeight, "\(before) → \(after)")
        }
    }

    /// RunOutcomeSection in a copy of ThreadWorkspacePanel's scroll column (`panel`); the column's
    /// Run details expansion is private state, and the inspector's divider is not part of this host.
    private func runDetails(_ answer: String, width: CGFloat) throws -> (NSView, NSWindow) {
        var run = try HistoryMockupFixtures.make(count: 1, short: true).1[0]
        run.mode = .ask
        run.answerText = answer
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        let host = NSHostingView(rootView: RunDetailsColumn(run: run).environment(model))
        host.sizingOptions = []
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = NSRect(x: 0, y: 0, width: width, height: 700)
        return (host, window)
    }

    private static func passages(_ count: Int, _ prefix: String) -> String {
        (0..<count).map { "\(prefix) \($0): " + HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n")
    }

    private static var split: String {
        passages(16, "Before table") + "\n\n" + HistoryMockupFixtures.table + "\n\n" + passages(24, "After table")
    }

    private func select(_ prefix: String, in host: NSView, window: NSWindow) throws -> ProseTextView {
        let prose = try #require(proseViews(in: host).first { $0.string.contains(prefix) })
        let start = (prose.string as NSString).range(of: prefix).location
        #expect(window.makeFirstResponder(prose))
        prose.setSelectedRange(NSRange(location: start, length: min(90, prose.string.utf16.count - start)))
        return prose
    }

    /// Scrolls so the selection's middle sits at `fraction` of the visible height.
    private func place(_ prose: ProseTextView, in scroll: NSScrollView, at fraction: CGFloat) throws {
        let rect = try #require(selectionRect(prose, in: scroll))
        scroll.contentView.scroll(to: NSPoint(x: 0, y: rect.midY - scroll.contentView.bounds.height * fraction))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    /// Scrolls the viewport top `fraction` into `prose`.
    private func read(into prose: ProseTextView, in scroll: NSScrollView, at fraction: CGFloat) throws {
        let document = try #require(scroll.documentView)
        let frame = prose.convert(prose.bounds, to: document)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: frame.minY + frame.height * fraction))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    private func resize(_ host: NSView, _ window: NSWindow, width: CGFloat) async {
        let height = host.bounds.height
        window.setContentSize(NSSize(width: width, height: height))
        host.setFrameSize(NSSize(width: width, height: height))
        await settle(host)
    }

    private func prose(startingWith prefix: String, in host: NSView) throws -> ProseTextView {
        try #require(proseViews(in: host).first { $0.string.hasPrefix(prefix) })
    }

    private func proseViews(in host: NSView) -> [ProseTextView] { views(host).compactMap { $0 as? ProseTextView } }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
    private func settle(_ host: NSView, count: Int = 4) async {
        for _ in 0..<count { host.layoutSubtreeIfNeeded(); try? await Task.sleep(for: .milliseconds(60)) }
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
}

}

/// Where a selection is in its scroll view: its first line's distance from the viewport top.
private struct Placement: CustomStringConvertible {
    let offset: CGFloat
    let lineHeight: CGFloat
    let visible: Bool
    let clipY: CGFloat
    var description: String { "offset \(offset), line \(lineHeight), visible \(visible), clip y \(clipY)" }
}

@MainActor private func selectionRect(_ prose: ProseTextView, in scroll: NSScrollView) -> NSRect? {
    guard let layout = prose.layoutManager, let container = prose.textContainer,
          let document = scroll.documentView, prose.selectedRange().length > 0 else { return nil }
    let glyphs = layout.glyphRange(forCharacterRange: prose.selectedRange(), actualCharacterRange: nil)
    return prose.convert(layout.boundingRect(forGlyphRange: glyphs, in: container)
        .offsetBy(dx: prose.textContainerOrigin.x, dy: prose.textContainerOrigin.y), to: document)
}

/// The distance from the viewport top to the top of `character`'s line.
@MainActor private func lineOffset(_ prose: ProseTextView, at character: Int, in scroll: NSScrollView) -> CGFloat? {
    guard let layout = prose.layoutManager, let document = scroll.documentView else { return nil }
    let line = layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: character), effectiveRange: nil)
        .offsetBy(dx: prose.textContainerOrigin.x, dy: prose.textContainerOrigin.y)
    return prose.convert(line, to: document).minY - scroll.contentView.bounds.minY
}

@MainActor private func placement(_ prose: ProseTextView, in scroll: NSScrollView) -> Placement? {
    guard let rect = selectionRect(prose, in: scroll), let layout = prose.layoutManager,
          let document = scroll.documentView else { return nil }
    let glyph = layout.glyphIndexForCharacter(at: prose.selectedRange().location)
    let line = prose.convert(layout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
        .offsetBy(dx: prose.textContainerOrigin.x, dy: prose.textContainerOrigin.y), to: document)
    let clip = scroll.contentView.bounds
    return Placement(offset: line.minY - clip.minY, lineHeight: line.height,
        visible: rect.minY >= clip.minY - 0.5 && rect.maxY <= clip.maxY + 0.5, clipY: clip.minY)
}

/// ThreadWorkspacePanel's scroll column around the real RunOutcomeSection that Run details expands.
private struct RunDetailsColumn: View {
    let run: TaskRun
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                RunOutcomeSection(task: run, locationID: .local)
            }
            .padding(Theme.Spacing.xxl)
            .frame(maxWidth: Theme.Layout.contentMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }
        .scrollContentBackground(.hidden)
    }
}

/// Prose in an AppKit scroll view whose flipped document is sized like SwiftUI's.
@MainActor private struct AppKitFixture {
    let window: NSWindow
    let scroll: NSScrollView
    let document: NSView
    let text: ProseTextView
    let source: ProseDocument

    init() {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
        scroll.hasVerticalScroller = true
        let document = FlippedColumn(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
        scroll.documentView = document
        let source = ProseBuilder.plain((0..<12).map { "Passage \($0): " + HistoryMockupFixtures.paragraph($0) }
            .joined(separator: "\n\n"))
        let text = ProseTextView.make()
        text.textStorage?.setAttributedString(source.text)
        document.addSubview(text)
        // Room beside the column for another scroll area of the same window.
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 600))
        content.addSubview(scroll)
        let window = NSWindow(contentRect: content.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = content
        self.window = window
        self.scroll = scroll
        self.document = document
        self.text = text
        self.source = source
        reflow(width: 400)
    }

    /// What SwiftUI does to the column: the document and the prose take the new measured height.
    func reflow(width: CGFloat) {
        let height = ProseMeasurer.shared.height(source, width: width)
        document.setFrameSize(NSSize(width: 400, height: height + 600))
        text.setFrameSize(NSSize(width: width, height: height))
    }

    func range(of prefix: String) throws -> NSRange {
        let start = (text.string as NSString).range(of: prefix).location
        try #require(start != NSNotFound)
        return NSRange(location: start, length: 90)
    }

    func select(_ prefix: String) throws -> NSRange {
        let range = try range(of: prefix)
        #expect(window.makeFirstResponder(text))
        text.setSelectedRange(range)
        return range
    }

    /// Scrolls so the selection's first line is `offset` points below the viewport top.
    func placeLine(of range: NSRange, at offset: CGFloat) throws {
        let layout = try #require(text.layoutManager)
        let line = layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: range.location),
            effectiveRange: nil).offsetBy(dx: text.textContainerOrigin.x, dy: text.textContainerOrigin.y)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: text.convert(line, to: document).minY - offset))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    /// Another host of the same answer: prose in the same column, below this one's text.
    func host() -> ProseTextView {
        let host = ProseTextView.make()
        host.textStorage?.setAttributedString(ProseBuilder.plain("After the table: more of the answer.").text)
        host.frame = NSRect(x: 0, y: document.frame.height - 400, width: 400, height: 200)
        document.addSubview(host)
        return host
    }

    /// A window point on screen beside the narrowed prose: over a neighbouring ProseTextView placed
    /// there, as Run details puts prose after a table, or over the bare column (padding).
    func neighbour(prose: Bool) throws -> NSPoint {
        let top = scroll.contentView.bounds.minY
        var expected: NSView = document
        if prose {
            let neighbour = ProseTextView.make()
            neighbour.textStorage?.setAttributedString(ProseBuilder.plain("A neighbouring paragraph.").text)
            neighbour.frame = NSRect(x: 220, y: top + 40, width: 160, height: 240)
            document.addSubview(neighbour)
            expected = neighbour
        }
        let point = document.convert(NSPoint(x: 300, y: top + (prose ? 160 : 420)), to: nil)
        let hit = window.contentView?.hitTest(point)
        try #require(hit === expected, "the pointer is over \(String(describing: hit))")
        return point
    }
}

/// A scroll view of its own, at the middle of a tall empty document.
@MainActor private func tallColumn(_ frame: NSRect) -> NSScrollView {
    let column = NSScrollView(frame: frame)
    column.hasVerticalScroller = true
    column.documentView = FlippedColumn(frame: NSRect(x: 0, y: 0, width: frame.width, height: 3_000))
    column.contentView.scroll(to: NSPoint(x: 0, y: 1_000))
    column.reflectScrolledClipView(column.contentView)
    return column
}

/// Prose inside `column`, at its current viewport.
@MainActor private func proseHost(in column: NSScrollView) -> ProseTextView {
    let prose = ProseTextView.make()
    prose.textStorage?.setAttributedString(ProseBuilder.plain("Prose of another scroll view.").text)
    prose.frame = NSRect(x: 0, y: column.contentView.bounds.minY + 20, width: column.frame.width - 20, height: 200)
    column.documentView?.addSubview(prose)
    return prose
}

/// A classic line-based mouse wheel (synthetic, not hardware): a CGEvent at the global location of
/// `point`, attached to `window`, through both halves of AppKit's dispatch of a real wheel.
/// NSApplication.sendEvent runs the local event monitors; without a window-server window number it
/// forwards a synthetic wheel to no window, so the window's own sendEvent then delivers it to the
/// view under the pointer, which needs the window on screen. Posted to the application's queue
/// instead, the wheel came back as a copy without the window and the run ended early with status 0.
@MainActor private func sendWheel(lines: Int32, at point: NSPoint, in window: NSWindow) throws {
    let primary = try #require(NSScreen.screens.first, "global coordinates need the primary display")
    let screen = window.convertPoint(toScreen: point)
    let wheel = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
        wheel1: lines, wheel2: 0, wheel3: 0))
    wheel.location = CGPoint(x: screen.x, y: primary.frame.height - screen.y)
    wheel.flags = []
    wheel.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
    wheel.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
    let event = try #require(NSEvent(cgEvent: wheel))
    let attached = event.window === window
    if !attached {
        // +[NSEvent eventWithCGEvent:] leaves the window unset; attach it as Chromium's test events do.
        try #require(class_getInstanceVariable(NSEvent.self, "_window") != nil, "NSEvent has no _window")
        event.setValue(window, forKey: "_window")
    }
    try #require(event.window === window)
    let local = event.locationInWindow
    try #require(abs(local.x - point.x) < 1 && abs(local.y - point.y) < 1, "event at \(local), meant \(point)")
    try #require(window.isVisible, "the window delivers a wheel to its views only on screen")
    print("#520 wheel \(lines) at \(point) window=\(attached ? "from CGEvent" : "attached") delta=\(event.scrollingDeltaY)")
    NSApplication.shared.sendEvent(event)
    window.sendEvent(event)
}

/// A scroll view's offset once a wheel's scrolling, animated or not, has come to rest.
@MainActor private func settledOffset(of scroll: NSScrollView) async -> CGFloat {
    var last = scroll.contentView.bounds.minY
    for _ in 0..<20 {
        try? await Task.sleep(for: .milliseconds(50))
        let now = scroll.contentView.bounds.minY
        if abs(now - last) < 0.01 { return now }
        last = now
    }
    return last
}

private final class FlippedColumn: NSView {
    override var isFlipped: Bool { true }
}
