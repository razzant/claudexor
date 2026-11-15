// #694 r10 stage 2: an isolated thread's preparation owns its resources from
// before its first changing Git step. A stop whose end is not proven leaves the
// tree, its registration and its new branch held; Retry, purge and every reader
// of the path refuse while a READ finds what the stop left still running; once
// it ended, the next turn releases and recreates. Real Git, real processes: the
// survivor is this test's own grandchild (it left Git's group and holds Git's
// stderr, carrying the preparation's scope marker), ended by its exact PID after
// its start time was re-read.
import { execFileSync, spawn } from "node:child_process";
import {
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
import { mintRunScopeMarker, scopeMarkerEnv } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertThreadTreeReady,
  PreparationCleanupFailed,
  PreparationHeld,
  readThreadPreparation,
  threadPreparationRecordPath,
  threadTreeState,
  writeThreadPreparation,
} from "./preparation-hold.js";
import { ensureThreadWorktree, purgeThreadWorktree } from "./thread-tree.js";
import {
  endIdentified,
  startOf as ps,
  type Identity,
} from "../../core/src/test-support/process-fixtures.js";

// The success path's record removal can be made to fail (r10 D).
let refuseRecordRemoval = false;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (refuseRecordRemoval && String(args[0]).endsWith("preparation.json"))
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return fs.unlinkSync(...args);
    },
  };
});

const posix = process.platform !== "win32";
const dirs: string[] = [];
const own: Identity[] = [];
/** End this test's own processes by measured identity (`endIdentified`). */
const endOwn = (): Promise<void> => endIdentified(own);
afterEach(async () => {
  refuseRecordRemoval = false;
  await endOwn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.GIT_CONFIG_COUNT;
}, 0);
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const saved = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...process.env } })
    .toString()
    .trim();
