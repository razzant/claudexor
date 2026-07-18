import SwiftUI

/// Block-aware markdown rendering: headings, paragraphs, list items, and fenced
/// code render as separate views. `AttributedString(markdown:)` alone collapses
/// every newline into one run-on line, which made multi-paragraph answers unreadable.
///
/// Shared by the run-detail answer view and the chat transcript (a turn's assistant
/// message renders markdown, not flat text — the v0.10 chat regression fix).
struct MarkdownOutputView: View {
    let markdown: String
    /// Roots (thread repoRoot / run dir) whose images may render INLINE and
    /// whose file links may open (F2.5 W-C7). Empty = no local-file access:
    /// an image degrades to its visible markdown text, honestly.
    var fileScopeRoots: [String] = []
    /// Conversation answers use body-sized prose; dense secondary surfaces
    /// retain the compact callout default.
    var bodyFont: Font = .callout
    /// A visible, dismissible refusal for a blocked file-link click (sol #14):
    /// out-of-scope or unsafe-type targets never fail silently.
    @State private var linkRefusal: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if let linkRefusal {
                Label(linkRefusal, systemImage: "hand.raised.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .onTapGesture { self.linkRefusal = nil }
                    .help("Tap to dismiss. Agent-produced files open only inside this thread's scope, and only for safe document/image types.")
            }
            ForEach(blocks) { block in
                switch block.kind {
                case .heading(let level):
                    inline(block.text, font: level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                case .paragraph:
                    inline(block.text, font: bodyFont)
                case .image(let alt, let target):
                    ScopedInlineImage(target: target, alt: alt, roots: fileScopeRoots)
                case .list:
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        ForEach(Array(block.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                                Text("•").font(bodyFont).foregroundStyle(.secondary)
                                inline(String(item.dropFirst(2)), font: bodyFont)
                            }
                        }
                    }
                case .code:
                    ScrollView(.horizontal, showsIndicators: true) {
                        Text(block.text)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(Theme.Spacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .codeSurface(Theme.Radius.control)
                }
            }
            if renderTruncated > 0 {
                Text("\(renderTruncated) more characters not rendered here — open the run's full answer artifact.")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // W-C7: FILE links open via NSWorkspace, but ONLY for an in-scope
        // SAFE-type file — an out-of-scope target OR an executable/script/app
        // (a `.command`/`.app` would launch agent code, sol #11) is refused
        // with a VISIBLE disclosure, not a silent beep (sol #14). Web links
        // keep normal browser behavior.
        .environment(\.openURL, OpenURLAction { url in
            guard url.isFileURL || url.scheme == nil else { return .systemAction }
            let raw = url.isFileURL ? url.path : url.absoluteString
            switch ScopedInlineImage.openDecision(raw, roots: fileScopeRoots) {
            case .open(let path):
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
                linkRefusal = nil
            case .refuse(let reason):
                linkRefusal = "Link not opened: \(reason)."
                NSSound.beep()
            }
            return .handled
        })
    }

    @ViewBuilder
    private func inline(_ raw: String, font: Font) -> some View {
        Text(Self.inlineAttributed(raw))
            .font(font)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Memoized inline-markdown parse: AttributedString(markdown:) is a full
    /// parser invocation PER LINE per render — a long transcript re-parsed
    /// every visible paragraph on each SSE batch. Completed text never
    /// changes, so it parses once (same policy as the block cache below).
    private final class InlineBox { let value: AttributedString; init(_ v: AttributedString) { value = v } }
    private static let inlineCache: NSCache<NSString, InlineBox> = {
        // Byte-costed (W23 class): unbounded keys/values must not pool megabytes.
        let c = NSCache<NSString, InlineBox>(); c.countLimit = 2048
        c.totalCostLimit = 8 * 1024 * 1024
        return c
    }()

    static func inlineAttributed(_ raw: String) -> AttributedString {
        let key = raw as NSString
        if let hit = inlineCache.object(forKey: key) { return hit.value }
        let parsed = (try? AttributedString(markdown: raw, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(raw)
        inlineCache.setObject(InlineBox(parsed), forKey: key, cost: raw.utf16.count)
        return parsed
    }

    /// Hard character bound BEFORE parse/layout (review sol #16, the W23 hang
    /// class): "Show more" / Run Detail used to hand the WHOLE answer to the
    /// parser, which materializes the entire string on the main thread. The
    /// full artifact stays reachable in the run's files; the view never lays
    /// out more than this. Disclosed via `renderTruncated`.
    static let renderCharCap = 200_000
    private var boundedMarkdown: String {
        markdown.count > Self.renderCharCap ? String(markdown.prefix(Self.renderCharCap)) : markdown
    }
    private var renderTruncated: Int { max(0, markdown.count - Self.renderCharCap) }

    // Memoized: parsing was a computed property that re-ran on EVERY render, so a
    // list re-render (e.g. one new SSE event) re-parsed every visible message. The
    // cache keys on the raw string — a completed message's text never changes, so it
    // parses once. (Only the actively-streaming message's text changes → cache miss.)
    private var blocks: [MarkdownBlock] { Self.parse(boundedMarkdown) }

    private final class BlocksBox { let blocks: [MarkdownBlock]; init(_ b: [MarkdownBlock]) { blocks = b } }
    private static let cache: NSCache<NSString, BlocksBox> = {
        // Byte-costed (W23 class): 256 multi-megabyte answers must not pool.
        let c = NSCache<NSString, BlocksBox>(); c.countLimit = 256
        c.totalCostLimit = 16 * 1024 * 1024
        return c
    }()

    /// Internal (not private) so the W22 acceptance fixtures can assert the
    /// block structure (headings / lists / fences) without rendering views.
    static func parse(_ markdown: String) -> [MarkdownBlock] {
        let key = markdown as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let out = parseUncached(markdown)
        cache.setObject(BlocksBox(out), forKey: key, cost: markdown.utf16.count)
        return out
    }

    private static func parseUncached(_ markdown: String) -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        var paragraph: [String] = []
        var list: [String] = []
        var code: [String] = []
        var inCode = false

        func flushParagraph() {
            let text = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !text.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .paragraph, text: text)) }
            paragraph.removeAll()
        }
        func flushList() {
            if !list.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .list, text: list.joined(separator: "\n"))) }
            list.removeAll()
        }

