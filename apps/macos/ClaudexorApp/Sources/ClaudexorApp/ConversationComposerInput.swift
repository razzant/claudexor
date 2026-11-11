import AppKit
import SwiftUI

/// An explicit destination owned by this conversation, never the next editable
/// control in the window. Keep the user's native editor selection across blur.
@MainActor final class ConversationComposerInput: NSObject {
    weak var marker: NSView?
    var enabled = false
    private weak var selectedField: NSTextField?
    private var selectedText: String?
    private var selection = NSRange(location: 0, length: 0)
    private var restoringSelection = false

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(selectionChanged(_:)),
            name: NSTextView.didChangeSelectionNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func selectionChanged(_ notification: Notification) {
        guard !restoringSelection, let editor = notification.object as? NSTextView,
              let marker, let window = marker.window, window.firstResponder === editor,
              let root = window.contentView, let field = field(under: marker, in: root),
              field.currentEditor() === editor else { return }
        selectedField = field
        selectedText = editor.string
        selection = editor.selectedRange()
    }

    func forward(_ event: NSEvent, from message: NSView) {
        guard enabled, let marker, let window = marker.window, message.window === window,
              !marker.isHiddenOrHasHiddenAncestor, let root = window.contentView,
              let field = field(under: marker, in: root), field.isEnabled, field.isEditable,
              !field.isHiddenOrHasHiddenAncestor else { return }
        let length = field.stringValue.utf16.count
        let range = selectedField === field && selectedText == field.stringValue && NSMaxRange(selection) <= length
            ? selection : NSRange(location: length, length: 0)
        // Becoming first responder selects the entire field. Restore the selection
        // the user left before delivering the original event to AppKit's input method.
        restoringSelection = true
        let accepted = window.makeFirstResponder(field)
        let editor = field.currentEditor() as? NSTextView
        if accepted { editor?.setSelectedRange(range) }
        restoringSelection = false
        guard accepted, let editor, window.firstResponder === editor else { return }
        editor.keyDown(with: event)
    }

    private func field(under marker: NSView, in root: NSView) -> NSTextField? {
        // The marker is the text field's own background, before padding/chrome.
        // Hit-testing its centre resolves that native control, including SwiftUI
        // wrappers, without scanning for another editable field or moving focus.
        let centre = NSPoint(x: marker.bounds.midX, y: marker.bounds.midY)
        var hit = root.hitTest(marker.convert(centre, to: root.superview))
        while let view = hit {
            if let field = view as? NSTextField { return field }
            hit = view.superview
        }
        return nil
    }
}

struct ComposerInputRegistration: NSViewRepresentable {
    let input: ConversationComposerInput
    @Environment(\.isEnabled) private var enabled
    func makeNSView(context: Context) -> NSView { ComposerInputMarker() }
    func updateNSView(_ view: NSView, context: Context) { input.marker = view; input.enabled = enabled }
}

private final class ComposerInputMarker: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private struct ConversationComposerInputKey: EnvironmentKey {
    static let defaultValue: ConversationComposerInput? = nil
}

extension EnvironmentValues {
    var conversationComposerInput: ConversationComposerInput? {
        get { self[ConversationComposerInputKey.self] }
        set { self[ConversationComposerInputKey.self] = newValue }
    }
}
