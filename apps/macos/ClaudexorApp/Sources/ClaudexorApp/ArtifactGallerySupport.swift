import Foundation
import AppKit
import ClaudexorKit
import SwiftUI

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

    static func previewKind(mime: String?, path: String) -> AgentFilePreviewKind {
        let kind = ScopedInlineImage.previewKind(path: path)
        if case .blocked = kind, of(mime: mime, path: path) == .text { return .source }
        return kind
    }

    /// QA-067 (issue-067) PARITY: the App's text set MUST match the server's
    /// `SEMANTIC_TEXT_EXTENSIONS` (`packages/control-api/src/artifact-read.ts`,
    /// checked by `scripts/artifact-text-parity-check.mjs`), which grew in Ф2 to
    /// cover source code + config/markup. The server serves these exactly
    /// through the 4-MiB-capped TEXT path (INV-146); the App must agree so an
    /// eager preview treats them as text in the in-app viewer instead of sending
    /// them down the raw-binary "open externally" path. Truly-binary types
    /// (images, PDFs, archives) stay `.other`. Keep this in lockstep with the
    /// server set.
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
    produced: Bool,
    mime: String? = nil
) async throws -> SafeFilePreviewRequest {
    let bytes = try await model.artifactDataOutcome(
        runId: runId, path: path, produced: produced, locationID: locationID).get()
    let kind = ArtifactCategory.previewKind(mime: mime, path: path)
    if kind == .source || kind == .markdown,
       String(data: bytes, encoding: .utf8) == nil {
        throw ArtifactFetchError.payloadError(from: GatewayError.decoding("Invalid UTF-8"), path: path)
    }
    let url = try ExternalArtifactHandoff.standard()
        .stage(data: bytes, suggestedName: (path as NSString).lastPathComponent)
    let task = model.task(runId, at: locationID)
    var request = SafeFilePreviewRequest.localFile(
        url: url, kind: kind, fileScopeRoots: task?.fileScopeRoots ?? [])
    request.remoteFileScope = task?.remoteFileScope
    return request
}

/// The gallery presents its existing payload state immediately, before a fetch
/// completes. A successful load hands the same retained snapshot to the viewer.
struct ArtifactPreviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let state: LoadState<SafeFilePreviewRequest>
    let path: String
    let retry: () -> Void

    var body: some View {
        if case .loaded(let request) = state {
            SafeFilePreviewSheet(request: request)
        } else {
            VStack(spacing: Theme.Spacing.md) {
                Text(path).font(.headline).textSelection(.enabled)
                Spacer()
                switch state {
                case .failed(let error):
                    Text(error.message).foregroundStyle(.secondary).textSelection(.enabled)
                    Button("Retry", action: retry).buttonStyle(.bordered)
                case .empty:
                    ContentUnavailableView("Empty file", systemImage: "doc")
                default:
                    ProgressView("Loading \(path)…")
                }
                Spacer()
                HStack {
                    Spacer()
                    Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
                }
            }
            .padding(Theme.Spacing.lg)
            .frame(minWidth: 720, minHeight: 520)
        }
    }
}
