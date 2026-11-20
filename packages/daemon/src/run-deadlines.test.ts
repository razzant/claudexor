/**
 * run-deadline/1 at the scheduler: contract trials 1, 2, 5, 6, 7 and 9, plus
 * the start refusal, idempotent lookup while queued and the snapshot shape.
 * These run an in-process DaemonServer without a warden directory, so no
 * process is spawned; the warden is proven in `run-deadline-process.test.ts`.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { RunDeadlines, runDeadlineCapabilities, type RunDeadlineClock } from "./run-deadlines.js";
import { RUN_DEADLINE_STOP_GRACE_SEC } from "./run-deadline-warden.js";
import { DaemonServer, type JobRecord, type RunnerFn } from "./server.js";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { legacyCommandFixture } from "./store/test-support/legacy-command-fixture.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

async function daemon(runner: RunnerFn, clock?: RunDeadlineClock) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "d-rdl-")));
  dirs.push(dir);
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  store.recoverAfterStartup();
  const socketPath = join(dir, "d.sock");
  const server = new DaemonServer({
    socketPath,
    token: "token",
    commands: legacyCommandFixture({ current: () => store }),
    runtimeConcurrencyCaps: {
      max_concurrent: 1,
      max_concurrent_non_model_jobs: 1,
      max_concurrent_model_operations: 1,
      max_parallel_candidates: 1,
      max_deep_scan_width: 1,
      max_council_members: 2,
    },
    ...(clock ? { runDeadlines: { clock } } : {}),
    runner,
  });
  await server.start();
  const client = new DaemonClient(socketPath, "token");
  return {
    server,
    client,
    store,
    async close() {
      await server.stop();
      journal.close();
    },
  };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`condition not met: ${JSON.stringify(value)}`);
    await sleep(20);
  }
}

const live = (record: { state: string }) => record.state === "queued" || record.state === "running";
const errorCode = async (work: Promise<unknown>) =>
  work.then(
    () => "resolved",
    (error: { code?: string }) => error.code,
  );

/** A runner that holds its slot until released; it records which jobs it ran. */
function slotRunner() {
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const runner: RunnerFn = async (params, ctx) => {
    ran.push((params as { label: string }).label);
    if ((params as { label: string }).label === "blocker") await gate;
    else
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 300);
      });
    return { lifecycle: ctx.signal.aborted ? "cancelled" : "succeeded" };
  };
  return { ran, runner, release: () => release() };
}

