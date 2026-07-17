import Foundation
import ClaudexorKit

// MARK: - Harness readiness refresh (INV-124 split from AppModel.swift)
//
// The harness-list refresh (typed readiness rows included), the exact
// auth-source refresh, and their readiness-text projections. Split out whole
// — zero behavior change; `private` members became fileprivate-equivalent
// module internals only where the extension boundary required it.

extension AppModel {
    func refreshHarnesses(fresh: Bool = false) async -> Bool {
        guard let client else { return false }
        do {
            liveHarnesses = try await client.listHarnesses(fresh: fresh).map { status in
                let family = HarnessFamily(rawValue: status.id)
                let health = HarnessHealth(rawValue: status.status) ?? .unavailable
                let version = status.manifest?["version"]?.stringValue ?? status.manifest?["adapter_version"]?.stringValue ?? "unknown"
                let auth = Self.harnessReadinessText(status: status, health: health)
                let checks = status.checks.map { "\($0.id): \($0.status)" }
                let acceptsImages = Self.acceptsImages(manifest: status.manifest)
                let acceptsBrowser = status.manifest?["capabilities"]?["browser_tool"]?.boolValue ?? false
                let effortLevels: [String] = {
                    // Schema truth: HarnessCapabilities.effort_levels lives under
                    // manifest.capabilities (the old capability_profile path was
                    // never populated — the ladder read empty for EVERY harness).
                    guard case .array(let values) = status.manifest?["capabilities"]?["effort_levels"] else { return [] }
                    return values.compactMap(\.stringValue)
                }()
                // The configured-model verdict is a typed `configured_model`
                // readiness row (daemon-normalized) — the ONE owner; no
                // separate string projection here (Ф4 review lane 2 #2).
                return HarnessInfo(family: family, health: health, version: version, auth: auth,
                                   authSources: status.authSources,
                                   intents: status.enabledIntents, routableIntents: status.routableIntents,
                                   reasons: status.reasons ?? [], checks: checks, readiness: status.readiness,
                                   acceptsImages: acceptsImages, acceptsBrowser: acceptsBrowser,
                                   effortLevels: effortLevels)
            }
            return true
        } catch {
            // Keep last-known harness rows.
            return false
        }
    }

    @discardableResult
    func refreshAuthReadinessAfterSetupLifecycle(for family: HarnessFamily, job: SetupJob?) async -> Bool {
        guard let request = family.authReadinessRequest(after: job) else { return false }
        let refreshed = await refreshAuthReadiness(for: family, request: request)
        // The card renders daemon-NORMALIZED rows, which only a harness-list
        // refresh rebuilds — else the sheet's own recheck left them stale.
        _ = await refreshHarnesses(fresh: true)
        return refreshed
    }

    @discardableResult
    func refreshAuthReadiness(for family: HarnessFamily, request: AuthReadinessRefreshRequest) async -> Bool {
        guard let client else { return false }
        do {
            let response = try await client.refreshAuthReadiness(harnessId: family.rawValue, request: request)
            let source = HarnessAuthSource(
                source: response.readiness.source.rawValue,
                availability: response.readiness.availability.rawValue,
                verification: response.readiness.verification.rawValue,
                detail: response.readiness.detail
            )
            exactAuthSources[family, default: [:]][response.requestedSource] = source
            if let index = liveHarnesses.firstIndex(where: { $0.family == family }) {
                if let sourceIndex = liveHarnesses[index].authSources.firstIndex(where: { $0.source == source.source }) {
                    liveHarnesses[index].authSources[sourceIndex] = source
                } else {
                    liveHarnesses[index].authSources.append(source)
                }
            }
            return true
        } catch {
            return false
        }
    }

    func authSource(for family: HarnessFamily, source: AuthSourceKind) -> HarnessAuthSource? {
        exactAuthSources[family]?[source]
            ?? harnessInfo(for: family)?.authSources.first { $0.source == source.rawValue }
    }

    /// One overall sentence — the ROWS own every smoke/source/model detail
    /// (one presentational owner per fact, INV-134; Ф4 final review #3).
    private static func harnessReadinessText(status: HarnessStatus, health: HarnessHealth) -> String {
        switch health {
        case .ok: return "Ready by doctor."
        case .degraded: return "Not ready: doctor degraded."
        case .unavailable: return "Not ready: unavailable."
        }
    }

}
