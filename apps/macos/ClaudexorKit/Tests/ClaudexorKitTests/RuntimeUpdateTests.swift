import Foundation
import Testing
@testable import ClaudexorKit

// M7 pure logic: manifest parse honesty, semver ordering, the update decision
// (including the app-vs-engine skew guard), and current.json round-trip.

@Suite struct RuntimeUpdateTests {
    // MARK: - Manifest parse

    private let goodSHA = String(repeating: "a", count: 64)

    @Test func parsesWellFormedManifest() {
        let json = """
        {"version":"3.1.0","sha256":"\(goodSHA)","minAppVersion":"3.0.0","signature":null,"notes":"hi"}
        """
        let m = RuntimeManifest.parse(Data(json.utf8))
        #expect(m?.version == "3.1.0")
        #expect(m?.sha256 == goodSHA)
        #expect(m?.minAppVersion == "3.0.0")
        #expect(m?.signature == nil)
        #expect(m?.notes == "hi")
    }

    @Test func signatureIsIgnoredNeverRequired() {
        // Missing signature key must not fail parse; a present non-null one is
        // ignored (reserved) and scrubbed to nil.
        let noKey = #"{"version":"3.1.0","sha256":"\#(goodSHA)","minAppVersion":"3.0.0"}"#
        #expect(RuntimeManifest.parse(Data(noKey.utf8))?.signature == nil)
        let present = #"{"version":"3.1.0","sha256":"\#(goodSHA)","minAppVersion":"3.0.0","signature":"deadbeef"}"#
        #expect(RuntimeManifest.parse(Data(present.utf8))?.signature == nil)
    }

    @Test func notesDefaultsToEmptyWhenAbsent() {
        let json = #"{"version":"3.1.0","sha256":"\#(goodSHA)","minAppVersion":"3.0.0"}"#
        #expect(RuntimeManifest.parse(Data(json.utf8))?.notes == "")
    }

    @Test func rejectsEmptyOrMalformedVersion() {
        let empty = #"{"version":"  ","sha256":"\#(goodSHA)","minAppVersion":"3.0.0"}"#
        #expect(RuntimeManifest.parse(Data(empty.utf8)) == nil)
        let notSemver = #"{"version":"latest","sha256":"\#(goodSHA)","minAppVersion":"3.0.0"}"#
        #expect(RuntimeManifest.parse(Data(notSemver.utf8)) == nil)
    }

    @Test func rejectsBadSHA() {
        let shortSHA = #"{"version":"3.1.0","sha256":"abc","minAppVersion":"3.0.0"}"#
        #expect(RuntimeManifest.parse(Data(shortSHA.utf8)) == nil)
        let upper = #"{"version":"3.1.0","sha256":"\#(String(repeating: "A", count: 64))","minAppVersion":"3.0.0"}"#
        // Uppercase is normalized to lowercase, so this is accepted.
        #expect(RuntimeManifest.parse(Data(upper.utf8))?.sha256 == String(repeating: "a", count: 64))
        let nonHex = #"{"version":"3.1.0","sha256":"\#(String(repeating: "g", count: 64))","minAppVersion":"3.0.0"}"#
        #expect(RuntimeManifest.parse(Data(nonHex.utf8)) == nil)
    }

    @Test func rejectsBadMinAppVersion() {
        let json = #"{"version":"3.1.0","sha256":"\#(goodSHA)","minAppVersion":"nope"}"#
        #expect(RuntimeManifest.parse(Data(json.utf8)) == nil)
    }

    @Test func rejectsGarbageAndEmpty() {
        #expect(RuntimeManifest.parse(Data("not json".utf8)) == nil)
        #expect(RuntimeManifest.parse(Data("{}".utf8)) == nil)
        #expect(RuntimeManifest.parse(Data("".utf8)) == nil)
    }

    // MARK: - Semver

    @Test func semverParsesAndOrders() {
        #expect(SemanticVersion("3.1.0")! > SemanticVersion("3.0.9")!)
        #expect(SemanticVersion("3.2")! > SemanticVersion("3.1.5")!)  // 3.2 == 3.2.0
        #expect(SemanticVersion("3.0.0")! == SemanticVersion("3.0.0")!)
        #expect(SemanticVersion("3.1.0-rc.1")! == SemanticVersion("3.1.0")!)  // pre-release stripped
    }

