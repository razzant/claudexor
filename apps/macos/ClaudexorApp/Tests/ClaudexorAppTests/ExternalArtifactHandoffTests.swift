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

        // A bare "/" has lastPathComponent "/" (neither empty nor "."/".."); it must
        // also fall back, never be appended as the file name (round-5 #5).
        let slash = try handoff.stage(data: Data(), suggestedName: "/")
        #expect(slash.lastPathComponent == "artifact")
        #expect(slash.deletingLastPathComponent().deletingLastPathComponent().path == root.path)
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

    @Test func stageRepairsAPreexistingWorldReadableRoot() throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        // Round-3 #7: a pre-existing user-owned 0755 root (another tool, or a widened
        // umask) passes ownership + is-a-directory but VIOLATES the private-0700
        // contract — every private artifact copy would otherwise sit under a
        // world-readable parent. The mode check repairs it to 0700 before staging.
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        #expect((try FileManager.default.attributesOfItem(atPath: root.path)[.posixPermissions] as? Int) == 0o755)

        let url = try ExternalArtifactHandoff(root: root).stage(data: Data("x".utf8), suggestedName: "a.txt")

        // The shared root was TIGHTENED to 0700 before the copy was written under it.
        #expect((try FileManager.default.attributesOfItem(atPath: root.path)[.posixPermissions] as? Int) == 0o700)
        #expect(FileManager.default.fileExists(atPath: url.path))
    }

    @Test func stageRefusesASymlinkedRoot() throws {
        let base = makeRoot()
        defer { try? FileManager.default.removeItem(at: base) }
        // The "attacker" destination the planted symlink points at — a REAL,
        // current-user-owned 0700 directory. A `stat`-following root check would
        // resolve the link, see this valid directory, and ACCEPT it (writing the
        // secret THROUGH the link). The lstat-not-stat check refuses it: the
        // decisive proof is the exact "is a symlink" reason, not a bare throw.
        let target = base.appendingPathComponent("victim", isDirectory: true)
        try FileManager.default.createDirectory(
            at: target, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let linkedRoot = base.appendingPathComponent("claudexor-open", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: target)

        let handoff = ExternalArtifactHandoff(root: linkedRoot)
        var thrown: ExternalArtifactHandoff.HandoffError?
        do {
            _ = try handoff.stage(data: Data("secret".utf8), suggestedName: "a.txt")
        } catch let error as ExternalArtifactHandoff.HandoffError {
            thrown = error
        }
        // The SYMLINK branch fired (not "not a directory" via a followed target).
        guard case .insecureRoot(let reason) = thrown else {
            Issue.record("expected an insecureRoot refusal, got \(String(describing: thrown))")
            return
        }
        #expect(reason.contains("symlink"))
        // Nothing was written THROUGH the symlink into the target dir.
        #expect(try FileManager.default.contentsOfDirectory(atPath: target.path).isEmpty)
    }

    @Test func sweepFailsClosedOnASymlinkedRoot() throws {
        let base = makeRoot()
        defer { try? FileManager.default.removeItem(at: base) }
        // A REAL, user-owned 0700 target a `stat`-following sweep would enumerate.
        let target = base.appendingPathComponent("victim", isDirectory: true)
        try FileManager.default.createDirectory(
            at: target, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
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
    // The fixtures below are the REAL normalized `ControlProblem` the daemon puts
    // on the wire (proven by `control-api.test.ts`: the human string is `message`,
    // NOT `error`, and the class rides in `context.sensitiveClass`, NOT a top-level
    // key). The daemon funnels every >=400 JSON body through problemBody, so a
    // top-level `error`/`sensitiveClass` body is one the real engine never emits.
    @Test func sensitiveClassBecomesAHumanRefusal() {
        let body = #"{"code":"sensitive_file_refused","message":"refusing to serve .env: credential-bearing dotenv file","retryable":false,"context":{"sensitiveClass":"dotenv"}}"#
        let msg = ArtifactFetchError.sensitiveRefusalMessage(body: body)
        #expect(msg.contains("dotenv"))
        #expect(msg.hasPrefix("Refused"))
        #expect(!msg.contains("{"))   // never the raw JSON body
    }

    @Test func credentialsAndRegistryClassesAreNamed() {
        #expect(ArtifactFetchError.sensitiveRefusalMessage(
            body: #"{"code":"sensitive_file_refused","message":"x","context":{"sensitiveClass":"credentials_file"}}"#).contains("credentials"))
        #expect(ArtifactFetchError.sensitiveRefusalMessage(
            body: #"{"code":"sensitive_file_refused","message":"x","context":{"sensitiveClass":"package_registry_credentials"}}"#).contains("package-registry"))
    }

    @Test func patchSecretFenceFallsBackToMessageString() {
        // The patch fence 409 has no sensitiveClass — the daemon-normalized human
        // `message` (code http_409, empty context) is shown.
        let body = #"{"code":"http_409","message":"artifact contains secret-like token; refusing to serve patch","retryable":false,"context":{}}"#
        let msg = ArtifactFetchError.sensitiveRefusalMessage(body: body)
        #expect(msg.contains("secret-like token"))
        #expect(msg.hasPrefix("Refused"))
    }

    @Test func legacyOrHostileTopLevelShapeFallsBackGenerically() {
        // The OLD hand-authored shape the real daemon never emits (top-level
        // `error`/`sensitiveClass`): with no `message` and no `context.sensitiveClass`
        // it must fall back to the generic refusal — NOT resurrect the dead branches.
        let body = #"{"error":"refusing to serve .env: credential-bearing dotenv file","code":"sensitive_file_refused","sensitiveClass":"dotenv"}"#
        let msg = ArtifactFetchError.sensitiveRefusalMessage(body: body)
        #expect(msg == "The engine refused to serve this file.")
        #expect(!msg.contains("dotenv"))   // the top-level class is NOT trusted
    }

    @Test func statusMappingIsTypedAndCarriesThePath() {
        // Round-3 #2: EVERY projected failure names the artifact path so the failure
        // view + Retry never show a bare basename or a generic offline blob.
        let path = "final/report/.env"
        // A 409 → typed notRenderable refusal, WITH the path visible. Body is the
        // real normalized ControlProblem (class in `context`, not top-level).
        let refusal = ArtifactFetchError.payloadError(
            from: GatewayError.http(status: 409, body: #"{"code":"sensitive_file_refused","message":"x","context":{"sensitiveClass":"dotenv"}}"#), path: path)
        if case .notRenderable(let m) = refusal { #expect(m.contains("dotenv")); #expect(m.contains(path)) }
        else { Issue.record("409 should map to .notRenderable") }

        // 413 → its own reason, with the path.
        if case .notRenderable(let m) = ArtifactFetchError.payloadError(
            from: GatewayError.http(status: 413, body: ""), path: path) { #expect(m.contains(path)) }
        else { Issue.record("413 should map to .notRenderable") }

        // Any other status OR a non-HTTP transport error → a path-carrying transport.
        for error in [GatewayError.http(status: 500, body: ""), GatewayError.transport("x")] {
            guard case .transport(let m) = ArtifactFetchError.payloadError(from: error, path: path) else {
                Issue.record("non-renderable failure should map to .transport with the path"); continue
            }
            #expect(m.contains(path))
        }
        // The nil-client offline projection also names the path (never a bare blob).
        guard case .transport(let m) = ArtifactFetchError.offline(path: path) else {
            Issue.record("offline should be a path-carrying transport"); return
        }
        #expect(m.contains(path))
    }
}
