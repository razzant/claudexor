import ClaudexorKit

// MARK: - Credential profile mutations + quota rotation

extension AppModel {
    struct CredentialProfileDeletionResult: Equatable {
        let message: String
        let isError: Bool
    }
    /// Toggle an account row's Enabled — the ONE routing control, uniformly the
    /// profile PATCH route for every row (unified account model; the retired
    /// `native_credentials_enabled` settings path died with the CLI-login
    /// pseudo-row). Reloads the projection so Enabled reflects wire truth.
    /// Returns a refusal string on failure.
    @discardableResult
    func setProfileEnabled(harnessId: String, profileId: String, enabled: Bool) async -> String? {
        let locationID = activeExecutionLocation
        accountsNextUpAuthorityFresh[locationID] = false
        guard let requestClient = gateway(for: locationID) else {
            return "Engine offline — reconnect to change the account."
        }
        do {
            _ = try await requestClient.updateCredentialProfile(
                harnessId: harnessId, profileId: profileId, enabled: enabled)
            noteAccountResourceBindingWrite(AccountTarget(harness: harnessId, profileId: profileId), at: locationID)
            await refreshCredentialProfilesAfterMutation(locationID: locationID)
            return nil
        } catch {
            await refreshCredentialProfiles(locationID: locationID)
            return userMessage(for: error)
        }
    }

    /// Register a new credential profile (INV-135). On success the registry is
    /// refreshed and the new entry returned so the accounts popover can offer its
    /// login immediately. On failure the daemon's reason (409 duplicate id / 400
    /// invalid slug or harness) is returned verbatim for inline display.
    func createCredentialProfile(harnessId: String, profileId: String, displayName: String?) async
        -> (entry: CredentialProfileEntry?, error: String?) {
        let locationID = activeExecutionLocation
        accountsNextUpAuthorityFresh[locationID] = false
        guard let requestClient = gateway(for: locationID) else {
            return (nil, "Engine offline — reconnect to add an account.")
        }
        do {
            let entry = try await requestClient.createCredentialProfile(
                CreateCredentialProfileRequest(harnessId: harnessId, profileId: profileId, displayName: displayName))
            await refreshCredentialProfilesAfterMutation(locationID: locationID)
            return (entry, nil)
        } catch {
            return (nil, userMessage(for: error))
        }
    }

    /// Remove a credential profile (INV-135 / D-U4): success means the binding
    /// and any Claudexor-owned state or managed secret are gone. Vendor-owned
    /// OS-user credentials can deliberately remain unchanged and are disclosed
    /// as successful info.
    /// Returns the daemon's
    /// reason on refusal: a 409 while a login job is active, or the typed
    /// RETRYABLE 503 `credential_cleanup_failed` — the row stays registered so
    /// the removal can simply be retried; that state is an error, never a
    /// half-deleted success. An old engine's removed-with-warning receipt is
    /// still surfaced verbatim.
    func deleteCredentialProfile(harnessId: String, profileId: String) async
        -> CredentialProfileDeletionResult {
        let locationID = activeExecutionLocation
        accountsNextUpAuthorityFresh[locationID] = false
        guard let requestClient = gateway(for: locationID) else {
            return .init(message: "Engine offline — reconnect to remove an account.", isError: true)
        }
        do {
            let receipt = try await requestClient.deleteCredentialProfile(
                harnessId: harnessId, profileId: profileId)
            noteAccountResourceBindingWrite(AccountTarget(harness: harnessId, profileId: profileId), at: locationID)
            if draftCredentialProfileId == profileId {
                draftCredentialProfileId = nil
                if draftPrimaryHarness == harnessId { draftPrimaryHarness = nil }
            }
            await refreshCredentialProfilesAfterMutation(locationID: locationID)
            if locationID == .local {
                await refreshThreads()
            } else {
                await refreshRemoteThreads(locationID)
            }
            if let selectedThreadId {
                await refreshOpenThread(
                    locationID: locationID, id: selectedThreadId, mayReconnect: false)
            }
            return .init(message: Self.deletionSuccessMessage(for: receipt), isError: false)
        } catch {
            // The row survived; reload so the surface keeps showing it beside
            // the refusal instead of pretending the delete settled.
            await refreshCredentialProfiles(locationID: locationID)
            return .init(
                message: Self.deleteRefusalMessage(for: error) ?? userMessage(for: error),
                isError: true)
        }
    }

