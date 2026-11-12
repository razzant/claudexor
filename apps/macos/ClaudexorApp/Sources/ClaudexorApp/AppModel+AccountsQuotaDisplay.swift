import ClaudexorKit
import Foundation

/// Freshness of quota as DISPLAY data. This is deliberately not a routing
/// verdict: stale values stay useful to a person while `next_up` remains gated
/// by the separate atomic-snapshot authority.
enum AccountsQuotaDisplayState: Equatable, Sendable {
    case idle
    case loading
    case current(observedAt: String?)
    case stale(reason: String, observedAt: String?)
    case failedWithoutData(reason: String)

    var observedAt: String? {
        switch self {
        case .current(let observedAt), .stale(_, let observedAt): return observedAt
        case .idle, .loading, .failedWithoutData: return nil
        }
    }
}

struct AccountsQuotaSubscription: Hashable, Sendable {
    let id: UUID
    let locationID: ExecutionLocationID
}

extension AppModel {
    static let quotaProjectionMarker = "quota.projection.updated"
    static let accountsQuotaMarkerDedupeLimit = 32

    var activeAccountsQuotaDisplayState: AccountsQuotaDisplayState {
        if let state = accountsQuotaDisplayStates[activeExecutionLocation] { return state }
        if let response = quotaResponse(at: activeExecutionLocation) {
            return .current(observedAt: Self.quotaObservedAt(response))
        }
        return .idle
    }

    func beginAccountsQuotaSubscription(
        locationID requestedLocationID: ExecutionLocationID? = nil
    ) -> AccountsQuotaSubscription {
        let locationID = requestedLocationID ?? activeExecutionLocation
        let subscription = AccountsQuotaSubscription(id: UUID(), locationID: locationID)
        let wasEmpty = accountsQuotaSubscribers[locationID, default: []].isEmpty
        accountsQuotaSubscribers[locationID, default: []].insert(subscription.id)
        if wasEmpty { scheduleAccountsQuotaDisplayHydration(at: locationID) }
        return subscription
    }

    func endAccountsQuotaSubscription(_ subscription: AccountsQuotaSubscription) {
        accountsQuotaSubscribers[subscription.locationID]?.remove(subscription.id)
        if accountsQuotaSubscribers[subscription.locationID]?.isEmpty == true {
            accountsQuotaSubscribers.removeValue(forKey: subscription.locationID)
            // A trigger that arrived while the lead request was running must not
            // queue work after the last consumer left.
            accountsQuotaDisplayTrailing.remove(subscription.locationID)
        }
    }

    func hasAccountsQuotaSubscribers(at locationID: ExecutionLocationID) -> Bool {
        !(accountsQuotaSubscribers[locationID]?.isEmpty ?? true)
    }

    /// The general journal stream calls this before any run/thread guards. With
    /// no live Accounts/Quota consumer the marker is dropped, never queued.
    func noteQuotaProjectionMarker(
        at locationID: ExecutionLocationID,
        invalidateNextUp: Bool,
        cursor: String? = nil
    ) {
        if invalidateNextUp { accountsNextUpAuthorityFresh[locationID] = false }
        guard invalidateNextUp || hasAccountsQuotaSubscribers(at: locationID) else { return }
        if let cursor, !rememberAccountsQuotaDisplayMarker(cursor, at: locationID) {
            return
        }
        markAccountsQuotaDisplayStale(
            at: locationID, reason: "New quota data is available; updating…")
        guard hasAccountsQuotaSubscribers(at: locationID) else { return }
        scheduleAccountsQuotaDisplayHydration(at: locationID)
    }

    /// Remember a marker without changing display/routing state. A successful
    /// atomic snapshot seeds its own cursor here so the general stream cannot
    /// immediately stale that just-accepted quota with the snapshot's marker.
    @discardableResult
    func rememberAccountsQuotaDisplayMarker(
        _ cursor: String,
        at locationID: ExecutionLocationID
    ) -> Bool {
        var recent = accountsQuotaDisplayMarkerCursors[locationID] ?? []
        guard !recent.contains(cursor) else { return false }
        recent.append(cursor)
        if recent.count > Self.accountsQuotaMarkerDedupeLimit {
            recent.removeFirst(recent.count - Self.accountsQuotaMarkerDedupeLimit)
        }
        accountsQuotaDisplayMarkerCursors[locationID] = recent
        return true
    }

