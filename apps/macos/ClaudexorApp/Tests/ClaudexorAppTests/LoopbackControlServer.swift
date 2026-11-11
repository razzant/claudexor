import Foundation
import Network

/// In-process HTTP/1.1 endpoint on 127.0.0.1 for real-Foundation transport
/// tests. Event-stream routes answer exactly as the daemon does (`200
/// text/event-stream`, `connection: keep-alive`, chunked body: a pooled
/// connection; a `Connection: close` stream would not occupy URLSession's
/// per-host pool and could not reproduce the starvation), then stay open with
/// comment heartbeats until the client leaves. JSON routes answer from a table,
/// optionally delayed or held until an explicit release, without blocking other
/// connections. Every request records how many event streams were open, so a test can
/// prove ordering without wall-clock limits.
final class LoopbackControlServer: @unchecked Sendable {
    struct Arrival: Sendable {
        let path: String
        let openStreams: Int
        let at: ContinuousClock.Instant
    }

    struct Route {
        var body: Data
        var delay: Duration = .zero
        var held = false
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "test.loopback-control")
    private let lock = NSLock()
    private let token: String
    private var routes: [String: Route]
    private var arrivals: [Arrival] = []
    private var answered: [(path: String, at: ContinuousClock.Instant)] = []
    private var streams: [ObjectIdentifier: (path: String, connection: NWConnection)] = [:]
    private var unauthorized = 0
    private var heartbeat: DispatchSourceTimer?
    // Accessed only on queue. A test controls response order, never a sleep.
    private var heldResponses: [String: [(connection: NWConnection, respond: () -> Void)]] = [:]

    init(token: String, routes: [String: Route]) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        self.token = token
        self.routes = routes
    }

    var requests: [Arrival] { lock.withLock { arrivals } }
    var openStreamPaths: [String] { lock.withLock { streams.values.map(\.path).sorted() } }
    var unauthorizedRequests: Int { lock.withLock { unauthorized } }

    func answeredAt(_ path: String) -> ContinuousClock.Instant? {
        lock.withLock { answered.first { $0.path == path }?.at }
    }

    func release(_ path: String) {
        queue.sync {
            lock.withLock { routes[path]?.held = false }
            let pending = heldResponses.removeValue(forKey: path) ?? []
            pending.forEach { $0.respond() }
        }
    }

    func start() async throws -> URL {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.receive(connection, buffer: Data())
        }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.2, repeating: 0.2)
        timer.setEventHandler { [weak self] in self?.pingStreams() }
        timer.resume()
        heartbeat = timer
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let once = LoopbackOnce()
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready:
                    if once.claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case let .failed(error):
                    if once.claim() { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
        return URL(string: "http://127.0.0.1:\(port)")!
    }

    /// Push one valid run frame to every open run stream: proves the streams
    /// are still alive and delivering after the request under test.
    func pushRunFrame(id: Int) {
        let frame = Self.chunk("id: \(id)\nevent: test.frame\ndata: {\"seq\":\(id)}\n\n")
        queue.async { [weak self] in
            guard let self else { return }
            for entry in self.lock.withLock({ Array(self.streams.values) })
            where entry.path.hasPrefix("/v2/runs/") && entry.path.hasSuffix("/events") {
                entry.connection.send(content: frame, completion: .contentProcessed { _ in })
            }
        }
    }

    func stop() {
        queue.sync {
            heartbeat?.cancel()
            heartbeat = nil
            for entry in lock.withLock({ Array(streams.values) }) { entry.connection.cancel() }
            lock.withLock { streams.removeAll() }
            for pending in heldResponses.values {
                pending.forEach { $0.connection.cancel() }
            }
            heldResponses.removeAll()
            listener.cancel()
        }
    }

    private static func chunk(_ text: String) -> Data {
        let body = Data(text.utf8)
        var data = Data("\(String(body.count, radix: 16))\r\n".utf8)
        data.append(body)
        data.append(Data("\r\n".utf8))
        return data
    }

    private func pingStreams() {
        let ping = Self.chunk(": ping\n\n")
        for entry in lock.withLock({ Array(streams.values) }) {
            entry.connection.send(content: ping, completion: .contentProcessed { _ in })
        }
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if done || error != nil { connection.cancel() } else { self.receive(connection, buffer: buffer) }
                return
            }
            let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
            let rest = Data(buffer[end.upperBound...])
            self.handle(head: head, rest: rest, connection: connection)
        }
    }

    private func handle(head: String, rest: Data, connection: NWConnection) {
        let lines = head.split(separator: "\r\n").map(String.init)
        let target = lines.first?.split(separator: " ").dropFirst().first.map(String.init) ?? ""
        let path = target.split(separator: "?").first.map(String.init) ?? target
        let authorized = lines.contains { $0 == "Authorization: Bearer \(token)" }
        let isStream = lines.contains { $0.lowercased() == "accept: text/event-stream" }
        lock.withLock {
            arrivals.append(Arrival(path: path, openStreams: streams.count, at: .now))
            if !authorized { unauthorized += 1 }
        }
        if isStream {
            openStream(path: path, connection: connection)
            return
        }
        let route = lock.withLock { routes[path] }
        let status = route == nil ? "404 Not Found" : "200 OK"
        let body = route?.body ?? Data(#"{"error":"not found"}"#.utf8)
        let respond = { [weak self] in
            guard let self else { return }
            var response = Data(("HTTP/1.1 \(status)\r\nContent-Type: application/json\r\n"
                + "Content-Length: \(body.count)\r\nConnection: keep-alive\r\n\r\n").utf8)
            response.append(body)
            self.lock.withLock { self.answered.append((path, .now)) }
            connection.send(content: response, completion: .contentProcessed { _ in })
            self.receive(connection, buffer: rest)
        }
        if route?.held == true {
            heldResponses[path, default: []].append((connection, respond))
        } else if let delay = route?.delay, delay > .zero {
            let (seconds, attoseconds) = delay.components
            let interval = Double(seconds) + Double(attoseconds) / 1e18
            queue.asyncAfter(deadline: .now() + interval, execute: respond)
        } else {
            respond()
        }
    }

    private func openStream(path: String, connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        var head = Data(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
            + "Cache-Control: no-cache, no-transform\r\nConnection: keep-alive\r\n"
            + "Transfer-Encoding: chunked\r\n\r\n").utf8)
        head.append(Self.chunk(": connected\n\n"))
        lock.withLock { streams[key] = (path, connection) }
        connection.send(content: head, completion: .contentProcessed { _ in })
        watchClose(connection, key: key)
    }

    /// A stream's request has been read; any later read result is the client
    /// closing (or resetting) the connection.
    private func watchClose(_ connection: NWConnection, key: ObjectIdentifier) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) { [weak self] _, _, done, error in
            guard let self else { return }
            if done || error != nil {
                self.lock.withLock { _ = self.streams.removeValue(forKey: key) }
                connection.cancel()
            } else {
                self.watchClose(connection, key: key)
            }
        }
    }
}

private final class LoopbackOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.withLock { defer { done = true }; return !done } }
}
