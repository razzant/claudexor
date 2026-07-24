import Testing
import Foundation
import ClaudexorKit
@testable import ClaudexorApp

/// M9-UX item 8b: artifacts split into IMAGE cards vs. compact TEXT rows (with a
/// full text viewer) vs. open-externally files. The categorizer keys off the
/// server MIME first, then the filename extension for generic/absent MIME.
@Suite struct ArtifactCategoryTests {
    @Test func imagesAreImagesExceptSvg() {
        #expect(ArtifactCategory.of(mime: "image/png", path: "shot.png") == .image)
        #expect(ArtifactCategory.of(mime: "image/jpeg", path: "a.jpg") == .image)
        // SVG is XML text, not a raster image — it renders/opens as text.
        #expect(ArtifactCategory.of(mime: "image/svg+xml", path: "icon.svg") == .text)
    }

    @Test func textLikeFormatsAreText() {
        #expect(ArtifactCategory.of(mime: "text/markdown", path: "README.md") == .text)
        #expect(ArtifactCategory.of(mime: "text/plain", path: "notes.txt") == .text)
        #expect(ArtifactCategory.of(mime: "application/json", path: "data.json") == .text)
        #expect(ArtifactCategory.of(mime: "application/x-yaml", path: "cfg.yaml") == .text)
    }

    @Test func absentMimeFallsBackToExtension() {
        // The defect class: a .md the server didn't tag must STILL open as text.
        #expect(ArtifactCategory.of(mime: nil, path: "REPORT.md") == .text)
        #expect(ArtifactCategory.of(mime: "", path: "run.log") == .text)
        #expect(ArtifactCategory.of(mime: nil, path: "conf.yml") == .text)
        #expect(ArtifactCategory.of(mime: nil, path: "tbl.csv") == .text)
    }

    @Test func binariesOpenExternally() {
        #expect(ArtifactCategory.of(mime: "application/pdf", path: "doc.pdf") == .other)
        #expect(ArtifactCategory.of(mime: "application/octet-stream", path: "a.bin") == .other)
        #expect(ArtifactCategory.of(mime: nil, path: "archive.zip") == .other)
    }

    // QA-067 parity: every extension the SERVER treats as semantic TEXT (redacts
    // + 4 MiB cap) must also be `.text` in the App, so an eager preview never
    // takes the raw-binary "open externally" path for a class the server redacts.
    @Test func codeAndConfigFilesAreTextMatchingServer() {
        // Source code (octet-stream MIME from the server → extension fallback).
        for path in ["main.py", "app.ts", "index.js", "mod.rs", "svc.go", "Main.java", "q.sql", "run.sh"] {
            #expect(ArtifactCategory.of(mime: "application/octet-stream", path: path) == .text)
        }
        // Config / markup.
        for path in ["cfg.toml", "app.ini", "opts.cfg", "site.conf", "style.css", "data.json5"] {
            #expect(ArtifactCategory.of(mime: nil, path: path) == .text)
        }
    }

    @Test func semanticTextSetHasRepresentativeMembership() {
        // The AUTHORITATIVE server↔Swift parity gate is scripts/artifact-text-parity-check.mjs
        // (X102) — a THIRD hardcoded copy of the extension list here just drifted
        // independently (round-3 #10). Keep only representative membership: a few
        // known-in (source + config + markup) and a few known-out (truly binary).
        for ext in ["ts", "py", "toml", "svg", "json5", "sql"] {
            #expect(ArtifactCategory.semanticTextExtensions.contains(ext))
        }
        for ext in ["pdf", "png", "zip", "bin", "jpg"] {
            #expect(!ArtifactCategory.semanticTextExtensions.contains(ext))
        }
    }

    @Test func sizeTextIsHumanOrNilWhenUnknown() {
        #expect(artifactSizeText(nil) == nil)
        #expect(artifactSizeText(0) != nil)
        #expect(artifactSizeText(2048) != nil)
    }
}

