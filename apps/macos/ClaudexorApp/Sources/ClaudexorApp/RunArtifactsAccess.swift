import Foundation
import ClaudexorKit

/// Artifact/produced-output access for the gallery (Phase 3): thin client
/// calls; nil = the LOAD failed (offline/transport) — distinct from an
/// honest empty list, so the gallery can render its error state.
extension AppModel {
    /// Preserve the server's typed failure while retaining the original bytes
    /// for a gallery snapshot. Text decoding remains a consumer decision.
    func artifactDataOutcome(
        runId: String, path: String, produced: Bool,
        locationID: ExecutionLocationID? = nil
    ) async -> Result<Data, PayloadError> {
        guard let requestClient = gateway(for: locationID ?? selectedExecutionLocation) else {
            return .failure(ArtifactFetchError.offline(path: path))
        }
        do {
            let data = produced
                ? try await requestClient.producedData(runId: runId, path: path)
                : try await requestClient.artifactData(runId: runId, path: path)
            return .success(data)
        } catch { return .failure(ArtifactFetchError.payloadError(from: error, path: path)) }
    }

    // MARK: - Artifacts (Phase 3 gallery)

    /// List a run's produced artifacts (path/kind/bytes/mime) for the gallery.
    /// nil = the LOAD failed (offline/transport) — distinct from an honest
    /// empty list, so the gallery can show its error state.
    func runArtifacts(
        runId: String,
        locationID: ExecutionLocationID? = nil
    ) async -> [ArtifactInfo]? {
        guard let requestClient = gateway(for: locationID ?? selectedExecutionLocation) else { return nil }
        return try? await requestClient.listRunArtifacts(runId: runId)
    }

    /// Raw bytes of one artifact (images / pdf) for inline rendering or open.
    func artifactBytes(
        runId: String,
        path: String,
        locationID: ExecutionLocationID? = nil
    ) async -> Data? {
        guard let requestClient = gateway(for: locationID ?? selectedExecutionLocation) else { return nil }
        return try? await requestClient.artifactData(runId: runId, path: path)
    }

    /// Text content of one artifact (markdown / code / json / log), typed so a
    /// server refusal renders honestly (QA-067). A 409 sensitive-file / patch
    /// refusal becomes a `.notRenderable` reason the viewer shows verbatim, a 413
    /// oversize its own reason, and anything else `.offline` — never a silent nil
    /// the row would paint as a generic "engine offline" blob.
    func artifactTextOutcome(
        runId: String,
        path: String,
        locationID: ExecutionLocationID? = nil
    ) async -> Result<String, PayloadError> {
        guard let requestClient = gateway(for: locationID ?? selectedExecutionLocation) else {
            return .failure(ArtifactFetchError.offline(path: path))
        }
        do { return .success(try await requestClient.artifactText(runId: runId, path: path)) }
        catch { return .failure(ArtifactFetchError.payloadError(from: error, path: path)) }
    }

    // MARK: - Produced outputs (project artifacts/, not the run tree)

    /// List a run's PRODUCED outputs — files the run writes into the project's
    /// `artifacts/` folder — for the thread-workspace Artifacts gallery. nil = load failed.
    func producedArtifacts(
        runId: String,
        locationID: ExecutionLocationID? = nil
    ) async -> [ArtifactInfo]? {
        guard let requestClient = gateway(for: locationID ?? selectedExecutionLocation) else { return nil }
        return try? await requestClient.listProducedFiles(runId: runId)
    }

    /// Raw bytes of one produced output (images / pdf) for inline rendering or open.
    func producedBytes(
        runId: String,
        path: String,
        locationID: ExecutionLocationID? = nil
    ) async -> Data? {
        guard let requestClient = gateway(for: locationID ?? selectedExecutionLocation) else { return nil }
        return try? await requestClient.producedData(runId: runId, path: path)
    }

    /// Text content of one produced output (markdown / code / json / log), typed
    /// like `artifactTextOutcome` so a 409 sensitive-file refusal renders as its
    /// typed reason (QA-067).
    func producedTextOutcome(
        runId: String,
        path: String,
        locationID: ExecutionLocationID? = nil
    ) async -> Result<String, PayloadError> {
        guard let requestClient = gateway(for: locationID ?? selectedExecutionLocation) else {
            return .failure(ArtifactFetchError.offline(path: path))
        }
        do {
            let data = try await requestClient.producedData(runId: runId, path: path)
            // STRICT decode (round-3 crit #3): `String(decoding:as:UTF8.self)` silently
            // REPLACES malformed bytes with U+FFFD and paints corruption as if it were
            // real text. Refuse a non-UTF-8 body with its path instead.
            guard let text = String(data: data, encoding: .utf8) else {
                return .failure(.notRenderable("\(path) is not valid UTF-8 text — open it from the run folder."))
            }
            return .success(text)
        } catch { return .failure(ArtifactFetchError.payloadError(from: error, path: path)) }
    }
}

