// #694 r10 stage 1: the stop outcome produced by core `runCaptureRaw` survives
// every workspace wrapper, and a private resource only the direct Git writes
// (scratch index, staging) waits for that Git's exit when a stop left it running.
// The capture is replaced only for the one intercepted step; every other Git
// call is real.
//
// Windows, with the platform injected (the suites built on `#!/bin/sh` filters
// and real signals stay POSIX-only): a step that takes the user's locks finishes
// before the stop is taken while a scratch-index step is still interrupted; and
// genuine unconfirmed stops stay held until an operator confirms an old record;
// a current child refuses confirmation until its actual exit.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult, CaptureTermination } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";

type Intercept = (
  args: string[],
  opts: {
    abortSignal?: AbortSignal;
    env?: Record<string, string | null | undefined>;
    onCaptured?: (pid: number, identity: undefined) => void;
  },
) => Promise<CaptureResult> | undefined;
let intercept: Intercept | null = null;
// A filesystem without hard links: the transfer streams through its staging.
let refuseLinks = false;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      if (refuseLinks) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return fs.linkSync(...args);
    },
  };
});
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (cmd: string, args: string[], opts: Parameters<typeof core.runCaptureRaw>[2]) =>
      intercept?.(args, opts ?? {}) ?? core.runCaptureRaw(cmd, args, opts),
  };
});

const { gitObserved, GitOperationError } = await import("./git-observed.js");
const {
  gitEnv,
  PreparationCancelled,
  PreparationStopped,
  PreparationTerminationUnconfirmed,
  unconfirmedTerminationOf,
} = await import("./git-run.js");
const { GitInitializationError } = await import("./git-initialization.js");
const { ensureGitRepository } = await import("./git.js");
const { stashCreate } = await import("./git-snapshot.js");
const { transferObjects } = await import("./object-transfer.js");
const { ensureThreadWorktree } = await import("./thread-tree.js");
const {
  confirmThreadRelease,
  PreparationHeld,
  readThreadPreparation,
  threadPreparationRecordPath,
} = await import("./preparation-hold.js");
const { recordDigest } = await import("./preparation-release.js");
/** The operator's confirmation of one thread record as an inspection showed it. */
const confirmAsInspected = (
  repo: string,
  tree: string,
  quiet: Parameters<typeof confirmThreadRelease>[2]["quiet"],
) =>
  confirmThreadRelease(repo, tree, {
    digest: recordDigest(readFileSync(threadPreparationRecordPath(tree))),
    readWriter: null,
    quiet,
  });
/** The real capture and the real release criterion (`@claudexor/core` is mocked above). */
const realCore = await vi.importActual<typeof import("@claudexor/core")>("@claudexor/core");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
afterEach(() => {
  intercept = null;
  refuseLinks = false;
});
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", cwd, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();

/** An unconfirmed stop; `alive` keeps the direct Git running until `exit()`. */
const unconfirmedStop = (alive: boolean) => {
  let exit: () => void = () => {};
  const directExit = alive
    ? new Promise<void>((resolve) => {
        exit = resolve;
      })
    : Promise.resolve();
  const termination: CaptureTermination = {
    status: "unconfirmed",
    reason: alive ? "direct_child_alive" : "output_held",
    rootPid: 4242,
    groups: [4242],
    directExited: !alive,
    ...(alive ? {} : { directExitObservedAt: Date.now() }),
    directExit,
  };
  return { termination, exit: () => exit() };
};
const stoppedResult = (termination: CaptureTermination): CaptureResult => ({
  code: null,
  signal: "SIGKILL",
  stdout: "",
  stderr: "",
  drain: "truncated",
  termination,
});

describe("the stop outcome survives workspace wrappers (#694 r10)", () => {
  const repo = mkdtempSync(join(tmpdir(), "cx-stop-outcome-"));
  dirs.push(repo);
  sh(repo, ["init", "-q"]);

  it("gitObserved: an unconfirmed stop outranks the cut capture and allowFailure", async () => {
    const controller = new AbortController();
    const { termination } = unconfirmedStop(false);
    intercept = (args) => {
      if (!args.includes("status")) return undefined;
      controller.abort("stop");
      return Promise.resolve(stoppedResult(termination));
    };
    const error = await gitObserved(repo, ["status"], {
      label: "status",
      allowFailure: true,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreparationTerminationUnconfirmed);
    expect(error).toBeInstanceOf(PreparationStopped);
    expect(error).not.toBeInstanceOf(PreparationCancelled);
    expect(unconfirmedTerminationOf(error)).toBe(termination);
  });

  it("gitObserved: a confirmed stop stays an ordinary cancellation", async () => {
    const controller = new AbortController();
    intercept = (args) => {
      if (!args.includes("status")) return undefined;
      controller.abort("stop");
      return Promise.resolve({
        ...stoppedResult({ status: "confirmed", proof: "group_empty" }),
        drain: undefined,
      });
    };
    const error = await gitObserved(repo, ["status"], {
      label: "status",
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreparationCancelled);
    expect(unconfirmedTerminationOf(error)).toBeUndefined();
  });

  it("gitObserved: a stall whose end was not proven is a GitOperationError carrying it", async () => {
    const { termination } = unconfirmedStop(false);
    intercept = (args, opts) => {
      if (!args.includes("status")) return undefined;
      return new Promise((resolve) => {
        opts.abortSignal?.addEventListener("abort", () => resolve(stoppedResult(termination)));
      });
    };
    const error = await gitObserved(repo, ["status"], { label: "status", stallMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GitOperationError);
    expect(error).toMatchObject({ code: "capture_git_stalled" });
    expect(unconfirmedTerminationOf(error)).toBe(termination);
  });

  it("gitEnv: a stop whose capture failed keeps its outcome", async () => {
    const controller = new AbortController();
    const { termination } = unconfirmedStop(false);
    intercept = (args) => {
      if (!args.includes("status")) return undefined;
      controller.abort("stop");
      return Promise.reject(
        Object.assign(new Error("capture overflow"), { captureTermination: termination }),
      );
    };
    const error = await gitEnv(repo, ["status"], {}, undefined, controller.signal).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PreparationTerminationUnconfirmed);
    expect(unconfirmedTerminationOf(error)).toBe(termination);
  });

  it("gitEnv: the 60 s bound with an unproven end is never read as a result", async () => {
    const { termination } = unconfirmedStop(false);
    intercept = (args) =>
      args.includes("status") ? Promise.resolve(stoppedResult(termination)) : undefined;
    const error = await gitEnv(repo, ["status"], {}).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PreparationStopped);
    expect(unconfirmedTerminationOf(error)).toBe(termination);
  });

  // The step rule is named, not inherited from the host: on Windows the user's own
  // `add` is not handed the stop at all (`userLockStep`), so it cannot be stopped
  // by it; that rule has its own injected tests below (r10 E).
  it("a partial initialization keeps the unconfirmed stop of its step (POSIX step rule, injected: the step takes the stop itself)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-stop-init-"));
    dirs.push(root);
    writeFileSync(join(root, "a.txt"), "a\n");
    const controller = new AbortController();
    const { termination } = unconfirmedStop(false);
    intercept = (args) => {
      if (!args.includes("add")) return undefined;
      controller.abort("stop");
      return Promise.resolve(stoppedResult(termination));
    };
    const error = await ensureGitRepository(root, {
      signal: controller.signal,
      platform: "linux",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitInitializationError);
    expect(unconfirmedTerminationOf(error)).toBe(termination);
    expect((error as InstanceType<typeof GitInitializationError>).context).toMatchObject({
      termination_unconfirmed: {
        survivors: [],
        unresolved: [{ pgid: 4242, reason: "output_held" }],
        reason: "output_held",
      },
      project_git_initialization: { partial: true, failed_stage: "add" },
    });
  });
});

