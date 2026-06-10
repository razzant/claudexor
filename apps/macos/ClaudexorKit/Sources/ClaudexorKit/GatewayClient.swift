import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Thin async client for the Claudexor control-api (loopback HTTP+SSE). It issues
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

    /// Start a run; returns either a real run id/dir or a queued job id if the
    /// daemon has not produced the run artifact directory before the HTTP timeout.
    public func startRun(_ body: StartRunRequest) async throws -> RunStartResult {
        var req = request("runs", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw GatewayError.transport("no response") }
        guard http.statusCode == 200 || http.statusCode == 202 else {
            throw GatewayError.http(status: http.statusCode, body: String(decoding: data, as: UTF8.self))
        }
        do {
            if http.statusCode == 202 {
                return .queued(try Self.decoder.decode(QueuedRunInfo.self, from: data))
            }
            return .started(try Self.decoder.decode(RunStartInfo.self, from: data))
        } catch {
            throw GatewayError.decoding("\(error)")
        }
    }

    public func cancel(runId: String) async throws {
        var req = request("runs/\(runId)/control", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(#"{"control":{"kind":"cancel"}}"#.utf8)
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

    public func artifactText(runId: String, path: String) async throws -> String {
        let escaped = path.split(separator: "/").map { part in
            String(part).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(part)
        }.joined(separator: "/")
        let req = request("runs/\(runId)/artifacts/\(escaped)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return String(decoding: data, as: UTF8.self)
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

    public func setupHarness(_ body: HarnessSetupRequest) async throws -> HarnessSetupResponse {
        var req = request("harnesses/setup", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(HarnessSetupResponse.self, from: data)
    }

    public func createSetupJob(_ body: SetupJobCreateRequest) async throws -> SetupJob {
        var req = request("setup/jobs", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJob.self, from: data)
    }

    public func setupJob(jobId: String) async throws -> SetupJob {
        let req = request("setup/jobs/\(jobId)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJob.self, from: data)
    }

    public func confirmSetupJob(jobId: String) async throws -> SetupJob {
        var req = request("setup/jobs/\(jobId)/confirm", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(SetupJobConfirmRequest())
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJob.self, from: data)
    }

    public func listSetupJobs() async throws -> [SetupJob] {
        let req = request("setup/jobs", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJobListResponse.self, from: data).jobs
    }

    public func settings() async throws -> SettingsSnapshot {
        let req = request("settings", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SettingsSnapshot.self, from: data)
    }

    public func updateSettings(_ body: SettingsUpdateRequest) async throws -> SettingsUpdateResponse {
        var req = request("settings", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SettingsUpdateResponse.self, from: data)
    }

    public func listSecrets() async throws -> SecretListResponse {
        let req = request("secrets", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SecretListResponse.self, from: data)
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

    /// Deliver the user's answers for a pending interactive question.
    public func answerInteraction(runId: String, interactionId: String, answers: [InteractionAnswerPayload]) async throws -> InteractionAnswerResponse {
        var req = request("runs/\(runId)/interactions/\(interactionId)/answer", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(["answers": answers])
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(InteractionAnswerResponse.self, from: data)
    }

    /// Live SSE event stream for a run, resuming after `lastEventId` if given. The
    /// stream finishes when the server sends the terminal `end` event or closes.
    public func events(runId: String, lastEventId: Int? = nil) -> AsyncThrowingStream<BusEnvelope, Error> {
        sseStream(path: "runs/\(runId)/events", lastEventId: lastEventId)
    }

    /// Global LIVE-ONLY run-event multiplex (`GET /events`, no replay): every
    /// run's events tagged with run_id. Reconnect = re-snapshot `/runs` first.
    public func globalEvents() -> AsyncThrowingStream<BusEnvelope, Error> {
        sseStream(path: "events", lastEventId: nil)
    }

    /// Byte-level SSE consumption (SSEParser). `bytes.lines` is NEVER used here:
    /// it swallows the empty delimiter lines and silently drops every event.
    private func sseStream(path: String, lastEventId: Int?) -> AsyncThrowingStream<BusEnvelope, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = self.request(path, method: "GET")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let last = lastEventId { req.setValue(String(last), forHTTPHeaderField: "Last-Event-ID") }

                    let (bytes, resp) = try await self.session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
                        throw GatewayError.http(status: status, body: "events stream failed")
                    }

                    var parser = SSEParser()
                    var chunk: [UInt8] = []
                    chunk.reserveCapacity(1024)
                    func flush() -> Bool {
                        for frame in parser.feed(chunk) {
                            if frame.event == "end" { return true }
                            if let payload = Self.parseJSON(frame.data) {
                                continuation.yield(BusEnvelope(seq: frame.id ?? 0, kind: frame.event, event: payload))
                            }
                        }
                        chunk.removeAll(keepingCapacity: true)
                        return false
                    }
                    for try await byte in bytes {
                        chunk.append(byte)
                        if byte == 0x0A, flush() {
                            continuation.finish()
                            return
                        }
                    }
                    _ = flush()
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
