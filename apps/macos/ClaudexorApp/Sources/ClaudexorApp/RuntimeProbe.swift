import Foundation
import ClaudexorKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Probe / handshake ports (M7)
//
// The two verification seams of an install. Both spawn/POST in production and
// are stubbed in tests (forced success/failure), so the swap+rollback logic is
// exercised offline without a live daemon.

/// Probe-start: boot the NEW daemon against a THROWAWAY config dir so it never
/// touches real state, and confirm it boots and its handshake identity matches
/// `expectedVersion`. Returns false on any boot/identity failure.
public protocol RuntimeProbe: Sendable {
    func verify(versionDir: URL, expectedVersion: String) async -> Bool
}

/// Handshake-verify the now-SERVING engine (post-swap): the real daemon must be
/// answering `/v2/handshake` with `engine.version == expectedVersion` (D20
/// identity). Returns false on any handshake/identity failure → rollback.
public protocol RuntimeHandshakeVerifier: Sendable {
    func verifyServing(expectedVersion: String) async -> Bool
}

/// POST `/v2/handshake` and decode the engine identity. Shared by both real
/// ports. Returns nil on any transport/status/decode failure.
func fetchEngineHandshake(baseURL: URL, token: String, session: URLSession) async -> ControlHandshakeResponse? {
    var req = URLRequest(url: baseURL.appendingPathComponent("v2/handshake"))
    req.httpMethod = "POST"
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue("3", forHTTPHeaderField: "X-Claudexor-Protocol-Major")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data(#"{"protocolMajor":3,"client":"claudexor-macos"}"#.utf8)
    guard let (data, response) = try? await session.data(for: req),
          let http = response as? HTTPURLResponse, http.statusCode == 200,
          let decoded = try? JSONDecoder().decode(ControlHandshakeResponse.self, from: data) else {
        return nil
    }
    return decoded
}

/// Production handshake-verify against the live serving daemon, resolved through
/// the control-api discovery file (same source the app's GatewayClient uses).
public struct DefaultRuntimeHandshakeVerifier: RuntimeHandshakeVerifier {
    private let discoveryPath: URL
    private let session: URLSession

    public init(discoveryPath: URL = ControlApiDiscovery.defaultPath(), session: URLSession = .shared) {
        self.discoveryPath = discoveryPath
        self.session = session
    }

    public func verifyServing(expectedVersion: String) async -> Bool {
        guard let discovery = try? ControlApiDiscovery.load(from: discoveryPath),
              let baseURL = discovery.baseURL,
              let token = try? discovery.readToken() else {
            return false
        }
        guard let handshake = await fetchEngineHandshake(baseURL: baseURL, token: token, session: session),
              handshake.protocolMajor == 3, handshake.compatible else {
            return false
        }
        return handshake.engine.version == expectedVersion
    }
}

/// Production probe-start: spawn the new daemon against a throwaway config dir,
/// wait for it to publish its control-api discovery file, handshake it, verify
/// the version, then tear it down. Node is ALWAYS the app-bundled binary; only
/// the daemon SCRIPT comes from the candidate version dir.
public struct DefaultRuntimeProbe: RuntimeProbe {
    private let session: URLSession
    private let bootTimeout: TimeInterval

    public init(session: URLSession = .shared, bootTimeout: TimeInterval = 20) {
        self.session = session
        self.bootTimeout = bootTimeout
    }

    public func verify(versionDir: URL, expectedVersion: String) async -> Bool {
        guard let node = DaemonLauncher.bundledNode,
              FileManager.default.isExecutableFile(atPath: node.path) else {
            return false  // dev/SwiftPM: no bundled node to probe with.
        }
        let daemon = versionDir.appendingPathComponent("claudexord.bundle.cjs")
        guard FileManager.default.fileExists(atPath: daemon.path) else { return false }

        let configDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-probe-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: configDir) }

        let process = Process()
        process.executableURL = node
        process.arguments = [daemon.path]
        var env = ProcessInfo.processInfo.environment
        env["CLAUDEXOR_CONFIG_DIR"] = configDir.path
        process.environment = env
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return false }
        defer { if process.isRunning { process.terminate() } }

        let discoveryPath = configDir.appendingPathComponent("daemon/control-api.json")
        let deadline = Date().addingTimeInterval(bootTimeout)
        while Date() < deadline {
            if let discovery = try? ControlApiDiscovery.load(from: discoveryPath),
               let baseURL = discovery.baseURL,
               let token = try? discovery.readToken(),
               let handshake = await fetchEngineHandshake(baseURL: baseURL, token: token, session: session) {
                return handshake.protocolMajor == 3
                    && handshake.compatible
                    && handshake.engine.version == expectedVersion
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return false
    }
}
