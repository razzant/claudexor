import Foundation
import ClaudexorKit

struct HarnessProjectionLease {
    let locationID: ExecutionLocationID
    let ticket: UInt64
    let locationGeneration: Int
    let client: GatewayClient
}

private struct HarnessRefreshRequest {
    let lease: HarnessProjectionLease
    let fresh: Bool
    let markStaleOnFailure: Bool
}

@MainActor
final class HarnessProjectionLane {
    var ticket: UInt64 = 0
    fileprivate var pending: HarnessRefreshRequest?
    fileprivate var inFlight: HarnessRefreshRequest?
    var runnerID: UUID?
    var task: Task<Bool, Never>?
}

// MARK: - Harness readiness refresh (INV-124 split from AppModel.swift)
//
// The harness-list refresh (typed readiness rows included), the exact
// auth-source refresh, and their readiness-text projections. Split out whole
// — zero behavior change; `private` members became fileprivate-equivalent
// module internals only where the extension boundary required it.

extension AppModel {
    private func harnessProjectionLane(at locationID: ExecutionLocationID)
        -> HarnessProjectionLane
    {
        if let lane = harnessProjectionLanes[locationID] { return lane }
        let lane = HarnessProjectionLane()
        harnessProjectionLanes[locationID] = lane
        return lane
    }

    /// Claim the next location-local harness projection before starting I/O.
    /// `requireCurrentClient=false` is only for connectRemote's not-yet-adopted
    /// client; acceptance still requires that exact client to own the location.
    func claimHarnessProjection(
        at locationID: ExecutionLocationID,
        client explicitClient: GatewayClient? = nil,
        requireCurrentClient: Bool = true
    ) -> HarnessProjectionLease? {
        guard let requestClient = explicitClient ?? gateway(for: locationID),
              !requireCurrentClient || isCurrentGateway(requestClient, at: locationID)
        else { return nil }
        let lane = harnessProjectionLane(at: locationID)
        lane.ticket &+= 1
        // A newer harness projection is now admitted, so the Accounts tuple's
        // derived next_up can no longer be presented as current while I/O waits.
        accountsNextUpAuthorityFresh[locationID] = false
        return HarnessProjectionLease(
            locationID: locationID,
            ticket: lane.ticket,
            locationGeneration: executionLocationGeneration(for: locationID),
            client: requestClient)
    }

    func harnessProjectionIsCurrent(_ lease: HarnessProjectionLease) -> Bool {
        harnessProjectionLanes[lease.locationID]?.ticket == lease.ticket
            && executionLocationGeneration(for: lease.locationID) == lease.locationGeneration
            && isCurrentGateway(lease.client, at: lease.locationID)
    }

    /// One accept gate for full Doctor snapshots and point-readiness patches.
    @discardableResult
    func acceptHarnessProjection(
        _ lease: HarnessProjectionLease,
        apply: () -> Void
    ) -> Bool {
        guard harnessProjectionIsCurrent(lease) else { return false }
        apply()
        return true
    }

    @discardableResult
    func acceptHarnessSnapshot(
        _ harnesses: [HarnessStatus],
        git: WorkspaceGitCapability?,
        lease: HarnessProjectionLease
    ) -> Bool {
        acceptHarnessProjection(lease) {
            storeHarnessSnapshot(harnesses, git: git, at: lease.locationID)
        }
    }

    /// A reconnect/disconnect cancels and detaches only this location's lane.
    /// A replacement request can start immediately even if old URL loading is
    /// non-cooperative; runner identity keeps its late cleanup from touching it.
    func retireHarnessProjection(at locationID: ExecutionLocationID) {
        guard let lane = harnessProjectionLanes[locationID] else { return }
        lane.ticket &+= 1
        lane.pending = nil
        lane.inFlight = nil
        lane.runnerID = nil
        let oldTask = lane.task
        lane.task = nil
        oldTask?.cancel()
    }

    private func storeHarnessSnapshot(
        _ harnesses: [HarnessStatus],
        git: WorkspaceGitCapability?,
        at locationID: ExecutionLocationID
    ) {
        let mapped = Self.mapHarnessStatuses(harnesses)
        var exactSources: [HarnessFamily: [AuthSourceKind: HarnessAuthSource]] = [:]
        for info in mapped {
            for source in info.authSources {
                guard let kind = AuthSourceKind(rawValue: source.source) else { continue }
                exactSources[info.family, default: [:]][kind] = source
            }
        }
        if locationID == .local {
            liveHarnesses = mapped
            exactAuthSources = exactSources
            harnessReadinessFresh = true
            gitCapability = git
        } else {
            remoteHarnesses[locationID] = mapped
            remoteExactAuthSources[locationID] = exactSources
            remoteHarnessReadinessFresh[locationID] = true
            if let git { remoteGitCapabilities[locationID] = git }
            else { remoteGitCapabilities.removeValue(forKey: locationID) }
        }
    }

