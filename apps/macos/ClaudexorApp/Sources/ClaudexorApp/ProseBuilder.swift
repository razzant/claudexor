import AppKit
import CryptoKit
import SwiftUI

struct ProseStyle: Hashable {
    var bodySize: CGFloat = NSFont.preferredFont(forTextStyle: .body).pointSize
    var generation: String { "prose-2:\(bodySize)" }
    var font: NSFont { .systemFont(ofSize: bodySize) }
    var codeFont: NSFont { .monospacedSystemFont(ofSize: max(10, bodySize - 2), weight: .regular) }

    static func make(body: Bool, size: DynamicTypeSize) -> ProseStyle {
        let base = NSFont.preferredFont(forTextStyle: body ? .body : .callout).pointSize
        let scale: CGFloat = switch size {
        case .xSmall: 0.85
        case .small: 0.9
        case .medium: 0.95
        case .large: 1
        case .xLarge: 1.1
        case .xxLarge: 1.2
        case .xxxLarge: 1.3
        default: 1.5
        }
        return ProseStyle(bodySize: base * scale)
    }
}

/// Immutable attributed text. Equal content/style has equal identity even after cache eviction.
final class ProseDocument {
    let id: String
    let style: ProseStyle
    let text: NSAttributedString

    init(identity: String, text: NSAttributedString, style: ProseStyle) {
        id = SHA256.hash(data: Data((style.generation + identity).utf8))
            .map { String(format: "%02x", $0) }.joined()
        self.text = NSAttributedString(attributedString: text)
        self.style = style
    }
}

struct ProseSegment: Identifiable {
    enum Content {
        case prose(ProseDocument)
        case image(alt: String, target: String, source: String)
        case table(MarkdownOutputView.MarkdownTable, source: String)
    }
    let id: Int
    let content: Content
}

@MainActor enum ProseBuilder {
    private final class Box {
        let segments: [ProseSegment]
        init(_ segments: [ProseSegment]) { self.segments = segments }
    }
    private static let cache: NSCache<NSString, Box> = {
        let value = NSCache<NSString, Box>()
        value.countLimit = 256
        value.totalCostLimit = 16 * 1024 * 1024
        return value
    }()

    static func plain(_ source: String, style: ProseStyle = .init()) -> ProseDocument {
        let key = "plain:\(style.generation):\(source)" as NSString
        if let hit = cache.object(forKey: key), case .prose(let doc) = hit.segments.first?.content { return doc }
        let text = NSAttributedString(string: source, attributes: [
            .font: style.font, .foregroundColor: NSColor.labelColor,
            .paragraphStyle: paragraph(spacing: Theme.Spacing.xs)
        ])
        let doc = ProseDocument(identity: "plain:" + source, text: text, style: style)
        cache.setObject(Box([.init(id: 0, content: .prose(doc))]), forKey: key, cost: source.utf16.count * 4)
        return doc
    }