/// Maps a `GatewayError` from an artifact/produced fetch onto the typed
/// `PayloadError` the gallery renders (QA-067). Every projected failure carries
/// the artifact PATH (round-3 #2) so the failure view names the exact file, never
/// a bare basename or a generic "engine offline" blob. Pure + testable — no network.
enum ArtifactFetchError {
    /// The engine was unreachable (or the error was not a recognizable HTTP
    /// status) for THIS file — carries the path so the failure view + Retry name
    /// the exact artifact (round-3 #2).
    static func offline(path: String) -> PayloadError {
        .transport("\(path): The engine is offline or the request failed. Reopen this tab to retry.")
    }

    static func payloadError(from error: Error, path: String) -> PayloadError {
        guard let gateway = error as? GatewayError else { return offline(path: path) }
        switch gateway {
        case .http(let status, let body):
            switch status {
            case 409: return .notRenderable("\(path): \(sensitiveRefusalMessage(body: body))")
            case 413:
                // #535: an exact result too large to render as one patch is a typed
                // absence of the VIEW (it stays applyable and revertable).
                if let unrendered = unrenderedPatchMessage(body: body) { return .notRenderable(unrendered) }
                return .notRenderable("\(path): Too large to preview here — open it from the run folder.")
            default: return offline(path: path)
            }
        case .decoding:
            // Strict UTF-8 decode failed in the client (malformed bytes on the
            // artifact-text path): refuse as not-renderable naming the file, the
            // same honest outcome producedTextOutcome gives for a non-UTF-8 body.
            return .notRenderable("\(path) is not valid UTF-8 text — open it from the run folder.")
        case .transport:
            return offline(path: path)
        }
    }

    /// Human refusal for a server 409 (the `sensitive_file_refused` credential
    /// fence or the patch secret-like-token fence).
    ///
    /// The body is the daemon's NORMALIZED `ControlProblem` (RFC-9457-style): the
    /// daemon funnels every >=400 JSON body through `controlProblemError` /
    /// `problemBody`, so the human string lands in `message` (NOT `error`) and the
    /// refusal class rides in `context.sensitiveClass` (NOT a top-level key). This
    /// decoder mirrors that real wire shape — proven by the server's own test in
    /// `packages/control-api/src/control-api.test.ts` (`body.context?.sensitiveClass`).
    /// Prefers the typed `context.sensitiveClass`, then the human `message`, then a
    /// generic refusal — never the raw JSON problem body. A legacy/hostile body that
    /// carries neither (e.g. an old top-level-`error`/`sensitiveClass` shape the real
    /// daemon never emits) falls back generically.
    /// The engine's typed `patch_view_unavailable` 413 (#535) as one honest line;
    /// nil for any other body (an ordinary oversize artifact).
    static func unrenderedPatchMessage(body: String) -> String? {
        struct Body: Decodable {
            struct Inventory: Decodable { var changedFiles: Int? }
            var code: String?
            var reason: String?
            var estimatedBytes: Int?
            var inventory: Inventory?
        }
        guard let decoded = body.data(using: .utf8).flatMap({ try? JSONDecoder().decode(Body.self, from: $0) }),
              decoded.code == "patch_view_unavailable"
        else { return nil }
        let files = decoded.inventory?.changedFiles.map { "\($0) changed file\($0 == 1 ? "" : "s"); " } ?? ""
        let lead = decoded.reason == "render_failed"
            ? "The patch for these changes could not be rendered"
            : "These changes are too large to show as one patch"
        return "\(lead) (\(files)kept exactly). Apply and Revert still work; open the run folder to inspect the files."
    }

    static func sensitiveRefusalMessage(body: String) -> String {
        struct Body: Decodable {
            struct Context: Decodable { var sensitiveClass: String? }
            var message: String?
            var code: String?
            var context: Context?
        }
        let decoded = body.data(using: .utf8).flatMap { try? JSONDecoder().decode(Body.self, from: $0) }
        if let cls = decoded?.context?.sensitiveClass {
            let human: String
            switch cls {
            case "dotenv": human = "a dotenv (.env) file"
            case "package_registry_credentials": human = "a package-registry credentials file"
            case "credentials_file": human = "a credentials file"
            default: human = "a credential-bearing file"
            }
            return "Refused — Claudexor does not serve \(human)."
        }
        if let message = decoded?.message, !message.isEmpty {
            return "Refused — \(message)"
        }
        return "The engine refused to serve this file."
    }
}
