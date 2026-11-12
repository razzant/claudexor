import Foundation
import Testing
@testable import ClaudexorKit

/// The negotiated API-key rows (includeApiKeys): a default key route with a
/// null profile_id, its key binding, and a capped/uncapped spending row.
@Suite(.serialized)
struct KeyAllowanceWireTests {
    static let empty = #"{"value":null,"source":null,"observed_at":null,"freshness":"unknown","last_attempt_at":null,"last_error":null}"#
    static func target(_ profile: String?) -> String {
        #"{"harness":"openrouter","profile_id":\#(profile.map { "\"\($0)\"" } ?? "null")}"#
    }
    static func row(_ fingerprint: String, remaining: String, observed: String, error: String? = nil,
                    profile: String? = nil) -> String {
        let value = error == nil
            ? #"[{"id":"openrouter_key_limit","label":"Key limit","enabled":null,"used":"12.34","limit":"50","unit":"USD","currency":"USD","decimal_places":null,"fee_included":null,"resets_at":"2026-11-01T00:00:00.000Z","reason":"Display only","capped":true,"remaining":"\#(remaining)","window":"month"}]"#
            : "null"
        let spending = #"{"value":\#(value),"source":\#(error == nil ? "\"openrouter_key\"" : "null"),"observed_at":\#(error == nil ? "\"\(observed)\"" : "null"),"freshness":"\#(error == nil ? "fresh" : "unknown")","last_attempt_at":"\#(observed)","last_error":\#(error.map { "\"\($0)\"" } ?? "null")}"#
        return #"{"target":\#(target(profile)),"credential_fingerprint":"\#(fingerprint)","balances":\#(empty),"spending":\#(spending),"resets":\#(empty),"diagnostics":\#(empty)}"#
    }
    /// A key the engine binds now but has not read yet: every facet unknown.
    static func unread(_ fingerprint: String, profile: String? = nil) -> String {
        #"{"target":\#(target(profile)),"credential_fingerprint":"\#(fingerprint)","balances":\#(empty),"spending":\#(empty),"resets":\#(empty),"diagnostics":\#(empty)}"#
    }
    static func quota(_ rows: String...) throws -> ControlQuotaResponse {
        try JSONDecoder().decode(ControlQuotaResponse.self,
            from: Data(#"{"snapshots":[],"absences":[],"refreshed_at":null,"resources":[\#(rows.joined(separator: ","))]}"#.utf8))
    }
    static func response(_ rows: String...) -> Data {
        Data(#"{"snapshots":[],"absences":[],"refreshed_at":null,"resources":[\#(rows.joined(separator: ","))]}"#.utf8)
    }

    @Test func decodesTheDefaultKeyRouteAndKeepsExplicitNullOnTheWire() throws {
        let response = try JSONDecoder().decode(ControlAccountResourcesResponse.self,
            from: Self.response(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:00:00Z")))
        let row = try #require(response.resources.first)
        #expect(row.target == AccountTarget(harness: "openrouter", profileId: nil))
        #expect(row.credentialFingerprint == "aaaaaaaaaaaaaaaa")
        let spending = try #require(row.spending.value?.first)
        #expect(spending.capped == true && spending.remaining == "37.66" && spending.window == "month")
        let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(row.target)) as? [String: Any])
        #expect(encoded["profile_id"] is NSNull)
        #expect(try JSONDecoder().decode(ControlAccountResourcesResponse.self, from: JSONEncoder().encode(response)) == response)
        // The wire always carries profile_id; a target without it is malformed.
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(AccountTarget.self, from: Data(#"{"harness":"openrouter"}"#.utf8))
        }
    }

    @Test func mergeNeverMixesTwoKeysFacts() throws {
        let previous = try JSONDecoder().decode(ControlQuotaResponse.self,
            from: Self.response(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:05:00Z")))
        // Older and failed, but for a different key: it replaces, never inherits.
        let replaced = try JSONDecoder().decode(ControlQuotaResponse.self,
            from: Self.response(Self.row("bbbbbbbbbbbbbbbb", remaining: "0", observed: "2026-10-29T08:00:00Z", error: "timeout")))
        let target = AccountTarget(harness: "openrouter", profileId: nil)
        let merged = try #require(replaced.replacingAccount(target, in: previous,
            reboundSinceRequest: false).resources?.first)
        #expect(merged.credentialFingerprint == "bbbbbbbbbbbbbbbb")
        #expect(merged.spending.value == nil && merged.spending.lastError == "timeout")
        // The same key keeps its newer successful figures through an older failure.
        let sameKey = try JSONDecoder().decode(ControlQuotaResponse.self,
            from: Self.response(Self.row("aaaaaaaaaaaaaaaa", remaining: "0", observed: "2026-10-29T08:00:00Z", error: "timeout")))
        let kept = try #require(sameKey.replacingAccount(target, in: previous,
            reboundSinceRequest: false).resources?.first)
        #expect(kept.spending.value?.first?.remaining == "37.66")
    }

    @Test func aLateReplyForAReplacedKeyNeverRestoresItsFigures() throws {
        let target = AccountTarget(harness: "openrouter", profileId: nil)
        // Shown: key B, bound by a display read admitted after the refresh began with A shown.
        let shown = try Self.quota(Self.unread("bbbbbbbbbbbbbbbb"))
        // The refresh reply was read with key A, which has since been replaced.
        let late = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "36.1", observed: "2026-10-29T08:10:00Z"))
        let kept = try #require(late.replacingAccount(target, in: shown,
            reboundSinceRequest: true, preferPreviousOnTie: true).resources?.first)
        #expect(kept.credentialFingerprint == "bbbbbbbbbbbbbbbb")
        #expect(kept.spending.value == nil && kept.spending.freshness == .unknown)
    }

    @Test func aNewKeyReplyReplacesTheShownKeyWhenNothingNewerWasAdmitted() throws {
        let target = AccountTarget(harness: "openrouter", profileId: nil)
        // The engine's key changed with no display read in between: the reply is the newest binding.
        let shown = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:05:00Z"))
        let reply = try Self.quota(Self.row("bbbbbbbbbbbbbbbb", remaining: "9.5", observed: "2026-10-29T08:01:00Z"))
        let replaced = try #require(reply.replacingAccount(target, in: shown,
            reboundSinceRequest: false, preferPreviousOnTie: false).resources?.first)
        #expect(replaced.credentialFingerprint == "bbbbbbbbbbbbbbbb")
        #expect(replaced.spending.value?.first?.remaining == "9.5")
    }

    @Test func aTargetWithNoShownRowIsAddedAfterAnInterveningOwnerToo() throws {
        let work = AccountTarget(harness: "openrouter", profileId: "work")
        let shown = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:05:00Z"))
        let reply = try Self.quota(Self.row("cccccccccccccccc", remaining: "4", observed: "2026-10-29T08:06:00Z", profile: "work"))
        for owner in [false, true] {
            let rows = try #require(reply.replacingAccount(work, in: shown,
                reboundSinceRequest: false, preferPreviousOnTie: owner).resources)
            #expect(rows.first { $0.target == work }?.credentialFingerprint == "cccccccccccccccc")
            // The unaddressed default row is untouched.
            #expect(rows.first { $0.target.profileId == nil }?.spending.value?.first?.remaining == "37.66")
        }
    }

    @Test func sameKeyReadingsStayInObservationOrderAcrossOwners() throws {
        let target = AccountTarget(harness: "openrouter", profileId: nil)
        let shown = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:05:00Z"))
        func merged(_ remaining: String, _ observed: String, owner: Bool) throws -> String? {
            let reply = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: remaining, observed: observed))
            return try #require(reply.replacingAccount(target, in: shown,
                reboundSinceRequest: false, preferPreviousOnTie: owner).resources?.first)
                .spending.value?.first?.remaining
        }
        // An older reading never overwrites a newer one, owner or not.
        #expect(try merged("40", "2026-10-29T08:00:00Z", owner: true) == "37.66")
        #expect(try merged("40", "2026-10-29T08:00:00Z", owner: false) == "37.66")
        // A later reading of the same key wins even after an intervening owner.
        #expect(try merged("36.1", "2026-10-29T08:10:00Z", owner: true) == "36.1")
        // A tie goes to the intervening owner, otherwise to the reply.
        #expect(try merged("30", "2026-10-29T08:05:00Z", owner: true) == "37.66")
        #expect(try merged("30", "2026-10-29T08:05:00Z", owner: false) == "30")
    }

    @Test func anotherKeysReplyStandsWhenOnlyUnrelatedWorkIntervened() throws {
        let target = AccountTarget(harness: "openrouter", profileId: nil)
        // The refresh began with key A shown. Another account's commit, or a display
        // read that failed, advanced the generation without rebinding this account.
        let shown = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:10:00Z"),
                                   Self.row("cccccccccccccccc", remaining: "3", observed: "2026-10-29T08:11:00Z", profile: "work"))
        let reply = try Self.quota(Self.row("bbbbbbbbbbbbbbbb", remaining: "9.5", observed: "2026-10-29T08:09:00Z"),
                                   Self.row("cccccccccccccccc", remaining: "4", observed: "2026-10-29T08:09:00Z", profile: "work"))
        let rows = try #require(reply.replacingAccount(target, in: shown,
            reboundSinceRequest: false, preferPreviousOnTie: true).resources)
        let replaced = try #require(rows.first { $0.target == target })
        #expect(replaced.credentialFingerprint == "bbbbbbbbbbbbbbbb")
        #expect(replaced.spending.value?.first?.remaining == "9.5")
        // The other account keeps its own newer row.
        #expect(rows.first { $0.target.profileId == "work" }?.spending.value?.first?.remaining == "3")
    }

    @Test func aLateReplyCannotRestoreAKeyRemovedAfterTheRequestBegan() throws {
        let target = AccountTarget(harness: "openrouter", profileId: nil)
        // A was shown when the refresh began; a display read then admitted its removal.
        let shown = try Self.quota()
        let late = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "36.1", observed: "2026-10-29T08:10:00Z"))
        for owner in [false, true] {
            let merged = late.replacingAccount(target, in: shown,
                reboundSinceRequest: true, preferPreviousOnTie: owner)
            #expect(merged.resources?.contains { $0.target == target } == false)
        }
    }

    @Test func aReplyWithoutTheRowRemovesItUnlessThisAccountWasRebound() throws {
        let target = AccountTarget(harness: "openrouter", profileId: nil)
        let reply = try Self.quota()
        // Unchanged binding: the reply's missing row is the newest word, even after unrelated work.
        let shownA = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:05:00Z"))
        let removed = reply.replacingAccount(target, in: shownA,
            reboundSinceRequest: false, preferPreviousOnTie: true)
        #expect(removed.resources?.contains { $0.target == target } == false)
        // Rebound to B after the request began: the newer owner stands.
        let shownB = try Self.quota(Self.unread("bbbbbbbbbbbbbbbb"))
        let kept = reply.replacingAccount(target, in: shownB,
            reboundSinceRequest: true, preferPreviousOnTie: true)
        #expect(kept.resources?.first { $0.target == target }?.credentialFingerprint == "bbbbbbbbbbbbbbbb")
    }

    @Test func onlyAKeyChangeOrAnAppearingOrMissingRowChangesABinding() throws {
        let key = AccountTarget(harness: "openrouter", profileId: nil)
        let work = AccountTarget(harness: "openrouter", profileId: "work")
        let shown = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:05:00Z"),
                                   Self.row("cccccccccccccccc", remaining: "3", observed: "2026-10-29T08:05:00Z", profile: "work"))
        // Newer figures under the same keys are not binding changes.
        let reread = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "36.1", observed: "2026-10-29T08:10:00Z"),
                                    Self.row("cccccccccccccccc", remaining: "2", observed: "2026-10-29T08:10:00Z", profile: "work"))
        #expect(reread.resourceBindingChanges(from: shown).isEmpty)
        // Another key for one account changes only that account's binding.
        let replaced = try Self.quota(Self.unread("bbbbbbbbbbbbbbbb"),
                                      Self.row("cccccccccccccccc", remaining: "3", observed: "2026-10-29T08:05:00Z", profile: "work"))
        #expect(replaced.resourceBindingChanges(from: shown) == [key])
        // A removed row and a first row are binding changes too.
        let removed = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:05:00Z"))
        #expect(removed.resourceBindingChanges(from: shown) == [work])
        #expect(shown.resourceBindingChanges(from: nil) == [key, work])
    }

    @Test func anOmittedResourceListRemovesNoRowButAnEmptyListRemovesThemAll() throws {
        let key = AccountTarget(harness: "openrouter", profileId: nil)
        let work = AccountTarget(harness: "openrouter", profileId: "work")
        let shown = try Self.quota(Self.row("aaaaaaaaaaaaaaaa", remaining: "37.66", observed: "2026-10-29T08:05:00Z"),
                                   Self.row("cccccccccccccccc", remaining: "3", observed: "2026-10-29T08:05:00Z", profile: "work"))
        // The legacy quota projection has no resources field; a resources read can list none.
        let omitted = try JSONDecoder().decode(ControlQuotaResponse.self,
            from: Data(#"{"snapshots":[],"absences":[],"refreshed_at":null}"#.utf8))
        let empty = try Self.quota()
        #expect(omitted.resources == nil && empty.resources == [])
        #expect(omitted.resourceBindingChanges(from: shown).isEmpty)
        #expect(empty.resourceBindingChanges(from: shown) == [key, work])
        // The exact merge draws the same line, rebound or not.
        for rebound in [false, true] {
            let kept = omitted.replacingAccount(key, in: shown, reboundSinceRequest: rebound)
            #expect(kept.resources?.first(where: { $0.target == key }) == shown.resources?.first(where: { $0.target == key }))
        }
        #expect(empty.replacingAccount(key, in: shown, reboundSinceRequest: false)
            .resources?.contains { $0.target == key } == false)
    }

    @Test func negotiatesApiKeyRowsOnlyWhenEveryResourceOperationAdvertisesThem() async throws {
        defer { KeyAllowanceProtocol.handler = nil }
        let flag = #"{"name":"includeApiKeys","location":"query","enum":["true","false"]}"#
        let view = #"{"name":"view","location":"query","enum":["resources"]}"#
        func catalog(_ ids: [String]) -> String {
            let ops = ["get:quota", "post:quota", "get:credential-profiles"].map { id in
                #"{"id":"\#(id)","parameters":[\#(view)\#(ids.contains(id) ? "," + flag : "")]}"#
            }
            return #"{"operations":[\#(ops.joined(separator: ","))]}"#
        }
        let recorder = KeyAllowanceRecorder()
        for (ids, expected) in [(["get:quota", "post:quota", "get:credential-profiles"], true), (["get:quota", "post:quota"], false)] {
            let body = Data(catalog(ids).utf8)
            KeyAllowanceProtocol.handler = { request in
                recorder.record(request)
                return (200, body)
            }
            #expect(try await Self.client().accountResourceCapabilities().apiKeys == expected)
        }
        KeyAllowanceProtocol.handler = { request in
            recorder.record(request)
            if request.url?.path == "/v2/credential-profiles" {
                return (200, Data(#"{"profiles":[],"quota":\#(String(decoding: Self.response(), as: UTF8.self))}"#.utf8))
            }
            return (200, Self.response())
        }
        let client = Self.client()
        _ = try await client.quota(refresh: true, resources: true, apiKeys: true,
                                   target: AccountTarget(harness: "openrouter", profileId: nil))
        _ = try await client.quota(resources: false, apiKeys: true)
        _ = try await client.credentialProfilesSnapshot(resources: true, apiKeys: true)
        let requests = recorder.requests.filter { $0.url?.path != "/v2/operations" }
        #expect(requests.map { $0.url?.query } == ["view=resources&includeApiKeys=true", nil,
                                                   "snapshot=true&view=resources&includeApiKeys=true"])
        let body = try #require(JSONSerialization.jsonObject(with: KeyAllowanceProtocol.body(requests[0])) as? [String: Any])
        let target = try #require(body["target"] as? [String: Any])
        #expect(target["harness"] as? String == "openrouter" && target["profile_id"] is NSNull)
    }

    static func client() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [KeyAllowanceProtocol.self]
        return GatewayClient(baseURL: URL(string: "https://engine.invalid")!, token: "fixture",
                             session: URLSession(configuration: configuration))
    }
}

private final class KeyAllowanceRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    func record(_ request: URLRequest) { lock.withLock { recorded.append(request) } }
    var requests: [URLRequest] { lock.withLock { recorded } }
}

private final class KeyAllowanceProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            result.append(buffer, count: count)
        }
        return result
    }
}
