import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// The sidebar trash lifecycle (owner decision E1): "Delete" moves a thread to
/// Trash with one click, "Restore" brings it back, and "Delete Now…" purges it
/// after a confirmation. Each command is ONE server call plus a list re-read.
@Suite(.serialized)
struct ThreadLifecycleTests {
    // MARK: Section membership

    @Test func sectionsSplitActiveArchivedAndTrashAndNeverShowPurged() throws {
        let states = ["active", "closed", "trashed", "purged", "active"]
        let rows = try states.enumerated().map { index, state in
            LocatedThread(
                locationID: .local, thread: try lifecycleThread(id: "th-\(index)", state: state))
        }
        let sections = ThreadSidebarSections(rows)
        #expect(sections.active.map(\.thread.id) == ["th-0", "th-4"])
        #expect(sections.archived.map(\.thread.id) == ["th-1"])
        #expect(sections.trash.map(\.thread.id) == ["th-2"])
    }

    @Test func aThreadWithoutALifecycleStateStaysActive() throws {
        let legacy = try JSONDecoder().decode(ThreadSummary.self, from: Data(
            lifecycleJSON(id: "th-legacy", state: "active")
                .replacingOccurrences(of: #""state":"active""#, with: #""state":null"#).utf8))
        let sections = ThreadSidebarSections([LocatedThread(locationID: .local, thread: legacy)])
        #expect(sections.active.map(\.thread.id) == ["th-legacy"])
        #expect(sections.archived.isEmpty && sections.trash.isEmpty)
    }

    @Test func foldersGroupOnlyActiveThreadsAndEveryThreadIsListedOnce() throws {
        // The sidebar composes the folder view (ThreadsScreen+Folders) over the
        // active partition; an archived or trashed thread keeps its folder
        // label but is listed only in its own section.
        let specs: [(id: String, state: String, folder: String?)] = [
            ("live", "active", "A"), ("loose", "active", nil), ("shelved", "closed", "A"),
            ("binned", "trashed", "A"), ("parked", "closed", "B"),
        ]
        let rows = try specs.map { spec in
            LocatedThread(locationID: .local, thread: try lifecycleThread(
                id: spec.id, state: spec.state, folder: spec.folder))
        }
        let sections = ThreadSidebarSections(rows)
        let folders = ThreadFolderSection.sections(for: sections.active)
        #expect(folders.map(\.folder) == ["A", nil])
        #expect(folders.map { $0.threads.map(\.thread.id) } == [["live"], ["loose"]])
        let listed = folders.flatMap(\.threads) + sections.archived + sections.trash
        #expect(listed.map(\.thread.id).sorted() == rows.map(\.thread.id).sorted())
        #expect(sections.archived.map(\.thread.folder) == ["A", "B"])
        #expect(sections.trash.map(\.thread.folder) == ["A"])
        // A folder carried only by archived or trashed threads makes no
        // section: the active part stays the plain list.
        #expect(ThreadFolderSection.sections(for: ThreadSidebarSections([rows[1], rows[4]]).active).isEmpty)
    }

    // MARK: Honest "Delete Now…" text

    @Test func deleteNowTextBranchesOnWorkspaceModeAndNeverPromisesErasure() {
        let direct = ThreadLifecycleCopy.deleteNowMessage(workspaceMode: "in_place")
        let isolated = ThreadLifecycleCopy.deleteNowMessage(workspaceMode: "isolated")
        for text in [direct, isolated] {
            #expect(text.hasPrefix("Project files are not touched."))
            // Codex config-dir logins and Antigravity keep sessions in the
            // account's own directory, which purge never deletes.
            #expect(text.contains("Saved sessions may remain in the agents' own storage."))
            #expect(!text.contains("sessions of this thread's Ask and Plan turns are deleted"))
            #expect(text.contains("Its messages stay in the local engine journal"))
            #expect(text.hasSuffix("This cannot be undone."))
            #expect(!text.contains("removes the conversation"))
        }
        #expect(!direct.contains("working copy"))
        #expect(isolated.contains(
            "The thread's separate working copy is deleted, including changes that were never applied to the project."))
        // No mode on the wire (a legacy row) makes no working-copy claim.
        #expect(ThreadLifecycleCopy.deleteNowMessage(workspaceMode: nil) == direct)
    }

    @Test func aFailedDeleteNowPromisesTrashOnlyWhileTheListStillHasItThere() {
        let reason = "Cannot reach the engine — is the daemon running?"
        let gaps = ThreadListGaps(skippedProjects: 1, unreadableThreads: 2)
        let outcomes: [DeleteNowFailure] = [.inTrash, .gone, .elsewhere, .unconfirmed(nil), .unconfirmed(gaps)]
        for outcome in outcomes {
            let text = ThreadLifecycleCopy.deleteNowFailure(outcome, reason: reason)
            #expect(text.hasSuffix(reason))
            #expect(text.contains("stays in Trash") == (outcome == .inTrash))
            // Only a complete list without the thread says it was deleted.
            #expect(text.hasPrefix("The thread was deleted") == (outcome == .gone))
        }
        #expect(ThreadLifecycleCopy.deleteNowFailure(.unconfirmed(gaps), reason: reason).contains(
            "(the engine skipped 1 project and this app could not read 2 threads)"))
    }

    @Test func onlyAListWithoutGapsConfirmsAPurgeByLeavingTheThreadOut() throws {
        let trashed = try lifecycleThread(id: "th-1", state: "trashed")
        let active = try lifecycleThread(id: "th-1", state: "active")
        let skipped = ThreadListGaps(skippedProjects: 1)
        let unreadable = ThreadListGaps(unreadableThreads: 1)
        #expect(DeleteNowFailure(listed: nil, gaps: ThreadListGaps()) == .gone)
        #expect(DeleteNowFailure(listed: nil, gaps: skipped) == .unconfirmed(skipped))
        #expect(DeleteNowFailure(listed: nil, gaps: unreadable) == .unconfirmed(unreadable))
        // A listed thread is where the list shows it, gaps or not.
        #expect(DeleteNowFailure(listed: trashed, gaps: skipped) == .inTrash)
        #expect(DeleteNowFailure(listed: active, gaps: ThreadListGaps()) == .elsewhere)
        // Absence from a list with gaps retires no banner; absence from a complete one does.
        for banner in [DeleteNowFailure.inTrash, .elsewhere, .unconfirmed(nil), .unconfirmed(skipped)] {
            #expect(banner.stillHolds(once: .unconfirmed(skipped)))
            #expect(!banner.stillHolds(once: .gone))
        }
        // A thread back outside Trash retires what points to Trash, and only that.
        #expect(!DeleteNowFailure.inTrash.stillHolds(once: .elsewhere))
        #expect(!DeleteNowFailure.unconfirmed(nil).stillHolds(once: .elsewhere))
        #expect(!DeleteNowFailure.unconfirmed(skipped).stillHolds(once: .elsewhere))
        #expect(DeleteNowFailure.elsewhere.stillHolds(once: .elsewhere))
        #expect(DeleteNowFailure.inTrash.stillHolds(once: .inTrash))
        #expect(DeleteNowFailure.unconfirmed(nil).stillHolds(once: .inTrash))
    }

    @Test func trashCaptionStatesHowLongRestoreWorks() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        #expect(ThreadLifecycleCopy.trashCaption(
            place: "repo", purgeAfter: "2030-01-15T12:00:00.000Z", now: now)
            .hasPrefix("repo · restorable until "))
        #expect(ThreadLifecycleCopy.trashCaption(
            place: "repo", purgeAfter: "2020-01-15T12:00:00Z", now: now)
            .hasPrefix("repo · restore period ended "))
        #expect(ThreadLifecycleCopy.trashCaption(place: "repo", purgeAfter: nil, now: now)
            == "repo · in Trash")
        // Restore is offered exactly while the caption says it works; with no
        // readable deadline the app claims nothing and the engine decides.
        #expect(!ThreadLifecycleCopy.restorePeriodEnded(
            purgeAfter: "2030-01-15T12:00:00.000Z", now: now))
        #expect(ThreadLifecycleCopy.restorePeriodEnded(purgeAfter: "2020-01-15T12:00:00Z", now: now))
        #expect(!ThreadLifecycleCopy.restorePeriodEnded(purgeAfter: nil, now: now))
    }

    // MARK: Commands

    @MainActor
    @Test func deleteMovesTheThreadToTrashAndLeavesItsConversation() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "active"])
        let model = lifecycleModel(server)
        let thread = try lifecycleThread(id: "th-1", state: "active")
        model.threads = [thread]
        model.selectedThreadId = "th-1"
        model.selectedThreadDetail = ThreadDetailResponse(thread: thread, sessions: [], turns: [])

        await model.trashThread(locationID: .local, id: "th-1")

        #expect(server.posts == ["POST /v2/threads/th-1/trash"])
        #expect(server.recorded.contains("GET /v2/threads"))
        // A trashed thread takes no turns: the conversation pane becomes a draft.
        #expect(model.selectedThreadId == nil)
        let sections = ThreadSidebarSections(model.locatedThreads)
        #expect(sections.active.isEmpty)
        #expect(sections.trash.map(\.thread.id) == ["th-1"])
    }

    @MainActor
    @Test func deleteAndDeleteNowWaitWhileATurnRunsThenReachTheEngine() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "active", "th-2": "trashed"])
        let model = lifecycleModel(server)
        model.threads = [
            try lifecycleThread(id: "th-1", state: "active", headRunId: "run-1"),
            try lifecycleThread(id: "th-2", state: "trashed", headRunId: "run-2"),
        ]
        model.liveTasks = [runningTask("run-1"), runningTask("run-2")]

        await model.trashThread(locationID: .local, id: "th-1")
        #expect(model.threadStatus == ThreadLifecycleCopy.deleteBusyReason)
        // The disabled menu item names the reason in its title, not only in a tooltip.
        #expect(ThreadLifecycleCopy.deleteMenuTitle(busy: true) == "Delete (a turn is running)")
        #expect(ThreadLifecycleCopy.deleteMenuTitle(busy: false) == "Delete")
        await model.deleteThreadNow(locationID: .local, id: "th-2")
        #expect(model.threadStatus == ThreadLifecycleCopy.deleteNowBusyReason)
        #expect(server.recorded.isEmpty)

        // Once the turns finished, the same commands reach the engine.
        model.liveTasks = []
        await model.deleteThreadNow(locationID: .local, id: "th-2")
        await model.trashThread(locationID: .local, id: "th-1")
        #expect(server.posts == ["POST /v2/threads/th-2/purge", "POST /v2/threads/th-1/trash"])
    }

    @MainActor
    @Test func deleteNowPurgesOnlyThatThreadAndItLeavesTheList() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "trashed", "th-2": "active"])
        let model = lifecycleModel(server)
        model.threads = [
            try lifecycleThread(id: "th-1", state: "trashed"),
            try lifecycleThread(id: "th-2", state: "active"),
        ]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        #expect(server.posts == ["POST /v2/threads/th-1/purge"])
        #expect(model.threads.map(\.id) == ["th-2"])
        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func aRefusedDeleteNowLeavesTheThreadInTrashAndRestoreBringsItBack() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .refuse)
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        // No hidden trash: the engine's refusal is shown and the row stays in Trash.
        #expect(model.threadStatus?.contains("stays in Trash") == true)
        #expect(model.threadStatus?.contains("thread_busy") == true)
        #expect(ThreadSidebarSections(model.locatedThreads).trash.map(\.thread.id) == ["th-1"])

        await model.restoreThread(locationID: .local, id: "th-1")

        #expect(server.posts == ["POST /v2/threads/th-1/purge", "POST /v2/threads/th-1/restore"])
        #expect(ThreadSidebarSections(model.locatedThreads).active.map(\.thread.id) == ["th-1"])
        // The refused purge's banner does not outlive the successful Restore.
        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func aLostPurgeAnswerSaysTheThreadWasDeletedAndPromisesNoTrash() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        // The engine journals the purge, then its answer is lost on the way back.
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .applyThenDropAnswer)
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        #expect(server.posts == ["POST /v2/threads/th-1/purge"])
        #expect(server.recorded.last == "GET /v2/threads")
        #expect(ThreadSidebarSections(model.locatedThreads).trash.isEmpty)
        let status = try #require(model.threadStatus)
        #expect(status.hasPrefix("The thread was deleted"))
        #expect(!status.contains("Trash"))
    }

    @MainActor
    @Test func anUnreadableListAfterAFailedPurgeConfirmsNothingUntilALaterListShowsTheThreadGone() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        // The purge request never reaches the engine, and the list cannot be read either.
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .dropBeforeApply)
        server.listUnreachable = true
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        let unconfirmed = try #require(model.threadStatus)
        #expect(unconfirmed.hasPrefix("Could not confirm whether the thread was deleted"))
        #expect(!unconfirmed.contains("stays in Trash"))
        // A later list that still has the thread in Trash keeps the banner...
        server.listUnreachable = false
        #expect(await model.refreshThreads())
        #expect(ThreadSidebarSections(model.locatedThreads).trash.map(\.thread.id) == ["th-1"])
        #expect(model.threadStatus == unconfirmed)
        // ...and a later list without the thread retires it.
        server.setState("th-1", "purged")
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == nil)
    }

    // MARK: A list that is incomplete confirms no deletion

    @MainActor
    @Test func aThreadMissingFromAListThatSkippedItsProjectIsNotCalledDeleted() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        // The purge never reaches the engine; the re-read succeeds but skips the
        // thread's project (its folder is missing), so the row is not in it.
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .dropBeforeApply)
        server.skippedRoot = lifecycleRoot
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        let unconfirmed = try #require(model.threadStatus)
        #expect(unconfirmed.hasPrefix("Could not confirm whether the thread was deleted"))
        #expect(unconfirmed.contains("the engine skipped 1 project"))
        // The project comes back with the thread still in Trash: the banner holds...
        server.skippedRoot = nil
        #expect(await model.refreshThreads())
        #expect(ThreadSidebarSections(model.locatedThreads).trash.map(\.thread.id) == ["th-1"])
        #expect(model.threadStatus == unconfirmed)
        // ...until a complete list no longer has the thread.
        server.setState("th-1", "purged")
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func aRefusedDeleteNowWhoseRowThisAppCannotReadIsNotCalledDeleted() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        // The engine refuses (409), and the re-read carries the thread's row in a
        // shape this app version cannot decode, so the row is dropped.
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .refuse)
        server.unreadable = ["th-1"]
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        let unconfirmed = try #require(model.threadStatus)
        #expect(unconfirmed.hasPrefix("Could not confirm whether the thread was deleted"))
        #expect(unconfirmed.contains("this app could not read 1 thread"))
        #expect(unconfirmed.contains("thread_busy"))
        // While the row stays unreadable, nothing is confirmed either way.
        #expect(await model.refreshThreads())
        #expect(!(model.threadStatus ?? "").hasPrefix("The thread was deleted"))
    }

    @MainActor
    @Test func aRemoteListThatSkippedAProjectOrARowConfirmsNoDeletionButACompleteOneDoes() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        for gap in ["project", "row", "none"] {
            let server = LifecycleServer(
                states: ["th-1": "trashed"],
                purge: gap == "none" ? .applyThenDropAnswer : .dropBeforeApply)
            if gap == "project" { server.skippedRoot = lifecycleRoot }
            if gap == "row" { server.unreadable = ["th-1"] }
            let (model, remote) = remoteLifecycleModel(
                server, threads: [try lifecycleThread(id: "th-1", state: "trashed")])

            await model.deleteThreadNow(locationID: remote, id: "th-1")

            #expect(server.posts == ["POST /v2/threads/th-1/purge"])
            let status = try #require(model.threadStatus)
            switch gap {
            case "project": #expect(status.contains("the engine skipped 1 project"))
            case "row": #expect(status.contains("this app could not read 1 thread"))
            default: #expect(status.hasPrefix("The thread was deleted"))
            }
            if gap != "none" {
                #expect(status.hasPrefix("Could not confirm whether the thread was deleted"))
                // A complete remote list without the thread retires the banner.
                server.skippedRoot = nil
                server.unreadable = []
                server.setState("th-1", "purged")
                #expect(await model.refreshRemoteThreads(remote))
                #expect(model.threadStatus == nil)
            }
        }
    }

    // MARK: The banner follows the thread's confirmed state

    @MainActor
    @Test func aStaysInTrashBannerHoldsWhileTrashedAndLeavesWhenAnotherClientRestores() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .refuse)
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        let banner = try #require(model.threadStatus)
        #expect(banner.contains("stays in Trash"))
        // Still listed in Trash: the banner holds.
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == banner)
        // Another client restores it: the next list retires the Trash promise.
        server.setState("th-1", "active")
        #expect(await model.refreshThreads())
        #expect(ThreadSidebarSections(model.locatedThreads).active.map(\.thread.id) == ["th-1"])
        #expect(model.threadStatus == nil)
    }

    // MARK: A failed list read does not outlive the next successful one

    @MainActor
    @Test func aFailedRereadIsRetiredByTheNextSuccessfulListAndTheBannerComesBack() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .refuse)
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]
        await model.deleteThreadNow(locationID: .local, id: "th-1")
        let banner = try #require(model.threadStatus)
        #expect(banner.contains("stays in Trash"))

        // A background re-read fails and takes the status line...
        server.listUnreachable = true
        #expect(await model.refreshThreads() == false)
        #expect(model.threadStatus?.hasPrefix("Could not refresh threads: ") == true)
        // ...the retry succeeds with the thread still in Trash: the banner is back.
        server.listUnreachable = false
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == banner)
        // Fails again, then succeeds without the thread: nothing stale is left.
        server.listUnreachable = true
        #expect(await model.refreshThreads() == false)
        server.listUnreachable = false
        server.setState("th-1", "purged")
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func aFailedRefreshWithNothingElsePendingIsShownUntilAListSucceeds() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "active"])
        server.listUnreachable = true
        let model = lifecycleModel(server)

        #expect(await model.refreshThreads() == false)
        #expect(model.threadStatus?.hasPrefix("Could not refresh threads: ") == true)
        server.listUnreachable = false
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func aLocalRefreshFailureThatReplacedARemoteBannerGivesItBackOnTheNextLocalList() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        // One status line serves every engine: a failed local read replaces
        // a remote engine's Delete Now banner until the local list comes back.
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .refuse)
        let (model, remote) = remoteLifecycleModel(
            server, threads: [try lifecycleThread(id: "th-1", state: "trashed")])
        await model.deleteThreadNow(locationID: remote, id: "th-1")
        let banner = try #require(model.threadStatus)
        #expect(banner.contains("stays in Trash"))

        server.listUnreachable = true
        #expect(await model.refreshThreads() == false)
        #expect(model.threadStatus?.hasPrefix("Could not refresh threads: ") == true)
        server.listUnreachable = false
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == banner)
    }

    @MainActor
    @Test func aBannerThatALaterOperationClearedDoesNotComeBackAfterAFailedReread() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "trashed", "th-2": "active"], purge: .refuse)
        let model = lifecycleModel(server)
        model.threads = [
            try lifecycleThread(id: "th-1", state: "trashed"),
            try lifecycleThread(id: "th-2", state: "active"),
        ]
        await model.deleteThreadNow(locationID: .local, id: "th-1")
        #expect(model.threadStatus?.contains("stays in Trash") == true)

        // The owner's next operation succeeds and clears the status line...
        await model.setThreadFolder(locationID: .local, id: "th-2", folder: "Work")
        #expect(model.threadStatus == nil)
        // ...so a failed re-read followed by a good one shows no stale banner,
        // although the thread is still in Trash.
        server.listUnreachable = true
        #expect(await model.refreshThreads() == false)
        #expect(model.threadStatus?.hasPrefix("Could not refresh threads: ") == true)
        server.listUnreachable = false
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == nil)
    }
}

