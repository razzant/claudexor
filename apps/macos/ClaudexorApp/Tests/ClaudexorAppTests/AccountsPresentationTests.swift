import Foundation
import ClaudexorKit
import Testing
@testable import ClaudexorApp

/// Owner dogfood: the internal profile id is DERIVED, never typed. The
/// generator must always emit a server-valid slug, unique per harness.
@Suite struct AccountsPresentationTests {
    @MainActor
    @Test func accountReadinessRequiresExactPassedSourceVerification() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "api key ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available",
                verification: "failed", detail: "session expired"),
        ]
        var row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unavailable)
        #expect(!row.verified)

        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available",
                verification: "not_run"),
        ]
        row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unknown)

        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available",
                verification: "passed"),
        ]
        row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .ready)
        #expect(row.verified)
    }

    @MainActor
    @Test func draftAccountSelectionPersistsAndClearsInTheOneAccountsSurface() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        await model.setThreadCredentialProfile("work", harnessId: "claude")
        #expect(model.draftCredentialProfileId == "work")
        #expect(model.draftPrimaryHarness == "claude")
        #expect(model.draftEligiblePool == ["claude"])
        await model.setThreadCredentialProfile(nil)
        #expect(model.draftCredentialProfileId == nil)
    }

    @MainActor
    @Test func profileAvailabilityWithoutPassedVerificationIsNotGreen() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let json = """
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
        "credential_kind":"config_dir_login","enabled":true},
        "status":{"availability":"available","verification":"failed","detail":"probe failed",
        "last_verified_at":null}}
        """
        model.credentialProfiles = [
            try JSONDecoder().decode(CredentialProfileEntry.self, from: Data(json.utf8)),
        ]
        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unavailable)
        #expect(!row.verified)
    }

    @Test func generatedIdSlugifiesTheDisplayName() {
        #expect(AccountsPresentation.generatedProfileId(displayName: "Work", existing: []) == "work")
        #expect(AccountsPresentation.generatedProfileId(displayName: "Experiment A (max)", existing: [])
            == "experiment-a-max")
        // Non-latin names fall back to the auto id instead of an invalid slug.
        #expect(AccountsPresentation.generatedProfileId(displayName: "個人アカウント", existing: []) == "acct")
        #expect(AccountsPresentation.generatedProfileId(displayName: "", existing: []) == "acct")
    }

    @Test func quotaDatesAreAlwaysPresentedInEnglish() {
        let value = formattedDate("2026-07-18T12:30:00.000Z")
        #expect(value?.contains("Jul") == true)
    }

    @Test func generatedIdIsUniqueAndAlwaysValid() {
        #expect(AccountsPresentation.generatedProfileId(displayName: "Work", existing: ["work"]) == "work-2")
        #expect(AccountsPresentation.generatedProfileId(displayName: "", existing: ["acct", "acct-2"]) == "acct-3")
        // Every derivation the UI can produce passes the server's slug rule.
        for name in ["Work", "  ", "--weird__", "Ελληνικό όνομα", String(repeating: "x", count: 200)] {
            let id = AccountsPresentation.generatedProfileId(displayName: name, existing: ["acct"])
            #expect(AccountsPresentation.isValidSlug(id), "invalid slug for \(name): \(id)")
        }
    }
}
