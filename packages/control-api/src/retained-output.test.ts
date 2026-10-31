import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { ControlRunDetail } from "@claudexor/schema";
import {
  createRevertAnchorFromPatchOrNull,
  createRevertAnchorOrNull,
  snapshotTree,
} from "@claudexor/workspace";
import { projectRuntimeDir } from "@claudexor/util";
import { RETAINED_OUTPUT_PATH } from "@claudexor/event-log";
import {
  DaemonControlApiServer,
  type DaemonRunRecord,
  type DaemonControlApiOptions,
} from "./daemon-server.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-retained-http-"));
  roots.push(root);
  return root;
}
function initRepo(): string {
  const root = directory();
  execFileSync("git", ["init", "-b", "main", root]);
  writeFileSync(join(root, "file.txt"), "before\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "base",
  ]);
  return root;
}
async function withApi(
  record: DaemonRunRecord,
  fn: (get: (path: string, body?: unknown) => Promise<Response>) => Promise<void>,
) {
  const enqueue = vi.fn(async () => ({ id: "unused", state: "queued" }));
  const services: DaemonControlApiOptions["services"] = {
    beginDelivery: async () => ({ id: "delivery-1", state: "running", reused: false }),
    completeDelivery: async () => {},
    failDelivery: async () => {},
  };
  const server = new DaemonControlApiServer({
    token: "fixture-token",
    services,
    daemon: {
      enqueue,
      status: async () => record,
      cancel: async () => {},
      list: async (query) => (query && "delegatedFromRunId" in query ? [] : [record]),
    },
  });
  const address = await server.start();
  try {
    await fn((path, body) =>
      fetch(`http://${address.host}:${address.port}/v2${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer fixture-token",
          "X-Claudexor-Protocol-Major": "3",
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  } finally {
    await server.stop();
  }
}

describe("retained results through the public control API", () => {
  it("transfers a complete retained document beyond the log-preview cap exactly", async () => {
    const runDir = directory();
    mkdirSync(join(runDir, "final"));
    const secret = `sk-ant-${"A".repeat(48)}`;
    writeFileSync(
      join(runDir, RETAINED_OUTPUT_PATH),
      "x".repeat(4_800_000) + "\n" + secret + "\nEND_OF_REVIEW",
    );
    writeFileSync(join(runDir, "large.log"), "x".repeat(4_800_000));
    const record: DaemonRunRecord = {
      id: "job-large",
      runId: "run-large",
      state: "failed",
      runDir,
      params: {},
    };
    await withApi(record, async (get) => {
      const response = await get(`/runs/run-large/artifacts/${RETAINED_OUTPUT_PATH}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.length).toBeGreaterThan(4_800_000);
      expect(text).toContain("END_OF_REVIEW");
      expect(text).toContain(secret);
      expect((await get("/runs/run-large/artifacts/large.log")).status).toBe(413);
    });
  });
  it("recovers the addressed interrupted run on cold read, with no generation or invented terminal", async () => {
    const runDir = directory();
    mkdirSync(join(runDir, "final"));
    const record: DaemonRunRecord = {
      id: "job-1",
      runId: "run-1",
      taskId: "task-1",
      state: "interrupted",
      runDir,
      error: "daemon restarted before completion",
      params: { mode: "ask" },
    };
    const original =
      JSON.stringify({
        seq: 1,
        run_id: "run-1",
        task_id: "task-1",
        ts: "2026-10-04T00:00:00Z",
        type: "harness.event",
        payload: {
          harness_id: "cursor",
          attempt_id: "a01",
          session_id: "try-1",
          type: "message",
          text: "Useful before crash",
          payload: { delta: true },
        },
      }) + "\n";
    writeFileSync(join(runDir, "events.jsonl"), original);
    await withApi(record, async (get) => {
      expect((await get("/runs")).status).toBe(200);
      expect(existsSync(join(runDir, RETAINED_OUTPUT_PATH))).toBe(false);
      const response = await get("/runs/run-1");
      expect(response.status).toBe(200);
      const detail = ControlRunDetail.parse(await response.json());
      expect(detail.summary).toMatchObject({
        state: "interrupted",
        outputReadyState: "diagnostic",
      });
      expect(detail.runFacts).toBeNull();
      expect(detail.primaryOutput).toMatchObject({ kind: "report", path: RETAINED_OUTPUT_PATH });
      expect(detail.primaryOutput?.text).toContain("Useful before crash");
      expect(await (await get(`/runs/run-1/artifacts/${RETAINED_OUTPUT_PATH}`)).text()).toContain(
        "Useful before crash",
      );
    });
    const retained = readFileSync(join(runDir, RETAINED_OUTPUT_PATH), "utf8");
    await withApi(record, async (get) => {
      const detail = ControlRunDetail.parse(await (await get("/runs/run-1")).json());
      expect(detail.primaryOutput?.text).toBe(retained);
    });
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toBe(original);
    expect(existsSync(join(runDir, "final/run_facts.yaml"))).toBe(false);
  });

  it.each([false, true])(
    "Revert uses the captured execution tree, preserving later changes (conflict=%s)",
    async (conflict) => {
      const project = initRepo(),
        execution = initRepo(),
        runDir = directory();
      mkdirSync(join(runDir, "final"));
      const before = await snapshotTree(execution);
      writeFileSync(join(execution, "file.txt"), "cancelled edit\n");
      const after = await snapshotTree(execution);
      // Git reads the pair in the execution tree; the project keeps it, as the
      // orchestrator writes it for a run whose execution root is not its project.
      const anchor = await createRevertAnchorOrNull(execution, before, after, project);
      expect(anchor).not.toBeNull();
      writeFileSync(
        join(runDir, "final/work_product.yaml"),
        stringify({
          id: "wp-1",
          kind: "patch",
          source_task_id: "task-1",
          producer_attempt_id: "a01",
          meta: {
            result_kind: "patch",
            lifecycle: "cancelled",
            adopted: true,
            apply_state: "applied_review_blocked",
            pre_turn_sha: before,
            post_turn_sha: after,
            revert_anchor_id: anchor,
            execution_root: execution,
          },
        }),
      );
      if (conflict) writeFileSync(join(execution, "file.txt"), "later user edit\n");
      const record: DaemonRunRecord = {
        id: "job-1",
        runId: "run-1",
        state: "cancelled",
        runDir,
        params: { mode: "agent", scope: { kind: "project", root: project } },
      };
      await withApi(record, async (get) => {
        const response = await get("/runs/run-1/decision", { action: "revert_run" });
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(conflict ? 409 : 200);
        // A later edit of what the turn changed is the one cause that ends the revert.
        if (conflict)
          expect(body).toMatchObject({
            code: "revert_refused",
            message: expect.stringContaining("changed after this turn"),
            context: { reason: "postimage_diverged", refusalCode: "revert_conflict" },
          });
      });
      expect(readFileSync(join(execution, "file.txt"), "utf8")).toBe(
        conflict ? "later user edit\n" : "before\n",
      );
      expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("before\n");
    },
  );
});