// MARK: - Fixtures

/// The project every fixture thread belongs to.
private let lifecycleRoot = "/tmp/project"

private func lifecycleJSON(
    id: String,
    state: String,
    workspaceMode: String = "in_place",
    headRunId: String? = nil,
    folder: String? = nil
) -> String {
    let head = headRunId.map { "\"\($0)\"" } ?? "null"
    let folderJSON = folder.map { "\"\($0)\"" } ?? "null"
    let purgeAfter = state == "trashed" ? "\"2030-01-01T00:00:00.000Z\"" : "null"
    return #"{"id":"\#(id)","title":"Thread \#(id)","folder":\#(folderJSON),"repoRoot":"\#(lifecycleRoot)","mode":"agent","workspaceMode":"\#(workspaceMode)","authPreference":"auto","primaryHarness":null,"eligibleHarnesses":[],"state":"\#(state)","trashedAt":null,"purgeAfter":\#(purgeAfter),"runIds":[],"headRunId":\#(head),"needsHuman":false,"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z"}"#
}

private func lifecycleThread(
    id: String,
    state: String,
    headRunId: String? = nil,
    folder: String? = nil
) throws -> ThreadSummary {
    try JSONDecoder().decode(
        ThreadSummary.self,
        from: Data(lifecycleJSON(id: id, state: state, headRunId: headRunId, folder: folder).utf8))
}

