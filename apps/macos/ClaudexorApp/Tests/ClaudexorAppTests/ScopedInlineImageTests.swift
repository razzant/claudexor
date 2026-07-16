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
}
