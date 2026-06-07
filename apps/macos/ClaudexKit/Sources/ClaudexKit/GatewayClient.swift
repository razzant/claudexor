import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Thin async client for the Claudex control-api (loopback HTTP+SSE). It issues
/// POST commands and consumes the live SSE event stream with Last-Event-ID resume.
/// It owns no orchestration; it just talks to the local engine-service.
public final class GatewayClient: Sendable {
    private let baseURL: URL
    private let token: String
    private let session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    private func request(_ path: String, method: String) -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    public func health() async throws -> Bool {
        let req = request("healthz", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return false }
        let obj = try? Self.decoder.decode([String: JSONValue].self, from: data)
        return obj?["ok"]?.boolValue ?? false
    }

    /// Start a run; returns the run id/dir as soon as the server knows them.
    public func startRun(_ body: StartRunRequest) async throws -> RunStartInfo {
        var req = request("runs", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw GatewayError.transport("no response") }
        guard http.statusCode == 200 else {
            throw GatewayError.http(status: http.statusCode, body: String(decoding: data, as: UTF8.self))
        }
        do {
            return try Self.decoder.decode(RunStartInfo.self, from: data)
        } catch {
            throw GatewayError.decoding("\(error)")
        }
    }

    public func cancel(runId: String) async throws {
        let req = request("runs/\(runId)/cancel", method: "POST")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
    }

    public func listRuns() async throws -> [RunSummary] {
        let req = request("runs", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return (try Self.decoder.decode(RunListResponse.self, from: data)).runs
    }

    public func runDetail(runId: String) async throws -> RunDetail {
        let req = request("runs/\(runId)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(RunDetail.self, from: data)
    }

    public func listHarnesses() async throws -> [HarnessStatus] {
        let req = request("harnesses", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return (try Self.decoder.decode(HarnessListResponse.self, from: data)).harnesses
    }

    public func applyCheck(runId: String) async throws -> ApplyCheckResult {
        var req = request("runs/\(runId)/apply/check", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ApplyCheckResult.self, from: data)
    }

    public func setSecret(name: String, value: String) async throws {
        var req = request("secrets", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(SecretSetRequest(name: name, value: value))
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
    }

    /// Live SSE event stream for a run, resuming after `lastEventId` if given. The
    /// stream finishes when the server sends the terminal `end` event or closes.
    public func events(runId: String, lastEventId: Int? = nil) -> AsyncThrowingStream<BusEnvelope, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = self.request("runs/\(runId)/events", method: "GET")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let last = lastEventId { req.setValue(String(last), forHTTPHeaderField: "Last-Event-ID") }

                    let (bytes, resp) = try await self.session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
                        throw GatewayError.http(status: status, body: "events stream failed")
                    }

                    var id: Int?
                    var eventName = "message"
                    var dataLine = ""
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            // dispatch the accumulated event block
                            if eventName == "end" { continuation.finish(); return }
                            if !dataLine.isEmpty, let payload = Self.parseJSON(dataLine) {
                                continuation.yield(BusEnvelope(seq: id ?? 0, kind: eventName, event: payload))
                            }
                            id = nil
                            eventName = "message"
                            dataLine = ""
                            continue
                        }
                        if line.hasPrefix(":") { continue } // comment / heartbeat
                        if line.hasPrefix("id:") { id = Int(line.dropFirst(3).trimmingCharacters(in: .whitespaces)) }
                        else if line.hasPrefix("event:") { eventName = String(line.dropFirst(6).trimmingCharacters(in: .whitespaces)) }
                        else if line.hasPrefix("data:") { dataLine += String(line.dropFirst(5).trimmingCharacters(in: .whitespaces)) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func parseJSON(_ s: String) -> JSONValue? {
        guard let data = s.data(using: .utf8) else { return nil }
        return try? decoder.decode(JSONValue.self, from: data)
    }
}
