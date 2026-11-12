import Foundation
import ClaudexorKit

/// The single UI vocabulary for engine-owned Delegate facts. Views may choose
/// layout, but never infer child provenance or downgrade state themselves.
enum DelegationPresentation {
    struct ControlState: Equatable {
        let available: Bool
        let explanation: String
    }

    struct Warning: Equatable {
        let title: String
        let detail: String
    }

    struct ChildReceipt: Equatable {
        let badge: String
        let parentLabel: String
        let parentRunId: String
    }

    struct RunReceipt: Equatable {
        let requested: String
        let effective: String
        let used: String
        let reason: String
        let detail: String
    }

    /// Final UI-to-wire fence. A previously-on switch cannot smuggle a stale
    /// request after the selected route becomes known-unavailable.
    static func requestedForWire(isOn: Bool, control: ControlState) -> Bool {
        visibleToggleValue(isOn: isOn, control: control)
    }

    /// Visible composer state uses the same fence as the wire. This is also
    /// applied on first appearance, when SwiftUI has no availability change to
    /// deliver and an old `true` binding would otherwise reopen disabled-but-on.
    static func visibleToggleValue(isOn: Bool, control: ControlState) -> Bool {
        isOn && control.available
    }

    /// The composer consumes the engine's exact capability row. Missing data is
    /// an older runtime, never an optimistic "probably works". Full-access
    /// compatibility combines that typed requirement with the draft's current
    /// access selection; no harness/runtime capability is inferred locally.
    static func control(
        capability: HarnessDelegationCapability?,
        hasFullAccess: Bool
    ) -> ControlState {
        control(capabilities: [capability], hasFullAccess: hasFullAccess)
    }

    /// Auto routing may choose from several engine-declared rows. One capable,
    /// access-compatible route is sufficient because the engine capability-
    /// gates the selected lane; an explicit primary passes a one-element list.
    static func control(
        capabilities: [HarnessDelegationCapability?],
        hasFullAccess: Bool
    ) -> ControlState {
        guard !capabilities.isEmpty else {
            return ControlState(
                available: false,
                explanation: "No routable harness is selected. Enable a harness or choose a primary harness, then try again."
            )
        }
        let reported = capabilities.compactMap { $0 }
        guard !reported.isEmpty else {
            return ControlState(
                available: false,
                explanation: "Delegate availability is not reported by this runtime. Update or repair the Claudexor runtime, then reconnect."
            )
        }
        let ready = reported.filter(\.available)
        guard !ready.isEmpty else {
            let remediations = Set(reported.compactMap { capability in
                let value = capability.remediation?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return value?.isEmpty == false ? value : nil
            })
            if remediations.count == 1, let remediation = remediations.first {
                return ControlState(available: false, explanation: remediation)
            }
            let reasons = Set(reported.map(\.reason))
            return ControlState(
                available: false,
                explanation: reasons.count == 1
                    ? unavailableExplanation(reason: reported[0].reason)
                    : "No selected route can host Delegate. Check Harness Doctor or choose a supported harness and runtime."
            )
        }
        if ready.allSatisfy(\.requiresFullAccess), !hasFullAccess {
            return ControlState(
                available: false,
                explanation: "Delegate needs Full access for this harness. Choose Full access, then enable Delegate."
            )
        }
        return ControlState(
            available: true,
            explanation: "Let the agent use the Claudexor tool belt to start bounded, isolated child runs. Permission does not require the agent to create one."
        )
    }

    private static func unavailableExplanation(reason: String) -> String {
        switch reason {
        case "runtime_unavailable":
            return "This runtime cannot host the Delegate tool belt. Update or repair the Claudexor runtime, then reconnect."
        case "manifest_unsupported":
            return "The selected harness cannot accept the Delegate tool belt. Choose a supported harness."
        default:
            return "Delegate is unavailable for the selected harness and runtime. Check Harness Doctor, then try again."
        }
    }

    /// A requested-but-ineffective belt is degraded. A mixed pool is also
    /// degraded when at least one lane was effective but another selected lane
    /// continued as ordinary Agent. `used == false` by itself remains healthy:
    /// Delegate is permission and the agent may legitimately create no child.
    static func warning(_ facts: RunDelegationInfo?, phase: RunPhase) -> Warning? {
        guard let facts, facts.requested else { return nil }
        guard warningShaped(facts) else { return nil }
        let partial = facts.effective && facts.reason == "partially_degraded"
        return Warning(
            title: partial
                ? (phase == .succeeded
                    ? "Done with warnings · one lane continued without Delegate"
                    : (phase.isActive
                        ? "One lane is continuing without Delegate"
                        : "One lane continued without Delegate"))
                : (phase == .succeeded
                    ? "Done with warnings · continued without Delegate"
                    : (phase.isActive ? "Continuing without Delegate" : "Continued without Delegate")),
            detail: facts.remediation?.trimmingCharacters(in: .whitespacesAndNewlines)
                .nilIfEmpty ?? degradedExplanation(reason: facts.reason)
        )
    }

