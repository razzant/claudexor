import SwiftUI
import AppKit
import ClaudexorKit

/// Phase 3 (Feature A): the artifacts gallery — renders a run's produced files
/// as evidence. M9-UX item 8: IMAGES render as large thumbnail cards in a grid;
/// text-like files (md/txt/yaml/json/log) render as COMPACT list rows (name,
/// size, one-line preview) that open a full text viewer with a proper LoadState;
/// everything else opens externally. Reuses the binary-aware
/// `GET /runs/:id/artifacts(/:path)` control-API path. Technical artifacts
/// (events.jsonl, context/, attempts/) stay in Diagnostics, not the gallery.
struct ArtifactGalleryView: View {
    @Environment(AppModel.self) private var model
    let runId: String
    /// When true, source the project's PRODUCED outputs (`/runs/:id/produced`)
    /// instead of the run's orchestration tree — and skip the run-tree filter.
    var produced: Bool = false
    /// D15: identity-keyed load slot — switching runs shows loading/empty, never
    /// the previous run's artifact list.
    @State private var slot = PayloadSlot<[ArtifactInfo]>()

    private var plane: PayloadPlane { produced ? .produced : .run }
    private var identity: PayloadIdentity { PayloadIdentity(runId: runId, plane: plane) }

    /// Filter the loaded list for display; the raw slot value is the fetch truth.
    private func display(_ artifacts: [ArtifactInfo]) -> [ArtifactInfo] {
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

    private var displayArtifacts: [ArtifactInfo] { display(slot.state.value ?? []) }
    /// Item 8 grouping: image cards vs. the compact document list (text + other).
    private var imageArtifacts: [ArtifactInfo] {
        displayArtifacts.filter { ArtifactCategory.of(mime: $0.mime, path: $0.path) == .image }
    }
    private var documentArtifacts: [ArtifactInfo] {
        displayArtifacts.filter { ArtifactCategory.of(mime: $0.mime, path: $0.path) != .image }
    }

    /// Images the run CHANGED anywhere in the project tree (typed diff
    /// evidence — F2.5 W-C7 part 3): agents drop screenshots wherever the
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
            if case .failed(let error) = slot.state {
                VStack(spacing: Theme.Spacing.sm) {
                    Text(error.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        .multilineTextAlignment(.center)
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
                .frame(maxWidth: .infinity).padding(Theme.Spacing.xl)
            } else if case .loading = slot.state, runChangedImages.isEmpty {
                ProgressView("Loading artifacts…").controlSize(.small)
                    .frame(maxWidth: .infinity).padding(Theme.Spacing.xl)
            } else if case .idle = slot.state, runChangedImages.isEmpty {
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity).padding(Theme.Spacing.xl)
            } else if displayArtifacts.isEmpty && runChangedImages.isEmpty {
                Text(produced
                     ? "No project outputs yet — files the run writes into the project's artifacts/ folder (and any images its diff touches) show up here."
                     : "No artifacts produced yet — files appear here as the run finishes its output.")
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).multilineTextAlignment(.center).padding(Theme.Spacing.xl)
            } else {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if !imageArtifacts.isEmpty { imagesSection }
                    if !documentArtifacts.isEmpty { documentsSection }
                }
                .padding(Theme.Spacing.md)
            }
        }
        // Loads on appear and whenever the selected run/plane changes. The slot's
        // identity keying (D15) drops the previous run's list the instant `runId`
        // changes, so a stale artifact list can never render under a new run.
        .task(id: identity) { await load() }
    }

    /// Images: large thumbnail cards in an adaptive grid.
    private var imagesSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Label("Images", systemImage: "photo.on.rectangle")
                .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: Theme.Spacing.md)],
                      alignment: .leading, spacing: Theme.Spacing.md) {
                ForEach(imageArtifacts) { art in
                    ArtifactImageCard(runId: runId, art: art, produced: produced)
                }
            }
        }
    }

    /// Text + other files: compact list rows (name, size, one-line preview).
    private var documentsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Label("Files", systemImage: "doc.on.doc")
                .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            LazyVStack(spacing: Theme.Spacing.xxs) {
                ForEach(documentArtifacts) { art in
                    ArtifactRow(runId: runId, art: art, produced: produced)
                }
            }
        }
    }

    private func load() async {
        let id = identity
        slot.begin(id)
        let list = produced
            ? await model.producedArtifacts(runId: runId)
            : await model.runArtifacts(runId: runId)
        guard let list else {
            // Load FAILED (offline/transport): show the typed error state instead
            // of silently rendering "no artifacts" over kept last-known data.
            slot.commit(.failed(.offline), for: id)
            return
        }
        // Keep last-known on a transient empty ONLY when we already have content
        // for THIS identity (a live run still producing) — never across a switch.
        if list.isEmpty, let existing = slot.state.value, !existing.isEmpty { return }
        slot.commit(list.isEmpty ? .empty : .loaded(list), for: id)
    }
}

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
        // Generic/absent mime: fall back to the extension for the common
        // text-like evidence formats (md/txt/yaml/json/log/csv/xml/svg).
        let ext = (path as NSString).pathExtension.lowercased()
        if ["md", "markdown", "txt", "text", "yaml", "yml", "json", "log", "csv", "xml", "svg"].contains(ext) {
            return .text
        }
        return .other
    }
}

