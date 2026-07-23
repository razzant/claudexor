import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// QA-062: the tracked handoff-dir owner. Stage writes a private 0700 copy under
/// the ONE tracked root; the startup sweep reclaims stale copies by bounded age
/// and fails closed on anything that is not a plain UUID-named directory.
@Suite struct ExternalArtifactHandoffTests {
    private func makeRoot() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("handoff-test-\(UUID().uuidString)", isDirectory: true)
        return dir
    }

    @Test func stageWritesA0700UuidDirUnderTheTrackedRoot() throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let handoff = ExternalArtifactHandoff(root: root)

        let url = try handoff.stage(data: Data("hello".utf8), suggestedName: "report.md")

        #expect(FileManager.default.fileExists(atPath: url.path))
        #expect(url.lastPathComponent == "report.md")
        // The copy's parent is a UUID-named child of the tracked root.
        let dir = url.deletingLastPathComponent()
        #expect(dir.deletingLastPathComponent().path == root.path)
        #expect(UUID(uuidString: dir.lastPathComponent) != nil)
        let perms = try FileManager.default.attributesOfItem(atPath: dir.path)[.posixPermissions] as? Int
        #expect(perms == 0o700)
        #expect(String(decoding: try Data(contentsOf: url), as: UTF8.self) == "hello")
    }

    @Test func stageSanitizesAgentControlledNames() throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let handoff = ExternalArtifactHandoff(root: root)

        // A path-traversal name is reduced to its basename inside the private dir.
        let url = try handoff.stage(data: Data(), suggestedName: "../../etc/passwd")
        #expect(url.lastPathComponent == "passwd")
        #expect(url.deletingLastPathComponent().deletingLastPathComponent().path == root.path)

        // Degenerate names fall back to "artifact".
        let dotted = try handoff.stage(data: Data(), suggestedName: "..")
        #expect(dotted.lastPathComponent == "artifact")
    }

    @Test func sweepReclaimsStaleCopiesAndKeepsFreshOnes() throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let handoff = ExternalArtifactHandoff(root: root)

        let fresh = try handoff.stage(data: Data("new".utf8), suggestedName: "a.txt")
        let stale = try handoff.stage(data: Data("old".utf8), suggestedName: "b.txt")
        // Age the second copy's dir a week back.
        let staleDir = stale.deletingLastPathComponent()
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-7 * 24 * 60 * 60)], ofItemAtPath: staleDir.path)

        let reclaimed = handoff.sweepStale(now: Date(), maxAge: 24 * 60 * 60)

        #expect(reclaimed == 1)
        #expect(!FileManager.default.fileExists(atPath: staleDir.path))
        #expect(FileManager.default.fileExists(atPath: fresh.path))   // fresh survives
    }

    @Test func sweepFailsClosedOnNonUuidChildren() throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // A non-UUID directory the user (or another app) placed under the root is
        // NEVER swept, even when old.
        let foreign = root.appendingPathComponent("keep-me", isDirectory: true)
        try FileManager.default.createDirectory(at: foreign, withIntermediateDirectories: true)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-30 * 24 * 60 * 60)], ofItemAtPath: foreign.path)

        let reclaimed = ExternalArtifactHandoff(root: root).sweepStale(now: Date(), maxAge: 24 * 60 * 60)

        #expect(reclaimed == 0)
        #expect(FileManager.default.fileExists(atPath: foreign.path))
    }

    @Test func sweepOnAMissingRootIsANoOp() {
        let root = makeRoot()   // never created
        #expect(ExternalArtifactHandoff(root: root).sweepStale() == 0)
    }

    @Test func stageCreatesTheTrackedRootPrivate() throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try ExternalArtifactHandoff(root: root).stage(data: Data("x".utf8), suggestedName: "a.txt")
        let attrs = try FileManager.default.attributesOfItem(atPath: root.path)
        #expect((attrs[.type] as? FileAttributeType) == .typeDirectory)
        #expect((attrs[.posixPermissions] as? Int) == 0o700)
    }

    @Test func stageRefusesASymlinkedRoot() throws {
        let base = makeRoot()
        defer { try? FileManager.default.removeItem(at: base) }
        // The "attacker" destination the planted symlink points at.
        let target = base.appendingPathComponent("victim", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let linkedRoot = base.appendingPathComponent("claudexor-open", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: target)

        let handoff = ExternalArtifactHandoff(root: linkedRoot)
        #expect(throws: ExternalArtifactHandoff.HandoffError.self) {
            _ = try handoff.stage(data: Data("secret".utf8), suggestedName: "a.txt")
        }
        // Nothing was written THROUGH the symlink into the target dir.
        #expect(try FileManager.default.contentsOfDirectory(atPath: target.path).isEmpty)
    }

    @Test func sweepFailsClosedOnASymlinkedRoot() throws {
        let base = makeRoot()
        defer { try? FileManager.default.removeItem(at: base) }
        let target = base.appendingPathComponent("victim", isDirectory: true)
        // A stale UUID-named dir a followed symlink would otherwise reclaim.
        let bait = target.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: bait, withIntermediateDirectories: true)
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-30 * 24 * 60 * 60)], ofItemAtPath: bait.path)
        let linkedRoot = base.appendingPathComponent("claudexor-open", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: target)

        let reclaimed = ExternalArtifactHandoff(root: linkedRoot).sweepStale(now: Date(), maxAge: 24 * 60 * 60)
        #expect(reclaimed == 0)
        #expect(FileManager.default.fileExists(atPath: bait.path))   // never followed
    }
}

