import AppKit
import Carbon
import SwiftUI
import Testing
@testable import ClaudexorApp

extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct ComposerDraftInputTests {
    @Test(arguments: [false, true])
    func typingRestoresAnExistingSelectionOrUsesTheUnfocusedDraftEnd(selected: Bool) async throws {
        try await withScreen(draft: "existing draft") { host, window, message, composer in
            if selected {
                #expect(window.makeFirstResponder(composer))
                let editor = try #require(composer.currentEditor() as? NSTextView)
                editor.setSelectedRange(NSRange(location: 8, length: 5))
            } else { #expect(composer.currentEditor() == nil) }
            #expect(window.makeFirstResponder(message))
            window.sendEvent(try key("x", code: 7, window: window))
            await settle(host)
            #expect(composer.stringValue == (selected ? "existingxt" : "existing draftx"))
            #expect(window.firstResponder === composer.currentEditor())
        }
    }

    @Test(arguments: ["x", "ж"])
    func emptyComposerReceivesTheOriginalPrintableKey(text: String) async throws {
        try await withScreen { host, window, message, composer in
            #expect(window.makeFirstResponder(message))
            window.sendEvent(try key(text, code: 7, window: window))
            await settle(host)
            #expect(composer.stringValue == text)
            #expect(window.firstResponder === composer.currentEditor())
        }
    }

    @Test func deadKeyBeginsCompositionInTheComposer() async throws {
        // AppKit receives characters already translated by the keyboard layout.
        // Retain the dead-key state across both physical keys without changing
        // the machine's selected input source or faking the composed character.
        let filter = [kTISPropertyInputSourceID as String: "com.apple.keylayout.US"] as CFDictionary
        let sources = try #require(TISCreateInputSourceList(filter, true)).takeRetainedValue() as NSArray
        let source = try #require(sources.firstObject) as! TISInputSource
        let pointer = try #require(TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData))
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue()
        let layout = UnsafeRawPointer(CFDataGetBytePtr(data)).assumingMemoryBound(to: UCKeyboardLayout.self)
        var deadState: UInt32 = 0
        func translated(option: Bool) throws -> String {
            var characters = [UniChar](repeating: 0, count: 8)
            var count = 0
            let status = UCKeyTranslate(layout, 14, UInt16(kUCKeyActionDown), option ? UInt32(optionKey >> 8) : 0,
                UInt32(LMGetKbdType()), 0, &deadState, characters.count, &count, &characters)
            #expect(status == noErr)
            return String(utf16CodeUnits: characters, count: count)
        }
        let dead = try translated(option: true)
        #expect(dead.isEmpty && deadState != 0)
        let composed = try translated(option: false)
        #expect(composed == "é")
        try await withScreen { host, window, message, composer in
            #expect(window.makeFirstResponder(message))
            window.sendEvent(try key(dead, code: 14, modifiers: .option, unmodified: "e", window: window))
            #expect(composer.currentEditor() != nil && window.firstResponder === composer.currentEditor())
            window.sendEvent(try key(composed, code: 14, unmodified: "e", window: window))
            await settle(host)
            #expect(composer.stringValue == "é")
        }
    }

    private func withScreen(draft: String = "",
        _ body: @MainActor (NSView, NSWindow, ProseTextView, NSTextField) async throws -> Void) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let source = try HistoryTestSource(count: 1)
        let model = HistoryMockupFixtures.model(detail: source.detail, runs: source.runs, source: source)
        let host = NSHostingView(rootView: ThreadsScreen(composerText: draft).environment(model))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = window.frame
        defer { window.close() }
        await settle(host)
        let message = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        let composer = try #require(views(host).compactMap { $0 as? NSTextField }.first { $0.isEditable })
        try await body(host, window, message, composer)
    }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
    private func settle(_ host: NSView) async {
        for _ in 0..<4 { host.layoutSubtreeIfNeeded(); try? await Task.sleep(for: .milliseconds(60)) }
    }
    private func key(_ text: String, code: UInt16, modifiers: NSEvent.ModifierFlags = [],
                     unmodified: String? = nil, window: NSWindow) throws -> NSEvent {
        try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: text,
            charactersIgnoringModifiers: unmodified ?? text, isARepeat: false, keyCode: code))
    }
}

}
