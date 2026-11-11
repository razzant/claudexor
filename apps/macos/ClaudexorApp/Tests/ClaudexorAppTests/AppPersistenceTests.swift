import ClaudexorKit
import Darwin
import Foundation
import Testing
@testable import ClaudexorApp

/// Where an AppModel's state persists (#379). Stores live in disposable
/// directories and preferences in closures. The one test that touches the
/// default Application Support and `~/.ssh/config` locations re-executes
/// itself in a fresh HOME/CFFIXED_USER_HOME and proves where each resolves
/// before it writes anything there. It reads the real user defaults but
/// records their writes: no test writes the user defaults of the Mac it
/// runs on.
@MainActor @Suite struct AppPersistenceTests {
    @Test func injectedStoresSaveEveryRemoteWriterAndRestoreItOffline() async throws {
        let stores = TemporaryRemoteStores("cx-persist")
        defer { stores.remove() }
        let alpha = RemoteConnection(sshAlias: "alpha", status: .connected, savedProjects: ["/alpha"])
        let beta = RemoteConnection(sshAlias: "beta")
        try stores.connections.save([alpha, beta])
        try stores.threadCache.save([
            RemoteThreadCacheEntry(
                locationID: alpha.locationID, thread: try persistedThread("alpha-old"), syncedAt: .now),
            RemoteThreadCacheEntry(
                locationID: beta.locationID, thread: try persistedThread("beta-kept"), syncedAt: .now),
        ])

        let model = AppModel(requestNotificationAuthorization: false, persistence: stores.persistence)
        #expect(model.remoteConnections.map(\.id) == [alpha.id, beta.id])
        #expect(model.remoteConnections.map(\.status) == [RemoteConnectionState.offline, .offline])
        #expect(model.remoteThreadCache.map(\.thread.id) == ["alpha-old", "beta-kept"])
        // Restoring does not rewrite connections: the file still holds the live status.
        #expect(try stores.connections.load().map(\.status) == [RemoteConnectionState.connected, .offline])

        // Each writer is checked on its own; a later save would mask a missed one.
        model.setRemoteNickname(alpha.id, nickname: "  Alpha box ")
        #expect(try stores.connections.load().map(\.nickname) == [Optional("Alpha box"), nil])
        model.setRemoteEnabled(beta.id, enabled: false)
        #expect(try stores.connections.load().map(\.enabled) == [true, false])
        model.selectRemoteProject(connectionID: alpha.id, path: "/alpha/next")
        #expect(try stores.connections.load().first?.savedProjects == ["/alpha/next", "/alpha"])

        model.remoteClients[alpha.locationID] = persistenceEngineClient(token: "alpha")
        #expect(await model.refreshRemoteThreads(alpha.locationID))
        #expect(try cachedThreadIDs(stores) == ["beta-kept", "alpha-listed"])
        model.applyThreadUpdate(try persistedThread("alpha-listed", title: "Renamed"), at: alpha.locationID)
        #expect(try stores.threadCache.load().last?.thread.title == "Renamed")
        // selectRemoteProject made alpha's folder the draft's target.
        #expect(await model.newThread(title: nil, shouldSelectCreatedThread: { _ in false }) == "alpha-created")
        #expect(try cachedThreadIDs(stores) == ["beta-kept", "alpha-listed", "alpha-created"])

        // A second model on the same files is the next launch.
        let relaunched = AppModel(requestNotificationAuthorization: false, persistence: stores.persistence)
        #expect(relaunched.remoteConnections.map(\.nickname) == [Optional("Alpha box"), nil])
        #expect(relaunched.remoteConnections.map(\.enabled) == [true, false])
        #expect(relaunched.remoteConnections.map(\.status) == [RemoteConnectionState.offline, .offline])
        #expect(relaunched.remoteThreadCache.map(\.thread.id) == ["beta-kept", "alpha-listed", "alpha-created"])

        // Removal forgets the connection and only its own cached rows.
        await relaunched.removeRemoteConnection(alpha.id)
        #expect(try stores.connections.load().map(\.id) == [beta.id])
        #expect(try cachedThreadIDs(stores) == ["beta-kept"])
    }

