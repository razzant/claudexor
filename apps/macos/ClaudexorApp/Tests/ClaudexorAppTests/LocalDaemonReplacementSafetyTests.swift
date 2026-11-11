import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

struct LocalDaemonReplacementSafetyTests {
    private func identity(_ version: String, sha: String = "a") -> RuntimeClosureIdentity {
        RuntimeClosureIdentity(version: version, buildSha: String(repeating: sha, count: 40))
    }

    private func reconciler(
        _ daemon: ReconciliationDaemonStub,
        target: RuntimeClosureIdentity,
        scriptPath: String = "/fixtures/App-B/claudexord.bundle.cjs"
    ) -> LocalDaemonReconciler {
        LocalDaemonReconciler(
            daemon: daemon,
            lifecycleOwner: LocalRuntimeLifecycleOwner(),
            targetClosure: {
                LocalRuntimeClosureSelection(
                    scriptURL: URL(fileURLWithPath: scriptPath),
                    authority: .installed(target))
            },
            handshakePollInterval: 0,
            handshakePollTimeout: 0)
    }

    private func expectUsableWithNotice(_ result: LocalDaemonReconciliationResult) {
        let policy = LocalDaemonReconciliationPolicy(result)
        if case let .useCompatible(notice) = policy {
            #expect(notice?.isEmpty == false)
        } else {
            Issue.record("Expected a compatible serving daemon with a notice; got \(result)")
        }
    }

    @Test func passivePollingDoesNotSwitchBetweenSameVersionBuilds() async {
        let buildA = identity("3.2.0")
        let buildB = identity("3.2.0", sha: "b")

        // Either copy may be serving first. Each other copy polls twice, using
        // its own selected closure; no real daemon or restart loop is involved.
        for (serving, selected) in [(buildA, buildB), (buildB, buildA)] {
            let daemon = ReconciliationDaemonStub()
            daemon.targetIdentity = selected
            daemon.runningIdentity = serving
            daemon.servingIdentity = serving
            let sut = reconciler(daemon, target: selected)

            for _ in 0..<2 {
                let result = await sut.reconcile(serving: serving)
                expectUsableWithNotice(result)
            }

            #expect(daemon.stops == 0)
            #expect(daemon.starts == 0)
            #expect(daemon.stoppedIdentities.isEmpty)
            #expect(daemon.startedScripts.isEmpty)
        }
    }

    @Test func olderAppDoesNotReplaceANewerCompatibleDaemon() async {
        // Numeric ordering matters: lexicographic ordering would invert this.
        let serving = identity("3.10.0", sha: "b")
        let selected = identity("3.9.0")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = selected
        daemon.runningIdentity = serving
        daemon.servingIdentity = serving

        let result = await reconciler(daemon, target: selected).reconcile(serving: serving)

        expectUsableWithNotice(result)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
    }

    @Test func strictlyNewerNumericUpgradeStillStopsStartsAndProvesTheSelectedBuild() async {
        let serving = identity("3.9.0")
        let selected = identity("3.10.0", sha: "b")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = selected
        daemon.servingIdentity = serving
        daemon.runningIdentity = selected

        let result = await reconciler(daemon, target: selected).reconcile(serving: serving)

        #expect(result == .replaced(selected))
        #expect(daemon.stoppedIdentities == [serving])
        #expect(daemon.stops == 1)
        #expect(daemon.starts == 1)
        #expect(daemon.startedScripts == [URL(fileURLWithPath: "/fixtures/App-B/claudexord.bundle.cjs")])
    }

    @Test(arguments: ["dev", "3.2.0-rc.1", "3.2.0+local", "3.2"])
    func unorderableVersionsDoNotAuthorizeAutomaticReplacement(version: String) async {
        let unorderable = identity(version)
        let stable = identity("3.3.0", sha: "b")

        for (serving, selected) in [(unorderable, stable), (stable, unorderable)] {
            let daemon = ReconciliationDaemonStub()
            daemon.targetIdentity = selected
            daemon.runningIdentity = serving
            daemon.servingIdentity = serving

            let result = await reconciler(daemon, target: selected).reconcile(serving: serving)

            expectUsableWithNotice(result)
            #expect(daemon.stops == 0)
            #expect(daemon.starts == 0)
        }
    }

    @Test func staleServingObservationCannotReplaceAnotherClientsNewerSwitch() async {
        let staleObservation = identity("3.1.2")
        let selected = identity("3.2.0", sha: "b")
        let anotherClientsSwitch = identity("3.3.0", sha: "c")
        let daemon = ReconciliationDaemonStub()
        daemon.targetIdentity = selected
        daemon.runningIdentity = anotherClientsSwitch
        daemon.servingIdentity = anotherClientsSwitch

        let result = await reconciler(daemon, target: selected)
            .reconcile(serving: staleObservation)

        expectUsableWithNotice(result)
        #expect(daemon.stops == 0)
        #expect(daemon.starts == 0)
        #expect(daemon.stoppedIdentities.isEmpty)
    }

    @Test func sameVersionAndShaAreCoherentAcrossEntryPaths() async throws {
        let selected = identity("3.2.0")
        let entryA = "/fixtures/App-A/claudexord.bundle.cjs"
        let entryB = "/fixtures/App-B/claudexord.bundle.cjs"

        for (servingEntry, selectedEntry) in [(entryA, entryB), (entryB, entryA)] {
            let engine = EngineBuildIdentity(
                version: selected.version, sha: selected.buildSha, entry: servingEntry)
            let serving = try #require(AppRuntimeDaemonControl.runtimeIdentity(
                version: engine.version, buildSha: engine.sha))
            let daemon = ReconciliationDaemonStub()
            daemon.targetIdentity = selected
            daemon.runningIdentity = serving
            daemon.servingIdentity = serving

            let result = await reconciler(daemon, target: selected, scriptPath: selectedEntry)
                .reconcile(serving: serving)

            #expect(result == .coherent(selected))
            #expect(daemon.busyProbes == 0)
            #expect(daemon.stops == 0)
            #expect(daemon.starts == 0)
        }
    }
}
