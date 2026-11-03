import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import {
  ACP_MAX_REPLAY_TURNS,
  acpTerminalRecordMode,
  acpTerminalSummary,
  acpSessionQuery,
  projectAcpRunControls,
  projectTerminalTurnDetail,
  selectReplayTurns,
  typedFetchReason,
} from "./acp-surface-runner.js";

describe("ACP run-control projection", () => {
  it("preserves explicit soft timer settings without creating an implicit limit", () => {
    expect(projectAcpRunControls({ maxSeconds: 60, timeLimitMode: "soft" })).toEqual({
      maxSeconds: 60,
      timeLimitMode: "soft",
    });
    expect(projectAcpRunControls({})).toEqual({});
  });
  it("keeps explicit Standard and directory footprint on the thread request", () => {
    const execution = {
      workspaceKind: "directory",
      scopePaths: ["input", "image.bin"],
      auxiliaryWritableRoots: ["/srv/cache"],
    };
    const reviewerPanel = [{ harness: "claude", processingPreference: "economy" }];
    expect(
      projectAcpRunControls({
        mode: "__acp_session_prompt",
        runMode: "agent",
        processingPreference: "standard",
        execution,
        reviewerPanel,
      }),
    ).toEqual({ mode: "agent", processingPreference: "standard", execution, reviewerPanel });
  });
  it.each([true, false])("preserves review=%s through the thread projection", (review) => {
    expect(
      projectAcpRunControls({ mode: "__acp_session_prompt", runMode: "agent", review }),
    ).toEqual({ mode: "agent", review });
  });

  it("forwards a strict credentialProfileId to the thread turn", () => {
    expect(
      projectAcpRunControls({
        mode: "__acp_session_prompt",
        runMode: "ask",
        credentialProfileId: "work-secondary",
      }),
    ).toEqual({ mode: "ask", credentialProfileId: "work-secondary" });
  });

  it("maps the Agent race alias to the strict n vocabulary", () => {
    expect(
      projectAcpRunControls({
        mode: "__acp_session_prompt",
        runMode: "agent",
        race: true,
        harness: "codex",
      }),
    ).toEqual({ mode: "agent", n: 2, harnesses: ["codex"] });
    expect(projectAcpRunControls({ runMode: "agent", race: true, n: 3 })).toEqual({
      mode: "agent",
      n: 3,
    });
    expect(projectAcpRunControls({ runMode: "agent", race: false })).toEqual({ mode: "agent" });
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const addr = { baseUrl: "http://127.0.0.1:1", token: "t" } as never;

const typedFailure = {
  phase: "execute",
  category: "auth",
  code: null,
  harnessId: "claude",
  attemptId: "a01",
  safeMessage: "Authentication expired",
  rawDetailRef: "attempts/a01/failure.json",
  resetsAt: null,
  vendorFailure: null,
  logRefs: ["attempts/a01/stderr.log"],
  eventRefs: ["events.jsonl#42"],
  runDir: "/tmp/run-1",
  nextActions: ["Log in again"],
};

const terminalRunFacts = validateRunFactsInvariants({
  schema_version: SCHEMA_VERSION,
  run_id: "run-1",
  task_id: "task-1",
  mode: "plan",
  outcome: makeOutcomeFacts("succeeded"),
  deliverable: {
    present: true,
    kind: "plan",
    path: "final/plan.md",
    producer_attempt_id: "p01",
  },
  participants: {
    planners: 1,
    attempts: [
      {
        attempt_id: "p01",
        harness_id: "codex",
        role: "planner",
        deliverable_present: true,
        status: "success",
      },
    ],
  },
  gates: {
    configured: false,
    required: 0,
    total: 0,
    executed: false,
    state: "not_configured",
    receipt_attempt_id: null,
  },
  review: { state: "not_run", blocker_ids: [], blockers: 0 },
  apply: { eligibility: null, operator_decision_present: false },
  required_actions: [],
  generated_at: "2026-08-14T00:00:00.000Z",
});

const failedOutcomeFacts = makeOutcomeFacts("failed", { reason: "harness_failed" });
const failedRunFacts = validateRunFactsInvariants({
  ...terminalRunFacts,
  run_id: "run-failed",
  outcome: failedOutcomeFacts,
  required_actions: requiredActionsFor(failedOutcomeFacts, false),
});

// The post-terminal detail read DEGRADES: a finished ACP turn must never become
// a JSON-RPC error that loses the runId — the terminal answer survives and the
// typed problem rides the result as detailProblem.
describe("projectTerminalTurnDetail (post-terminal degrade)", () => {
  it.each([
    {
      name: "typed receipt error",
      code: "run_facts_invalid",
      message: "canonical RunFacts receipt is invalid",
      retryable: false,
    },
    {
      name: "malformed successful response",
      code: "invalid_service_response",
      message: "run detail endpoint returned an invalid response",
      retryable: true,
    },
  ])("carries a typed detailProblem for a $name", async ({ code, message, retryable }) => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi
      .spyOn(daemonRun, "fetchRunDetail")
      .mockRejectedValue(Object.assign(new Error(message), { code, retryable }));
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1", "succeeded")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        failure: null,
        primaryOutput: null,
        outcomeFacts: null,
        outcomeBanner: null,
        runFacts: null,
        detailProblem: {
          code,
          message,
          retryable,
        },
      });
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("returns the exact validated receipt from the same single detail read", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      summary: { runId: "run-1", taskId: "task-1" },
      runFacts: terminalRunFacts,
    });
    try {
      const projected = await projectTerminalTurnDetail(addr, "run-1", "succeeded");
      expect(projected.runFacts).toEqual(terminalRunFacts);
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("keeps an explicit legacy receipt null without fabricating a problem", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      summary: { runId: "run-1" },
      runFacts: null,
    });
    try {
      const projected = await projectTerminalTurnDetail(addr, "run-1", "succeeded");
      expect(projected).toMatchObject({ runFacts: null });
      expect(projected).not.toHaveProperty("detailProblem");
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });

  it.each([
    ["run identity", { ...terminalRunFacts, run_id: "run-other" }, "succeeded"],
    ["terminal lifecycle", terminalRunFacts, "failed"],
  ] as const)(
    "clears the whole detail-derived snapshot on wrong %s",
    async (_axis, receipt, lifecycle) => {
      const daemonRun = await import("./daemon-run.js");
      const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
        summary: {
          runId: "run-1",
          taskId: "task-1",
          outcomeFacts: makeOutcomeFacts("succeeded"),
        },
        runFacts: receipt,
        applyEligibility: {
          eligible: false,
          state: "needs_review",
          reason: null,
          requiredAction: null,
        },
        planReadiness: { state: "needs_answers", questionCount: 1 },
        planQuestions: [{ id: "q1" }],
        failure: typedFailure,
        primaryOutput: {
          kind: "plan",
          path: "final/plan.md",
          text: "# Untrusted plan",
          bytes: 16,
          truncated: false,
        },
        outcomeBanner: "Done",
      });
      try {
        await expect(projectTerminalTurnDetail(addr, "run-1", lifecycle)).resolves.toEqual({
          applyEligibility: null,
          planReadiness: null,
          planQuestions: [],
          failure: null,
          primaryOutput: null,
          outcomeFacts: null,
          outcomeBanner: null,
          runFacts: null,
          detailProblem: {
            code: "run_facts_invalid",
            message:
              "canonical RunFacts receipt is invalid; inspect final/run_facts.yaml before retrying",
            retryable: false,
          },
        });
        expect(detailSpy).toHaveBeenCalledTimes(1);
      } finally {
        detailSpy.mockRestore();
      }
    },
  );

  it("projects eligibility, readiness, questions, and typed failure from ONE detail read", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      applyEligibility: {
        eligible: false,
        state: "needs_review",
        reason: null,
        requiredAction: null,
      },
      planReadiness: { state: "needs_answers", questionCount: 1 },
      planQuestions: [{ id: "q1" }],
      failure: typedFailure,
      summary: {
        outcomeFacts: makeOutcomeFacts("cancelled", { reason: "wall_clock_exceeded" }),
      },
      outcomeBanner: "Time limit reached",
      primaryOutput: {
        kind: "plan",
        path: "final/plan.md",
        text: "# Plan",
        bytes: 6,
        truncated: false,
      },
    });
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1", "cancelled")).resolves.toEqual({
        applyEligibility: {
          eligible: false,
          state: "needs_review",
          reason: null,
          requiredAction: null,
        },
        planReadiness: { state: "needs_answers", questionCount: 1 },
        planQuestions: [{ id: "q1" }],
        // A record written before per-try attribution decodes with an empty list.
        failure: { ...typedFailure, poolAttempts: [] },
        outcomeFacts: makeOutcomeFacts("cancelled", { reason: "wall_clock_exceeded" }),
        outcomeBanner: "Time limit reached",
        runFacts: null,
        primaryOutput: {
          kind: "plan",
          path: "final/plan.md",
          text: "# Plan",
          bytes: 6,
          truncated: false,
        },
      });
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("does not forward a malformed failure-shaped object", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      failure: { category: "invented", safeMessage: 42 },
    });
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1", "succeeded")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        failure: null,
        primaryOutput: null,
        outcomeFacts: null,
        outcomeBanner: null,
        runFacts: null,
      });
    } finally {
      detailSpy.mockRestore();
    }
  });

  it("projects null fields for a missing/legacy detail and skips the read without a runId", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue(null);
    try {
      await expect(projectTerminalTurnDetail(addr, "run-1", "succeeded")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        failure: null,
        primaryOutput: null,
        outcomeFacts: null,
        outcomeBanner: null,
        runFacts: null,
      });
      await expect(projectTerminalTurnDetail(addr, "", "succeeded")).resolves.toEqual({
        applyEligibility: null,
        planReadiness: null,
        planQuestions: [],
        failure: null,
        primaryOutput: null,
        outcomeFacts: null,
        outcomeBanner: null,
        runFacts: null,
      });
      expect(detailSpy).toHaveBeenCalledTimes(1);
    } finally {
      detailSpy.mockRestore();
    }
  });
});