/** A cancelled live turn in `execution`, whose project keeps its revert anchor. */
async function liveTurn(anchorOf: "pair" | "patch") {
  const project = initRepo(),
    execution = initRepo(),
    runDir = directory();
  mkdirSync(join(runDir, "final"));
  const before = await snapshotTree(execution);
  writeFileSync(join(execution, "file.txt"), "cancelled edit\n");
  const after = await snapshotTree(execution);
  const anchor =
    anchorOf === "pair"
      ? await createRevertAnchorOrNull(execution, before, after, project)
      : createRevertAnchorFromPatchOrNull(
          execution,
          execFileSync("git", ["-C", execution, "diff", "--binary", before, after]).toString(),
        );
  expect(anchor).toMatch(/^sha256:[0-9a-f]{64}$/);
  const file = join(
    projectRuntimeDir(anchorOf === "pair" ? project : execution),
    "anchors",
    "objects",
    `${anchor!.slice(7)}.${anchorOf}`,
  );
  expect(existsSync(file)).toBe(true);
  writeFileSync(
    join(runDir, "final/work_product.yaml"),
    stringify({
      id: "wp-1",
      kind: "patch",
      source_task_id: "task-1",
      producer_attempt_id: "a01",
      meta: {
        result_kind: "patch",
        lifecycle: "cancelled",
        adopted: true,
        apply_state: "applied_review_blocked",
        pre_turn_sha: before,
        post_turn_sha: after,
        revert_anchor_id: anchor,
        execution_root: execution,
      },
    }),
  );
  const record: DaemonRunRecord = {
    id: "job-1",
    runId: "run-1",
    taskId: "task-1",
    state: "cancelled",
    runDir,
    params: { mode: "agent", scope: { kind: "project", root: project } },
  };
  return { project, execution, runDir, anchor: anchor!, file, record };
}