describe("private resources wait for a direct Git a stop left running (r10 A)", () => {
  it("the scratch index stays until the stopped add exits, then goes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-stop-scratch-"));
    dirs.push(repo);
    sh(repo, ["init", "-q"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, ["add", "-A"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "base"]);
    writeFileSync(join(repo, "b.txt"), "dirty\n");
    const controller = new AbortController();
    const stop = unconfirmedStop(true);
    let scratch = "";
    intercept = (args, opts) => {
      const index = opts.env?.["GIT_INDEX_FILE"];
      if (!args.includes("add") || !index) return undefined;
      scratch = dirname(index);
      controller.abort("stop");
      return Promise.resolve(stoppedResult(stop.termination));
    };
    const error = await stashCreate(repo, {}, [], [], controller.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreparationTerminationUnconfirmed);
    expect(scratch).toContain("claudexor-snapshot-index-");
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(scratch)).toBe(true);
    stop.exit();
    await vi.waitFor(() => expect(existsSync(scratch)).toBe(false), { timeout: 5_000 });
  });

  it("an exited direct Git leaves nothing to wait for: the scratch index goes at once", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-stop-scratch2-"));
    dirs.push(repo);
    sh(repo, ["init", "-q"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, ["add", "-A"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "base"]);
    writeFileSync(join(repo, "b.txt"), "dirty\n");
    const controller = new AbortController();
    const stop = unconfirmedStop(false);
    let scratch = "";
    intercept = (args, opts) => {
      const index = opts.env?.["GIT_INDEX_FILE"];
      if (!args.includes("add") || !index) return undefined;
      scratch = dirname(index);
      controller.abort("stop");
      return Promise.resolve(stoppedResult(stop.termination));
    };
    await stashCreate(repo, {}, [], [], controller.signal).catch(() => {});
    expect(scratch).toContain("claudexor-snapshot-index-");
    expect(existsSync(scratch)).toBe(false);
  });

  it("the staging producer retains its real current child through confirmation and prune until exit, then cleans up", async () => {
    const { confirmStagingRelease } = await import("./staging-owner.js");
    const { pruneObjectStore } = await import("./object-store.js");
    const { stagingGeneration } = await import("./preparation-release.js");
    const { withScopeMarker } = await import("./git-run.js");
    const source = mkdtempSync(join(tmpdir(), "cx-stop-src-"));
    const dest = mkdtempSync(join(tmpdir(), "cx-stop-dst-"));
    dirs.push(source, dest);
    sh(source, ["init", "-q", "--bare"]);
    sh(dest, ["init", "-q", "--bare"]);
    const oids = ["alpha\n", "beta\n"].map((text) =>
      sh(source, ["hash-object", "-w", "--stdin"], { GIT_DIR: source }, text),
    );
    const controller = new AbortController();
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const directExit = once(child, "exit").then(() => {});
    await once(child, "spawn");
    intercept = (args, opts) => {
      if (!args.includes("index-pack")) return undefined;
      opts.onCaptured?.(child.pid!, undefined);
      controller.abort("stop");
      return Promise.resolve(
        stoppedResult({
          status: "unconfirmed",
          reason: "direct_child_alive",
          rootPid: child.pid!,
          groups: [],
          directExited: false,
          directExit,
        }),
      );
    };
    const staging = () =>
      readdirSync(join(dest, "objects")).filter((name) => name.startsWith("tmp_claudexor-"));
    refuseLinks = true;
    try {
      const error = await transferObjects(
        { cwd: source, env: { GIT_DIR: source }, objectsDir: join(source, "objects") },
        { cwd: dest, env: { GIT_DIR: dest }, objectsDir: join(dest, "objects") },
        oids,
        20,
        withScopeMarker(controller.signal, realCore.mintRunScopeMarker()),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PreparationTerminationUnconfirmed);
      expect(staging()).toHaveLength(1);
      const name = staging()[0]!;
      const ownerPath = join(dest, "objects", name, "owner.json");
      const confirm = () =>
        confirmStagingRelease(dest, name, {
          digest: recordDigest(readFileSync(ownerPath)),
          readWriter: null,
        });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await confirm()).toMatchObject({ outcome: "refused" });
        const record = JSON.parse(readFileSync(ownerPath, "utf8"));
        record.operator_release = {
          generation: stagingGeneration(record),
          confirmed_at: new Date().toISOString(),
          observation: { reasons: [] },
        };
        writeFileSync(ownerPath, JSON.stringify(record));
        await pruneObjectStore({ store: dest, graceMs: 0, objectFormat: "sha1" });
        expect(staging()).toEqual([name]);
        expect(child.exitCode).toBeNull();
      }
      child.stdin.end();
      await directExit;
      for (let end = Date.now() + 5_000; staging().length > 0 && Date.now() < end;)
        await new Promise((r) => setTimeout(r, 10));
      expect(staging()).toEqual([]);
    } finally {
      child.stdin.end();
      await directExit;
    }
  });

  it.each([
    ["a preparation scope's transfer", true],
    ["a transfer outside any preparation scope", false],
  ] as const)(
    "%s: an owner record before its writer spawns only when scoped (r12)",
    async (_name, scoped) => {
      const { withScopeMarker } = await import("./git-run.js");
      const { mintRunScopeMarker } = await import("@claudexor/core");
      const source = mkdtempSync(join(tmpdir(), "cx-owner-src-"));
      const dest = mkdtempSync(join(tmpdir(), "cx-owner-dst-"));
      dirs.push(source, dest);
      sh(source, ["init", "-q", "--bare"]);
      sh(dest, ["init", "-q", "--bare"]);
      const oids = ["one\n", "two\n"].map((text) =>
        sh(source, ["hash-object", "-w", "--stdin"], { GIT_DIR: source }, text),
      );
      const marker = mintRunScopeMarker();
      const signal = scoped ? withScopeMarker(undefined, marker) : new AbortController().signal;
      const seen: Array<Record<string, unknown> | null> = [];
      intercept = (args) => {
        if (!args.includes("index-pack")) return undefined;
        for (const name of readdirSync(join(dest, "objects")).filter((n) =>
          n.startsWith("tmp_claudexor-"),
        )) {
          const owner = join(dest, "objects", name, "owner.json");
          seen.push(existsSync(owner) ? JSON.parse(readFileSync(owner, "utf8")) : null);
        }
        return undefined; // the real index-pack runs
      };
      refuseLinks = true;
      await transferObjects(
        { cwd: source, env: { GIT_DIR: source }, objectsDir: join(source, "objects") },
        { cwd: dest, env: { GIT_DIR: dest }, objectsDir: join(dest, "objects") },
        oids,
        20,
        signal,
      );
      expect(seen).toEqual([
        scoped
          ? expect.objectContaining({ intent: "index-pack", scope: { marker }, writer: null })
          : null,
      ]);
    },
  );
});

