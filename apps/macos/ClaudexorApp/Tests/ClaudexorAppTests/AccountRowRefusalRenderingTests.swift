import AppKit
import ClaudexorKit
import Foundation
import SwiftUI
import Testing
import Vision
@testable import ClaudexorApp

/// What the engine answers the routing-evidence read in each scene.
private enum EngineEvidence: Sendable {
    /// A current engine answers the opt-in read.
    case optIn
    /// An engine whose strict route predates the query refuses it with 400.
    case olderEngine
    /// The auxiliary read fails; the listing stays authoritative.
    case readFailed
}

/// The engine's generated responses (`pnpm fixtures:swift`), rebased from the
/// fixture's fixed engine clock onto this run's `now`. Only timestamps move.
private struct AccountsWire: Sendable {
    let bodies: [String: Data]
    let optIn: Data
    let older: Data

    init(now: Date) throws {
        let url = try #require(Bundle.module.url(forResource: "accounts-opt-in-wire", withExtension: "json"))
        let root = try #require(
            try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let clock = try #require((root["engineClock"] as? String).flatMap(formatter.date(from:)))
        let shift = now.timeIntervalSince(clock)
        func rebased(_ value: Any, key: String? = nil) -> Any {
            if let object = value as? [String: Any] {
                return object.reduce(into: [String: Any]()) { $0[$1.key] = rebased($1.value, key: $1.key) }
            }
            if let array = value as? [Any] { return array.map { rebased($0) } }
            if key?.hasSuffix("_at") == true, let text = value as? String,
               let date = formatter.date(from: text) {
                return formatter.string(from: date.addingTimeInterval(shift))
            }
            return value
        }
        func body(_ value: Any?) throws -> Data {
            try JSONSerialization.data(withJSONObject: rebased(try #require(value)))
        }
        let evidence = try #require(root["routingEvidence"] as? [String: Any])
        optIn = try body(evidence["optIn"])
        older = try body(evidence["older"])
        bodies = [
            "/v2/operations": try body(root["operations"]),
            "/v2/credential-profiles": try body(root["credentialProfiles"]),
            "/v2/quota": try body(root["quota"]),
        ]
    }
}

/// Answers each request from the generated responses and records path + query.
private final class AccountsWireProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var wire: AccountsWire?
    nonisolated(unsafe) private static var evidence = EngineEvidence.optIn
    nonisolated(unsafe) private static var recorded: [String] = []
    static let evidencePath = "/v2/accounts/routing-evidence"

    static func install(_ wire: AccountsWire, _ evidence: EngineEvidence) {
        lock.withLock {
            Self.wire = wire
            Self.evidence = evidence
            recorded = []
        }
    }

    static var requested: [String] { lock.withLock { recorded } }

    private static func answer(_ url: URL) -> (Int, Data) {
        lock.withLock {
            recorded.append(url.path + (url.query.map { "?\($0)" } ?? ""))
            let refused = { (code: String, message: String) in
                Data(#"{"code":"\#(code)","message":"\#(message)","retryable":false}"#.utf8)
            }
            guard let wire else { return (404, refused("not_found", "no fixture")) }
            guard url.path == evidencePath else {
                return wire.bodies[url.path].map { (200, $0) } ?? (404, refused("not_found", "no route"))
            }
            switch evidence {
            case .optIn:
                return (200, url.query == nil ? wire.older : wire.optIn)
            case .olderEngine:
                return url.query == nil
                    ? (200, wire.older)
                    : (400, refused("invalid_request", "unsupported query parameter"))
            case .readFailed:
                return (500, refused("internal", "account evidence store unavailable"))
            }
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let (status, body) = Self.answer(url)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status,
            httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func gateway() -> GatewayClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Self.self]
        return GatewayClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture",
                             session: URLSession(configuration: configuration))
    }
}

/// #200's rows from the engine's actual responses through the real client,
/// AppModel hydration, AccountsPresentation and AccountsSurface. No daemon,
/// network, credentials or preferences; the render has no window at all. Run with
/// CX_ACCOUNT_REFUSAL_RENDER_QA=1 and CX_ACCOUNT_REFUSAL_RENDER_OUTPUT=<new dir> to
/// keep the PNGs and their manifest.
@MainActor @Suite(.serialized)
struct AccountRowRefusalRenderingTests {
    static let width: CGFloat = 400
    static let order = ["work", "spare", "org-disabled", "logged-out"]
    static let readiness: [AccountReadiness] = [.ready, .ready, .unavailable, .unavailable]

    /// Bounded wait for work the app starts without awaiting it.
    func settled(_ condition: () -> Bool) async throws {
        for _ in 0..<1000 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        Issue.record("the awaited state never arrived")
    }

