import Foundation
import SwiftUI
import Testing
@testable import ClaudexorApp

/// W22 acceptance fixtures: the final-answer markdown honestly supports
/// headings / lists / fenced code / links, and — since #24 — GFM pipe tables.
/// Everything else still degrades to readable paragraphs.
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

    // MARK: - #24 GFM tables

    /// Pulls the single `.table` payload out of a block list, or nil.
    private func onlyTable(_ blocks: [MarkdownOutputView.MarkdownBlock]) -> MarkdownOutputView.MarkdownTable? {
        let tables = blocks.compactMap { block -> MarkdownOutputView.MarkdownTable? in
            if case .table(let t) = block.kind { return t }
            return nil
        }
        return tables.count == 1 ? tables.first : nil
    }

    @Test func simpleTableParsesHeaderAndRows() {
        let md = """
        | Mode | What it does |
        | --- | --- |
        | ask | Read-only answer |
        | plan | Read-only plan |
        """
        let blocks = MarkdownOutputView.parse(md)
        #expect(blocks.map(\.kind) == [.table(MarkdownOutputView.MarkdownTable(
            header: ["Mode", "What it does"],
            alignments: [.leading, .leading],
            rows: [["ask", "Read-only answer"], ["plan", "Read-only plan"]],
            truncatedRows: 0, truncatedColumns: 0))])
    }

    @Test func optionalOuterPipesAreEquivalent() {
        let withPipes = onlyTable(MarkdownOutputView.parse("| a | b |\n| --- | --- |\n| 1 | 2 |"))
        let without = onlyTable(MarkdownOutputView.parse("a | b\n--- | ---\n1 | 2"))
        #expect(withPipes != nil)
        #expect(withPipes == without)
    }

    @Test func alignmentVariantsFromDelimiterRow() {
        let md = "| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |"
        let table = onlyTable(MarkdownOutputView.parse(md))
        #expect(table?.alignments == [.leading, .center, .trailing])
    }

    @Test func escapedPipeAndInlineCodePipeStayInsideOneCell() {
        // First body cell has an escaped pipe; second has a pipe inside code.
        let md = "| a | b |\n| --- | --- |\n| x \\| y | `p|q` |"
        let table = onlyTable(MarkdownOutputView.parse(md))
        #expect(table?.rows == [["x | y", "`p|q`"]])
    }

    @Test func inlineFormattingIsPreservedInCellText() {
        let md = "| col |\n| --- |\n| see [doc](https://example.com) **bold** |"
        let table = onlyTable(MarkdownOutputView.parse(md))
        #expect(table?.rows.first?.first == "see [doc](https://example.com) **bold**")
        // The cell text still yields a real link through the shared inline path.
        let parsed = MarkdownOutputView.inlineAttributed(table?.rows.first?.first ?? "")
        #expect(parsed.runs.contains { $0.link != nil })
    }

    @Test func missingDelimiterFallsBackToParagraph() {
        // Header-shaped line but the next line is not a delimiter row.
        let blocks = MarkdownOutputView.parse("| a | b |\n| just some prose here |")
        #expect(!blocks.contains { if case .table = $0.kind { return true }; return false })
        #expect(blocks.allSatisfy { $0.kind == .paragraph })
    }

    @Test func mismatchedColumnCountIsNotATable() {
        // Header has 2 columns, delimiter has 1 → not a table.
        let blocks = MarkdownOutputView.parse("| a | b |\n| --- |\n| 1 | 2 |")
        #expect(!blocks.contains { if case .table = $0.kind { return true }; return false })
    }

    @Test func bodyStopsAtFirstNonRowLine() {
        let md = """
        | a | b |
        | --- | --- |
        | 1 | 2 |
        | 3 | 4 |

        Trailing paragraph.
        """
        let blocks = MarkdownOutputView.parse(md)
        let table = onlyTable(blocks)
        #expect(table?.rows == [["1", "2"], ["3", "4"]])
        // The prose after the blank line is its own paragraph, not a table row.
        #expect(blocks.last.map { $0.kind == .paragraph && $0.text == "Trailing paragraph." } == true)
    }

    @Test func tableInsideSurroundingProseStaysSeparate() {
        let md = """
        Intro paragraph.

        | a | b |
        | --- | --- |
        | 1 | 2 |

        Outro paragraph.
        """
        let blocks = MarkdownOutputView.parse(md)
        #expect(blocks.map(\.kind) == [.paragraph, .table(MarkdownOutputView.MarkdownTable(
            header: ["a", "b"], alignments: [.leading, .leading],
            rows: [["1", "2"]], truncatedRows: 0, truncatedColumns: 0)), .paragraph])
        #expect(blocks.first?.text == "Intro paragraph.")
        #expect(blocks.last?.text == "Outro paragraph.")
    }

    @Test func tableShapedTextInsideFenceStaysCode() {
        let md = "```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```"
        let blocks = MarkdownOutputView.parse(md)
        #expect(blocks.map(\.kind) == [.code])
        #expect(blocks.first?.text == "| a | b |\n| --- | --- |\n| 1 | 2 |")
    }

    @Test func midStreamHeaderStaysParagraphUntilDelimiterArrives() {
        // Header alone (delimiter not yet streamed) is not a table.
        let partial = MarkdownOutputView.parse("| a | b |")
        #expect(!partial.contains { if case .table = $0.kind { return true }; return false })
        // Once the complete delimiter row arrives, it becomes a table.
        let complete = MarkdownOutputView.parse("| a | b |\n| --- | --- |")
        #expect(onlyTable(complete)?.header == ["a", "b"])
    }

    @Test func rowColumnAndCellCapsBoundTheTable() {
        // Columns beyond the cap are clipped and disclosed.
        let wideCols = (0..<(MarkdownOutputView.maxTableColumns + 3)).map { "c\($0)" }
        let headerLine = "| " + wideCols.joined(separator: " | ") + " |"
        let delimLine = "| " + wideCols.map { _ in "---" }.joined(separator: " | ") + " |"
        // Rows beyond the cap are clipped and disclosed.
        let bodyLines = (0..<(MarkdownOutputView.maxTableRows + 5)).map { r in
            "| " + wideCols.map { _ in "\(r)" }.joined(separator: " | ") + " |"
        }
        // One oversized cell exceeds the per-cell character cap.
        let bigCellRow = "| " + wideCols.enumerated().map { i, _ in
            i == 0 ? String(repeating: "x", count: MarkdownOutputView.maxTableCellChars + 50) : "y"
        }.joined(separator: " | ") + " |"

        let md = ([headerLine, delimLine, bigCellRow] + bodyLines).joined(separator: "\n")
        let table = onlyTable(MarkdownOutputView.parse(md))
        #expect(table?.header.count == MarkdownOutputView.maxTableColumns)
        #expect(table?.truncatedColumns == 3)
        #expect(table?.rows.count == MarkdownOutputView.maxTableRows)
        #expect(table?.truncatedRows == 6) // (maxRows + 5 body) + 1 bigCell row - maxRows
        // The oversized cell is bounded with an ellipsis.
        let firstCell = table?.rows.first?.first ?? ""
        #expect(firstCell.count == MarkdownOutputView.maxTableCellChars + 1) // capped + "…"
        #expect(firstCell.hasSuffix("…"))
    }

    @Test func renderCharCapExcludesATablePushedBeyondTheBound() {
        // A table that only appears AFTER renderCharCap must not render: the
        // cap is applied before parse, so the truncated prefix has no table.
        let filler = String(repeating: "filler line\n", count: MarkdownOutputView.renderCharCap / 5)
        let md = filler + "\n| a | b |\n| --- | --- |\n| 1 | 2 |"
        #expect(md.count > MarkdownOutputView.renderCharCap)
        let bounded = String(md.prefix(MarkdownOutputView.renderCharCap))
        let blocks = MarkdownOutputView.parse(bounded)
        #expect(!blocks.contains { if case .table = $0.kind { return true }; return false })
    }

    @Test func tableViewBuildsWithoutCrashing() {
        // Render smoke: the dedicated table view constructs and its body evaluates.
        let table = MarkdownOutputView.MarkdownTable(
            header: ["a", "b"], alignments: [.leading, .trailing],
            rows: [["1", "2"]], truncatedRows: 2, truncatedColumns: 1)
        let view = MarkdownTableView(table: table, bodyFont: .callout)
        _ = view.body
        // The whole markdown view builds with a table block too.
        let outer = MarkdownOutputView(markdown: "| a | b |\n| --- | --- |\n| 1 | 2 |")
        _ = outer.body
    }
}
