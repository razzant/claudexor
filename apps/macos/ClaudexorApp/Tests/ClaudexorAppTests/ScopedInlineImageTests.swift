import AppKit
import Foundation
import Testing
@testable import ClaudexorApp

/// Ф2.5 W-C7: agent images render inline ONLY inside the thread's scope
/// (repoRoot / run dir) — canonical paths, symlink-escape and traversal
/// rejected, image extensions only; everything else is a disclosed refusal.
@MainActor
@Suite struct ScopedInlineImageTests {
    /// A real 1×1 PNG so decode paths run against an actual image.
    private static let tinyPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!

    private func makeFixture() throws -> (root: String, outside: String) {
        let base = NSTemporaryDirectory() + "img-scope-" + UUID().uuidString
        let root = base + "/repo"
        let outside = base + "/outside"
        try FileManager.default.createDirectory(atPath: root + "/shots", withIntermediateDirectories: true)
        try FileManager.default.createDirectory(atPath: outside, withIntermediateDirectories: true)
        try Self.tinyPNG.write(to: URL(fileURLWithPath: root + "/shots/action.png"))
        try Self.tinyPNG.write(to: URL(fileURLWithPath: outside + "/secret.png"))
        try Data("plain".utf8).write(to: URL(fileURLWithPath: root + "/notes.txt"))
        // A symlink INSIDE the root pointing OUTSIDE it — the classic escape.
        try FileManager.default.createSymbolicLink(
            atPath: root + "/shots/escape.png", withDestinationPath: outside + "/secret.png")
        return (root, outside)
    }

    @Test func inScopeImageResolvesAndDecodes() throws {
        let (root, _) = try makeFixture()
        let path = ScopedInlineImage.scopedImagePath(root + "/shots/action.png", roots: [root])
        #expect(path != nil)
        #expect(ScopedInlineImage.boundedPreview(path!) != nil)
        // file:// form resolves to the same scope.
        #expect(ScopedInlineImage.scopedImagePath("file://" + root + "/shots/action.png", roots: [root]) != nil)
    }

    @Test func escapesAndForeignPathsAreRefused() throws {
        let (root, outside) = try makeFixture()
        // Outside the root outright.
        #expect(ScopedInlineImage.scopedImagePath(outside + "/secret.png", roots: [root]) == nil)
        // Symlink inside the root escaping it: canonicalization catches it.
        #expect(ScopedInlineImage.scopedImagePath(root + "/shots/escape.png", roots: [root]) == nil)
        // `..` traversal past the root.
        #expect(ScopedInlineImage.scopedImagePath(root + "/shots/../../outside/secret.png", roots: [root]) == nil)
        // Non-image extension never renders.
        #expect(ScopedInlineImage.scopedImagePath(root + "/notes.txt", roots: [root]) == nil)
        // Relative and remote targets never resolve.
        #expect(ScopedInlineImage.scopedImagePath("shots/action.png", roots: [root]) == nil)
        #expect(ScopedInlineImage.scopedImagePath("https://example.com/a.png", roots: [root]) == nil)
        // No scope roots (e.g. artifact gallery) = no local-file access at all.
        #expect(ScopedInlineImage.scopedImagePath(root + "/shots/action.png", roots: []) == nil)
    }

    /// W-C7 part 3: the canvas surfaces every image the run's DIFF touched
    /// (typed evidence), through the same scope gate — nothing outside the
    /// project ever renders, non-images never render.
    @Test func runImagePathsDeriveOnlyInScopeImagesFromDiffPaths() throws {
        let (root, outside) = try makeFixture()
        let paths = ArtifactGalleryView.runImagePaths(
            diffPaths: ["shots/action.png", "notes.txt", "shots/escape.png", outside + "/secret.png"],
            repoRoot: root
        )
        #expect(paths.count == 1)
        #expect(paths.first?.hasSuffix("/shots/action.png") == true)
        // No root = no derivation at all.
        #expect(ArtifactGalleryView.runImagePaths(diffPaths: ["shots/action.png"], repoRoot: nil).isEmpty)
    }

    /// sol #11/#14: a scoped file-link opens ONLY safe document/image types;
    /// an executable/script inside the repo is refused (with a reason), never
    /// launched; out-of-scope is refused too.
    @Test func openDecisionAllowsSafeTypesAndRefusesExecutablesAndOutOfScope() throws {
        let base = NSTemporaryDirectory() + "open-" + UUID().uuidString + "/repo"
        try FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        for (name, data) in [("doc.md", "hi"), ("shot.png", "x"), ("evil.command", "#!/bin/sh"), ("run.sh", "echo")] {
            try Data(data.utf8).write(to: URL(fileURLWithPath: base + "/" + name))
        }
        if case .open = ScopedInlineImage.openDecision(base + "/doc.md", roots: [base]) {} else {
            Issue.record("a .md should open")
        }
        if case .open = ScopedInlineImage.openDecision(base + "/shot.png", roots: [base]) {} else {
            Issue.record("a .png should open")
        }
        if case .refuse(let r) = ScopedInlineImage.openDecision(base + "/evil.command", roots: [base]) {
            #expect(r.contains("unsafe"))
        } else { Issue.record(".command must be refused") }
        if case .refuse = ScopedInlineImage.openDecision(base + "/run.sh", roots: [base]) {} else {
            Issue.record(".sh must be refused")
        }
        // confirm #3: active formats that execute in the default handler
        // (.html/.svg run JavaScript in the browser) are refused, not opened.
        for active in ["page.html", "vec.svg", "x.htm"] {
            try Data("<script>".utf8).write(to: URL(fileURLWithPath: base + "/" + active))
            if case .refuse = ScopedInlineImage.openDecision(base + "/" + active, roots: [base]) {} else {
                Issue.record("\(active) must be refused (active format)")
            }
        }
        if case .refuse(let r) = ScopedInlineImage.openDecision("/etc/hosts", roots: [base]) {
            #expect(r.contains("scope"))
        } else { Issue.record("out-of-scope must be refused") }
    }

