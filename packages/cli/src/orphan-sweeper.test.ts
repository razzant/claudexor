import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTime, WorkspaceManager } from "@claudexor/workspace";
import { oneShotRuntimeDir, projectRuntimeDir } from "@claudexor/util";
import { commandExecutionRoots, commandScopeRoots } from "@claudexor/daemon";
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

function envelope(
  root: string,
  taskId: string,
  attemptId: string,
  owner?: { pid: number; started: string | null },
): string {
  const base = join(projectRuntimeDir(root), "workspaces", taskId, attemptId);
  mkdirSync(join(base, "tree"), { recursive: true });
  mkdirSync(join(base, "home"), { recursive: true });
  writeFileSync(join(base, "tree", "work.txt"), "in flight\n");
  if (owner) {
    writeFileSync(
      join(base, "owner.json"),
      JSON.stringify({ ...owner, created_at: new Date().toISOString() }) + "\n",
    );
  }
  return base;
}

/** The composition root hands the sweep the scope roots of the ALREADY
 * PREPARED global command projection — never a second journal replay. */
function recordProject(root: string): () => string[] {
  return () => commandScopeRoots([{ params: { scope: { kind: "project", root } } }]);
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
      const dead = envelope(root, "task-dead", "a01", {
        pid: 999_999_990,
        started: "Thu Jan  1 00:00:00 1970",
      });
      // Legacy envelope without a marker: swept (pre-marker debris).
      const legacy = envelope(root, "task-legacy", "a01");

      const knownProjectRoots = recordProject(root);
      const actions = await sweepOrphanWorkspaces({ knownProjectRoots });

      expect(existsSync(live)).toBe(true);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(legacy)).toBe(false);
      expect(
        actions.some((a) => a.includes("kept envelope task-live/a01") && a.includes("live owner")),
      ).toBe(true);
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
      const staleBase = join(projectRuntimeDir(root), "workspaces", "task-stale", "a01");
      // Freshness = newest mtime across base + working dirs; age them ALL.
      for (const path of [
        join(staleBase, "tree", "work.txt"),
        join(staleBase, "tree"),
        join(staleBase, "home"),
        join(staleBase, "owner.json"),
        staleBase,
      ]) {
        utimesSync(path, old, old);
      }
      const knownProjectRoots = recordProject(root);
      // Inverse case: dirs are OLD but one nested file is fresh — editing an
      // existing file bumps only the file's mtime, and that must count as
      // liveness (the walk looks at files, not just directory entries).
      const nested = envelope(root, "task-nested", "a01", { pid: process.pid, started: null });
      for (const path of [
        join(nested, "tree"),
        join(nested, "home"),
        join(nested, "owner.json"),
        nested,
      ]) {
        utimesSync(path, old, old);
      }
      // tree/work.txt keeps its fresh mtime (just created).
      await sweepOrphanWorkspaces({ knownProjectRoots });
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("is strictly read-only on a clean root: no journal file is created and nothing is swept (C1b)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "claudexor-sweep-state-"));
    try {
      // A FRESH root has no journal tree at all. The sweep runs between the
      // startup's read-only preparation and its prepared activation, so any
      // file it creates here fails activation's revalidation and traps the
      // root on the recovery plane.
      const journalRoot = join(realpathSync(stateDir), "journal");
      const actions = await sweepOrphanWorkspaces({
        // An unreadable command projection means no sweep, never a journal read.
        knownProjectRoots: () => {
          throw new Error("global command projection unavailable");
        },
      });
      // No project root is known on a clean root, so no envelope/branch action
      // may appear (the shared tmpdir ro-home sweep is environment-owned).
      expect(actions.filter((action) => !action.includes("stale tmp dir"))).toEqual([]);
      expect(existsSync(journalRoot)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("startup sweep removes a dead in-place run's marked artifact child and preserves siblings", async () => {
    const root = initRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "claudexor-sweep-state-"));
    try {
      const artifactRoot = join(root, ".claudexor-artifacts");
      mkdirSync(artifactRoot);
      const userFile = join(artifactRoot, "user-notes.txt");
      writeFileSync(userFile, "preserve me\n");
      const manager = new WorkspaceManager(root);
      const env = await manager.create({
        taskId: "task-inplace-orphan",
        attemptId: "a01",
        inPlace: true,
      });
      const owned = manager.ensureArtifactDirectory(env);
      writeFileSync(join(owned, "shot.png"), Buffer.from([0x89, 0x50]));
      const base = join(projectRuntimeDir(root), "workspaces", "task-inplace-orphan", "a01");
      const ownerPath = join(base, "owner.json");
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          ...owner,
          pid: 999_999_990,
          started: "Thu Jan  1 00:00:00 1970",
        })}\n`,
      );
      const knownProjectRoots = recordProject(root);

      const actions = await sweepOrphanWorkspaces({ knownProjectRoots });

      expect(actions.some((action) => action.includes("task-inplace-orphan/a01"))).toBe(true);
      expect(existsSync(base)).toBe(false);
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(artifactRoot)).toBe(true);
      expect(readFileSync(userFile, "utf8")).toBe("preserve me\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("commandScopeRoots", () => {
  it("collects unique project scope roots from accepted command records only", () => {
    expect(
      commandScopeRoots([
        { params: { scope: { kind: "project", root: "/a" } } },
        { params: { scope: { kind: "project", root: "/a" } } },
        { params: { scope: { kind: "project", root: "/b", ephemeral: true } } },
        { params: { scope: { kind: "none" } } },
        { params: { scope: { kind: "project", root: 7 } } },
        { params: "not an object" },
        {},
      ]),
    ).toEqual(["/a", "/b"]);
  });
});

describe("crash-GC of the one-shot namespace (#503)", () => {
  /** An orphan a one-shot run left: its record names its execution root, its owner is dead. */
  function oneShotEnvelope(store: string, executionRoot: string): string {
    const base = join(store, "workspaces", "task-one", "a01");
    mkdirSync(join(base, "home"), { recursive: true });
    writeFileSync(
      join(base, "owner.json"),
      JSON.stringify({
        pid: 999_999_990,
        started: "Thu Jan  1 00:00:00 1970",
        created_at: new Date().toISOString(),
        envelope_id: "env-one",
        workspace_mode: "in_place",
        execution_root: executionRoot,
      }) + "\n",
    );
    return base;
  }
  const inConfig = async (run: (config: string, tree: string) => Promise<void>) => {
    const config = mkdtempSync(join(tmpdir(), "claudexor-sweep-config-"));
    const tree = initRepo();
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", config);
    try {
      await run(config, tree);
    } finally {
      vi.unstubAllEnvs();
      rmSync(config, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  };
  const sweep = () => sweepOrphanWorkspaces({ knownProjectRoots: () => [] });

  it("disposes an orphan of the plain store", () =>
    inConfig(async (_config, tree) => {
      const base = oneShotEnvelope(oneShotRuntimeDir(), tree);
      const actions = await sweep();
      expect(existsSync(base)).toBe(false);
      expect(actions).toContain(`disposed orphan envelope task-one/a01 under ${tree}`);
    }));

  it("never follows a linked store, and leaves what it links to intact", () =>
    inConfig(async (config, tree) => {
      const moved = join(config, "another-store");
      const base = oneShotEnvelope(moved, tree);
      symlinkSync(moved, oneShotRuntimeDir());
      const actions = await sweep();
      expect(existsSync(base)).toBe(true);
      expect(actions).toContain(`kept namespace ${oneShotRuntimeDir()}: not a plain directory`);
      expect(actions.filter((action) => action.includes("task-one"))).toEqual([]);
    }));

  it("never follows a linked workspaces directory of a plain store", () =>
    inConfig(async (config, tree) => {
      const moved = join(config, "another-store");
      const base = oneShotEnvelope(moved, tree);
      mkdirSync(oneShotRuntimeDir());
      const linked = join(oneShotRuntimeDir(), "workspaces");
      symlinkSync(join(moved, "workspaces"), linked);
      const actions = await sweep();
      expect(existsSync(base)).toBe(true);
      expect(actions).toContain(`kept namespace ${linked}: not a plain directory`);
      expect(actions.filter((action) => action.includes("task-one"))).toEqual([]);
    }));
});

describe("crash-GC reach into caller-owned execution roots", () => {
  it("disposes only Claudexor scratch under a delegated root, never the caller's tree or refs", async () => {
    const copy = initRepo();
    try {
      // A caller ref shaped like attempt debris: under a SCOPE root the branch
      // sweep would delete it; under a caller-owned execution root it is not
      // Claudexor's to collect.
      execFileSync("git", ["-C", copy, "branch", "claudexor/task-gone/a01"]);
      const base = join(projectRuntimeDir(copy), "workspaces", "task-del", "a01");
      mkdirSync(join(base, "home"), { recursive: true });
      writeFileSync(
        join(base, "owner.json"),
        JSON.stringify({
          pid: 999_999_990,
          started: "Thu Jan  1 00:00:00 1970",
          created_at: new Date().toISOString(),
          envelope_id: "env-del",
          workspace_mode: "in_place",
        }) + "\n",
      );
      const actions = await sweepOrphanWorkspaces({
        knownProjectRoots: () => [],
        knownExecutionRoots: () =>
          commandExecutionRoots([
            {
              params: {
                scope: { kind: "project", root: "/author" },
                execution: { workspaceRoot: copy },
              },
            },
          ]),
      });
      expect(existsSync(base)).toBe(false);
      expect(actions.some((a) => a.includes("disposed orphan envelope task-del/a01"))).toBe(true);
      expect(
        execFileSync("git", ["-C", copy, "branch", "--list", "claudexor/*"], { encoding: "utf8" }),
      ).toContain("claudexor/task-gone/a01");
      expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("a\n");
    } finally {
      rmSync(copy, { recursive: true, force: true });
      rmSync(projectRuntimeDir(copy), { recursive: true, force: true });
    }
  });
});
