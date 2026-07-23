import Testing
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