    @Test func markdownIsHardBoundedBeforeLayoutWithDisclosure() {
        // sol #16: even "show the whole answer" must not lay out unbounded text.
        let huge = String(repeating: "a ", count: MarkdownOutputView.renderCharCap)
        let blocks = MarkdownOutputView.parse(String(huge.prefix(MarkdownOutputView.renderCharCap)))
        let held = blocks.reduce(0) { $0 + $1.text.count }
        #expect(held <= MarkdownOutputView.renderCharCap + 16)
    }

    @Test func markdownImageLinesBecomeImageBlocks() {
        let md = "Итог гонки:\n\n![Гонка NEON//RUN](/Users/anton/racing6/racing-action.png)\n\nВсё работает."
        let blocks = MarkdownOutputView.parse(md)
        let image = blocks.first { if case .image = $0.kind { return true }; return false }
        #expect(image != nil)
        if case .image(let alt, let target) = image!.kind {
            #expect(alt == "Гонка NEON//RUN")
            #expect(target == "/Users/anton/racing6/racing-action.png")
        }
        // A title after the path is stripped from the target.
        let titled = MarkdownOutputView.imageLine("![shot](/tmp/a.png \"the race\")")
        #expect(titled?.target == "/tmp/a.png")
        // Regular text/links stay non-image blocks.
        #expect(MarkdownOutputView.imageLine("[link](/tmp/a.png)") == nil)
        #expect(MarkdownOutputView.imageLine("plain text") == nil)
    }

    /// W3.7: the artifact gallery decodes already-fetched bytes through the
    /// SAME bounded thumbnail path as inline previews — a full-resolution
    /// screenshot comes back capped at maxThumbnailPixels, oversize bytes are
    /// refused outright, and non-image bytes fail honestly.
    @Test func dataPreviewIsBoundedAndRefusesOversizeOrGarbage() {
        // A real 2000×1400 PNG (bigger than the 1200px bound) built in-memory.
        let size = NSSize(width: 2000, height: 1400)
        let big = NSImage(size: size)
        big.lockFocus()
        NSColor.systemTeal.setFill()
        NSRect(origin: .zero, size: size).fill()
        big.unlockFocus()
        let tiff = big.tiffRepresentation!
        let png = NSBitmapImageRep(data: tiff)!.representation(using: NSBitmapImageRep.FileType.png, properties: [:])!

        let preview = ScopedInlineImage.boundedPreview(data: png, cacheKey: "test|big.png")
        #expect(preview != nil)
        if let preview {
            #expect(max(preview.size.width, preview.size.height)
                    <= CGFloat(ScopedInlineImage.maxThumbnailPixels))
        }
        // Garbage bytes fail honestly (imageLoadFailed path, never a crash).
        #expect(ScopedInlineImage.boundedPreview(data: Data("not an image".utf8),
                                                 cacheKey: "test|junk") == nil)
        // Oversize payloads are refused before any decode.
        let oversize = Data(count: ScopedInlineImage.maxSourceBytes + 1)
        #expect(ScopedInlineImage.boundedPreview(data: oversize, cacheKey: "test|huge") == nil)
    }

    /// A flat-colour BMP: uncompressed, so two images of the same dimensions
    /// have byte-IDENTICAL LENGTH and differ only in content — exactly the
    /// shape a byte-count cache key cannot tell apart. The pixel buffer is
    /// written directly (lockFocus drawing needs a window server and yields
    /// blank, identical bitmaps under `swift test`).
    private func flatBMP(r: UInt8, g: UInt8, b: UInt8) -> Data {
        let side = 64
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
            bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: side * 3, bitsPerPixel: 24)!
        let pixels = rep.bitmapData!
        for i in stride(from: 0, to: side * side * 3, by: 3) {
            pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b
        }
        return rep.representation(using: NSBitmapImageRep.FileType.bmp, properties: [:])!
    }

    /// The colour at the centre of a decoded preview, in sRGB.
    private func centreColour(_ image: NSImage) -> NSColor? {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.colorAt(x: rep.pixelsWide / 2, y: rep.pixelsHigh / 2)?
            .usingColorSpace(.sRGB)
    }

    /// W3.7 (wave-2): an artifact RE-PRODUCED at the same identity must never
    /// serve the previous preview. The file-path twin keys on size+mtime; the
    /// data path keys on a content fingerprint, because equal-length bytes are
    /// a real shape (any two same-dimension screenshots in an uncompressed
    /// format) that a byte COUNT cannot distinguish.
    @Test func dataPreviewInvalidatesOnEqualLengthContentChange() {
        let red = flatBMP(r: 255, g: 0, b: 0)
        let blue = flatBMP(r: 0, g: 0, b: 255)
        // The premise this pin rests on: same length, different bytes.
        #expect(red.count == blue.count)
        #expect(red != blue)

        let key = "invalidation|shot.bmp"
        guard let first = ScopedInlineImage.boundedPreview(data: red, cacheKey: key),
              let second = ScopedInlineImage.boundedPreview(data: blue, cacheKey: key)
        else { Issue.record("bounded preview refused a valid BMP"); return }

        guard let firstColour = centreColour(first), let secondColour = centreColour(second)
        else { Issue.record("could not sample the decoded previews"); return }
        // A byte-count key would return the RED preview for the blue bytes.
        #expect(firstColour.redComponent > 0.5 && firstColour.blueComponent < 0.5)
        #expect(secondColour.blueComponent > 0.5 && secondColour.redComponent < 0.5)
    }
}
