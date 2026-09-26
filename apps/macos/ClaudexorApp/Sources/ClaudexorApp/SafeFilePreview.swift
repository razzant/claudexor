import AppKit
import Darwin
import QuickLookUI
import SwiftUI

enum AgentFilePreviewKind: Equatable, Sendable {
    case source
    case quickLook
    case blocked(reason: String)
}

struct SafeFilePreviewRequest: Identifiable {
    enum SourceReadError: Error, Equatable {
        case couldNotRead
        case notRegularFile
        case outsideScope
    }

    struct BoundedSource: Equatable, Sendable {
        let bytes: Data
        let wasTruncated: Bool

        var text: String { String(decoding: bytes, as: UTF8.self) }
    }

    static let sourceByteLimit = 4 * 1024 * 1024
    static let quickLookByteLimit = 64 * 1024 * 1024

    let id = UUID()
    let url: URL
    let kind: AgentFilePreviewKind
    let source: BoundedSource?
    let displayName: String

    init(
        url: URL,
        kind: AgentFilePreviewKind,
        source: BoundedSource? = nil,
        displayName: String? = nil
    ) {
        self.url = url
        self.kind = kind
        self.source = source
        self.displayName = displayName ?? url.lastPathComponent
    }

    static func localFile(url: URL, kind: AgentFilePreviewKind) -> SafeFilePreviewRequest {
        SafeFilePreviewRequest(
            url: url,
            kind: kind,
            source: kind == .source ? try? boundedSource(at: url) : nil)
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
            case .source:
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
            displayName: url.lastPathComponent)
    }

    static func boundedSource(
        at url: URL,
        maxBytes: Int = sourceByteLimit
    ) throws -> BoundedSource {
        precondition(maxBytes >= 0 && maxBytes < Int.max)
        let handle = try regularFileHandle(at: url)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: maxBytes + 1) ?? Data()
        return BoundedSource(
            bytes: Data(bytes.prefix(maxBytes)),
            wasTruncated: bytes.count > maxBytes)
    }

    private static func boundedSource(
        openFileDescriptor descriptor: Int32,
        maxBytes: Int = sourceByteLimit
    ) throws -> BoundedSource {
        let copy = Darwin.dup(descriptor)
        guard copy >= 0 else { throw SourceReadError.couldNotRead }
        let handle = FileHandle(fileDescriptor: copy, closeOnDealloc: true)
        let bytes = try handle.read(upToCount: maxBytes + 1) ?? Data()
        return BoundedSource(
            bytes: Data(bytes.prefix(maxBytes)),
            wasTruncated: bytes.count > maxBytes)
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
    let request: SafeFilePreviewRequest

    var body: some View {
        VStack(spacing: 0) {
            Text(request.displayName)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
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
    }

    @ViewBuilder private var preview: some View {
        switch request.kind {
        case .source:
            if let source = request.source {
                ScrollView([.horizontal, .vertical]) {
                    Text(source.text)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Theme.Spacing.lg)
                }
            } else {
                ContentUnavailableView(
                    "Preview unavailable",
                    systemImage: "doc.badge.ellipsis",
                    description: Text("The file could not be read within the preview limit."))
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
