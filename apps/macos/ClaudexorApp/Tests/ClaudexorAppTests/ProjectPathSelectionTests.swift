import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

// Git fixture setup blocks on child pipe reads and exit waits. Bound this suite's
// fan-out (including argument cases) so it cannot monopolize the shared executor
// while other suites measure async process responsiveness.
@Suite(.serialized) struct ProjectPathSelectionTests {
    @Test func fixturesUseCheckoutScratchWithoutLauncherConfiguration() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        var checkout = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { checkout.deleteLastPathComponent() }
        #expect(fixture.root.deletingLastPathComponent().path
            == checkout.appendingPathComponent(".build/test-fixtures").resolvingSymlinksInPath().path)
    }

    @Test func uniqueBasenamesStayQuiet() {
        let paths = ["/work/alpha/app", "/work/beta/tools"]
        #expect(ProjectPathSelection.recentProjectLabel(paths[0], among: paths) == "app")
        #expect(ProjectPathSelection.recentProjectLabel(paths[1], among: paths) == "tools")
    }

    @Test func duplicateBasenamesUseTheShortestContiguousParentSuffix() {
        let paths = ["/work/red/shared/app", "/work/blue/shared/app", "/work/blue/other/app"]
        // Hand-derived expectations: red/blue alone would omit the immediate parent.
        #expect(ProjectPathSelection.recentProjectLabel(paths[0], among: paths) == "app — red/shared")
        #expect(ProjectPathSelection.recentProjectLabel(paths[1], among: paths) == "app — blue/shared")
        #expect(ProjectPathSelection.recentProjectLabel(paths[2], among: paths) == "app — other")
    }

    @Test func aSingleParentIsEnoughWhenItDistinguishesTheFolders() {
        let paths = ["/work/Release One/app", "/work/Release Two/app"]
        #expect(ProjectPathSelection.recentProjectLabel(paths[0], among: paths) == "app — Release One")
        #expect(ProjectPathSelection.recentProjectLabel(paths[1], among: paths) == "app — Release Two")
    }

    @Test func equivalentRepeatedPathsDoNotCreateArtificialAmbiguity() {
        let paths = ["/work/app", "/work/app/", "/work/other/../app"]
        for path in paths {
            #expect(ProjectPathSelection.recentProjectLabel(path, among: paths) == "app")
        }
    }

    @Test func suffixesDistinguishAnAncestorFromItsDescendant() {
        let paths = ["/work/app", "/work/work/app"]
        #expect(ProjectPathSelection.recentProjectLabel(paths[0], among: paths) == "app — /work")
        #expect(ProjectPathSelection.recentProjectLabel(paths[1], among: paths) == "app — work/work")
    }

    @Test func remoteMenusCanFormatPathsWithoutFilesystemOrCrossHostCollisions() {
        let oneHost = ["/srv/red/app", "/srv/blue/app"]
        let anotherHost = ["/srv/red/app"]
        #expect(ProjectPathSelection.recentProjectLabel(oneHost[0], among: oneHost) == "app — red")
        #expect(ProjectPathSelection.recentProjectLabel(anotherHost[0], among: anotherHost) == "app")
        let homeRelative = ["~/red/app", "~/blue/app"]
        #expect(ProjectPathSelection.recentProjectLabel(homeRelative[0], among: homeRelative) == "app — red")
    }

    @Test func ordinaryDirectoriesStayOrdinaryAndTheProbeDoesNotInitializeGit() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("ordinary folder")
        #expect(fixture.status(folder) == .ordinaryFolder)
        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent(".git").path))
        #expect(fixture.status(fixture.root) == .ordinaryFolder)
    }

    @Test func missingEmptyAndFileSelectionsAreUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        #expect(fixture.status(fixture.root.appendingPathComponent("missing")) == .unavailable)
        #expect(ProjectPathSelection.checkoutStatus(
            for: "", isLocal: true, searchBoundary: fixture.root.path) == .unavailable)
        let file = try fixture.write("ordinary file", at: "file")
        #expect(fixture.status(file) == .unavailable)
    }

    @Test func primaryCheckoutAndItsSubdirectoryAreDetectedWithoutMutation() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let main = try fixture.repository("primary checkout")
        let nested = try fixture.directory("primary checkout/source/nested")
        let head = main.appendingPathComponent(".git/HEAD")
        let config = main.appendingPathComponent(".git/config")
        let before = try [Data(contentsOf: head), Data(contentsOf: config)]
        #expect(fixture.status(main) == .primaryCheckout)
        #expect(fixture.status(nested) == .primaryCheckout)
        #expect(try [Data(contentsOf: head), Data(contentsOf: config)] == before)
    }

    @Test(arguments: ["garbage\n", "ref: \n", "ref: HEAD\n", "ref: refs/heads/main\ntrailing garbage\n",
                      String(repeating: "g", count: 40) + "\n", "\n" + String(repeating: "a", count: 40) + "\n"])
    func forgedRepositoryWithMalformedHeadIsUnavailable(head: String) throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("forged checkout")
        _ = try fixture.directory("forged checkout/.git/objects")
        _ = try fixture.directory("forged checkout/.git/refs")
        try Data(head.utf8).write(to: folder.appendingPathComponent(".git/HEAD"))
        #expect(fixture.status(folder) == .unavailable)
    }

    @Test func registeredWorktreeWithMalformedAdministrativeHeadIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let admin = try fixture.adminDirectory(for: linked)
        try Data("garbage\n".utf8).write(to: admin.appendingPathComponent("HEAD"))
        #expect(fixture.status(linked) == .unavailable)
        #expect(fixture.status(fixture.root.appendingPathComponent("primary checkout")) == .primaryCheckout)
    }

    @Test func registeredWorktreeWithMalformedCommonRepositoryHeadIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let main = fixture.root.appendingPathComponent("primary checkout")
        try Data("garbage\n".utf8).write(to: main.appendingPathComponent(".git/HEAD"))
        #expect(fixture.status(main) == .unavailable)
        #expect(fixture.status(linked) == .unavailable)
    }

    // Git's own discovery accepts any `ref:` into refs/, including reftable's placeholder.
    @Test(arguments: ["ref: refs/heads/unborn\n", "ref:\trefs/heads/feature/topic\n", "ref: refs/heads/.invalid\n",
                      String(repeating: "a", count: 40) + "\n", String(repeating: "B", count: 64) + "\n"])
    func validSymbolicAndDetachedHeadsRemainSupported(head: String) throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let main = fixture.root.appendingPathComponent("primary checkout")
        let admin = try fixture.adminDirectory(for: linked)
        try Data(head.utf8).write(to: main.appendingPathComponent(".git/HEAD"))
        try Data(head.utf8).write(to: admin.appendingPathComponent("HEAD"))
        #expect(fixture.status(main) == .primaryCheckout)
        #expect(fixture.status(linked) == .linkedWorktree("linked checkout"))
    }

    @Test func linkedDetachedWorktreeWithSpacesAndItsSubdirectoryAreDetected() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let nested = try fixture.directory("linked checkout/source/nested")
        let marker = linked.appendingPathComponent(".git")
        let before = try Data(contentsOf: marker)
        #expect(fixture.status(linked) == .linkedWorktree("linked checkout"))
        #expect(fixture.status(nested) == .linkedWorktree("linked checkout"))
        #expect(try Data(contentsOf: marker) == before)
    }

    @Test func canonicalSymlinkSpellingKeepsWorktreeMembership() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let alias = fixture.root.appendingPathComponent("checkout alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: linked)
        #expect(fixture.status(alias) == .linkedWorktree("linked checkout"))
    }

    @Test func relativeGitdirAndCommonDirPointersAreSupported() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let admin = try fixture.adminDirectory(for: linked)
        let relativeAdmin = "../primary checkout/.git/worktrees/" + admin.lastPathComponent
        try Data("gitdir: \(relativeAdmin)\n".utf8).write(to: linked.appendingPathComponent(".git"))
        // Git's native fixture already uses ../.. for commondir.
        #expect(try String(contentsOf: admin.appendingPathComponent("commondir"), encoding: .utf8) == "../..\n")
        #expect(fixture.status(linked) == .linkedWorktree("linked checkout"))
    }

    @Test func separateGitDirectoryIsAPrimaryCheckoutNotALinkedWorktree() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let main = try fixture.directory("separate checkout")
        let metadata = fixture.root.appendingPathComponent("separate metadata")
        try fixture.git(["init", "--template=", "--initial-branch=main",
                         "--separate-git-dir", metadata.path, main.path])
        #expect(fixture.status(main) == .primaryCheckout)
    }

    @Test func reftableCheckoutsAreRecognizedFromGitsDiscoveryPlaceholder() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree(refFormat: "reftable")
        let main = fixture.root.appendingPathComponent("primary checkout")
        let admin = try fixture.adminDirectory(for: linked)
        // Refs live in reftable/; HEAD is a placeholder Git writes only to stay discoverable.
        for head in [main.appendingPathComponent(".git/HEAD"), admin.appendingPathComponent("HEAD")] {
            #expect(try String(contentsOf: head, encoding: .utf8) == "ref: refs/heads/.invalid\n")
        }
        #expect(fixture.status(main) == .primaryCheckout)
        #expect(fixture.status(try fixture.directory("primary checkout/source/nested")) == .primaryCheckout)
        #expect(fixture.status(linked) == .linkedWorktree("linked checkout"))
        #expect(fixture.status(try fixture.directory("linked checkout/source/nested")) == .linkedWorktree("linked checkout"))
    }

    @Test(arguments: ["files", "reftable"])
    func classificationLeavesEveryFixtureEntryUnchanged(refFormat: String) throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree(refFormat: refFormat)
        let folders = [
            fixture.root.appendingPathComponent("primary checkout"), linked,
            try fixture.directory("primary checkout/source/nested"), try fixture.directory("linked checkout/nested"),
        ]
        let before = try fixture.entries()
        #expect(before.keys.contains("primary checkout/.git/index"))
        for folder in folders { #expect(fixture.status(folder) != .unavailable) }
        // No index, ref, lock or content change, and no entry created or removed in any directory.
        #expect(try fixture.entries() == before)
    }

    /// The chip resets observation per selection identity; this replays its states with real
    /// classifier results, so a late or stale observation can never label another selection.
    @Test func switchingSelectionsAndRemovingAFolderNeverReusesAnotherObservation() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let ordinary = try fixture.directory("ordinary folder")
        let local = ExecutionLocationID.local.rawValue
        let a = ComposerSelectionContext(locationID: local, threadID: "a", repoRoot: linked.path)
        let b = ComposerSelectionContext(locationID: local, threadID: nil, repoRoot: ordinary.path)
        let remoteA = ComposerSelectionContext(
            locationID: "ssh:11111111-1111-4111-8111-111111111111", threadID: "a", repoRoot: linked.path)
        func help(_ selected: ComposerSelectionContext, _ observed: ComposerSelectionContext?,
                  _ status: ProjectCheckoutStatus?) -> String {
            ProjectCheckoutPresentation(context: selected, observedContext: observed, status: status).help
        }

        let aStatus = fixture.status(linked)
        #expect(help(a, a, aStatus) == "In the linked Git worktree “linked checkout”\n\(linked.path)")
        #expect(help(b, a, aStatus) == "Git checkout status unavailable\n\(ordinary.path)")
        let bStatus = fixture.status(ordinary)
        #expect(help(b, b, bStatus) == "Not in a Git checkout\n\(ordinary.path)")
        #expect(help(a, b, bStatus) == "Git checkout status unavailable\n\(linked.path)")
        #expect(help(a, a, fixture.status(linked)) == "In the linked Git worktree “linked checkout”\n\(linked.path)")
        #expect(help(remoteA, a, aStatus) == "Git checkout status unavailable on remote host\n\(linked.path)")

        try FileManager.default.removeItem(at: linked)
        let removed = fixture.status(linked)
        #expect(removed == .unavailable)
        #expect(help(a, a, removed) == "Git checkout status unavailable\n\(linked.path)")
    }

    @Test(arguments: ["not a gitdir pointer\n", "gitdir: missing metadata\n", "gitdir: .\n"])
    func aGitNamedFileDoesNotProveAWorktree(marker: String) throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("fake checkout")
        try Data(marker.utf8).write(to: folder.appendingPathComponent(".git"))
        #expect(fixture.status(folder) == .unavailable)
    }

    @Test func aGitNamedDirectoryWithoutRepositoryMetadataIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("fake checkout")
        _ = try fixture.directory("fake checkout/.git")
        #expect(fixture.status(folder) == .unavailable)
    }

    @Test func oversizedGitdirMetadataIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let folder = try fixture.directory("oversized marker")
        try Data(("gitdir: " + String(repeating: "x", count: 131_072)).utf8)
            .write(to: folder.appendingPathComponent(".git"))
        #expect(fixture.status(folder) == .unavailable)
    }

    @Test func aSelfReferentialCommonDirectoryIsUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let admin = try fixture.adminDirectory(for: linked)
        try Data(".\n".utf8).write(to: admin.appendingPathComponent("commondir"))
        #expect(fixture.status(linked) == .unavailable)
    }

    @Test func anotherFoldersGitdirPointerDoesNotEstablishMembership() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let fake = try fixture.directory("unregistered checkout")
        try Data(contentsOf: linked.appendingPathComponent(".git"))
            .write(to: fake.appendingPathComponent(".git"))
        #expect(fixture.status(fake) == .unavailable)
        #expect(fixture.status(linked) == .linkedWorktree("linked checkout"))
    }

    @Test func unrelatedCommonDirectoryAndBrokenBacklinkAreUnavailable() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        let admin = try fixture.adminDirectory(for: linked)
        let other = try fixture.repository("unrelated repository")
        let common = admin.appendingPathComponent("commondir")
        let original = try Data(contentsOf: common)
        try Data((other.appendingPathComponent(".git").path + "\n").utf8).write(to: common)
        #expect(fixture.status(linked) == .unavailable)
        try original.write(to: common)
        try Data((fixture.root.appendingPathComponent("missing/.git").path + "\n").utf8)
            .write(to: admin.appendingPathComponent("gitdir"))
        #expect(fixture.status(linked) == .unavailable)
    }

    @Test func remoteSelectionNeverGetsLocalRepositoryEvidence() throws {
        let fixture = try CheckoutFixture()
        defer { fixture.cleanUp() }
        let linked = try fixture.linkedWorktree()
        #expect(fixture.status(linked, isLocal: false) == .unavailable)
        #expect(fixture.status(fixture.root.appendingPathComponent("missing"), isLocal: false) == .unavailable)
    }
}

