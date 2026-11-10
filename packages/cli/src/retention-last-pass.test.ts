import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlGcReceipt, GcHoldClass } from "@claudexor/schema";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { afterRetention, serializeRetention } from "./retention-lifetime.js";
import { readLastRetention, recordLastRetention } from "./retention-last-pass.js";
import { createSqlDaemonRuntime } from "./sql-daemon-runtime.js";
import { createRetentionRunner } from "./retention-service.js";
import { handleMaintenanceRoute } from "../../control-api/src/maintenance-routes.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
function receipt() {
  return ControlGcReceipt.parse({
    dry_run: false,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    policy: { runs_max_age_days: 30, reviews_max_age_days: 14, keep_last_runs_per_project: 0 },
    examined_runs: 0,
    kept: {},
    freed_bytes: 17,
  });
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gc-last-"));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const sql = await sqlFixture(root);
  cleanup.push(() => sql.close());
  return { root, sql };
}
it("defaults an old receipt without the new hold/truncation fields", () => {
  expect(receipt()).toMatchObject({
    held: { roots: 0, native_homes: 0 },
    holds: [],
    truncated: false,
  });
});
it("keeps the last completion and failed/held streak through failure, holds and partial work until completion", async () => {
  const { sql } = await fixture();
  const complete = recordLastRetention(async () => receipt(), sql.store);
  await complete({ dry_run: false });
  const first = readLastRetention(sql.store)!;
  expect(first).toMatchObject({ last_completed_at: first.finished_at, failed_or_held_streak: 0 });
  const fail = recordLastRetention(async () => {
    throw new Error("inventory unreadable");
  }, sql.store);
  await expect(fail({ dry_run: false })).rejects.toThrow("inventory unreadable");
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "failed",
    last_completed_at: first.finished_at,
    failed_or_held_streak: 1,
  });
  const held = receipt();
  held.holds = [
    { class: "references_changed", count: 1, example: "project registration changed: /root" },
  ];
  await recordLastRetention(async () => held, sql.store)({ dry_run: false });
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "held",
    last_completed_at: first.finished_at,
    failed_or_held_streak: 2,
  });
  const partial = receipt();
  partial.truncated = true;
  await recordLastRetention(async () => partial, sql.store)({ dry_run: false });
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "truncated",
    last_completed_at: first.finished_at,
    failed_or_held_streak: 2,
  });
  await complete({ dry_run: false });
  const last = readLastRetention(sql.store)!;
  expect(last).toMatchObject({
    outcome: "completed",
    last_completed_at: last.finished_at,
    failed_or_held_streak: 0,
  });
});
it("reports no known completion on an initial failure and reads a legacy summary", async () => {
  const { sql } = await fixture();
  const fail = recordLastRetention(async () => {
    throw new Error("missing partition");
  }, sql.store);
  await expect(fail({ dry_run: false })).rejects.toThrow("missing partition");
  expect(readLastRetention(sql.store)).toMatchObject({
    last_completed_at: null,
    failed_or_held_streak: 1,
  });
  const legacy = { ...readLastRetention(sql.store), outcome: "completed" } as Record<
    string,
    unknown
  >;
  delete legacy.last_completed_at;
  delete legacy.failed_or_held_streak;
  sql.store.transaction(() =>
    sql.store
      .prepare("UPDATE meta SET value=? WHERE key='retention_last_pass'")
      .run(JSON.stringify(legacy)),
  );
  expect(readLastRetention(sql.store)?.outcome).toBe("completed");
  await expect(fail({ dry_run: false })).rejects.toThrow("missing partition");
  expect(readLastRetention(sql.store)).toMatchObject({
    last_completed_at: legacy.finished_at,
    failed_or_held_streak: 1,
  });
});
it("persists held class/count/since through reopen and log truncation; preview preserves it and a clean pass clears it", async () => {
  const { root, sql } = await fixture();
  const held = receipt();
  held.held.roots = 2;
  held.holds = [{ class: "missing_partition", count: 2, example: "/fixture/root" }];
  await recordLastRetention(async () => held, sql.store)({ dry_run: false });
  const first = readLastRetention(sql.store)!;
  expect(first.outcome).toBe("held");
  expect(first.holds[0]?.count).toBe(2);
  const since = first.holds[0]!.since;
  expect(since).toBe(first.started_at);
  await sql.close();
  writeFileSync(join(root, "daemon.log"), "");
  const reopened = await sqlFixture(root);
  cleanup.push(() => reopened.close());
  expect(readLastRetention(reopened.store)).toEqual(first);
  await recordLastRetention(async () => held, reopened.store)({ dry_run: false });
  expect(readLastRetention(reopened.store)?.holds[0]?.since).toBe(since);
  const prior = readLastRetention(reopened.store);
  await recordLastRetention(async () => receipt(), reopened.store)({ dry_run: true });
  expect(readLastRetention(reopened.store)).toEqual(prior);
  await recordLastRetention(async () => receipt(), reopened.store)({ dry_run: false });
  expect(readLastRetention(reopened.store)).toMatchObject({
    outcome: "completed",
    holds: [],
    held: { roots: 0, native_homes: 0 },
    errors: { count: 0, first: null },
  });
});
it.each(["model", "upload"])(
  "records a throwing outer %s cleanup as failed with the earlier freed bytes",
  async (step) => {
    const { root, sql } = await fixture();
    const runtime = createSqlDaemonRuntime(sql.graph, {
      server: { socketPath: join(root, "unused.sock"), token: "fixture" },
      authReadiness: () => ({ invalidate() {} }),
      agent: () => async () => ({ lifecycle: "succeeded" }),
    });
    cleanup.push(() => runtime.stop());
    if (step === "upload")
      vi.spyOn(sql.graph.resources, "pruneUploadBindings").mockImplementation(() => {
        throw new Error("upload cleanup unavailable");
      });
    else
      vi.spyOn(runtime.models.operations, "reconcileResources").mockImplementation(() => {
        throw new Error("model cleanup unavailable");
      });
    const run = runtime.retention(async () => receipt());
    await expect(run({ dry_run: false })).rejects.toThrow(`${step} cleanup unavailable`);
    expect(readLastRetention(sql.store)).toMatchObject({
      outcome: "failed",
      freed_bytes: 17,
      errors: { count: 1, first: expect.stringContaining(`${step} cleanup unavailable`) },
    });
  },
);
it("periodic retention uses the daemon's history policy and releases cancelled ids, but preview does neither", async () => {
  const { root, sql } = await fixture();
  const runtime = createSqlDaemonRuntime(sql.graph, {
    server: {
      socketPath: join(root, "unused.sock"),
      token: "fixture",
      maxHistory: 0,
      idempotencyRetentionMs: 0,
      now: () => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
    },
    authReadiness: () => ({ invalidate() {} }),
    agent: () => async () => ({ lifecycle: "succeeded" }),
  });
  cleanup.push(() => runtime.stop());
  sql.graph.commands.current().accept({
    id: "cancelled-retention",
    params: { mode: "ask", prompt: "never run" },
    idempotencyKey: "cancelled-retention",
    clientId: "fixture",
  });
  runtime.server.cancelJob("cancelled-retention");
  // This memory-retention claim has no public projection; inspect the existing
  // set rather than add a production API only to expose its size.
  const cancelled = Reflect.get(runtime.server, "cancelled") as Set<string>;
  expect(cancelled.has("cancelled-retention")).toBe(true);
  const prune = vi.spyOn(runtime.server, "pruneHistory");
  const run = runtime.retention(async () => receipt());
  await run({ dry_run: true });
  expect(prune).not.toHaveBeenCalled();
  expect(sql.records().map((record) => record.id)).toContain("cancelled-retention");
  expect(cancelled.has("cancelled-retention")).toBe(true);
  await run({ dry_run: false });
  expect(prune).toHaveBeenCalledTimes(1);
  expect(sql.records()).toEqual([]);
  expect(cancelled.size).toBe(0);
});

