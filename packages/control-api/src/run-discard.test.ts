import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceManager,
  envelopeBaseOf,
  readEnvelopeCustody,
  retainForContinuation,
  retainForInspection,
  retainedEnvelopeOfRun,
} from "@claudexor/workspace";
import { afterAll, describe, expect, it } from "vitest";
import { DecisionRecord, makeOutcomeFacts } from "@claudexor/schema";
import { stringify } from "yaml";
import { discardRunResult, takeRunResult } from "./run-discard.js";
import { readDeliveryState } from "./run-delivery-state.js";
import type { DaemonRunRecord } from "./run-record.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-discard-${name}-`)));
  dirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = temp("repo");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

function terminalPatch(): DaemonRunRecord {
  const runDir = temp("taken");
  mkdirSync(join(runDir, "final"), { recursive: true });
  writeFileSync(join(runDir, "events.jsonl"), "");
  writeFileSync(
    join(runDir, "final/work_product.yaml"),
    "id: wp-1\nkind: patch\nsource_task_id: task-1\nmeta:\n  result_kind: patch\n  apply_state: not_applied\n",
  );
  writeFileSync(join(runDir, "final/patch.diff"), "diff --git a/a b/a\n");
  return { id: "job-t", runId: "run-t", state: "succeeded", runDir };
}

