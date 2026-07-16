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
}
