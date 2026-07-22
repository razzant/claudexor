import ClaudexorKit
import Foundation

// MARK: - Engine settings load/save
//
// Split from AppModel.swift (readability ratchet). POST /v2/settings answers
// with the fresh effective snapshot (GET's shape) — the save answer IS the
// refresh (#20 / D1, no follow-up GET).

extension AppModel {
    func refreshSettings() async {
        guard let client else { return }
        do {
            settingsSnapshot = try await client.settings()
        } catch {
            settingsStatus = "Could not load settings: \(error)"
        }
    }

    func saveSettings(_ patch: SettingsUpdateRequest) async -> Bool {
        guard let client else {
            settingsStatus = "Engine offline: reconnect before saving settings."
            return false
        }
        // The POST answer of an OLDER save carries older daemon truth: two
        // concurrent row saves may deliver responses out of issue order, so
        // only the NEWEST save's snapshot may be applied (INV-002 — the app
        // projects server truth, never regresses it).
        settingsSaveGeneration += 1
        let generation = settingsSaveGeneration
        do {
            let answer = try await client.updateSettings(patch)
            if generation == settingsSaveGeneration { settingsSnapshot = answer }
            settingsStatus = "Saved engine defaults."
            await refreshHarnesses()
            return true
        } catch {
            settingsStatus = "Could not save settings: \(error)"
            return false
        }
    }
}
