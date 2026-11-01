import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WorkspaceManager, envelopeBaseOf, readEnvelopeCustody } from "@claudexor/workspace";
import { preserveCaptureSource } from "./captureRefusal.js";

// #563: a Git capture refusal names the stage its retention setup stopped at,
// from the custody record itself: written (only the run's address failed) or
// not written (held by this process only). Same wording as the directory lane.
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `cx-retention-stage-${name}-`)));
  dirs.push(dir);
  return dir;
};

async function refused(occupy: (base: string, runDir: string) => string) {
  const repo = temp("repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
  const runDir = temp("run");
  const wsm = new WorkspaceManager(repo);
  const envelope = await wsm.create({ taskId: "task-stage", attemptId: "a01", baseRef: "HEAD" });
  mkdirSync(join(occupy(envelopeBaseOf(envelope), runDir), "occupied"), { recursive: true });
  const refusal = preserveCaptureSource({
    wsm,
    envelope,
    inPlace: false,
    holder: { runId: "run-stage", runDir },
    skipped: { checks: 0, review: false },
    error: Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
  });
  return { refusal, envelope };
}

describe("Git capture refusal retention stage", () => {
  it("custody written, run address not: incomplete setup, never process-only", async () => {
    const { refusal, envelope } = await refused((_base, runDir) =>
      join(runDir, "attempts/a01/retained-envelope.json"),
    );
    expect(refusal).toMatchObject({ disposition: "manual_cleanup", phase: "workspace" });
    expect(refusal.retentionFailure).toBeDefined();
    expect(readEnvelopeCustody(envelopeBaseOf(envelope))?.state).toBe("retained");
    expect(refusal.detail).toContain(
      `the retained isolated source at ${envelope.worktree_path} (not applied), recorded in durable custody; its address in this run could not be written, so retention setup is incomplete until crash recovery restores that address.`,
    );
    expect(refusal.detail).not.toContain("held by this process only");
  });

  it("custody not written: held by this process only, and says so", async () => {
    const { refusal, envelope } = await refused((base) => join(base, "continuation-custody.json"));
    expect(refusal.retentionFailure).toBeDefined();
    expect(refusal.detail).toContain(
      `the isolated source at ${envelope.worktree_path}, held by this process only (durable retention could not be recorded).`,
    );
    expect(refusal.detail).not.toContain("durable custody");
  });
});