        for line in markdown.components(separatedBy: .newlines) {
            if line.hasPrefix("```") {
                if inCode {
                    out.append(MarkdownBlock(id: out.count, kind: .code, text: code.joined(separator: "\n")))
                    code.removeAll()
                    inCode = false
                } else {
                    flushParagraph(); flushList()
                    inCode = true
                }
                continue
            }
            if inCode { code.append(line); continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flushParagraph(); flushList(); continue }
            if let image = imageLine(trimmed) {
                flushParagraph(); flushList()
                out.append(MarkdownBlock(id: out.count, kind: .image(alt: image.alt, target: image.target), text: trimmed))
            } else if let headingLevel = headingLevel(trimmed) {
                flushParagraph(); flushList()
                out.append(MarkdownBlock(id: out.count, kind: .heading(headingLevel.level), text: headingLevel.text))
            } else if isListItem(trimmed) {
                flushParagraph()
                list.append("• \(listItemText(trimmed))")
            } else {
                flushList()
                paragraph.append(trimmed)
            }
        }
        if !code.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .code, text: code.joined(separator: "\n"))) }
        flushParagraph(); flushList()
        return out.isEmpty ? [MarkdownBlock(id: 0, kind: .paragraph, text: markdown)] : out
    }

    /// A whole-line markdown image: `![alt](target)`. Plain syntax walk (the
    /// same style as the rest of this parser) — internal for the W-C7 tests.
    static func imageLine(_ line: String) -> (alt: String, target: String)? {
        guard line.hasPrefix("!["), line.hasSuffix(")"),
              let altEnd = line.range(of: "](")
        else { return nil }
        let alt = String(line[line.index(line.startIndex, offsetBy: 2)..<altEnd.lowerBound])
        let rawTarget = String(line[altEnd.upperBound..<line.index(before: line.endIndex)])
        // An optional markdown title (`path "title"`) rides after the first space.
        let target = rawTarget.split(separator: " ", maxSplits: 1).first.map(String.init) ?? rawTarget
        guard !target.isEmpty else { return nil }
        return (alt, target)
    }

    private static func headingLevel(_ line: String) -> (level: Int, text: String)? {
        guard line.hasPrefix("#") else { return nil }
        let hashes = line.prefix(while: { $0 == "#" })
        let text = line.dropFirst(hashes.count).trimmingCharacters(in: .whitespaces)
        guard hashes.count <= 6, !text.isEmpty else { return nil }
        return (min(hashes.count, 3), text)
    }

    private static func isListItem(_ line: String) -> Bool {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") { return true }
        // ordered list: "1. text"
        let head = line.prefix(while: { $0.isNumber })
        return !head.isEmpty && line.dropFirst(head.count).hasPrefix(". ")
    }

    private static func listItemText(_ line: String) -> String {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
            return String(line.dropFirst(2))
        }
        let head = line.prefix(while: { $0.isNumber })
        return String(line.dropFirst(head.count + 2))
    }

    struct MarkdownBlock: Identifiable, Equatable {
        enum Kind: Equatable { case heading(Int), paragraph, list, code, image(alt: String, target: String) }
        let id: Int
        let kind: Kind
        let text: String
    }
}
