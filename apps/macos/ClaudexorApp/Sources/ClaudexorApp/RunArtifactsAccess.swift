import Foundation
import ClaudexorKit

/// Artifact/produced-output access for the gallery (Phase 3): thin client
/// calls; nil = the LOAD failed (offline/transport) — distinct from an
/// honest empty list, so the gallery can render its error state.
extension AppModel {
    // MARK: - Artifacts (Phase 3 gallery)

    /// List a run's produced artifacts (path/kind/bytes/mime) for the gallery.
    /// nil = the LOAD failed (offline/transport) — distinct from an honest
    /// empty list, so the gallery can show its error state.
    func runArtifacts(runId: String) async -> [ArtifactInfo]? {
        guard let client else { return nil }
        return try? await client.listRunArtifacts(runId: runId)
    }

    /// Raw bytes of one artifact (images / pdf) for inline rendering or open.
    func artifactBytes(runId: String, path: String) async -> Data? {
        guard let client else { return nil }
        return try? await client.artifactData(runId: runId, path: path)
    }

    /// Text content of one artifact (markdown / code / json / log), typed so a
    /// server refusal renders honestly (QA-067). A 409 sensitive-file / patch
    /// refusal becomes a `.notRenderable` reason the viewer shows verbatim, a 413
    /// oversize its own reason, and anything else `.offline` — never a silent nil
    /// the row would paint as a generic "engine offline" blob.
    func artifactTextOutcome(runId: String, path: String) async -> Result<String, PayloadError> {
        guard let client else { return .failure(ArtifactFetchError.offline(path: path)) }
        do { return .success(try await client.artifactText(runId: runId, path: path)) }
        catch { return .failure(ArtifactFetchError.payloadError(from: error, path: path)) }
    }

    // MARK: - Produced outputs (project artifacts/, not the run tree)

    /// List a run's PRODUCED outputs — files the run writes into the project's
    /// `artifacts/` folder — for the thread-workspace Artifacts gallery. nil = load failed.
    func producedArtifacts(runId: String) async -> [ArtifactInfo]? {
        guard let client else { return nil }
        return try? await client.listProducedFiles(runId: runId)
    }

    /// Raw bytes of one produced output (images / pdf) for inline rendering or open.
    func producedBytes(runId: String, path: String) async -> Data? {
        guard let client else { return nil }
        return try? await client.producedData(runId: runId, path: path)
    }

    /// Text content of one produced output (markdown / code / json / log), typed
    /// like `artifactTextOutcome` so a 409 sensitive-file refusal renders as its
    /// typed reason (QA-067).
    func producedTextOutcome(runId: String, path: String) async -> Result<String, PayloadError> {
        guard let client else { return .failure(ArtifactFetchError.offline(path: path)) }
        do {
            let data = try await client.producedData(runId: runId, path: path)
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
            case 413: return .notRenderable("\(path): Too large to preview here — open it from the run folder.")
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
    /// fence or the patch secret-like-token fence). Prefers the typed
    /// `sensitiveClass`, then the server `error` string, then a generic refusal —
    /// never the raw JSON problem body.
    static func sensitiveRefusalMessage(body: String) -> String {
        struct Body: Decodable {
            var error: String?
            var code: String?
            var sensitiveClass: String?
        }
        let decoded = body.data(using: .utf8).flatMap { try? JSONDecoder().decode(Body.self, from: $0) }
        if let cls = decoded?.sensitiveClass {
            let human: String
            switch cls {
            case "dotenv": human = "a dotenv (.env) file"
            case "package_registry_credentials": human = "a package-registry credentials file"
            case "credentials_file": human = "a credentials file"
            default: human = "a credential-bearing file"
            }
            return "Refused — Claudexor does not serve \(human)."
        }
        if let err = decoded?.error, !err.isEmpty {
            return "Refused — \(err)"
        }
        return "The engine refused to serve this file."
    }
}