private func runningTask(_ id: String) -> TaskRun {
    TaskRun(
        id: id, title: "Run", prompt: "", mode: .agent, phase: .running,
        project: "Project", harnesses: [], n: 1,
        createdAt: .now, updatedAt: .now,
        spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
        routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
        candidates: [], findings: [], diff: []
    )
}

@MainActor
private func lifecycleModel(_ server: LifecycleServer) -> AppModel {
    LifecycleStubURLProtocol.handler = { server.handle($0) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [LifecycleStubURLProtocol.self]
    let client = GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
        session: URLSession(configuration: config))
    let model = AppModel(client: client, requestNotificationAuthorization: false)
    model.health = .connected
    return model
}

/// A model whose remote engine is the stub: `threads` are its cached rows.
@MainActor
private func remoteLifecycleModel(
    _ server: LifecycleServer,
    threads: [ThreadSummary]
) -> (AppModel, ExecutionLocationID) {
    let model = lifecycleModel(server)
    let connection = RemoteConnection(id: UUID(), sshAlias: "lifecycle-host")
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [LifecycleStubURLProtocol.self]
    model.remoteConnections = [connection]
    model.remoteClients[connection.locationID] = GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:1235")!, token: "remote",
        session: URLSession(configuration: config))
    model.remoteThreadCache = threads.map {
        RemoteThreadCacheEntry(locationID: connection.locationID, thread: $0, syncedAt: .now)
    }
    return (model, connection.locationID)
}

