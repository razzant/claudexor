import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
/**
 * The durable maintenance OPERATION over a real CommandStore journal and the
 * real spawnProcess owner, driving a fake CLI child (a tiny node script that
 * logs every invocation and its pid). No real npm, vendor CLI, daemon, login
 * or ~/.claudexor is involved; every child pid is proven dead afterwards.
 */
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnProcess } from "@claudexor/core";
import { accountObservations } from "./account-observations.js";
import { createHarnessMaintenance } from "./harness-maintenance-service.js";

const FAKE_CLI = `
import { appendFileSync, readFileSync } from "node:fs";
const [config, , verb, ...rest] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(config, "utf8"));
appendFileSync(cfg.log, JSON.stringify({ verb, rest, pid: process.pid }) + "\\n");
const now = new Date().toISOString();
if (verb === "inspect") {
  const one = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
  const rows = (one ? [one] : cfg.all).map((harness) => ({ ...cfg.row, harness, observedAt: now }));
  if (rest.includes("--latest")) for (const row of rows) row.available = { version: cfg.latest, observedAt: now };
  setTimeout(() => process.stdout.write(JSON.stringify({ observedAt: now, harnesses: rows })), cfg.inspectSleepMs ?? 0);
} else if (verb === "update") {
  process.stderr.write("installing " + rest.join(" ") + "\\n");
  setTimeout(() => {
    if (cfg.update) process.stdout.write(JSON.stringify(cfg.update));
    process.exitCode = cfg.update?.ok ? 0 : 1;
  }, cfg.sleepMs ?? 0);
}
`;

const ROW = {
  mechanism: "managed_npm",
  maintainable: true,
  canCheckLatest: true,
  targets: ["latest", "version", "previous", "baseline"],
  remedy: null,
  selection: { kind: "managed", binary: "/m/bin/codex", version: "1.0.0", overrideEnv: null },
  installed: { version: "1.0.0", binary: "/m/bin/codex", proved: true },
  releaseTested: { version: "0.1.0", verification: "release_verified" },
  available: null,
  availableProblem: null,
};

const UPDATED = {
  ok: true,
  after: { version: "7.7.7", binary: "/m/bin/codex", selected: true, proved: true },
  mutation: "applied",
  limitations: ["in_place_replacement", "new_starts_may_fail"],
};

const roots: string[] = [];
const stores: Array<Awaited<ReturnType<typeof sqlFixture>>> = [];
const pids = new Set<number>();
afterEach(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone: the expected case */
    }
  }
  pids.clear();
  for (const sql of stores.splice(0)) await sql.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function harnessWorld(config: Record<string, unknown> = {}, spawn = spawnProcess) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-maint-op-")));
  roots.push(root);
  const script = join(root, "fake-cli.mjs");
  const configPath = join(root, "config.json");
  const log = join(root, "calls.jsonl");
  writeFileSync(script, FAKE_CLI);
  const write = (patch: Record<string, unknown>) =>
    writeFileSync(
      configPath,
      JSON.stringify({ log, all: ["codex"], latest: "7.7.7", row: ROW, update: UPDATED, ...patch }),
    );
  write(config);
  const sql = await sqlFixture(root);
  stores.push(sql);
  const store = sql.graph.commands.current();
  let next = 0;
  const controllers = new Map<string, AbortController>();
  const client = {
    enqueue: vi.fn(async (request: unknown, options: Record<string, unknown>) => {
      const { record, reused } = store.accept({
        id: `job-${(next += 1)}`,
        params: request,
        idempotencyKey: String(options.idempotencyKey),
        clientId: String(options.clientId),
        operation: options.operation as string,
        idempotencyParams: options.idempotencyRequest,
      });
      return { id: record.id, state: record.state, reused };
    }),
    cancel: vi.fn(async (id: string) => {
      controllers.get(id)?.abort();
      return { id, cancelled: true };
    }),
  };
  const spawnArgs: Array<{ args: string[]; resultAtSpawn: unknown }> = [];
  const readiness = { invalidate: vi.fn() };
  const maintenance = createHarnessMaintenance({
    commands: sql.graph.commands,
    maintenanceQueries: sql.graph.commands.queries,
    client,
    readiness: () => readiness,
    cli: { command: process.execPath, args: [script, configPath] },
    cancelKillDelayMs: 500,
    spawn: ((command: string, argv: string[], options: never) => {
      spawnArgs.push({
        args: argv.slice(2),
        resultAtSpawn: structuredClone(sql.records().at(-1)?.result ?? null),
      });
      return spawn(command, argv, options);
    }) as typeof spawnProcess,
  });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const call = JSON.parse(line) as { verb: string; rest: string[]; pid: number };
            pids.add(call.pid);
            return call;
          })
      : [];
  /** Emulates the daemon's runJob: running -> execute -> terminal update. */
  const run = async (id: string) => {
    const controller = new AbortController();
    controllers.set(id, controller);
    store.update(id, { state: "running", startedAt: new Date().toISOString() });
    const result = await maintenance.execute(store.get(id)!.params, {
      jobId: id,
      signal: controller.signal,
      onRunStart: () => undefined,
    });
    store.update(id, { state: result.lifecycle, result, finishedAt: new Date().toISOString() });
    return maintenance.routes.getMaintenanceOperation(id);
  };
  return { maintenance, store, client, calls, run, write, spawnArgs, controllers, readiness };
}

