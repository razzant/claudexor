import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

@MainActor @Suite(.serialized)
struct ProseActionTests {
    @Test func codeHeadersCopySourceThroughTheDelegateAndStayOutOfSelection() async throws {
        let source = "let first = 1\n  let second = first + 2"
        let doc = try document("Before.\n\n```swift\n\(source)\n```\n\nAfter.")
        let view = ProseTextView.make()
        view.shownID = doc.id
        view.textStorage?.setAttributedString(doc.text)
        let coordinator = ProseText.Coordinator()
        view.delegate = coordinator
        var writes: [String] = []
        view.writeCopiedText = { writes.append($0); return true }
        let index = (view.string as NSString).range(of: "Copy").location
        let link = try #require(doc.text.attribute(.link, at: index, effectiveRange: nil) as? URL)
        #expect(view.string.contains("swift    Copy"))
        #expect(doc.text.attribute(.toolTip, at: index, effectiveRange: nil) as? String == "Copy code")
        let originalLength = view.string.utf16.count
        #expect(coordinator.textView(view, clickedOnLink: link, at: index))
        #expect(writes == [source] && view.string.contains("Copied"))
        #expect(view.string.utf16.count == originalLength)
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally(); view.cancelCopyFeedback() }
        view.setSelectedRange(NSRange(location: 0, length: originalLength))
        #expect(view.writeSelection(to: board, types: [.string]))
        let copied = try #require(board.string(forType: .string))
        #expect(copied.hasPrefix("Before.") && copied.contains(source) && copied.hasSuffix("After."))
        #expect(!copied.contains("swift") && !copied.contains("Copied"))
        // Even a malformed action is consumed; AppKit must never open this URL.
        #expect(coordinator.textView(view, clickedOnLink: link, at: 0))
        #expect(writes.count == 1)
        view.writeCopiedText = { _ in false }
        #expect(coordinator.textView(view, clickedOnLink: link, at: index))
        #expect(view.string.contains("Copy failed"))
        // The label returns after 1.2 s; a busy main actor may run that reset much later (#527).
        let deadline = ContinuousClock.now + .seconds(60)
        while view.string.contains("Copy failed"), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(view.string.contains("swift    Copy ") && !view.string.contains("Copy failed"))
        #expect(try document("```\nx\n```").text.string.hasPrefix("text    Copy"))
    }

    @Test func codeAccessibilityActionAndMessageMenuKeepNativeCopy() throws {
        let app = NSApplication.shared
        let policy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        defer { app.setActivationPolicy(policy) }
        let markdown = "**Before**\n\n```swift\nlet x = 1\n```"
        let doc = try document(markdown)
        let view = ProseTextView.make()
        view.textStorage?.setAttributedString(doc.text)
        view.messageSource = markdown
        let coordinator = ProseText.Coordinator()
        view.delegate = coordinator
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        defer { window.close(); view.cancelCopyFeedback() }
        var copied: [String] = []
        view.writeCopiedText = { copied.append($0); return true }
        let action = try #require(view.codeAccessibilityActions().first)
        #expect(action.accessibilityLabel() == "Copy code")
        #expect(action.accessibilityPerformPress())
        #expect(copied == ["let x = 1"])
        let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown, location: .zero,
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1))
        let menu = try #require(view.menu(for: event))
        #expect(menu.items.contains { $0.action == #selector(NSText.copy(_:)) })
        let item = try #require(menu.items.first { $0.title == "Copy message" })
        #expect(item.target === view && item.action == #selector(ProseTextView.copyMessage(_:)))
        view.copyMessage(item)
        #expect(copied.last == markdown)
        // A truncated prompt supplies a user-initiated full-source read instead.
        var requested = 0
        view.copyMessageAction = { requested += 1 }
        #expect(requested == 0)
        view.copyMessage(item)
        #expect(requested == 1 && copied.count == 2)
    }

    @Test func tableFadesOnlyIndicateHiddenColumnsAndFoldingUsesContent() {
        #expect(TableHiddenColumns(offset: 0, content: 300, viewport: 420) == TableHiddenColumns())
        let start = TableHiddenColumns(offset: 0, content: 900, viewport: 420)
        let middle = TableHiddenColumns(offset: 200, content: 900, viewport: 420)
        let end = TableHiddenColumns(offset: 480, content: 900, viewport: 420)
        #expect(!start.leading && start.trailing)
        #expect(middle.leading && middle.trailing)
        #expect(end.leading && !end.trailing)
        #expect(!TurnCard.isLongAnswer(String(repeating: "a", count: 1_200)))
        #expect(TurnCard.isLongAnswer(String(repeating: "a", count: 1_201)))
        #expect(TurnCard.isLongAnswer(Array(repeating: "line", count: 16).joined(separator: "\n")))
    }

    private func document(_ markdown: String) throws -> ProseDocument {
        try #require(ProseBuilder.segments(markdown, style: .init()).compactMap {
            if case .prose(let document) = $0.content { return document }
            return nil
        }.first)
    }
}
