import AppKit
import Darwin
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// Exercises production history/turn/input views under real AppKit layout.
/// The pane composition is a fixture, not a full ThreadsScreen: no daemon,
/// account, filesystem preview or network refresh is started. Run this test in
/// a separate OS process with an external deadline: a main-thread layout hang
/// cannot be interrupted by an async timeout on the same main actor.
@MainActor @Suite(.serialized)
struct ConversationHistoryRenderingTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_CONVERSATION_RENDER_QA"] == "1"))
    func longConversationCanReopenAndResizeWithBoundedMemory() async throws {
        let application = NSApplication.shared
        let originalPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(originalPolicy) }

        let initialFootprint = try #require(Self.footprintBytes())
        let clock = ContinuousClock()
        let started = clock.now
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let turns = Self.fixtureTurns(model: model)
        let target = TurnStartTarget.existing(
            locationID: .local, threadID: "conversation-render-fixture",
            repoRoot: nil, workspaceMode: "in_place", eligibleHarnesses: [])

        let host = NSHostingView(rootView: AnyView(EmptyView()))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer {
            window.contentView = nil
            window.close()
        }

        let widths: [CGFloat] = [1280, 900, 1100, 1280]
        var footprints: [UInt64] = []
        var firstRenderedFootprint: UInt64?
        for reopen in 0..<3 {
            // Changing the root recreates the real rows, including their local
            // disclosure state, just as leaving and reopening a thread does.
            host.rootView = AnyView(EmptyView())
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            host.rootView = AnyView(
                ConversationRenderFixture(turns: turns, target: target)
                    .environment(model)
                    .background(Color(nsColor: .windowBackgroundColor)))
            for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
                host.appearance = NSAppearance(named: appearance)
                for width in widths {
                    window.setContentSize(NSSize(width: width, height: 820))
                    host.frame = NSRect(x: 0, y: 0, width: width, height: 820)
                    host.layoutSubtreeIfNeeded()
                    try await Task.sleep(for: .milliseconds(100))
                    host.displayIfNeeded()
                    let footprint = try #require(Self.footprintBytes())
                    footprints.append(footprint)
                    if firstRenderedFootprint == nil { firstRenderedFootprint = footprint }
                    // A four-turn fixture should not consume gigabytes. These
                    // generous limits tolerate SwiftUI/AppKit/font caches while
                    // catching the reported 6.7–19 GB allocation growth.
                    #expect(footprint < initialFootprint + 512 * 1024 * 1024)
                    #expect(footprint < 2 * 1024 * 1024 * 1024)
                }
                if let root = ProcessInfo.processInfo.environment["CX_CONVERSATION_RENDER_OUTPUT"] {
                    let directory = URL(fileURLWithPath: root, isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try Self.capture(host, to: directory.appendingPathComponent("conversation-\(reopen)-\(name).png"))
                }
            }
        }
        let finalFootprint = try #require(footprints.last)
        let warmedFootprint = try #require(firstRenderedFootprint)
        #expect(finalFootprint < warmedFootprint + 256 * 1024 * 1024)
        // Elapsed time is diagnostic; the external process deadline detects main-actor
        // hangs without turning concurrent host load into a performance-test failure.
        // This test does not claim the original version failed here, nor that
        // short rendering replaces the actual multi-minute interactive repro.
        if let root = ProcessInfo.processInfo.environment["CX_CONVERSATION_RENDER_OUTPUT"] {
            let record: [String: Any] = [
                "production_views": ["ConversationHistoryStack", "TurnCard", "GlassField"],
                "fixture_turns": turns.count,
                "prompt_characters": turns.map { $0.prompt.count },
                "reopens": 3, "appearances": ["light", "dark"],
                "viewport_widths": widths.map(Double.init),
                "initial_footprint_bytes": initialFootprint,
                "sampled_footprint_bytes": footprints,
                "elapsed": String(describing: started.duration(to: clock.now)),
                "daemon_or_network_started": false,
                "baseline_failure_established": false,
            ]
            let url = URL(fileURLWithPath: root).appendingPathComponent("conversation-render-evidence.json")
            try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys]).write(to: url)
        }
    }

    private static func fixtureTurns(model: AppModel) -> [ThreadTurnInfo] {
        let paragraph = "A bounded human sample keeps its existing source, rig, weapon, and timing. Проверяем хват, переходы, обе камеры и происхождение файла.\n\n"
        let table = """
        | Phase | Observed behavior | Next check |
        | --- | --- | --- |
        | Ready | The right hand starts near the shoulder; this cell wraps at narrow widths. | Check the actual sword grip. |
        | Contact | Body rotation and planted feet remain readable. | Match the server contact time. |
        | Recover | Return to the starting pose without a sudden jump. | Review both camera views. |

        """
        let retained = "## Retained output\n\n" + String(repeating: paragraph, count: 6)
            + table + "```text\nrecorded diagnostic output, not a completion verdict\n```\n\n"
            + String(repeating: paragraph, count: 35)
        let answer = "## Completed sample contract\n\n" + table + String(repeating: paragraph, count: 22)
        var runs: [TaskRun] = []
        let turns = (0..<4).map { index -> ThreadTurnInfo in
            let prompt = String(String(repeating: "Task \(index): " + paragraph, count: 80).prefix(8_000))
            let id = "render-run-\(index)"
            var run = TaskRun(
                id: id, title: "Conversation fixture \(index)", prompt: prompt,
                mode: .agent, phase: index == 0 ? .cancelled : index == 3 ? .running : .succeeded,
                project: "Fixture", harnesses: [], n: 2,
                createdAt: .now, updatedAt: .now, spendUsd: 0, capUsd: 0,
                routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
                candidates: [], findings: [], diff: [])
            run.answerText = index == 0 ? retained : answer
            run.outputReadyState = index == 0 ? "diagnostic" : "ready"
            if index == 0 {
                run.outcomeBanner = "Stopped by host"
                run.primaryOutputPath = "final/retained-output.md"
                run.primaryOutputTruncated = true
                run.capturedArtifactPaths = ["attempts/a01/produced/frame.png"]
            }
            runs.append(run)
            return ThreadTurnInfo(
                id: "render-turn-\(index)", threadId: "conversation-render-fixture",
                runId: id, parentRunId: nil, planRunId: nil, kind: "agent", prompt: prompt,
                run: nil, createdAt: "2026-10-25T00:00:00Z")
        }
        model.liveTasks = runs
        // Opening a chat during a request also mounts its auto-expanded live
        // activity. Exercise the real reducer/presentation cap without a CLI,
        // model request or daemon connection.
        let live = model.ensureLiveBox("render-run-3")
        for sequence in 1...120 {
            live.transcript.apply(BusEnvelope(
                seq: sequence, kind: "harness.event", event: .object([
                    "type": .string("harness.event"),
                    "payload": .object([
                        "type": .string("message"),
                        "text": .string("Live step \(sequence): " + paragraph),
                    ]),
                ])))
        }
        return turns
    }

    private static func footprintBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let capacity = Int(count)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: capacity) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : nil
    }

    private static func capture(_ host: NSView, to url: URL) throws {
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: url)
    }
}

/// The real container and rows share the same width/selection modifiers as the
/// production pane. The composer uses the actual auto-growing native field.
@MainActor
private struct ConversationRenderFixture: View {
    let turns: [ThreadTurnInfo]
    let target: TurnStartTarget
    @State private var composerText = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                ConversationHistoryStack {
                    ForEach(turns) { turn in
                        TurnCard(turn: turn, target: target, routingOptions: TurnOptions(), executionRoot: nil)
                            .conversationMeasure()
                            .id(turn.id)
                    }
                }
            }
            GlassEffectContainer(spacing: Theme.Spacing.sm) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text("Agent · render fixture").font(.caption)
                    HStack(spacing: Theme.Spacing.sm) {
                        GlassField(text: $composerText, placeholder: "Continue this conversation…")
                        Button("Send", action: {}).disabled(true)
                    }
                }
                .padding(Theme.Spacing.md)
                .composerGlass()
                .conversationMeasure()
                .padding(Theme.Spacing.md)
            }
        }
    }
}