describe("run-deadline/1 at the scheduler", () => {
  it("trial 1: a queued start whose answer was lost never starts after its deadline", async () => {
    const slot = slotRunner();
    const d = await daemon(slot.runner);
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const request = { label: "late", deadline: { at: inMs(400) } };
      // The caller never reads this answer ("lost"); it finds the run by its key.
      void d.client.enqueue(request, { idempotencyKey: "lost", clientId: "t" });
      const found = (await until(
        () => d.client.findAccepted(request, { idempotencyKey: "lost", clientId: "t" }),
        (value) => value !== null,
      )) as JobRecord;
      expect(found.state).toBe("queued");
      const read = await d.client.runDeadline(found.id, { action: "read" });
      expect(read).toMatchObject({ at: request.deadline.at, revision: 0, state: "armed" });
      expect(Date.parse(read.serverNow)).toBeGreaterThan(0);
      expect(read.stopGraceSec).toBe(RUN_DEADLINE_STOP_GRACE_SEC);
      const ended = await until(
        () => d.client.status(found.id),
        (record) => !live(record),
      );
      expect(ended).toMatchObject({ state: "cancelled", errorCode: "run_deadline_expired" });
      slot.release();
      await sleep(200);
      expect(slot.ran).toEqual(["blocker"]);
      expect(await d.client.runDeadline(found.id, { action: "read" })).toMatchObject({
        state: "expired",
      });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 2: preparation longer than the deadline never launches", async () => {
    let launched = false;
    const d = await daemon(async (_params, ctx) => {
      // "Preparation": far longer than the deadline, interruptible by the stop.
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 5_000);
      });
      if (!ctx.signal.aborted) launched = true;
      return { lifecycle: ctx.signal.aborted ? "cancelled" : "succeeded" };
    });
    try {
      const accepted = await d.client.enqueue(
        { label: "prep", deadline: { at: inMs(300) } },
        { idempotencyKey: "p", clientId: "t" },
      );
      const ended = await until(
        () => d.client.status(accepted.id),
        (record) => !live(record),
      );
      expect(ended.state).toBe("cancelled");
      expect(launched).toBe(false);
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "expired",
      });
    } finally {
      await d.close();
    }
  });

  it("refuses a start whose deadline already passed and accepts nothing", async () => {
    const d = await daemon(async () => ({ lifecycle: "succeeded" }));
    try {
      const request = { label: "past", deadline: { at: inMs(-1_000) } };
      expect(
        await errorCode(d.client.enqueue(request, { idempotencyKey: "x", clientId: "t" })),
      ).toBe("run_deadline_passed");
      expect(await d.client.findAccepted(request, { idempotencyKey: "x", clientId: "t" })).toBe(
        null,
      );
    } finally {
      await d.close();
    }
  });

  it("trial 5: a stale revision is a conflict and the deadline stays", async () => {
    const slot = slotRunner();
    const d = await daemon(slot.runner);
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const at = inMs(60_000);
      const accepted = await d.client.enqueue(
        { label: "q", deadline: { at } },
        { idempotencyKey: "q", clientId: "t" },
      );
      const moved = await d.client.runDeadline(accepted.id, {
        action: "set",
        at: inMs(90_000),
        expectedRevision: 0,
      });
      expect(moved.revision).toBe(1);
      expect(
        await errorCode(
          d.client.runDeadline(accepted.id, {
            action: "set",
            at: inMs(120_000),
            expectedRevision: 0,
          }),
        ),
      ).toBe("run_deadline_revision_conflict");
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        at: moved.at,
        revision: 1,
      });
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 6: a run queued longer than one period starts when renewed and expires when not", async () => {
    const slot = slotRunner();
    const d = await daemon(slot.runner);
    const period = 400;
    try {
      await d.client.enqueue({ label: "blocker" }, { idempotencyKey: "b", clientId: "t" });
      const renewed = await d.client.enqueue(
        { label: "renewed", deadline: { at: inMs(period) } },
        { idempotencyKey: "r", clientId: "t" },
      );
      const abandoned = await d.client.enqueue(
        { label: "abandoned", deadline: { at: inMs(period) } },
        { idempotencyKey: "a", clientId: "t" },
      );
      let revision = 0;
      // Renew every period/2 for three periods while the slot is held.
      for (let i = 0; i < 6; i += 1) {
        const next = await d.client.runDeadline(renewed.id, {
          action: "set",
          at: inMs(period),
          expectedRevision: revision,
        });
        revision = next.revision;
        await sleep(period / 2);
      }
      expect(await d.client.status(abandoned.id)).toMatchObject({
        state: "cancelled",
        errorCode: "run_deadline_expired",
      });
      expect(await d.client.status(renewed.id)).toMatchObject({ state: "queued" });
      await d.client.runDeadline(renewed.id, {
        action: "set",
        at: inMs(30_000),
        expectedRevision: revision,
      });
      slot.release();
      const ended = await until(
        () => d.client.status(renewed.id),
        (record) => !live(record),
      );
      expect(ended.state).toBe("succeeded");
      expect(slot.ran).toEqual(["blocker", "renewed"]);
    } finally {
      slot.release();
      await d.close();
    }
  });

  it("trial 7: changing a finished run's deadline is refused, typed, with no new timer", async () => {
    const d = await daemon(async () => ({ lifecycle: "succeeded" }));
    try {
      const accepted = await d.client.enqueue(
        { label: "done", deadline: { at: inMs(60_000) } },
        { idempotencyKey: "d", clientId: "t" },
      );
      await until(
        () => d.client.status(accepted.id),
        (record) => !live(record),
      );
      expect(
        await errorCode(
          d.client.runDeadline(accepted.id, {
            action: "set",
            at: inMs(90_000),
            expectedRevision: 0,
          }),
        ),
      ).toBe("run_deadline_closed");
      expect(await d.client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
        state: "closed",
        revision: 0,
      });
    } finally {
      await d.close();
    }
  });

  it("trial 9: a backwards wall-clock step does not postpone the stop", async () => {
    let stepped = false;
    const clock: RunDeadlineClock = {
      wallNow: () => (stepped ? Date.now() - 3_600_000 : Date.now()),
      monoNow: () => process.hrtime.bigint(),
    };
    const d = await daemon(async (_params, ctx) => {
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { lifecycle: "cancelled" };
    }, clock);
    try {
      const at = inMs(600);
      const accepted = await d.client.enqueue(
        { label: "clock", deadline: { at } },
        { idempotencyKey: "c", clientId: "t" },
      );
      stepped = true; // the server clock jumps one hour back
      const read = await d.client.runDeadline(accepted.id, { action: "read" });
      expect(Date.parse(read.serverNow)).toBeLessThan(Date.parse(at) - 3_000_000);
      expect(read.at).toBe(at);
      const ended = await until(
        () => d.client.status(accepted.id),
        (record) => !live(record),
        5_000,
      );
      expect(ended.state).toBe("cancelled");
      expect(Date.now()).toBeLessThan(Date.parse(at) + 2_000);
    } finally {
      await d.close();
    }
  });
});

describe("RunDeadlines registry", () => {
  const registry = () => new RunDeadlines({ onExpire: () => {} });

  it("caps a Delegate child by its parent's current deadline and follows an extension", () => {
    const deadlines = registry();
    try {
      deadlines.admit("parent", { deadline: { at: inMs(10_000) } }, null);
      deadlines.admit("child", { deadline: { at: inMs(60_000) } }, "parent");
      const parentAt = deadlines.snapshot("parent")!.at;
      expect(deadlines.snapshot("child")).toMatchObject({ at: parentAt, inheritedFrom: "parent" });
      const extended = deadlines.set(
        "parent",
        { at: inMs(30_000), expectedRevision: 0 },
        { live: true, delegated: false },
      );
      expect(deadlines.snapshot("child")).toMatchObject({
        at: extended.at,
        inheritedFrom: "parent",
      });
      expect(() =>
        deadlines.set(
          "child",
          { at: inMs(20_000), expectedRevision: 0 },
          { live: true, delegated: true },
        ),
      ).toThrow(expect.objectContaining({ code: "delegated_deadline_forbidden" }));
    } finally {
      deadlines.dispose();
    }
  });

  it("declares the capability only where the stop invariant is proven", () => {
    expect(runDeadlineCapabilities("linux")).toEqual([
      { name: "run-deadline/1", stopGraceSec: RUN_DEADLINE_STOP_GRACE_SEC },
    ]);
    expect(runDeadlineCapabilities("darwin")).toEqual([]);
    expect(runDeadlineCapabilities("win32")).toEqual([]);
  });
});