    @Test func aFailedStoreLookupAtLaunchDoesNotStopLaterSaves() throws {
        let stores = TemporaryRemoteStores("cx-persist-retry")
        defer { stores.remove() }
        let connections = stores.connections
        var lookups = 0
        let model = AppModel(
            requestNotificationAuthorization: false,
            persistence: AppPersistence(remoteConnections: {
                lookups += 1
                // The launch lookup fails, as an unavailable Application Support would.
                if lookups == 1 { throw CocoaError(.fileNoSuchFile) }
                return connections
            }))
        #expect(lookups == 1)
        #expect(model.remoteConnections.isEmpty)

        let host = RemoteConnection(sshAlias: "retry-host")
        model.remoteConnections = [host]
        model.setRemoteNickname(host.id, nickname: "saved")
        #expect(lookups == 2)
        #expect(try connections.load().map(\.nickname) == ["saved"])
    }

    @Test func preferenceWritersAndResetRecoveryUseOnlyTheComposedPreferences() async throws {
        let saved = PreferenceRecorder()
        saved.values = ["claudexor.appearance": "dark", "claudexor.recentProjects": ["/saved/one"]]
        var launch = saved.persistence
        launch.environment = ["CLAUDEXOR_DEBUG_APPEARANCE": "light", "CLAUDEXOR_PROJECT_ROOT": "/env/project"]
        let model = AppModel(requestNotificationAuthorization: false, persistence: launch)
        #expect(model.appearance == .light)
        #expect(model.projectRoot == "/env/project")
        #expect(model.recentProjects == ["/saved/one"])
        // Restoring saves what it applied, the launch switches included...
        #expect(saved.writes == [
            "claudexor.appearance", "claudexor.appearance", "claudexor.projectRoot", "claudexor.recentProjects",
        ])
        #expect(saved.values["claudexor.appearance"] as? String == "light")
        #expect(saved.values["claudexor.projectRoot"] as? String == "/env/project")
        #expect(saved.values["claudexor.recentProjects"] as? [String] == ["/saved/one"])
        // ...so a later launch without them keeps them.
        let restarted = AppModel(requestNotificationAuthorization: false, persistence: saved.persistence)
        #expect(restarted.appearance == .light)
        #expect(restarted.projectRoot == "/env/project")
        #expect(restarted.recentProjects == ["/saved/one"])
        saved.writes.removeAll()

        model.appearance = .system
        model.selectProject("/picked/two")
        model.clearProject()
        #expect(saved.writes == [
            "claudexor.appearance", "claudexor.projectRoot", "claudexor.recentProjects", "claudexor.projectRoot",
        ])
        #expect(saved.values["claudexor.appearance"] as? String == "system")
        // "No project" is a saved choice, so the next launch does not restore the old one.
        #expect(saved.values["claudexor.projectRoot"] as? String == "")
        #expect(saved.values["claudexor.recentProjects"] as? [String] == ["/picked/two", "/saved/one"])

        // An unresolved reset is saved before its first request could leave.
        await model.accountResourceActions.startReset(
            AccountResourcesFixtures.request, label: "Granted reset", using: unreachableResetConnection())
        let reset = try #require(
            model.accountResourceActions.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        #expect(saved.resetRecovery != nil)

        // The next launch restores all of it from the saved values alone.
        let relaunched = AppModel(requestNotificationAuthorization: false, persistence: saved.persistence)
        #expect(relaunched.appearance == .system)
        #expect(relaunched.projectRoot.isEmpty)
        #expect(relaunched.recentProjects == ["/picked/two", "/saved/one"])
        #expect(relaunched.accountResourceActions.attempts(
            for: AccountResourcesFixtures.target, at: .local).map(\.id) == [reset.id])
    }

    @Test func distinctStoresStaySeparateAndMemoryOnlyModelsShareNothing() throws {
        let first = TemporaryRemoteStores("cx-persist-a")
        let second = TemporaryRemoteStores("cx-persist-b")
        defer { first.remove(); second.remove() }
        let hostA = RemoteConnection(sshAlias: "only-a")
        let hostB = RemoteConnection(sshAlias: "only-b")
        try first.connections.save([hostA])
        try second.connections.save([hostB])
        let modelA = AppModel(requestNotificationAuthorization: false, persistence: first.persistence)
        let modelB = AppModel(requestNotificationAuthorization: false, persistence: second.persistence)
        #expect(modelA.remoteConnections.map(\.id) == [hostA.id])
        #expect(modelB.remoteConnections.map(\.id) == [hostB.id])

        // Interleaved writes land only in each model's own files.
        modelA.setRemoteNickname(hostA.id, nickname: "A")
        modelB.setRemoteNickname(hostB.id, nickname: "B")
        modelB.applyThreadUpdate(try persistedThread("thread-b"), at: hostB.locationID)
        modelA.applyThreadUpdate(try persistedThread("thread-a"), at: hostA.locationID)
        #expect(try first.connections.load().map(\.nickname) == ["A"])
        #expect(try second.connections.load().map(\.nickname) == ["B"])
        #expect(try first.threadCache.load().map(\.thread.id) == ["thread-a"])
        #expect(try second.threadCache.load().map(\.thread.id) == ["thread-b"])

        // Without stores, nothing outlives the model that made it.
        let memory = AppPersistence.memoryOnly
        let reachesNothing = memory.remoteConnections == nil && memory.remoteThreadCache == nil
            && memory.preferences == nil && memory.accountResetRecovery == nil
            && memory.environment.isEmpty && !memory.scansSSHConfig
        #expect(reachesNothing)
        let scratch = AppModel(requestNotificationAuthorization: false)
        scratch.remoteConnections = [hostA]
        scratch.setRemoteNickname(hostA.id, nickname: "scratch")
        scratch.applyThreadUpdate(try persistedThread("scratch-thread"), at: hostA.locationID)
        scratch.appearance = .light
        scratch.selectProject("/scratch/project")
        let next = AppModel(requestNotificationAuthorization: false)
        #expect(next.remoteConnections.isEmpty && next.remoteThreadCache.isEmpty)
        #expect(next.appearance == .dark && next.projectRoot.isEmpty && next.recentProjects.isEmpty)
        #expect(try first.connections.load().map(\.nickname) == ["A"])
    }

    /// The real default locations, inside a fresh home. An unchanged file
    /// proves no write; a model that stays empty beside loadable decoys proves
    /// no read; the app's own composition then loads and saves the same files.
    @Test func defaultModelLeavesTheUsersStateAloneWhileTheAppCompositionPersists() async throws {
        try await isolatedRuntimeConsumer(
            "AppPersistenceTests/defaultModelLeavesTheUsersStateAloneWhileTheAppCompositionPersists"
        ) {
            let home = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["CFFIXED_USER_HOME"]))
            let sshDirectory = home.appendingPathComponent(".ssh", isDirectory: true)
            try FileManager.default.createDirectory(
                at: sshDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            // The production expressions, resolved before any write.
            let connectionsStore = try RemoteConnectionStore.applicationSupport()
            let threadCacheStore = try RemoteThreadCacheStore.applicationSupport()
            let sshConfig = URL(fileURLWithPath: NSString(string: "~/.ssh/config").expandingTildeInPath)
            let defaultDirectory = connectionsStore.fileURL.deletingLastPathComponent()
            let realHome = try #require(realPath(home))
            let realSupport = try #require(realPath(defaultDirectory.deletingLastPathComponent()))
            try #require(realSupport.hasPrefix(realHome + "/"),
                         "Application Support must resolve inside the fresh home")
            try #require(threadCacheStore.fileURL.deletingLastPathComponent() == defaultDirectory)
            let realSSH = try #require(realPath(sshDirectory))
            try #require(realPath(sshConfig.deletingLastPathComponent()) == realSSH,
                         "~/.ssh/config must resolve inside the fresh home")

            // Loadable decoys at every default location.
            let decoyHost = RemoteConnection(sshAlias: "decoy-default-host", status: .connected)
            try connectionsStore.save([decoyHost])
            try threadCacheStore.save([RemoteThreadCacheEntry(
                locationID: decoyHost.locationID, thread: try persistedThread("decoy-default-thread"),
                syncedAt: .now)])
            try Data("Host decoy-ssh-host\n    HostName 192.0.2.10\n".utf8)
                .write(to: sshConfig, options: .withoutOverwriting)
            let decoyReset = try JSONEncoder().encode([AccountResetRecoveryPreferences.Entry(
                key: "decoy-reset", body: AccountResourcesFixtures.request, location: .local,
                label: "Decoy reset")])
            let decoyPreferences: [String: Any] = [
                "claudexor.appearance": "light",
                "claudexor.projectRoot": "/decoy/default-project",
                "claudexor.recentProjects": ["/decoy/default-project"],
                "claudexor.accounts.unresolvedResets": decoyReset,
            ]
            // The volatile argument domain outranks saved values and never
            // reaches disk; the production readers must see it.
            var arguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
            arguments.merge(decoyPreferences) { _, decoy in decoy }
            UserDefaults.standard.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain)
            #expect(AppPreferences.standard.load("claudexor.projectRoot") as? String == "/decoy/default-project")
            #expect(AccountResetRecoveryPreferences.standard.load() == decoyReset)
            let preferenceKeys = Array(decoyPreferences.keys)
            let preferencesBefore = savedStandardPreferences(preferenceKeys)
            print("Saved claudexor preferences before the models: \(preferencesBefore.keys.sorted())")
            let filesBefore = try fileBytes(in: defaultDirectory)
            let sshBefore = try Data(contentsOf: sshConfig)

            // A default model reads none of it...
            let inert = AppModel(requestNotificationAuthorization: false)
            #expect(inert.remoteConnections.isEmpty && inert.remoteThreadCache.isEmpty)
            #expect(inert.sshHostScan == .configMissing)
            #expect(inert.appearance == .dark && inert.projectRoot.isEmpty && inert.recentProjects.isEmpty)
            #expect(inert.accountResourceActions.attempts(for: AccountResourcesFixtures.target, at: .local).isEmpty)
            // ...and every writer it runs stays in memory.
            let inertHost = RemoteConnection(sshAlias: "inert-host")
            inert.remoteConnections = [inertHost]
            try await exerciseRemoteWriters(inert, on: inertHost, token: "inert")
            #expect(inert.remoteThreadCache.map(\.thread.id) == ["inert-listed", "inert-created"])
            inert.appearance = .system
            inert.selectProject("/inert/project")
            inert.clearProject()
            await inert.accountResourceActions.startReset(
                AccountResourcesFixtures.request, label: "Inert reset", using: unreachableResetConnection())
            #expect(inert.accountResourceActions.attempts(for: AccountResourcesFixtures.target, at: .local).count == 1)
            await inert.removeRemoteConnection(inertHost.id)
            #expect(try fileBytes(in: defaultDirectory) == filesBefore)
            #expect(try Data(contentsOf: sshConfig) == sshBefore)
            #expect(savedStandardPreferences(preferenceKeys) == preferencesBefore)

            // The app's composition reads every decoy. Its restore saves the
            // applied preferences back, so only that writer is replaced, by a
            // recorder: the real user defaults domain is never written...
            let appPreferences = PreferenceRecorder()
            var composition = AppPersistence.user
            composition.preferences = appPreferences.preferences(reading: AppPreferences.standard.load)
            let app = AppModel(requestNotificationAuthorization: false, persistence: composition)
            #expect(app.remoteConnections.map(\.id) == [decoyHost.id])
            #expect(app.remoteConnections.map(\.status) == [RemoteConnectionState.offline])
            #expect(app.remoteThreadCache.map(\.thread.id) == ["decoy-default-thread"])
            #expect(app.sshHostScan.hosts.map(\.alias) == ["decoy-ssh-host"])
            #expect(app.appearance == .light)
            #expect(app.projectRoot == "/decoy/default-project")
            #expect(app.recentProjects == ["/decoy/default-project"])
            #expect(app.accountResourceActions.attempts(
                for: AccountResourcesFixtures.target, at: .local).map(\.id) == ["decoy-reset"])
            #expect(appPreferences.writes == [
                "claudexor.appearance", "claudexor.projectRoot", "claudexor.recentProjects",
            ])
            #expect(appPreferences.values["claudexor.appearance"] as? String == "light")
            #expect(appPreferences.values["claudexor.projectRoot"] as? String == "/decoy/default-project")
            #expect(appPreferences.values["claudexor.recentProjects"] as? [String] == ["/decoy/default-project"])
            #expect(try fileBytes(in: defaultDirectory) == filesBefore)
            #expect(savedStandardPreferences(preferenceKeys) == preferencesBefore)
            // ...and its remote writers save where the next launch finds them.
            try await exerciseRemoteWriters(app, on: decoyHost, token: "app")
            let relaunched = AppModel(requestNotificationAuthorization: false, persistence: composition)
            #expect(relaunched.remoteConnections.map(\.nickname) == ["app nickname"])
            #expect(relaunched.remoteConnections.map(\.enabled) == [false])
            #expect(relaunched.remoteConnections.first?.savedProjects == ["/app/project"])
            #expect(relaunched.remoteThreadCache.map(\.thread.id) == ["app-listed", "app-created"])
            #expect(relaunched.remoteThreadCache.first?.thread.title == "app renamed")
            await relaunched.removeRemoteConnection(decoyHost.id)
            #expect(try connectionsStore.load().isEmpty)
            #expect(try threadCacheStore.load().isEmpty)
            #expect(savedStandardPreferences(preferenceKeys) == preferencesBefore)
        }
    }
}