it("drains the actual persistence barrier before shutdown and propagates a barrier failure", async () => {
  const { sql } = await fixture();
  const flush = sql.store.flushed.bind(sql.store);
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const spy = vi.spyOn(sql.store, "flushed").mockImplementation(async () => {
    entered();
    await barrier;
    await flush();
  });
  const run = recordLastRetention(
    serializeRetention(async () => receipt()),
    sql.store,
  );
  const pending = run({ dry_run: false });
  await ready;
  let stopped = false;
  const stop = run.cancel!().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stopped).toBe(false);
  release();
  await pending;
  await stop;
  expect(stopped).toBe(true);
  const completed = readLastRetention(sql.store)!;
  spy.mockRejectedValue(new Error("durability unavailable"));
  await expect(run({ dry_run: false })).rejects.toThrow("durability unavailable");
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "failed",
    last_completed_at: completed.finished_at,
    failed_or_held_streak: 1,
    errors: { count: 1, first: expect.stringContaining("durability unavailable") },
  });
});
it("bounds accumulated diagnostics to 16 KiB and never reports truncation or errors as completed", async () => {
  const { sql } = await fixture();
  const data = receipt();
  data.holds = GcHoldClass.options.flatMap((kind) =>
    Array.from({ length: 10 }, () => ({ class: kind, count: 1, example: "\u0000".repeat(5000) })),
  );
  data.errors = Array.from({ length: 200 }, () => "\u0000".repeat(10000));
  data.truncated = true;
  await recordLastRetention(async () => data, sql.store)({ dry_run: false });
  const last = readLastRetention(sql.store)!;
  expect(last.outcome).toBe("truncated");
  expect(last.holds.every((hold) => hold.count === 10)).toBe(true);
  expect(last.errors.count).toBe(200);
  expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThanOrEqual(16 * 1024);
  await recordLastRetention(
    afterRetention(
      async () => receipt(),
      () => {
        throw new Error("outer failure");
      },
    ),
    sql.store,
  )({ dry_run: true }).catch(() => {});
  expect(readLastRetention(sql.store)).toEqual(last);
  const errors = receipt();
  errors.errors = ["cannot clean"];
  await recordLastRetention(async () => errors, sql.store)({ dry_run: false });
  expect(readLastRetention(sql.store)?.outcome).toBe("failed");
});

