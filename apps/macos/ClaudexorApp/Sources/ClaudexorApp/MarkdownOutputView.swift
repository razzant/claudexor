import SwiftUI

/// Block-aware markdown rendering: headings, paragraphs, list items, and fenced
/// code render as separate views. `AttributedString(markdown:)` alone collapses
/// every newline into one run-on line, which made multi-paragraph answers unreadable.
///
/// Shared by the run-detail answer view and the chat transcript (a turn's assistant
/// message renders markdown, not flat text — the v0.10 chat regression fix).
struct MarkdownOutputView: View {
    let markdown: String

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(blocks) { block in
                switch block.kind {
                case .heading(let level):
                    inline(block.text, font: level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                case .paragraph:
                    inline(block.text, font: .callout)
                case .list:
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        ForEach(Array(block.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                                Text("•").font(.callout).foregroundStyle(.secondary)
                                inline(String(item.dropFirst(2)), font: .callout)
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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func inline(_ raw: String, font: Font) -> some View {
        Text((try? AttributedString(markdown: raw, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(raw))
            .font(font)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // Memoized: parsing was a computed property that re-ran on EVERY render, so a
    // list re-render (e.g. one new SSE event) re-parsed every visible message. The
    // cache keys on the raw string — a completed message's text never changes, so it
    // parses once. (Only the actively-streaming message's text changes → cache miss.)
    private var blocks: [MarkdownBlock] { Self.parse(markdown) }

    private final class BlocksBox { let blocks: [MarkdownBlock]; init(_ b: [MarkdownBlock]) { blocks = b } }
    private static let cache: NSCache<NSString, BlocksBox> = {
        let c = NSCache<NSString, BlocksBox>(); c.countLimit = 256; return c
    }()

    private static func parse(_ markdown: String) -> [MarkdownBlock] {
        let key = markdown as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let out = parseUncached(markdown)
        cache.setObject(BlocksBox(out), forKey: key)
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
            if let headingLevel = headingLevel(trimmed) {
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

    private struct MarkdownBlock: Identifiable {
        enum Kind { case heading(Int), paragraph, list, code }
        let id: Int
        let kind: Kind
        let text: String
    }
}
