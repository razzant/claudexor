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

/// The daemon lifecycle around a runtime swap (B2): an idle-daemon STOP so the
/// pointer swap is not raced by a live serving process, and a RELAUNCH so the
/// post-swap handshake observes the NEW engine (an un-restarted daemon keeps
/// serving the old closure and would fail the identity check spuriously). Both
/// are best-effort — the authoritative proof is the handshake — so they return a
/// Bool for disclosure, never to gate the outcome.
public protocol RuntimeDaemonLifecycle: Sendable {
    /// Stop the daemon if one is serving, waiting until it is idle. True when the
    /// daemon is stopped or was already absent.
    func stopIdleDaemon() async -> Bool
    /// Relaunch the daemon from the currently-pointed runtime. True when a
    /// relaunch was started.
    func relaunch() async -> Bool
}

/// Test/default lifecycle that touches NO real daemon (so the offline install
/// tests, which drive success/failure through the handshake stub, never signal a
/// developer's running daemon). Production wires `DefaultRuntimeDaemonLifecycle`.
public struct NoopRuntimeDaemonLifecycle: RuntimeDaemonLifecycle {
    public init() {}
    public func stopIdleDaemon() async -> Bool { true }
    public func relaunch() async -> Bool { true }
}

// MARK: - Process birth identity (B4: never signal a recycled pid)

/// A process's kernel BIRTH identity — the pid, its `darwin:<sec>:<usec>` start
/// token, and its process-group — matching the `KnownProcessIdentity` the daemon
/// records in its writer lease (@claudexor/core process-identity).
public struct ObservedProcessIdentity: Sendable, Equatable {
    public let pid: Int
    public let startToken: String
    public let processGroupId: Int
    public init(pid: Int, startToken: String, processGroupId: Int) {
        self.pid = pid
        self.startToken = startToken
        self.processGroupId = processGroupId
    }
}

/// The outcome of observing a pid — deliberately distinguishing a CONFIRMED-gone
/// process from one we simply could not observe, so a stop fails CLOSED (never
/// assumes death) when identity is unverifiable.
public enum ProcessIdentityObservation: Sendable, Equatable {
    case known(ObservedProcessIdentity)
    /// The kernel confirmed no such process (helper EXIT_MISSING / ESRCH).
    case missing
    /// Could not observe (helper unavailable, permission, malformed) — fail closed.
    case unknown
}

/// Reads a live process's kernel birth identity so a runtime-swap stop never
/// signals a RECYCLED pid (sol #5) — the same discipline, and the SAME bundled
/// helper, the daemon's own confirmed-death stop uses (packages/daemon
/// terminate.ts). Injected so the PID-reuse path is stubbed offline.
public protocol ProcessIdentityReading: Sendable {
    func observe(pid: Int) -> ProcessIdentityObservation
}

/// Production reader: shells the app-bundled `native/claudexor-process-identity`
/// helper (`--pid <n>`) — the very binary the daemon records its lease identity
/// with — so the observed start token is BYTE-IDENTICAL to the recorded one.
public struct BundledProcessIdentityReader: ProcessIdentityReading {
    private let helperURL: URL?

    public init(helperURL: URL? = Bundle.main.resourceURL?
        .appendingPathComponent("native/claudexor-process-identity")) {
        self.helperURL = helperURL
    }

    public func observe(pid: Int) -> ProcessIdentityObservation {
        guard pid > 0, let helper = helperURL,
              FileManager.default.isExecutableFile(atPath: helper.path) else { return .unknown }
        let process = Process()
        process.executableURL = helper
        process.arguments = ["--pid", String(pid)]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return .unknown }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        // EXIT_MISSING (3) = ESRCH: the process is confirmed gone.
        if process.terminationStatus == 3 { return .missing }
        guard process.terminationStatus == 0 else { return .unknown }
        let line = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines)
        let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        guard f.count == 5, f[0] == "claudexor-process-identity-v2",
              let obsPid = Int(f[1]), obsPid == pid, let pgid = Int(f[2]) else { return .unknown }
        return .known(ObservedProcessIdentity(pid: pid, startToken: "darwin:\(f[3]):\(f[4])",
                                              processGroupId: pgid))
    }
}

/// The daemon's recorded birth identity, parsed from the `identity` object its
/// writer lease (`<socket>.writer/owner.json`) stores at acquisition.
struct DaemonBirthIdentity: Equatable {
    let pid: Int
    let startToken: String
    let processGroupId: Int

