import AppKit
import ClaudexorKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// The live question card hosted alone, with a memory-only AppModel: no daemon,
/// network, preferences, credentials or app lifecycle. The always-on checks
/// measure the laid-out card; with CX_INTERACTION_RENDER_OUTPUT set, the same
/// scenarios are drawn in a never-shown offscreen window and written as PNGs.
/// A never-key window draws `.borderedProminent` in its inactive form, nearly
/// white on white in light mode for any such button (baseline included), so the
/// fixture forces the key control state for drawing and says so in its manifest.
@MainActor @Suite(.serialized)
struct InteractionCardRenderingTests {
    static let runID = "render-run"
    static let interactionID = "render-interaction"
    static let sentence = "The migration rewrites the billing tables, so explain the trade-off before choosing. "
    static let longLabel = "Blue-green with a full copy of the billing database, switched over in one step after the copy is verified. " +
        String(repeating: "Keep the old stack warm for a day so a rollback stays possible. ", count: 8)

    static func compact() -> PendingInteraction {
        pending([InteractionQuestion(
            id: "q1", question: "Which store?", header: "Store",
            options: [InteractionOption(label: "SQLite", description: nil),
                      InteractionOption(label: "Postgres", description: nil)],
            multiSelect: false)])
    }

    /// Longer than every former display bound: question 2000, header 100,
    /// label 500 and description 1000 characters.
    static func long() -> PendingInteraction {
        pending([
            InteractionQuestion(
                id: "q1",
                question: "Which rollout keeps the release safe? " + String(repeating: sentence, count: 30) + "END",
                header: "Rollout plan for the billing service migration, " +
                    String(repeating: "including the data copy and the rollback window, ", count: 2),
                options: [InteractionOption(label: "Canary", description: String(repeating: "Gradual. ", count: 120)),
                          InteractionOption(label: longLabel, description: nil),
                          InteractionOption(label: "Wait", description: nil)],
                multiSelect: false),
            InteractionQuestion(
                id: "q2", question: "Anything else to keep in mind? " + String(repeating: sentence, count: 6),
                header: nil, options: [], multiSelect: false),
        ])
    }

    /// A short question whose long option label sits in view, selected.
    static func longLabels() -> PendingInteraction {
        pending([
            InteractionQuestion(
                id: "q1", question: "Which rollout should I use for the billing migration?",
                header: "Rollout",
                options: [InteractionOption(label: "Canary", description: nil),
                          InteractionOption(label: longLabel, description: nil),
                          InteractionOption(label: "Wait for the next release window", description: nil)],
                multiSelect: false),
            InteractionQuestion(id: "q2", question: "Anything else?", header: nil,
                                options: [], multiSelect: false),
        ])
    }

    static func pending(_ questions: [InteractionQuestion]) -> PendingInteraction {
        PendingInteraction(interactionId: interactionID, runId: runID, attemptId: "a01",
            harnessId: "claude", sourceTool: "AskUserQuestion", questions: questions,
            requestedAt: "2026-11-01T00:00:00Z", timeoutAt: nil)
    }

    static func card(_ interaction: PendingInteraction, width: CGFloat,
                     draft: InteractionDraft? = nil) -> some View {
        let presentation = ConversationPresentation()
        if let draft { presentation.interactionDrafts[runID] = [interactionID: draft] }
        return InteractionCard(interaction: interaction)
            .environment(AppModel(client: nil, requestNotificationAuthorization: false,
                                  loadPersistedState: false))
            .environment(presentation)
            .frame(width: width)
    }

    static func fittingSize(_ view: some View) -> NSSize {
        let host = NSHostingView(rootView: view)
        host.layoutSubtreeIfNeeded()
        return host.fittingSize
    }

    /// An ordinary question keeps a compact card: the bounded middle takes only
    /// what its content needs, never the full scroll height.
    @Test func compactQuestionDoesNotReserveTheScrollHeight() {
        let compact = Self.fittingSize(Self.card(Self.compact(), width: 680))
        let long = Self.fittingSize(Self.card(Self.long(), width: 680))
        #expect(compact.height < 300)
        // Long content fills the 320pt middle and stops there: the card is at
        // most that bound plus the compact card's chrome.
        #expect(long.height > compact.height + 150)
        #expect(long.height <= compact.height + 320)
    }