describe("an isolated base held after a stop without a proven end (r10 C)", () => {
  /** A real isolated preparation in a run's scope whose checkout was stopped
   * without a proven end (its own Git exited): the base it keeps, with its
   * facts, and the release its run runs once that scope settled. */
  const heldBase = async () => {
    const { prepareEnvelope } = await import("./prepare-envelope.js");
    const { withScopeMarker } = await import("./git-run.js");
    const hold = await import("./envelope-preparation.js");
    const { mintRunScopeMarker } = await import("@claudexor/core");
    const root = mkdtempSync(join(tmpdir(), "cx-held-base-"));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    sh(repo, ["init", "-q"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, ["add", "-A"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "base"]);
    const base = join(root, "envelope");
    const marker = mintRunScopeMarker();
    const releases: Array<() => Promise<void>> = [];
    const controller = new AbortController();
    const signal = withScopeMarker(controller.signal, marker, (release) => releases.push(release));
    const { termination } = unconfirmedStop(false);
    let sawMarker = false;
    intercept = (args, opts) => {
      if (opts.env?.[marker] === "1") sawMarker = true;
      if (!args.includes("checkout")) return undefined;
      controller.abort("stop");
      return Promise.resolve(stoppedResult(termination));
    };
    const error = await prepareEnvelope({
      repoRoot: repo,
      projectRoot: repo,
      base,
      opts: { taskId: "t", attemptId: "a", signal },
    }).catch((e: unknown) => e);
    intercept = null;
    expect(error).toBeInstanceOf(PreparationTerminationUnconfirmed);
    expect(error).toMatchObject({ heldBase: base });
    expect(sawMarker).toBe(true);
    expect(existsSync(join(base, "tree"))).toBe(true);
    expect(hold.readEnvelopePreparation(base)).toMatchObject({
      scope_marker: marker,
      preparing: true,
      held: { reason: "output_held", groups: [4242] },
    });
    expect(
      await hold.envelopePreparationVerdict(base, async () => ({
        status: "held",
        reasons: ["alive"],
      })),
    ).toEqual({ status: "held", reasons: ["alive"] });
    expect(releases).toHaveLength(1);
    return { base, hold, settledScopeRelease: releases[0]! };
  };
  /** The operator's confirmation of that base as an inspection showed it. */
  const confirmBase = (
    hold: typeof import("./envelope-preparation.js"),
    base: string,
    quiet?: Parameters<typeof confirmThreadRelease>[2]["quiet"],
  ) =>
    hold.confirmEnvelopeRelease(base, {
      digest: recordDigest(readFileSync(join(base, "owner.json"))),
      readWriter: null,
      ...(quiet ? { quiet } : {}),
    });

  it("keeps the base with its preparation facts and refuses a sweep's read while held; its run's settled scope then releases it where a read proves the end (macOS, Linux) — on Windows no read does, so it stays held until the operator's confirmation", async () => {
    const { base, hold, settledScopeRelease } = await heldBase();
    // The host's own read, as shipped: nothing is injected below.
    await settledScopeRelease();
    if (process.platform !== "win32") {
      expect(existsSync(base)).toBe(false);
      return;
    }
    // Windows: no group probe and no census, so nothing by itself releases it.
    expect(existsSync(join(base, "tree"))).toBe(true);
    expect(await hold.releaseEnvelopeBase(base)).toBe(false);
    expect(await hold.envelopePreparationVerdict(base)).toMatchObject({
      status: "held",
      operatorMayConfirm: true,
    });
    expect(await confirmBase(hold, base)).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
      stop: { reason: "output_held", groups: [4242] },
    });
    expect(existsSync(base)).toBe(false);
  });

  it("win32 read (injected): the same held base is never released by a settled scope's read, a sweep's or a retry's; only the operator's confirmation releases it", async () => {
    const { base, hold } = await heldBase();
    /** The release criterion as on Windows: no group probe, no census. */
    const win32Quiet = (facts: Parameters<typeof realCore.preparationQuiet>[0]) =>
      realCore.preparationQuiet(facts, { platform: "win32" });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await hold.releaseEnvelopeBase(base, win32Quiet)).toBe(false);
      expect(await hold.envelopePreparationVerdict(base, win32Quiet)).toEqual({
        status: "held",
        reasons: [expect.stringMatching(/no read can prove that what it started has ended/)],
        operatorMayConfirm: true,
      });
      expect(existsSync(join(base, "tree"))).toBe(true);
    }
    // A stale digest changes nothing; the inspected one releases, owner.json last.
    expect(
      await hold.confirmEnvelopeRelease(base, {
        digest: "0".repeat(64),
        readWriter: null,
        quiet: win32Quiet,
      }),
    ).toMatchObject({ outcome: "stale" });
    expect(existsSync(join(base, "tree"))).toBe(true);
    expect(await confirmBase(hold, base, win32Quiet)).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
      continued: false,
      stop: { reason: "output_held", groups: [4242] },
    });
    expect(existsSync(base)).toBe(false);
  });

  it("a handed-over base is no longer preparing", async () => {
    const { prepareEnvelope } = await import("./prepare-envelope.js");
    const hold = await import("./envelope-preparation.js");
    const root = mkdtempSync(join(tmpdir(), "cx-ready-base-"));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    sh(repo, ["init", "-q"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, ["add", "-A"]);
    sh(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "base"]);
    const base = join(root, "envelope");
    await prepareEnvelope({
      repoRoot: repo,
      projectRoot: repo,
      base,
      opts: { taskId: "t", attemptId: "b" },
    });
    expect(hold.readEnvelopePreparation(base)).toMatchObject({ preparing: false });
    expect((await hold.envelopePreparationVerdict(base)).status).toBe("none");
  });
});

