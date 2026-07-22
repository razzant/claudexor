import ClaudexorKit
import Foundation

// MARK: - Engine settings load/save
//
// Split from AppModel.swift (readability ratchet). POST /v2/settings answers
// with the fresh effective snapshot (GET's shape) — the save answer IS the
// refresh (#20 / D1, no follow-up GET).
//
// ALL settings network operations are SERIALIZED through one chain (X10/X14,
// the sol confirmation blocker): only one save/refresh is in flight at a time
// and answers apply in issue order, which the daemon's config lock makes equal
// to commit order — so the projection can never regress to older daemon truth
// (INV-002), and a superseded save can never overwrite a newer failure status.

extension AppModel {
    /// Append an operation to the settings chain: it starts only after every
    /// previously enqueued settings operation finished. The chain tail is
    /// swapped synchronously (no await between read and write), so enqueue
    /// order IS issue order.
    private func enqueueSettingsOperation<T: Sendable>(
        _ op: @escaping @MainActor () async -> T
    ) async -> T {
        let previous = settingsChain
        let task = Task { @MainActor in
            await previous?.value
            return await op()
        }
        settingsChain = Task { _ = await task.value }
        return await task.value
    }

    func refreshSettings() async {
        let epoch = settingsEpoch
        await enqueueSettingsOperation { [weak self] in
            guard let self, self.settingsEpoch == epoch, let client = self.client else { return }
            do {
                let answer = try await client.settings()
                // Re-check AFTER the await (X24): enterHardOffline may have
                // reset the projection while the request was in flight; a late
                // answer must not repopulate the cleared state.
                guard self.settingsEpoch == epoch else { return }
                self.settingsSnapshot = answer
            } catch {
                guard self.settingsEpoch == epoch else { return }
                self.settingsStatus = "Could not load settings: \(error)"
            }
        }
    }

    func saveSettings(_ patch: SettingsUpdateRequest) async -> Bool {
        let epoch = settingsEpoch
        return await enqueueSettingsOperation { [weak self] in
            guard let self, self.settingsEpoch == epoch else { return false }
            guard let client = self.client else {
                self.settingsStatus = "Engine offline: reconnect before saving settings."
                return false
            }
            do {
                let answer = try await client.updateSettings(patch)
                // Re-check AFTER the await (X24): a response landing past an
                // enterHardOffline reset must not write into the cleared state.
                guard self.settingsEpoch == epoch else { return false }
                self.settingsSnapshot = answer
                self.settingsStatus = "Saved engine defaults."
                await self.refreshHarnesses()
                return true
            } catch {
                guard self.settingsEpoch == epoch else { return false }
                self.settingsStatus = "Could not save settings: \(error)"
                return false
            }
        }
    }
}
