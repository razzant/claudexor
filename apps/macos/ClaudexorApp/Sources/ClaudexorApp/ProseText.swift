import AppKit
import SwiftUI

/// One measuring stack, with precisely the same TextKit 1 geometry as the displayed host.
/// Width is keyed by its exact floating-point bits: rounding can clip a final line.
@MainActor final class ProseMeasurer {
    static let shared = ProseMeasurer()
    private let storage = NSTextStorage()
    private let layout = NSLayoutManager()
    private let container = NSTextContainer(size: .zero)
    private final class Measurement {
        let size: CGSize
        let lines: [CGRect]
        init(size: CGSize, lines: [CGRect]) { self.size = size; self.lines = lines }
    }
    private let cache = NSCache<NSString, Measurement>()
    private(set) var layoutCount = 0

    init() {
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        cache.countLimit = 50_000
        cache.totalCostLimit = 16 * 1024 * 1024
    }

    private func measure(_ document: ProseDocument, width: CGFloat) -> Measurement {
        precondition(width.isFinite && width > 0)
        let key = "\(document.id):\(document.style.generation):\(Double(width).bitPattern)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        storage.setAttributedString(document.text)
        container.containerSize = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let rect = layout.usedRect(for: container)
        let value = CGSize(width: min(width, ceil(rect.maxX)), height: max(1, ceil(rect.maxY)))
        var lines: [CGRect] = []
        layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { _, used, _, _, _ in
            lines.append(used)
        }
        let measured = Measurement(size: value, lines: lines)
        cache.setObject(measured, forKey: key, cost: lines.count * MemoryLayout<CGRect>.stride + 64)
        layoutCount += 1
        return measured
    }

    func size(_ document: ProseDocument, width: CGFloat) -> CGSize { measure(document, width: width).size }
    func height(_ document: ProseDocument, width: CGFloat) -> CGFloat { size(document, width: width).height }
    func lines(_ document: ProseDocument, width: CGFloat) -> [CGRect] { measure(document, width: width).lines }
    func wholeLineHeight(_ document: ProseDocument, width: CGFloat, limit: CGFloat) -> CGFloat {
        let measured = measure(document, width: width)
        guard measured.size.height > limit else { return measured.size.height }
        return measured.lines.filter { ceil($0.maxY) <= limit }.last.map { ceil($0.maxY) } ?? 0
    }
}

struct ProseText: NSViewRepresentable {
    let document: ProseDocument
    var hugs = false
    var cap: CGFloat = Theme.Layout.conversationMaxWidth
    var heightLimit: CGFloat? = nil
    var accessibilityName = "Message text"
    var onSelectionChange: ((Bool) -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    @Environment(\.proseLinkGate) private var linkGate
    @Environment(\.proseMessageID) private var messageID
    @Environment(\.conversationComposerInput) private var composerInput
    @Environment(\.proseMessageSource) private var messageSource
    @Environment(\.proseMessageCopyAction) private var copyMessageAction
    @Environment(\.conversationReadingPosition) private var readingPosition
    @Environment(ConversationPresentation.self) private var presentation: ConversationPresentation?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> ProseTextView {
        let view = ProseTextView.make()
        view.delegate = context.coordinator
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: ProseTextView, context: Context) {
        let replacing = view.shownID != document.id || view.messageID != messageID
        if replacing {
            // Notify the old document's owners before installing new callbacks.
            context.coordinator.selectionChanged?(false)
            view.focusChanged?(false)
        }
        context.coordinator.gate = linkGate
        view.composerInput = composerInput
        view.messageID = messageID
        view.messageSource = messageSource
        view.copyMessageAction = copyMessageAction
        if view.readingPosition !== readingPosition {
            view.readingPosition?.unregister(view)
            view.readingPosition = readingPosition
            readingPosition?.register(view)
        }
        context.coordinator.selectionChanged = { selected in
            onSelectionChange?(selected)
            guard let messageID else { return }
            let key = messageID + ":" + document.id
            if selected { presentation?.selectedMessages.insert(key) }
            else { presentation?.selectedMessages.remove(key) }
        }
        view.focusChanged = { focused in
            onFocusChange?(focused)
            guard let messageID else { return }
            let key = messageID + ":" + document.id
            if focused { presentation?.focusedMessages.insert(key) }
            else { presentation?.focusedMessages.remove(key) }
        }
        view.setAccessibilityLabel(accessibilityName)
        // The content identity, not the cache object's address, owns replacement.
        if view.shownID != document.id {
            view.cancelCopyFeedback()
            view.textStorage?.setAttributedString(document.text)
            view.shownID = document.id
        }
        if replacing {
            context.coordinator.selectionChanged?(view.selectedRange().length > 0)
            view.focusChanged?(view.window?.firstResponder === view)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ProseTextView, context: Context) -> CGSize? {
        let proposed = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        var width = min(proposed ?? cap, cap)
        if hugs { width = max(1, ProseMeasurer.shared.size(document, width: width).width) }
        // Only the cache mutates. No SwiftUI state writes or asynchronous height feedback.
        let height = heightLimit.map { ProseMeasurer.shared.wholeLineHeight(document, width: width, limit: $0) }
            ?? ProseMeasurer.shared.height(document, width: width)
        return CGSize(width: width, height: height)
    }

    static func dismantleNSView(_ view: ProseTextView, coordinator: Coordinator) {
        view.cancelCopyFeedback()
        view.stopKeepingSelection()
        view.readingPosition?.unregister(view)
        coordinator.selectionChanged?(false)
        view.focusChanged?(false)
        coordinator.selectionChanged = nil
        view.delegate = nil
        view.focusChanged = nil
        view.textStorage?.setAttributedString(NSAttributedString(string: ""))
        view.shownID = nil
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var gate: ProseLinkGate?
        var selectionChanged: ((Bool) -> Void)?

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let url = link as? URL ?? (link as? String).flatMap(URL.init(string:)) {
                if url.scheme == "claudexor-code-copy" {
                    (textView as? ProseTextView)?.copyCode(link: url, at: charIndex)
                } else { gate?.handle(url) }
            }
            return true // Never let AppKit's default file URL opener bypass the scope gate.
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            selectionChanged?(view.selectedRange().length > 0)
        }
    }
}

private struct ProseMessageIDKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var proseMessageID: String? {
        get { self[ProseMessageIDKey.self] }
        set { self[ProseMessageIDKey.self] = newValue }
    }
}

