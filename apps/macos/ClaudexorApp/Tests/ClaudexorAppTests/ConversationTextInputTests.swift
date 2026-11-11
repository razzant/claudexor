import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct ConversationTextInputTests {
    @Test(arguments: [false, true])
    func typingInMessageMovesToComposerWithoutLosingFirstCharacter(selected: Bool) async throws {
        let policy = NSApplication.shared.activationPolicy()
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let (host, window) = window(ThreadsScreen().environment(model))
        defer { window.close() }
        await settle(host)
        let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        let composer = try #require(views(host).compactMap { $0 as? NSTextField }.first { $0.isEditable })
        #expect(window.makeFirstResponder(message))
        message.setSelectedRange(NSRange(location: 0, length: selected ? 8 : 0))
        let sourceText = message.string
        // Navigation / selection keys do not become composer input.
        for (text, code) in [(" ", UInt16(49)), ("\u{F72C}", UInt16(116))] {
            message.keyDown(with: try key(text, code: code))
            #expect(window.firstResponder === message && composer.stringValue.isEmpty)
        }
        message.setSelectedRange(NSRange(location: 2, length: 0))
        message.keyDown(with: try key("\u{F702}", code: 123, modifiers: .shift))
        #expect(message.selectedRange().length == 1 && composer.stringValue.isEmpty)
        message.keyDown(with: try key("a", code: 0, modifiers: .command))
        #expect(window.firstResponder === message && composer.stringValue.isEmpty)
        // AppKit dispatches Command-A through the responder action, not keyDown.
        #expect(NSApp.sendAction(#selector(NSText.selectAll(_:)), to: window.firstResponder, from: nil))
        #expect(message.selectedRange().length == sourceText.utf16.count)
        message.setSelectedRange(NSRange(location: 0, length: selected ? 8 : 0))
        message.keyDown(with: try key("x", code: 7))
        #expect(composer.currentEditor() != nil && window.firstResponder === composer.currentEditor())
        #expect(composer.stringValue == "x")
        window.firstResponder?.keyDown(with: try key("y", code: 16))
        await settle(host)
        #expect(composer.stringValue == "xy")
        #expect(message.string == sourceText)
    }

    @Test func typingWithNoAvailableComposerDoesNothing() async throws {
        let policy = NSApplication.shared.activationPolicy()
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let (host, window) = window(ThreadsScreen().environment(model).disabled(true))
        defer { window.close() }
        await settle(host)
        let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        let text = message.string
        #expect(window.makeFirstResponder(message))
        message.keyDown(with: try key("x", code: 7))
        #expect(window.firstResponder === message && message.string == text)
        #expect(views(host).compactMap { $0 as? NSTextView }.allSatisfy { !$0.isEditable || $0.string.isEmpty })
        let isolated = ProseTextView.make()
        window.contentView = isolated
        isolated.string = "No composer"
        #expect(window.makeFirstResponder(isolated))
        isolated.keyDown(with: try key("x", code: 7))
        #expect(window.firstResponder === isolated && isolated.string == "No composer")
    }

    @Test func expandingAndCollapsingFocusedProseClearsOldKeysBeforeFollowerRecovery() async throws {
        let policy = NSApplication.shared.activationPolicy()
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 45)
        let history = try source.store(loaded: true)
        let turn = "mock-turn-44"
        let root = PromptBubble(prompt: HistoryMockupFixtures.prompt(44), turnID: turn)
            .environment(history.presentation).environment(\.proseMessageID, turn)
        let (host, window) = window(root)
        defer { window.close() }
        history.presentation.expanded["prompt:" + turn] = false
        await settle(host)
        for expanded in [true, false] {
            let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
            #expect(window.makeFirstResponder(message))
            message.setSelectedRange(NSRange(location: 0, length: 10))
            let oldKey = turn + ":" + (try #require(message.shownID))
            #expect(history.presentation.selectedMessages.contains(oldKey))
            #expect(history.presentation.focusedMessages.contains(oldKey))
            // These are the production Show more / Show less binding writes.
            history.presentation.expanded["prompt:" + turn] = expanded
            await settle(host)
            #expect(!history.presentation.selectedMessages.contains(oldKey))
            #expect(!history.presentation.focusedMessages.contains(oldKey))
        }
        let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        message.setSelectedRange(NSRange(location: 0, length: 0))
        #expect(window.makeFirstResponder(nil))
        #expect(history.presentation.selectedMessages.isEmpty && history.presentation.focusedMessages.isEmpty)
        history.following = true
        (source.detail, source.runs) = try HistoryMockupFixtures.make(count: 85, short: true)
        source.epoch = "after-expansion"
        await history.refresh()
        #expect(history.following && history.readingAnchor == nil)
        #expect(history.mountedIDs.last == "mock-turn-84" && !history.mountedIDs.contains(turn))
    }

    private func window<V: View>(_ root: V) -> (NSHostingView<V>, NSWindow) {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let host = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = window.frame
        return (host, window)
    }

    private func settle(_ host: NSView) async {
        for _ in 0..<3 {
            host.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(60))
        }
    }

    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }

    private func key(_ text: String, code: UInt16, modifiers: NSEvent.ModifierFlags = []) throws -> NSEvent {
        try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: 0, windowNumber: 0, context: nil, characters: text,
            charactersIgnoringModifiers: text, isARepeat: false, keyCode: code))
    }
}

}
