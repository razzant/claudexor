import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, promises, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger } from "@claudexor/budget";
import { EventLog, liveRunEventSeq, readRunEvents } from "@claudexor/event-log";
import { makeOutcomeFacts, type RunEvent } from "@claudexor/schema";
import { orderedAppender } from "@claudexor/util";
import { WorkspaceManager, envelopeBaseOf } from "@claudexor/workspace";
import { forRun } from "./continuation-custody.js";
import type { OrchestratorResult } from "./orchestrator.js";
import { guardAnnouncedRun, type AnnouncedRunContext } from "./runTerminals.js";

const realOpen = promises.open;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture(runId: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-held-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun(runId);
  const log = new EventLog(paths.eventsPath, runId, "task-held");
  return { store, paths, log };
}

function terminals(eventsPath: string): Array<{ type: string; lifecycle: string | undefined }> {
  return readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; payload?: { lifecycle?: string } })
    .filter((event) => /^run\.(completed|failed|cancelled)$/.test(event.type))
    .map((event) => ({ type: event.type, lifecycle: event.payload?.lifecycle }));
}

describe("held terminal, late throw (fix round 4 item 3 / Astra R1)", () => {
  it.each([
    { kind: "an ordinary run keeps its held success", delegate: false, lifecycle: "succeeded" },
    { kind: "a Delegate parent is still cancelled", delegate: true, lifecycle: "cancelled" },
  ])(
    "abort DURING the barrier of a strategy that held its success and then threw: $kind",
    async ({ delegate, lifecycle }) => {
      const runId = delegate ? "run-held-delegate" : "run-held-ordinary";
      const { store, paths, log } = fixture(runId);
      const controller = new AbortController();
      const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
      const result = await guardAnnouncedRun(
        controller.signal,
        async (announce) => {
          log.emit("run.created", { mode: "agent", prompt: "x" });
          announce({
            log,
            store,
            paths,
            runId,
            taskId: "task-held",
            mode: "agent",
            phase: "race",
            spend: () => root.spend(),
            valuation: () => root.valuation(),
            spendEstimated: () => root.estimated(),
            // Only a Delegate parent owns a child drain; its cancel stays live.
            ...(delegate
              ? { budgetTerminal: () => root.terminal(), recheckBudgetAfterBarrier: () => true }
              : {}),
          });
          store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
            winner: "a01",
            facts: makeOutcomeFacts("succeeded"),
            why_winner: "strategy completed before the late throw",
            budget_summary: { spend_usd: 0, cash_usd: 0, valuation_usd: 0, estimated: false },
          });
          log.deferTerminal();
          store.writeText(join(paths.finalDir, "summary.md"), "done\n");
          log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
          log.emit("run.completed", { lifecycle: "succeeded" });
          throw new Error("late explosion after the held terminal");
        },
        async () => {
          // The host cancels while the settlement barrier runs.
          controller.abort("host_cancelled");
        },
      );
      expect(result.lifecycle).toBe(lifecycle);
      const published = terminals(paths.eventsPath);
      expect(published).toHaveLength(1);
      expect(published[0]?.lifecycle).toBe(lifecycle);
      if (!delegate) expect(published[0]?.type).toBe("run.completed");
    },
  );
});

/** A queued run log on a real store, as `createRunEventLog` makes it; `refuse`
 * lets the durable sink refuse a line at landing. */
function queuedFixture(runId: string, refuse: (event: RunEvent) => boolean = () => false) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-net-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun(runId);
  // What the durable sink accepted, in order.
  const sink: string[] = [];
  const log = new EventLog(
    paths.eventsPath,
    runId,
    "task-net",
    (event) => {
      if (refuse(event)) throw new Error(`journal refused ${event.type}`);
      sink.push(event.type);
    },
    undefined,
    undefined,
    { queued: true },
  );
  const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
  const context: AnnouncedRunContext = {
    log,
    store,
    paths,
    runId,
    taskId: "task-net",
    mode: "agent",
    phase: "race",
    spend: () => root.spend(),
    valuation: () => root.valuation(),
    spendEstimated: () => root.estimated(),
  };
  const terminalTypes = (types: readonly string[]) =>
    types.filter((type) => /^run\.(completed|failed|blocked)$/.test(type));
  const events = () => readRunEvents(paths.eventsPath).events;
  return {
    store,
    paths,
    log,
    context,
    sink,
    events,
    terminals: () => events().filter((event) => terminalTypes([event.type]).length > 0),
    sinkTerminals: () => terminalTypes(sink),
    summary: () => readFileSync(join(paths.finalDir, "summary.md"), "utf8"),
    /** The run starts as `beginAnnouncedRun` starts it, deferring its terminal
     * as every orchestrated run's scope custody does. */
    start: async (announce: (a: AnnouncedRunContext) => void) => {
      await log.emitLanded("run.created", { mode: "agent", prompt: "x" });
      announce(context);
      log.deferTerminal();
    },
  };
}