const until = async (what: string, ok: () => boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A project whose `y.held` smudge filter, while `hold` exists, starts a survivor
 * in its own process group holding Git's stderr, reports it, and blocks: as ONE
 * process that replaced the shell and announced itself (`holding`, by rename), so
 * a stop sent after that finds no shell in Git's group (a shell can miss a SIGINT
 * that lands as its foreground child exits, and would stand for a second survivor). */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-custody-")));
  dirs.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitattributes"), "*.held filter=held\n");
  writeFileSync(join(repo, "y.held"), "committed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const hold = join(root, "hold");
  const survivorFile = join(root, "survivor");
  const survivor = join(root, "survivor.cjs");
  writeFileSync(
    survivor,
    `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore',2]});const f=require('node:fs');f.writeFileSync(${JSON.stringify(survivorFile + ".tmp")},String(c.pid));f.renameSync(${JSON.stringify(survivorFile + ".tmp")},${JSON.stringify(survivorFile)});c.unref();`,
  );
  const holding = join(root, "holding");
  const holder = join(root, "hold-until.cjs");
  writeFileSync(
    holder,
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(holding + ".tmp")},'');fs.renameSync(${JSON.stringify(holding + ".tmp")},${JSON.stringify(holding)});const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(root)})){clearInterval(t);process.stdin.pipe(process.stdout);}},20);`,
  );
  const program = join(root, "filter.sh");
  writeFileSync(
    program,
    `#!/bin/sh\nif [ -e '${hold}' ]; then '${process.execPath}' '${survivor}'; exec '${process.execPath}' '${holder}'; fi\nexec cat\n`,
    { mode: 0o755 },
  );
  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_0 = "filter.held.smudge";
  process.env.GIT_CONFIG_VALUE_0 = program;
  process.env.GIT_CONFIG_KEY_1 = "filter.held.clean";
  process.env.GIT_CONFIG_VALUE_1 = "cat";
  const tree = (id: string) => join(projectRuntimeDir(repo), "threads", id, "tree");
  return {
    repo,
    tree,
    hold: () => writeFileSync(hold, ""),
    unhold: () => rmSync(hold, { force: true }),
    survivor: async () => {
      // The PID file is published by rename (whole or absent); the survivor joins
      // this test's custody only with its measured start, and that read must succeed.
      await until("the survivor to report", () => existsSync(survivorFile));
      await until("the filter to hold", () => existsSync(holding));
      const pid = Number(readFileSync(survivorFile, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad survivor pid ${pid}`);
      let start: string | "gone" | null = null;
      await until("the survivor's start time", () => (start = ps(pid)) !== null);
      if (start === "gone") throw new Error(`survivor ${pid} ended before it was identified`);
      own.push({ pid, start: start as unknown as string });
      return pid;
    },
    branch: (id: string) =>
      execFileSync("git", ["-C", repo, "branch", "--list", `claudexor/thread-${id}`])
        .toString()
        .trim(),
    registered: (path: string) =>
      git(repo, "worktree", "list", "--porcelain")
        .split("\n")
        .some((line) => line === `worktree ${path}`),
  };
}

describe.runIf(posix)("thread preparation custody (#694 r10)", () => {
  it("a stop without a proven end holds tree, registration and branch; readers refuse; after the survivor ends the next turn recreates", async () => {
    const w = world();
    const marker = mintRunScopeMarker();
    w.hold();
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      openScope: async () => ({ marker }),
    });
    await w.survivor();
    controller.abort("stop");
    // The preparation itself tried its release after the stop: the survivor still
    // runs, so the stop is refused as held, typed and with what is held.
    const error = await preparing.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreparationHeld);
    expect(error).toMatchObject({
      code: "termination_unconfirmed",
      context: { termination_unconfirmed: { reason: "output_held" }, held: [w.tree("th")] },
    });
    const record = readThreadPreparation(w.tree("th"));
    expect(record).toMatchObject({
      scope: { marker },
      own_registration: true,
      own_branch: { name: "claudexor/thread-th" },
      held: { reason: "output_held" },
    });
    expect(w.branch("th")).toContain("claudexor/thread-th");
    expect(threadTreeState(w.tree("th"))).toBe("held");
    const recordBytes = readFileSync(threadPreparationRecordPath(w.tree("th")), "utf8");

    // Retry, a reader of the recorded path and purge all refuse with the addresses.
    w.unhold();
    const retry = await ensureThreadWorktree(w.repo, "th").catch((e: unknown) => e);
    expect(retry).toBeInstanceOf(PreparationHeld);
    expect(retry).toMatchObject({
      code: "termination_unconfirmed",
      retryable: true,
      context: {
        termination_unconfirmed: { reason: "output_held" },
        held: [w.tree("th")],
        preparation: { tree: w.tree("th"), branch: "claudexor/thread-th" },
      },
    });
    expect(() => assertThreadTreeReady(w.tree("th"))).toThrow(PreparationHeld);
    await expect(purgeThreadWorktree(w.repo, "th")).rejects.toBeInstanceOf(PreparationHeld);
    // A refusal rewrites nothing.
    expect(readFileSync(threadPreparationRecordPath(w.tree("th")), "utf8")).toBe(recordBytes);
    expect(w.branch("th")).toContain("claudexor/thread-th");

    await endOwn();
    const next = await ensureThreadWorktree(w.repo, "th");
    expect(next).toMatchObject({ path: w.tree("th"), created: true });
    expect(threadTreeState(w.tree("th"))).toBe("ready");
    expect(readFileSync(join(w.tree("th"), "y.held"), "utf8")).toBe("committed\n");
  }, 60_000);

  it("a daemon that died midway (record, half checkout, no stop): released only once nothing of its scope runs", async () => {
    const w = world();
    const marker = mintRunScopeMarker();
    const tree = w.tree("crash");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, ".git"), "gitdir: /nowhere\n");
    writeThreadPreparation({
      schema: 1,
      thread_id: "crash",
      tree,
      scope: { marker },
      opened_at: new Date().toISOString(),
      own_registration: true,
      own_branch: null,
    });
    // A writer of that scope (a hook's background process) is still alive.
    const writer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: { ...process.env, ...scopeMarkerEnv(marker) },
      stdio: "ignore",
    });
    let start: string | "gone" | null = null;
    await until("the writer's start time", () => (start = ps(writer.pid!)) !== null);
    if (start === "gone") throw new Error("the writer ended before it was identified");
    own.push({ pid: writer.pid!, start: start as unknown as string });
    // The half checkout is never taken as a tree.
    expect(threadTreeState(tree)).toBe("held");
    await expect(ensureThreadWorktree(w.repo, "crash")).rejects.toBeInstanceOf(PreparationHeld);
    expect(existsSync(join(tree, ".git"))).toBe(true);
    await endOwn();
    await until(
      "the writer to be gone",
      () => writer.exitCode !== null || writer.signalCode !== null,
    );
    const next = await ensureThreadWorktree(w.repo, "crash");
    expect(next.created).toBe(true);
    expect(threadTreeState(tree)).toBe("ready");
  }, 60_000);

  it("a record that cannot be deleted on success fails the preparation, typed, before the tree is handed over; Retry refuses while the fault stands and then hands the same tree over", async () => {
    const w = world();
    refuseRecordRemoval = true;
    const failed = await ensureThreadWorktree(w.repo, "keep").catch((e: unknown) => e);
    // Nothing of this preparation runs (it succeeded): a cleanup fault, not a hold.
    expect(failed).toBeInstanceOf(PreparationCleanupFailed);
    expect(failed).not.toBeInstanceOf(PreparationHeld);
    expect(failed).toMatchObject({
      code: "preparation_cleanup_failed",
      retryable: true,
      requiredActions: [expect.stringMatching(/then retry/)],
      context: {
        held: [w.tree("keep")],
        preparation: {
          complete: true,
          branch: "claudexor/thread-keep",
          cleanup_error: expect.stringMatching(/operation not permitted/),
        },
      },
    });
    expect((failed as PreparationCleanupFailed).context).not.toHaveProperty(
      "termination_unconfirmed",
    );
    // The tree stays unready; its checkout was complete, and the fault is on record.
    expect(threadTreeState(w.tree("keep"))).toBe("held");
    expect(readThreadPreparation(w.tree("keep"))).toMatchObject({
      complete: true,
      cleanup_error: expect.stringMatching(/operation not permitted/),
    });
    writeFileSync(join(w.tree("keep"), "left-in-tree"), "x");
    const bytes = readFileSync(threadPreparationRecordPath(w.tree("keep")), "utf8");
    // Retry while the record cannot be released: the same typed refusal; the
    // complete tree, its registration and its branch are neither taken nor removed.
    const refused = await ensureThreadWorktree(w.repo, "keep").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PreparationCleanupFailed);
    expect(refused).toMatchObject({ code: "preparation_cleanup_failed", retryable: true });
    expect(readFileSync(threadPreparationRecordPath(w.tree("keep")), "utf8")).toBe(bytes);
    // Readers of the tree get that cleanup fault too, not processes to wait for.
    expect(() => assertThreadTreeReady(w.tree("keep"))).toThrow(PreparationCleanupFailed);
    expect(existsSync(join(w.tree("keep"), "left-in-tree"))).toBe(true);
    expect(w.registered(w.tree("keep"))).toBe(true);
    expect(w.branch("keep")).toContain("claudexor/thread-keep");
    // The fault clears: only the record goes and the same tree is handed over
    // (not recreated: a file left in it stays).
    refuseRecordRemoval = false;
    const next = await ensureThreadWorktree(w.repo, "keep");
    expect(next).toMatchObject({ path: w.tree("keep"), created: true });
    expect(threadTreeState(w.tree("keep"))).toBe("ready");
    expect(existsSync(join(w.tree("keep"), "left-in-tree"))).toBe(true);
    expect(w.branch("keep")).toContain("claudexor/thread-keep");
  });

  it("a complete tree held for a member its settlement saw alive, whose end a later read proves while the record cannot be removed: a cleanup refusal, no longer an unconfirmed termination; then the same tree", async () => {
    const w = world();
    const marker = mintRunScopeMarker();
    const unsettled = {
      coverage: "marker+capture",
      census: "ok",
      censusFailure: null,
      ended: [],
      survivors: [{ pid: 4242, startToken: "t" }],
      unreadable: [],
      reusedGroups: [],
      settled: false,
      incomplete: false,
      completeness: "not_provable",
      completenessReason: null,
      restricted: false,
      durationMs: 1,
    } as const;
    const held = await ensureThreadWorktree(w.repo, "c", {
      openScope: async () => ({ marker }),
      settleScope: async () => unsettled as never,
    }).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(PreparationHeld);
    expect(held).toMatchObject({
      code: "termination_unconfirmed",
      context: { termination_unconfirmed: { reason: "scope_unsettled" } },
    });
    writeFileSync(join(w.tree("c"), "kept"), "x");
    // The member has ended (the read says so); the record's removal is refused.
    refuseRecordRemoval = true;
    const quiet = async () => ({ status: "quiet" as const });
    const refused = await ensureThreadWorktree(w.repo, "c", { quiet }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PreparationCleanupFailed);
    expect(refused).toMatchObject({
      code: "preparation_cleanup_failed",
      retryable: true,
      context: { preparation: { complete: true, scope_marker: marker } },
    });
    expect((refused as PreparationCleanupFailed).context).not.toHaveProperty(
      "termination_unconfirmed",
    );
    expect(readThreadPreparation(w.tree("c"))).toMatchObject({
      complete: true,
      held: { reason: "scope_unsettled" },
      cleanup_error: expect.stringMatching(/operation not permitted/),
    });
    expect(existsSync(join(w.tree("c"), "kept"))).toBe(true);
    refuseRecordRemoval = false;
    const next = await ensureThreadWorktree(w.repo, "c", { quiet });
    expect(next).toMatchObject({ path: w.tree("c"), created: true });
    expect(existsSync(join(w.tree("c"), "kept"))).toBe(true);
    expect(w.registered(w.tree("c"))).toBe(true);
    expect(w.branch("c")).toContain("claudexor/thread-c");
  });
});
