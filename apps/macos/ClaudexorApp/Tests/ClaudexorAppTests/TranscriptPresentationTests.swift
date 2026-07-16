import Foundation
import Testing
import AppKit
import ClaudexorKit
@testable import ClaudexorApp

/// Ф2.5 W-C3/W-C6: transcript presentation helpers — humane tool titles from
/// TYPED fields, per-kind glyphs that actually exist, and the reasoning
/// segment timer label.
@MainActor
@Suite struct TranscriptPresentationTests {
    private func tool(kind: String?, name: String = "shell", target: String?) -> ToolBlock {
        ToolBlock(name: name, kind: kind, target: target, status: .ok, detail: nil, exitCode: nil)
    }

    @Test func commandTitleIsTheBinaryBasenameAndSubtitleKeepsTheFullTarget() {
        let long = tool(kind: "command", target: "/opt/homebrew/bin/pnpm -r test --filter engine")
        #expect(ToolRow.title(long) == "pnpm")
        #expect(ToolRow.subtitle(long) == "/opt/homebrew/bin/pnpm -r test --filter engine")

        // A bare single-word command is not repeated as its own subtitle.
        let bare = tool(kind: "command", target: "ls")
        #expect(ToolRow.title(bare) == "ls")
        #expect(ToolRow.subtitle(bare) == nil)
    }

    @Test func nonCommandKindsKeepTheToolNameAndTargetAsContext() {
        let web = tool(kind: "web", name: "web_search", target: "claudexor release notes")
        #expect(ToolRow.title(web) == "web_search")
        #expect(ToolRow.subtitle(web) == "claudexor release notes")

        let untargeted = tool(kind: "file", name: "Edit", target: nil)
        #expect(ToolRow.title(untargeted) == "Edit")
        #expect(ToolRow.subtitle(untargeted) == nil)
    }

    /// Every kind glyph must be a REAL SF Symbol — a bad name renders as an
    /// invisible blank (the Ф2 "<glyph>.slash" lesson).
    @Test func everyKindGlyphExistsAsAnSFSymbol() {
        for kind in ["command", "web", "file", "mcp", "search", "other", nil] {
            let glyph = ToolRow.kindGlyph(kind)
            #expect(NSImage(systemSymbolName: glyph, accessibilityDescription: nil) != nil,
                    "missing SF Symbol: \(glyph)")
        }
    }

    @Test func thinkingLabelShowsTheSegmentSpanOnlyOnceKnown() {
        #expect(TranscriptView.thinkingLabel(seconds: 0) == "Thinking")
        #expect(TranscriptView.thinkingLabel(seconds: 0.4) == "Thinking")
        #expect(TranscriptView.thinkingLabel(seconds: 12) == "Thinking · 12s")
        #expect(TranscriptView.thinkingLabel(seconds: 125) == "Thinking · 2m 05s")
    }

    /// W-C5 status line: the terminal turn's frozen duration label.
    @Test func turnDurationLabelFormatsSecondsAndMinutes() {
        #expect(TurnCard.durationLabel(seconds: 41) == "41s")
        #expect(TurnCard.durationLabel(seconds: 60) == "1m 00s")
        #expect(TurnCard.durationLabel(seconds: 125) == "2m 05s")
    }
}