/// Bounded-evidence disclosure: the thread-aggregated gallery must never silently
/// omit a run whose artifact listing failed. The pure aggregation reports the
/// failed run ids alongside the successful snapshot, which the view renders as a
/// partial-results warning WITH a Retry (the successful artifacts stay visible).
@Suite struct ArtifactGalleryAggregateTests {
    /// Build a listing via the public Codable path (no init-visibility coupling).
    private func listing(_ paths: [String]) -> [ArtifactInfo] {
        let objs = paths.map { #"{"path":"\#($0)","kind":"file","mime":"text/markdown"}"# }
        let json = "[\(objs.joined(separator: ","))]"
        return try! JSONDecoder().decode([ArtifactInfo].self, from: Data(json.utf8))
    }

    @Test func oneRunFailsWhileAnotherLoadsShowsPartialAndDisclosesFailure() {
        // run-A returns artifacts; run-B's listing threw (a present key with a nil
        // value, exactly as `fetchListings` records a per-run transport failure).
        var byRun: [String: [ArtifactInfo]?] = ["run-A": listing(["final/report.md"])]
        byRun.updateValue(nil, forKey: "run-B")
        let (combined, failed) = ArtifactGalleryView.aggregate(
            runIds: ["run-A", "run-B"], byRun: byRun)
        // The successful run's outputs stay visible...
        #expect(combined.count == 1)
        #expect(combined.first?.runId == "run-A")
        #expect(combined.first?.art.path == "final/report.md")
        // ...AND the failed run is disclosed (drives the banner + Retry), not dropped.
        #expect(failed == ["run-B"])
    }

    @Test func allRunsSucceedDiscloseNoFailure() {
        let byRun: [String: [ArtifactInfo]?] = [
            "run-A": listing(["a.md"]),
            "run-B": listing(["b.md"]),
        ]
        let (combined, failed) = ArtifactGalleryView.aggregate(
            runIds: ["run-A", "run-B"], byRun: byRun)
        #expect(combined.count == 2)
        #expect(failed.isEmpty)
    }

    @Test func duplicatePathsWithinARunAreDeDuplicated() {
        let byRun: [String: [ArtifactInfo]?] = ["run-A": listing(["x.md", "x.md", "y.md"])]
        let (combined, failed) = ArtifactGalleryView.aggregate(runIds: ["run-A"], byRun: byRun)
        #expect(combined.count == 2)
        #expect(failed.isEmpty)
    }

    @Test func aMissingRunEntryCountsAsFailedNotSilentlyEmpty() {
        // A run id with NO entry (e.g. an offline client returned `[:]`) must also
        // be disclosed as failed rather than treated as a clean empty result.
        let byRun: [String: [ArtifactInfo]?] = ["run-A": listing(["a.md"])]
        let (combined, failed) = ArtifactGalleryView.aggregate(
            runIds: ["run-A", "run-missing"], byRun: byRun)
        #expect(combined.count == 1)
        #expect(failed == ["run-missing"])
    }
}

/// Ф3 r7 critical #1 (follow-on edge of the round-6 disclosure fix): a refresh
/// over an EXISTING nonempty snapshot where EVERY run's listing fails must retain
/// the last-known snapshot AND disclose the failure (a "could not refresh" banner
/// with Retry) — it must never take the silent keep-last-known path that renders
/// stale artifacts as freshly confirmed. The retain-vs-disclose branch is a pure
/// decision so the regression is nailed down without a live view.
@Suite struct ArtifactGalleryLoadDecisionTests {
    @Test func failedRefreshOverNonemptySnapshotIsDisclosedNotSilent() {
        // The defect class: nonempty snapshot on screen, refresh aggregates to
        // nothing because every listing errored. The old code silently returned;
        // the fix keeps the snapshot AND records the failed runs for disclosure.
        let decision = ArtifactGalleryView.loadDecision(
            combinedIsEmpty: true, failed: ["run-A", "run-B"], existingNonEmpty: true)
        #expect(decision == .keepStale(failed: ["run-A", "run-B"]))
    }

    @Test func benignTransientEmptyOverSnapshotKeepsSilently() {
        // A live run still producing returns empty with NO failures — keep the
        // last-known snapshot silently (no banner), exactly as before.
        let decision = ArtifactGalleryView.loadDecision(
            combinedIsEmpty: true, failed: [], existingNonEmpty: true)
        #expect(decision == .keepStale(failed: []))
    }

    @Test func allFailWithNothingShownIsTheTypedError() {
        // No snapshot yet + a real transport failure → the typed error state,
        // never a silent empty.
        let decision = ArtifactGalleryView.loadDecision(
            combinedIsEmpty: true, failed: ["run-A"], existingNonEmpty: false)
        #expect(decision == .fail)
    }

    @Test func freshContentCommits() {
        // Content aggregated → commit it (carrying any partial-failure disclosure).
        #expect(ArtifactGalleryView.loadDecision(
            combinedIsEmpty: false, failed: ["run-B"], existingNonEmpty: true)
            == .commit(failed: ["run-B"]))
        #expect(ArtifactGalleryView.loadDecision(
            combinedIsEmpty: false, failed: [], existingNonEmpty: false)
            == .commit(failed: []))
    }

    @Test func emptyRefreshWithNoPriorContentCommitsEmpty() {
        // Nothing shown, refresh reports a clean empty (no failures) → commit the
        // empty state (a real "no artifacts"), not a fail and not a keep.
        #expect(ArtifactGalleryView.loadDecision(
            combinedIsEmpty: true, failed: [], existingNonEmpty: false)
            == .commit(failed: []))
    }
}
