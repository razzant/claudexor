import AppKit
import ClaudexorKit
import CryptoKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// Never ordered, never key: pictures only, no desktop presence.
private final class StreamFlowCaptureWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Explicit opt-in (CX_STREAM_WINDOW=1): the production ThreadsScreen in a
/// never-ordered borderless window under a prohibited activation policy, over
/// the real GatewayClient and an in-process loopback engine. Pool-capacity
/// streams of other threads stay open and the unrelated /runs answers after
/// two seconds; switching threads through the call the sidebar selection makes
/// must paint the selected history before that answer. Frames and a manifest
/// go to CX_STREAM_WINDOW_OUT when set. No daemon, account, saved state,
/// credential or visible window is involved.
extension KeyboardFocusTests {
@MainActor @Suite(.serialized)
struct StreamWindowFlowTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_STREAM_WINDOW"] == "1"))
    func switchedHistoryPaintsWhileStreamsHoldThePoolAndRunsAreSlow() async throws {
        let app = NSApplication.shared
        let policy = app.activationPolicy()
        app.setActivationPolicy(.prohibited)
        defer { app.setActivationPolicy(policy) }
        let token = UUID().uuidString
        let previous = try distinctHistorySource(thread: "thread-A", runPrefix: "run-A", count: 2)
        let selected = try HistoryTestSource(count: 3) // "Checkpoint 3:" exists only in this thread
        let threadB = selected.detail.thread.id
        let session = URLSession(configuration: .ephemeral)
        let streams = session.configuration.httpMaximumConnectionsPerHost
        try #require((1...64).contains(streams))
        let others = (0..<(streams - 1)).map { "run-other-\($0)" }
        let runRows = others.map { #"{"runId":"\#($0)","state":"running","mode":"agent"}"# }
        let threads = ThreadListResponse(threads: [previous.detail.thread, selected.detail.thread])
        let server = try LoopbackControlServer(token: token, routes: [
            "/v2/runs": .init(body: Data(#"{"runs":[\#(runRows.joined(separator: ","))]}"#.utf8), delay: .seconds(2)),
            "/v2/threads": .init(body: try JSONEncoder().encode(threads)),
            "/v2/threads/thread-A/history": .init(body: try JSONEncoder().encode(previous.page(nil))),
            "/v2/threads/\(threadB)/history": .init(body: try JSONEncoder().encode(selected.page(nil))),
        ])
        let base = try await server.start()
        defer { server.stop() }
        let model = AppModel(client: GatewayClient(baseURL: base, token: token, session: session),
                             requestNotificationAuthorization: false, loadPersistedState: false)
        defer { model.cancelAllStreams() }
        model.health = .connected
        model.threads = threads.threads
        model.liveTasks = others.map(liveRunInAnotherThread)
        model.startGlobalStream()
        for id in others { model.stream(runId: id) }
        await model.openThread(locationID: .local, id: "thread-A")

        let rect = NSRect(x: 0, y: 0, width: 1200, height: 760)
        let window = StreamFlowCaptureWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: ThreadsScreen(feedState: ConversationFeedState()).environment(model))
        host.frame = rect
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        let out = ProcessInfo.processInfo.environment["CX_STREAM_WINDOW_OUT"].map { URL(fileURLWithPath: $0) }
        try #require(await settle(host) {
            server.openStreamPaths.count == streams && prose(host).contains { $0.hasPrefix("Checkpoint 2:") }
        })
        var frames = [try capture(host, "1-previous-thread", out)]

        let started = ContinuousClock.now
        let switched = Task { await model.openThread(locationID: .local, id: threadB) } // the sidebar selection's call
        let paintedInTime = await settle(host) { prose(host).contains { $0.hasPrefix("Checkpoint 3:") } }
        let painted = ContinuousClock.now - started
        let runsAnsweredBeforePaint = server.answeredAt("/v2/runs") != nil
        let streamsAtPaint = server.openStreamPaths.count
        frames.append(try capture(host, paintedInTime ? "2-switched-before-runs-answer" : "2-switched-not-painted-10s", out))
        var reconciled: Duration?
        if paintedInTime {
            await switched.value
            reconciled = ContinuousClock.now - started
            _ = await settle(host) { true }
            frames.append(try capture(host, "3-after-runs-answer", out))
        }
        if let out {
            let manifest: [String: Any] = [
                "capture": "NSHostingView.cacheDisplay", "window_shown": window.isVisible,
                "activation_policy": "prohibited", "per_host_limit": streams,
                "painted_within_10s": paintedInTime, "streams_open_at_paint": streamsAtPaint,
                "runs_answered_before_paint": runsAnsweredBeforePaint, "runs_delay_ms": 2000,
                "history_request_reached_server": server.requests.contains { $0.path == "/v2/threads/\(threadB)/history" },
                "switch_to_paint_ms": Self.milliseconds(painted),
                "switch_to_reconciled_ms": reconciled.map(Self.milliseconds) ?? NSNull(),
                "requests": server.requests.map { ["path": $0.path, "open_streams": $0.openStreams] },
                "frames": frames,
            ]
            try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
                .write(to: out.appendingPathComponent("manifest.json"))
        }
        #expect(!window.isVisible)
        #expect(paintedInTime, "the switched history did not paint within 10 s")
        #expect(!runsAnsweredBeforePaint && streamsAtPaint == streams)
        if let reconciled { #expect(painted < reconciled && !model.runListReconciliationNeeded) }
        #expect(server.openStreamPaths.count == streams && server.unauthorizedRequests == 0)
    }

    private static func milliseconds(_ duration: Duration) -> Double {
        let (seconds, attoseconds) = duration.components
        return ((Double(seconds) * 1000 + Double(attoseconds) / 1e15) * 1000).rounded() / 1000
    }

    /// Lays out and draws until `done` holds; false after a 10 s deadline.
    private func settle(_ host: NSView, until done: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        repeat {
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
            try? await Task.sleep(for: .milliseconds(20))
            if ContinuousClock.now >= deadline { return done() }
        } while !done()
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        return true
    }

    private func views(_ root: NSView) -> [NSView] { [root] + root.subviews.flatMap(views) }
    private func prose(_ host: NSView) -> [String] { views(host).compactMap { ($0 as? ProseTextView)?.string } }

    private func capture(_ host: NSView, _ name: String, _ out: URL?) throws -> [String: Any] {
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        let digest = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
        try out.map { try png.write(to: $0.appendingPathComponent("\(name).png")) }
        return ["name": name, "sha256": digest, "prose_prefixes": prose(host).map { String($0.prefix(24)) }]
    }
}
}