/// Human file-size for a row's metadata line, or nil when the size is unknown.
func artifactSizeText(_ bytes: Int?) -> String? {
    guard let bytes else { return nil }
    return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
}

/// Write bytes to a fresh unpredictable 0700 dir and hand them to the system
/// opener (pdf, binaries, oversize images). Shared by the image card and the
/// document row. Release-wave sol #4: the artifact name is agent-controlled, so
/// a basename-only name under a fresh private dir + `.atomic` write closes the
/// symlink-overwrite primitive.
@MainActor
func openArtifactExternally(model: AppModel, runId: String, path: String, produced: Bool) async {
    let data = produced
        ? await model.producedBytes(runId: runId, path: path)
        : await model.artifactBytes(runId: runId, path: path)
    guard let data else { return }
    let base = ((path as NSString).lastPathComponent as NSString).lastPathComponent
    let safeName = base.isEmpty || base == "." || base == ".." ? "artifact" : base
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("claudexor-open-\(UUID().uuidString)", isDirectory: true)
    do {
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let url = dir.appendingPathComponent(safeName)
        try data.write(to: url, options: [.atomic])
        NSWorkspace.shared.open(url)
    } catch { /* opening a preview is best-effort */ }
}

// MARK: - Image card (large thumbnail)

private struct ArtifactImageCard: View {
    @Environment(AppModel.self) private var model
    let runId: String
    let art: ArtifactInfo
    var produced: Bool = false
    /// D15 identity-keyed image slot: a card reused for a different run/path never
    /// shows the previous file's bytes. `DecodedImage` boxes the actor crossing.
    @State private var imageSlot = PayloadSlot<DecodedImage>()

    private var identity: PayloadIdentity {
        PayloadIdentity(runId: runId, plane: produced ? .produced : .run, path: art.path)
    }
    private var image: NSImage? { imageSlot.state.value?.image }
    private var imageLoadFailed: Bool { if case .failed = imageSlot.state { return true }; return false }
    private var fileName: String { (art.path as NSString).lastPathComponent }

    var body: some View {
        Button { Task { await openArtifactExternally(model: model, runId: runId, path: art.path, produced: produced) } } label: {
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
        .help("\(art.path) — click to open full size")
        .task(id: identity) { await loadImage() }
    }

    @ViewBuilder private var preview: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit()
            } else if imageLoadFailed {
                Image(systemName: "photo.badge.exclamationmark").font(.system(size: 28)).foregroundStyle(.secondary)
                    .help("Too large to preview — click to open externally")
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(height: 88).frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
    }

    /// Off-main handoff of an already-bounded decode (same Swift 6 actor-
    /// crossing box as ScopedInlineImage). Equatable-by-identity so it can ride
    /// the value-typed load slot.
    struct DecodedImage: @unchecked Sendable, Equatable {
        let image: NSImage?
        static func == (lhs: DecodedImage, rhs: DecodedImage) -> Bool { lhs.image === rhs.image }
    }

    private func loadImage() async {
        let id = identity
        imageSlot.begin(id)
        guard imageSlot.state.value == nil else { return }
        let data = produced
            ? await model.producedBytes(runId: runId, path: art.path)
            : await model.artifactBytes(runId: runId, path: art.path)
        guard let data else {
            imageSlot.commit(.failed(.offline), for: id)
            return
        }
        // W3.7: the SAME bounded decode as inline chat previews, OFF the main
        // actor — a gallery of full-resolution screenshots must not full-decode
        // in `body`'s task.
        let key = "\(runId)|\(produced ? "produced" : "run")|\(art.path)"
        let decoded = await Task.detached(priority: .userInitiated) {
            DecodedImage(image: ScopedInlineImage.boundedPreview(data: data, cacheKey: key))
        }.value
        if decoded.image != nil {
            imageSlot.commit(.loaded(decoded), for: id)
        } else {
            imageSlot.commit(.failed(.notRenderable("Too large to preview — click to open externally")), for: id)
        }
    }
}

