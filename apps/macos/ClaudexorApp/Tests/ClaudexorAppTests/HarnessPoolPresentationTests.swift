import Foundation
import Testing
@testable import ClaudexorApp

/// Owner F9: the harness pool's Auto-vs-subset mode mapping. The wire body must
/// be UNCHANGED in Auto (empty pool = "no explicit pool"); only an explicit
/// subset sends ids. These pin that mapping so the UI can't drift from the wire.
@Suite struct HarnessPoolPresentationTests {
    private let available = ["claude", "codex", "cursor", "opencode"]

    @Test func emptyPoolIsAutoAndIncludesAllAvailable() {
        #expect(HarnessPoolPresentation.isAuto(pool: []))
        for id in available {
            #expect(HarnessPoolPresentation.isIncluded(id, pool: [], available: available))
        }
        #expect(HarnessPoolPresentation.caption(pool: []).hasPrefix("Auto"))
    }

    @Test func selectingAutoSendsEmptyWire() {
        // Auto's wire body is the "no explicit pool" the composer already sends.
        #expect(HarnessPoolPresentation.selectingAuto().isEmpty)
    }

    @Test func firstTapFromAutoMaterializesAllMinusTapped() {
        // Tapping one chip in Auto switches to explicit mode: the visible set was
        // "all available", so the result is all-available minus the tapped one, in
        // canonical order.
        let next = HarnessPoolPresentation.toggling("codex", pool: [], available: available)
        #expect(next == ["claude", "cursor", "opencode"])
        #expect(!HarnessPoolPresentation.isAuto(pool: next))
        #expect(HarnessPoolPresentation.caption(pool: next).hasPrefix("Explicit"))
    }

    @Test func explicitModeTogglesWithinSubsetAndKeepsOrder() {
        let pool = ["claude", "cursor"]
        // Re-add a harness → canonical order, not append order.
        #expect(HarnessPoolPresentation.toggling("codex", pool: pool, available: available)
                == ["claude", "codex", "cursor"])
        // Remove one → the remainder.
        #expect(HarnessPoolPresentation.toggling("claude", pool: pool, available: available)
                == ["cursor"])
    }

    @Test func explicitInclusionReflectsSubsetNotAll() {
        let pool = ["claude"]
        #expect(HarnessPoolPresentation.isIncluded("claude", pool: pool, available: available))
        #expect(!HarnessPoolPresentation.isIncluded("codex", pool: pool, available: available))
    }

    @Test func emptyingTheSubsetFallsBackToAuto() {
        // Removing the last explicit harness leaves an empty pool = Auto (the wire
        // treats empty as auto, so the UI must read it the same way).
        let next = HarnessPoolPresentation.toggling("claude", pool: ["claude"], available: available)
        #expect(next.isEmpty)
        #expect(HarnessPoolPresentation.isAuto(pool: next))
    }
}