/// The app's Kit stores, pointed at one disposable directory.
private struct TemporaryRemoteStores {
    let directory: URL
    let connections: RemoteConnectionStore
    let threadCache: RemoteThreadCacheStore

    init(_ label: String) {
        directory = runtimeTestTemporaryDirectory
            .appendingPathComponent("\(label)-\(UUID().uuidString.prefix(8))", isDirectory: true)
        connections = RemoteConnectionStore(fileURL: directory.appendingPathComponent("connections.json"))
        threadCache = RemoteThreadCacheStore(fileURL: directory.appendingPathComponent("remote-threads.json"))
    }

    @MainActor var persistence: AppPersistence {
        let connections = self.connections
        let threadCache = self.threadCache
        return AppPersistence(remoteConnections: { connections }, remoteThreadCache: { threadCache })
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }
}

/// An in-memory user defaults domain that remembers which keys were written.
@MainActor
private final class PreferenceRecorder {
    var values: [String: Any] = [:]
    var writes: [String] = []
    var resetRecovery: Data?

    var persistence: AppPersistence {
        AppPersistence(
            preferences: preferences(reading: { self.values[$0] }),
            accountResetRecovery: AccountResetRecoveryPreferences(
                load: { self.resetRecovery },
                save: { self.resetRecovery = $0 }))
    }

