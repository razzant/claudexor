import ClaudexorKit
import Foundation

/// Where one run's remote file references resolve (INV-072/INV-073): its
/// execution tree, addressed through the stable project identity. A tree other
/// than the project itself is reachable only through the run whose recorded
/// binding the engine verifies, never as the project's same-named file.
struct RemoteFileScope: Equatable, Sendable {
    let runID: String?
    let projectRoot: String?
    let executionRoot: String?
}

extension TaskRun {
    /// Local roots this run's answer, retained output and previews may open:
    /// its execution tree (summary `executionRoot`) and run directory only.
    var fileScopeRoots: [String] { [executionRoot, runDir].compactMap { $0 } }

    var remoteFileScope: RemoteFileScope {
        RemoteFileScope(
            runID: resolvedRunId ?? id, projectRoot: repoRoot, executionRoot: executionRoot)
    }
}

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

    /// Returns true when the cached list of the location now reflects the
    /// engine; false when it kept the last-known rows.
    @discardableResult
    func refreshRemoteThreads(
        _ locationID: ExecutionLocationID,
        using preparedClient: GatewayClient? = nil
    ) async -> Bool {
        guard let remote = remoteConnection(for: locationID),
              let client = preparedClient ?? remoteClients[locationID],
              isCurrentGateway(client, at: locationID)
        else { return false }
        do {
            let list = try await client.listThreads()
            guard isCurrentGateway(client, at: locationID) else { return false }
            let now = Date()
            remoteThreadCache.removeAll { $0.locationID == locationID }
            remoteThreadCache.append(contentsOf: list.threads.map {
                RemoteThreadCacheEntry(locationID: locationID, thread: $0, syncedAt: now)
            })
            persistRemoteThreadCache()
            reconcileThreadStatus(at: locationID, listGaps: ThreadListGaps(list))
            await refreshRemoteRuns(locationID, using: client)
            guard isCurrentGateway(client, at: locationID) else { return true }
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
            return true
        } catch {
            guard isCurrentGateway(client, at: locationID) else { return false }
            remoteConnectionMessages[remote.id] =
                "Could not sync; showing cached thread summaries."
            return false
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

    /// The selected thread's execution tree (`ThreadWorkspacePanel.executionRoot`):
    /// a delegated thread's file references resolve in its caller-owned workspace,
    /// never in the project it is identified by.
    var currentThreadExecutionRoot: String? {
        guard let thread = currentThread else { return nil }
        return ThreadWorkspacePanel.executionRoot(for: thread)
    }

    /// Markdown that names no run resolves in the selected thread, unbound.
    var currentThreadRemoteFileScope: RemoteFileScope {
        RemoteFileScope(
            runID: nil, projectRoot: currentThread?.repoRoot,
            executionRoot: currentThreadExecutionRoot)
    }

    func remoteProjectFileReference(
        target: String,
        scope: RemoteFileScope? = nil
    ) -> RemoteFileReference? {
        remoteProjectFileReference(
            target: target,
            locationID: selectedExecutionLocation,
            scope: scope ?? currentThreadRemoteFileScope)
    }

    func remoteProjectFileReference(
        target: String,
        locationID: ExecutionLocationID,
        scope: RemoteFileScope
    ) -> RemoteFileReference? {
        guard locationID != .local else { return nil }
        return Self.remoteFileReference(
            target: target, scope: scope, projects: remoteProjects[locationID] ?? [])
    }

    typealias RemoteFileReference = (projectID: String, relativePath: String, runID: String?)

    /// Pure resolution (unit-tested): the registered project is found by the
    /// stable identity; the path is contained by the execution tree; a tree
    /// other than the project travels with its run, and without one maps nowhere.
    nonisolated static func remoteFileReference(
        target: String,
        scope: RemoteFileScope,
        projects: [RegisteredProject]
    ) -> RemoteFileReference? {
        guard let root = scope.executionRoot,
              let projectRoot = scope.projectRoot,
              let project = projects.first(where: { $0.root == projectRoot })
        else { return nil }
        let runID = root == projectRoot ? nil : scope.runID
        guard root == projectRoot || runID != nil,
              let relative = containedProjectRelativePath(target: target, repoRoot: root)
        else { return nil }
        return (project.id, relative, runID)
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
        try? persistence.remoteThreadCache?().save(remoteThreadCache)
    }

    private static func threadSortDate(_ thread: ThreadSummary) -> String {
        thread.updatedAt
    }
}
