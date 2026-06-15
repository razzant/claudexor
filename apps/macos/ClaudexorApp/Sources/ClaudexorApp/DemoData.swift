import Foundation

/// Showcase content. The app prefers live engine-service state; this populates the
/// surfaces the control-api does not yet expose (candidate detail, diffs, findings,
/// interview) so every screen is legible. Live runs render with `isLive = true` and a
/// "Live" badge; everything here renders with a quiet "Sample" badge for honesty.
enum DemoData {
    static func ago(_ minutes: Double) -> Date { Date(timeIntervalSinceNow: -minutes * 60) }

    // MARK: Tasks

    static let tasks: [TaskRun] = [raceTask, convergenceTask, planTask, blockedTask, doneTask, auditTask]

    static let raceTask = TaskRun(
        id: "run-7f3a91",
        title: "Wire config → deterministic gates",
        prompt: "Populate TaskContract.tests.commands from repo config and CLI flags so gatesPassed isn't vacuously true. Add build/test/typecheck gates and thread them through race + convergence.",
        mode: .bestOfN,
        status: .running,
        project: "claudexor",
        specTitle: "Config-to-gates v3",
        harnesses: [.codex, .claude, .cursor],
        n: 3,
        createdAt: ago(42), updatedAt: ago(1),
        activePhase: .review,
        spendUsd: 0.2143, capUsd: 0.60,
        routeProof: .verified,
        attentionNote: nil,
        plan: [
            PlanItem("Read packages/config + TaskContract schema", .done),
            PlanItem("Add tests.commands resolver from repo config", .done),
            PlanItem("Thread gates through orchestrator race path", .done),
            PlanItem("Wire CLI --gate / --test flags", .active),
            PlanItem("Add gate-failure → convergence feedback", .pending),
            PlanItem("Update docs + regenerate JSON schema", .pending),
        ],
        activity: [
            ActivityEvent(.system, "Run started · best_of_n · 3 candidates", at: ago(42)),
            ActivityEvent(.thinking, harness: .codex, "Mapping repo config keys to TaskContract.tests.commands", detail: "Found gates in claudexor.config.json: build, test, typecheck.", at: ago(40)),
            ActivityEvent(.file, harness: .codex, "Edited packages/cli/src/spec.ts", detail: "+34 −6", code: "+ contract.tests = { commands: resolveGates(cfg, flags) };", at: ago(33)),
            ActivityEvent(.tool, harness: .claude, "Ran pnpm -w typecheck", detail: "exit 0 · 9.2s", at: ago(21)),
            ActivityEvent(.gate, "Gates: typecheck ✓  build ✓  test ✓ (claude)", at: ago(18)),
            ActivityEvent(.review, harness: .cursor, "Cross-family review of codex candidate", detail: "1 major, 2 minor findings; route verified.", at: ago(6)),
            ActivityEvent(.message, harness: .claude, "Proposing synthesis from codex+cursor diffs", at: ago(2)),
        ],
        candidates: [
            Candidate(id: "a01", family: .codex, status: .succeeded, costUsd: 0.0712, estimated: false, gatesPassed: 3, gatesTotal: 3, reviewState: .changesRequested, summary: "Resolver + race threading; misses CLI flag path.", filesChanged: 5, added: 142, removed: 28),
            Candidate(id: "a02", family: .claude, status: .succeeded, costUsd: 0.0934, estimated: false, gatesPassed: 3, gatesTotal: 3, reviewState: .clean, summary: "Full resolver + CLI flags + convergence feedback.", filesChanged: 7, added: 198, removed: 41),
            Candidate(id: "a03", family: .cursor, status: .running, costUsd: 0.0312, estimated: true, gatesPassed: 2, gatesTotal: 3, reviewState: .pending, summary: "In progress — gate wiring done, tests pending.", filesChanged: 4, added: 96, removed: 12),
            Candidate(id: "syn", family: .claude, status: .running, costUsd: 0.0185, estimated: true, gatesPassed: 0, gatesTotal: 3, reviewState: .pending, summary: "Synthesis of codex resolver + claude CLI wiring.", isSynthesis: true, filesChanged: 7, added: 176, removed: 33),
        ],
        findings: [
            Finding(id: "f1", severity: .major, category: "Correctness", title: "CLI --gate flag not threaded into contract", detail: "codex candidate resolves gates from config only; CLI-provided gates are dropped before the contract is built, so `claudexor race --gate \"pnpm test\"` is silently ignored.", reviewer: .cursor, routeProof: .verified, evidenceFile: "packages/cli/src/cli.ts", evidenceLine: 412, status: .accepted, taskTitle: "Wire config → deterministic gates"),
            Finding(id: "f2", severity: .minor, category: "Tests", title: "No test for empty gate list staying vacuous-false", detail: "Add a regression asserting gatesPassed([]) does not report success once gates are required.", reviewer: .cursor, routeProof: .verified, evidenceFile: "packages/review/src/gates.test.ts", evidenceLine: nil, status: .proposed, taskTitle: "Wire config → deterministic gates"),
            Finding(id: "f3", severity: .nit, category: "Style", title: "Prefer typed GateSpec over string[]", detail: "Minor: a GateSpec record (name+command+required) would read better in artifacts.", reviewer: .codex, routeProof: .unverified, evidenceFile: nil, evidenceLine: nil, status: .proposed, taskTitle: "Wire config → deterministic gates"),
        ],
        diff: demoDiff
    )

