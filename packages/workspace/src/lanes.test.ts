import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectRuntimeDir } from "@claudexor/util";
import { WorkspaceManager } from "./manager.js";
import {
  ensureLaneHomeEnv,
  laneHomeDir,
  purgeProfileLanes,
  purgeThreadLanes,
  readThreadSummary,
  sweepOrphanLanes,
  writeThreadSummary,
} from "./lanes.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

// A hermetic Claudexor-owned root so every projectRuntimeDir(...) resolves
// under a throwaway config dir (never the operator's real ~/.claudexor).
let prevConfigDir: string | undefined;
let configDir: string;

beforeEach(() => {
  prevConfigDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  configDir = reapMk(join(tmpdir(), "claudexor-lanes-cfg-"));
  process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = prevConfigDir;
});

describe("lane home paths", () => {
  it("is STABLE across turns of the same lane and DISTINCT per profile/harness/thread", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    const mgr = new WorkspaceManager(repo);

    const a1 = mgr.laneHomeEnv("th-1", "codex", "work");
    const a2 = mgr.laneHomeEnv("th-1", "codex", "work");
    // Same (thread, harness, profile) -> same home across two calls (turns).
    expect(a2.homeDir).toBe(a1.homeDir);

    // Different profile -> different home.
    expect(mgr.laneHomeEnv("th-1", "codex", "personal").homeDir).not.toBe(a1.homeDir);
    // The null engine default is its OWN lane, distinct from a named profile.
    expect(mgr.laneHomeEnv("th-1", "codex", null).homeDir).not.toBe(a1.homeDir);
    // Different harness -> different home.
    expect(mgr.laneHomeEnv("th-1", "claude", "work").homeDir).not.toBe(a1.homeDir);
    // Different thread -> different home.
    expect(mgr.laneHomeEnv("th-2", "codex", "work").homeDir).not.toBe(a1.homeDir);

    // The env scopes HOME + per-harness config dirs, all under the lane home.
    expect(a1.env["HOME"]).toBe(a1.homeDir);
    expect(a1.env["CODEX_HOME"]).toBe(join(a1.homeDir, ".codex"));
    expect(a1.env["CLAUDE_CONFIG_DIR"]).toBe(join(a1.homeDir, ".claude"));
    // Confinement (INV-063): the lane home lives under the project runtime
    // namespace's `lanes/` dir, outside every worktree.
    expect(a1.homeDir).toBe(laneHomeDir(projectRuntimeDir(repo), "th-1", "codex", "work"));
    expect(a1.homeDir.startsWith(join(projectRuntimeDir(repo), "lanes") + "/")).toBe(true);
    expect(existsSync(a1.env["CODEX_HOME"] as string)).toBe(true);
  });

  it("rejects unsafe path segments", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    const mgr = new WorkspaceManager(repo);
    expect(() => mgr.laneHomeEnv("../escape", "codex", null)).toThrow();
    expect(() => mgr.laneHomeEnv("th-1", "co/dex", null)).toThrow();
  });
});

describe("lane lifecycle owners", () => {
  it("purgeThreadLanes removes every lane of one thread and leaves other threads", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    const rt = projectRuntimeDir(repo);
    ensureLaneHomeEnv(rt, "th-1", "codex", "work");
    ensureLaneHomeEnv(rt, "th-1", "claude", null);
    ensureLaneHomeEnv(rt, "th-2", "codex", "work");

    purgeThreadLanes(repo, "th-1");

    expect(existsSync(join(rt, "lanes", "th-1"))).toBe(false);
    expect(existsSync(join(rt, "lanes", "th-2"))).toBe(true);
  });

  it("purgeProfileLanes removes exactly that (harness,profile) lane across threads", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    const rt = projectRuntimeDir(repo);
    ensureLaneHomeEnv(rt, "th-1", "codex", "work");
    ensureLaneHomeEnv(rt, "th-2", "codex", "work");
    ensureLaneHomeEnv(rt, "th-1", "codex", "personal");
    ensureLaneHomeEnv(rt, "th-1", "claude", "work");

    const removed = purgeProfileLanes(repo, "codex", "work");
    expect(removed).toBe(2);

    expect(existsSync(join(rt, "lanes", "th-1", "codex-work"))).toBe(false);
    expect(existsSync(join(rt, "lanes", "th-2", "codex-work"))).toBe(false);
    // A different profile / harness under the same thread is untouched.
    expect(existsSync(join(rt, "lanes", "th-1", "codex-personal"))).toBe(true);
    expect(existsSync(join(rt, "lanes", "th-1", "claude-work"))).toBe(true);
  });

  it("sweepOrphanLanes removes lane dirs whose thread is not live", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    const rt = projectRuntimeDir(repo);
    ensureLaneHomeEnv(rt, "th-live", "codex", null);
    ensureLaneHomeEnv(rt, "th-gone", "codex", null);

    const actions = sweepOrphanLanes(repo, new Set(["th-live"]));

    expect(existsSync(join(rt, "lanes", "th-live"))).toBe(true);
    expect(existsSync(join(rt, "lanes", "th-gone"))).toBe(false);
    expect(actions.some((a) => a.includes("th-gone"))).toBe(true);
  });

  it("does not throw when the lanes root does not exist", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    // Prove the repo has content but NO lanes dir yet.
    writeFileSync(join(repo, "x"), "y");
    expect(() => purgeThreadLanes(repo, "th-1")).not.toThrow();
    expect(purgeProfileLanes(repo, "codex", "work")).toBe(0);
    expect(sweepOrphanLanes(repo, new Set())).toEqual([]);
  });
});

describe("thread continuation-summary cache (INV-137, V9c)", () => {
  it("round-trips a summary and misses on an unknown key", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    expect(readThreadSummary(repo, "th-1", "t5")).toBeNull(); // cold miss
    writeThreadSummary(repo, "th-1", "t5", "cached summary body");
    expect(readThreadSummary(repo, "th-1", "t5")).toBe("cached summary body"); // hit
    expect(readThreadSummary(repo, "th-1", "t6")).toBeNull(); // different key => miss
  });

  it("expires by NEW HEAD: a new collapse boundary is a new key (old entry harmless)", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    writeThreadSummary(repo, "th-1", "t5", "summary up to t5");
    // Head advances → the collapse boundary moves to t7 → a fresh key misses,
    // so the engine recomputes; the t5 entry stays but is never read again.
    expect(readThreadSummary(repo, "th-1", "t7")).toBeNull();
    writeThreadSummary(repo, "th-1", "t7", "summary up to t7");
    expect(readThreadSummary(repo, "th-1", "t5")).toBe("summary up to t5");
    expect(readThreadSummary(repo, "th-1", "t7")).toBe("summary up to t7");
  });

  it("lives under the thread's lane dir, so the lifecycle owners sweep it", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    const rt = projectRuntimeDir(repo);
    writeThreadSummary(repo, "th-1", "t5", "body");
    expect(existsSync(join(rt, "lanes", "th-1", "summaries", "t5.md"))).toBe(true);
    // Thread purge removes the whole `<threadId>` dir — summaries included.
    purgeThreadLanes(repo, "th-1");
    expect(existsSync(join(rt, "lanes", "th-1"))).toBe(false);
    expect(readThreadSummary(repo, "th-1", "t5")).toBeNull();
  });

  it("returns null (never throws) for an unsafe key", () => {
    const repo = reapMk(join(tmpdir(), "claudexor-lanes-repo-"));
    expect(readThreadSummary(repo, "../escape", "t5")).toBeNull();
    expect(readThreadSummary(repo, "th-1", "../escape")).toBeNull();
  });
});
