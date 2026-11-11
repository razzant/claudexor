import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct ProseExportAndPreviewTests {
    @Test func richSelectionExcludesCodeHeadersWithoutChangingTheLiveDocument() throws {
        let source = "**Before.**\n\n```swift\nlet first = 1\n  let second = first + 2\n```\n\nAfter."
        let doc = try #require(ProseBuilder.segments(source, style: .init()).compactMap {
            if case .prose(let doc) = $0.content { return doc }; return nil
        }.first)
        let view = ProseTextView.make()
        view.textStorage?.setAttributedString(doc.text)
        let range = NSRange(location: 0, length: doc.text.length)
        view.setSelectedRange(range)
        let original = view.attributedString()
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let types = view.writablePasteboardTypes + [.string]
        #expect(types.contains { $0 != .string && $0.rawValue != "NSStringPboardType" })
        board.declareTypes(types, owner: nil)
        #expect(view.writeSelection(to: board, types: types))
        for type in types {
            if type == .string || type.rawValue == "NSStringPboardType" {
                let text = try #require(board.string(forType: type))
                #expect(!text.contains("swift") && !text.contains("Copy"))
                #expect(text.contains("let first = 1\n  let second = first + 2"))
                continue
            }
            let data = try #require(board.data(forType: type))
            let exported = try NSAttributedString(data: data, options: [:], documentAttributes: nil)
            #expect(!exported.string.contains("swift") && !exported.string.contains("Copy"))
            #expect(exported.string.contains("let first = 1\n  let second = first + 2"))
            #expect(exported.string.hasPrefix("Before.") && exported.string.hasSuffix("After."))
            let font = try #require(exported.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
            #expect(NSFontManager.shared.traits(of: font).contains(.boldFontMask))
        }
        #expect(view.selectedRange() == range && view.attributedString().isEqual(to: original) == true)
    }

    @Test func fullPromptSheetDoesNotJoinTheFeedRegistryOrSelection() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let position = ConversationReadingPosition()
        let presentation = ConversationPresentation()
        let root = HistoryFullPromptSheet(prompt: String(repeating: "Full source words. ", count: 3_000))
            .environment(\.conversationReadingPosition, position).environment(\.proseMessageID, "feed-turn")
            .environment(presentation)
        let (host, window) = window(root)
        defer { window.close() }
        await settle(host)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        #expect(prose.readingPosition == nil && prose.messageID == nil)
        #expect(window.makeFirstResponder(prose))
        prose.setSelectedRange(NSRange(location: 0, length: 10))
        #expect(presentation.selectedMessages.isEmpty && presentation.focusedMessages.isEmpty)
    }

    /// A chat answer's file link presents the preview inside the feed's environment (#520 found the
    /// preview registered with the feed, paused its following and copied the presenting message).
    @Test func filePreviewSheetDoesNotJoinThePresentingFeedOrMessage() async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let position = ConversationReadingPosition()
        let presentation = ConversationPresentation()
        let markdown = "# Notes\n\n" + String(repeating: "Previewed file words. ", count: 400)
        let request = SafeFilePreviewRequest(
            url: FileManager.default.temporaryDirectory.appendingPathComponent("notes.md"), kind: .markdown,
            source: SafeFilePreviewRequest.BoundedSource(bytes: Data(markdown.utf8), wasTruncated: false))
        let root = SafeFilePreviewSheet(request: request)
            .environment(\.conversationReadingPosition, position).environment(\.proseMessageID, "feed-turn")
            .environment(\.proseMessageSource, "The presenting answer").environment(presentation)
        let (host, window) = window(root)
        defer { window.close() }
        await settle(host)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first {
            $0.string.contains("Previewed file words") })
        #expect(prose.readingPosition == nil && prose.messageID == nil)
        #expect(prose.messageSource == markdown)
        #expect(window.makeFirstResponder(prose))
        prose.setSelectedRange(NSRange(location: 0, length: 10))
        #expect(presentation.selectedMessages.isEmpty && presentation.focusedMessages.isEmpty)
    }

    @Test(arguments: [false, true])
    func collapsedSourceEndsOnAWordAndFillsTheWideFold(prompt: Bool) async throws {
        let policy = NSApplication.shared.activationPolicy()
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer { NSApplication.shared.setActivationPolicy(policy) }
        let text = (0..<24).map { HistoryMockupFixtures.paragraph($0) }.joined(separator: "\n\n")
        let root = prompt
            ? AnyView(PromptBubble(prompt: text, turnID: "older"))
            : AnyView(ConversationAnswerText(answer: text, expanded: .constant(false)))
        let (host, window) = window(root.frame(width: 680).fixedSize(horizontal: false, vertical: true))
        defer { window.close() }
        await settle(host)
        let prose = try #require(views(host).compactMap { $0 as? ProseTextView }.first)
        // Rendered paragraphs normalize blank lines, so compare the final word.
        let finalWord = try #require(prose.string.split(whereSeparator: { $0.isWhitespace }).last)
        let sourceWords = text.split(whereSeparator: { $0.isWhitespace })
        let completeWord = sourceWords.contains(finalWord)
        #expect(completeWord, "Preview ends with incomplete word: \(finalWord)")
        let frame = host.fittingSize
        let layout = try #require(prose.layoutManager)
        let container = try #require(prose.textContainer)
        layout.ensureLayout(for: container)
        // Source must extend beyond the fold. The visible bottom is the last
        // complete line below 260pt, plus Show more (and prompt bubble padding).
        #expect(layout.usedRect(for: container).height > 260)
        #expect(frame.height >= 260)
        #expect(prose.string.count < text.count)
    }

    @Test func previewSuppliesTheWideFoldEvenAtTheSmallestBodyFont() {
        let source = String(repeating: "iii ", count: 4_000)
        let preview = ConversationPreviewText.prefix(source)
        let document = ProseBuilder.plain(preview, style: .make(body: true, size: .xSmall))
        #expect(ProseMeasurer.shared.height(document, width: 680) > 260)
        #expect(preview.hasSuffix("iii") && preview.count < source.count)
        let token = String(repeating: "n", count: 7_000)
        let preservedIndentation = ConversationPreviewText.prefix("  " + token + " next word") == "  " + token
        #expect(preservedIndentation)
    }

    private func window<V: View>(_ root: V) -> (NSHostingView<V>, NSWindow) {
        let host = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = window.frame
        return (host, window)
    }
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
    private func settle(_ host: NSView) async {
        for _ in 0..<4 { host.layoutSubtreeIfNeeded(); try? await Task.sleep(for: .milliseconds(60)) }
    }
}

}
