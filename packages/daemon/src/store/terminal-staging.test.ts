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
import { basename, join, resolve } from "node:path";
import {
  RunEvent,
  RunTelemetry,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import { processTiming } from "@claudexor/util";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { BlobFiles } from "./blob-files.js";
import { SqlCommandPruner } from "./command-prune.js";
import { SqlCommandStore } from "./commands.js";
import { MaintenanceController } from "./maintenance.js";
import { Obligations } from "./obligations.js";
import { createPartition } from "./partitions.js";
import { storedTerminal } from "./run-events.js";
import { EngineStore } from "./store.js";
import { SqlTerminalFiles } from "./terminal-files.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

/** The pool-side writes (the paths they opened, and a gate that holds their
 * data) and the whole-file reads. */
const pool = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  held: [] as string[],
  wholeReads: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    pool.wholeReads.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const write = handle.write.bind(handle) as (...input: unknown[]) => Promise<unknown>;
    return Object.assign(handle, {
      write: async (...input: unknown[]) => {
        if (pool.hold) {
          pool.held.push(String(args[0]));
          await pool.hold;
        }
        return write(...input);
      },
    });
  };
  return { ...actual, open, readFile, default: { ...actual, open, readFile } };
});

const TIME = "2026-11-02T00:00:00.000Z";
const dist = (file: string) => resolve(import.meta.dirname, "../../dist/store", file);
const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  Object.assign(pool, { hold: null, held: [], wholeReads: [] });
  for (const fn of cleanup.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

function facts(generatedAt = TIME) {
  const outcome = makeOutcomeFacts("failed", { reason: "harness_failed" });
  return validateRunFactsInvariants({
    schema_version: SCHEMA_VERSION,
    run_id: "run",
    task_id: "task",
    mode: "agent",
    outcome,
    deliverable: { present: false, kind: null, path: null, producer_attempt_id: null },
    participants: { planners: 0, attempts: [] },
    gates: {
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    },
    review: { state: "not_run", blocker_ids: [], blockers: 0 },
    apply: { eligibility: null, operator_decision_present: false },
    required_actions: requiredActionsFor(outcome, false),
    generated_at: generatedAt,
  });
}
/** A legacy-shaped hook telemetry carrying the retired `run_facts` mirror: the
 * terminal-files owner ignores it, never staging or writing telemetry.yaml. */
function telemetry() {
  return RunTelemetry.parse({
    schema_version: SCHEMA_VERSION,
    run_id: "run",
    task_id: "task",
    mode: "agent",
    requested_access: "full",
    effective_access: "full",
    external_context_policy: "off",
    effective_web_mode: "off",
    web: {},
    attempts: [],
    generated_at: TIME,
    run_facts: facts(),
  });
}
/** A failed terminal whose journal copy is a large body (its error text). */
function terminal(generatedAt = TIME) {
  const value = facts(generatedAt);
  return RunEvent.parse({
    seq: 2,
    ts: TIME,
    run_id: "run",
    task_id: "task",
    type: "run.failed",
    payload: {
      lifecycle: value.outcome.lifecycle,
      facts: value.outcome,
      reason: value.outcome.reason,
      run_facts: value,
      error: "e".repeat(70_000),
    },
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-terminal-staging-"));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const runDir = join(root, "run");
  mkdirSync(join(runDir, "final"), { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    `${JSON.stringify({ seq: 1, ts: TIME, run_id: "run", task_id: "task", type: "run.created", payload: {} })}\n`,
  );
  const daemonDir = join(root, "daemon");
  const store = await EngineStore.open({
    daemonDir,
    workerEntry: dist("flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  cleanup.push(() => store.close());
  const generation = store.transaction(() => createPartition(store, "global"));
  const blobs = new BlobFiles(store),
    obligations = new Obligations(store),
    files = new SqlTerminalFiles(store, obligations);
  const commands = new SqlCommandStore(store, blobs, generation, {
    isLive: () => true,
    obligations,
    terminalFiles: files,
    pruner: new SqlCommandPruner(store, blobs),
  });
  commands.accept({
    id: "job",
    params: { mode: "agent", prompt: "fixture" },
    idempotencyKey: "key",
    clientId: "fixture",
  });
  commands.update("job", { state: "running", runId: "run", taskId: "task", runDir });
  // Every external write reports what it did: wrote bytes, or adopted staged ones.
  vi.spyOn(processTiming, "recordSync").mockReturnValue(true);
  const log = vi.spyOn(store, "logSlowWrite");
  const writes = () =>
    log.mock.calls.map(([line]) =>
      JSON.parse(String(line).slice("store.external_write ".length)),
    ) as Array<{ purpose: string; written: boolean; staged?: true; bytes: number }>;
  const temps = () => readdirSync(blobs.dir).filter((name) => name.endsWith(".tmp"));
  return { root, runDir, daemonDir, store, generation, blobs, files, commands, writes, temps };
}

describe("terminal receipts and bodies are written off the request thread before the commit", () => {
  it("publishes staged receipts and adopts the staged journal body inside the synchronous commit", async () => {
    const f = await fixture();
    await f.commands.stageTerminal("job", terminal(), telemetry());
    expect(f.temps()).toHaveLength(1);
    expect(existsSync(join(f.runDir, "final", "run_facts.yaml"))).toBe(false);
    // Its log ends with a canonical line before the terminal: only its tail was read.
    expect(pool.wholeReads.filter((path) => path.endsWith("events.jsonl"))).toEqual([]);

    expect(f.commands.persistTerminal("job", terminal(), telemetry())).toEqual({
      state: "materialized",
    });
    const receipts = f.writes().filter((write) => write.purpose === "terminal_receipt");
    expect(receipts).toEqual([
      expect.objectContaining({ staged: true, written: true }),
    ]);
    const bodies = f.writes().filter((write) => write.purpose === "blob_body");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter((write) => write.written)).toEqual([]);
    expect(f.temps()).toEqual([]);
    const receipt = parseYaml(readFileSync(join(f.runDir, "final", "run_facts.yaml"), "utf8"));
    expect(validateRunFactsInvariants(receipt)).toEqual(facts());
    // The retired telemetry mirror is not written from the hook's telemetry.
    expect(existsSync(join(f.runDir, "final", "telemetry.yaml"))).toBe(false);
    expect(readFileSync(join(f.runDir, "events.jsonl"), "utf8")).toContain('"type":"run.failed"');
    expect(f.files.pending("run")).toBe(false);
  });

  it("keeps the request thread serving while the terminal's staged writes wait on the drive", async () => {
    const f = await fixture();
    let release!: () => void;
    pool.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 2);
    try {
      const staging = f.commands.stageTerminal("job", terminal(), telemetry());
      // The receipt and the large journal body are written on the pool, and held there.
      const held = () => pool.held.map((path) => basename(path));
      await vi.waitFor(() => {
        expect(held()).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^\.run_facts\.yaml\./),
            expect.stringMatching(/^\.[0-9a-f]{64}\./),
          ]),
        );
      });
      expect(held().some((name) => name.startsWith(".telemetry.yaml."))).toBe(false);
      const before = ticks;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(ticks - before).toBeGreaterThan(3);
      // The request thread still answers from SQL; nothing is committed or visible.
      expect(f.commands.get("job")?.state).toBe("running");
      expect(storedTerminal(f.store, "run", f.generation.pid)).toBeUndefined();
      expect(existsSync(join(f.runDir, "final", "run_facts.yaml"))).toBe(false);
      release();
      await staging;
    } finally {
      clearInterval(timer);
      release();
    }
    expect(f.commands.persistTerminal("job", terminal(), telemetry())).toEqual({
      state: "materialized",
    });
    expect(f.writes().filter((write) => write.purpose === "terminal_receipt")).toEqual([
      expect.objectContaining({ staged: true }),
    ]);
  });

  it("stages the rewrite of a log whose tail is torn, and the commit adopts it", async () => {
    const f = await fixture();
    const created = readFileSync(join(f.runDir, "events.jsonl"), "utf8");
    // A crash left a prefix of the terminal line without its newline.
    const line = JSON.stringify(terminal());
    writeFileSync(join(f.runDir, "events.jsonl"), created + line.slice(0, 80));
    await f.commands.stageTerminal("job", terminal(), telemetry());
    expect(f.temps()).toHaveLength(2);
    expect(f.commands.persistTerminal("job", terminal(), telemetry())).toEqual({
      state: "materialized",
    });
    expect(f.writes().filter((write) => write.purpose === "terminal_log")).toEqual([
      expect.objectContaining({ staged: true, written: true }),
    ]);
    expect(readFileSync(join(f.runDir, "events.jsonl"), "utf8")).toBe(`${created}${line}\n`);
    expect(f.temps()).toEqual([]);
  });

  it("commits the command as it is at the commit, also when its row changed after the stage", async () => {
    const f = await fixture();
    await f.commands.stageTerminal("job", terminal(), telemetry());
    f.commands.update("job", { startedAt: "2026-11-02T00:00:00.500Z" });
    expect(f.commands.persistTerminal("job", terminal(), telemetry())).toEqual({
      state: "materialized",
    });
    expect(f.commands.get("job")).toMatchObject({
      state: "failed",
      startedAt: "2026-11-02T00:00:00.500Z",
    });
  });

  it("writes on the request thread what changed after staging and drops the stale temp", async () => {
    const f = await fixture();
    await f.commands.stageTerminal("job", terminal(), telemetry());
    const changed = terminal("2026-11-02T00:00:01.000Z");
    expect(f.commands.persistTerminal("job", changed, telemetry())).toEqual({
      state: "materialized",
    });
    const receipts = f.writes().filter((write) => write.purpose === "terminal_receipt");
    expect(receipts).toEqual([expect.not.objectContaining({ staged: true })]);
    expect(receipts[0]).toMatchObject({ written: true });
    const receipt = parseYaml(readFileSync(join(f.runDir, "final", "run_facts.yaml"), "utf8"));
    expect(validateRunFactsInvariants(receipt)).toEqual(facts("2026-11-02T00:00:01.000Z"));
    expect(f.temps()).toEqual([]);
  });

  it("leaves no terminal after a crash between staging and the commit; the orphan sweep reclaims the temps", async () => {
    const f = await fixture();
    await f.commands.stageTerminal("job", terminal(), telemetry());
    const staged = f.temps();
    expect(staged).toHaveLength(1);
    const bodies = readdirSync(f.blobs.dir).filter((name) => !name.endsWith(".tmp"));
    // The process dies before the synchronous terminal commit ran.
    await f.store.close();
    const store = await EngineStore.open({
      daemonDir: f.daemonDir,
      workerEntry: dist("flusher-worker.js"),
    });
    cleanup.push(() => store.close());
    expect(storedTerminal(store, "run", f.generation.pid)).toBeUndefined();
    expect(existsSync(join(f.runDir, "final", "run_facts.yaml"))).toBe(false);
    expect(existsSync(join(f.runDir, "final", "telemetry.yaml"))).toBe(false);
    const maintenance = new MaintenanceController(store, {
      workerEntry: dist("maintenance-worker.js"),
      processStartedAt: Date.now() + 1_000,
    });
    cleanup.push(() => maintenance.stop());
    const report = await maintenance.sweepOrphans();
    expect(report.removedTemps.map((path) => basename(path)).sort()).toEqual([...staged].sort());
    expect(f.temps()).toEqual([]);
    // The staged journal body was published but never owned: the sweep takes it too.
    expect(bodies.length).toBeGreaterThan(0);
    expect(report.removedBlobs.sort()).toEqual([...bodies].sort());
  });
});
