import AppKit
import CryptoKit
import Foundation
import SwiftUI
import Testing
import Vision
import ClaudexorKit
@testable import ClaudexorApp

/// Offscreen pixels of the real components that present a run's terminal state,
/// light and dark, for states decoded from the generated wire page. Gated QA
/// (`CX_RUN_STATE_RENDER_OUT=<dir>`): no window is shown, activation is prohibited,
/// in-memory model, no client. `render-manifest.json` binds every PNG to its state
/// source and to the bytes of the sources it was built from.
@MainActor @Suite(.serialized)
struct RunStateRenderTests {
    private static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    /// The sources these pixels depend on; recorded so a later edit is detectable.
    private static let boundSources = [
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/DecisionBar.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/DelegationRows.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/DomainModels.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/RunEventDecoding.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/RunOutcomeSection.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/TaskRun+Presentation.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/TurnCard.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/TurnCardBars.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/TurnPresentation.swift",
        "apps/macos/ClaudexorApp/Sources/ClaudexorApp/WorkspaceEvidence.swift",
        "apps/macos/ClaudexorKit/Sources/ClaudexorKit/WireDTOs.swift",
        "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire/thread-history-work-veto.json",
    ]

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private struct Case {
        let name: String
        let turn: String
        var future = false
        let component: Component
        let shows: [String]
        let hides: [String]

        enum Component: String { case turnCard, outcomeSection, delegatedRow, evidenceRow }
    }

    private static let cases: [Case] = [
        Case(name: "turn-needs-input", turn: "turn-needs-input", component: .turnCard,
             shows: ["Needs input"], hides: ["Accept risk", "Override needs", "Done"]),
        Case(name: "turn-incomplete-review-blocked", turn: "turn-incomplete-review-blocked", component: .turnCard,
             shows: ["Incomplete", "Rerun with feedback"], hides: ["Accept risk", "Override needs", "Needs you", "Done"]),
        Case(name: "turn-needs-input-checks-failed", turn: "turn-needs-input-checks-failed", component: .turnCard,
             shows: ["Needs input", "Rerun with feedback"], hides: ["Accept risk", "Override needs", "Needs you", "Done"]),
        Case(name: "turn-review-gate-control", turn: "turn-review-gate", component: .turnCard,
             shows: ["Needs you", "Accept risk", "Rerun with feedback", "Override needs"], hides: []),
        Case(name: "turn-host-stopped", turn: "turn-host-stopped", component: .turnCard,
             shows: ["Stopped by host"], hides: ["Cancelled", "Done"]),
        Case(name: "turn-clean-control", turn: "turn-clean", component: .turnCard,
             shows: ["Done"], hides: ["Needs", "Accept risk"]),
        Case(name: "turn-unknown-reason", turn: "turn-clean", future: true, component: .turnCard,
             shows: ["Future reason code"], hides: ["Done"]),
        Case(name: "outcome-incomplete-review-blocked", turn: "turn-incomplete-review-blocked", component: .outcomeSection,
             shows: ["Incomplete", "risk decision cannot"], hides: ["needs a decision"]),
        Case(name: "outcome-needs-input", turn: "turn-needs-input", component: .outcomeSection,
             shows: ["Needs input"], hides: ["needs a decision"]),
        Case(name: "row-delegated-incomplete", turn: "turn-incomplete-review-blocked", component: .delegatedRow,
             shows: ["Incomplete"], hides: ["Done"]),
        Case(name: "row-evidence-needs-input", turn: "turn-needs-input", component: .evidenceRow,
             shows: ["Needs input"], hides: ["Done"]),
    ]

    private static func model(for page: ThreadHistoryPage, run: TaskRun) -> AppModel {
        let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
        let store = ThreadHistoryStore(locationID: .local, threadID: page.threadId) { _, _, _ in page }
        store.install([page], ids: page.turns.map(\.id), reset: true, serial: 0)
        model.selectedHistory = store
        model.selectedThreadId = page.threadId
        model.liveTasks = [run]
        return model
    }

