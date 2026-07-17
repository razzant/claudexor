import SwiftUI
import AppKit
import ClaudexorKit

/// Phase 3 (Feature A): the artifacts gallery — renders a run's produced files
/// (markdown / code / image / pdf) as cards. Images render inline; text opens in
/// a sheet; anything else opens externally. Reuses the binary-aware
/// `GET /runs/:id/artifacts(/:path)` control-API path. Technical artifacts
/// (events.jsonl, context/, attempts/) stay in Diagnostics, not the gallery.
struct ArtifactGalleryView: View {
    @Environment(AppModel.self) private var model
    let runId: String
    /// When true, source the project's PRODUCED outputs (`/runs/:id/produced`)
    /// instead of the run's orchestration tree — and skip the run-tree filter.
    var produced: Bool = false
    @State private var artifacts: [ArtifactInfo] = []
    @State private var loadError: String?

    private var displayArtifacts: [ArtifactInfo] {
        // The produced endpoint already returns only project outputs, so show all
        // files it returns. The run-tree filter only applies to the run artifacts.
        if produced {
            return artifacts.filter { $0.kind == "file" }
        }
        return artifacts.filter {
            $0.kind == "file"
                && !$0.path.hasSuffix("events.jsonl")
                && !$0.path.hasPrefix("context/")
                && !$0.path.hasPrefix("attempts/")
        }
    }

    /// Images the run CHANGED anywhere in the project tree (typed diff
    /// evidence — Ф2.5 W-C7 part 3): agents drop screenshots wherever the
    /// task says, not just artifacts/, so the canvas surfaces every image the
    /// diff touched — same canonical scope gate as inline chat previews.
    private var runChangedImages: [String] {
        guard produced, let run = model.task(runId) else { return [] }
        return Self.runImagePaths(diffPaths: run.diff.map(\.path), repoRoot: run.repoRoot)
    }

    /// Pure derivation (unit-tested): diff-relative paths -> absolute image
    /// paths that pass the thread-scope gate on the real filesystem.
    static func runImagePaths(diffPaths: [String], repoRoot: String?) -> [String] {
        guard let root = repoRoot, !root.isEmpty else { return [] }
        return diffPaths
            .map { ($0 as NSString).isAbsolutePath ? $0 : (root as NSString).appendingPathComponent($0) }
            .compactMap { ScopedInlineImage.scopedImagePath($0, roots: [root]) }
    }

    var body: some View {
        ScrollView {
            if !runChangedImages.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Label("Images this run changed", systemImage: "photo.badge.checkmark")
                        .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: Theme.Spacing.md)],
                              alignment: .leading, spacing: Theme.Spacing.md) {
                        ForEach(runChangedImages, id: \.self) { path in
                            ScopedInlineImage(target: path,
                                              alt: (path as NSString).lastPathComponent,
                                              roots: [model.task(runId)?.repoRoot].compactMap { $0 })
                        }
                    }
                }
                .padding(Theme.Spacing.md)
                Divider()
            }
            if let loadError {
                Text(loadError).font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(Theme.Spacing.xl)
            } else if displayArtifacts.isEmpty && runChangedImages.isEmpty {
                Text(produced
                     ? "No project outputs yet — files the run writes into the project's artifacts/ folder (and any images its diff touches) show up here."
                     : "No artifacts produced yet — files appear here as the run finishes its output.")
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).multilineTextAlignment(.center).padding(Theme.Spacing.xl)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: Theme.Spacing.md)],
                          alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(displayArtifacts) { art in
                        ArtifactCard(runId: runId, art: art, produced: produced)
                    }
                }
                .padding(Theme.Spacing.md)
            }
        }
        // Loads on appear and whenever the selected run changes. (The inspector
        // re-creates this view when you switch to the Artifacts tab, so re-opening
        // it after the run produces output refreshes the list.)
        .task(id: runId) { await load() }
    }

    private func load() async {
        let list = produced
            ? await model.producedArtifacts(runId: runId)
            : await model.runArtifacts(runId: runId)
        guard let list else {
            // Load FAILED (offline/transport): show the error state instead of
            // silently rendering "no artifacts" over kept last-known data.
            loadError = "Could not load artifacts — the engine is offline or the request failed. Re-open this tab to retry."
            return
        }
        if list.isEmpty && !artifacts.isEmpty { return } // keep last-known on a transient empty
        artifacts = list
        loadError = nil
    }
}