/// How the tiny engine answers a purge request.
private enum PurgeBehavior {
    case apply                // 200 with the purged thread
    case refuse               // 409 thread_busy; nothing changes
    case applyThenDropAnswer  // the engine purges, but its answer never arrives
    case dropBeforeApply      // the request never reaches the engine
}

/// A tiny in-memory engine for the lifecycle routes and the thread list.
/// `handle` returns nil when the connection drops instead of answering.
private final class LifecycleServer: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [String: String]
    private var calls: [String] = []
    private let purge: PurgeBehavior
    private var listDown = false
    private var skipped: String?
    private var garbled: Set<String> = []

    init(states: [String: String], purge: PurgeBehavior = .apply) {
        self.states = states
        self.purge = purge
    }

    var recorded: [String] { lock.withLock { calls } }
    var posts: [String] { recorded.filter { $0.hasPrefix("POST ") } }
    /// While true, `GET /v2/threads` drops the connection.
    var listUnreachable: Bool {
        get { lock.withLock { listDown } }
        set { lock.withLock { listDown = newValue } }
    }

    /// While set, the list skips this project root and reports it in
    /// `problems`, as the engine does for a project whose folder is missing.
    var skippedRoot: String? {
        get { lock.withLock { skipped } }
        set { lock.withLock { skipped = newValue } }
    }
    /// Threads whose list rows come in a shape the app cannot decode.
    var unreadable: Set<String> {
        get { lock.withLock { garbled } }
        set { lock.withLock { garbled = newValue } }
    }

    /// Another client (or the engine itself) changes a thread's state.
    func setState(_ id: String, _ state: String) { lock.withLock { states[id] = state } }

    func handle(_ request: URLRequest) -> (HTTPURLResponse, Data)? {
        lock.withLock {
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            calls.append("\(method) \(path)")
            if method == "GET", path == "/v2/threads" {
                if listDown { return nil }
                // Every fixture thread lives in `lifecycleRoot`.
                let listed = skipped == lifecycleRoot ? [] : states.keys.sorted()
                let rows = listed
                    .filter { states[$0] != "purged" }
                    .map { garbled.contains($0)
                        ? #"{"id":"\#($0)","state":7}"#
                        : lifecycleJSON(id: $0, state: states[$0] ?? "active") }
                let problems = skipped.map {
                    #"[{"projectId":"p-1","root":"\#($0)","code":"project_root_missing","message":"project root no longer exists: \#($0)"}]"#
                } ?? "[]"
                return reply(request, 200, #"{"threads":[\#(rows.joined(separator: ","))],"problems":\#(problems)}"#)
            }
            let parts = path.split(separator: "/").map(String.init)
            if method == "PATCH", parts.count == 3, parts[1] == "threads" {
                // A folder move: the engine answers with the re-filed thread.
                return reply(request, 200, lifecycleJSON(
                    id: parts[2], state: states[parts[2]] ?? "active", folder: "Work"))
            }
            guard method == "POST", parts.count == 4, parts[1] == "threads" else {
                return reply(request, 404, #"{"error":"not found"}"#)
            }
            let id = parts[2]
            switch parts[3] {
            case "trash": states[id] = "trashed"
            case "restore": states[id] = "active"
            case "purge":
                switch purge {
                case .refuse:
                    return reply(request, 409, #"{"code":"thread_busy","message":"thread \#(id) has an active turn (running)","retryable":false}"#)
                case .dropBeforeApply: return nil
                case .applyThenDropAnswer:
                    states[id] = "purged"
                    return nil
                case .apply: states[id] = "purged"
                }
            default: return reply(request, 404, #"{"error":"not found"}"#)
            }
            return reply(request, 200, lifecycleJSON(id: id, state: states[id] ?? "active"))
        }
    }

    private func reply(_ request: URLRequest, _ status: Int, _ body: String) -> (HTTPURLResponse, Data) {
        (
            HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"])!,
            Data(body.utf8)
        )
    }
}

private final class LifecycleStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (HTTPURLResponse, Data)?)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        guard let answer = handler(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        let (response, data) = answer
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
