// #694 V16: what a thread turn refused before its run keeps, from the real
// preparation error to the turn's `enqueue_error`. The error is the one the
// isolated thread's preparation (`ensureThreadWorktree`, real Git) returns when
// the first initialization's `add` was cut by Git's 60 s bound with its end
// unproven and no stop was taken; only that one capture is replaced. An
// in-process `DaemonServer` settles it (`settleJobError`) and carries it
// (its socket in this test's folder, no child process) to `onTurnEnqueueFailed`,
// which records it on a turn of the real SQL thread store. The store's flusher
// is a worker thread of this process; everything is closed through its handle.
//
// Not reached here: the daemon runner's scope settlement (`closeAfter`), which
// reaps the scope's members by a process census, returns the same error object.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult, CaptureTermination } from "@claudexor/core";

let cut: ((args: string[]) => Promise<CaptureResult> | undefined) | null = null;
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (cmd: string, args: string[], opts: Parameters<typeof core.runCaptureRaw>[2]) =>
      (cmd === "git" ? cut?.(args) : undefined) ?? core.runCaptureRaw(cmd, args, opts),
  };
});

const realCore = await vi.importActual<typeof import("@claudexor/core")>("@claudexor/core");
const { ensureThreadWorktree } = await import("@claudexor/workspace");
const { DaemonServer } = await import("./server.js");
const { DaemonClient } = await import("./client.js");
const { EngineStore } = await import("./store/store.js");
const { createSqlDaemonServices } = await import("./store/sql-daemon-services.js");
const { createPartition } = await import("./store/partitions.js");
const { setGlobalGenerationInTx } = await import("./store/generations.js");
const { DurableJournal } = await import("./store/test-support/fixtures/legacy/journal/index.js");
const { CommandStore } =
  await import("./store/test-support/fixtures/legacy/daemon/command-store.js");
const { legacyCommandFixture } = await import("./store/test-support/legacy-command-fixture.js");
type JobRecord = import("./server.js").JobRecord;

