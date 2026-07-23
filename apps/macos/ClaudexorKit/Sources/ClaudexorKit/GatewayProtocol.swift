import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Outcome of the health + protocol handshake. `ok` is the connectivity /
/// compatibility verdict (unchanged from the old Bool contract); `engine` is the
/// serving build's disclosed identity, retained instead of discarded (QA-002 /
/// D20). `engine` is decoded LENIENTLY: a daemon that omits the field, or an
/// older build that predates it, still connects — it simply reports no identity
/// (the About panel then shows "unknown"), never a dropped connection.
public struct GatewayHandshakeOutcome: Sendable, Equatable {
    public let ok: Bool
    public let engine: EngineBuildIdentity?

    public init(ok: Bool, engine: EngineBuildIdentity?) {
        self.ok = ok
        self.engine = engine
    }
}

func gatewayHandshake(baseURL: URL, token: String, session: URLSession) async throws -> GatewayHandshakeOutcome {
    var health = URLRequest(url: baseURL.appendingPathComponent("healthz"))
    health.httpMethod = "GET"
    health.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let (healthData, healthResponse) = try await session.data(for: health)
    guard let healthHTTP = healthResponse as? HTTPURLResponse,
          healthHTTP.statusCode == 200,
          let healthJSON = try? JSONSerialization.jsonObject(with: healthData) as? [String: Any],
          healthJSON["ok"] as? Bool == true else { return GatewayHandshakeOutcome(ok: false, engine: nil) }

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
          json["protocolMajor"] as? Int == 3 else { return GatewayHandshakeOutcome(ok: false, engine: nil) }
    // Retain the typed build identity for the About panel. Decoded leniently so a
    // missing/older `engine` object never demotes a healthy connection.
    let engine = (try? JSONDecoder().decode(ControlHandshakeResponse.self, from: data))?.engine
    return GatewayHandshakeOutcome(ok: true, engine: engine)
}

func gatewayHealth(baseURL: URL, token: String, session: URLSession) async throws -> Bool {
    try await gatewayHandshake(baseURL: baseURL, token: token, session: session).ok
}
