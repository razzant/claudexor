import AppKit
import Darwin
import QuickLookUI
import SwiftUI

enum AgentFilePreviewKind: Equatable, Sendable {
    case markdown
    case source
    case quickLook
    case blocked(reason: String)
}

struct SafeFilePreviewRequest: Identifiable, Equatable, Sendable {
    enum SourceReadError: Error, Equatable {
        case couldNotRead
        case notRegularFile
        case outsideScope
    }

    struct BoundedSource: Equatable, Sendable {
        let bytes: Data
        let wasTruncated: Bool

        let text: String?

        init(bytes: Data, wasTruncated: Bool) {
            self.bytes = bytes
            self.wasTruncated = wasTruncated
            self.text = String(data: bytes, encoding: .utf8)
        }

        init(readBuffer: Data, maxBytes: Int) {
            bytes = Data(readBuffer.prefix(maxBytes))
            wasTruncated = readBuffer.count > maxBytes
            if let decoded = String(data: bytes, encoding: .utf8) {
                text = decoded
                return
            }
            // The read includes one full scalar of lookahead. Validate the
            // retained prefix before using the existing character-safe bound;
            // an interior encoding error cannot be repaired by trimming it.
            if wasTruncated {
                var probe = readBuffer
                for _ in 0..<4 where probe.count >= maxBytes {
                    if let decoded = String(data: probe, encoding: .utf8) {
                        text = AppModel.boundedUTF8Prefix(decoded, maxBytes: maxBytes)
                        return
                    }
                    probe.removeLast()
                }
            }
            text = nil
        }
    }

    static let sourceByteLimit = 4 * 1024 * 1024
    static let quickLookByteLimit = 64 * 1024 * 1024

    let id = UUID()
    let url: URL
    let kind: AgentFilePreviewKind
    let source: BoundedSource?
    let displayName: String
    let fileScopeRoots: [String]
    /// The previewed run's tree for remote link checks; nil = the selected thread.
    var remoteFileScope: RemoteFileScope?

    init(
        url: URL,
        kind: AgentFilePreviewKind,
        source: BoundedSource? = nil,
        displayName: String? = nil,
        fileScopeRoots: [String] = []
    ) {
        self.url = url
        self.kind = kind
        self.source = source
        self.displayName = displayName ?? url.lastPathComponent
        self.fileScopeRoots = fileScopeRoots
    }

    static func localFile(
        url: URL, kind: AgentFilePreviewKind, fileScopeRoots: [String] = []
    ) -> SafeFilePreviewRequest {
        SafeFilePreviewRequest(
            url: url,
            kind: kind,
            source: kind == .source || kind == .markdown ? try? boundedSource(at: url) : nil,
            fileScopeRoots: fileScopeRoots)
    }

    static func scopedLocalFile(
        url: URL,
        roots: [String],
        kind: AgentFilePreviewKind
    ) async throws -> SafeFilePreviewRequest {
        let snapshot = try await Task.detached(priority: .userInitiated) { () throws -> (URL, BoundedSource?) in
            let descriptor = try scopedRegularFileDescriptor(at: url, roots: roots)
            defer { Darwin.close(descriptor) }
            switch kind {
            case .source, .markdown:
                let source = try boundedSource(openFileDescriptor: descriptor)
                let staged = try ExternalArtifactHandoff.standard().stage(
                    data: source.bytes,
                    suggestedName: url.lastPathComponent)
                return (staged, source)
            case .quickLook:
                let staged = try ExternalArtifactHandoff.standard().stage(
                    openFileDescriptor: descriptor,
                    suggestedName: url.lastPathComponent,
                    maximumBytes: quickLookByteLimit)
                return (staged, nil)
            case .blocked:
                return (url, nil)
            }
        }.value
        return SafeFilePreviewRequest(
            url: snapshot.0,
            kind: kind,
            source: snapshot.1,
            displayName: url.lastPathComponent,
            fileScopeRoots: roots)
    }

