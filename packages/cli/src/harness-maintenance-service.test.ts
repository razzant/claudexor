/** Durable command custody with fake CLI children and private SQLite roots. */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spawnProcess } from "@claudexor/core";
import { RunEventBus } from "@claudexor/daemon";
import type { RunEvent } from "@claudexor/schema";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createHarnessMaintenance } from "./harness-maintenance-service.js";
import { emptyMaintenanceEvidence } from "./harness-maintenance.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const selection = (version = "1.0.0") => ({
  path: "/fixture/codex",
  realPath: "/fixture/codex",
  version,
  versionOutput: `codex ${version}`,
  overrideEnv: null,
  overrideValue: null,
});
const ROW = {
  harness: "codex",
  selection: selection(),
  newest: { status: "not_read", source: "https://example.invalid/latest" },
  updateAvailable: "cannot_tell",
  releaseNotesUrl: null,
  actions: {
    install: { available: false, reason: "Already selected; use Update.", commands: [] },
    update: {
      available: true,
      reason: null,
      commands: [{ kind: "exec", command: "/fixture/codex", args: ["update"] }],
    },
    exactVersion: { available: true, reason: null, commands: [] },
  },
};
const EVIDENCE = {
  ...emptyMaintenanceEvidence({ kind: "latest", version: null }),
  phase: "installing",
  installationHome: "/fixture",
  before: selection(),
  commands: [{ binary: "/fixture/codex", args: ["update"], env: {}, script: null }],
  mutation: "unknown",
};
const RECEIPT = {
  ...EVIDENCE,
  phase: "settled",
  ok: true,
  harness: "codex",
  dryRun: false,
  after: selection("2.0.0"),
  outcome: "changed",
  mutation: "applied",
  exitCode: 0,
  progress: ["Updated"],
};
const FAKE_CLI = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [config, , verb, ...rest] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(config, "utf8"));
const log = (phase) => appendFileSync(cfg.log, JSON.stringify({ verb, rest, pid: process.pid, phase }) + "\\n");
log("started");
if (verb === "inspect") {
  const version = existsSync(cfg.state) ? readFileSync(cfg.state, "utf8") : "1.0.0";
  const row = { ...cfg.row, selection: { ...cfg.row.selection, version, versionOutput: "codex " + version }, observedAt: new Date().toISOString() };
  if (rest.includes("--latest")) row.newest = { status: "unavailable", source: "https://example.invalid/latest", observedAt: row.observedAt, problem: { code: "newest_unavailable", message: "offline", retryable: true } };
  process.stdout.write(JSON.stringify({ harnesses: [row] }));
} else if (verb === "update") {
  await new Promise((resolve) => setTimeout(resolve, cfg.prepareDelay ?? 0));
  if (process.env.CLAUDEXOR_MAINTENANCE_PROTOCOL !== "1") throw new Error("missing custody protocol");
  const input = createInterface({ input: process.stdin });
  process.stderr.write("CLAUDEXOR_MAINTENANCE_EVIDENCE " + JSON.stringify(cfg.evidence) + "\\n");
  for await (const line of input) { if (line !== "ack") throw new Error("not acknowledged"); break; }
  input.close();
  writeFileSync(cfg.state, "2.0.0"); log("mutated");
  await new Promise((resolve) => setTimeout(resolve, cfg.finishDelay ?? 0));
  if (cfg.receipt) process.stdout.write(JSON.stringify(cfg.receipt));
  process.exitCode = cfg.receipt?.ok ? 0 : 1;
}
`;
const worlds: Array<{
  root: string;
  sql: Awaited<ReturnType<typeof sqlFixture>>;
  close(): Promise<void>;
}> = [];
afterEachClosed(async () => {
  const owned = worlds.splice(0);
  for (const w of owned) await w.close();
  return () => {
    for (const w of owned) rmSync(w.root, { recursive: true, force: true });
  };
});
async function harnessWorld(config: Record<string, unknown> = {}, spawn = spawnProcess) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maintenance-service-")));
  const script = join(root, "fake.mjs"),
    configPath = join(root, "config.json"),
    log = join(root, "calls.jsonl"),
    state = join(root, "version");
  writeFileSync(script, FAKE_CLI);
  const write = (patch: Record<string, unknown>) =>
    writeFileSync(
      configPath,
      JSON.stringify({ log, state, row: ROW, evidence: EVIDENCE, receipt: RECEIPT, ...patch }),
    );
  write(config);
  const sql = await sqlFixture(root);
  const store = sql.graph.commands.current();
  const controllers = new Map<string, AbortController>();
  const running = new Set<Promise<unknown>>();
  let next = 0;
  const client = {
    enqueue: vi.fn(async (params: unknown, options: Record<string, unknown>) => {
      const { record, reused } = store.accept({
        id: `job-${++next}`,
        params,
        idempotencyKey: String(options.idempotencyKey),
        clientId: String(options.clientId),
        operation: String(options.operation),
        idempotencyParams: options.idempotencyRequest,
      });
      return { id: record.id, state: record.state, reused };
    }),
    cancel: vi.fn(async (id: string) => {
      controllers.get(id)?.abort();
      return { id, cancelled: true };
    }),
  };
  const bus = new RunEventBus();
  const acknowledgments: unknown[] = [];
  const readiness = { invalidate: vi.fn() };
  const maintenance = createHarnessMaintenance({
    commands: sql.graph.commands,
    maintenanceQueries: sql.graph.commands.queries,
    client,
    bus,
    readiness: () => readiness,
    cli: { command: process.execPath, args: [script, configPath] },
    cancelKillDelayMs: 200,
    spawn: ((bin, args, options) =>
      spawn(bin, args, {
        ...options,
        ...(options?.onSpawn
          ? {
              onSpawn: (io) =>
                options.onSpawn!({
                  ...io,
                  write: (data) => {
                    acknowledgments.push(structuredClone(sql.records().at(-1)?.result));
                    io.write(data);
                  },
                }),
            }
          : {}),
      })) as typeof spawnProcess,
  });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { verb: string; pid: number; phase: string })
      : [];
  function run(id: string) {
    const controller = new AbortController();
    controllers.set(id, controller);
    store.update(id, { state: "running", startedAt: new Date().toISOString() });
    const work = (async () => {
      const value = await maintenance.execute(store.get(id)!.params, {
        jobId: id,
        signal: controller.signal,
        onRunStart: () => undefined,
      });
      store.update(id, {
        state: value.lifecycle,
        result: value,
        finishedAt: new Date().toISOString(),
      });
      return maintenance.routes.getMaintenanceOperation(id);
    })();
    running.add(work);
    void work.finally(() => running.delete(work));
    return work;
  }
  worlds.push({
    root,
    sql,
    close: async () => {
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled(running);
      maintenance.close();
      await sql.close();
    },
  });
  return {
    maintenance,
    store,
    client,
    bus,
    calls,
    run,
    write,
    state,
    acknowledgments,
    controllers,
    readiness,
  };
}
const latest = { harness: "codex", target: { kind: "latest" } };
function nativeEvent(
  bus: RunEventBus,
  type: string,
  run = "run-a",
  attempt = "a1",
  harness = "codex",
) {
  bus.publish({
    seq: 1,
    ts: new Date().toISOString(),
    run_id: run,
    task_id: "task",
    type,
    payload: { attempt_id: attempt, harness_id: harness },
  } as RunEvent);
}

describe("durable vendor operation", () => {
  it("rejoins duplicate idempotent requests, rejects changed bodies, and allows only one active harness operation", async () => {
    const w = await harnessWorld();
    const route = w.maintenance.routes;
    const first = await route.createMaintenanceOperation(latest, "key");
    expect((await route.createMaintenanceOperation(latest, "key")).id).toBe(first.id);
    expect(w.client.enqueue).toHaveBeenCalledOnce();
    await expect(
      route.createMaintenanceOperation(
        { harness: "codex", target: { kind: "version", version: "2.0.0" } },
        "key",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(route.createMaintenanceOperation(latest, "another")).rejects.toMatchObject({
      code: "maintenance_already_active",
    });
    const done = await w.run(first.id);
    expect(done).toMatchObject({
      state: "succeeded",
      outcome: "changed",
      requester: { source: "control-api", requestId: "key" },
    });
    expect((await route.createMaintenanceOperation(latest, "key")).id).toBe(first.id);
    expect(await route.getMaintenanceOperation(first.id)).toEqual(done);
  });
  it("rejoins a duplicate while asynchronous acceptance is still pending", async () => {
    const w = await harnessWorld();
    const enqueue = w.client.enqueue.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.client.enqueue.mockImplementationOnce(async (...args) => {
      await held;
      return enqueue(...args);
    });
    const first = w.maintenance.routes.createMaintenanceOperation(latest, "pending");
    const duplicate = w.maintenance.routes.createMaintenanceOperation(latest, "pending");
    await expect(
      w.maintenance.routes.createMaintenanceOperation(
        { harness: "claude", target: { kind: "latest" } },
        "pending",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(w.client.enqueue).toHaveBeenCalledOnce();
    release();
    expect((await first).id).toBe((await duplicate).id);
  });
  it("commits exact command and before evidence before acknowledging mutation; active runs are a fact", async () => {
    const w = await harnessWorld();
    nativeEvent(w.bus, "harness.started");
    nativeEvent(w.bus, "harness.started", "run-a", "a2");
    nativeEvent(w.bus, "harness.started", "run-b");
    nativeEvent(w.bus, "harness.started", "run-c");
    nativeEvent(w.bus, "run.blocked", "run-c");
    const op = await w.maintenance.routes.createMaintenanceOperation(latest, "key");
    const done = await w.run(op.id);
    expect(w.acknowledgments).toEqual([
      expect.objectContaining({
        phase: "installing",
        activeRunsAtStart: 2,
        before: selection(),
        commands: EVIDENCE.commands,
      }),
    ]);
    expect(done).toMatchObject({
      state: "succeeded",
      activeRunsAtStart: 2,
      after: selection("2.0.0"),
      exitCode: 0,
    });
    expect(w.calls().map((c) => [c.verb, c.phase])).toEqual([
      ["update", "started"],
      ["update", "mutated"],
    ]);
    expect(w.readiness.invalidate).toHaveBeenCalledWith("codex");
  });
  it("cancel after mutation stops the child, re-observes effects and retains the command", async () => {
    const w = await harnessWorld({ finishDelay: 10_000 });
    const op = await w.maintenance.routes.createMaintenanceOperation(latest, "cancel");
    const pending = w.run(op.id);
    await vi.waitFor(() => expect(w.calls().some((c) => c.phase === "mutated")).toBe(true));
    await w.maintenance.routes.cancelMaintenanceOperation(op.id);
    const done = await pending;
    expect(done).toMatchObject({
      state: "cancelled",
      phase: "settled",
      termination: "confirmed",
      mutation: "applied",
      outcome: "changed",
      before: selection(),
      after: selection("2.0.0"),
      commands: EVIDENCE.commands,
      problem: { code: "maintenance_cancelled" },
    });
    for (const pid of new Set(w.calls().map((c) => c.pid)))
      expect(() => process.kill(pid, 0)).toThrow();
  });
  it("cancel before preparation does not authorize mutation", async () => {
    const w = await harnessWorld({ prepareDelay: 10_000 });
    const op = await w.maintenance.routes.createMaintenanceOperation(latest, "cancel-prepare");
    const pending = w.run(op.id);
    await vi.waitFor(() => expect(w.calls()).toHaveLength(1));
    await w.maintenance.routes.cancelMaintenanceOperation(op.id);
    expect(await pending).toMatchObject({ state: "cancelled", mutation: "none", commands: [] });
    expect(existsSync(w.state)).toBe(false);
  });
  it("keeps the event loop responsive and reads inventory without executing any update", async () => {
    const w = await harnessWorld({ finishDelay: 150 });
    const inventory = await w.maintenance.routes.maintenanceInventory({
      harnessIds: ["codex"],
      checkLatest: true,
    });
    expect(inventory.harnesses[0]).toMatchObject({
      selection: selection(),
      newest: { status: "unavailable" },
      operation: null,
    });
    expect(w.calls().every((c) => c.verb === "inspect")).toBe(true);
    const op = await w.maintenance.routes.createMaintenanceOperation(latest, "offline-update");
    const pending = w.run(op.id);
    let ticked = false;
    await new Promise((resolve) =>
      setTimeout(() => {
        ticked = true;
        resolve(null);
      }, 10),
    );
    expect(ticked).toBe(true);
    expect((await pending).state).toBe("succeeded");
    expect(
      (await w.maintenance.routes.maintenanceInventory({ harnessIds: ["codex"] })).harnesses[0],
    ).toMatchObject({
      selection: selection("2.0.0"),
      newest: { status: "unavailable" },
      operation: { id: op.id, outcome: "changed" },
    });
  });
  it("an interrupted durable operation discloses uncertain effects", async () => {
    const w = await harnessWorld();
    const op = await w.maintenance.routes.createMaintenanceOperation(latest, "interrupted");
    w.store.update(op.id, { state: "interrupted", result: EVIDENCE, error: "owner exited" });
    expect(await w.maintenance.routes.getMaintenanceOperation(op.id)).toMatchObject({
      state: "interrupted",
      mutation: "unknown",
      outcome: "unknown",
      problem: { message: "owner exited" },
    });
  });
  it("rejects retired targets and discloses active maintenance on the bound readiness service", async () => {
    const w = await harnessWorld();
    for (const kind of ["previous", "baseline"])
      await expect(
        w.maintenance.routes.createMaintenanceOperation(
          { harness: "codex", target: { kind } },
          kind,
        ),
      ).rejects.toThrow();
    const op = await w.maintenance.routes.createMaintenanceOperation(latest, "active");
    const services = {
      harnesses: async () => ({ harnesses: [{ id: "codex", reasons: [], readiness: [] }] }),
    };
    w.maintenance.bind(services);
    expect(await services.harnesses()).toMatchObject({
      harnesses: [
        { reasons: [expect.stringContaining(op.id)], readiness: [{ id: "maintenance" }] },
      ],
    });
  });
  it("starts all seven inventory observations before awaiting any one", async () => {
    const waiting: Array<() => void> = [];
    const w = await harnessWorld({}, async function* (_bin, args) {
      const harness = args![args!.indexOf("inspect") + 1]!;
      await new Promise<void>((resolve) => waiting.push(resolve));
      yield {
        type: "stdout",
        line: JSON.stringify({
          harnesses: [{ ...ROW, harness, observedAt: new Date().toISOString() }],
        }),
      };
    });
    const pending = w.maintenance.routes.maintenanceInventory();
    await vi.waitFor(() => expect(waiting).toHaveLength(7));
    waiting.reverse().forEach((release) => release());
    expect((await pending).harnesses.map((row) => row.harness)).toEqual([
      "agy",
      "claude",
      "codex",
      "copilot",
      "cursor",
      "grok",
      "opencode",
    ]);
  });
  it("retains the last successful newest reading and its time across failures, but accepts a later success", async () => {
    const observedAt = "2026-11-10T00:00:00.000Z";
    const unavailable = {
      status: "unavailable",
      source: "https://example.invalid/latest",
      observedAt,
      problem: { code: "newest_unavailable", message: "rate limited", retryable: true },
    };
    const success = {
      status: "available",
      source: "https://example.invalid/latest",
      observedAt,
      version: "2.0.0",
    };
    let newest: object = unavailable;
    const w = await harnessWorld({}, async function* () {
      yield {
        type: "stdout",
        line: JSON.stringify({
          harnesses: [{ ...ROW, newest, observedAt: new Date().toISOString() }],
        }),
      };
    });
    const read = async () =>
      (
        await w.maintenance.routes.maintenanceInventory({
          harnessIds: ["codex"],
          checkLatest: true,
        })
      ).harnesses[0]!;
    expect((await read()).newest).toMatchObject(unavailable);
    newest = { ...unavailable, observedAt: "2026-11-11T00:00:00.000Z" };
    expect((await read()).newest).toMatchObject(newest); // No success yet: keep the current failure.
    newest = success;
    expect((await read()).newest).toEqual(success);
    newest = { ...unavailable, observedAt: "2026-11-11T00:00:00.000Z" };
    expect(await read()).toMatchObject({ newest: success, updateAvailable: "yes" });
    newest = { ...success, version: "1.0.0", observedAt: "2026-11-11T00:00:00.000Z" };
    expect(await read()).toMatchObject({ newest, updateAvailable: "no" });
  });
  it.each(["old-first", "new-first"])(
    "concurrent observations terminate and fence late answers (%s)",
    async (order) => {
      const waiting: Array<() => void> = [];
      let count = 0;
      const w = await harnessWorld({}, async function* () {
        const version = `${++count}.0.0`;
        await new Promise<void>((resolve) => waiting.push(resolve));
        yield {
          type: "stdout",
          line: JSON.stringify({
            harnesses: [
              { ...ROW, observedAt: new Date().toISOString(), selection: selection(version) },
            ],
          }),
        };
      });
      const read = (checkLatest = false) =>
        w.maintenance.routes.maintenanceInventory({ harnessIds: ["codex"], checkLatest });
      const first = read();
      const shared = read();
      await vi.waitFor(() => expect(waiting).toHaveLength(1));
      const newest = read(true); // Requires a public-source read as well.
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      waiting[order === "old-first" ? 0 : 1]!();
      await new Promise((resolve) => setImmediate(resolve));
      waiting[order === "old-first" ? 1 : 0]!();
      for (const result of await Promise.all([first, shared, newest]))
        expect(result.harnesses[0]!.selection.version).toBe("2.0.0");
      expect(count).toBe(2);
      const next = read();
      await vi.waitFor(() => expect(waiting).toHaveLength(3));
      waiting[2]!();
      expect((await next).harnesses[0]!.selection.version).toBe("3.0.0");
    },
  );
});
