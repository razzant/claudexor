import AppKit
import Foundation
import SwiftUI
import Testing
import Vision
import ClaudexorKit
@testable import ClaudexorApp

/// #118/#413/#215 visual QA: offscreen pixels of the real run Outcome section (its
/// facts row), from the engine-projected summaries through the real DTO decode
/// and task mapping, light and dark. Gated QA: no window is shown, activation is
/// prohibited, the model is in memory. With CX_WEB_ACCESS_RENDER_OUT=<dir> it
/// writes `<scenario>-<appearance>.png` plus `facts.json` (each fact's text, tone
/// and hover help, which pixels cannot show; the Diagnostics text; and the
/// recognized text of each image).
@MainActor @Suite(.serialized)
struct WebAccessFactsRenderTests {
    private static let scenarios = [
        "webOffReadonly", "webOffRefused", "webOffLegacyTelemetry", "webOffNoTelemetry",
        "codexSearch", "claudeSearch", "browserVerified", "browserClosedOnly", "olderEngineSearch",
        "olderRecordVerified", "codexBrowserReady", "codexBrowserFailed", "codexBrowserStillStarting",
        "codexBrowserCancelled", "codexBrowserNotObserved", "codexBrowserMixed", "codexBrowserUnavailable",
        "olderEngineBrowser",
        "cursorReadonly", "inheritNative", "inheritNativeMixed",
    ]

    private static func ocr(_ png: Data) throws -> String {
        let image = try #require(NSBitmapImageRep(data: png)?.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_WEB_ACCESS_RENDER_OUT"] != nil))
    func runFactsRowRendersInLightAndDark() async throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["CX_WEB_ACCESS_RENDER_OUT"]),
                      isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let policy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(policy) }
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        var record: [String: Any] = [:]
        for name in Self.scenarios {
            var task = AppModel.liveTask(from: try WebAccessFactsTests.summary(name))
            task.answerText = "Fixture answer for \(name)."
            var entry: [String: Any] = [
                "facts": (RunFacts.headerPrimary(task) + RunFacts.headerDetails(task)).map {
                    ["id": $0.id, "text": $0.text, "glyph": $0.glyph ?? "", "tone": "\($0.tone)", "help": $0.help ?? ""]
                },
                "diagnostics": RunDiagnosticsPresentation.summary(
                    detail: try WebAccessFactsTests.detail(name), error: nil),
            ]
            let width: CGFloat = 760
            let host = NSHostingView(rootView: AnyView(
                RunOutcomeSection(task: task)
                    .padding(20)
                    .frame(width: width, alignment: .topLeading)
                    .environment(model)
                    .background(Color(nsColor: .windowBackgroundColor))))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 220),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            host.frame = NSRect(x: 0, y: 0, width: width, height: 220)
            defer { window.contentView = nil; window.close() }
            for (appearanceName, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
                host.appearance = NSAppearance(named: appearance)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                host.layoutSubtreeIfNeeded()
                host.displayIfNeeded()
                #expect(!window.isVisible && !window.isKeyWindow)
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: out.appendingPathComponent("\(name)-\(appearanceName).png"))
                entry["ocr-\(appearanceName)"] = try Self.ocr(png)
            }
            record[name] = entry
        }
        let json = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
        try json.write(to: out.appendingPathComponent("facts.json"))
    }
}
