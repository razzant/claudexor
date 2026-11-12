import AppKit
import Foundation
import SwiftUI
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// #450: the flat transcript must never present a command that is still
/// running in a background shell (or timed out) as one more finished call.
@MainActor
@Suite struct TranscriptCommandOutcomePresentationTests {
    private func env(_ seq: Int, _ json: String) -> BusEnvelope {
        let value = try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return BusEnvelope(seq: seq, kind: value["type"]?.stringValue ?? "message", event: value)
    }

    /// Three finished shell calls, then one moved to a background shell after
    /// its 30 s timeout: the handoff must stand alone, not join a quiet
    /// «shell · 4 calls» group of finished calls.
    @Test func aBackgroundHandoffNeverJoinsTheFinishedToolGroup() {
        var reducer = TranscriptReducer()
        var seq = 1
        for index in 0..<4 {
            reducer.apply(env(seq, #"{"type":"harness.event","payload":{"type":"tool_call","tool":{"name":"shell","kind":"command","use_id":"c\#(index)","target":"find /workspace"}}}"#))
            seq += 1
            let outcome = index == 3
                ? #"{"state":"backgrounded","background_reason":"timeout","timeout_ms":30000,"shell_id":"3","pid":4242}"#
                : #"{"state":"exited"}"#
            reducer.apply(env(seq, #"{"type":"harness.event","payload":{"type":"tool_result","tool":{"name":"shell","kind":"command","use_id":"c\#(index)","status":"ok","command_outcome":"# + outcome + "}}}"))
            seq += 1
        }
        let rows = TranscriptPresentation.rows(reducer.blocks)
        #expect(rows.count == 4)
        if case .tool(_, let tool) = rows.last {
            #expect(tool.status.rawValue == "unconfirmed")
        } else {
            Issue.record("the background handoff must stand alone")
        }
    }

    /// The same words as the engine's `commandOutcomeLabel` (schema
    /// `tool-ref.test.ts` pins the identical strings): one vocabulary.
    @Test func theNoteUsesTheEngineVocabulary() {
        typealias Outcome = ToolBlock.CommandOutcome
        #expect(ToolRow.commandNote(Outcome(state: .backgrounded, timeoutMs: 30000, backgroundReason: .timeout,
                                            shellId: "3", pid: 4242))
                == "Handed off to background after its 30s timeout; completion not observed · shell 3 · pid 4242")
        #expect(ToolRow.commandNote(Outcome(state: .backgrounded, backgroundReason: .timeout))
                == "Handed off to background after its timeout; completion not observed")
        #expect(ToolRow.commandNote(Outcome(state: .backgrounded, timeoutMs: 0, backgroundReason: .timeout))
                == "Handed off to background; completion not observed")
        #expect(ToolRow.commandNote(Outcome(state: .backgrounded, backgroundReason: .requested, pid: 7))
                == "Handed off to background; completion not observed · pid 7")
        #expect(ToolRow.commandNote(Outcome(state: .timedOut, timeoutMs: 90000))
                == "Timed out after 1m 30s · exit status unknown")
        #expect(ToolRow.commandNote(Outcome(state: .timedOut)) == "Timed out · exit status unknown")
        #expect(ToolRow.commandNote(Outcome(state: .unknown)) == "Command outcome not reported")
        #expect(ToolRow.commandNote(nil) == "Command outcome not reported")
    }

    /// #546: the note after a later `command_outcome_refined` row, folded
    /// through the real reducer: the reported completion leads, the exit code
    /// stays unknown and the handoff stays in the history.
    @Test func aReportedCompletionNamesItselfAndKeepsTheHandoff() {
        func note(_ completion: String, reason: String) -> String? {
            var reducer = TranscriptReducer()
            reducer.apply(env(1, #"{"type":"harness.event","payload":{"type":"tool_call","tool":{"name":"shell","kind":"command","use_id":"bg","target":"sleep 45"}}}"#))
            reducer.apply(env(2, #"{"type":"harness.event","payload":{"type":"tool_result","tool":{"name":"shell","kind":"command","use_id":"bg","status":"ok","command_outcome":{"state":"backgrounded",\#(reason),"shell_id":"3","pid":4242}}}}"#))
            reducer.apply(env(3, #"{"type":"harness.event","payload":{"type":"status","tool":{"name":"shell","kind":"command","use_id":"bg","target":"sleep 45","command_outcome":{"state":"completion_reported",\#(reason),"shell_id":"3","pid":4242,"completion_status":"\#(completion)"}},"payload":{"code":"command_outcome_refined"}}}"#))
            guard case .tool(_, let tool) = reducer.blocks.first, tool.status == .unconfirmed else { return nil }
            return ToolRow.commandNote(tool.commandOutcome)
        }
        let timeout = #""background_reason":"timeout","timeout_ms":30000"#
        let requested = #""background_reason":"requested""#
        #expect(note("success", reason: timeout)
                == "Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 3 · pid 4242")
        #expect(note("success", reason: requested)
                == "Completion reported; exit code unknown · handed off to background · shell 3 · pid 4242")
        #expect(note("error", reason: requested)
                == "Completion reported (error); exit code unknown · handed off to background · shell 3 · pid 4242")
    }

    /// Reuses the app's warning mark and caution tone: never the success
    /// check, the failure cross, or a spinner that would never stop.
    @Test func theUnconfirmedGlyphIsARealDistinctWarningMark() {
        let glyph = ToolRow.statusGlyph(.unconfirmed)
        #expect(NSImage(systemSymbolName: glyph, accessibilityDescription: nil) != nil)
        #expect(Set([ToolRow.statusGlyph(.running), ToolRow.statusGlyph(.ok), ToolRow.statusGlyph(.error)])
            .contains(glyph) == false)
        for scheme in [ColorScheme.light, .dark] {
            var environment = EnvironmentValues()
            environment.colorScheme = scheme
            #expect(ToolRow.statusColor(.unconfirmed).resolve(in: environment)
                    == Theme.status(.caution).resolve(in: environment))
        }
    }
}

