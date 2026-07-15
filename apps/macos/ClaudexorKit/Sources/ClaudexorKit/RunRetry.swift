import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct RunRetryResponse: Codable, Sendable, Equatable {
    public let retryOf: String
    public let jobId: String
    public let runId: String?
    public let turnId: String?
    public let state: String
}

public struct RunAgainDifference: Codable, Sendable, Equatable {
    public let field: String
    public let change: String
    public let reason: String
}

public struct RunAgainDraft: Codable, Sendable {
    public let sourceRunId: String
    /// Lossless editable request object. Keeping this schema-driven avoids a
    /// hand-maintained Swift mirror silently dropping newly added run controls.
    public let request: JSONValue
    public let differences: [RunAgainDifference]
}

public extension GatewayClient {
    func retryRun(runId: String) async throws -> RunRetryResponse {
        var req = request("runs/\(runId)/retry", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse,
              http.statusCode == 200 || http.statusCode == 202 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(RunRetryResponse.self, from: data)
    }

    func runAgainDraft(runId: String) async throws -> RunAgainDraft {
        let req = request("runs/\(runId)/run-again", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(RunAgainDraft.self, from: data)
    }
}