final class ProseTextView: NSTextView {
    var shownID: String?
    var messageID: String?
    weak var composerInput: ConversationComposerInput?
    weak var readingPosition: ConversationReadingPosition?
    var messageSource: String?
    var copyMessageAction: (@MainActor () -> Void)?
    var writeCopiedText: (String) -> Bool = { ProseCodeActions.write($0) }
    var copyFeedback: [URL: Task<Void, Never>] = [:]
    var focusChanged: ((Bool) -> Void)?
    override var canBecomeKeyView: Bool { false }

    static func make() -> ProseTextView {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 680, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(layout)
        layout.addTextContainer(container)
        container.lineFragmentPadding = 0
        container.widthTracksTextView = true
        let view = ProseTextView(frame: .zero, textContainer: container)
        view.isEditable = false
        view.isSelectable = true
        view.isRichText = true
        view.importsGraphics = false
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.autoresizingMask = []
        view.allowsUndo = false
        view.usesFindBar = false
        view.usesFontPanel = false
        view.isAutomaticLinkDetectionEnabled = false
        view.isAutomaticDataDetectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.writingToolsBehavior = .none
        view.linkTextAttributes = [.foregroundColor: NSColor(Theme.accent), .cursor: NSCursor.pointingHand]
        return view
    }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { focusChanged?(true) }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { focusChanged?(false) }
        return accepted
    }

    override func writeSelection(to pasteboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        let range = selectedRange()
        guard range.length > 0, NSMaxRange(range) <= (string as NSString).length else { return false }
        guard let textStorage else { return false }
        return ProseCodeActions.writeSelection(textStorage, range: range, to: pasteboard, types: types)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        if messageSource != nil {
            let item = NSMenuItem(title: "Copy message", action: #selector(copyMessage(_:)), keyEquivalent: "")
            item.target = self
            item.toolTip = "Copy this message's Markdown source."
            menu.addItem(.separator())
            menu.addItem(item)
        }
        return menu
    }

    override func accessibilityChildren() -> [Any]? { (super.accessibilityChildren() ?? []) + codeAccessibilityActions() }

    /// A resized NSTextView scrolls its enclosing scroll view from inside setFrameSize (macOS 26.6
    /// moved a followed feed to a growing answer's first line that way). On macOS 26.4 that request
    /// covers the text that was on screen, not the selection, and narrowing Run details makes none
    /// (#520). So prose never scrolls because its size changed: the feed owns its position, and
    /// elsewhere a visible selection is put back once the width settles (below).
    private var resizingFrame = false

    override func setFrameSize(_ newSize: NSSize) {
        let reflows = selectionAnchor != nil && newSize.width != frame.width
        let outer = resizingFrame
        resizingFrame = true
        defer { resizingFrame = outer }
        super.setFrameSize(newSize)
        if reflows { restoreSelectionAfterReflow() }
    }

    /// The end of a window's live resize enters the same reveal without setFrameSize
    /// (-[NSTextView viewDidEndLiveResize] calls _setFrameSize:forceScroll: directly).
    override func viewDidEndLiveResize() {
        let outer = resizingFrame
        resizingFrame = true
        defer { resizingFrame = outer }
        super.viewDidEndLiveResize()
    }

    override func scrollToVisible(_ rect: NSRect) -> Bool {
        resizingFrame ? false : super.scrollToVisible(rect)
    }

    /// The first selected character the reader could see, and its line's distance from the viewport top.
    struct SelectionAnchor: Equatable {
        let documentID: String?
        let character: Int
        let offset: CGFloat
    }
    /// Outside the feed nothing restores a reflowed viewport: the scroll view keeps its offset, so a
    /// narrower Run details answer or preview pushed the selected passage off screen. A non-empty
    /// selection on screen is the reader's place. It is captured as scrolling and selection change,
    /// and put back at the same height once a width change settles, outside layout. An insertion
    /// point, a selection scrolled out of view and feed prose never move the scroll view.
    private(set) var selectionAnchor: SelectionAnchor?
    /// How long a width change lets layout settle before the selection is put back.
    var selectionRestoreDelay: Duration = .milliseconds(180)
    private var selectionRestore: Task<Void, Never>?
    private var deferredCapture: Task<Void, Never>?
    private var scrollFollower: ProseScrollFollower?
    /// Prose keeping a selection, one per scroll view: the reader's latest.
    @MainActor private static let keptSelections = NSHashTable<ProseTextView>.weakObjects()
    private var selecting = false
    var isRestoringSelection: Bool { selectionRestore != nil }

    /// Every update, a drag's included, replaces a pending restore; the anchor waits for its end.
    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
        selecting = stillSelecting
        cancelSelectionRestore()
        relinquishSiblingSelections()
        if stillSelecting { selectionAnchor = nil } else { selectionMoved() }
    }

    /// The hosts of a split answer share one scroll view. A selection begun, a caret or a scroll key
    /// in the prose the reader is using ends another host's keeping there at once; focus merely
    /// moving on leaves that selection the reader's place, inactive.
    private func relinquishSiblingSelections() {
        guard window?.firstResponder === self, let scroll = verticalScrollView else { return }
        for other in Self.keptSelections.allObjects where other !== self && other.scrollFollower?.scroll === scroll {
            other.stopKeepingSelection()
        }
    }

    /// Non-empty selected ranges in text order; Command-drag can add several.
    private var selectedPassages: [NSRange] {
        let length = (string as NSString).length
        return selectedRanges.map(\.rangeValue).filter { $0.length > 0 && NSMaxRange($0) <= length }
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil { stopKeepingSelection() }
        super.viewWillMove(toWindow: newWindow)
    }

    /// A new or cleared selection replaces any pending restore.
    private func selectionMoved() {
        cancelSelectionRestore()
        guard readingPosition == nil, window != nil, !selectedPassages.isEmpty, let scroll = verticalScrollView else {
            stopKeepingSelection()
            return
        }
        if scrollFollower?.scroll !== scroll {
            stopKeepingSelection()
            for other in Self.keptSelections.allObjects where other.scrollFollower?.scroll === scroll {
                other.stopKeepingSelection()
            }
            Self.keptSelections.add(self)
            scrollFollower = ProseScrollFollower(view: self, scroll: scroll)
        }
        captureSelectionAnchor()
    }

    func stopKeepingSelection() {
        cancelSelectionRestore()
        deferredCapture?.cancel()
        deferredCapture = nil
        selectionAnchor = nil
        scrollFollower = nil
        Self.keptSelections.remove(self)
    }

    /// The reader's own scrolling replaces a pending restore.
    func cancelSelectionRestore() {
        selectionRestore?.cancel()
        selectionRestore = nil
    }

    /// A clip move with unchanged sizes is a scroll and is captured at once. A move that comes with a
    /// size change can be a widening column's clamp, which reaches the clip before this view's new
    /// frame does; it is captured on the next turn unless that frame scheduled a restore.
    fileprivate func clipMoved(resized: Bool) {
        guard selectionRestore == nil else { return }
        guard resized else {
            captureSelectionAnchor()
            return
        }
        deferredCapture?.cancel()
        deferredCapture = Task { @MainActor [weak self] in
            guard !Task.isCancelled, let self, self.selectionRestore == nil else { return }
            self.deferredCapture = nil
            self.captureSelectionAnchor()
        }
    }

    private func restoreSelectionAfterReflow() {
        deferredCapture?.cancel()
        deferredCapture = nil
        selectionRestore?.cancel()
        let delay = selectionRestoreDelay
        selectionRestore = Task { @MainActor [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.selectionRestore = nil
            self.restoreSelectionAnchor()
            self.captureSelectionAnchor()
        }
    }

    private func captureSelectionAnchor() {
        selectionAnchor = nil
        let passages = selectedPassages
        guard readingPosition == nil, !selecting, !passages.isEmpty,
              let clip = scrollFollower?.scroll?.contentView, let layout = layoutManager,
              let container = textContainer else { return }
        let viewport = convert(clip.bounds, from: clip)
        let shown = viewport.intersection(bounds)
        guard !shown.isEmpty else { return }
        let glyphs = layout.glyphRange(forBoundingRect: shown.offsetBy(dx: -textContainerOrigin.x,
            dy: -textContainerOrigin.y), in: container)
        let visible = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        // The first passage on screen; an earlier one may have been scrolled away.
        guard let seen = passages.lazy.map({ NSIntersectionRange($0, visible) }).first(where: { $0.length > 0 }),
              let line = lineRect(at: seen.location) else { return }
        selectionAnchor = SelectionAnchor(documentID: shownID, character: seen.location, offset: line.minY - viewport.minY)
    }

    private func restoreSelectionAnchor() {
        guard let anchor = selectionAnchor, anchor.documentID == shownID, readingPosition == nil,
              selectedPassages.contains(where: { NSLocationInRange(anchor.character, $0) }),
              let scroll = scrollFollower?.scroll,
              scroll === verticalScrollView, let line = lineRect(at: anchor.character) else { return }
        let clip = scroll.contentView
        var target = convert(clip.bounds, from: clip)
        // A shorter viewport still shows the line.
        target.origin.y = line.minY - min(anchor.offset, max(0, target.height - line.height))
        var bounds = clip.bounds
        bounds.origin.y = convert(target, to: clip).origin.y
        bounds = clip.constrainBoundsRect(bounds)
        guard abs(bounds.origin.y - clip.bounds.origin.y) >= 1 else { return }
        clip.scroll(to: bounds.origin)
        scroll.reflectScrolledClipView(clip)
    }

    private func lineRect(at character: Int) -> NSRect? {
        guard let layout = layoutManager, character < (string as NSString).length else { return nil }
        return layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: character), effectiveRange: nil)
            .offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
    }

    override func scrollWheel(with event: NSEvent) {
        cancelSelectionRestore()
        if abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX), let feed = verticalScrollView {
            feed.scrollWheel(with: event)
        } else { nextResponder?.scrollWheel(with: event) }
    }

    override func keyDown(with event: NSEvent) {
        let arrow = [123, 124, 125, 126].contains(event.keyCode)
        if event.modifierFlags.contains(.command)
            || (arrow && (event.modifierFlags.contains(.shift) || selectedRange().length > 0)) {
            super.keyDown(with: event)
        } else if event.keyCode == 48 {
            if event.modifierFlags.contains(.shift) { window?.selectPreviousKeyView(self) }
            else { window?.selectNextKeyView(self) }
        } else if [49, 115, 116, 119, 121].contains(event.keyCode) || arrow {
            // Home, Page Up, Up arrow and Shift-Space read earlier content.
            if [115, 116, 126].contains(event.keyCode) || (event.keyCode == 49 && event.modifierFlags.contains(.shift)) {
                readingPosition?.readerMovedUp()
            }
            cancelSelectionRestore()
            relinquishSiblingSelections()
            verticalScrollView?.keyDown(with: event)
        } else if !event.modifierFlags.contains(.control),
                  let characters = event.characters?.isEmpty == false ? event.characters
                    : event.charactersIgnoringModifiers,
                  !characters.isEmpty,
                  characters.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && !(0xF700...0xF8FF).contains($0.value) }) {
            composerInput?.forward(event, from: self)
        }
    }

    private var verticalScrollView: NSScrollView? {
        var ancestor = superview
        while let view = ancestor {
            if let scroll = view as? NSScrollView, scroll.hasVerticalScroller { return scroll }
            ancestor = view.superview
        }
        return nil
    }
}

/// Reports a scroll view's clip moves and the reader's live scrolling to the prose keeping a
/// selection in it. A separate observer, so removing it leaves NSTextView's own registrations alone.
@MainActor private final class ProseScrollFollower: NSObject {
    private weak var view: ProseTextView?
    weak var scroll: NSScrollView?
    private var sizes: [CGSize]

    init(view: ProseTextView, scroll: NSScrollView) {
        self.view = view
        self.scroll = scroll
        sizes = ProseScrollFollower.sizes(of: scroll.contentView)
        super.init()
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(boundsChanged(_:)),
            name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(liveScrollStarted(_:)),
            name: NSScrollView.willStartLiveScrollNotification, object: scroll)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private static func sizes(of clip: NSClipView) -> [CGSize] {
        [clip.bounds.size, clip.documentView?.frame.size ?? .zero]
    }

    @objc private func boundsChanged(_ notification: Notification) {
        guard let clip = scroll?.contentView else { return }
        let now = Self.sizes(of: clip)
        let resized = now != sizes
        sizes = now
        view?.clipMoved(resized: resized)
    }

    @objc private func liveScrollStarted(_ notification: Notification) { view?.cancelSelectionRestore() }
}
