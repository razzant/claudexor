import Foundation
import ClaudexorKit
import Testing
@testable import ClaudexorApp

/// Owner dogfood: the internal profile id is DERIVED, never typed. The
/// generator must always emit a server-valid slug, unique per harness.
@Suite struct AccountsPresentationTests {
    /// Unified account model: every identity is a registry row, so rotation
    /// eligibility is uniformly "two or more ENABLED rows" — for agy AND for
    /// the families that used to count a native login as the second identity.
    /// A disabled row is not a rotation target, so it never counts.
    @Test func autoBalanceEligibilityUniformlyNeedsTwoEnabledAccountRows() {
        #expect(AccountsPresentation.configDirLoginHarnessIds.contains("agy"))
        for harness in AccountsPresentation.configDirLoginHarnessIds {
            #expect(AccountsAutoBalance.eligibleHarnessIds(
                profiles: [(harness, true)],
                serverEligibleHarnessIds: [harness]).isEmpty)
            #expect(AccountsAutoBalance.eligibleHarnessIds(
                profiles: [(harness, true), (harness, true)],
                serverEligibleHarnessIds: [harness]) == [harness])
            #expect(AccountsAutoBalance.eligibleHarnessIds(
                profiles: [(harness, true), (harness, false)],
                serverEligibleHarnessIds: [harness]).isEmpty)
        }
    }

    /// "This harness id decodes as a SetupHarness" is NOT "this harness has a
    /// bootstrap login". A surface that offers a PROFILE-LESS login (the remote
    /// Setup button) must gate on the engine's bootstrap sugar — which resolves
    /// the login onto the `<harness>-default` row — or it posts a login the
    /// daemon refuses: agy signs in only into a named row.
    @Test func onlyBootstrapFamiliesOfferAProfilelessLogin() {
        #expect(!AccountsPresentation.supportsBootstrapLogin(.agy))
        #expect(SetupHarness(rawValue: HarnessFamily.agy.setupHarnessId) != nil)
        for family in [HarnessFamily.claude, .codex, .cursor] {
            #expect(AccountsPresentation.supportsBootstrapLogin(family))
        }
        // API-key families have no vendor login to bootstrap either.
        for family in [HarnessFamily.opencode, .raw, .openrouter] {
            #expect(!AccountsPresentation.supportsBootstrapLogin(family))
        }
    }

    /// The global popover's add flow is DERIVED from the config-dir login set,
    /// not hand-listed. The hand-listed picker offered Claude/Codex/Cursor only,
    /// so a user who had added one Google account found no way to add the second
    /// and no explanation — the two-account story dead-ended in the one surface
    /// that owns adding accounts.
    @Test func everyConfigDirLoginFamilyIsAddableAndNamedInTheCaption() {
        let addable = AccountsPresentation.addableFamilies
        #expect(addable.map(\.rawValue) == AccountsPresentation.configDirLoginHarnessIds)
        #expect(addable.contains(HarnessFamily.agy))

        // The caption names the PRODUCTS, in the SSOT's own order, and can
        // never again omit a family the picker offers.
        let caption = AccountsPresentation.addAccountCaption(family: nil)
        for family in addable { #expect(caption.contains(family.label)) }
        #expect(caption.contains("Antigravity"))
        // Л-14: never the binary id.
        #expect(!caption.contains("Agy"))

        // A family-scoped host (the Harness Doctor's Manage sheet) names its
        // one vendor instead of the whole list.
        let scoped = AccountsPresentation.addAccountCaption(family: .agy)
        #expect(scoped.contains("Antigravity"))
        #expect(!scoped.contains("Cursor"))

        // The form's initial selection must be a row the picker actually
        // offers, or the control opens on nothing.
        #expect(AccountsPresentation.configDirLoginHarnessIds
            .contains(AccountsPresentation.defaultAddHarnessId))
    }

    /// Grok Build accounts are named rows like Antigravity: addable from the
    /// popover under the product name, never a profile-less bootstrap login.
    @Test func grokIsAddableAsANamedAccountOnly() {
        let grok = HarnessFamily(rawValue: "grok")
        #expect(AccountsPresentation.addableFamilies.contains(grok))
        #expect(AccountsPresentation.addAccountCaption(family: nil).contains("Grok Build"))
        #expect(AccountsPresentation.addAccountCaption(family: grok).contains("Grok Build"))
        #expect(SetupHarness(rawValue: grok.setupHarnessId) == .grok)
        #expect(!AccountsPresentation.supportsBootstrapLogin(grok))
    }

    /// Oxford list: a future two-family set must not read "A, or B".
    @Test func addableFamilyListReadsAsProse() {
        #expect(AccountsPresentation.listed([]) == "")
        #expect(AccountsPresentation.listed(["Claude"]) == "Claude")
        #expect(AccountsPresentation.listed(["Claude", "Codex"]) == "Claude or Codex")
        #expect(AccountsPresentation.listed(["Antigravity", "Claude", "Codex"])
            == "Antigravity, Claude, or Codex")
    }

    @Test func accountActionNoticeClearsAndRejectsLateCompletions() {
        var notice = AccountsActionNotice()
        let first = notice.begin()
        notice.settle("First refusal", generation: first)
        #expect(notice.message == "First refusal")

        let second = notice.begin()
        #expect(notice.message == nil)
        notice.settle("Late first refusal", generation: first)
        #expect(notice.message == nil)
        notice.settle("Current refusal", generation: second)
        #expect(notice.message == "Current refusal")

        let third = notice.begin()
        notice.settle(nil, generation: third)
        #expect(notice.message == nil)
    }

    @MainActor
    @Test func enabledActionRidesTheProfilePatchRouteForEveryRow() async {
        // Unified account model: EVERY row's Enabled toggle is the profile
        // PATCH (the retired native_credentials_enabled settings path died
        // with the pseudo-row), so every refusal is the PATCH route's.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let row = AccountRowModel(
            id: "profile/claude/work", displayName: "Work", harnessId: "claude",
            family: .claude, readiness: .unknown, verified: false, profileId: "work",
            detail: nil, quotaGroups: [], enabled: true, nextUp: false)
        let migrated = AccountRowModel(
            id: "profile/claude/claude-default", displayName: "claude default login",
            harnessId: "claude", family: .claude, readiness: .unknown, verified: false,
            profileId: "claude-default", detail: nil, quotaGroups: [], enabled: true,
            nextUp: false)

        #expect(await AccountsSurface.setEnabled(row, to: false, model: model)
            == "Engine offline — reconnect to change the account.")
        #expect(await AccountsSurface.setEnabled(migrated, to: false, model: model)
            == "Engine offline — reconnect to change the account.")
    }

    @Test func crossGroupResetOrderingUsesAbsoluteInstantsAndStableFallbacks() {
        let sameInstantZ = "2026-08-09T00:00:00Z"
        let sameInstantOffset = "2026-08-09T01:00:00+01:00"
        #expect(AccountsPresentation.earliestReset(
            [sameInstantOffset, sameInstantZ]) == sameInstantZ)
        #expect(AccountsPresentation.earliestReset(
            [sameInstantZ, sameInstantOffset]) == sameInstantZ)

        // Raw lexical order says 00:30 is earlier, but the offsets make it
        // 02:30Z; the raw 03:00 value is actually the earlier 01:00Z instant.
        let lexicallyFirstButLater = "2026-08-09T00:30:00-02:00"
        let lexicallyLaterButEarlier = "2026-08-09T03:00:00+02:00"
        #expect(AccountsPresentation.earliestReset(
            [lexicallyFirstButLater, lexicallyLaterButEarlier])
            == lexicallyLaterButEarlier)

        #expect(AccountsPresentation.earliestReset(
            ["unknown-z", sameInstantZ, "unknown-a"]) == sameInstantZ)
        #expect(AccountsPresentation.earliestReset(
            ["unknown-z", "unknown-a"]) == "unknown-a")
    }

    @MainActor
    @Test func authSheetBoundaryPreservesTheOneActionLoginTarget() {
        let sheet = AuthSheet(target: AuthSheetTarget(
            family: .claude, profileId: "work", autoStartLogin: true))
        #expect(sheet.family == .claude)
        #expect(sheet.profileId == "work")
        #expect(sheet.autoStartLogin)
    }

    @MainActor
    @Test func accountReadinessRequiresExactPassedSourceVerification() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        func seed(availability: String, verification: String, detail: String? = nil) throws {
            let json = """
            [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
              "credential_kind":"config_dir_login","enabled":true},
              "status":{"availability":"\(availability)","verification":"\(verification)",
              "detail":\(detail.map { "\"\($0)\"" } ?? "null"),"last_verified_at":null}}]
            """
            model.credentialProfiles = try JSONDecoder().decode(
                [CredentialProfileEntry].self, from: Data(json.utf8))
        }

        try seed(availability: "available", verification: "failed", detail: "session expired")
        var row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unavailable)
        #expect(!row.verified)

        try seed(availability: "available", verification: "not_run")
        row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unknown)

        try seed(availability: "unavailable", verification: "not_run")
        row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .unavailable)

        try seed(availability: "available", verification: "passed")
        row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.readiness == .ready)
        #expect(row.verified)
    }

    @MainActor
    @Test func accountsAvailabilityFollowsTheActiveLocationGateway() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let locationID = ExecutionLocationID.remote(UUID())
        model.draftExecutionLocation = locationID
        model.health = .connected
        #expect(!AccountsPresentation.isAvailable(model: model))

        model.remoteClients[locationID] = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test")
        model.health = .offline
        #expect(AccountsPresentation.isAvailable(model: model))
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
        #expect(row.profileId == "work")
        #expect(!row.enabled)
    }

    @MainActor
    @Test func everyRowRendersFromTheProfilesListAndNothingIsSynthesized() throws {
        // Unified account model: doctor knowledge of a harness must NOT
        // fabricate a "CLI login" pseudo-row — with zero profile rows the list
        // is empty, and with rows every one is a registry row.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "session ready",
            intents: ["implement"])]
        model.exactAuthSources[.claude] = [
            .nativeSession: HarnessAuthSource(
                source: "native_session", availability: "available", verification: "passed"),
        ]
        #expect(AccountsPresentation.rows(model: model).isEmpty)

        // The migrated legacy login is the ordinary `claude-default` row.
        let profilesJSON = """
        [{"profile":{"profile_id":"claude-default","harness_id":"claude",
          "display_name":"claude default login","credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}},
         {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":false},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))
        let rows = AccountsPresentation.rows(model: model)
        #expect(rows.map(\.profileId) == ["claude-default", "work"])
        // Enabled is the wire `profile.enabled` on every row — including the
        // migrated one, whose toggle rides the same profile PATCH route.
        #expect(rows.map(\.enabled) == [true, false])
    }

    @MainActor
    @Test func nextUpBindsToTheAccountPoolsAuthority() throws {
        // The routing verdict rides ONLY the `accountPools` carrier — the
        // legacy harnessAccounts projection is never consulted.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
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
        model.accountPools = try JSONDecoder().decode(
            [HarnessAccountPool].self,
            from: Data(#"[{"harness_id":"claude","next_up":{"kind":"profile","profileId":"work"}}]"#.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true

        var rows = AccountsPresentation.rows(model: model)
        #expect(rows.first { $0.profileId == "work" }?.nextUp == true)
        #expect(rows.first { $0.profileId == "spare" }?.nextUp == false)

        // Expired authority never fabricates a verdict.
        model.accountsNextUpAuthorityFresh[.local] = false
        rows = AccountsPresentation.rows(model: model)
        #expect(rows.allSatisfy { !$0.nextUp })
    }

    @MainActor
    @Test func unknownNextUpKindIsToleratedAndMarksNoRow() throws {
        // Forward compatibility: a newer engine's pool kind decodes as
        // `.unknown` — the accounts response survives and no row shows the
        // badge (the legacy throw-on-unknown decoder class is dead).
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.accountPools = try JSONDecoder().decode(
            [HarnessAccountPool].self,
            from: Data(#"[{"harness_id":"claude","next_up":{"kind":"quantum_route","extra":42}}]"#.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true

        #expect(model.accountPools.first?.nextUp == .unknown(kind: "quantum_route"))
        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.nextUp == false)
        #expect(AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil
        ).label == "Automatic")
    }

    @MainActor
    @Test func apiKeyRouteIsARouteNeverAnAccountRow() throws {
        // INV-061: the pool's api_key_route verdict adds NO row and marks no
        // row as next up; the unpinned composer segment stays "Automatic".
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.liveHarnesses = [HarnessInfo(
            family: .claude, health: .ok, version: "1", auth: "key ready",
            intents: ["implement"])]
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":false},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.accountPools = try JSONDecoder().decode(
            [HarnessAccountPool].self,
            from: Data(#"[{"harness_id":"claude","next_up":{"kind":"api_key_route"}}]"#.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true

        let rows = AccountsPresentation.rows(model: model)
        #expect(rows.count == 1)
        #expect(rows.allSatisfy { !$0.nextUp })
        #expect(model.authoritativeNextUp(for: "claude")?.isApiKeyRoute == true)
        #expect(AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil
        ).label == "Automatic")
    }

    @Test func apiKeyRouteDisclosureIsLimitedToConfigDirLoginFamilies() {
        // The popover's api_key_route line explains a DEGRADATION: a
        // config-dir-login family whose enabled rows cannot serve the next
        // unpinned run. For api-key-PRIMARY families (opencode/raw-api/
        // openrouter) the key IS the ordinary route — no standing line.
        let pools = ["claude", "openrouter", "opencode", "raw-api"]
        #expect(AccountsPresentation.apiKeyRouteDisclosureHarnessIds(
            family: nil, poolHarnessIds: pools, isApiKeyRouteNextUp: { _ in true })
            == ["claude"])
        // No api_key_route verdict → no line at all.
        #expect(AccountsPresentation.apiKeyRouteDisclosureHarnessIds(
            family: nil, poolHarnessIds: pools, isApiKeyRouteNextUp: { _ in false })
            .isEmpty)
        // A family-scoped host (the AuthSheet) follows the same rule.
        #expect(AccountsPresentation.apiKeyRouteDisclosureHarnessIds(
            family: .claude, poolHarnessIds: [], isApiKeyRouteNextUp: { $0 == "claude" })
            == ["claude"])
        #expect(AccountsPresentation.apiKeyRouteDisclosureHarnessIds(
            family: .openrouter, poolHarnessIds: [], isApiKeyRouteNextUp: { _ in true })
            .isEmpty)
    }

    @MainActor
    @Test func identityLineBindsToTheDaemonProjectionAndFallsBackToDetail() throws {
        // INV-067: the row's secondary line is the daemon-projected {email, plan}
        // ("email · plan") when disclosed, sourced from the profile entry's
        // `identity` on the wire. When absent the row falls back to the
        // readiness detail.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        // "work" discloses both fields; "plan-only" discloses just the plan;
        // "bare" discloses nothing and must fall back to its status detail;
        // the migrated `cursor-default` row keeps its verified readiness
        // reachable from status-marker help without an extra visible line.
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":"probe ok","last_verified_at":null},
          "identity":{"email":"work@example.test","plan":"claude_max"}},
         {"profile":{"profile_id":"plan-only","harness_id":"claude","display_name":"PlanOnly",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":"probe ok","last_verified_at":null},
          "identity":{"plan":"claude_pro"}},
         {"profile":{"profile_id":"bare","harness_id":"claude","display_name":"Bare",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":"probe ok","last_verified_at":null},
          "identity":null},
         {"profile":{"profile_id":"failed","harness_id":"claude","display_name":"Failed",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"unavailable","verification":"failed","detail":"login expired","last_verified_at":null},
          "identity":{"email":"old@example.test"}},
         {"profile":{"profile_id":"cursor-default","harness_id":"cursor",
          "display_name":"cursor default login","credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":"Cursor session verified in the profile store","last_verified_at":null},
          "identity":{"email":"cursor@example.test"}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))

        let rows = AccountsPresentation.rows(model: model)
        let work = try #require(rows.first { $0.profileId == "work" })
        #expect(work.identityLine == "work@example.test · claude_max")
        #expect(work.secondaryLines == ["work@example.test · claude_max"])
        #expect(work.hiddenReadinessDetail == "probe ok")
        let planOnly = try #require(rows.first { $0.profileId == "plan-only" })
        #expect(planOnly.identityLine == "claude_pro")
        let bare = try #require(rows.first { $0.profileId == "bare" })
        #expect(bare.identityLine == nil)     // nothing disclosed → falls back to detail
        #expect(bare.detail == "probe ok")
        #expect(bare.secondaryLines == ["probe ok"])
        let failed = try #require(rows.first { $0.profileId == "failed" })
        #expect(failed.secondaryLines == ["old@example.test", "login expired"])
        #expect(failed.hiddenReadinessDetail == nil)
        let cursorDefault = try #require(rows.first { $0.profileId == "cursor-default" })
        #expect(cursorDefault.identityLine == "cursor@example.test")
        #expect(cursorDefault.secondaryLines == ["cursor@example.test"])
        #expect(cursorDefault.hiddenReadinessDetail
            == "Cursor session verified in the profile store")
    }

    @MainActor
    @Test func compactPercentIgnoresScopedRatiosAndLabelsScopedExhaustion() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"""
        {"snapshots":[{"subject":{"harness":"claude","credential_route":"vendor_native",
          "plan_label":"max","subject_id":"work"},"constraints":[
          {"id":"five_hour","label":"5 hour","applies_to_models":null,"used_ratio":0.2,
           "window_seconds":18000,"resets_at":"2026-08-09T05:00:00Z","cooldown_until":null},
          {"id":"weekly_fable","label":"Week","applies_to_models":["fable"],"used_ratio":1,
           "window_seconds":604800,"resets_at":"2026-08-10T00:00:00Z","cooldown_until":null}],
          "source":"claude_oauth_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh",
          "availability":{"state":"available","blocking_constraints":[],"resets_at":null,
          "model_scoped_exhaustions":[{"constraint_id":"weekly_fable",
          "applies_to_models":["fable"],"resets_at":"2026-08-10T00:00:00Z"}]}}],
          "absences":[],"refreshed_at":"2026-08-09T00:00:00Z"}
        """#.utf8))

        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.worstPercent == 20)
        #expect(row.compactWindow?.usedRatio == 0.2)
        #expect(row.quotaAvailabilityState == "available")
        #expect(row.scopedQuotaLabel == "Fable only")
        #expect(AccountsPresentation.worstPercent([row]) == 20)
    }

    /// The compact percent describes text: image windows stay visible in the
    /// detail rows, labelled, but never become the account row's one number.
    @MainActor
    @Test func compactPercentDescribesTextWhileImageWindowsStayVisible() throws {
        func row(_ constraints: String) throws -> AccountRowModel {
            let model = AppModel(client: nil, requestNotificationAuthorization: false)
            model.credentialProfiles = try JSONDecoder().decode(
                [CredentialProfileEntry].self,
                from: Data(#"[{"profile":{"profile_id":"work","harness_id":"codex","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
            model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"""
            {"snapshots":[{"subject":{"harness":"codex","credential_route":"vendor_native",
              "plan_label":"pro","subject_id":"work"},"constraints":[\#(constraints)],
              "source":"codex_app_server","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh",
              "availability":{"state":"available","blocking_constraints":[],"resets_at":null,
              "model_scoped_exhaustions":[]}}],"absences":[],"refreshed_at":"2026-08-09T00:00:00Z"}
            """#.utf8))
            return try #require(AccountsPresentation.rows(model: model).first)
        }
        let image = #"""
        {"id":"image_gen:primary","label":"image_gen primary","applies_to_request_kinds":["image"],
         "used_ratio":0.95,"window_seconds":86400,"resets_at":"2026-08-10T00:00:00Z","cooldown_until":null}
        """#
        let text = #"""
        {"id":"codex:primary","label":"codex primary","applies_to_request_kinds":["text"],
         "used_ratio":0.2,"window_seconds":18000,"resets_at":"2026-08-09T05:00:00Z","cooldown_until":null}
        """#
        let legacy = #"""
        {"id":"primary","label":"primary","used_ratio":0.4,"window_seconds":18000,
         "resets_at":"2026-08-09T05:00:00Z","cooldown_until":null}
        """#

        let mixed = try row("\(image),\(text)")
        #expect(mixed.worstPercent == 20)
        #expect(mixed.worstWindow?.label == "codex primary")
        #expect(AccountsPresentation.worstPercent([mixed]) == 20)
        let windows = mixed.quotaGroups.flatMap(\.windows)
        #expect(windows.map(\.label).sorted() == ["codex primary", "image_gen primary (images)"])
        #expect(windows.first { $0.label.hasSuffix("(images)") }?.usedRatio == 0.95)
        // A window without request-kind scope still applies to text.
        #expect(try row("\(image),\(text),\(legacy)").worstPercent == 40)
        let imageOnly = try row(image)
        #expect(imageOnly.worstPercent == nil)
        #expect(imageOnly.quotaGroups.flatMap(\.windows).count == 1)
    }

    @MainActor
    @Test func scopedOnlyWindowsShowScopedUsageWithoutAnAccountPercent() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"""
        {"snapshots":[{"subject":{"harness":"claude","credential_route":"vendor_native",
          "plan_label":"max","subject_id":"work"},"constraints":[{"id":"weekly_fable",
          "label":"Week","applies_to_models":["fable"],"used_ratio":0.5,
          "window_seconds":604800,"resets_at":"2026-08-10T00:00:00Z","cooldown_until":null}],
          "source":"claude_oauth_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh",
          "availability":{"state":"available","blocking_constraints":[],"resets_at":null,
          "model_scoped_exhaustions":[]}}],"absences":[],
          "refreshed_at":"2026-08-09T00:00:00Z"}
        """#.utf8))

        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.worstPercent == nil)
        #expect(row.compactWindow?.usedRatio == 0.5)
        #expect(row.compactWindow?.appliesToModels == ["fable"])
        #expect(row.scopedQuotaLabel == nil)
        #expect(AccountsPresentation.worstPercent([row]) == nil)
    }

    @MainActor
    @Test func scopedExhaustionKeepsItsServerAuthoredWarningLabel() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"agy","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"""
        {"snapshots":[{"subject":{"harness":"agy","credential_route":"vendor_native","plan_label":null,"subject_id":"work"},"constraints":[{"id":"gemini-week","label":"Week","applies_to_models":["gemini-*"],"used_ratio":1,"window_seconds":604800,"resets_at":null,"cooldown_until":null}],"source":"agy_command_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh","availability":{"state":"available","blocking_constraints":[],"resets_at":null,"model_scoped_exhaustions":[{"constraint_id":"gemini-week","applies_to_models":["gemini-*"],"resets_at":null} ]}}],"absences":[],"refreshed_at":"2026-08-09T00:00:00Z"}
        """#.utf8))

        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.compactWindow?.usedRatio == 1)
        #expect(row.scopedQuotaLabel == "Gemini only")
        #expect(AccountsPresentation.worstPercent([row]) == nil)
    }

    @MainActor
    @Test func unmeasuredScopedWindowsRemainUnknown() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"agy","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"{"snapshots":[{"subject":{"harness":"agy","credential_route":"vendor_native","plan_label":null,"subject_id":"work"},"constraints":[{"id":"gemini-week","label":"Week","applies_to_models":["gemini-*"],"used_ratio":null,"window_seconds":604800,"resets_at":null,"cooldown_until":null}],"source":"agy_command_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh","availability":{"state":"available","blocking_constraints":[],"resets_at":null,"model_scoped_exhaustions":[]}}],"absences":[],"refreshed_at":"2026-08-09T00:00:00Z"}"#.utf8))

        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.compactWindow == nil)
        #expect(row.scopedQuotaLabel == nil)
        #expect(row.worstPercent == nil)
        #expect(AccountsPresentation.worstPercent([row]) == nil)
    }

    @MainActor
    @Test func unknownAccountWideWindowBlocksScopedFallback() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"{"snapshots":[{"subject":{"harness":"claude","credential_route":"vendor_native","plan_label":"max","subject_id":"work"},"constraints":[{"id":"five-hour","label":"5 hour","used_ratio":null,"window_seconds":18000,"resets_at":null,"cooldown_until":null},{"id":"fable-week","label":"Week","applies_to_models":["fable"],"used_ratio":0.8,"window_seconds":604800,"resets_at":"2026-08-10T00:00:00Z","cooldown_until":null}],"source":"claude_oauth_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"fresh","availability":{"state":"available","blocking_constraints":[],"resets_at":null,"model_scoped_exhaustions":[]}}],"absences":[],"refreshed_at":"2026-08-09T00:00:00Z"}"#.utf8))

        let row = try #require(AccountsPresentation.rows(model: model).first)
        #expect(row.worstWindow != nil)
        #expect(row.worstPercent == nil)
        #expect(row.compactWindow?.usedRatio == nil)
        #expect(row.compactWindow?.appliesToModels == nil)
        #expect(AccountsPresentation.worstPercent([row]) == nil)
    }

    @MainActor
    @Test func accountRowColumnSetIsStableAcrossRows() throws {
        // §1 presentation contract: every row emits the SAME ordered trailing
        // column set, which is exactly what keeps the Enabled toggle collinear.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.credentialProfiles = try JSONDecoder().decode([CredentialProfileEntry].self, from: Data("""
        [{"profile":{"profile_id":"claude-default","harness_id":"claude",
          "display_name":"claude default login","credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}},
         {"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """.utf8))
        let rows = AccountsPresentation.rows(model: model)
        let migrated = try #require(rows.first { $0.profileId == "claude-default" })
        let profile = try #require(rows.first { $0.profileId == "work" })
        #expect(AccountsPresentation.columns(for: migrated) == AccountsPresentation.columns(for: profile))
        #expect(AccountsPresentation.columns(for: migrated) == [.enabled, .manage, .delete])
    }

    @MainActor
    @Test func composerAccountSegmentKeepsAutomaticStableAndShowsAnExplicitPin() throws {
        // An unpinned thread is one stable Automatic choice even while the
        // server's next-up route changes; an explicit pin shows its account.
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let profilesJSON = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self, from: Data(profilesJSON.utf8))

        // No projection yet.
        var seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil)
        #expect(seg.pinned == false)
        #expect(seg.label == "Automatic")

        // Pool verdict: a specific row is next up — Automatic stays stable.
        model.accountPools = try JSONDecoder().decode([HarnessAccountPool].self, from: Data("""
        [{"harness_id":"claude","next_up":{"kind":"profile","profileId":"work"}}]
        """.utf8))
        model.accountsNextUpAuthorityFresh[.local] = true
        seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil)
        #expect(seg.pinned == false)
        #expect(seg.label == "Automatic")

        // The unpinned route may honestly be the policy API key (INV-061) —
        // still the one stable Automatic choice, never a fake account name.
        model.accountPools = try JSONDecoder().decode([HarnessAccountPool].self, from: Data("""
        [{"harness_id":"claude","next_up":{"kind":"api_key_route"}}]
        """.utf8))
        seg = AccountsPresentation.composerAccountSegment(
            model: model, harnessId: "claude", pinnedProfileId: nil)
        #expect(seg.label == "Automatic")

        // A thread pin overrides the pool and resolves to the profile's name.
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
