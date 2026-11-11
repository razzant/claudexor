import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite struct ProjectCheckoutPresentationTests {
    private static let draftAction = "Project for the new thread — pick a recent project or Browse…"
    private static let boundAction = "Project for this thread (bound). Pick another to start a new thread there."

    private func context(_ path: String, thread: String? = nil, remote: Bool = false) -> ComposerSelectionContext {
        .init(locationID: remote ? "ssh:11111111-1111-4111-8111-111111111111" : ExecutionLocationID.local.rawValue,
              threadID: thread, repoRoot: path)
    }

    @Test func verifiedGitCheckoutTopologyIsHoverAndAccessibilityTextForTheSelectedPath() {
        let selected = context("/work/main checkout/source")
        let primary = ProjectCheckoutPresentation(context: selected, observedContext: selected, status: .primaryCheckout)
        #expect(primary.help == "In a primary Git checkout\n/work/main checkout/source")
        #expect(primary.chipHelp == "In a primary Git checkout\n/work/main checkout/source\n\n" + Self.draftAction)
        #expect(primary.accessibilityValue == "source\nIn a primary Git checkout\n/work/main checkout/source")

        let linked = context("/work/review checkout/source")
        let worktree = ProjectCheckoutPresentation(
            context: linked, observedContext: linked, status: .linkedWorktree("review checkout"))
        #expect(worktree.help == "In the linked Git worktree “review checkout”\n/work/review checkout/source")
        #expect(worktree.accessibilityValue
            == "source\nIn the linked Git worktree “review checkout”\n/work/review checkout/source")
    }

    @Test func checkoutStatusNeverChangesTheVisibleName() {
        // Selected A: the chip shows a constant folder glyph plus this name, so topology must not reach it.
        let selected = context("/work/red/app", thread: "thread")
        let recent = ["/work/red/app", "/work/blue/app"]
        let statuses: [ProjectCheckoutStatus?] = [nil, .primaryCheckout, .linkedWorktree("app"), .ordinaryFolder, .unavailable]
        for status in statuses {
            let presentation = ProjectCheckoutPresentation(
                context: selected, observedContext: status == nil ? nil : selected, status: status, recent: recent)
            #expect(presentation.name == "app — red")
        }
    }

    @Test func checkoutLinesNameTheGitRoleNeverTheMainBranchOrAWorkingDirectory() {
        let selected = context("/work/app/source/nested")
        let statuses: [ProjectCheckoutStatus] = [.primaryCheckout, .linkedWorktree("app"), .ordinaryFolder, .unavailable]
        let help = statuses.map {
            ProjectCheckoutPresentation(context: selected, observedContext: selected, status: $0).chipHelp
        }
        // A nested selection is "in" its checkout; the line never claims it is the checkout root.
        #expect(help == [
            "In a primary Git checkout\n/work/app/source/nested\n\n" + Self.draftAction,
            "In the linked Git worktree “app”\n/work/app/source/nested\n\n" + Self.draftAction,
            "Not in a Git checkout\n/work/app/source/nested\n\n" + Self.draftAction,
            "Git checkout status unavailable\n/work/app/source/nested\n\n" + Self.draftAction,
        ])
        for text in help {
            #expect(!text.localizedCaseInsensitiveContains("main"))
            #expect(!text.localizedCaseInsensitiveContains("working directory"))
        }
    }

    @Test func initialLocalObservationShowsLoadingForOnlyTheSelectedPath() {
        let selected = context("/work/new folder")
        let presentation = ProjectCheckoutPresentation(context: selected, observedContext: nil, status: nil)
        #expect(presentation.name == "new folder")
        #expect(presentation.help == "Checking Git checkout…\n/work/new folder")
    }

    @Test func ordinaryFolderSaysItIsNotInAGitCheckout() {
        let selected = context("/work/design notes")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: selected, status: .ordinaryFolder)
        #expect(presentation.help == "Not in a Git checkout\n/work/design notes")
    }

    @Test func aNewSelectionCannotShowThePreviousFoldersStatusEvenBeforeItsTaskStarts() {
        let previous = context("/work/old checkout", thread: "old")
        let selected = context("/work/new folder", thread: "new")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: previous, status: .linkedWorktree("old checkout"))
        #expect(presentation.help == "Git checkout status unavailable\n/work/new folder")
        #expect(!presentation.chipHelp.contains("old checkout"))
        #expect(!presentation.accessibilityValue.contains("old checkout"))
    }

    @Test func selectedThreadIdentityFencesEvidenceEvenWhenThePathIsTheSame() {
        let previous = context("/work/app", thread: "old")
        let selected = context("/work/app", thread: "new")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: previous, status: .primaryCheckout)
        #expect(presentation.help == "Git checkout status unavailable\n/work/app")
        #expect(!presentation.chipHelp.contains("primary"))
    }

    @Test func unavailableSelectedThreadNeverShowsDraftOrPreviouslySelectedWorkspaceHelp() {
        let previous = context("/work/previous workspace", thread: "old")
        let unavailable = context("", thread: "missing")
        let presentation = ProjectCheckoutPresentation(
            context: unavailable, observedContext: previous, status: .linkedWorktree("previous workspace"), metadataKnown: false)
        #expect(presentation.name == "Project unavailable")
        #expect(presentation.help == "Project metadata unavailable")
        #expect(presentation.chipHelp == "Project metadata unavailable\n\n" + Self.boundAction)
        #expect(presentation.accessibilityValue == "Project unavailable\nProject metadata unavailable")
    }

    @Test(arguments: [false, true])
    func confirmedScopelessThreadKeepsNoProjectCopyInsteadOfUnavailable(remote: Bool) {
        let selected = context("", thread: "known-scopeless", remote: remote)
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: nil, status: nil, metadataKnown: true,
            connectionName: remote ? "builder" : nil)
        let expected = remote ? "builder · No project" : "No project"
        #expect(presentation.name == expected)
        #expect(presentation.chipHelp == Self.boundAction)
        #expect(presentation.accessibilityValue == expected)
    }

    @Test func knownSelectedProjectStillUsesDisambiguatedNameAndPathHelpInTheChip() {
        let selected = context("/work/red/app", thread: "known-project")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: selected, status: .primaryCheckout,
            metadataKnown: true, recent: ["/work/red/app", "/work/blue/app"])
        #expect(presentation.name == "app — red")
        #expect(presentation.chipHelp == "In a primary Git checkout\n/work/red/app\n\n" + Self.boundAction)
        #expect(presentation.accessibilityValue == "app — red\nIn a primary Git checkout\n/work/red/app")
    }

    @Test func unavailableProbeReplacesEarlierSuccessForTheSamePath() {
        let selected = context("/work/removed checkout")
        let presentation = ProjectCheckoutPresentation(
            context: selected, observedContext: selected, status: .unavailable)
        #expect(presentation.help == "Git checkout status unavailable\n/work/removed checkout")
    }

    @Test func remoteContextNeverPresentsLocalEvidenceEvenForAnIdenticalPath() {
        let local = context("/work/app")
        let remote = context("/work/app", remote: true)
        for observed in [local, remote] {
            let presentation = ProjectCheckoutPresentation(
                context: remote, observedContext: observed, status: .primaryCheckout, connectionName: "builder")
            #expect(presentation.name == "builder · app")
            #expect(presentation.help == "Git checkout status unavailable on remote host\n/work/app")
        }
    }

    @Test func aDraftWithoutAProjectCannotInheritPreviousEvidence() {
        let presentation = ProjectCheckoutPresentation(
            context: context(""), observedContext: context("/work/app"), status: .primaryCheckout)
        #expect(presentation.name == "Choose project")
        #expect(presentation.chipHelp == Self.draftAction)
        #expect(presentation.accessibilityValue == "Choose project")
    }
}

