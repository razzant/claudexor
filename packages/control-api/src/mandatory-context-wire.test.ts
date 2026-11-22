/**
 * Wire compatibility of the late mandatory-context refusal: a Plan that lost a
 * required file after admission fails with category `project` and `code: null`,
 * so the released 6.2.0 readers keep the WHOLE failure record on the ordinary
 * HTTP detail read. The refusal's own code stays an open-vocabulary term on
 * the problem surfaces (ControlProblem/TurnEnqueueProblem); it is deliberately
 * not a RunFailureCode — the widened member an earlier candidate tried is
 * asserted rejected here so it never returns. Synthetic neutral run trees only.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { CONTROL_PROTOCOL_MAJOR, RunFailure } from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import { releasedRunReader } from "../../schema/fixtures/run-results-6.2.0.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const TS = "2026-11-17T00:00:00.000Z";
const SAFE_MESSAGE =
  "mandatory context missing/unreadable in /execution/root: REQUIRED.md (ENOENT)";

/** A Plan run whose context phase failed AFTER admission, exactly as the
 * orchestrator's context terminal leaves it on disk (failure.yaml, summary and
 * the journal's run.failed line). */
function failedPlanRun() {
  const runDir = mkdtempSync(join(tmpdir(), "cx-mandatory-wire-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "final"));
  const failure = RunFailure.parse({
    phase: "context",
    category: "project",
    code: null,
    safeMessage: SAFE_MESSAGE,
    runDir,
    nextActions: ["Open diagnostics", "Retry the run"],
  });
  writeFileSync(join(runDir, "final", "failure.yaml"), stringify(failure));
  writeFileSync(
    join(runDir, "final", "summary.md"),
    `# Run run-plan (plan)\n\n- Lifecycle: failed\n- Phase: context\n\n${SAFE_MESSAGE}\n`,
  );
  const event = (seq: number, type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ seq, ts: TS, run_id: "run-plan", task_id: "task-plan", type, payload });
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      event(1, "run.created", { mode: "plan" }),
      event(2, "run.failed", {
        lifecycle: "failed",
        facts: { lifecycle: "failed", reason: "harness_failed" },
        reason: "harness_failed",
        phase: "context",
        error: SAFE_MESSAGE,
        failure_ref: "final/failure.yaml",
      }),
    ].join("\n") + "\n",
  );
  const record: DaemonRunRecord = {
    id: "job-plan",
    runId: "run-plan",
    taskId: "task-plan",
    state: "failed",
    runDir,
    params: { mode: "plan", scope: { kind: "project", root: runDir }, prompt: "fixture" },
  };
  return { runDir, record };
}

describe("late mandatory-context failure on the ordinary HTTP wire", () => {
  it("keeps the failed Plan's failure record readable by the released 6.2.0 detail reader", async () => {
    const r = failedPlanRun();
    const token = "fixture";
    const server = new DaemonControlApiServer({
      token,
      daemon: {
        list: async (query) => ("delegatedFromRunId" in query ? [] : [r.record]),
        status: async () => r.record,
        enqueue: async () => {
          throw new Error("unexpected enqueue");
        },
        cancel: async () => {
          throw new Error("unexpected cancel");
        },
      },
    });
    const { host, port } = await server.start();
    try {
      const res = await fetch(`http://${host}:${port}/v2/runs/run-plan`, {
        headers: {
          authorization: `Bearer ${token}`,
          "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
        },
      });
      expect(res.status).toBe(200);
      const detail = (await res.json()) as Record<string, unknown>;
      expect(detail).toMatchObject({
        failure: { phase: "context", category: "project", code: null },
      });
      expect((detail["failure"] as { safeMessage: string }).safeMessage).toContain(
        "REQUIRED.md (ENOENT)",
      );
      const readAs620 = releasedRunReader("ControlRunDetail");
      expect(readAs620(detail), JSON.stringify(readAs620.errors)).toBe(true);

      // Sensitivity: a code member the released reader does not know loses the
      // WHOLE failure record — the frozen reader rejects the detail and even
      // the current parse-or-null projection drops the failure. That is why
      // `mandatory_context_unavailable` never joins RunFailureCode.
      const widened = JSON.parse(JSON.stringify(detail)) as {
        failure: Record<string, unknown>;
      };
      widened.failure["code"] = "mandatory_context_unavailable";
      expect(readAs620(widened)).toBe(false);
      expect(RunFailure.safeParse(widened.failure).success).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
