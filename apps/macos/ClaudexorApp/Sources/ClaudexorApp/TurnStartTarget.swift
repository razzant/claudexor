import ClaudexorKit
import Foundation

/// Immutable destination for one turn-start attempt. The value is captured
/// before the first await so a host, project, workspace, or thread selection
/// change cannot redirect create, upload, or turn requests in flight.
struct TurnStartTarget {
    enum Destination {
        case existing(threadID: String, eligibleHarnesses: [String])
        case draft(createRequest: CreateThreadRequest, eligibleHarnesses: [String])
    }

    let locationID: ExecutionLocationID
    let repoRoot: String
    let workspace: RunApplicabilityWorkspace
    let destination: Destination

    static func existing(
        locationID: ExecutionLocationID,
        threadID: String,
        repoRoot: String?,
        workspaceMode: String?,
        eligibleHarnesses: [String]
    ) -> TurnStartTarget {
        .init(
            locationID: locationID,
            repoRoot: (repoRoot ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            // A delegated thread executes live in its caller-owned root and never
            // provisions a worktree: the in-place column is its closest cell.
            workspace: workspaceMode == "isolated" ? .isolated : .inPlace,
            destination: .existing(
                threadID: threadID, eligibleHarnesses: eligibleHarnesses))
    }

    static func draft(
        locationID: ExecutionLocationID,
        createRequest: CreateThreadRequest,
        eligibleHarnesses: [String]
    ) -> TurnStartTarget {
        .init(
            locationID: locationID,
            repoRoot: (createRequest.scope.root ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines),
            workspace: createRequest.workspace == "isolated" ? .isolated : .inPlace,
            destination: .draft(
                createRequest: createRequest, eligibleHarnesses: eligibleHarnesses))
    }

    var threadID: String? {
        guard case .existing(let threadID, _) = destination else { return nil }
        return threadID
    }

    var createRequest: CreateThreadRequest? {
        guard case .draft(let request, _) = destination else { return nil }
        return request
    }

    var eligibleHarnesses: [String] {
        switch destination {
        case .existing(_, let eligibleHarnesses), .draft(_, let eligibleHarnesses):
            return eligibleHarnesses
        }
    }

    func replacingDraftWorkspace(_ workspace: RunApplicabilityWorkspace) -> TurnStartTarget {
        guard case .draft(var request, let eligibleHarnesses) = destination else {
            return self
        }
        request.workspace = workspace == .isolated ? "isolated" : nil
        return .draft(
            locationID: locationID,
            createRequest: request,
            eligibleHarnesses: eligibleHarnesses)
    }

    func replacingDraftTitle(_ title: String?) -> TurnStartTarget {
        guard case .draft(var request, let eligibleHarnesses) = destination else {
            return self
        }
        request.title = title
        return .draft(
            locationID: locationID,
            createRequest: request,
            eligibleHarnesses: eligibleHarnesses)
    }
}

struct PreparedTurnStart {
    let client: GatewayClient
    let applicability: ControlRunApplicabilityResponse?
}

enum TurnStartPreparation {
    case ready(PreparedTurnStart)
    case blocked(String)
}

enum TurnStartAdmission: Equatable {
    case allowed
    /// The action may start because async preparation can make this exact
    /// immutable target ready (currently: reconnecting a remote location).
    case preparable(String)
    case blocked(String)

    /// Controls that start async preparation block only terminal refusals.
    var interactionBlocker: String? {
        guard case .blocked(let message) = self else { return nil }
        return message
    }

    /// The low-level boundary must be fully ready before its first mutation.
    var finalBlocker: String? {
        switch self {
        case .allowed: nil
        case .preparable(let message), .blocked(let message): message
        }
    }
}

extension AppModel {
    /// Freeze the draft's complete create request, including the sticky routing
    /// and workspace choices that used to be re-read after a remote connect.
    var composerTurnStartTarget: TurnStartTarget {
        if let threadID = selectedThreadId {
            let thread: ThreadSummary? = {
                if selectedHistory?.header?.thread.id == threadID {
                    return selectedHistory?.header?.thread.summary
                }
                return threadSummary(threadID, at: selectedExecutionLocation)
            }()
            let stickyPool = thread?.eligibleHarnesses ?? []
            let settingsPool = settingsSnapshot(at: selectedExecutionLocation)?
                .routing.eligibleHarnesses ?? []
            return .existing(
                locationID: selectedExecutionLocation,
                threadID: threadID,
                repoRoot: thread?.repoRoot,
                workspaceMode: thread?.workspaceMode,
                eligibleHarnesses: stickyPool.isEmpty ? settingsPool : stickyPool)
        }

        let locationID = draftExecutionLocation
        let root = normalizedProjectRoot
        let settings = settingsSnapshot(at: locationID)
        let resolvedPool = draftEligiblePool.isEmpty
            ? (settings?.routing.eligibleHarnesses ?? [])
            : draftEligiblePool
        let resolvedPrimary = draftPrimaryHarness ?? settings?.routing.primaryHarness
        let guardedPrimary = resolvedPrimary.flatMap { primary in
            resolvedPool.isEmpty || resolvedPool.contains(primary) ? primary : nil
        }
        let request = CreateThreadRequest(
            scope: root.isEmpty ? .none : .project(root: root),
            workspace: draftIsolatedWorkspace ? "isolated" : nil,
            primaryHarness: guardedPrimary,
            eligibleHarnesses: draftEligiblePool.isEmpty ? nil : draftEligiblePool,
            credentialProfileId: draftCredentialProfileId,
            access: draftThreadAccess)
        return .draft(
            locationID: locationID,
            createRequest: request,
            eligibleHarnesses: resolvedPool)
    }