const latest = { harness: "codex", target: { kind: "latest" as const } };

describe("harness maintenance operation", () => {
  it.each([true, false])(
    "a pre-update inspection cannot restore old observations (newer read: %s)",
    async (newerRead) => {
      let release!: () => void;
      let started!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const captured = new Promise<void>((resolve) => (started = resolve));
      let version = "1.0.0";
      let inspections = 0;
      const w = await harnessWorld({}, async function* (_command, args) {
        const [, , , verb, ...rest] = args;
        if (verb === "inspect") {
          const ids = rest[0]?.startsWith("--") ? ["codex", "claude"] : [rest[0]!];
          const rows = ids.map((harness) => ({
            ...ROW,
            harness,
            observedAt: new Date().toISOString(),
            selection: { ...ROW.selection, version: harness === "codex" ? version : "1.0.0" },
            installed: { ...ROW.installed, version: harness === "codex" ? version : "1.0.0" },
            available: rest.includes("--latest")
              ? { version, observedAt: new Date().toISOString() }
              : null,
          }));
          if (++inspections === 1) {
            started();
            await held;
          }
          yield { type: "stdout", line: JSON.stringify({ harnesses: rows }) };
        } else {
          expect(verb).toBe("update");
          version = "7.7.7";
          yield { type: "stdout", line: JSON.stringify(UPDATED) };
        }
        yield { type: "exit", code: 0, signal: null };
      });
      const inventory = w.maintenance.routes.maintenanceInventory;
      const pending = inventory({ harnessIds: ["codex", "claude"], checkLatest: true });
      await captured;
      const { id } = await w.maintenance.routes.createMaintenanceOperation(
        { harness: "codex", target: { kind: "version", version: "7.7.7" } },
        "update",
      );
      expect(await w.run(id)).toMatchObject({ state: "succeeded", after: { version: "7.7.7" } });
      if (newerRead)
        expect(
          (await inventory({ harnessIds: ["codex"], checkLatest: true })).harnesses[0],
        ).toMatchObject({ installed: { version: "7.7.7" } });
      release();
      const rows = (await pending).harnesses;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        selection: { version: "7.7.7" },
        installed: { version: "7.7.7" },
        available: { version: "7.7.7" },
      });
      expect(rows[1]).toMatchObject({ harness: "claude", installed: { version: "1.0.0" } });
      expect((await inventory({ harnessIds: ["codex", "claude"] })).harnesses).toEqual(rows);
      // Reuse the newer read, or reacquire only the invalidated harness. The
      // unaffected row from the original all-harness read remains reusable.
      expect(
        w.spawnArgs.filter((call) => call.args[1] === "inspect").map((call) => call.args),
      ).toEqual([
        ["harness", "inspect", "--latest", "--json"],
        ["harness", "inspect", "codex", "--json"],
        ["harness", "inspect", "codex", "--latest", "--json"],
      ]);
    },
  );

  it("one key + same body rejoins the same operation; a different body conflicts", async () => {
    const w = await harnessWorld();
    const first = await w.maintenance.routes.createMaintenanceOperation(latest, "k1");
    const again = await w.maintenance.routes.createMaintenanceOperation(latest, "k1");
    expect(again.id).toBe(first.id);
    expect(w.client.enqueue).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ state: "queued", phase: "accepted", target: { version: null } });
    await expect(
      w.maintenance.routes.createMaintenanceOperation(
        { harness: "codex", target: { kind: "baseline" } },
        "k1",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("resolves latest once and records the proved before + exact target BEFORE mutating", async () => {
    const w = await harnessWorld();
    const observations = vi.spyOn(accountObservations, "invalidateHarness");
    const { id } = await w.maintenance.routes.createMaintenanceOperation(latest, "k1");
    const done = await w.run(id);
    expect(done).toMatchObject({
      state: "succeeded",
      phase: "settled",
      mutation: "applied",
      target: { kind: "latest", version: "7.7.7" },
      before: { version: "1.0.0", selection: "managed", proved: true },
      after: { version: "7.7.7", selected: true },
    });
    const verbs = w.calls().map((call) => call.verb);
    expect(verbs).toEqual(["inspect", "update"]);
    expect(w.calls()[0]!.rest).toContain("--latest");
    expect(w.calls()[1]!.rest).toEqual(["codex", "--vendor-version", "7.7.7", "--yes", "--json"]);
    const atSpawn = w.spawnArgs.find((entry) => entry.args.includes("update"))!.resultAtSpawn;
    expect(atSpawn).toMatchObject({
      phase: "installing",
      mutation: "unknown",
      target: { version: "7.7.7" },
      before: { version: "1.0.0", proved: true },
    });
    expect(w.readiness.invalidate).toHaveBeenCalledWith("codex");
    // Only the affected harness's account observations; no global fanout.
    expect(observations).toHaveBeenCalledWith("codex");
    expect(observations).toHaveBeenCalledTimes(1);
    const inventory = await w.maintenance.routes.maintenanceInventory({});
    expect(inventory.harnesses[0]).toMatchObject({
      previous: { version: "1.0.0", operationId: id },
      operation: { id, state: "succeeded", targetVersion: "7.7.7" },
    });
  });

  it("a failed first update keeps its before fact, and Return targets that exact version", async () => {
    const w = await harnessWorld({
      update: { ok: false, code: "install_verification_failed", mutation: "unknown" },
    });
    const { id } = await w.maintenance.routes.createMaintenanceOperation(
      { harness: "codex", target: { kind: "version", version: "2.0.0" } },
      "k1",
    );
    const failed = await w.run(id);
    expect(failed).toMatchObject({
      state: "failed",
      mutation: "unknown",
      before: { version: "1.0.0", proved: true },
      problem: { code: "install_verification_failed" },
    });
    const back = await w.maintenance.routes.createMaintenanceOperation(
      { harness: "codex", target: { kind: "previous" } },
      "k2",
    );
    expect(back.target).toEqual({ kind: "previous", version: "1.0.0" });
  });

  it("previous stays unknown without retained evidence instead of becoming the baseline", async () => {
    const w = await harnessWorld();
    await expect(
      w.maintenance.routes.createMaintenanceOperation(
        { harness: "codex", target: { kind: "previous" } },
        "k",
      ),
    ).rejects.toMatchObject({ code: "maintenance_target_unknown" });
    expect(w.client.enqueue).not.toHaveBeenCalled();
  });

  it("cancel stops the child tree and reports an uncertain effect, not a clean rollback", async () => {
    const w = await harnessWorld({ sleepMs: 30_000 });
    const { id } = await w.maintenance.routes.createMaintenanceOperation(latest, "k1");
    const running = w.run(id);
    await vi.waitFor(() => expect(w.calls().map((call) => call.verb)).toContain("update"), {
      timeout: 10_000,
    });
    await w.maintenance.routes.cancelMaintenanceOperation(id);
    const done = await running;
    expect(done).toMatchObject({
      state: "cancelled",
      mutation: "unknown",
      termination: "confirmed",
      problem: { code: "maintenance_cancelled" },
    });
    for (const call of w.calls()) expect(() => process.kill(call.pid, 0)).toThrow();
  });

  it("cancel during preparation stops its child before any update starts", async () => {
    const w = await harnessWorld({ inspectSleepMs: 30_000 });
    const { id } = await w.maintenance.routes.createMaintenanceOperation(latest, "k1");
    const running = w.run(id);
    await vi.waitFor(() => expect(w.calls()).toHaveLength(1), { timeout: 10_000 });
    await w.maintenance.routes.cancelMaintenanceOperation(id);
    const done = await running;
    expect(done).toMatchObject({
      state: "cancelled",
      mutation: "none",
      termination: "confirmed",
      problem: { code: "maintenance_cancelled" },
    });
    expect(w.calls().map((call) => call.verb)).toEqual(["inspect"]);
    for (const call of w.calls()) expect(() => process.kill(call.pid, 0)).toThrow();
  });

  it("keeps the daemon event loop responsive while the installer child runs", async () => {
    const w = await harnessWorld({ sleepMs: 600 });
    const { id } = await w.maintenance.routes.createMaintenanceOperation(latest, "k1");
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    try {
      await w.run(id);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  it("an interrupted operation after the install began reads as unknown, not as the old version", async () => {
    const w = await harnessWorld();
    const { id } = await w.maintenance.routes.createMaintenanceOperation(latest, "k1");
    w.store.update(id, {
      state: "interrupted",
      error: "daemon restarted before command completion was durably observed",
      result: {
        phase: "installing",
        mechanism: "managed_npm",
        target: { kind: "latest", version: "7.7.7" },
        before: { version: "1.0.0", binary: "/m/bin/codex", selection: "managed", proved: true },
        after: null,
        mutation: "unknown",
        termination: "not_applicable",
        limitations: [],
        progress: [],
        problem: null,
      },
    });
    const detail = await w.maintenance.routes.getMaintenanceOperation(id);
    expect(detail).toMatchObject({
      state: "interrupted",
      mutation: "unknown",
      after: null,
      problem: { code: "maintenance_interrupted" },
    });
  });

  it("reading inventory only inspects: no update, install or login child", async () => {
    const w = await harnessWorld();
    const codex = { harnessIds: ["codex"] };
    await w.maintenance.routes.maintenanceInventory(codex);
    await w.maintenance.routes.maintenanceInventory(codex);
    await w.maintenance.routes.maintenanceInventory({ ...codex, checkLatest: true });
    const verbs = w.calls().map((call) => call.verb);
    expect(new Set(verbs)).toEqual(new Set(["inspect"]));
    // The second plain read is served from the in-memory projection.
    expect(verbs).toHaveLength(2);
  });

  it("refuses a cached not-maintainable installation before acceptance", async () => {
    const w = await harnessWorld({
      row: { ...ROW, maintainable: false, targets: [], remedy: "unset CLAUDEXOR_CODEX_BIN" },
    });
    await w.maintenance.routes.maintenanceInventory({});
    await expect(
      w.maintenance.routes.createMaintenanceOperation(latest, "k1"),
    ).rejects.toMatchObject({
      code: "harness_not_maintainable",
      status: 409,
    });
    expect(w.client.enqueue).not.toHaveBeenCalled();
  });

  it("an active operation is disclosed on the readiness row instead of an auth/quota cause", async () => {
    const w = await harnessWorld();
    const { id } = await w.maintenance.routes.createMaintenanceOperation(latest, "k1");
    const list = w.maintenance.decorateHarnessList(async () => ({
      harnesses: [
        { id: "codex", reasons: [], readiness: [] },
        { id: "claude", reasons: [], readiness: [] },
      ],
    }));
    const value = (await list()) as { harnesses: Array<{ id: string; reasons: string[] }> };
    expect(value.harnesses[0]!.reasons.join(" ")).toContain(`operation ${id}`);
    expect(value.harnesses[1]!.reasons).toEqual([]);
    await expect(
      w.maintenance.routes.createMaintenanceOperation(latest, "k2"),
    ).rejects.toMatchObject({
      code: "maintenance_already_active",
      context: { operationId: id },
    });
  });
});