/// The chip's only input is `ThreadsScreen.composerSelectionContext`, a field-for-field copy of
/// `AppModel.composerTurnStartTarget`. These tests drive that real AppModel seam (no daemon).
@Suite(.serialized) @MainActor struct ProjectChipSelectionConsumerTests {
    private func thread(mode: String, repoRoot: String, workspaceRoot: String?) throws -> ThreadSummary {
        var json: [String: Any] = [
            "id": "thread-\(mode)", "runIds": [], "needsHuman": false, "workspaceMode": mode, "repoRoot": repoRoot,
            "createdAt": "2026-10-21T00:00:00Z", "updatedAt": "2026-10-21T00:00:00Z",
        ]
        json["workspaceRoot"] = workspaceRoot
        return try JSONDecoder().decode(ThreadSummary.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func chipContext(_ target: TurnStartTarget) -> ComposerSelectionContext {
        .init(locationID: target.locationID.rawValue, threadID: target.threadID, repoRoot: target.repoRoot)
    }

    @Test(arguments: [("delegated", "/runs/caller-owned/app"), ("isolated", nil), ("in_place", nil)]
          as [(String, String?)])
    func aSelectedThreadNamesItsProjectNeverItsExecutionTree(mode: String, workspaceRoot: String?) throws {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let selected = try thread(mode: mode, repoRoot: "/work/red/app", workspaceRoot: workspaceRoot)
        model.threads = [selected]
        model.selectedThreadId = selected.id
        model.selectedThreadDetail = ThreadDetailResponse(thread: selected, sessions: [], turns: [])

        let target = model.composerTurnStartTarget
        #expect(target.repoRoot == "/work/red/app")
        #expect(target.threadID == selected.id)
        // The execution tree keeps its own owner (a delegated thread's caller-owned root); the chip never reads it.
        #expect(ThreadWorkspacePanel.executionRoot(for: selected) == (workspaceRoot ?? "/work/red/app"))
        let context = chipContext(target)
        let presentation = ProjectCheckoutPresentation(
            context: context, observedContext: context, status: .linkedWorktree("app"),
            recent: ["/work/red/app", "/work/blue/app"])
        #expect(presentation.name == "app — red")
        #expect(presentation.chipHelp
            == "In the linked Git worktree “app”\n/work/red/app\n\n" + "Project for this thread (bound). "
                + "Pick another to start a new thread there.")
        #expect(!presentation.accessibilityValue.contains("/runs/"))
    }

    @Test func anIsolatedDraftNamesTheSelectedProjectBeforeAnyWorktreeExists() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let previousRoot = model.projectRoot
        defer { model.projectRoot = previousRoot }
        model.projectRoot = "/work/red/app"
        model.draftIsolatedWorkspace = true

        let target = model.composerTurnStartTarget
        #expect(target.threadID == nil)
        #expect(target.workspace == .isolated)
        #expect(target.repoRoot == "/work/red/app")
        #expect(target.createRequest?.scope == .project(root: "/work/red/app"))
        let presentation = ProjectCheckoutPresentation(context: chipContext(target), observedContext: nil, status: nil)
        #expect(presentation.name == "app")
        #expect(presentation.chipHelp == "Checking Git checkout…\n/work/red/app\n\n"
            + "Project for the new thread — pick a recent project or Browse…")
    }

    @Test func aSelectedThreadWithoutLoadedMetadataNeverFallsBackToTheDraftProject() {
        let model = AppModel(client: nil, requestNotificationAuthorization: false)
        let previousRoot = model.projectRoot
        defer { model.projectRoot = previousRoot }
        model.projectRoot = "/work/draft/app"
        model.selectedThreadId = "not-yet-loaded"

        let target = model.composerTurnStartTarget
        #expect(target.repoRoot.isEmpty)
        // The same facts ThreadsScreen.projectChipMetadataKnown reads.
        let known = model.selectedThreadDetail?.thread.id == "not-yet-loaded"
            || model.threadSummary("not-yet-loaded", at: model.selectedExecutionLocation) != nil
        #expect(!known)
        let presentation = ProjectCheckoutPresentation(
            context: chipContext(target), observedContext: nil, status: nil, metadataKnown: known)
        #expect(presentation.name == "Project unavailable")
        #expect(!presentation.chipHelp.contains("/work/draft"))
    }
}