    /// One classification owner shared by the durable warning and run facts.
    /// Pending startup and a failed parent lifecycle already have their own
    /// presentation; only a genuine unavailable/partial route is warning-shaped.
    static func warningShaped(_ facts: RunDelegationInfo) -> Bool {
        let partial = facts.effective && facts.reason == "partially_degraded"
        let unavailable = !facts.effective &&
            ["runtime_unavailable", "manifest_unsupported", "access_profile_incompatible"]
                .contains(facts.reason)
        return facts.requested && (partial || unavailable)
    }

    /// Exact engine-owned Delegate facts for the ordinary run-detail surface.
    /// Healthy and injected-but-unused runs need a durable receipt too; warnings
    /// remain reserved for the degraded cases above.
    static func runReceipt(_ facts: RunDelegationInfo?) -> RunReceipt? {
        guard let facts, facts.requested else { return nil }
        let remediation = facts.remediation?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
        return RunReceipt(
            requested: "Delegate · requested=\(facts.requested)",
            effective: "effective=\(facts.effective)",
            used: "used=\(facts.used)",
            reason: "reason=\(facts.reason)",
            detail: remediation ?? "Engine-owned Delegate receipt for this run."
        )
    }

    static func shouldHydrateChildInteractions(
        waitingOnUser: Bool,
        pendingInteractionCount: Int
    ) -> Bool {
        waitingOnUser && pendingInteractionCount == 0
    }

    static func childInteractionLoadFailure(
        waitingOnUser: Bool,
        pendingInteractionCount: Int,
        engineError: String?
    ) -> String? {
        guard shouldHydrateChildInteractions(
            waitingOnUser: waitingOnUser,
            pendingInteractionCount: pendingInteractionCount
        ), let engineError,
           engineError.hasPrefix("Could not load run detail:") else { return nil }
        return engineError
    }

    private static func degradedExplanation(reason: String) -> String {
        switch reason {
        case "runtime_unavailable":
            return "The selected Claudexor runtime could not provide the Delegate tool belt. Update or repair the runtime, then try again."
        case "manifest_unsupported":
            return "The selected harness could not accept the Delegate tool belt. Choose a supported harness, then try again."
        case "access_profile_incompatible":
            return "The selected access profile could not host Delegate. Choose Full access, then try again."
        case "partially_degraded":
            return "One selected lane could not host Delegate and continued as ordinary Agent. Inspect that lane or choose only Delegate-capable harnesses."
        default:
            return "Delegate could not be enabled before the run started."
        }
    }

    /// Only explicit engine provenance can produce a Claudexor child receipt.
    /// A vendor-native subagent has no such origin and is intentionally absent.
    static func childReceipt(delegatedFromRunId: String?) -> ChildReceipt? {
        guard let parentRunId = delegatedFromRunId,
              !parentRunId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return ChildReceipt(
            badge: "Delegated",
            parentLabel: "Parent · \(shortRunId(parentRunId))",
            parentRunId: parentRunId
        )
    }

    static func isChild(_ run: TaskRun, of parentRunId: String) -> Bool {
        childReceipt(delegatedFromRunId: run.delegatedFromRunId)?.parentRunId == parentRunId
    }

    static func shortRunId(_ runId: String) -> String {
        String(runId.suffix(8))
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

extension AppModel {
    /// Parent/list summaries carry the waiting overlay but not the interaction
    /// payload. Force one coalesced detail refresh even when this child was
    /// hydrated earlier, then stop once the question payload is present.
    func hydrateDelegatedChildInteractions(_ child: TaskRun) async {
        guard DelegationPresentation.shouldHydrateChildInteractions(
            waitingOnUser: child.awaitingAnswer,
            pendingInteractionCount: child.openQuestions.count
        ) else { return }
        await loadRunDetail(child.id)
    }

    /// Flat rows for real Claudexor children of one parent. Current turn cards
    /// provide canonical server chronology; exact-lineage tasks absent from the
    /// projection append as a legacy/restoration fallback.
    func delegatedChildren(
        of parentRunId: String,
        projectedIds: [String] = [],
        at locationID: ExecutionLocationID? = nil
    ) -> [TaskRun] {
        let location = locationID ?? activeExecutionLocation
        let locatedTasks = location == .local ? tasks : remoteTasks[location] ?? []
        let exact = locatedTasks.filter { DelegationPresentation.isChild($0, of: parentRunId) }
        guard !projectedIds.isEmpty else { return exact }
        let byId = Dictionary(uniqueKeysWithValues: exact.map { ($0.id, $0) })
        var seen = Set<String>()
        var ordered = projectedIds.compactMap { id -> TaskRun? in
            guard seen.insert(id).inserted else { return nil }
            return byId[id]
        }
        ordered.append(contentsOf: exact.filter { seen.insert($0.id).inserted })
        return ordered
    }

    func delegatedChildren(
        of parent: TaskRun,
        projectedIds: [String] = [],
        at locationID: ExecutionLocationID? = nil
    ) -> [TaskRun] {
        delegatedChildren(
            of: parent.resolvedRunId ?? parent.id,
            projectedIds: projectedIds, at: locationID)
    }
}