describe("acpSessionQuery terminal RunFacts binding", () => {
  it.each(["running", "succeeded"])(
    "forwards a soft timer warning when the first status is %s",
    async (state) => {
      const daemonRun = await import("./daemon-run.js");
      const live = await import("./live.js");
      const event = {
        type: "control.applied",
        payload: {
          control: { kind: "time_limit", action: "reached" },
          timeLimit: { mode: "soft" },
        },
      };
      const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
        client: {
          status: vi
            .fn()
            .mockResolvedValueOnce({ state, runId: "run-soft" })
            .mockResolvedValue({ state: "succeeded", runId: "run-soft" }),
        },
        addr,
      } as never);
      const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue(null);
      const controlSpy = vi
        .spyOn(live, "controlApiFetch")
        .mockImplementation(async (_addr, path) => {
          if (path === "/threads/thread-soft")
            return Response.json({ thread: { id: "thread-soft", repoRoot: "/repo" } });
          if (path === "/threads/thread-soft/turns") return Response.json({ jobId: "job-soft" });
          if (path === "/runs/run-soft/events")
            return new Response(
              `event: control.applied\ndata: ${JSON.stringify(event)}\n\nevent: end\ndata: {}\n\n`,
            );
          throw new Error(`unexpected request ${path}`);
        });
      const onEvent = vi.fn();
      try {
        const result = await acpSessionQuery(
          {
            mode: "__acp_session_prompt",
            sessionId: "thread-soft",
            prompt: "work",
            maxSeconds: 1,
            timeLimitMode: "soft",
          },
          { onEvent } as never,
          {} as never,
        );
        expect(onEvent).toHaveBeenCalledWith(event);
        expect(result).toMatchObject({ runId: "run-soft", status: "succeeded" });
      } finally {
        ensureSpy.mockRestore();
        detailSpy.mockRestore();
        controlSpy.mockRestore();
      }
    },
  );

  it("uses the exact terminal status runId and failed lifecycle at the detail boundary", async () => {
    const daemonRun = await import("./daemon-run.js");
    const live = await import("./live.js");
    const terminalStatus = vi.fn().mockResolvedValue({
      state: "failed",
      runId: "run-failed",
      runDir: "/runs/run-failed",
      error: "harness failed",
      params: { mode: "plan" },
    });
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: { status: terminalStatus },
      addr,
    } as never);
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue({
      summary: {
        runId: "run-failed",
        taskId: "task-1",
        outcomeFacts: failedOutcomeFacts,
      },
      runFacts: failedRunFacts,
      outcomeBanner: "Run failed",
    });
    const controlSpy = vi
      .spyOn(live, "controlApiFetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ thread: { id: "thread-1", repoRoot: "/repo" } }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jobId: "job-failed" }) } as Response);
    try {
      const result = (await acpSessionQuery(
        {
          mode: "__acp_session_prompt",
          sessionId: "thread-1",
          prompt: "run it",
          runMode: "plan",
        },
        undefined,
        {} as never,
      )) as Record<string, unknown>;

      expect(terminalStatus).toHaveBeenCalledWith("job-failed");
      expect(detailSpy).toHaveBeenCalledTimes(1);
      expect(detailSpy).toHaveBeenCalledWith(addr, "run-failed");
      expect(result).toMatchObject({
        runId: "run-failed",
        status: "failed",
        outcomeFacts: failedOutcomeFacts,
      });
      expect(result["runFacts"]).toEqual(failedRunFacts);
      expect(result).not.toHaveProperty("detailProblem");
    } finally {
      ensureSpy.mockRestore();
      detailSpy.mockRestore();
      controlSpy.mockRestore();
    }
  });
});