private struct ArtifactCard: View {
    @Environment(AppModel.self) private var model
    let runId: String
    let art: ArtifactInfo
    /// Mirror of the gallery's flag — route byte/text fetches at the produced path.
    var produced: Bool = false
    @State private var image: NSImage?
    @State private var imageLoadFailed = false
    @State private var text: String?
    @State private var showText = false

    private var mime: String { art.mime ?? "" }
    private var isImage: Bool { mime.hasPrefix("image/") && mime != "image/svg+xml" }
    private var isText: Bool { mime.hasPrefix("text/") || mime == "application/json" }
    private var fileName: String { (art.path as NSString).lastPathComponent }

    var body: some View {
        Button(action: tap) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                preview
                Text(fileName).font(.caption).lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(Theme.Spacing.sm)
            .frame(maxWidth: .infinity)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .help(art.path)
        .task(id: art.id) { if isImage { await loadImage() } }
        .sheet(isPresented: $showText) { textSheet }
    }

    @ViewBuilder private var preview: some View {
        Group {
            if isImage, let image {
                Image(nsImage: image).resizable().scaledToFit()
            } else if isImage, imageLoadFailed {
                Image(systemName: "photo.badge.exclamationmark").font(.system(size: 28)).foregroundStyle(.secondary)
                    .help("Too large to preview — tap to open externally")
            } else {
                Image(systemName: glyph).font(.system(size: 28)).foregroundStyle(.secondary)
            }
        }
        .frame(height: 88).frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
    }

    private var glyph: String {
        if isImage { return "photo" }
        if isText { return mime == "application/json" ? "curlybraces" : "doc.text" }
        if mime == "application/pdf" { return "doc.richtext" }
        return "doc"
    }

    @ViewBuilder private var textSheet: some View {
        VStack(spacing: 0) {
            HStack {
                Text(fileName).font(.headline)
                Spacer()
                Button("Done") { showText = false }
            }
            .padding(Theme.Spacing.md)
            Divider()
            ScrollView {
                MarkdownOutputView(markdown: text ?? "Loading…")
                    .padding(Theme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 520, minHeight: 360)
    }

    private func tap() {
        if isText {
            Task { await loadText(); showText = true }
        } else if !isImage {
            Task { await openExternally() }
        } else if image == nil {
            // Un-previewable / oversize image: hand the bytes to the system opener
            // instead of leaving a silent dead-end blank card.
            Task { await openExternally() }
        }
    }

    /// Off-main handoff of an already-bounded decode (same Swift 6 actor-
    /// crossing box as ScopedInlineImage).
    private struct DecodedCard: @unchecked Sendable { let image: NSImage? }

    private func loadImage() async {
        guard image == nil, !imageLoadFailed else { return }
        let data = produced
            ? await model.producedBytes(runId: runId, path: art.path)
            : await model.artifactBytes(runId: runId, path: art.path)
        guard let data else {
            imageLoadFailed = true
            return
        }
        // W3.7: the SAME bounded decode as inline chat previews (thumbnail
        // bound + byte-costed cache), OFF the main actor — a gallery of
        // full-resolution screenshots must not full-decode in `body`'s task.
        let key = "\(runId)|\(produced ? "produced" : "run")|\(art.path)"
        let decoded = await Task.detached(priority: .userInitiated) {
            DecodedCard(image: ScopedInlineImage.boundedPreview(data: data, cacheKey: key))
        }.value
        if let loaded = decoded.image {
            image = loaded
        } else {
            imageLoadFailed = true
        }
    }

    private func loadText() async {
        if text == nil {
            text = produced
                ? await model.producedTextContent(runId: runId, path: art.path)
                : await model.artifactTextContent(runId: runId, path: art.path)
        }
    }

    /// Write the bytes to a temp file and hand it to the system opener (pdf, etc.).
    private func openExternally() async {
        let data = produced
            ? await model.producedBytes(runId: runId, path: art.path)
            : await model.artifactBytes(runId: runId, path: art.path)
        guard let data else { return }
        // Release wave sol #4: the artifact NAME is agent-controlled and the
        // shared temp dir is predictable — a precreated symlink at that path
        // would turn "open preview" into an arbitrary user-file overwrite.
        // Fresh unpredictable 0700 dir + basename-only name closes both legs
        // of the primitive; .atomic replaces (never follows) a destination.
        let base = (fileName as NSString).lastPathComponent
        let safeName = base.isEmpty || base == "." || base == ".." ? "artifact" : base
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-open-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: dir,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700],
            )
            let url = dir.appendingPathComponent(safeName)
            try data.write(to: url, options: [.atomic])
            NSWorkspace.shared.open(url)
        } catch { /* opening a preview is best-effort */ }
    }
}
