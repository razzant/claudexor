import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

private final class ProseIdentityWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}
extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct ProseIdentityLifecycleTests {
    @Test(arguments: [false, true])
    func collapsingSelectedPromptThenEvictingClearsEveryFocusKey(blurBeforeCollapse: Bool) async throws {
        let app = NSApplication.shared
        let oldPolicy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        defer { app.setActivationPolicy(oldPolicy) }
        let presentation = ConversationPresentation()
        presentation.latestTurnID = "turn"
        let prompt = String(repeating: "A long selectable prompt with several words. ", count: 200)
        let host = NSHostingView(rootView: AnyView(PromptBubble(prompt: prompt, turnID: "turn")
            .environment(presentation).environment(\.proseMessageID, "turn")))
        let rect = NSRect(x: 0, y: 0, width: 700, height: 700)
        let window = ProseIdentityWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = rect
        defer { window.close() }
        await settle(host)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        #expect(window.makeFirstResponder(prose))
        prose.setSelectedRange(NSRange(location: 0, length: 10))
        await settle(host)
        let originalKeys = presentation.selectedMessages
        #expect(originalKeys.count >= 2 && !presentation.focusedMessages.isEmpty)
        if blurBeforeCollapse {
            #expect(window.makeFirstResponder(nil))
            await settle(host)
        }
        presentation.expanded["prompt:turn"] = false // the Show less button's action
        await settle(host)
        let collapsed = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        #expect(collapsed.string.count < prompt.count)
        print("PROMPT HOST REUSED: \(collapsed === prose)")
        collapsed.setSelectedRange(NSRange(location: 0, length: 0))
        #expect(window.makeFirstResponder(nil))
        await settle(host)
        #expect(presentation.selectedMessages.isEmpty)
        #expect(presentation.focusedMessages.isEmpty)
        host.rootView = AnyView(EmptyView()) // the same dismantling path used on eviction
        await settle(host)
        #expect(presentation.selectedMessages.isEmpty)
        #expect(presentation.focusedMessages.isEmpty)
        #expect(!window.isVisible)
    }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
    private func settle(_ view: NSView) async {
        for _ in 0..<5 {
            view.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(30))
        }
    }
}

}