/// `ProjectChip` keeps one control across selections; SwiftUI restarts its `.task(id:)` probe only
/// when this key changes.
@Suite struct ProjectCheckoutProbeTests {
    private static let local = ExecutionLocationID.local.rawValue
    private static let remote = "ssh:11111111-1111-4111-8111-111111111111"

    @Test func everyFieldTheContextFenceComparesAndEveryRefreshRestartsTheProbe() {
        // A field the fence compares but the key ignored would leave the chip on “Checking…” with no probe running.
        let selections: [ComposerSelectionContext] = [
            .init(locationID: Self.local, threadID: nil, repoRoot: "/work/red/app"),
            .init(locationID: Self.local, threadID: nil, repoRoot: "/work/blue/app"),
            .init(locationID: Self.local, threadID: "thread", repoRoot: "/work/red/app"),
            .init(locationID: Self.local, threadID: "other", repoRoot: "/work/red/app"),
            .init(locationID: Self.remote, threadID: nil, repoRoot: "/work/red/app"),
            .init(locationID: Self.local, threadID: nil, repoRoot: ""),
        ]
        for old in selections {
            for new in selections {
                for (oldRefresh, newRefresh) in [(0, 0), (0, 1)] {
                    let restarts = ProjectCheckoutProbe(context: old, refresh: oldRefresh)
                        != ProjectCheckoutProbe(context: new, refresh: newRefresh)
                    #expect(restarts == (old != new || oldRefresh != newRefresh))
                }
            }
        }
    }

