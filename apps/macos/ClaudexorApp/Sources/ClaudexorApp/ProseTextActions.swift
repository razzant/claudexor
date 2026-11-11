import AppKit
import SwiftUI

extension NSAttributedString.Key {
    static let proseCopyExcluded = Self("ClaudexorProseCopyExcluded")
    static let proseCodeSource = Self("ClaudexorProseCodeSource")
}

@MainActor enum ProseCodeActions {
    static func header(language: String?, source: String, index: Int,
                       paragraph: NSParagraphStyle, style: ProseStyle) -> NSAttributedString {
        let p = paragraph.mutableCopy() as! NSMutableParagraphStyle
        p.headIndent = 0
        p.paragraphSpacing = Theme.Spacing.sm
        let title = (language?.isEmpty == false ? language! : "text") + "    "
        let text = NSMutableAttributedString(string: title + label("Copy") + "\n", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: max(10, style.bodySize - 3), weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: p, .proseCopyExcluded: true
        ])
        text.addAttributes([.link: URL(string: "claudexor-code-copy://block/\(index)")!,
            .proseCodeSource: source, .toolTip: "Copy code"],
            range: NSRange(location: title.utf16.count, length: label("Copy").utf16.count))
        return text
    }

    // Fixed source indices while feedback changes: following prose and selected
    // source ranges never move when Copy becomes Copied / Copy failed.
    static func label(_ value: String) -> String { value.padding(toLength: 11, withPad: " ", startingAt: 0) }

    static func plainText(_ text: NSAttributedString, range: NSRange) -> String {
        projection(text, range: range).string
    }

    private static func projection(_ text: NSAttributedString, range: NSRange) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        text.enumerateAttribute(.proseCopyExcluded, in: range) { excluded, part, _ in
            if excluded as? Bool != true { result.append(text.attributedSubstring(from: part)) }
        }
        return result
    }

    static func writeSelection(_ text: NSAttributedString, range: NSRange, to pasteboard: NSPasteboard,
                               types: [NSPasteboard.PasteboardType]) -> Bool {
        // Export a detached projection, retaining native rich formats/attributes
        // without changing the painted storage, selection or reading character.
        let selected = projection(text, range: range)
        let exporter = NSTextView(frame: .zero)
        exporter.isRichText = true
        exporter.textStorage?.setAttributedString(selected)
        exporter.setSelectedRange(NSRange(location: 0, length: selected.length))
        let native = NSPasteboard.withUniqueName()
        defer { native.releaseGlobally() }
        native.declareTypes(types, owner: nil)
        _ = exporter.writeSelection(to: native, types: types)
        // Materialize native data before its owner goes away. Legacy AppKit type
        // names and their modern aliases both carry the filtered projection.
        var data: [NSPasteboard.PasteboardType: Data] = [:]
        for type in types { data[type] = native.data(forType: type) }
        for (type, bytes) in data { pasteboard.setData(bytes, forType: type) }
        guard types.contains(.string) else { return !data.isEmpty }
        pasteboard.addTypes([.string], owner: nil)
        return pasteboard.setString(selected.string, forType: .string) || !data.isEmpty
    }

    static func write(_ text: String, to pasteboard: NSPasteboard = .general) -> Bool {
        pasteboard.clearContents()
        return pasteboard.setString(text, forType: .string)
    }
}

extension ProseTextView {
    @discardableResult
    func copyCode(link: URL, at index: Int) -> Bool {
        guard link.scheme == "claudexor-code-copy", let storage = textStorage,
              index >= 0, index < storage.length,
              let source = storage.attribute(.proseCodeSource, at: index, effectiveRange: nil) as? String,
              storage.attribute(.link, at: index, effectiveRange: nil) as? URL == link else { return false }
        var range = NSRange()
        _ = storage.attribute(.proseCodeSource, at: index, effectiveRange: &range)
        let result = writeCopiedText(source)
        let attributes = storage.attributes(at: index, effectiveRange: nil)
        storage.replaceCharacters(in: range, with: NSAttributedString(
            string: ProseCodeActions.label(result ? "Copied" : "Copy failed"), attributes: attributes))
        copyFeedback[link]?.cancel()
        let identity = shownID
        copyFeedback[link] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1_200))
            guard !Task.isCancelled, let self, self.shownID == identity,
                  let storage = self.textStorage, NSMaxRange(range) <= storage.length else { return }
            storage.replaceCharacters(in: range, with: NSAttributedString(string: ProseCodeActions.label("Copy"), attributes: attributes))
            self.copyFeedback[link] = nil
        }
        return true
    }

    func cancelCopyFeedback() {
        copyFeedback.values.forEach { $0.cancel() }
        copyFeedback.removeAll()
    }

    func copyMessage(to pasteboard: NSPasteboard) -> Bool {
        guard let messageSource else { return false }
        return ProseCodeActions.write(messageSource, to: pasteboard)
    }

    @objc func copyMessage(_ sender: Any?) {
        if let copyMessageAction { copyMessageAction() }
        else if let messageSource { _ = writeCopiedText(messageSource) }
    }

    func codeAccessibilityActions() -> [NSAccessibilityElement] {
        guard let textStorage, let layoutManager, let textContainer, let window else { return [] }
        var actions: [NSAccessibilityElement] = []
        textStorage.enumerateAttribute(.proseCodeSource, in: NSRange(location: 0, length: textStorage.length)) { source, range, _ in
            guard source != nil, let link = textStorage.attribute(.link, at: range.location, effectiveRange: nil) as? URL else { return }
            let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let rect = layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer).offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
            let action = ProseCodeAccessibilityAction()
            action.setAccessibilityParent(self)
            action.setAccessibilityRole(.button)
            action.setAccessibilityLabel("Copy code")
            action.setAccessibilityHelp("Copy the block's exact source lines.")
            action.setAccessibilityFrame(window.convertToScreen(convert(rect, to: nil)))
            action.press = { [weak self] in
                guard let self, let coordinator = self.delegate as? ProseText.Coordinator else { return false }
                return coordinator.textView(self, clickedOnLink: link, at: range.location)
            }
            actions.append(action)
        }
        return actions
    }
}

private final class ProseCodeAccessibilityAction: NSAccessibilityElement {
    var press: (() -> Bool)?
    override func accessibilityPerformPress() -> Bool { press?() ?? false }
}

private struct ProseMessageSourceKey: EnvironmentKey { static let defaultValue: String? = nil }
private struct ProseMessageCopyActionKey: EnvironmentKey { static let defaultValue: (@MainActor () -> Void)? = nil }
extension EnvironmentValues {
    var proseMessageCopyAction: (@MainActor () -> Void)? {
        get { self[ProseMessageCopyActionKey.self] }
        set { self[ProseMessageCopyActionKey.self] = newValue }
    }
    var proseMessageSource: String? {
        get { self[ProseMessageSourceKey.self] }
        set { self[ProseMessageSourceKey.self] = newValue }
    }
}