    static func boundedSource(
        at url: URL,
        maxBytes: Int = sourceByteLimit
    ) throws -> BoundedSource {
        precondition(maxBytes >= 0 && maxBytes <= Int.max - 4)
        let handle = try regularFileHandle(at: url)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: maxBytes + 4) ?? Data()
        return BoundedSource(readBuffer: bytes, maxBytes: maxBytes)
    }

    private static func boundedSource(
        openFileDescriptor descriptor: Int32,
        maxBytes: Int = sourceByteLimit
    ) throws -> BoundedSource {
        let copy = Darwin.dup(descriptor)
        guard copy >= 0 else { throw SourceReadError.couldNotRead }
        let handle = FileHandle(fileDescriptor: copy, closeOnDealloc: true)
        let bytes = try handle.read(upToCount: maxBytes + 4) ?? Data()
        return BoundedSource(readBuffer: bytes, maxBytes: maxBytes)
    }

    private static func regularFileHandle(at url: URL) throws -> FileHandle {
        var pathStatus = stat()
        guard lstat(url.path, &pathStatus) == 0,
              pathStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG)
        else { throw SourceReadError.notRegularFile }

        let descriptor = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw SourceReadError.couldNotRead }

        var openedStatus = stat()
        guard fstat(descriptor, &openedStatus) == 0 else {
            Darwin.close(descriptor)
            throw SourceReadError.couldNotRead
        }
        guard openedStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              openedStatus.st_dev == pathStatus.st_dev,
              openedStatus.st_ino == pathStatus.st_ino
        else {
            Darwin.close(descriptor)
            throw SourceReadError.notRegularFile
        }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    private static func scopedRegularFileDescriptor(at url: URL, roots: [String]) throws -> Int32 {
        guard let target = canonicalPath(url.path) else { throw SourceReadError.couldNotRead }
        for root in roots {
            guard let canonicalRoot = canonicalPath(root) else { continue }
            let prefix = canonicalRoot.hasSuffix("/") ? canonicalRoot : canonicalRoot + "/"
            guard target.hasPrefix(prefix) else { continue }
            let relativePath = String(target.dropFirst(prefix.count))
            if let descriptor = try? openRegularFile(relativePath: relativePath, under: canonicalRoot) {
                return descriptor
            }
        }
        throw SourceReadError.outsideScope
    }

    private static func canonicalPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Resolve from a pinned canonical root, never from a mutable parent path.
    /// `openat` + `O_NOFOLLOW` on every component closes symlink/ABA escapes.
    private static func openRegularFile(relativePath: String, under root: String) throws -> Int32 {
        let components = relativePath.split(separator: "/").map(String.init)
        guard let fileName = components.last, fileName != ".", fileName != ".." else {
            throw SourceReadError.outsideScope
        }
        var directory = try openAbsoluteDirectory(root)
        defer { Darwin.close(directory) }
        for component in components.dropLast() {
            guard component != ".", component != ".." else { throw SourceReadError.outsideScope }
            let next = Darwin.openat(
                directory, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
            guard next >= 0 else { throw SourceReadError.outsideScope }
            Darwin.close(directory)
            directory = next
        }
        let descriptor = Darwin.openat(
            directory, fileName, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw SourceReadError.couldNotRead }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG)
        else {
            Darwin.close(descriptor)
            throw SourceReadError.notRegularFile
        }
        return descriptor
    }

    private static func openAbsoluteDirectory(_ path: String) throws -> Int32 {
        var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directory >= 0 else { throw SourceReadError.couldNotRead }
        for component in path.split(separator: "/") {
            let next = Darwin.openat(
                directory, String(component), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
            Darwin.close(directory)
            guard next >= 0 else { throw SourceReadError.outsideScope }
            directory = next
        }
        return directory
    }
}