describe("Windows step boundaries (r10 E)", () => {
  it("a step taking the user's locks is not interrupted on win32 but keeps its scope; elsewhere the stop passes through", async () => {
    const { userLockStep, withScopeMarker, scopeMarkerOf } = await import("./git-run.js");
    const { mintRunScopeMarker } = await import("@claudexor/core");
    const controller = new AbortController();
    const marker = mintRunScopeMarker();
    const scoped = withScopeMarker(controller.signal, marker);
    expect(userLockStep(scoped, "darwin")).toBe(scoped);
    expect(userLockStep(scoped, "linux")).toBe(scoped);
    const onWindows = userLockStep(scoped, "win32");
    expect(onWindows).not.toBe(scoped);
    expect(scopeMarkerOf(onWindows)).toBe(marker);
    controller.abort("stop");
    expect(scoped.aborted).toBe(true);
    expect(onWindows?.aborted).toBe(false);
    expect(userLockStep(controller.signal, "win32")).toBeUndefined();
  });

  const USER = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
  /** A committed project with one untracked file, so its base snapshot has work to do. */
  const project = (): string => {
    const root = mkdtempSync(join(tmpdir(), "cx-stop-win-"));
    dirs.push(root);
    const repo = join(root, "project");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: ENV });
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, ["add", "-A"]);
    sh(repo, [...USER, "commit", "-qm", "base"]);
    writeFileSync(join(repo, "untracked.txt"), "the user's own work\n");
    return repo;
  };
  const threadDir = (repo: string, id: string) => join(projectRuntimeDir(repo), "threads", id);
  const userState = (repo: string) => ({
    head: sh(repo, ["rev-parse", "HEAD"]),
    status: sh(repo, ["status", "--porcelain"]),
    worktrees: sh(repo, ["worktree", "list", "--porcelain"]),
    branches: sh(repo, ["branch", "--list", "claudexor/*"]),
  });
  const isAdd = (args: string[]) => args.includes("worktree") && args.includes("add");
  const confirmedStop = (): CaptureResult => ({
    code: null,
    signal: "SIGINT",
    stdout: "",
    stderr: "",
    termination: { status: "confirmed", proof: "group_empty" },
  });
  /** The release criterion as on Windows: no group probe, no census, the pid probe from `inUse`. */
  const win32Quiet =
    (inUse: ReadonlySet<number> = new Set()) =>
    (facts: Parameters<typeof realCore.preparationQuiet>[0]) =>
      realCore.preparationQuiet(facts, {
        platform: "win32",
        probePidAlive: (pid) => inUse.has(pid),
      });
  /** An unconfirmed stop as Windows reports it: no process group. */
  const windowsStop = (alive: boolean) => {
    const stop = unconfirmedStop(alive);
    return { ...stop, termination: { ...stop.termination, groups: [] } as CaptureTermination };
  };

  it("win32 (injected): a Stop during `git worktree add` does not interrupt it — Git finishes the step, then the stop is taken at its boundary and what it made is released", async () => {
    const repo = project();
    const before = userState(repo);
    const controller = new AbortController();
    const add: { stopSeen?: boolean; code?: number | null; made?: boolean } = {};
    intercept = (args, opts) => {
      if (!isAdd(args)) return undefined;
      controller.abort("stop"); // the Stop arrives while the add runs
      add.stopSeen = opts.abortSignal?.aborted === true;
      return realCore.runCaptureRaw("git", args, opts as never).then((result) => {
        add.code = result.code;
        add.made = existsSync(join(threadDir(repo, "th-win"), "tree", "a.txt"));
        return result;
      });
    };
    const error = await ensureThreadWorktree(repo, "th-win", {
      signal: controller.signal,
      platform: "win32",
    }).catch((e: unknown) => e);
    // The step's own stop was never aborted: Git ran to its end and made the tree.
    expect(add).toEqual({ stopSeen: false, code: 0, made: true });
    // Then the stop, at the step's boundary: an ordinary cancellation, nothing held.
    expect(error).toBeInstanceOf(PreparationCancelled);
    expect(unconfirmedTerminationOf(error)).toBeUndefined();
    expect(existsSync(threadDir(repo, "th-win"))).toBe(false);
    expect(userState(repo)).toEqual(before);
    expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
    // The next turn makes the tree.
    intercept = null;
    const next = await ensureThreadWorktree(repo, "th-win", { platform: "win32" });
    expect(next.created).toBe(true);
    expect(readFileSync(join(next.path, "a.txt"), "utf8")).toBe("a\n");
  });

  it("negative control: elsewhere the same Stop is the step's own stop — Git's add is interrupted, never left to finish", async () => {
    const repo = project();
    const controller = new AbortController();
    let stopSeen: boolean | undefined;
    intercept = (args, opts) => {
      if (!isAdd(args)) return undefined;
      controller.abort("stop");
      stopSeen = opts.abortSignal?.aborted === true;
      return Promise.resolve(confirmedStop());
    };
    const error = await ensureThreadWorktree(repo, "th-posix", {
      signal: controller.signal,
      platform: "linux",
    }).catch((e: unknown) => e);
    expect(stopSeen).toBe(true);
    expect(error).toBeInstanceOf(PreparationCancelled);
    expect(existsSync(threadDir(repo, "th-posix"))).toBe(false);
  });

  it("win32 (injected): a scratch-index step is still interrupted — the base snapshot takes the Stop itself and no later step starts", async () => {
    const repo = project();
    const before = userState(repo);
    const controller = new AbortController();
    const scratch: boolean[] = [];
    let added = false;
    intercept = (args, opts) => {
      if (isAdd(args)) added = true;
      if (!opts.env?.["GIT_INDEX_FILE"] || scratch.length > 0) return undefined;
      controller.abort("stop"); // the Stop arrives while a scratch-index step runs
      scratch.push(opts.abortSignal?.aborted === true);
      return Promise.resolve(confirmedStop());
    };
    const error = await ensureThreadWorktree(repo, "th-scratch", {
      signal: controller.signal,
      platform: "win32",
    }).catch((e: unknown) => e);
    // This step's stop IS the Stop: private state, interrupted as on POSIX.
    expect(scratch).toEqual([true]);
    expect(error).toBeInstanceOf(PreparationCancelled);
    expect(added).toBe(false);
    expect(existsSync(threadDir(repo, "th-scratch"))).toBe(false);
    expect(userState(repo)).toEqual(before);
  });

  it("win32 (injected, r17): an unconfirmed Stop whose own Git exited is HELD where no read can prove the end — never released by itself, never an ordinary cancellation; the operator's confirmation releases it and the next turn makes the tree", async () => {
    const repo = project();
    const controller = new AbortController();
    const { termination } = windowsStop(false);
    const snapshotStop: Intercept = (_args, opts) => {
      if (!opts.env?.["GIT_INDEX_FILE"] || controller.signal.aborted) return undefined;
      controller.abort("stop");
      return Promise.resolve(stoppedResult(termination));
    };
    intercept = snapshotStop;
    const error = await ensureThreadWorktree(repo, "th-unproven", {
      signal: controller.signal,
      platform: "win32",
      quiet: win32Quiet(),
    }).catch((e: unknown) => e);
    const tree = join(threadDir(repo, "th-unproven"), "tree");
    expect(error).toBeInstanceOf(PreparationHeld);
    expect(error).not.toBeInstanceOf(PreparationStopped);
    expect(error).toMatchObject({
      code: "termination_unconfirmed",
      retryable: true,
      requiredActions: [expect.any(String), expect.stringMatching(/gc release-preparation/)],
      context: {
        termination_unconfirmed: { survivors: [], unresolved: [], reason: "output_held" },
        held: [tree],
        release_requires: "operator_confirmation",
        preparation: {
          early: true,
          unresolved: [expect.stringMatching(/no process groups to probe and no process census/)],
        },
      },
    });
    const message = (error as Error).message;
    expect(message).toMatch(/is held until what its unfinished preparation started has ended/);
    expect(message).not.toMatch(/has since ended/);
    expect(readThreadPreparation(tree)).toMatchObject({
      early: true,
      held: { reason: "output_held" },
    });
    // Retry, the next turn: still held — no age, retry or new daemon releases it by itself.
    intercept = null;
    await expect(
      ensureThreadWorktree(repo, "th-unproven", { platform: "win32", quiet: win32Quiet() }),
    ).rejects.toMatchObject({ context: { release_requires: "operator_confirmation" } });
    // The operator confirms the inspected record: released (an early record: only itself).
    expect(await confirmAsInspected(repo, tree, win32Quiet())).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
      continued: false,
    });
    expect(existsSync(threadPreparationRecordPath(tree))).toBe(false);
    const next = await ensureThreadWorktree(repo, "th-unproven", {
      platform: "win32",
      quiet: win32Quiet(),
    });
    expect(next.created).toBe(true);
    // The new preparation's record never carried the old confirmation.
    expect(existsSync(threadPreparationRecordPath(tree))).toBe(false);

    // Negative control: the same stop where the release's read PROVED the end is
    // the ordinary cancellation it always was.
    const proven = new AbortController();
    intercept = (_args, opts) => {
      if (!opts.env?.["GIT_INDEX_FILE"] || proven.signal.aborted) return undefined;
      proven.abort("stop");
      return Promise.resolve(stoppedResult(windowsStop(false).termination));
    };
    const cancelled = await ensureThreadWorktree(repo, "th-proven", {
      signal: proven.signal,
      quiet: (facts) => realCore.preparationQuiet(facts, { platform: "linux" }),
    }).catch((e: unknown) => e);
    expect(cancelled).toBeInstanceOf(PreparationCancelled);
    expect(cancelled).not.toHaveProperty("code");
  });

  // Both sides are named, not inherited from the host: the initialization's `add`
  // takes the stop itself (the POSIX step rule; on Windows it is never handed the
  // stop), and the release's read is the injected one.
  it("where no read can prove the end (injected), a partial initialization whose step took the stop itself (POSIX step rule, injected) keeps its own unconfirmed stop beside the hold; a proven end drops it", async () => {
    const outcome = async (quiet: ReturnType<typeof win32Quiet>) => {
      const root = mkdtempSync(join(tmpdir(), "cx-stop-win-init-"));
      dirs.push(root);
      writeFileSync(join(root, "a.txt"), "a\n");
      const controller = new AbortController();
      const { termination } = windowsStop(false);
      intercept = (args) => {
        if (!args.includes("add")) return undefined;
        controller.abort("stop");
        return Promise.resolve(stoppedResult(termination));
      };
      const error = await ensureThreadWorktree(root, "th-init", {
        signal: controller.signal,
        platform: "linux",
        quiet,
      }).catch((e: unknown) => e);
      intercept = null;
      return error;
    };
    const unproven = await outcome(win32Quiet());
    expect(unproven).toBeInstanceOf(PreparationHeld);
    expect(unproven).toMatchObject({
      code: "termination_unconfirmed",
      context: {
        termination_unconfirmed: { reason: "output_held" },
        held: [expect.stringMatching(/th-init/)],
        release_requires: "operator_confirmation",
        project_git_initialization: { partial: true, initialized: true, failed_stage: "add" },
      },
    });
    expect((unproven as Error).message).toMatch(
      /^Git repository initialization was stopped during add;.*held until/s,
    );
    expect((unproven as Error).message).not.toMatch(/has since ended/);
    const proven = await outcome((facts) =>
      realCore.preparationQuiet(facts, { platform: "linux" }),
    );
    expect(proven).toBeInstanceOf(GitInitializationError);
    expect((proven as Error).message).toMatch(/what the stopped step started has since ended/);
    expect((proven as InstanceType<typeof GitInitializationError>).context).not.toHaveProperty(
      "termination_unconfirmed",
    );
  });

  it("win32 (injected): a Stop that left the step's own Git running holds what it made while that pid is in use; the next turn is refused without a second snapshot — also once its exit is seen, since its children's end is still unread (r17) — and the operator's confirmation releases it", async () => {
    const repo = project();
    const controller = new AbortController();
    const { termination, exit } = windowsStop(true);
    let snapshots = 0;
    intercept = (_args, opts) => {
      if (!opts.env?.["GIT_INDEX_FILE"]) return undefined;
      snapshots += 1;
      if (controller.signal.aborted) return undefined;
      controller.abort("stop");
      return Promise.resolve(stoppedResult(termination));
    };
    const inUse = new Set([4242]);
    const error = await ensureThreadWorktree(repo, "th-writer", {
      signal: controller.signal,
      platform: "win32",
      quiet: win32Quiet(inUse),
    }).catch((e: unknown) => e);
    // A measured live process: held, typed, with the stop's own facts.
    expect(error).toBeInstanceOf(PreparationHeld);
    expect(error).toMatchObject({
      code: "termination_unconfirmed",
      context: {
        termination_unconfirmed: { reason: "direct_child_alive" },
        preparation: { unresolved: [expect.stringMatching(/current child has not exited/)] },
      },
    });
    const tree = join(threadDir(repo, "th-writer"), "tree");
    expect(readThreadPreparation(tree)).toMatchObject({
      early: true,
      held: { reason: "direct_child_alive", groups: [], direct_writer_pid: 4242 },
    });
    // Retry while it runs: refused by the record's read, before any new Git step.
    const seen = snapshots;
    await expect(
      ensureThreadWorktree(repo, "th-writer", { platform: "win32", quiet: win32Quiet(inUse) }),
    ).rejects.toBeInstanceOf(PreparationHeld);
    expect(snapshots).toBe(seen);
    expect(existsSync(threadPreparationRecordPath(tree))).toBe(true);
    // This daemon sees the process exit: the record no longer waits on its pid.
    exit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readThreadPreparation(tree)?.held).not.toHaveProperty("direct_writer_pid");
    intercept = null;
    await expect(
      ensureThreadWorktree(repo, "th-writer", { platform: "win32", quiet: win32Quiet(inUse) }),
    ).rejects.toMatchObject({ context: { release_requires: "operator_confirmation" } });
    expect(snapshots).toBe(seen);
    expect(await confirmAsInspected(repo, tree, win32Quiet(inUse))).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
    });
    const next = await ensureThreadWorktree(repo, "th-writer", {
      platform: "win32",
      quiet: win32Quiet(inUse), // the pid names another process by now
    });
    expect(next.created).toBe(true);
    expect(existsSync(threadPreparationRecordPath(tree))).toBe(false);
  });

  // #694 V15: the hold itself can fail. `settleScope` runs between the hold and
  // the preparation's own release, so it stands here for "the fault was over by
  // the time that release read the record".
  it("win32 (injected): an unconfirmed Stop whose record could not be read just then is not on the record — the preparation's own call releases nothing under the platform's limit and keeps the stop's facts, the next turn is held, and only the operator's confirmation releases it", async () => {
    const repo = project();
    const controller = new AbortController();
    const { termination } = windowsStop(false);
    const tree = join(threadDir(repo, "th-unread"), "tree");
    const recordPath = threadPreparationRecordPath(tree);
    let early = Buffer.alloc(0);
    intercept = (_args, opts) => {
      if (!opts.env?.["GIT_INDEX_FILE"] || controller.signal.aborted) return undefined;
      controller.abort("stop");
      early = readFileSync(recordPath);
      writeFileSync(recordPath, early.subarray(0, early.length >> 1)); // torn just then
      return Promise.resolve(stoppedResult(termination));
    };
    const error = await ensureThreadWorktree(repo, "th-unread", {
      signal: controller.signal,
      platform: "win32",
      quiet: win32Quiet(),
      settleScope: async () => {
        writeFileSync(recordPath, early);
        return null;
      },
    }).catch((e: unknown) => e);
    // Not the ordinary cancellation a release under the platform's limit would
    // have made of it: the stop was unconfirmed and nothing read its end.
    expect(error).toBeInstanceOf(PreparationHeld);
    expect(error).toMatchObject({
      code: "termination_unconfirmed",
      context: { termination_unconfirmed: { reason: "output_held" }, held: [tree] },
    });
    expect(readFileSync(recordPath)).toEqual(early);
    expect(readThreadPreparation(tree)).toMatchObject({ early: true });
    expect(readThreadPreparation(tree)).not.toHaveProperty("held");
    intercept = null;
    await expect(
      ensureThreadWorktree(repo, "th-unread", { platform: "win32", quiet: win32Quiet() }),
    ).rejects.toMatchObject({ context: { release_requires: "operator_confirmation" } });
    expect(await confirmAsInspected(repo, tree, win32Quiet())).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
    });
    const next = await ensureThreadWorktree(repo, "th-unread", {
      platform: "win32",
      quiet: win32Quiet(),
    });
    expect(next.created).toBe(true);
  });

  it("win32 (injected): a hold that could not be written while the step's own Git still runs keeps the stop's facts in the refusal, and this daemon still owns that Git — the operator's confirmation and the next turn are refused until its exit is seen", async () => {
    const repo = project();
    const controller = new AbortController();
    const { termination, exit } = windowsStop(true);
    const tree = join(threadDir(repo, "th-unwritten"), "tree");
    const recordPath = threadPreparationRecordPath(tree);
    const inTheWay = `${recordPath}.${process.pid}.tmp`;
    intercept = (_args, opts) => {
      if (!opts.env?.["GIT_INDEX_FILE"] || controller.signal.aborted) return undefined;
      controller.abort("stop");
      mkdirSync(inTheWay); // the record's rewrite is refused: its temporary file cannot be made
      return Promise.resolve(stoppedResult(termination));
    };
    const error = await ensureThreadWorktree(repo, "th-unwritten", {
      signal: controller.signal,
      platform: "win32",
      quiet: win32Quiet(),
      settleScope: async () => {
        rmSync(inTheWay, { recursive: true });
        return null;
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreparationHeld);
    expect(error).toMatchObject({
      code: "termination_unconfirmed",
      context: { termination_unconfirmed: { reason: "direct_child_alive" }, held: [tree] },
    });
    expect(readThreadPreparation(tree)).toMatchObject({ early: true });
    expect(readThreadPreparation(tree)).not.toHaveProperty("held");
    intercept = null;
    // Nothing durable names that Git, yet it is this daemon's current child.
    expect(await confirmAsInspected(repo, tree, win32Quiet())).toMatchObject({
      outcome: "refused",
      reasons: [expect.stringMatching(/current child has not exited/)],
    });
    await expect(
      ensureThreadWorktree(repo, "th-unwritten", { platform: "win32", quiet: win32Quiet() }),
    ).rejects.toMatchObject({
      context: {
        preparation: { unresolved: [expect.stringMatching(/current child has not exited/)] },
      },
    });
    expect(existsSync(recordPath)).toBe(true);
    exit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await confirmAsInspected(repo, tree, win32Quiet())).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
    });
    const next = await ensureThreadWorktree(repo, "th-unwritten", {
      platform: "win32",
      quiet: win32Quiet(),
    });
    expect(next.created).toBe(true);
  });
});

