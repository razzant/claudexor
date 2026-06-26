import SwiftUI
import WebKit
import ClaudexorKit

// MARK: - Mini-browser (Phase 5, Feature B)

/// Holds one WKWebView so SwiftUI toolbar buttons (back/forward/reload) can drive
/// it. WebKit views are created on the main actor.
@MainActor final class WebViewStore: ObservableObject {
    let webView: WKWebView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    func load(_ url: URL) {
        // WKWebView CANNOT load a file:// URL via load(URLRequest:) — it needs
        // loadFileURL(_:allowingReadAccessTo:) with explicit read access. Grant the
        // project ROOT so the page's relative js/, css/ (and ES-module/importmap)
        // assets resolve, not just the index.html's own directory.
        if url.isFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.load(URLRequest(url: url))
        }
    }
}

/// WKWebView bridged into SwiftUI. Web content is dense → it sits on a SOLID
/// surface, never glass-on-glass (design system §3).
struct WebPreview: NSViewRepresentable {
    let store: WebViewStore
    func makeNSView(context: Context) -> WKWebView { store.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

/// User-driven mini-browser: a solid toolbar (back/forward/reload + URL field)
/// over a WKWebView — for localhost dev-server previews, rendered run outputs, or
/// arbitrary URLs the user types. (Agent-driven browsing is a separate mirrored
/// Chromium via Playwright MCP — Phase 7.)
struct BrowserView: View {
    /// When set (and the file exists on disk), auto-load it once on first appear —
    /// e.g. the project's index.html — without clobbering a URL the user typed.
    var autoLoadFile: String? = nil
    @StateObject private var store = WebViewStore()
    @State private var urlString = ""
    /// The file path last auto-loaded — so switching the open run/project re-loads
    /// the new index.html, while never re-loading the same one or clobbering a URL
    /// the user typed.
    @State private var autoLoadedPath: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.Spacing.sm) {
                Button { store.webView.goBack() } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.borderless).help("Back")
                Button { store.webView.goForward() } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(.borderless).help("Forward")
                Button { store.webView.reload() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Reload")
                TextField("localhost:3000  ·  or a URL…", text: $urlString)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(navigate)
                Button("Go", action: navigate)
                    .disabled(urlString.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(Theme.Spacing.sm)
            .background(Theme.surfaceRaised)
            Divider()
            WebPreview(store: store)
        }
        .onAppear(perform: autoLoadIfNeeded)
        .onChange(of: autoLoadFile) { _, _ in autoLoadIfNeeded() }
    }

    /// Auto-load the project's index.html when it (or the open project) changes —
    /// but never re-load the same path, and never clobber a URL the user typed
    /// (only overwrite an empty field or a previous auto-load).
    private func autoLoadIfNeeded() {
        guard let path = autoLoadFile, path != autoLoadedPath, FileManager.default.fileExists(atPath: path) else { return }
        let priorAuto = autoLoadedPath.map { URL(fileURLWithPath: $0).absoluteString }
        let current = urlString.trimmingCharacters(in: .whitespaces)
        guard current.isEmpty || current == priorAuto else { return }
        autoLoadedPath = path
        let url = URL(fileURLWithPath: path)
        store.load(url)
        urlString = url.absoluteString
    }

    private func navigate() {
        var s = urlString.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return }
        if !s.contains("://") { s = "http://" + s }
        if let url = URL(string: s) { store.load(url) }
    }
}

// MARK: - Canvas / Workbench (Phase 6, Q3/Q13)

/// The Canvas side of the trailing Workbench: a segmented set of work surfaces.
/// Artifacts is run-scoped; the browser is session/global. (A live Preview tab
/// and the agent-mirror browser arrive with Phase 7.)
struct CanvasView: View {
    let runId: String?
    /// The open run/task's project root — used to auto-load the project's
    /// index.html in the browser and (via produced) to scope outputs.
    let repoRoot: String?
    @State private var tab: CanvasTab = .artifacts

    enum CanvasTab: String, CaseIterable, Identifiable {
        case artifacts = "Artifacts", browser = "Browser"
        var id: String { rawValue }
        var glyph: String { self == .artifacts ? "photo.on.rectangle.angled" : "globe" }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(CanvasTab.allCases) { t in
                    Label(t.rawValue, systemImage: t.glyph).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(Theme.Spacing.sm)
            Divider()
            switch tab {
            case .artifacts:
                if let runId {
                    ArtifactGalleryView(runId: runId, produced: true)
                } else {
                    ContentUnavailableView("No run open", systemImage: "photo.on.rectangle.angled",
                        description: Text("Open a run from a turn to see its artifacts."))
                }
            case .browser:
                // NSString.appendingPathComponent normalizes separators (a repoRoot
                // with a trailing slash won't produce `//index.html`).
                BrowserView(autoLoadFile: repoRoot.map { ($0 as NSString).appendingPathComponent("index.html") })
            }
        }
    }
}
