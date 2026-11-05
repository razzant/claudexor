import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  envelopeBaseOf,
  processStartTime,
  readEnvelopeCustody,
  WorkspaceManager,
} from "@claudexor/workspace";
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

describe("crash-GC stays inside the namespace it sweeps (#503)", () => {
  /** A dead run's disposable orphan: a link is the only way to reach one in another store. */
  function orphan(workspaces: string, taskId: string, executionRoot: string): string {
    const base = join(workspaces, taskId, "a01");
    mkdirSync(join(base, "home"), { recursive: true });
    writeFileSync(join(base, "home", "kept.txt"), "another store's bytes\n");
    writeFileSync(
      join(base, "owner.json"),
      JSON.stringify({
        pid: 999_999_990,
        started: "Thu Jan  1 00:00:00 1970",
        created_at: new Date().toISOString(),
        envelope_id: `env-${taskId}`,
        workspace_mode: "in_place",
        execution_root: executionRoot,
      }) + "\n",
    );
    return base;
  }
  const namespaces = {
    "one-shot": { runtime: () => oneShotRuntimeDir(), roots: () => [] as string[] },
    project: {
      runtime: (tree: string) => projectRuntimeDir(tree),
      roots: (tree: string) => [tree],
    },
  };
  async function inStores(
    run: (stores: { other: string; tree: string }) => Promise<void>,
  ): Promise<void> {
    const config = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-sweep-swept-")));
    const other = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-sweep-other-")));
    const tree = initRepo();
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", config);
    try {
      await run({ other, tree });
    } finally {
      vi.unstubAllEnvs();
      for (const path of [config, other, tree]) rmSync(path, { recursive: true, force: true });
    }
  }

  it.each(["one-shot", "project"] as const)(
    "keeps a linked task directory of a %s namespace and still disposes its plain sibling",
    (kind) =>
      inStores(async ({ other, tree }) => {
        const namespace = namespaces[kind];
        const workspaces = join(namespace.runtime(tree), "workspaces");
        const target = orphan(join(other, "workspaces"), "task-linked", tree);
        const plain = orphan(workspaces, "task-plain", tree);
        const link = join(workspaces, "task-linked");
        symlinkSync(join(other, "workspaces", "task-linked"), link);

        const actions = await sweepOrphanWorkspaces({
          knownProjectRoots: () => namespace.roots(tree),
        });

        expect(readFileSync(join(target, "home", "kept.txt"), "utf8")).toContain("another store");
        expect(existsSync(join(target, "owner.json"))).toBe(true);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(actions).toContain(
          `kept envelope task-linked under ${namespace.runtime(tree)}: not a plain directory`,
        );
        expect(existsSync(plain)).toBe(false);
        expect(actions).toContain(`disposed orphan envelope task-plain/a01 under ${tree}`);
      }),
  );

  it("never recovers custody through a linked attempt, in place or in the other store", () =>
    inStores(async ({ other, tree }) => {
      const swept = process.env.CLAUDEXOR_CONFIG_DIR!;
      // An interrupted run of the OTHER store: live custody, a changed tree, an auth file.
      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", other);
      const runDir = join(other, "holder-run");
      mkdirSync(runDir);
      const env = await new WorkspaceManager(tree).create({
        taskId: "task-linked",
        attemptId: "a01",
        baseRef: "HEAD",
        custody: { runId: "run-other", runDir },
      });
      const base = envelopeBaseOf(env);
      writeFileSync(join(env.worktree_path, "a.txt"), "their edit\n");
      const auth = join(env.harness_config_dirs["codex_home"]!, "auth.json");
      mkdirSync(join(auth, ".."), { recursive: true });
      writeFileSync(auth, "{}");
      writeFileSync(
        join(base, "owner.json"),
        JSON.stringify({ pid: 999_999_990, started: "Thu Jan  1 00:00:00 1970" }) + "\n",
      );
      const custody = readEnvelopeCustody(base);
      expect(custody?.state).toBe("live");

      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", swept);
      const task = join(projectRuntimeDir(tree), "workspaces", "task-linked");
      mkdirSync(task, { recursive: true });
      const link = join(task, "a01");
      symlinkSync(base, link);

      const actions = await sweepOrphanWorkspaces({ knownProjectRoots: () => [tree] });

      expect(readEnvelopeCustody(base)).toEqual(custody);
      expect(existsSync(auth)).toBe(true);
      expect(existsSync(join(runDir, "final"))).toBe(false);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(actions).toContain(
        `kept envelope task-linked/a01 under ${projectRuntimeDir(tree)}: not a plain directory`,
      );
    }));
});