// #694 V16: the 60 s bound can cut a step of the first initialization with its end
// unproven while no caller's stop was taken (`gitEnv` keeps the termination on a
// plain error). Once a step began, that is a partial initialization as a stop's
// is: its progress and its termination reach the thread turn's refusal. A read
// before any mutation, an ordinary failure and a proven end are not one. The step
// rule is named, not inherited: Windows still hands the user's steps no stop.
describe("an unconfirmed time bound during the first initialization (#694 V16)", () => {
  const folder = () => {
    const root = mkdtempSync(join(tmpdir(), "cx-bound-init-"));
    dirs.push(root);
    writeFileSync(join(root, "a.txt"), "a\n");
    return root;
  };
  type Stage = "init" | "add" | "commit" | "head";
  /** Cut `stage` at its bound, its end unproven; every other Git call is real. */
  const cutAt = (stage: Stage, termination: CaptureTermination, seen: { signal?: unknown }) => {
    let committed = false;
    const intercept: Intercept = (args, opts) => {
      const hit =
        stage === "head"
          ? committed && args.at(-2) === "rev-parse" && args.at(-1) === "HEAD"
          : args.includes(stage);
      if (args.includes("commit")) committed = true;
      if (!hit) return undefined;
      seen.signal = opts.abortSignal;
      return Promise.resolve(stoppedResult(termination));
    };
    return intercept;
  };
  const progress: Record<Stage, Record<string, unknown>> = {
    init: { initialized: false, baseline_committed: false, failed_stage: "init" },
    add: { initialized: true, baseline_committed: false, failed_stage: "add" },
    commit: { initialized: true, baseline_committed: false, failed_stage: "commit" },
    head: { initialized: true, baseline_committed: true, failed_stage: "head" },
  };
  /** The release criterion as on Windows (no group probe, no census), as in r10 E. */
  const win32Quiet = () => (facts: Parameters<typeof realCore.preparationQuiet>[0]) =>
    realCore.preparationQuiet(facts, { platform: "win32", probePidAlive: () => false });
  /** An unconfirmed stop as Windows reports it: no process group. */
  const windowsStop = (alive: boolean) => {
    const stop = unconfirmedStop(alive);
    return { ...stop, termination: { ...stop.termination, groups: [] } as CaptureTermination };
  };

  it.for(
    (["init", "add", "commit", "head"] as const).flatMap((stage) =>
      (["linux", "win32"] as const).map((platform) => [stage, platform] as const),
    ),
  )(
    "the bound cutting `%s` (%s step rule, injected) is a partial initialization carrying its termination; the step's stop is what that platform hands it",
    async ([stage, platform]) => {
      const root = folder();
      const live = new AbortController(); // a caller whose stop is never taken
      const { termination } = unconfirmedStop(false);
      const seen: { signal?: unknown } = {};
      intercept = cutAt(stage, termination, seen);
      const error = await ensureGitRepository(root, { signal: live.signal, platform }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(GitInitializationError);
      expect(error).not.toBeInstanceOf(PreparationStopped);
      expect(unconfirmedTerminationOf(error)).toBe(termination);
      expect((error as InstanceType<typeof GitInitializationError>).context).toEqual({
        termination_unconfirmed: {
          survivors: [],
          unresolved: [{ pgid: 4242, reason: "output_held" }],
          reason: "output_held",
        },
        project_git_initialization: {
          partial: true,
          gitignore_seeded: false,
          head_sha: null,
          ...progress[stage],
        },
      });
      expect((error as Error).message).toMatch(
        new RegExp(`^Git repository initialization was cut at its time bound during ${stage};`),
      );
      expect((error as Error).message).toMatch(/its end is unconfirmed/);
      // The step rule is unchanged: the user's step is handed no stop on Windows.
      expect(seen.signal).toBe(platform === "win32" ? undefined : live.signal);
    },
  );

  it("win32 (injected): a Stop during the user's `add`, which is not interrupted and then meets its bound, keeps the partial initialization and the termination", async () => {
    const root = folder();
    const controller = new AbortController();
    const { termination } = unconfirmedStop(true);
    let stopSeen: boolean | undefined;
    intercept = (args, opts) => {
      if (!args.includes("add")) return undefined;
      controller.abort("stop");
      stopSeen = opts.abortSignal?.aborted === true;
      return Promise.resolve(stoppedResult(termination));
    };
    const error = await ensureGitRepository(root, {
      signal: controller.signal,
      platform: "win32",
    }).catch((e: unknown) => e);
    expect(stopSeen).toBe(false);
    expect(error).toBeInstanceOf(GitInitializationError);
    expect(unconfirmedTerminationOf(error)).toBe(termination);
    expect((error as InstanceType<typeof GitInitializationError>).context).toMatchObject({
      termination_unconfirmed: { survivors: [4242], unresolved: [], reason: "direct_child_alive" },
      project_git_initialization: { partial: true, initialized: true, failed_stage: "add" },
    });
  });

  it("controls: a bound cutting a read before any mutation, an ordinary failure, a bound whose end was proven, a confirmed Stop and a healthy run keep what they were", async () => {
    // A read before the first mutation: nothing to disclose, the termination stays.
    let root = folder();
    const { termination } = unconfirmedStop(false);
    intercept = (args) =>
      args.includes("--is-inside-work-tree")
        ? Promise.resolve(stoppedResult(termination))
        : undefined;
    const read = await ensureGitRepository(root, { platform: "linux" }).catch((e: unknown) => e);
    expect(read).not.toBeInstanceOf(GitInitializationError);
    expect(unconfirmedTerminationOf(read)).toBe(termination);
    expect(existsSync(join(root, ".git"))).toBe(false);

    // An ordinary failure of a step (no termination): passed on as it was.
    root = folder();
    const fault = new Error("spawn git EAGAIN");
    intercept = (args) => (args.includes("add") ? Promise.reject(fault) : undefined);
    expect(await ensureGitRepository(root, { platform: "linux" }).catch((e: unknown) => e)).toBe(
      fault,
    );

    // The bound with a proven end: the step's own failure, no termination.
    root = folder();
    intercept = (args) =>
      args.includes("add")
        ? Promise.resolve({
            ...stoppedResult({ status: "confirmed", proof: "group_empty" }),
            drain: undefined,
          })
        : undefined;
    const proven = await ensureGitRepository(root, { platform: "linux" }).catch((e: unknown) => e);
    expect(proven).toBeInstanceOf(GitInitializationError);
    expect((proven as Error).message).toMatch(/^git add failed during repository initialization/);
    expect((proven as InstanceType<typeof GitInitializationError>).context).not.toHaveProperty(
      "termination_unconfirmed",
    );

    // A confirmed Stop after the first mutation: the stop's wording, no termination.
    root = folder();
    const controller = new AbortController();
    intercept = (args) => {
      if (!args.includes("add")) return undefined;
      controller.abort("stop");
      return Promise.resolve({
        ...stoppedResult({ status: "confirmed", proof: "group_empty" }),
        drain: undefined,
      });
    };
    const stopped = await ensureGitRepository(root, {
      signal: controller.signal,
      platform: "linux",
    }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(GitInitializationError);
    expect((stopped as Error).message).toMatch(/was stopped during add/);
    expect(unconfirmedTerminationOf(stopped)).toBeUndefined();

    // Healthy.
    intercept = null;
    root = folder();
    expect(await ensureGitRepository(root, { platform: "linux" })).toMatchObject({
      initialized: true,
      baselineCommitted: true,
    });
  });

  it("through the thread's preparation: a proven end leaves the partial initialization without the termination; where no read proves it (injected), the hold carries both — then the operator's confirmation releases it and the next turn makes the tree", async () => {
    const turn = async (platform: NodeJS.Platform, quiet: ReturnType<typeof win32Quiet>) => {
      const root = folder();
      const { termination } = windowsStop(false);
      intercept = (args) =>
        args.includes("add") ? Promise.resolve(stoppedResult(termination)) : undefined;
      const error = await ensureThreadWorktree(root, "th-bound", { platform, quiet }).catch(
        (e: unknown) => e,
      );
      intercept = null;
      return { root, error };
    };
    const proven = await turn("linux", (facts) =>
      realCore.preparationQuiet(facts, { platform: "linux" }),
    );
    expect(proven.error).toBeInstanceOf(GitInitializationError);
    expect((proven.error as Error).message).toMatch(
      /^Git repository initialization was cut at its time bound during add;.*what the stopped step started has since ended/s,
    );
    expect((proven.error as InstanceType<typeof GitInitializationError>).context).toEqual({
      project_git_initialization: expect.objectContaining({
        partial: true,
        initialized: true,
        failed_stage: "add",
      }),
    });

    const held = await turn("win32", win32Quiet());
    expect(held.error).toBeInstanceOf(PreparationHeld);
    expect(held.error).toMatchObject({
      code: "termination_unconfirmed",
      context: {
        termination_unconfirmed: { survivors: [], unresolved: [], reason: "output_held" },
        release_requires: "operator_confirmation",
        project_git_initialization: { partial: true, initialized: true, failed_stage: "add" },
      },
    });
    expect((held.error as Error).message).toMatch(
      /^Git repository initialization was cut at its time bound during add;.*held until/s,
    );
    const tree = join(projectRuntimeDir(held.root), "threads", "th-bound", "tree");
    expect(await confirmAsInspected(held.root, tree, win32Quiet())).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
    });
    const next = await ensureThreadWorktree(held.root, "th-bound", {
      platform: "win32",
      quiet: win32Quiet(),
    });
    expect(next.created).toBe(true);
  });
});