    func turnStartTarget(
        locationID: ExecutionLocationID,
        thread: ThreadSummary
    ) -> TurnStartTarget {
        let stickyPool = thread.eligibleHarnesses ?? []
        let settingsPool = settingsSnapshot(at: locationID)?.routing.eligibleHarnesses ?? []
        return .existing(
            locationID: locationID,
            threadID: thread.id,
            repoRoot: thread.repoRoot,
            workspaceMode: thread.workspaceMode,
            eligibleHarnesses: stickyPool.isEmpty ? settingsPool : stickyPool)
    }

    /// Resolve the exact gateway lease and exact-root applicability before any
    /// create/upload/turn mutation. A remote reconnect is allowed here because
    /// the immutable target was already captured; the returned client identity
    /// then owns the whole attempt and may never be silently replaced mid-turn.
    func prepareTurnStart(_ target: TurnStartTarget) async -> TurnStartPreparation {
        let neededReconnect = gateway(for: target.locationID) == nil
        if neededReconnect, let connectionID = target.locationID.remoteConnectionID {
            await connectRemote(connectionID)
        }
        guard let requestClient = gateway(for: target.locationID) else {
            return .blocked("Engine offline — reconnect before sending.")
        }

        let applicability: ControlRunApplicabilityResponse?
        if target.repoRoot.isEmpty {
            applicability = nil
        } else if !neededReconnect,
                  case .ready(let cached)? = runApplicabilityProjections[target.locationID],
                  cached.repoRoot == target.repoRoot {
            // Copy the exact-root receipt into this attempt. A later view-task
            // refresh for another root must not change an already-started action.
            applicability = cached
        } else {
            do {
                applicability = try await requestClient.runApplicability(
                    repoRoot: target.repoRoot)
            } catch {
                guard isCurrentGateway(requestClient, at: target.locationID) else {
                    return .blocked(Self.turnStartConnectionChangedMessage)
                }
                return .blocked(
                    "Could not verify Git readiness: \(userMessage(for: error))")
            }
        }

        guard isCurrentGateway(requestClient, at: target.locationID) else {
            return .blocked(Self.turnStartConnectionChangedMessage)
        }
        return .ready(PreparedTurnStart(
            client: requestClient,
            applicability: applicability))
    }

    static let turnStartConnectionChangedMessage =
        "The engine connection changed while preparing this turn. Try again."

    /// The one app-side turn-start admission boundary. It selects one cell from
    /// the server-authored Git matrix for the exact immutable target and the
    /// exact access/repair fields that will ride the wire. All other readiness
    /// remains owned by normal server preflight.
    func turnStartAdmission(
        target: TurnStartTarget,
        mode: RunMode,
        options: TurnOptions,
        applicability preparedApplicability: ControlRunApplicabilityResponse? = nil
    ) -> TurnStartAdmission {
        guard gateway(for: target.locationID) != nil else {
            return target.locationID.remoteConnectionID == nil
                ? .blocked("Engine offline — reconnect before sending.")
                : .preparable("Engine offline — Send will reconnect before starting.")
        }
        if target.repoRoot.isEmpty {
            if target.workspace == .isolated {
                return .blocked("Pick a project before enabling an isolated workspace.")
            }
            return mode.requiresProject
                ? .blocked("Pick a project to use \(mode.label). Ask can run without a project.")
                : .allowed
        }
        let response: ControlRunApplicabilityResponse
        if let preparedApplicability {
            guard preparedApplicability.repoRoot == target.repoRoot else {
                return .blocked("Git readiness did not match this project. Try again.")
            }
            response = preparedApplicability
        } else {
            guard let projection = runApplicabilityProjections[target.locationID],
                  projection.repoRoot == target.repoRoot
            else {
                return .blocked("Checking whether this workspace strategy needs Git…")
            }
            switch projection {
            case .ready(let value):
                response = value
            case .failed(_, let message):
                return .blocked(message)
            case .loading:
                return .blocked("Checking whether this workspace strategy needs Git…")
            }
        }
        let access = options.access.flatMap(AccessProfile.init(wire:)) ?? .workspaceWrite
        let repair = composerRepairWire(
            mode: mode,
            access: access,
            requestedAttempts: options.maxAttempts,
            requestedUntilClean: options.untilClean)
        let cell = response.matrix.cell(
            workspace: target.workspace,
            shape: composerRunApplicabilityShape(
                mode: mode, access: access, repair: repair))
        guard !cell.applicable else { return .allowed }
        let parts: [String?] = [cell.reason, cell.remediation]
        let message = parts
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return .blocked(
            message.isEmpty ? "This workspace strategy is not available." : message)
    }

    private func settingsSnapshot(at locationID: ExecutionLocationID) -> SettingsSnapshot? {
        locationID == .local ? settingsSnapshot : remoteSettingsSnapshots[locationID]
    }
}
