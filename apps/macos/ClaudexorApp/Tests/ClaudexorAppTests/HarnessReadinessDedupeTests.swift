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

    // MARK: - QA-005: absent optional API-key fallback is neutral, never red

    private func apiKeySource(availability: String, verification: String) -> HarnessAuthSource {
        HarnessAuthSource(source: "api_key_env", availability: availability, verification: verification)
    }

    @Test func absentOptionalKeyRendersNeutralNotFail() {
        // Native adapter emits a presence-only `stored_key` fail because no key is
        // configured; the typed api_key_env source says unavailable + not_run.
        let rows = [
            ReadinessCheck(kind: "auth", id: "native_session", title: "Native session", status: "pass"),
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no anthropic key fallback"),
        ]
        let out = HarnessReadinessPresentation.neutralizeAbsentOptionalKey(
            rows, authSources: [apiKeySource(availability: "unavailable", verification: "not_run")])
        let stored = out.first { $0.id == "stored_key" }
        #expect(stored?.status == "skip")
        #expect(stored?.detail == "not configured (optional API-key fallback)")
        // "skip" is the neutral tone the card maps away from red — not "fail".
        #expect(stored?.status != "fail")
    }

    @Test func presentPresentButFailedKeyStaysRed() {
        // A configured-but-broken key: api_key_env is available + failed. The
        // stored_key presence check is `pass` (key IS present); the real failure
        // is a separate smoke row that must remain red.
        let rows = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "pass"),
            ReadinessCheck(kind: "smoke", id: "isolated_api_smoke", title: "Isolated API-key smoke", status: "fail", detail: "401"),
        ]
        let out = HarnessReadinessPresentation.neutralizeAbsentOptionalKey(
            rows, authSources: [apiKeySource(availability: "available", verification: "failed")])
        #expect(out.first { $0.id == "isolated_api_smoke" }?.status == "fail")
        #expect(out.first { $0.id == "stored_key" }?.status == "pass")
    }

    @Test func storedKeyFailWithoutTypedSourceIsLeftUnchanged() {
        // No api_key_env source to prove the absence is optional → do not rewrite.
        let rows = [ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail")]
        let out = HarnessReadinessPresentation.neutralizeAbsentOptionalKey(rows, authSources: [])
        #expect(out.first { $0.id == "stored_key" }?.status == "fail")
    }

    @Test func presentationNeutralizesAbsentOptionalKeyEndToEnd() {
        var info = HarnessInfo(family: .claude, health: .ok, version: "1", auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no anthropic key fallback"),
        ]
        info.authSources = [apiKeySource(availability: "unavailable", verification: "not_run")]
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: info)
        #expect(presentation.rows.first { $0.id == "stored_key" }?.status == "skip")
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
