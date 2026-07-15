import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public extension GatewayClient {
    func quota(refresh: Bool = false) async throws -> ControlQuotaResponse {
        let req = request("quota", method: refresh ? "POST" : "GET")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ControlQuotaResponse.self, from: data)
    }
}