    /// What opening Accounts does: one registry hydration and its evidence read.
    private func hydrated(_ evidence: EngineEvidence, now: Date) async throws -> AppModel {
        AccountsWireProtocol.install(try AccountsWire(now: now), evidence)
        let model = AppModel(client: AccountsWireProtocol.gateway(), requestNotificationAuthorization: false)
        model.health = .connected
        #expect(await model.loadCredentialProfiles(locationID: .local) == nil)
        let state = model.accountsRoutingEvidence
        try await settled { state.evidence[.local] != nil || state.problems[.local] != nil }
        return model
    }

    /// The row identity and status that no routing-evidence answer may change.
    private func expectGenericRows(_ rows: [AccountRowModel]) {
        #expect(rows.map(\.profileId) == Self.order)
        #expect(rows.map(\.readiness) == Self.readiness)
        #expect(rows.map(\.verified) == [true, true, false, false])
        #expect(rows.allSatisfy { $0.enabled })
        #expect(rows.map(AccountsPresentation.columns(for:)).allSatisfy {
            $0 == AccountsPresentation.AccountRowColumn.allCases
        })
        // A credential-wide refusal and a logged-out row keep their status and
        // detail; neither becomes a one-model observation.
        #expect(rows[2].detail == "oauth_org_not_allowed")
        #expect(rows[3].detail == "No credentials in this account's store.")
        #expect(rows[2].credentialUnusable.isEmpty && rows[3].credentialUnusable.isEmpty)
    }

    private func orNull(_ text: String?) -> Any { text ?? NSNull() }

    private func line(_ row: AccountRowModel, now: Date) -> String? {
        AccountsPresentation.refusalLine(row.refusalMarks, credentialUnusable: row.credentialUnusable, now: now)
    }

    @Test func aCurrentEnginesResponseIsOneDatedObservationOnItsRow() async throws {
        let now = Date()
        let model = try await hydrated(.optIn, now: now)
        #expect(AccountsWireProtocol.requested.contains(
            AccountsWireProtocol.evidencePath + "?includeCredentialUnusable=true"))
        let rows = AccountsPresentation.rows(model: model)
        expectGenericRows(rows)
        #expect(rows[0].credentialUnusable.map(\.model) == ["claude-opus-5-5"])
        let shown = try #require(line(rows[0], now: now.addingTimeInterval(1)))
        #expect(shown == "Recent refusal · claude-opus-5-5 (model_not_found, 12m ago), default model")
        #expect(!shown.localizedCaseInsensitiveContains("unavailable"))
        // Most recent first, so a bounded line keeps the freshest fact.
        #expect(line(rows[1], now: now.addingTimeInterval(1)) == "Recent refusal · "
            + "claude-sonnet-4-5-20250929 (model_not_found, 40m ago), "
            + "claude-haiku-4-5-20251001 (model_not_found, 41m ago)")
        #expect(rows[2...3].allSatisfy { line($0, now: now) == nil })
        #expect(model.accountsRoutingEvidence.problems[.local] == nil)
    }

    @Test func anOlderEngineIsReadAgainAndKeepsItsSoftMarkAndStatus() async throws {
        let now = Date()
        let model = try await hydrated(.olderEngine, now: now)
        #expect(AccountsWireProtocol.requested.filter { $0.hasPrefix(AccountsWireProtocol.evidencePath) } == [
            AccountsWireProtocol.evidencePath + "?includeCredentialUnusable=true",
            AccountsWireProtocol.evidencePath,
        ])
        let rows = AccountsPresentation.rows(model: model)
        expectGenericRows(rows)
        #expect(rows.allSatisfy { $0.credentialUnusable.isEmpty })
        #expect(line(rows[0], now: now) == "Recent refusal · default model")
        #expect(rows[1...3].allSatisfy { line($0, now: now) == nil })
        #expect(model.accountsRoutingEvidence.problems[.local] == nil)
    }

    @Test func aFailedReadIsOneNoticeAndTheRowsStayCurrent() async throws {
        let now = Date()
        let model = try await hydrated(.readFailed, now: now)
        let notice = try #require(model.accountsRoutingEvidence.problems[.local])
        #expect(notice.contains("HTTP 500") && notice.contains("Account rows are current"))
        let rows = AccountsPresentation.rows(model: model)
        expectGenericRows(rows)
        #expect(rows.allSatisfy { line($0, now: now) == nil && $0.lastService.isEmpty })
    }

    private func raiseContentsScale(_ layer: CALayer?, to scale: CGFloat) {
        guard let layer else { return }
        layer.contentsScale = scale
        layer.setNeedsDisplay()
        layer.displayIfNeeded()
        layer.sublayers?.forEach { raiseContentsScale($0, to: scale) }
    }

    /// What the rendered pixels actually say, whatever the row's model holds.
    private func recognizedText(_ png: Data) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(data: png).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_ACCOUNT_REFUSAL_RENDER_QA"] == "1"))
    func theAccountsSurfaceRendersEveryEngineStateWithoutClipping() async throws {
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        let scenes: [(String, EngineEvidence)] = [
            ("proposed-opt-in", .optIn), ("now-older-engine", .olderEngine), ("read-failed", .readFailed),
        ]
        let appearances: [(String, NSAppearance.Name, ColorScheme)] = [
            ("light", .aqua, .light), ("dark", .darkAqua, .dark),
        ]
        var records: [[String: Any]] = []
        for (scene, evidence) in scenes {
            for (name, appearance, scheme) in appearances {
                let now = Date()
                let model = try await hydrated(evidence, now: now)
                let host = NSHostingView(rootView: AccountsSurface(family: nil, login: { _ in })
                    .padding(Theme.Spacing.lg)
                    .frame(width: Self.width)
                    .textSelection(.enabled)
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(model)
                    .environment(\.colorScheme, scheme)
                    .environment(\.locale, Locale(identifier: "en_US_POSIX")))
                host.appearance = NSAppearance(named: appearance)
                host.frame = NSRect(x: 0, y: 0, width: Self.width, height: 600)
                host.layoutSubtreeIfNeeded()
                // What the surface subscribes to when it appears; a hosting view
                // with no window is not told that it appeared.
                let quota = model.beginAccountsQuotaSubscription()
                defer { model.endAccountsQuotaSubscription(quota) }
                try await settled { model.activeQuotaResponse != nil }
                try await Task.sleep(for: .milliseconds(150))
                // The capture is exactly the content's height: nothing is clipped.
                let height = host.fittingSize.height.rounded(.up)
                host.frame = NSRect(x: 0, y: 0, width: Self.width, height: height)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                // With no window to take it from, rasterize at the bitmap's scale.
                raiseContentsScale(host.layer, to: 2)
                host.displayIfNeeded()
                #expect(abs(host.fittingSize.height - host.bounds.height) <= 1)
                #expect(host.bounds.width == Self.width)
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                #expect(host.window == nil)
                #expect(application.windows.isEmpty && !application.isActive)
                let rows = AccountsPresentation.rows(model: model)
                expectGenericRows(rows)
                let filename = "\(scene)-\(name).png"
                let recognized = try recognizedText(png)
                let pixels = recognized.lowercased().filter { $0.isLetter || $0.isNumber }
                if evidence == .optIn {
                    // The ordinary row states the model, the reason and the age
                    // in its pixels, not only in hover help.
                    for fact in ["claudeopus55modelnotfound12mago",
                                 "claudesonnet4520250929modelnotfound40mago"] {
                        #expect(pixels.contains(fact), "\(filename) does not show \(fact)")
                    }
                }
                records.append([
                    "file": filename,
                    "width_points": host.bounds.width,
                    "height_points": host.bounds.height,
                    "fitting_height_points": host.fittingSize.height,
                    "pixels": [bitmap.pixelsWide, bitmap.pixelsHigh],
                    "hosting_window": orNull(host.window.map { String(describing: $0) }),
                    "application_window_count": application.windows.count,
                    "recognized_text": recognized,
                    "requests": AccountsWireProtocol.requested,
                    "notice": orNull(model.accountsRoutingEvidence.problems[.local]),
                    "rows": rows.map { row in
                        [
                            "profile": row.profileId,
                            "readiness": String(describing: row.readiness),
                            "verified": row.verified,
                            "enabled": row.enabled,
                            "detail": orNull(row.detail),
                            // The full text; the hover help when the row truncates it.
                            "refusal_line": orNull(line(row, now: Date())),
                            "last_served_line": orNull(AccountsPresentation.lastServedLine(row.lastService)),
                        ] as [String: Any]
                    },
                ])
                if let root = ProcessInfo.processInfo.environment["CX_ACCOUNT_REFUSAL_RENDER_OUTPUT"] {
                    let directory = URL(fileURLWithPath: root, isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try png.write(to: directory.appendingPathComponent(filename))
                }
            }
        }
        if let root = ProcessInfo.processInfo.environment["CX_ACCOUNT_REFUSAL_RENDER_OUTPUT"] {
            let manifest: [String: Any] = [
                "capture": "NSHostingView.cacheDisplay of AccountsSurface sized to its fittingSize",
                "source": "accounts-opt-in-wire.json through GatewayClient and AppModel; timestamps rebased",
                "records": records,
            ]
            try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: root).appendingPathComponent("manifest.json"))
        }
    }
}
