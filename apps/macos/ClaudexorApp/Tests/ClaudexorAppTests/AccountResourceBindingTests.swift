import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

/// Loopback fixtures for the suite below; not actor-isolated, so the
/// URLProtocol handlers can build their responses off the main actor.
private enum Binding {
    static let key = AccountTarget(harness: "openrouter", profileId: nil)
    static let work = AccountTarget(harness: "openrouter", profileId: "work")
    static let keyA = "aaaaaaaaaaaaaaaa", keyB = "bbbbbbbbbbbbbbbb", workKey = "cccccccccccccccc"
    static let otherDefaultKey = "dddddddddddddddd"
    static let catalog: String = {
        let parameters = #"{"name":"view","location":"query","enum":["resources"]},{"name":"includeApiKeys","location":"query","enum":["true","false"]}"#
        let operations = ["get:quota", "post:quota", "get:credential-profiles"]
            .map { #"{"id":"\#($0)","parameters":[\#(parameters)]}"# }.joined(separator: ",")
        return #"{"operations":[\#(operations)]}"#
    }()
    static let empty = #"{"value":null,"source":null,"observed_at":null,"freshness":"unknown","last_attempt_at":null,"last_error":null}"#
    static func row(_ fingerprint: String, profile: String? = nil, left: String) -> String {
        let spending = #"{"value":[{"id":"openrouter_key_limit","label":"Key limit","enabled":null,"used":"12.34","limit":"50","unit":"USD","currency":"USD","decimal_places":null,"fee_included":null,"resets_at":null,"reason":"Display only","capped":true,"remaining":"\#(left)","window":"month"}],"source":"openrouter_key","observed_at":"2026-10-29T08:10:00Z","freshness":"fresh","last_attempt_at":"2026-10-29T08:10:00Z","last_error":null}"#
        return #"{"target":{"harness":"openrouter","profile_id":\#(profile.map { "\"\($0)\"" } ?? "null")},"credential_fingerprint":"\#(fingerprint)","balances":\#(empty),"spending":\#(spending),"resets":\#(empty),"diagnostics":\#(empty)}"#
    }
    static func unread(_ fingerprint: String, profile: String? = nil) -> String {
        #"{"target":{"harness":"openrouter","profile_id":\#(profile.map { "\"\($0)\"" } ?? "null")},"credential_fingerprint":"\#(fingerprint)","balances":\#(empty),"spending":\#(empty),"resets":\#(empty),"diagnostics":\#(empty)}"#
    }
    /// The other account beside `profile`: the work key beside the default key, the
    /// default key beside a named one.
    static func other(for profile: String?, left: String = "4") -> String {
        profile == nil ? row(workKey, profile: "work", left: left) : row(otherDefaultKey, left: left)
    }
    static func targets(_ request: ResourceRecordedRequest, _ profile: String?) -> Bool {
        let json = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
        let value = (json?["target"] as? [String: Any])?["profile_id"]
        return profile.map { value as? String == $0 } ?? (value is NSNull)
    }
    static func body(_ rows: String...) -> Data {
        Data(#"{"snapshots":[],"absences":[],"refreshed_at":null,"resources":[\#(rows.joined(separator: ","))]}"#.utf8)
    }
    static func isDefaultTarget(_ request: ResourceRecordedRequest) -> Bool {
        let json = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
        return (json?["target"] as? [String: Any])?["profile_id"] is NSNull
    }
    static let unavailable = (503, Data(#"{"type":"about:blank","title":"Unavailable","status":503,"detail":"Display read unavailable."}"#.utf8))
}

/// Numbers the display reads a handler serves, so one test can commit B and then A.
private actor ReadSequence {
    private var served = 0
    func next() -> Int { served += 1; return served }
}

/// What display reads answer now; a test switches it between the app's writes.
actor AccountResourceDisplayReads {
    private var answer: (Int, Data)
    init(_ answer: (Int, Data)) { self.answer = answer }
    func set(_ value: (Int, Data)) { answer = value }
    func next() -> (Int, Data) { answer }
}

/// The app's own credential writes for one account, through the real AppModel calls.
enum AccountResourceOwnWrite: String, CaseIterable, Sendable {
    case storeDefaultKey, enableNamedProfile, removeNamedProfile
    var profile: String? { self == .storeDefaultKey ? nil : "work" }
}

private extension Binding {
    static let workEntry = #"{"profile":{"profile_id":"work","harness_id":"openrouter","display_name":"Work key","credential_kind":"api_key","isolation_locator":null,"secret_ref":"openrouter:work","enabled":true},"status":{"profile_id":"work","harness_id":"openrouter","availability":"available","verification":"not_run","verification_source":"local_store","detail":"Managed secret openrouter:work is present.","last_verified_at":null}}"#
    /// A controlled engine: the addressed refresh is held at `gate`; display reads
    /// answer from `reads`; the app's writes are acknowledged unless
    /// `refuseSecretWrites`; every other read is unavailable.
    static func engine(target profile: String?, gate: ResourceResponseGate, refreshReply: Data,
                       reads: AccountResourceDisplayReads, refuseSecretWrites: Bool = false) -> ResourceAppProtocol.Handler {
        { request in
            switch (request.method, request.url.path) {
            case ("GET", "/v2/operations"): return (200, Data(catalog.utf8))
            case ("POST", "/v2/quota"):
                if targets(request, profile) { await gate.pause() }
                return (200, refreshReply)
            case ("GET", "/v2/quota"): return await reads.next()
            case ("POST", "/v2/secrets"):
                return refuseSecretWrites ? unavailable : (200, Data(#"{"name":"openrouter","backend":"file","stored":true}"#.utf8))
            case ("PATCH", "/v2/credential-profiles/openrouter/work"): return (200, Data(workEntry.utf8))
            case ("DELETE", "/v2/credential-profiles/openrouter/work"):
                return (200, Data(#"{"removed":true,"credentialCleanup":"secret_deleted"}"#.utf8))
            default: return unavailable
            }
        }
    }
}

/// An exact key refresh against the real AppModel connection and accept path,
/// with loopback URLProtocol responses only (no socket, daemon, credentials or
/// provider). Another key's reply, or a missing row, stands unless a committed
/// snapshot changed THIS account's binding while the request ran, even if it
/// changed back.
@MainActor @Suite(.serialized)
struct AccountResourceBindingTests {
    /// Key A shown with fresh figures and the work key beside it, as a display read left them.
    func model(_ fixture: ResourceAppFixture) throws -> AppModel {
        let model = AppModel(client: fixture.gateway(), requestNotificationAuthorization: false)
        model.storeAccountsQuotaSnapshot(try JSONDecoder().decode(ControlQuotaResponse.self, from: Binding.body(
            Binding.row(Binding.keyA, left: "37.66"), Binding.row(Binding.workKey, profile: "work", left: "4"))), at: .local)
        return model
    }
    func shown(_ model: AppModel, _ target: AccountTarget = Binding.key) -> AccountResourceSnapshot? {
        model.quotaResponse(at: .local)?.resources?.first { $0.target == target }
    }
    func settled(_ model: AppModel, _ what: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(30))
        while model.accountsQuotaDisplayTasks[.local] != nil, ContinuousClock.now <= deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        try #require(model.accountsQuotaDisplayTasks[.local] == nil, Comment(rawValue: what))
    }

    @Test func aDisplayReadThatFailsDoesNotHideTheNewKeysReply() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        fixture.handler = { request in
            switch (request.method, request.url.path) {
            case ("GET", "/v2/operations"): return (200, Data(Binding.catalog.utf8))
            case ("POST", "/v2/quota"):
                await gate.pause()   // Read with key B, the engine's key now.
                return (200, Binding.body(Binding.row(Binding.keyB, left: "9.50"), Binding.row(Binding.workKey, profile: "work", left: "3")))
            default: return Binding.unavailable   // Every display read fails: key A stays shown.
            }
        }
        let model = try model(fixture)
        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await settled(model, "the subscription's first display read never settled")
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(Binding.key, using: connection) }
        await gate.waitForStart()
        let atRequest = model.accountsQuotaDisplayGenerations[.local] ?? 0
        // A quota-stream update starts another display read while the refresh runs; it fails.
        await model.handleGlobalEvent(JournalEvent(cursor: "binding:1", partition: "global",
            type: AppModel.quotaProjectionMarker, observedAt: "2026-10-29T08:11:00Z", payload: .object([:])))
        try await settled(model, "the marker's display read never settled")
        #expect((model.accountsQuotaDisplayGenerations[.local] ?? 0) > atRequest)
        #expect(shown(model)?.credentialFingerprint == Binding.keyA)
        await gate.finish()
        await refresh.value
        #expect(shown(model)?.credentialFingerprint == Binding.keyB)
        #expect(shown(model)?.spending.value?.first?.remaining == "9.50")
        #expect(model.accountResourceActions.refreshes[.local]?[Binding.key]?.error == nil)
        #expect(shown(model, Binding.work)?.spending.value?.first?.remaining == "4")
    }

    @Test func anotherAccountsRefreshDoesNotHideTheNewKeysReply() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        fixture.handler = { request in
            switch (request.method, request.url.path) {
            case ("GET", "/v2/operations"): return (200, Data(Binding.catalog.utf8))
            case ("POST", "/v2/quota"):
                if Binding.isDefaultTarget(request) { await gate.pause() }
                return (200, Binding.body(Binding.row(Binding.keyB, left: "9.50"), Binding.row(Binding.workKey, profile: "work", left: "3")))
            default: return Binding.unavailable
            }
        }
        let model = try model(fixture)
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(Binding.key, using: connection) }
        await gate.waitForStart()
        // The work key's own refresh commits only its row, and advances the generation.
        await model.accountResourceActions.refresh(Binding.work, using: connection)
        #expect(shown(model, Binding.work)?.spending.value?.first?.remaining == "3")
        #expect(shown(model)?.credentialFingerprint == Binding.keyA)
        await gate.finish()
        await refresh.value
        #expect(shown(model)?.credentialFingerprint == Binding.keyB)
        #expect(shown(model)?.spending.value?.first?.remaining == "9.50")
        #expect(model.accountResourceActions.refreshes[.local]?[Binding.key]?.error == nil)
        #expect(shown(model, Binding.work)?.spending.value?.first?.remaining == "3")
    }

    @Test func aLateReplyCannotRestoreAKeyRemovedWhileItRan() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        fixture.handler = { request in
            switch (request.method, request.url.path) {
            case ("GET", "/v2/operations"): return (200, Data(Binding.catalog.utf8))
            case ("POST", "/v2/quota"):
                await gate.pause()   // Read with key A before it was removed.
                return (200, Binding.body(Binding.row(Binding.keyA, left: "36.10"), Binding.row(Binding.workKey, profile: "work", left: "4")))
            default:   // The key is gone: the engine publishes no default row.
                return (200, Binding.body(Binding.row(Binding.workKey, profile: "work", left: "4")))
            }
        }
        let model = try model(fixture)
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(Binding.key, using: connection) }
        await gate.waitForStart()
        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await settled(model, "the removal's display read never settled")
        #expect(shown(model) == nil)
        await gate.finish()
        await refresh.value
        #expect(shown(model) == nil)
        #expect(shown(model, Binding.work)?.credentialFingerprint == Binding.workKey)
    }

    @Test func aLateReplyCannotRestoreAKeyReplacedWhileItRan() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        fixture.handler = { request in
            switch (request.method, request.url.path) {
            case ("GET", "/v2/operations"): return (200, Data(Binding.catalog.utf8))
            case ("POST", "/v2/quota"):
                await gate.pause()   // Read with key A before it was replaced.
                return (200, Binding.body(Binding.row(Binding.keyA, left: "36.10"), Binding.row(Binding.workKey, profile: "work", left: "4")))
            default:   // The engine binds key B now and has not read it yet.
                return (200, Binding.body(Binding.unread(Binding.keyB), Binding.row(Binding.workKey, profile: "work", left: "4")))
            }
        }
        let model = try model(fixture)
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(Binding.key, using: connection) }
        await gate.waitForStart()
        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await settled(model, "the replacement's display read never settled")
        #expect(shown(model)?.credentialFingerprint == Binding.keyB)
        await gate.finish()
        await refresh.value
        #expect(shown(model)?.credentialFingerprint == Binding.keyB)
        #expect(shown(model)?.spending.value == nil)
    }

    /// Key A, then B, then A again, all committed while one exact refresh ran: its
    /// late reply, read with B, must not overwrite the A shown now.
    @Test(arguments: [nil, "work"] as [String?])
    func aLateReplyCannotOverwriteAKeyThatCameBackWhileItRan(profile: String?) async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        let reads = ReadSequence()
        let target = AccountTarget(harness: "openrouter", profileId: profile)
        fixture.handler = { request in
            switch (request.method, request.url.path) {
            case ("GET", "/v2/operations"): return (200, Data(Binding.catalog.utf8))
            case ("POST", "/v2/quota"):
                await gate.pause()   // Read with key B, bound at the engine while it ran.
                return (200, Binding.body(Binding.row(Binding.keyB, profile: profile, left: "9.50"), Binding.other(for: profile)))
            default:   // The display commits B, then A again.
                return await reads.next() == 1
                    ? (200, Binding.body(Binding.unread(Binding.keyB, profile: profile), Binding.other(for: profile)))
                    : (200, Binding.body(Binding.row(Binding.keyA, profile: profile, left: "36.10"), Binding.other(for: profile)))
            }
        }
        let model = AppModel(client: fixture.gateway(), requestNotificationAuthorization: false)
        model.storeAccountsQuotaSnapshot(try JSONDecoder().decode(ControlQuotaResponse.self, from: Binding.body(
            Binding.row(Binding.keyA, profile: profile, left: "37.66"), Binding.other(for: profile))), at: .local)
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(target, using: connection) }
        await gate.waitForStart()
        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await settled(model, "the display read that binds B never settled")
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyB)
        await model.handleGlobalEvent(JournalEvent(cursor: "aba:\(profile ?? "default")", partition: "global",
            type: AppModel.quotaProjectionMarker, observedAt: "2026-10-29T08:12:00Z", payload: .object([:])))
        try await settled(model, "the display read that binds A again never settled")
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyA)
        await gate.finish()
        await refresh.value
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyA)
        #expect(shown(model, target)?.spending.value?.first?.remaining == "36.10")
        #expect(model.accountResourceActions.refreshes[.local]?[target]?.error == nil)
    }

    /// Another account's committed refresh and a failed display read change nothing
    /// for this account: the new key's reply stands, for the default and a named key.
    @Test(arguments: [nil, "work"] as [String?])
    func aNewKeysReplyStandsAfterAnotherAccountsCommitAndAFailedRead(profile: String?) async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        let target = AccountTarget(harness: "openrouter", profileId: profile)
        let otherTarget = AccountTarget(harness: "openrouter", profileId: profile == nil ? "work" : nil)
        fixture.handler = { request in
            switch (request.method, request.url.path) {
            case ("GET", "/v2/operations"): return (200, Data(Binding.catalog.utf8))
            case ("POST", "/v2/quota"):
                if Binding.targets(request, profile) { await gate.pause() }
                return (200, Binding.body(Binding.row(Binding.keyB, profile: profile, left: "9.50"),
                                          Binding.other(for: profile, left: "3")))
            default: return Binding.unavailable
            }
        }
        let model = AppModel(client: fixture.gateway(), requestNotificationAuthorization: false)
        model.storeAccountsQuotaSnapshot(try JSONDecoder().decode(ControlQuotaResponse.self, from: Binding.body(
            Binding.row(Binding.keyA, profile: profile, left: "37.66"), Binding.other(for: profile))), at: .local)
        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        try await settled(model, "the subscription's first display read never settled")
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(target, using: connection) }
        await gate.waitForStart()
        await model.accountResourceActions.refresh(otherTarget, using: connection)
        await model.handleGlobalEvent(JournalEvent(cursor: "unrelated:\(profile ?? "default")", partition: "global",
            type: AppModel.quotaProjectionMarker, observedAt: "2026-10-29T08:12:00Z", payload: .object([:])))
        try await settled(model, "the marker's display read never settled")
        #expect(shown(model, otherTarget)?.spending.value?.first?.remaining == "3")
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyA)
        await gate.finish()
        await refresh.value
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyB)
        #expect(shown(model, target)?.spending.value?.first?.remaining == "9.50")
        #expect(model.accountResourceActions.refreshes[.local]?[target]?.error == nil)
        #expect(shown(model, otherTarget)?.spending.value?.first?.remaining == "3")
    }

    /// A display read commits while the user's exact refresh of key A runs. If the
    /// first capability negotiation failed, that read is the legacy quota projection:
    /// it omits resources, so it removes no key and the refresh's newer reading of A
    /// stands. A read that returns an empty list removes the key, and the late reply
    /// cannot bring it back.
    @Test(arguments: [true, false])
    func onlyAnEmptyResourceListRemovesTheKeyARefreshReads(omitsResources: Bool) async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let display = ResourceResponseGate(), exact = ResourceResponseGate()
        let negotiations = ReadSequence(), recorder = ResourceAppRecorder()
        let reply = Binding.body(Binding.row(Binding.keyA, left: "36.10")
            .replacingOccurrences(of: "08:10:00Z", with: "08:20:00Z"), Binding.other(for: nil))
        fixture.handler = { request in
            await recorder.record(request)
            switch (request.method, request.url.path) {
            case ("GET", "/v2/operations"):
                // The display read's negotiation fails; the user's Refresh negotiates again.
                let first = await negotiations.next() == 1
                return omitsResources && first ? Binding.unavailable : (200, Data(Binding.catalog.utf8))
            case ("GET", "/v2/quota"):
                await display.pause()
                return (200, omitsResources ? Data(#"{"snapshots":[],"absences":[],"refreshed_at":null}"#.utf8) : Binding.body())
            case ("POST", "/v2/quota"):
                await exact.pause()
                return (200, reply)
            default: return Binding.unavailable
            }
        }
        let model = try model(fixture)
        let subscription = model.beginAccountsQuotaSubscription()
        defer { model.endAccountsQuotaSubscription(subscription) }
        await display.waitForStart()
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(Binding.key, using: connection) }
        await exact.waitForStart()
        await display.finish()
        try await settled(model, "the display read never settled")
        #expect(shown(model)?.credentialFingerprint == (omitsResources ? Binding.keyA : nil))
        await exact.finish()
        await refresh.value
        let rich = "view=resources&includeApiKeys=true"
        let requests = await recorder.requests.map { "\($0.method) \($0.url.path)" + ($0.url.query.map { "?\($0)" } ?? "") }
            .filter { $0.hasSuffix("/v2/operations") || $0.contains("/v2/quota") }
        #expect(requests == (omitsResources
            ? ["GET /v2/operations", "GET /v2/quota", "GET /v2/operations", "POST /v2/quota?\(rich)"]
            : ["GET /v2/operations", "GET /v2/quota?\(rich)", "POST /v2/quota?\(rich)"]))
        #expect(model.accountResourceActions.refreshes[.local]?[Binding.key]?.error == nil)
        if omitsResources {
            #expect(shown(model)?.credentialFingerprint == Binding.keyA)
            #expect(shown(model)?.spending.value?.first?.remaining == "36.10")
            #expect(shown(model, Binding.work)?.credentialFingerprint == Binding.workKey)
        } else {
            #expect(shown(model) == nil)
            #expect(shown(model, Binding.work) == nil)
        }
    }

    func perform(_ write: AccountResourceOwnWrite, _ model: AppModel) async -> Bool {
        switch write {
        case .storeDefaultKey:
            return await model.storeSecret(name: "openrouter", value: "fixture-binding-synthetic-key", for: .openrouter).stored
        case .enableNamedProfile:
            return await model.setProfileEnabled(harnessId: "openrouter", profileId: "work", enabled: true) == nil
        case .removeNamedProfile:
            return await !model.deleteCredentialProfile(harnessId: "openrouter", profileId: "work").isError
        }
    }

    /// Key A shown for the written account, beside the other account, with a subscriber.
    func writeScene(_ fixture: ResourceAppFixture, _ profile: String?, gate: ResourceResponseGate,
                    reads: AccountResourceDisplayReads, refuseSecretWrites: Bool = false) async throws -> (AppModel, AccountsQuotaSubscription) {
        fixture.handler = Binding.engine(target: profile, gate: gate, refreshReply: Binding.body(
            Binding.row(Binding.keyB, profile: profile, left: "9.50"), Binding.other(for: profile, left: "3")),
            reads: reads, refuseSecretWrites: refuseSecretWrites)
        let model = AppModel(client: fixture.gateway(), requestNotificationAuthorization: false)
        model.storeAccountsQuotaSnapshot(try JSONDecoder().decode(ControlQuotaResponse.self, from: Binding.body(
            Binding.row(Binding.keyA, profile: profile, left: "37.66"), Binding.other(for: profile))), at: .local)
        let subscription = model.beginAccountsQuotaSubscription()
        try await settled(model, "the subscription's first display read never settled")
        return (model, subscription)
    }
    func shownA(_ profile: String?) -> (Int, Data) {
        (200, Binding.body(Binding.row(Binding.keyA, profile: profile, left: "37.66"), Binding.other(for: profile)))
    }

    /// The app stores key B (its readback fails, so A stays shown), a refresh runs with
    /// B at the engine, then the app stores A again and that readback commits A: the
    /// late reply read with B cannot make B current. Default key only: the app stores
    /// no named key.
    @Test func aLateReplyCannotInstallAKeyTheAppReplacedWhileItRan() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        let reads = AccountResourceDisplayReads(shownA(nil))
        let (model, subscription) = try await writeScene(fixture, nil, gate: gate, reads: reads)
        defer { model.endAccountsQuotaSubscription(subscription) }
        await reads.set(Binding.unavailable)
        #expect(await perform(.storeDefaultKey, model))
        try await settled(model, "B's readback never settled")
        #expect(shown(model)?.credentialFingerprint == Binding.keyA)
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(Binding.key, using: connection) }
        await gate.waitForStart()
        await reads.set((200, Binding.body(Binding.row(Binding.keyA, left: "36.10"), Binding.other(for: nil))))
        #expect(await perform(.storeDefaultKey, model))
        try await settled(model, "A's readback never settled")
        #expect(shown(model)?.spending.value?.first?.remaining == "36.10")
        await gate.finish()
        await refresh.value
        #expect(shown(model)?.credentialFingerprint == Binding.keyA)
        #expect(shown(model)?.spending.value?.first?.remaining == "36.10")
        #expect(model.accountResourceActions.refreshes[.local]?[Binding.key]?.error == nil)
    }

    /// A reply begun before the app's acknowledged write of its exact account cannot
    /// install another key, even though the readback that would show the write failed.
    @Test(arguments: AccountResourceOwnWrite.allCases)
    func aReplyBegunBeforeAnOwnWriteCannotInstallAnotherKey(write: AccountResourceOwnWrite) async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        let reads = AccountResourceDisplayReads(shownA(write.profile))
        let target = AccountTarget(harness: "openrouter", profileId: write.profile)
        let (model, subscription) = try await writeScene(fixture, write.profile, gate: gate, reads: reads)
        defer { model.endAccountsQuotaSubscription(subscription) }
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(target, using: connection) }
        await gate.waitForStart()
        await reads.set(Binding.unavailable)
        #expect(await perform(write, model))
        try await settled(model, "the write's readback never settled")
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyA)
        await gate.finish()
        await refresh.value
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyA)
        #expect(shown(model, target)?.spending.value?.first?.remaining == "37.66")
    }

    /// A refresh begun after the app's acknowledged write installs the key it was read
    /// with, although the write's readback failed and another display read fails meanwhile.
    @Test(arguments: [AccountResourceOwnWrite.storeDefaultKey, .enableNamedProfile])
    func aRefreshBegunAfterAnOwnWriteInstallsTheCurrentKey(write: AccountResourceOwnWrite) async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        let reads = AccountResourceDisplayReads(shownA(write.profile))
        let target = AccountTarget(harness: "openrouter", profileId: write.profile)
        let (model, subscription) = try await writeScene(fixture, write.profile, gate: gate, reads: reads)
        defer { model.endAccountsQuotaSubscription(subscription) }
        await reads.set(Binding.unavailable)
        #expect(await perform(write, model))
        try await settled(model, "the write's readback never settled")
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyA)
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(target, using: connection) }
        await gate.waitForStart()
        await model.handleGlobalEvent(JournalEvent(cursor: "after-write:\(write.rawValue)", partition: "global",
            type: AppModel.quotaProjectionMarker, observedAt: "2026-10-29T08:12:00Z", payload: .object([:])))
        try await settled(model, "the marker's display read never settled")
        await gate.finish()
        await refresh.value
        #expect(shown(model, target)?.credentialFingerprint == Binding.keyB)
        #expect(shown(model, target)?.spending.value?.first?.remaining == "9.50")
        #expect(model.accountResourceActions.refreshes[.local]?[target]?.error == nil)
    }

    /// Another account's acknowledged write and the engine refusing this account's key
    /// write change nothing for the default key's reply.
    @Test func anotherAccountsWriteAndARefusedKeyWriteKeepTheReply() async throws {
        let fixture = ResourceAppFixture()
        defer { fixture.handler = nil }
        let gate = ResourceResponseGate()
        let reads = AccountResourceDisplayReads(shownA(nil))
        let (model, subscription) = try await writeScene(fixture, nil, gate: gate, reads: reads, refuseSecretWrites: true)
        defer { model.endAccountsQuotaSubscription(subscription) }
        let connection = try #require(model.accountResourceConnection(at: .local))
        let refresh = Task { await model.accountResourceActions.refresh(Binding.key, using: connection) }
        await gate.waitForStart()
        #expect(await perform(.enableNamedProfile, model))
        #expect(await !perform(.storeDefaultKey, model))
        await gate.finish()
        await refresh.value
        #expect(shown(model)?.credentialFingerprint == Binding.keyB)
        #expect(shown(model)?.spending.value?.first?.remaining == "9.50")
        #expect(model.accountResourceActions.refreshes[.local]?[Binding.key]?.error == nil)
    }
}
