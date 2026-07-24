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

    private func providerAuthFileSource(availability: String, verification: String) -> HarnessAuthSource {
        HarnessAuthSource(source: "provider_auth_file", availability: availability, verification: verification)
    }

    @Test func absentOptionalKeyRendersNeutralNotFail() {
        // Native adapter emits a presence-only `stored_key` fail because no key is
        // configured; the typed api_key_env source says unavailable + not_run.
        let rows = [
            ReadinessCheck(kind: "auth", id: "native_session", title: "Native session", status: "pass"),
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no anthropic key fallback"),
        ]
        let out = HarnessReadinessPresentation.neutralizeAbsentOptionalKey(
            rows, authSources: [apiKeySource(availability: "unavailable", verification: "not_run")],
            apiKeyFallbackSource: .apiKeyEnvironment)
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
            rows, authSources: [apiKeySource(availability: "available", verification: "failed")],
            apiKeyFallbackSource: .apiKeyEnvironment)
        #expect(out.first { $0.id == "isolated_api_smoke" }?.status == "fail")
        #expect(out.first { $0.id == "stored_key" }?.status == "pass")
    }

    @Test func storedKeyFailWithoutTypedSourceIsLeftUnchanged() {
        // No api_key_env source to prove the absence is optional → do not rewrite.
        let rows = [ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail")]
        let out = HarnessReadinessPresentation.neutralizeAbsentOptionalKey(
            rows, authSources: [], apiKeyFallbackSource: .apiKeyEnvironment)
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

    // MARK: - QA-005 codex: the api-key fallback lives at provider_auth_file, not api_key_env

    @Test func codexDefaultSubscriptionNeutralizesAbsentProviderAuthFileKey() {
        // The DEFAULT codex subscription case: native session works, and the
        // OPTIONAL api-key fallback (provider_auth_file) is absent + not_run.
        // Before the typed-source fix the neutralizer only recognized api_key_env,
        // so codex rendered a RED stored_key here — violating native-first QA-005.
        var info = HarnessInfo(family: .codex, health: .ok, version: "1", auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "auth", id: "native_session", title: "Native session", status: "pass"),
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no OPENAI_API_KEY / auth.json fallback"),
        ]
        info.authSources = [providerAuthFileSource(availability: "unavailable", verification: "not_run")]
        let presentation = HarnessReadinessPresentation.from(family: .codex, info: info)
        let stored = presentation.rows.first { $0.id == "stored_key" }
        #expect(stored?.status == "skip")
        #expect(stored?.detail == "not configured (optional API-key fallback)")
        #expect(stored?.status != "fail")
    }

    @Test func codexPresentButFailedProviderAuthFileKeyStaysRed() {
        // A configured codex api-key fallback that FAILS its smoke stays red: the
        // provider_auth_file source is available (present) so the absence rewrite
        // is never triggered and the real isolated_api_smoke failure shows red.
        var info = HarnessInfo(family: .codex, health: .degraded, version: "1", auth: "key failed", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "pass"),
            ReadinessCheck(kind: "smoke", id: "isolated_api_smoke", title: "Isolated API-key smoke", status: "fail", detail: "401"),
        ]
        info.authSources = [providerAuthFileSource(availability: "available", verification: "failed")]
        let presentation = HarnessReadinessPresentation.from(family: .codex, info: info)
        #expect(presentation.rows.first { $0.id == "isolated_api_smoke" }?.status == "fail")
        #expect(presentation.rows.first { $0.id == "stored_key" }?.status == "pass")
    }

    @Test func codexApiKeyEnvSourceDoesNotNeutralizeProviderAuthFileFamily() {
        // A stray api_key_env source must NOT neutralize codex's stored_key: codex's
        // fallback is provider_auth_file, so an unrelated api_key_env absence is not
        // proof the codex fallback is unconfigured — the fail stays red.
        var info = HarnessInfo(family: .codex, health: .ok, version: "1", auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no auth.json fallback"),
        ]
        info.authSources = [apiKeySource(availability: "unavailable", verification: "not_run")]
        let presentation = HarnessReadinessPresentation.from(family: .codex, info: info)
        #expect(presentation.rows.first { $0.id == "stored_key" }?.status == "fail")
    }

    // MARK: - Round-5 #6: the api-key is PRIMARY for opencode/raw-api, not a fallback

    @Test func apiKeyPrimaryFamilyFailedStoredKeyStaysRed() {
        // opencode's PRIMARY credential is the api key (defaultAuthReadinessRequest
        // == .apiKey), so an absent/failed stored_key is a REAL failure — never the
        // "optional API-key fallback" QA-005 neutralizes for native-first families.
        // The stray api_key_env source that neutralizes claude/cursor must NOT
        // neutralize an api-key-PRIMARY family.
        var info = HarnessInfo(family: .opencode, health: .unavailable, version: "1", auth: "no key", intents: [])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no OPENAI_API_KEY"),
        ]
        info.authSources = [apiKeySource(availability: "unavailable", verification: "not_run")]
        let presentation = HarnessReadinessPresentation.from(family: .opencode, info: info)
        #expect(presentation.rows.first { $0.id == "stored_key" }?.status == "fail")
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
