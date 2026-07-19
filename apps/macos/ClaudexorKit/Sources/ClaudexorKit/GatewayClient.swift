import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public final class GatewayClient: Sendable {
    private let baseURL: URL
    private let token: String
    let session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    func request(_ path: String, method: String, timeout: TimeInterval? = nil,
                 queryItems: [URLQueryItem] = []) -> URLRequest {
        let externalPath = path == "healthz" ? path : (path.hasPrefix("v2/") ? path : "v2/\(path)")
        var url = baseURL.appendingPathComponent(externalPath)
        if !queryItems.isEmpty, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = queryItems
            if let encoded = components.url { url = encoded }
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if externalPath != "healthz" {
            req.setValue("3", forHTTPHeaderField: "X-Claudexor-Protocol-Major")
        }
        if method == "POST" { req.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key") }
        if let timeout { req.timeoutInterval = timeout }
        return req
    }

    static let encoder = JSONEncoder(), decoder = JSONDecoder()

    static func yieldChecked<Element: Sendable>(
        _ element: Element,
        to continuation: AsyncThrowingStream<Element, Error>.Continuation,
        context: String
    ) throws -> Bool {
        switch continuation.yield(element) {
        case .enqueued:
            return true
        case .dropped:
            throw GatewayError.transport("\(context) buffer overflow; resnapshot is required")
        case .terminated:
            return false
        @unknown default:
            throw GatewayError.transport("\(context) returned an unknown buffering result")
        }
    }

    public func health() async throws -> Bool {
        try await gatewayHealth(baseURL: baseURL, token: token, session: session)
    }

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

    public func listRunArtifacts(runId: String) async throws -> [ArtifactInfo] {
        let req = request("runs/\(runId)/artifacts", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        struct Resp: Decodable { let artifacts: [ArtifactInfo] }
        return (try? Self.decoder.decode(Resp.self, from: data))?.artifacts ?? []
    }

    public func artifactData(runId: String, path: String) async throws -> Data {
        let escaped = path.split(separator: "/").map { part in
            String(part).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(part)
        }.joined(separator: "/")
        let req = request("runs/\(runId)/artifacts/\(escaped)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return data
    }

    /// List a run's PRODUCED outputs — the project's `artifacts/` dir, not the run
    /// orchestration tree. Same shape/serving as `GET /runs/:id/artifacts`.
    public func listProducedFiles(runId: String) async throws -> [ArtifactInfo] {
        let req = request("runs/\(runId)/produced", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        struct Resp: Decodable { let artifacts: [ArtifactInfo] }
        return (try? Self.decoder.decode(Resp.self, from: data))?.artifacts ?? []
    }

    public func producedData(runId: String, path: String) async throws -> Data {
        let escaped = path.split(separator: "/").map { part in
            String(part).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(part)
        }.joined(separator: "/")
        let req = request("runs/\(runId)/produced/\(escaped)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return data
    }

    public func listHarnesses(fresh: Bool = false) async throws -> [HarnessStatus] {
        let query = fresh ? [URLQueryItem(name: "fresh", value: "true")] : []
        let req = request("harnesses", method: "GET", queryItems: query)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return (try Self.decoder.decode(HarnessListResponse.self, from: data)).harnesses
    }

    /// Refresh exactly one harness credential source. This route deliberately
    /// cannot fan out to unrelated adapters or overwrite aggregate catalog truth.
    public func refreshAuthReadiness(
        harnessId: String,
        request body: AuthReadinessRefreshRequest
    ) async throws -> AuthReadinessRefreshResponse {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        guard !harnessId.isEmpty,
              let escaped = harnessId.addingPercentEncoding(withAllowedCharacters: allowed) else {
            throw GatewayError.decoding("invalid auth-readiness harness id")
        }
        var req = request("v2/harnesses/\(escaped)/auth-readiness", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        let result = try Self.decoder.decode(AuthReadinessRefreshResponse.self, from: data)
        guard result.harnessId == harnessId,
              result.authRequest == body.authRequest,
              result.requestedSource == body.source,
              result.readiness.source == body.source else {
            throw GatewayError.decoding("auth-readiness response does not match its exact request")
        }
        return result
    }

    /// Enumerable models for one harness (the ADP4 consumer of the adapter
    /// models() producer). `source == "none"` (or an empty list) means the
    /// harness cannot enumerate — the caller should fall back to free text.
    public func harnessModels(harnessId: String, route: String? = nil) async throws -> HarnessModelsResponse {
        let escaped = harnessId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? harnessId
        // ?route= filters manifest-annotated models by credential route (W11/W20).
        let query = route.map { "?route=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? ""
        let req = request("harnesses/\(escaped)/models\(query)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(HarnessModelsResponse.self, from: data)
    }

    public func createSetupJob(_ body: SetupJobCreateRequest) async throws -> SetupJob {
        var req = request("v2/setup/jobs", method: "POST")
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
        let escaped = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        let req = request("v2/setup/jobs/\(escaped)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJob.self, from: data)
    }

    public func setupJobSnapshot(jobId: String) async throws -> SetupJobSnapshot {
        let escaped = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        let req = request("v2/setup/jobs/\(escaped)/snapshot", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJobSnapshot.self, from: data)
    }

    public func listSetupJobs(filter: SetupJobListFilter = SetupJobListFilter()) async throws -> [SetupJob] {
        var query: [URLQueryItem] = []
        if let harness = filter.harness { query.append(URLQueryItem(name: "harness", value: harness)) }
        if let action = filter.action { query.append(URLQueryItem(name: "action", value: action)) }
        if let active = filter.active { query.append(URLQueryItem(name: "active", value: active ? "true" : "false")) }
        if let limit = filter.limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        let req = request("v2/setup/jobs", method: "GET", queryItems: query)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJobListResponse.self, from: data).jobs
    }

    public func cancelSetupJob(jobId: String) async throws -> SetupJob {
        let escaped = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        let req = request("v2/setup/jobs/\(escaped)/cancel", method: "POST")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJob.self, from: data)
    }

    public func reconcileSetupJob(jobId: String) async throws -> SetupJob {
        let escaped = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        let req = request("v2/setup/jobs/\(escaped)/reconcile", method: "POST")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJob.self, from: data)
    }

    public func extendSetupJob(jobId: String) async throws -> SetupJob {
        let escaped = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        let req = request("v2/setup/jobs/\(escaped)/extend", method: "POST")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(SetupJob.self, from: data)
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

    /// Apply a run's reviewed patch (apply | branch | commit | pr). Server-gated.
    public func apply(runId: String, body: ApplyRunRequest = ApplyRunRequest()) async throws -> ApplyResultInfo {
        var req = request("runs/\(runId)/apply", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ApplyResultInfo.self, from: data)
    }

    /// Typed operator decision on a blocked run (accept risk / rerun / apply clean patch).
    public func decide(runId: String, body: RunDecisionRequest) async throws -> RunDecisionResponse {
        var req = request("runs/\(runId)/decision", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(RunDecisionResponse.self, from: data)
    }

    /// Revert this turn's in-place mutation (server-owned restore to the pre-turn
    /// snapshot). Routes through the same decision endpoint with `revert_run`; the
    /// server refuses (HTTP 409) if the working tree has diverged since the turn.
    public func revertRun(runId: String) async throws -> RunDecisionResponse {
        try await decide(runId: runId, body: RunDecisionRequest(action: "revert_run"))
    }

    // MARK: Threads (chat/session-first)

    public func listThreads() async throws -> ThreadListResponse {
        let req = request("threads", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ThreadListResponse.self, from: data)
    }

    public func threadDetail(id: String) async throws -> ThreadDetailResponse {
        let req = request("threads/\(id)", method: "GET")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ThreadDetailResponse.self, from: data)
    }

    public func createThread(_ body: CreateThreadRequest) async throws -> ThreadSummary {
        var req = request("threads", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ThreadSummary.self, from: data)
    }

    /// Send a follow-up turn into a thread; the engine resumes native sessions.
    public func sendTurn(threadId: String, body: ThreadTurnRequest) async throws -> RunStartResult {
        var req = request("threads/\(threadId)/turns", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if status == 200 {
            return .started(try Self.decoder.decode(RunStartInfo.self, from: data))
        }
        if status == 202 {
            // The turn IS recorded (turnId) but its run had not started within the
            // wait window; the runner binds it when it starts. Treat as queued —
            // never lost, never cancelled (the v0.9 30s race is gone).
            return .queued(try Self.decoder.decode(QueuedRunInfo.self, from: data))
        }
        throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
    }

    /// Re-enqueue a REFUSED turn (same prompt/options — the daemon replays the
    /// recorded job params onto the SAME turn; no duplicate bubble). 200/202
    /// mirror sendTurn; 409 means the turn is not retryable (run bound/active).
    public func retryTurn(threadId: String, turnId: String) async throws -> RunStartResult {
        let req = request("threads/\(threadId)/turns/\(turnId)/retry", method: "POST")
        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if status == 200 {
            return .started(try Self.decoder.decode(RunStartInfo.self, from: data))
        }
        if status == 202 {
            return .queued(try Self.decoder.decode(QueuedRunInfo.self, from: data))
        }
        throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
    }

    /// List per-repo user-level trust files (Settings trust section).
    public func trustList() async throws -> TrustListResponse {
        let (data, resp) = try await session.data(for: request("trust", method: "GET"))
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(TrustListResponse.self, from: data)
    }

    /// Grant/revoke full access for ONE repo (the narrow trust write — the
    /// same user-level file `claudexor trust` owns). Returns the updated entry.
    public func updateTrust(repoRoot: String, allowFullAccess: Bool) async throws -> TrustEntry {
        var req = request("trust", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(TrustUpdateRequest(repoRoot: repoRoot, allowFullAccess: allowFullAccess))
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(TrustEntry.self, from: data)
    }

    /// Rename / archive a thread (PATCH /threads/:id).
    public func updateThread(id: String, body: UpdateThreadRequest) async throws -> ThreadSummary {
        var req = request("threads/\(id)", method: "PATCH")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ThreadSummary.self, from: data)
    }

    /// Deliver an isolated thread's accumulated worktree diff to its project.
    public func applyThread(id: String, body: ThreadApplyRequest) async throws -> ThreadApplyResponse {
        var req = request("threads/\(id)/apply", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ThreadApplyResponse.self, from: data)
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

    /// Full-snapshot setup lifecycle stream. Unknown names, malformed payloads,
    /// and buffer loss are protocol failures that force a scoped resnapshot.
    public func setupJobEvents(jobId: String, lastEventId: String) -> AsyncThrowingStream<SetupJobEvent, Error> {
        let escaped = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        let frames = sseFrames(path: "v2/setup/jobs/\(escaped)/events", lastEventId: lastEventId)
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(64)) { continuation in
            let task = Task {
                do {
                    for try await frame in frames {
                        switch frame.event {
                        case "end":
                            continuation.finish()
                            return
                        case "error":
                            throw GatewayError.transport(frame.data)
                        case "setup":
                            guard let data = frame.data.data(using: .utf8) else {
                                throw GatewayError.decoding("setup SSE payload is not UTF-8")
                            }
                            let event = try Self.decoder.decode(SetupJobEvent.self, from: data)
                            guard frame.id == event.cursor else {
                                throw GatewayError.decoding("setup SSE id does not match its durable event cursor")
                            }
                            guard try Self.yieldChecked(event, to: continuation, context: "setup SSE") else { return }
                        default:
                            throw GatewayError.decoding("unknown setup SSE event '\(frame.event)'")
                        }
                    }
                    throw GatewayError.transport("setup SSE ended without a terminal end event")
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Byte-level SSE consumption (SSEParser). `bytes.lines` is NEVER used here:
    /// it swallows the empty delimiter lines and silently drops every event.
    private func sseStream(path: String, lastEventId: Int?) -> AsyncThrowingStream<BusEnvelope, Error> {
        let frames = sseFrames(path: path, lastEventId: lastEventId.map(String.init))
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(256)) { continuation in
            let task = Task {
                do {
                    for try await frame in frames {
                        if frame.event == "end" {
                            continuation.finish()
                            return
                        }
                        if frame.event == "error" { throw GatewayError.transport(frame.data) }
                        guard !frame.event.isEmpty,
                              let id = frame.id, let sequence = Int(id), sequence >= 0,
                              let payload = Self.parseJSON(frame.data) else {
                            throw GatewayError.decoding("run SSE frame has an invalid name, id, or JSON payload")
                        }
                        let envelope = BusEnvelope(seq: sequence, kind: frame.event, event: payload)
                        guard try Self.yieldChecked(envelope, to: continuation, context: "run SSE") else { return }
                    }
                    throw GatewayError.transport("run SSE ended without a terminal end event")
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Raw byte-level frame stream shared by run and setup consumers. Keeping
    /// this below the DTO wrappers prevents the `AsyncBytes.lines` empty-line
    /// regression from returning through a second SSE implementation.
    func sseFrames(path: String, lastEventId: String?) -> AsyncThrowingStream<SSEFrame, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingOldest(256)) { continuation in
            let task = Task {
                do {
                    var req = self.request(path, method: "GET")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let last = lastEventId { req.setValue(last, forHTTPHeaderField: "Last-Event-ID") }
                    let (bytes, resp) = try await self.session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
                        throw GatewayError.http(status: status, body: "events stream failed")
                    }
                    guard http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("text/event-stream") == true else {
                        throw GatewayError.transport("events response is not text/event-stream")
                    }
                    var parser = SSEParser()
                    var chunk: [UInt8] = []
                    chunk.reserveCapacity(1024)
                    func flush() throws -> (stop: Bool, terminalEnd: Bool) {
                        defer { chunk.removeAll(keepingCapacity: true) }
                        for frame in parser.feed(chunk) {
                            guard try Self.yieldChecked(frame, to: continuation, context: "raw SSE") else {
                                return (true, false)
                            }
                            if frame.event == "end" { return (true, true) }
                        }
                        return (false, false)
                    }
                    for try await byte in bytes {
                        chunk.append(byte)
                        if byte == 0x0A {
                            let result = try flush()
                            if result.stop {
                                if result.terminalEnd { continuation.finish() }
                                return
                            }
                        }
                    }
                    let result = try flush()
                    if result.terminalEnd {
                        continuation.finish()
                    } else if result.stop {
                        return
                    } else {
                        throw GatewayError.transport("events stream ended without a terminal end event")
                    }
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