/** The next open of `path` fails with a transient EIO, once. */
function failNextOpen(path: string): () => number {
  let failed = 0;
  vi.spyOn(promises, "open").mockImplementation((async (
    ...args: Parameters<typeof promises.open>
  ) => {
    if (String(args[0]) === path && failed === 0) {
      failed += 1;
      throw Object.assign(new Error("EIO: transient"), { code: "EIO" });
    }
    return realOpen(...args);
  }) as typeof promises.open);
  return () => failed;
}

describe("a landing failure meets the failure net (#704)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("control: a strategy that throws with nothing lost gets its output and exactly one run.failed", async () => {
    const f = queuedFixture("run-net-control");
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      await f.start(announce);
      f.log.emit("harness.event", { text: "last line" });
      throw new Error("strategy failed for its own reason");
    });
    expect(result.lifecycle).toBe("failed");
    expect(
      f
        .events()
        .map((event) => event.type)
        .slice(-2),
    ).toEqual(["output.ready", "run.failed"]);
    expect(f.terminals()).toHaveLength(1);
    expect(f.sinkTerminals()).toEqual(["run.failed"]);
    expect(f.summary()).toContain("strategy failed for its own reason");
    expect(f.summary()).not.toContain("did not reach the journal");
    expect(liveRunEventSeq(f.paths.eventsPath)).toBeNull();
  });

  it.each([
    { kind: "fails", aborted: false, lifecycle: "failed" },
    { kind: "is cancelled", aborted: true, lifecycle: "cancelled" },
  ])(
    "states a line lost before a run that $kind, in its one terminal (held on events.jsonl)",
    async ({ aborted, lifecycle }) => {
      const f = queuedFixture(
        `run-net-held-${lifecycle}`,
        (event) => event.payload["text"] === "lost",
      );
      const controller = new AbortController();
      const result = await guardAnnouncedRun(controller.signal, async (announce) => {
        await f.start(announce);
        f.log.emit("harness.event", { text: "lost" });
        // Its landing failed and nobody awaited it: the run's journal holds it.
        await orderedAppender.drained(f.paths.eventsPath);
        if (aborted) controller.abort("host_cancelled");
        throw new Error("strategy failed for its own reason");
      });
      expect(result.lifecycle).toBe(lifecycle);
      expect(f.terminals()).toHaveLength(1);
      expect(f.terminals()[0]?.payload["lifecycle"]).toBe(lifecycle);
      expect(f.sinkTerminals()).toEqual(["run.failed"]);
      const statement = "Run events did not reach the journal: journal refused harness.event";
      expect(f.summary()).toContain(statement);
      expect(result.summary).toContain(statement);
      if (!aborted) {
        expect(String(f.terminals()[0]?.payload["error"])).toContain(statement);
        expect(f.summary()).toContain("strategy failed for its own reason");
      }
      expect(liveRunEventSeq(f.paths.eventsPath)).toBeNull();
    },
  );

  it("consumes a failure held on a side journal under the run directory, and states it", async () => {
    const f = queuedFixture("run-net-side");
    const journal = join(f.paths.attemptsDir, "a01", "events.jsonl");
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      await f.start(announce);
      const failed = failNextOpen(journal);
      orderedAppender.append(journal, "{}\n");
      await orderedAppender.drained(journal);
      expect(failed()).toBe(1);
      throw new Error("strategy failed for its own reason");
    });
    expect(result.lifecycle).toBe("failed");
    expect(f.terminals()).toHaveLength(1);
    expect(f.sinkTerminals()).toEqual(["run.failed"]);
    expect(String(f.terminals()[0]?.payload["error"])).toContain(
      "Run events did not reach the journal: EIO: transient",
    );
    expect(liveRunEventSeq(f.paths.eventsPath)).toBeNull();
  });

  it("commits the net's terminal when a landing failure interrupts its first commit", async () => {
    let refusals = 1;
    const f = queuedFixture(
      "run-net-flush",
      (event) => event.type === "output.ready" && refusals-- > 0,
    );
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      await f.start(announce);
      throw new Error("strategy failed for its own reason");
    });
    // The net's own output was in flight during its flush, and its landing failed.
    expect(refusals).toBe(0);
    expect(result.lifecycle).toBe("failed");
    expect(f.terminals()).toHaveLength(1);
    expect(f.sinkTerminals()).toEqual(["run.failed"]);
    expect(liveRunEventSeq(f.paths.eventsPath)).toBeNull();
  });

  it("fails the run through the net when the commit of a held verdict meets a landing failure", async () => {
    const f = queuedFixture("run-net-verdict");
    const journal = join(f.paths.attemptsDir, "a01", "events.jsonl");
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      await f.start(announce);
      f.store.writeText(join(f.paths.finalDir, "summary.md"), "done\n");
      f.log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
      f.log.emit("run.completed", { lifecycle: "succeeded" });
      failNextOpen(journal);
      orderedAppender.append(journal, "{}\n");
      await orderedAppender.drained(journal);
      throw new Error("late explosion after the held terminal");
    });
    expect(result.lifecycle).toBe("failed");
    expect(f.terminals().map((event) => event.type)).toEqual(["run.failed"]);
    expect(f.sinkTerminals()).toEqual(["run.failed"]);
    expect(String(f.terminals()[0]?.payload["error"])).toContain("EIO: transient");
    expect(liveRunEventSeq(f.paths.eventsPath)).toBeNull();
  });

  it("fails a returned run whose own terminal barrier finds its lost line, instead of republishing its verdict", async () => {
    const f = queuedFixture("run-net-returned", (event) => event.payload["text"] === "lost");
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      await f.start(announce);
      f.store.writeText(join(f.paths.finalDir, "summary.md"), "done\n");
      f.log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
      f.log.emit("run.completed", { lifecycle: "succeeded" });
      // A line after the held verdict whose landing the sink refuses.
      f.log.emit("harness.event", { text: "lost" });
      return {
        lifecycle: "succeeded",
        facts: makeOutcomeFacts("succeeded"),
        summary: "done",
        candidates: [],
      } as unknown as OrchestratorResult;
    });
    expect(result.lifecycle).toBe("failed");
    expect(f.terminals().map((event) => event.type)).toEqual(["run.failed"]);
    expect(f.sinkTerminals()).toEqual(["run.failed"]);
    expect(String(f.terminals()[0]?.payload["error"])).toContain("journal refused harness.event");
  });

  it("settles envelope custody through the net's flush after a line was lost", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-net-repo-")));
    dirs.push(repo);
    for (const args of [
      ["init", "-q", repo],
      [
        "-C",
        repo,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ],
    ])
      execFileSync("git", args);
    const f = queuedFixture("run-net-custody", (event) => event.payload["text"] === "lost");
    const kept = forRun({ continuation: { retain: true } }, true, f.context.runId, f.paths, f.log);
    const wsm = new WorkspaceManager(repo);
    let base = "";
    const result = await guardAnnouncedRun(undefined, async (announce) => {
      await f.start(announce);
      const env = await kept.envelope(wsm, {
        taskId: "task-net",
        attemptId: "a01",
        baseRef: "HEAD",
      });
      base = envelopeBaseOf(env);
      await kept.settle(wsm, env, [undefined]);
      f.log.emit("harness.event", { text: "lost" });
      await orderedAppender.drained(f.paths.eventsPath);
      throw new Error("strategy failed for its own reason");
    });
    expect(result.lifecycle).toBe("failed");
    expect(f.terminals()).toHaveLength(1);
    // Direction 1: the custody the run held settled before its terminal (the
    // unchanged envelope was disposed).
    expect(base).not.toBe("");
    expect(existsSync(base)).toBe(false);
    // Direction 2: the terminal states the lost line.
    expect(f.summary()).toContain("journal refused harness.event");
  });

  it("releases the live writer of a run whose net cannot commit, and keeps a poisoned one as its fence", async () => {
    // Direction 1: every commit is refused; the run rejects without a terminal,
    // and its writer does not stay registered.
    const f = queuedFixture("run-net-uncommitted");
    f.log.setTerminalPersistence(() => {
      throw new Error("terminal store unavailable");
    });
    await expect(
      guardAnnouncedRun(undefined, async (announce) => {
        await f.start(announce);
        throw new Error("strategy failed for its own reason");
      }),
    ).rejects.toThrow(/terminal store unavailable/);
    expect(f.log.terminalCommitted()).toBe(false);
    expect(liveRunEventSeq(f.paths.eventsPath)).toBeNull();
    expect(() => new EventLog(f.paths.eventsPath, "run-net-uncommitted", "task-net")).not.toThrow();
    // Direction 2: a terminal that needs recovery keeps its writer as the fence.
    const g = queuedFixture("run-net-poisoned");
    g.log.setTerminalPersistence(() => ({
      state: "pending",
      error: new Error("tail repair owed"),
    }));
    await expect(
      guardAnnouncedRun(undefined, async (announce) => {
        await g.start(announce);
        throw new Error("strategy failed for its own reason");
      }),
    ).rejects.toMatchObject({ code: "terminal_recovery_required" });
    expect(liveRunEventSeq(g.paths.eventsPath)).not.toBeNull();
  });
});