// #535 round 9: a revert whose retained anchor is gone or unreadable is the typed
// 409 `revert_refused` (and its audited rejection), never a raw 400 naming a file.
describe("a revert whose retained anchor is missing or unreadable", () => {
  it.each([
    { anchorOf: "pair", damage: "removed", says: "is missing" },
    { anchorOf: "pair", damage: "garbled", says: "is unreadable" },
    { anchorOf: "patch", damage: "removed", says: "is missing" },
    { anchorOf: "patch", damage: "garbled", says: "is unreadable" },
  ] as const)(
    "a $damage $anchorOf anchor answers 409 revert_refused, audited, and changes nothing",
    async ({ anchorOf, damage, says }) => {
      const f = await liveTurn(anchorOf);
      if (damage === "removed") rmSync(f.file);
      else writeFileSync(f.file, readFileSync(f.file, "utf8").slice(0, 40));
      await withApi(f.record, async (get) => {
        const response = await get("/runs/run-1/decision", { action: "revert_run" });
        const problem = (await response.json()) as {
          code: string;
          message: string;
          context: { reason: string; detail: string };
        };
        expect(response.status, JSON.stringify(problem)).toBe(409);
        expect(problem.code).toBe("revert_refused");
        expect(problem.context.reason).toBe("reverse_apply_failed");
        expect(problem.context.detail).toContain(`retained revert anchor ${f.anchor} ${says}`);
        expect(problem.context.detail).toContain("nothing was changed");
        // Never a file the anchor never was.
        if (anchorOf === "pair") expect(problem.context.detail).not.toContain(".patch");
        const detail = ControlRunDetail.parse(await (await get("/runs/run-1")).json());
        expect(detail.summary.result).toMatchObject({
          applyState: "applied_review_blocked",
          revertAnchorId: f.anchor,
        });
      });
      expect(readFileSync(join(f.execution, "file.txt"), "utf8")).toBe("cancelled edit\n");
      expect(readFileSync(join(f.project, "file.txt"), "utf8")).toBe("before\n");
      const rejected = readFileSync(join(f.runDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
        .filter((event) => event.type === "control.rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.payload).toMatchObject({
        decision: "revert_run",
        reason: "reverse_apply_failed",
      });
      expect(String(rejected[0]!.payload["detail"])).toContain(f.anchor);
    },
  );
});

// #535 R5 E1: only a later edit of what the turn changed ends a revert. Every other
// refusal that left the tree untouched read "Revert is no longer available because
// the affected files changed after this turn", although it stays available once its
// cause is gone; the typed cause now rides the problem, with its remedy.
describe("a revert refused for a cause other than a later edit", () => {
  it("answers reverse_apply_failed with the typed cause and its remedy, writing nothing", async () => {
    const f = await liveTurn("pair");
    execFileSync("git", ["-C", f.execution, "sparse-checkout", "set", "--no-cone", "/other/"]);
    await withApi(f.record, async (get) => {
      const response = await get("/runs/run-1/decision", { action: "revert_run" });
      const problem = (await response.json()) as {
        code: string;
        message: string;
        context: { reason: string; detail: string; refusalCode?: string };
      };
      expect(response.status, JSON.stringify(problem)).toBe(409);
      expect(problem).toMatchObject({
        code: "revert_refused",
        context: {
          reason: "reverse_apply_failed",
          refusalCode: "delivery_outside_sparse_checkout",
        },
      });
      expect(problem.message).toContain("git sparse-checkout add");
      expect(problem.message).not.toContain("no longer available");
      expect(problem.context.detail).toContain("file.txt");
    });
    expect(readFileSync(join(f.execution, "file.txt"), "utf8")).toBe("cancelled edit\n");
    const rejected = readFileSync(join(f.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === "control.rejected");
    expect(rejected.at(-1)!.payload).toMatchObject({
      reason: "reverse_apply_failed",
      refusalCode: "delivery_outside_sparse_checkout",
    });
  });
});