    /// Preferences that read through `load` and save here.
    func preferences(reading load: @escaping (String) -> Any?) -> AppPreferences {
        AppPreferences(load: load, save: { value, key in
            self.values[key] = value
            self.writes.append(key)
        })
    }
}

/// Every remote-metadata writer: connection edits, project selection, list
/// refresh, PATCH application and thread creation (removal is the caller's).
@MainActor
private func exerciseRemoteWriters(
    _ model: AppModel, on connection: RemoteConnection, token: String
) async throws {
    model.setRemoteNickname(connection.id, nickname: "\(token) nickname")
    model.setRemoteEnabled(connection.id, enabled: false)
    model.selectRemoteProject(connectionID: connection.id, path: "/\(token)/project")
    model.remoteClients[connection.locationID] = persistenceEngineClient(token: token)
    #expect(await model.refreshRemoteThreads(connection.locationID))
    model.applyThreadUpdate(
        try persistedThread("\(token)-listed", title: "\(token) renamed"), at: connection.locationID)
    #expect(await model.newThread(title: nil, shouldSelectCreatedThread: { _ in false }) == "\(token)-created")
}

/// A reset whose connection is already gone: the request is recorded and
/// saved, then stops before any network call.
@MainActor
private func unreachableResetConnection() -> AccountResourceConnection {
    AccountResourceConnection(
        location: .local,
        client: GatewayClient(baseURL: URL(string: "http://127.0.0.1:9")!, token: "unused"),
        isCurrent: { false }, accept: { _, _, _ in })
}

