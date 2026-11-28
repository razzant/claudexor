import ClaudexorKit
import Foundation
import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

@Suite(.serialized) struct RemoteRunDetailTests {
    /// The product view gives the earlier text and the accepted answer separate
    /// native documents, so an unclosed fence in the first cannot swallow the second.
    @MainActor
    @Test func addressedAnswerWithUnclosedFence() throws {
        let earlier = "## Earlier assistant text\n\n```swift\nlet swatch = 1"
        let accepted = "B: The accepted correction remains prose."
        let note = "Earlier assistant text could not be determined: the run's event record is incomplete."
        // Control: one concatenated document puts the accepted line inside the fence.
        let joined = renderedProse(offscreen(MarkdownOutputView(markdown: earlier + "\n\n" + accepted)))
        #expect(joined.count == 1)
        #expect(joined.first.flatMap { insideCodeBlock($0.text, accepted) } == true)

        let both = offscreen(AddressedAnswerContent(earlier: earlier, accepted: accepted))
        let hosts = renderedProse(both)
        let early = try #require(hosts.first { $0.text.string.contains("let swatch = 1") })
        let final = try #require(hosts.first { $0.text.string.contains(accepted) })
        #expect(!early.text.string.contains(accepted))
        #expect(!final.text.string.contains("let swatch"))
        #expect(insideCodeBlock(early.text, "let swatch = 1") == true)
        #expect(insideCodeBlock(final.text, accepted) == false)
        #expect(early.top < final.top)

        let noted = offscreen(AddressedAnswerContent(earlier: nil, accepted: accepted, earlierNote: note))
        #expect(renderedProse(noted).map(\.text.string) == [accepted])

        // Optional legible raster of the same offscreen hosts; no window is shown.
        guard let path = ProcessInfo.processInfo.environment["CX756_PREVIEW_PNG"] else { return }
        let sheet = offscreen(VStack(alignment: .leading, spacing: 24) {
            AddressedAnswerContent(earlier: earlier, accepted: accepted)
            Divider()
            AddressedAnswerContent(earlier: nil, accepted: accepted, earlierNote: note)
        })
        let bitmap = try #require(sheet.bitmapImageRepForCachingDisplay(in: sheet.bounds))
        sheet.cacheDisplay(in: sheet.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    @MainActor
    @Test func failedRemoteDetailLoadRemainsRetryable() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let calls = RemoteRunDetailCounter()
        let (model, locationID) = makeModel(runId: "run-retry")
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-retry" else {
                throw RemoteRunDetailError.badRequest
            }
            if calls.incrementAndGet() == 1 {
                return (response(for: request, status: 503), Data("offline".utf8), 0)
            }
            let body = #"{"summary":{"runId":"run-retry","state":"succeeded","mode":"agent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"fresh answer","truncated":false},"lastSeq":2}"#
            return (response(for: request), Data(body.utf8), 0)
        }

