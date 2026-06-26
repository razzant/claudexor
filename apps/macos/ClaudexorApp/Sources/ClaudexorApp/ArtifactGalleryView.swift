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
    @State private var artifacts: [ArtifactInfo] = []
    @State private var loadError: String?

    private var displayArtifacts: [ArtifactInfo] {
        artifacts.filter {
            $0.kind == "file"
                && !$0.path.hasSuffix("events.jsonl")
                && !$0.path.hasPrefix("context/")
                && !$0.path.hasPrefix("attempts/")
        }
    }

    var body: some View {
        ScrollView {
            if let loadError {
                Text(loadError).font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(Theme.Spacing.xl)
            } else if displayArtifacts.isEmpty {
                Text("No artifacts produced yet — files appear here as the run finishes its output.")
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).multilineTextAlignment(.center).padding(Theme.Spacing.xl)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: Theme.Spacing.md)],
                          alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(displayArtifacts) { art in
                        ArtifactCard(runId: runId, art: art)
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
        let list = await model.runArtifacts(runId: runId)
        if list.isEmpty && !artifacts.isEmpty { return } // keep last-known on a transient empty
        artifacts = list
        loadError = nil
    }
}

private struct ArtifactCard: View {
    @Environment(AppModel.self) private var model
    let runId: String
    let art: ArtifactInfo
    @State private var image: NSImage?
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
        }
    }

    private func loadImage() async {
        guard image == nil, let data = await model.artifactBytes(runId: runId, path: art.path) else { return }
        image = NSImage(data: data)
    }

    private func loadText() async {
        if text == nil { text = await model.artifactTextContent(runId: runId, path: art.path) }
    }

    /// Write the bytes to a temp file and hand it to the system opener (pdf, etc.).
    private func openExternally() async {
        guard let data = await model.artifactBytes(runId: runId, path: art.path) else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
        do {
            try data.write(to: url)
            NSWorkspace.shared.open(url)
        } catch { /* opening a preview is best-effort */ }
    }
}
