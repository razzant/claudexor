import Foundation
import ClaudexorKit

// MARK: - Harness readiness projection
//
// Extracted from `AppModel.swift` (INV-124 readability ratchet): how the
// composer decides whether a harness chip is offered for an intent. Pure move
// — zero behavior change. (W14 later re-bases this on the server-side
// `routableIntents` projection.)

extension AppModel {
    func harnessInfo(for family: HarnessFamily) -> HarnessInfo? {
        harnesses.first { $0.family == family }
    }

    func availability(for family: HarnessFamily, mode: RunMode) -> HarnessAvailability {
        let intent = mode.requiredIntent
        guard let info = harnessInfo(for: family) else {
            return HarnessAvailability(family: family, available: false,
                                       reason: "Harness Doctor has not loaded \(family.label). Reconnect the engine, then recheck.",
                                       intent: intent, info: nil)
        }
        // Engine-level per-harness settings gate routing; the composer must
        // mirror that truth instead of offering a chip the engine will reject.
        if settingsSnapshot?.harnesses?[family.rawValue]?.enabled == false {
            return HarnessAvailability(family: family, available: false,
                                       reason: "\(family.label) is disabled in Settings (Per-Harness Defaults).",
                                       intent: intent, info: info)
        }
        // Server-side routability truth (Р8/W14): the doctor gates
        // routableIntents on the engine, so a degraded/unauth'd harness ships
        // an EMPTY list. The app formats that verdict — it no longer
        // re-derives availability from health + enabled intents.
        guard info.routableIntents.contains(intent) else {
            let reason = info.reasons.first
                ?? (info.health == .ok
                    ? "\(family.label) is not routable for \(intent). Fix auth/install status in Harness Doctor."
                    : info.auth)
            return HarnessAvailability(family: family, available: false,
                                       reason: reason, intent: intent, info: info)
        }
        return HarnessAvailability(family: family, available: true,
                                   reason: "\(family.label) can handle \(intent).",
                                   intent: intent, info: info)
    }

    func availableHarnesses(for mode: RunMode, selected: Set<HarnessFamily>) -> [HarnessFamily] {
        selectableHarnesses
            .filter { selected.contains($0) }
            .filter { availability(for: $0, mode: mode).available }
    }
}