/// The rows the engine stores for the synthetic Cursor shell fixture,
/// generated from the Cursor normalizer and the orchestrator's `harness.event`
/// projection by `scripts/gen-cursor-transcript-fixture.ts` (kept fresh by
/// `pnpm fixtures:swift:check`; the orchestrator integration test proves the
/// tool rows equal those a real run persisted).
@MainActor
enum CursorTranscriptReplay {
    private struct Fixture: Decodable {
        let generatedBy: [String]
        let rows: [JSONValue]
    }

    static func rows() throws -> [JSONValue] {
        let url = try #require(
            Bundle.module.url(forResource: "cursor-command-outcome-transcript", withExtension: "json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.generatedBy == ["createCursorParser", "harnessEventPayload"])
        return fixture.rows
    }

    /// Fold the stored rows in order through the app's reducer, optionally
    /// only the first `count` of them (a mid-run snapshot).
    static func reducer(_ rows: [JSONValue], first count: Int? = nil) -> TranscriptReducer {
        var reducer = TranscriptReducer()
        for row in rows.prefix(count ?? rows.count) {
            let seq = Int(row["seq"]?.doubleValue ?? 0)
            reducer.apply(BusEnvelope(seq: seq, kind: row["type"]?.stringValue ?? "", event: row))
        }
        return reducer
    }

    /// The number of rows up to and including the stored call of `useId`.
    static func rowsThroughCall(_ useId: String, in rows: [JSONValue]) -> Int? {
        rows.firstIndex {
            $0["payload"]?["type"]?.stringValue == "tool_call"
                && $0["payload"]?["tool"]?["use_id"]?.stringValue == useId
        }.map { $0 + 1 }
    }

    static func tools(_ rows: [TranscriptPresentation.Row]) -> [ToolBlock] {
        rows.compactMap { row in
            if case .tool(_, let tool) = row { return tool }
            return nil
        }
    }
}

@MainActor
@Suite struct CursorTranscriptReplayTests {
    @Test func storedCursorRowsFoldIntoAnHonestFlatTranscript() throws {
        let stored = try CursorTranscriptReplay.rows()
        let blocks = CursorTranscriptReplay.reducer(stored).blocks
        let rows = TranscriptPresentation.chatRows(blocks).rows
        let tools = CursorTranscriptReplay.tools(rows)
        // One narration line; each of the seven shell calls stands on its own
        // (the typed final answer is the answer bubble, never a transcript row).
        #expect(rows.count == 8)
        #expect(!rows.contains { if case .toolGroup = $0 { true } else { false } })
        #expect(tools.map(\.target) == ["ls", "pnpm test", "find /repo -name '*.log'", "pnpm dev",
                                        "sleep 120", "pnpm build", "missing-tool --version"])
        #expect(tools.map(\.status) == [.ok, .error, .unconfirmed, .unconfirmed, .unconfirmed, .error, .error])
        #expect(tools.map(\.exitCode) == [0, 1, nil, nil, nil, nil, nil])
        #expect(TurnPresentation.activitySummary(blocks: blocks) == "7 tools")
    }

    /// The Swift note and the engine's own stored result text name the same
    /// state for every unconfirmed command of the replay.
    @Test func everyUnconfirmedNoteMatchesTheStoredEngineText() throws {
        let stored = try CursorTranscriptReplay.rows()
        var engineText: [String: String] = [:]
        for row in stored where row["payload"]?["type"]?.stringValue == "tool_result" {
            if let target = row["payload"]?["tool"]?["target"]?.stringValue,
               let text = row["payload"]?["text"]?.stringValue {
                engineText[target] = text
            }
        }
        let prefix = "tool_result: "
        let unconfirmed = CursorTranscriptReplay.tools(
            TranscriptPresentation.rows(CursorTranscriptReplay.reducer(stored).blocks))
            .filter { $0.status == .unconfirmed }
        #expect(unconfirmed.count == 3)
        for tool in unconfirmed {
            let text = try #require(engineText[tool.target ?? ""])
            #expect(text.hasPrefix(prefix))
            #expect(ToolRow.commandNote(tool.commandOutcome) == String(text.dropFirst(prefix.count)))
        }
    }

    /// Mid-run, a command still in its first 30 s keeps the spinner while an
    /// earlier handoff already reads as unconfirmed; the collapsed receipt
    /// line follows the newest call.
    @Test func midRunTheRunningCallAndTheHandoffStayDistinct() throws {
        let stored = try CursorTranscriptReplay.rows()
        let cut = try #require(CursorTranscriptReplay.rowsThroughCall("c-bg-request", in: stored))
        let blocks = CursorTranscriptReplay.reducer(stored, first: cut).blocks
        let tools = CursorTranscriptReplay.tools(TranscriptPresentation.rows(blocks))
        #expect(tools.map(\.status) == [.ok, .error, .unconfirmed, .running])
        #expect(TurnPresentation.lastActivityLine(blocks: blocks) == "pnpm pnpm dev")
    }
}