    static let convergenceTask = TaskRun(
        id: "run-2bd180",
        title: "Daemon durable registry survives restart",
        prompt: "Persist job registry to jobs.json atomically; restore runId/runDir on restart without leaking raw results.",
        mode: .untilClean,
        status: .needsReview,
        project: "claudexor",
        specTitle: "Durable service v2",
        harnesses: [.claude, .codex],
        n: 1,
        createdAt: ago(180), updatedAt: ago(24),
        activePhase: .final,
        spendUsd: 0.1487, capUsd: 0.40,
        routeProof: .verified,
        attentionNote: "Converged after 3 rounds — ready for your review.",
        plan: [
            PlanItem("Add persistPath + atomic write", .done),
            PlanItem("Persist runId/runDir on onRunStart", .done),
            PlanItem("Omit raw result from jobs.json", .done),
            PlanItem("Prune history; restore on boot", .done),
        ],
        activity: [
            ActivityEvent(.system, "Round 3 · convergence predicate satisfied", at: ago(26)),
            ActivityEvent(.review, harness: .codex, "Final review: clean, route verified", at: ago(24)),
        ],
        candidates: [
            Candidate(id: "c01", family: .claude, status: .succeeded, costUsd: 0.1487, estimated: false, gatesPassed: 4, gatesTotal: 4, reviewState: .winner, summary: "Atomic persist, restart-safe, redaction upheld.", filesChanged: 3, added: 211, removed: 47),
        ],
        findings: [],
        diff: demoDiff2
    )

    static let planTask = TaskRun(
        id: "run-9c0e22",
        title: "Plan: notarized DMG + LaunchAgent installer",
        prompt: "Plan a notarized .app + DMG with Developer ID, hardened runtime (no sandbox), and a LaunchAgent for claudexord.",
        mode: .plan,
        status: .running,
        project: "claudexor",
        specTitle: nil,
        harnesses: [.codex, .claude],
        n: 2,
        createdAt: ago(12), updatedAt: ago(0.4),
        activePhase: .context,
        spendUsd: 0.0312, capUsd: 0.25,
        routeProof: .unverified,
        attentionNote: nil,
        plan: [
            PlanItem("Survey signing/notarization options", .active),
            PlanItem("Draft DMG layout + LaunchAgent plist", .pending),
            PlanItem("Extract ambiguities → interview", .pending),
            PlanItem("Freeze SpecPack", .pending),
        ],
        activity: [
            ActivityEvent(.thinking, harness: .codex, "Comparing Developer ID + notarytool vs App Store sandbox", at: ago(8)),
            ActivityEvent(.thinking, harness: .claude, "LaunchAgent vs SMAppService for claudexord lifecycle", at: ago(4)),
        ],
        candidates: [],
        findings: [],
        diff: []
    )

