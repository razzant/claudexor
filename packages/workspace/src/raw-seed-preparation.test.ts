// A8 home tests: real private bases and raw records; inject only the result of
// the seed's Git transaction and the read used to decide its existing release.
// No held subprocess, hook, signal delivery or retry is needed for this fault.
import { execFileSync } from "node:child_process";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintRunScopeMarker,
  type CaptureResult,
  type PreparationQuietVerdict,
} from "@claudexor/core";
import { WorkspaceManager } from "./manager.js";
import { readEnvelopeCustody } from "./envelope-custody.js";
import { readEnvelopePreparation, releaseEnvelopeBase } from "./envelope-preparation.js";
import {
  preparationStopsOf,
  PreparationStopped,
  unconfirmedTerminationOf,
  withScopeMarker,
} from "./git-run.js";
import { RAW_ACCEPTED_REF, transferRawRecords } from "./raw-patch.js";

let intercept: ((args: string[]) => Promise<CaptureResult> | undefined) | null = null;
let quiet: PreparationQuietVerdict = { status: "quiet" };
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (cmd: string, args: string[], opts: Parameters<typeof core.runCaptureRaw>[2]) =>
      (cmd === "git" ? intercept?.(args) : undefined) ?? core.runCaptureRaw(cmd, args, opts),
    preparationQuiet: async () => quiet,
  };
});

