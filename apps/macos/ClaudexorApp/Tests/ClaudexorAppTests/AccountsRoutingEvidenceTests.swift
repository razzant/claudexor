import Foundation
import Testing
@testable import ClaudexorApp
import ClaudexorKit

/// One request path → (status, body) table for this suite's gateway.
private final class RoutingEvidenceProtocol: URLProtocol {
    nonisolated(unsafe) static var routes: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var requested: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.requested.append(path)
        let (status, body) = Self.routes[path] ?? (404, #"{"code":"not_found","message":"no route"}"#)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func gateway() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Self.self]
        return GatewayClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture",
                             session: URLSession(configuration: configuration))
    }
}

/// Holds each read of the listed paths until the test answers it, so
/// completions arrive in any order; every other path answers at once.
private actor HeldReads {
    private var held: [String: [CheckedContinuation<(Int, String), Never>]] = [:]
    func hold(_ path: String) async -> (Int, String) {
        await withCheckedContinuation { held[path, default: []].append($0) }
    }
    func count(_ path: String) -> Int { held[path]?.count ?? 0 }
    func answer(_ path: String, _ index: Int, _ status: Int, _ body: String) {
        held[path]![index].resume(returning: (status, body))
    }
}

/// Foundation callback bridge for one request (see ResourceProtocolCallback).
private struct HeldDelivery: @unchecked Sendable {
    let deliver: ((status: Int, body: String)) -> Void
}

