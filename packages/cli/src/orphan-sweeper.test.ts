import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTime } from "@claudexor/workspace";
import { sweepOrphanWorkspaces } from "./orphan-sweeper.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-sweep-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

function envelope(root: string, taskId: string, attemptId: string, owner?: { pid: number; started: string | null }): string {
  const base = join(root, ".claudexor", "workspaces", taskId, attemptId);
  mkdirSync(join(base, "tree"), { recursive: true });
  mkdirSync(join(base, "home"), { recursive: true });
  writeFileSync(join(base, "tree", "work.txt"), "in flight\n");
  if (owner) {
    writeFileSync(join(base, "owner.json"), JSON.stringify({ ...owner, created_at: new Date().toISOString() }) + "\n");
  }
  return base;
}

describe("crash-GC live-owner guard", () => {
  it("keeps envelopes whose recorded owner process is ALIVE and sweeps dead/markerless ones", async () => {
    const root = initRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "claudexor-sweep-state-"));
    try {
      // Live owner: THIS test process (same pid + command name).
      const live = envelope(root, "task-live", "a01", {
        pid: process.pid,
        started: processStartTime(process.pid),
      });
      // Dead owner: a pid from the far end of the space (guaranteed-ish gone);
      // even a recycled pid cannot reproduce the recorded start time.
      const dead = envelope(root, "task-dead", "a01", { pid: 999_999_990, started: "Thu Jan  1 00:00:00 1970" });
      // Legacy envelope without a marker: swept (pre-marker debris).
      const legacy = envelope(root, "task-legacy", "a01");

      const jobsPath = join(stateDir, "jobs.json");
      writeFileSync(
        jobsPath,
        JSON.stringify([{ params: { scope: { kind: "project", root } } }]) + "\n",
      );
      const actions = await sweepOrphanWorkspaces({ jobsPath, threadsPath: join(stateDir, "threads.json") });

      expect(existsSync(live)).toBe(true);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(legacy)).toBe(false);
      expect(actions.some((a) => a.includes("kept envelope task-live/a01") && a.includes("live owner"))).toBe(true);
      expect(actions.some((a) => a.includes("disposed orphan envelope task-dead/a01"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("without start-time proof: a live pid keeps only a FRESH envelope; a stale one is swept (bounded credential retention)", async () => {
    const root = initRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "claudexor-sweep-state-"));
    try {
      // Live pid, NO recorded start time (legacy/ps-less marker), fresh dir -> kept.
      const fresh = envelope(root, "task-fresh", "a01", { pid: process.pid, started: null });
      // Same marker shape but the envelope is OLD -> swept (a recycled pid
      // must not pin a seeded-credential home forever).
      const stale = envelope(root, "task-stale", "a01", { pid: process.pid, started: null });
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const staleBase = join(root, ".claudexor", "workspaces", "task-stale", "a01");
      // Freshness = newest mtime across base + working dirs; age them ALL.
      for (const path of [join(staleBase, "tree", "work.txt"), join(staleBase, "tree"), join(staleBase, "home"), join(staleBase, "owner.json"), staleBase]) {
        utimesSync(path, old, old);
      }
      const jobsPath = join(stateDir, "jobs.json");
      writeFileSync(jobsPath, JSON.stringify([{ params: { scope: { kind: "project", root } } }]) + "\n");
      // Inverse case: dirs are OLD but one nested file is fresh — editing an
      // existing file bumps only the file's mtime, and that must count as
      // liveness (the walk looks at files, not just directory entries).
      const nested = envelope(root, "task-nested", "a01", { pid: process.pid, started: null });
      for (const path of [join(nested, "tree"), join(nested, "home"), join(nested, "owner.json"), nested]) {
        utimesSync(path, old, old);
      }
      // tree/work.txt keeps its fresh mtime (just created).
      await sweepOrphanWorkspaces({ jobsPath, threadsPath: join(stateDir, "threads.json") });
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
