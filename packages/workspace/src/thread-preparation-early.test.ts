// #694: an isolated thread's preparation is recorded before its FIRST Git step
// (the project's initialization, the base snapshot with the user's clean
// filters, the lookups), not only before the step that changes the thread. A
// stop there whose end was not proven leaves that early record: Retry refuses
// without a second snapshot until what the stop left has ended, and nothing
// that was there before the preparation is removed. A failed preparation
// settles its scope first and then releases once. Real Git, real processes:
// a survivor is this test's own grandchild (it left Git's group and carries
// the preparation's scope marker), ended by its exact PID after its start time
// was re-read.
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
import { dirname, join } from "node:path";
import { mintRunScopeMarker, preparationQuiet, type ScopeReapOutcome } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PreparationCancelled } from "./git-run.js";
import {
  assertThreadTreeReady,
  PreparationCleanupFailed,
  PreparationHeld,
  readThreadPreparation,
  threadPreparationRecordPath,
  threadTreeState,
  type PreparationQuietRead,
} from "./preparation-hold.js";
import { ensureThreadWorktree, purgeThreadWorktree } from "./thread-tree.js";
import {
  endIdentified,
  startOf as ps,
  type Identity,
} from "../../core/src/test-support/process-fixtures.js";

// The record's write can be made to fail (a durable record that cannot be made),
// and so can its removal alone (a record that cannot be released).
let refuseRecordWrite = false;
let refuseRecordRemoval = false;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (refuseRecordWrite && String(args[0]).includes("preparation.json"))
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return fs.writeFileSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (refuseRecordRemoval && String(args[0]).endsWith("preparation.json"))
        throw Object.assign(new Error("EPERM: operation not permitted, unlink"), {
          code: "EPERM",
        });
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
  refuseRecordWrite = false;
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
/** The release criterion as shipped. */
const patientQuiet: PreparationQuietRead = (facts) => preparationQuiet(facts);
/** The same with a short bound, for a read that is expected to find a member
 * alive (it waits its whole bound for that member). */
const shortQuiet: PreparationQuietRead = (facts) => preparationQuiet(facts, { deadlineMs: 800 });

/** The held part of a fixture filter: ONE process that announces itself
 * (`holding`, by rename), waits for `release` (or for its test directory to go)
 * and then passes its input through. A signal sent to its group ends it at once.
 * A `/bin/sh` loop of short `sleep`s does not do that reliably: the shell can miss
 * a SIGINT that lands just as a foreground child exits, and would then stand for
 * a survivor no test meant. For the same
 * reason a test stops only once the holder announced itself: then no shell is
 * left in Git's group. */
const HOLD_JS =
  "const fs=require('node:fs');const [release,root,holding]=process.argv.slice(2);" +
  "fs.writeFileSync(holding+'.tmp','');fs.renameSync(holding+'.tmp',holding);" +
  "const t=setInterval(()=>{if((release&&fs.existsSync(release))||!fs.existsSync(root)){" +
  "clearInterval(t);process.stdin.pipe(process.stdout);}},20);";
/** Write that program under `root`; returns the shell words that `exec` it. */
function holdUntil(root: string, release: string): string {
  const program = join(root, "hold-until.cjs");
  writeFileSync(program, HOLD_JS);
  return `exec '${process.execPath}' '${program}' '${release}' '${root}' '${join(root, "holding")}'`;
}

/**
 * A project (a plain folder when `plain`) with an untracked `y.held` whose
 * REQUIRED `held` filter is driven by flag files:
 * - clean (the project's initialization and the base snapshot run it): logs each
 *   run; `clean-fail` fails it; `clean-hold` starts a survivor in its own
 *   process group holding Git's stderr, reports it and blocks; `clean-block`
 *   only blocks (it dies with Git's group);
 * - smudge (the checkout runs it): `smudge-fail` starts a quiet survivor (own
 *   group, no pipe of Git's) and fails the checkout.
 */
