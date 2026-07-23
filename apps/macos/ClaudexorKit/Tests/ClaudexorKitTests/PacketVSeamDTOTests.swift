import Foundation
import Testing
@testable import ClaudexorKit

/// Ф3 packet V — Swift DTO parity for the Ф2 seam fields that were on the wire
/// but dropped at the Swift boundary. Each pins the decode (present + honest
/// default-on-absent for a legacy/version-skewed payload).
@Suite struct PacketVSeamDTOTests {

    // QA-065 — the session's credential-profile binding.
    @Test func threadSessionDecodesProfileId() throws {
        let bound = #"""
        {"id":"s1","threadId":"th-1","harnessId":"claude","nativeSessionId":"nat-1",
         "observedModel":null,"profileId":"work","state":"live"}
        """#
        let s = try JSONDecoder().decode(ThreadSessionInfo.self, from: Data(bound.utf8))
        #expect(s.profileId == "work")

        // A legacy payload omitting the key decodes to nil (engine-default account).
        let legacy = #"{"id":"s2","threadId":"th-1","harnessId":"codex","nativeSessionId":null,"observedModel":null,"state":"live"}"#
        let d = try JSONDecoder().decode(ThreadSessionInfo.self, from: Data(legacy.utf8))
        #expect(d.profileId == nil)
    }

    // QA-064 — project-listing problems survive the thread-list decode.
    @Test func threadListDecodesProjectProblems() throws {
        let json = #"""
        {"threads":[],"problems":[
          {"projectId":"p1","root":"/tmp/gone","code":"project_root_missing","message":"root missing"}
        ]}
        """#
        let list = try JSONDecoder().decode(ThreadListResponse.self, from: Data(json.utf8))
        #expect(list.problems.count == 1)
        #expect(list.problems.first?.root == "/tmp/gone")
        #expect(list.problems.first?.code == "project_root_missing")

        // Older payload without the key → empty, never a decode failure.
        let bare = try JSONDecoder().decode(ThreadListResponse.self, from: Data(#"{"threads":[]}"#.utf8))
        #expect(bare.problems.isEmpty)
    }

    // QA-070 — ignored per-harness knobs ride the timeline event.
    @Test func timelineEventDecodesIgnoredSettings() throws {
        let json = #"""
        {"type":"harness.started","ts":null,"title":"harness · started","detail":null,
         "severity":"warning","ignoredSettings":["max_turns=5 (manifest capabilities.max_turns=false for codex)"],
         "rawRef":"events.jsonl"}
        """#
        let e = try JSONDecoder().decode(TimelineEvent.self, from: Data(json.utf8))
        #expect(e.ignoredSettings?.count == 1)
        #expect(e.severity == "warning")

        // Older payload omitting the key → nil.
        let bare = #"{"type":"harness.started","title":"harness · started"}"#
        let d = try JSONDecoder().decode(TimelineEvent.self, from: Data(bare.utf8))
        #expect(d.ignoredSettings == nil)
    }

    // QA-072 — project nesting relations survive the registry decode.
    @Test func registeredProjectDecodesNesting() throws {
        let json = #"""
        {"projects":[
          {"schemaVersion":1,"id":"child","root":"/repo/child","createdAt":"2026-07-19T12:00:00.000Z",
           "updatedAt":"2026-07-19T12:00:00.000Z",
           "nesting":[{"relation":"inside","root":"/repo","projectId":"parent"}]}
        ]}
        """#
        let list = try JSONDecoder().decode(ProjectListResponse.self, from: Data(json.utf8))
        #expect(list.projects.first?.nesting.first?.relation == "inside")
        #expect(list.projects.first?.nesting.first?.root == "/repo")

        // Older payload without nesting → empty, never a decode failure.
        let bare = #"""
        {"projects":[{"schemaVersion":1,"id":"solo","root":"/repo/solo",
          "createdAt":"2026-07-19T12:00:00.000Z","updatedAt":"2026-07-19T12:00:00.000Z"}]}
        """#
        let d = try JSONDecoder().decode(ProjectListResponse.self, from: Data(bare.utf8))
        #expect(d.projects.first?.nesting.isEmpty == true)
    }
}
