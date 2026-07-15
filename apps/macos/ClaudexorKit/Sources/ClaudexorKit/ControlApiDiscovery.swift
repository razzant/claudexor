import Foundation

/// Discovery document written by `claudexord` when it starts the HTTP/SSE facade:
/// `~/.claudexor/v2/daemon/control-api.json` (or `$CLAUDEXOR_CONFIG_DIR/daemon/...`).
public struct ControlApiDiscovery: Codable, Sendable, Equatable {
    public let host: String
    public let port: Int
    public let tokenPath: String

    /// Nil when the discovery file carries a host that does not form a valid
    /// URL (hand-edited/corrupted file). Callers route that into the same
    /// offline/unreachable state as a missing daemon — never a crash.
    public var baseURL: URL? {
        URL(string: "http://\(host):\(port)")
    }

    public func readToken(fileManager: FileManager = .default) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: tokenPath))
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func makeClient(fileManager: FileManager = .default, session: URLSession = .shared) throws -> GatewayClient {
        guard let url = baseURL else {
            throw ControlApiDiscoveryError.invalidHost(host: host, port: port)
        }
        return GatewayClient(baseURL: url, token: try readToken(fileManager: fileManager), session: session)
    }

    public static func defaultPath(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        if let override = ProcessInfo.processInfo.environment["CLAUDEXOR_CONFIG_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override).appendingPathComponent("daemon/control-api.json")
        }
        return home.appendingPathComponent(".claudexor/v2/daemon/control-api.json")
    }

    public static func load(from path: URL = defaultPath()) throws -> ControlApiDiscovery {
        let data = try Data(contentsOf: path)
        return try JSONDecoder().decode(ControlApiDiscovery.self, from: data)
    }
}

public enum ControlApiDiscoveryError: Error, LocalizedError {
    case invalidHost(host: String, port: Int)

    public var errorDescription: String? {
        switch self {
        case let .invalidHost(host, port):
            return "control-api discovery file carries an invalid host/port ('\(host)':\(port)) — delete ~/.claudexor/v2/daemon/control-api.json and restart the daemon"
        }
    }
}
