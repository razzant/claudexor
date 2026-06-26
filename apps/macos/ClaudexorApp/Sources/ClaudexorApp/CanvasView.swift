import SwiftUI
import WebKit
import ClaudexorKit

// MARK: - Mini-browser (Phase 5, Feature B)

/// Holds one WKWebView so SwiftUI toolbar buttons (back/forward/reload) can drive
/// it. WebKit views are created on the main actor.
@MainActor final class WebViewStore: ObservableObject {
    let webView: WKWebView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    func load(_ url: URL) { webView.load(URLRequest(url: url)) }
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
    @StateObject private var store = WebViewStore()
    @State private var urlString = ""

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
                    ArtifactGalleryView(runId: runId)
                } else {
                    ContentUnavailableView("No run open", systemImage: "photo.on.rectangle.angled",
                        description: Text("Open a run from a turn to see its artifacts."))
                }
            case .browser:
                BrowserView()
            }
        }
    }
}