    @Test func aLocalRemoteLocalHopRestartsEachTimeAndObservesOnlyTheLocalFolder() {
        let a = ComposerSelectionContext(locationID: Self.local, threadID: nil, repoRoot: "/work/red/app")
        let b = ComposerSelectionContext(locationID: Self.remote, threadID: nil, repoRoot: "/work/red/app")
        let probes = [a, b, a].map { ProjectCheckoutProbe(context: $0, refresh: 0) }
        #expect(probes[0] != probes[1] && probes[1] != probes[2])
        #expect(probes.map(\.localPath) == ["/work/red/app", nil, "/work/red/app"])
        let unloaded = ComposerSelectionContext(locationID: Self.local, threadID: "not-yet-loaded", repoRoot: "")
        #expect(ProjectCheckoutProbe(context: unloaded, refresh: 1).localPath == nil)
    }
}

/// Wiring the probe tests cannot reach without a window: the caller must not replace the chip, and
/// the chip must give SwiftUI the complete probe key.
@Suite struct ProjectChipIdentityWiringTests {
    private func source(_ file: String) throws -> String {
        let appRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: appRoot.appendingPathComponent("Sources/ClaudexorApp/" + file), encoding: .utf8)
            .filter { !$0.isWhitespace }
    }

    @Test func choosingAnotherProjectRestartsTheProbeWithoutReplacingTheChip() throws {
        let screen = try source("ThreadsScreen.swift")
        let afterCall = try #require(screen.components(separatedBy: "ProjectChip(context:composerSelectionContext").dropFirst().first)
        let call = try #require(afterCall.components(separatedBy: "ifthreadHasProject{").first)
        #expect(call.contains("onNoProject:{model.clearProject()})"))
        #expect(!call.contains(".id("))

        let components = try source("DesignSystemComponents.swift")
        let afterType = try #require(components.components(separatedBy: "structProjectChip:View{").dropFirst().first)
        let chip = try #require(afterType.components(separatedBy: "structProjectCheckoutProbe:Equatable{").first)
        #expect(chip.contains("letprobe=ProjectCheckoutProbe(context:context,refresh:checkoutRefresh)"))
        #expect(chip.contains(".task(id:probe)"))
        #expect(!chip.contains(".id("))
    }
}
