import AppKit
import Foundation
import SwiftUI
import Testing
import Vision
import ClaudexorKit
@testable import ClaudexorApp

/// #215 visual QA of the Browser badge in the real run Outcome facts row, from the
/// engine-projected summaries through the real DTO decode and task mapping, light
/// and dark. Rendered by SwiftUI's `ImageRenderer` into a bitmap: no `NSWindow` is
/// created, nothing is shown and the app may not activate, which the test asserts.
/// With CX_BROWSER_BADGE_RENDER_OUT=<dir> it writes `<scenario>-<appearance>.png`
/// plus `badges.json` (each badge's text, tone and hover help, and the recognized
/// text of each image).
@MainActor @Suite(.serialized)
struct BrowserBadgeRenderTests {
    static let scenarios = [
        "browserVerified", "olderEngineBrowser", "codexBrowserReady", "codexBrowserFailed",
        "codexBrowserCancelled", "codexBrowserStillStarting", "codexBrowserNotObserved",
        "codexBrowserMixed", "codexBrowserUnavailable",
    ]

    private static func ocr(_ image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_BROWSER_BADGE_RENDER_OUT"] != nil))
    func browserBadgeRendersWithoutAWindow() throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["CX_BROWSER_BADGE_RENDER_OUT"]),
                      isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let policy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(policy) }
        #expect(application.windows.isEmpty)
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        var record: [String: Any] = [:]
        for name in Self.scenarios {
            let task = AppModel.liveTask(from: try WebAccessFactsTests.summary(name))
            let badge = try #require(RunFacts.headerDetails(task).first { $0.id == "browser" })
            var entry: [String: Any] = ["text": badge.text, "tone": "\(badge.tone)", "help": badge.help ?? ""]
            for (appearanceName, scheme, appearance) in [
                ("light", ColorScheme.light, NSAppearance.Name.aqua), ("dark", .dark, .darkAqua),
            ] {
                let drawing = try #require(NSAppearance(named: appearance))
                // ImageRenderer resolves SwiftUI colors from the color scheme, but not a
                // dynamic NSColor: resolve the window background in this appearance first.
                var background = NSColor.windowBackgroundColor
                drawing.performAsCurrentDrawingAppearance {
                    background = NSColor.windowBackgroundColor.usingColorSpace(.sRGB) ?? background
                }
                let view = RunOutcomeSection(task: task)
                    .padding(20)
                    .frame(width: 760, alignment: .topLeading)
                    .environment(model)
                    .environment(\.colorScheme, scheme)
                    .background(Color(nsColor: background))
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                var image: CGImage?
                drawing.performAsCurrentDrawingAppearance { image = renderer.cgImage }
                let cgImage = try #require(image)
                let png = try #require(NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]))
                try png.write(to: out.appendingPathComponent("\(name)-\(appearanceName).png"))
                entry["ocr-\(appearanceName)"] = try Self.ocr(cgImage)
            }
            record[name] = entry
        }
        // Rendering made no window, so none could be shown.
        #expect(application.windows.isEmpty)
        let json = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
        try json.write(to: out.appendingPathComponent("badges.json"))
    }
}
