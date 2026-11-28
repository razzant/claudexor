import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension GatewayClient {
    public func runDetail(runId: String, includeEarlierAssistantOutput: Bool = false) async throws -> RunDetail {
        let req = request("runs/\(runId)", method: "GET", queryItems: includeEarlierAssistantOutput ? [
            URLQueryItem(name: "includeEarlierAssistantOutput", value: "true")
        ] : [])
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(RunDetail.self, from: data)
    }
}