/// QA-067: a server 409 sensitive-file refusal renders as its typed reason, not a
/// generic offline blob or the raw JSON problem body.
@Suite struct ArtifactFetchErrorTests {
    @Test func sensitiveClassBecomesAHumanRefusal() {
        let body = #"{"error":"refusing to serve .env: credential-bearing dotenv file","code":"sensitive_file_refused","sensitiveClass":"dotenv"}"#
        let msg = ArtifactFetchError.sensitiveRefusalMessage(body: body)
        #expect(msg.contains("dotenv"))
        #expect(msg.hasPrefix("Refused"))
        #expect(!msg.contains("{"))   // never the raw JSON body
    }

    @Test func credentialsAndRegistryClassesAreNamed() {
        #expect(ArtifactFetchError.sensitiveRefusalMessage(
            body: #"{"sensitiveClass":"credentials_file"}"#).contains("credentials"))
        #expect(ArtifactFetchError.sensitiveRefusalMessage(
            body: #"{"sensitiveClass":"package_registry_credentials"}"#).contains("package-registry"))
    }

    @Test func patchSecretFenceFallsBackToServerErrorString() {
        // The patch fence 409 has no sensitiveClass — the server error is shown.
        let body = #"{"error":"artifact contains secret-like token; refusing to serve patch"}"#
        let msg = ArtifactFetchError.sensitiveRefusalMessage(body: body)
        #expect(msg.contains("secret-like token"))
        #expect(msg.hasPrefix("Refused"))
    }

    @Test func statusMappingIsTyped() {
        // A 409 → typed notRenderable refusal; 413 → its own reason; else offline.
        let refusal = ArtifactFetchError.payloadError(from: GatewayError.http(
            status: 409, body: #"{"sensitiveClass":"dotenv"}"#))
        if case .notRenderable(let m) = refusal { #expect(m.contains("dotenv")) }
        else { Issue.record("409 should map to .notRenderable") }

        if case .notRenderable = ArtifactFetchError.payloadError(from: GatewayError.http(status: 413, body: "")) {}
        else { Issue.record("413 should map to .notRenderable") }

        #expect(ArtifactFetchError.payloadError(from: GatewayError.http(status: 500, body: "")) == .offline)
        #expect(ArtifactFetchError.payloadError(from: GatewayError.transport("x")) == .offline)
    }
}