/// Opt-in pictures of the replayed transcript (no app model, daemon,
/// network, credentials or provider action; the window is never shown; the
/// output directory is explicit).
@MainActor @Suite(.serialized)
struct TranscriptCommandOutcomeRenderingTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_TOOL_ROW_RENDER_QA"] == "1"))
    func replayedTranscriptInBothAppearances() async throws {
        let output = try #require(ProcessInfo.processInfo.environment["CX_TOOL_ROW_RENDER_OUTPUT"])
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        let stored = try CursorTranscriptReplay.rows()
        let cut = try #require(CursorTranscriptReplay.rowsThroughCall("c-bg-request", in: stored))
        let scenes = [("mid-run", CursorTranscriptReplay.reducer(stored, first: cut).blocks),
                      ("settled", CursorTranscriptReplay.reducer(stored).blocks)]
        let width: CGFloat = 640, height: CGFloat = 300
        for (scene, blocks) in scenes {
            for (name, appearance, scheme) in [("light", NSAppearance.Name.aqua, ColorScheme.light),
                                                ("dark", .darkAqua, .dark)] {
                let content = VStack(alignment: .leading) {
                    TranscriptView(blocks: blocks)
                    Spacer(minLength: 0)
                }
                .padding(Theme.Spacing.lg)
                .frame(width: width, height: height)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
                .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                let host = NSHostingView(rootView: content)
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                host.frame = NSRect(x: 0, y: 0, width: width, height: height)
                host.appearance = NSAppearance(named: appearance)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                host.displayIfNeeded()
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                let directory = URL(fileURLWithPath: output, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try png.write(to: directory.appendingPathComponent("transcript-\(scene)-\(name).png"))
                #expect(!window.isVisible && !window.isKeyWindow)
                window.close()
            }
        }
    }
}

