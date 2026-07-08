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

    /// Text content of one artifact (markdown / code / json / log).
    func artifactTextContent(runId: String, path: String) async -> String? {
        guard let client else { return nil }
        return try? await client.artifactText(runId: runId, path: path)
    }

    // MARK: - Produced outputs (project artifacts/, not the run tree)

    /// List a run's PRODUCED outputs — files the run writes into the project's
    /// `artifacts/` folder — for the Canvas gallery. nil = load failed.
    func producedArtifacts(runId: String) async -> [ArtifactInfo]? {
        guard let client else { return nil }
        return try? await client.listProducedFiles(runId: runId)
    }

    /// Raw bytes of one produced output (images / pdf) for inline rendering or open.
    func producedBytes(runId: String, path: String) async -> Data? {
        guard let client else { return nil }
        return try? await client.producedData(runId: runId, path: path)
    }

    /// Text content of one produced output (markdown / code / json / log).
    func producedTextContent(runId: String, path: String) async -> String? {
        guard let client else { return nil }
        guard let data = try? await client.producedData(runId: runId, path: path) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}