    static func segments(_ markdown: String, style: ProseStyle) -> [ProseSegment] {
        let key = "\(style.generation):\(markdown)" as NSString
        if let hit = cache.object(forKey: key) { return hit.segments }
        var result: [ProseSegment] = []
        let run = NSMutableAttributedString(string: "")
        var identity = ""
        func flush() {
            guard run.length > 0 else { return }
            result.append(.init(id: result.count, content: .prose(
                ProseDocument(identity: identity, text: run, style: style))))
            run.setAttributedString(NSAttributedString(string: ""))
            identity = ""
        }
        func append(_ text: NSAttributedString) {
            if run.length > 0 { run.append(NSAttributedString(string: "\n")) }
            run.append(text)
        }
        for block in MarkdownOutputView.parse(markdown) {
            switch block.kind {
            case .image(let alt, let target):
                flush()
                result.append(.init(id: result.count, content: .image(alt: alt, target: target, source: block.text)))
            case .table(let table):
                flush()
                result.append(.init(id: result.count, content: .table(table, source: block.text)))
            case .code:
                // Each source line remains a real newline. Soft wrapping and indentation
                // are paragraph attributes, so copying never inserts continuation spaces.
                if run.length > 0,
                   let previous = run.attribute(.paragraphStyle, at: run.length - 1, effectiveRange: nil) as? NSParagraphStyle,
                   let ending = previous.mutableCopy() as? NSMutableParagraphStyle {
                    ending.paragraphSpacing = 0 // Match the final line of the separate prose host.
                    let last = (run.string as NSString).paragraphRange(for: NSRange(location: run.length - 1, length: 0))
                    run.addAttribute(.paragraphStyle, value: ending, range: last)
                }
                let box = ProseCodeBlock()
                box.setValue(100, type: .percentageValueType, for: .width)
                box.setWidth(Theme.Spacing.md, type: .absoluteValueType, for: .padding)
                box.setWidth(Theme.Spacing.md, type: .absoluteValueType, for: .margin, edge: .minY)
                box.setWidth(Theme.Spacing.md, type: .absoluteValueType, for: .margin, edge: .maxY)
                let p = paragraph(spacing: 0)
                p.textBlocks = [box]
                p.headIndent = ("  " as NSString).size(withAttributes: [.font: style.codeFont]).width
                p.firstLineHeadIndent = 0
                p.lineBreakMode = .byWordWrapping
                let header = ProseCodeActions.header(language: block.language, source: block.text,
                    index: block.id, paragraph: p, style: style)
                append(header)
                run.append(NSAttributedString(string: block.text, attributes: [
                    .font: style.codeFont, .foregroundColor: NSColor.labelColor, .paragraphStyle: p
                ]))
                identity += "code:" + (block.language ?? "text") + ":" + block.text + "\n"
            case .list:
                for item in block.text.components(separatedBy: "\n") {
                    let p = paragraph(spacing: Theme.Spacing.xs)
                    p.headIndent = Theme.Spacing.lg
                    p.tabStops = [NSTextTab(textAlignment: .left, location: Theme.Spacing.lg)]
                    let line = NSMutableAttributedString(string: "•\t", attributes: [
                        .font: style.font, .foregroundColor: NSColor.secondaryLabelColor
                    ])
                    line.append(inline(String(item.dropFirst(2)), font: style.font, style: style))
                    line.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: line.length))
                    append(line)
                }
                identity += "list:" + block.text + "\n"
            case .heading(let level):
                let font = NSFont.systemFont(ofSize: style.bodySize + (level == 1 ? 5 : level == 2 ? 2 : 0), weight: .semibold)
                append(inline(block.text, font: font, style: style))
                identity += "heading\(level):" + block.text + "\n"
            case .paragraph:
                append(inline(block.text, font: style.font, style: style))
                identity += "paragraph:" + block.text + "\n"
            }
        }
        flush()
        if result.isEmpty { result = [.init(id: 0, content: .prose(plain("", style: style)))] }
        cache.setObject(Box(result), forKey: key, cost: markdown.utf16.count * 6)
        return result
    }

    private static func paragraph(spacing: CGFloat) -> NSMutableParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.paragraphSpacing = spacing
        p.lineBreakMode = .byWordWrapping
        return p
    }

    static func tableCell(_ source: String, style: ProseStyle, header: Bool) -> ProseDocument {
        let font = NSFont.systemFont(ofSize: style.bodySize, weight: header ? .semibold : .regular)
        let text = NSMutableAttributedString(attributedString: inline(source, font: font, style: style))
        text.addAttribute(.paragraphStyle, value: paragraph(spacing: 0), range: NSRange(location: 0, length: text.length))
        return ProseDocument(identity: "table:\(header):" + source, text: text, style: style)
    }

    private static func inline(_ source: String, font: NSFont, style: ProseStyle) -> NSAttributedString {
        let parsed = MarkdownOutputView.inlineAttributed(source)
        let result = NSMutableAttributedString(string: "")
        for run in parsed.runs {
            let intent = run.inlinePresentationIntent ?? []
            var face = intent.contains(.code) ? style.codeFont : font
            if intent.contains(.stronglyEmphasized) { face = NSFontManager.shared.convert(face, toHaveTrait: .boldFontMask) }
            if intent.contains(.emphasized) { face = NSFontManager.shared.convert(face, toHaveTrait: .italicFontMask) }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: face, .foregroundColor: NSColor.labelColor,
                .paragraphStyle: paragraph(spacing: Theme.Spacing.md)
            ]
            if intent.contains(.code) { attributes[.backgroundColor] = NSColor(Theme.surfaceCode) }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            result.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return result
    }
}