/// #546: the rows the engine stores for the native-shaped Cursor run of the
/// issue (a timeout handoff, a requested background command, one completion
/// notification per shell), generated like the #450 fixture. The frame shape
/// stays a hypothesis until a sanitized recording exists.
@MainActor
enum CursorCompletionReplay {
    private struct Fixture: Decodable {
        let generatedBy: [String]
        let source: String
        let rows: [JSONValue]
    }

    static let completion = ("cursor-background-completion-transcript", "background-completion")
    /// Synthetic negative reports: no native run showed these frames.
    static let failures = ("cursor-background-completion-failures-transcript", "background-completion-failures")

    static func rows(_ fixture: (resource: String, source: String) = completion) throws -> [JSONValue] {
        let url = try #require(Bundle.module.url(forResource: fixture.resource, withExtension: "json"))
        let stored = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(stored.generatedBy == ["createCursorParser", "harnessEventPayload"])
        #expect(stored.source == "packages/harness-cursor/fixtures/shell/\(fixture.source).jsonl")
        return stored.rows
    }

    /// The rows up to and including the first stored row of `type`.
    static func rowsThrough(_ type: String, in rows: [JSONValue]) -> Int? {
        rows.firstIndex { $0["payload"]?["type"]?.stringValue == type }.map { $0 + 1 }
    }

    static func isRefinement(_ row: JSONValue) -> Bool {
        row["payload"]?["type"]?.stringValue == "status"
            && row["payload"]?["payload"]?["code"]?.stringValue == "command_outcome_refined"
    }

    /// The engine's own stored words for the latest row about each command.
    static func engineText(_ rows: [JSONValue]) -> [String: String] {
        var text: [String: String] = [:]
        for row in rows where isRefinement(row) || row["payload"]?["type"]?.stringValue == "tool_result" {
            guard let target = row["payload"]?["tool"]?["target"]?.stringValue,
                  let words = row["payload"]?["text"]?.stringValue else { continue }
            text[target] = words.hasPrefix("tool_result: ") ? String(words.dropFirst(13)) : words
        }
        return text
    }
}

