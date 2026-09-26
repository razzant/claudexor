import Foundation
import AppKit
import ClaudexorKit

// Support types for the artifacts gallery, split out of ArtifactGalleryView.swift
// so the view file stays under the readability cap. These are pure/standalone
// (the file categorizer, the size formatter, the external-open handoff, and the
// aggregated-load decision) and are unit-tested directly.

/// The evidence category of one artifact — drives whether it renders as an image
/// card, a compact text row (with a full text viewer), or an open-externally row.
/// Pure so the mapping is unit-tested (mime first, filename extension fallback).
enum ArtifactCategory {
    case image, text, other

    static func of(mime: String?, path: String) -> ArtifactCategory {
        let m = mime ?? ""
        if m.hasPrefix("image/") && m != "image/svg+xml" { return .image }
        if m.hasPrefix("text/") || m == "application/json"
            || m == "application/x-yaml" || m == "application/yaml" { return .text }
        // Generic/absent mime: fall back to the extension.
        let ext = (path as NSString).pathExtension.lowercased()
        if semanticTextExtensions.contains(ext) { return .text }
        return .other
    }

    /// QA-067 (issue-067) PARITY: the App's text set MUST match the server's
    /// `SEMANTIC_TEXT_EXTENSIONS` (`packages/control-api/src/artifact-serve-routes.ts`),
    /// which grew in Ф2 to cover source code + config/markup. The server now
    /// routes these through the redacting, 4-MiB-capped TEXT path; the App must
    /// agree so an eager preview treats them as (redaction-aware) text in the
    /// in-app viewer instead of sending them down the raw-binary "open
    /// externally" path. Truly-binary types (images, PDFs, archives) stay
    /// `.other`. Keep this in lockstep with the server set.
    static let semanticTextExtensions: Set<String> = [
        // markup / structured data (server text/* MIME or semantic-text)
        "md", "markdown", "txt", "text", "yaml", "yml", "json", "log",
        "csv", "xml", "svg", "json5", "toml", "ini", "cfg", "conf", "css",
        // source code
        "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "py", "rb", "go",
        "rs", "java", "c", "h", "cpp", "sql",
    ]
}

/// Human file-size for a row's metadata line, or nil when the size is unknown.
func artifactSizeText(_ bytes: Int?) -> String? {
    guard let bytes else { return nil }
    return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
}

/// The pure decision `ArtifactGalleryView.load()` makes once the per-run listings
/// are aggregated — separated from the @State mutation so the retain-vs-disclose
/// branching is unit-tested (a whole-set refresh failure over a nonempty snapshot
/// must be DISCLOSED, not passed off as freshly confirmed).
enum GalleryLoadDecision: Equatable {
    /// Nothing loaded anywhere and the refresh failed → the typed error state.
    case fail
    /// A whole-set refresh FAILED while a nonempty snapshot is already shown →
    /// keep last-known bytes but disclose (`failed` names the runs that errored;
    /// empty means a benign transient empty — a live run still producing).
    case keepStale(failed: [String])
    /// Commit the freshly aggregated snapshot (empty or loaded) + its failed set.
    case commit(failed: [String])
}

/// Stage bytes in a fresh unpredictable 0700 dir for the in-app preview sheet.
/// Shared by the image card and document row. The artifact name is agent-controlled, so
/// a basename-only name under a fresh private dir + `.atomic` write closes the
/// symlink-overwrite primitive. QA-062: the copy now lives under the single
/// TRACKED handoff root (`ExternalArtifactHandoff`) so a bounded-age startup
/// sweep can reclaim it — the write-side hardening is unchanged.
@MainActor
func stagedArtifactPreview(
    model: AppModel,
    locationID: ExecutionLocationID,
    runId: String,
    path: String,
    produced: Bool
) async throws -> SafeFilePreviewRequest {
    let data = produced
        ? await model.producedBytes(runId: runId, path: path, locationID: locationID)
        : await model.artifactBytes(runId: runId, path: path, locationID: locationID)
    guard let data else { throw CocoaError(.fileReadUnknown) }
    let url = try ExternalArtifactHandoff.standard()
        .stage(data: data, suggestedName: (path as NSString).lastPathComponent)
    return .localFile(url: url, kind: ScopedInlineImage.previewKind(path: path))
}