        #expect(!(await model.loadRunDetail("run-retry", locationID: locationID)))
        #expect(model.task("run-retry", at: locationID)?.engineError?.contains(
            "Could not load run detail") == true)
        #expect(await model.loadRunDetail("run-retry", locationID: locationID))
        #expect(calls.value == 2)
        #expect(model.task("run-retry", at: locationID)?.answerText == "fresh answer")
    }

    @MainActor
    @Test func addressedAnswerShowsEarlierPreviewBeforeTheSameAcceptedText() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, locationID) = makeModel(runId: "run-speaks")
        let requests = RemoteRunDetailCounter()
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-speaks",
                  request.url?.query == "includeEarlierAssistantOutput=true" else {
                throw RemoteRunDetailError.badRequest // No implicit full-artifact fetch.
            }
            // The old route tolerates the unknown query and returns its normal answer.
            // The new route returns an additional preview only for the addressed request.
            let sequence = requests.incrementAndGet()
            let earlier = sequence == 1 ? "" : ###", "earlierAssistantOutput":{"path":"final/earlier-assistant-output.md","text":"## Earlier assistant text (not the accepted final)\n\nInitial swatch report.","bytes":20000,"truncated":true}"###
            let body = #"{"summary":{"runId":"run-speaks","state":"succeeded","mode":"ask","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Accepted text.","truncated":false\#(earlier)},"lastSeq":\#(sequence)}"#
            return (response(for: request), Data(body.utf8), 0)
        }
        #expect(await model.loadRunDetail("run-speaks", locationID: locationID))
        #expect(model.task("run-speaks", at: locationID)?.answerText == "Accepted text.")
        #expect(model.task("run-speaks", at: locationID)?.earlierAnswerText == nil)
        #expect(await model.loadRunDetail("run-speaks", locationID: locationID))
        let task = model.task("run-speaks", at: locationID)
        let expected = "## Earlier assistant text (not the accepted final)\n\nInitial swatch report."
            + "\n\n[Earlier text preview bounded; full artifact: final/earlier-assistant-output.md]"
        #expect(task?.earlierAnswerText == expected)
        #expect(task?.answerText == "Accepted text.")
        #expect(task?.primaryOutputPath == "final/answer.md")
        #expect(requests.value == 2)
    }

    /// The local addressed detail asks for earlier text even after a plain view
    /// hydration cached the run, keeps it across a runs-list refresh, and lets a
    /// fresh addressed detail replace it with a positive unavailability note.
    @MainActor
    @Test func localAddressedDetailAsksForEarlierTextBeyondAPlainHydration() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, _) = makeModel(runId: "run-local", local: true)
        let queries = RemoteRunDetailRecorder()
        let state = RemoteRunDetailRecorder()
        state.append("text")
        RemoteRunDetailURLProtocol.handler = { request in
            let query = request.url?.query ?? ""
            if request.url?.path == "/v2/runs", query.isEmpty {
                let list = #"{"runs":[{"runId":"run-local","state":"succeeded","mode":"ask","outputReadyState":"ready"}]}"#
                return (response(for: request), Data(list.utf8), 0)
            }
            let addressed = query == "includeEarlierAssistantOutput=true"
            guard request.url?.path == "/v2/runs/run-local", addressed || query.isEmpty else {
                throw RemoteRunDetailError.badRequest
            }
            queries.append(query)
            let extra = !addressed ? "" : state.last == "text"
                ? ###", "earlierAssistantOutput":{"path":"final/earlier-assistant-output.md","text":"## Earlier assistant text (not the accepted final)\n\nInitial swatch report.","bytes":80,"truncated":false}"###
                : #", "earlierAssistantOutputUnavailable":"source_gap""#
            let body = #"{"summary":{"runId":"run-local","state":"succeeded","mode":"ask","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Accepted text.","truncated":false\#(extra)},"lastSeq":4}"#
            return (response(for: request), Data(body.utf8), 0)
        }

        // An ordinary view (Evidence, Changes) hydrates the run without earlier text.
        await model.ensureRunDetail("run-local")
        #expect(queries.values == [""])
        #expect(model.task("run-local")?.answerText == "Accepted text.")
        #expect(model.task("run-local")?.earlierAnswerText == nil)

        // Opening the run's detail is not satisfied by that cached plain load.
        await model.ensureAddressedRunDetail("run-local", locationID: .local)
        #expect(queries.values == ["", "includeEarlierAssistantOutput=true"])
        let earlier = "## Earlier assistant text (not the accepted final)\n\nInitial swatch report."
        #expect(model.task("run-local")?.earlierAnswerText == earlier)
        #expect(model.task("run-local")?.earlierAnswerNote == nil)
        #expect(model.task("run-local")?.answerText == "Accepted text.")
        await model.ensureAddressedRunDetail("run-local", locationID: .local)
        #expect(queries.values.count == 2)

        // A runs-list refresh carries only the summary and keeps the addressed view.
        await model.refreshRuns()
        #expect(model.task("run-local")?.earlierAnswerText == earlier)
        #expect(model.task("run-local")?.answerText == "Accepted text.")

        // A later milestone load of the addressed run is itself authoritative.
        state.append("gap")
        await model.loadRunDetail("run-local")
        #expect(queries.values.last == "includeEarlierAssistantOutput=true")
        let task = try #require(model.task("run-local"))
        #expect(task.earlierAnswerText == nil)
        #expect(task.earlierAnswerNote
            == "Earlier assistant text could not be determined: the run's event record is incomplete.")
        #expect(task.answerText == "Accepted text.")
        #expect(task.primaryOutputPath == "final/answer.md")
    }

    @MainActor
    @Test func localLocationScopedLoadIsAnAddressedRead() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, _) = makeModel(runId: "run-local", local: true)
        let queries = RemoteRunDetailRecorder()
        RemoteRunDetailURLProtocol.handler = { request in
            queries.append(request.url?.query ?? "")
            let earlier = request.url?.query == "includeEarlierAssistantOutput=true"
                ? ###","earlierAssistantOutput":{"path":"final/earlier-assistant-output.md","text":"Initial swatch report.","bytes":22,"truncated":false}"### : ""
            let body = #"{"summary":{"runId":"run-local","state":"succeeded","mode":"ask","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Accepted text.","truncated":false\#(earlier)},"lastSeq":4}"#
            return (response(for: request), Data(body.utf8), 0)
        }
        await model.ensureRunDetail("run-local")
        #expect(await model.loadRunDetail("run-local", locationID: .local))
        #expect(queries.values == ["", "includeEarlierAssistantOutput=true"])
        #expect(model.task("run-local")?.earlierAnswerText == "Initial swatch report.")
        #expect(model.task("run-local")?.answerText == "Accepted text.")
    }

    /// A new draft, another thread and a connection boundary retire addressed
    /// runs with the hydration cache, so a later unrelated load is plain again.
    @MainActor
    @Test func addressedRunsRetireWithTheHydrationCache() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, _) = makeModel(runId: "run-local", local: true)
        let queries = RemoteRunDetailRecorder()
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-local" else {
                return (response(for: request, status: 404), Data("{}".utf8), 0)
            }
            queries.append(request.url?.query ?? "")
            let earlier = request.url?.query == "includeEarlierAssistantOutput=true"
                ? ###","earlierAssistantOutput":{"path":"final/earlier-assistant-output.md","text":"Initial swatch report.","bytes":22,"truncated":false}"### : ""
            let body = #"{"summary":{"runId":"run-local","state":"succeeded","mode":"ask","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Accepted text.","truncated":false\#(earlier)},"lastSeq":4}"#
            return (response(for: request), Data(body.utf8), 0)
        }
        let boundaries: [(String, @MainActor () async -> Void)] = [
            ("new draft", { model.startDraftThread() }),
            ("other thread", { await model.openThread(locationID: .local, id: "thread-other") }),
            ("connection", { model.retireRunDetailState(cancelInFlight: true) }),
        ]
        for (label, boundary) in boundaries {
            await model.ensureAddressedRunDetail("run-local", locationID: .local)
            #expect(queries.last == "includeEarlierAssistantOutput=true", "\(label)")
            #expect(model.addressedRunDetails["run-local"] == true, "\(label)")
            await boundary()
            #expect(model.addressedRunDetails.isEmpty, "\(label)")
            await model.loadRunDetail("run-local")
            #expect(queries.last == "", "\(label)")
            #expect(model.addressedRunDetails.isEmpty, "\(label)")
            // The plain read keeps the view it was shown beside the same answer.
            #expect(model.task("run-local")?.earlierAnswerText == "Initial swatch report.", "\(label)")
        }
    }

    @MainActor
    @Test func remoteAddressedEarlierTextSurvivesARunsListRefresh() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, locationID) = makeModel(runId: "run-remote")
        RemoteRunDetailURLProtocol.handler = { request in
            switch (request.url?.path, request.url?.query) {
            case ("/v2/runs", nil):
                let list = #"{"runs":[{"runId":"run-remote","state":"succeeded","mode":"ask","outputReadyState":"ready"}]}"#
                return (response(for: request), Data(list.utf8), 0)
            case ("/v2/runs/run-remote", "includeEarlierAssistantOutput=true"):
                let body = #"{"summary":{"runId":"run-remote","state":"succeeded","mode":"ask","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Accepted text.","truncated":false,"earlierAssistantOutputUnavailable":"publication_failed"},"lastSeq":5}"#
                return (response(for: request), Data(body.utf8), 0)
            default:
                throw RemoteRunDetailError.badRequest
            }
        }
        #expect(await model.loadRunDetail("run-remote", locationID: locationID))
        let note = "Earlier assistant text could not be determined: preparing it failed."
        #expect(model.task("run-remote", at: locationID)?.earlierAnswerNote == note)
        #expect(model.task("run-remote", at: locationID)?.earlierAnswerText == nil)
        await model.refreshRemoteRuns(locationID)
        #expect(model.task("run-remote", at: locationID)?.earlierAnswerNote == note)
        #expect(model.task("run-remote", at: locationID)?.answerText == "Accepted text.")
    }

    /// A bounded remote page (200 newer runs) keeps the open written detail, even
    /// one chosen from the full turn list, and the loaded history rows; never
    /// other turns, a closed detail, or another location's selection.
    @MainActor
    @Test func boundedRemotePageKeepsTheOpenDetailAndSelectedFamily() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 25) // loaded rows: runs 5-24; turn list: 0-24
        let (model, locationID) = makeModel(runId: "mock-run-0")
        model.remoteTasks[locationID]? += source.runs.filter { ["mock-run-1", "mock-run-5"].contains($0.id) }
        select(source, in: model, at: locationID, open: "mock-run-0")
        RemoteRunDetailURLProtocol.handler = familyFixture
        #expect(await model.loadRunDetail("mock-run-0", locationID: locationID))
        await model.refreshRemoteRuns(locationID)
        var kept = Set(model.remoteTasks[locationID]?.map(\.id) ?? [])
        #expect(kept.count == 202 && kept.isSuperset(of: ["mock-run-0", "mock-run-5", "run-new-199"]))
        #expect(model.task("mock-run-0", at: locationID)?.earlierAnswerText == "Initial swatch report.")
        model.route = .threads // closed detail: only the loaded rows stay
        await model.refreshRemoteRuns(locationID)
        kept = Set(model.remoteTasks[locationID]?.map(\.id) ?? [])
        #expect(kept.count == 201 && kept.contains("mock-run-5"))
        // The same ids selected at another location keep nothing here.
        select(source, in: model, at: .remote(UUID()), open: "mock-run-5")
        await model.refreshRemoteRuns(locationID)
        #expect(model.remoteTasks[locationID]?.count == 200)
    }

    /// After a list refresh evicted the row, re-opening the authorized local
    /// detail loads and inserts it; its markers no longer stand in for a row.
    @MainActor
    @Test func localReopenAfterEvictionLoadsTheAuthorizedSelection() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 25)
        let (model, _) = makeModel(runId: "run-unrelated", local: true)
        select(source, in: model, at: .local, open: "mock-run-0")
        let reads = RemoteRunDetailRecorder()
        RemoteRunDetailURLProtocol.handler = { request in
            if request.url?.path == "/v2/runs/mock-run-0" { reads.append(request.url?.query ?? "") }
            return try familyFixture(request)
        }
        let reopen = { await model.ensureAddressedRunDetail(
            "mock-run-0", locationID: .local, insertingIfMissing: model.task("mock-run-0") == nil) }
        await reopen()
        await model.refreshRuns() // the open detail survives a bounded page
        #expect(model.task("mock-run-0")?.earlierAnswerText == "Initial swatch report.")
        model.route = .threads
        await model.refreshRuns() // closed and off-page: evicted, markers remain
        #expect(model.task("mock-run-0") == nil && model.hydratedRunDetails.contains("mock-run-0"))
        model.route = .task("mock-run-0")
        await reopen()
        #expect(reads.values == Array(repeating: "includeEarlierAssistantOutput=true", count: 2))
        #expect(model.task("mock-run-0")?.earlierAnswerText == "Initial swatch report.")
        // Control: a selection that no longer names the run authorizes no insertion.
        model.route = .threads
        await model.refreshRuns()
        let other = try distinctHistorySource(thread: "thread-other", runPrefix: "other", count: 2)
        select(other, in: model, at: .local, open: "mock-run-0")
        await reopen()
        #expect(reads.values.count == 2 && model.task("mock-run-0") == nil)
    }

    @MainActor
    @Test func localReopenLoadsReportAfterHistoryRestoresOnlyTheChildSummary() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let source = try HistoryTestSource(count: 25) // parent run-0 is off the loaded page
        let child = "run-child"
        let (model, _) = makeModel(runId: child, local: true)
        select(source, in: model, at: .local, open: child)
        let history = try #require(model.selectedHistory)
        source.transform = { json in
            var turns = json["turns"] as! [[String: Any]]
            if let index = turns.firstIndex(where: { $0["runId"] as? String == "mock-run-0" }),
               var run = turns[index]["run"] as? [String: Any] {
                run["delegatedChildRunIds"] = [child]
                turns[index]["run"] = run
                json["turns"] = turns
            }
        }
        let reads = RemoteRunDetailRecorder()
        RemoteRunDetailURLProtocol.handler = { request in
            switch (request.url?.path, request.url?.query) {
            case ("/v2/runs/mock-run-0", nil):
                reads.append("parent")
                let body = #"{"summary":{"runId":"mock-run-0","state":"succeeded","mode":"agent"},"children":[{"runId":"run-child","state":"succeeded","mode":"ask","delegatedFromRunId":"mock-run-0"}],"lastSeq":6}"#
                return (response(for: request), Data(body.utf8), 0)
            case ("/v2/runs/run-child", let query):
                reads.append(query ?? "plain child")
                return try familyFixture(request)
            default:
                return try familyFixture(request)
            }
        }
        await model.ensureAddressedRunDetail(child, locationID: .local)
        try #require(model.task(child)?.earlierAnswerText == "Initial swatch report.")
        try #require(model.task(child)?.answerText == "Accepted text.")
        model.route = .threads
        await model.refreshRuns()
        try #require(model.task(child) == nil)

        let older = try source.page(.beforeTurnId(source.detail.turns[5].id))
        history.install([older], ids: older.turns.map(\.id) + history.rows.map(\.id), reset: false, serial: 0)
        await model.loadHistoryDelegates(history)
        let summary = try #require(model.task(child))
        try #require(model.workspaceRunIDs.contains(child) && summary.delegatedFromRunId == "mock-run-0")
        try #require(summary.earlierAnswerText == nil && summary.answerText == nil)
        try #require(reads.values == ["includeEarlierAssistantOutput=true", "parent"])

        model.route = .task(child)
        for _ in 0..<2 { await model.ensureAddressedRunDetail(child, locationID: .local) }
        #expect(reads.values == ["includeEarlierAssistantOutput=true", "parent", "includeEarlierAssistantOutput=true"])
        #expect(model.task(child)?.earlierAnswerText == "Initial swatch report.")
        #expect(model.task(child)?.answerText == "Accepted text.")
    }

    @MainActor
    @Test func remoteLegacyDetailUsesTheSharedBoundedArtifactFallback() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, locationID) = makeModel(runId: "run-legacy")
        let legacyAnswer = String(repeating: "é", count: 128_001)
        RemoteRunDetailURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v2/runs/run-legacy":
                let body = #"{"summary":{"runId":"run-legacy","state":"succeeded","mode":"ask"},"artifacts":[{"path":"final/answer.md","kind":"file","bytes":256002}],"lastSeq":3}"#
                return (response(for: request), Data(body.utf8), 0)
            case "/v2/runs/run-legacy/artifacts/final/answer.md":
                return (response(for: request), Data(legacyAnswer.utf8), 0)
            default:
                throw RemoteRunDetailError.badRequest
            }
        }

        #expect(await model.loadRunDetail("run-legacy", locationID: locationID))
        let answer = try #require(model.task("run-legacy", at: locationID)?.answerText)
        let preview = try #require(answer.components(
            separatedBy: "\n\n_Inline preview bounded").first)
        #expect(preview.utf8.count == 256_000)
        #expect(!answer.contains("�"))
        #expect(answer.contains("open final/answer.md for the full artifact"))
    }

    @MainActor
    @Test func newerRemoteDetailWinsWhenResponsesCompleteInReverseOrder() async {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let calls = RemoteRunDetailCounter()
        let (model, locationID) = makeModel(runId: "run-race")
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-race" else {
                throw RemoteRunDetailError.badRequest
            }
            let call = calls.incrementAndGet()
            let answer = call == 1 ? "stale answer" : "fresh answer"
            let sequence = call == 1 ? 1 : 2
            let body = #"{"summary":{"runId":"run-race","state":"succeeded","mode":"agent"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"\#(answer)","truncated":false},"lastSeq":\#(sequence)}"#
            return (response(for: request), Data(body.utf8), call == 1 ? 0.15 : 0)
        }

        let first = Task { await model.loadRunDetail("run-race", locationID: locationID) }
        while calls.value < 1 { await Task.yield() }
        let second = Task { await model.loadRunDetail("run-race", locationID: locationID) }
        _ = await (first.value, second.value)

        #expect(calls.value == 2)
        #expect(model.task("run-race", at: locationID)?.answerText == "fresh answer")
    }

    @MainActor
    @Test func retainedReportKeepsCauseAndArtifactAcrossRemoteHydrationAndListRefresh() async throws {
        defer { RemoteRunDetailURLProtocol.handler = nil }
        let (model, locationID) = makeModel(runId: "run-retained")
        RemoteRunDetailURLProtocol.handler = { request in
            guard request.url?.path == "/v2/runs/run-retained" else {
                throw RemoteRunDetailError.badRequest
            }
            let body = ##"{"summary":{"runId":"run-retained","state":"failed","mode":"agent","outputReadyState":"diagnostic","error":"Native stream closed"},"primaryOutput":{"kind":"report","path":"final/retained-output.md","text":"# Useful partial review","truncated":true},"outcomeBanner":"Failed","artifacts":[{"path":"attempts/a01/produced/images","kind":"directory"},{"path":"attempts/a01/produced/images/result.png","kind":"file"}],"lastSeq":8}"##
            return (response(for: request), Data(body.utf8), 0)
        }
        #expect(await model.loadRunDetail("run-retained", locationID: locationID))
        let task = try #require(model.task("run-retained", at: locationID))
        #expect(task.answerText == "# Useful partial review")
        #expect(task.hasRetainedOutput)
        #expect(task.primaryOutputPath == "final/retained-output.md")
        #expect(task.primaryOutputTruncated)
        #expect(task.capturedArtifactPaths == ["attempts/a01/produced/images/result.png"])
        #expect(task.engineError == "Native stream closed")
        let summary = try JSONDecoder().decode(RunSummary.self, from: Data(
            #"{"runId":"run-retained","state":"failed","mode":"agent","outputReadyState":"diagnostic"}"#.utf8))
        let refreshed = AppModel.mergeRefreshedTask(summary: summary, existing: task)
        #expect(refreshed.hasRetainedOutput)
        #expect(refreshed.primaryOutputPath == task.primaryOutputPath)
        #expect(refreshed.primaryOutputTruncated)
        #expect(refreshed.capturedArtifactPaths == task.capturedArtifactPaths)
    }

    @MainActor
    private func makeModel(runId: String, local: Bool = false) -> (AppModel, ExecutionLocationID) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RemoteRunDetailURLProtocol.self]
        let client = GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:43123")!, token: "test",
            session: URLSession(configuration: config))
        let locationID: ExecutionLocationID = local ? .local : .remote(UUID())
        let model = AppModel(client: local ? client : nil, requestNotificationAuthorization: false)
        model.selectedExecutionLocation = locationID
        model.draftExecutionLocation = locationID
        if !local { model.remoteClients[locationID] = client }
        let row = TaskRun(
            id: runId, title: runId, prompt: "", mode: .agent, phase: .succeeded,
            project: "Remote", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now,
            spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        if local { model.liveTasks = [row] } else { model.remoteTasks[locationID] = [row] }
        return (model, locationID)
    }
}