/// Every read/write and Git subprocess is confined to a unique controlled fixture.
/// Fixture allocation is checkout-local regardless of the launcher's TMPDIR.
private struct CheckoutFixture {
    let root: URL

    init() throws {
        var checkout = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { checkout.deleteLastPathComponent() }
        let scratch = checkout.appendingPathComponent(".build/test-fixtures").resolvingSymlinksInPath()
        root = scratch.appendingPathComponent("checkout-provenance-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func cleanUp() { try? FileManager.default.removeItem(at: root) }

    func directory(_ relative: String) throws -> URL {
        let target = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        return target
    }

    func write(_ value: String, at relative: String) throws -> URL {
        let target = root.appendingPathComponent(relative)
        try Data(value.utf8).write(to: target)
        return target
    }

    func status(_ folder: URL, isLocal: Bool = true) -> ProjectCheckoutStatus {
        ProjectPathSelection.checkoutStatus(
            for: folder.path, isLocal: isLocal, searchBoundary: root.path)
    }

    func repository(_ name: String, refFormat: String? = nil) throws -> URL {
        let target = try directory(name)
        let format = refFormat.map { ["--ref-format=\($0)"] } ?? []
        try git(["init", "--template=", "--initial-branch=main"] + format + [target.path])
        return target
    }

    func linkedWorktree(refFormat: String? = nil) throws -> URL {
        let main = try repository("primary checkout", refFormat: refFormat)
        try git(["-C", main.path, "commit", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "Fixture"])
        let linked = root.appendingPathComponent("linked checkout")
        try git(["-C", main.path, "worktree", "add", "--detach", linked.path, "HEAD"])
        return linked
    }

    /// Each entry's mode, inode, size, modification time and regular-file bytes. Creating and
    /// removing a lock file still changes its directory's modification time.
    func entries() throws -> [String: String] {
        let base = root.resolvingSymlinksInPath().path
        let walker = try #require(FileManager.default.enumerator(atPath: base))
        var result = ["": try entry(base)]
        for case let relative as String in walker {
            result[relative] = try entry(base + "/" + relative)
        }
        return result
    }

    private func entry(_ path: String) throws -> String {
        var info = stat()
        try #require(lstat(path, &info) == 0, "lstat failed: \(path)")
        var value = "\(info.st_mode) \(info.st_ino) \(info.st_size) "
            + "\(info.st_mtimespec.tv_sec).\(info.st_mtimespec.tv_nsec)"
        if info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) {
            value += " " + (try Data(contentsOf: URL(fileURLWithPath: path))).base64EncodedString()
        }
        return value
    }

    func adminDirectory(for linked: URL) throws -> URL {
        let marker = try String(contentsOf: linked.appendingPathComponent(".git"), encoding: .utf8)
        try #require(marker.hasPrefix("gitdir: "))
        let path = String(marker.dropFirst(8)).trimmingCharacters(in: .newlines)
        let admin = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        try #require(admin.path.hasPrefix(root.resolvingSymlinksInPath().path + "/"))
        return admin
    }

    func git(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.currentDirectoryURL = root
        process.arguments = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"] + arguments
        process.environment = [
            "PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "GIT_AUTHOR_NAME": "Fixture", "GIT_COMMITTER_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        ]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        try output.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try output.fileHandleForReading.close()
        try #require(process.terminationStatus == 0, "Fixture git failed: \(String(decoding: data, as: UTF8.self))")
    }
}