// MARK: - Document row (compact: name, size, one-line preview)

private struct ArtifactRow: View {
    @Environment(AppModel.self) private var model
    let runId: String
    let art: ArtifactInfo
    var produced: Bool = false

    /// D15 identity-keyed text slot: a row reused for a different run/path never
    /// shows the previous file's text. Fetched lazily so it both feeds the
    /// one-line preview AND warms the viewer — tapping opens INSTANTLY into
    /// whatever state the fetch is in (loading spinner / text / failed), which is
    /// the M9-UX item-8 bug fix: the viewer no longer blocks on the whole fetch
    /// before appearing.
    @State private var textSlot = PayloadSlot<String>()
    @State private var showViewer = false

    private var category: ArtifactCategory { ArtifactCategory.of(mime: art.mime, path: art.path) }
    private var isText: Bool { category == .text }
    private var identity: PayloadIdentity {
        PayloadIdentity(runId: runId, plane: produced ? .produced : .run, path: art.path)
    }
    private var fileName: String { (art.path as NSString).lastPathComponent }

    var body: some View {
        Button(action: tap) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: glyph).font(.body).foregroundStyle(.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(fileName).font(.callout).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(subtitle).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Image(systemName: isText ? "chevron.right" : "arrow.up.forward.app")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.vertical, Theme.Spacing.xs)
            .padding(.horizontal, Theme.Spacing.sm)
            .frame(maxWidth: .infinity)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isText ? "\(art.path) — open text viewer" : "\(art.path) — open externally")
        // Lazily fetch text for the preview + viewer (visible rows only).
        .task(id: identity) { if isText { await loadText() } }
        .sheet(isPresented: $showViewer) { textViewer }
    }

    /// The one-line summary: type · size, plus a content preview once loaded.
    private var subtitle: String {
        var parts: [String] = []
        if let size = artifactSizeText(art.bytes) { parts.append(size) }
        if isText, let preview = previewLine {
            parts.append(preview)
        } else if !isText {
            parts.append(art.mime ?? "file")
        }
        return parts.isEmpty ? (art.mime ?? "file") : parts.joined(separator: " · ")
    }

    /// The first non-blank line of the loaded text, bounded — the row preview.
    private var previewLine: String? {
        switch textSlot.state {
        case .loaded(let text):
            let line = text.split(whereSeparator: \.isNewline)
                .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            return line.map { String($0.prefix(140)) } ?? "(blank)"
        case .empty: return "(empty file)"
        case .loading, .idle: return "Loading…"
        case .failed: return nil
        }
    }

    private var glyph: String {
        if isText {
            let ext = (art.path as NSString).pathExtension.lowercased()
            if ext == "json" || art.mime == "application/json" { return "curlybraces" }
            if ext == "md" || ext == "markdown" { return "doc.text.image" }
            return "doc.text"
        }
        if art.mime == "application/pdf" { return "doc.richtext" }
        return "doc"
    }

    private func tap() {
        if isText {
            showViewer = true                       // opens INSTANTLY; content streams in
        } else {
            Task { await openArtifactExternally(model: model, runId: runId, path: art.path, produced: produced) }
        }
    }

    @ViewBuilder private var textViewer: some View {
        VStack(spacing: 0) {
            HStack {
                Text(fileName).font(.headline)
                Spacer()
                Button("Done") { showViewer = false }
            }
            .padding(Theme.Spacing.md)
            Divider()
            Group {
                switch textSlot.state {
                case .loaded(let text):
                    ScrollView {
                        MarkdownOutputView(markdown: text)
                            .padding(Theme.Spacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case .empty:
                    ContentUnavailableView("Empty file", systemImage: "doc")
                case .failed(let error):
                    VStack(spacing: Theme.Spacing.sm) {
                        Text(error.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                            .multilineTextAlignment(.center)
                        Button("Retry") { Task { await loadText(force: true) } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .idle, .loading:
                    ProgressView("Loading \(fileName)…").controlSize(.small)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(minWidth: 520, minHeight: 360)
    }

    private func loadText(force: Bool = false) async {
        let id = identity
        if force { textSlot = PayloadSlot<String>() }
        textSlot.begin(id)
        // Already terminal for this identity (a warmed preview) — don't refetch.
        if !force, textSlot.state.isTerminal { return }
        let content = produced
            ? await model.producedTextContent(runId: runId, path: art.path)
            : await model.artifactTextContent(runId: runId, path: art.path)
        guard let content else {
            textSlot.commit(.failed(.offline), for: id)
            return
        }
        textSlot.commit(content.isEmpty ? .empty : .loaded(content), for: id)
    }
}
