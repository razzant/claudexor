import Foundation

/// Discovery document written by `claudexd` when it starts the HTTP/SSE facade:
/// `~/.claudex/daemon/control-api.json` (or `$CLAUDEX_CONFIG_DIR/daemon/...`).
public struct ControlApiDiscovery: Codable, Sendable, Equatable {
    public let host: String
    public let port: Int
    public let tokenPath: String

    public var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }

    public func readToken(fileManager: FileManager = .default) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: tokenPath))
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func makeClient(fileManager: FileManager = .default, session: URLSession = .shared) throws -> GatewayClient {
        GatewayClient(baseURL: baseURL, token: try readToken(fileManager: fileManager), session: session)
    }

    public static func defaultPath(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        if let override = ProcessInfo.processInfo.environment["CLAUDEX_CONFIG_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override).appendingPathComponent("daemon/control-api.json")
        }
        return home.appendingPathComponent(".claudex/daemon/control-api.json")
    }

    public static func load(from path: URL = defaultPath()) throws -> ControlApiDiscovery {
        let data = try Data(contentsOf: path)
        return try JSONDecoder().decode(ControlApiDiscovery.self, from: data)
    }
}