    @discardableResult
    func scheduleHarnessRefresh(
        fresh: Bool = false,
        locationID requestedLocationID: ExecutionLocationID? = nil,
        markStaleOnFailure: Bool = false
    ) -> Task<Bool, Never>? {
        let locationID = requestedLocationID ?? activeExecutionLocation
        guard let lease = claimHarnessProjection(at: locationID) else {
            markHarnessRefreshFailure(at: locationID, stale: markStaleOnFailure)
            return nil
        }
        let lane = harnessProjectionLane(at: locationID)
        // The latest lease owns acceptance, while stronger read/failure
        // requirements already admitted to this coalesced pass stay monotone.
        let inheritedFresh =
            (lane.pending?.fresh ?? false) || (lane.inFlight?.fresh ?? false)
        let inheritedStaleOnFailure =
            (lane.pending?.markStaleOnFailure ?? false)
            || (lane.inFlight?.markStaleOnFailure ?? false)
        lane.pending = HarnessRefreshRequest(
            lease: lease,
            fresh: fresh || inheritedFresh,
            markStaleOnFailure: markStaleOnFailure || inheritedStaleOnFailure)
        if let task = lane.task { return task }

        let runnerID = UUID()
        lane.runnerID = runnerID
        let task = Task { @MainActor [weak self] in
            await self?.runHarnessRefreshLane(at: locationID, runnerID: runnerID) ?? false
        }
        lane.task = task
        return task
    }

    @discardableResult
    func refreshHarnesses(
        fresh: Bool = false,
        locationID requestedLocationID: ExecutionLocationID? = nil,
        markStaleOnFailure: Bool = false
    ) async -> Bool {
        let locationID = requestedLocationID ?? activeExecutionLocation
        guard let task = scheduleHarnessRefresh(
            fresh: fresh,
            locationID: locationID,
            markStaleOnFailure: markStaleOnFailure)
        else { return false }
        return await task.value
    }

    private func runHarnessRefreshLane(
        at locationID: ExecutionLocationID,
        runnerID: UUID
    ) async -> Bool {
        var lastResult = false
        while !Task.isCancelled,
              let lane = harnessProjectionLanes[locationID],
              lane.runnerID == runnerID,
              let request = lane.pending
        {
            lane.pending = nil
            lane.inFlight = request
            lastResult = await performHarnessRefresh(request)
            if let currentLane = harnessProjectionLanes[locationID],
               currentLane.runnerID == runnerID
            {
                currentLane.inFlight = nil
            }
        }
        if let lane = harnessProjectionLanes[locationID], lane.runnerID == runnerID {
            lane.runnerID = nil
            lane.task = nil
        }
        return lastResult
    }

    private func performHarnessRefresh(_ request: HarnessRefreshRequest) async -> Bool {
        guard harnessProjectionIsCurrent(request.lease) else { return false }
        do {
            let response = try await request.lease.client.listHarnessStatus(
                fresh: request.fresh)
            return acceptHarnessSnapshot(
                response.harnesses, git: response.git, lease: request.lease)
        } catch {
            guard harnessProjectionIsCurrent(request.lease) else { return false }
            markHarnessRefreshFailure(
                at: request.lease.locationID, stale: request.markStaleOnFailure)
            return false
        }
    }

    private func markHarnessRefreshFailure(
        at locationID: ExecutionLocationID,
        stale: Bool
    ) {
        // Keep the last server-authored rows unchanged. An explicit Accounts
        // refresh expires client freshness instead of inventing a health verdict.
        if stale {
            if locationID == .local { harnessReadinessFresh = false }
            else { remoteHarnessReadinessFresh[locationID] = false }
        }
        if locationID == .local { gitCapability = nil }
        else { remoteGitCapabilities.removeValue(forKey: locationID) }
    }

    static func mapHarnessStatuses(_ statuses: [HarnessStatus]) -> [HarnessInfo] {
        statuses.map { status in
            let family = HarnessFamily(rawValue: status.id)
            let health = HarnessHealth(rawValue: status.status) ?? .unavailable
            let version =
                status.manifest?["version"]?.stringValue
                ?? status.manifest?["adapter_version"]?.stringValue ?? "unknown"
            let auth = Self.harnessReadinessText(status: status, health: health)
            let attachmentInputs = Self.attachmentInputs(manifest: status.manifest)
            let acceptsBrowser =
                status.manifest?["capabilities"]?["browser_tool"]?.boolValue ?? false
            let readsFiles = status.manifest?["capabilities"]?["read_files"]?.boolValue
            let effortLevels: [String] = {
                // Schema truth: HarnessCapabilities.effort_levels lives under
                // manifest.capabilities.
                guard
                    case .array(let values) =
                        status.manifest?["capabilities"]?["effort_levels"]
                else { return [] }
                return values.compactMap(\.stringValue)
            }()
            let modelEffortLevels: [String: [String]] = {
                guard
                    case .object(let entries) =
                        status.manifest?["capabilities"]?["model_effort_levels"]
                else { return [:] }
                return entries.compactMapValues { entry in
                    guard case .array(let values) = entry["levels"] else {
                        return nil
                    }
                    let levels = values.compactMap(\.stringValue)
                    return levels.isEmpty ? nil : levels
                }
            }()
            return HarnessInfo(
                family: family, health: health, version: version, auth: auth,
                authSources: status.authSources,
                intents: status.enabledIntents,
                routableIntents: status.routableIntents,
                reasons: status.reasons ?? [], readiness: status.readiness,
                attachmentInputs: attachmentInputs,
                acceptsBrowser: acceptsBrowser,
                readsFiles: readsFiles,
                delegation: status.delegation,
                setupLogin: status.setupLogin,
                effortLevels: effortLevels,
                modelEffortLevels: modelEffortLevels)
        }
    }

