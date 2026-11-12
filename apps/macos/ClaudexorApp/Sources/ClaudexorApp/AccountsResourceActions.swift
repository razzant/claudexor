import ClaudexorKit
import Foundation
import Observation

/// Command UI state and unresolved request recovery. Resource facts live in the existing
/// location-scoped ControlQuotaResponse, never in this action controller.
struct AccountResetAttempt: Identifiable {
    let id: String
    let request: ControlAccountResetRequest
    let label: String
    var token = UUID()
    var inFlight = false
    var receipt: ControlAccountResetResponse?
    var error: String?
    var refreshedAfterAttempt = false

    var unconfirmed: Bool {
        guard let receipt else { return true }
        return receipt.outcome == .pending || receipt.outcome == .unknown || receipt.outcome == .alreadyUsed
    }
    var usageNeedsRefresh: Bool {
        !refreshedAfterAttempt && (unconfirmed || receipt?.outcome.confirmsReset == true)
            && receipt?.readback.state != .fresh
    }
}

struct AccountResourceRefresh {
    var token = UUID()
    var inFlight = true
    var error: String?
}

/// The display counters an exact-account request reads when it begins; its reply
/// is accepted against them.
struct AccountRequestObservation: Equatable {
    /// The location's display generation: orders one key's tied readings.
    var displayGeneration: UInt64 = 0
    /// Binding changes of the addressed account seen so far: committed snapshots
    /// and acknowledged app-owned writes of its credential.
    var bindingChanges: UInt64 = 0
}

@MainActor
struct AccountResourceConnection {
    let location: ExecutionLocationID
    let client: GatewayClient
    let isCurrent: () -> Bool
    var observe: (AccountTarget) -> AccountRequestObservation = { _ in AccountRequestObservation() }
    let accept: (ControlQuotaResponse, AccountTarget, AccountRequestObservation) -> Void
}

@MainActor @Observable
final class AccountsResourceActions {
    private(set) var capabilities: [ExecutionLocationID: AccountResourceCapabilities] = [:]
    private(set) var capabilityErrors: [ExecutionLocationID: String] = [:]
    private(set) var resets: [ExecutionLocationID: [AccountResetAttempt]] = [:]
    private(set) var refreshes: [ExecutionLocationID: [AccountTarget: AccountResourceRefresh]] = [:]
    private(set) var recoveryNotice: String?
    @ObservationIgnored private var capabilityClients: [ExecutionLocationID: GatewayClient] = [:]
    @ObservationIgnored private let preferences: AccountResetRecoveryPreferences?

    /// Tests inject a private in-memory preference store. No AppModel lifecycle
    /// or operator defaults are needed to prove close/relaunch recovery.
    init(preferences: AccountResetRecoveryPreferences? = nil) {
        self.preferences = preferences
        guard let data = preferences?.load() else { return }
        do {
            let entries = try JSONDecoder().decode([AccountResetRecoveryPreferences.Entry].self, from: data)
            for entry in entries {
                guard !resets[entry.location, default: []].contains(where: { $0.id == entry.key }) else { continue }
                var attempt = AccountResetAttempt(id: entry.key, request: entry.body, label: entry.label)
                attempt.receipt = entry.receipt
                if entry.receipt == nil {
                    attempt.error = "The app closed before this result was confirmed. Check the original request."
                }
                resets[entry.location, default: []].append(attempt)
            }
        } catch { recoveryNotice = "Saved reset recovery could not be read. Earlier reset results may be unconfirmed." }
    }

    private func persistUnresolved() {
        guard let preferences else { return }
        let entries = resets.flatMap { location, attempts in
            attempts.filter { $0.unconfirmed || $0.inFlight || $0.usageNeedsRefresh }.map {
                AccountResetRecoveryPreferences.Entry(key: $0.id, body: $0.request, location: location, label: $0.label,
                    receipt: $0.receipt?.outcome.confirmsReset == true ? $0.receipt?.withoutResources() : nil)
            }
        }
        do { preferences.save(entries.isEmpty ? nil : try JSONEncoder().encode(entries)) }
        catch { recoveryNotice = "Could not save reset recovery for the next app launch." }
    }

    func capabilities(at location: ExecutionLocationID, client: GatewayClient?) -> AccountResourceCapabilities? {
        guard let client, capabilityClients[location] === client else { return nil }
        return capabilities[location]
    }

    @discardableResult
    func loadCapabilities(
        client: GatewayClient, at location: ExecutionLocationID, isCurrent: () -> Bool
    ) async -> AccountResourceCapabilities? {
        do {
            let value = try await client.accountResourceCapabilities()
            guard isCurrent() else { return nil }
            capabilityClients[location] = client
            capabilities[location] = value
            capabilityErrors.removeValue(forKey: location)
            return value
        } catch {
            guard isCurrent() else { return nil }
            capabilityErrors[location] = Self.message(error)
            return nil
        }
    }

    func attempts(for target: AccountTarget, at location: ExecutionLocationID) -> [AccountResetAttempt] {
        resets[location, default: []].filter { $0.request.target == target }
    }