private final class RemoteRunDetailRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    var values: [String] { lock.withLock { items } }
    var last: String? { lock.withLock { items.last } }
    func append(_ value: String) { lock.withLock { items.append(value) } }
}

/// A light, white-backed offscreen host for the real view; never put in a window.
@MainActor
private func offscreen(_ content: some View) -> NSView {
    let host = NSHostingView(rootView: content.frame(width: 580).padding(16).background(Color.white))
    host.appearance = NSAppearance(named: .aqua)
    host.frame.size = host.fittingSize
    host.layoutSubtreeIfNeeded()
    return host
}

/// The native prose documents the host created, top first.
@MainActor
private func renderedProse(_ host: NSView) -> [(text: NSAttributedString, top: CGFloat)] {
    var found: [(text: NSAttributedString, top: CGFloat)] = []
    func walk(_ view: NSView) {
        if let prose = view as? ProseTextView, let storage = prose.textStorage {
            let frame = prose.convert(prose.bounds, to: host)
            found.append((NSAttributedString(attributedString: storage),
                          host.isFlipped ? frame.minY : host.bounds.height - frame.maxY))
        }
        view.subviews.forEach(walk)
    }
    walk(host)
    return found.sorted { $0.top < $1.top }
}

/// Whether `needle` sits in a fenced code block of the rendered document; nil if absent.
private func insideCodeBlock(_ text: NSAttributedString, _ needle: String) -> Bool? {
    let range = (text.string as NSString).range(of: needle)
    guard range.location != NSNotFound else { return nil }
    let style = text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle
    return style?.textBlocks.contains { $0 is ProseCodeBlock } == true
}