    @discardableResult
    func refreshAuthReadinessAfterSetupLifecycle(for family: HarnessFamily, job: SetupJob?) async -> Bool {
        guard let request = family.authReadinessRequest(after: job) else { return false }
        let refreshed = await refreshAuthReadiness(for: family, request: request)
        // The card renders daemon-NORMALIZED rows, which only a harness-list
        // refresh rebuilds — else the sheet's own recheck left them stale.
        _ = await refreshHarnesses(fresh: true, markStaleOnFailure: true)
        return refreshed
    }

    /// Refresh the exact credential store an AuthSheet represents. Default login
    /// sheets use the source-targeted probe; profile sheets consume the profile
    /// snapshot's own doctor result and never let default-route failure overwrite it.
    ///
    /// A family with NO default credential store (agy: every account is a named
    /// profile, INV-135 / Л-4) has no source to probe at all. Reporting `false`
    /// there announced the failure of a check that never ran — the sheet then
    /// blamed the engine right after a successful login. The accounts/profiles
    /// projection IS this family's readiness truth, so refresh THAT and report
    /// its real outcome.
    @discardableResult
    func refreshCredentialReadiness(
        for family: HarnessFamily,
        profileId: String?,
        after job: SetupJob?
    ) async -> Bool {
        guard let profileId else {
            guard family.authReadinessRequest(after: job) != nil else {
                return await refreshAccounts() == nil
            }
            let refreshed = await refreshAuthReadinessAfterSetupLifecycle(for: family, job: job)
            // A profile-less job is the BOOTSTRAP login (K.4): its credential
            // lands on the `<harness>-default` REGISTRY row, which the exact
            // source probe and harness refresh above never re-read — so a
            // fresh/cold row stayed invisible ("No accounts yet") until a
            // manual popover Refresh, right after a successful login. Re-read
            // the registry too, through the same mutation-fenced reload the
            // exact-profile (cursor) lane already performs.
            if job != nil, AccountsPresentation.supportsBootstrapLogin(family) {
                await refreshCredentialProfilesAfterMutation()
            }
            return refreshed
        }
        return await refreshExactCredentialProfile(
            harnessID: family.setupHarnessId, profileID: profileId) != nil
    }

    @discardableResult
    func refreshAuthReadiness(for family: HarnessFamily, request: AuthReadinessRefreshRequest) async -> Bool {
        let locationID = activeExecutionLocation
        guard let lease = claimHarnessProjection(at: locationID) else { return false }
        do {
            let response = try await lease.client.refreshAuthReadiness(
                harnessId: family.rawValue, request: request)
            let source = HarnessAuthSource(
                source: response.readiness.source.rawValue,
                availability: response.readiness.availability.rawValue,
                verification: response.readiness.verification.rawValue,
                detail: response.readiness.detail
            )
            return acceptHarnessProjection(lease) {
                if locationID == .local {
                    exactAuthSources[family, default: [:]][response.requestedSource] = source
                } else {
                    remoteExactAuthSources[locationID, default: [:]][family, default: [:]][
                        response.requestedSource] = source
                }
                var rows = locationID == .local
                    ? liveHarnesses
                    : (remoteHarnesses[locationID] ?? [])
                if let index = rows.firstIndex(where: { $0.family == family }) {
                    if let sourceIndex = rows[index].authSources.firstIndex(where: {
                        $0.source == source.source
                    }) {
                        rows[index].authSources[sourceIndex] = source
                    } else {
                        rows[index].authSources.append(source)
                    }
                }
                if locationID == .local { liveHarnesses = rows }
                else { remoteHarnesses[locationID] = rows }
            }
        } catch {
            return false
        }
    }

    func authSource(for family: HarnessFamily, source: AuthSourceKind) -> HarnessAuthSource? {
        let exact = activeExecutionLocation == .local
            ? exactAuthSources[family]?[source]
            : remoteExactAuthSources[activeExecutionLocation]?[family]?[source]
        return exact
            ?? harnessInfo(for: family)?.authSources.first { $0.source == source.rawValue }
    }

    /// One overall sentence — the ROWS own every smoke/source/model detail
    /// (one presentational owner per fact, INV-134; F4 final review #3).
    private static func harnessReadinessText(status: HarnessStatus, health: HarnessHealth) -> String {
        switch health {
        case .ok: return "Ready by doctor."
        case .degraded: return "Not ready: doctor degraded."
        case .unavailable: return "Not ready: unavailable."
        }
    }

}
