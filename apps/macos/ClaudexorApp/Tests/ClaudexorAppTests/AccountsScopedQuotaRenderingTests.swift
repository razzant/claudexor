import AppKit
import ClaudexorKit
import SwiftUI
import Testing
import Vision
@testable import ClaudexorApp

/// Windowless, real-Accounts-surface rendering for the row-local scoped quota
/// fallback. Fixtures are synthetic and never open a daemon, account or provider.
@MainActor @Suite(.serialized)
struct AccountsScopedQuotaRenderingTests {
    private static let width: CGFloat = 400

    private func makeModel(snapshots: [String]) throws -> AppModel {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        model.health = .connected
        model.credentialProfiles = try JSONDecoder().decode(
            [CredentialProfileEntry].self,
            from: Data(#"[{"profile":{"profile_id":"work","harness_id":"agy","display_name":"Work","credential_kind":"config_dir_login","enabled":true},"status":{"availability":"available","verification":"passed","detail":null,"last_verified_at":null}}]"#.utf8))
        let body = """
        {"snapshots":[\(snapshots.joined(separator: ","))],"absences":[],"refreshed_at":"2026-08-09T00:00:00Z"}
        """
        model.quotaResponse = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(body.utf8))
        return model
    }

    private func snapshot(_ id: String, freshness: String, constraints: String,
                          state: String = "available", scoped: String = "[]") -> String {
        """
        {"id":"\(id)","subject":{"harness":"agy","credential_route":"vendor_native","plan_label":null,"subject_id":"work"},"constraints":[\(constraints)],"source":"agy_command_usage","observed_at":"2026-08-09T00:00:00Z","freshness":"\(freshness)","availability":{"state":"\(state)","blocking_constraints":[],"resets_at":null,"model_scoped_exhaustions":\(scoped)}}
        """
    }

    private func recognizedText(_ png: Data) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(data: png).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
    }

    private func raiseContentsScale(_ layer: CALayer?, to scale: CGFloat) {
        guard let layer else { return }
        layer.contentsScale = scale
        layer.setNeedsDisplay()
        layer.displayIfNeeded()
        layer.sublayers?.forEach { raiseContentsScale($0, to: scale) }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_ACCOUNT_SCOPED_QUOTA_RENDER_QA"] == "1"))
    func accountsSurfaceShowsScopedScopeAndFreshnessWithoutPromotingTheTrigger() async throws {
        let gemini = #"{"id":"gemini-week","label":"Gemini week","applies_to_models":["gemini-*"],"used_ratio":0.3,"window_seconds":604800,"resets_at":null,"cooldown_until":null}"#
        let claude = #"{"id":"claude-week","label":"Claude week","applies_to_models":["claude-*","gpt-*"],"used_ratio":0.7,"window_seconds":604800,"resets_at":null,"cooldown_until":null}"#
        let accountWide = #"{"id":"wide","label":"Account week","used_ratio":0.42,"window_seconds":604800,"resets_at":null,"cooldown_until":null}"#
        let oldScoped = #"{"id":"old-scoped","label":"Old scoped","applies_to_models":["claude-*","gpt-*"],"used_ratio":0.8,"window_seconds":604800,"resets_at":null,"cooldown_until":null}"#
        let newScoped = #"{"id":"new-scoped","label":"New scoped","applies_to_models":["gemini-*"],"used_ratio":0.2,"window_seconds":3600,"resets_at":null,"cooldown_until":null}"#
        let scenes: [(String, [String], String)] = [
            ("healthy-scoped", [snapshot("scoped", freshness: "fresh", constraints: "\(gemini),\(claude)")], "70% used • Claude, Gpt only"),
            ("account-wide-control", [snapshot("wide", freshness: "fresh", constraints: "\(accountWide),\(claude)")], "42% used"),
            ("stale-selected-window", [snapshot("new", freshness: "fresh", constraints: newScoped), snapshot("old", freshness: "stale", constraints: oldScoped)], "Last known: 80% used • Claude, Gpt only"),
            ("stale-group", [snapshot("stale", freshness: "stale", constraints: claude)], "Last-known quota"),
            ("unknown-scoped", [snapshot("unknown", freshness: "fresh", constraints: claude.replacingOccurrences(of: #""used_ratio":0.7"#, with: #""used_ratio":null"#))], "Quota unknown"),
        ]
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        var records: [[String: Any]] = []
        for (scene, snapshotJSON, expected) in scenes {
            let model = try makeModel(snapshots: snapshotJSON)
            for (name, appearance, scheme) in [("light", NSAppearance.Name.aqua, ColorScheme.light), ("dark", NSAppearance.Name.darkAqua, ColorScheme.dark)] {
                let host = NSHostingView(rootView: AccountsSurface(family: nil, login: { _ in })
                    .padding(Theme.Spacing.lg)
                    .frame(width: Self.width)
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(model)
                    .environment(\.colorScheme, scheme)
                    .environment(\.locale, Locale(identifier: "en_US_POSIX")))
                host.appearance = NSAppearance(named: appearance)
                host.frame = NSRect(x: 0, y: 0, width: Self.width, height: 500)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                let height = host.fittingSize.height.rounded(.up)
                host.frame = NSRect(x: 0, y: 0, width: Self.width, height: height)
                host.layoutSubtreeIfNeeded()
                raiseContentsScale(host.layer, to: 2)
                host.displayIfNeeded()
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                let recognized = try recognizedText(png)
                let normalized = recognized.lowercased().filter { $0.isLetter || $0.isNumber }
                let expectedNormalized = expected.lowercased().filter { $0.isLetter || $0.isNumber }
                #expect(normalized.contains(expectedNormalized), "\(scene)-\(name): \(recognized)")
                #expect(host.window == nil)
                #expect(application.windows.isEmpty && !application.isActive)
                let rowPercent = AccountsPresentation.worstPercent(AccountsPresentation.rows(model: model))
                let filename = "\(scene)-\(name).png"
                if let root = ProcessInfo.processInfo.environment["CX_ACCOUNT_SCOPED_QUOTA_RENDER_OUTPUT"] {
                    let directory = URL(fileURLWithPath: root, isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try png.write(to: directory.appendingPathComponent(filename))
                }
                records.append(["scene": scene, "appearance": name, "file": filename,
                                "width_points": host.bounds.width, "height_points": host.bounds.height,
                                "recognized_text": recognized,
                                "trigger_percent": rowPercent.map { $0 } ?? NSNull()])
            }
        }
        if let root = ProcessInfo.processInfo.environment["CX_ACCOUNT_SCOPED_QUOTA_RENDER_OUTPUT"] {
            try JSONSerialization.data(withJSONObject: ["capture": "windowless AccountsSurface", "records": records], options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: root).appendingPathComponent("manifest.json"))
        }
    }
}