@MainActor
@Suite struct CursorCompletionReplayTests {
    @Test func storedRowsRefineEachCommandOnItsOwnCard() throws {
        let stored = try CursorCompletionReplay.rows()
        let blocks = CursorTranscriptReplay.reducer(stored).blocks
        let tools = CursorTranscriptReplay.tools(TranscriptPresentation.chatRows(blocks).rows)
        #expect(tools.map(\.target) == ["sleep 45", "sleep 5"])
        #expect(tools.map(\.status) == [.unconfirmed, .unconfirmed])
        #expect(tools.map(\.exitCode) == [nil, nil])
        #expect(tools.map { ToolRow.commandNote($0.commandOutcome) } == [
            "Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 148478 · pid 148480",
            "Completion reported; exit code unknown · handed off to background · shell 148490 · pid 148492",
        ])
        #expect(TurnPresentation.activitySummary(blocks: blocks) == "2 tools")
    }

    /// One vocabulary: each card's note equals the engine's own stored text of
    /// the latest row about that command.
    @Test func everyNoteMatchesTheLatestStoredEngineText() throws {
        let stored = try CursorCompletionReplay.rows()
        let engineText = CursorCompletionReplay.engineText(stored)
        #expect(stored.filter { CursorCompletionReplay.isRefinement($0) }.count == 2)
        let tools = CursorTranscriptReplay.tools(
            TranscriptPresentation.rows(CursorTranscriptReplay.reducer(stored).blocks))
        #expect(tools.count == 2)
        for tool in tools {
            #expect(ToolRow.commandNote(tool.commandOutcome) == engineText[tool.target ?? ""])
        }
    }

    /// Mid-run, before any notification, both handoffs say exactly what was
    /// seen: handed off, completion not observed.
    @Test func beforeTheNotificationsTheHandoffsClaimNoCompletion() throws {
        let stored = try CursorCompletionReplay.rows()
        let cut = try #require(CursorCompletionReplay.rowsThrough("status", in: stored)).advanced(by: -1)
        let tools = CursorTranscriptReplay.tools(
            TranscriptPresentation.rows(CursorTranscriptReplay.reducer(stored, first: cut).blocks))
        #expect(tools.map { ToolRow.commandNote($0.commandOutcome) } == [
            "Handed off to background after its 30s timeout; completion not observed · shell 148478 · pid 148480",
            "Handed off to background; completion not observed · shell 148490 · pid 148492",
        ])
    }

    /// The live stream (with a reconnect that replays earlier rows) and the
    /// restored transcript (one fresh fold of the stored rows) end identical.
    @Test func theLiveStreamAndTheRestoredTranscriptAgree() throws {
        let stored = try CursorCompletionReplay.rows()
        let restored = CursorTranscriptReplay.reducer(stored)
        var live = TranscriptReducer()
        let reconnectAt = try #require(CursorCompletionReplay.rowsThrough("status", in: stored))
        for row in stored.prefix(reconnectAt) + stored.dropFirst(2) {
            live.apply(BusEnvelope(seq: Int(row["seq"]?.doubleValue ?? 0), kind: row["type"]?.stringValue ?? "", event: row))
        }
        #expect(live.blocks == restored.blocks)
        #expect(live.textChars == restored.textChars)
        #expect(live.trimmed == restored.trimmed)
    }

    /// The longest words of any note, at the conversation's real widths (680 is
    /// its cap, 420 its floor with the inspector closed, 320 a narrow split with
    /// the inspector open), must fit the row's three lines: the handle at the
    /// end is the part a clip would lose.
    @Test func theLongestNotesFitTheirThreeLinesAtRealWidths() throws {
        func height(_ text: String, _ width: CGFloat) -> CGFloat {
            NSHostingView(rootView: Text(text).font(.caption)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: width, alignment: .leading)).fittingSize.height
        }
        let notes = [
            "Completion reported (aborted); exit code unknown · handed off to background after its 30s timeout · shell 148478 · pid 148480",
            "Handed off to background after its 30s timeout; completion not observed · shell 148478 · pid 148480",
        ]
        for conversation in [CGFloat(680), 420, 320] {
            let width = conversation - 3 * Theme.Spacing.lg
            for note in notes {
                let lines = (height(note, width) / height("X", width)).rounded()
                #expect(lines <= 3, "\(lines) lines at \(conversation): \(note)")
            }
        }
    }
}

/// #546: the vendor's negative reports reach the same card in the engine's
/// words, the exit code stays unknown, and a frame nothing defines leaves its
/// handoff standing. Synthetic rows: no native run showed these frames.
@MainActor
@Suite struct CursorCompletionFailureReplayTests {
    @Test func negativeReportsKeepTheirWordsAndAnUnreadableReportLeavesTheHandoff() throws {
        let stored = try CursorCompletionReplay.rows(CursorCompletionReplay.failures)
        let blocks = CursorTranscriptReplay.reducer(stored).blocks
        let tools = CursorTranscriptReplay.tools(TranscriptPresentation.chatRows(blocks).rows)
        #expect(tools.map(\.target) == ["pnpm test", "pnpm dev", "sleep 600"])
        // A report is not a failed tool call and never a success.
        #expect(tools.map(\.status) == [.unconfirmed, .unconfirmed, .unconfirmed])
        #expect(tools.map(\.exitCode) == [nil, nil, nil])
        #expect(tools.map { ToolRow.commandNote($0.commandOutcome) } == [
            "Completion reported (error); exit code unknown · handed off to background after its 30s timeout · shell 148500 · pid 148502",
            "Completion reported (aborted); exit code unknown · handed off to background · shell 148510 · pid 148512",
            "Handed off to background; completion not observed · shell 148520 · pid 148522",
        ])
    }

    @Test func everyNoteMatchesTheLatestStoredEngineText() throws {
        let stored = try CursorCompletionReplay.rows(CursorCompletionReplay.failures)
        let engineText = CursorCompletionReplay.engineText(stored)
        let tools = CursorTranscriptReplay.tools(
            TranscriptPresentation.rows(CursorTranscriptReplay.reducer(stored).blocks))
        #expect(tools.count == 3)
        for tool in tools {
            #expect(ToolRow.commandNote(tool.commandOutcome) == engineText[tool.target ?? ""])
        }
    }
}

