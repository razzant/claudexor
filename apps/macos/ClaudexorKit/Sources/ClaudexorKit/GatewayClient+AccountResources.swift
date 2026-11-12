import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct AccountResourceCapabilities: Sendable, Equatable {
    public let read: Bool
    public let refresh: Bool
    public let accountsSnapshot: Bool
    public let reset: Bool
    public let resetStatus: Bool
    /// `GET /v2/accounts/routing-evidence` (model-scoped refusals + last service).
    public let routingEvidence: Bool
    /// Every resources read and refresh accepts `includeApiKeys` (API-key rows).
    public var apiKeys: Bool = false
}

/// Only the declaration slice needed by this consumer. No version guesses or
/// provider names. The full catalog remains owned by packages/schema.
struct AccountResourceOperationCatalog: Decodable, Sendable {
    struct Operation: Decodable, Sendable {
        struct Parameter: Decodable, Sendable {
            let name: String
            let location: String
            let `enum`: [String]?
        }
        let id: String
        let parameters: [Parameter]
        private enum CodingKeys: String, CodingKey { case id, parameters }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            parameters = try c.decodeIfPresent([Parameter].self, forKey: .parameters) ?? []
        }
    }
    let operations: [Operation]

    var capabilities: AccountResourceCapabilities {
        func rich(_ id: String) -> Bool {
            operations.contains { op in
                op.id == id && op.parameters.contains {
                    $0.name == "view" && $0.location == "query"
                        && ($0.enum ?? []).contains("resources")
                }
            }
        }
        // One engine ships the three together; all are required so rows never
        // appear in one read and vanish from the next.
        let apiKeys = ["get:quota", "post:quota", "get:credential-profiles"].allSatisfy { id in
            operations.contains { op in
                op.id == id && op.parameters.contains { $0.name == "includeApiKeys" && $0.location == "query" }
            }
        }
        return AccountResourceCapabilities(
            read: rich("get:quota"), refresh: rich("post:quota"),
            accountsSnapshot: rich("get:credential-profiles"),
            reset: operations.contains { $0.id == "post:account-resets" },
            resetStatus: operations.contains { $0.id == "get:account-resets.id" },
            routingEvidence: operations.contains { $0.id == "get:accounts.routing-evidence" },
            apiKeys: apiKeys)
    }
}

/// Per-connection declaration cache, not an account observation cache. Failed
/// negotiation can be retried; simultaneous consumers share one catalog read.
actor AccountResourceCapabilityCache {
    private var task: Task<AccountResourceCapabilities, Error>?
    func value(load: @escaping @Sendable () async throws -> AccountResourceCapabilities) async throws -> AccountResourceCapabilities {
        if let task { return try await task.value }
        let task = Task { try await load() }
        self.task = task
        do { return try await task.value }
        catch { self.task = nil; throw error }
    }
}

public extension GatewayClient {
    func accountResourceCapabilities() async throws -> AccountResourceCapabilities {
        try await accountResourceCapabilityCache.value { [self] in
            do {
                let data = try await accountResourceData(request("operations", method: "GET"))
                return try Self.decoder.decode(AccountResourceOperationCatalog.self, from: data).capabilities
            } catch let GatewayError.http(status, _) where status == 404 || status == 405 {
                return AccountResourceOperationCatalog(operations: []).capabilities
            }
        }
    }

    /// Callers keep this exact body and key until a receipt can be recovered.
    /// Reposting with that key recovers the same logical engine operation.
    func resetAccount(
        _ body: ControlAccountResetRequest,
        idempotencyKey: String
    ) async throws -> ControlAccountResetResponse {
        var req = request("account-resets", method: "POST")
        req.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        req.httpBody = try encoder.encode(body)
        return try await accountResetReceipt(req)
    }

    func accountReset(id: String) async throws -> ControlAccountResetResponse {
        // An operation id is a single path segment, never query/path syntax.
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/%?#")
        guard let escaped = id.addingPercentEncoding(withAllowedCharacters: allowed) else {
            throw GatewayError.transport("Invalid account reset operation id")
        }
        var req = request("account-resets", method: "GET")
        guard let url = req.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw GatewayError.transport("Invalid account reset URL")
        }
        components.percentEncodedPath += "/\(escaped)"
        req.url = components.url
        return try await accountResetReceipt(req)
    }

    private func accountResetReceipt(_ request: URLRequest) async throws -> ControlAccountResetResponse {
        let data = try await accountResourceData(request)
        return try Self.decoder.decode(ControlAccountResetResponse.self, from: data)
    }
}

extension GatewayClient {
    func accountResourceData(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200 || http.statusCode == 202 else {
            throw GatewayError.http(status: (response as? HTTPURLResponse)?.statusCode ?? -1,
                                    body: String(decoding: data, as: UTF8.self))
        }
        return data
    }
}