    private static func view(_ item: Case, row: ThreadHistoryTurn, run: TaskRun) -> AnyView {
        switch item.component {
        case .turnCard:
            let target = TurnStartTarget.existing(locationID: .local, threadID: row.threadId, repoRoot: nil,
                                                  workspaceMode: "in_place", eligibleHarnesses: [])
            return AnyView(TurnCard(turn: row.turnInfo, target: target, routingOptions: TurnOptions(),
                                    executionRoot: nil, historyRow: row))
        case .outcomeSection:
            return AnyView(RunOutcomeSection(task: run))
        case .delegatedRow:
            return AnyView(DelegatedRunRow(child: run))
        case .evidenceRow:
            return AnyView(RunEvidenceSection(locationID: .local, runId: run.id, expandedByDefault: false))
        }
    }

    private static func render(_ content: AnyView, model: AppModel, appearance: NSAppearance.Name) async throws -> Data {
        let width: CGFloat = 760, height: CGFloat = 460
        let host = NSHostingView(rootView: AnyView(
            ScrollView { content.padding(12) }
                .environment(model)
                .background(Color(nsColor: .windowBackgroundColor))))
        host.appearance = NSAppearance(named: appearance)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: appearance)
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        #expect(!window.isVisible && !window.isKeyWindow)
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        return try #require(bitmap.representation(using: .png, properties: [:]))
    }

    private static func ocr(_ png: Data) throws -> String {
        let image = try #require(NSBitmapImageRep(data: png)?.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_RUN_STATE_RENDER_OUT"] != nil))
    func theRealComponentsDrawTheStateTheWireCarries() async throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["CX_RUN_STATE_RENDER_OUT"]),
                      isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let policy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(policy) }

        var renders: [[String: Any]] = []
        for item in Self.cases {
            let page = item.future
                ? try ProducerWire.page(editingFactsOf: item.turn) { $0["reason"] = .string("future_reason_code") }
                : try ProducerWire.page()
            let row = try ProducerWire.row(page, item.turn)
            var run = try #require(HistoryRunPresentation.task(row, thread: page.header.thread))
            run.delegatedFromRunId = item.component == .delegatedRow ? "run-parent" : nil
            let model = Self.model(for: page, run: run)
            for (suffix, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
                let png = try await Self.render(Self.view(item, row: row, run: run), model: model, appearance: appearance)
                let file = "\(item.name)-\(suffix).png"
                try png.write(to: out.appendingPathComponent(file))
                let text = try Self.ocr(png)
                var facts: [String: String] = [:]
                facts["state"] = row.run?.state
                facts["reason"] = row.run?.outcomeFacts?.reason
                facts["review"] = row.run?.outcomeFacts?.review
                facts["checks"] = row.run?.outcomeFacts?.checks
                facts["workState"] = row.run?.outcomeFacts?.workState?.state
                facts["banner"] = row.run?.outcomeBanner
                renders.append([
                    "file": file, "sha256": Self.sha256(png), "component": item.component.rawValue,
                    "appearance": suffix, "stateSource": "\(ProducerWire.historyPage).json#\(item.turn)",
                    "editedForFutureCode": item.future,
                    "facts": facts,
                    "shows": item.shows, "hides": item.hides, "ocr": text,
                ])
                for word in item.shows { #expect(text.contains(word), "\(file) must show \(word): \(text)") }
                for word in item.hides { #expect(!text.contains(word), "\(file) must not show \(word): \(text)") }
            }
        }
        let sources = try Dictionary(uniqueKeysWithValues: Self.boundSources.map {
            ($0, Self.sha256(try Data(contentsOf: Self.root.appendingPathComponent($0))))
        })
        let manifest: [String: Any] = ["sources": sources, "renders": renders]
        try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            .write(to: out.appendingPathComponent("render-manifest.json"))
    }
}
