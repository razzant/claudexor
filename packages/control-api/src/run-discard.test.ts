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
import { discardRunResult } from "./run-discard.js";
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
});