const roots: string[] = [];
afterEach(() => {
  intercept = null;
  quiet = { status: "quiet" };
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-seed-base-")));
  roots.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  const emptyConfig = join(root, "gitconfig");
  writeFileSync(emptyConfig, "");
  for (const [key, value] of Object.entries({
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    CLAUDEXOR_CONFIG_DIR: join(root, "config"),
  }))
    vi.stubEnv(key, value);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  git(repo, "update-ref", RAW_ACCEPTED_REF, tree);
  const runtime = join(root, "runtime");
  return {
    root,
    repo,
    git,
    tree,
    base: join(runtime, "workspaces", "t", "a1"),
    manager: new WorkspaceManager(repo, { runtimeRoot: runtime }),
  };
}

const seedTransaction = (args: string[]) => args.includes("update-ref") && args.includes("--stdin");

const unconfirmed = (): CaptureResult => ({
  code: null,
  signal: "SIGKILL",
  stdout: "",
  stderr: "",
  drain: "truncated",
  termination: {
    status: "unconfirmed",
    reason: "output_held",
    rootPid: 4242,
    groups: [4242],
    directExited: true,
    directExitObservedAt: Date.now(),
    directExit: Promise.resolve(),
  },
});

describe("Raw membership before envelope handoff (A8)", () => {
  it("a time-bound unconfirmed transfer holds the whole base, without installing continuation custody", async () => {
    const w = world();
    const releases: Array<() => Promise<void>> = [];
    const signal = withScopeMarker(undefined, mintRunScopeMarker(), (release) =>
      releases.push(release),
    );
    let calls = 0;
    intercept = (args) => {
      if (!seedTransaction(args)) return undefined;
      calls += 1;
      return Promise.resolve(unconfirmed());
    };
    quiet = { status: "held", reasons: ["injected seed descendant is alive"] };
    const error: unknown = await w.manager
      .create({
        taskId: "t",
        attemptId: "a1",
        seedRawRecords: true,
        signal,
        custody: { runId: "run", runDir: join(w.root, "run") },
      })
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(calls).toBe(1);
    expect(signal.aborted).toBe(false); // a watchdog failure, not a user Stop
    expect(error).not.toBeInstanceOf(PreparationStopped);
    expect(unconfirmedTerminationOf(error)?.status).toBe("unconfirmed");
    expect(error).toMatchObject({ heldBase: w.base });
    expect(readFileSync(join(w.base, "tree", "README.md"), "utf8")).toBe("base\n");
    expect(readEnvelopeCustody(w.base)).toBeNull();
    expect(readEnvelopePreparation(w.base)).toMatchObject({ preparing: true });
    const termination = {
      survivors: [],
      unresolved: [{ pgid: 4242, reason: "output_held" }],
      reason: "output_held",
    };
    // The producer records the one capture, not every wrapper that rethrows it;
    // no caller signal or event-log replay is needed for the terminal's carrier.
    expect(preparationStopsOf(signal)).toEqual({
      termination_unconfirmed: termination,
      held: [w.base],
    });
    expect(releases).toHaveLength(1);
    await releases[0]!(); // a settlement callback is not itself proof
    expect(existsSync(w.base)).toBe(true);
    quiet = { status: "quiet", unproven: "no process census" };
    expect(await releaseEnvelopeBase(w.base)).toBe(false);
    expect(existsSync(w.base)).toBe(true);
    quiet = { status: "quiet" };
    await releases[0]!(); // the same release now has proof
    expect(existsSync(w.base)).toBe(false);
    expect(preparationStopsOf(signal)).toEqual({ termination_unconfirmed: termination, held: [] });
    expect(w.git(w.repo, "rev-parse", RAW_ACCEPTED_REF)).toBe(w.tree);
  });

  it("negative control: the old seed-after-handoff finally really disposes a base with unconfirmed Git", async () => {
    const w = world();
    const releases: Array<() => Promise<void>> = [];
    const signal = withScopeMarker(undefined, mintRunScopeMarker(), (release) =>
      releases.push(release),
    );
    const envelope = await w.manager.create({ taskId: "t", attemptId: "a1", signal });
    expect(readEnvelopePreparation(w.base)?.preparing).toBe(false);
    intercept = (args) => (seedTransaction(args) ? Promise.resolve(unconfirmed()) : undefined);
    quiet = { status: "held", reasons: ["injected seed descendant is alive"] };
    let error: unknown;
    try {
      await transferRawRecords(w.repo, envelope.worktree_path, signal);
    } catch (failure) {
      error = failure;
    } finally {
      await w.manager.dispose(envelope); // exactly the old caller's cleanup; no stub
    }
    expect(unconfirmedTerminationOf(error)?.status).toBe("unconfirmed");
    expect(error).not.toHaveProperty("heldBase");
    expect(releases).toEqual([]);
    expect(existsSync(w.base)).toBe(false); // the old boundary loses the real base
  });

  it("an ordinary transfer error still removes an unscoped never-started base", async () => {
    const w = world();
    intercept = (args) =>
      seedTransaction(args)
        ? Promise.resolve({ code: 1, signal: null, stdout: "", stderr: "injected ref refusal" })
        : undefined;
    await expect(
      w.manager.create({ taskId: "t", attemptId: "a1", seedRawRecords: true }),
    ).rejects.toThrow("injected ref refusal");
    expect(existsSync(w.base)).toBe(false);
    expect(w.git(w.repo, "rev-parse", RAW_ACCEPTED_REF)).toBe(w.tree);
  });

  it.each([false, true])(
    "a healthy candidate seeds only when requested (%s), then uses ordinary disposal",
    async (seedRawRecords) => {
      const w = world();
      let seedCalls = 0;
      intercept = (args) => {
        if (seedTransaction(args)) seedCalls += 1;
        return undefined;
      };
      const envelope = await w.manager.create({
        taskId: "t",
        attemptId: "a1",
        seedRawRecords,
        custody: { runId: "run", runDir: join(w.root, "run") },
      });
      expect(seedCalls).toBe(seedRawRecords ? 1 : 0);
      if (seedRawRecords)
        expect(w.git(envelope.worktree_path, "rev-parse", RAW_ACCEPTED_REF)).toBe(w.tree);
      expect(readEnvelopePreparation(w.base)?.preparing).toBe(false);
      expect(readEnvelopeCustody(w.base)?.state).toBe("live");
      await w.manager.dispose(envelope);
      expect(existsSync(w.base)).toBe(false);
    },
  );

  it("source=destination stays a no-op, including equivalent paths and an already-aborted signal", async () => {
    const w = world();
    let captures = 0;
    intercept = () => {
      captures += 1;
      throw new Error("a same-tree seed must start no Git");
    };
    const stop = new AbortController();
    stop.abort("already stopped");
    await transferRawRecords(w.repo, w.repo, stop.signal);
    await transferRawRecords(w.repo, `${w.repo}/child/..`, stop.signal);
    expect(captures).toBe(0);
    intercept = null;
    const envelope = await w.manager.create({
      taskId: "t",
      attemptId: "a1",
      seedRawRecords: true,
      inPlace: true,
    });
    expect(envelope.worktree_path).toBe(w.repo);
    await w.manager.dispose(envelope);
    expect(existsSync(w.base)).toBe(false);
    expect(readFileSync(join(w.repo, "README.md"), "utf8")).toBe("base\n");
    expect(w.git(w.repo, "rev-parse", RAW_ACCEPTED_REF)).toBe(w.tree);
  });

  it("a directory envelope does not start a raw-record transfer", async () => {
    const w = world();
    let seedCalls = 0;
    intercept = (args) => {
      if (seedTransaction(args)) seedCalls += 1;
      return undefined;
    };
    const envelope = await w.manager.create({
      taskId: "t",
      attemptId: "a1",
      seedRawRecords: true,
      workspaceKind: "directory",
      scopePaths: ["README.md"],
    });
    expect(seedCalls).toBe(0);
    expect(readFileSync(join(envelope.worktree_path, "README.md"), "utf8")).toBe("base\n");
    await w.manager.dispose(envelope);
    expect(existsSync(w.base)).toBe(false);
    expect(existsSync(join(w.repo, "README.md"))).toBe(true);
  });
});