describe("crash-GC follows no link below the config root (#503)", () => {
  const LINK_REFUSED = "daemon-owned runtime path is a link; refusing to follow it";
  const attemptBranches = (repo: string) =>
    execFileSync("git", ["-C", repo, "branch", "--list", "claudexor/*"], { encoding: "utf8" });
  /** A dead run's orphan whose bytes a followed link would delete. */
  function orphanAt(workspaces: string, taskId: string, executionRoot: string): string {
    const base = join(workspaces, taskId, "a01");
    mkdirSync(join(base, "home"), { recursive: true });
    writeFileSync(join(base, "home", "kept.txt"), "another store's bytes\n");
    writeFileSync(
      join(base, "owner.json"),
      JSON.stringify({
        pid: 999_999_990,
        started: "Thu Jan  1 00:00:00 1970",
        envelope_id: `env-${taskId}`,
        workspace_mode: "in_place",
        execution_root: executionRoot,
      }) + "\n",
    );
    return base;
  }
  /** Real private stores on both sides of each link; nothing here is the operator's. */
  async function inStores(
    run: (stores: { config: string; other: string; tree: string; plain: string }) => Promise<void>,
  ): Promise<void> {
    const config = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-links-swept-")));
    const other = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-links-other-")));
    const tree = realpathSync(initRepo());
    const plain = realpathSync(initRepo());
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", config);
    try {
      await run({ config, other, tree, plain });
    } finally {
      vi.unstubAllEnvs();
      for (const path of [config, other, tree, plain])
        rmSync(path, { recursive: true, force: true });
    }
  }
  const linkTo: Record<string, (namespace: string, target: string) => void> = {
    "its workspaces directory": (namespace, target) => {
      mkdirSync(namespace, { recursive: true });
      symlinkSync(join(target, "workspaces"), join(namespace, "workspaces"));
    },
    "the namespace itself": (namespace, target) => {
      mkdirSync(dirname(namespace), { recursive: true });
      symlinkSync(target, namespace);
    },
  };

  it.each(Object.keys(linkTo))(
    "keeps what a project reaches through %s, and still sweeps a plain project",
    (kind) =>
      inStores(async ({ other, tree, plain }) => {
        const namespace = projectRuntimeDir(tree);
        const target = orphanAt(join(other, "workspaces"), "task-linked", tree);
        linkTo[kind]!(namespace, other);
        const neighbour = orphanAt(
          join(projectRuntimeDir(plain), "workspaces"),
          "task-plain",
          plain,
        );

        const actions = await sweepOrphanWorkspaces({ knownProjectRoots: () => [tree, plain] });

        expect(readFileSync(join(target, "home", "kept.txt"), "utf8")).toContain("another store");
        expect(actions.join("\n")).toContain(`kept namespace ${namespace}: ${LINK_REFUSED}`);
        expect(actions.filter((action) => action.includes("task-linked"))).toEqual([]);
        expect(existsSync(neighbour)).toBe(false);
        expect(actions).toContain(`disposed orphan envelope task-plain/a01 under ${plain}`);
      }),
  );

  it("keeps what a delegated execution root reaches through a link", () =>
    inStores(async ({ other, tree }) => {
      const target = orphanAt(join(other, "workspaces"), "task-linked", tree);
      linkTo["its workspaces directory"]!(projectRuntimeDir(tree), other);
      const actions = await sweepOrphanWorkspaces({
        knownProjectRoots: () => [],
        knownExecutionRoots: () => [tree],
      });
      expect(existsSync(target)).toBe(true);
      expect(actions.join("\n")).toContain(LINK_REFUSED);
    }));

  it("keeps everything behind a linked projects directory, and sweeps the one-shot store", () =>
    inStores(async ({ config, other, tree }) => {
      const digest = basename(projectRuntimeDir(tree));
      const target = orphanAt(join(other, "projects", digest, "workspaces"), "task-linked", tree);
      symlinkSync(join(other, "projects"), join(config, "projects"));
      const oneShot = orphanAt(join(oneShotRuntimeDir(), "workspaces"), "task-one", tree);
      const actions = await sweepOrphanWorkspaces({ knownProjectRoots: () => [tree] });
      expect(existsSync(target)).toBe(true);
      expect(actions.join("\n")).toContain(LINK_REFUSED);
      expect(existsSync(oneShot)).toBe(false);
    }));

  it.each(["workspaces", "workspaces/task-held", "workspaces/task-held/a01"])(
    "leaves a project's branches alone when a dangling %s link hides ownership",
    (linked) =>
      inStores(async ({ other, tree }) => {
        execFileSync("git", ["-C", tree, "branch", "claudexor/task-held/a01"]);
        // The linked disk is away: every envelope behind it merely looks absent.
        const namespace = projectRuntimeDir(tree);
        const link = join(namespace, linked);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(join(other, "unmounted"), link);
        await sweepOrphanWorkspaces({ knownProjectRoots: () => [tree] });
        expect(attemptBranches(tree)).toContain("claudexor/task-held/a01");
      }),
  );

  it.each([
    ["the threads directory", "threads"],
    ["a thread's directory", "threads/th-linked"],
    ["a thread's worktree", "threads/th-linked/tree"],
  ])("deletes no branch in another repository through %s", (_kind, linked) =>
    inStores(async ({ other, tree }) => {
      // A repository the link reaches, with what would read here as attempt debris.
      const foreign = join(other, "threads", "th-linked", "tree");
      mkdirSync(dirname(foreign), { recursive: true });
      renameSync(initRepo(), foreign);
      execFileSync("git", ["-C", foreign, "branch", "claudexor/task-foreign/a01"]);
      execFileSync("git", ["-C", foreign, "branch", "claudexor/verify-foreign"]);
      const link = join(projectRuntimeDir(tree), linked);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(other, linked), link);

      const actions = await sweepOrphanWorkspaces({ knownProjectRoots: () => [tree] });

      expect(attemptBranches(foreign)).toContain("claudexor/task-foreign/a01");
      expect(attemptBranches(foreign)).toContain("claudexor/verify-foreign");
      expect(actions.join("\n")).toContain(LINK_REFUSED);
    }),
  );

  it("still sweeps a plain thread tree and its namespace beside the fence", () =>
    inStores(async ({ tree }) => {
      const worktree = join(projectRuntimeDir(tree), "threads", "th-plain", "tree");
      mkdirSync(dirname(worktree), { recursive: true });
      renameSync(initRepo(), worktree);
      execFileSync("git", ["-C", worktree, "branch", "claudexor/task-gone/a01"]);
      const orphan = orphanAt(join(projectRuntimeDir(worktree), "workspaces"), "task-t", worktree);
      await sweepOrphanWorkspaces({ knownProjectRoots: () => [tree] });
      expect(existsSync(orphan)).toBe(false);
      expect(attemptBranches(worktree)).not.toContain("claudexor/task-gone/a01");
    }));

  it("still sweeps under a config root that is itself a link, at the path recorded there", () =>
    inStores(async ({ config, other, tree }) => {
      const relocated = join(other, "config-link");
      symlinkSync(config, relocated);
      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", relocated);
      const env = await new WorkspaceManager(tree).create({
        taskId: "task-relocated",
        attemptId: "a01",
        baseRef: "HEAD",
      });
      const base = envelopeBaseOf(env);
      expect(base.startsWith(relocated)).toBe(true);
      const owner = JSON.parse(readFileSync(join(base, "owner.json"), "utf8")) as object;
      writeFileSync(
        join(base, "owner.json"),
        JSON.stringify({ ...owner, pid: 999_999_990, started: "Thu Jan  1 00:00:00 1970" }),
      );

      const actions = await sweepOrphanWorkspaces({ knownProjectRoots: () => [tree] });

      expect(actions).toContain(`disposed orphan envelope task-relocated/a01 under ${tree}`);
      expect(existsSync(base)).toBe(false);
      expect(attemptBranches(tree)).not.toContain("claudexor/task-relocated/a01");
      expect(actions.join("\n")).not.toContain(LINK_REFUSED);
    }));

  it("still disposes against the recorded execution root of a project's own namespace", () =>
    inStores(async ({ tree, plain }) => {
      const logical = orphanAt(join(projectRuntimeDir(tree), "workspaces"), "task-exec", plain);
      const actions = await sweepOrphanWorkspaces({ knownProjectRoots: () => [tree] });
      expect(existsSync(logical)).toBe(false);
      expect(actions).toContain(`disposed orphan envelope task-exec/a01 under ${plain}`);
      expect(readFileSync(join(plain, "a.txt"), "utf8")).toBe("a\n");
    }));
});

describe("crash-GC of a thread's unregistered namespace (#503)", () => {
  it("disposes an orphan while its recorded root exists, and has no reach once it is gone", async () => {
    const root = initRepo();
    const knownProjectRoots = () => [root];
    try {
      const reached = envelope(root, "task-reached", "a01");
      await sweepOrphanWorkspaces({ knownProjectRoots });
      expect(existsSync(reached)).toBe(false);
      // The limitation: such an orphan keeps the namespace until an operator acts.
      const stranded = envelope(root, "task-stranded", "a01");
      rmSync(root, { recursive: true, force: true });
      const actions = await sweepOrphanWorkspaces({ knownProjectRoots });
      expect(existsSync(stranded)).toBe(true);
      expect(actions.filter((action) => action.includes("task-stranded"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(projectRuntimeDir(root), { recursive: true, force: true });
    }
  });
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
