import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

/// No AppModel construction, lifecycle, daemon, credentials or live networking.
@MainActor @Suite(.serialized)
struct AccountResourcesActionTests {
    @Test func concurrentClientsKeepTheirHandlersAndIndependentTeardown() async throws {
        let first = ResourceAppFixture()
        let second = ResourceAppFixture()
        defer { first.handler = nil; second.handler = nil }
        let gate = ResourceResponseGate()
        first.handler = { _ in
            await gate.pause()
            return (200, Data(AccountResourcesFixtures.catalog.utf8))
        }
        second.handler = { _ in (200, Data(#"{"operations":[]}"#.utf8)) }
        let firstClient = first.gateway()
        let secondClient = second.gateway()
        let pending = Task { try await firstClient.accountResourceCapabilities() }
        await gate.waitForStart()
        let other = try await secondClient.accountResourceCapabilities()
        #expect(!other.refresh)
        // Replacing the first fixture does not change the already-started
        // request; removing the second does not unregister the first client.
        first.handler = { _ in (200, Data(AccountResourcesFixtures.catalog.utf8)) }
        second.handler = nil
        await gate.finish()
        #expect(try await pending.value.refresh)
        #expect(try await firstClient.accountResourceCapabilities().refresh)
    }

    @Test func normalRelaunchRestoresUnresolvedKeyBodyAndLocationBeforeAnyNewRequest() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        var bytes: Data?
        let preferences = AccountResetRecoveryPreferences(load: { bytes }, save: { bytes = $0 })
        let recorder = ResourceAppRecorder()
        fixture.handler = { request in
            await recorder.record(request)
            throw URLError(.timedOut)
        }
        let remote = ExecutionLocationID.remote(UUID())
        let client = fixture.gateway()
        let connection = AccountResourceConnection(location: remote, client: client, isCurrent: { true }, accept: { _, _, _ in })
        var actions: AccountsResourceActions? = AccountsResourceActions(preferences: preferences)
        await actions?.startReset(AccountResourcesFixtures.request, label: "Granted reset", using: connection)
        let original = try #require(actions?.attempts(for: AccountResourcesFixtures.target, at: remote).last)
        let saved = try #require(bytes)
        let entries = try JSONDecoder().decode([AccountResetRecoveryPreferences.Entry].self, from: saved)
        #expect(entries.count == 1 && entries[0].key == original.id)
        #expect(entries[0].body == original.request && entries[0].location == remote)
        actions = nil
        let relaunched = AccountsResourceActions(preferences: preferences)
        let recovered = try #require(relaunched.attempts(for: AccountResourcesFixtures.target, at: remote).last)
        #expect(recovered.id == original.id && recovered.request == original.request)
        #expect(recovered.unconfirmed && recovered.receipt == nil && !recovered.inFlight)
        #expect(relaunched.attempts(for: AccountResourcesFixtures.target, at: .local).isEmpty)
        #expect(await recorder.requests.count == 1) // Restore never sends a request.
        fixture.handler = { request in
            await recorder.record(request)
            return (200, try AccountResourcesFixtures.receipt(outcome: "already_redeemed", readback: "fresh"))
        }
        await relaunched.recoverReset(key: recovered.id, using: connection)
        let requests = await recorder.requests
        #expect(requests.count == 2 && requests[0].key == requests[1].key && requests[0].body == requests[1].body)
        #expect(bytes == nil) // Resolved receipts remain engine-owned.
    }

    @Test func relaunchKeepsConfirmedResetWhileReadbackIsUnresolved() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        var bytes: Data?
        let preferences = AccountResetRecoveryPreferences(load: { bytes }, save: { bytes = $0 })
        let recorder = ResourceAppRecorder()
        fixture.handler = { request in
            await recorder.record(request)
            return (200, try AccountResourcesFixtures.receipt(outcome: "reset", readback: "failed"))
        }
        let connection = AccountResourceConnection(location: .local, client: fixture.gateway(),
            isCurrent: { true }, accept: { _, _, _ in })
        let actions = AccountsResourceActions(preferences: preferences)
        await actions.startReset(AccountResourcesFixtures.request, label: "Granted reset", using: connection)
        let original = try #require(actions.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        let saved = try #require(bytes)
        #expect(!String(decoding: saved, as: UTF8.self).contains("snapshots"))
        let restored = AccountsResourceActions(preferences: preferences)
        let prior = try #require(restored.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        #expect(prior.id == original.id && prior.request == original.request)
        #expect(!prior.unconfirmed && prior.usageNeedsRefresh)
        #expect(AccountResourcePresentation.status(prior) == "Reset applied")
        #expect(prior.receipt?.resources == nil)
        #expect(await recorder.requests.count == 1)
        fixture.handler = { request in
            await recorder.record(request)
            if request.url.path.hasSuffix("/operations") {
                return (200, Data(AccountResourcesFixtures.catalog.utf8))
            }
            return (200, Data(AccountResourcesFixtures.resources.utf8))
        }
        await restored.refresh(AccountResourcesFixtures.target, using: connection)
        #expect(bytes == nil)
        let refreshed = try #require(restored.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        #expect(!refreshed.unconfirmed && !refreshed.usageNeedsRefresh)
    }

    @Test func freshZeroDisablesOnlyItsOwnActionAndStaleOrUnknownRemainActionable() throws {
        let snapshot = try #require(AccountResourcesFixtures.quota().resources?.first)
        let offer = try #require(snapshot.resets.value?.first)
        var wire = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(offer)) as? [String: Any])
        wire["available_count"] = 0
        wire["usable_now"] = NSNull()
        let zero = try JSONDecoder().decode(AccountResetOffer.self, from: JSONSerialization.data(withJSONObject: wire))
        #expect(AccountResourcePresentation.disabledReason(offer: zero, grant: nil, freshness: .fresh,
            supported: true, busy: false) != nil)
        #expect(AccountResourcePresentation.disabledReason(offer: zero, grant: nil, freshness: .stale,
            supported: true, busy: false) == nil)
        wire["available_count"] = NSNull()
        let unknown = try JSONDecoder().decode(AccountResetOffer.self, from: JSONSerialization.data(withJSONObject: wire))
        #expect(AccountResourcePresentation.disabledReason(offer: unknown, grant: nil, freshness: .fresh,
            supported: true, busy: false) == nil)
        let originalGrant = try #require(offer.grants?.first)
        var grantWire = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(originalGrant)) as? [String: Any])
        grantWire["available_count"] = 0
        grantWire["usable_now"] = NSNull()
        let emptyGrant = try JSONDecoder().decode(AccountResetGrant.self, from: JSONSerialization.data(withJSONObject: grantWire))
        #expect(AccountResourcePresentation.disabledReason(offer: offer, grant: emptyGrant, freshness: .fresh,
            supported: true, busy: false) != nil)
        #expect(AccountResourcePresentation.disabledReason(offer: offer, grant: emptyGrant, freshness: .stale,
            supported: true, busy: false) == nil)
        let refill = try #require(snapshot.resets.value?.last)
        #expect(AccountResourcePresentation.disabledReason(offer: refill, grant: nil, freshness: .fresh,
            supported: true, busy: false) == nil)
    }

    @Test func timeoutWithoutReceiptRetainsBodyAndKeyAndRecoveryCannotSpendAgain() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let recorder = ResourceAppRecorder()
        fixture.handler = { request in
            await recorder.record(request)
            if await recorder.requests.count == 1 { throw URLError(.timedOut) }
            return (200, try AccountResourcesFixtures.receipt())
        }
        let actions = AccountsResourceActions()
        var displayed: ControlQuotaResponse?
        let connection = AccountResourceConnection(location: .local, client: fixture.gateway(),
                                                   isCurrent: { true }, accept: { response, _, _ in displayed = response })
        await actions.startReset(AccountResourcesFixtures.request, label: "Granted reset", using: connection)
        let unknown = try #require(actions.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        #expect(unknown.receipt == nil && unknown.unconfirmed && !unknown.inFlight)
        #expect(unknown.usageNeedsRefresh)
        await actions.recoverReset(key: unknown.id, using: connection)
        let requests = await recorder.requests
        #expect(requests.count == 2)
        #expect(requests[0].key == requests[1].key)
        #expect(requests[0].body == requests[1].body)
        #expect(try JSONDecoder().decode(ControlAccountResetRequest.self, from: requests[1].body) == AccountResourcesFixtures.request)
        let resolved = try #require(actions.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        #expect(resolved.receipt?.outcome == .reset)
        #expect(resolved.receipt?.readback.state == .failed)
        #expect(resolved.usageNeedsRefresh)
        #expect(displayed?.resources?.first?.resets.value?.first?.availableCount == 2)
    }

    @Test func deliberateResetAfterUnknownUsesNewKeyAndKeepsOriginalRecoverable() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let recorder = ResourceAppRecorder()
        fixture.handler = { request in
            await recorder.record(request)
            return (200, try AccountResourcesFixtures.receipt(outcome: "unknown"))
        }
        let actions = AccountsResourceActions()
        let connection = AccountResourceConnection(location: .local, client: fixture.gateway(), isCurrent: { true }, accept: { _, _, _ in })
        await actions.startReset(AccountResourcesFixtures.request, label: "Reset", using: connection)
        let original = try #require(actions.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        let snapshot = try #require(AccountResourcesFixtures.quota().resources?.first)
        let offer = try #require(snapshot.resets.value?.first)
        let message = AccountResourcePresentation.confirmation(account: "Work", offer: offer, grant: offer.grants?.first,
            freshness: .stale, previous: original)
        #expect(message.contains("previous reset result is unconfirmed"))
        #expect(message.contains("separate request"))
        #expect(AccountResourcePresentation.disabledReason(offer: offer, grant: nil, freshness: .unknown, supported: true, busy: false) == nil)
        await actions.startReset(AccountResourcesFixtures.request, label: "Reset", using: connection)
        await actions.recoverReset(key: original.id, using: connection)
        let requests = await recorder.requests
        #expect(requests[0].key != requests[1].key)
        #expect(requests[0].key == requests[2].key)
        #expect(actions.attempts(for: AccountResourcesFixtures.target, at: .local).count == 2)
    }

    @Test func runningReceiptUsesStatusReadAndSettlesWithoutAnotherResetPost() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let recorder = ResourceAppRecorder()
        fixture.handler = { request in
            await recorder.record(request)
            if request.url.path == "/v2/operations" { return (200, Data(AccountResourcesFixtures.catalog.utf8)) }
            if request.method == "POST" {
                return (202, try AccountResourcesFixtures.receipt(outcome: "pending", readback: "pending", state: "running"))
            }
            return (200, try AccountResourcesFixtures.receipt(outcome: "already_redeemed", readback: "fresh"))
        }
        let actions = AccountsResourceActions()
        let client = fixture.gateway()
        let connection = AccountResourceConnection(location: .local, client: client, isCurrent: { true }, accept: { _, _, _ in })
        await actions.loadCapabilities(client: client, at: .local, isCurrent: { true })
        await actions.startReset(AccountResourcesFixtures.request, label: "Reset", using: connection)
        let pending = try #require(actions.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        #expect(pending.receipt?.state == .running && pending.unconfirmed)
        await actions.recoverReset(key: pending.id, using: connection)
        let settled = try #require(actions.attempts(for: AccountResourcesFixtures.target, at: .local).last)
        #expect(settled.receipt?.outcome == .alreadyRedeemed && !settled.unconfirmed && !settled.usageNeedsRefresh)
        let requests = await recorder.requests
        #expect(requests.filter { $0.method == "POST" }.count == 1)
        #expect(requests.last?.method == "GET" && requests.last?.url.path == "/v2/account-resets/reset-fixture")
    }

    @Test func pendingThenRemoteGatewayRetirementCannotCommitOldResponse() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        fixture.handler = { _ in
            await gate.pause()
            return (200, try AccountResourcesFixtures.receipt(readback: "fresh"))
        }
        let actions = AccountsResourceActions()
        let remote = ExecutionLocationID.remote(UUID())
        var current = true
        var commits = 0
        let connection = AccountResourceConnection(location: remote, client: fixture.gateway(),
            isCurrent: { current }, accept: { _, _, _ in commits += 1 })
        let task = Task { await actions.startReset(AccountResourcesFixtures.request, label: "Reset", using: connection) }
        await gate.waitForStart()
        #expect(actions.attempts(for: AccountResourcesFixtures.target, at: remote).last?.inFlight == true)
        #expect(actions.attempts(for: AccountResourcesFixtures.target, at: .local).isEmpty)
        current = false
        await gate.finish()
        await task.value
        #expect(commits == 0)
        let retired = try #require(actions.attempts(for: AccountResourcesFixtures.target, at: remote).last)
        #expect(retired.unconfirmed && !retired.inFlight)
        #expect(retired.error?.contains("connection changed") == true)
        #expect(retired.request == AccountResourcesFixtures.request)
    }

    @Test func retryReadbackOnlyRefreshesExactDisabledDefaultAccount() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let recorder = ResourceAppRecorder()
        fixture.handler = { request in
            await recorder.record(request)
            if request.url.path == "/v2/operations" { return (200, Data(AccountResourcesFixtures.catalog.utf8)) }
            if request.url.path == "/v2/quota" { return (200, Data(AccountResourcesFixtures.resources.utf8)) }
            return (200, try AccountResourcesFixtures.receipt())
        }
        let actions = AccountsResourceActions()
        var target: AccountTarget?
        let connection = AccountResourceConnection(location: .local, client: fixture.gateway(),
            isCurrent: { true }, accept: { _, value, _ in target = value })
        await actions.startReset(AccountResourcesFixtures.request, label: "Reset", using: connection)
        await actions.refresh(AccountResourcesFixtures.target, using: connection)
        let requests = await recorder.requests
        #expect(requests.filter { $0.url.path == "/v2/account-resets" }.count == 1)
        let refresh = try #require(requests.first { $0.url.path == "/v2/quota" })
        #expect(refresh.method == "POST" && refresh.url.query == "view=resources")
        struct Body: Decodable { let target: AccountTarget }
        #expect(try JSONDecoder().decode(Body.self, from: refresh.body).target == AccountResourcesFixtures.target)
        #expect(target == AccountResourcesFixtures.target)
        #expect(actions.attempts(for: AccountResourcesFixtures.target, at: .local).last?.receipt?.outcome == .reset)
        #expect(actions.refreshes[.local]?[AccountResourcesFixtures.target]?.error == nil)
    }

    @Test func oldEngineDoesNotTurnExactRefreshIntoProviderFanout() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let recorder = ResourceAppRecorder()
        fixture.handler = { request in
            await recorder.record(request)
            return (200, Data(#"{"operations":[]}"#.utf8))
        }
        let actions = AccountsResourceActions()
        let connection = AccountResourceConnection(location: .local, client: fixture.gateway(), isCurrent: { true }, accept: { _, _, _ in Issue.record("Unexpected projection") })
        await actions.refresh(AccountResourcesFixtures.target, using: connection)
        #expect(await recorder.requests.count == 1)
        #expect(actions.refreshes[.local]?[AccountResourcesFixtures.target]?.error?.contains("does not advertise") == true)
    }

    @Test func aRefreshStartedBeforeResetCannotOverwriteItsReadback() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        fixture.handler = { request in
            if request.url.path == "/v2/operations" { return (200, Data(AccountResourcesFixtures.catalog.utf8)) }
            if request.url.path == "/v2/quota" {
                await gate.pause()
                return (200, Data(AccountResourcesFixtures.resources.utf8))
            }
            return (200, try AccountResourcesFixtures.receipt(readback: "fresh"))
        }
        let actions = AccountsResourceActions()
        var commits = 0
        let connection = AccountResourceConnection(location: .local, client: fixture.gateway(),
            isCurrent: { true }, accept: { _, _, _ in commits += 1 })
        let refreshing = Task { await actions.refresh(AccountResourcesFixtures.target, using: connection) }
        await gate.waitForStart()
        await actions.startReset(AccountResourcesFixtures.request, label: "Reset", using: connection)
        #expect(commits == 1)
        await gate.finish()
        await refreshing.value
        #expect(commits == 1)
        #expect(actions.refreshes[.local]?[AccountResourcesFixtures.target]?.error?.contains("reset changed") == true)
    }

    @Test(arguments: [false, true], [false, true])
    func newerBackgroundReadOfSameTargetSurvivesLateCommandResponse(reset: Bool, equalTimestamp: Bool) async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        fixture.handler = { request in
            if request.url.path == "/v2/operations" { return (200, Data(AccountResourcesFixtures.catalog.utf8)) }
            await gate.pause()
            return reset ? (200, try AccountResourcesFixtures.receipt(readback: "fresh"))
                : (200, Data(AccountResourcesFixtures.resources.utf8))
        }
        let actions = AccountsResourceActions()
        var displayed: ControlQuotaResponse? = try AccountResourcesFixtures.quota()
        var displayGeneration: UInt64 = 1
        let connection = AccountResourceConnection(location: .local, client: fixture.gateway(),
            isCurrent: { true }, observe: { _ in AccountRequestObservation(displayGeneration: displayGeneration) },
            accept: { response, target, observation in
                // The background read below keeps this account's key: not a rebinding.
                displayed = response.replacingAccount(target, in: displayed, reboundSinceRequest: false,
                                                      preferPreviousOnTie: observation.displayGeneration != displayGeneration)
            })
        let command = Task {
            if reset { await actions.startReset(AccountResourcesFixtures.request, label: "Reset", using: connection) }
            else { await actions.refresh(AccountResourcesFixtures.target, using: connection) }
        }
        await gate.waitForStart()
        // The existing SSE/background owner publishes newer observations while
        // the direct HTTP response is held. No AppModel or live engine is used.
        let newer = AccountResourcesFixtures.resources
            .replacingOccurrences(of: "14:32:00+03:00", with: equalTimestamp ? "11:32:00Z" : "11:33:00Z")
            .replacingOccurrences(of: "\"available_count\":2", with: "\"available_count\":1")
            .replacingOccurrences(of: "\"used_ratio\":1", with: "\"used_ratio\":0.5")
        displayed = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(newer.utf8))
        let background = displayed
        displayGeneration += 1
        await gate.finish()
        await command.value
        #expect(displayed == background)
        #expect(displayed?.resources?.first?.resets.value?.first?.availableCount == 1)
        if reset {
            let attempt = try #require(actions.attempts(for: AccountResourcesFixtures.target, at: .local).last)
            #expect(attempt.receipt?.outcome == .reset && !attempt.inFlight && !attempt.unconfirmed)
        } else {
            #expect(actions.refreshes[.local]?[AccountResourcesFixtures.target]?.inFlight == false)
            #expect(actions.refreshes[.local]?[AccountResourcesFixtures.target]?.error == nil)
        }
    }

    @Test func presentationKeepsIndependentFactsAndProviderKinds() throws {
        let redeemed = try AccountResourcesFixtures.attempt("already_redeemed")
        let used = try AccountResourcesFixtures.attempt("already_used")
        #expect(AccountResourcePresentation.status(redeemed) == "Reset applied")
        #expect(!redeemed.unconfirmed && used.unconfirmed)
        #expect(AccountResourcePresentation.status(used).contains("unconfirmed"))
        #expect(AccountResourcePresentation.amount("0", unit: "credits", currency: nil) == "0 credits")
        #expect(AccountResourcePresentation.amount(nil, unit: "credits", currency: nil) == "Unknown")
        #expect(AccountResourcePresentation.amount("12.3400", unit: "USD", currency: "USD") == "12.3400 USD")
        #expect(AccountResourcePresentation.amount("1234.00", unit: "minor", currency: "USD", decimalPlaces: 2) == "12.3400 USD")
        #expect(AccountResourcePresentation.amount("1.25", unit: "minor", currency: "USD", decimalPlaces: 4) == "0.000125 USD")
        #expect(AccountResourcePresentation.amount("0", unit: "minor", currency: "USD", decimalPlaces: 2) == "0.00 USD")
        #expect(AccountResourcePresentation.amount("1234", unit: "minor", currency: "USD").contains("scale unknown"))
        #expect(AccountResourcePresentation.scaledDecimal("1234567890123456789012345678901234567890", places: 2) == "12345678901234567890123456789012345678.90")
        #expect(AccountResourcePresentation.scaledDecimal("1e-7", places: 2) == "0.000000001")
        let snapshot = try #require(AccountResourcesFixtures.quota().resources?.first)
        let offer = try #require(snapshot.resets.value?.last)
        #expect(AccountResourcePresentation.action(offer) == "Refill session")
        #expect(AccountResourcePresentation.confirmation(account: "Disabled", offer: offer, grant: nil,
            freshness: .unknown, previous: nil).contains("Weekly quota still applies and is not replenished"))
        #expect(AccountResourcePresentation.summary(snapshot, attempts: [redeemed]).contains("Last reported: 2 resets"))
        #expect(snapshot.resets.value?.first?.availableCount == 2)
        #expect(snapshot.resets.value?.first?.grants?.count == 1)
        let grantOffer = try #require(snapshot.resets.value?.first)
        let grantMessage = AccountResourcePresentation.confirmation(account: "Work", offer: grantOffer,
            grant: grantOffer.grants?.first, freshness: .fresh, previous: nil)
        #expect(grantMessage.contains("5-hour and weekly included limits"))
        #expect(!grantMessage.contains("five_hour") && !grantMessage.contains("seven_day"))
    }

    @Test func usableRefillWithoutCountStaysAvailableAndKnownZeroIsEmpty() throws {
        let snapshot = try #require(AccountResourcesFixtures.quota().resources?.first)
        let refill = try #require(snapshot.resets.value?.last)
        #expect(refill.kind == .sessionRefill && refill.availableCount == nil && refill.usableNow == true)
        #expect(AccountResourcePresentation.inventory(refill.availableCount, usableNow: refill.usableNow,
                                                      freshness: .fresh) == "Available now")
        #expect(AccountResourcePresentation.inventory(2, usableNow: false, freshness: .fresh) == "Unavailable now · 2 remaining")
        #expect(AccountResourcePresentation.inventory(0, usableNow: nil, freshness: .fresh) == "Unavailable now · 0 remaining")
        #expect(AccountResourcePresentation.inventory(nil, usableNow: true, freshness: .stale)
            == "Last reported: available · current availability unknown")
        #expect(AccountResourcePresentation.inventory(nil, usableNow: nil, freshness: .unknown) == "Availability unknown")
    }

    @Test func inlineFreshnessIsHumanAndSourceDetailsKeepExactEvidence() throws {
        let snapshot = try #require(AccountResourcesFixtures.quota().resources?.first)
        #expect(AccountResourcePresentation.freshness(snapshot.balances) == "Last known · Last check failed")
        #expect(AccountResourcePresentation.freshness(snapshot.resets) == "Updated")
        #expect(AccountResourcePresentation.freshness(snapshot.resets, override: .stale) == "Last known")
        let source = AccountResourcePresentation.sourceDetails(snapshot.balances)
        #expect(source.contains("Last error: not_reported"))
        #expect(source.contains("Observed: 2026-10-09T14:28:00+03:00"))
        #expect(source.contains("Last checked: 2026-10-09T14:32:00+03:00"))
        #expect(source.contains("Source: provider"))
    }
}
