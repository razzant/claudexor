import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readRunEvents } from "@claudexor/event-log";
import { ArtifactStore } from "@claudexor/artifact-store";
import { makeOutcomeFacts, type WorkspaceEnvelope } from "@claudexor/schema";
import {
  WorkspaceManager,
  envelopeBaseOf,
  readEnvelopeCustody,
  retainedEnvelopeOfRun,
} from "@claudexor/workspace";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CandidateRun } from "./candidateEvidence.js";
import { flushContinuationTerminal, forRun, sessionCapsuleFile } from "./continuation-custody.js";
import type { AnnouncedRunContext } from "./runTerminalContext.js";

/** Synchronous `node:fs` calls made by any module of this test while counting. */
const sync = vi.hoisted(() => ({ counting: false, calls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual))
    if (name.endsWith("Sync") && typeof value === "function")
      patched[name] = (...args: unknown[]) => {
        if (sync.counting) sync.calls.push(name);
        return (value as (...callArgs: unknown[]) => unknown)(...args);
      };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-custody-${name}-`)));
  dirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = temp("repo");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

function fakeLog() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  /** Types whose emit throws, as an emit throws a landing failure the journal holds. */
  const refused = new Set<string>();
  const record = (type: string, payload: Record<string, unknown> = {}) => {
    if (refused.has(type)) throw new Error(`journal refused ${type}`);
    events.push({ type, payload });
    return {} as never;
  };
  const log = { deferTerminal() {}, emit: record, emitAside: record } as unknown as EventLog;
  return { log, events, refused };
}

function candidate(
  env: WorkspaceEnvelope,
  facts: { diff?: string; errored?: boolean; workState?: string },
): CandidateRun {
  return {
    attemptId: env.attempt_id,
    harnessId: "fake",
    label: "Candidate A",
    diff: facts.diff ?? "",
    reviewCwd: env.worktree_path,
    gates: [],
    cost: 0,
    errored: facts.errored ?? false,
    costEstimated: false,
    errors: [],
    telemetry: {
      outcome: facts.workState ? { workState: { state: facts.workState } } : undefined,
    } as never,
  };
}

function setup(retain: boolean, signal?: AbortSignal) {
  const repo = initRepo();
  const runDir = temp("run");
  const paths = { root: runDir, attemptsDir: join(runDir, "attempts") };
  const { log, events, refused } = fakeLog();
  const kept = forRun({ continuation: { retain }, signal }, true, "run-1", paths, log);
  const wsm = new WorkspaceManager(repo);
  const create = () => kept.envelope(wsm, { taskId: "task-1", attemptId: "a01", baseRef: "HEAD" });
  return { repo, runDir, paths, kept, wsm, create, events, refused };
}

describe("candidate envelope custody (A9)", () => {
  it.each([true, false])(
    "still publishes the terminal when settlement throws (terminal already pending: %s)",
    async (pending) => {
      const repo = initRepo();
      const store = new ArtifactStore(repo);
      const paths = store.createRun("run-settle");
      const log = new EventLog(paths.eventsPath, "run-settle", "task-settle");
      const context: AnnouncedRunContext = {
        store,
        paths,
        log,
        runId: "run-settle",
        taskId: "task-settle",
        mode: "agent",
        phase: "settle",
      };
      const kept = forRun({ continuation: { retain: true } }, true, context.runId, paths, log);
      const wsm = new WorkspaceManager(repo);
      const env = await kept.envelope(wsm, {
        taskId: "task-settle",
        attemptId: "a01",
        baseRef: "HEAD",
      });
      await kept.settle(wsm, env, [candidate(env, { errored: true })]);
      const settle = vi
        .spyOn(wsm, "dispose")
        .mockRejectedValue(new Error("injected settle failure"));
      const facts = makeOutcomeFacts("failed");
      try {
        log.emit("run.created", { prompt: "Test terminal settlement" });
        if (pending) log.emit("run.failed", { facts });
        expect(log.terminalCommitted()).toBe(false);
        await expect(flushContinuationTerminal(context, facts)).rejects.toThrow(
          "injected settle failure",
        );
        // With no deferred event, the terminal guard must still be able to publish
        // its fallback: the deferral stands until a terminal commits, so the
        // fallback is held, and the guard's flush publishes it.
        if (!pending) {
          log.emit("run.failed", { facts });
          expect(log.terminalCommitted()).toBe(false);
          await flushContinuationTerminal(context, facts);
        }
        expect(log.terminalCommitted()).toBe(true);
        const written = readRunEvents(paths.eventsPath).events;
        // #411(f): the failure is disclosed once, before the terminal, which still publishes.
        expect(written.map((event) => event.type)).toEqual([
          "run.created",
          "workspace.settlement_failed",
          "run.failed",
        ]);
        expect(written[1]?.payload).toEqual({
          attempt_id: "a01",
          envelope_id: env.id,
          root: env.worktree_path,
          stage: "dispose",
          cause: "injected settle failure",
        });
        // The failed settle is removed: a guard retry must not repeat the failing operation.
        await expect(flushContinuationTerminal(context, facts)).resolves.toBeUndefined();
        expect(settle).toHaveBeenCalledTimes(1);
      } finally {
        settle.mockRestore();
        log.dispose();
      }
    },
  );

  it("a diagnostic that cannot be written changes neither the error, the terminal nor the retry", async () => {
    const repo = initRepo();
    const store = new ArtifactStore(repo);
    const paths = store.createRun("run-settle-quiet");
    const log = new EventLog(paths.eventsPath, "run-settle-quiet", "task-settle");
    const context: AnnouncedRunContext = {
      store,
      paths,
      log,
      runId: "run-settle-quiet",
      taskId: "task-settle",
      mode: "agent",
      phase: "settle",
    };
    const kept = forRun({ continuation: { retain: true } }, true, context.runId, paths, log);
    const wsm = new WorkspaceManager(repo);
    const env = await kept.envelope(wsm, {
      taskId: "task-settle",
      attemptId: "a01",
      baseRef: "HEAD",
    });
    await kept.settle(wsm, env, [candidate(env, { errored: true })]);
    const settle = vi.spyOn(wsm, "dispose").mockRejectedValue(new Error("injected settle failure"));
    const emit = log.emit.bind(log);
    const diagnostic = vi.spyOn(log, "emit").mockImplementation((type, payload, publish) => {
      if (type === "workspace.settlement_failed") throw new Error("diagnostic write failed");
      return emit(type, payload, publish);
    });
    const facts = makeOutcomeFacts("failed");
    try {
      log.emit("run.created", { prompt: "Test terminal settlement" });
      log.emit("run.failed", { facts });
      await expect(flushContinuationTerminal(context, facts)).rejects.toThrow(
        "injected settle failure",
      );
      expect(log.terminalCommitted()).toBe(true);
      expect(readRunEvents(paths.eventsPath).events.map((event) => event.type)).toEqual([
        "run.created",
        "run.failed",
      ]);
      expect(diagnostic).toHaveBeenCalledWith(
        "workspace.settlement_failed",
        expect.objectContaining({ stage: "dispose" }),
      );
      await expect(flushContinuationTerminal(context, facts)).resolves.toBeUndefined();
      expect(settle).toHaveBeenCalledTimes(1);
    } finally {
      diagnostic.mockRestore();
      settle.mockRestore();
      log.dispose();
    }
  });

  it.each([true, false])(
    "settles the run directory before custody: a line lost first leaves custody and the terminal for the net (lost: %s)",
    async (lost) => {
      const repo = initRepo();
      const store = new ArtifactStore(repo);
      const runId = `run-settle-first-${lost}`;
      const paths = store.createRun(runId);
      const log = new EventLog(
        paths.eventsPath,
        runId,
        "task-settle",
        (event) => {
          if (event.payload["text"] === "lost") throw new Error("journal refused harness.event");
        },
        undefined,
        undefined,
        { queued: true },
      );
      const context: AnnouncedRunContext = {
        store,
        paths,
        log,
        runId,
        taskId: "task-settle",
        mode: "agent",
        phase: "settle",
      };
      const kept = forRun({ continuation: { retain: true } }, true, runId, paths, log);
      const wsm = new WorkspaceManager(repo);
      const env = await kept.envelope(wsm, {
        taskId: "task-settle",
        attemptId: "a01",
        baseRef: "HEAD",
      });
      writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
      await kept.settle(wsm, env, [
        candidate(env, { diff: "diff --git a/a b/a\n", errored: true }),
      ]);
      const facts = makeOutcomeFacts("failed");
      await log.emitLanded("run.created", { prompt: "Test terminal settlement" });
      // The run's last line, refused at landing while nobody awaits it.
      if (lost) log.emit("harness.event", { text: "lost" });
      log.emit("run.failed", { facts });
      const types = () => readRunEvents(paths.eventsPath).events.map((event) => event.type);
      try {
        if (lost) {
          // Direction 1: the flush rejects before custody or the terminal moved.
          await expect(flushContinuationTerminal(context, facts)).rejects.toThrow(
            "journal refused harness.event",
          );
          expect(readEnvelopeCustody(envelopeBaseOf(env))?.state).toBe("live");
          expect(log.terminalCommitted()).toBe(false);
          expect(log.deferredTerminalPending()?.type).toBe("run.failed");
          expect(types().filter((type) => type.startsWith("workspace."))).toEqual([]);
        }
        // Direction 2 (and the net's next flush): custody keeps the work, once,
        // before the terminal.
        await flushContinuationTerminal(context, facts);
        expect(readEnvelopeCustody(envelopeBaseOf(env))?.state).toBe("retained");
        expect(log.terminalCommitted()).toBe(true);
        expect(types().filter((type) => type !== "harness.event")).toEqual([
          "run.created",
          "workspace.retained",
          "run.failed",
        ]);
      } finally {
        log.dispose();
      }
    },
  );

  it("a journal failure after the envelope was kept is not reported as a failed settlement", async () => {
    const { kept, wsm, create, events, refused, runDir } = setup(true);
    const env = await create();
    await kept.settle(wsm, env, [candidate(env, { diff: "diff --git a/a b/a\n", errored: true })]);
    refused.add("workspace.retained");
    // Direction 1: the journal's failure is the run's, thrown as it is.
    await expect(kept.finish(makeOutcomeFacts("failed"))).rejects.toThrow("journal refused");
    expect(events.filter((event) => event.type === "workspace.settlement_failed")).toEqual([]);
    // Direction 2: the envelope is kept all the same.
    expect(readEnvelopeCustody(envelopeBaseOf(env))?.state).toBe("retained");
    expect(retainedEnvelopeOfRun(runDir, "run-1")?.envelope.id).toBe(env.id);
  });

  it("keeps the envelope of an errored candidate that changed files and discloses it", async () => {
    const { kept, wsm, create, events, runDir } = setup(true);
    const env = await create();
    expect(readEnvelopeCustody(envelopeBaseOf(env))?.state).toBe("live");
    await kept.settle(wsm, env, [candidate(env, { diff: "diff --git a/a b/a\n", errored: true })]);
    await kept.finish(makeOutcomeFacts("failed"));
    expect(existsSync(env.worktree_path)).toBe(true);
    expect(retainedEnvelopeOfRun(runDir, "run-1")?.envelope.id).toBe(env.id);
    expect(events).toEqual([
      expect.objectContaining({
        type: "workspace.retained",
        payload: expect.objectContaining({ root: env.worktree_path, cause: null }),
      }),
    ]);
  });

  it("keeps unfinished work at the run end without walking its tree on the main thread (#704)", async () => {
    const { kept, wsm, create, runDir } = setup(true);
    const env = await create();
    // A kept tree with many entries: a synchronous disk-use walk reads each one.
    for (let i = 0; i < 120; i += 1) writeFileSync(join(env.worktree_path, `f${i}.txt`), "x\n");
    await kept.settle(wsm, env, [candidate(env, { diff: "diff --git a/a b/a\n", errored: true })]);
    sync.calls.length = 0;
    sync.counting = true;
    try {
      await kept.finish(makeOutcomeFacts("failed"));
    } finally {
      sync.counting = false;
    }
    // Direction 1: the run end listed and measured none of the tree synchronously.
    const walked = sync.calls.filter((name) => name === "readdirSync" || name === "lstatSync");
    expect(walked.length).toBeLessThan(10);
    // Direction 2: the envelope is kept, its custody and size recorded.
    const custody = readEnvelopeCustody(envelopeBaseOf(env));
    expect(custody).toMatchObject({ state: "retained" });
    expect(custody?.bytes).toBeGreaterThan(120 * 2);
    expect(retainedEnvelopeOfRun(runDir, "run-1")?.envelope.id).toBe(env.id);
  });

  it("keeps needs_input work and a cancelled session, and names the cause", async () => {
    const waiting = setup(true);
    const env = await waiting.create();
    writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
    await waiting.kept.settle(waiting.wsm, env, [
      candidate(env, { diff: "x", workState: "needs_input" }),
    ]);
    await waiting.kept.finish(makeOutcomeFacts("succeeded"));
    expect(readEnvelopeCustody(envelopeBaseOf(env))?.cause).toBe("input_required");

    // A cancelled run with no diff but a native session capsule is kept too.
    const abort = new AbortController();
    const cancelled = setup(true, abort.signal);
    const env2 = await cancelled.create();
    mkdirSync(join(cancelled.paths.attemptsDir, "a01"), { recursive: true });
    writeFileSync(sessionCapsuleFile(join(cancelled.paths.attemptsDir, "a01")), "{}\n");
    abort.abort("wall_clock_exceeded");
    await cancelled.kept.settle(cancelled.wsm, env2, [candidate(env2, { errored: true })]);
    await cancelled.kept.finish(makeOutcomeFacts("cancelled"));
    expect(readEnvelopeCustody(envelopeBaseOf(env2))?.cause).toBe("wall_clock");
  });

  it("disposes finished work, work with nothing to continue, and non-daemon runs", async () => {
    const done = setup(true);
    const env = await done.create();
    await done.kept.settle(done.wsm, env, [candidate(env, { diff: "x", workState: "completed" })]);
    await done.kept.finish(makeOutcomeFacts("succeeded"));
    expect(existsSync(envelopeBaseOf(env))).toBe(false);

    const empty = setup(true);
    const env2 = await empty.create();
    await empty.kept.settle(empty.wsm, env2, [candidate(env2, { errored: true })]);
    await empty.kept.finish(makeOutcomeFacts("failed"));
    expect(existsSync(envelopeBaseOf(env2))).toBe(false);

    const local = setup(false);
    const env3 = await local.create();
    expect(readEnvelopeCustody(envelopeBaseOf(env3))).toBeNull();
    await local.kept.settle(local.wsm, env3, [candidate(env3, { diff: "x", errored: true })]);
    expect(existsSync(envelopeBaseOf(env3))).toBe(false);
  });

  it("a successor adopts the kept envelope instead of creating one, and keeps it again when it stops", async () => {
    const first = setup(true);
    const env = await first.create();
    writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
    await first.kept.settle(first.wsm, env, [candidate(env, { diff: "x", errored: true })]);
    await first.kept.finish(makeOutcomeFacts("failed"));
    const custody = retainedEnvelopeOfRun(first.runDir, "run-1")!;

    const succRunDir = temp("succ");
    const paths = { root: succRunDir, attemptsDir: join(succRunDir, "attempts") };
    const { log } = fakeLog();
    const next = forRun(
      { continuation: { retain: true, adopt: custody } },
      true,
      "run-2",
      paths,
      log,
    );
    const adopted = await next.envelope(first.wsm, {
      taskId: "task-2",
      attemptId: "a01",
      baseRef: "HEAD",
    });
    expect(adopted.worktree_path).toBe(env.worktree_path);
    expect(readEnvelopeCustody(envelopeBaseOf(adopted))).toMatchObject({
      state: "live",
      holder_run_id: "run-2",
    });
    // The successor's run-level capture reaches the adopted envelope by its
    // own attempt id; the envelope keeps the predecessor's identity.
    await next.settle(first.wsm, adopted, [
      { ...candidate(adopted, { diff: "x", errored: true }), attemptId: "a01" },
    ]);
    await next.finish(makeOutcomeFacts("failed"));
    expect(retainedEnvelopeOfRun(succRunDir, "run-2")?.envelope.id).toBe(env.id);
    expect(retainedEnvelopeOfRun(first.runDir, "run-1")).toBeNull();
  });
});