    /// With wrapping on (the question card), a chip wider than its row wraps
    /// inside the row; other flow rows keep their one-line chips.
    @Test func longChipWrapsWithinTheRowOnlyWhereEnabled() {
        func chips(_ label: String, wraps: Bool) -> some View {
            FlowLayout(spacing: Theme.Spacing.sm, wrapsWideSubviews: wraps) {
                Text(label).font(.caption.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.xs)
            }
            .frame(width: 300)
        }
        let short = Self.fittingSize(chips("SQLite", wraps: true))
        let wrapped = Self.fittingSize(chips(Self.longLabel, wraps: true))
        let unchanged = Self.fittingSize(chips(Self.longLabel, wraps: false))
        #expect(wrapped.width <= 300)
        #expect(wrapped.height >= 3 * short.height)
        #expect(unchanged.height < 2 * short.height)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_INTERACTION_RENDER_OUTPUT"] != nil))
    func renderCardsForVisualReview() async throws {
        let output = try #require(ProcessInfo.processInfo.environment["CX_INTERACTION_RENDER_OUTPUT"])
        let directory = URL(fileURLWithPath: output, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        let typed = InteractionDraft(selections: ["q1": [Self.longLabel]],
                                     freeText: ["q2": "  keep both spaces  "])
        let scenarios: [(String, PendingInteraction, CGFloat, InteractionDraft?)] = [
            ("compact-680", Self.compact(), 680, nil),
            ("long-680", Self.long(), 680, typed),
            ("long-420", Self.long(), 420, typed),
            ("labels-680", Self.longLabels(), 680, typed),
            ("labels-420", Self.longLabels(), 420, typed),
        ]
        var records: [[String: Any]] = []
        for (name, interaction, width, draft) in scenarios {
            for (scheme, appearance, colorScheme) in [("light", NSAppearance.Name.aqua, ColorScheme.light),
                                                       ("dark", .darkAqua, .dark)] {
                let content = Self.card(interaction, width: width, draft: draft)
                    .padding(Theme.Spacing.lg)
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.controlActiveState, .key)
                    .environment(\.colorScheme, colorScheme)
                    .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                let host = NSHostingView(rootView: content)
                host.appearance = NSAppearance(named: appearance)
                host.layoutSubtreeIfNeeded()
                let size = host.fittingSize
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                    styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                host.frame = NSRect(origin: .zero, size: size)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                host.displayIfNeeded()
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                let file = "\(name)-\(scheme).png"
                try png.write(to: directory.appendingPathComponent(file))
                #expect(!window.isVisible)
                records.append(["file": file, "card_width_points": width,
                                "rendered_width_points": size.width, "rendered_height_points": size.height,
                                "pixel_width": bitmap.pixelsWide, "pixel_height": bitmap.pixelsHigh])
                window.contentView = nil
                window.close()
            }
        }
        let manifest: [String: Any] = ["capture": "NSHostingView.cacheDisplay", "window_shown": false,
            "control_active_state": "key, forced by the fixture; the window is never key",
            "app_model": "memory-only, no client", "scenarios": records]
        try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent("manifest.json"))
    }
}