/// Select `source`'s thread at `location`: loaded history rows, the full turn
/// list the workspace panel shows, and an open detail route.
@MainActor
private func select(_ source: HistoryTestSource, in model: AppModel, at location: ExecutionLocationID, open id: String) {
    model.selectedExecutionLocation = location
    model.selectedThreadId = source.detail.thread.id
    model.selectedHistory = try? source.store(location: location, loaded: true)
    model.workspaceHistoryVisible = true
    model.selectedThreadDetail = source.detail
    model.route = .task(id)
}

/// A bounded runs page of 200 newer runs and an addressed detail for any run.
private func familyFixture(_ request: URLRequest) throws -> (HTTPURLResponse, Data, TimeInterval) {
    let path = request.url?.path ?? ""
    if path == "/v2/runs", request.url?.query == nil {
        let rows = (0..<200).map { #"{"runId":"run-new-\#($0)","state":"succeeded","mode":"ask"}"# }
        return (response(for: request), Data(#"{"runs":[\#(rows.joined(separator: ","))]}"#.utf8), 0)
    }
    guard path.hasPrefix("/v2/runs/"), request.url?.query == "includeEarlierAssistantOutput=true" else {
        throw RemoteRunDetailError.badRequest
    }
    let id = String(path.dropFirst("/v2/runs/".count))
    let body = ###"{"summary":{"runId":"\###(id)","state":"succeeded","mode":"ask","outputReadyState":"ready"},"primaryOutput":{"kind":"answer","path":"final/answer.md","text":"Accepted text.","truncated":false,"earlierAssistantOutput":{"path":"final/earlier-assistant-output.md","text":"Initial swatch report.","bytes":22,"truncated":false}},"lastSeq":6}"###
    return (response(for: request), Data(body.utf8), 0)
}

private enum RemoteRunDetailError: Error { case badRequest }

private final class RemoteRunDetailCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.withLock { count } }
    func incrementAndGet() -> Int { lock.withLock { count += 1; return count } }
}

private func response(for request: URLRequest, status: Int = 200) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
}

private final class RemoteRunDetailURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler:
        ((URLRequest) throws -> (HTTPURLResponse, Data, TimeInterval))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw RemoteRunDetailError.badRequest }
            let (response, data, delay) = try handler(request)
            let deliver = { [weak self] in
                guard let self else { return }
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            }
            if delay > 0 {
                DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: deliver)
            } else {
                deliver()
            }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