    @Test func semverRejectsGarbage() {
        #expect(SemanticVersion("") == nil)
        #expect(SemanticVersion("latest") == nil)
        #expect(SemanticVersion("3.x.0") == nil)
        #expect(SemanticVersion("1.2.3.4") == nil)
    }

    // MARK: - Decision

    private func manifest(version: String, minApp: String) -> RuntimeManifest {
        RuntimeManifest(version: version, sha256: goodSHA, minAppVersion: minApp)
    }

    @Test func decidesUpToDateWhenNotNewer() {
        let d = decideRuntimeUpdate(runningEngineVersion: "3.1.0", appVersion: "3.1.0",
                                    manifest: manifest(version: "3.1.0", minApp: "3.0.0"))
        #expect(d == .upToDate)
        let older = decideRuntimeUpdate(runningEngineVersion: "3.2.0", appVersion: "3.2.0",
                                        manifest: manifest(version: "3.1.0", minApp: "3.0.0"))
        #expect(older == .upToDate)
    }

    @Test func decidesAvailableWhenNewerAndAppSatisfies() {
        let m = manifest(version: "3.2.0", minApp: "3.0.0")
        let d = decideRuntimeUpdate(runningEngineVersion: "3.1.0", appVersion: "3.1.0", manifest: m)
        #expect(d == .available(m))
        #expect(d.chipAvailability?.version == "3.2.0")
    }

    @Test func skewGuardBlocksWhenAppTooOld() {
        // Newer closure but the app is older than minAppVersion → do NOT download.
        let m = manifest(version: "3.2.0", minApp: "3.2.0")
        let d = decideRuntimeUpdate(runningEngineVersion: "3.1.0", appVersion: "3.1.0", manifest: m)
        #expect(d == .appUpdateRequired(minAppVersion: "3.2.0", manifest: m))
        // The chip never advertises a download it cannot perform.
        #expect(d.chipAvailability == nil)
    }

    @Test func devAppSatisfiesAnyFloor() {
        let m = manifest(version: "9.9.9", minApp: "5.0.0")
        let d = decideRuntimeUpdate(runningEngineVersion: "3.1.0", appVersion: "dev", manifest: m)
        #expect(d == .available(m))
    }

    @Test func unparseableRunningVersionIsUnknownNotAnUpdate() {
        let m = manifest(version: "3.2.0", minApp: "3.0.0")
        let d = decideRuntimeUpdate(runningEngineVersion: "dev", appVersion: "3.1.0", manifest: m)
        if case .unknown = d {} else { Issue.record("expected .unknown, got \(d)") }
        #expect(d.chipAvailability == nil)
    }

    @Test func appSatisfiesHelper() {
        #expect(appSatisfies(appVersion: "3.1.0", minAppVersion: "3.0.0"))
        #expect(appSatisfies(appVersion: "3.0.0", minAppVersion: "3.0.0"))
        #expect(!appSatisfies(appVersion: "2.9.0", minAppVersion: "3.0.0"))
        #expect(appSatisfies(appVersion: "dev", minAppVersion: "9.0.0"))
    }

    // MARK: - current.json

    @Test func currentRoundTrips() throws {
        let c = RuntimeCurrent(version: "3.1.0", path: "versions/3.1.0",
                               sha256: goodSHA, installedAt: "2026-07-19T00:00:00Z", engineSha: "abc123")
        let data = try JSONEncoder().encode(c)
        #expect(RuntimeCurrent.parse(data) == c)
    }

    @Test func currentAllowsNullEngineSha() throws {
        let json = #"{"version":"3.1.0","path":"versions/3.1.0","sha256":"\#(goodSHA)","installedAt":"2026-07-19T00:00:00Z","engineSha":null}"#
        #expect(RuntimeCurrent.parse(Data(json.utf8))?.engineSha == nil)
    }

    @Test func currentRejectsEmptyVersionOrPath() {
        let noVersion = #"{"version":"","path":"versions/3.1.0","sha256":"\#(goodSHA)","installedAt":"x","engineSha":null}"#
        #expect(RuntimeCurrent.parse(Data(noVersion.utf8)) == nil)
        let noPath = #"{"version":"3.1.0","path":"","sha256":"\#(goodSHA)","installedAt":"x","engineSha":null}"#
        #expect(RuntimeCurrent.parse(Data(noPath.utf8)) == nil)
        #expect(RuntimeCurrent.parse(Data("garbage".utf8)) == nil)
    }

    @Test func versionPathHelper() {
        #expect(RuntimeCurrent.versionPath("3.1.0") == "versions/3.1.0")
    }
}