    func refresh(_ target: AccountTarget, using connection: AccountResourceConnection) async {
        let location = connection.location
        guard refreshes[location]?[target]?.inFlight != true else { return }
        let attempt = AccountResourceRefresh()
        let resetTokens = Dictionary(uniqueKeysWithValues: attempts(for: target, at: location).map { ($0.id, $0.token) })
        refreshes[location, default: [:]][target] = attempt
        do {
            let capability = await loadCapabilities(client: connection.client, at: location,
                                                     isCurrent: connection.isCurrent)
            guard connection.isCurrent() else { throw GatewayError.transport("Engine connection changed. Retry refresh.") }
            guard capability?.refresh == true else {
                throw GatewayError.transport("This engine does not advertise exact-account refresh. Update the engine to use it.")
            }
            let observation = connection.observe(target)
            let response = try await connection.client.quota(
                refresh: true, resources: true, apiKeys: capability?.apiKeys == true, target: target)
            guard refreshes[location]?[target]?.token == attempt.token else { return }
            guard connection.isCurrent() else { throw GatewayError.transport("Engine connection changed. Retry refresh.") }
            guard resetTokens == Dictionary(uniqueKeysWithValues: attempts(for: target, at: location).map { ($0.id, $0.token) }) else {
                throw GatewayError.transport("A reset changed while this refresh was running. Refresh again for current resources.")
            }
            connection.accept(response, target, observation)
            refreshes[location]?[target]?.inFlight = false
            // This acknowledges a read, not a reset. Each server facet and
            // quota window still supplies its own freshness/absence below.
            for index in resets[location, default: []].indices
                where resets[location]?[index].request.target == target
                    && resets[location]?[index].inFlight == false
                    && resets[location]?[index].token == resetTokens[resets[location]![index].id] {
                resets[location]?[index].refreshedAfterAttempt = true
            }
            persistUnresolved()
        } catch {
            guard refreshes[location]?[target]?.token == attempt.token else { return }
            refreshes[location]?[target]?.inFlight = false
            refreshes[location]?[target]?.error = Self.message(error)
        }
    }

    /// Called only after the single native confirmation. A deliberately new
    /// action gets a new key, even when an earlier outcome remains unknown.
    func startReset(_ request: ControlAccountResetRequest, label: String,
                    using connection: AccountResourceConnection) async {
        let attempt = AccountResetAttempt(id: UUID().uuidString, request: request, label: label)
        // Keep unresolved original requests when another reset is intentional.
        // This is current action recovery, not a second persisted history.
        resets[connection.location, default: []].removeAll {
            $0.request.target == request.target && !$0.unconfirmed && !$0.inFlight
        }
        resets[connection.location, default: []].append(attempt)
        persistUnresolved() // Before the first provider-capable request.
        await recoverReset(key: attempt.id, using: connection)
    }

    /// HTTP loss may leave no receipt id. Always retain/reuse the original
    /// key/body. The engine decides whether same-key recovery needs provider IO.
    func recoverReset(key: String, using connection: AccountResourceConnection) async {
        let location = connection.location
        guard let index = resets[location]?.firstIndex(where: { $0.id == key }),
              var attempt = resets[location]?[index], !attempt.inFlight else { return }
        attempt.token = UUID()
        attempt.inFlight = true
        attempt.error = nil
        resets[location]?[index] = attempt
        persistUnresolved()
        do {
            guard connection.isCurrent() else {
                throw GatewayError.transport("Engine connection changed. Check the original request after reconnecting.")
            }
            let observation = connection.observe(attempt.request.target)
            let receipt: ControlAccountResetResponse
            if let previous = attempt.receipt, previous.state == .running,
               capabilities(at: location, client: connection.client)?.resetStatus == true {
                receipt = try await connection.client.accountReset(id: previous.id)
            } else {
                receipt = try await connection.client.resetAccount(attempt.request, idempotencyKey: attempt.id)
            }
            guard let index = resets[location]?.firstIndex(where: { $0.id == key && $0.token == attempt.token }) else { return }
            guard connection.isCurrent() else {
                throw GatewayError.transport("Engine connection changed. Check the original reset result after reconnecting.")
            }
            guard receipt.request == attempt.request else {
                throw GatewayError.transport("The reset receipt names a different request. The original result remains unknown.")
            }
            resets[location]?[index].receipt = receipt
            resets[location]?[index].inFlight = false
            resets[location]?[index].token = UUID() // Retire any read admitted before this outcome.
            persistUnresolved()
            if let response = receipt.resources { connection.accept(response.quota, attempt.request.target, observation) }
        } catch {
            guard let index = resets[location]?.firstIndex(where: { $0.id == key && $0.token == attempt.token }) else { return }
            resets[location]?[index].inFlight = false
            resets[location]?[index].error = Self.message(error)
            resets[location]?[index].token = UUID()
            persistUnresolved()
        }
    }

    private static func message(_ error: Error) -> String {
        if let problem = (error as? GatewayError)?.controlProblem { return problem.message }
        if case GatewayError.transport(let message) = error { return message }
        if case GatewayError.http(let status, _) = error { return "Engine request failed (HTTP \(status))." }
        if error is DecodingError { return "The engine returned an unreadable resource response." }
        return "The engine did not return a response."
    }
}