    static let blockedTask = TaskRun(
        id: "run-44ab7e",
        title: "Swap Ouroboros claude_code.py for Claudexor",
        prompt: "Replace Ouroboros' claude_code.py with the Claudexor embeddable substrate over JSON-RPC.",
        mode: .maxAttempts,
        status: .blocked,
        project: "ouroboros",
        specTitle: "Embed substrate v1",
        harnesses: [.claude],
        n: 1,
        createdAt: ago(320), updatedAt: ago(60),
        activePhase: .envelope,
        spendUsd: 0.0890, capUsd: 0.30,
        routeProof: .sameModelFallback,
        attentionNote: "Needs permission: write outside workspace_write scope (Ouroboros repo).",
        plan: [
            PlanItem("Map claude_code.py surface to Claudexor API", .done),
            PlanItem("Generate JSON-RPC client shim", .blocked, note: "Blocked on access scope"),
        ],
        activity: [
            ActivityEvent(.system, "Paused — requires elevated access profile", at: ago(60)),
        ],
        candidates: [],
        findings: [],
        diff: []
    )

    static let doneTask = TaskRun(
        id: "run-1190ff",
        title: "Control-api SSE replay with Last-Event-ID",
        prompt: "Add bounded per-run event bus with replay + gap detection over loopback SSE.",
        mode: .bestOfN,
        status: .succeeded,
        project: "claudexor",
        specTitle: "Control API v1",
        harnesses: [.codex, .claude],
        n: 2,
        createdAt: ago(1440), updatedAt: ago(1300),
        activePhase: .final,
        spendUsd: 0.1021, capUsd: 0.50,
        routeProof: .verified,
        attentionNote: nil,
        plan: [
            PlanItem("Bounded ring buffer + replay", .done),
            PlanItem("Last-Event-ID reconnect", .done),
            PlanItem("Eviction TTL + 404 guard", .done),
        ],
        activity: [ActivityEvent(.review, "Merged to main · 517c9ba", at: ago(1300))],
        candidates: [
            Candidate(id: "w01", family: .codex, status: .succeeded, costUsd: 0.0501, estimated: false, gatesPassed: 3, gatesTotal: 3, reviewState: .winner, summary: "Ring buffer + reconnect; chosen winner.", filesChanged: 4, added: 220, removed: 12),
            Candidate(id: "w02", family: .claude, status: .succeeded, costUsd: 0.0520, estimated: false, gatesPassed: 3, gatesTotal: 3, reviewState: .clean, summary: "Alternative with timer-based eviction.", filesChanged: 5, added: 240, removed: 18),
        ],
        findings: [],
        diff: demoDiff2
    )

    static let auditTask = TaskRun(
        id: "run-66c1a4",
        title: "Audit: secret redaction across artifacts",
        prompt: "Read-only audit of every path that writes artifacts; confirm no auth.json / tokens can enter patch.diff.",
        mode: .readOnlyAudit,
        status: .succeeded,
        project: "claudexor",
        specTitle: nil,
        harnesses: [.claude],
        n: 1,
        createdAt: ago(900), updatedAt: ago(880),
        activePhase: .final,
        spendUsd: 0.0277, capUsd: 0.20,
        routeProof: .verified,
        attentionNote: nil,
        plan: [PlanItem("Trace artifact writers", .done), PlanItem("Verify scoped HOME outside worktree", .done)],
        activity: [ActivityEvent(.review, harness: .claude, "No leak paths found; 1 advisory note", at: ago(880))],
        candidates: [],
        findings: [
            Finding(id: "af1", severity: .minor, category: "Hygiene", title: "Advisory: prune old envelope homes on dispose", detail: "dispose() removes the envelope base; add a periodic sweep for orphaned bases from crashed runs.", reviewer: .claude, routeProof: .verified, evidenceFile: "packages/workspace/src/manager.ts", evidenceLine: 188, status: .proposed, taskTitle: "Audit: secret redaction across artifacts"),
        ],
        diff: []
    )

    // MARK: Diffs

