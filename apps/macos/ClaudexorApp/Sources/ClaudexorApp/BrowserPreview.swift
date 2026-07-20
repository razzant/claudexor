import SwiftUI
import WebKit
import ClaudexorKit

// MARK: - Mini-browser preview (D42)
//
// The Canvas mode is gone (D42 folds artifacts into the thread workspace's
// Artifacts tab). BrowserView survives as an "Open preview" affordance: the
// workspace Artifacts tab opens it in a sheet for the thread's repoRoot
// index.html (localhost / rendered-output preview). Agent-driven browsing is a
// separate mirrored Chromium via Playwright MCP.

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

// MARK: - Preview sheet

/// A sheet host for BrowserView, opened from the workspace Artifacts tab's "Open
/// preview" affordance. Auto-loads the thread project's index.html.
struct PreviewSheet: View {
    let repoRoot: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Preview").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding(Theme.Spacing.md)
            Divider()
            // NSString.appendingPathComponent normalizes separators (a repoRoot
            // with a trailing slash won't produce `//index.html`).
            BrowserView(autoLoadFile: (repoRoot as NSString).appendingPathComponent("index.html"))
        }
        .frame(minWidth: 720, minHeight: 520)
    }
}
