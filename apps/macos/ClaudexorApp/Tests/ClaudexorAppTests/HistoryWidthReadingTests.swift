import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

@MainActor @Suite(.serialized)
struct HistoryWidthReadingTests {
    @Test(arguments: ["light", "dark"])
    func resizingPreservesTheReadingCharacterAndFollowing(name: String) async throws {
        try await Self.exercise(name: name)
    }

    static func exercise(name: String,
        capture: ((NSView, NSWindow, String, String, ConversationFeedState, [String: Any]) throws -> Void)? = nil) async throws {
        let app = NSApplication.shared
        let policy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        defer { app.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 3)
        source.runs[1].answerText = (0..<40).map { "Passage \($0): " + HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n")
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let history = try #require(model.selectedHistory)
        history.presentation.expanded["answer:mock-turn-1"] = true
        let state = ConversationFeedState()
        let scheme: ColorScheme = name == "dark" ? .dark : .light
        let root = ConversationFeed(state: state, history: history, routingOptions: .init())
            .environment(model).environment(\.colorScheme, scheme).tint(Theme.accent)
            .foregroundStyle(Color(nsColor: .labelColor), Color(nsColor: .secondaryLabelColor))
            .background(Theme.surfaceBase)
        let host = NSHostingView(rootView: root)
        host.sizingOptions = []
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.appearance = NSAppearance(named: name == "dark" ? .darkAqua : .aqua)
        host.appearance = window.appearance
        host.frame = window.frame
        defer { window.close() }
        await settle(host)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first { $0.string.hasPrefix("Passage 0:") })
        let layout = try #require(prose.layoutManager)
        let container = try #require(prose.textContainer)
        let range = (prose.string as NSString).range(of: "Passage 20:")
        #expect(range.location != NSNotFound)
        layout.ensureLayout(for: container)
        let glyph = layout.glyphIndexForCharacter(at: range.location)
        let line = layout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
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
        await settle(host)
        let passage = try #require(state.readingPosition.passage)
        #expect(passage.turnID == "mock-turn-1" && passage.character > 1_000)
        let before = try #require(state.readingPosition.lineOffset(for: passage))
        for (width, scene) in [(680.0, "19-width-change-before"), (420.0, "19-width-change-after"), (680.0, "19-width-change-restored")] {
            window.setContentSize(NSSize(width: width, height: 700))
            host.setFrameSize(NSSize(width: width, height: 700))
            await settle(host)
            let y = try #require(state.readingPosition.lineOffset(for: passage))
            #expect(abs(host.bounds.width - width) <= 1)
            #expect(abs(y - before) <= line.height)
            #expect(!history.following && history.readingAnchor == passage.turnID)
            let claim = "Column \(Int(width)) pt: turn \(passage.turnID), character \(passage.character), line y = \(y) pt (before \(before) pt); tolerance one line (\(line.height) pt)."
            print("WIDTH \(name): \(claim)")
            try capture?(host, window, scene, claim, state, ["anchor_character": passage.character,
                "anchor_turn_id": passage.turnID, "anchor_y": y, "anchor_before_y": before,
                "anchor_line_height": line.height, "column_width": width, "prose_width": prose.bounds.width])
        }
        await history.jump()
        await settle(host)
        window.setContentSize(NSSize(width: 420, height: 700))
        host.setFrameSize(NSSize(width: 420, height: 700))
        await settle(host)
        #expect(state.atBottom && history.following && history.readingAnchor == nil)
    }

    private static func settle(_ host: NSView) async {
        for _ in 0..<10 {
            host.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(60))
        }
    }
    private static func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
}
