import Testing
@testable import ClaudexorApp

/// Presentation-level contract for the shared row component (UI cut 3 §1). The
/// owner-round-3 bug was a detail line WRAPPING into fragments that interleaved
/// the trailing control columns — so the load-bearing, testable rule is the
/// single-line derivation the identity block applies to every detail.
@Suite struct AlignedListRowTests {
    @Test func singleLineCollapsesEveryWhitespaceRun() {
        // Newlines, tabs and repeated spaces all collapse to ONE space so the
        // line can never wrap into multiple fragments.
        #expect(AlignedRowText.singleLine("63% used · resets Jul 25") == "63% used · resets Jul 25")
        #expect(AlignedRowText.singleLine("63% used\n· resets\nJul 25") == "63% used · resets Jul 25")
        #expect(AlignedRowText.singleLine("a\t\tb   c\r\nd") == "a b c d")
        #expect(AlignedRowText.singleLine("  leading and trailing  ") == "leading and trailing")
        #expect(AlignedRowText.singleLine("") == "")
    }

    @Test func detailRendersItsSingleLineFormButKeepsFullTextForHelp() {
        // The rendered form is single-line; the ORIGINAL (multi-line) text is
        // preserved verbatim so the component can expose it via `.help`.
        let detail = AlignedRowDetail(0, "line one\nline two", emphasis: .warning)
        #expect(detail.singleLine == "line one line two")
        #expect(detail.text == "line one\nline two")
        #expect(detail.emphasis == .warning)
    }
}