private func cachedThreadIDs(_ stores: TemporaryRemoteStores) throws -> [String] {
    try stores.threadCache.load().map(\.thread.id)
}

private func threadJSON(_ id: String, title: String? = nil) -> String {
    #"{"id":"\#(id)","title":"\#(title ?? id)","repoRoot":"/remote/project","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-28T00:00:00Z","updatedAt":"2026-07-28T00:00:00Z"}"#
}

private func persistedThread(_ id: String, title: String? = nil) throws -> ThreadSummary {
    try JSONDecoder().decode(ThreadSummary.self, from: Data(threadJSON(id, title: title).utf8))
}

/// Every file in `directory` with its exact bytes: an edit and a new file
/// both change the result.
private func fileBytes(in directory: URL) throws -> [String: Data] {
    var files: [String: Data] = [:]
    for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
        files[name] = try Data(contentsOf: directory.appendingPathComponent(name))
    }
    return files
}

/// What the standard domain has saved for `keys`, ignoring volatile domains:
/// any user defaults write by a model changes it.
private func savedStandardPreferences(_ keys: [String]) -> [String: NSObject] {
    var saved: [String: NSObject] = [:]
    for key in keys {
        let value = CFPreferencesCopyValue(
            key as CFString, kCFPreferencesCurrentApplication, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        if let value = value as? NSObject { saved[key] = value }
    }
    return saved
}

/// The canonical path of an existing item (temporary homes sit behind the
/// /var symlink).
private func realPath(_ url: URL) -> String? {
    guard let resolved = realpath(url.path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}

private func persistenceEngineClient(token: String) -> GatewayClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PersistenceEngineProtocol.self]
    return GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:1")!, token: token,
        session: URLSession(configuration: configuration))
}

/// A stateless remote engine. Each row it returns is named after the bearer
/// token that asked, so two models' answers cannot be mixed up.
private final class PersistenceEngineProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let token = (request.value(forHTTPHeaderField: "Authorization") ?? "")
            .replacingOccurrences(of: "Bearer ", with: "")
        let (status, body) = Self.answer(
            method: request.httpMethod ?? "GET", path: request.url?.path ?? "", token: token)
        client?.urlProtocol(
            self,
            didReceive: HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"])!,
            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func answer(method: String, path: String, token: String) -> (Int, String) {
        switch (method, path) {
        case ("GET", "/v2/threads"): return (200, "{\"threads\":[\(threadJSON(token + "-listed"))]}")
        case ("GET", "/v2/runs"): return (200, "{\"runs\":[]}")
        case ("POST", "/v2/threads"): return (200, threadJSON(token + "-created"))
        default: return (404, "{\"code\":\"unexpected_test_route\"}")
        }
    }
}
