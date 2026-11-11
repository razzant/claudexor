import Foundation
import ClaudexorKit

struct AccountsRefreshReceipt: Sendable {
    let generation: UInt64
    let registryGeneration: UInt64
    let profiles: [CredentialProfileEntry]?
    let registryCommitted: Bool
    let error: String?
}

// MARK: - Credential profiles + auto-balance (INV-135)
//
// The account-registry half of AppModel: registered credential profiles with
// doctor readiness, in-app registration/removal, and the auto-balance toggle
// (per-harness profile_policy.limit_action via the settings wire).

extension AppModel {
    var activeAccountsLoadState: ProjectionLoadState {
        accountsLoadStates[activeExecutionLocation] ?? .idle
    }

    var activeAccountsReadinessFresh: Bool {
        accountsReadinessAuthorityFresh[activeExecutionLocation] != false
    }

    /// Persist the thread's manual account choice (INV-135). nil restores the
    /// engine-default ladder; a draft carries the choice into thread creation.
    func setThreadCredentialProfile(_ profileId: String?, harnessId: String? = nil) async {
        guard let id = selectedThreadId else {
            draftCredentialProfileId = profileId
            if let harnessId {
                draftPrimaryHarness = harnessId
                if profileId != nil { draftEligiblePool = [harnessId] }
            }
            return
        }
        let locationID = selectedExecutionLocation
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to change the account."
            return
        }
        do {
            let updated = try await requestClient.updateThread(
                id: id,
                body: UpdateThreadRequest(
                    primaryHarness: harnessId.map { .some($0) },
                    eligibleHarnesses: profileId == nil ? nil : harnessId.map { [$0] },
                    credentialProfileId: .some(profileId)))
            applyThreadUpdate(updated, at: locationID)
        } catch {
            if selectedExecutionLocation == locationID, selectedThreadId == id {
                threadStatus = userMessage(for: error)
            }
        }
    }

    /// Fetch and return one exact account only when this request remains the
    /// current projection owner through commit. The ordinary Accounts loader
    /// intentionally retires an older caller silently when a newer refresh
    /// supersedes it; setup verification must not mistake that nil error for a
    /// fresh receipt and read the previous shared projection.
    func refreshExactCredentialProfile(
        harnessID: String,
        profileID: String,
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) async -> CredentialProfileEntry? {
        let locationID = requestedLocationID ?? activeExecutionLocation
        let receipt = await refreshAccountsReceipt(at: locationID)
        guard receipt.error == nil,
              receipt.registryCommitted,
              accountsRefreshGenerations[locationID] == receipt.generation,
              accountsRegistryGenerations[locationID] == receipt.registryGeneration
        else { return nil }
        return receipt.profiles?.first {
            $0.profile.harnessId == harnessID && $0.profile.profileId == profileID
        }
    }

    /// The request receipt keeps the data-generation fence and the Accounts
    /// presentation settlement on one authority. In particular, a newer
    /// background refresh that supersedes an in-flight foreground Retry owns
    /// the visible success/failure once it settles.
    private func performAccountsRefresh(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        harnessLease: HarnessProjectionLease,
        generation: UInt64,
        registryGeneration: UInt64,
        quotaDisplayGenerationAtStart: UInt64,
        previousQuotaCursor: String?
    ) async -> AccountsRefreshReceipt {
        let finish: ([CredentialProfileEntry]?, Bool, String?) -> AccountsRefreshReceipt = {
            AccountsRefreshReceipt(
                generation: generation,
                registryGeneration: registryGeneration,
                profiles: $0,
                registryCommitted: $1,
                error: $2)
        }
        do {
            let evidenceRead = accountsRoutingEvidence.begin(at: locationID)
            let capabilities = await loadAccountResourceCapabilities(client: requestClient, at: locationID)
            Task { @MainActor [weak self] in
                await self?.accountsRoutingEvidence.refresh(
                    evidenceRead, client: requestClient, at: locationID, capabilities: capabilities,
                    isCurrent: { [weak self] in self?.isCurrentGateway(requestClient, at: locationID) == true })
            }
            let response = try await requestClient.credentialProfilesSnapshot(
                resources: capabilities?.accountsSnapshot == true, apiKeys: capabilities?.apiKeys == true)
            guard accountsRefreshIsCurrent(generation, client: requestClient, at: locationID)
            else {
                return finish(nil, false, accountsRefreshRetirementMessage(
                    requestClient, at: locationID))
            }
            if let harnesses = response.harnesses,
               let git = response.git,
               let quota = response.quota,
               let quotaEventCursor = response.quotaEventCursor?.trimmingCharacters(
                   in: .whitespacesAndNewlines),
               !quotaEventCursor.isEmpty
            {
                let registryCommitted = commitAccountsRegistryIfCurrent(
                    response, at: locationID, generation: registryGeneration)
                guard acceptHarnessSnapshot(
                    harnesses, git: git, lease: harnessLease)
                else {
                    let message = settleAccountsAfterSupersededHarnessProjection(
                        at: locationID,
                        client: requestClient,
                        registryGeneration: registryGeneration,
                        previousQuotaCursor: previousQuotaCursor,
                        quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                        markHarnessReadinessStale: false)
                    return finish(response.profiles, registryCommitted, message)
                }
                // The atomic tuple still owns cursor/next_up/readiness, but a
                // display-only GET admitted later owns the visible quota slice.
                // Never regress that newer projection with this older request.
                storeAccountsQuotaSnapshot(
                    quota,
                    at: locationID,
                    ifDisplayGenerationIs: quotaDisplayGenerationAtStart)
                rememberAccountsQuotaDisplayMarker(quotaEventCursor, at: locationID)
                startAccountsQuotaObserver(
                    at: locationID, client: requestClient, after: quotaEventCursor)
                accountsReadinessAuthorityFresh[locationID] = true
                // A later plain hydration/mutation owns the stable registry and
                // intentionally expires the tuple's next_up authority.
                accountsNextUpAuthorityFresh[locationID] = registryCommitted
                if registryCommitted {
                    accountsRegistryLoadStates[locationID] = .loaded
                    return finish(response.profiles, true, nil)
                }
                return finish(
                    response.profiles,
                    false,
                    "Accounts changed while the full refresh was running. Refresh again for routing order.")
            }
            let registryCommitted = commitAccountsProfilesOnlyIfCurrent(
                response.profiles, at: locationID, generation: registryGeneration)
            if registryCommitted {
                accountsRegistryLoadStates[locationID] = .loaded
            }
            let message = "The engine returned an incomplete Accounts snapshot. Update the runtime and retry."
            markAccountsRefreshFailure(
                at: locationID,
                client: requestClient,
                registryGeneration: registryGeneration,
                previousQuotaCursor: previousQuotaCursor,
                quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                reason: message)
            return finish(response.profiles, registryCommitted, message)
        } catch {
            guard accountsRefreshIsCurrent(generation, client: requestClient, at: locationID)
            else {
                return finish(nil, false, accountsRefreshRetirementMessage(
                    requestClient, at: locationID))
            }
            guard harnessProjectionIsCurrent(harnessLease) else {
                let message = settleAccountsAfterSupersededHarnessProjection(
                    at: locationID,
                    client: requestClient,
                    registryGeneration: registryGeneration,
                    previousQuotaCursor: previousQuotaCursor,
                    quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                    markHarnessReadinessStale: false)
                return finish(nil, false, message)
            }
            let message = userMessage(for: error)
            markAccountsRefreshFailure(
                at: locationID,
                client: requestClient,
                registryGeneration: registryGeneration,
                previousQuotaCursor: previousQuotaCursor,
                quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                reason: message)
            return finish(nil, false, message)
        }
    }

    private func commitAccountsRegistryIfCurrent(
        _ response: CredentialProfilesResponse,
        at locationID: ExecutionLocationID,
        generation: UInt64
    ) -> Bool {
        guard accountsRegistryGenerations[locationID] == generation else { return false }
        storeCredentialProfiles(
            response.profiles,
            accountPools: response.accountPools,
            at: locationID)
        return true
    }

    /// A legacy/incomplete response cannot authoritatively replace the pool
    /// authority slice (older daemons omit it and decode as empty). Its
    /// profile registry remains useful, so update that slice without erasing
    /// the last stable pool verdicts.
    private func commitAccountsProfilesOnlyIfCurrent(
        _ profiles: [CredentialProfileEntry],
        at locationID: ExecutionLocationID,
        generation: UInt64
    ) -> Bool {
        guard accountsRegistryGenerations[locationID] == generation else { return false }
        if locationID == .local { credentialProfiles = profiles }
        else { remoteCredentialProfiles[locationID] = profiles }
        return true
    }

    private func accountsRefreshIsCurrent(
        _ generation: UInt64,
        client requestClient: GatewayClient,
        at locationID: ExecutionLocationID
    ) -> Bool {
        accountsRefreshGenerations[locationID] == generation
            && gateway(for: locationID) === requestClient
    }

    /// A newer Accounts refresh supersedes an older one silently. Retiring the
    /// exact daemon client is different: an explicit foreground refresh must
    /// not report that an empty, discarded projection loaded successfully.
    private func accountsRefreshRetirementMessage(
        _ requestClient: GatewayClient,
        at locationID: ExecutionLocationID
    ) -> String? {
        isCurrentGateway(requestClient, at: locationID)
            ? "A newer Accounts owner superseded this refresh. Retry Accounts."
            : "The engine connection changed while Accounts was refreshing. Retry Accounts."
    }

    func storeCredentialProfiles(
        _ profiles: [CredentialProfileEntry],
        accountPools pools: [HarnessAccountPool],
        at locationID: ExecutionLocationID
    ) {
        if locationID == .local {
            credentialProfiles = profiles
            accountPools = pools
        } else {
            remoteCredentialProfiles[locationID] = profiles
            remoteAccountPools[locationID] = pools
        }
    }

    /// A newer harness projection ticket superseded Accounts while it awaited
    /// its tuple. Settle only Accounts-owned slices; the newer harness/Git owner
    /// must remain untouched.
    private func settleAccountsAfterSupersededHarnessProjection(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient,
        registryGeneration: UInt64,
        previousQuotaCursor: String?,
        quotaDisplayGenerationAtStart: UInt64,
        markHarnessReadinessStale: Bool
    ) -> String {
        let message = "A newer harness refresh superseded Accounts. Retry Accounts."
        markAccountsRefreshFailure(
            at: locationID,
            client: requestClient,
            registryGeneration: registryGeneration,
            previousQuotaCursor: previousQuotaCursor,
            quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
            reason: message,
            markHarnessReadinessStale: markHarnessReadinessStale)
        return message
    }

    private func markAccountsRefreshFailure(
        at locationID: ExecutionLocationID,
        client requestClient: GatewayClient?,
        registryGeneration: UInt64,
        previousQuotaCursor: String?,
        quotaDisplayGenerationAtStart: UInt64,
        reason: String,
        markHarnessReadinessStale: Bool = true
    ) {
        accountsNextUpAuthorityFresh[locationID] = false
        // A plain hydration admitted after this full refresh owns newer
        // profile/native-account readiness and must not be downgraded by the
        // older failure settling late.
        if (accountsRegistryGenerations[locationID] ?? 0) == registryGeneration {
            accountsReadinessAuthorityFresh[locationID] = false
        }
        if markHarnessReadinessStale {
            if locationID == .local { harnessReadinessFresh = false }
            else { remoteHarnessReadinessFresh[locationID] = false }
        }
        let registryState = accountsRegistryLoadStates[locationID]
        if (accountsRegistryGenerations[locationID] ?? 0) == registryGeneration,
           registryState == nil || registryState == .idle || registryState == .loading
        {
            accountsRegistryLoadStates[locationID] = .failed(reason)
        }
        // A display-only GET that STARTED after this full refresh owns newer
        // display data; do not downgrade it when the older full request fails.
        if (accountsQuotaDisplayGenerations[locationID] ?? 0) == quotaDisplayGenerationAtStart {
            markAccountsQuotaDisplayStale(at: locationID, reason: reason)
        }
        if let previousQuotaCursor,
           let requestClient,
           isCurrentGateway(requestClient, at: locationID)
        {
            startAccountsQuotaObserver(
                at: locationID, client: requestClient, after: previousQuotaCursor)
        }
    }

    /// One event-driven Accounts refresh, pinned to one execution location for
    /// the whole await: fresh doctor readiness, account projection, Git, and
    /// quota arrive from one server-authored snapshot epoch.
    @discardableResult
    func refreshAccounts(locationID requestedLocationID: ExecutionLocationID? = nil) async
        -> String?
    {
        let locationID = requestedLocationID ?? activeExecutionLocation
        return await refreshAccountsReceipt(at: locationID).error
    }

    private func refreshAccountsReceipt(at locationID: ExecutionLocationID) async
        -> AccountsRefreshReceipt
    {
        if let inFlight = accountsRefreshTasks[locationID] {
            return await inFlight.value
        }
        guard let requestClient = gateway(for: locationID) else {
            let message = "Engine offline — reconnect to refresh Accounts."
            let registryGeneration = accountsRegistryGenerations[locationID] ?? 0
            markAccountsRefreshFailure(
                at: locationID,
                client: nil,
                registryGeneration: registryGeneration,
                previousQuotaCursor: nil,
                quotaDisplayGenerationAtStart: accountsQuotaDisplayGenerations[locationID] ?? 0,
                reason: message)
            accountsLoadStates[locationID] = .failed(message)
            return AccountsRefreshReceipt(
                generation: accountsRefreshGenerations[locationID] ?? 0,
                registryGeneration: registryGeneration,
                profiles: nil,
                registryCommitted: false,
                error: message)
        }

        // A full refresh retires an older cached hydration. Its late response is
        // fenced by registryGeneration even if URL loading ignores cancellation.
        accountsRegistryTrailingHydrations.remove(locationID)
        accountsRegistryLoadTokens.removeValue(forKey: locationID)
        accountsRegistryLoadTasks.removeValue(forKey: locationID)?.cancel()
        let registryGeneration = (accountsRegistryGenerations[locationID] ?? 0) &+ 1
        accountsRegistryGenerations[locationID] = registryGeneration
        let generation = (accountsRefreshGenerations[locationID] ?? 0) &+ 1
        accountsRefreshGenerations[locationID] = generation
        let quotaDisplayGenerationAtStart = accountsQuotaDisplayGenerations[locationID] ?? 0
        let previousQuotaCursor = suspendAccountsQuotaObserver(at: locationID)
        accountsNextUpAuthorityFresh[locationID] = false
        if accountsRegistryLoadStates[locationID] == nil {
            accountsRegistryLoadStates[locationID] = .loading
        }
        guard let harnessLease = claimHarnessProjection(
            at: locationID, client: requestClient)
        else {
            let message = "The engine connection changed before Accounts could refresh. Retry Accounts."
            markAccountsRefreshFailure(
                at: locationID,
                client: requestClient,
                registryGeneration: registryGeneration,
                previousQuotaCursor: previousQuotaCursor,
                quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                reason: message)
            accountsLoadStates[locationID] = .failed(message)
            return AccountsRefreshReceipt(
                generation: generation,
                registryGeneration: registryGeneration,
                profiles: nil,
                registryCommitted: false,
                error: message)
        }

        let token = UUID()
        accountsRefreshTaskTokens[locationID] = token
        accountsLoadTokens[locationID] = token
        accountsLoadStates[locationID] = .loading
        let task = Task { @MainActor [weak self] in
            guard let self else {
                return AccountsRefreshReceipt(
                    generation: generation,
                    registryGeneration: registryGeneration,
                    profiles: nil,
                    registryCommitted: false,
                    error: "Accounts stopped refreshing.")
            }
            return await self.performAccountsRefresh(
                at: locationID,
                client: requestClient,
                harnessLease: harnessLease,
                generation: generation,
                registryGeneration: registryGeneration,
                quotaDisplayGenerationAtStart: quotaDisplayGenerationAtStart,
                previousQuotaCursor: previousQuotaCursor)
        }
        accountsRefreshTasks[locationID] = task
        let receipt = await task.value
        guard accountsRefreshTaskTokens[locationID] == token else { return receipt }
        accountsRefreshTaskTokens.removeValue(forKey: locationID)
        accountsRefreshTasks.removeValue(forKey: locationID)
        accountsLoadTokens.removeValue(forKey: locationID)
        if accountsRefreshGenerations[locationID] == generation {
            accountsLoadStates[locationID] =
                receipt.error.map(ProjectionLoadState.failed) ?? .loaded
        }
        return receipt
    }

    func retireAccountsRequests(at locationID: ExecutionLocationID) {
        accountsReadinessAuthorityFresh[locationID] = false
        accountsNextUpAuthorityFresh[locationID] = false
        accountsRegistryGenerations[locationID] =
            (accountsRegistryGenerations[locationID] ?? 0) &+ 1
        accountsRegistryLoadTokens.removeValue(forKey: locationID)
        accountsRegistryLoadTasks.removeValue(forKey: locationID)?.cancel()
        accountsRegistryTrailingHydrations.remove(locationID)
        accountsRefreshGenerations[locationID] =
            (accountsRefreshGenerations[locationID] ?? 0) &+ 1
        accountsRefreshTaskTokens.removeValue(forKey: locationID)
        accountsRefreshTasks.removeValue(forKey: locationID)?.cancel()
        accountsLoadTokens.removeValue(forKey: locationID)
        // A connection boundary cannot leave either independent UI lane in an
        // orphaned spinner after its task/token has been retired. Stable loaded
        // or failed states remain until their owner explicitly replaces them.
        if accountsRegistryLoadStates[locationID] == .loading {
            accountsRegistryLoadStates[locationID] = .idle
        }
        if accountsLoadStates[locationID] == .loading {
            accountsLoadStates[locationID] = .idle
        }
    }

    /// The pool `next_up` verdict is a separately expiring slice of the
    /// accounts projection (unified account model: routing facts ride ONLY the
    /// `accountPools` carrier). Invalidating it never fabricates `.none` and
    /// never touches the profile rows' Enabled/identity facts.
    func authoritativeNextUp(for harnessId: String) -> ControlPoolNextUp? {
        guard accountsNextUpAuthorityFresh[activeExecutionLocation] == true else { return nil }
        return activeAccountPools.first { $0.harnessId == harnessId }?.nextUp
    }

}
