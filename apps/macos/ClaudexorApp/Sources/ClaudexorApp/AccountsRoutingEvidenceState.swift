import Foundation
import ClaudexorKit

/// Model-scoped account routing evidence per execution location (INV-135):
/// live refusal marks, live model-scoped credential refusals and each
/// account's last service per requested model.
/// It is kept apart from the profile DTOs, so a PATCH that replaces one row
/// never drops it, and its failure never fails Accounts hydration: the listing
/// stays authoritative and the surface shows one non-fatal notice.
@MainActor @Observable
final class AccountsRoutingEvidenceState {
    private(set) var evidence: [ExecutionLocationID: AccountRoutingEvidence] = [:]
    private(set) var problems: [ExecutionLocationID: String] = [:]
    @ObservationIgnored private var latest: [ExecutionLocationID: UInt64] = [:]

    /// Starts a read at the location, before its first await. It supersedes
    /// every earlier read there; a credential mutation calls it too, so no
    /// answer from before the mutation (success, failure or an unsupported
    /// catalog) can publish after it.
    @discardableResult
    func begin(at location: ExecutionLocationID) -> UInt64 {
        let request = (latest[location] ?? 0) &+ 1
        latest[location] = request
        return request
    }

    /// One read per Accounts hydration, only when the operation catalog
    /// advertises it. An engine without the read shows nothing new.
    func refresh(
        _ request: UInt64,
        client: GatewayClient,
        at location: ExecutionLocationID,
        capabilities: AccountResourceCapabilities?,
        isCurrent: () -> Bool
    ) async {
        guard capabilities?.routingEvidence == true else {
            guard latest[location] == request, isCurrent() else { return }
            evidence[location] = nil
            problems[location] = nil
            return
        }
        do {
            let value = try await client.accountRoutingEvidence()
            guard latest[location] == request, isCurrent() else { return }
            evidence[location] = value
            problems[location] = nil
        } catch {
            guard latest[location] == request, isCurrent() else { return }
            evidence[location] = nil
            problems[location] = Self.notice(error)
        }
    }

    func marks(harnessId: String, profileId: String, at location: ExecutionLocationID,
               now: Date = Date()) -> [AccountRefusalMark] {
        (evidence[location]?.refusals ?? []).filter {
            $0.harnessId == harnessId && $0.profileId == profileId && $0.isLive(at: now)
        }
    }

    func credentialUnusable(harnessId: String, profileId: String, at location: ExecutionLocationID,
                            now: Date = Date()) -> [AccountCredentialUnusableMark] {
        (evidence[location]?.credentialUnusable ?? []).filter {
            $0.harnessId == harnessId && $0.profileId == profileId && $0.isLive(at: now)
        }
    }

    func lastService(harnessId: String, profileId: String,
                     at location: ExecutionLocationID) -> [AccountLastService] {
        (evidence[location]?.lastService ?? []).filter {
            $0.harnessId == harnessId && $0.profileId == profileId
        }
    }

    static func notice(_ error: Error) -> String {
        let reason: String
        if case GatewayError.http(let status, _) = error { reason = "HTTP \(status)" }
        else { reason = error.localizedDescription }
        return "Recent refusals and last-served evidence are unavailable (\(reason)). Account rows are current."
    }
}
