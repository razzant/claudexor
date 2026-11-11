import SwiftUI
import AppKit

/// Block-aware markdown: contiguous headings, paragraphs, lists and wrapped code
/// share a native selection host. Tables and images split runs.
/// The existing block parser preserves paragraph breaks and GFM tables instead
/// of flattening the whole answer through AttributedString(markdown:) (#24).
///
/// Shared by the run-detail answer view and the chat transcript (a turn's assistant
/// message renders markdown, not flat text — the v0.10 chat regression fix).
struct MarkdownOutputView: View {
    // Passive file snapshots can render without a live conversation model.
    @Environment(AppModel.self) private var model: AppModel?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.proseMessageSource) private var messageSource
    let markdown: String
    /// Roots (thread execution root / run dir) whose images may render INLINE and
    /// whose file links may open (F2.5 W-C7). Empty = no local-file access:
    /// an image degrades to its visible markdown text, honestly.
    var fileScopeRoots: [String] = []
    /// The same run's tree for a remote location; nil = the selected thread.
    var remoteFileScope: RemoteFileScope? = nil
    /// Conversation answers use body-sized prose; dense secondary surfaces
    /// retain the compact callout default.
    var bodyFont: Font = .callout
    /// A file snapshot never fetches images automatically. Manual links use the
    /// same system/scoped-file handling as answers.
    var isFilePreview = false
    var previewHeight: CGFloat? = nil
    /// A visible, dismissible refusal for a blocked file-link click (sol #14):
    /// out-of-scope or unsafe-type targets never fail silently.
    @State private var linkRefusal: String?
    @State private var previewRequest: SafeFilePreviewRequest?

    var body: some View {
        ProsePreviewLayout(heightLimit: previewHeight) {
            if let linkRefusal {
                Label(linkRefusal, systemImage: "hand.raised.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .onTapGesture { self.linkRefusal = nil }
                    .help("Tap to dismiss. Agent-produced files open only inside this thread's scope, and only for safe document/image types.")
            }
            ForEach(ProseBuilder.segments(boundedMarkdown,
                style: .make(body: bodyFont == .body, size: dynamicTypeSize))) { segment in
                switch segment.content {
                case .prose(let document):
                    ProseText(document: document)
                        .layoutValue(key: ProsePreviewBoundary.self, value: { width, limit in
                            ProseMeasurer.shared.wholeLineHeight(document, width: min(680, width), limit: limit)
                        })
                case .image(let alt, let target, let source):
                    if isFilePreview || model == nil {
                        ProseText(document: ProseBuilder.plain(source))
                    } else if model?.selectedExecutionLocation == .local {
                        ScopedInlineImage(target: target, alt: alt, roots: fileScopeRoots)
                    } else {
                        RemoteScopedProjectImage(target: target, alt: alt, scope: remoteFileScope)
                    }
                case .table(let table, let source):
                    MarkdownTableView(table: table, bodyFont: bodyFont,
                        overflowHint: MarkdownTableView.overflowHint(filePreview: isFilePreview),
                        markdown: source)
                }
            }
            if renderTruncated > 0 {
                Text(isFilePreview
                     ? "\(renderTruncated) more characters not formatted here — choose Show source to inspect the loaded text."
                     : "\(renderTruncated) more characters not rendered here — open the run's full answer artifact.")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(item: $previewRequest) { SafeFilePreviewSheet(request: $0) }
        .environment(\.proseLinkGate, gate)
        .environment(\.proseMessageSource, messageSource ?? markdown)
        .environment(\.openURL, OpenURLAction { url in
            gate.handle(url)
            return .handled
        })
    }

    private var gate: ProseLinkGate {
        ProseLinkGate(model: model, roots: fileScopeRoots, remoteScope: remoteFileScope,
            notice: { linkRefusal = $0 }, preview: { previewRequest = $0 })
    }

    enum LinkRoute: Equatable { case system, scoped(target: String) }

    /// Manual links share one rule across answers and file previews: non-file
    /// links keep system behavior; local targets use the existing scope gate.
    nonisolated static func linkRoute(for url: URL) -> LinkRoute {
        guard url.isFileURL || url.scheme == nil else { return .system }
        return .scoped(target: url.isFileURL ? url.path : url.absoluteString)
    }

    nonisolated static func refusalNotice(_ reason: String) -> String { "Link not opened: \(reason)" }
    enum LocalFileAction: Equatable {
        case preview(path: String, kind: AgentFilePreviewKind)
        case reveal(path: String)
        case refuse(reason: String)
    }

    nonisolated static func localFileAction(_ target: String, roots: [String]) -> LocalFileAction {
        let decision = ScopedInlineImage.previewDecision(target, roots: roots)
        guard let path = decision.path else {
            if case .blocked(let reason) = decision.kind { return .refuse(reason: reason) }
            return .refuse(reason: "File is unavailable.")
        }
        if case .blocked = decision.kind { return .reveal(path: path) }
        return .preview(path: path, kind: decision.kind)
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

    // MARK: - Table limits (bounded like renderCharCap: a hostile/oversized
    // table must never explode layout on the main thread). Overflow is
    // disclosed, never silently dropped.
    /// Body rows rendered; the rest disclosed as "N more rows".
    static let maxTableRows = 100
    /// Columns rendered; wider header/rows are clipped and disclosed.
    static let maxTableColumns = 12
    /// Per-cell character bound before it reaches the inline parser/layout.
    static let maxTableCellChars = 500

    // Memoized: parsing was a computed property that re-ran on EVERY render, so a
    // list re-render (e.g. one new SSE event) re-parsed every visible message. The
    // cache keys on the raw string — a completed message's text never changes, so it
    // parses once. (Only the actively-streaming message's text changes → cache miss.)

    private final class BlocksBox { let blocks: [MarkdownBlock]; init(_ b: [MarkdownBlock]) { blocks = b } }
    private static let cache: NSCache<NSString, BlocksBox> = {
        // Byte-costed (W23 class): 256 multi-megabyte answers must not pool.
        let c = NSCache<NSString, BlocksBox>(); c.countLimit = 256
        c.totalCostLimit = 16 * 1024 * 1024
        return c
    }()

    /// Internal (not private) so the W22 acceptance fixtures can assert the
    /// block structure (headings / lists / fences / tables) without rendering views.
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
        var codeLanguage: String?

        func flushParagraph() {
            let text = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !text.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .paragraph, text: text)) }
            paragraph.removeAll()
        }
        func flushList() {
            if !list.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .list, text: list.joined(separator: "\n"))) }
            list.removeAll()
        }

        // Indexed walk (not a bare for-line loop) so a table can look one line
        // AHEAD for its delimiter row and then consume its body rows.
        let lines = markdown.components(separatedBy: .newlines)
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("```") {
                if inCode {
                    out.append(MarkdownBlock(id: out.count, kind: .code, text: code.joined(separator: "\n"), language: codeLanguage))
                    code.removeAll()
                    inCode = false
                } else {
                    flushParagraph(); flushList()
                    inCode = true
                    codeLanguage = line.dropFirst(3).split(whereSeparator: { $0.isWhitespace }).first.map(String.init)
                }
                i += 1; continue
            }
            if inCode { code.append(line); i += 1; continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flushParagraph(); flushList(); i += 1; continue }

            // GFM table: a header row + a VALID delimiter row on the NEXT line.
            // Streaming-safe: `tableAt` returns nil until the complete delimiter
            // line already exists, so a half-typed table stays paragraph text.
            if let hit = tableAt(lines, i) {
                flushParagraph(); flushList()
                out.append(MarkdownBlock(id: out.count, kind: .table(hit.table), text: hit.rawText))
                i = hit.nextIndex
                continue
            }
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
            i += 1
        }
        if !code.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .code, text: code.joined(separator: "\n"), language: codeLanguage)) }
        flushParagraph(); flushList()
        return out.isEmpty ? [MarkdownBlock(id: 0, kind: .paragraph, text: markdown)] : out
    }

    // MARK: - Table parsing

    /// If `lines[i]` is a table header whose next line is a valid delimiter,
    /// build the bounded typed table and return the index PAST its last body
    /// row. Returns nil otherwise (including when the delimiter line does not
    /// yet exist — streaming safety). Internal for the parser fixtures.
    static func tableAt(_ lines: [String], _ i: Int) -> (table: MarkdownTable, rawText: String, nextIndex: Int)? {
        let headerLine = lines[i].trimmingCharacters(in: .whitespaces)
        guard headerLine.contains("|") else { return nil }
        // The delimiter row must ALREADY be present (do not recognize a table
        // mid-stream before it arrives).
        guard i + 1 < lines.count else { return nil }
        let delimLine = lines[i + 1].trimmingCharacters(in: .whitespaces)

        var header = tableCells(headerLine)
        let delim = tableCells(delimLine)
        guard !header.isEmpty,
              header.count == delim.count,
              delim.allSatisfy(isDelimiterCell) else { return nil }
        var alignments = delim.map(alignmentOf)

        // Body rows: every following non-empty line that still tokenizes as a
        // pipe row. Stops at the first non-row line (blank / no pipe / fence).
        var rows: [[String]] = []
        var j = i + 2
        while j < lines.count {
            let t = lines[j].trimmingCharacters(in: .whitespaces)
            if t.isEmpty || t.hasPrefix("```") || !t.contains("|") { break }
            var cells = tableCells(t)
            // Normalize ragged rows to the header width (pad short, clip long).
            if cells.count < header.count {
                cells.append(contentsOf: Array(repeating: "", count: header.count - cells.count))
            } else if cells.count > header.count {
                cells = Array(cells.prefix(header.count))
            }
            rows.append(cells)
            j += 1
        }

        // Column cap.
        var truncatedCols = 0
        if header.count > maxTableColumns {
            truncatedCols = header.count - maxTableColumns
            header = Array(header.prefix(maxTableColumns))
            alignments = Array(alignments.prefix(maxTableColumns))
            rows = rows.map { Array($0.prefix(maxTableColumns)) }
        }
        // Row cap.
        var truncatedRows = 0
        if rows.count > maxTableRows {
            truncatedRows = rows.count - maxTableRows
            rows = Array(rows.prefix(maxTableRows))
        }
        // Per-cell character cap.
        header = header.map(capCell)
        rows = rows.map { $0.map(capCell) }

        let table = MarkdownTable(header: header, alignments: alignments, rows: rows,
                                  truncatedRows: truncatedRows, truncatedColumns: truncatedCols)
        let rawText = lines[i..<j].joined(separator: "\n")
        return (table, rawText, j)
    }

    /// Split ONE table line into cells: honors escaped `\|`, ignores pipes
    /// inside inline-code (backtick) spans, and drops the empty cells produced
    /// by optional leading/trailing pipes. Plain character walk (no regex, the
    /// house style). Internal for the tokenizer fixtures.
    static func tableCells(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var cells: [String] = []
        var current = ""
        var inCode = false
        var idx = trimmed.startIndex
        while idx < trimmed.endIndex {
            let ch = trimmed[idx]
            if ch == "\\" {
                let next = trimmed.index(after: idx)
                if next < trimmed.endIndex, trimmed[next] == "|" {
                    // Escaped pipe → a literal pipe inside the cell, not a separator.
                    current.append("|")
                    idx = trimmed.index(after: next)
                    continue
                }
                current.append(ch)
                idx = trimmed.index(after: idx)
                continue
            }
            if ch == "`" {
                inCode.toggle(); current.append(ch)
                idx = trimmed.index(after: idx); continue
            }
            if ch == "|", !inCode {
                cells.append(current); current = ""
                idx = trimmed.index(after: idx); continue
            }
            current.append(ch)
            idx = trimmed.index(after: idx)
        }
        cells.append(current)
        // Drop the empty leading/trailing cells that an outer `|` produces —
        // but keep genuinely empty INTERIOR cells (`a || b`).
        if trimmed.hasPrefix("|"), let first = cells.first,
           first.trimmingCharacters(in: .whitespaces).isEmpty {
            cells.removeFirst()
        }
        if trimmed.hasSuffix("|"), let last = cells.last,
           last.trimmingCharacters(in: .whitespaces).isEmpty {
            cells.removeLast()
        }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// A delimiter cell is `:?-+:?` (dashes with optional alignment colons).
    static func isDelimiterCell(_ cell: String) -> Bool {
        var s = Substring(cell)
        if s.first == ":" { s = s.dropFirst() }
        if s.last == ":" { s = s.dropLast() }
        return !s.isEmpty && s.allSatisfy { $0 == "-" }
    }

    static func alignmentOf(_ cell: String) -> MarkdownTable.Alignment {
        let lead = cell.hasPrefix(":"), trail = cell.hasSuffix(":")
        if lead && trail { return .center }
        if trail { return .trailing }
        return .leading
    }

    static func capCell(_ s: String) -> String {
        s.count > maxTableCellChars ? String(s.prefix(maxTableCellChars)) + "…" : s
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

    /// A parsed GFM pipe table. Bounded at parse time (rows/columns/cell
    /// length); `truncated*` disclose what the caps dropped.
    struct MarkdownTable: Equatable {
        enum Alignment: Equatable { case leading, center, trailing }
        let header: [String]
        let alignments: [Alignment]
        let rows: [[String]]
        let truncatedRows: Int
        let truncatedColumns: Int
    }

    struct MarkdownBlock: Identifiable, Equatable {
        enum Kind: Equatable {
            case heading(Int), paragraph, list, code
            case image(alt: String, target: String)
            case table(MarkdownTable)
        }
        let id: Int
        let kind: Kind
        let text: String
        var language: String? = nil
    }
}
