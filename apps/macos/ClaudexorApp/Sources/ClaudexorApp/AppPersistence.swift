import ClaudexorKit
import Foundation

/// The user's state on this Mac that one AppModel session restores at launch
/// and keeps current: remote connection labels, the offline remote thread
/// list, the app's own preferences and unresolved account-reset requests,
/// plus the `CLAUDEXOR_DEBUG_APPEARANCE` / `CLAUDEXOR_PROJECT_ROOT` launch
/// fallbacks and the `~/.ssh/config` host scan.
///
/// Only the app entry composes `.user`. Every other AppModel (tests, fixtures)
/// gets `.memoryOnly`: it starts empty and keeps every change in memory, so it
/// can never read or overwrite a developer's real state by accident. A test
/// that exercises persistence passes its own temporary stores.
@MainActor
struct AppPersistence {
    /// Resolved again for every load and save, as the app always did: a
    /// failed Application Support lookup costs that one write, never the
    /// rest of the session.
    var remoteConnections: (() throws -> RemoteConnectionStore)?
    var remoteThreadCache: (() throws -> RemoteThreadCacheStore)?
    var preferences: AppPreferences?
    var accountResetRecovery: AccountResetRecoveryPreferences?
    var environment: [String: String] = [:]
    var scansSSHConfig = false

    static var memoryOnly: Self { Self() }

    static var user: Self {
        Self(
            remoteConnections: RemoteConnectionStore.applicationSupport,
            remoteThreadCache: RemoteThreadCacheStore.applicationSupport,
            preferences: .standard,
            accountResetRecovery: .standard,
            environment: ProcessInfo.processInfo.environment,
            scansSSHConfig: true)
    }
}

/// The app's own choices: appearance, the working project and its recents.
/// `.standard` is the user defaults domain the app has always used.
@MainActor
struct AppPreferences {
    let load: (String) -> Any?
    let save: (Any?, String) -> Void

    static var standard: Self {
        Self(load: { UserDefaults.standard.object(forKey: $0) },
             save: { UserDefaults.standard.set($0, forKey: $1) })
    }
}