function world(plain = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-early-")));
  dirs.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  writeFileSync(join(repo, ".gitattributes"), "*.held filter=held\n");
  writeFileSync(join(repo, "a.txt"), "plain\n");
  if (!plain) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
  }
  writeFileSync(join(repo, "y.held"), "user data\n"); // untracked: cleaned by the first add
  const flag = (name: string) => join(root, name);
  const survivorFile = join(root, "survivor");
  const survivor = (stderr: "2" | "'ignore'") => {
    const program = join(root, `survivor-${stderr === "2" ? "loud" : "quiet"}.cjs`);
    writeFileSync(
      program,
      `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore',${stderr}]});const f=require('node:fs');f.writeFileSync(${JSON.stringify(survivorFile + ".tmp")},String(c.pid));f.renameSync(${JSON.stringify(survivorFile + ".tmp")},${JSON.stringify(survivorFile)});c.unref();`,
    );
    return program;
  };
  const log = join(root, "clean.log");
  const clean = join(root, "clean.sh");
  writeFileSync(
    clean,
    `#!/bin/sh\necho run >> '${log}'\nif [ -e '${flag("clean-fail")}' ]; then exit 1; fi\nif [ -e '${flag("clean-hold")}' ]; then '${process.execPath}' '${survivor("2")}'; fi\nif [ -e '${flag("clean-hold")}' ] || [ -e '${flag("clean-block")}' ]; then ${holdUntil(root, "")}; fi\nexec cat\n`,
    { mode: 0o755 },
  );
  const smudge = join(root, "smudge.sh");
  writeFileSync(
    smudge,
    `#!/bin/sh\nif [ -e '${flag("smudge-fail")}' ]; then '${process.execPath}' '${survivor("'ignore'")}'; exit 1; fi\nexec cat\n`,
    { mode: 0o755 },
  );
  process.env.GIT_CONFIG_COUNT = "3";
  process.env.GIT_CONFIG_KEY_0 = "filter.held.clean";
  process.env.GIT_CONFIG_VALUE_0 = clean;
  process.env.GIT_CONFIG_KEY_1 = "filter.held.smudge";
  process.env.GIT_CONFIG_VALUE_1 = smudge;
  process.env.GIT_CONFIG_KEY_2 = "filter.held.required";
  process.env.GIT_CONFIG_VALUE_2 = "true";
  const tree = (id: string) => join(projectRuntimeDir(repo), "threads", id, "tree");
  return {
    repo,
    tree,
    record: (id: string) => threadPreparationRecordPath(tree(id)),
    set: (name: string) => writeFileSync(flag(name), ""),
    clear: (name: string) => rmSync(flag(name), { force: true }),
    /** How many times the clean filter ran (each snapshot or initialization add runs it). */
    cleanRuns: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0),
    survivor: async () => {
      // Published by rename (whole or absent); it joins this test's custody only
      // with its measured start, and that read must succeed.
      await until("the survivor to report", () => existsSync(survivorFile));
      // A holding filter has replaced its shell before anything is stopped.
      if (existsSync(flag("clean-hold"))) {
        await until("the filter to hold", () => existsSync(join(root, "holding")));
        rmSync(join(root, "holding"), { force: true });
      }
      const pid = Number(readFileSync(survivorFile, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad survivor pid ${pid}`);
      let start: string | "gone" | null = null;
      await until("the survivor's start time", () => (start = ps(pid)) !== null);
      if (start === "gone") throw new Error(`survivor ${pid} ended before it was identified`);
      own.push({ pid, start: start as unknown as string });
      rmSync(survivorFile, { force: true });
      return pid;
    },
    branch: (id: string) => git(repo, "branch", "--list", `claudexor/thread-${id}`),
    registered: (id: string) =>
      git(repo, "worktree", "list", "--porcelain")
        .split("\n")
        .some((line) => line === `worktree ${tree(id)}`),
  };
}

/** A runner's scope as the test drives it: counts its openings and settlements
 * and logs the order of settlement and release reads. */
function scope(settle?: () => Promise<void>, read: PreparationQuietRead = patientQuiet) {
  const marker = mintRunScopeMarker();
  const order: string[] = [];
  let opened = 0;
  return {
    marker,
    order,
    opened: () => opened,
    options: {
      openScope: async () => {
        opened += 1;
        return { marker };
      },
      ...(settle
        ? {
            settleScope: async (): Promise<ScopeReapOutcome | null> => {
              order.push("settle");
              await settle();
              return null;
            },
          }
        : {}),
      quiet: ((facts) => {
        order.push("quiet");
        return read(facts);
      }) as PreparationQuietRead,
    },
  };
}

describe.runIf(posix)("early thread preparation custody (#694)", () => {
  it("a Stop during the base snapshot without a proven end: the early record holds, Retry refuses without a second snapshot, and the writer's end lets Retry make the tree", async () => {
    const w = world();
    const first = scope(undefined, shortQuiet);
    w.set("clean-hold");
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      ...first.options,
    });
    const survivor = await w.survivor();
    // The record exists while the snapshot still runs: before the stop, and
    // before anything of the thread (tree, registration, branch) was made.
    expect(readThreadPreparation(w.tree("th"))).toMatchObject({
      early: true,
      scope: { marker: first.marker },
      own_registration: null,
      own_branch: null,
    });
    expect(w.cleanRuns()).toBe(1);
    controller.abort("stop");
    const stopped = await preparing.catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(PreparationHeld);
    expect(stopped).toMatchObject({
      code: "termination_unconfirmed",
      retryable: true,
      context: {
        termination_unconfirmed: { reason: "output_held" },
        preparation: { early: true, scope_marker: first.marker, record: w.record("th") },
      },
    });
    expect(ps(survivor)).not.toBe("gone");
    const bytes = readFileSync(w.record("th"), "utf8");
    expect(JSON.parse(bytes)).toMatchObject({ early: true, held: { reason: "output_held" } });
    expect(existsSync(w.tree("th"))).toBe(false);
    expect(w.branch("th")).toBe("");
    expect(w.registered("th")).toBe(false);

    // Retry and every reader refuse: no new scope, no second snapshot, nothing rewritten.
    w.clear("clean-hold");
    const retry = scope(undefined, shortQuiet);
    const refused = await ensureThreadWorktree(w.repo, "th", retry.options).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(PreparationHeld);
    expect(refused).toMatchObject({ code: "termination_unconfirmed", retryable: true });
    expect(retry.opened()).toBe(0);
    expect(w.cleanRuns()).toBe(1);
    expect(threadTreeState(w.tree("th"))).toBe("held");
    expect(() => assertThreadTreeReady(w.tree("th"))).toThrow(PreparationHeld);
    await expect(purgeThreadWorktree(w.repo, "th", { quiet: shortQuiet })).rejects.toBeInstanceOf(
      PreparationHeld,
    );
    expect(readFileSync(w.record("th"), "utf8")).toBe(bytes);
    expect(ps(survivor)).not.toBe("gone"); // a refusal signals nothing

    // The writer ends: the next attempt frees the record and makes the tree.
    await endOwn();
    const next = scope();
    const made = await ensureThreadWorktree(w.repo, "th", next.options);
    expect(made).toMatchObject({ path: w.tree("th"), created: true });
    expect(next.opened()).toBe(1);
    expect(threadTreeState(w.tree("th"))).toBe("ready");
    expect(readFileSync(join(w.tree("th"), "y.held"), "utf8")).toBe("user data\n");
  }, 90_000);

  it("a Stop whose survivor the scope's settlement then ends is an ordinary Stop: settled first, released by one read, nothing left", async () => {
    const w = world();
    const s = scope(endOwn);
    w.set("clean-hold");
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      ...s.options,
    });
    const survivor = await w.survivor();
    controller.abort("stop");
    const stopped = await preparing.catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(PreparationCancelled);
    expect(s.order).toEqual(["settle", "quiet"]);
    expect(ps(survivor)).toBe("gone");
    expect(existsSync(w.record("th"))).toBe(false);
    expect(existsSync(dirname(w.tree("th")))).toBe(false);
  }, 60_000);

  it("a confirmed Stop and an ordinary failure before the thread changed settle, release and leave no record or thread directory", async () => {
    const w = world();
    // A stop the snapshot's Git and its filter end with (no survivor).
    const stop = scope(async () => {});
    w.set("clean-block");
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      ...stop.options,
    });
    await until("the snapshot's filter to run", () => w.cleanRuns() === 1);
    expect(existsSync(w.record("th"))).toBe(true);
    controller.abort("stop");
    expect(await preparing.catch((e: unknown) => e)).toBeInstanceOf(PreparationCancelled);
    expect(stop.order).toEqual(["settle", "quiet"]);
    expect(existsSync(dirname(w.tree("th")))).toBe(false);

    // A snapshot that fails by itself.
    w.clear("clean-block");
    w.set("clean-fail");
    const fail = scope(async () => {});
    const failed = await ensureThreadWorktree(w.repo, "th", fail.options).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(PreparationHeld);
    expect((failed as Error).message).toMatch(/clean filter 'held' failed/);
    expect((failed as Error).message).not.toMatch(/is held until|could not be/);
    expect(fail.order).toEqual(["settle", "quiet"]);
    expect(existsSync(dirname(w.tree("th")))).toBe(false);
    expect(w.branch("th")).toBe("");

    w.clear("clean-fail");
    const made = await ensureThreadWorktree(w.repo, "th", scope(async () => {}).options);
    expect(made.created).toBe(true);
  }, 60_000);

  it("a scope or a record that cannot be made durable refuses before any Git child of the preparation is spawned", async () => {
    const w = world();
    let settled = 0;
    const settleScope = async () => {
      settled += 1;
      return null;
    };
    await expect(
      ensureThreadWorktree(w.repo, "th", {
        openScope: async () => {
          throw new Error("the scope index is not durable");
        },
        settleScope,
      }),
    ).rejects.toThrow("the scope index is not durable");
    expect(w.cleanRuns()).toBe(0);
    expect(existsSync(dirname(w.tree("th")))).toBe(false);

    // The scope opened, its record could not be written: nothing is spawned, the
    // scope is settled (no entry of it stays) and no thread directory is left.
    const s = scope();
    refuseRecordWrite = true;
    const refused = await ensureThreadWorktree(w.repo, "th", { ...s.options, settleScope }).catch(
      (e: unknown) => e,
    );
    refuseRecordWrite = false;
    expect(refused).toMatchObject({ code: "EACCES" });
    expect(s.opened()).toBe(1);
    expect(settled).toBe(2);
    expect(w.cleanRuns()).toBe(0);
    expect(existsSync(dirname(w.tree("th")))).toBe(false);
  });

  it("the project's initialization stopped without a proven end keeps its partial receipt beside the hold; Retry refuses, then finishes it", async () => {
    const w = world(true); // a plain folder: initialization's `add` cleans y.held
    const first = scope(undefined, shortQuiet);
    w.set("clean-hold");
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      ...first.options,
    });
    await w.survivor();
    controller.abort("stop");
    const stopped = await preparing.catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(PreparationHeld);
    expect(stopped).toMatchObject({
      code: "termination_unconfirmed",
      context: {
        termination_unconfirmed: { reason: "output_held" },
        project_git_initialization: { partial: true, initialized: true, failed_stage: "add" },
        preparation: { early: true },
      },
    });
    expect((stopped as Error).message).toMatch(/initialization was stopped during add/);
    w.clear("clean-hold");
    await expect(
      ensureThreadWorktree(w.repo, "th", scope(undefined, shortQuiet).options),
    ).rejects.toBeInstanceOf(PreparationHeld);
    expect(w.cleanRuns()).toBe(1);
    await endOwn();
    const made = await ensureThreadWorktree(w.repo, "th", scope().options);
    expect(made).toMatchObject({
      created: true,
      projectGitInitialization: { baselineCommitted: true },
    });
    expect(readFileSync(join(w.tree("th"), "y.held"), "utf8")).toBe("user data\n");
  }, 90_000);

  it("a ready tree whose project must be initialized again is recorded for that step and never removed: held, refused to readers, then reused as it was", async () => {
    const w = world();
    await ensureThreadWorktree(w.repo, "th", scope().options);
    writeFileSync(join(w.tree("th"), "left-by-a-turn"), "work\n");
    const base = git(w.tree("th"), "rev-parse", "HEAD");
    // The user's branch is gone (an unborn HEAD): the project needs a baseline again.
    git(w.repo, "update-ref", "-d", "refs/heads/main");
    w.set("clean-hold");
    const s = scope(undefined, shortQuiet);
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      ...s.options,
    });
    await w.survivor();
    expect(readThreadPreparation(w.tree("th"))).toMatchObject({ early: true });
    controller.abort("stop");
    const stopped = await preparing.catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(PreparationHeld);
    expect(stopped).toMatchObject({
      context: { project_git_initialization: { partial: true, failed_stage: "add" } },
    });
    // The ready tree is untouched and refused while the hold stands.
    expect(threadTreeState(w.tree("th"))).toBe("held");
    expect(readFileSync(join(w.tree("th"), "left-by-a-turn"), "utf8")).toBe("work\n");
    expect(w.branch("th")).toContain("claudexor/thread-th");
    w.clear("clean-hold");
    await expect(
      ensureThreadWorktree(w.repo, "th", scope(undefined, shortQuiet).options),
    ).rejects.toBeInstanceOf(PreparationHeld);
    await endOwn();
    const reused = await ensureThreadWorktree(w.repo, "th", scope().options);
    expect(reused).toMatchObject({
      path: w.tree("th"),
      created: false,
      baseSha: base,
      projectGitInitialization: { baselineCommitted: true },
    });
    expect(threadTreeState(w.tree("th"))).toBe("ready");
    expect(readFileSync(join(w.tree("th"), "left-by-a-turn"), "utf8")).toBe("work\n");
    expect(w.registered("th")).toBe(true);
  }, 90_000);

  it("a failed add settles its scope before its one release: what the checkout left is ended first, then everything it made goes", async () => {
    const w = world();
    // The settlement ends the survivor once it is in this test's custody.
    let inCustody: Promise<number> = Promise.resolve(0);
    const s = scope(async () => {
      await inCustody;
      await endOwn();
    });
    w.set("smudge-fail");
    const preparing = ensureThreadWorktree(w.repo, "th", s.options).catch((e: unknown) => e);
    inCustody = w.survivor();
    const survivor = await inCustody;
    const failed = await preparing;
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toMatch(/git worktree add failed/);
    expect((failed as Error).message).not.toMatch(/is held until|could not be/);
    expect(s.order).toEqual(["settle", "quiet"]);
    expect(ps(survivor)).toBe("gone");
    expect(existsSync(dirname(w.tree("th")))).toBe(false);
    expect(w.branch("th")).toBe("");
    expect(w.registered("th")).toBe(false);
  }, 60_000);

  it("a failed add whose survivor nothing ended names what stays held; the next attempt refuses, then releases after its end", async () => {
    const w = world();
    const s = scope(); // no settlement of its own
    w.set("smudge-fail");
    const preparing = ensureThreadWorktree(w.repo, "th", s.options).catch((e: unknown) => e);
    const survivor = await w.survivor();
    const failed = await preparing;
    expect((failed as Error).message).toMatch(
      new RegExp(
        `git worktree add failed.*is held until what its unfinished preparation started has ended: scope member ${survivor} is alive`,
        "s",
      ),
    );
    expect(s.order).toEqual(["quiet"]);
    // Nothing was removed under the survivor: the record and the new branch stay.
    expect(readThreadPreparation(w.tree("th"))).toMatchObject({
      own_branch: { name: "claudexor/thread-th" },
    });
    expect(readThreadPreparation(w.tree("th"))?.early).toBeUndefined();
    expect(w.branch("th")).toContain("claudexor/thread-th");
    w.clear("smudge-fail");
    await expect(
      ensureThreadWorktree(w.repo, "th", scope(undefined, shortQuiet).options),
    ).rejects.toBeInstanceOf(PreparationHeld);
    await endOwn();
    const made = await ensureThreadWorktree(w.repo, "th", scope().options);
    expect(made).toMatchObject({ path: w.tree("th"), created: true });
    expect(readFileSync(join(w.tree("th"), "y.held"), "utf8")).toBe("user data\n");
  }, 90_000);

  // A record that cannot be REMOVED once the end was proven is a cleanup fault,
  // typed and retryable — never an unconfirmed termination, and never untyped.
  it("an unconfirmed Stop whose end the settlement then proves, with an early record that cannot be removed: a typed cleanup refusal; Retry refuses without a second snapshot while the fault stands, then makes the tree", async () => {
    const w = world();
    let inCustody: Promise<number> = Promise.resolve(0);
    const first = scope(async () => {
      await inCustody;
      await endOwn();
    });
    w.set("clean-hold");
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      ...first.options,
    }).catch((e: unknown) => e);
    inCustody = w.survivor();
    const survivor = await inCustody;
    refuseRecordRemoval = true;
    controller.abort("stop");
    const stopped = await preparing;
    // The stop itself was unconfirmed (output_held); the settlement ended the
    // survivor and the release's read proved it before the removal failed.
    expect(first.order).toEqual(["settle", "quiet"]);
    expect(ps(survivor)).toBe("gone");
    expect(stopped).toBeInstanceOf(PreparationCleanupFailed);
    expect(stopped).not.toBeInstanceOf(PreparationHeld);
    expect(stopped).toMatchObject({
      code: "preparation_cleanup_failed",
      retryable: true,
      requiredActions: [expect.stringMatching(/then retry/)],
      context: {
        held: [w.tree("th")],
        preparation: {
          early: true,
          record: w.record("th"),
          scope_marker: first.marker,
          cleanup_error: expect.stringMatching(/EPERM/),
        },
      },
    });
    const context = (stopped as PreparationCleanupFailed).context as Record<string, unknown>;
    expect(context).not.toHaveProperty("termination_unconfirmed");
    expect(context.preparation).not.toHaveProperty("held");
    // The durable record stands, as written: the stop's facts and the fault.
    const bytes = readFileSync(w.record("th"), "utf8");
    expect(JSON.parse(bytes)).toMatchObject({
      early: true,
      held: { reason: "output_held" },
      cleanup_error: expect.stringMatching(/EPERM/),
    });
    expect(w.cleanRuns()).toBe(1);

    // Retry while the record cannot be released: refused the same way; no new
    // scope, no second snapshot, nothing rewritten; a reader refuses the tree.
    w.clear("clean-hold");
    const retry = scope();
    const refused = await ensureThreadWorktree(w.repo, "th", retry.options).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(PreparationCleanupFailed);
    expect(refused).toMatchObject({ code: "preparation_cleanup_failed", retryable: true });
    expect(retry.opened()).toBe(0);
    expect(w.cleanRuns()).toBe(1);
    expect(readFileSync(w.record("th"), "utf8")).toBe(bytes);
    expect(threadTreeState(w.tree("th"))).toBe("held");
    expect(() => assertThreadTreeReady(w.tree("th"))).toThrow(PreparationCleanupFailed);
    await expect(purgeThreadWorktree(w.repo, "th", { quiet: patientQuiet })).rejects.toBeInstanceOf(
      PreparationCleanupFailed,
    );
    expect(existsSync(w.tree("th"))).toBe(false);
    expect(w.branch("th")).toBe("");

    // The fault clears: the next attempt releases the record and makes the tree.
    refuseRecordRemoval = false;
    const made = await ensureThreadWorktree(w.repo, "th", scope().options);
    expect(made).toMatchObject({ path: w.tree("th"), created: true });
    expect(threadTreeState(w.tree("th"))).toBe("ready");
  }, 90_000);

  it("the same during the project's initialization over a ready tree: the partial receipt rides the cleanup refusal, the ready tree is never removed, and it is reused once the record can go", async () => {
    const w = world();
    await ensureThreadWorktree(w.repo, "th", scope().options);
    writeFileSync(join(w.tree("th"), "left-by-a-turn"), "work\n");
    const base = git(w.tree("th"), "rev-parse", "HEAD");
    git(w.repo, "update-ref", "-d", "refs/heads/main"); // an unborn HEAD: a baseline is needed again
    w.set("clean-hold");
    let inCustody: Promise<number> = Promise.resolve(0);
    const s = scope(async () => {
      await inCustody;
      await endOwn();
    });
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      ...s.options,
    }).catch((e: unknown) => e);
    inCustody = w.survivor();
    const survivor = await inCustody;
    refuseRecordRemoval = true;
    controller.abort("stop");
    const stopped = await preparing;
    expect(ps(survivor)).toBe("gone");
    expect(stopped).toBeInstanceOf(PreparationCleanupFailed);
    expect(stopped).toMatchObject({
      code: "preparation_cleanup_failed",
      retryable: true,
      context: {
        project_git_initialization: { partial: true, failed_stage: "add" },
        preparation: { early: true, cleanup_error: expect.stringMatching(/EPERM/) },
      },
    });
    expect((stopped as PreparationCleanupFailed).context).not.toHaveProperty(
      "termination_unconfirmed",
    );
    expect((stopped as Error).message).toMatch(
      /initialization was stopped during add.*has since ended.*could not be released/s,
    );
    // The ready tree, its registration and its branch were there before: untouched.
    const untouched = () => {
      expect(readFileSync(join(w.tree("th"), "left-by-a-turn"), "utf8")).toBe("work\n");
      expect(git(w.tree("th"), "rev-parse", "HEAD")).toBe(base);
      expect(w.registered("th")).toBe(true);
      expect(w.branch("th")).toContain("claudexor/thread-th");
    };
    untouched();
    expect(threadTreeState(w.tree("th"))).toBe("held");
    w.clear("clean-hold");
    await expect(ensureThreadWorktree(w.repo, "th", scope().options)).rejects.toBeInstanceOf(
      PreparationCleanupFailed,
    );
    untouched();
    refuseRecordRemoval = false;
    const reused = await ensureThreadWorktree(w.repo, "th", scope().options);
    expect(reused).toMatchObject({
      path: w.tree("th"),
      created: false,
      baseSha: base,
      projectGitInitialization: { baselineCommitted: true },
    });
    untouched();
    expect(threadTreeState(w.tree("th"))).toBe("ready");
  }, 90_000);

  it("a thread directory that became unwritable for real: the unconfirmed Stop keeps its own facts though the record cannot take them; Retry is held while the survivor lives, a cleanup refusal after its end, and succeeds once writable", async () => {
    const w = world();
    const first = scope(undefined, shortQuiet); // no settlement of its own
    w.set("clean-hold");
    const controller = new AbortController();
    const preparing = ensureThreadWorktree(w.repo, "th", {
      signal: controller.signal,
      ...first.options,
    }).catch((e: unknown) => e);
    const survivor = await w.survivor();
    const threadDir = dirname(w.tree("th"));
    const early = readFileSync(w.record("th"), "utf8");
    try {
      chmodSync(threadDir, 0o500); // no unlink, no rewrite of the record
      controller.abort("stop");
      const stopped = await preparing;
      // No read is made from a record that lacks the stop's groups: it stays held,
      // typed, with the stop's own disclosure.
      expect(first.order).toEqual([]);
      expect(stopped).toBeInstanceOf(PreparationHeld);
      expect(stopped).toMatchObject({
        code: "termination_unconfirmed",
        retryable: true,
        context: {
          termination_unconfirmed: { reason: "output_held" },
          preparation: { early: true },
        },
      });
      expect(readFileSync(w.record("th"), "utf8")).toBe(early);
      expect(ps(survivor)).not.toBe("gone");

      // The survivor lives: the read (its scope marker) keeps the thread held.
      w.clear("clean-hold");
      const held = await ensureThreadWorktree(
        w.repo,
        "th",
        scope(undefined, shortQuiet).options,
      ).catch((e: unknown) => e);
      expect(held).toBeInstanceOf(PreparationHeld);
      expect(held).toMatchObject({ code: "termination_unconfirmed" });
      expect(ps(survivor)).not.toBe("gone"); // a refusal signals nothing

      // It ended; the record still cannot be removed: now a cleanup refusal.
      await endOwn();
      const refused = await ensureThreadWorktree(w.repo, "th", scope().options).catch(
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(PreparationCleanupFailed);
      expect(refused).toMatchObject({
        code: "preparation_cleanup_failed",
        retryable: true,
        context: { preparation: { early: true, cleanup_error: expect.stringMatching(/EACCES/) } },
      });
      expect((refused as PreparationCleanupFailed).context).not.toHaveProperty(
        "termination_unconfirmed",
      );
      expect(readFileSync(w.record("th"), "utf8")).toBe(early);
      expect(w.cleanRuns()).toBe(1);
    } finally {
      chmodSync(threadDir, 0o700);
    }
    const made = await ensureThreadWorktree(w.repo, "th", scope().options);
    expect(made).toMatchObject({ path: w.tree("th"), created: true });
    expect(readFileSync(join(w.tree("th"), "y.held"), "utf8")).toBe("user data\n");
  }, 90_000);
});