    static func deletionSuccessMessage(for receipt: DeleteCredentialProfileReceipt) -> String {
        if receipt.vendorCredentialDisposition != nil {
            return "Removed from Claudexor. Claudexor removed the binding and any Claudexor-owned state or managed secret; it did not change any vendor credential for this OS user."
        }
        if let warning = receipt.cleanupWarning { return "Removed from Claudexor. \(warning)" }
        return "Removed from Claudexor."
    }

    /// The typed delete-refusal mapping (D-U4): the engine's retryable
    /// `credential_cleanup_failed` names the honest state — binding kept,
    /// owned-state cleanup possibly partial — and the working next act
    /// (retry). nil falls back to the generic error mapping.
    static func deleteRefusalMessage(for error: Error) -> String? {
        guard let problem = (error as? GatewayError)?.controlProblem,
              problem.code == "credential_cleanup_failed"
        else { return nil }
        return "Couldn't remove Claudexor-owned state or a managed secret, so the binding is still registered: \(problem.message) Try Remove again."
    }

    // MARK: Auto-switch-at-quota (batch-6 item b)

    /// The harnesses the auto-switch toggle targets: config_dir_login families
    /// with a SECOND ENABLED account row registered (unified account model —
    /// every identity is a row, rotation draws only from the enabled pool, so
    /// it needs ≥2 enabled rows). A harness whose extra rows are disabled
    /// cannot rotate, so it is excluded — the old hardcoded [claude, codex] set
    /// patched harnesses that had nothing to switch to (owner: "renders but
    /// doesn't activate").
    var autoBalanceHarnessIds: [String] {
        let serverEligible: Set<String>
        if accountsNextUpAuthorityFresh[activeExecutionLocation] == true {
            serverEligible = Set(activeAccountPools.compactMap { pool in
                if case .profile = pool.nextUp { return pool.harnessId }
                return nil
            })
        } else {
            serverEligible = []
        }
        return AccountsAutoBalance.eligibleHarnessIds(
            profiles: activeCredentialProfiles.map {
                // Ambiguous and server-unavailable rows are not rotation
                // candidates. Valid pools keep every verified enabled row.
                let serverReady = $0.status.availability == "available"
                    && $0.status.verification == "passed"
                return (harnessId: $0.profile.harnessId,
                        enabled: $0.profile.enabled && serverReady)
            },
            serverEligibleHarnessIds: serverEligible)
    }

    /// Aggregated auto-switch state across the eligible harnesses. `mixed` (they
    /// disagree) renders as "—"; `unavailable` (no 2nd account anywhere) disables
    /// the control. Reads the per-harness `profile_limit_action` from settings;
    /// an ABSENT value is the engine's stored `auto` default (A6).
    var autoBalanceState: AccountsAutoBalance.State {
        if let pending = autoBalanceOverride {
            // While a save round-trips, reflect the optimistic choice — but only
            // when there is actually an eligible harness to have set.
            if autoBalanceHarnessIds.isEmpty { return .unavailable }
            switch pending {
            case .rotate: return .on
            case .auto: return .auto
            case .fail: return .off
            }
        }
        let actions = autoBalanceHarnessIds.map {
            activeSettingsSnapshot?.harnesses?[$0]?.profileLimitAction ?? "auto"
        }
        return AccountsAutoBalance.state(actions: actions)
    }

    /// Apply one tri-state pick to every eligible harness at once (On = rotate,
    /// Auto = kind-aware default, Off = fail), so a mixed state resolves to a
    /// single consistent choice. Off never erases a hand-configured `ask`
    /// (see `AccountsAutoBalance.patchValue`).
    func setAutoBalance(_ choice: AccountsAutoBalance.Choice) async {
        let patch = Dictionary(uniqueKeysWithValues: autoBalanceHarnessIds.compactMap {
            id -> (String, HarnessSettingsPatch)? in
            let current = activeSettingsSnapshot?.harnesses?[id]?.profileLimitAction ?? "auto"
            guard let value = AccountsAutoBalance.patchValue(current: current, choice: choice)
            else { return nil }
            return (id, HarnessSettingsPatch(profileLimitAction: value))
        })
        guard !patch.isEmpty else { return }
        accountsNextUpAuthorityFresh[activeExecutionLocation] = false
        autoBalanceOverride = choice
        defer { autoBalanceOverride = nil }
        _ = await saveSettings(SettingsUpdateRequest(harnesses: patch))
    }
}
