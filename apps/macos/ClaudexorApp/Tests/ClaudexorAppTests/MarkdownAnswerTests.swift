import Foundation
import Testing
@testable import ClaudexorApp

/// W22 acceptance fixtures: the final-answer markdown honestly supports
/// headings / lists / fenced code / links; everything else degrades to
/// readable paragraphs (tables/blockquotes are out of scope by design).
@MainActor
@Suite struct MarkdownAnswerTests {
    @Test func headingsSplitIntoTypedBlocks() {
        let blocks = MarkdownOutputView.parse("# Title\n\nBody text")
        #expect(blocks.map(\.kind) == [.heading(1), .paragraph])
        #expect(blocks.first?.text == "Title")
    }

    @Test func listsKeepOneRowPerItemIncludingOrdered() {
        let blocks = MarkdownOutputView.parse("- alpha\n- beta\n\n1. one\n2. two")
        #expect(blocks.map(\.kind) == [.list, .list])
        #expect(blocks[0].text == "• alpha\n• beta")
        #expect(blocks[1].text == "• one\n• two")
    }

    @Test func fencedCodePreservesNewlinesAndNeverParsesInline() {
        let blocks = MarkdownOutputView.parse("```\nlet a = 1\nlet b = 2\n```")
        #expect(blocks.map(\.kind) == [.code])
        #expect(blocks.first?.text == "let a = 1\nlet b = 2")
    }

    @Test func inlineLinksCarryARealLinkAttribute() {
        let parsed = MarkdownOutputView.inlineAttributed("see [the doc](https://example.com/spec)")
        let hasLink = parsed.runs.contains { $0.link != nil }
        #expect(hasLink)
    }

    @Test func longAnswerDetectionCollapsesWallsOfTextOnly() {
        #expect(!TurnCard.isLongAnswer("short answer"))
        #expect(TurnCard.isLongAnswer(String(repeating: "long text ", count: 200)))
        #expect(TurnCard.isLongAnswer(Array(repeating: "line", count: 20).joined(separator: "\n")))
    }
}
