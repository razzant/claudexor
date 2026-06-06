import Foundation
import ClaudexKit

/// UI-side view models. These wrap ClaudexKit DTOs for display; the canonical state
/// is the engine-service (read via GatewayClient). Sample data is used until the app
/// is wired to a live gateway.

struct Project: Identifiable, Hashable {
    let id: String
    let name: String
    var specs: [Spec]
}

struct Spec: Identifiable, Hashable {
    let id: String
    let title: String
    var frozen: Bool
    var runs: [RunRef]
}

struct RunRef: Identifiable, Hashable {
    let id: String
    let title: String
    let state: String
}

/// The phases of a run, rendered as the mission-control pipeline.
enum RunPhase: String, CaseIterable, Identifiable {
    case contract, context, risk, budget, envelope, gates, review, synthesis, arbitration, final
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct CandidateVM: Identifiable, Hashable {
    let id: String
    let harnessId: String
    let state: String
    let costUsd: Double
    let estimated: Bool
}

enum SampleData {
    static let projects: [Project] = [
        Project(
            id: "p1",
            name: "claudex",
            specs: [
                Spec(id: "s1", title: "Config-to-gates", frozen: true, runs: [
                    RunRef(id: "run-aaa", title: "race · 2 candidates", state: "running"),
                    RunRef(id: "run-bbb", title: "until-convergence", state: "success"),
                ]),
                Spec(id: "s2", title: "Plan interview UX", frozen: false, runs: []),
            ]
        ),
        Project(id: "p2", name: "ouroboros", specs: [
            Spec(id: "s3", title: "Swap claude_code.py", frozen: true, runs: [
                RunRef(id: "run-ccc", title: "best-of-n", state: "blocked"),
            ]),
        ]),
    ]

    static let candidates: [CandidateVM] = [
        CandidateVM(id: "a01", harnessId: "codex", state: "green", costUsd: 0.0123, estimated: true),
        CandidateVM(id: "a02", harnessId: "claude", state: "green", costUsd: 0.0210, estimated: false),
        CandidateVM(id: "synth", harnessId: "cursor", state: "running", costUsd: 0.0041, estimated: false),
    ]
}
