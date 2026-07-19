import Foundation
import ClaudexorKit

// MARK: - Credential profiles + auto-balance (INV-135)
//
// The account-registry half of AppModel: registered credential profiles with
// doctor readiness, in-app registration/removal, and the auto-balance toggle
// (per-harness profile_policy.limit_action via the settings wire).

extension AppModel {
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
        guard let client else {
            threadStatus = "Engine offline — reconnect to change the account."
            return
        }
        do {
            let updated = try await client.updateThread(
                id: id,
                body: UpdateThreadRequest(
                    primaryHarness: harnessId.map { .some($0) },
                    eligibleHarnesses: profileId == nil ? nil : harnessId.map { [$0] },
                    credentialProfileId: .some(profileId)))
            applyThreadUpdate(updated)
        } catch {
            threadStatus = userMessage(for: error)
        }
    }

    /// Registered credential profiles + doctor readiness (INV-135). Drives the
    /// accounts popover; a failing fetch leaves the last snapshot in place.
    func refreshCredentialProfiles() async {
        guard let client else { return }
        do { credentialProfiles = try await client.credentialProfiles().profiles } catch {
            /* endpoint absent (older daemon) or offline — keep last snapshot */
        }
    }

    /// Register a new credential profile (INV-135). On success the registry is
    /// refreshed and the new entry returned so the accounts popover can offer its
    /// login immediately. On failure the daemon's reason (409 duplicate id / 400
    /// invalid slug or harness) is returned verbatim for inline display.
    func createCredentialProfile(harnessId: String, profileId: String, displayName: String?) async
        -> (entry: CredentialProfileEntry?, error: String?) {
        guard let client else { return (nil, "Engine offline — reconnect to add an account.") }
        do {
            let entry = try await client.createCredentialProfile(
                CreateCredentialProfileRequest(harnessId: harnessId, profileId: profileId, displayName: displayName))
            await refreshCredentialProfiles()
            return (entry, nil)
        } catch {
            return (nil, userMessage(for: error))
        }
    }

    /// Remove a credential profile (INV-135): the daemon deletes the registry
    /// entry plus the profile's own credential material (scoped login dir /
    /// namespaced secret; the default vendor store is untouchable). Returns the
    /// daemon's reason on refusal (409 while a login job is active) and any
    /// cleanup warning verbatim for inline display.
    func deleteCredentialProfile(harnessId: String, profileId: String) async -> String? {
        guard let client else { return "Engine offline — reconnect to remove an account." }
        do {
            let receipt = try await client.deleteCredentialProfile(
                harnessId: harnessId, profileId: profileId)
            if draftCredentialProfileId == profileId {
                draftCredentialProfileId = nil
                if draftPrimaryHarness == harnessId { draftPrimaryHarness = nil }
            }
            await refreshCredentialProfiles()
            await refreshQuota(force: true)
            await refreshThreads()
            if let selectedThreadId { await openThread(selectedThreadId) }
            return receipt.cleanupWarning
        } catch {
            return userMessage(for: error)
        }
    }

    // MARK: Footer profile (M5c) — the active credential identity in the sidebar

    /// The harness + credential profile the NEXT turn of the current thread/draft
    /// will authenticate as, resolved from the wire (thread sticky > draft). The
    /// profile name is looked up in the registered profiles; nil = the engine's
    /// automatic account routing (no pinned profile). Truth from the wire only.
    var activeAccountFooter: (harnessLabel: String, profileName: String?)? {
        guard let harnessId = effectivePrimaryHarness else { return nil }
        let label = HarnessFamily(rawValue: harnessId).label
        let profileId = selectedThreadId == nil
            ? draftCredentialProfileId
            : currentThread?.credentialProfileId
        guard let profileId else { return (label, nil) }
        let name = credentialProfiles.first {
            $0.profile.profileId == profileId && $0.profile.harnessId == harnessId
        }?.profile.displayName
        return (label, name ?? profileId)
    }

    // MARK: Update availability (M5c shell)

    /// Re-read the local update override. Renders a chip only when the shell
    /// actually finds a pending version — no fake states (M7 fills the provider).
    func refreshUpdateAvailability() {
        updateAvailability = updateProvider.current()
    }

    // MARK: Auto-balance

    /// Harnesses that participate in credential-profile auto-balance — the
    /// config_dir_login families the registry covers.
    static let autoBalanceHarnessIds = ["claude", "codex"]

    /// Aggregated auto-balance state across the profile-capable harnesses:
    /// on = every harness rotates, off = none rotate, mixed = they disagree.
    enum AutoBalanceState { case on, off, mixed }

    var autoBalanceState: AutoBalanceState {
        if let pending = autoBalanceOverride { return pending ? .on : .off }
        let actions = Self.autoBalanceHarnessIds.map {
            settingsSnapshot?.harnesses?[$0]?.profileLimitAction ?? "fail"
        }
        if actions.allSatisfy({ $0 == "rotate" }) { return .on }
        if actions.allSatisfy({ $0 != "rotate" }) { return .off }
        return .mixed
    }

    /// Flip auto-balance for BOTH profile-capable harnesses at once (on = rotate,
    /// off = fail), so a mixed state resolves to a single consistent choice.
    func setAutoBalance(_ on: Bool) async {
        // ON sets rotate on both families. OFF only downgrades harnesses that
        // are currently "rotate" — a hand-configured "ask" is not auto-switch,
        // so the toggle must not erase it.
        let patch = Dictionary(uniqueKeysWithValues: Self.autoBalanceHarnessIds.compactMap {
            id -> (String, HarnessSettingsPatch)? in
            let current = settingsSnapshot?.harnesses?[id]?.profileLimitAction ?? "fail"
            if on { return current == "rotate" ? nil : (id, HarnessSettingsPatch(profileLimitAction: "rotate")) }
            return current == "rotate" ? (id, HarnessSettingsPatch(profileLimitAction: "fail")) : nil
        })
        guard !patch.isEmpty else { return }
        autoBalanceOverride = on
        defer { autoBalanceOverride = nil }
        _ = await saveSettings(SettingsUpdateRequest(harnesses: patch))
    }
}