const closes: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];
afterEach(async () => {
  cut = null;
  for (const close of closes.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** An unconfirmed end as Windows reports it (no process group), or POSIX (one). */
const unconfirmed = (groups: number[]): CaptureTermination => ({
  status: "unconfirmed",
  reason: "output_held",
  rootPid: 4242,
  groups,
  directExited: true,
  directExitObservedAt: Date.now(),
  directExit: Promise.resolve(),
});
const capture = (termination: CaptureTermination): CaptureResult => ({
  code: null,
  signal: "SIGKILL",
  stdout: "",
  stderr: "",
  drain: "truncated",
  termination,
});
/** The release criterion as on Windows: no group probe, no census, no pid alive. */
const windowsRead = (facts: Parameters<typeof realCore.preparationQuiet>[0]) =>
  realCore.preparationQuiet(facts, { platform: "win32", probePidAlive: () => false });
/** A read that proves the end (nothing is probed: there is no group to probe). */
const provingRead = (facts: Parameters<typeof realCore.preparationQuiet>[0]) =>
  realCore.preparationQuiet(facts, { platform: "linux" });

type Case = "bound_held" | "bound_held_posix_groups" | "bound_proven" | "stop_held";
/** The real error the thread's preparation returns for one case. */
async function preparationError(kind: Case): Promise<unknown> {
  const root = temp("cx-enq-");
  writeFileSync(join(root, "a.txt"), "a\n");
  const controller = new AbortController();
  const termination = unconfirmed(kind === "bound_held_posix_groups" ? [4242] : []);
  cut = (args) => {
    if (!(args.includes(root) && args.includes("add"))) return undefined;
    if (kind === "stop_held") controller.abort("stop"); // the step takes the Stop itself
    return Promise.resolve(capture(termination));
  };
  try {
    return await ensureThreadWorktree(root, "th-enq", {
      ...(kind === "stop_held" ? { signal: controller.signal } : {}),
      platform: kind === "bound_held" ? "win32" : "linux",
      quiet: kind === "bound_proven" ? provingRead : windowsRead,
    }).then(
      () => new Error("the preparation unexpectedly succeeded"),
      (error: unknown) => error,
    );
  } finally {
    cut = null;
  }
}

const initialization = {
  partial: true,
  initialized: true,
  baseline_committed: false,
  gitignore_seeded: false,
  head_sha: null,
  failed_stage: "add",
};
/** What `enqueue_error.context` must keep for each case (the settled, bounded context). */
const kept: Record<Case, Record<string, unknown>> = {
  bound_held: {
    termination_unconfirmed: { survivors: [], unresolved: [], reason: "output_held" },
    project_git_initialization: initialization,
    release_requires: "operator_confirmation",
  },
  // The bound's own facts survive; each unresolved group is an object one level
  // below the problem context's depth bound (`safeProblemContext`, depth 3), so it
  // is kept as `[bounded]` there, as for any stop's.
  bound_held_posix_groups: {
    termination_unconfirmed: { survivors: [], unresolved: ["[bounded]"], reason: "output_held" },
    project_git_initialization: initialization,
  },
  bound_proven: { project_git_initialization: initialization },
  stop_held: {
    termination_unconfirmed: { survivors: [], unresolved: [], reason: "output_held" },
    project_git_initialization: initialization,
  },
};
const message: Record<Case, RegExp> = {
  bound_held:
    /^Git repository initialization was cut at its time bound during add;.*its end is unconfirmed.*held until/s,
  bound_held_posix_groups:
    /^Git repository initialization was cut at its time bound during add;.*its end is unconfirmed.*held until/s,
  bound_proven:
    /^Git repository initialization was cut at its time bound during add;.*what the stopped step started has since ended/s,
  stop_held: /^Git repository initialization was stopped during add;.*held until/s,
};
const CASES: Case[] = ["bound_held", "bound_held_posix_groups", "bound_proven", "stop_held"];

describe("a thread turn's refusal keeps a cut initialization (#694 V16)", () => {
  it("through the daemon's settlement to the turn's recorded enqueue_error (in-process server, real SQL thread store)", async () => {
    const thrown = new Map<Case, unknown>();
    for (const kind of CASES) thrown.set(kind, await preparationError(kind));

    const dir = temp("d-enq-");
    const engine = await EngineStore.open({
      daemonDir: dir,
      workerEntry: resolve(import.meta.dirname, "../dist/store/flusher-worker.js"),
    });
    closes.push(() => engine.close());
    engine.transaction(() =>
      setGlobalGenerationInTx(engine, createPartition(engine, "global").pid),
    );
    const graph = createSqlDaemonServices(engine, { purgeFiles: async () => [] });
    closes.push(() => graph.close());
    const thread = graph.threads.createThread({});
    const turns = new Map(CASES.map((kind) => [kind, graph.threads.createTurn(thread.id, kind)]));

    const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
    closes.push(() => journal.close());
    const commands = new CommandStore(journal);
    commands.recoverAfterStartup();
    const server = new DaemonServer({
      socketPath: join(dir, "d.sock"),
      token: "token",
      commands: legacyCommandFixture({ current: () => commands }),
      onTurnEnqueueFailed: (turnId, problem) => graph.threads.setTurnEnqueueError(turnId, problem),
      runner: async (params) => {
        throw thrown.get((params as { kind: Case }).kind);
      },
    });
    await server.start();
    closes.push(() => server.stop());
    const client = new DaemonClient(join(dir, "d.sock"), "token");
    for (const kind of CASES) {
      const job = await client.enqueue({ kind, turnId: turns.get(kind)!.id });
      let record = (await client.status(job.id)) as JobRecord;
      for (let i = 0; i < 400 && (record.state === "queued" || record.state === "running"); i++) {
        await new Promise((r) => setTimeout(r, 5));
        record = (await client.status(job.id)) as JobRecord;
      }
      expect(record.state, kind).toBe("failed");
      const refusal = graph.threads.getTurn(turns.get(kind)!.id)?.enqueue_error;
      expect(refusal?.context, kind).toMatchObject(kept[kind]);
      expect(refusal?.message, kind).toMatch(message[kind]);
      if (kind === "bound_proven")
        expect(refusal?.context).not.toHaveProperty("termination_unconfirmed");
      if (kind !== "bound_proven") expect(refusal?.code, kind).toBe("termination_unconfirmed");
    }
  });
});