it("a cancelled queued pass never starts or overwrites the pass that ran", async () => {
  const { sql } = await fixture();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  const flush = vi.spyOn(sql.store, "flushed");
  const core = serializeRetention(async (_request, signal) => {
    calls += 1;
    enter();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    const value = receipt();
    value.truncated = true;
    value.held.roots = 2;
    value.holds = [{ class: "missing_partition", count: 2, example: "/held" }];
    return value;
  });
  const run = recordLastRetention(core, sql.store);
  const first = run({ dry_run: false });
  const queued = run({ dry_run: false }).catch((error: unknown) => error);
  await entered;
  await run.cancel!();
  await first;
  expect(await queued).toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "truncated",
    freed_bytes: 17,
    held: { roots: 2, native_homes: 0 },
    holds: [{ class: "missing_partition", count: 2, example: "/held", since: expect.any(String) }],
    errors: { count: 0, first: null },
  });
});
it("carries every absent hold class and conservative counts only while truncated", async () => {
  const { sql } = await fixture();
  const previous = receipt();
  previous.held = { roots: 2, native_homes: 3 };
  previous.holds = GcHoldClass.options.map((kind) => ({ class: kind, count: 1, example: kind }));
  await recordLastRetention(async () => previous, sql.store)({ dry_run: false });
  const first = readLastRetention(sql.store)!;
  const partial = receipt();
  partial.truncated = true;
  partial.held = { roots: 1, native_homes: 1 };
  partial.holds = [{ class: "missing_partition", count: 4, example: "observed this pass" }];
  await recordLastRetention(async () => partial, sql.store)({ dry_run: false });
  const expected = first.holds.map((hold) =>
    hold.class === "missing_partition" ? { ...hold, ...partial.holds[0] } : hold,
  );
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "truncated",
    held: first.held,
    holds: expected,
  });
  partial.truncated = false;
  await recordLastRetention(async () => partial, sql.store)({ dry_run: false });
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "held",
    held: partial.held,
    holds: [expected[0]],
  });
});
it.each(["cancel-inventory", "throw-before-inventory"])(
  "carries previous holds and since when %s yields no inventory",
  async (kind) => {
    const { sql } = await fixture();
    const held = receipt();
    held.held = { roots: 2, native_homes: 1 };
    held.holds = [
      { class: "missing_partition", count: 2, example: "/held" },
      { class: "native_home_veto", count: 1, example: "/native" },
    ];
    await recordLastRetention(async () => held, sql.store)({ dry_run: false });
    const previous = readLastRetention(sql.store)!;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const inventory = vi
      .spyOn(sql.graph.threads, "retentionReferences")
      .mockImplementation(async (_ignored, signal) => {
        enter();
        if (kind === "throw-before-inventory") throw new Error("inventory unavailable");
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal!.throwIfAborted();
        throw new Error("expected cancellation");
      });
    const core = createRetentionRunner({
      projects: () => sql.graph.projects,
      threads: sql.graph.threads,
      daemonJobs: () => [],
      purgeThread: async () => {},
      hasPurgeLeftovers: () => false,
    });
    const run = recordLastRetention(core, sql.store);
    const pending = run({ dry_run: false }).catch((error: unknown) => error);
    await entered;
    if (kind === "cancel-inventory") await run.cancel!();
    const result = await pending;
    if (kind === "throw-before-inventory")
      expect(result).toMatchObject({ message: "inventory unavailable" });
    expect(readLastRetention(sql.store)).toMatchObject({
      outcome: kind === "cancel-inventory" ? "truncated" : "failed",
      held: previous.held,
      holds: previous.holds,
    });
    inventory.mockRestore();
    await recordLastRetention(async () => held, sql.store)({ dry_run: false });
    expect(readLastRetention(sql.store)?.holds).toEqual(previous.holds);
    await recordLastRetention(async () => receipt(), sql.store)({ dry_run: false });
    expect(readLastRetention(sql.store)).toMatchObject({
      outcome: "completed",
      holds: [],
      held: { roots: 0, native_homes: 0 },
    });
  },
);
it.each([
  "not JSON",
  JSON.stringify({ outcome: "future_outcome", holds: [{ class: "future_class" }] }),
])("replaces an unreadable stored record without wedging retention: %s", async (value) => {
  const { sql } = await fixture();
  sql.store.transaction(() =>
    sql.store.prepare("INSERT INTO meta(key,value) VALUES('retention_last_pass',?)").run(value),
  );
  const run = vi.fn(async () => receipt());
  await recordLastRetention(run, sql.store)({ dry_run: false });
  expect(run).toHaveBeenCalledTimes(1);
  expect(readLastRetention(sql.store)).toMatchObject({
    outcome: "completed",
    freed_bytes: 17,
    holds: [],
  });
});
it.each(["not JSON", JSON.stringify({ outcome: "future_outcome" })])(
  "GET returns null with a diagnostic for an unreadable record without running GC: %s",
  async (value) => {
    const { root, sql } = await fixture();
    sql.store.transaction(() =>
      sql.store.prepare("INSERT INTO meta(key,value) VALUES('retention_last_pass',?)").run(value),
    );
    const runtime = createSqlDaemonRuntime(sql.graph, {
      server: { socketPath: join(root, "unused.sock"), token: "fixture" },
      authReadiness: () => ({ invalidate() {} }),
      agent: () => async () => ({ lifecycle: "succeeded" }),
    });
    cleanup.push(() => runtime.stop());
    const runRetention = vi.fn();
    const ctx = {
      services: { lastRetention: runtime.controlRoutes.lastRetention, runRetention },
      readBody: vi.fn(),
      json: vi.fn(),
      requestError: vi.fn(),
    };
    const res = {} as ServerResponse;
    await handleMaintenanceRoute(ctx, "GET", "/maintenance/gc", {} as IncomingMessage, res);
    expect(ctx.json).toHaveBeenCalledWith(res, 200, {
      last: null,
      diagnostic: expect.stringContaining("unreadable"),
    });
    expect(ctx.requestError).not.toHaveBeenCalled();
    expect(runRetention).not.toHaveBeenCalled();
    expect(
      sql.store.prepare("SELECT value FROM meta WHERE key='retention_last_pass'").get(),
    ).toEqual({ value });
  },
);
it("propagates a write failure without replacing the preceding durable record", async () => {
  const { sql } = await fixture();
  const run = recordLastRetention(async () => receipt(), sql.store);
  await run({ dry_run: false });
  const previous = readLastRetention(sql.store);
  vi.spyOn(sql.store, "transaction").mockImplementation(() => {
    throw new Error("meta write failed");
  });
  await expect(run({ dry_run: false })).rejects.toThrow("meta write failed");
  expect(readLastRetention(sql.store)).toEqual(previous);
});