    /// Losing a stream means a later marker may have been missed. It never
    /// starts a poll loop; the dedicated atomic observer alone may retire
    /// `next_up`, while either stream can make visible display data stale.
    func noteAccountsQuotaStreamFailure(
        at locationID: ExecutionLocationID,
        reason: String,
        invalidateNextUp: Bool
    ) {
        if invalidateNextUp {
            accountsNextUpAuthorityFresh[locationID] = false
        } else {
            guard hasAccountsQuotaSubscribers(at: locationID) else { return }
        }
        markAccountsQuotaDisplayStale(at: locationID, reason: reason)
    }

    func scheduleAccountsQuotaDisplayHydration(at locationID: ExecutionLocationID) {
        guard hasAccountsQuotaSubscribers(at: locationID) else { return }
        if accountsQuotaDisplayTasks[locationID] != nil {
            accountsQuotaDisplayTrailing.insert(locationID)
            return
        }
        let token = UUID()
        accountsQuotaDisplayTaskTokens[locationID] = token
        let task: Task<Void, Never> = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runAccountsQuotaDisplayHydration(at: locationID, token: token)
        }
        accountsQuotaDisplayTasks[locationID] = task
    }

    private func runAccountsQuotaDisplayHydration(
        at locationID: ExecutionLocationID,
        token: UUID
    ) async {
        for pass in 0...1 {
            accountsQuotaDisplayTrailing.remove(locationID)
            guard hasAccountsQuotaSubscribers(at: locationID),
                  accountsQuotaDisplayTaskTokens[locationID] == token
            else { break }
            await performAccountsQuotaDisplayHydration(at: locationID, token: token)
            guard accountsQuotaDisplayTaskTokens[locationID] == token else { return }
            if pass == 1 || !accountsQuotaDisplayTrailing.contains(locationID) { break }
        }
        guard accountsQuotaDisplayTaskTokens[locationID] == token else { return }
        accountsQuotaDisplayTrailing.remove(locationID)
        accountsQuotaDisplayTaskTokens.removeValue(forKey: locationID)
        accountsQuotaDisplayTasks.removeValue(forKey: locationID)
    }

    private func performAccountsQuotaDisplayHydration(
        at locationID: ExecutionLocationID,
        token: UUID
    ) async {
        guard let requestClient = gateway(for: locationID) else {
            markAccountsQuotaDisplayFailure(
                at: locationID, reason: "Engine offline — reconnect to load quota.")
            return
        }
        let generation = (accountsQuotaDisplayGenerations[locationID] ?? 0) &+ 1
        accountsQuotaDisplayGenerations[locationID] = generation
        if quotaResponse(at: locationID) == nil {
            accountsQuotaDisplayStates[locationID] = .loading
        }
        do {
            let capabilities = await loadAccountResourceCapabilities(client: requestClient, at: locationID)
            let response = try await requestClient.quota(
                resources: capabilities?.read == true, apiKeys: capabilities?.apiKeys == true)
            guard accountsQuotaDisplayTaskTokens[locationID] == token,
                  accountsQuotaDisplayGenerations[locationID] == generation,
                  isCurrentGateway(requestClient, at: locationID)
            else { return }
            storeAccountsQuotaSnapshot(response, at: locationID)
        } catch {
            guard accountsQuotaDisplayTaskTokens[locationID] == token,
                  accountsQuotaDisplayGenerations[locationID] == generation,
                  isCurrentGateway(requestClient, at: locationID)
            else { return }
            markAccountsQuotaDisplayFailure(at: locationID, reason: userMessage(for: error))
        }
    }

    func storeAccountsQuotaSnapshot(
        _ response: ControlQuotaResponse,
        at locationID: ExecutionLocationID
    ) {
        accountsQuotaDisplayGenerations[locationID] =
            (accountsQuotaDisplayGenerations[locationID] ?? 0) &+ 1
        // A legacy read (no resources) keeps the shown rows and their key bindings.
        let previous = quotaResponse(at: locationID)
        let response = response.retainingResources(of: previous)
        for target in response.resourceBindingChanges(from: previous) {
            accountResourceBindingChanges[locationID, default: [:]][target, default: 0] &+= 1
        }
        if locationID == .local { quotaResponse = response }
        else { remoteQuotaResponses[locationID] = response }
        // A refresh that skipped vendors for an active rate-limit cooldown is
        // NOT uniformly current: those vendors ride last-known data, so the
        // display says so instead of stamping the request-time refreshed_at
        // over them (honest states — unknown ≠ fresh).
        let refreshSkipped = response.refreshSkipped ?? []
        if refreshSkipped.isEmpty {
            accountsQuotaDisplayStates[locationID] = .current(
                observedAt: Self.quotaObservedAt(response))
        } else {
            let vendors = refreshSkipped.map { row in row.subject?.subjectId.map { "\(row.vendor)/\($0)" } ?? row.vendor }.joined(separator: ", ")
            accountsQuotaDisplayStates[locationID] = .stale(
                reason:
                    "Rate-limit cooldown: \(vendors) served from last-known data (not re-fetched).",
                observedAt: Self.quotaObservedAt(response))
        }
        quotaStatus = nil
    }

    /// Commit an older composite request's display slice only while no newer
    /// display owner has been admitted. Other slices from that composite
    /// response have independent fences and may still commit.
    func storeAccountsQuotaSnapshot(
        _ response: ControlQuotaResponse,
        at locationID: ExecutionLocationID,
        ifDisplayGenerationIs expectedGeneration: UInt64
    ) {
        guard (accountsQuotaDisplayGenerations[locationID] ?? 0) == expectedGeneration
        else { return }
        storeAccountsQuotaSnapshot(response, at: locationID)
    }

    func markAccountsQuotaDisplayStale(
        at locationID: ExecutionLocationID,
        reason: String
    ) {
        guard let response = quotaResponse(at: locationID) else {
            accountsQuotaDisplayStates[locationID] = .failedWithoutData(reason: reason)
            return
        }
        let observedAt = accountsQuotaDisplayStates[locationID]?.observedAt
            ?? Self.quotaObservedAt(response)
        accountsQuotaDisplayStates[locationID] = .stale(
            reason: reason, observedAt: observedAt)
    }

    func markAccountsQuotaDisplayFailure(
        at locationID: ExecutionLocationID,
        reason: String
    ) {
        markAccountsQuotaDisplayStale(at: locationID, reason: reason)
    }

    /// Backward-compatible call site name: invalidation retains display values
    /// and retires only the routing authority derived from the old quota epoch.
    func expireAccountsQuotaProjection(at locationID: ExecutionLocationID) {
        accountsNextUpAuthorityFresh[locationID] = false
        markAccountsQuotaDisplayStale(
            at: locationID, reason: "Quota changed; refresh is pending.")
    }

    func retireAccountsQuotaDisplayRequest(
        at locationID: ExecutionLocationID,
        discardProjection: Bool
    ) {
        accountsQuotaDisplayTaskTokens.removeValue(forKey: locationID)
        accountsQuotaDisplayTasks.removeValue(forKey: locationID)?.cancel()
        accountsQuotaDisplayTrailing.remove(locationID)
        accountsQuotaDisplayGenerations[locationID] =
            (accountsQuotaDisplayGenerations[locationID] ?? 0) &+ 1
        accountsQuotaDisplayMarkerCursors.removeValue(forKey: locationID)
        if discardProjection {
            if locationID == .local { quotaResponse = nil }
            else { remoteQuotaResponses.removeValue(forKey: locationID) }
            accountsQuotaDisplayStates.removeValue(forKey: locationID)
        } else if quotaResponse(at: locationID) != nil {
            markAccountsQuotaDisplayStale(
                at: locationID,
                reason: "Engine connection changed; showing last-known data.")
        }
    }

    func quotaResponse(at locationID: ExecutionLocationID) -> ControlQuotaResponse? {
        locationID == .local ? quotaResponse : remoteQuotaResponses[locationID]
    }

    static func quotaObservedAt(_ response: ControlQuotaResponse) -> String? {
        response.refreshedAt
            ?? response.snapshots.map(\.observedAt).max()
            ?? response.absences.map(\.observedAt).max()
    }
}