/// Opt-in pictures of the #546 replay (no app model, daemon, network,
/// credentials or provider action; the window is never shown; the output
/// directory and file prefix are explicit). It uses only APIs the #450 app
/// already had, so the same file renders the previous app ("Now") as well, and
/// each height comes from the content, so this harness cannot hide a clip.
@MainActor @Suite(.serialized)
struct TranscriptCompletionRenderingTests {
    private struct Stored: Decodable { let rows: [JSONValue] }

    private func stored(_ resource: String) throws -> [JSONValue]? {
        guard let url = Bundle.module.url(forResource: resource, withExtension: "json") else { return nil }
        return try JSONDecoder().decode(Stored.self, from: Data(contentsOf: url)).rows
    }

    private func envelope(_ row: JSONValue) -> BusEnvelope {
        BusEnvelope(seq: Int(row["seq"]?.doubleValue ?? 0), kind: row["type"]?.stringValue ?? "", event: row)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_TOOL_ROW_RENDER_QA"] == "1"))
    func backgroundCompletionInBothAppearances() async throws {
        let environment = ProcessInfo.processInfo.environment
        let output = try #require(environment["CX_TOOL_ROW_RENDER_OUTPUT"])
        let prefix = environment["CX_TOOL_ROW_RENDER_PREFIX"] ?? "proposed"
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        var midRun = TranscriptReducer()
        var settled = TranscriptReducer()
        for row in try #require(try stored("cursor-background-completion-transcript")) {
            settled.apply(envelope(row))
            if row["payload"]?["type"]?.stringValue == "tool_result",
               row["payload"]?["tool"]?["use_id"]?.stringValue == "call-background-sleep" {
                midRun = settled
            }
        }
        var scenes = [("mid-run", midRun.blocks), ("settled", settled.blocks)]
        // The previous app has no such rows to show; the proposal must.
        if let rows = try stored("cursor-background-completion-failures-transcript") {
            var reducer = TranscriptReducer()
            for row in rows { reducer.apply(envelope(row)) }
            scenes.append(("negative-reports", reducer.blocks))
        }
        for (scene, blocks) in scenes {
            for width in [CGFloat(680), 420, 320] {
                for (name, appearance, scheme) in [("light", NSAppearance.Name.aqua, ColorScheme.light),
                                                    ("dark", .darkAqua, .dark)] {
                    let content = TranscriptView(blocks: blocks)
                        .padding(Theme.Spacing.lg)
                        .frame(width: width, alignment: .topLeading)
                        .background(Color(nsColor: .windowBackgroundColor))
                        .environment(\.colorScheme, scheme)
                        .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                    let host = NSHostingView(rootView: content)
                    host.appearance = NSAppearance(named: appearance)
                    let height = max(host.fittingSize.height, 1)
                    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                                          styleMask: [.borderless], backing: .buffered, defer: false)
                    window.isReleasedWhenClosed = false
                    window.contentView = host
                    host.frame = NSRect(x: 0, y: 0, width: width, height: height)
                    host.layoutSubtreeIfNeeded()
                    try await Task.sleep(for: .milliseconds(150))
                    host.displayIfNeeded()
                    let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                    host.cacheDisplay(in: host.bounds, to: bitmap)
                    let png = try #require(bitmap.representation(using: .png, properties: [:]))
                    let directory = URL(fileURLWithPath: output, isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try png.write(to: directory.appendingPathComponent(
                        "\(prefix)-\(scene)-w\(Int(width))-\(name).png"))
                    #expect(!window.isVisible && !window.isKeyWindow)
                    window.close()
                }
            }
        }
    }
}
