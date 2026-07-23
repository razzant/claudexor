import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// D-13 transcript-scroll performance regressions (packet P). These are
/// model/seam-level tests: a headless XCTest cannot invoke SwiftUI `body` or
/// measure live layout, so each asserts the deterministic invariant the view
/// change RELIES on. The live-scroll feel itself is a manual Visual-QA story
/// (DESIGN_SYSTEM §3.2 / §8).
@Suite(.serialized)
struct TurnCardPerfTests {

    /// A `harness.event` thinking envelope — the shape the transcript reducer folds.
    /// Consecutive thinking events MERGE into one block (segment semantics).
    private func thinking(_ seq: Int, _ text: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("thinking"), "text": .string(text)])
        ]))
    }

    /// A `harness.event` one-shot narration message — each appends its OWN block
    /// (no merge), so N of them produce N blocks and exercise the row cap.
    private func message(_ seq: Int, _ text: String) -> BusEnvelope {
        BusEnvelope(seq: seq, kind: "harness.event", event: .object([
            "type": .string("harness.event"),
            "payload": .object(["type": .string("message"), "text": .string(text)])
        ]))
    }

    /// D-13 A / GH #23 toggle path: the transcript the (now PLAIN, non-lazy)
    /// `TranscriptView` lays out is reducer-capped, so dropping the inner
    /// `LazyVStack` can never hand it an unbounded row array — the nested-lazy
    /// layout loop is closed structurally, not by laziness. Exercised through the
    /// exact app read path a receipt toggle uses (`transcriptBlocks`).
    @MainActor
    @Test func expandedTranscriptReadPathIsAlwaysReducerCapped() {
        let model = AppModel(requestNotificationAuthorization: false)
        let box = model.ensureLiveBox("run-cap")
        for i in 1...500 { box.transcript.apply(message(i, "narration step \(i)")) }
        let blocks = model.transcriptBlocks("run-cap")
        #expect(blocks.count <= 200)                          // reducer cap — laziness buys nothing
        #expect(model.transcriptTrimmedCount("run-cap") > 0)  // and the drop is disclosed
    }

    /// D-13 E containment: an UNRELATED AppModel write (a background sidebar
    /// refresh + a DIFFERENT run's live transcript) leaves run A's transcript
    /// blocks byte-identical, so the `.equatable()` guard on `TranscriptView`
    /// compares equal and SKIPS A's up-to-200-row re-layout. Asserted at the seam
    /// the guard keys on (transcript-blocks equality), since a headless test
    /// cannot observe a skipped SwiftUI body directly.
    @MainActor
    @Test func unrelatedRefreshLeavesOtherRunsTranscriptEquatableAndUnchanged() throws {
        let model = AppModel(requestNotificationAuthorization: false)
        let a = model.ensureLiveBox("run-A")
        for i in 1...5 { a.transcript.apply(thinking(i, "A step \(i)")) }
        let before = model.transcriptBlocks("run-A")

        // A "sidebar refresh" writes an unrelated stored property…
        model.threads = [try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"t1","title":"T","repoRoot":null,"mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z"}"#.utf8))]
        // …and a DIFFERENT run streams new transcript rows.
        let b = model.ensureLiveBox("run-B")
        for i in 1...9 { b.transcript.apply(thinking(i, "B step \(i)")) }

        let after = model.transcriptBlocks("run-A")
        #expect(after == before)  // run A's blocks untouched by the unrelated writes
        // Equal blocks ⇒ the EquatableView guard compares equal ⇒ body skipped.
        #expect(TranscriptView(blocks: after) == TranscriptView(blocks: before))
        // The guard never wrongly SUPPRESSES a real update: a genuine change to
        // A's own blocks compares unequal, so its transcript still re-lays-out.
        #expect(TranscriptView(blocks: after)
                != TranscriptView(blocks: after + [.message(id: "x", text: "new")]))
    }

    /// The debug render-count hook records only while enabled, so normal runs and
    /// release builds pay a single bool check per call.
    @MainActor
    @Test func renderProbeCountsOnlyWhileEnabled() {
        RenderProbe.reset()
        RenderProbe.enabled = false
        RenderProbe.record("k")
        #expect(RenderProbe.count("k") == 0)

        RenderProbe.enabled = true
        RenderProbe.record("k")
        RenderProbe.record("k")
        #expect(RenderProbe.count("k") == 2)

        // Leave the global probe OFF for any later suite.
        RenderProbe.reset()
        RenderProbe.enabled = false
        #expect(RenderProbe.count("k") == 0)
    }
}
