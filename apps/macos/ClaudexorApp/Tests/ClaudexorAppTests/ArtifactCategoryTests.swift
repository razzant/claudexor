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

    @Test func sizeTextIsHumanOrNilWhenUnknown() {
        #expect(artifactSizeText(nil) == nil)
        #expect(artifactSizeText(0) != nil)
        #expect(artifactSizeText(2048) != nil)
    }
}