private final class HeldReadProtocol: URLProtocol {
    nonisolated(unsafe) static var reads = HeldReads()
    nonisolated(unsafe) static var heldPaths: Set<String> = []
    nonisolated(unsafe) static var answers: [String: (Int, String)] = [:]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let delivery = HeldDelivery { [self] reply in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: reply.status,
                httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        let (reads, held) = (Self.reads, Self.heldPaths.contains(url.path))
        let now = Self.answers[url.path] ?? (404, #"{"code":"not_found","message":"no route"}"#)
        Task { delivery.deliver(held ? await reads.hold(url.path) : now) }
    }
    override func stopLoading() {}
    static func reset(holding paths: Set<String>, answers: [String: (Int, String)]) {
        reads = HeldReads()
        heldPaths = paths
        self.answers = answers
    }
    static func gateway() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Self.self]
        return GatewayClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture",
                             session: URLSession(configuration: configuration))
    }
    /// Bounded wait until `count` reads of `path` are held; false if they never arrive.
    static func arrived(_ count: Int, _ path: String) async -> Bool {
        for _ in 0..<300 {
            if await reads.count(path) >= count { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
}

@Suite(.serialized)
struct AccountsRoutingEvidenceTests {
    static let current = #"{"operations":[{"id":"get:credential-profiles"},{"id":"get:accounts.routing-evidence"}]}"#
    static let older = #"{"operations":[{"id":"get:credential-profiles"}]}"#
    static let evidence = """
    {"refusals":[
      {"harness_id":"claude","profile_id":"work","requested_model":"grok-4.7",
       "observed_at":"2026-10-13T08:00:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"},
      {"harness_id":"claude","profile_id":"work","requested_model":null,
       "observed_at":"2026-10-13T08:01:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"},
      {"harness_id":"claude","profile_id":"work","requested_model":"expired-model",
       "observed_at":"2020-01-01T00:00:00.000Z","expires_at":"2020-01-01T01:00:00.000Z"}],
     "lastService":[
      {"harness_id":"claude","profile_id":"work","requested_model":"grok-4.7","observed_at":"2026-10-13T07:00:00.000Z"},
      {"harness_id":"claude","profile_id":"work","requested_model":null,"observed_at":"2026-10-13T06:00:00.000Z"}]}
    """
    static func profiles(workEnabled: Bool = true) throws -> [CredentialProfileEntry] {
        let json = """
        [{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":\(workEnabled)},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}},
         {"profile":{"profile_id":"spare","harness_id":"claude","display_name":"Spare",
          "credential_kind":"config_dir_login","enabled":true},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]
        """
        return try JSONDecoder().decode([CredentialProfileEntry].self, from: Data(json.utf8))
    }

    @MainActor
    func connectedModel() throws -> (AppModel, GatewayClient) {
        let client = RoutingEvidenceProtocol.gateway()
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        model.health = .connected
        model.credentialProfiles = try Self.profiles()
        return (model, client)
    }

    @MainActor
    @Test func evidenceJoinsRowsByAccountAndSurvivesARowReplacement() async throws {
        defer { RoutingEvidenceProtocol.routes = [:]; RoutingEvidenceProtocol.requested = [] }
        RoutingEvidenceProtocol.routes = [
            "/v2/operations": (200, Self.current),
            "/v2/accounts/routing-evidence": (200, Self.evidence),
        ]
        let (model, client) = try connectedModel()
        await model.refreshAccountsRoutingEvidence(at: .local, client: client)
        var rows = AccountsPresentation.rows(model: model)
        let work = try #require(rows.first { $0.profileId == "work" })
        // Expired marks are hidden; several models per account stay distinct.
        #expect(work.refusalMarks.map(\.requestedModel) == ["grok-4.7", nil])
        #expect(AccountsPresentation.refusalLine(work.refusalMarks) == "Recent refusal · grok-4.7, default model")
        let served = try #require(AccountsPresentation.lastServedLine(work.lastService))
        #expect(served.hasPrefix("Last served · grok-4.7 · "))
        #expect(served.contains("; default model · "))
        let spare = try #require(rows.first { $0.profileId == "spare" })
        #expect(AccountsPresentation.refusalLine(spare.refusalMarks) == nil)
        #expect(AccountsPresentation.lastServedLine(spare.lastService) == nil)
        #expect(model.accountsRoutingEvidence.problems[.local] == nil)
        // An Enabled PATCH replaces the row DTO; the separately held evidence stays joined.
        model.credentialProfiles = try Self.profiles(workEnabled: false)
        rows = AccountsPresentation.rows(model: model)
        let patched = try #require(rows.first { $0.profileId == "work" })
        #expect(patched.enabled == false)
        #expect(patched.refusalMarks.count == 2)
        #expect(patched.lastService.count == 2)
    }

    @MainActor
    @Test func anOlderEngineIsNeverAskedAndShowsNothingNew() async throws {
        defer { RoutingEvidenceProtocol.routes = [:]; RoutingEvidenceProtocol.requested = [] }
        RoutingEvidenceProtocol.routes = ["/v2/operations": (200, Self.older)]
        let (model, client) = try connectedModel()
        await model.refreshAccountsRoutingEvidence(at: .local, client: client)
        #expect(!RoutingEvidenceProtocol.requested.contains("/v2/accounts/routing-evidence"))
        #expect(model.accountsRoutingEvidence.evidence[.local] == nil)
        #expect(model.accountsRoutingEvidence.problems[.local] == nil)
        #expect(AccountsPresentation.rows(model: model).allSatisfy { $0.refusalMarks.isEmpty })
    }

    @MainActor
    @Test func aFailedAuxiliaryReadIsOneNoticeAndNeverHidesTheRows() async throws {
        defer { RoutingEvidenceProtocol.routes = [:]; RoutingEvidenceProtocol.requested = [] }
        RoutingEvidenceProtocol.routes = [
            "/v2/operations": (200, Self.current),
            "/v2/accounts/routing-evidence": (500, #"{"code":"internal","message":"store unavailable"}"#),
        ]
        let (model, client) = try connectedModel()
        await model.refreshAccountsRoutingEvidence(at: .local, client: client)
        let notice = try #require(model.accountsRoutingEvidence.problems[.local])
        #expect(notice.contains("HTTP 500"))
        #expect(notice.contains("Account rows are current"))
        let rows = AccountsPresentation.rows(model: model)
        #expect(rows.map(\.profileId) == ["work", "spare"])
        #expect(rows.allSatisfy { $0.refusalMarks.isEmpty && $0.lastService.isEmpty })
        // A later successful read clears the notice.
        RoutingEvidenceProtocol.routes["/v2/accounts/routing-evidence"] = (200, Self.evidence)
        await model.refreshAccountsRoutingEvidence(at: .local, client: client)
        #expect(model.accountsRoutingEvidence.problems[.local] == nil)
        #expect(model.accountsRoutingEvidence.evidence[.local]?.refusals.count == 3)
    }

    static let evidencePath = "/v2/accounts/routing-evidence"
    static let registryPath = "/v2/credential-profiles"
    /// One account's evidence: its last service of `model`, optionally with a live refusal mark.
    static func evidence(served model: String, marked: Bool = false) -> String {
        let mark = #"{"harness_id":"claude","profile_id":"work","requested_model":"\#(model)","#
            + #""observed_at":"2026-10-13T08:00:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"}"#
        return #"{"refusals":[\#(marked ? mark : "")],"lastService":[{"harness_id":"claude","#
            + #""profile_id":"work","requested_model":"\#(model)","observed_at":"2026-10-13T07:00:00.000Z"}]}"#
    }
    static func registry(workEnabled: Bool) -> String {
        """
        {"profiles":[{"profile":{"profile_id":"work","harness_id":"claude","display_name":"Work",
          "credential_kind":"config_dir_login","enabled":\(workEnabled)},
          "status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}],
         "accountPools":[]}
        """
    }

    @MainActor
    func heldModel(holding paths: Set<String>) throws -> (AppModel, GatewayClient) {
        HeldReadProtocol.reset(holding: paths, answers: [
            "/v2/operations": (200, Self.current),
            "/v2/credential-profiles/claude/work": (200, #"{"profile":{"profile_id":"work","harness_id":"claude","#
                + #""display_name":"Work","credential_kind":"config_dir_login","enabled":false},"status":"#
                + #"{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}"#),
        ])
        let client = HeldReadProtocol.gateway()
        let model = AppModel(client: client, requestNotificationAuthorization: false)
        model.health = .connected
        model.credentialProfiles = try Self.profiles()
        return (model, client)
    }

    @MainActor
    func served(_ model: AppModel) -> [String?] {
        model.accountsRoutingEvidence.lastService(harnessId: "claude", profileId: "work", at: .local)
            .map(\.requestedModel)
    }

    @MainActor
    @Test func anOlderReadAnsweringLastNeverReplacesANewerOne() async throws {
        let (model, client) = try heldModel(holding: [Self.evidencePath])
        // A hydration's unawaited read, then an explicit Refresh's read, both pending.
        let older = Task { await model.refreshAccountsRoutingEvidence(at: .local, client: client) }
        #expect(await HeldReadProtocol.arrived(1, Self.evidencePath))
        let newer = Task { await model.refreshAccountsRoutingEvidence(at: .local, client: client) }
        #expect(await HeldReadProtocol.arrived(2, Self.evidencePath))
        await HeldReadProtocol.reads.answer(Self.evidencePath, 1, 200, Self.evidence(served: "newer-model"))
        await newer.value
        #expect(served(model) == ["newer-model"])
        await HeldReadProtocol.reads.answer(Self.evidencePath, 0, 200, Self.evidence(served: "older-model"))
        await older.value
        #expect(served(model) == ["newer-model"])
    }

    @MainActor
    @Test func anOlderFailureAfterANewerSuccessNeitherErasesItNorWarns() async throws {
        let (model, client) = try heldModel(holding: [Self.evidencePath])
        let older = Task { await model.refreshAccountsRoutingEvidence(at: .local, client: client) }
        #expect(await HeldReadProtocol.arrived(1, Self.evidencePath))
        let newer = Task { await model.refreshAccountsRoutingEvidence(at: .local, client: client) }
        #expect(await HeldReadProtocol.arrived(2, Self.evidencePath))
        await HeldReadProtocol.reads.answer(Self.evidencePath, 1, 200, Self.evidence(served: "newer-model"))
        await newer.value
        await HeldReadProtocol.reads.answer(Self.evidencePath, 0, 500, #"{"code":"internal","message":"old"}"#)
        await older.value
        #expect(served(model) == ["newer-model"])
        #expect(model.accountsRoutingEvidence.problems[.local] == nil)
        // The primary rows never depended on the auxiliary read.
        #expect(AccountsPresentation.rows(model: model).map(\.profileId) == ["work", "spare"])
    }

    @MainActor
    @Test func anEnabledToggleDuringAPendingReadFencesItAndReadsAgain() async throws {
        let (model, client) = try heldModel(holding: [Self.evidencePath, Self.registryPath])
        // Opening Accounts (registry hydration plus its evidence read) and an
        // explicit Refresh's evidence read are all in flight.
        let load = Task { await model.loadCredentialProfiles(locationID: .local) }
        #expect(await HeldReadProtocol.arrived(1, Self.evidencePath))
        #expect(await HeldReadProtocol.arrived(1, Self.registryPath))
        let refresh = Task { await model.refreshAccountsRoutingEvidence(at: .local, client: client) }
        #expect(await HeldReadProtocol.arrived(2, Self.evidencePath))
        // The real Enabled toggle lands while they are pending.
        let toggle = Task {
            await model.setProfileEnabled(harnessId: "claude", profileId: "work", enabled: false)
        }
        let reread = await HeldReadProtocol.arrived(3, Self.evidencePath)
        await HeldReadProtocol.reads.answer(Self.registryPath, 0, 200, Self.registry(workEnabled: true))
        #expect(await HeldReadProtocol.arrived(2, Self.registryPath))
        await HeldReadProtocol.reads.answer(Self.registryPath, 1, 200, Self.registry(workEnabled: false))
        // After the mutation the engine reports the mark cleared.
        var next = 2
        for _ in 0..<300 {
            while await HeldReadProtocol.reads.count(Self.evidencePath) > next {
                await HeldReadProtocol.reads.answer(Self.evidencePath, next, 200, Self.evidence(served: "m"))
                next += 1
            }
            if served(model) == ["m"] { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        // The reads from before it answer last, still carrying the old mark.
        for stale in 0..<2 {
            await HeldReadProtocol.reads.answer(Self.evidencePath, stale, 200, Self.evidence(served: "m", marked: true))
        }
        await refresh.value
        _ = await load.value
        #expect(await toggle.value == nil)
        #expect(reread)
        #expect(model.accountsRoutingEvidence.marks(harnessId: "claude", profileId: "work", at: .local).isEmpty)
        #expect(served(model) == ["m"])
        #expect(model.credentialProfiles.first { $0.profile.profileId == "work" }?.profile.enabled == false)
    }

    @MainActor
    @Test func aSupersededReadPublishesNothingNotEvenAnUnsupportedCatalog() async throws {
        let (_, client) = try heldModel(holding: [])
        HeldReadProtocol.answers[Self.evidencePath] = (200, Self.evidence(served: "newer-model"))
        let supported = try await client.accountResourceCapabilities()
        let state = AccountsRoutingEvidenceState()
        let older = state.begin(at: .local)
        let newer = state.begin(at: .local)
        await state.refresh(newer, client: client, at: .local, capabilities: supported, isCurrent: { true })
        await state.refresh(older, client: client, at: .local, capabilities: nil, isCurrent: { true })
        #expect(state.lastService(harnessId: "claude", profileId: "work", at: .local).count == 1)
        // A mutation after the newest read starts fences it before it can answer.
        let pending = state.begin(at: .local)
        state.begin(at: .local)
        HeldReadProtocol.answers[Self.evidencePath] = (500, #"{"code":"internal","message":"old"}"#)
        await state.refresh(pending, client: client, at: .local, capabilities: supported, isCurrent: { true })
        #expect(state.problems[.local] == nil)
        #expect(state.lastService(harnessId: "claude", profileId: "work", at: .local).count == 1)
    }

    /// Soft pre-progress marks plus the opt-in model-scoped credential refusals
    /// (#200): two live ones on Work, one expired, one on another account.
    static let evidenceWithCredentialRefusals = """
    {"refusals":[
      {"harness_id":"claude","profile_id":"work","requested_model":"grok-4.7",
       "observed_at":"2026-10-13T06:00:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"},
      {"harness_id":"claude","profile_id":"work","requested_model":null,
       "observed_at":"2026-10-13T06:01:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"}],
     "lastService":[
      {"harness_id":"claude","profile_id":"work","requested_model":null,"observed_at":"2026-10-13T05:00:00.000Z"}],
     "credentialUnusable":[
      {"harness_id":"claude","profile_id":"work","model":"gpt-5.5","code":"capability_refused",
       "detail":"model_not_found","observed_at":"2026-10-13T07:48:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"},
      {"harness_id":"claude","profile_id":"work","model":"grok-4.7","code":"capability_refused",
       "detail":"model_not_found","observed_at":"2026-10-13T06:00:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"},
      {"harness_id":"claude","profile_id":"work","model":"expired-model","code":"capability_refused",
       "detail":"model_not_found","observed_at":"2020-01-01T00:00:00.000Z","expires_at":"2020-01-01T01:00:00.000Z"},
      {"harness_id":"claude","profile_id":"spare","model":"gpt-5.5","code":"capability_refused",
       "detail":"model_not_found","observed_at":"2026-10-13T07:48:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"}]}
    """

    @MainActor
    @Test func aModelScopedRefusalIsADatedObservationInTheOneRefusalLine() async throws {
        defer { RoutingEvidenceProtocol.routes = [:]; RoutingEvidenceProtocol.requested = [] }
        RoutingEvidenceProtocol.routes = [
            "/v2/operations": (200, Self.current),
            "/v2/accounts/routing-evidence": (200, Self.evidenceWithCredentialRefusals),
        ]
        let (model, client) = try connectedModel()
        await model.refreshAccountsRoutingEvidence(at: .local, client: client)
        let rows = AccountsPresentation.rows(model: model)
        let work = try #require(rows.first { $0.profileId == "work" })
        #expect(work.credentialUnusable.map(\.model) == ["gpt-5.5", "grok-4.7"])
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-13T08:00:00Z"))
        let line = try #require(AccountsPresentation.refusalLine(
            work.refusalMarks, credentialUnusable: work.credentialUnusable, now: now))
        // Model, the typed reason and when; a pre-progress mark of the same
        // model folds into it, and the default model stays its own entry.
        #expect(line == "Recent refusal · gpt-5.5 (model_not_found, 12m ago), "
            + "grok-4.7 (model_not_found, 2h ago), default model")
        #expect(!line.localizedCaseInsensitiveContains("unavailable"))
        // An observation, never the row's status: readiness, Enabled, order and
        // controls are exactly as without it.
        #expect(work.readiness == .ready && work.verified && work.enabled)
        #expect(rows.map(\.profileId) == ["work", "spare"])
        #expect(AccountsPresentation.columns(for: work) == AccountsPresentation.AccountRowColumn.allCases)
        let spare = try #require(rows.first { $0.profileId == "spare" })
        #expect(spare.readiness == .ready)
        #expect(AccountsPresentation.refusalLine(
            spare.refusalMarks, credentialUnusable: spare.credentialUnusable, now: now)
            == "Recent refusal · gpt-5.5 (model_not_found, 12m ago)")
    }

    @Test func aNamedRefusalNeverStandsInForTheDefaultModel() throws {
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-13T08:00:00Z"))
        let marks = try JSONDecoder().decode([AccountRefusalMark].self, from: Data("""
            [{"harness_id":"claude","profile_id":"work","requested_model":null,
              "observed_at":"2026-10-13T07:00:00.000Z","expires_at":"2099-01-01T00:00:00.000Z"}]
            """.utf8))
        let refusals = try JSONDecoder().decode([AccountCredentialUnusableMark].self, from: Data("""
            [{"harness_id":"claude","profile_id":"work","model":"claude-opus-5-5","code":"capability_refused",
              "detail":null,"observed_at":"2026-10-13T07:59:40.000Z","expires_at":"2099-01-01T00:00:00.000Z"}]
            """.utf8))
        // Without typed evidence the engine's code is the reason.
        #expect(AccountsPresentation.refusalLine(marks, credentialUnusable: refusals, now: now)
            == "Recent refusal · claude-opus-5-5 (capability_refused, just now), default model")
        #expect(AccountsPresentation.refusalLine(marks, now: now) == "Recent refusal · default model")
        #expect(AccountsPresentation.refusalLine([], credentialUnusable: [], now: now) == nil)
    }

    @Test func copyIsQualifiedAndLocaleIndependent() throws {
        #expect(AccountsPresentation.nextUpLabel == "Next up · default model")
        #expect(AccountsPresentation.modelLabel(nil) == "default model")
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-13T10:00:00Z"))
        #expect(AccountsPresentation.age("2026-10-13T09:58:30.000Z", now: now) == "1m ago")
        #expect(AccountsPresentation.age("2026-10-13T07:00:00Z", now: now) == "3h ago")
        #expect(AccountsPresentation.age("2026-10-10T10:00:00Z", now: now) == "3d ago")
        #expect(AccountsPresentation.age("not a time", now: now) == "not a time")
    }
}
