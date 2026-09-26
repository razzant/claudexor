import ClaudexorKit
import Foundation

extension AppModel {
    var locatedThreads: [LocatedThread] {
        let local = threads.map { LocatedThread(locationID: .local, thread: $0) }
        let remote = remoteThreadCache.map {
            LocatedThread(locationID: $0.locationID, thread: $0.thread)
        }
        return (local + remote).sorted {
            Self.threadSortDate($0.thread) > Self.threadSortDate($1.thread)
        }
    }

    var threadFolderNames: [String] {
        Array(Set(locatedThreads.compactMap(\.thread.folder)))
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    func threads(in folder: String?) -> [LocatedThread] {
        locatedThreads.filter { $0.thread.folder == folder }
    }

    var selectedLocatedThreadID: String? {
        guard let selectedThreadId else { return nil }
        return "\(selectedExecutionLocation.rawValue)|\(selectedThreadId)"
    }

    var selectedRemoteConnection: RemoteConnection? {
        guard let id = selectedExecutionLocation.remoteConnectionID else { return nil }
        return remoteConnections.first { $0.id == id }
    }

    func remoteConnection(for locationID: ExecutionLocationID) -> RemoteConnection? {
        guard let id = locationID.remoteConnectionID else { return nil }
        return remoteConnections.first { $0.id == id }
    }

    func gateway(for locationID: ExecutionLocationID) -> GatewayClient? {
        locationID == .local ? client : remoteClients[locationID]
    }

    /// One lease check for every response that wants to mutate a
    /// location-scoped daemon projection after an await. Removing/replacing the
    /// exact client retires the whole epoch; a late response is then inert.
    func isCurrentGateway(_ requestClient: GatewayClient, at locationID: ExecutionLocationID) -> Bool {
        gateway(for: locationID) === requestClient
    }

    func refreshRemoteThreads(
        _ locationID: ExecutionLocationID,
        using preparedClient: GatewayClient? = nil
    ) async {
        guard let remote = remoteConnection(for: locationID),
              let client = preparedClient ?? remoteClients[locationID],
              isCurrentGateway(client, at: locationID)
        else { return }
        do {
            let list = try await client.listThreads()
            guard isCurrentGateway(client, at: locationID) else { return }
            let now = Date()
            remoteThreadCache.removeAll { $0.locationID == locationID }
            remoteThreadCache.append(contentsOf: list.threads.map {
                RemoteThreadCacheEntry(locationID: locationID, thread: $0, syncedAt: now)
            })
            persistRemoteThreadCache()
            await refreshRemoteRuns(locationID, using: client)
            guard isCurrentGateway(client, at: locationID) else { return }
            for thread in list.threads {
                guard let runID = thread.headRunId,
                      remoteTasks[locationID]?.first(where: {
                          $0.id == runID
                      })?.phase.isActive == true
                else { continue }
                streamRemoteRun(
                    locationID: locationID, runID: runID, threadID: thread.id)
            }
            remoteConnectionMessages[remote.id] =
                list.droppedThreads == 0
                ? "Synced \(list.threads.count) thread(s)."
                : "Synced with \(list.droppedThreads) incompatible thread row(s) hidden."
        } catch {
            guard isCurrentGateway(client, at: locationID) else { return }
            remoteConnectionMessages[remote.id] =
                "Could not sync; showing cached thread summaries."
        }
    }

    func refreshRemoteRuns(
        _ locationID: ExecutionLocationID,
        using preparedClient: GatewayClient? = nil
    ) async {
        guard let client = preparedClient ?? remoteClients[locationID],
              isCurrentGateway(client, at: locationID)
        else { return }
        do {
            let summaries = try await client.listRuns()
            guard remoteClients[locationID] === client else { return }
            let existingByID = Dictionary(
                uniqueKeysWithValues: (remoteTasks[locationID] ?? []).map { ($0.id, $0) })
            remoteTasks[locationID] = summaries.map {
                Self.mergeRefreshedTask(
                    summary: $0,
                    existing: existingByID[$0.runId]
                        ?? $0.jobId.flatMap { existingByID[$0] })
            }
        } catch {
            // Run transcripts and artifacts are intentionally memory-only.
        }
    }

    func remoteProjectFileReference(
        target: String
    ) -> (projectID: String, relativePath: String)? {
        remoteProjectFileReference(
            target: target,
            locationID: selectedExecutionLocation,
            repoRoot: currentThread?.repoRoot)
    }

    func remoteProjectFileReference(
        target: String,
        locationID: ExecutionLocationID,
        repoRoot: String?
    ) -> (projectID: String, relativePath: String)? {
        guard locationID != .local,
              let root = repoRoot,
              let project = remoteProjects[locationID]?.first(where: {
                  $0.root == root
              })
        else { return nil }
        guard let relative = Self.containedProjectRelativePath(
            target: target, repoRoot: root)
        else { return nil }
        return (project.id, relative)
    }

    /// Convert an absolute or project-relative UI target into one lexical,
    /// contained project path. The remote file service performs the canonical
    /// filesystem/symlink check; this client-side owner prevents a host
    /// FileManager lookup and keeps every remote image caller on the same scope
    /// derivation.
    nonisolated static func containedProjectRelativePath(
        target: String,
        repoRoot: String
    ) -> String? {
        guard !repoRoot.isEmpty else { return nil }
        var path = target
        if path.hasPrefix("file://") { path.removeFirst("file://".count) }
        let absolute: String
        if path.hasPrefix("/") {
            absolute = path
        } else {
            absolute = (repoRoot as NSString).appendingPathComponent(path)
        }
        let normalizedRoot = URL(fileURLWithPath: repoRoot).standardized.path
        let normalized = URL(fileURLWithPath: absolute).standardized.path
        let prefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : normalizedRoot + "/"
        guard normalized.hasPrefix(prefix) else { return nil }
        let relative = String(normalized.dropFirst(prefix.count))
        guard !relative.isEmpty,
              !relative.split(separator: "/").contains("..")
        else { return nil }
        return relative
    }

    func persistRemoteThreadCache() {
        try? RemoteThreadCacheStore.applicationSupport().save(remoteThreadCache)
    }

    private static func threadSortDate(_ thread: ThreadSummary) -> String {
        thread.updatedAt
    }
}