    init?(_ raw: Any?) {
        guard let d = raw as? [String: Any],
              (d["status"] as? String) == "known",
              let pid = (d["pid"] as? NSNumber)?.intValue,
              let startToken = d["startToken"] as? String,
              let pgid = (d["processGroupId"] as? NSNumber)?.intValue else { return nil }
        self.pid = pid
        self.startToken = startToken
        self.processGroupId = pgid
    }

    /// True only when the live process IS the daemon we recorded — same pid,
    /// same kernel birth token, same process group (never a recycled pid).
    func matches(_ observed: ObservedProcessIdentity) -> Bool {
        pid == observed.pid && startToken == observed.startToken
            && processGroupId == observed.processGroupId
    }
}

/// Production lifecycle: stop the serving daemon by signalling the pid recorded
/// in its single-writer lease (`<socket>.writer`), wait for the socket to
/// disappear, then relaunch through `DaemonLauncher` (which resolves the daemon
/// script through the freshly-swapped `current.json`).
public struct DefaultRuntimeDaemonLifecycle: RuntimeDaemonLifecycle {
    private let daemonDir: URL
    private let stopTimeout: TimeInterval
    private let identityReader: ProcessIdentityReading
    /// Injectable so the death-prove path is exercised offline without signalling
    /// a real process; production sends the real SIGTERM.
    private let signal: @Sendable (Int32, Int32) -> Void

    public init(
        daemonDir: URL? = nil,
        stopTimeout: TimeInterval = 15,
        identityReader: ProcessIdentityReading = BundledProcessIdentityReader(),
        signal: @escaping @Sendable (Int32, Int32) -> Void = { kill($0, $1) }
    ) {
        self.daemonDir = daemonDir ?? {
            if let override = ProcessInfo.processInfo.environment["CLAUDEXOR_CONFIG_DIR"], !override.isEmpty {
                return URL(fileURLWithPath: override).appendingPathComponent("daemon", isDirectory: true)
            }
            return FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".claudexor/v3/daemon", isDirectory: true)
        }()
        self.stopTimeout = stopTimeout
        self.identityReader = identityReader
        self.signal = signal
    }

    private var socketPath: URL { daemonDir.appendingPathComponent("claudexord.sock") }
    private var writerLeasePath: URL {
        daemonDir.appendingPathComponent("claudexord.sock.writer/owner.json")
    }

    /// Stop the serving daemon, PROVING it is the one we recorded before we ever
    /// signal it. Returns true only when the daemon is confirmed stopped (or was
    /// never there / already dead) — a recycled pid is never signalled (B4/sol #5),
    /// and an unverifiable identity fails CLOSED so the caller aborts the swap
    /// rather than mutate state under a possibly-live process.
    public func stopIdleDaemon() async -> Bool {
        // No socket → nothing serving → already idle.
        guard FileManager.default.fileExists(atPath: socketPath.path) else { return true }
        guard let data = try? Data(contentsOf: writerLeasePath),
              let lease = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = (lease["pid"] as? NSNumber)?.intValue, pid > 0 else {
            // A serving socket with no readable lease: cannot safely signal a pid.
            return false
        }
        guard let recorded = DaemonBirthIdentity(lease["identity"]) else {
            // No recorded birth identity: we cannot prove the pid is still THIS
            // daemon, so we refuse to signal it and report the stop UNCONFIRMED.
            return false
        }
        let pid32 = Int32(truncatingIfNeeded: pid)
        switch identityReader.observe(pid: pid) {
        case .missing:
            // The daemon process is gone; the socket is a stale leftover. Nothing
            // is serving — safe to swap, and we never signalled anything.
            return true
        case .unknown:
            // Could not verify the pid's identity — fail closed (never signal an
            // unverifiable pid, never claim the stop succeeded).
            return false
        case let .known(observed):
            guard recorded.matches(observed) else {
                // The pid was RECYCLED by a different process — our daemon is dead.
                // Never signal the newcomer; the stale socket is safe to swap over.
                return true
            }
            // Verified: the pid still IS our daemon. Signal it, then PROVE death.
            signal(pid32, SIGTERM)
            let deadline = Date().addingTimeInterval(stopTimeout)
            while Date() < deadline {
                // A clean exit removes the socket; a crash may leave it, but the
                // pid identity is then gone/recycled — either proves death.
                if !FileManager.default.fileExists(atPath: socketPath.path) { return true }
                switch identityReader.observe(pid: pid) {
                case .missing: return true
                case .known(let now) where !recorded.matches(now): return true
                case .known, .unknown: break
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            return !FileManager.default.fileExists(atPath: socketPath.path)
        }
    }

    public func relaunch() async -> Bool {
        DaemonLauncher.startIfNeeded()
    }
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