describe("ACP session/list", () => {
  it("lists active and closed threads but never a trashed one", async () => {
    const daemonRun = await import("./daemon-run.js");
    const live = await import("./live.js");
    const ensureSpy = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {},
      addr,
    } as never);
    const row = (id: string, state: string) => ({
      id,
      repoRoot: "/repo",
      title: id,
      updatedAt: "2026-10-01T00:00:00.000Z",
      state,
    });
    const controlSpy = vi.spyOn(live, "controlApiFetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        threads: [
          row("th-active", "active"),
          row("th-closed", "closed"),
          row("th-trash", "trashed"),
        ],
      }),
    } as Response);
    try {
      const result = (await acpSessionQuery(
        { mode: "__acp_session_list" },
        undefined,
        {} as never,
      )) as { sessions: Array<{ sessionId: string }> };
      expect(result.sessions.map((session) => session.sessionId)).toEqual([
        "th-active",
        "th-closed",
      ]);
    } finally {
      ensureSpy.mockRestore();
      controlSpy.mockRestore();
    }
  });
});

describe("ACP terminal primary-output projection", () => {
  const unavailableDetail = {
    applyEligibility: null,
    planReadiness: null,
    planQuestions: [],
    failure: null,
    primaryOutput: null,
    outcomeFacts: null,
    outcomeBanner: null,
    runFacts: null,
    detailProblem: { code: "detail_unavailable", message: "offline", retryable: true },
  };

  it.each([
    ["wall_clock_exceeded", "Time limit reached"],
    ["user_cancelled", "Cancelled"],
  ] as const)("uses the server outcome banner for a cancelled %s terminal", (reason, banner) => {
    expect(
      acpTerminalSummary({
        runId: `run-${reason}`,
        runDir: "",
        record: { state: "cancelled", params: { mode: "agent" } },
        detail: {
          ...unavailableDetail,
          detailProblem: undefined,
          outcomeFacts: makeOutcomeFacts("cancelled", { reason }),
          outcomeBanner: banner,
        },
      }),
    ).toBe(banner);
  });

  it("uses the canonical Control API primary output when detail succeeds", () => {
    expect(
      acpTerminalSummary({
        runId: "run-plan",
        runDir: "",
        record: { state: "succeeded", params: { mode: "agent" } },
        detail: {
          ...unavailableDetail,
          detailProblem: undefined,
          primaryOutput: {
            kind: "plan",
            path: "final/plan.md",
            text: "Canonical plan\n",
            bytes: 15,
            truncated: false,
          },
        },
      }),
    ).toBe("Canonical plan");
  });

  it.each([
    { mode: "plan" as const, file: "plan.md", text: "Fallback plan" },
    { mode: "ask" as const, file: "report.md", text: "Fallback research report" },
  ])("uses the durable $mode mode only when detail is unavailable", ({ mode, file, text }) => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-acp-output-"));
    tempDirs.push(root);
    mkdirSync(join(root, "final"), { recursive: true });
    writeFileSync(join(root, "final", file), `${text}\n`);
    expect(
      acpTerminalSummary({
        runId: `run-${mode}`,
        runDir: root,
        record: { state: "succeeded", params: { mode } },
        detail: unavailableDetail,
      }),
    ).toBe(text);
  });

  it("recovers a cancelled Ask diagnostic without guessing Agent", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-acp-cancelled-"));
    tempDirs.push(root);
    mkdirSync(join(root, "final"), { recursive: true });
    writeFileSync(join(root, "final", "summary.md"), "Stopped after deadline\n");
    expect(
      acpTerminalSummary({
        runId: "run-ask-cancelled",
        runDir: root,
        record: { state: "cancelled", params: { mode: "ask" } },
        detail: unavailableDetail,
      }),
    ).toBe("Stopped after deadline");
  });

  it("accepts only the canonical mode vocabulary from daemon params", () => {
    expect(acpTerminalRecordMode({ params: { mode: "ask" } })).toBe("ask");
    expect(acpTerminalRecordMode({ params: { mode: "plan" } })).toBe("plan");
    expect(acpTerminalRecordMode({ params: { mode: "legacy-audit" } })).toBeUndefined();
    expect(acpTerminalRecordMode({ params: null })).toBeUndefined();
  });
});