describe("discard decision", () => {
  it("releases a kept stopped run's envelope and records the disposition", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    mkdirSync(join(runDir, "final"), { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), "");
    const env = await new WorkspaceManager(repo).create({
      taskId: "task-d",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-d", runDir },
    });
    writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
    retainForContinuation(env, { runId: "run-d", runDir }, "cancelled");
    const rec: DaemonRunRecord = { id: "job-d", runId: "run-d", state: "cancelled", runDir };

    await expect(discardRunResult(rec)).resolves.toMatchObject({
      accepted: true,
      status: "discarded",
      message: expect.stringContaining("A continuation starts from the project base"),
    });
    expect(existsSync(envelopeBaseOf(env))).toBe(false);
    expect(retainedEnvelopeOfRun(runDir, "run-d")).toBeNull();
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"decision":"discard"');
  });

  it("reports an unreadable inspection address instead of treating it as nothing held", async () => {
    const runDir = temp("run");
    writeFileSync(join(runDir, "attempts"), "not a directory");
    const rec: DaemonRunRecord = { id: "job-u", runId: "run-u", state: "failed", runDir };
    await expect(discardRunResult(rec)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("reports an unreadable or invalid source address before releasing anything, even beside a readable source", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    mkdirSync(join(runDir, "final"), { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), "");
    const wsm = new WorkspaceManager(repo);
    const holder = { runId: "run-m", runDir };
    const readable = await wsm.create({
      taskId: "task-m",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: holder,
    });
    const faulty = await wsm.create({
      taskId: "task-m",
      attemptId: "a02",
      baseRef: "HEAD",
      custody: holder,
    });
    retainForInspection(readable, holder);
    retainForInspection(faulty, holder);
    const rec: DaemonRunRecord = { id: "job-m", runId: "run-m", state: "failed", runDir };
    const pointer = join(runDir, "attempts", "a02", "retained-envelope.json");
    const pointerBytes = readFileSync(pointer);
    const stillHeld = () => {
      expect(readEnvelopeCustody(envelopeBaseOf(readable))?.state).toBe("retained");
      expect(readEnvelopeCustody(envelopeBaseOf(faulty))?.state).toBe("retained");
      expect(existsSync(readable.worktree_path)).toBe(true);
      expect(existsSync(faulty.worktree_path)).toBe(true);
    };

    writeFileSync(pointer, "{");
    await expect(discardRunResult(rec)).rejects.toThrow(/invalid retained-envelope pointer/);
    stillHeld();
    writeFileSync(pointer, pointerBytes);
    // chmod 0o000 denies reads only where the platform honors the mode bits
    // for the current user (not root, not Windows): probe the real capability.
    const probeDir = temp("probe");
    writeFileSync(join(probeDir, "probe"), "x");
    chmodSync(join(probeDir, "probe"), 0o000);
    let canDenyRead = false;
    try {
      readFileSync(join(probeDir, "probe"));
    } catch (error) {
      canDenyRead = (error as { code?: string }).code === "EACCES";
    }
    if (canDenyRead) {
      const custodyFile = join(envelopeBaseOf(faulty), "continuation-custody.json");
      chmodSync(custodyFile, 0o000);
      await expect(discardRunResult(rec)).rejects.toMatchObject({ code: "EACCES" });
      chmodSync(custodyFile, 0o600);
      stillHeld();
    }
    // Readable again: one decision releases every held source.
    await expect(discardRunResult(rec)).resolves.toMatchObject({ status: "discarded" });
    expect(existsSync(envelopeBaseOf(readable))).toBe(false);
    expect(existsSync(envelopeBaseOf(faulty))).toBe(false);
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"decision":"discard"');
  });

  it("refuses a run that holds nothing to discard", async () => {
    const runDir = temp("run");
    const rec: DaemonRunRecord = { id: "job-x", runId: "run-x", state: "failed", runDir };
    await expect(discardRunResult(rec)).rejects.toMatchObject({ status: 409 });
  });

  it("marks a terminal patch as taken, keeps the patch bytes, and repeats as a no-op", async () => {
    const rec = terminalPatch();
    const runDir = rec.runDir!;

    await expect(takeRunResult(rec)).resolves.toMatchObject({ accepted: true, status: "taken" });
    const state = readDeliveryState(rec);
    expect(state).toMatchObject({ takenReason: "captured_result" });
    expect(state?.takenAt).toEqual(expect.any(String));
    const eventBefore = readFileSync(join(runDir, "events.jsonl"), "utf8");
    await expect(takeRunResult(rec)).resolves.toMatchObject({ accepted: true, status: "taken" });
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toBe(eventBefore);
    expect(existsSync(join(runDir, "final/patch.diff"))).toBe(true);
  });

  it("refuses taken for blocked review or failed checks while accepting a clean patch", async () => {
    const rec = terminalPatch();
    const arbitration = join(rec.runDir!, "arbitration");
    mkdirSync(arbitration);
    for (const facts of [
      makeOutcomeFacts("succeeded", { review: "blocked", checks: "passed" }),
      makeOutcomeFacts("succeeded", { review: "approved", checks: "failed" }),
    ]) {
      writeFileSync(
        join(arbitration, "decision.yaml"),
        stringify(DecisionRecord.parse({ winner: "a01", facts })),
      );
      await expect(takeRunResult(rec)).rejects.toMatchObject({
        status: 409,
        code: "run_taken_needs_decision",
        context: { reason: "needs_decision" },
      });
      expect(readDeliveryState(rec)).toBeNull();
    }
    writeFileSync(
      join(arbitration, "decision.yaml"),
      stringify(
        DecisionRecord.parse({
          winner: "a01",
          facts: makeOutcomeFacts("succeeded", { review: "approved", checks: "passed" }),
        }),
      ),
    );
    await expect(takeRunResult(rec)).resolves.toMatchObject({ accepted: true, status: "taken" });
  });

  it("refuses real non-patch results but takes legacy no-change patch rows", async () => {
    const rec = terminalPatch();
    const workProduct = join(rec.runDir!, "final/work_product.yaml");
    const write = (kind: string, resultKind: string | undefined) =>
      writeFileSync(
        workProduct,
        stringify({
          id: "wp-1",
          kind,
          source_task_id: "task-1",
          meta: { result_kind: resultKind, apply_state: "not_applied" },
        }),
      );
    for (const [kind, resultKind] of [
      ["patch", "files"],
      ["files", "files"],
      ["report", "answer"],
      ["new_repo", "patch"],
    ] as const) {
      write(kind, resultKind);
      await expect(takeRunResult(rec)).rejects.toMatchObject({
        status: 409,
        code: "run_taken_not_patch",
        context: { reason: "not_patch" },
      });
      expect(readDeliveryState(rec)).toBeNull();
    }
    for (const resultKind of ["none", "answer", undefined]) {
      write("patch", resultKind);
      await expect(takeRunResult(rec)).resolves.toMatchObject({ accepted: true, status: "taken" });
      expect(readDeliveryState(rec)?.takenReason).toBe("captured_result");
      rmSync(join(rec.runDir!, "final/delivery_state.yaml")); // Each variant reaches admission afresh.
    }
  });

  it("refuses taken for a retained continuation source but accepts inspection-only custody", async () => {
    const rec = terminalPatch();
    const holder = { runId: rec.runId!, runDir: rec.runDir! };
    const env = await new WorkspaceManager(initRepo()).create({
      taskId: "task-t",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: holder,
    });
    retainForContinuation(env, holder, "cancelled");
    try {
      expect(existsSync(join(holder.runDir, "final/resumable.yaml"))).toBe(false);
      await expect(takeRunResult(rec)).rejects.toMatchObject({
        status: 409,
        code: "run_taken_continuable",
        context: { reason: "continuable" },
      });
      expect(readDeliveryState(rec)).toBeNull();
      retainForInspection(env, holder);
      await expect(takeRunResult(rec)).resolves.toMatchObject({ accepted: true, status: "taken" });
      expect(existsSync(env.worktree_path)).toBe(true);
    } finally {
      await discardRunResult(rec);
    }
  });

  it("refuses taken on a continuable or non-terminal run with typed reasons", async () => {
    const continuableDir = temp("taken-continuable");
    mkdirSync(join(continuableDir, "final"), { recursive: true });
    writeFileSync(
      join(continuableDir, "final/resumable.yaml"),
      "cause: cancelled\nresetsAt: null\nlimitWindow: null\nlimitEvidence: null\ncarriers: []\nlimitCode: null\nsession: null\nworkspace:\n  kind: none\n  root: null\n",
    );
    const continuable: DaemonRunRecord = {
      id: "job-c",
      runId: "run-c",
      state: "cancelled",
      runDir: continuableDir,
    };
    await expect(takeRunResult(continuable)).rejects.toMatchObject({
      status: 409,
      code: "run_taken_continuable",
      context: { reason: "continuable" },
      message: expect.stringContaining("continueFrom"),
    });

    const live: DaemonRunRecord = {
      id: "job-live",
      runId: "run-live",
      state: "running",
      runDir: continuableDir,
    };
    await expect(takeRunResult(live)).rejects.toMatchObject({
      status: 409,
      code: "run_taken_non_terminal",
      context: { reason: "non_terminal" },
    });
    await expect(takeRunResult(terminalPatch())).resolves.toMatchObject({
      accepted: true,
      status: "taken",
    });
  });
});