    static let demoDiff: [DiffFile] = [
        DiffFile(path: "packages/cli/src/spec.ts", added: 34, removed: 6, hunks: [
            DiffHunk(header: "@@ -118,7 +118,9 @@ export function draftFromPlanAndAnswers(", lines: [
                DiffLine(kind: .context, text: "  const constraints: TaskConstraints = {", oldNo: 118, newNo: 118),
                DiffLine(kind: .remove, text: "    access: 'workspace_write',", oldNo: 119, newNo: nil),
                DiffLine(kind: .add, text: "    access: answers.access ?? 'workspace_write',", oldNo: nil, newNo: 119),
                DiffLine(kind: .add, text: "    tests: { commands: resolveGates(cfg, flags) },", oldNo: nil, newNo: 120),
                DiffLine(kind: .context, text: "  };", oldNo: 120, newNo: 121),
            ]),
        ]),
        DiffFile(path: "packages/review/src/gates.ts", added: 41, removed: 9, hunks: [
            DiffHunk(header: "@@ -12,6 +12,18 @@ export function gatesPassed(", lines: [
                DiffLine(kind: .context, text: "export function gatesPassed(results: GateResult[]): boolean {", oldNo: 12, newNo: 12),
                DiffLine(kind: .remove, text: "  return results.every((r) => r.ok);", oldNo: 13, newNo: nil),
                DiffLine(kind: .add, text: "  if (results.length === 0) return false; // required gates must run", oldNo: nil, newNo: 13),
                DiffLine(kind: .add, text: "  return results.every((r) => r.ok);", oldNo: nil, newNo: 14),
            ]),
        ]),
    ]

    static let demoDiff2: [DiffFile] = [
        DiffFile(path: "packages/daemon/src/server.ts", added: 88, removed: 17, hunks: [
            DiffHunk(header: "@@ -204,6 +204,22 @@ class DaemonServer {", lines: [
                DiffLine(kind: .add, text: "  private persist(): void {", oldNo: nil, newNo: 204),
                DiffLine(kind: .add, text: "    const tmp = `${this.persistPath}.tmp`;", oldNo: nil, newNo: 205),
                DiffLine(kind: .add, text: "    writeFileSync(tmp, serialize(this.redactedJobs()));", oldNo: nil, newNo: 206),
                DiffLine(kind: .add, text: "    renameSync(tmp, this.persistPath); // atomic", oldNo: nil, newNo: 207),
                DiffLine(kind: .add, text: "  }", oldNo: nil, newNo: 208),
            ]),
        ]),
    ]

    // MARK: Projects

    static let projects: [Project] = [
        Project(id: "p1", name: "claudexor", specs: [
            Spec(id: "s1", title: "Config-to-gates v3", frozen: true, version: 3, runIds: ["run-7f3a91"]),
            Spec(id: "s2", title: "Durable service v2", frozen: true, version: 2, runIds: ["run-2bd180"]),
            Spec(id: "s3", title: "Control API v1", frozen: true, version: 1, runIds: ["run-1190ff"]),
            Spec(id: "s4", title: "macOS mission-control", frozen: false, version: 1, runIds: []),
        ]),
        Project(id: "p2", name: "ouroboros", specs: [
            Spec(id: "s5", title: "Embed substrate v1", frozen: true, version: 1, runIds: ["run-44ab7e"]),
        ]),
    ]

    // MARK: Harness doctor

    static let harnesses: [HarnessInfo] = [
        HarnessInfo(family: .codex, health: .ok, version: "codex 0.137", auth: "api_key (scoped CODEX_HOME)", intents: ["plan", "implement", "repair", "review", "synthesize"]),
        HarnessInfo(family: .claude, health: .ok, version: "claude-code 2.0", auth: "api_key (ANTHROPIC_API_KEY)", intents: ["plan", "implement", "repair", "review", "synthesize", "audit"]),
        HarnessInfo(family: .cursor, health: .degraded, version: "cursor-agent 0.4", auth: "local_session", intents: ["implement", "review"]),
        HarnessInfo(family: .opencode, health: .unavailable, version: "—", auth: "not installed", intents: []),
        HarnessInfo(family: .raw, health: .ok, version: "openrouter", auth: "api_key", intents: ["review", "plan"]),
    ]
}
