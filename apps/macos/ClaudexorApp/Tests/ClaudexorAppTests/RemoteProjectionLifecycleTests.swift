import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct RemoteProjectionLifecycleTests {
    @MainActor
    @Test func delayedThreadSnapshotCannotCrossAReplacedClientLease() async throws {
        defer { RemoteEpochURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RemoteEpochURLProtocol.self]
        let session = URLSession(configuration: config)
        let oldClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "old", session: session)
        let newClient = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "new", session: session)
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "lease-host")
        let locationID = connection.locationID
        model.remoteConnections = [connection]
        model.remoteClients[locationID] = oldClient

        let (arrivals, arrival) = AsyncStream<Void>.makeStream()
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        RemoteEpochURLProtocol.handler = { request in
            guard request.url?.path == "/v2/threads" else { throw RemoteEpochError.badRequest }
            arrival.yield()
            // Only the lease swap below releases this response; executor order is not a gate.
            release.wait()
            return (RemoteEpochURLProtocol.response(for: request), Data(
                #"{"threads":[{"id":"old-thread","title":"Old","repoRoot":"/old","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-28T00:00:00Z","updatedAt":"2026-07-28T00:00:00Z"}]}"#.utf8))
        }

        let refresh = Task {
            await model.refreshRemoteThreads(locationID)
            arrival.finish()
        }
        // Wait for the request itself, or for a refresh that ended without sending it,
        // never for a clock: parallel suites can hold the main actor for seconds (#527).
        var loadArrived = false
        for await _ in arrivals { loadArrived = true; break }
        try #require(loadArrived, "remote thread load never arrived")

        model.remoteClients.removeValue(forKey: locationID)
        model.discardRemoteDaemonProjections(at: locationID)
        model.remoteClients[locationID] = newClient
        let newThread = try JSONDecoder().decode(ThreadSummary.self, from: Data(
            #"{"id":"new-thread","title":"New","repoRoot":"/new","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-28T00:00:00Z","updatedAt":"2026-07-28T00:00:00Z"}"#.utf8))
        model.remoteThreadCache = [RemoteThreadCacheEntry(
            locationID: locationID, thread: newThread, syncedAt: .now)]
        release.signal()
        await refresh.value

        #expect(model.remoteThreadCache.map(\.thread.id) == ["new-thread"])
    }

    @MainActor
    @Test func backgroundThreadRefreshNeverReconnectsAnOfflineHost() async {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connection = RemoteConnection(id: UUID(), sshAlias: "host-a")
        model.remoteConnections = [connection]
        model.remoteConnectionGenerations[connection.id] = 7
        model.selectedExecutionLocation = connection.locationID
        model.selectedThreadId = "thread-a"

        await model.refreshOpenThread(
            locationID: connection.locationID, id: "thread-a")

        #expect(model.remoteConnectionGenerations[connection.id] == 7)
        #expect(model.remoteConnectTasks.isEmpty)
        #expect(model.threadStatus?.contains("offline") == true)
    }

    @MainActor
    @Test func retiringOneLocationDropsOnlyItsCancelMemory() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let locationA = ExecutionLocationID.remote(UUID())
        let locationB = ExecutionLocationID.remote(UUID())
        model.rememberRunCancelled("run-a", at: locationA)
        model.rememberRunCancelled("run-b", at: locationB)
        model.discardRemoteDaemonProjections(at: locationA)

        #expect(!model.wasRunCancelled("run-a", at: locationA))
        #expect(model.wasRunCancelled("run-b", at: locationB))
    }

    @MainActor
    @Test func retiringOneRemoteLocationPreservesItsOfflineCacheAndOtherLocations() throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let connectionA = RemoteConnection(id: UUID(), sshAlias: "host-a")
        let connectionB = RemoteConnection(id: UUID(), sshAlias: "host-b")
        let locationA = connectionA.locationID
        let locationB = connectionB.locationID
        let settings = try settingsSnapshot()
        let quota = ControlQuotaResponse(snapshots: [], refreshedAt: "2026-07-28T00:00:00Z")

        model.remoteConnections = [connectionA, connectionB]
        model.remoteConnectionMessages[connectionA.id] = "Keep A message"
        model.remoteThreadCache = [
            RemoteThreadCacheEntry(
                locationID: locationA, thread: try thread(id: "thread-a"), syncedAt: .now),
            RemoteThreadCacheEntry(
                locationID: locationB, thread: try thread(id: "thread-b"), syncedAt: .now),
        ]

        for locationID in [locationA, locationB] {
            model.remoteCredentialProfiles[locationID] = []
            model.remoteAccountPools[locationID] = []
            model.remoteHarnesses[locationID] = []
            model.remoteSettingsSnapshots[locationID] = settings
            model.remoteQuotaResponses[locationID] = quota
            model.remoteExactAuthSources[locationID] = [:]
            model.remoteSecretBackends[locationID] = "file"
            model.remoteStoredSecrets[locationID] = []
            model.remoteTrustEntries[locationID] = []
            model.remoteProjects[locationID] = []
            model.remoteTasks[locationID] = []
            model.runApplicabilityProjections[locationID] = .loading(
                repoRoot: "/tmp/\(locationID.rawValue)")
        }

        model.settingsSnapshot = settings
        model.quotaResponse = quota

        model.discardRemoteDaemonProjections(at: locationA)

        #expect(model.remoteCredentialProfiles[locationA] == nil)
        #expect(model.remoteAccountPools[locationA] == nil)
        #expect(model.remoteHarnesses[locationA] == nil)
        #expect(model.remoteSettingsSnapshots[locationA] == nil)
        #expect(model.remoteQuotaResponses[locationA] == nil)
        #expect(model.remoteExactAuthSources[locationA] == nil)
        #expect(model.remoteSecretBackends[locationA] == nil)
        #expect(model.remoteStoredSecrets[locationA] == nil)
        #expect(model.remoteTrustEntries[locationA] == nil)
        #expect(model.remoteProjects[locationA] == nil)
        #expect(model.remoteTasks[locationA] == nil)
        #expect(model.runApplicabilityProjections[locationA] == nil)

        #expect(model.remoteCredentialProfiles[locationB] != nil)
        #expect(model.remoteAccountPools[locationB] != nil)
        #expect(model.remoteHarnesses[locationB] != nil)
        #expect(model.remoteSettingsSnapshots[locationB] == settings)
        #expect(model.remoteQuotaResponses[locationB] == quota)
        #expect(model.remoteExactAuthSources[locationB] != nil)
        #expect(model.remoteSecretBackends[locationB] == "file")
        #expect(model.remoteStoredSecrets[locationB] != nil)
        #expect(model.remoteTrustEntries[locationB] != nil)
        #expect(model.remoteProjects[locationB] != nil)
        #expect(model.remoteTasks[locationB] != nil)
        #expect(model.runApplicabilityProjections[locationB] != nil)

        #expect(model.settingsSnapshot == settings)
        #expect(model.quotaResponse == quota)

        #expect(model.remoteConnections == [connectionA, connectionB])
        #expect(model.remoteConnectionMessages[connectionA.id] == "Keep A message")
        #expect(model.remoteThreadCache.map(\.thread.id).sorted() == ["thread-a", "thread-b"])
    }

    private func settingsSnapshot() throws -> SettingsSnapshot {
        try JSONDecoder().decode(SettingsSnapshot.self, from: Data(
            #"{"sources":[],"routing":{"goal":"auto","paidFallback":"when_unavailable","qualityTiers":{},"primaryHarness":null,"eligibleHarnesses":[],"envInheritance":"mirror_native","authPreference":"auto"},"budget":{"paidBudgetPerRun":{"kind":"unlimited"}},"runtime":null,"harnesses":{},"interactionTimeoutMs":null}"#.utf8))
    }

    private func thread(id: String) throws -> ThreadSummary {
        try JSONDecoder().decode(ThreadSummary.self, from: Data(
            #"{"id":"\#(id)","title":"\#(id)","repoRoot":"/tmp/project","mode":null,"workspaceMode":"in_place","authPreference":null,"primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-07-28T00:00:00Z","updatedAt":"2026-07-28T00:00:00Z"}"#.utf8))
    }
}

private enum RemoteEpochError: Error { case badRequest }

private final class RemoteEpochURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler:
        ((URLRequest) throws -> (HTTPURLResponse, Data))?

    static func response(for request: URLRequest) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let request = request
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            do {
                guard let handler = Self.handler else { throw RemoteEpochError.badRequest }
                let (response, data) = try handler(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }
    override func stopLoading() {}
}
