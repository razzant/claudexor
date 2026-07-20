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

    @MainActor
    @Test func profileEnabledIsSourcedFromTheWireNotFaked() throws {
        // D25 accounts symmetry: the Enabled state is wire truth (profile.enabled).
        // V11b makes the toggle LIVE (reload-after-PATCH), so it still reflects the
        // wire — a disabled profile must read as disabled.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let json = """
        {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
        "credential_kind":"config_dir_login","enabled":false},
        "status":{"availability":"available","verification":"passed","detail":null,
        "last_verified_at":null}}
        """
        model.credentialProfiles = [
            try JSONDecoder().decode(CredentialProfileEntry.self, from: Data(json.utf8)),
        ]
        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.isProfile)
        #expect(!row.enabled)
    }

    @MainActor
    @Test func cliLoginRowDefaultsEnabledWithoutProjectionAndIsNotDeletable() throws {
        // The native vendor login is a symmetric row: never a credential profile
        // (so never Claudexor's to delete). With no V11b projection present it
        // defaults to enabled, and nextUp is false (client-fallback path).
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        let row = try #require(AccountsPresentation.rows(model: model).first { $0.isCliLogin })
        #expect(row.enabled)
        #expect(row.nextUp == false)
        #expect(!row.isProfile)
        #expect(row.profileId == nil)
    }

    @MainActor
    @Test func nextUpProfileAndCliEnabledBindToServerProjection() throws {
        // F1 engine cut: the informational next-up hint and the CLI-login Enabled
        // state come from the server accounts projection (`next_up`), not client
        // pin state — and there is no user-settable Active any more.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}},
         {"profile":{"profile_id":"spare","harness_id":"claude","display_name":"Spare",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))
        // Projection: routing would pick "work" next; the native login is DISABLED.
        let accountsJSON = """
        [{"harness_id":"claude","native_credentials_enabled":false,
          "native_login_detected":true,"next_up":{"kind":"profile","profileId":"work"}}]
        """
        model.harnessAccounts = try JSONDecoder().decode(
            [HarnessAccounts].self, from: Data(accountsJSON.utf8))

        let rows = AccountsPresentation.rows(model: model)
        let cli = try #require(rows.first { $0.isCliLogin })
        #expect(cli.enabled == false)     // driven by native_credentials_enabled
        #expect(cli.nextUp == false)      // a profile is next up, not the native login
        let work = try #require(rows.first { $0.profileId == "work" })
        #expect(work.nextUp == true)
        let spare = try #require(rows.first { $0.profileId == "spare" })
        #expect(spare.nextUp == false)
    }

    @MainActor
    @Test func nativeNextUpMarksTheCliLoginRow() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))
        // Projection: routing would pick the native/CLI login next.
        let accountsJSON = """
        [{"harness_id":"claude","native_credentials_enabled":true,
          "native_login_detected":true,"next_up":{"kind":"native"}}]
        """
        model.harnessAccounts = try JSONDecoder().decode(
            [HarnessAccounts].self, from: Data(accountsJSON.utf8))

        let rows = AccountsPresentation.rows(model: model)
        let cli = try #require(rows.first { $0.isCliLogin })
        #expect(cli.enabled == true)
        #expect(cli.nextUp == true)
        let work = try #require(rows.first { $0.profileId == "work" })
        #expect(work.nextUp == false)
    }

    @MainActor
    @Test func accountRowColumnSetIsStableAcrossRowKinds() throws {
        // §1 presentation contract: every row kind emits the SAME ordered trailing
        // column set, which is exactly what keeps the Enabled toggle collinear.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        model.credentialProfiles = try JSONDecoder().decode([CredentialProfileEntry].self, from: Data("""
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """.utf8))
        let rows = AccountsPresentation.rows(model: model)
        let cli = try #require(rows.first { $0.isCliLogin })
        let profile = try #require(rows.first { $0.isProfile })
        #expect(AccountsPresentation.columns(for: cli) == AccountsPresentation.columns(for: profile))
        #expect(AccountsPresentation.columns(for: cli) == [.enabled, .manage, .delete])
    }

    @MainActor
    @Test func composerAccountSegmentFollowsPinThenNextUpDefault() throws {
        // The composer chip's account segment shows the thread's pinned account,
        // else the harness's server-computed next-up default.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))

        // No projection yet → generic default.
        var seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil)
        #expect(seg.pinned == false)
        #expect(seg.label == "Default")

        // Projection: the native CLI login is next up.
        model.harnessAccounts = try JSONDecoder().decode([HarnessAccounts].self, from: Data("""
        [{"harness_id":"claude","native_credentials_enabled":true,
          "native_login_detected":true,"next_up":{"kind":"native"}}]
        """.utf8))
        seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil)
        #expect(seg.pinned == false)
        #expect(seg.label == "CLI login")

        // A thread pin overrides the default and resolves to the profile's name.
        seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: "work")
        #expect(seg.pinned == true)
        #expect(seg.label == "Work")
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