/// One pass through the real card, in the order its window allows. Observed:
/// wheel events do not move the scroll view of a window placed beyond the
/// displays, and SwiftUI buttons do not fire until a window is ordered in. So it
/// scrolls while never ordered in, then moves beyond every display, is ordered in
/// there and takes mouse and key events through `NSWindow.sendEvent`; the answer
/// request is caught at a URLProtocol. The events stay inside this process:
/// nothing is posted to the window server, no accessibility client, no
/// activation, and the window never becomes key or reaches a display.
/// Opt-in like the render QA, because such a host exposes no button to
/// accessibility, so buttons are located by their focus-ring views, an unstable
/// framework detail; a missing ring fails here rather than faking a press.
extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct InteractionCardInteractionTests {
    typealias Fixture = InteractionCardRenderingTests
    static let typed = "  keep both spaces  "
    /// US key codes for `typed`; the characters travel in the event.
    static let keyCodes: [Character: UInt16] = [
        " ": 49, "k": 40, "e": 14, "p": 35, "b": 11, "o": 31, "t": 17, "h": 4, "s": 1, "a": 0, "c": 8,
    ]

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_INTERACTION_RENDER_OUTPUT"] != nil))
    func scrollsToTheEndSelectsTheLongOptionTypesAndSends() async throws {
        let output = try #require(ProcessInfo.processInfo.environment["CX_INTERACTION_RENDER_OUTPUT"])
        let directory = URL(fileURLWithPath: output, isDirectory: true).appendingPathComponent("interaction")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        CapturedAnswerURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CapturedAnswerURLProtocol.self]
        let model = AppModel(client: GatewayClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "test",
                                                   session: URLSession(configuration: configuration)),
                             requestNotificationAuthorization: false, loadPersistedState: false)
        let presentation = ConversationPresentation()
        let interaction = Fixture.long()
        let question = interaction.questions[0]
        // Past every former bound: question 2000, header 100, label 500, description 1000.
        #expect(question.question.count > 2000)
        #expect((question.header ?? "").count > 100)
        #expect(Fixture.longLabel.count > 500)
        #expect((question.options[0].description ?? "").count > 1000)
        func draft() -> InteractionDraft? { presentation.interactionDrafts[Fixture.runID]?[Fixture.interactionID] }

        let host = NSHostingView(rootView: InteractionCard(interaction: interaction)
            .environment(model)
            .environment(presentation)
            .environment(\.controlActiveState, .key)
            .frame(width: 680)
            .padding(Theme.Spacing.lg)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, .light)
            .environment(\.locale, Locale(identifier: "en_US_POSIX")))
        host.appearance = NSAppearance(named: .aqua)
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.stationary, .ignoresCycle, .transient]
        window.contentView = host
        host.frame = NSRect(origin: .zero, size: size)
        defer {
            window.makeFirstResponder(nil)
            window.orderOut(nil)
            window.contentView = nil
            window.close()
        }
        await settle(host)
        func staysOffDisplay() -> Bool {
            !window.isKeyWindow && !application.isActive && !window.occlusionState.contains(.visible)
                && !NSScreen.screens.contains { $0.frame.intersects(window.frame) }
        }
        var log: [String: Any] = ["card_size": "\(size)", "question_characters": question.question.count,
            "label_characters": Fixture.longLabel.count, "typed": Self.typed,
            "delivery": "NSWindow.sendEvent and NSScrollView.scrollWheel inside this process",
            "control_active_state": "key, forced by the fixture for drawing; the window is never key"]

        // The question's text field holds the whole question and fits it at this width.
        let scroll = try #require(views(host).compactMap { $0 as? NSScrollView }.first)
        let questionField = try #require(views(host).compactMap { $0 as? NSTextField }
            .first { $0.stringValue == question.question })
        let cell = try #require(questionField.cell)
        let needed = cell.cellSize(forBounds: NSRect(x: 0, y: 0, width: questionField.bounds.width,
                                                     height: .greatestFiniteMagnitude)).height
        #expect(needed <= questionField.bounds.height + 1)
        #expect(questionField.bounds.height > scroll.bounds.height)
        log["question_field"] = ["height": questionField.bounds.height, "height_needed": needed,
                                 "scroll_view_height": scroll.bounds.height]
        try capture(host, to: directory.appendingPathComponent("01-top.png"))

        // Wheel to the end of the long content.
        let document = try #require(scroll.documentView)
        func atEnd() -> Bool { scroll.contentView.bounds.maxY >= document.frame.maxY - 0.5 }
        var offsets = [scroll.contentView.bounds.minY]
        var wheels = 0
        while !atEnd(), wheels < 60 {
            let wheel = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                                             wheel1: -160, wheel2: 0, wheel3: 0))
            scroll.scrollWheel(with: try #require(NSEvent(cgEvent: wheel)))
            await settle(host, count: 1)
            wheels += 1
            offsets.append(scroll.contentView.bounds.minY)
            if wheels <= 12 {
                try capture(host, to: directory.appendingPathComponent(String(format: "02-wheel-%02d.png", wheels)))
            }
        }
        #expect(atEnd())
        #expect(offsets.last! > offsets.first! + 300)
        log["scroll"] = ["wheel_events": wheels, "offsets": offsets, "document_height": document.frame.height]
        try capture(host, to: directory.appendingPathComponent("03-end.png"))

        // Order in beyond every display; the scroll position holds.
        #expect(!window.isVisible)
        let displays = NSScreen.screens.reduce(NSRect.null) { $0.union($1.frame) }
        window.setFrameOrigin(NSPoint(x: displays.maxX + 4000, y: displays.maxY + 4000))
        window.orderFrontRegardless()
        await settle(host)
        #expect(window.isVisible && staysOffDisplay())
        #expect(scroll.contentView.bounds.minY == offsets.last!)
        log["displays"] = "\(displays)"
        log["ordered_in_at"] = "\(window.frame)"

        // Send starts disabled: a real click on it sends nothing.
        try await click(try sendButton(host, outside: scroll), in: window, host: host)
        #expect(CapturedAnswerURLProtocol.requests().isEmpty)

        // Every chip is reachable at the end; a click selects, another replaces it.
        let chips = focusRings(host).filter { $0.isDescendant(of: scroll) }
            .sorted { $0.convert($0.bounds, to: nil).maxY > $1.convert($1.bounds, to: nil).maxY }
        #expect(chips.count == 3)
        let (first, long) = (chips[0], chips[1])
        let visible = scroll.convert(scroll.bounds, to: nil)
        for chip in [first, long] {
            let frame = chip.convert(chip.bounds, to: nil)
            #expect(visible.contains(NSPoint(x: frame.midX, y: frame.midY)))
        }
        log["long_chip_frame"] = "\(long.convert(long.bounds, to: nil))"
        try await click(first, in: window, host: host)
        #expect(draft()?.selections["q1"] == ["Canary"])
        try await click(long, in: window, host: host)
        #expect(draft()?.selections["q1"] == [Fixture.longLabel])
        try capture(host, to: directory.appendingPathComponent("04-long-option-selected.png"))

        // Real key events into the last field, the second question's.
        let field = try #require(views(host).compactMap { $0 as? NSTextField }.last { $0.isEditable })
        #expect(window.makeFirstResponder(field))
        for character in Self.typed {
            let text = String(character)
            let code = try #require(Self.keyCodes[character])
            window.sendEvent(try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                characters: text, charactersIgnoringModifiers: text, isARepeat: false, keyCode: code)))
        }
        await settle(host)
        #expect(field.stringValue == Self.typed)
        #expect(draft()?.freeText["q2"] == Self.typed)
        try capture(host, to: directory.appendingPathComponent("05-free-text-typed.png"))
        #expect(CapturedAnswerURLProtocol.requests().isEmpty)

        // Send stays in reach below the scrolled content.
        try await click(try sendButton(host, outside: scroll), in: window, host: host)
        for _ in 0..<50 where CapturedAnswerURLProtocol.requests().isEmpty { await settle(host, count: 1) }
        await settle(host)
        let requests = CapturedAnswerURLProtocol.requests()
        #expect(requests.count == 1)
        let request = try #require(requests.first)
        #expect(request.path == "/v2/runs/\(Fixture.runID)/interactions/\(Fixture.interactionID)/answer")
        try request.body.write(to: directory.appendingPathComponent("answer-body.json"))
        let json = try #require(try JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        let answers = try #require(json["answers"] as? [[String: Any]])
        #expect(answers.count == 2)
        #expect(answers.first?["questionId"] as? String == "q1")
        #expect(answers.first?["selectedLabels"] as? [String] == [Fixture.longLabel])
        #expect(answers.first?["freeText"] == nil)
        #expect(answers.last?["questionId"] as? String == "q2")
        #expect(answers.last?["selectedLabels"] as? [String] == [])
        #expect(answers.last?["freeText"] as? String == Self.typed)
        try capture(host, to: directory.appendingPathComponent("06-sent.png"))
        log["request"] = ["path": request.path, "body_bytes": request.body.count, "requests": requests.count]
        #expect(staysOffDisplay())
        log["window"] = ["ordered_in": window.isVisible, "key": window.isKeyWindow, "app_active": application.isActive,
                         "occlusion_visible": window.occlusionState.contains(.visible)]
        try JSONSerialization.data(withJSONObject: log, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent("interaction-log.json"))
    }

    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }

    private func focusRings(_ host: NSView) -> [NSView] {
        views(host).filter { String(describing: type(of: $0)).contains("FocusRing") }
    }

    private func sendButton(_ host: NSView, outside scroll: NSView) throws -> NSView {
        try #require(focusRings(host).last { !$0.isDescendant(of: scroll) })
    }

    private func settle(_ host: NSView, count: Int = 3) async {
        for _ in 0..<count {
            host.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(60))
        }
    }

    private func click(_ target: NSView, in window: NSWindow, host: NSView) async throws {
        let frame = target.convert(target.bounds, to: nil)
        let point = NSPoint(x: frame.midX, y: frame.midY)
        for (type, pressure) in [(NSEvent.EventType.leftMouseDown, Float(1)), (.leftMouseUp, Float(0))] {
            window.sendEvent(try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                eventNumber: 0, clickCount: 1, pressure: pressure)))
            await settle(host, count: 1)
        }
        await settle(host)
    }

    private func capture(_ host: NSView, to url: URL) throws {
        host.displayIfNeeded()
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try #require(bitmap.representation(using: .png, properties: [:])).write(to: url)
    }
}
}

/// Records each answer request; answers it as the daemon would. Private so it
/// cannot race the other answer tests.
private final class CapturedAnswerURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [(path: String, body: Data)] = []
    static func reset() { lock.withLock { recorded = [] } }
    static func requests() -> [(path: String, body: Data)] { lock.withLock { recorded } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let entry = (path: request.url?.path ?? "", body: answerRequestBody(request) ?? Data())
        Self.lock.withLock { Self.recorded.append(entry) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"accepted":true,"status":"delivered"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
