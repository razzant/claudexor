import ClaudexorKit
import Testing
@testable import ClaudexorApp

/// M5c: the readiness card is the ONE render owner, so it dedupes doctor
/// findings the daemon may emit more than once (owner-reported duplicates).
@Suite struct HarnessReadinessDedupeTests {
    @Test func checksDedupeByIdKeepingFirstOrder() {
        let checks = [
            ReadinessCheck(kind: "binary", id: "cli", title: "CLI", status: "pass"),
            ReadinessCheck(kind: "auth", id: "auth", title: "Auth", status: "fail", detail: "expired"),
            ReadinessCheck(kind: "auth", id: "auth", title: "Auth", status: "fail", detail: "expired"),
            ReadinessCheck(kind: "binary", id: "cli", title: "CLI", status: "pass"),
        ]
        let deduped = HarnessReadinessPresentation.dedupeChecks(checks)
        #expect(deduped.map(\.id) == ["cli", "auth"])
    }

    @Test func reasonsDedupePreservingOrder() {
        let reasons = ["not logged in", "quota unknown", "not logged in", "binary missing"]
        #expect(HarnessReadinessPresentation.dedupeOrdered(reasons)
            == ["not logged in", "quota unknown", "binary missing"])
    }

    @Test func presentationDoesNotRenderDuplicateRows() {
        var info = HarnessInfo(family: .claude, health: .ok, version: "1", auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "auth", id: "auth", title: "Auth", status: "pass"),
            ReadinessCheck(kind: "auth", id: "auth", title: "Auth", status: "pass"),
        ]
        info.reasons = ["dup", "dup"]
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: info)
        #expect(presentation.rows.count == 1)
        // rawEvidence carries one reason + one row line, not the duplicates.
        #expect(presentation.rawEvidence == "dup\nauth: pass")
    }
}
