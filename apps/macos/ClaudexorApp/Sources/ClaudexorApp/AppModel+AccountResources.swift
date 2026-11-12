import ClaudexorKit
import Foundation

extension AppModel {
    func loadAccountResourceCapabilities(
        client: GatewayClient, at location: ExecutionLocationID
    ) async -> AccountResourceCapabilities? {
        await accountResourceActions.loadCapabilities(client: client, at: location) { [weak self] in
            self?.isCurrentGateway(client, at: location) == true
        }
    }

    /// The additive, catalog-negotiated routing-evidence read beside an
    /// Accounts hydration; it settles independently and never fails it.
    func refreshAccountsRoutingEvidence(at location: ExecutionLocationID, client: GatewayClient) async {
        let request = accountsRoutingEvidence.begin(at: location)
        let capabilities = await loadAccountResourceCapabilities(client: client, at: location)
        await accountsRoutingEvidence.refresh(
            request, client: client, at: location, capabilities: capabilities,
            isCurrent: { [weak self] in self?.isCurrentGateway(client, at: location) == true })
    }

    /// An app-owned credential write the engine acknowledged (a stored key; a
    /// profile enabled, disabled or removed) changes that account's binding even
    /// when the display read that would show it fails: a reply begun before it
    /// cannot install another key, while a refresh begun after it still can.
    func noteAccountResourceBindingWrite(_ target: AccountTarget, at location: ExecutionLocationID) {
        accountResourceBindingChanges[location, default: [:]][target, default: 0] &+= 1
    }

    func accountResourceConnection(at location: ExecutionLocationID) -> AccountResourceConnection? {
        guard let requestClient = gateway(for: location) else { return nil }
        return AccountResourceConnection(location: location, client: requestClient,
            isCurrent: { [weak self] in self?.isCurrentGateway(requestClient, at: location) == true },
            observe: { [weak self] target in
                AccountRequestObservation(displayGeneration: self?.accountsQuotaDisplayGenerations[location] ?? 0,
                                          bindingChanges: self?.accountResourceBindingChanges[location]?[target] ?? 0)
            },
            accept: { [weak self] response, target, observation in
                guard let self else { return }
                // Reset/refresh responses retain all accounts server-side. Only
                // the addressed slice belongs to this request in the UI; never
                // replace another account's newer display with that older copy.
                let previous = self.quotaResponse(at: location)
                let merged = response.replacingAccount(target, in: previous,
                    reboundSinceRequest: (self.accountResourceBindingChanges[location]?[target] ?? 0) != observation.bindingChanges,
                    preferPreviousOnTie: (self.accountsQuotaDisplayGenerations[location] ?? 0) != observation.displayGeneration)
                self.accountsNextUpAuthorityFresh[location] = false
                guard merged != previous else { return }
                self.storeAccountsQuotaSnapshot(merged, at: location)
            })
    }
}
