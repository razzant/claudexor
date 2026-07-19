import Testing
@testable import ClaudexorKit

/// Continuity disclosure one-liner (INV-137/D21): the Swift port of the
/// engine's `continuityLabel` must read the SAME sentence as the CLI, and only
/// a `packet` continuation discloses.
@Suite struct ContinuityDisclosureTests {
    private func c(_ kind: String, turns: Int = 0, summarized: Bool = false,
                   from: LaneSwitchedFrom? = nil) -> ThreadTurnContinuity {
        ThreadTurnContinuity(kind: kind, packetTurns: turns, summarized: summarized, laneSwitchedFrom: from)
    }

    @Test func nativeResumeAndFreshDiscloseNothing() {
        #expect(c("native_resume", turns: 3).disclosure == nil)
        #expect(c("fresh").disclosure == nil)
    }

    @Test func packetDisclosesTurnCount() {
        #expect(c("packet", turns: 1).disclosure == "continued with thread context · 1 turn")
        #expect(c("packet", turns: 4).disclosure == "continued with thread context · 4 turns")
    }

    @Test func packetAppendsCondensedAndLaneSwitch() {
        let note = c("packet", turns: 6, summarized: true,
                     from: .init(harness: "codex", profileId: nil)).disclosure
        #expect(note == "continued with thread context · 6 turns (older turns condensed) · switched from codex")
    }
}