// W5: the ACP session/load replay is bounded, and a failed per-turn detail
// fetch discloses a typed reason instead of vanishing.
describe("ACP load-replay bounding (W5)", () => {
  it("keeps every turn when the thread is within the cap", () => {
    const turns = Array.from({ length: 10 }, (_, i) => i);
    const { replayTurns, omittedTurnCount } = selectReplayTurns(turns);
    expect(replayTurns).toEqual(turns);
    expect(omittedTurnCount).toBe(0);
  });

  it("keeps only the most recent N turns and reports the omitted count", () => {
    const total = ACP_MAX_REPLAY_TURNS + 12;
    const turns = Array.from({ length: total }, (_, i) => i);
    const { replayTurns, omittedTurnCount } = selectReplayTurns(turns);
    expect(replayTurns.length).toBe(ACP_MAX_REPLAY_TURNS);
    // The tail (most recent) is kept, in chronological order.
    expect(replayTurns[0]).toBe(12);
    expect(replayTurns.at(-1)).toBe(total - 1);
    expect(omittedTurnCount).toBe(12);
  });
});

describe("typedFetchReason (W5)", () => {
  it("prefers the typed control-API code", () => {
    expect(
      typedFetchReason(
        Object.assign(new Error("gone"), { code: "run_expired_by_retention", status: 410 }),
      ),
    ).toBe("run_expired_by_retention");
  });

  it("falls back to the HTTP status, then a generic marker", () => {
    expect(typedFetchReason(Object.assign(new Error("boom"), { status: 503 }))).toBe("http_503");
    expect(typedFetchReason(new Error("transport blew up"))).toBe("detail_unavailable");
    expect(typedFetchReason(undefined)).toBe("detail_unavailable");
  });
});
