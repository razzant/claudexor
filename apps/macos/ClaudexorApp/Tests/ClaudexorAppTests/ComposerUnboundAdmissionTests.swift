import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// #576: the newest turn of a thread can be admitted while no run is bound to
/// it yet. The history header then carries that admission as
/// `latestAdmission = { id, runId: null, enqueueError, jobId, state }`, where
/// `state` is the command lifecycle (`ControlRunState`: queued | running |
/// succeeded | failed | cancelled | interrupted) or null
/// (packages/daemon/src/store/thread-history-read.ts,
/// packages/control-api/src/thread-history-read.ts), beside the thread's
/// previous head run. Only a live admission may hold the composer; the
/// unbound admission is never a cancel target.
///
/// Incidence: the restart recovery stamps a typed enqueue error on an
/// interrupted runless turn (packages/daemon/src/runless-turn-recovery.ts),
/// and that shape already released the composer. The unbound `succeeded` /
/// `interrupted` headers WITHOUT an enqueue error below are schema-valid header
/// contracts (`ControlRunState`), not a reproduced production stuck composer.
@MainActor @Suite struct ComposerUnboundAdmissionTests {
    private static func model(admissionState: String?, enqueueError: [String: Any]? = nil) throws -> AppModel {
        let source = try HistoryTestSource(count: 2)
        source.runs[0].phase = .succeeded
        source.transform = { json in
            var turns = json["turns"] as! [[String: Any]]
            let previousRun = turns[0]["run"] as Any
            // The newest turn is admitted but has no run.
            turns[1]["runId"] = NSNull()
            turns[1]["run"] = NSNull()
            turns[1]["runStatus"] = "unbound"
            turns[1]["primaryOutput"] = NSNull()
            turns[1]["primaryOutputStatus"] = "none"
            json["turns"] = turns
            var header = json["header"] as! [String: Any]
            var thread = header["thread"] as! [String: Any]
            thread["headRunId"] = "mock-run-0"
            header["thread"] = thread
            header["headRun"] = ["runId": "mock-run-0", "run": previousRun]
            header["headRunStatus"] = "available"
            header["latestAdmission"] = [
                "id": "mock-turn-1", "runId": NSNull(), "enqueueError": enqueueError.map { $0 as Any } ?? NSNull(),
                "jobId": "job-mock-turn-1", "state": admissionState.map { $0 as Any } ?? NSNull(),
            ] as [String: Any]
            json["header"] = header
        }
        let model = AppModel(requestNotificationAuthorization: false, loadPersistedState: false)
        let store = try source.store(loaded: true)
        model.selectedHistory = store
        model.selectedThreadId = source.detail.thread.id
        #expect(store.header?.latestAdmission?.runId == nil)
        #expect(store.header?.latestAdmission?.state == admissionState)
        return model
    }

    @Test(arguments: ["succeeded", "interrupted"])
    func aFinishedUnboundAdmissionReleasesTheComposer(_ state: String) throws {
        let model = try Self.model(admissionState: state)
        #expect(model.composerTurnState == .idle)
        #expect(!model.selectedThreadBusy)
        #expect(!model.selectedThreadStarting)
        #expect(model.selectedHeadRunId == nil)
    }

    @Test(arguments: ["queued", "running"])
    func aLiveUnboundAdmissionStillHoldsTheComposerWithoutACancelTarget(_ state: String) throws {
        let model = try Self.model(admissionState: state)
        #expect(model.composerTurnState == .starting)
        #expect(model.selectedThreadBusy)
        #expect(model.selectedThreadStarting)
        #expect(model.selectedHeadRunId == nil)
    }

    @Test(arguments: ["failed", "cancelled"])
    func aFailedOrCancelledUnboundAdmissionKeepsTheComposerIdle(_ state: String) throws {
        let model = try Self.model(admissionState: state)
        #expect(model.composerTurnState == .idle)
        #expect(!model.selectedThreadBusy)
        #expect(!model.selectedThreadStarting)
    }

    /// The producer's restart-recovery shape for an interrupted runless turn.
    @Test func theRestartRecoveryShapeKeepsTheComposerIdle() throws {
        let model = try Self.model(admissionState: "interrupted", enqueueError: [
            "message": "daemon restarted before this turn's accepted command started a run",
            "code": "daemon_restarted_before_start", "retryable": true,
            "requiredActions": ["Retry the turn; its accepted request is replayed unchanged."],
            "context": [String: Any](), "failedAt": "2026-11-01T00:00:00.000Z",
        ])
        #expect(model.selectedHistory?.header?.latestAdmission?.enqueueError?.code == "daemon_restarted_before_start")
        #expect(model.composerTurnState == .idle)
        #expect(!model.selectedThreadBusy)
        #expect(!model.selectedThreadStarting)
    }

    @Test func anAdmissionWithoutACommandStateKeepsTheComposerIdle() throws {
        let model = try Self.model(admissionState: nil)
        #expect(model.composerTurnState == .idle)
        #expect(!model.selectedThreadBusy)
    }
}