struct SafeFilePreviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var showSource = false
    let request: SafeFilePreviewRequest

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(request.displayName)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if request.kind == .markdown, request.source?.text != nil {
                    Toggle("Show source", isOn: $showSource)
                        .toggleStyle(.checkbox)
                        .help("Switch between formatted Markdown and its source text.")
                }
            }
            .padding(Theme.Spacing.lg)

            if request.source?.wasTruncated == true {
                Label(
                    "Source shows only the first \(SafeFilePreviewRequest.sourceByteLimit) bytes.",
                    systemImage: "arrow.down.right.and.arrow.up.left")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.bottom, Theme.Spacing.md)
            }

            Divider()
            preview.frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()

            HStack {
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([request.url])
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(Theme.Spacing.lg)
        }
        .frame(minWidth: 720, minHeight: 520)
        // Like the full-prompt sheet, a preview owns its prose whoever presents it: opened from a
        // chat answer it joins neither the feed's reading position nor that turn's selection and
        // focus, and Copy message copies the previewed Markdown rather than the presenting message.
        .environment(\.conversationReadingPosition, nil)
        .environment(\.proseMessageID, nil)
        .environment(\.conversationComposerInput, nil)
        .environment(\.proseMessageCopyAction, nil)
        .environment(\.proseMessageSource, nil)
    }

    @ViewBuilder private var preview: some View {
        switch request.kind {
        case .source, .markdown:
            if let source = request.source, let text = source.text {
                if request.kind == .markdown && !showSource {
                    ScrollView {
                        MarkdownOutputView(
                            markdown: text, fileScopeRoots: request.fileScopeRoots,
                            remoteFileScope: request.remoteFileScope,
                            bodyFont: .body, isFilePreview: true)
                            .padding(Theme.Spacing.lg)
                    }
                } else {
                    LiteralSourceView(text: text)
                }
            } else {
                ContentUnavailableView(
                    "Preview unavailable",
                    systemImage: "doc.badge.ellipsis",
                    description: Text(request.source == nil
                        ? "The file could not be read within the preview limit."
                        : "\(request.displayName) is not valid UTF-8 text. Use Reveal in Finder to inspect the retained file."))
            }
        case .quickLook:
            QuickLookPreview(url: request.url)
        case .blocked(let reason):
            ContentUnavailableView(
                "Preview blocked",
                systemImage: "hand.raised.fill",
                description: Text(reason))
        }
    }
}

/// Literal source in a TextKit view. A single SwiftUI `Text` lays out its whole
/// string before it draws, which blocks the main thread for seconds at 256 KiB
/// and about a minute at 1 MiB; TextKit draws the visible part first and lays
/// out the rest while idle. Short source starts at the top-left corner. The
/// view is passive: plain text, never editable, and no link or data detection,
/// so markup in the file stays inert characters.
struct LiteralSourceView: NSViewRepresentable {
    let text: String

    /// Remembers what is shown so an update never re-reads megabytes of text.
    final class Coordinator { var shown: String? }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.documentView = Self.makeTextView()
        updateNSView(scroll, context: context)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard context.coordinator.shown != text, let view = scroll.documentView as? NSTextView
        else { return }
        Self.show(text, in: view)
        context.coordinator.shown = text
    }

    static func makeTextView() -> NSTextView {
        let view = NSTextView(usingTextLayoutManager: false)
        let unbounded = NSSize(
            width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.isEditable = false
        view.isSelectable = true
        view.isRichText = false
        view.importsGraphics = false
        view.drawsBackground = false
        view.isAutomaticLinkDetectionEnabled = false
        view.isAutomaticDataDetectionEnabled = false
        view.writingToolsBehavior = .none
        view.textContainerInset = NSSize(width: Theme.Spacing.lg, height: Theme.Spacing.lg)
        // Long lines scroll horizontally instead of wrapping.
        view.textContainer?.containerSize = unbounded
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.lineFragmentPadding = 0
        view.layoutManager?.allowsNonContiguousLayout = true
        view.maxSize = unbounded
        view.isHorizontallyResizable = true
        view.isVerticallyResizable = true
        view.autoresizingMask = [.width, .height]
        return view
    }

    static func show(_ text: String, in view: NSTextView) {
        let font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        // Tabs advance on the character grid at every column. The default
        // style has twelve stops and breaks the line at a tab beyond them.
        let paragraph = NSMutableParagraphStyle()
        paragraph.tabStops = []
        paragraph.defaultTabInterval = CGFloat(tabColumns) * font.maximumAdvancement.width
        view.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: [
            .font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph,
        ]))
    }

    static let tabColumns = 4
}

private struct QuickLookPreview: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> NSView {
        guard let view = QLPreviewView(frame: .zero, style: .normal) else {
            return NSTextField(labelWithString: "Quick Look is unavailable. Use Reveal in Finder.")
        }
        view.autostarts = true
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        (view as? QLPreviewView)?.previewItem = url as NSURL
    }
}
