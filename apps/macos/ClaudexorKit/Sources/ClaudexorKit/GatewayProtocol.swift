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

    // Negotiate protocol major 3 (v3.0.0 broke the run/thread/status/mode
    // contracts wholesale). The `/v2` URL prefix is a frozen path spelling, NOT
    // the compatibility contract — the negotiated protocolMajor is the ONLY
    // compatibility signal (PLAN D-decision; do not "fix" the literal).
    var handshake = URLRequest(url: baseURL.appendingPathComponent("v2/handshake"))
    handshake.httpMethod = "POST"
    handshake.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    handshake.setValue("3", forHTTPHeaderField: "X-Claudexor-Protocol-Major")
    handshake.setValue("application/json", forHTTPHeaderField: "Content-Type")
    handshake.httpBody = Data(#"{"protocolMajor":3,"client":"claudexor-macos"}"#.utf8)
    let (data, response) = try await session.data(for: handshake)
    guard let http = response as? HTTPURLResponse,
          http.statusCode == 200,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          json["protocolMajor"] as? Int == 3 else { return false }
    return true
}
