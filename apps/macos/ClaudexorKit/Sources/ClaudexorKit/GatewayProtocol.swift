import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

func gatewayHealth(baseURL: URL, token: String, session: URLSession) async throws -> Bool {
    var health = URLRequest(url: baseURL.appendingPathComponent("healthz"))
    health.httpMethod = "GET"
    health.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let (healthData, healthResponse) = try await session.data(for: health)
    guard let healthHTTP = healthResponse as? HTTPURLResponse,
          healthHTTP.statusCode == 200,
          let healthJSON = try? JSONSerialization.jsonObject(with: healthData) as? [String: Any],
          healthJSON["ok"] as? Bool == true else { return false }

    var handshake = URLRequest(url: baseURL.appendingPathComponent("v2/handshake"))
    handshake.httpMethod = "POST"
    handshake.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    handshake.setValue("2", forHTTPHeaderField: "X-Claudexor-Protocol-Major")
    handshake.setValue("application/json", forHTTPHeaderField: "Content-Type")
    handshake.httpBody = Data(#"{"protocolMajor":2,"client":"claudexor-macos"}"#.utf8)
    let (data, response) = try await session.data(for: handshake)
    guard let http = response as? HTTPURLResponse,
          http.statusCode == 200,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          json["protocolMajor"] as? Int == 2 else { return false }
    return true
}
